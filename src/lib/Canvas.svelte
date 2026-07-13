<script lang="ts">
  import {
    project,
    viewport,
    activeFigureId,
    activeCanvasId,
    selection,
    partSelection,
    enteredGroupId,
    activeTool,
    drawStyle,
    selectOnly,
    clearSelection,
    selectFrame,
    selectedFrameId,
    beginGesture,
    rollbackGesture,
    gestureCancelHook,
    mutate,
    mutateFigure,
    figureRev,
    globalRev,
    expandGroups,
    newId,
    findElement,
    lastDupOffset,
    captionOpen,
    hoverId,
    nodeEditId,
    arrange,
  } from "./store";
  import { chainOf, cloneGroupsFor, effectiveHidden, effectiveLocked, unitOf } from "./groups";
  import { perfCounters } from "./dev/perfCounters";
  // WS-3.2: shared interaction core (Canvas + SlideStage) — math only.
  import { HANDLES, handlePos, cursorFor, type Handle } from "./interact/handles";
  import { computeResizeBox } from "./interact/gestureMath";
  import { snap, boxSnapTargets } from "./interact/snap";
  import { commitArrange } from "./keyboard";
  import type { Element, Figure, ImageElement, LineElement, PathElement, Project, SemanticPlotElement, VectorNode } from "./types";
  import { get } from "svelte/store";
  import { onMount } from "svelte";
  import { applyTextLayout, lineH, visualLines } from "./text";
  import {
    elementBBox,
    rotatedAABB,
    rectIntersectsElement,
    selectionBBox,
    rectsIntersect,
    rotateAbout,
    rotatePoint,
    gapBetween,
    lineWorldEndpoints,
    type Rect,
  } from "./geometry";
  import { createDrawElement, createTextElement, resizeRemap, scaleRemap, applyDrawModifiers, cropRemap, lineEndpointRemap, type CropRemapResult } from "./editing";
  import { nodesToPath, pathToNodes, constrain45, segsFromNodes, nearestTOnSeg, bendSegment } from "./path";
  import { penSnap, type PenSnapResult } from "./interact/penSnap";
  import * as ops from "./ops";
  import { settings } from "./settings";
  import { importDroppedFiles } from "./io";
  import { pushToast, errMsg } from "./toast";
  import { isScaffoldPart, resolvePartId } from "./plot/partStyle";
  import { plotManifests } from "./plot/store";
  import ElementView from "./Element.svelte";
  import CaptionEditor from "./CaptionEditor.svelte";

  // ===========================================================================
  // Rendering architecture (performance-critical):
  //  - The "scene" holds all committed content. Panning is a CSS transform on
  //    its wrapper (compositor-only, NO repaint). Zooming is compositor-only
  //    too while the wheel burst lasts (a residual scale on the wrapper); the
  //    content repaints ONCE per zoom gesture, when the settle fold bakes the
  //    zoom into the scene SVG (renderZoom — see the P6 rationale block below).
  //  - ALL live interaction (dragged-element previews, selection box + handles,
  //    marquee, guides, draw/pen previews) renders on a separate screen-space
  //    overlay. During a drag/resize the scene is frozen (originals hidden) and
  //    only the small overlay updates, so cost is independent of window size /
  //    resolution. The scene repaints exactly once, on pointer-up.
  //  - The scene wrapper is promoted (will-change) ONLY while interacting; at
  //    idle it demotes, releasing its tile allocation and re-rastering at full
  //    quality — crisp at rest without any interaction (P6 blur fix).
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
        // figure-v1 P5: ctrl/meta-drag on a handle = CROP (exactly one unlocked
        // image/plot with a sized asset). The snapshot pins the content→canvas
        // mapping for the whole gesture; everything stays transient until the
        // single pointer-up commit (ops.setCrop). Esc rides the normal
        // transient-only cancel.
        crop?: { orig: ImageElement | SemanticPlotElement; disp: { width: number; height: number } };
      }
    | {
        // Figma-parity line pivot: drag ONE endpoint, the other stays fixed.
        // Rotation/flip are baked into the endpoints at grab. WS-1 Fix 2: the
        // drag is fully TRANSIENT — `live` (a private clone) accumulates the
        // remap per move and renders via the scene-slot override; ONE
        // beginGesture+mutate on pointer-up commits it (Esc just drops it).
        kind: "lineEnd";
        figId: string;
        id: string;
        which: 1 | 2;
        fixed: { x: number; y: number }; // figure-local, transform baked
        live: LineElement;
      }
    | {
        kind: "marquee";
        figId: string;
        x0: number;
        y0: number;
        add: Set<string>;
        // P7: the pointerdown deselected (no shift) — if the gesture ends as a
        // plain CLICK (no real drag), pointer-up also exits the entered-group
        // scope entirely (Figma: background click = full exit; a real marquee
        // keeps the scope it selected within).
        bgClick: boolean;
      }
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
      }
    | {
        // Move one PART of a semantic plot (drag writes an id-keyed {dx,dy}
        // override in PLOT-LOCAL units on release; the drag itself is a
        // transient DOM transform — the model stays frozen until commit).
        kind: "partmove";
        figId: string;
        elementId: string;
        partId: string;
        node: SVGGraphicsElement; // the live mounted node (prefixed id)
        inv: DOMMatrix; // screen → plot-local, captured at pointerdown
        sx: number; // client coords at down
        sy: number;
        baseDx: number; // existing override translation (or 0)
        baseDy: number;
        baseTransform: string; // node's transform attribute at down (restored on Esc)
        restTransform: string; // baseTransform minus the override's translate prefix
      };

  let gesture: Gesture = null;

  // Live, transient gesture state (drives the overlay; never the scene).
  let gestureFig: Figure | null = null;
  let gestureEls: Element[] = [];
  let gestureHiddenIds = new Set<string>();
  let dragging = false;
  let committed = false;
  // WS-1 Fix 2: live line-pivot clone (reassigned per move → scene-slot preview).
  let lineEndLive: LineElement | null = null;
  let gestureAltDup = false; // current move is an alt-drag-copy
  let altDupDone = false; // FIG-9: the deferred duplicate has been materialized (on first move)
  let pendingShiftToggle: string | null = null; // shift-click toggle deferred to up
  let gDX = 0;
  let gDY = 0;
  let fDX = 0; // live frame-move delta, world units (F8)
  let fDY = 0;
  let pDX = 0; // live part-move translation, PLOT-LOCAL units (dx/dy override)
  let pDY = 0;
  // Transient highlight for the moving part (screen px). The reactive
  // partBoxScreen suppresses itself during gestures, so the drag draws its own
  // box from the live node's bounding rect each frame.
  let partMoveBox: { x: number; y: number; w: number; h: number } | null = null;
  let gNb: Rect | null = null;
  let liveBox: Rect | null = null;
  let marquee: Rect | null = null; // figure-local
  let lastMarqueeKey = ""; // FIG-1: last hit-set signature, to skip no-op selection.set
  let preview: Element | null = null;
  let guides: { x?: number; y?: number }[] = [];
  // Equal-spacing snap dimension lines during a move (F7), figure-local.
  let spacing: { x1: number; y1: number; x2: number; y2: number; label: string }[] = [];
  let rotateTip = ""; // live angle readout during a rotate drag
  let gRotDeg = 0; // FIG-1: live rotate delta (deg); drives a transient transform, committed on release
  // Crop gesture transients (figure-v1 P5): the last cropRemap result (drives
  // the ghost/clip overlay + the one-shot commit) and the "Crop" chip anchor
  // (host-relative screen px, near the pointer — rotateTip precedent).
  let cropRes: CropRemapResult | null = null;
  let cropChip: { x: number; y: number } | null = null;

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
  // Placement assist (interact/penSnap): penRaw is the last RAW cursor point so
  // Shift/Alt keydown/keyup can re-snap without a mouse move; penSnapRes drives
  // penCursor (the snapped point) + the guide/close overlays. One function feeds
  // both preview and placement, so clicks land exactly where the preview shows.
  let penRaw: { x: number; y: number } | null = null;
  let penSnapRes: PenSnapResult | null = null;

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
  // Figma bend: ctrl+drag anywhere on a segment curves it (path.ts bendSegment
  // moves the two flanking handles so the curve passes through the drag point).
  // t is fixed at the grab parameter; deltas accumulate against `orig`.
  let bendDrag: null | { s: number; t: number; sx: number; sy: number; started: boolean; orig: VectorNode[] } = null;
  let ctrlDown = false; // cursor affordance on segment hits

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

  // P7 groups: effective hidden/locked = own flag OR any ancestor GROUP's
  // eye/padlock (registry state). Precomputed ONCE per project change for every
  // element on the active canvas (the plan's perf note) — the render filter,
  // hit-testing, hover preview and marquee all consult this map instead of
  // re-walking ancestor chains per element per event/frame.
  // WS-1 Fix 3a/3b: (a) group-FREE figures contribute no entries — the
  // effHidden/effLocked fallbacks (own flags) are exact for them, so the map
  // stays empty on ungrouped projects; (b) the whole map is memoized on the
  // figure revisions — a scoped commit to one figure (mutateFigure) leaves the
  // map identity unchanged unless a grouped figure actually changed.
  // Memos live in a NON-reactive const box: reassigning a component `let` that
  // the same $: block reads makes the effect self-dependent (it re-runs until
  // the scheduler's loop guard trips — a measured 4× pan regression).
  // WS-1 Fix 7: while the Figure pane is hidden behind another mode (keep-alive)
  // the expensive derives return their FROZEN last value — no recompute per
  // notify. Reactivation re-runs them (paneActive is a dep) and the rev-keyed
  // memos recompute exactly the figures whose revisions moved while hidden.
  export let paneActive = true;

  const effMemoBox = { key: "", val: new Map<string, { hidden: boolean; locked: boolean }>() };
  $: effState = (() => {
    if (!paneActive) return effMemoBox.val;
    const key =
      canvasFigures.map((f) => `${f.id}:${$figureRev[f.id] ?? 0}`).join(",") + `|${$globalRev}`;
    if (key === effMemoBox.key) return effMemoBox.val;
    perfCounters.effRecomputes++;
    const m = new Map<string, { hidden: boolean; locked: boolean }>();
    for (const f of canvasFigures) {
      if (!f.groups || !Object.keys(f.groups).length) continue; // 3a fast path
      for (const el of f.elements)
        m.set(el.id, { hidden: effectiveHidden(f, el), locked: effectiveLocked(f, el) });
    }
    effMemoBox.key = key;
    effMemoBox.val = m;
    return m;
  })();
  const effHidden = (el: Element) => effState.get(el.id)?.hidden ?? !!el.hidden;
  const effLocked = (el: Element) => effState.get(el.id)?.locked ?? !!el.locked;

  // P7: a live commit can delete/dissolve the ENTERED group (⌘⇧G, bridge verb,
  // member delete) — store.pruneSelection only covers undo/redo paths. Drop the
  // scope the moment its registry def disappears so clicks never resolve
  // against a stale scope.
  $: {
    const eg = $enteredGroupId;
    if (eg && !$project.figures.some((f) => f.groups?.[eg])) enteredGroupId.set(null);
  }

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
    // P6: the cull keys off renderZoom (the scale baked into the scene), not the
    // live zoom — recomputing per wheel tick would re-diff the scene content
    // mid-gesture. While the zoom is unsettled the visible set is FROZEN (the
    // key is skipped); the fold flips zoomUnsettled off and re-culls once.
    const z = renderZoom;
    const ready = hostW > 0 && hostH > 0;
    const qx = ready ? Math.round($viewport.panX / CULL_STEP) * CULL_STEP : 0;
    const qy = ready ? Math.round($viewport.panY / CULL_STEP) * CULL_STEP : 0;
    const key = ready ? `${hostW}x${hostH}@${z}:${qx},${qy}` : "all";
    if (!zoomUnsettled && key !== cullKey) {
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
    // Hidden elements (Layers eye — the element's own OR an ancestor group's,
    // via effectiveHidden/effState, P7) are never rendered — so never hit-testable.
    if (dragging && gesture?.kind === "figmove" && gesture.figId === fig.id)
      return fig.elements.filter((el) => !effHidden(el));
    const lr: Rect = { x: cullRect.x - fig.x, y: cullRect.y - fig.y, w: cullRect.w, h: cullRect.h };
    // FIG-4: cull by the ROTATED bounds — a tilted element near the viewport edge must
    // not vanish while its spun corners are still visible (unrotated = same fast path).
    return fig.elements.filter(
      (el) => !effHidden(el) && ($selection.has(el.id) || rectsIntersect(rotatedAABB(el), lr)),
    );
  }
  // Precompute the per-figure visible element lists keyed off the (stable-within-a-
  // pan-step) cull rect + selection, so the template's {#each} only re-diffs when
  // the cull region/selection/project actually change — not on every pan frame.
  // WS-1 Fix 3b: per-figure culled-elements memo. The per-figure ARRAY keeps
  // its identity unless that figure's revision (or a global input: cull rect,
  // selection, gesture phase, global rev) changed — so the keyed scene {#each}
  // skips re-reconciling untouched figures entirely. Non-numeric deps
  // (selection set, gesture object, dragging flag) fold in as identity
  // generations tracked in the non-reactive box (see effMemoBox note).
  const visMemoBox = {
    map: new Map<string, { key: string; els: Element[] }>(),
    sel: null as Set<string> | null,
    selGen: 0,
    ges: null as Gesture,
    drag: false,
    gesGen: 0,
    // cullRect is quantized (only re-assigned every CULL_STEP px of pan — the
    // F5 design above); its IDENTITY is the correct change signal. Do not key
    // on its fields: a per-flush string here once collided with the culling
    // throttle's own `cullKey` let and forced a re-cull every pan frame.
    cullRef: null as Rect | null,
    cullGen: 0,
    frozen: new Map<string, Element[]>(), // last computed map (Fix 7 suspension)
  };
  $: visibleByFig = (() => {
    if (!paneActive) return visMemoBox.frozen; // Fix 7: hidden pane — no recompute
    void effState; // P7: group eyes change the visible set (effHidden reads it)
    if ($selection !== visMemoBox.sel) {
      visMemoBox.sel = $selection;
      visMemoBox.selGen++;
    }
    if (gesture !== visMemoBox.ges || dragging !== visMemoBox.drag) {
      visMemoBox.ges = gesture;
      visMemoBox.drag = dragging;
      visMemoBox.gesGen++;
    }
    if (cullRect !== visMemoBox.cullRef) {
      visMemoBox.cullRef = cullRect;
      visMemoBox.cullGen++;
    }
    const next = new Map<string, { key: string; els: Element[] }>();
    const m = new Map<string, Element[]>();
    for (const f of visibleFigures) {
      const key = `${$figureRev[f.id] ?? 0}|${$globalRev}|${visMemoBox.cullGen}|${visMemoBox.selGen}|${visMemoBox.gesGen}`;
      let mm = visMemoBox.map.get(f.id);
      if (!mm || mm.key !== key) {
        perfCounters.visRecomputes++;
        mm = { key, els: visibleEls(f) };
      }
      next.set(f.id, mm);
      m.set(f.id, mm.els);
    }
    visMemoBox.map = next;
    visMemoBox.frozen = m;
    return m;
  })();

  // selection bbox in active-figure-local coords
  $: overlayBox = (() => {
    const fig = $project.figures.find((f) => f.id === $activeFigureId);
    if (!fig) return null;
    return selectionBBox(fig.elements.filter((e) => $selection.has(e.id)));
  })();

  // --- one repaint per zoom gesture + will-change lifecycle (figure-v1 P6) ---
  //
  // RATIONALE (diagnosis: notes/Flux_Electron_Compositor_Notes.md, Phase 0a):
  // the .scene layer's raster area grows as content-bounds × zoom², and a
  // PERMANENTLY promoted (will-change) layer of that size gets budget-limited
  // tiles — content rendered soft at rest (reproduced at DSF 2) and Electron
  // logged "tile memory limits exceeded". Only DEMOTING the layer releases the
  // full-quality raster; plain repaints re-raster at the same capped scale
  // (no-op commit and a real 1px mutation were both bit-identical). On top of
  // that, the old <g scale($viewport.zoom)> made EVERY wheel tick a full
  // content repaint. Contract:
  //  1. renderZoom is the scale BAKED into the scene SVG (<g scale(renderZoom)>).
  //     $viewport.zoom stays the live truth for overlay/rulers/hit-testing; the
  //     scene wrapper carries a compositor-only residual scale(zoom/renderZoom)
  //     mid-gesture, so a zoom burst costs ONE content repaint — the settle
  //     fold (ZOOM_SETTLE_MS after the last zoom change) sets renderZoom = zoom
  //     and the residual returns to exactly 1. The world→screen mapping is
  //     pan + zoom·w at ALL times (renderZoom cancels out), so gesture math,
  //     hit-testing, getBoundingClientRect and getScreenCTM captures stay exact
  //     mid-residual too (zoom-about-cursor is unchanged).
  //  2. Scene-INTERNAL screen-constant sizes (empty-hint, figure titlebar,
  //     figure label) divide by renderZoom, NOT $viewport.zoom — one live-zoom
  //     read inside the scene template silently reintroduces per-tick repaints.
  //     (They scale with the residual mid-burst and snap crisp on the fold.)
  //  3. Culling keys off renderZoom and is frozen while the zoom is unsettled
  //     (an uncovered margin for ≤ ZOOM_SETTLE_MS on zoom-out is accepted);
  //     pan-quantized re-culling is unchanged.
  //  4. Any gesture pointerdown folds IMMEDIATELY (foldZoomNow, capture phase):
  //     a gesture must never run on a residual-scaled scene where a later
  //     settle fold would repaint under its feet (partmove holds a captured CTM
  //     and a transient DOM transform on a live node). The settle timer
  //     likewise never folds while an interaction is in flight — it re-checks
  //     until idle. Programmatic viewport.set is covered by the settle timer
  //     (verify scripts sleep ≥ 250ms > ZOOM_SETTLE_MS).
  //  5. will-change lifecycle: .scene has NO permanent will-change (neither in
  //     CSS nor inline). style:will-change promotes it only while sceneHot —
  //     an interaction is live (gesture / guideDrag / nodeDrag / unsettled
  //     zoom / wheel pan) or ended less than SCENE_COOL_MS ago — and drops to
  //     null at idle. The idle demotion IS the blur fix: the layer re-rasters
  //     at full quality and its tile allocation is released. `contain: paint`
  //     is FORBIDDEN on .scene (it clips panned content — verified).
  const ZOOM_SETTLE_MS = 180; // fold delay after the last zoom change
  const SCENE_COOL_MS = 200; // will-change demotion delay after the last interaction
  let renderZoom = get(viewport).zoom;
  let zoomUnsettled = false;
  let zoomSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let sceneHot = false;
  let sceneCoolTimer: ReturnType<typeof setTimeout> | null = null;

  /** Promote the scene layer NOW (same event turn as the interaction start);
   *  demote SCENE_COOL_MS after the last call once nothing is live. One timer,
   *  coalesced — long interactions stay hot via the re-check loop. */
  function keepSceneHot() {
    sceneHot = true;
    if (sceneCoolTimer) clearTimeout(sceneCoolTimer);
    sceneCoolTimer = setTimeout(maybeCoolScene, SCENE_COOL_MS);
  }
  function maybeCoolScene() {
    sceneCoolTimer = null;
    if (gesture || guideDrag || nodeDrag || zoomUnsettled) {
      sceneCoolTimer = setTimeout(maybeCoolScene, SCENE_COOL_MS); // still busy — re-check
    } else {
      sceneHot = false; // idle demotion → full-quality re-raster + tile release
    }
  }

  /** Arm/refresh the settle fold — runs (reactively) on every zoom change, from
   *  any writer: wheel, Toolbar zoom buttons, scripts' viewport.set. */
  function scheduleZoomFold() {
    zoomUnsettled = true;
    keepSceneHot();
    if (zoomSettleTimer) clearTimeout(zoomSettleTimer);
    zoomSettleTimer = setTimeout(foldZoom, ZOOM_SETTLE_MS);
  }
  function foldZoom() {
    zoomSettleTimer = null;
    if (gesture || guideDrag || nodeDrag) {
      // Never fold under an in-flight interaction (contract §4) — re-check.
      zoomSettleTimer = setTimeout(foldZoom, ZOOM_SETTLE_MS);
      return;
    }
    zoomUnsettled = false;
    renderZoom = get(viewport).zoom; // THE one content repaint of the gesture
  }
  /** Immediate fold at gesture pointerdown (contract §4). The screen mapping is
   *  residual-invariant, so handlers in this same event turn (including the
   *  partmove getScreenCTM capture) read correct values whether or not the DOM
   *  flush has landed yet. */
  function foldZoomNow() {
    if (zoomSettleTimer) {
      clearTimeout(zoomSettleTimer);
      zoomSettleTimer = null;
    }
    if (zoomUnsettled || renderZoom !== get(viewport).zoom) {
      zoomUnsettled = false;
      renderZoom = get(viewport).zoom;
    }
  }
  $: if ($viewport.zoom !== renderZoom) scheduleZoomFold();
  // Gesture starts promote in the same event turn their pointerdown runs
  // (Svelte flushes this before the frame paints); guide/node drags reassign
  // per-move, which just refreshes the cool timer.
  $: if (gesture !== null || guideDrag !== null || nodeDrag !== null) keepSceneHot();

  // --- pan / zoom ---
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    keepSceneHot(); // promote in the same event turn the pan/zoom burst starts
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
    lastDownEl = null; // background pointerdown — no element under a dblclick
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
    lastDownEl = null; // figure-background pointerdown (also the locked/tool fallthrough)
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
      // P7: deselect on pointerdown (Figma), but DON'T exit the entered-group
      // scope yet — a marquee drag started on the figure background must keep
      // selecting within the scope; only a plain background CLICK (no drag)
      // exits it entirely (the marquee branch of onPointerUp).
      if (!e.shiftKey) {
        selection.set(new Set());
        partSelection.set(null);
      }
      gesture = { kind: "marquee", figId: fig.id, x0: lp.x, y0: lp.y, add: new Set(e.shiftKey ? $selection : []), bgClick: !e.shiftKey };
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
      // Same assist as the pointermove preview (close / shift-45 / align /
      // equal-length) so the click lands exactly where the preview showed.
      // A click inside the close radius of the first node closes the path.
      const assist = penSnap(penNodes, lp, { zoom: $viewport.zoom, shift: e.shiftKey, disable: e.altKey });
      if (assist.close && penFigId === fig.id) {
        finishPen(true);
        return;
      }
      if (penNodes.length === 0) penFigId = fig.id;
      if (penFigId === fig.id) {
        penNodes = [...penNodes, { x: assist.pt.x, y: assist.pt.y, type: "corner" }];
        penDrag = { i: penNodes.length - 1 }; // a drag now pulls out handles
        penSnapRes = null; // guides hide while handles are being pulled
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
    penRaw = null;
    penSnapRes = null;
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
    const figId = findElement($project, id)?.figure.id;
    const apply = (p: Project) => ops.updatePath(p, id, { nodes, closed: editClosed });
    figId ? mutateFigure(figId, apply) : mutate(apply);
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

  // ---------------------------------------------------------------------
  // Rotation/flip-aware mapping between a path element's LOCAL space and
  // FIGURE space (Element.svelte's buildTransform: flip about the bbox centre
  // first, then rotate about it). Every node-edit overlay position and every
  // pointer→node conversion must round trip through these — translate+scale
  // alone leaves markers/hits at the UNROTATED pose while the element renders
  // rotated (the "stuck on the original shape" bug).
  // ---------------------------------------------------------------------
  function elMapPoint(el: Element, p: { x: number; y: number }): { x: number; y: number } {
    const b = elementBBox(el);
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    let q = { x: el.x + p.x, y: el.y + p.y };
    const sx = el.flipX ? -1 : 1;
    const sy = el.flipY ? -1 : 1;
    if (sx !== 1 || sy !== 1) q = { x: c.x + (q.x - c.x) * sx, y: c.y + (q.y - c.y) * sy };
    return el.rotation ? rotatePoint(q, c, el.rotation) : q;
  }
  function elUnmapPoint(el: Element, q: { x: number; y: number }): { x: number; y: number } {
    const b = elementBBox(el);
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    let p = el.rotation ? rotatePoint(q, c, -el.rotation) : { x: q.x, y: q.y };
    const sx = el.flipX ? -1 : 1;
    const sy = el.flipY ? -1 : 1;
    if (sx !== 1 || sy !== 1) p = { x: c.x + (p.x - c.x) * sx, y: c.y + (p.y - c.y) * sy };
    return { x: p.x - el.x, y: p.y - el.y };
  }
  /** SVG transform string: element-LOCAL coords → screen, incl. rotation/flip.
   *  `vp` passed explicitly so reactive callers keep their $viewport dep visible. */
  function elOverlayTransform(vp: { panX: number; panY: number; zoom: number }, figXY: { x: number; y: number }, el: Element): string {
    const parts = [`translate(${vp.panX + figXY.x * vp.zoom} ${vp.panY + figXY.y * vp.zoom}) scale(${vp.zoom})`];
    const sx = el.flipX ? -1 : 1;
    const sy = el.flipY ? -1 : 1;
    if (el.rotation || sx !== 1 || sy !== 1) {
      const b = elementBBox(el);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (el.rotation) parts.push(`rotate(${el.rotation} ${cx} ${cy})`);
      if (sx !== 1 || sy !== 1) parts.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
    }
    parts.push(`translate(${el.x} ${el.y})`);
    return parts.join(" ");
  }

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
    const g = elUnmapPoint(found.element, lp);
    nodeDrag.sx = g.x;
    nodeDrag.sy = g.y;
  }

  function onNodeDrag(e: PointerEvent) {
    const nd = nodeDrag;
    if (!nd || !editPathId) return;
    const found = findElement($project, editPathId);
    if (!found || found.element.type !== "path") return;
    const el = found.element;
    const lp = localPoint(e.clientX, e.clientY, found.figure);
    // element-local incl. rotation/flip (el.x/y stays fixed until commit)
    const { x: ex, y: ey } = elUnmapPoint(el, lp);
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
    // WS-1 Fix 2: the live path renders as a TRANSIENT preview from editNodes
    // (nodeDragLive swaps into the element's scene slot + the overlay outline)
    // — no per-pointermove mutate()/store notify. finishNodeDrag → commitNodes
    // applies the accumulated result once, under the beginGesture above.
  }

  function finishNodeDrag(e: PointerEvent) {
    if (nodeDrag?.started) commitNodes(); // refit + resync under the open gesture
    nodeDrag = null;
    try {
      hostEl.releasePointerCapture(e.pointerId);
    } catch {}
  }

  // --- bend (ctrl+drag a segment; Figma's bend tool) ---
  function onSegDown(e: PointerEvent, s: number) {
    if (!e.ctrlKey || !editPathId) return;
    const found = findElement($project, editPathId);
    if (!found || found.element.type !== "path") return;
    e.stopPropagation();
    const el = found.element;
    const lp = localPoint(e.clientX, e.clientY, found.figure);
    const { x: ex, y: ey } = elUnmapPoint(el, lp);
    const segs = segsFromNodes(editNodes, editClosed);
    const t = segs[s] ? nearestTOnSeg(segs[s], ex, ey).t : 0.5;
    bendDrag = { s, t, sx: ex, sy: ey, started: false, orig: editNodes.map(cloneNode) };
    try {
      hostEl.setPointerCapture(e.pointerId);
    } catch {}
  }

  function onBendDrag(e: PointerEvent) {
    const bd = bendDrag;
    if (!bd || !editPathId) return;
    const found = findElement($project, editPathId);
    if (!found || found.element.type !== "path") return;
    const el = found.element;
    const lp = localPoint(e.clientX, e.clientY, found.figure);
    const { x: ex, y: ey } = elUnmapPoint(el, lp);
    if (!bd.started) {
      if (Math.hypot(ex - bd.sx, ey - bd.sy) < 2 / $viewport.zoom) return;
      bd.started = true;
      beginGesture();
    }
    editNodes = bendSegment(bd.orig, bd.s, editClosed, bd.t, ex - bd.sx, ey - bd.sy);
    // live preview rides nodeDragLive (same transient scene-slot mechanism)
  }

  function finishBendDrag(e: PointerEvent) {
    if (bendDrag?.started) commitNodes();
    bendDrag = null;
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
        applyTextLayout(f.element);
      }
    });
  }
  // Ctrl/Cmd+B/I/U inside the inline editor: toggle on the edited element via
  // mutate — the edit session already opened ONE beginGesture, so the whole
  // session (typing + toggles) stays a single undo entry.
  function onTextEditToggle(which: "bold" | "italic" | "underline") {
    if (!editingId) return;
    const id = editingId;
    mutate((p) => {
      ops.toggleTextStyle(p, [id], which);
      const f = findElement(p, id);
      if (f) applyTextLayout(f.element); // bold changes metrics → re-wrap
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
    // Locked elements (own padlock OR an ancestor GROUP's, P7) can't be
    // selected/moved via the canvas (only from the Layers panel). Treat a click
    // on one like a click on the figure (marquee / clear).
    if (effLocked(el)) {
      onFigureDown(e, fig);
      return;
    }
    e.stopPropagation();
    activeFigureId.set(fig.id);
    selectedFrameId.set(null);
    // P7: record the element under this pointerdown — beginMove takes pointer
    // capture, which retargets the compatibility dblclick to the HOST, so the
    // host dblclick handler resolves "which element was double-clicked" from
    // this record (same trap the node-edit capture comment documents).
    lastDownEl = { id: el.id, t: performance.now() };
    // P7: clicks resolve to selection UNITS bounded by the entered-group scope
    // (Figma). Clicking an element OUTSIDE the entered group exits the scope
    // entirely first (like a background click), so a stale scope never
    // redirects what a click selects.
    let scope = $enteredGroupId;
    if (scope && !chainOf(fig, el).includes(scope)) {
      enteredGroupId.set(null);
      scope = null;
    }
    const unit = unitOf(fig, el, scope);
    // Drill into a semantic plot: clicking an ALREADY-selected plot selects the
    // part under the cursor (its prefixed DOM id → canonical semantic id) and —
    // for a REAL part — arms a part-move gesture, so a drag moves the part
    // itself (an id-keyed {dx,dy} override). SCAFFOLD parts (figure/plot-area/
    // background patches/axis containers) clear the part selection and fall
    // through to the normal whole-plot move — else the plot would be
    // un-draggable by its own background. P7: only when the plot is its OWN
    // unit at the current scope — a plot inside a selected GROUP moves the
    // group; double-click enters the group first (Figma), then clicks drill.
    if (el.type === "plot" && unit.groupId === null && $selection.has(el.id)) {
      // (DOM Element is shadowed by the figure-model Element import → cast via unknown)
      const pid = resolvePartId($plotManifests[el.assetId], e.target as unknown as globalThis.Element, el.id);
      const scaffold = !pid || isScaffoldPart($plotManifests[el.assetId], pid);
      partSelection.set(pid && !scaffold ? { elementId: el.id, partId: pid } : null);
      // Plain select-tool click on a real part → part move (shift keeps the
      // deferred selection toggle; alt keeps duplicate-drag; scale tool keeps
      // whole-plot semantics).
      if (pid && !scaffold && $activeTool === "select" && !e.shiftKey && !e.altKey) {
        if (beginPartMove(e, fig, el.id, pid)) return;
      }
    } else {
      partSelection.set(null);
    }
    const grp = expandGroups($project, new Set([el.id]), scope);
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
    const { xs, ys } = boxSnapTargets(fig.elements, new Set(sel.map((el) => el.id)), { w: fig.width, h: fig.height }, fig.guides);
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

  // Arm a part-move gesture on the live mounted node. Returns false when the
  // node/CTM isn't available (unmounted asset, <image> fallback) — the caller
  // then falls through to the normal whole-plot move.
  function beginPartMove(e: PointerEvent, fig: Figure, elementId: string, partId: string): boolean {
    const found = findElement($project, elementId);
    if (!found || found.element.type !== "plot") return false;
    const node = document.getElementById(`${elementId}__${partId}`) as unknown as SVGGraphicsElement | null;
    if (!node || typeof node.getScreenCTM !== "function") return false;
    // The override translate is PREPENDED to the node's transform list, so it
    // operates in the space where that list begins — the PARENT's user space.
    // Deltas must be measured there (the node's own CTM would fold in its own
    // rotate/scale, e.g. a rotated y-axis title, and the drag would shear).
    const parent = node.parentNode as SVGGraphicsElement | null;
    const raw = parent && typeof parent.getScreenCTM === "function" ? parent.getScreenCTM() : node.getScreenCTM();
    if (!raw) return false;
    // getScreenCTM may hand back a legacy SVGMatrix (no transformPoint) —
    // normalize to a real DOMMatrix so the move handler can map points.
    const ctm = new DOMMatrix([raw.a, raw.b, raw.c, raw.d, raw.e, raw.f]);
    const ov = found.element.overrides?.[partId];
    const baseDx = Number(ov?.dx ?? 0) || 0;
    const baseDy = Number(ov?.dy ?? 0) || 0;
    const baseTransform = node.getAttribute("transform") ?? "";
    // applyOverrides prepends exactly `translate(${dx} ${dy})` when the
    // override carried dx/dy — strip that prefix so the live transform composes
    // the NEW translation with the node's original transform, never both.
    let restTransform = baseTransform;
    if (ov?.dx != null || ov?.dy != null) {
      const prefix = `translate(${baseDx} ${baseDy})`;
      if (baseTransform.startsWith(prefix)) restTransform = baseTransform.slice(prefix.length).trimStart();
    }
    gesture = {
      kind: "partmove",
      figId: fig.id,
      elementId,
      partId,
      node,
      inv: ctm.inverse(),
      sx: e.clientX,
      sy: e.clientY,
      baseDx,
      baseDy,
      baseTransform,
      restTransform,
    };
    gestureFig = fig;
    gestureEls = [];
    committed = false;
    dragging = false;
    pDX = baseDx;
    pDY = baseDy;
    partMoveBox = null;
    hostEl.setPointerCapture(e.pointerId);
    return true;
  }

  // FIG-9: materialize the alt-drag copies on the first real move. Clones the
  // originals in place, makes the copies the moved set (re-keying origs + snap
  // targets), and opens one history entry covering the duplicate + the drag.
  // P7: group identity clones through the shared cloneGroupsFor (this was the
  // last hand-rolled remap minting DANGLING groupIds) — copies of grouped
  // elements land in NEW GroupDefs with the same names/nesting and fresh ids,
  // exactly like ops.duplicateElements (Ctrl+D) and paste.
  function performAltDup(fig: Figure) {
    const g = gesture;
    if (!g || g.kind !== "move") return;
    altDupDone = true;
    beginGesture(); // single history entry for duplicate + drag
    committed = true;
    const originals = gestureEls;
    const newIds: string[] = [];
    const grpRemap = new Map<string, string>();
    mutateFigure(fig.id, (p) => {
      const f = p.figures.find((ff) => ff.id === fig.id);
      if (!f) return;
      const cloned = cloneGroupsFor(f.groups, originals, grpRemap);
      if (Object.keys(cloned).length) {
        f.groups = f.groups ?? {};
        Object.assign(f.groups, cloned);
      }
      const copies = originals.map((el) => {
        const c = structuredClone(el);
        c.id = newId(c.type);
        if (c.groupId) c.groupId = grpRemap.get(c.groupId) ?? c.groupId;
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
    const t = boxSnapTargets(fig.elements, new Set(newIds), { w: fig.width, h: fig.height }, fig.guides);
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
    enteredGroupId.set(null); // P7: frame selection is a full scope exit
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
          mutateFigure(figId, (p) => ops.addGuide(p, figId, gd.axis, gd.pos));
        }
      } else {
        // move existing (drag off the figure = delete)
        beginGesture();
        mutateFigure(figId, (p) => {
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
    // figure-v1 P5: ctrl/meta + drag on a resize handle CROPS (Figma parity) —
    // only for exactly ONE unlocked image/plot whose asset has a known
    // intrinsic size; anything else (multi-select, Scale tool, unsized asset)
    // falls back to a plain resize so the modifier never dead-ends.
    let crop: { orig: ImageElement | SemanticPlotElement; disp: { width: number; height: number } } | undefined;
    if ((e.ctrlKey || e.metaKey) && $activeTool !== "scale" && sel.length === 1) {
      const el = sel[0];
      if ((el.type === "image" || el.type === "plot") && !el.locked) {
        const disp = ops.assetDisplaySize($project, el.assetId);
        if (disp) crop = { orig: structuredClone(el), disp };
      }
    }
    gesture = { kind: "resize", figId: fig.id, handle, ob: { ...overlayBox }, origs, scale: $activeTool === "scale", crop };
    gestureFig = fig;
    gestureEls = sel;
    committed = false;
    dragging = false;
    gNb = { ...overlayBox };
    liveBox = { ...overlayBox };
    hostEl.setPointerCapture(e.pointerId);
  }

  // Endpoint pivot (Figma parity): grab one end of a single selected line and
  // drag it while the other end stays put. Rotation/flip bake into the world
  // endpoints at grab (the drag then edits pure endpoint geometry — the shape
  // the model stores anyway).
  function onLineEndDown(e: PointerEvent, which: 1 | 2) {
    e.stopPropagation();
    if ($captionOpen) return;
    const fig = activeFigure();
    if (!fig || !selLine) return;
    const { p1, p2 } = lineWorldEndpoints(selLine);
    gesture = {
      kind: "lineEnd",
      figId: fig.id,
      id: selLine.id,
      which,
      fixed: which === 1 ? p2 : p1,
      live: structuredClone(selLine),
    };
    gestureFig = fig;
    gestureEls = [selLine];
    committed = false;
    dragging = false;
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
    if (bendDrag) {
      onBendDrag(e);
      return;
    }
    if ($activeTool === "pen" && penFigId) {
      const pf = $project.figures.find((f) => f.id === penFigId);
      if (pf) {
        const lp = localPoint(e.clientX, e.clientY, pf);
        penRaw = lp;
        if (penDrag) {
          penCursor = lp;
          penSnapRes = null;
          // pull symmetric handles out of the just-placed node → smooth node
          const n = penNodes[penDrag.i];
          let dx = lp.x - n.x;
          let dy = lp.y - n.y;
          if (e.shiftKey) ({ dx, dy } = constrain45(dx, dy));
          n.hOut = { dx, dy };
          n.hIn = { dx: -dx, dy: -dy };
          n.type = "smooth";
          penNodes = penNodes;
        } else {
          penSnapRes = penSnap(penNodes, lp, { zoom: $viewport.zoom, shift: e.shiftKey, disable: e.altKey });
          penCursor = penSnapRes.pt;
        }
      }
    }
    const g = gesture;
    if (!g) return;

    if (g.kind === "pan") {
      viewport.update((v) => ({ ...v, panX: g.panX + (e.clientX - g.sx), panY: g.panY + (e.clientY - g.sy) }));
      return;
    }

    // Part move — handled before the figure lookup / main branches (mirrors the
    // early modal drags): a pure transient DOM transform, no model mutation.
    if (g.kind === "partmove") {
      // 2px client threshold: below it this stays a click (selection only).
      if (!dragging && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 2) return;
      startDragging();
      const p0 = g.inv.transformPoint(new DOMPoint(g.sx, g.sy));
      const p1 = g.inv.transformPoint(new DOMPoint(e.clientX, e.clientY));
      pDX = g.baseDx + (p1.x - p0.x);
      pDY = g.baseDy + (p1.y - p0.y);
      const t = [`translate(${pDX} ${pDY})`, g.restTransform].filter(Boolean).join(" ");
      g.node.setAttribute("transform", t);
      // live highlight from the moving node's real bounds
      const r = g.node.getBoundingClientRect();
      const h = hostEl.getBoundingClientRect();
      const O = 2;
      partMoveBox = { x: r.left - h.left - O, y: r.top - h.top - O, w: r.width + 2 * O, h: r.height + 2 * O };
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
      if (g.crop) {
        // Crop mode: pure per-frame math against the pointer-down snapshot —
        // NO snapping of any kind. The selection box + handles track the live
        // window (liveBox); the ghost/clip overlay draws the content.
        const res = cropRemap(g.crop.orig, g.handle, lp, { shift: e.shiftKey, alt: e.altKey }, g.crop.disp);
        if (res) {
          startDragging();
          cropRes = res;
          gNb = { x: res.x, y: res.y, w: res.width, h: res.height };
          liveBox = gNb;
          const hr = hostEl.getBoundingClientRect();
          cropChip = { x: e.clientX - hr.left, y: e.clientY - hr.top };
        }
        return;
      }
      // The Scale tool always scales uniformly; a single locked-aspect element does
      // too (no Shift needed).
      const forceAspect = g.scale || (gestureEls.length === 1 && !!gestureEls[0].lockAspect);
      const nb = computeResizeBox(g.ob, g.handle, lp, e.shiftKey || forceAspect);
      startDragging();
      gNb = nb;
      liveBox = nb;
    } else if (g.kind === "lineEnd") {
      // WS-1 Fix 2: fully transient pivot — the shared pure remap runs on the
      // gesture's private clone, which renders via the scene-slot override.
      // No store notify per move; ONE mutate on pointer-up commits the result.
      const lp = localPoint(e.clientX, e.clientY, fig);
      startDragging();
      lineEndpointRemap(g.live, g.which, g.fixed, lp, e.shiftKey);
      if ($settings.snapPixel) {
        g.live.x = Math.round(g.live.x);
        g.live.y = Math.round(g.live.y);
        g.live.x2 = Math.round(g.live.x2);
        g.live.y2 = Math.round(g.live.y2);
      }
      lineEndLive = { ...g.live };
    } else if (g.kind === "rotate") {
      // FIG-1: flicker-free rotate — accumulate the delta and apply a transient rotate transform
      // to the selection's LIVE scene groups (composited), committing once on release. The old
      // path mutate()'d the model every pointermove, re-running visibleByFig + re-diffing every
      // visible element each frame (janky at 1–2k elements). Mirrors the move/resize path.
      const lp = localPoint(e.clientX, e.clientY, fig);
      let delta = (Math.atan2(lp.y - g.cy, lp.x - g.cx) * 180) / Math.PI - g.startAngle;
      const base = g.origs.get(gestureEls[0]?.id ?? "")?.rotation ?? 0;
      if (e.shiftKey) delta = Math.round((base + delta) / 15) * 15 - base; // snap the primary to 15°
      startDragging();
      gRotDeg = delta;
      rotateTip = `${Math.round((((base + delta) % 360) + 360) % 360)}°`;
    } else if (g.kind === "marquee") {
      const lp = localPoint(e.clientX, e.clientY, fig);
      const r: Rect = { x: Math.min(g.x0, lp.x), y: Math.min(g.y0, lp.y), w: Math.abs(lp.x - g.x0), h: Math.abs(lp.y - g.y0) };
      marquee = r;
      const hit = new Set(g.add);
      // FIG-4: honor rotation — the empty AABB corners of a tilted element don't count.
      // P7: group-locked/-hidden members (effective state) don't marquee-select.
      for (const el of fig.elements)
        if (!effLocked(el) && !effHidden(el) && rectIntersectsElement(r, el)) hit.add(el.id);
      // FIG-1: dragging the marquee re-ran expandGroups + every selection-dependent
      // reactive (handles, inspector, bbox) on EACH pointermove even when the hit set
      // hadn't changed. Only push a new selection when the result actually differs.
      // P7: expansion is bounded by the entered-group scope — marquee == click.
      const expanded = expandGroups($project, hit, $enteredGroupId);
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
    if (bendDrag) {
      finishBendDrag(e);
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
        mutateFigure(g.figId, (p) => {
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
        // now apply the deferred toggle (deselect it / its unit at the scope).
        const grp = expandGroups($project, new Set([pendingShiftToggle]), $enteredGroupId);
        selection.update((s) => {
          const n = new Set(s);
          for (const id of grp) n.delete(id);
          return n;
        });
      }
    } else if (g.kind === "resize" && g.crop && dragging && cropRes) {
      // Crop: ONE commit writing {x,y,width,height,crop} through the shared
      // pure op (content-pinned — reproduces cropRes exactly from the same
      // fixed mapping). No snapPixel: rounding the box without re-deriving the
      // window would unpin the content.
      const res = cropRes;
      const targetId = g.crop.orig.id;
      ensureCommitted();
      mutateFigure(g.figId, (p) => ops.setCrop(p, targetId, res.crop));
    } else if (g.kind === "resize" && gNb && dragging) {
      const nb = gNb;
      ensureCommitted();
      // Which box axes this handle drives (text sizing transitions key off it:
      // width-only drag → wrap mode, any height drag → fixed box).
      const axes = { w: g.handle !== "n" && g.handle !== "s", h: g.handle !== "e" && g.handle !== "w" };
      mutateFigure(g.figId, (p) => {
        const f = p.figures.find((ff) => ff.id === g.figId);
        if (!f) return;
        for (const el of f.elements) {
          const o = g.origs.get(el.id);
          if (o) {
            if (g.scale) scaleRemap(el, o, g.ob, nb);
            else resizeRemap(el, o, g.ob, nb, axes);
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
        mutateFigure(g.figId, (p) => p.figures.find((f) => f.id === g.figId)?.elements.push(el));
        selectOnly(el.id);
      }
      activeTool.set("select");
    } else if (g.kind === "figmove" && dragging && (fDX !== 0 || fDY !== 0)) {
      ensureCommitted();
      mutateFigure(g.figId, (p) => {
        const f = p.figures.find((ff) => ff.id === g.figId);
        if (f) {
          f.x = g.ox + fDX;
          f.y = g.oy + fDY;
        }
      });
    } else if (g.kind === "partmove") {
      if (dragging) {
        // ONE undo step. The mount signature includes overrides, so the commit
        // re-clones the plot once — replacing the transiently-mutated node with
        // a pristine clone carrying the new translate. Below the threshold this
        // was a click: selection only, DOM untouched.
        ensureCommitted();
        mutateFigure(g.figId, (p) => ops.setPartOverride(p, g.elementId, g.partId, { dx: pDX, dy: pDY }));
      }
    } else if (g.kind === "rotate" && dragging && gRotDeg !== 0) {
      // FIG-1: commit the transient rotate once. The model is still at the pre-rotation state
      // (we only showed a live transform), so a single rotateAbout with the accumulated delta —
      // about the same figure-local pivot — yields the final orbit+spin, matching the preview.
      ensureCommitted();
      mutateFigure(g.figId, (p) => {
        const f = p.figures.find((ff) => ff.id === g.figId);
        if (!f) return;
        rotateAbout(f.elements.filter((el) => g.origs.has(el.id)), { x: g.cx, y: g.cy }, gRotDeg);
      });
    } else if (g.kind === "lineEnd" && dragging && lineEndLive) {
      // WS-1 Fix 2: single commit of the accumulated transient pivot.
      const live = lineEndLive;
      ensureCommitted();
      mutateFigure(g.figId, (p) => {
        const f = p.figures.find((ff) => ff.id === g.figId);
        const el = f?.elements.find((x) => x.id === g.id);
        if (!el || el.type !== "line") return;
        el.x = live.x;
        el.y = live.y;
        el.x1 = live.x1;
        el.y1 = live.y1;
        el.x2 = live.x2;
        el.y2 = live.y2;
        el.width = live.width;
        el.height = live.height;
        el.rotation = live.rotation;
        delete el.flipX;
        delete el.flipY;
      });
    } else if (g.kind === "marquee") {
      // P7: a plain background CLICK (no real marquee — the box never grew past
      // click slop) exits the entered-group scope entirely (Figma: background
      // click = full exit). A real marquee drag keeps the scope it selected in.
      const moved = marquee && (marquee.w * $viewport.zoom > 3 || marquee.h * $viewport.zoom > 3);
      if (g.bgClick && !moved) enteredGroupId.set(null);
    }

    // Reset all transient state in one batch -> single clean scene render.
    resetGestureTransients();
    try {
      hostEl.releasePointerCapture(e.pointerId);
    } catch {}
  }

  /** Drop every piece of in-flight gesture state (shared by pointer-up commit and
   *  Esc-cancel) — one batch → a single clean scene render. */
  function resetGestureTransients() {
    preview = null;
    marquee = null;
    guides = [];
    spacing = [];
    liveBox = null;
    rotateTip = "";
    gDX = 0;
    gDY = 0;
    gRotDeg = 0;
    fDX = 0;
    fDY = 0;
    pDX = 0;
    pDY = 0;
    partMoveBox = null;
    cropRes = null;
    cropChip = null;
    gNb = null;
    lineEndLive = null;
    gestureEls = [];
    gestureFig = null;
    gestureHiddenIds = new Set();
    dragging = false;
    gestureAltDup = false;
    pendingShiftToggle = null;
    gesture = null;
  }

  /** FIG-12: abort the in-flight gesture (Esc). Transient kinds (move/resize/
   *  figmove/rotate/marquee/pan/draw) never touched the model — dropping the
   *  transients IS the cancel. Alt-drag-copy duplicated the model at first move
   *  (one beginGesture entry) → roll that back. The eventual pointerup finds
   *  gesture === null and no-ops; capture releases implicitly with it. */
  function cancelGesture(): boolean {
    if (!gesture) return false;
    if (gestureAltDup) rollbackGesture(); // removes the copies minted at first move
    // Endpoint pivot is transient (WS-1 Fix 2) — dropping lineEndLive IS the
    // cancel; the model was never touched.
    if (gesture.kind === "draw") activeTool.set("select");
    // Part move mutated the live node's transform transiently — put it back.
    if (gesture.kind === "partmove" && dragging) {
      if (gesture.baseTransform) gesture.node.setAttribute("transform", gesture.baseTransform);
      else gesture.node.removeAttribute("transform");
    }
    resetGestureTransients();
    return true;
  }

  // FIG-12: expose the abort to the global Esc handler while this canvas is mounted.
  onMount(() => {
    gestureCancelHook.fn = cancelGesture;
    return () => {
      if (gestureCancelHook.fn === cancelGesture) gestureCancelHook.fn = null;
    };
  });

  // --- keyboard (space-pan, pen finish; global shortcuts live in keyboard.ts) ---
  function onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
    if (e.code === "Space" && !spaceDown && !typing) spaceDown = true;
    if (e.key === "Alt") altDown = true; // caliper (measure) mode
    if (e.key === "Control") ctrlDown = true; // bend affordance in node-edit
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

    // Pen authoring: Enter finishes (open), Esc cancels. Shift/Alt re-snap the
    // preview live (constrain / disable-assist) without waiting for a move.
    if (penNodes.length) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishPen(false);
      } else if (e.key === "Escape") {
        penNodes = [];
        penFigId = null;
        penCursor = null;
        penDrag = null;
        penRaw = null;
        penSnapRes = null;
      } else if ((e.key === "Shift" || e.key === "Alt") && penRaw && !penDrag) {
        penSnapRes = penSnap(penNodes, penRaw, { zoom: $viewport.zoom, shift: e.shiftKey, disable: e.altKey });
        penCursor = penSnapRes.pt;
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
    if (e.key === "Control") ctrlDown = false;
    if ((e.key === "Shift" || e.key === "Alt") && penNodes.length && penRaw && !penDrag) {
      penSnapRes = penSnap(penNodes, penRaw, { zoom: $viewport.zoom, shift: e.shiftKey, disable: e.altKey });
      penCursor = penSnapRes.pt;
    }
  }
  function onWinBlur() {
    spaceDown = false;
    altDown = false; // don't leave the caliper stuck on if focus leaves mid-hold
    ctrlDown = false;
  }

  let prevTool = $activeTool;
  $: if ($activeTool !== prevTool) {
    if (prevTool === "pen" && penNodes.length >= 2) finishPen(false);
    else if (prevTool === "pen") {
      penNodes = [];
      penFigId = null;
      penCursor = null;
      penDrag = null;
      penRaw = null;
      penSnapRes = null;
    }
    prevTool = $activeTool;
  }

  // P7: the element under the last pointerdown (nulled by background downs).
  // Pointer capture (beginMove captures on every element pointerdown) retargets
  // real-mouse click/dblclick compatibility events to the HOST — a per-element
  // on:dblclick never fires from a real mouse — so the host handler resolves
  // the double-clicked element from this record instead.
  let lastDownEl: { id: string; t: number } | null = null;

  function onDblClick(e: MouseEvent) {
    if ($captionOpen) return; // read-only while the caption editor is open
    if (editPathId) return; // node markers/segments handle their own dblclicks
    if (penNodes.length >= 2) {
      finishPen(false);
      return;
    }
    // P7: group-enter / member drill for real-mouse double-clicks (the second
    // click's pointerdown recorded the element; see lastDownEl above).
    if (lastDownEl && performance.now() - lastDownEl.t < 600) {
      const f = findElement($project, lastDownEl.id);
      if (f && onElementDblClick(e, f.element, f.figure)) return;
    }
    // Double-click to edit: text → inline editor; path → node-edit mode.
    const ids = [...$selection];
    if (ids.length === 1) {
      const f = findElement($project, ids[0]);
      if (f && f.element.type === "text") startEdit(f.element, true);
      else if (f && f.element.type === "path" && !f.element.locked) enterNodeEdit(ids[0]);
    }
  }

  // P7: double-click on an element descends the group hierarchy ONE level
  // (Figma "enter group"). The hit element's UNIT at the current scope decides:
  //  - a GROUP unit → enter it (enteredGroupId) and select the next-level unit
  //    under the cursor — nested groups drill progressively, one dblclick per
  //    level;
  //  - the element itself → text starts the inline edit here (as before);
  //    plots already part-drilled on the second pointerdown (onElementDown);
  //    paths keep the selection-based node-edit entry in onDblClick.
  // Returns true when it consumed the double-click. Called from the host
  // handler (real mice, via lastDownEl) AND from the per-element on:dblclick
  // (synthetic dispatches in tests) — stopPropagation keeps the two disjoint.
  function onElementDblClick(e: MouseEvent, el: Element, fig: Figure): boolean {
    if ($captionOpen || editPathId) return false;
    if ($activeTool !== "select" && $activeTool !== "scale") return false;
    if (effLocked(el)) return false;
    const unit = unitOf(fig, el, $enteredGroupId);
    if (unit.groupId && !e.shiftKey && !e.altKey) {
      e.stopPropagation();
      enteredGroupId.set(unit.groupId);
      selection.set(expandGroups($project, new Set([el.id]), unit.groupId));
      partSelection.set(null);
      return true;
    }
    if (el.type === "text" && unit.groupId === null) {
      e.stopPropagation();
      startEdit(el, true);
      return true;
    }
    return false;
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
    if (!files.length) return;
    // No silent failures: a drop that misses every figure used to vanish, and the
    // fire-and-forget import swallowed read/decode errors.
    if (!fig) {
      pushToast("info", "Drop onto a figure to import");
      return;
    }
    importDroppedFiles(files, fig.id).catch((err) =>
      pushToast("error", "Import failed", { detail: errMsg(err) }),
    );
  }

  $: af = $project.figures.find((f) => f.id === $activeFigureId) ?? null;
  $: displayBox = liveBox ?? overlayBox; // figure-local, active figure

  // A selection made entirely of locked elements (only reachable via the Layers
  // panel) shows its box but NO resize/rotate handles — locked elements can't be
  // transformed on the canvas. P7: an ancestor group's padlock counts.
  $: selLocked = (() => {
    if (!af) return false;
    void effState;
    const els = af.elements.filter((e) => $selection.has(e.id));
    return els.length > 0 && els.every((e) => effLocked(e));
  })();

  // Figma-parity line editing: a SINGLE selected line/arrow gets two endpoint
  // handles instead of the 8-handle bbox (which degenerates to a zero-area box
  // for axis-aligned lines and only bbox-scales). Dragging one endpoint pivots
  // the line about the fixed other.
  $: selLine = (() => {
    if (!af || selLocked || $captionOpen || $selection.size !== 1) return null;
    const el = af.elements.find((e) => $selection.has(e.id));
    return el && el.type === "line" ? el : null;
  })();
  $: lineEndsScreen =
    selLine && af
      ? (() => {
          // WS-1 Fix 2: during a transient pivot the handles track the live clone.
          const { p1, p2 } = lineWorldEndpoints(lineEndLive ?? selLine);
          const s = (p: { x: number; y: number }) => ({
            x: $viewport.panX + (af!.x + p.x) * $viewport.zoom,
            y: $viewport.panY + (af!.y + p.y) * $viewport.zoom,
          });
          return { a: s(p1), b: s(p2) };
        })()
      : null;

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
    // Don't preview-outline a locked/hidden element (own flag OR an ancestor
    // group's, P7) — a click won't select it.
    void effState;
    if (effLocked(found.element) || effHidden(found.element)) return null;
    // P7: preview the unit a click would select — bounded by the entered scope.
    const grp = expandGroups($project, new Set([$hoverId]), $enteredGroupId);
    const b = selectionBBox(found.figure.elements.filter((e) => grp.has(e.id)));
    if (!b) return null;
    // Outset ~1.5px (screen) so the outline sits just outside the element's own
    // border and stays visible even on a same-hue shape (Figma-style).
    const O = 1.5;
    // Figma-style for strokes: a hovered SINGLE line/path shows a TRACE of its
    // own geometry (accent over the stroke), not the bounding box — the box
    // appears on selection. Groups and box-like elements keep the box preview.
    const el = found.element;
    const single = grp.size === 1;
    const trace =
      single && (el.type === "path" || el.type === "line")
        ? {
            d:
              el.type === "path"
                ? el.d
                : `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2}`,
            // full element transform — a rotated/flipped path must trace its
            // RENDERED pose, not the unrotated one
            tf: elOverlayTransform($viewport, { x: found.figure.x, y: found.figure.y }, el),
          }
        : null;
    return {
      x: $viewport.panX + (found.figure.x + b.x) * $viewport.zoom - O,
      y: $viewport.panY + (found.figure.y + b.y) * $viewport.zoom - O,
      w: b.w * $viewport.zoom + 2 * O,
      h: b.h * $viewport.zoom + 2 * O,
      trace,
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
  // Placement-assist overlay (screen px): dashed alignment guides from the
  // matched node/midpoint to the prospective point, equal-length tick pairs
  // (geometry-notation ticks across both edges' midpoints), the cursor's
  // prospective-node dot, and the close-the-shape hot state.
  $: penAssist = (() => {
    if (!penFig || !penSnapRes || penDrag) return null;
    const px = (p: { x: number; y: number }) => ({
      x: $viewport.panX + (penFig!.x + p.x) * $viewport.zoom,
      y: $viewport.panY + (penFig!.y + p.y) * $viewport.zoom,
    });
    const aligns: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const ticks: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const tick = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const A = px(a);
      const B = px(b);
      const mx = (A.x + B.x) / 2;
      const my = (A.y + B.y) / 2;
      const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      const nx = -(B.y - A.y) / len;
      const ny = (B.x - A.x) / len;
      ticks.push({ x1: mx - nx * 5, y1: my - ny * 5, x2: mx + nx * 5, y2: my + ny * 5 });
    };
    for (const g of penSnapRes.guides) {
      if (g.kind === "align") {
        const F = px(g.from);
        const T = px(g.to);
        aligns.push({ x1: F.x, y1: F.y, x2: T.x, y2: T.y });
      } else {
        tick(g.a[0], g.a[1]);
        tick(g.b[0], g.b[1]);
      }
    }
    return { aligns, ticks, close: penSnapRes.close, cursor: penCursor ? px(penCursor) : null };
  })();

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
  // WS-1 Fix 2: transient node-drag preview — the edited path re-rendered from
  // the WORKING node list while a node/handle drag is live. Swapped into the
  // element's own scene slot (z-order + clipping preserved); the model stays
  // frozen until the single pointer-up commit.
  $: nodeDragLive =
    (nodeDrag?.started || bendDrag?.started) && editInfo
      ? ({ ...editInfo.el, nodes: editNodes, d: nodesToPath(editNodes, editClosed) } as PathElement)
      : null;

  // Single transient scene-slot override (node drag OR line-endpoint pivot —
  // they cannot be simultaneously active).
  $: sceneOverride = nodeDragLive
    ? { id: editPathId as string, el: nodeDragLive as Element }
    : lineEndLive
      ? { id: lineEndLive.id, el: lineEndLive as Element }
      : null;

  // group transform mapping the edited path's local space → screen (for the
  // highlighted outline), incl. the element's rotation/flip. Uses el.x/y which
  // is held fixed during a node drag.
  $: editTransform = editInfo
    ? elOverlayTransform($viewport, { x: editInfo.fig.x, y: editInfo.fig.y }, editInfo.el)
    : "";
  $: editScreen = (() => {
    if (!editInfo) return null;
    // element-local → screen through the FULL element transform (rotation/flip
    // included via elMapPoint) — rigid maps take bezier controls to the
    // rotated curve's controls, so mapping each point is exact.
    const S = (x: number, y: number) => {
      const m = elMapPoint(editInfo!.el, { x, y });
      return {
        x: $viewport.panX + (editInfo!.fig.x + m.x) * $viewport.zoom,
        y: $viewport.panY + (editInfo!.fig.y + m.y) * $viewport.zoom,
      };
    };
    const N = editNodes.length;
    const nodes = editNodes.map((n, i) => {
      const pt = S(n.x, n.y);
      const hi = n.hIn && editSel.has(i) ? S(n.x + n.hIn.dx, n.y + n.hIn.dy) : null;
      const ho = n.hOut && editSel.has(i) ? S(n.x + n.hOut.dx, n.y + n.hOut.dy) : null;
      return { i, x: pt.x, y: pt.y, smooth: n.type === "smooth", sel: editSel.has(i), hIn: hi, hOut: ho };
    });
    // segment midpoints (screen) → click to insert a node; per-segment screen
    // path d → the wide ctrl-drag BEND hit target
    const segCount = editClosed ? N : N - 1;
    const mids: { s: number; x: number; y: number }[] = [];
    const segsD: { s: number; d: string }[] = [];
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
      const mid = S(de(0.5, a.x, a1x, b1x, b.x), de(0.5, a.y, a1y, b1y, b.y));
      mids.push({ s, x: mid.x, y: mid.y });
      const A = S(a.x, a.y);
      const C1 = S(a1x, a1y);
      const C2 = S(b1x, b1y);
      const B = S(b.x, b.y);
      segsD.push({ s, d: `M ${A.x} ${A.y} C ${C1.x} ${C1.y} ${C2.x} ${C2.y} ${B.x} ${B.y}` });
    }
    return { nodes, mids, segsD };
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

  // Crop overlay (figure-v1 P5): a GHOST of the full content at 0.35 opacity +
  // a full-opacity copy clipped to the live window (= the cropped preview —
  // identical pixels, since the content→canvas mapping is fixed) + the window
  // outline. Both copies are CONSTANT for the whole gesture (the mapping is
  // pinned), so plots mount once — only the clip rect moves per frame. The
  // synthetic elements carry distinct ids (no DOM-id collision with the hidden
  // scene original). Flip flags STAY on the ghost (a full-content element
  // flipped about its own centre reproduces the element's mirrored mapping
  // exactly — see cropRemap); only the ROTATION moves to the wrapper, about
  // the LIVE box centre (the mid-gesture render pivot).
  $: cropOverlay = (() => {
    if (!(dragging && gesture?.kind === "resize" && gesture.crop && gestureFig && cropRes)) return null;
    const o = gesture.crop.orig;
    const d = gesture.crop.disp;
    const crop0 = o.crop ?? { x: 0, y: 0, width: d.width, height: d.height };
    const kx = o.width / crop0.width;
    const ky = o.height / crop0.height;
    // Full-content box under the fixed (flip-aware) mapping.
    const gx = o.flipX ? o.x + o.width + crop0.x * kx - d.width * kx : o.x - crop0.x * kx;
    const gy = o.flipY ? o.y + o.height + crop0.y * ky - d.height * ky : o.y - crop0.y * ky;
    const ghost: Element = {
      ...o,
      id: `${o.id}-cropghost`,
      x: gx,
      y: gy,
      width: d.width * kx,
      height: d.height * ky,
      rotation: 0,
      opacity: 1,
    };
    delete (ghost as ImageElement | SemanticPlotElement).crop;
    const live: Element = { ...ghost, id: `${o.id}-croplive` };
    const ccx = cropRes.x + cropRes.width / 2;
    const ccy = cropRes.y + cropRes.height / 2;
    return {
      ghost,
      live,
      wrap: o.rotation ? `rotate(${o.rotation} ${ccx} ${ccy})` : null,
      clip: { x: cropRes.x, y: cropRes.y, w: cropRes.width, h: cropRes.height },
    };
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

  // FIG-1 flicker-free rotate: the selection rotates about the shared figure-local pivot via a
  // transient transform on each element's LIVE scene group. Expressed as a translate/rotate/
  // translate list (not transform-origin) so it lives in the same figure-local user space the
  // move transform already relies on (px == user unit under the ancestor scale(zoom)).
  $: rotIds =
    dragging && gesture?.kind === "rotate"
      ? new Set(gestureEls.map((el) => el.id))
      : (null as Set<string> | null);
  $: rotTransform =
    gesture?.kind === "rotate"
      ? `translate(${gesture.cx}px, ${gesture.cy}px) rotate(${gRotDeg}deg) translate(${-gesture.cx}px, ${-gesture.cy}px)`
      : "";

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
  on:pointerdown|capture={foldZoomNow}
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
  <!-- SCENE: panned via cheap CSS transform; zoom rides the compositor-only
       residual scale(zoom/renderZoom) mid-gesture and folds into the SVG's
       scale(renderZoom) on settle — ONE content repaint per zoom gesture.
       will-change only while sceneHot: the idle demotion is the crisp-at-rest
       fix (P6 rationale block in the script; the residual is the ONLY live-zoom
       read allowed inside the scene). -->
  <div
    class="scene"
    style={`transform: translate3d(${$viewport.panX}px, ${$viewport.panY}px, 0) scale(${$viewport.zoom / renderZoom});`}
    style:will-change={sceneHot ? "transform" : null}
  >
    <svg class="scene-svg" xmlns="http://www.w3.org/2000/svg">
      <g transform={`scale(${renderZoom})`}>
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
              {#if fig.elements.length === 0}
                <!-- Empty-figure affordance: point at the three import paths. Constant
                     screen size (÷renderZoom — NEVER live zoom inside the scene, P6;
                     like .figure-label); pointer-events:none so it never blocks canvas
                     gestures or the drop target. -->
                <text
                  class="empty-hint"
                  x={fig.width / 2}
                  y={fig.height / 2}
                  font-size={12 / renderZoom}
                >
                  <tspan x={fig.width / 2} dy={-5 / renderZoom}>Drop PNG/SVG plots here</tspan>
                  <tspan x={fig.width / 2} dy={18 / renderZoom}>Ctrl+Shift+K import · Alt+I plot importer</tspan>
                </text>
              {/if}
              {#each visibleByFig.get(fig.id) ?? [] as el (el.id)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <g
                  class="el"
                  class:editing-hidden={editingId === el.id}
                  style:visibility={gestureHiddenIds.has(el.id) ? "hidden" : null}
                  style:transform={moveIds?.has(el.id) ? moveTransform : rotIds?.has(el.id) ? rotTransform : null}
                  style:will-change={moveIds?.has(el.id) || rotIds?.has(el.id) ? "transform" : null}
                  on:pointerdown={(e) => onElementDown(e, el, fig)}
                  on:pointerenter={() => {
                    if (($activeTool === "select" || $activeTool === "scale") && !$captionOpen) hoverId.set(el.id);
                  }}
                  on:pointerleave={() => {
                    if ($hoverId === el.id) hoverId.set(null);
                  }}
                  on:dblclick={(e) => onElementDblClick(e, el, fig)}
                >
                  <!-- WS-1 Fix 2: transient node-drag / line-pivot preview swaps
                       into the element's own slot — z-order + clipping intact,
                       model untouched until the single pointer-up commit. -->
                  {#if sceneOverride && sceneOverride.id === el.id}
                    <ElementView element={sceneOverride.el} />
                  {:else}
                    <ElementView element={el} />
                  {/if}
                </g>
              {/each}
            </g>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect
              class="figure-titlebar"
              x="0"
              y={-22 / renderZoom}
              width={Math.max(fig.width, 120 / renderZoom)}
              height={18 / renderZoom}
              on:pointerdown={(e) => startFigMove(e, fig)}
            />
            <text class="figure-label" x="0" y={-8 / renderZoom} font-size={13 / renderZoom}>{fig.name}</text>
          </g>
          </g>
        {/each}
      </g>
    </svg>
  </div>

  <!-- OVERLAY: screen-space, cheap; all live interaction chrome + previews -->
  <svg class="overlay-svg" xmlns="http://www.w3.org/2000/svg">
    <!-- resized element preview (a move uses a live scene transform instead — F5) -->
    {#if dragging && gestureFig && gesture?.kind === "resize" && !gesture.crop}
      <g transform={dragTransform} style="will-change: transform">
        {#each gestureEls as el (el.id)}
          <ElementView element={el} />
        {/each}
      </g>
    {/if}

    <!-- crop gesture (P5): full-content ghost + live window (clipped copy) + outline + chip -->
    {#if cropOverlay && gestureFig}
      <g transform={drawPreviewTransform}>
        <g transform={cropOverlay.wrap}>
          <clipPath id="flux-crop-live">
            <rect
              x={cropOverlay.clip.x}
              y={cropOverlay.clip.y}
              width={cropOverlay.clip.w}
              height={cropOverlay.clip.h}
            />
          </clipPath>
          <g opacity="0.35"><ElementView element={cropOverlay.ghost} /></g>
          <g clip-path="url(#flux-crop-live)"><ElementView element={cropOverlay.live} /></g>
          <rect
            class="crop-outline"
            x={cropOverlay.clip.x}
            y={cropOverlay.clip.y}
            width={cropOverlay.clip.w}
            height={cropOverlay.clip.h}
            fill="none"
            vector-effect="non-scaling-stroke"
          />
        </g>
      </g>
      {#if cropChip}
        <rect class="crop-chip-bg" x={cropChip.x + 14} y={cropChip.y - 26} width="44" height="18" rx="4" />
        <text class="crop-chip" x={cropChip.x + 36} y={cropChip.y - 17} text-anchor="middle" dominant-baseline="central">Crop</text>
      {/if}
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

    <!-- hover outline: previews what a click would select. Lines/paths trace
         their own geometry (Figma); everything else gets the box. -->
    {#if hoverInfo}
      {#if hoverInfo.trace}
        <g transform={hoverInfo.trace.tf}>
          <path class="hover-trace" d={hoverInfo.trace.d} vector-effect="non-scaling-stroke" />
        </g>
      {:else}
        <rect class="hover-box" x={hoverInfo.x} y={hoverInfo.y} width={hoverInfo.w} height={hoverInfo.h} fill="none" />
      {/if}
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
    {#if lineEndsScreen && !editingInfo && !editPathId}
      <!-- Figma parity: a single selected line gets its two ENDPOINT handles
           (drag one to pivot about the other) — no bbox, no rotate handle
           (endpoints subsume rotation; the bbox degenerates for h/v lines). -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <circle
        class="endpoint-handle"
        cx={lineEndsScreen.a.x}
        cy={lineEndsScreen.a.y}
        r="5"
        on:pointerdown={(e) => onLineEndDown(e, 1)}
      />
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <circle
        class="endpoint-handle"
        cx={lineEndsScreen.b.x}
        cy={lineEndsScreen.b.y}
        r="5"
        on:pointerdown={(e) => onLineEndDown(e, 2)}
      />
    {:else if selScreen && !editingInfo && !editPathId}
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

    <!-- part being MOVED (partBoxScreen suppresses itself during gestures) -->
    {#if partMoveBox}
      <rect
        class="part-box"
        x={partMoveBox.x}
        y={partMoveBox.y}
        width={partMoveBox.w}
        height={partMoveBox.h}
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
        <circle
          class="pen-anchor"
          class:first={a.first}
          class:smooth={a.smooth}
          class:hot={a.first && !!penAssist?.close}
          cx={a.x}
          cy={a.y}
          r={a.first ? (penAssist?.close ? 6.5 : 5) : 4}
        />
      {/each}
      {#if penAssist}
        {#each penAssist.aligns as l}
          <line class="pen-guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
        {/each}
        {#each penAssist.ticks as t}
          <line class="pen-tick" x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
        {/each}
        {#if penAssist.cursor}
          <circle class="pen-cursor" class:close={penAssist.close} cx={penAssist.cursor.x} cy={penAssist.cursor.y} r={penAssist.close ? 9 : 3} />
        {/if}
      {/if}
    {/if}

    <!-- node-edit overlay: outline + segment-insert markers + handles + nodes -->
    {#if editInfo && editScreen}
      <g transform={editTransform}>
        <path class="node-edit-path" d={nodeDragLive?.d ?? editInfo.el.d} vector-effect="non-scaling-stroke" /></g>
      <!-- wide per-segment hit strokes: ctrl+drag BENDS the segment (Figma).
           Plain clicks fall through (no handler consumes them). -->
      {#each editScreen.segsD as sg}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <path class="seg-hit" class:bendable={ctrlDown} d={sg.d} on:pointerdown={(e) => onSegDown(e, sg.s)} />
      {/each}
      {#each editScreen.mids as m}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <circle
          class="node-insert"
          cx={m.x}
          cy={m.y}
          r="4"
          on:pointerdown={(e) => {
            if (e.ctrlKey) {
              onSegDown(e, m.s); // ctrl on the midpoint marker bends too
              return;
            }
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
    <!-- Editor⇄render parity: sizing auto = hugging box, no wrap (pre + slack);
         auto-h/fixed = pre-wrap at EXACTLY the model width (content-box), long
         words break like text.ts wrapText; line-height mirrors lineH(el). -->
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
        ${editingInfo.el.underline ? "text-decoration:underline;" : ""}
        line-height:${editingInfo.el.lineHeight ?? 1.2};
        color:${editingInfo.el.color};
        text-align:${editingInfo.el.align};
        white-space:${editingInfo.el.sizing === "auto" ? "pre" : "pre-wrap"};
        overflow-wrap:${editingInfo.el.sizing === "auto" ? "normal" : "break-word"};
        width:${editingInfo.el.sizing === "auto"
          ? Math.max(editingInfo.el.width, 8) * $viewport.zoom + 4
          : Math.max(editingInfo.el.width, 8) * $viewport.zoom}px;
        height:${Math.max(
          editingInfo.el.height,
          Math.ceil(visualLines(editingInfo.el).length * lineH(editingInfo.el)),
          editingInfo.el.fontSize,
        ) * $viewport.zoom + 2}px;`}
      on:input={onTextInput}
      on:blur={finishEdit}
      on:pointerdown|stopPropagation
      on:dblclick|stopPropagation
      on:keydown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finishEdit();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const k = e.key.toLowerCase();
          if (k === "b" || k === "i" || k === "u") {
            e.preventDefault();
            e.stopPropagation();
            onTextEditToggle(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
          }
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
    transform-origin: 0 0; /* residual zoom scale composes about the pan origin */
    /* P6: NO permanent will-change here — promotion is inline-only while
       sceneHot (a permanently promoted layer gets budget-limited tiles at high
       zoom ⇒ blurry at rest + Electron tile-memory spam; see the rationale
       block in the script). `contain: paint` is likewise FORBIDDEN: it clips
       panned content outside the host box. */
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
  .empty-hint {
    fill: var(--c-tx-muted);
    text-anchor: middle;
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
  /* hovered line/path: trace the stroke itself (Figma), not the bbox */
  .hover-trace {
    fill: none;
    stroke: var(--c-accent-bright);
    stroke-width: 2;
    pointer-events: none;
    opacity: 0.9;
    stroke-linejoin: round;
    stroke-linecap: round;
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
  .endpoint-handle {
    fill: var(--c-tx-hi);
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: all;
    cursor: crosshair;
  }
  .endpoint-handle:hover {
    fill: var(--c-accent);
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
  /* crop gesture (P5): window outline + pointer chip */
  .crop-outline {
    stroke: var(--c-accent);
    stroke-width: 1.5;
    paint-order: stroke;
    pointer-events: none;
  }
  .crop-chip-bg {
    fill: var(--c-accent);
    pointer-events: none;
  }
  .crop-chip {
    fill: #fff;
    font-size: 11px;
    font-weight: 600;
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
    /* MUST stay none: anchors live in the OVERLAY svg, but pen placement/close
       runs in the SCENE svg's figure handler — an anchor that captures the
       pointer silently swallows the click. (pointer-events:all here was why
       closing a path by clicking the first node was so finicky: only the thin
       annulus between the 5px anchor and the old 8px radius worked.) */
    pointer-events: none;
  }
  .pen-anchor.first {
    fill: var(--c-accent);
  }
  .pen-anchor.smooth {
    fill: var(--c-accent);
  }
  .pen-anchor.hot {
    stroke: var(--c-tx-hi);
    stroke-width: 2;
  }
  /* placement assist: dashed alignment guides, equal-length ticks, and the
     prospective-node dot (turns into a ring around the first anchor when a
     click would close the shape) */
  .pen-guide {
    stroke: var(--c-accent);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    opacity: 0.8;
    pointer-events: none;
  }
  .pen-tick {
    stroke: var(--c-accent);
    stroke-width: 2;
    stroke-linecap: round;
    pointer-events: none;
  }
  .pen-cursor {
    fill: var(--c-tx-hi);
    stroke: var(--c-accent);
    stroke-width: 1.5;
    pointer-events: none;
  }
  .pen-cursor.close {
    fill: none;
    stroke-width: 2.5;
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
  /* per-segment bend hit target: invisible wide stroke; the cursor flags the
     affordance while Ctrl is held */
  .seg-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 10;
    pointer-events: stroke;
  }
  .seg-hit.bendable {
    cursor: crosshair;
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
