<script lang="ts">
  import {
    project,
    viewport,
    activeFigureId,
    activeCanvasId,
    selection,
    partSelection,
    activeTool,
    drawStyle,
    selectOnly,
    clearSelection,
    selectFrame,
    selectedFrameId,
    beginGesture,
    mutate,
    expandGroups,
    newId,
    findElement,
    lastDupOffset,
    captionOpen,
    hoverId,
    arrange,
  } from "./store";
  import { commitArrange } from "./keyboard";
  import type { Element, Figure } from "./types";
  import { get } from "svelte/store";
  import { applyAutoWidth } from "./text";
  import {
    elementBBox,
    selectionBBox,
    rectsIntersect,
    rotateAbout,
    type Rect,
  } from "./geometry";
  import { createDrawElement, createTextElement, resizeRemap } from "./editing";
  import { importDroppedFiles } from "./io";
  import { semanticIdFromNode } from "./plot/parse";
  import ElementView from "./Element.svelte";
  import CaptionEditor from "./CaptionEditor.svelte";

  // ===========================================================================
  // Rendering architecture (performance-critical):
  //  - The "scene" holds all committed content. Panning is a CSS transform on
  //    its wrapper (GPU-composited, NO repaint). Zoom changes an internal scale
  //    (one repaint per wheel tick — fine, it's discrete).
  //  - ALL live interaction (dragged-element previews, selection box + handles,
  //    marquee, guides, draw/pen previews) renders on a separate screen-space
  //    overlay. During a drag/resize the scene is frozen (originals hidden) and
  //    only the small overlay updates, so cost is independent of window size /
  //    resolution. The scene repaints exactly once, on pointer-up.
  // ===========================================================================

  let hostEl: HTMLDivElement;

  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 16;
  const HS = 9; // on-screen handle size in px (constant)

  let spaceDown = false;

  type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

  type Gesture =
    | null
    | { kind: "pan"; sx: number; sy: number; panX: number; panY: number }
    | {
        kind: "move";
        figId: string;
        sx: number;
        sy: number;
        origs: Map<string, Element>;
        ob: Rect;
        xs: number[];
        ys: number[];
      }
    | {
        kind: "resize";
        figId: string;
        handle: Handle;
        ob: Rect;
        origs: Map<string, Element>;
      }
    | { kind: "marquee"; figId: string; x0: number; y0: number; add: Set<string> }
    | { kind: "draw"; figId: string; x0: number; y0: number }
    | {
        kind: "rotate";
        figId: string;
        cx: number;
        cy: number;
        startAngle: number;
        origs: Map<string, Element>;
      }
    | {
        kind: "figmove";
        figId: string;
        sx: number;
        sy: number;
        ox: number;
        oy: number;
        xs: number[];
        ys: number[];
      };

  let gesture: Gesture = null;

  // Live, transient gesture state (drives the overlay; never the scene).
  let gestureFig: Figure | null = null;
  let gestureEls: Element[] = [];
  let gestureHiddenIds = new Set<string>();
  let dragging = false;
  let committed = false;
  let gestureAltDup = false; // current move is an alt-drag-copy
  let pendingShiftToggle: string | null = null; // shift-click toggle deferred to up
  let gDX = 0;
  let gDY = 0;
  let fDX = 0; // live frame-move delta, world units (F8)
  let fDY = 0;
  let gNb: Rect | null = null;
  let liveBox: Rect | null = null;
  let marquee: Rect | null = null; // figure-local
  let preview: Element | null = null;
  let guides: { x?: number; y?: number }[] = [];
  let rotateTip = ""; // live angle readout during a rotate drag

  function ensureCommitted() {
    if (!committed) {
      beginGesture();
      committed = true;
    }
  }

  // pen tool state
  let penPts: { x: number; y: number }[] = [];
  let penFigId: string | null = null;
  let penCursor: { x: number; y: number } | null = null;

  // inline text editing
  let editingId: string | null = null;
  let taEl: HTMLTextAreaElement | null = null;

  // --- coordinate helpers ---
  function clientToWorld(cx: number, cy: number) {
    const r = hostEl.getBoundingClientRect();
    return {
      x: (cx - r.left - $viewport.panX) / $viewport.zoom,
      y: (cy - r.top - $viewport.panY) / $viewport.zoom,
    };
  }
  function localPoint(cx: number, cy: number, fig: Figure) {
    const w = clientToWorld(cx, cy);
    return { x: w.x - fig.x, y: w.y - fig.y };
  }
  function activeFigure(): Figure | null {
    return $project.figures.find((f) => f.id === $activeFigureId) ?? null;
  }
  function selectedEls(fig: Figure): Element[] {
    return fig.elements.filter((e) => $selection.has(e.id));
  }

  // Only the active canvas's figures are rendered / hit-tested.
  $: canvasFigures = $project.figures.filter((f) => f.canvasId === $activeCanvasId);

  // F5 viewport culling: render only figures/elements intersecting the viewport
  // (+ a generous buffer). The pan is QUANTIZED so the visible set's identity only
  // changes every CULL_STEP px of pan — preserving the cheap CSS-transform pan
  // within the buffer (no per-frame re-filter / re-render). Selected elements are
  // always rendered, so a drag that leaves the viewport never culls what you drag.
  let hostW = 0;
  let hostH = 0;
  const CULL_MARGIN = 600; // screen-px buffer around the viewport
  const CULL_STEP = 400; // re-cull granularity (must be < CULL_MARGIN to avoid popping)
  let cullRect: Rect = { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
  let cullKey = "";
  $: {
    const z = $viewport.zoom;
    const ready = hostW > 0 && hostH > 0;
    const qx = ready ? Math.round($viewport.panX / CULL_STEP) * CULL_STEP : 0;
    const qy = ready ? Math.round($viewport.panY / CULL_STEP) * CULL_STEP : 0;
    const key = ready ? `${hostW}x${hostH}@${z}:${qx},${qy}` : "all";
    if (key !== cullKey) {
      cullKey = key;
      cullRect = ready
        ? {
            x: (-qx - CULL_MARGIN) / z,
            y: (-qy - CULL_MARGIN) / z,
            w: (hostW + 2 * CULL_MARGIN) / z,
            h: (hostH + 2 * CULL_MARGIN) / z,
          }
        : { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
    }
  }
  $: visibleFigures = canvasFigures.filter(
    (f) =>
      f.id === $activeFigureId ||
      rectsIntersect({ x: f.x, y: f.y, w: f.width, h: f.height }, cullRect),
  );
  function visibleEls(fig: Figure): Element[] {
    // The frame being moved renders all its elements: its world position is stale
    // until commit, so culling by the stale bbox would drop elements as it travels.
    // Hidden elements (Layers eye) are never rendered — so also never hit-testable.
    if (dragging && gesture?.kind === "figmove" && gesture.figId === fig.id)
      return fig.elements.filter((el) => !el.hidden);
    const lr: Rect = { x: cullRect.x - fig.x, y: cullRect.y - fig.y, w: cullRect.w, h: cullRect.h };
    return fig.elements.filter(
      (el) => !el.hidden && ($selection.has(el.id) || rectsIntersect(elementBBox(el), lr)),
    );
  }
  // Precompute the per-figure visible element lists keyed off the (stable-within-a-
  // pan-step) cull rect + selection, so the template's {#each} only re-diffs when
  // the cull region/selection/project actually change — not on every pan frame.
  $: visibleByFig = (() => {
    void cullRect;
    void $selection;
    void $project;
    void dragging;
    void gesture;
    const m = new Map<string, Element[]>();
    for (const f of visibleFigures) m.set(f.id, visibleEls(f));
    return m;
  })();

  // selection bbox in active-figure-local coords
  $: overlayBox = (() => {
    const fig = $project.figures.find((f) => f.id === $activeFigureId);
    if (!fig) return null;
    return selectionBBox(fig.elements.filter((e) => $selection.has(e.id)));
  })();

  // --- pan / zoom ---
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = hostEl.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, $viewport.zoom * factor));
      const wx = (px - $viewport.panX) / $viewport.zoom;
      const wy = (py - $viewport.panY) / $viewport.zoom;
      viewport.set({ zoom: next, panX: px - wx * next, panY: py - wy * next });
    } else {
      // Shift+wheel = horizontal pan (some setups don't auto-map it to deltaX).
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      viewport.update((v) => ({ ...v, panX: v.panX - dx, panY: v.panY - dy }));
    }
  }

  function startPanIfNeeded(e: PointerEvent): boolean {
    if (e.button === 1 || (spaceDown && e.button === 0) || $activeTool === "hand") {
      gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, panX: $viewport.panX, panY: $viewport.panY };
      hostEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      return true;
    }
    return false;
  }

  function onCanvasDown(e: PointerEvent) {
    if (startPanIfNeeded(e)) return;
    if (get(arrange)?.active) {
      e.stopPropagation();
      commitArrange(); // click applies the live arrangement and exits the mode
      return;
    }
    if ($captionOpen) return; // read-only while the caption editor is open
    if ($activeTool === "select") clearSelection();
  }

  function onFigureDown(e: PointerEvent, fig: Figure) {
    if (startPanIfNeeded(e)) return;
    if (get(arrange)?.active) {
      e.stopPropagation();
      commitArrange();
      return;
    }
    if ($captionOpen) return; // read-only while the caption editor is open
    e.stopPropagation();
    activeFigureId.set(fig.id);
    selectedFrameId.set(null);
    const lp = localPoint(e.clientX, e.clientY, fig);

    if ($activeTool === "select") {
      if (!e.shiftKey) clearSelection();
      gesture = { kind: "marquee", figId: fig.id, x0: lp.x, y0: lp.y, add: new Set(e.shiftKey ? $selection : []) };
      gestureFig = fig;
      marquee = { x: lp.x, y: lp.y, w: 0, h: 0 };
      hostEl.setPointerCapture(e.pointerId);
    } else if ($activeTool === "text") {
      const el = createTextElement(lp, get(drawStyle));
      beginGesture();
      mutate((p) => p.figures.find((f) => f.id === fig.id)?.elements.push(el));
      selectOnly(el.id);
      activeTool.set("select");
      startEdit(el, false);
    } else if (["rect", "ellipse", "line", "arrow"].includes($activeTool)) {
      gesture = { kind: "draw", figId: fig.id, x0: lp.x, y0: lp.y };
      gestureFig = fig;
      preview = createDrawElement($activeTool, lp, lp, get(drawStyle));
      hostEl.setPointerCapture(e.pointerId);
    } else if ($activeTool === "pen") {
      if (penPts.length === 0) {
        penFigId = fig.id;
        penPts = [lp];
      } else if (penFigId === fig.id) {
        const first = penPts[0];
        const near = Math.hypot(lp.x - first.x, lp.y - first.y) < 8 / $viewport.zoom;
        if (near && penPts.length >= 2) finishPen(true);
        else penPts = [...penPts, lp];
      }
    }
  }

  function finishPen(close: boolean) {
    if (penPts.length >= 2 && penFigId) {
      const xs = penPts.map((p) => p.x);
      const ys = penPts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const s = get(drawStyle);
      let d = penPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x - minX} ${p.y - minY}`).join(" ");
      if (close) d += " Z";
      const el: Element = {
        type: "path",
        id: newId("path"),
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
        rotation: 0,
        d,
        fill: s.fill,
        stroke: s.stroke,
        strokeWidth: s.strokeWidth,
        closed: close,
      };
      const figId = penFigId;
      beginGesture();
      mutate((p) => p.figures.find((f) => f.id === figId)?.elements.push(el));
      selectOnly(el.id);
      activeTool.set("select");
    }
    penPts = [];
    penFigId = null;
    penCursor = null;
  }

  // --- inline text editing ---
  function startEdit(el: Element, snapshot: boolean) {
    if (el.type !== "text") return;
    const found = findElement($project, el.id);
    if (found) activeFigureId.set(found.figure.id);
    selectOnly(el.id);
    if (snapshot) beginGesture();
    editingId = el.id;
    requestAnimationFrame(() => {
      taEl?.focus();
      taEl?.select();
    });
  }
  function onTextInput(e: Event) {
    if (!editingId) return;
    const val = (e.currentTarget as HTMLTextAreaElement).value;
    const id = editingId;
    mutate((p) => {
      const f = findElement(p, id);
      if (f && f.element.type === "text") {
        f.element.text = val;
        applyAutoWidth(f.element);
      }
    });
  }
  function finishEdit() {
    if (!editingId) return;
    const f = findElement($project, editingId);
    if (f && f.element.type === "text" && f.element.text.trim() === "") {
      const id = editingId;
      mutate((p) => {
        for (const fig of p.figures) fig.elements = fig.elements.filter((x) => x.id !== id);
      });
      clearSelection();
    }
    editingId = null;
  }
  $: editingInfo = (() => {
    if (!editingId) return null;
    const f = findElement($project, editingId);
    if (!f || f.element.type !== "text") return null;
    return {
      el: f.element,
      left: $viewport.panX + (f.figure.x + f.element.x) * $viewport.zoom,
      top: $viewport.panY + (f.figure.y + f.element.y) * $viewport.zoom,
    };
  })();

  // --- pointer down on an element ---
  function onElementDown(e: PointerEvent, el: Element, fig: Figure) {
    if (startPanIfNeeded(e)) return;
    if (get(arrange)?.active) {
      e.stopPropagation();
      commitArrange();
      return;
    }
    if ($captionOpen) return; // read-only while the caption editor is open
    if ($activeTool !== "select") {
      onFigureDown(e, fig);
      return;
    }
    // Locked elements can't be selected/moved via the canvas (only from the Layers
    // panel). Treat a click on one like a click on the figure (marquee / clear).
    if (el.locked) {
      onFigureDown(e, fig);
      return;
    }
    e.stopPropagation();
    activeFigureId.set(fig.id);
    selectedFrameId.set(null);
    // Drill into a semantic plot: clicking an ALREADY-selected plot selects the
    // part under the cursor (its prefixed DOM id → canonical semantic id);
    // otherwise clear any part selection. The whole-plot drag still proceeds.
    if (el.type === "plot" && $selection.has(el.id)) {
      // (DOM Element is shadowed by the figure-model Element import → cast via unknown)
      const pid = semanticIdFromNode(e.target as unknown as SVGElement, el.id);
      partSelection.set(pid ? { elementId: el.id, partId: pid } : null);
    } else {
      partSelection.set(null);
    }
    const grp = expandGroups($project, new Set([el.id]));
    // Shift has two meanings on an element: shift-CLICK toggles its selection,
    // but shift-DRAG constrains the move to one axis. We can't tell which at
    // pointer-down, so for an already-selected element we DEFER the toggle to
    // pointer-up and only apply it if no real drag happened (see onPointerUp).
    // Alt means duplicate-on-drag, so shift+alt is "drag a copy, axis-locked" —
    // never a selection toggle.
    pendingShiftToggle = null;
    if (e.shiftKey && !e.altKey) {
      if ($selection.has(el.id)) {
        pendingShiftToggle = el.id; // keep selection for the drag; toggle on click-up
      } else {
        selection.update((s) => {
          const n = new Set(s);
          for (const id of grp) n.add(id);
          return n;
        });
      }
    } else if (!$selection.has(el.id)) {
      selection.set(grp);
    }
    beginMove(e, fig);
  }

  function beginMove(e: PointerEvent, fig: Figure) {
    let sel = selectedEls(fig);
    // Alt-drag = duplicate-on-drag: clone the selection in place, then drag the
    // copies (Figma-style). The originals stay put; the new copies are hidden in
    // the frozen scene and shown only on the overlay while dragging.
    gestureAltDup = e.altKey && sel.length > 0;
    if (gestureAltDup) {
      beginGesture(); // single history entry covers the duplicate + the drag
      const newIds: string[] = [];
      const grpRemap = new Map<string, string>();
      mutate((p) => {
        const f = p.figures.find((ff) => ff.id === fig.id);
        if (!f) return;
        const copies = sel.map((el) => {
          const c = structuredClone(el);
          c.id = newId(c.type);
          if (c.groupId) {
            if (!grpRemap.has(c.groupId)) grpRemap.set(c.groupId, newId("grp"));
            c.groupId = grpRemap.get(c.groupId);
          }
          newIds.push(c.id);
          return c;
        });
        f.elements.push(...copies);
      });
      selection.set(new Set(newIds));
      const f2 = $project.figures.find((ff) => ff.id === fig.id) ?? fig;
      sel = f2.elements.filter((el) => newIds.includes(el.id));
    }
    const origs = new Map<string, Element>();
    for (const el of sel) origs.set(el.id, structuredClone(el));
    const ob = selectionBBox(sel) ?? { x: 0, y: 0, w: 0, h: 0 };
    const selIds = new Set(sel.map((el) => el.id));
    const xs = [0, fig.width, fig.width / 2];
    const ys = [0, fig.height, fig.height / 2];
    for (const el of fig.elements) {
      if (selIds.has(el.id)) continue;
      const b = elementBBox(el);
      xs.push(b.x, b.x + b.w, b.x + b.w / 2);
      ys.push(b.y, b.y + b.h, b.y + b.h / 2);
    }
    gesture = { kind: "move", figId: fig.id, sx: e.clientX, sy: e.clientY, origs, ob, xs, ys };
    gestureFig = fig;
    gestureEls = sel;
    committed = gestureAltDup; // duplicate already opened the history entry
    dragging = false;
    gDX = 0;
    gDY = 0;
    liveBox = ob;
    hostEl.setPointerCapture(e.pointerId);
  }

  // F8: begin moving a whole figure (frame) by its title label. Snaps the frame's
  // edges/centres to neighbouring figures. Reuses the flicker-free path (a transient
  // GPU transform on the live figure group; the model commits on pointer-up).
  function startFigMove(e: PointerEvent, fig: Figure) {
    e.stopPropagation();
    if ($captionOpen) return;
    selectFrame(fig.id);
    activeFigureId.set(fig.id);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const f of canvasFigures) {
      if (f.id === fig.id) continue;
      xs.push(f.x, f.x + f.width, f.x + f.width / 2);
      ys.push(f.y, f.y + f.height, f.y + f.height / 2);
    }
    gesture = { kind: "figmove", figId: fig.id, sx: e.clientX, sy: e.clientY, ox: fig.x, oy: fig.y, xs, ys };
    gestureFig = fig;
    committed = false;
    dragging = false;
    fDX = 0;
    fDY = 0;
    hostEl.setPointerCapture(e.pointerId);
  }

  function snap(edges: number[], targets: number[], thr: number) {
    let best = thr;
    let off = 0;
    let line: number | null = null;
    for (const edge of edges)
      for (const t of targets) {
        const d = t - edge;
        if (Math.abs(d) < best) {
          best = Math.abs(d);
          off = d;
          line = t;
        }
      }
    return { off, line };
  }

  function onHandleDown(e: PointerEvent, handle: Handle) {
    e.stopPropagation();
    if ($captionOpen) return; // read-only while the caption editor is open
    const fig = activeFigure();
    if (!fig || !overlayBox) return;
    const sel = selectedEls(fig);
    const origs = new Map<string, Element>();
    for (const el of sel) origs.set(el.id, structuredClone(el));
    gesture = { kind: "resize", figId: fig.id, handle, ob: { ...overlayBox }, origs };
    gestureFig = fig;
    gestureEls = sel;
    committed = false;
    dragging = false;
    gNb = { ...overlayBox };
    liveBox = { ...overlayBox };
    hostEl.setPointerCapture(e.pointerId);
  }

  // Rotate handle (F2): drag rotates the selection about its bbox centre. The
  // model is updated live (from the captured originals so the delta never
  // compounds); Shift snaps the primary element's resulting angle to 15°.
  function onRotateDown(e: PointerEvent) {
    e.stopPropagation();
    if ($captionOpen) return;
    const fig = activeFigure();
    if (!fig || !overlayBox) return;
    const sel = selectedEls(fig);
    if (!sel.length) return;
    const cx = overlayBox.x + overlayBox.w / 2;
    const cy = overlayBox.y + overlayBox.h / 2;
    const lp = localPoint(e.clientX, e.clientY, fig);
    const startAngle = (Math.atan2(lp.y - cy, lp.x - cx) * 180) / Math.PI;
    const origs = new Map<string, Element>();
    for (const el of sel) origs.set(el.id, structuredClone(el));
    gesture = { kind: "rotate", figId: fig.id, cx, cy, startAngle, origs };
    gestureFig = fig;
    gestureEls = sel;
    committed = false;
    dragging = false;
    rotateTip = "";
    hostEl.setPointerCapture(e.pointerId);
  }

  function startDragging() {
    if (!dragging) {
      dragging = true;
      // F5 flicker-free move: a move applies a transient GPU transform to the live
      // scene groups (no hide, no re-decode, no overlay copy), so SVG/plot/image
      // elements never blank. Only resize freezes the originals + uses the overlay
      // (cheap geometry). The data model stays frozen until pointer-up either way.
      gestureHiddenIds =
        gesture?.kind === "resize" ? new Set(gestureEls.map((el) => el.id)) : new Set();
    }
  }

  function onPointerMove(e: PointerEvent) {
    if ($activeTool === "pen" && penFigId) {
      const pf = $project.figures.find((f) => f.id === penFigId);
      if (pf) penCursor = localPoint(e.clientX, e.clientY, pf);
    }
    const g = gesture;
    if (!g) return;

    if (g.kind === "pan") {
      viewport.update((v) => ({ ...v, panX: g.panX + (e.clientX - g.sx), panY: g.panY + (e.clientY - g.sy) }));
      return;
    }
    const fig = $project.figures.find((f) => f.id === g.figId);
    if (!fig) return;

    if (g.kind === "figmove") {
      const rawDx = (e.clientX - g.sx) / $viewport.zoom;
      const rawDy = (e.clientY - g.sy) / $viewport.zoom;
      let dx = rawDx;
      let dy = rawDy;
      const nextGuides: { x?: number; y?: number }[] = [];
      if (!e.altKey) {
        const thr = 6 / $viewport.zoom;
        const fx = g.ox + dx;
        const fy = g.oy + dy;
        const sX = snap([fx, fx + fig.width / 2, fx + fig.width], g.xs, thr);
        const sY = snap([fy, fy + fig.height / 2, fy + fig.height], g.ys, thr);
        if (sX.line != null) {
          dx += sX.off;
          nextGuides.push({ x: sX.line });
        }
        if (sY.line != null) {
          dy += sY.off;
          nextGuides.push({ y: sY.line });
        }
      }
      dragging = true;
      guides = nextGuides;
      fDX = dx;
      fDY = dy;
      return;
    }

    if (g.kind === "move") {
      const rawDx = (e.clientX - g.sx) / $viewport.zoom;
      const rawDy = (e.clientY - g.sy) / $viewport.zoom;
      // Shift constrains movement to the dominant axis (Figma-style).
      const lockAxis = e.shiftKey
        ? Math.abs(rawDx) >= Math.abs(rawDy)
          ? "x"
          : "y"
        : null;
      let dx = lockAxis === "y" ? 0 : rawDx;
      let dy = lockAxis === "x" ? 0 : rawDy;
      const nextGuides: { x?: number; y?: number }[] = [];
      if (!e.altKey) {
        const thr = 6 / $viewport.zoom;
        const mx = g.ob.x + dx;
        const my = g.ob.y + dy;
        const sX = snap([mx, mx + g.ob.w / 2, mx + g.ob.w], g.xs, thr);
        const sY = snap([my, my + g.ob.h / 2, my + g.ob.h], g.ys, thr);
        if (sX.line != null && lockAxis !== "y") {
          dx += sX.off;
          nextGuides.push({ x: sX.line });
        }
        if (sY.line != null && lockAxis !== "x") {
          dy += sY.off;
          nextGuides.push({ y: sY.line });
        }
      }
      startDragging();
      guides = nextGuides;
      gDX = dx;
      gDY = dy;
      liveBox = { x: g.ob.x + dx, y: g.ob.y + dy, w: g.ob.w, h: g.ob.h };
    } else if (g.kind === "resize") {
      const lp = localPoint(e.clientX, e.clientY, fig);
      // A single element with a locked aspect ratio resizes uniformly without Shift.
      const forceAspect = gestureEls.length === 1 && !!gestureEls[0].lockAspect;
      const nb = computeResizeBox(g.ob, g.handle, lp, e.shiftKey || forceAspect);
      startDragging();
      gNb = nb;
      liveBox = nb;
    } else if (g.kind === "rotate") {
      const lp = localPoint(e.clientX, e.clientY, fig);
      let delta = (Math.atan2(lp.y - g.cy, lp.x - g.cx) * 180) / Math.PI - g.startAngle;
      dragging = true;
      ensureCommitted(); // first move captures the pre-rotation state (one undo)
      mutate((p) => {
        const f = p.figures.find((ff) => ff.id === g.figId);
        if (!f) return;
        const sel: Element[] = [];
        for (const el of f.elements) {
          const o = g.origs.get(el.id);
          if (!o) continue;
          el.x = o.x; // restore originals so the delta doesn't compound
          el.y = o.y;
          el.rotation = o.rotation;
          sel.push(el);
        }
        if (e.shiftKey && sel.length) {
          const base = g.origs.get(sel[0].id)?.rotation ?? 0;
          delta = Math.round((base + delta) / 15) * 15 - base;
        }
        rotateAbout(sel, { x: g.cx, y: g.cy }, delta);
        const a = ((((sel[0]?.rotation ?? 0) % 360) + 360) % 360);
        rotateTip = `${Math.round(a)}°`;
      });
    } else if (g.kind === "marquee") {
      const lp = localPoint(e.clientX, e.clientY, fig);
      const r: Rect = { x: Math.min(g.x0, lp.x), y: Math.min(g.y0, lp.y), w: Math.abs(lp.x - g.x0), h: Math.abs(lp.y - g.y0) };
      marquee = r;
      const hit = new Set(g.add);
      for (const el of fig.elements)
        if (!el.locked && !el.hidden && rectsIntersect(elementBBox(el), r)) hit.add(el.id);
      selection.set(expandGroups($project, hit));
    } else if (g.kind === "draw") {
      const lp = localPoint(e.clientX, e.clientY, fig);
      preview = createDrawElement($activeTool, { x: g.x0, y: g.y0 }, lp, get(drawStyle));
    }
  }

  function onPointerUp(e: PointerEvent) {
    const g = gesture;
    if (!g) return;

    if (g.kind === "move") {
      if (dragging && (gDX !== 0 || gDY !== 0)) {
        ensureCommitted();
        mutate((p) => {
          const f = p.figures.find((ff) => ff.id === g.figId);
          if (!f) return;
          for (const el of f.elements) {
            const o = g.origs.get(el.id);
            if (o) {
              el.x = o.x + gDX;
              el.y = o.y + gDY;
            }
          }
        });
        // Remember an alt-drag-copy's offset so Ctrl+D repeats the same step.
        if (gestureAltDup) lastDupOffset.set({ dx: gDX, dy: gDY });
      } else if (pendingShiftToggle) {
        // It was a shift-CLICK (no real drag) on an already-selected element:
        // now apply the deferred toggle (deselect it / its group).
        const grp = expandGroups($project, new Set([pendingShiftToggle]));
        selection.update((s) => {
          const n = new Set(s);
          for (const id of grp) n.delete(id);
          return n;
        });
      }
    } else if (g.kind === "resize" && gNb && dragging) {
      const nb = gNb;
      ensureCommitted();
      mutate((p) => {
        const f = p.figures.find((ff) => ff.id === g.figId);
        if (!f) return;
        for (const el of f.elements) {
          const o = g.origs.get(el.id);
          if (o) resizeRemap(el, o, g.ob, nb);
        }
      });
    } else if (g.kind === "draw" && preview) {
      const b = elementBBox(preview);
      const el = preview;
      if (b.w > 2 || b.h > 2) {
        beginGesture();
        mutate((p) => p.figures.find((f) => f.id === g.figId)?.elements.push(el));
        selectOnly(el.id);
      }
      activeTool.set("select");
    } else if (g.kind === "figmove" && dragging && (fDX !== 0 || fDY !== 0)) {
      ensureCommitted();
      mutate((p) => {
        const f = p.figures.find((ff) => ff.id === g.figId);
        if (f) {
          f.x = g.ox + fDX;
          f.y = g.oy + fDY;
        }
      });
    }

    // Reset all transient state in one batch -> single clean scene render.
    preview = null;
    marquee = null;
    guides = [];
    liveBox = null;
    rotateTip = "";
    gDX = 0;
    gDY = 0;
    fDX = 0;
    fDY = 0;
    gNb = null;
    gestureEls = [];
    gestureFig = null;
    gestureHiddenIds = new Set();
    dragging = false;
    gestureAltDup = false;
    pendingShiftToggle = null;
    gesture = null;
    try {
      hostEl.releasePointerCapture(e.pointerId);
    } catch {}
  }

  function computeResizeBox(ob: Rect, h: Handle, lp: { x: number; y: number }, shift: boolean): Rect {
    let x = ob.x,
      y = ob.y,
      w = ob.w,
      hh = ob.h;
    const right = ob.x + ob.w;
    const bottom = ob.y + ob.h;
    if (h.includes("w")) {
      x = lp.x;
      w = right - lp.x;
    }
    if (h.includes("e")) w = lp.x - ob.x;
    if (h.includes("n")) {
      y = lp.y;
      hh = bottom - lp.y;
    }
    if (h.includes("s")) hh = lp.y - ob.y;
    if (shift && ob.w > 0 && ob.h > 0) {
      const s = Math.max(w / ob.w, hh / ob.h);
      w = ob.w * s;
      hh = ob.h * s;
      if (h.includes("w")) x = right - w;
      if (h.includes("n")) y = bottom - hh;
    }
    return { x, y, w: Math.max(1, w), h: Math.max(1, hh) };
  }

  // --- keyboard (space-pan, pen finish; global shortcuts live in keyboard.ts) ---
  function onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
    if (e.code === "Space" && !spaceDown && !typing) spaceDown = true;
    if (!typing && penPts.length) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishPen(false);
      } else if (e.key === "Escape") {
        penPts = [];
        penFigId = null;
        penCursor = null;
      }
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code === "Space") spaceDown = false;
  }

  let prevTool = $activeTool;
  $: if ($activeTool !== prevTool) {
    if (prevTool === "pen" && penPts.length >= 2) finishPen(false);
    else if (prevTool === "pen") {
      penPts = [];
      penFigId = null;
      penCursor = null;
    }
    prevTool = $activeTool;
  }

  function onDblClick() {
    if ($captionOpen) return; // read-only while the caption editor is open
    if (penPts.length >= 2) {
      finishPen(false);
      return;
    }
    // Double-click to edit text — robust even if a resize handle was the target.
    const ids = [...$selection];
    if (ids.length === 1) {
      const f = findElement($project, ids[0]);
      if (f && f.element.type === "text") startEdit(f.element, true);
    }
  }

  // --- OS file drag-and-drop (from the file explorer) ---
  let dropFigId: string | null = null;
  function figureAt(clientX: number, clientY: number): Figure | null {
    const w = clientToWorld(clientX, clientY);
    return (
      canvasFigures.find(
        (f) => w.x >= f.x && w.x <= f.x + f.width && w.y >= f.y && w.y <= f.y + f.height,
      ) ?? null
    );
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer || $captionOpen) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropFigId = figureAt(e.clientX, e.clientY)?.id ?? null;
  }
  function onDragLeave(e: DragEvent) {
    const rel = e.relatedTarget as Node | null;
    if (!rel || !hostEl.contains(rel)) dropFigId = null;
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    if ($captionOpen) return;
    const fig = figureAt(e.clientX, e.clientY);
    dropFigId = null;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (fig && files.length) importDroppedFiles(files, fig.id);
  }

  const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  function handlePos(h: Handle, b: Rect) {
    const map: Record<Handle, [number, number]> = {
      nw: [b.x, b.y],
      n: [b.x + b.w / 2, b.y],
      ne: [b.x + b.w, b.y],
      e: [b.x + b.w, b.y + b.h / 2],
      se: [b.x + b.w, b.y + b.h],
      s: [b.x + b.w / 2, b.y + b.h],
      sw: [b.x, b.y + b.h],
      w: [b.x, b.y + b.h / 2],
    };
    return map[h];
  }
  const cursorFor: Record<Handle, string> = {
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
  };

  $: af = $project.figures.find((f) => f.id === $activeFigureId) ?? null;
  $: displayBox = liveBox ?? overlayBox; // figure-local, active figure

  // A selection made entirely of locked elements (only reachable via the Layers
  // panel) shows its box but NO resize/rotate handles — locked elements can't be
  // transformed on the canvas.
  $: selLocked = (() => {
    if (!af) return false;
    const els = af.elements.filter((e) => $selection.has(e.id));
    return els.length > 0 && els.every((e) => e.locked);
  })();

  // Figma-style hover outline: a thin accent box around whatever a click would
  // select (the hovered element, expanded to its whole group). Suppressed while
  // dragging, editing, read-only (caption), with a non-select tool, or when the
  // hovered thing is already selected (the selection box already shows it).
  $: hoverInfo = (() => {
    if (
      !$hoverId ||
      gesture ||
      dragging ||
      editingId ||
      $captionOpen ||
      $activeTool !== "select" ||
      $selection.has($hoverId)
    )
      return null;
    const found = findElement($project, $hoverId);
    if (!found) return null;
    // Don't preview-outline a locked/hidden element — a click won't select it.
    if (found.element.locked || found.element.hidden) return null;
    const grp = expandGroups($project, new Set([$hoverId]));
    const b = selectionBBox(found.figure.elements.filter((e) => grp.has(e.id)));
    if (!b) return null;
    // Outset ~1.5px (screen) so the outline sits just outside the element's own
    // border and stays visible even on a same-hue shape (Figma-style).
    const O = 1.5;
    return {
      x: $viewport.panX + (found.figure.x + b.x) * $viewport.zoom - O,
      y: $viewport.panY + (found.figure.y + b.y) * $viewport.zoom - O,
      w: b.w * $viewport.zoom + 2 * O,
      h: b.h * $viewport.zoom + 2 * O,
    };
  })();

  // Overlay geometry in SCREEN px. These must reference $viewport directly so
  // Svelte recomputes them on pan/zoom (a helper that reads $viewport inside
  // would hide the dependency and the overlay would desync).
  $: selScreen =
    af && displayBox
      ? {
          x: $viewport.panX + (af.x + displayBox.x) * $viewport.zoom,
          y: $viewport.panY + (af.y + displayBox.y) * $viewport.zoom,
          w: displayBox.w * $viewport.zoom,
          h: displayBox.h * $viewport.zoom,
        }
      : null;
  $: handlesScreen = selScreen
    ? HANDLES.map((h) => {
        const [hx, hy] = handlePos(h, selScreen);
        return { h, x: hx - HS / 2, y: hy - HS / 2, cursor: cursorFor[h] };
      })
    : [];
  $: guidesScreen =
    gesture?.kind === "move" && gestureFig
      ? guides.map((gd) =>
          gd.x != null
            ? {
                v: true,
                x: $viewport.panX + (gestureFig!.x + gd.x) * $viewport.zoom,
                a: $viewport.panY + gestureFig!.y * $viewport.zoom - 40,
                b: $viewport.panY + (gestureFig!.y + gestureFig!.height) * $viewport.zoom + 40,
              }
            : {
                v: false,
                y: $viewport.panY + (gestureFig!.y + (gd.y ?? 0)) * $viewport.zoom,
                a: $viewport.panX + gestureFig!.x * $viewport.zoom - 40,
                b: $viewport.panX + (gestureFig!.x + gestureFig!.width) * $viewport.zoom + 40,
              },
        )
      : [];
  $: marqueeScreen =
    marquee && gesture?.kind === "marquee" && gestureFig
      ? {
          x: $viewport.panX + (gestureFig.x + marquee.x) * $viewport.zoom,
          y: $viewport.panY + (gestureFig.y + marquee.y) * $viewport.zoom,
          w: marquee.w * $viewport.zoom,
          h: marquee.h * $viewport.zoom,
        }
      : null;
  $: penFig = penFigId ? ($project.figures.find((f) => f.id === penFigId) ?? null) : null;
  $: penScreenPts =
    penFig && penPts.length
      ? [...penPts, ...(penCursor ? [penCursor] : [])].map(
          (p) => `${$viewport.panX + (penFig!.x + p.x) * $viewport.zoom},${$viewport.panY + (penFig!.y + p.y) * $viewport.zoom}`,
        )
      : [];
  $: penAnchors =
    penFig && penPts.length
      ? penPts.map((p, i) => ({
          x: $viewport.panX + (penFig!.x + p.x) * $viewport.zoom,
          y: $viewport.panY + (penFig!.y + p.y) * $viewport.zoom,
          first: i === 0,
        }))
      : [];
  // Highlight box for a selected plot PART (screen px). getBoundingClientRect
  // already accounts for every ancestor transform (zoom / pan / figure /
  // nested-viewBox), so we just subtract the host origin. Re-measures on
  // pan/zoom ($viewport) and on edits ($project — an override can resize a part).
  $: partBoxScreen = (() => {
    const ps = $partSelection;
    void $viewport;
    void $project;
    // Suppress during a drag: the measured node moves via a transient transform
    // this block doesn't track, so the box would otherwise lag/stale (F5).
    if (!ps || !hostEl || dragging || gesture) return null;
    const node = document.getElementById(`${ps.elementId}__${ps.partId}`);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const h = hostEl.getBoundingClientRect();
    const O = 2; // small outset so tiny markers stay visible
    return { x: r.left - h.left - O, y: r.top - h.top - O, w: r.width + 2 * O, h: r.height + 2 * O };
  })();

  $: hostCursor =
    gesture?.kind === "pan" || spaceDown || $activeTool === "hand"
      ? "grab"
      : $activeTool === "text"
        ? "text"
        : ["rect", "ellipse", "line", "arrow", "pen"].includes($activeTool)
          ? "crosshair"
          : "default";

  // draw-preview group transform (screen space), references $viewport directly.
  $: drawPreviewTransform = gestureFig
    ? `translate(${$viewport.panX + gestureFig.x * $viewport.zoom} ${$viewport.panY + gestureFig.y * $viewport.zoom}) scale(${$viewport.zoom})`
    : "";

  // overlay transform that maps a figure's local space to screen px, including
  // the live move/resize delta — used for the dragged-element previews.
  $: dragTransform = (() => {
    if (!gestureFig) return "";
    const base = `translate(${$viewport.panX + gestureFig.x * $viewport.zoom} ${$viewport.panY + gestureFig.y * $viewport.zoom}) scale(${$viewport.zoom})`;
    if (gesture?.kind === "move") return `${base} translate(${gDX} ${gDY})`;
    if (gesture?.kind === "resize" && gNb) {
      const sX = gesture.ob.w ? gNb.w / gesture.ob.w : 1;
      const sY = gesture.ob.h ? gNb.h / gesture.ob.h : 1;
      return `${base} translate(${gNb.x} ${gNb.y}) scale(${sX} ${sY}) translate(${-gesture.ob.x} ${-gesture.ob.y})`;
    }
    return base;
  })();

  // F5 flicker-free move: the set of element ids being moved + the transient GPU
  // transform applied to their LIVE scene groups (Tier-1, composited). gDX/gDY are
  // figure-local world units; on an SVG <g> a CSS px == one user unit, so the
  // ancestor scale(zoom) maps the translate to the correct on-screen delta.
  $: moveIds =
    dragging && gesture?.kind === "move"
      ? new Set(gestureEls.map((el) => el.id))
      : (null as Set<string> | null);
  $: moveTransform = `translate3d(${gDX}px, ${gDY}px, 0)`;

  // F8 frame move: the figure being moved + its transient GPU transform, plus
  // smart-guide lines (world-absolute, drawn full-viewport in the overlay).
  $: figMoveId = dragging && gesture?.kind === "figmove" ? gesture.figId : (null as string | null);
  $: frameTransform = `translate3d(${fDX}px, ${fDY}px, 0)`;
  $: frameGuidesScreen =
    gesture?.kind === "figmove"
      ? guides.map((gd) =>
          gd.x != null
            ? { v: true, x: $viewport.panX + gd.x * $viewport.zoom }
            : { v: false, y: $viewport.panY + (gd.y ?? 0) * $viewport.zoom },
        )
      : [];
</script>

<svelte:window
  on:keydown={onKeyDown}
  on:keyup={onKeyUp}
  on:dragover|preventDefault
  on:drop|preventDefault
/>

<div
  class="canvas-host"
  bind:this={hostEl}
  bind:clientWidth={hostW}
  bind:clientHeight={hostH}
  style:cursor={hostCursor}
  role="application"
  aria-label="Figure canvas"
  on:wheel={onWheel}
  on:pointerdown={onCanvasDown}
  on:pointermove={onPointerMove}
  on:pointerup={onPointerUp}
  on:pointercancel={onPointerUp}
  on:pointerleave={() => hoverId.set(null)}
  on:dblclick={onDblClick}
  on:dragover={onDragOver}
  on:dragleave={onDragLeave}
  on:drop={onDrop}
>
  <!-- SCENE: panned via cheap CSS transform; only repaints on data/zoom change -->
  <div class="scene" style={`transform: translate3d(${$viewport.panX}px, ${$viewport.panY}px, 0);`}>
    <svg class="scene-svg" xmlns="http://www.w3.org/2000/svg">
      <g transform={`scale(${$viewport.zoom})`}>
        {#each visibleFigures as fig (fig.id)}
          <g
            style:transform={figMoveId === fig.id ? frameTransform : null}
            style:will-change={figMoveId === fig.id ? "transform" : null}
          >
          <g transform={`translate(${fig.x} ${fig.y})`}>
            <rect class="fig-shadow" x="3" y="4" width={fig.width} height={fig.height} />
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect
              class="figure-bg"
              class:active={$activeFigureId === fig.id}
              class:frame-selected={$selectedFrameId === fig.id}
              class:droptarget={dropFigId === fig.id}
              x="0"
              y="0"
              width={fig.width}
              height={fig.height}
              fill={fig.background}
              on:pointerdown={(e) => onFigureDown(e, fig)}
            />
            <clipPath id={`clip-${fig.id}`}>
              <rect x="0" y="0" width={fig.width} height={fig.height} />
            </clipPath>
            <g clip-path={`url(#clip-${fig.id})`}>
              {#each visibleByFig.get(fig.id) ?? [] as el (el.id)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <g
                  class="el"
                  class:editing-hidden={editingId === el.id}
                  style:visibility={gestureHiddenIds.has(el.id) ? "hidden" : null}
                  style:transform={moveIds?.has(el.id) ? moveTransform : null}
                  style:will-change={moveIds?.has(el.id) ? "transform" : null}
                  on:pointerdown={(e) => onElementDown(e, el, fig)}
                  on:pointerenter={() => {
                    if ($activeTool === "select" && !$captionOpen) hoverId.set(el.id);
                  }}
                  on:pointerleave={() => {
                    if ($hoverId === el.id) hoverId.set(null);
                  }}
                  on:dblclick={(e) => {
                    if (el.type === "text") {
                      e.stopPropagation();
                      startEdit(el, true);
                    }
                  }}
                >
                  <ElementView element={el} />
                </g>
              {/each}
            </g>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect
              class="figure-titlebar"
              x="0"
              y={-22 / $viewport.zoom}
              width={Math.max(fig.width, 120 / $viewport.zoom)}
              height={18 / $viewport.zoom}
              on:pointerdown={(e) => startFigMove(e, fig)}
            />
            <text class="figure-label" x="0" y={-8 / $viewport.zoom} font-size={13 / $viewport.zoom}>{fig.name}</text>
          </g>
          </g>
        {/each}
      </g>
    </svg>
  </div>

  <!-- OVERLAY: screen-space, cheap; all live interaction chrome + previews -->
  <svg class="overlay-svg" xmlns="http://www.w3.org/2000/svg">
    <!-- resized element preview (a move uses a live scene transform instead — F5) -->
    {#if dragging && gestureFig && gesture?.kind === "resize"}
      <g transform={dragTransform} style="will-change: transform">
        {#each gestureEls as el (el.id)}
          <ElementView element={el} />
        {/each}
      </g>
    {/if}

    <!-- draw preview -->
    {#if preview && gesture?.kind === "draw" && gestureFig}
      <g transform={drawPreviewTransform}>
        <ElementView element={preview} />
      </g>
    {/if}

    <!-- smart guides (move) -->
    {#each guidesScreen as gd}
      {#if gd.v}
        <line class="guide" x1={gd.x} y1={gd.a} x2={gd.x} y2={gd.b} />
      {:else}
        <line class="guide" x1={gd.a} y1={gd.y} x2={gd.b} y2={gd.y} />
      {/if}
    {/each}

    <!-- smart guides (frame move) — full-viewport lines -->
    {#each frameGuidesScreen as gd}
      {#if gd.v}
        <line class="guide" x1={gd.x} y1={0} x2={gd.x} y2={hostH} />
      {:else}
        <line class="guide" x1={0} y1={gd.y} x2={hostW} y2={gd.y} />
      {/if}
    {/each}

    <!-- marquee -->
    {#if marqueeScreen}
      <rect class="marquee" x={marqueeScreen.x} y={marqueeScreen.y} width={marqueeScreen.w} height={marqueeScreen.h} />
    {/if}

    <!-- hover outline: previews what a click would select -->
    {#if hoverInfo}
      <rect class="hover-box" x={hoverInfo.x} y={hoverInfo.y} width={hoverInfo.w} height={hoverInfo.h} fill="none" />
    {/if}

    <!-- selection box + handles -->
    {#if selScreen && !editingInfo}
      <rect class="sel-box" x={selScreen.x} y={selScreen.y} width={selScreen.w} height={selScreen.h} fill="none" />
      {#if !$captionOpen && !selLocked}
        <!-- rotate handle: circle above the top-centre resize handle, on a stem -->
        <line
          class="rot-stem"
          x1={selScreen.x + selScreen.w / 2}
          y1={selScreen.y}
          x2={selScreen.x + selScreen.w / 2}
          y2={selScreen.y - 15}
        />
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <circle
          class="rot-handle"
          cx={selScreen.x + selScreen.w / 2}
          cy={selScreen.y - 20}
          r="5"
          on:pointerdown={onRotateDown}
        />
        {#if gesture?.kind === "rotate" && rotateTip}
          <text class="rot-tip" x={selScreen.x + selScreen.w / 2 + 12} y={selScreen.y - 18}>{rotateTip}</text>
        {/if}
        {#each handlesScreen as hd}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <rect
            class="handle"
            x={hd.x}
            y={hd.y}
            width={HS}
            height={HS}
            style={`cursor:${hd.cursor}`}
            on:pointerdown={(e) => onHandleDown(e, hd.h)}
          />
        {/each}
      {/if}
    {/if}

    <!-- selected plot part -->
    {#if partBoxScreen}
      <rect
        class="part-box"
        x={partBoxScreen.x}
        y={partBoxScreen.y}
        width={partBoxScreen.w}
        height={partBoxScreen.h}
        fill="none"
      />
    {/if}

    <!-- pen preview -->
    {#if penScreenPts.length}
      <polyline class="pen-line" points={penScreenPts.join(" ")} />
      {#each penAnchors as a}
        <circle class="pen-anchor" class:first={a.first} cx={a.x} cy={a.y} r="4" />
      {/each}
    {/if}
  </svg>

  {#if $captionOpen}
    <CaptionEditor />
  {/if}

  {#if editingInfo}
    <textarea
      bind:this={taEl}
      class="text-edit"
      value={editingInfo.el.text}
      spellcheck="false"
      style={`left:${editingInfo.left}px; top:${editingInfo.top}px;
        font-family:${editingInfo.el.fontFamily};
        font-size:${editingInfo.el.fontSize * $viewport.zoom}px;
        font-weight:${editingInfo.el.fontWeight};
        font-style:${editingInfo.el.fontStyle};
        color:${editingInfo.el.color};
        text-align:${editingInfo.el.align};
        width:${Math.max(editingInfo.el.width, 8) * $viewport.zoom + 4}px;
        height:${Math.max(editingInfo.el.height, editingInfo.el.fontSize) * $viewport.zoom + 2}px;`}
      on:input={onTextInput}
      on:blur={finishEdit}
      on:pointerdown|stopPropagation
      on:dblclick|stopPropagation
      on:keydown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finishEdit();
        }
      }}
    ></textarea>
  {/if}
</div>

<style>
  .canvas-host {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--c-canvas);
    touch-action: none;
    user-select: none;
  }
  .fig-shadow {
    fill: var(--c-canvas-shadow);
  }
  .scene {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
    will-change: transform;
  }
  .scene-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    display: block;
  }
  .overlay-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .editing-hidden {
    opacity: 0;
  }
  .text-edit {
    position: absolute;
    margin: 0;
    padding: 0;
    border: none;
    outline: 1px solid var(--c-accent);
    background: transparent;
    resize: none;
    overflow: hidden;
    white-space: pre;
    line-height: 1.2;
    box-sizing: content-box;
    z-index: 10;
  }
  .figure-bg {
    stroke: #00000022;
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .figure-bg.active {
    stroke: var(--c-accent);
    vector-effect: non-scaling-stroke;
  }
  .figure-bg.droptarget {
    stroke: var(--c-accent);
    stroke-width: 3;
    vector-effect: non-scaling-stroke;
    filter: drop-shadow(0 0 6px var(--c-accent-glow));
  }
  .figure-bg.frame-selected {
    stroke: var(--c-accent);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .figure-titlebar {
    fill: transparent;
    pointer-events: all;
    cursor: move;
  }
  .figure-label {
    fill: var(--c-tx-2);
    font-family: var(--font-serif);
    dominant-baseline: text-after-edge;
    pointer-events: none;
  }
  .el {
    cursor: move;
  }
  .sel-box {
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: none;
  }
  .hover-box {
    stroke: var(--c-accent-bright);
    stroke-width: 1.5;
    pointer-events: none;
    vector-effect: non-scaling-stroke;
    rx: 1;
  }
  .part-box {
    stroke: var(--c-accent-bright);
    stroke-width: 1.5;
    stroke-dasharray: 3 2;
    pointer-events: none;
    vector-effect: non-scaling-stroke;
  }
  .handle {
    fill: var(--c-tx-hi);
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: all;
  }
  .rot-stem {
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: none;
  }
  .rot-handle {
    fill: var(--c-tx-hi);
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: all;
    cursor: grab;
  }
  .rot-tip {
    fill: var(--c-tx-hi);
    font-size: 11px;
    font-family: var(--font-mono);
    paint-order: stroke;
    stroke: var(--c-canvas);
    stroke-width: 3px;
    pointer-events: none;
  }
  .marquee {
    fill: var(--c-accent-tint);
    stroke: var(--c-accent);
    stroke-width: 1;
    pointer-events: none;
  }
  .guide {
    stroke: var(--c-guide);
    stroke-width: 1;
    pointer-events: none;
  }
  .pen-line {
    fill: none;
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: none;
  }
  .pen-anchor {
    fill: var(--c-tx-hi);
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: all;
  }
  .pen-anchor.first {
    fill: var(--c-accent);
  }
</style>
