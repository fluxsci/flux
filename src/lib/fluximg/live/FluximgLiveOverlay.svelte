<script lang="ts">
  /**
   * The live image: a WebGL canvas exactly over the placed element with the element's own vector layers on top of
   * it, a pink viewfinder frame round it, and the control board (`FluximgBoard`) standing round that.
   *
   * The image stays flat and in place. Everything here is transient chrome: the view recipe is on the element
   * (edits go through `actions.ts`), and when the live view closes the element's still, drawn by the reference
   * renderer from the same recipe, is what remains.
   *
   * What the image itself answers to: the pointer reads out (ticks on the frame, a tick on every channel's
   * histogram, a card for the object under it); a drag moves the frame when it is zoomed in, pulls the contrast of
   * a channel that is in hand, or draws an inset when that is in hand; an annotation that is shown can be dragged
   * to another corner.
   */
  import { onDestroy } from "svelte";
  import { project } from "../../store";
  import { yieldsToShellModal, isAnnotateChord } from "../../../shell/agent/annotationVisibility";
  import { fluximgBundle, fluximgLutsReady, fluximgManifests, fluximgService, needLuts, resolveLut } from "../store";
  import { cachedObjectStyles, previewStyleBy } from "../objectStyle";
  import FluximgVectors from "../FluximgVectors.svelte";
  import { furnitureInset } from "../furniture";
  import { clampCrop, fullCrop } from "../still";
  import { insetsOf } from "../static";
  import { contributingChannelIndices, formatNumber, resolveView } from "../viewOps";
  import type { FluximgElement } from "../../types";
  import FluximgBoard from "./FluximgBoard.svelte";
  import { channelInHand, defaultArmed, dragContrast, insetPlan, makeInset, moveInset, panFrame, setFurnitureCorner, type BoardGhosts, type FurnitureSpot } from "./actions";
  import type { BoardFit } from "./boardLayout";
  import { LiveDriver, type FrameInfo } from "./driver";
  import { fluximgTables, needTable, objectCells, tableOf } from "./objectTables";
  import { cancelLiveEdit, fluximgFrame, fluximgHover, fluximgLive, fluximgLiveProblem, fluximgPreview, fluximgReadout, fluximgStylePreview, fluximgTip, liveArm, livePointer, liveSampler, setLive, settleLiveEdit } from "./session";

  let { element, left, top, zoom, beginPan, moveView = undefined }: { element: FluximgElement; left: number; top: number; zoom: number; beginPan: () => void; moveView?: (f: BoardFit) => void } = $props();

  const asset = $derived($project.assets.find((a) => a.id === element.assetId && a.kind === "fluximg"));
  const manifest = $derived(asset ? $fluximgManifests[asset.id] : undefined);
  const rv = $derived(manifest ? resolveView(manifest, element.view) : null);
  // What the image shows: its view, or, while a styling key is hovered, that key's choice on its layer (a preview:
  // nothing is written until the key is pressed).
  const shownView = $derived.by(() => {
    const p = $fluximgStylePreview;
    if (!rv || !p) return rv;
    return { ...rv, layers: rv.layers.map((l) => (l.id === p.layerId ? { ...l, styleBy: previewStyleBy(l.styleBy, p.part, p.column) } : l)) };
  });
  const crop = $derived(manifest ? clampCrop(manifest, element.crop) : null);
  const box = $derived({ width: element.width, height: element.height });
  const live = $derived($fluximgLive);
  const insets = $derived.by(() => {
    for (const f of $project.figures) if (f.elements.some((e) => e.id === element.id)) return insetsOf(f.elements, element.id, element.assetId);
    return [];
  });
  const whole = $derived.by(() => { if (!manifest || !crop) return true; const f = fullCrop(manifest); return crop.width >= f.width - 1e-6 && crop.height >= f.height - 1e-6; });

  // --- geometry ---------------------------------------------------------------------------------
  const bw = $derived(element.width * zoom), bh = $derived(element.height * zoom);
  let wrapper = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  /** The canvas host: its size, and where it sits in the window (device-pixel snapping needs the absolute position). */
  let host = $state({ w: 0, h: 0, x: 0, y: 0, dpr: 1 });
  $effect(() => {
    const parent = wrapper?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const measure = (): void => { const r = parent.getBoundingClientRect(); host = { w: parent.clientWidth, h: parent.clientHeight, x: r.left, y: r.top, dpr: window.devicePixelRatio || 1 }; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  });

  /**
   * The part of the box on screen, in the box's own (untransformed) pixels. Its edges are snapped INWARD to whole
   * device pixels, so one canvas pixel is one screen pixel at any zoom and on a 1.25x display. A rotated element
   * draws its whole box instead (capped below), since its visible part is no rectangle of the box.
   */
  const vis = $derived.by(() => {
    if (!host.w || !host.h) return { x: 0, y: 0, w: 0, h: 0 };
    if (element.rotation) return { x: 0, y: 0, w: bw, h: bh };
    const d = host.dpr;
    const snapIn = (lo: number, hi: number, origin: number, limit: number): [number, number] => {
      const a = Math.ceil((origin + Math.max(lo, 0)) * d) / d - origin, b = Math.floor((origin + Math.min(hi, limit)) * d) / d - origin;
      return [a, Math.max(a, b)];
    };
    const [x0, x1] = snapIn(left, left + bw, host.x, host.w), [y0, y1] = snapIn(top, top + bh, host.y, host.h);
    let x = x0 - left, y = y0 - top;
    const w = x1 - x0, h = y1 - y0;
    // The wrapper mirrors its content for a flipped element, so the visible part is mirrored in box space.
    if (element.flipX) x = bw - (x + w);
    if (element.flipY) y = bh - (y + h);
    return { x, y, w, h };
  });
  const out = $derived.by(() => {
    const w = vis.w * host.dpr, h = vis.h * host.dpr;
    const k = Math.min(1, 4096 / Math.max(1, w, h));
    return { w: Math.max(0, Math.round(w * k)), h: Math.max(0, Math.round(h * k)) };
  });
  /** The image pixels the canvas shows. */
  const visCrop = $derived.by(() => {
    if (!crop || !(bw > 0) || !(bh > 0)) return null;
    const kx = crop.width / bw, ky = crop.height / bh;
    return { x: crop.x + vis.x * kx, y: crop.y + vis.y * ky, width: vis.w * kx, height: vis.h * ky };
  });
  /** The image's ROTATED screen bounds: what the board stands round (it is never rotated or mirrored itself). */
  const bounds = $derived.by(() => {
    const a = (element.rotation * Math.PI) / 180;
    const w = Math.abs(bw * Math.cos(a)) + Math.abs(bh * Math.sin(a)), h = Math.abs(bw * Math.sin(a)) + Math.abs(bh * Math.cos(a));
    const cx = left + bw / 2, cy = top + bh / 2;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  });

  // --- frames -----------------------------------------------------------------------------------
  let driver = $state.raw<LiveDriver | null>(null);
  let frame = $state.raw<FrameInfo | null>(null);
  let problem = $state("");
  // The driver depends on WHICH bundle is shown, never on the asset record's identity: undo, redo and a cancelled
  // edit replace the project with a copy, and recreating the driver then disposed the canvas's WebGL context (lost
  // for good: the same canvas hands back the lost context) and the live image went blank.
  const bundle = $derived(asset ? fluximgBundle(asset) : "");
  $effect(() => {
    if (!canvas || !manifest || !bundle) return;
    let d: LiveDriver;
    try { d = new LiveDriver(canvas, fluximgService(), bundle, manifest, resolveLut); }
    catch (error) { problem = error instanceof Error ? error.message : String(error); return; }
    d.onFrame = (info) => {
      frame = info;
      if (info.sharp && !info.pending) { clearTimeout(waiting); waiting = undefined; }
      fluximgFrame.set({ serial: info.serial, sharp: info.sharp, pending: info.pending });
      canvas?.dispatchEvent(new CustomEvent("flux-fluximg-frame", { bubbles: true, detail: { elementId: element.id, ...info, time: performance.now() } }));
    };
    d.onError = (message) => { problem = message; };
    driver = d;
    liveSampler.read = () => d.inView();
    // Colour maps load lazily; tables built before they arrive are the gray fallback.
    void needLuts().then(() => d.invalidateTables());
    return () => { d.dispose(); if (driver === d) driver = null; liveSampler.read = null; };
  });
  // A view whose frame has not reached the screen a moment after it was asked for: the board's lamp says so
  // (the picture never goes blank while it waits, so nothing else would).
  let waiting: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!driver || !rv || !visCrop || out.w < 1 || out.h < 1) return;
    // On a slide the play key previews: a session-only plane over the view's own (nothing is written).
    const pv = $fluximgPreview, view = pv && rv.index[pv.dim] !== pv.index ? { ...rv, index: { ...rv.index, [pv.dim]: pv.index } } : rv;
    driver.set({ view, crop: visCrop, outWidth: out.w, outHeight: out.h });
    clearTimeout(waiting);
    waiting = setTimeout(() => fluximgFrame.update((f) => ({ ...f, sharp: false, pending: Math.max(1, f.pending) })), 160);
  });

  // --- pointer: readout, hover, and what a drag on the image does ---------------------------------
  /** Screen motion or position → the element's own axes (through its rotation; mirroring is applied by the caller). */
  function unrotate(dx: number, dy: number): [number, number] {
    const a = (-element.rotation * Math.PI) / 180;
    return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
  }
  /** A client point as fractions of the box as it is DRAWN on screen (rotation undone, mirroring not). */
  function boxPoint(clientX: number, clientY: number): { u: number; v: number } {
    const [dx, dy] = unrotate(clientX - (host.x + left + bw / 2), clientY - (host.y + top + bh / 2));
    return { u: (dx + bw / 2) / bw, v: (dy + bh / 2) / bh };
  }
  /** Client point → level-0 image pixels (through rotation and mirroring); null off the image unless `clamp`. */
  function imagePoint(clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
    if (!crop || !(bw > 0) || !(bh > 0)) return null;
    let { u, v } = boxPoint(clientX, clientY);
    if (element.flipX) u = 1 - u;
    if (element.flipY) v = 1 - v;
    if (clamp) { u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v)); }
    else if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
    return { x: crop.x + u * crop.width, y: crop.y + v * crop.height };
  }
  $effect(() => { livePointer.locate = (x, y) => imagePoint(x, y); return () => { livePointer.locate = null; }; });
  let under = $state.raw<{ x: number; y: number; values: number[]; u: number; v: number; cx: number; cy: number } | null>(null);
  let moveQueued = 0, lastMove: PointerEvent | null = null;
  let space = false;

  function readPointer(): void {
    moveQueued = 0;
    const e = lastMove;
    if (!e) return;
    const p = imagePoint(e.clientX, e.clientY);
    livePointer.at = p;
    const b = boxPoint(e.clientX, e.clientY);
    under = p && driver ? { ...p, values: driver.valuesAt(p.x, p.y), u: b.u, v: b.v, cx: e.clientX - host.x, cy: e.clientY - host.y } : null;
    const shape = e.target instanceof Element ? e.target.closest("[data-key]") : null;
    const layer = shape?.closest("[data-layer]")?.getAttribute("data-layer");
    const key = shape?.getAttribute("data-key");
    const now = layer && key ? { layerId: layer, key, from: "image" as const } : null;
    const was = $fluximgHover;
    if ((now?.key ?? "") !== (was?.key ?? "") || (now?.layerId ?? "") !== (was?.layerId ?? "")) { if (now || was?.from === "image") fluximgHover.set(now); }
  }

  // Three things a drag on the live image can be, by what is in hand:
  //   an inset           the drag draws the rectangle that becomes one (the pink of Flux's guides);
  //   a channel          the drag pulls its contrast (right / left) and brightness (up / down);
  //   otherwise          the image moves under its frame, when the frame shows only part of it.
  let pan = $state.raw<{ pointer: number; x: number; y: number; from: { x: number; y: number; width: number; height: number } } | null>(null);
  let pull = $state.raw<{ pointer: number; x: number; y: number; from: [number, number]; channel: number } | null>(null);
  let drawn = $state.raw<{ pointer: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const mode = $derived(live?.armed === "inset" ? "inset" : channelInHand(live?.armed) ? "pull" : live?.armed === "zoom" || !whole ? "pan" : "read");
  /** The rectangle being drawn, in the element's box (canvas px), for the guide. */
  const drawnBox = $derived.by(() => {
    if (!drawn || !crop) return null;
    const kx = box.width / crop.width, ky = box.height / crop.height;
    const x = (Math.min(drawn.x0, drawn.x1) - crop.x) * kx, y = (Math.min(drawn.y0, drawn.y1) - crop.y) * ky;
    return { x, y, width: Math.abs(drawn.x1 - drawn.x0) * kx, height: Math.abs(drawn.y1 - drawn.y0) * ky };
  });
  function onMove(e: PointerEvent): void {
    if (pan && e.pointerId === pan.pointer && crop) {
      e.preventDefault(); e.stopPropagation();
      // Screen motion → image pixels, through rotation and mirroring; the image follows the hand.
      let [dx, dy] = unrotate(e.clientX - pan.x, e.clientY - pan.y);
      if (element.flipX) dx = -dx;
      if (element.flipY) dy = -dy;
      panFrame(-dx * (pan.from.width / bw), -dy * (pan.from.height / bh), "frame-pan", pan.from);
      return;
    }
    if (pull && e.pointerId === pull.pointer) {
      e.preventDefault(); e.stopPropagation();
      dragContrast(pull.channel, pull.from, e.clientX - pull.x, e.clientY - pull.y);
      return;
    }
    if (drawn && e.pointerId === drawn.pointer) {
      e.preventDefault(); e.stopPropagation();
      const p = imagePoint(e.clientX, e.clientY, true);
      if (p) drawn = { ...drawn, x1: p.x, y1: p.y };
      // While the box is drawn, where its inset will go (and, on the board, where the instruments will stand then).
      const w = Math.abs(drawn.x1 - drawn.x0), h = Math.abs(drawn.y1 - drawn.y0);
      const at = w >= 2 && h >= 2 ? insetPlan(w / h) : null;
      if (at || insetGhost) { insetGhost = !!at; preview = at ? { ghosts: [{ box: at.box, label: "inset", wash: "" }], adds: at.place !== "inside" } : null; }
      return;
    }
    lastMove = e;
    if (!moveQueued) moveQueued = requestAnimationFrame(readPointer);
  }
  function onDown(e: PointerEvent): void {
    // Middle button and Space+drag pan the canvas, as everywhere else.
    if (e.button === 1 || space) return;
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (!wrapper || !crop || !live) return;
    if (mode === "inset") {
      const p = imagePoint(e.clientX, e.clientY, true);
      if (!p) return;
      drawn = { pointer: e.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else if (mode === "pull" && rv?.channels[live.channel]) {
      const r = rv.channels[live.channel].range;
      pull = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: [r[0], r[1]], channel: live.channel };
    } else if (mode === "pan" && !whole) {
      pan = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: { ...crop } };
    } else return;
    wrapper.setPointerCapture(e.pointerId);
  }
  function onUp(e: PointerEvent): void {
    const mine = (pan && e.pointerId === pan.pointer) || (pull && e.pointerId === pull.pointer) || (drawn && e.pointerId === drawn.pointer);
    if (!mine) return;
    if (wrapper?.hasPointerCapture(e.pointerId)) wrapper.releasePointerCapture(e.pointerId);
    const rect = drawn && e.type === "pointerup" ? { x: Math.min(drawn.x0, drawn.x1), y: Math.min(drawn.y0, drawn.y1), width: Math.abs(drawn.x1 - drawn.x0), height: Math.abs(drawn.y1 - drawn.y0) } : null;
    const cancelled = e.type !== "pointerup";
    pan = null; pull = null; drawn = null;
    if (insetGhost) { insetGhost = false; preview = null; }
    if (rect) {
      // The rectangle becomes an inset; the image keeps its frame and outlines the inset's region. One is enough:
      // the view lets go of the inset tool.
      if (makeInset(null, rect) && $fluximgLive) { liveArm.explicit = false; setLive({ armed: defaultArmed() }); }
      return;
    }
    if (cancelled) cancelLiveEdit(); else settleLiveEdit();
  }
  function onLeave(): void {
    lastMove = null; livePointer.at = null; under = null;
    if ($fluximgHover?.from === "image") fluximgHover.set(null);
  }
  function onKey(e: KeyboardEvent): void {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    // Space held = pan the canvas, as everywhere else (a Space TAP is the board's play key: it acts on key-up).
    if (e.code === "Space") { space = e.type === "keydown"; if (space) beginPan(); }
  }
  // Capture phase: the board's own window handler takes Space (play / stop) and stops it there.
  $effect(() => {
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKey, { capture: true });
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("keyup", onKey, { capture: true }); };
  });

  // The hovered object (from the image or from the list) is lit on the image; a hovered row of the key lights
  // every object of its category.
  let hot: Element[] = [];
  $effect(() => {
    const h = $fluximgHover;
    for (const el of hot) el.classList.remove("fx-hot");
    hot = [];
    if (!h || !wrapper) return;
    // By id (the overlay's prefix is unique on the page): a row of the key can name thousands of objects.
    for (const k of h.keys ?? [h.key]) {
      const el = document.getElementById(`${prefix}${h.layerId}/${k}`);
      if (el) { el.classList.add("fx-hot"); hot.push(el); }
    }
  });

  const prefix = $derived(`fxl-${element.id.replace(/[^A-Za-z0-9_-]/g, "_")}-`);
  const ax = $derived(manifest?.axes?.x), ay = $derived(manifest?.axes?.y);
  /** A position in the axis' unit, with the decimals one pixel step needs (0.25 µm pixels read "15.75 µm", never "5.2499"). */
  function place(v: number, a: typeof ax, name: string): string {
    if (!a || typeof a.scale !== "number" || !a.unit) return `${name} ${Math.floor(v)}`;
    // The pixel under the pointer, named by its centre.
    const value = (a.offset ?? 0) + a.scale * (Math.floor(v) + 0.5);
    const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(Math.abs(a.scale) / 2) - 1e-9)));
    return `${name} ${value.toFixed(decimals).replace("-", "−")} ${a.unit}`;
  }
  const fmtValue = (v: number): string => (Number.isNaN(v) ? "–" : formatNumber(Number(v.toPrecision(4))));
  const shown = $derived(rv ? contributingChannelIndices(rv).map((i) => rv.channels[i]) : []);
  /** A channel's colour for chrome: its own colour, or a bright entry of its colour map. */
  function inkOf(c: { color: string | null; lut: string | null }): string {
    if (c.color) return c.color;
    const table = c.lut ? resolveLut(c.lut) : null;
    return table?.[Math.floor(table.length * 0.72)]?.slice(0, 7) ?? "#cecdc3";
  }
  // What is under the pointer goes to the board: every channel's strip marks the value, the head says where.
  $effect(() => {
    const h = $fluximgHover;
    fluximgReadout.set(under ? {
      where: [place(under.x, ax, "x"), place(under.y, ay, "y")],
      values: shown.map((c, i) => ({ channel: c.index, value: under!.values[i] ?? NaN, text: fmtValue(under!.values[i] ?? NaN) })),
      object: h ? { layerId: h.layerId, key: h.key } : null,
      u: under.u, v: under.v,
    } : null);
  });
  $effect(() => { fluximgLiveProblem.set(problem); });

  // --- the object under the pointer: a card that follows it -----------------------------------------
  const card = $derived.by(() => {
    const h = $fluximgHover;
    if (!h || h.from !== "image" || !under || !manifest || !asset || pan || pull || drawn) return null;
    const layer = manifest.layers.find((l) => l.id === h.layerId);
    const table = layer && layer.kind !== "intensity" ? tableOf($fluximgTables, asset, layer.table) : null;
    const flip = under.cx > host.w - 250, up = under.cy > host.h - 120;
    // The columns the layer is styled by come first: they are what its colours and opacities mean.
    const sb = rv?.layers.find((l) => l.id === h.layerId)?.styleBy;
    const first = [sb?.color?.column, sb?.opacity?.column].filter((c): c is string => !!c);
    const all = objectCells(table, h.key);
    const cells = [...first.flatMap((c) => all.filter(([n]) => n === c)), ...all.filter(([n]) => !first.includes(n))].slice(0, 4);
    // The object's own colour beside the value it comes from.
    void $fluximgLutsReady;
    const own = sb?.color && layer && layer.kind !== "intensity" ? cachedObjectStyles(table, layer.key ?? null, sb, resolveLut).byKey.get(h.key)?.color ?? null : null;
    return { key: h.key, layer: layer?.name ?? "", cells, styled: first, swatch: own, swatchOf: sb?.color?.column ?? "", x: under.cx, y: under.cy, flip, up };
  });
  $effect(() => {
    const h = $fluximgHover;
    if (!h || !manifest || !asset) return;
    const layer = manifest.layers.find((l) => l.id === h.layerId);
    if (layer && layer.kind !== "intensity") needTable(asset, layer.table);
  });

  // --- annotations you can take hold of: drag one to another corner ---------------------------------
  type Kind = "scalebar" | "stamp" | "channelLabels" | "colorbar" | "key";
  const PARTS: Record<Kind, string> = { scalebar: '[data-part^="scalebar"]', stamp: '[data-part="stamp"]', channelLabels: '[data-part="channel"]', colorbar: '[data-part="colorbar"]', key: '[data-part="key"]' };
  /** The key's rows on screen (client px), so the grip that covers the key can say which category is under the pointer. */
  let legendRows: Array<{ layerId: string; row: string; x0: number; y0: number; x1: number; y1: number }> = [];
  let grips = $state.raw<Array<{ kind: Kind; x: number; y: number; w: number; h: number }>>([]);
  let gripDrag = $state.raw<{ pointer: number; kind: Kind; corner: FurnitureSpot } | null>(null);
  function measureGrips(): void {
    const root = wrapper;
    if (!root || !rv) { grips = []; return; }
    const next: typeof grips = [];
    for (const kind of Object.keys(PARTS) as Kind[]) {
      if (!rv.furniture[kind]) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const el of root.querySelectorAll(PARTS[kind])) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      }
      if (x1 > x0) next.push({ kind, x: x0 - host.x - 4, y: y0 - host.y - 4, w: x1 - x0 + 8, h: y1 - y0 + 8 });
    }
    legendRows = [...root.querySelectorAll<SVGGElement>('[data-part="key.entry"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { layerId: el.getAttribute("data-legend-layer") ?? "", row: el.getAttribute("data-legend-row") ?? "", x0: r.left, y0: r.top - 1, x1: r.right, y1: r.bottom + 1 };
    });
    grips = next;
  }
  // Measured AFTER the frame that draws the image (the picture comes first), and only while an annotation is shown.
  let gripFrame = 0;
  const anyFurniture = $derived(!!rv && !!(rv.furniture.scalebar || rv.furniture.stamp || rv.furniture.channelLabels || rv.furniture.colorbar || rv.furniture.key));
  $effect(() => {
    void rv; void crop; void bw; void bh; void left; void top; void host;
    // The key is drawn from a table that arrives later, and changes with a previewed styling.
    if (rv?.furniture.key) { void $fluximgTables; void shownView; void $fluximgLutsReady; }
    if (!anyFurniture) { if (grips.length) grips = []; return; }
    if (!gripFrame) gripFrame = requestAnimationFrame(() => { gripFrame = 0; measureGrips(); });
  });
  /** The corner of the picture a client point is nearest (annotations are never mirrored, so neither is this). */
  function cornerAt(e: PointerEvent): FurnitureSpot {
    const { u, v } = boxPoint(e.clientX, e.clientY);
    return `${v < 0.5 ? "top" : "bottom"}-${u < 0.5 ? "left" : "right"}` as FurnitureSpot;
  }
  function gripDown(e: PointerEvent, kind: Kind): void {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const item = rv?.furniture[kind];
    gripDrag = { pointer: e.pointerId, kind, corner: item ? item.corner : "bottom-right" };
  }
  /** Over the key, the category under the pointer lights its objects on the image (and nothing else is hovered). */
  function legendHover(e: PointerEvent | null): void {
    const was = $fluximgHover;
    const hit = e ? legendRows.find((r) => e.clientX >= r.x0 && e.clientX <= r.x1 && e.clientY >= r.y0 && e.clientY <= r.y1) : undefined;
    if (!hit || !manifest || !asset || !rv) { if (was?.from === "legend") fluximgHover.set(null); return; }
    const layer = manifest.layers.find((l) => l.id === hit.layerId), lv = rv.layers.find((l) => l.id === hit.layerId);
    if (!layer || layer.kind === "intensity" || !lv?.styleBy) return;
    void $fluximgLutsReady;
    const legend = cachedObjectStyles(tableOf($fluximgTables, asset, layer.table), layer.key ?? null, lv.styleBy, resolveLut).legend;
    const keys = hit.row === "missing" ? legend?.missing?.keys : legend?.color?.kind === "category" ? legend.color.entries[Number(hit.row)]?.keys : undefined;
    if (!keys?.length) { if (was?.from === "legend") fluximgHover.set(null); return; }
    if (was?.from === "legend" && was.layerId === hit.layerId && was.keys?.length === keys.length && was.key === keys[0]) return;
    fluximgHover.set({ layerId: hit.layerId, key: keys[0], keys, from: "legend" });
  }
  function gripMove(e: PointerEvent): void {
    if (!gripDrag && legendRows.length) { legendHover(e); return; }
    if (!gripDrag || e.pointerId !== gripDrag.pointer) return;
    const corner = cornerAt(e);
    if (corner !== gripDrag.corner) { gripDrag = { ...gripDrag, corner }; setFurnitureCorner(gripDrag.kind, corner); }
  }
  function gripUp(e: PointerEvent): void {
    if (!gripDrag || e.pointerId !== gripDrag.pointer) return;
    const cancelled = e.type !== "pointerup";
    gripDrag = null;
    if (cancelled) cancelLiveEdit(); else settleLiveEdit();
  }
  const slot = $derived(Math.max(8, furnitureInset(box) * zoom));

  // --- an inset's region on the picture: take its rectangle and move it; the inset follows -----------
  /** Each inset's region as fractions of the box AS DRAWN (mirrored with the picture), when any of it is in the frame. */
  const regions = $derived.by(() => {
    if (!crop) return [];
    return insets.map((i) => {
      let u = (i.crop.x - crop.x) / crop.width, v = (i.crop.y - crop.y) / crop.height;
      const w = i.crop.width / crop.width, h = i.crop.height / crop.height;
      if (element.flipX) u = 1 - (u + w);
      if (element.flipY) v = 1 - (v + h);
      return { id: i.id, crop: i.crop, u, v, w, h };
    }).filter((r) => r.u < 1 && r.v < 1 && r.u + r.w > 0 && r.v + r.h > 0);
  });
  let regionDrag = $state.raw<{ pointer: number; id: string; x: number; y: number; from: { x: number; y: number; width: number; height: number } } | null>(null);
  function regionDown(e: PointerEvent, r: { id: string; crop: { x: number; y: number; width: number; height: number } }): void {
    if (e.button !== 0 || space) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    fluximgTip.set(null);
    regionDrag = { pointer: e.pointerId, id: r.id, x: e.clientX, y: e.clientY, from: { ...r.crop } };
  }
  function regionMove(e: PointerEvent): void {
    if (!regionDrag || e.pointerId !== regionDrag.pointer || !crop) return;
    let [dx, dy] = unrotate(e.clientX - regionDrag.x, e.clientY - regionDrag.y);
    if (element.flipX) dx = -dx;
    if (element.flipY) dy = -dy;
    moveInset(regionDrag.id, regionDrag.from, dx * (crop.width / bw), dy * (crop.height / bh));
  }
  function regionUp(e: PointerEvent): void {
    if (!regionDrag || e.pointerId !== regionDrag.pointer) return;
    const cancelled = e.type !== "pointerup";
    regionDrag = null;
    if (cancelled) cancelLiveEdit(); else settleLiveEdit();
  }

  // --- what a hovered key would do, drawn on the figure ---------------------------------------------
  let preview = $state.raw<BoardGhosts>(null);
  /** The preview is the inset of the box being drawn (not a key's). */
  let insetGhost = false;
  const origin = $derived({ x: left - element.x * zoom, y: top - element.y * zoom });
  const previewBoxes = $derived.by(() => {
    if (!preview) return [];
    return preview.ghosts.map((g) => ({ x: origin.x + g.box.x * zoom, y: origin.y + g.box.y * zoom, w: g.box.width * zoom, h: g.box.height * zoom, label: g.label, wash: g.wash }));
  });

  const turn = $derived(`rotate(${element.rotation}deg)`);
  const boxStyle = $derived(`left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;transform:${turn} scale(${element.flipX ? -1 : 1},${element.flipY ? -1 : 1});opacity:${element.opacity ?? 1}`);
  const frameStyle = $derived(`left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;transform:${turn}`);
  onDestroy(() => { if (moveQueued) cancelAnimationFrame(moveQueued); if (gripFrame) cancelAnimationFrame(gripFrame); clearTimeout(waiting); for (const el of hot) el.classList.remove("fx-hot"); fluximgStylePreview.set(null); });
