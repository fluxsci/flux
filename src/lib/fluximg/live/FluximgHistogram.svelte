<script lang="ts">
  /**
   * A channel's contrast control: its histogram, filled with its own colour map between the black and white
   * points, with those two points as handles and the transfer curve drawn over it.
   *
   * What you see is the mapping: values left of the black handle show as the map's first colour, values right of
   * the white handle as its last, and the band between is stretched across the map. Drag a handle to move a
   * point, drag the band to slide the window. Presentational: it reports gestures; the panel owns the model.
   */
  import type { FluximgStats } from "../types";
  import { histDomain, histogramPath, transferPath, valueToX, xToValue } from "./histogram";

  type Phase = "start" | "move" | "end" | "cancel";
  let {
    stats, range, norm, gamma, table, width = 420, height = 118, armed = null, integer = false, format, onwindow, onarm,
  }: {
    stats: FluximgStats;
    /** Black point, white point (values). */
    range: [number, number];
    norm: "linear" | "log" | "gamma";
    gamma: number;
    /** The channel's 256 RGBA entries (what the renderer uses). */
    table: Uint8Array;
    width?: number;
    height?: number;
    /** Which handle the wheel drives: "black", "white", "window", or null. */
    armed?: string | null;
    integer?: boolean;
    format: (v: number) => string;
    onwindow: (range: [number, number], phase: Phase) => void;
    onarm: (which: "black" | "white" | "window") => void;
  } = $props();

  const uid = `fxh-${Math.random().toString(36).slice(2)}`;
  // The control's span is fixed while a handle is dragged: a domain that grows under the hand makes it run away.
  let held = $state.raw<{ lo: number; hi: number } | null>(null);
  const domain = $derived(held ?? histDomain(stats, range));
  const area = $derived(histogramPath(stats.hist, domain, width, height));
  const curve = $derived(transferPath(range, norm, gamma, domain, width, height));
  const xb = $derived(Math.min(width, Math.max(0, valueToX(range[0], domain, width))));
  const xw = $derived(Math.min(width, Math.max(0, valueToX(range[1], domain, width))));
  /** Sixteen stops are plenty for a map drawn 400 px wide, and keep the DOM small. */
  const stops = $derived(Array.from({ length: 17 }, (_, i) => {
    const k = Math.min(255, Math.round((i / 16) * 255)) * 4;
    return { offset: i / 16, color: `rgb(${table[k]},${table[k + 1]},${table[k + 2]})` };
  }));
  const first = $derived(`rgb(${table[0]},${table[1]},${table[2]})`), last = $derived(`rgb(${table[1020]},${table[1021]},${table[1022]})`);

  let svg = $state<SVGSVGElement>();
  let drag = $state.raw<{ pointer: number; which: "black" | "white" | "window"; x0: number; from: [number, number] } | null>(null);
  const GRAB = 9;
  function px(e: PointerEvent): number { const r = svg!.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * width; }
  function down(e: PointerEvent) {
    if (e.button !== 0 || !svg) return;
    e.preventDefault(); e.stopPropagation();
    const x = px(e);
    // The nearer handle wins inside its grab zone; between the handles the window slides; outside, the nearer point jumps.
    const db = Math.abs(x - xb), dw = Math.abs(x - xw);
    const which = db <= GRAB && db <= dw ? "black" : dw <= GRAB ? "white" : x > xb && x < xw ? "window" : db < dw ? "black" : "white";
    held = { ...domain };
    drag = { pointer: e.pointerId, which, x0: x, from: [range[0], range[1]] };
    svg.setPointerCapture(e.pointerId);
    onarm(which);
    onwindow(apply(x), "start");
  }
  function apply(x: number): [number, number] {
    const d = drag!, v = xToValue(x, domain, width), round = (n: number): number => (integer ? Math.round(n) : n);
    if (d.which === "window") { const dv = round(v - xToValue(d.x0, domain, width)); return [d.from[0] + dv, d.from[1] + dv]; }
    // A press away from a handle moves that handle to the pointer (a jump), then follows it.
    return d.which === "black" ? [round(v), d.from[1]] : [d.from[0], round(v)];
  }
  function move(e: PointerEvent) { if (drag && e.pointerId === drag.pointer) onwindow(apply(px(e)), "move"); }
  function finish(e: PointerEvent, phase: "end" | "cancel") {
    if (!drag || e.pointerId !== drag.pointer) return;
    const result = phase === "end" ? apply(px(e)) : drag.from;
    drag = null; held = null;
    if (svg?.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    onwindow(result, phase);
  }
</script>

<div class="hist" style={`width:${width}px`}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <svg bind:this={svg} class="plot" class:dragging={!!drag} {width} {height} viewBox={`0 0 ${width} ${height}`}
    onpointerdown={down} onpointermove={move} onpointerup={(e) => finish(e, "end")} onpointercancel={(e) => finish(e, "cancel")} onlostpointercapture={(e) => finish(e, "cancel")}>
    <defs>
      <!-- The colour map laid from the black point to the white point: the fill IS the mapping. -->
      <linearGradient id={`${uid}-map`} gradientUnits="userSpaceOnUse" x1={xb} y1="0" x2={Math.max(xw, xb + 0.01)} y2="0">
        {#each stops as s (s.offset)}<stop offset={s.offset} stop-color={s.color} />{/each}
      </linearGradient>
      <clipPath id={`${uid}-in`}><rect x={xb} y="0" width={Math.max(0, xw - xb)} height={height} /></clipPath>
      <clipPath id={`${uid}-lo`}><rect x="0" y="0" width={xb} height={height} /></clipPath>
      <clipPath id={`${uid}-hi`}><rect x={xw} y="0" width={Math.max(0, width - xw)} height={height} /></clipPath>
    </defs>
    <!-- Below the window everything is the map's first colour, above it the last: shown as flat tints of those. -->
    <rect class="clip lo" x="0" y="0" width={xb} height={height} style={`--k:${first}`} />
    <rect class="clip hi" x={xw} y="0" width={Math.max(0, width - xw)} height={height} style={`--k:${last}`} />
    {#if area}
      <path class="area out" d={area} clip-path={`url(#${uid}-lo)`} />
      <path class="area out" d={area} clip-path={`url(#${uid}-hi)`} />
      <path class="area in" d={area} fill={`url(#${uid}-map)`} clip-path={`url(#${uid}-in)`} />
      <path class="edge" d={area} />
    {:else}
      <text class="none" x={width / 2} y={height / 2 + 4} text-anchor="middle">No histogram in this image</text>
    {/if}
    {#if curve}<path class="curve" d={curve} />{/if}
    <line class="point" class:armed={armed === "black" || armed === "window"} x1={xb} y1="0" x2={xb} y2={height} />
    <line class="point" class:armed={armed === "white" || armed === "window"} x1={xw} y1="0" x2={xw} y2={height} />
  </svg>
  <!-- Handles hang below the plot so they never cover the histogram's foot. -->
  <div class="handles" aria-hidden="true">
    <span class="mark" class:armed={armed === "black" || armed === "window"} style={`left:${xb}px;background:${first}`}></span>
    <span class="mark" class:armed={armed === "white" || armed === "window"} style={`left:${xw}px;background:${last}`}></span>
  </div>
  <div class="scale" aria-hidden="true">
    <span>{format(domain.lo)}</span>
    <span class="mid">{norm === "log" ? "log" : norm === "gamma" && gamma !== 1 ? `γ ${format(gamma)}` : ""}</span>
    <span>{format(domain.hi)}</span>
  </div>
</div>

<style>
  .hist { position: relative; user-select: none; }
  .plot { display: block; background: var(--c-bg); outline: 1px solid var(--c-line-strong); border-radius: var(--r-ui); cursor: ew-resize; touch-action: none; }
  .clip { fill: var(--k); opacity: 0.16; }
  .area.out { fill: var(--c-tx-faint); opacity: 0.55; }
  .area.in { opacity: 0.95; }
  .edge { fill: none; stroke: var(--c-tx-muted); stroke-width: 0.75; opacity: 0.7; vector-effect: non-scaling-stroke; }
  .curve { fill: none; stroke: var(--c-tx-hi); stroke-width: 1; opacity: 0.55; vector-effect: non-scaling-stroke; pointer-events: none; }
  .point { stroke: var(--c-tx-hi); stroke-width: 1; pointer-events: none; }
  .point.armed { stroke: var(--c-accent-bright); stroke-width: 1.5; }
  .none { fill: var(--c-tx-muted); font: 11px var(--font-ui); }
  .handles { position: relative; height: 10px; }
  /* The colour picker's handle idiom: a filled circle, white rim, dark hairline ring. */
  .mark { position: absolute; top: -4px; width: 12px; height: 12px; box-sizing: border-box; transform: translateX(-50%); border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55); pointer-events: none; }
  .mark.armed { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 0 3px var(--c-accent); }
  .scale { display: flex; justify-content: space-between; padding-top: 2px; font: 9.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-muted); }
  .scale .mid { color: var(--c-tx-2); }
</style>
