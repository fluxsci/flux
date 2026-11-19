<script lang="ts">
  /**
   * The live image: a WebGL canvas exactly over the placed element, the element's own vector layers on top of it,
   * the navigator rails beside it, and a one-line readout of what is under the pointer.
   *
   * The image stays flat and in place. Everything here is transient chrome: the view recipe is on the element
   * (edits go through `actions.ts`), and when the live view closes the element's still, drawn by the reference
   * renderer from the same recipe, is what remains.
   */
  import { onDestroy } from "svelte";
  import { project } from "../../store";
  import { fluximgBundle, fluximgManifests, fluximgService, needLuts, resolveLut } from "../store";
  import FluximgVectors from "../FluximgVectors.svelte";
  import { clampCrop } from "../still";
  import { insetsOf } from "../static";
  import { contributingChannelIndices, describePosition, describeProjection, formatNumber, resolveView } from "../viewOps";
  import type { FluximgElement } from "../../types";
  import FluximgRail from "./FluximgRail.svelte";
  import { dimKeys, dimLength, panFrame, railDims, setPosition, setRun, togglePlayback } from "./actions";
  import { LiveDriver, type FrameInfo } from "./driver";
  import { cancelLiveEdit, fluximgHover, fluximgLive, fluximgLiveRect, livePointer, setLive, settleLiveEdit } from "./session";

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
  $effect(() => {
    if (!canvas || !manifest || !asset) return;
    let d: LiveDriver;
    try { d = new LiveDriver(canvas, fluximgService(), fluximgBundle(asset), manifest, resolveLut); }
    catch (error) { problem = error instanceof Error ? error.message : String(error); return; }
    d.onFrame = (info) => {
      frame = info;
      canvas?.dispatchEvent(new CustomEvent("flux-fluximg-frame", { bubbles: true, detail: { elementId: element.id, ...info, time: performance.now() } }));
    };
    d.onError = (message) => { problem = message; };
    driver = d;
    // Colour maps load lazily; tables built before they arrive are the gray fallback.
    void needLuts().then(() => d.invalidateTables());
    return () => { d.dispose(); if (driver === d) driver = null; };
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
    return p && p.dim === dim ? words : words.replace(new RegExp(`^${dim}\\s+`), "");
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
  const arm = (dim: string): void => setLive({ armed: `pos:${dim}` });

  // Layout around the element's ROTATED screen bounds (rails are never rotated or mirrored).
  const GAP = 12, ROW = 50, CAP = 26, VRAIL = 86;
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
  const hRail = $derived.by(() => {
    const s = span(bounds.x, bounds.x + bounds.w, host.w, CAP + 8, 150);
    const rows = hDims.length, stripH = 20;
    const y = Math.min(bounds.y + bounds.h + GAP, host.h - rows * ROW - stripH - 6);
    return { x: s.start - CAP, y, extent: s.length };
  });
  const vRail = $derived.by(() => {
    const s = span(bounds.y, bounds.y + bounds.h, host.h, 30, 44);
    const x = Math.min(bounds.x + bounds.w + GAP, host.w - VRAIL - 6);
    return { x, y: s.start - 23, extent: s.length };
  });
  const stripPos = $derived({ x: Math.max(8, Math.min(bounds.x, host.w - 320)), y: hRail.y + hDims.length * ROW });

  // The panel keeps clear of the image AND its rails.
  $effect(() => {
    const x0 = Math.min(bounds.x, hDims.length ? hRail.x : bounds.x), y0 = Math.min(bounds.y, vDim ? vRail.y : bounds.y);
    const x1 = Math.max(bounds.x + bounds.w, vDim ? vRail.x + VRAIL : 0, hDims.length ? hRail.x + CAP + hRail.extent + 150 : 0);
    const y1 = Math.max(bounds.y + bounds.h, stripPos.y + 20);
    fluximgLiveRect.set({ x: host.x + x0, y: host.y + y0, w: x1 - x0, h: y1 - y0 });
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
    lastMove = e;
    if (!moveQueued) moveQueued = requestAnimationFrame(readPointer);
  }
  function onDown(e: PointerEvent): void {
    // Middle button and Space+drag pan the canvas, as everywhere else.
    if (e.button === 1 || space) return;
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (live?.zone === "frame" && crop && wrapper) {
      pan = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: { ...crop } };
      wrapper.setPointerCapture(e.pointerId);
    }
  }
  function onUp(e: PointerEvent): void {
    if (!pan || e.pointerId !== pan.pointer) return;
    pan = null;
    if (wrapper?.hasPointerCapture(e.pointerId)) wrapper.releasePointerCapture(e.pointerId);
    settleLiveEdit();
  }
  function onLeave(): void {
    lastMove = null; livePointer.at = null; under = null;
    if ($fluximgHover?.from === "image") fluximgHover.set(null);
  }
  function onKey(e: KeyboardEvent): void { if (e.code === "Space") { space = e.type === "keydown"; if (space) beginPan(); } }

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
  const where = $derived.by(() => {
    if (!under) return "";
    const one = (v: number, a: typeof ax, name: string): string =>
      a && typeof a.scale === "number" && a.unit ? `${name} ${formatNumber(Number(((a.offset ?? 0) + a.scale * v).toPrecision(5)))} ${a.unit}` : `${name} ${Math.floor(v)}`;
    return `${one(under.x, ax, "x")}   ${one(under.y, ay, "y")}`;
  });
  const fmtValue = (v: number): string => (Number.isNaN(v) ? "–" : formatNumber(Number(v.toPrecision(5))));

  const boxStyle = $derived(`left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;transform:rotate(${element.rotation}deg) scale(${element.flipX ? -1 : 1},${element.flipY ? -1 : 1});opacity:${element.opacity ?? 1}`);
  onDestroy(() => { if (moveQueued) cancelAnimationFrame(moveQueued); hot?.classList.remove("fx-hot"); });
</script>

<svelte:window onkeydown={onKey} onkeyup={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={wrapper} class="fx-live" class:framing={live?.zone === "frame"} class:panning={!!pan} style={boxStyle}
  data-fluximg-live={element.id} data-command-scope="fluximg-live" data-level={frame?.level ?? ""} data-sharp={frame?.sharp ? "1" : "0"}
  onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} onlostpointercapture={onUp} onpointerleave={onLeave}>
  <canvas bind:this={canvas} class="gl" class:pixelated={!rv?.smooth} style={`left:${vis.x}px;top:${vis.y}px;width:${vis.w}px;height:${vis.h}px`}></canvas>
  {#if asset && manifest && rv && crop}
    <svg class="vec" width={bw} height={bh} viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio="none">
      <FluximgVectors {asset} {manifest} view={rv} {crop} {box} {prefix} flipX={!!element.flipX} flipY={!!element.flipY} {insets} />
    </svg>
  {/if}
</div>

{#if manifest && rv}
  {#each hDims as dim, i (dim)}
    <div class="fx-railpos" style={`left:${hRail.x}px;top:${hRail.y + i * ROW}px`}>
      <FluximgRail {dim} hotkey={keys[dim] ?? ""} length={dimLength(manifest, dim)} index={rv.index[dim] ?? 0}
        run={rv.projection?.dim === dim ? rv.projection : null} profiles={profilesOf(dim)} axis={manifest.axes?.[dim]} extent={hRail.extent}
        armed={live?.armed === `pos:${dim}` || live?.armed === `run:${dim}`} readout={readoutOf(dim)} unit={manifest.axes?.[dim]?.unit ?? ""} format={formatNumber}
        playing={live?.playing?.dim === dim} onplay={() => togglePlayback(dim)}
        onscrub={(index, phase) => scrub(dim, index, phase)} onrun={(from, to, phase) => runTo(dim, from, to, phase)} onarm={() => arm(dim)} />
    </div>
  {/each}
  {#if vDim}
    <div class="fx-railpos v" style={`left:${vRail.x}px;top:${vRail.y}px`}>
      <FluximgRail dim={vDim} hotkey={keys[vDim] ?? ""} vertical length={dimLength(manifest, vDim)} index={rv.index[vDim] ?? 0}
        run={rv.projection?.dim === vDim ? rv.projection : null} profiles={profilesOf(vDim)} axis={manifest.axes?.[vDim]} extent={vRail.extent}
        armed={live?.armed === `pos:${vDim}` || live?.armed === `run:${vDim}`} readout={readoutOf(vDim)} unit={manifest.axes?.[vDim]?.unit ?? ""} format={formatNumber}
        playing={live?.playing?.dim === vDim} onplay={() => togglePlayback(vDim)}
        onscrub={(index, phase) => scrub(vDim, index, phase)} onrun={(from, to, phase) => runTo(vDim, from, to, phase)} onarm={() => arm(vDim)} />
    </div>
  {/if}
  <div class="fx-strip" style={`left:${stripPos.x}px;top:${stripPos.y}px`} data-fluximg-readout>
    {#if problem}
      <span class="bad">{problem}</span>
    {:else if under}
      <span class="pos">{where}</span>
      {#each shownChannels as c, i (c.index)}
        <span class="val"><i style={`background:${inkOf(c)}`}></i>{c.name} <b>{fmtValue(under.values[i] ?? NaN)}</b></span>
      {/each}
      {#if $fluximgHover}<span class="obj">{$fluximgHover.key}</span>{/if}
    {:else}
      <span class="hint">Hover the image to read position and values</span>
    {/if}
  </div>
{/if}

<style>
  .fx-live { position: absolute; transform-origin: center; touch-action: none; overflow: hidden; outline: none; cursor: var(--cursor-cross); }
  .fx-live.framing { cursor: grab; }
  .fx-live.panning { cursor: grabbing; }
  .gl { position: absolute; display: block; pointer-events: none; }
  /* The drawing buffer is one pixel per screen pixel; if the browser ever rescales it, it must not smooth true pixels. */
  .gl.pixelated { image-rendering: pixelated; }
  .vec { position: absolute; inset: 0; display: block; overflow: hidden; pointer-events: none; }
  /* Objects answer the pointer over their whole interior, drawn or not, so a thin outline is easy to find. */
  .vec :global([data-key]) { pointer-events: all; }
  .vec :global(.fx-hot) { stroke: var(--c-accent-bright) !important; stroke-width: 2px !important; vector-effect: non-scaling-stroke; fill: var(--c-accent-bright) !important; fill-opacity: 0.18 !important; }
  /* Rails and the readout sit on their own surface: behind them is white paper or dark pasteboard, never known. */
  .fx-railpos { position: absolute; z-index: 2; padding: 5px 8px 16px 4px; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); box-shadow: var(--elev-1, 0 1px 3px rgba(0, 0, 0, 0.35)); }
  .fx-railpos.v { padding: 4px 6px 6px 6px; }
  .fx-strip { position: absolute; z-index: 2; display: flex; align-items: center; gap: 14px; height: 22px; max-width: 720px; padding: 0 8px; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); overflow: hidden; white-space: nowrap; font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-2); pointer-events: none; }
  .fx-strip .pos { color: var(--c-tx-hi); }
  .fx-strip .val { display: inline-flex; align-items: center; gap: 5px; }
  .fx-strip .val i { width: 8px; height: 8px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 22%, transparent); box-sizing: border-box; }
  .fx-strip .val b { font-weight: 500; color: var(--c-tx-hi); }
  .fx-strip .obj { color: var(--c-accent-bright); }
  .fx-strip .hint { color: var(--c-tx-muted); }
  .fx-strip .bad { color: var(--c-danger, #d14d41); }
</style>
