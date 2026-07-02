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
    nodeEditId,
    arrange,
  } from "./store";
  import { commitArrange } from "./keyboard";
  import type { Element, Figure, PathElement, VectorNode } from "./types";
  import { get } from "svelte/store";
  import { applyAutoWidth } from "./text";
  import {
    elementBBox,
    selectionBBox,
    rectsIntersect,
    rotateAbout,
    gapBetween,
    type Rect,
  } from "./geometry";
  import { createDrawElement, createTextElement, resizeRemap, scaleRemap, applyDrawModifiers } from "./editing";
  import { nodesToPath, pathToNodes, constrain45 } from "./path";
  import * as ops from "./ops";
  import { settings } from "./settings";
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
  const RULER = 20; // ruler strip thickness in screen px (Feature 11)

  // Active ruler-guide drag (create from a ruler, or move/delete an existing one).
  // Modal like pen/node drags — handled before the Gesture union.
  let guideDrag: null | { axis: "x" | "y"; pos: number; creating: boolean; origPos: number } = null;

  let spaceDown = false;
  let altDown = false; // Feature 3 measurement caliper (Alt held, not mid-drag)

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
        scale?: boolean; // Scale tool (F5): also scales stroke/corner/font
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
  let altDupDone = false; // FIG-9: the deferred duplicate has been materialized (on first move)
  let pendingShiftToggle: string | null = null; // shift-click toggle deferred to up
  let gDX = 0;
  let gDY = 0;
  let fDX = 0; // live frame-move delta, world units (F8)
  let fDY = 0;
  let gNb: Rect | null = null;
  let liveBox: Rect | null = null;
  let marquee: Rect | null = null; // figure-local
  let lastMarqueeKey = ""; // FIG-1: last hit-set signature, to skip no-op selection.set
  let preview: Element | null = null;
  let guides: { x?: number; y?: number }[] = [];
  // Equal-spacing snap dimension lines during a move (F7), figure-local.
  let spacing: { x1: number; y1: number; x2: number; y2: number; label: string }[] = [];
  let rotateTip = ""; // live angle readout during a rotate drag

  function ensureCommitted() {
    if (!committed) {
      beginGesture();
      committed = true;
    }
  }

  // --- pen tool state (bezier authoring) ---
  // penNodes are figure-local; on finish they're handed to ops.addPath which
  // normalizes them to element-local (0,0) and sets the element x/y/bbox.
  let penNodes: VectorNode[] = [];
  let penFigId: string | null = null;
  let penCursor: { x: number; y: number } | null = null; // figure-local, for the rubber-band
  // While the button is held right after placing a node, dragging pulls out that
  // node's (symmetric) bezier handles — Figma/Illustrator click-drag behavior.
  let penDrag: { i: number } | null = null;

  // --- node-edit state (double-click / Enter on a selected path) ---
  let editPathId: string | null = null;
  let editNodes: VectorNode[] = []; // working copy, element-local; live during drag
  let editClosed = false;
  let editSel = new Set<number>(); // selected node indices (for handles + delete)
  // Active node/handle drag. `orig` snapshots editNodes at grab so a multi-node
  // move applies a clean delta; `started` defers beginGesture to the first move.
  let nodeDrag:
    | null
    | { kind: "node" | "in" | "out"; i: number; started: boolean; alt: boolean; sx: number; sy: number; orig: VectorNode[] } = null;

  const cloneNode = (n: VectorNode): VectorNode => ({
    x: n.x,
    y: n.y,
    type: n.type,
    hIn: n.hIn ? { ...n.hIn } : undefined,
    hOut: n.hOut ? { ...n.hOut } : undefined,
  });

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
    if (editPathId) exitNodeEdit(); // click on empty canvas leaves node-edit
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
    // A click into the figure background while node-editing exits the mode
    // (unless the pen is active — then it's placing/closing nodes).
    if (editPathId && $activeTool !== "pen") exitNodeEdit();
    e.stopPropagation();
    activeFigureId.set(fig.id);
    selectedFrameId.set(null);
    const lp = localPoint(e.clientX, e.clientY, fig);

    if ($activeTool === "select" || $activeTool === "scale") {
      if (!e.shiftKey) clearSelection();
      gesture = { kind: "marquee", figId: fig.id, x0: lp.x, y0: lp.y, add: new Set(e.shiftKey ? $selection : []) };
      gestureFig = fig;
      marquee = { x: lp.x, y: lp.y, w: 0, h: 0 };
      lastMarqueeKey = "\0"; // force the first hit-set of this marquee to apply
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
      // Click near the first node (with ≥2 placed) closes the path.
      if (penNodes.length >= 2 && penFigId === fig.id) {
        const first = penNodes[0];
        if (Math.hypot(lp.x - first.x, lp.y - first.y) < 8 / $viewport.zoom) {
          finishPen(true);
          return;
        }
      }
      if (penNodes.length === 0) penFigId = fig.id;
      if (penFigId === fig.id) {
        penNodes = [...penNodes, { x: lp.x, y: lp.y, type: "corner" }];
        penDrag = { i: penNodes.length - 1 }; // a drag now pulls out handles
        hostEl.setPointerCapture(e.pointerId);
      }
    }
  }

  function finishPen(close: boolean) {
    const figId = penFigId;
    if (penNodes.length >= 2 && figId) {
      const s = get(drawStyle);
      const nodes = penNodes.map(cloneNode);
      let created: string | null = null;
      beginGesture();
      mutate((p) => {
        created = ops.addPath(p, figId, {
          nodes,
          closed: close,
          // an open squiggle shouldn't be filled (it would fill the implied chord)
          fill: close ? s.fill : "none",
          stroke: s.stroke,
          strokeWidth: s.strokeWidth,
        });
      });
      if (created) selectOnly(created);
      activeTool.set("select");
    }
    penNodes = [];
    penFigId = null;
    penCursor = null;
    penDrag = null;
  }

  // --- node editing (double-click / Enter on a selected path) ---
  function enterNodeEdit(id: string) {
    const found = findElement($project, id);
    if (!found || found.element.type !== "path") return;
    const el = found.element;
    activeFigureId.set(found.figure.id);
    selectOnly(id);
    editPathId = id;
    editClosed = el.closed;
    // Adopt legacy d-only paths into nodes so ANY path becomes editable.
    const src = el.nodes && el.nodes.length ? el.nodes : pathToNodes(el.d);
    editNodes = src.map(cloneNode);
    editSel = new Set();
    nodeDrag = null;
    nodeEditId.set(id);
  }
  function exitNodeEdit() {
    editPathId = null;
    editNodes = [];
    editSel = new Set();
    nodeDrag = null;
    nodeEditId.set(null);
  }

  // Write the working nodes back through ops.updatePath (refit → normalize +
  // bbox + d), then reload the normalized nodes so the overlay stays in sync.
  // Assumes a gesture is already open (single undo entry for the whole edit).
  function commitNodes() {
    const id = editPathId;
    if (!id) return;
    const nodes = editNodes.map(cloneNode);
    mutate((p) => ops.updatePath(p, id, { nodes, closed: editClosed }));
    const f = findElement($project, id);
    if (f && f.element.type === "path" && f.element.nodes) editNodes = f.element.nodes.map(cloneNode);
  }

  // Keep the working node list in sync if the model path changes underneath us
  // while node-edit is open and idle — an undo/redo, or a bridge/AI edit. If the
  // path is gone (undo of its creation), leave the mode.
  function resyncEditNodes() {
    if (!editPathId || nodeDrag) return;
    const f = findElement($project, editPathId);
    if (!f || f.element.type !== "path") {
      exitNodeEdit();
      return;
    }
    const el = f.element;
    if (el.d !== nodesToPath(editNodes, editClosed)) {
      editClosed = el.closed;
      editNodes = (el.nodes && el.nodes.length ? el.nodes : pathToNodes(el.d)).map(cloneNode);
      editSel = new Set([...editSel].filter((i) => i < editNodes.length));
    }
  }
  $: void $project, editPathId, nodeDrag, resyncEditNodes();

  function onNodeDown(e: PointerEvent, i: number, kind: "node" | "in" | "out") {
    e.stopPropagation();
    if (startPanIfNeeded(e)) return;
    const found = findElement($project, editPathId ?? "");
    if (!found || found.element.type !== "path") return;
    if (kind === "node") {
      if (e.shiftKey) {
        const n = new Set(editSel);
        n.has(i) ? n.delete(i) : n.add(i);
        editSel = n;
      } else if (!editSel.has(i)) {
        editSel = new Set([i]);
      }
    }
    nodeDrag = { kind, i, started: false, alt: e.altKey, sx: 0, sy: 0, orig: editNodes.map(cloneNode) };
    // record element-local grab point. NOTE: don't capture the pointer yet —
    // capturing here would retarget a no-drag dblclick to the host (where
    // onDblClick is suppressed in node-edit), breaking corner↔smooth toggle.
    // Capture is taken on the first real move in onNodeDrag instead.
    const lp = localPoint(e.clientX, e.clientY, found.figure);
    nodeDrag.sx = lp.x - found.element.x;
    nodeDrag.sy = lp.y - found.element.y;
  }

  function onNodeDrag(e: PointerEvent) {
    const nd = nodeDrag;
    if (!nd || !editPathId) return;
    const found = findElement($project, editPathId);
    if (!found || found.element.type !== "path") return;
    const el = found.element;
    const lp = localPoint(e.clientX, e.clientY, found.figure);
    const ex = lp.x - el.x; // element-local (el.x/y stays fixed until commit)
    const ey = lp.y - el.y;
    if (!nd.started) {
      // ignore sub-pixel jitter so a plain click stays a click (selection only)
      if (Math.hypot(ex - nd.sx, ey - nd.sy) < 2 / $viewport.zoom) return;
      nd.started = true;
      try {
        hostEl.setPointerCapture(e.pointerId); // now that it's a real drag
      } catch {}
      beginGesture();
    }
    if (nd.kind === "node") {
      const dx = ex - nd.sx;
      const dy = ey - nd.sy;
      const targets = editSel.has(nd.i) && editSel.size ? [...editSel] : [nd.i];
      for (const ti of targets) {
        editNodes[ti].x = nd.orig[ti].x + dx;
        editNodes[ti].y = nd.orig[ti].y + dy;
      }
    } else {
      const n = editNodes[nd.i];
      let hdx = ex - n.x;
      let hdy = ey - n.y;
      if (e.shiftKey) ({ dx: hdx, dy: hdy } = constrain45(hdx, hdy));
      const breakSym = e.altKey || nd.alt;
      if (nd.kind === "out") {
        n.hOut = { dx: hdx, dy: hdy };
        if (breakSym) n.type = "corner";
        else if (n.type === "smooth") n.hIn = { dx: -hdx, dy: -hdy };
      } else {
        n.hIn = { dx: hdx, dy: hdy };
        if (breakSym) n.type = "corner";
        else if (n.type === "smooth") n.hOut = { dx: -hdx, dy: -hdy };
      }
    }
    editNodes = editNodes;
    // live scene update WITHOUT refit (keep el.x/y fixed so overlay math holds)
    const id = editPathId;
    const live = editNodes.map(cloneNode);
    mutate((p) => {
      const f = findElement(p, id);
      if (f && f.element.type === "path") {
        f.element.nodes = live;
        f.element.d = nodesToPath(live, editClosed);
      }
    });
  }

  function finishNodeDrag(e: PointerEvent) {
    if (nodeDrag?.started) commitNodes(); // refit + resync under the open gesture
    nodeDrag = null;
    try {
      hostEl.releasePointerCapture(e.pointerId);
    } catch {}
  }

  function toggleNodeType(i: number) {
    if (!editPathId) return;
    const n = editNodes[i];
    beginGesture();
    if (n.type === "smooth") {
      n.type = "corner";
    } else {
      n.type = "smooth";
      if (!n.hIn && !n.hOut) {
        // synthesize a tangent from the neighbours' direction
        const N = editNodes.length;
        const prev = editNodes[(i - 1 + N) % N];
        const next = editNodes[(i + 1) % N];
        const tx = next.x - prev.x;
        const ty = next.y - prev.y;
        const len = Math.hypot(tx, ty) || 1;
        const s = Math.min(len / 3, 40);
        const ux = (tx / len) * s;
        const uy = (ty / len) * s;
        n.hOut = { dx: ux, dy: uy };
        n.hIn = { dx: -ux, dy: -uy };
      } else {
        const hi = n.hIn as { dx: number; dy: number };
        const h = n.hOut ?? { dx: -hi.dx, dy: -hi.dy };
        n.hOut = { ...h };
        n.hIn = { dx: -h.dx, dy: -h.dy };
      }
    }
    editNodes = editNodes;
    commitNodes();
  }

  function deleteEditNodes() {
    if (!editPathId) return;
    const targets = editSel.size ? editSel : new Set<number>();
    if (!targets.size) return;
    const keep = editNodes.filter((_, i) => !targets.has(i));
    if (keep.length < 2) {
      // too few points to be a path — delete the whole element
      const id = editPathId;
      beginGesture();
      mutate((p) => {
        for (const f of p.figures) f.elements = f.elements.filter((x) => x.id !== id);
      });
      clearSelection();
      exitNodeEdit();
      return;
    }
    beginGesture();
    editNodes = keep;
    editSel = new Set();
    commitNodes();
  }

  // Split the segment starting at node index `s` at its midpoint (t=0.5),
  // preserving the curve exactly (De Casteljau for cubics; bisection for lines).
  function insertNodeAt(s: number) {
    if (!editPathId) return;
    const N = editNodes.length;
    const a = editNodes[s];
    const b = editNodes[(s + 1) % N];
    const mid = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const hasCurve = a.hOut || b.hIn;
    let node: VectorNode;
    beginGesture();
    if (hasCurve) {
      const p0 = { x: a.x, y: a.y };
      const p1 = a.hOut ? { x: a.x + a.hOut.dx, y: a.y + a.hOut.dy } : { x: a.x, y: a.y };
      const p2 = b.hIn ? { x: b.x + b.hIn.dx, y: b.y + b.hIn.dy } : { x: b.x, y: b.y };
      const p3 = { x: b.x, y: b.y };
      const m01 = mid(p0, p1);
      const m12 = mid(p1, p2);
      const m23 = mid(p2, p3);
      const m012 = mid(m01, m12);
      const m123 = mid(m12, m23);
      const mm = mid(m012, m123);
      a.hOut = { dx: m01.x - a.x, dy: m01.y - a.y };
      b.hIn = { dx: m23.x - b.x, dy: m23.y - b.y };
      node = { x: mm.x, y: mm.y, type: "smooth", hIn: { dx: m012.x - mm.x, dy: m012.y - mm.y }, hOut: { dx: m123.x - mm.x, dy: m123.y - mm.y } };
    } else {
      const m = mid(a, b);
      node = { x: m.x, y: m.y, type: "corner" };
    }
    editNodes = [...editNodes.slice(0, s + 1), node, ...editNodes.slice(s + 1)];
    editSel = new Set([s + 1]);
    commitNodes();
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
    // Clicking a DIFFERENT element while node-editing leaves the mode first, then
    // proceeds with a normal selection (node markers stopPropagation, so a click
    // that reaches here is genuinely on the scene, not a node).
    if (editPathId && el.id !== editPathId) exitNodeEdit();
    if ($activeTool !== "select" && $activeTool !== "scale") {
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

  function snapTargets(fig: Figure, excludeIds: Set<string>): { xs: number[]; ys: number[] } {
    const xs = [0, fig.width, fig.width / 2];
    const ys = [0, fig.height, fig.height / 2];
    for (const el of fig.elements) {
      if (excludeIds.has(el.id)) continue;
      const b = elementBBox(el);
      xs.push(b.x, b.x + b.w, b.x + b.w / 2);
      ys.push(b.y, b.y + b.h, b.y + b.h / 2);
    }
    // Ruler guides join the snap targets (Feature 11).
    if (fig.guides?.x) xs.push(...fig.guides.x);
    if (fig.guides?.y) ys.push(...fig.guides.y);
    return { xs, ys };
  }

  function beginMove(e: PointerEvent, fig: Figure) {
    const sel = selectedEls(fig);
    // Alt-drag = duplicate-on-drag (Figma-style). FIG-9: the duplication is DEFERRED
    // to the first real move (performAltDup) — an alt-CLICK with no drag must leave
    // NOTHING behind (no stray copy, no history entry). Until then the gesture
    // targets the originals; on first move the copies become the moved set.
    gestureAltDup = e.altKey && sel.length > 0;
    altDupDone = false;
    const origs = new Map<string, Element>();
    for (const el of sel) origs.set(el.id, structuredClone(el));
    const ob = selectionBBox(sel) ?? { x: 0, y: 0, w: 0, h: 0 };
    const { xs, ys } = snapTargets(fig, new Set(sel.map((el) => el.id)));
    gesture = { kind: "move", figId: fig.id, sx: e.clientX, sy: e.clientY, origs, ob, xs, ys };
    gestureFig = fig;
    gestureEls = sel;
    committed = false;
    dragging = false;
    gDX = 0;
    gDY = 0;
    liveBox = ob;
    hostEl.setPointerCapture(e.pointerId);
  }

  // FIG-9: materialize the alt-drag copies on the first real move. Clones the
  // originals in place, makes the copies the moved set (re-keying origs + snap
  // targets), and opens one history entry covering the duplicate + the drag.
  function performAltDup(fig: Figure) {
    const g = gesture;
    if (!g || g.kind !== "move") return;
    altDupDone = true;
    beginGesture(); // single history entry for duplicate + drag
    committed = true;
    const originals = gestureEls;
    const newIds: string[] = [];
    const grpRemap = new Map<string, string>();
    mutate((p) => {
      const f = p.figures.find((ff) => ff.id === fig.id);
      if (!f) return;
      const copies = originals.map((el) => {
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
    const copies = f2.elements.filter((el) => newIds.includes(el.id));
    gestureEls = copies;
    // Re-key origs to the copies (identical geometry) so the move delta applies to
    // them; the now-unselected originals become valid snap targets.
    const origs = new Map<string, Element>();
    for (const el of copies) origs.set(el.id, structuredClone(el));
    g.origs = origs;
    const t = snapTargets(fig, new Set(newIds));
    g.xs = t.xs;
    g.ys = t.ys;
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

  // Equal-spacing snap candidate (F7): if the moving bbox M sits between two
  // row/column neighbours (siblings sharing M's cross-axis band), the offset that
  // makes both gaps equal + the two dimension lines that show it. Null if there's
  // no straddling pair or the equal position is out of threshold.
  function equalGap(M: Rect, sibs: Rect[], axis: "h" | "v", thr: number) {
    const band = sibs.filter((s) =>
      axis === "h" ? s.y < M.y + M.h && s.y + s.h > M.y : s.x < M.x + M.w && s.x + s.w > M.x,
    );
    const mc = axis === "h" ? M.x + M.w / 2 : M.y + M.h / 2;
    let left: Rect | null = null;
    let right: Rect | null = null;
    for (const s of band) {
      const sc = axis === "h" ? s.x + s.w / 2 : s.y + s.h / 2;
      if (sc < mc) {
        if (!left || (axis === "h" ? s.x + s.w > left.x + left.w : s.y + s.h > left.y + left.h)) left = s;
      } else if (!right || (axis === "h" ? s.x < right.x : s.y < right.y)) right = s;
    }
    if (!left || !right) return null;
    if (axis === "h") {
      const gap = (right.x - (left.x + left.w) - M.w) / 2;
      if (gap < 0) return null;
      const off = left.x + left.w + gap - M.x;
      if (Math.abs(off) > thr) return null;
      const y = M.y + M.h / 2;
      const nx = M.x + off;
      const lbl = `${Math.round(gap)}`;
      return { off, lines: [
        { x1: left.x + left.w, y1: y, x2: nx, y2: y, label: lbl },
        { x1: nx + M.w, y1: y, x2: right.x, y2: y, label: lbl },
      ] };
    }
    const gap = (right.y - (left.y + left.h) - M.h) / 2;
    if (gap < 0) return null;
    const off = left.y + left.h + gap - M.y;
    if (Math.abs(off) > thr) return null;
    const x = M.x + M.w / 2;
    const ny = M.y + off;
    const lbl = `${Math.round(gap)}`;
    return { off, lines: [
      { x1: x, y1: left.y + left.h, x2: x, y2: ny, label: lbl },
      { x1: x, y1: ny + M.h, x2: x, y2: right.y, label: lbl },
    ] };
  }

  // --- ruler guides (Feature 11) ---
  // "Nice" world-unit step (~64 screen px per tick) for the ruler labels.
  function niceStep(zoom: number): number {
    const raw = 64 / zoom;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    const m = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return m * p;
  }
  // Drag from a ruler strip → begin creating a guide (axis "x" = vertical guide
  // from the LEFT ruler; "y" = horizontal guide from the TOP ruler).
  function onRulerDown(e: PointerEvent, axis: "x" | "y") {
    if (!af || $captionOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const w = clientToWorld(e.clientX, e.clientY);
    const pos = axis === "x" ? w.x - af.x : w.y - af.y;
    guideDrag = { axis, pos, creating: true, origPos: pos };
    hostEl.setPointerCapture(e.pointerId);
  }
  function onGuideDown(e: PointerEvent, axis: "x" | "y", pos: number) {
    if (!af || $captionOpen) return;
    e.stopPropagation();
    guideDrag = { axis, pos, creating: false, origPos: pos };
    hostEl.setPointerCapture(e.pointerId);
  }
  function onGuideDragMove(e: PointerEvent) {
    if (!guideDrag || !af) return;
    const w = clientToWorld(e.clientX, e.clientY);
    guideDrag.pos = guideDrag.axis === "x" ? w.x - af.x : w.y - af.y;
    guideDrag = guideDrag;
  }
  function finishGuideDrag(e: PointerEvent) {
    const gd = guideDrag;
    if (gd && af) {
      const figId = af.id;
      const inFig = gd.axis === "x" ? gd.pos >= 0 && gd.pos <= af.width : gd.pos >= 0 && gd.pos <= af.height;
      if (gd.creating) {
        if (inFig) {
          beginGesture();
          mutate((p) => ops.addGuide(p, figId, gd.axis, gd.pos));
        }
      } else {
        // move existing (drag off the figure = delete)
        beginGesture();
        mutate((p) => {
          ops.removeGuide(p, figId, gd.axis, gd.origPos, 0.5);
          if (inFig) ops.addGuide(p, figId, gd.axis, gd.pos);
        });
      }
    }
    guideDrag = null;
    try {
      hostEl.releasePointerCapture(e.pointerId);
    } catch {}
  }

  function onHandleDown(e: PointerEvent, handle: Handle) {
    e.stopPropagation();
    if ($captionOpen) return; // read-only while the caption editor is open
    const fig = activeFigure();
    if (!fig || !overlayBox) return;
    const sel = selectedEls(fig);
    const origs = new Map<string, Element>();
    for (const el of sel) origs.set(el.id, structuredClone(el));
    gesture = { kind: "resize", figId: fig.id, handle, ob: { ...overlayBox }, origs, scale: $activeTool === "scale" };
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
    // Ruler-guide drag (modal — no Gesture).
    if (guideDrag) {
      onGuideDragMove(e);
      return;
    }
    // Node-edit drag (no Gesture — modal on editPathId).
    if (nodeDrag) {
      onNodeDrag(e);
      return;
    }
    if ($activeTool === "pen" && penFigId) {
      const pf = $project.figures.find((f) => f.id === penFigId);
      if (pf) {
        const lp = localPoint(e.clientX, e.clientY, pf);
        penCursor = lp;
        if (penDrag) {
          // pull symmetric handles out of the just-placed node → smooth node
          const n = penNodes[penDrag.i];
          let dx = lp.x - n.x;
          let dy = lp.y - n.y;
          if (e.shiftKey) ({ dx, dy } = constrain45(dx, dy));
          n.hOut = { dx, dy };
          n.hIn = { dx: -dx, dy: -dy };
          n.type = "smooth";
          penNodes = penNodes;
        }
      }
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
      const nextSpacing: typeof spacing = [];
      if (!e.altKey) {
        const thr = 6 / $viewport.zoom;
        const mx = g.ob.x + dx;
        const my = g.ob.y + dy;
        const sX = snap([mx, mx + g.ob.w / 2, mx + g.ob.w], g.xs, thr);
        const sY = snap([my, my + g.ob.h / 2, my + g.ob.h], g.ys, thr);
        // sibling bboxes for equal-spacing (F7) — excludes the moving set + hidden
        const movedIds = new Set(gestureEls.map((el) => el.id));
        const sibs = fig.elements.filter((el) => !movedIds.has(el.id) && !el.hidden).map(elementBBox);
        if (sX.line != null && lockAxis !== "y") {
          dx += sX.off;
          nextGuides.push({ x: sX.line });
        } else if (lockAxis !== "y") {
          const eg = equalGap({ x: g.ob.x + dx, y: g.ob.y + dy, w: g.ob.w, h: g.ob.h }, sibs, "h", thr);
          if (eg) {
            dx += eg.off;
            nextSpacing.push(...eg.lines);
          }
        }
        if (sY.line != null && lockAxis !== "x") {
          dy += sY.off;
          nextGuides.push({ y: sY.line });
        } else if (lockAxis !== "x") {
          const eg = equalGap({ x: g.ob.x + dx, y: g.ob.y + dy, w: g.ob.w, h: g.ob.h }, sibs, "v", thr);
          if (eg) {
            dy += eg.off;
            nextSpacing.push(...eg.lines);
          }
        }
        // Snap-to-grid (Feature 11): if no stronger snap grabbed an axis, quantize
        // the top-left to the grid.
        if ($settings.snapGrid && $settings.gridSize > 0) {
          const G = $settings.gridSize;
          if (lockAxis !== "y" && !nextGuides.some((q) => q.x != null) && !nextSpacing.length)
            dx += Math.round((g.ob.x + dx) / G) * G - (g.ob.x + dx);
          if (lockAxis !== "x" && !nextGuides.some((q) => q.y != null) && !nextSpacing.length)
            dy += Math.round((g.ob.y + dy) / G) * G - (g.ob.y + dy);
        }
      }
      // FIG-9: first real movement of an alt-drag materializes the copies now
      // (deferred from pointer-down so a bare alt-click leaves nothing behind).
      if (gestureAltDup && !altDupDone && (dx !== 0 || dy !== 0)) performAltDup(fig);
      startDragging();
      guides = nextGuides;
      spacing = nextSpacing;
      gDX = dx;
      gDY = dy;
      liveBox = { x: g.ob.x + dx, y: g.ob.y + dy, w: g.ob.w, h: g.ob.h };
    } else if (g.kind === "resize") {
      const lp = localPoint(e.clientX, e.clientY, fig);
      // The Scale tool always scales uniformly; a single locked-aspect element does
      // too (no Shift needed).
      const forceAspect = g.scale || (gestureEls.length === 1 && !!gestureEls[0].lockAspect);
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
      // FIG-1: dragging the marquee re-ran expandGroups + every selection-dependent
      // reactive (handles, inspector, bbox) on EACH pointermove even when the hit set
      // hadn't changed. Only push a new selection when the result actually differs.
      const expanded = expandGroups($project, hit);
      const key = [...expanded].sort().join(",");
      if (key !== lastMarqueeKey) {
        lastMarqueeKey = key;
        selection.set(expanded);
      }
    } else if (g.kind === "draw") {
      const lp = localPoint(e.clientX, e.clientY, fig);
      // Creation modifiers (F12): Shift = square/circle or 45° line; Alt = from centre.
      const { p0, p1 } = applyDrawModifiers($activeTool, { x: g.x0, y: g.y0 }, lp, e.shiftKey, e.altKey);
      preview = createDrawElement($activeTool, p0, p1, get(drawStyle));
    }
  }

  function onPointerUp(e: PointerEvent) {
    // End a ruler-guide drag (modal — no Gesture).
    if (guideDrag) {
      finishGuideDrag(e);
      return;
    }
    // End a node-edit drag (modal — no Gesture).
    if (nodeDrag) {
      finishNodeDrag(e);
      return;
    }
    // End a pen handle-drag; the node (with its handles) stays for the next click.
    if (penDrag) {
      penDrag = null;
      try {
        hostEl.releasePointerCapture(e.pointerId);
      } catch {}
      return;
    }
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
              if ($settings.snapPixel) {
                el.x = Math.round(el.x);
                el.y = Math.round(el.y);
              }
            }
          }
        });
        // Remember the last move offset so Ctrl+D repeats the same step (F4) —
        // whether it was an alt-drag-copy or a plain move of the selection.
        lastDupOffset.set({ dx: gDX, dy: gDY });
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
          if (o) {
            if (g.scale) scaleRemap(el, o, g.ob, nb);
            else resizeRemap(el, o, g.ob, nb);
            if ($settings.snapPixel) {
              el.x = Math.round(el.x);
              el.y = Math.round(el.y);
              if ("width" in el) el.width = Math.round(el.width);
              if ("height" in el) el.height = Math.round(el.height);
            }
          }
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
    spacing = [];
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
    if (e.key === "Alt") altDown = true; // caliper (measure) mode
    if (typing) return;

    // Shift+R toggles the rulers (Feature 11).
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyR") {
      e.preventDefault();
      settings.update((s) => ({ ...s, showRulers: !s.showRulers }));
      return;
    }

    // Node-edit mode owns the keyboard (keyboard.ts yields on nodeEditId).
    if (editPathId) {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        exitNodeEdit();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteEditNodes();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        editSel = new Set(editNodes.map((_, i) => i));
      }
      return;
    }

    // Pen authoring: Enter finishes (open), Esc cancels.
    if (penNodes.length) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishPen(false);
      } else if (e.key === "Escape") {
        penNodes = [];
        penFigId = null;
        penCursor = null;
        penDrag = null;
      }
      return;
    }

    // Enter node-edit on a single selected path (Figma: Enter to edit vertices).
    if (e.key === "Enter" && $selection.size === 1) {
      const id = [...$selection][0];
      const f = findElement($project, id);
      if (f && f.element.type === "path" && !f.element.locked) {
        e.preventDefault();
        enterNodeEdit(id);
      }
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code === "Space") spaceDown = false;
    if (e.key === "Alt") altDown = false;
  }
  function onWinBlur() {
    spaceDown = false;
    altDown = false; // don't leave the caliper stuck on if focus leaves mid-hold
  }

  let prevTool = $activeTool;
  $: if ($activeTool !== prevTool) {
    if (prevTool === "pen" && penNodes.length >= 2) finishPen(false);
    else if (prevTool === "pen") {
      penNodes = [];
      penFigId = null;
      penCursor = null;
      penDrag = null;
    }
    prevTool = $activeTool;
  }

  function onDblClick() {
    if ($captionOpen) return; // read-only while the caption editor is open
    if (editPathId) return; // node markers/segments handle their own dblclicks
    if (penNodes.length >= 2) {
      finishPen(false);
      return;
    }
    // Double-click to edit: text → inline editor; path → node-edit mode.
    const ids = [...$selection];
    if (ids.length === 1) {
      const f = findElement($project, ids[0]);
      if (f && f.element.type === "text") startEdit(f.element, true);
      else if (f && f.element.type === "path" && !f.element.locked) enterNodeEdit(ids[0]);
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
      editPathId ||
      $captionOpen ||
      ($activeTool !== "select" && $activeTool !== "scale") ||
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
  // Pen preview draws in figure-local coords inside a transform group (like the
  // draw preview), so bezier handles scale correctly with zoom.
  $: penTransform = penFig
    ? `translate(${$viewport.panX + penFig.x * $viewport.zoom} ${$viewport.panY + penFig.y * $viewport.zoom}) scale(${$viewport.zoom})`
    : "";
  $: penMainD = penFig && penNodes.length ? nodesToPath(penNodes, false) : "";
  // rubber-band from the last node to the cursor (hidden while dragging handles)
  $: penBandD =
    penFig && penNodes.length && penCursor && !penDrag
      ? nodesToPath([penNodes[penNodes.length - 1], { x: penCursor.x, y: penCursor.y, type: "corner" }], false)
      : "";
  $: penAnchors =
    penFig && penNodes.length
      ? penNodes.map((n, i) => ({
          x: $viewport.panX + (penFig!.x + n.x) * $viewport.zoom,
          y: $viewport.panY + (penFig!.y + n.y) * $viewport.zoom,
          first: i === 0,
          smooth: n.type === "smooth",
        }))
      : [];
  // live handle line for the node whose handles are being dragged out
  $: penHandle = (() => {
    if (!penFig || !penDrag) return null;
    const n = penNodes[penDrag.i];
    const px = (x: number) => $viewport.panX + (penFig!.x + x) * $viewport.zoom;
    const py = (y: number) => $viewport.panY + (penFig!.y + y) * $viewport.zoom;
    return {
      bx: px(n.x),
      by: py(n.y),
      ox: n.hOut ? px(n.x + n.hOut.dx) : null,
      oy: n.hOut ? py(n.y + n.hOut.dy) : null,
      ix: n.hIn ? px(n.x + n.hIn.dx) : null,
      iy: n.hIn ? py(n.y + n.hIn.dy) : null,
    };
  })();

  // --- node-edit overlay geometry (screen px) ---
  $: editInfo = (() => {
    if (!editPathId) return null;
    const f = findElement($project, editPathId);
    if (!f || f.element.type !== "path") return null;
    return { el: f.element as PathElement, fig: f.figure };
  })();
  // group transform mapping the edited path's local space → screen (for the
  // highlighted outline). Uses el.x/y which is held fixed during a node drag.
  $: editTransform = editInfo
    ? `translate(${$viewport.panX + (editInfo.fig.x + editInfo.el.x) * $viewport.zoom} ${$viewport.panY + (editInfo.fig.y + editInfo.el.y) * $viewport.zoom}) scale(${$viewport.zoom})`
    : "";
  $: editScreen = (() => {
    if (!editInfo) return null;
    const fx = editInfo.fig.x + editInfo.el.x;
    const fy = editInfo.fig.y + editInfo.el.y;
    const px = (x: number) => $viewport.panX + (fx + x) * $viewport.zoom;
    const py = (y: number) => $viewport.panY + (fy + y) * $viewport.zoom;
    const N = editNodes.length;
    const nodes = editNodes.map((n, i) => ({
      i,
      x: px(n.x),
      y: py(n.y),
      smooth: n.type === "smooth",
      sel: editSel.has(i),
      hIn: n.hIn && editSel.has(i) ? { x: px(n.x + n.hIn.dx), y: py(n.y + n.hIn.dy) } : null,
      hOut: n.hOut && editSel.has(i) ? { x: px(n.x + n.hOut.dx), y: py(n.y + n.hOut.dy) } : null,
    }));
    // segment midpoints (screen) → click to insert a node
    const segCount = editClosed ? N : N - 1;
    const mids: { s: number; x: number; y: number }[] = [];
    for (let s = 0; s < segCount; s++) {
      const a = editNodes[s];
      const b = editNodes[(s + 1) % N];
      const de = (t: number, p0: number, p1: number, p2: number, p3: number) => {
        const u = 1 - t;
        return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
      };
      const a1x = a.x + (a.hOut?.dx ?? 0);
      const a1y = a.y + (a.hOut?.dy ?? 0);
      const b1x = b.x + (b.hIn?.dx ?? 0);
      const b1y = b.y + (b.hIn?.dy ?? 0);
      mids.push({ s, x: px(de(0.5, a.x, a1x, b1x, b.x)), y: py(de(0.5, a.y, a1y, b1y, b.y)) });
    }
    return { nodes, mids };
  })();

  // Feature 3 — measurement caliper. Alt + a live selection: red dimension lines
  // to the hovered element's edges (equal-gutter checking) or, over empty space,
  // to the figure edges. Pure overlay; suppressed mid-gesture so Alt-drag-dup and
  // Alt-disable-snap keep working.
  $: measure = (() => {
    if (!altDown || !af || gesture || dragging || editPathId || $captionOpen || $activeTool !== "select") return null;
    const sel = af.elements.filter((e) => $selection.has(e.id));
    if (!sel.length) return null;
    const S = selectionBBox(sel);
    if (!S) return null;
    const r = (v: number) => `${Math.round(v)}`;
    const lines: { x1: number; y1: number; x2: number; y2: number; label: string }[] = [];
    const tgt = $hoverId && !$selection.has($hoverId) ? af.elements.find((e) => e.id === $hoverId && !e.hidden) : null;
    if (tgt) {
      const T = elementBBox(tgt);
      const g = gapBetween(S, T);
      if (!g.overlapX) {
        const L = S.x < T.x ? S : T;
        const R = S.x < T.x ? T : S;
        const yT = Math.max(S.y, T.y);
        const yB = Math.min(S.y + S.h, T.y + T.h);
        const y = yB > yT ? (yT + yB) / 2 : (S.y + S.h / 2 + (T.y + T.h / 2)) / 2;
        lines.push({ x1: L.x + L.w, y1: y, x2: R.x, y2: y, label: r(R.x - (L.x + L.w)) });
      }
      if (!g.overlapY) {
        const U = S.y < T.y ? S : T;
        const D = S.y < T.y ? T : S;
        const xL = Math.max(S.x, T.x);
        const xR = Math.min(S.x + S.w, T.x + T.w);
        const x = xR > xL ? (xL + xR) / 2 : (S.x + S.w / 2 + (T.x + T.w / 2)) / 2;
        lines.push({ x1: x, y1: U.y + U.h, x2: x, y2: D.y, label: r(D.y - (U.y + U.h)) });
      }
    } else {
      const cx = S.x + S.w / 2;
      const cy = S.y + S.h / 2;
      lines.push({ x1: 0, y1: cy, x2: S.x, y2: cy, label: r(S.x) });
      lines.push({ x1: S.x + S.w, y1: cy, x2: af.width, y2: cy, label: r(af.width - (S.x + S.w)) });
      lines.push({ x1: cx, y1: 0, x2: cx, y2: S.y, label: r(S.y) });
      lines.push({ x1: cx, y1: S.y + S.h, x2: cx, y2: af.height, label: r(af.height - (S.y + S.h)) });
    }
    return lines.filter((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1) > 0.5);
  })();
  $: measureScreen =
    measure && af
      ? measure.map((l) => ({
          x1: $viewport.panX + (af!.x + l.x1) * $viewport.zoom,
          y1: $viewport.panY + (af!.y + l.y1) * $viewport.zoom,
          x2: $viewport.panX + (af!.x + l.x2) * $viewport.zoom,
          y2: $viewport.panY + (af!.y + l.y2) * $viewport.zoom,
          mx: $viewport.panX + (af!.x + (l.x1 + l.x2) / 2) * $viewport.zoom,
          my: $viewport.panY + (af!.y + (l.y1 + l.y2) / 2) * $viewport.zoom,
          horizontal: l.y1 === l.y2,
          label: l.label,
        }))
      : [];
  // Equal-spacing dimension lines during a move (F7) — same red rendering.
  $: spacingScreen =
    spacing.length && af
      ? spacing.map((l) => ({
          x1: $viewport.panX + (af!.x + l.x1) * $viewport.zoom,
          y1: $viewport.panY + (af!.y + l.y1) * $viewport.zoom,
          x2: $viewport.panX + (af!.x + l.x2) * $viewport.zoom,
          y2: $viewport.panY + (af!.y + l.y2) * $viewport.zoom,
          mx: $viewport.panX + (af!.x + (l.x1 + l.x2) / 2) * $viewport.zoom,
          my: $viewport.panY + (af!.y + (l.y1 + l.y2) / 2) * $viewport.zoom,
          horizontal: l.y1 === l.y2,
          label: l.label,
        }))
      : [];

  // --- Feature 11: rulers / guides / grid (screen-space) ---
  $: rulerHTicks =
    $settings.showRulers && hostW
      ? (() => {
          const z = $viewport.zoom;
          const pan = $viewport.panX;
          const step = niceStep(z);
          const out: { sx: number; label: string }[] = [];
          const wl = (RULER - pan) / z;
          const wr = (hostW - pan) / z;
          for (let wx = Math.ceil(wl / step) * step; wx <= wr; wx += step) out.push({ sx: pan + wx * z, label: `${Math.round(wx)}` });
          return out;
        })()
      : [];
  $: rulerVTicks =
    $settings.showRulers && hostH
      ? (() => {
          const z = $viewport.zoom;
          const pan = $viewport.panY;
          const step = niceStep(z);
          const out: { sy: number; label: string }[] = [];
          const wt = (RULER - pan) / z;
          const wb = (hostH - pan) / z;
          for (let wy = Math.ceil(wt / step) * step; wy <= wb; wy += step) out.push({ sy: pan + wy * z, label: `${Math.round(wy)}` });
          return out;
        })()
      : [];
  // Existing guides for the active figure + the live drag preview, mapped to screen.
  $: guideScreen = (() => {
    if (!af) return [] as any[];
    const lines: { axis: "x" | "y"; pos: number; preview: boolean }[] = [];
    for (const x of af.guides?.x ?? [])
      if (!(guideDrag && !guideDrag.creating && guideDrag.axis === "x" && Math.abs(guideDrag.origPos - x) < 0.5)) lines.push({ axis: "x", pos: x, preview: false });
    for (const y of af.guides?.y ?? [])
      if (!(guideDrag && !guideDrag.creating && guideDrag.axis === "y" && Math.abs(guideDrag.origPos - y) < 0.5)) lines.push({ axis: "y", pos: y, preview: false });
    if (guideDrag) lines.push({ axis: guideDrag.axis, pos: guideDrag.pos, preview: true });
    return lines.map((g) =>
      g.axis === "x"
        ? {
            vertical: true,
            axis: "x" as const,
            pos: g.pos,
            preview: g.preview,
            sx: $viewport.panX + (af!.x + g.pos) * $viewport.zoom,
            a: $viewport.panY + af!.y * $viewport.zoom,
            b: $viewport.panY + (af!.y + af!.height) * $viewport.zoom,
          }
        : {
            vertical: false,
            axis: "y" as const,
            pos: g.pos,
            preview: g.preview,
            sy: $viewport.panY + (af!.y + g.pos) * $viewport.zoom,
            a: $viewport.panX + af!.x * $viewport.zoom,
            b: $viewport.panX + (af!.x + af!.width) * $viewport.zoom,
          },
    );
  })();
  // Background grid path (figure-local) for the active figure.
  $: gridD = (() => {
    if (!$settings.showGrid || !af || $settings.gridSize <= 0) return "";
    const G = $settings.gridSize;
    const W = af.width;
    const H = af.height;
    if (W / G + H / G > 4000) return ""; // too dense to be useful — skip
    let d = "";
    for (let x = 0; x <= W + 0.5; x += G) d += `M ${x} 0 L ${x} ${H} `;
    for (let y = 0; y <= H + 0.5; y += G) d += `M 0 ${y} L ${W} ${y} `;
    return d;
  })();

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
  on:blur={onWinBlur}
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
            {#if gridD && fig.id === $activeFigureId}
              <path class="grid" d={gridD} clip-path={`url(#clip-${fig.id})`} />
            {/if}
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
                    if (($activeTool === "select" || $activeTool === "scale") && !$captionOpen) hoverId.set(el.id);
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

    <!-- measurement caliper (Alt + selection): red gap dimensions -->
    {#each measureScreen as m}
      <line class="measure" x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} />
      {#if m.horizontal}
        <line class="measure" x1={m.x1} y1={m.y1 - 4} x2={m.x1} y2={m.y1 + 4} />
        <line class="measure" x1={m.x2} y1={m.y2 - 4} x2={m.x2} y2={m.y2 + 4} />
      {:else}
        <line class="measure" x1={m.x1 - 4} y1={m.y1} x2={m.x1 + 4} y2={m.y1} />
        <line class="measure" x1={m.x2 - 4} y1={m.y2} x2={m.x2 + 4} y2={m.y2} />
      {/if}
      <rect class="measure-bg" x={m.mx - (m.label.length * 3.5 + 5)} y={m.my - 8} width={m.label.length * 7 + 10} height="16" rx="3" />
      <text class="measure-label" x={m.mx} y={m.my} text-anchor="middle" dominant-baseline="central">{m.label}</text>
    {/each}

    <!-- equal-spacing snap dimensions (F7, during a move) -->
    {#each spacingScreen as m}
      <line class="measure" x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} />
      {#if m.horizontal}
        <line class="measure" x1={m.x1} y1={m.y1 - 4} x2={m.x1} y2={m.y1 + 4} />
        <line class="measure" x1={m.x2} y1={m.y2 - 4} x2={m.x2} y2={m.y2 + 4} />
      {:else}
        <line class="measure" x1={m.x1 - 4} y1={m.y1} x2={m.x1 + 4} y2={m.y1} />
        <line class="measure" x1={m.x2 - 4} y1={m.y2} x2={m.x2 + 4} y2={m.y2} />
      {/if}
      <rect class="measure-bg" x={m.mx - (m.label.length * 3.5 + 5)} y={m.my - 8} width={m.label.length * 7 + 10} height="16" rx="3" />
      <text class="measure-label" x={m.mx} y={m.my} text-anchor="middle" dominant-baseline="central">{m.label}</text>
    {/each}

    <!-- selection box + handles (hidden during node-edit — nodes stand in) -->
    {#if selScreen && !editingInfo && !editPathId}
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

    <!-- pen preview: committed curve (solid) + rubber-band to cursor (dashed) -->
    {#if penMainD}
      <g transform={penTransform}>
        <path class="pen-line" d={penMainD} vector-effect="non-scaling-stroke" />
        {#if penBandD}
          <path class="pen-band" d={penBandD} vector-effect="non-scaling-stroke" />
        {/if}
      </g>
      {#if penHandle}
        {#if penHandle.ox != null}
          <line class="node-handle-line" x1={penHandle.bx} y1={penHandle.by} x2={penHandle.ox} y2={penHandle.oy} />
          <circle class="node-handle" cx={penHandle.ox} cy={penHandle.oy} r="3.5" />
        {/if}
        {#if penHandle.ix != null}
          <line class="node-handle-line" x1={penHandle.bx} y1={penHandle.by} x2={penHandle.ix} y2={penHandle.iy} />
          <circle class="node-handle" cx={penHandle.ix} cy={penHandle.iy} r="3.5" />
        {/if}
      {/if}
      {#each penAnchors as a}
        <circle class="pen-anchor" class:first={a.first} class:smooth={a.smooth} cx={a.x} cy={a.y} r={a.first ? 5 : 4} />
      {/each}
    {/if}

    <!-- node-edit overlay: outline + segment-insert markers + handles + nodes -->
    {#if editInfo && editScreen}
      <g transform={editTransform}>
        <path class="node-edit-path" d={editInfo.el.d} vector-effect="non-scaling-stroke" />
      </g>
      {#each editScreen.mids as m}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <circle
          class="node-insert"
          cx={m.x}
          cy={m.y}
          r="4"
          on:pointerdown={(e) => {
            e.stopPropagation();
            insertNodeAt(m.s);
          }}
        />
      {/each}
      {#each editScreen.nodes as n}
        {#if n.hIn}
          <line class="node-handle-line" x1={n.x} y1={n.y} x2={n.hIn.x} y2={n.hIn.y} />
        {/if}
        {#if n.hOut}
          <line class="node-handle-line" x1={n.x} y1={n.y} x2={n.hOut.x} y2={n.hOut.y} />
        {/if}
      {/each}
      {#each editScreen.nodes as n}
        {#if n.hIn}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <circle class="node-handle" cx={n.hIn.x} cy={n.hIn.y} r="3.5" on:pointerdown={(e) => onNodeDown(e, n.i, "in")} />
        {/if}
        {#if n.hOut}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <circle class="node-handle" cx={n.hOut.x} cy={n.hOut.y} r="3.5" on:pointerdown={(e) => onNodeDown(e, n.i, "out")} />
        {/if}
      {/each}
      {#each editScreen.nodes as n}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        {#if n.smooth}
          <circle
            class="node-pt"
            class:sel={n.sel}
            cx={n.x}
            cy={n.y}
            r="4.5"
            on:pointerdown={(e) => onNodeDown(e, n.i, "node")}
            on:dblclick={(e) => {
              e.stopPropagation();
              toggleNodeType(n.i);
            }}
          />
        {:else}
          <rect
            class="node-pt"
            class:sel={n.sel}
            x={n.x - 4}
            y={n.y - 4}
            width="8"
            height="8"
            on:pointerdown={(e) => onNodeDown(e, n.i, "node")}
            on:dblclick={(e) => {
              e.stopPropagation();
              toggleNodeType(n.i);
            }}
          />
        {/if}
      {/each}
    {/if}

    <!-- ruler guides (Feature 11): draggable guide lines + live preview -->
    {#each guideScreen as g}
      {#if g.vertical}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <line class="guide-hit" x1={g.sx} y1={g.a} x2={g.sx} y2={g.b} on:pointerdown={(e) => onGuideDown(e, "x", g.pos)} />
        <line class="guide-line" class:preview={g.preview} x1={g.sx} y1={g.a} x2={g.sx} y2={g.b} />
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <line class="guide-hit" x1={g.a} y1={g.sy} x2={g.b} y2={g.sy} on:pointerdown={(e) => onGuideDown(e, "y", g.pos)} />
        <line class="guide-line" class:preview={g.preview} x1={g.a} y1={g.sy} x2={g.b} y2={g.sy} />
      {/if}
    {/each}

    <!-- rulers (Feature 11): screen-space strips, drag out a guide -->
    {#if $settings.showRulers}
      <rect class="ruler" x={RULER} y="0" width={Math.max(0, hostW - RULER)} height={RULER} on:pointerdown={(e) => onRulerDown(e, "y")} role="presentation" />
      {#each rulerHTicks as t}
        <line class="ruler-tick" x1={t.sx} y1={RULER - 6} x2={t.sx} y2={RULER} />
        <text class="ruler-label" x={t.sx + 3} y="9">{t.label}</text>
      {/each}
      <rect class="ruler" x="0" y={RULER} width={RULER} height={Math.max(0, hostH - RULER)} on:pointerdown={(e) => onRulerDown(e, "x")} role="presentation" />
      {#each rulerVTicks as t}
        <line class="ruler-tick" x1={RULER - 6} y1={t.sy} x2={RULER} y2={t.sy} />
        <text class="ruler-label" x="10" y={t.sy - 3} transform={`rotate(-90 10 ${t.sy - 3})`}>{t.label}</text>
      {/each}
      <rect class="ruler-corner" x="0" y="0" width={RULER} height={RULER} />
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
  /* --- rulers / guides / grid (Feature 11) --- */
  .grid {
    fill: none;
    stroke: var(--c-tx-muted);
    stroke-width: 0.5;
    opacity: 0.28;
    pointer-events: none;
    vector-effect: non-scaling-stroke;
  }
  .guide-line {
    stroke: var(--c-guide-2);
    stroke-width: 1;
    pointer-events: none;
  }
  .guide-line.preview {
    stroke-dasharray: 4 3;
  }
  .guide-hit {
    stroke: transparent;
    stroke-width: 9;
    cursor: grab;
    pointer-events: stroke;
  }
  .ruler {
    fill: var(--c-surface);
    opacity: 0.96;
    cursor: crosshair;
    pointer-events: all;
  }
  .ruler-corner {
    fill: var(--c-surface);
    pointer-events: none;
  }
  .ruler-tick {
    stroke: var(--c-tx-muted);
    stroke-width: 1;
    pointer-events: none;
  }
  .ruler-label {
    fill: var(--c-tx-muted);
    font-size: 9px;
    pointer-events: none;
  }

  /* --- measurement caliper (Feature 3) --- */
  .measure {
    stroke: #e5484d;
    stroke-width: 1;
    pointer-events: none;
  }
  .measure-bg {
    fill: #e5484d;
    pointer-events: none;
  }
  .measure-label {
    fill: #fff;
    font-size: 11px;
    font-weight: 600;
    pointer-events: none;
  }

  .pen-line {
    fill: none;
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: none;
  }
  .pen-band {
    fill: none;
    stroke: var(--c-accent);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
    opacity: 0.6;
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
  .pen-anchor.smooth {
    fill: var(--c-accent);
  }

  /* --- node-edit chrome --- */
  .node-edit-path {
    fill: none;
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: none;
  }
  .node-handle-line {
    stroke: var(--c-accent);
    stroke-width: 1;
    opacity: 0.7;
    pointer-events: none;
  }
  .node-handle {
    fill: var(--c-bg);
    stroke: var(--c-accent);
    stroke-width: 1.5;
    cursor: crosshair;
    pointer-events: all;
  }
  .node-pt {
    fill: var(--c-bg);
    stroke: var(--c-accent);
    stroke-width: 1.5;
    cursor: move;
    pointer-events: all;
  }
  .node-pt.sel {
    fill: var(--c-accent);
  }
  .node-insert {
    fill: none;
    stroke: var(--c-accent);
    stroke-width: 1.25;
    stroke-dasharray: 2 2;
    opacity: 0.55;
    cursor: copy;
    pointer-events: all;
  }
  .node-insert:hover {
    fill: var(--c-accent);
    opacity: 0.9;
  }
</style>