</script>


<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={wrapper} class="fx-live" class:pan={mode === "pan" && !whole} class:panning={!!pan} class:pull={mode === "pull"} class:inset={mode === "inset"} style={boxStyle}
  data-fluximg-live={element.id} data-command-scope="fluximg-live" data-level={frame?.level ?? ""} data-sharp={frame?.sharp ? "1" : "0"} data-mode={mode}
  onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} onlostpointercapture={onUp} onpointerleave={onLeave} ondblclick={(e) => e.stopPropagation()}>
  <canvas bind:this={canvas} class="gl" class:pixelated={!rv?.smooth} style={`left:${vis.x}px;top:${vis.y}px;width:${vis.w}px;height:${vis.h}px`}></canvas>
  {#if asset && manifest && rv && crop}
    <svg class="vec" width={bw} height={bh} viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio="none">
      <FluximgVectors {asset} {manifest} view={shownView ?? rv} {crop} {box} {prefix} flipX={!!element.flipX} flipY={!!element.flipY} {insets} />
      {#if drawnBox}<rect class="draw" x={drawnBox.x} y={drawnBox.y} width={drawnBox.width} height={drawnBox.height} />{/if}
    </svg>
  {/if}
</div>

<!-- The viewfinder: a pink hairline with corner marks says this image is live, and the marks thicken into handles
     when the frame is in hand. Ticks on its edges follow the pointer across the image. -->
<div class="fx-frame" class:hand={live?.armed === "zoom"} class:inset={mode === "inset"} style={frameStyle} aria-hidden="true" data-fxb-frame>
  <!-- The corner marks look like something to press: a press on one is the board's (it does nothing), never the
       canvas's (which would take it for a click elsewhere and close the view). -->
  {#each ["tl", "tr", "bl", "br"] as k (k)}<!-- svelte-ignore a11y_no_static_element_interactions --><i class={`c ${k}`} onpointerdown={(e) => { e.preventDefault(); e.stopPropagation(); }} ondblclick={(e) => e.stopPropagation()}></i>{/each}
  {#if under && !pan && !pull && !drawn}
    <i class="t x" style={`left:${under.u * 100}%`}></i><i class="t x b" style={`left:${under.u * 100}%`}></i>
    <i class="t y" style={`top:${under.v * 100}%`}></i><i class="t y r" style={`top:${under.v * 100}%`}></i>
  {/if}
  {#if gripDrag}
    {#each ["top-left", "top-right", "bottom-left", "bottom-right"] as c (c)}
      <i class="slot" class:on={gripDrag.corner === c} style={`${c.startsWith("top") ? "top" : "bottom"}:${slot}px;${c.endsWith("left") ? "left" : "right"}:${slot}px`}></i>
    {/each}
  {/if}
</div>

<!-- An inset's region is a thing on the picture too: drag its rectangle and the inset shows what is under it;
     roll the wheel over it and the inset shows it closer or wider. (Not while a box is being drawn or contrast pulled.) -->
{#if regions.length && (mode === "read" || mode === "pan")}
  <!-- Only the rectangle's EDGE takes the pointer (a band 12 px wide): what is inside it is still the image's. -->
  <svg class="fx-regions" style={frameStyle} width={bw} height={bh} viewBox={`0 0 ${bw} ${bh}`} aria-hidden="true">
    {#each regions as r (r.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <rect class="hit" class:held={regionDrag?.id === r.id} x={r.u * bw} y={r.v * bh} width={r.w * bw} height={r.h * bh} data-fxb-region={r.id} data-fxb-wheel={`region:${r.id}`}
        onpointerenter={(e) => { if (!regionDrag && !e.buttons) { const b = (e.currentTarget as SVGRectElement).getBoundingClientRect(); fluximgTip.set({ text: "The inset's region · drag its edge to move it, roll to size it", hk: "", x: Math.min(host.w - 8, Math.max(8, b.left + b.width / 2 - host.x)), y: b.top - host.y < 34 ? b.bottom - host.y + 9 : b.top - host.y - 9, below: b.top - host.y < 34 }); } }}
        onpointerleave={() => fluximgTip.set(null)}
        onpointerdown={(e) => regionDown(e, r)} onpointermove={regionMove} onpointerup={regionUp} onpointercancel={regionUp} onlostpointercapture={regionUp} />
      <rect class="show" x={r.u * bw} y={r.v * bh} width={r.w * bw} height={r.h * bh} />
    {/each}
  </svg>
{/if}

<!-- An annotation that is shown is a thing on the picture: take it and put it in another corner. -->
{#each grips as g (g.kind)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fx-grip" class:held={gripDrag?.kind === g.kind} style={`left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px`} data-fxb-grip={g.kind} data-fxb-wheel={`furniture:${g.kind}`}
    onpointerenter={() => { if (!gripDrag) fluximgTip.set({ text: g.kind === "scalebar" ? "Drag to another corner · roll: its length" : g.kind === "key" ? "Drag to a corner · roll: text size · point at a value" : "Drag to another corner · roll: text size", hk: "", x: Math.min(host.w - 8, Math.max(8, g.x + g.w / 2)), y: g.y < 34 ? g.y + g.h + 7 : g.y - 7, below: g.y < 34 }); }}
    onpointerleave={() => { fluximgTip.set(null); legendHover(null); }}
    onpointerdown={(e) => { fluximgTip.set(null); legendHover(null); gripDown(e, g.kind); }} onpointermove={gripMove} onpointerup={gripUp} onpointercancel={gripUp} onlostpointercapture={gripUp}></div>
{/each}

{#each previewBoxes as b, i (i)}
  <div class="fx-preview" style={`left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px${b.wash ? `;background:${b.wash}` : ""}`} aria-hidden="true" data-fxb-ghost><span>{b.label}</span></div>
{/each}

{#if card}
  <div class="fx-card" class:flip={card.flip} class:up={card.up} style={`left:${card.x}px;top:${card.y}px`} role="status" data-fxb-card>
    <b>{card.key}</b><span class="of">{card.layer}</span>
    {#each card.cells as [name, value] (name)}<span class="cell" class:styled={card.styled.includes(name)}><i>{name}</i><span class="v">{#if card.swatch && name === card.swatchOf}<i class="sw" style={`background:${card.swatch}`}></i>{/if}{value}</span></span>{/each}
    {#if under}<span class="cell vals">{#each shown as c, i (c.index)}<span><i class="dot" style={`background:${inkOf(c)}`}></i>{fmtValue(under.values[i] ?? NaN)}</span>{/each}</span>{/if}
  </div>
{/if}

{#if manifest && rv && host.w > 0}
  <FluximgBoard image={bounds} host={{ w: host.w, h: host.h }} {origin} {zoom} prefetch={(dim, steps) => driver?.prefetch(dim, steps)} bind:preview {moveView} />
{/if}

<style>
  .fx-live { position: absolute; transform-origin: center; touch-action: none; overflow: hidden; outline: none; cursor: var(--cursor-cross); }
  .fx-live.pan { cursor: grab; }
  .fx-live.panning { cursor: grabbing; }
  .fx-live.pull { cursor: move; }
  .fx-live.inset { cursor: crosshair; }
  /* The rectangle being drawn for an inset: the pink of Flux's guides, a constant hairline at any zoom. */
  .vec .draw { fill: color-mix(in oklab, var(--c-guide) 16%, transparent); stroke: var(--c-guide); stroke-width: 1.5px; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
  .gl { position: absolute; display: block; pointer-events: none; }
  /* The drawing buffer is one pixel per screen pixel; if the browser ever rescales it, it must not smooth true pixels. */
  .gl.pixelated { image-rendering: pixelated; }
  .vec { position: absolute; inset: 0; display: block; overflow: hidden; pointer-events: none; }
  /* Objects answer the pointer over their whole interior, drawn or not, so a thin outline is easy to find. */
  .vec :global([data-key]) { pointer-events: all; }
  .vec :global(.fx-hot) { stroke: var(--c-guide) !important; stroke-width: 2px !important; vector-effect: non-scaling-stroke; fill: var(--c-guide) !important; fill-opacity: 0.22 !important; }

  .fx-frame { position: absolute; z-index: 2; transform-origin: center; pointer-events: none; box-shadow: 0 0 0 1px color-mix(in oklab, var(--c-guide) 62%, transparent); animation: fx-frame-in 150ms linear backwards; }
  @keyframes fx-frame-in { from { opacity: 0; } to { opacity: 1; } }
  .c { position: absolute; width: 11px; height: 11px; pointer-events: auto; border: 0 solid var(--c-guide); transition: width 90ms linear, height 90ms linear, border-width 90ms linear; }
  .c.tl { left: -4px; top: -4px; border-left-width: 2px; border-top-width: 2px; }
  .c.tr { right: -4px; top: -4px; border-right-width: 2px; border-top-width: 2px; }
  .c.bl { left: -4px; bottom: -4px; border-left-width: 2px; border-bottom-width: 2px; }
  .c.br { right: -4px; bottom: -4px; border-right-width: 2px; border-bottom-width: 2px; }
  .fx-frame.hand .c { width: 17px; height: 17px; }
  .fx-frame.hand .c.tl { border-left-width: 3.5px; border-top-width: 3.5px; }
  .fx-frame.hand .c.tr { border-right-width: 3.5px; border-top-width: 3.5px; }
  .fx-frame.hand .c.bl { border-left-width: 3.5px; border-bottom-width: 3.5px; }
  .fx-frame.hand .c.br { border-right-width: 3.5px; border-bottom-width: 3.5px; }
  .fx-frame.inset { box-shadow: 0 0 0 1px var(--c-guide), 0 0 0 4px color-mix(in oklab, var(--c-guide) 22%, transparent); }
  /* Where the pointer is, on the frame's own edges: four small ticks that ride with it. */
  .t { position: absolute; background: var(--c-guide); }
  .t.x { top: -7px; width: 1.5px; height: 6px; margin-left: -0.75px; }
  .t.x.b { top: auto; bottom: -7px; }
  .t.y { left: -7px; width: 6px; height: 1.5px; margin-top: -0.75px; }
  .t.y.r { left: auto; right: -7px; }
  .slot { position: absolute; width: 20%; height: 11%; min-width: 26px; min-height: 14px; border: 1.5px dashed color-mix(in oklab, var(--c-guide) 70%, transparent); border-radius: 4px; }
  .slot.on { border-style: solid; border-color: var(--c-guide); background: color-mix(in oklab, var(--c-guide) 18%, transparent); }

  .fx-regions { position: absolute; z-index: 2; display: block; transform-origin: center; pointer-events: none; overflow: hidden; }
  .fx-regions .hit { fill: none; stroke: transparent; stroke-width: 12px; pointer-events: stroke; cursor: grab; touch-action: none; }
  .fx-regions .hit.held { cursor: grabbing; }
  .fx-regions .show { fill: none; stroke: transparent; stroke-width: 2px; pointer-events: none; transition: stroke 80ms linear, fill 80ms linear; }
  .fx-regions .hit:hover + .show { stroke: var(--c-guide); fill: color-mix(in oklab, var(--c-guide) 8%, transparent); }
  .fx-regions .hit.held + .show { stroke: var(--c-guide); fill: color-mix(in oklab, var(--c-guide) 14%, transparent); }
  .fx-grip { position: absolute; z-index: 2; border-radius: 4px; cursor: grab; touch-action: none; transition: box-shadow 80ms linear, background-color 80ms linear; }
  .fx-grip:hover { box-shadow: 0 0 0 1px var(--c-guide); background: color-mix(in oklab, var(--c-guide) 12%, transparent); }
  .fx-grip.held { cursor: grabbing; box-shadow: 0 0 0 1.5px var(--c-guide); background: color-mix(in oklab, var(--c-guide) 20%, transparent); }

  .fx-preview { position: absolute; z-index: 2; box-sizing: border-box; display: grid; place-items: center; pointer-events: none; border: 1.5px dashed var(--c-guide); background: color-mix(in oklab, var(--c-guide) 13%, transparent); border-radius: 2px; }
  .fx-preview span { padding: 1px 8px; border-radius: 9px; background: var(--flx-paper); color: var(--flx-magenta-600); font: 600 10.5px var(--font-mono); white-space: nowrap; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); max-width: 90%; overflow: hidden; text-overflow: ellipsis; }

  /* The object under the pointer, named beside it. */
  .fx-card { position: absolute; z-index: 4; display: flex; flex-direction: column; gap: 1px; min-width: 96px; max-width: 232px; margin: 14px 0 0 14px; padding: 6px 10px 7px; border-radius: 8px; background: #161514; border: 1px solid var(--c-guide); box-shadow: 0 8px 22px -8px rgba(0, 0, 0, 0.75), 0 2px 5px rgba(0, 0, 0, 0.4); color: var(--flx-base-200); font: 10.5px/15px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }
  .fx-card.flip { transform: translateX(calc(-100% - 28px)); }
  .fx-card.up { margin-top: 0; transform: translateY(calc(-100% - 12px)); }
  .fx-card.flip.up { transform: translate(calc(-100% - 28px), calc(-100% - 12px)); }
  .fx-card b { font: 600 12.5px/17px var(--font-ui); color: var(--flx-paper); overflow: hidden; text-overflow: ellipsis; }
  .fx-card .of { margin-bottom: 2px; color: var(--flx-base-500); font-family: var(--font-ui); }
  .fx-card .cell { display: flex; gap: 8px; justify-content: space-between; overflow: hidden; }
  .fx-card .cell > i { font-style: normal; color: var(--flx-base-500); }
  /* A column the layer is styled by: what the object's colour or opacity says, in the board's pink. */
  .fx-card .cell.styled > i { color: var(--c-guide); }
  .fx-card .v { display: inline-flex; align-items: center; gap: 5px; }
  .fx-card .sw { width: 8px; height: 8px; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); }
  .fx-card .vals { justify-content: flex-start; gap: 10px; margin-top: 2px; }
  .fx-card .vals span { display: inline-flex; align-items: center; gap: 4px; }
  .fx-card .dot { width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); }
</style>
