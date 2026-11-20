<script lang="ts">
  /**
   * The frame zone's navigator: the whole image, small, with the frame drawn on it. It answers "where am I?"
   * once the frame is zoomed in, and it is a handle: drag the frame's rectangle (or press anywhere on the map) to
   * move the frame there.
   *
   * The picture is a still of the whole image in the view on screen (same plane, same contrast), drawn by the one
   * still function; panning and zooming the frame never ask for a new one. Presentational apart from that request:
   * it reports where the frame should go, and the panel owns the model.
   */
  import type { Asset } from "../../types";
  import { fluximgBundle, fluximgIdentity, fluximgService } from "../store";
  import { fullCrop } from "../still";
  import type { FluximgManifest } from "../types";
  import type { FluximgView, PixelRect, ResolvedView } from "../view";
  import { pixelKey } from "../viewOps";
  import { fluximgLiveBusy } from "./session";

  type Phase = "start" | "move" | "end" | "cancel";
  let { asset, manifest, view, resolved, crop, insets = [], maxWidth = 276, maxHeight = 150, onmove }: {
    asset: Asset;
    manifest: FluximgManifest;
    /** The element's stored view (what the still function takes) and the same view resolved (what keys it). */
    view: FluximgView | undefined;
    resolved: ResolvedView;
    /** The frame, in image pixels. */
    crop: PixelRect;
    /** Regions already pulled out as insets, in image pixels. */
    insets?: ReadonlyArray<{ id: string; crop: PixelRect }>;
    maxWidth?: number;
    maxHeight?: number;
    /** The frame's new top-left corner in image pixels (the caller clamps it into the image). */
    onmove: (x: number, y: number, from: PixelRect, phase: Phase) => void;
  } = $props();

  const full = $derived(fullCrop(manifest));
  const size = $derived.by(() => {
    const k = Math.min(maxWidth / full.width, maxHeight / full.height);
    return { w: Math.max(8, Math.round(full.width * k)), h: Math.max(8, Math.round(full.height * k)) };
  });
  const whole = $derived(crop.width >= full.width - 1e-6 && crop.height >= full.height - 1e-6);
  const box = $derived({ x: (crop.x / full.width) * size.w, y: (crop.y / full.height) * size.h, w: (crop.width / full.width) * size.w, h: (crop.height / full.height) * size.h });

  // --- the picture --------------------------------------------------------------------------------
  // Drawn for the device's pixels (at most 2x). While a live gesture streams, the request waits: the workers
  // serve the image under the hand first, and the map catches up when it settles.
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const out = $derived({ w: Math.round(size.w * dpr), h: Math.round(size.h * dpr) });
  const key = $derived(`${fluximgIdentity(asset)}|${pixelKey(manifest, resolved, full, out.w, out.h)}`);
  let shown = $state<{ key: string; href: string } | null>(null);
  $effect(() => {
    const wanted = key;
    if (shown?.key === wanted || $fluximgLiveBusy) return;
    let stale = false;
    fluximgService().still(wanted, { bundle: fluximgBundle(asset), view: view ? $state.snapshot(view) as FluximgView : null, crop: full, outWidth: out.w, outHeight: out.h, slot: "live-navigator" })
      .then((href) => { if (!stale) shown = { key: wanted, href }; }, () => { /* cancelled by a newer request, or unreadable: the last picture stays */ });
    return () => { stale = true; };
  });

  // --- moving the frame ---------------------------------------------------------------------------
  let el = $state<HTMLDivElement>();
  let drag = $state.raw<{ pointer: number; from: PixelRect; dx: number; dy: number } | null>(null);
  /** A client point as image pixels. */
  function at(e: PointerEvent): { x: number; y: number } {
    const r = el!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * full.width, y: ((e.clientY - r.top) / r.height) * full.height };
  }
  function down(e: PointerEvent): void {
    if (e.button !== 0 || !el || whole) return;
    e.preventDefault(); e.stopPropagation();
    const p = at(e), from = { ...crop };
    // On the frame's rectangle: it keeps its place under the hand. Anywhere else: its centre comes to the pointer.
    const inside = p.x >= crop.x && p.x <= crop.x + crop.width && p.y >= crop.y && p.y <= crop.y + crop.height;
    drag = { pointer: e.pointerId, from, dx: inside ? p.x - crop.x : crop.width / 2, dy: inside ? p.y - crop.y : crop.height / 2 };
    el.setPointerCapture(e.pointerId);
    onmove(p.x - drag.dx, p.y - drag.dy, from, "start");
  }
  function move(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointer) return;
    const p = at(e);
    onmove(p.x - drag.dx, p.y - drag.dy, drag.from, "move");
  }
  function finish(e: PointerEvent, phase: "end" | "cancel"): void {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag, p = at(e);
    drag = null;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    onmove(phase === "end" ? p.x - d.dx : d.from.x, phase === "end" ? p.y - d.dy : d.from.y, d.from, phase);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="nav" class:whole class:dragging={!!drag} bind:this={el} style={`width:${size.w}px;height:${size.h}px`} data-fluximg-navigator
  onpointerdown={down} onpointermove={move} onpointerup={(e) => finish(e, "end")} onpointercancel={(e) => finish(e, "cancel")} onlostpointercapture={(e) => finish(e, "cancel")}>
  {#if shown}<img src={shown.href} alt="" width={size.w} height={size.h} draggable="false" />{/if}
  <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
    {#if !whole}
      <!-- Everything outside the frame is dimmed: one path, the map with the frame cut out of it. -->
      <path class="out" fill-rule="evenodd" d={`M0 0H${size.w}V${size.h}H0ZM${box.x} ${box.y}V${box.y + box.h}H${box.x + box.w}V${box.y}Z`} />
    {/if}
    {#each insets as i (i.id)}
      <rect class="inset" x={(i.crop.x / full.width) * size.w} y={(i.crop.y / full.height) * size.h} width={(i.crop.width / full.width) * size.w} height={(i.crop.height / full.height) * size.h} />
    {/each}
    {#if !whole}<rect class="frame" x={box.x + 0.5} y={box.y + 0.5} width={Math.max(1, box.w - 1)} height={Math.max(1, box.h - 1)} />{/if}
  </svg>
</div>

<style>
  .nav { position: relative; margin: 0 auto 8px; background: #070707; box-shadow: 0 0 0 1px rgba(255, 252, 240, 0.1); border-radius: 4px; overflow: hidden; user-select: none; touch-action: none; cursor: grab; }
  .nav.whole { cursor: var(--cursor-cross); }
  .nav.dragging { cursor: grabbing; }
  .nav img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
  .nav svg { position: absolute; inset: 0; display: block; pointer-events: none; }
  .out { fill: #000; opacity: 0.55; }
  .frame { fill: color-mix(in oklab, var(--c-guide) 10%, transparent); stroke: var(--c-guide); stroke-width: 1.25; }
  .nav.dragging .frame { stroke-width: 2; }
  .inset { fill: none; stroke: #fff; stroke-width: 1; stroke-dasharray: 3 2; opacity: 0.85; }
</style>
