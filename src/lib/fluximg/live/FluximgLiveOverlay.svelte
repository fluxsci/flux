<script lang="ts">
  /**
   * The live image: a WebGL canvas exactly over the placed element, the element's own vector layers on top of it,
   * the navigator rails beside it, and a one-line readout of what is under the pointer.
   *
   * The image stays flat and in place. Everything here is transient chrome: the view recipe is on the element
   * (edits go through `actions.ts`), and when the live view closes the element's still, drawn by the reference
   * renderer from the same recipe, is what remains.
   */
  import { onDestroy, tick } from "svelte";
  import { project } from "../../store";
  import { yieldsToShellModal, isAnnotateChord } from "../../../shell/agent/annotationVisibility";
  import { fluximgBundle, fluximgManifests, fluximgService, needLuts, resolveLut } from "../store";
  import FluximgVectors from "../FluximgVectors.svelte";
  import { clampCrop } from "../still";
  import { insetsOf } from "../static";
  import { contributingChannelIndices, describePosition, describeProjection, formatNumber, resolveView } from "../viewOps";
  import type { FluximgElement } from "../../types";
  import FluximgRail from "./FluximgRail.svelte";
  import { dimKeys, dimLength, dragContrast, makeInset, panFrame, railDims, setPosition, setRun, togglePlayback } from "./actions";
  import { LiveDriver, type FrameInfo } from "./driver";
  import { armLive, cancelLiveEdit, fluximgHover, fluximgLive, fluximgLiveProblem, fluximgLiveRect, fluximgReadout, livePointer, liveSampler, settleLiveEdit } from "./session";

  let { element, left, top, zoom, beginPan }: { element: FluximgElement; left: number; top: number; zoom: number; beginPan: () => void } = $props();

  const asset = $derived($project.assets.find((a) => a.id === element.assetId && a.kind === "fluximg"));
  const manifest = $derived(asset ? $fluximgManifests[asset.id] : undefined);
  const rv = $derived(manifest ? resolveView(manifest, element.view) : null);
  const crop = $derived(manifest ? clampCrop(manifest, element.crop) : null);
  const box = $derived({ width: element.width, height: element.height });
  const live = $derived($fluximgLive);
  const insets = $derived.by(() => {
    for (const f of $project.figures) if (f.elements.some((e) => e.id === element.id)) return insetsOf(f.elements, element.id, element.assetId);
    return [];
  });

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
      canvas?.dispatchEvent(new CustomEvent("flux-fluximg-frame", { bubbles: true, detail: { elementId: element.id, ...info, time: performance.now() } }));
    };
    d.onError = (message) => { problem = message; };
    driver = d;
    liveSampler.read = () => d.inView();
    // Colour maps load lazily; tables built before they arrive are the gray fallback.
    void needLuts().then(() => d.invalidateTables());
    return () => { d.dispose(); if (driver === d) driver = null; liveSampler.read = null; };
  });
  $effect(() => {
    if (!driver || !rv || !visCrop || out.w < 1 || out.h < 1) return;
    driver.set({ view: rv, crop: visCrop, outWidth: out.w, outHeight: out.h });
  });

  // --- rails ------------------------------------------------------------------------------------
  const dims = $derived(manifest ? railDims(manifest) : []);
  const keys = $derived(manifest ? dimKeys(manifest) : {});
  const vDim = $derived(dims.includes("z") ? "z" : null);
  const hDims = $derived(dims.filter((d) => d !== vDim));
  /** A channel's colour for chrome: its own colour, or a bright entry of its colour map. */
  function inkOf(c: { color: string | null; lut: string | null }): string {
    if (c.color) return c.color;
    const table = c.lut ? resolveLut(c.lut) : null;
    return table?.[Math.floor(table.length * 0.72)] ?? "#cecdc3";
  }
  const shownChannels = $derived(rv ? contributingChannelIndices(rv).map((i) => rv.channels[i]) : []);
  function profilesOf(dim: string): Array<{ color: string; values: ReadonlyArray<number | null> }> {
    const mean = manifest?.profiles?.[dim]?.mean;
    if (!mean) return [];
    return shownChannels.filter((c) => mean[c.index]).map((c) => ({ color: inkOf(c), values: mean[c.index] }));
  }
  function readoutOf(dim: string): string {
    if (!manifest || !rv) return "";
    const p = rv.projection;
    // "z 12/25 · −13 µm" without its leading dimension letter: the key cap already says it.
    const words = p && p.dim === dim ? describeProjection(manifest, p) : describePosition(manifest, dim, rv.index[dim] ?? 0);
    // …and a projection reads "max 1–7 · −61.5 to −55.5 µm", for the same reason.
    return p && p.dim === dim ? words.replace(new RegExp(`\\s${dim}\\s`), " ") : words.replace(new RegExp(`^${dim}\\s+`), "");
  }
  function scrub(dim: string, index: number, phase: "start" | "move" | "end" | "cancel"): void {
    if (phase === "cancel") { cancelLiveEdit(); return; }
    const before = rv?.index[dim] ?? 0;
    setPosition(dim, index);
    if (index !== before) driver?.prefetch(dim, index > before ? [1, 2, 3] : [-1, -2, -3]);
    if (phase === "end") settleLiveEdit();
  }
  function runTo(dim: string, from: number, to: number, phase: "start" | "move" | "end" | "cancel"): void {
    if (phase === "cancel") { cancelLiveEdit(); return; }
    setRun(dim, from, to);
    if (phase === "end") settleLiveEdit();
  }
  const arm = (dim: string): void => armLive(`pos:${dim}`);

  // Layout around the element's ROTATED screen bounds (rails are never rotated or mirrored).
  // ROW: a horizontal rail with its ticks. CAP: its key cap and gap. HTAIL: its position and play button.
  // VW: a depth rail with its tick labels. VHEAD: the line above a depth rail (key, play, position).
  const GAP = 10, ROW = 52, CAP = 31, HTAIL = 140, VW = 78, VHEAD = 74;
  const bounds = $derived.by(() => {
    const a = (element.rotation * Math.PI) / 180;
    const w = Math.abs(bw * Math.cos(a)) + Math.abs(bh * Math.sin(a)), h = Math.abs(bw * Math.sin(a)) + Math.abs(bh * Math.cos(a));
    const cx = left + bw / 2, cy = top + bh / 2;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  });
  /** A span clamped into the host, keeping at least `min` px of track. */
  function span(lo: number, hi: number, limit: number, before: number, after: number, min = 96): { start: number; length: number } {
    const a = Math.max(lo, before), b = Math.min(hi, limit - after);
    if (b - a >= min) return { start: a, length: b - a };
    const length = Math.min(Math.max(min, hi - lo), Math.max(40, limit - before - after));
    return { start: Math.min(Math.max(before, lo), Math.max(before, limit - after - length)), length };
  }
  /**
   * Depth stands at the image's right. When the right has no room it stands at its left; only when neither side
   * has room (the image fills the canvas) does it stand over the image's right edge. Rails never cover pixels
   * while there is anywhere else to be.
   */
  const vRail = $derived.by(() => {
    const s = span(bounds.y, bounds.y + bounds.h, host.h, VHEAD + 8, 12);
    const right = bounds.x + bounds.w + GAP, leftSide = bounds.x - GAP - VW;
    const x = right + VW <= host.w - 4 ? right : leftSide >= 4 ? leftSide : Math.max(4, host.w - VW - 4);
    return { x, y: s.start - VHEAD, extent: s.length };
  });
  /** Time (and any other dimension) lies under the image; above it when there is no room below; over its foot last. */
  const hRail = $derived.by(() => {
    const s = span(bounds.x, bounds.x + bounds.w, host.w, CAP + 8, HTAIL + 8);
    const height = hDims.length * ROW;
    const below = bounds.y + bounds.h + GAP, above = bounds.y - GAP - height;
    let y = below + height <= host.h - 4 ? below : above >= 4 ? above : Math.max(4, host.h - height - 4);
    // Beside a depth rail the row must not run into that rail's box (its key line stands above the image, so a time
    // row moved ABOVE the image lay right across it): step past the depth box, on the same side, when they would meet.
    if (vDim) {
      const x0 = s.start - CAP, x1 = s.start + s.length + HTAIL, vy0 = vRail.y, vy1 = vRail.y + VHEAD + vRail.extent + 8;
      if (x0 < vRail.x + VW && x1 > vRail.x && y < vy1 && y + height > vy0) {
        const under = vy1 + 4, over = vy0 - 4 - height, fitsUnder = under + height <= host.h - 4, fitsOver = over >= 4;
        if (y >= bounds.y + bounds.h) y = fitsUnder ? under : fitsOver ? over : y;
        else y = fitsOver ? over : fitsUnder ? under : y;
      }
    }
    return { x: s.start - CAP, y, extent: s.length };
  });

  // The panel keeps clear of the image AND its rails: measured from what is on screen, after it is laid out.
  let railBoxes = $state<HTMLElement[]>([]);
  $effect(() => {
    void hRail; void vRail; void hDims; void vDim; void rv;
    const image = { x: host.x + bounds.x, y: host.y + bounds.y, w: bounds.w, h: bounds.h };
    void tick().then(() => {
      let x0 = image.x, y0 = image.y, x1 = image.x + image.w, y1 = image.y + image.h;
      for (const box of railBoxes) {
        if (!box?.isConnected) continue;
        const r = box.getBoundingClientRect();
        if (!r.width) continue;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      }
      fluximgLiveRect.set({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    });
  });

  // --- pointer: readout, hover, panning inside the frame -----------------------------------------
  /** Client point → level-0 image pixels (through the element's rotation and mirroring), or null off the image. */
  function imagePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!crop || !(bw > 0) || !(bh > 0)) return null;
    const cx = host.x + left + bw / 2, cy = host.y + top + bh / 2, a = (-element.rotation * Math.PI) / 180;
    let dx = clientX - cx, dy = clientY - cy;
    [dx, dy] = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
    if (element.flipX) dx = -dx;
    if (element.flipY) dy = -dy;
    const u = (dx + bw / 2) / bw, v = (dy + bh / 2) / bh;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
    return { x: crop.x + u * crop.width, y: crop.y + v * crop.height };
  }
  let under = $state<{ x: number; y: number; values: number[] } | null>(null);
  let moveQueued = 0, lastMove: PointerEvent | null = null;
  let pan = $state.raw<{ pointer: number; x: number; y: number; from: { x: number; y: number; width: number; height: number } } | null>(null);
  let space = false;

  function readPointer(): void {
    moveQueued = 0;
    const e = lastMove;
    if (!e) return;
    const p = imagePoint(e.clientX, e.clientY);
    livePointer.at = p;
    under = p && driver ? { ...p, values: driver.valuesAt(p.x, p.y) } : null;
    const shape = e.target instanceof Element ? e.target.closest("[data-key]") : null;
    const layer = shape?.closest("[data-layer]")?.getAttribute("data-layer");
    const key = shape?.getAttribute("data-key");
    const now = layer && key ? { layerId: layer, key, from: "image" as const } : null;
    const was = $fluximgHover;
    if ((now?.key ?? "") !== (was?.key ?? "") || (now?.layerId ?? "") !== (was?.layerId ?? "")) { if (now || was?.from === "image") fluximgHover.set(now); }
  }
  // Three things a press on the live image can be, by what the panel has open:
  //   Frame zone             drag moves the image under its frame;
  //   Frame zone, inset armed  drag draws the rectangle that becomes an inset (the pink of Flux's guides);
  //   a channel's zone       drag pulls that channel's contrast (right/left) and brightness (up/down).
  let pull = $state.raw<{ pointer: number; x: number; y: number; from: [number, number]; channel: number } | null>(null);
  let drawn = $state.raw<{ pointer: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** The rectangle being drawn, in the element's box (canvas px), for the guide. */
  const drawnBox = $derived.by(() => {
    if (!drawn || !crop) return null;
    const kx = box.width / crop.width, ky = box.height / crop.height;
    const x = (Math.min(drawn.x0, drawn.x1) - crop.x) * kx, y = (Math.min(drawn.y0, drawn.y1) - crop.y) * ky;
    return { x, y, width: Math.abs(drawn.x1 - drawn.x0) * kx, height: Math.abs(drawn.y1 - drawn.y0) * ky };
  });
  /** A client point as image pixels, clamped INTO the image (a drag may leave it). */
  function imagePointClamped(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!crop || !(bw > 0) || !(bh > 0)) return null;
    const cx = host.x + left + bw / 2, cy = host.y + top + bh / 2, a = (-element.rotation * Math.PI) / 180;
    let dx = clientX - cx, dy = clientY - cy;
    [dx, dy] = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
    if (element.flipX) dx = -dx;
    if (element.flipY) dy = -dy;
    const u = Math.min(1, Math.max(0, (dx + bw / 2) / bw)), v = Math.min(1, Math.max(0, (dy + bh / 2) / bh));
    return { x: crop.x + u * crop.width, y: crop.y + v * crop.height };
  }
  function onMove(e: PointerEvent): void {
    if (pan && e.pointerId === pan.pointer && crop) {
      e.preventDefault(); e.stopPropagation();
      // Screen motion → image pixels, through rotation and mirroring; the image follows the hand.
      const a = (-element.rotation * Math.PI) / 180;
      let dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      [dx, dy] = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
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
      const p = imagePointClamped(e.clientX, e.clientY);
      if (p) drawn = { ...drawn, x1: p.x, y1: p.y };
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
    if (live.zone === "frame" && live.armed === "inset") {
      const p = imagePointClamped(e.clientX, e.clientY);
      if (!p) return;
      drawn = { pointer: e.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else if (live.zone === "frame") {
      pan = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: { ...crop } };
    } else if (live.zone === "channel" && rv?.channels[live.channel]) {
      const r = rv.channels[live.channel].range;
      pull = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: [r[0], r[1]], channel: live.channel };
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
    if (rect) {
      // The rectangle becomes an inset beside the image; the image keeps its frame and outlines the inset's region.
      if (makeInset(null, rect)) armLive("zoom");
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
    // Space held = pan the canvas, as everywhere else (a Space TAP is the panel's play key: it acts on key-up).
    if (e.code === "Space") { space = e.type === "keydown"; if (space) beginPan(); }
  }
  // Capture phase: the panel's own window handler takes Space (play / stop) and stops it there, and this overlay,
  // mounted after the panel, never saw it: Space+drag over the live image did not pan the canvas.
  $effect(() => {
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKey, { capture: true });
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("keyup", onKey, { capture: true }); };
  });

  // The hovered object (from the image or from the list) is outlined on the image.
  let hot: Element | null = null;
  $effect(() => {
    const h = $fluximgHover;
    hot?.classList.remove("fx-hot");
    hot = h && wrapper ? wrapper.querySelector(`[id="${CSS.escape(`${prefix}${h.layerId}/${h.key}`)}"]`) : null;
    hot?.classList.add("fx-hot");
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
  // What is under the pointer goes to the panel's readout strip (one fixed place, so nothing floats over the figure).
  $effect(() => {
    const object = $fluximgHover?.key ?? "";
    fluximgReadout.set(under ? {
      where: `${place(under.x, ax, "x")}   ${place(under.y, ay, "y")}`,
      values: shownChannels.map((c, i) => ({ name: c.name, ink: inkOf(c), text: fmtValue(under!.values[i] ?? NaN) })),
      object,
    } : null);
  });
  $effect(() => { fluximgLiveProblem.set(problem); });

  const boxStyle = $derived(`left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;transform:rotate(${element.rotation}deg) scale(${element.flipX ? -1 : 1},${element.flipY ? -1 : 1});opacity:${element.opacity ?? 1}`);
  onDestroy(() => { if (moveQueued) cancelAnimationFrame(moveQueued); hot?.classList.remove("fx-hot"); });
</script>


<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={wrapper} class="fx-live" class:framing={live?.zone === "frame" && live.armed !== "inset"} class:panning={!!pan} class:pulling={live?.zone === "channel"} style={boxStyle}
  data-fluximg-live={element.id} data-command-scope="fluximg-live" data-level={frame?.level ?? ""} data-sharp={frame?.sharp ? "1" : "0"}
  onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} onlostpointercapture={onUp} onpointerleave={onLeave}>
  <canvas bind:this={canvas} class="gl" class:pixelated={!rv?.smooth} style={`left:${vis.x}px;top:${vis.y}px;width:${vis.w}px;height:${vis.h}px`}></canvas>
  {#if asset && manifest && rv && crop}
    <svg class="vec" width={bw} height={bh} viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio="none">
      <FluximgVectors {asset} {manifest} view={rv} {crop} {box} {prefix} flipX={!!element.flipX} flipY={!!element.flipY} {insets} />
      {#if drawnBox}<rect class="draw" x={drawnBox.x} y={drawnBox.y} width={drawnBox.width} height={drawnBox.height} />{/if}
    </svg>
  {/if}
</div>

{#if manifest && rv}
  {#each hDims as dim, i (dim)}
    <div class="fx-railpos" bind:this={railBoxes[i]} style={`left:${hRail.x}px;top:${hRail.y + i * ROW}px`}>
      <FluximgRail {dim} hotkey={keys[dim] ?? ""} length={dimLength(manifest, dim)} index={rv.index[dim] ?? 0}
        run={rv.projection?.dim === dim ? rv.projection : null} profiles={profilesOf(dim)} axis={manifest.axes?.[dim]} extent={hRail.extent}
        armed={live?.armed === `pos:${dim}` || live?.armed === `run:${dim}`} readout={readoutOf(dim)} unit={manifest.axes?.[dim]?.unit ?? ""} format={formatNumber}
        playing={live?.playing?.dim === dim} onplay={() => togglePlayback(dim)}
        onscrub={(index, phase) => scrub(dim, index, phase)} onrun={(from, to, phase) => runTo(dim, from, to, phase)} onarm={() => arm(dim)} />
    </div>
  {/each}
  {#if vDim}
    <div class="fx-railpos v" bind:this={railBoxes[hDims.length]} style={`left:${vRail.x}px;top:${vRail.y}px`}>
      <FluximgRail dim={vDim} hotkey={keys[vDim] ?? ""} vertical length={dimLength(manifest, vDim)} index={rv.index[vDim] ?? 0}
        run={rv.projection?.dim === vDim ? rv.projection : null} profiles={profilesOf(vDim)} axis={manifest.axes?.[vDim]} extent={vRail.extent}
        armed={live?.armed === `pos:${vDim}` || live?.armed === `run:${vDim}`} readout={readoutOf(vDim)} unit={manifest.axes?.[vDim]?.unit ?? ""} format={formatNumber}
        playing={live?.playing?.dim === vDim} onplay={() => togglePlayback(vDim)}
        onscrub={(index, phase) => scrub(vDim, index, phase)} onrun={(from, to, phase) => runTo(vDim, from, to, phase)} onarm={() => arm(vDim)} />
    </div>
  {/if}
{/if}

<style>
  .fx-live { position: absolute; transform-origin: center; touch-action: none; overflow: hidden; outline: none; cursor: var(--cursor-cross); }
  .fx-live.framing { cursor: grab; }
  .fx-live.panning { cursor: grabbing; }
  .fx-live.pulling { cursor: move; }
  /* The rectangle being drawn for an inset: the pink of Flux's guides, a constant hairline at any zoom. */
  .vec .draw { fill: var(--c-layout-gap-tint); stroke: var(--c-layout-gap); stroke-width: 1.25px; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
  .gl { position: absolute; display: block; pointer-events: none; }
  /* The drawing buffer is one pixel per screen pixel; if the browser ever rescales it, it must not smooth true pixels. */
  .gl.pixelated { image-rendering: pixelated; }
  .vec { position: absolute; inset: 0; display: block; overflow: hidden; pointer-events: none; }
  /* Objects answer the pointer over their whole interior, drawn or not, so a thin outline is easy to find. */
  .vec :global([data-key]) { pointer-events: all; }
  .vec :global(.fx-hot) { stroke: var(--c-accent-bright) !important; stroke-width: 2px !important; vector-effect: non-scaling-stroke; fill: var(--c-accent-bright) !important; fill-opacity: 0.18 !important; }
  /* Rails are drawn straight on the canvas (no card of their own): see FluximgRail. */
  .fx-railpos { position: absolute; z-index: 2; }
</style>
