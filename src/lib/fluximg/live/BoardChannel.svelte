<script lang="ts">
  /**
   * A channel's strip on the board: its lamp, its name, and its histogram as the contrast control.
   *
   * The histogram is the pixels ON SCREEN, drawn in the channel's own colours between the black and white points
   * (so it changes as you move through the stack), over a faint outline of the whole image's. The two points are
   * the pink handles: drag one, drag between them to slide the window, roll the wheel over the plot to move the
   * nearer one. The paper line across the plot is the transfer curve; pull its dot up or down to bend it (gamma).
   * A tick rides the plot at the value under the pointer on the image.
   *
   * Working a strip with the mouse never takes the channel "in hand" (the wheel over the image keeps stepping
   * planes): only its digit, or a click on its name, does that.
   *
   * Presentational: it reports gestures and draws what it is given; the board owns the model.
   */
  import { evalExpr } from "../../num";
  import type { FluximgHistogram, FluximgStats } from "../types";
  import type { LiveSample } from "./session";
  import PaperKey from "./PaperKey.svelte";
  import { clippedShares, formatShare, histDomain, histogramPath, transferPath, valueToX, viewHistogram, xToValue } from "./histogram";

  type Phase = "start" | "move" | "end" | "cancel";
  type Point = "black" | "white" | "window" | "gamma";
  interface Swatch { label: string; color?: string; lut?: string; css: string }
  let {
    index, name, hotkey = "", stats, range, norm, gamma, invert, table, ink, shown, solo = false, inHand = false, armed = null, sample = null, probe = null,
    probeText = "", ghost = null, integer = false, format, width = 240, wellH = 46, swatches = [], current = "",
    onwindow, ongamma, ontake, ontoggle, onsolo, onauto, onnorm, oncolor, oninvert, onreset,
  }: {
    index: number;
    name: string;
    /** The digit that takes this channel in hand (shown on its lamp). */
    hotkey?: string;
    stats: FluximgStats;
    range: [number, number];
    norm: "linear" | "log" | "gamma";
    gamma: number;
    invert: boolean;
    /** The channel's 256 RGBA entries (what the renderer uses). */
    table: Uint8Array;
    ink: string;
    shown: boolean;
    solo?: boolean;
    inHand?: boolean;
    /** Which of its points the wheel drives while it is in hand. */
    armed?: string | null;
    /** The plane on screen for this channel, or null (hidden, or before the first frame). */
    sample?: LiveSample | null;
    /** The value under the pointer on the image, or null. */
    probe?: number | null;
    probeText?: string;
    /** A window a hovered key would set: drawn as two dashed lines. */
    ghost?: readonly [number, number] | null;
    integer?: boolean;
    format: (v: number) => string;
    width?: number;
    wellH?: number;
    swatches?: Swatch[];
    /** The label of the swatch this channel wears now. */
    current?: string;
    onwindow: (range: [number, number], phase: Phase) => void;
    ongamma: (gamma: number, phase: Phase) => void;
    ontake: (point: Point) => void;
    ontoggle: () => void;
    onsolo: () => void;
    onauto: () => void;
    onnorm: () => void;
    oncolor: (s: Swatch) => void;
    oninvert: () => void;
    onreset: () => void;
  } = $props();

  const uid = `fxc-${Math.random().toString(36).slice(2)}`;
  const PADX = 8;
  const w = $derived(Math.max(40, width - 2 * PADX)), h = $derived(wellH);
  // The control's span is fixed while a handle is dragged: a span that grows under the hand makes it run away.
  let held = $state.raw<{ lo: number; hi: number } | null>(null);
  // The window as two NUMBERS: every view change hands the strip a new `range` array with the same two values in
  // it, and nothing below (the span, the plots' paths, the curve) may be rebuilt for that. A derived number that
  // comes out the same wakes nothing that depends on it.
  const lo = $derived(range[0]), hi = $derived(range[1]);
  const domain = $derived.by(() => held ?? histDomain(stats, [lo, hi]));
  const xb = $derived(Math.min(w, Math.max(0, valueToX(lo, domain, w))));
  const xw = $derived(Math.min(w, Math.max(0, valueToX(hi, domain, w))));

  // --- the two histograms -------------------------------------------------------------------------
  const stack = $derived(histogramPath(stats.hist, domain, w, h));
  // The pixels on screen, binned over the strip's own span. THE PICTURE COMES FIRST: the count (about a millisecond
  // for a 4-megapixel plane) is never done in the frame that draws the image. It waits for the browser's next idle
  // moment, and takes whatever plane is on screen by then, so a fast scrub or a movie costs the picture nothing and
  // the plot follows a beat behind. One count per new plane, frame or span; never one per pointer move.
  let seen = $state.raw<FluximgHistogram | null>(null);
  let memo: { data: ArrayLike<number>; rect: string; lo: number; hi: number; bins: number } | null = null;
  let wanted: { sample: LiveSample; lo: number; hi: number; bins: number } | null = null;
  let waiting = 0;
  const idle: (run: () => void) => number = typeof requestIdleCallback === "function" ? (run) => requestIdleCallback(run, { timeout: 200 }) : (run) => window.setTimeout(run, 0);
  const unidle = (id: number): void => { if (typeof cancelIdleCallback === "function") cancelIdleCallback(id); else clearTimeout(id); };
  function count(): void {
    waiting = 0;
    const w = wanted;
    if (!w) return;
    const s = w.sample, rect = `${s.rect.x},${s.rect.y},${s.rect.width},${s.rect.height}`;
    if (memo && memo.data === s.data && memo.rect === rect && memo.lo === w.lo && memo.hi === w.hi && memo.bins === w.bins) return;
    const m = s.map, nodata = m && m.nodata !== null ? m.nodata : NaN;
    const decode = m ? (v: number): number => (v === nodata || v !== v ? NaN : m.add + m.mul * (v - m.sub)) : (v: number): number => v;
    seen = viewHistogram(s.data, s.width, s.height, s.rect, decode, { lo: w.lo, hi: w.hi }, w.bins);
    memo = { data: s.data, rect, lo: w.lo, hi: w.hi, bins: w.bins };
  }
  $effect(() => {
    const s = sample, lo = domain.lo, hi = domain.hi, bins = Math.min(160, Math.max(32, Math.round(w / 1.5)));
    if (!s) { wanted = null; memo = null; seen = null; return; }
    wanted = { sample: s, lo, hi, bins };
    if (!waiting) waiting = idle(count);
  });
  $effect(() => () => { if (waiting) unidle(waiting); waiting = 0; });
  const front = $derived(seen ? histogramPath(seen, domain, w, h) : "");
  const curve = $derived(transferPath([lo, hi], norm, gamma, domain, w, h));
  /** Twelve stops are plenty for a map drawn 220 px wide. */
  const stops = $derived(Array.from({ length: 13 }, (_, i) => {
    const k = Math.min(255, Math.round((i / 12) * 255)) * 4;
    return { offset: i / 12, color: `rgb(${table[k]},${table[k + 1]},${table[k + 2]})` };
  }));
  const first = $derived(`rgb(${table[0]},${table[1]},${table[2]})`), last = $derived(`rgb(${table[1020]},${table[1021]},${table[1022]})`);
  const clipped = $derived(clippedShares(stats, [lo, hi]));
  const probeX = $derived(probe !== null && Number.isFinite(probe) ? Math.min(w, Math.max(0, valueToX(probe, domain, w))) : null);
  const ghostX = $derived(ghost ? [Math.min(w, Math.max(0, valueToX(ghost[0], domain, w))), Math.min(w, Math.max(0, valueToX(ghost[1], domain, w)))] : null);
  /** The transfer curve's dot: its middle, where pulling bends it most. Not on a log scale (that has no dial). */
  const bend = $derived.by(() => {
    if (norm === "log" || !(xw - xb > 14)) return null;
    const g = norm === "gamma" && gamma > 0 ? gamma : 1;
    return { x: (xb + xw) / 2, y: h - Math.pow(0.5, g) * h };
  });
  /** A lamp's digit must read on its colour. */
  const lampInk = $derived.by(() => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(ink);
    if (!m) return "#100f0f";
    const l = 0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16);
    return l > 120 ? "#100f0f" : "#fffcf0";
  });

  // --- dragging the points ------------------------------------------------------------------------
  let svg = $state<SVGSVGElement>();
  let drag = $state.raw<{ pointer: number; which: Point; x0: number; from: [number, number]; g0: number } | null>(null);
  let over = $state<Point | null>(null);
  const GRAB = 9;
  const local = (e: PointerEvent): { x: number; y: number } => { const r = svg!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h }; };
  function pointAt(x: number, y: number): Point {
    if (bend && Math.hypot(x - bend.x, y - bend.y) <= 8) return "gamma";
    const db = Math.abs(x - xb), dw = Math.abs(x - xw);
    // The nearer handle wins inside its reach; between the handles the window slides; outside, the nearer point jumps.
    return db <= GRAB && db <= dw ? "black" : dw <= GRAB ? "white" : x > xb && x < xw ? "window" : db < dw ? "black" : "white";
  }
  function down(e: PointerEvent): void {
    if (e.button !== 0 || !svg) return;
    e.preventDefault(); e.stopPropagation();
    const p = local(e), which = pointAt(p.x, p.y);
    held = { ...domain };
    drag = { pointer: e.pointerId, which, x0: p.x, from: [range[0], range[1]], g0: norm === "gamma" ? gamma : 1 };
    svg.setPointerCapture(e.pointerId);
    if (which === "gamma") ongamma(gammaAt(p.y), "start"); else onwindow(windowAt(p.x), "start");
  }
  function windowAt(x: number): [number, number] {
    const d = drag!, v = xToValue(x, domain, w), round = (n: number): number => (integer ? Math.round(n) : n);
    if (d.which === "window") { const dv = round(v - xToValue(d.x0, domain, w)); return [d.from[0] + dv, d.from[1] + dv]; }
    return d.which === "black" ? [round(v), d.from[1]] : [d.from[0], round(v)];
  }
  /** The gamma whose curve passes through height `y` at its middle; it snaps back to 1 (a straight line) nearby. */
  function gammaAt(y: number): number {
    const t = Math.min(0.97, Math.max(0.03, 1 - y / h));
    const g = Math.min(5, Math.max(0.1, Math.log(t) / Math.log(0.5)));
    return Math.abs(g - 1) < 0.06 ? 1 : Number(g.toFixed(2));
  }
  function move(e: PointerEvent): void {
    if (!svg) return;
    const p = local(e);
    if (!drag) { over = pointAt(p.x, p.y); return; }
    if (e.pointerId !== drag.pointer) return;
    if (drag.which === "gamma") ongamma(gammaAt(p.y), "move"); else onwindow(windowAt(p.x), "move");
  }
  function finish(e: PointerEvent, phase: "end" | "cancel"): void {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag, p = local(e);
    // Read where the gesture ends BEFORE letting go of it (the span it was read in is the drag's own).
    const g = phase === "end" && d.which === "gamma" ? gammaAt(p.y) : d.g0;
    const range = phase === "end" && d.which !== "gamma" ? windowAt(p.x) : d.from;
    drag = null; held = null;
    if (svg?.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    if (d.which === "gamma") ongamma(g, phase); else onwindow(range, phase);
  }
  const lit = (p: Point): boolean => drag?.which === p || (!drag && (over === p || (inHand && (armed === p || armed === "window" && p !== "gamma"))));
  const cursor = $derived(drag?.which === "window" ? "grabbing" : over === "window" ? "grab" : over === "gamma" || drag?.which === "gamma" ? "ns-resize" : "ew-resize");

  // --- typing a point's value ---------------------------------------------------------------------
  let editing = $state<null | { which: "black" | "white"; text: string }>(null);
  function commit(): void {
    const e = editing;
    editing = null;
    if (!e) return;
    const v = evalExpr(e.text);
    if (v === null || !Number.isFinite(v)) return;
    onwindow(e.which === "black" ? [v, Math.max(range[1], v + (integer ? 1 : 1e-9))] : [Math.min(range[0], v - (integer ? 1 : 1e-9)), v], "end");
  }
  const focusNow = (node: HTMLInputElement): void => { node.focus(); node.select(); };

  let drawer = $state(false);
  let hovered = $state(false);
  const busy = $derived(hovered || inHand || !!drag || drawer);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="strip" class:off={!shown} class:hand={inHand} class:busy style={`width:${width}px;--ink:${ink}`} data-fxb-channel={index} data-fxb-wheel={`chan:${index}`}
  onpointerenter={() => (hovered = true)} onpointerleave={() => { hovered = false; over = null; }}>
  <div class="top">
    <button class="lamp" class:solo type="button" style={`color:${lampInk}`} aria-label={shown ? `Hide ${name}` : `Show ${name}`} aria-pressed={shown}
      data-tip={shown ? "Hide · alt-click: only this one" : "Show"} data-hk={hotkey ? `⇧${hotkey}` : undefined}
      onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); if (e.altKey) onsolo(); else ontoggle(); }}>{hotkey}</button>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <span class="name" onclick={() => ontake("white")} data-tip="Take in hand" data-hk={hotkey || undefined}>{name}</span>
    <span class="keys">
      <PaperKey quiet size={20} glyph="auto" label="Auto contrast" hotkey={inHand ? "A" : ""} onpress={onauto} />
      <PaperKey quiet size={20} glyph={norm} label={norm === "linear" ? "Linear · click for log" : norm === "log" ? "Log · click for gamma" : "Gamma · click for linear"} on={norm !== "linear"} onpress={onnorm} />
      <PaperKey quiet size={20} glyph="color" label="Colour" on={drawer} onpress={() => (drawer = !drawer)} />
      <PaperKey quiet size={20} glyph="solo" label="Only this channel" hotkey={hotkey ? `⌥${hotkey}` : ""} on={solo} onpress={onsolo} />
    </span>
    <span class="range" class:lo={lit("black")} class:hi={lit("white")}>
      {#if editing}
        <input class="num in" type="text" inputmode="decimal" spellcheck="false" bind:value={editing.text} use:focusNow
          onpointerdown={(e) => e.stopPropagation()} onblur={commit}
          onkeydown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.preventDefault(); editing = null; } }} />
      {:else}
        <button class="num b" type="button" data-tip="Black point · click to type" onpointerdown={(e) => e.stopPropagation()} onclick={() => (editing = { which: "black", text: format(range[0]) })}>{format(range[0])}</button>
        <i></i>
        <button class="num w" type="button" data-tip="White point · click to type" onpointerdown={(e) => e.stopPropagation()} onclick={() => (editing = { which: "white", text: format(range[1]) })}>{format(range[1])}</button>
      {/if}
    </span>
  </div>

  <div class="wellbox" style={`width:${w}px;height:${h}px`}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg bind:this={svg} class="well" width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={`cursor:${cursor}`} data-fxb-well data-b={(xb / w).toFixed(4)} data-w={(xw / w).toFixed(4)}
      onpointerdown={down} onpointermove={move} onpointerup={(e) => finish(e, "end")} onpointercancel={(e) => finish(e, "cancel")} onlostpointercapture={(e) => finish(e, "cancel")}
      ondblclick={(e) => { e.stopPropagation(); onauto(); }}>
      <defs>
        <!-- The colour map laid from the black point to the white point: the fill IS the mapping. -->
        <linearGradient id={`${uid}-map`} gradientUnits="userSpaceOnUse" x1={xb} y1="0" x2={Math.max(xw, xb + 0.01)} y2="0">
          {#each stops as s (s.offset)}<stop offset={s.offset} stop-color={s.color} />{/each}
        </linearGradient>
        <clipPath id={`${uid}-in`}><rect x={xb} y="0" width={Math.max(0, xw - xb)} height={h} /></clipPath>
        <clipPath id={`${uid}-lo`}><rect x="0" y="0" width={xb} height={h} /></clipPath>
        <clipPath id={`${uid}-hi`}><rect x={xw} y="0" width={Math.max(0, w - xw)} height={h} /></clipPath>
      </defs>
      <!-- Below the window everything is the map's first colour, above it the last: flat tints of those. -->
      <rect class="clip" x="0" y="0" width={xb} height={h} style={`fill:${first}`} />
      <rect class="clip" x={xw} y="0" width={Math.max(0, w - xw)} height={h} style={`fill:${last}`} />
      {#if stack}<path class="stack" class:alone={!front} d={stack} />{/if}
      {#if front || stack}
        {@const d = front || stack}
        <path class="out" d={d} clip-path={`url(#${uid}-lo)`} />
        <path class="out" d={d} clip-path={`url(#${uid}-hi)`} />
        <path class="in" d={d} fill={`url(#${uid}-map)`} clip-path={`url(#${uid}-in)`} />
        <path class="edge" d={d} />
      {/if}
      {#if curve && (busy || norm !== "linear")}<path class="curve" d={curve} />{/if}
      {#if clipped && busy}
        {#if xb > 44}<text class="share" x="4" y={h - 4}>{formatShare(clipped.black)}</text>{/if}
        {#if w - xw > 44}<text class="share" x={w - 4} y={h - 4} text-anchor="end">{formatShare(clipped.white)}</text>{/if}
      {/if}
      {#if ghostX}
        <line class="ghost" x1={ghostX[0]} y1="0" x2={ghostX[0]} y2={h} /><line class="ghost" x1={ghostX[1]} y1="0" x2={ghostX[1]} y2={h} />
      {/if}
      <line class="pt" class:lit={lit("black")} x1={xb} y1="0" x2={xb} y2={h} />
      <line class="pt" class:lit={lit("white")} x1={xw} y1="0" x2={xw} y2={h} />
      {#if bend && (busy || norm === "gamma")}<circle class="bend" class:lit={lit("gamma")} cx={bend.x} cy={bend.y} r={lit("gamma") ? 4.5 : 3.5} />{/if}
      {#if probeX !== null}<path class="probe" d={`M${probeX} 0V${h}M${probeX - 3.5} 0h7`} />{/if}
    </svg>
    <!-- The knobs hang on the plot's foot, half over its edge, so they never hide the histogram. -->
    <span class="knob" class:lit={lit("black")} class:held={drag?.which === "black" || drag?.which === "window"} style={`left:${xb}px`} data-fxb-knob="black"></span>
    <span class="knob" class:lit={lit("white")} class:held={drag?.which === "white" || drag?.which === "window"} style={`left:${xw}px`} data-fxb-knob="white"></span>
    {#if probeX !== null && probeText}<span class="probeval" class:flip={probeX > w - 54} style={`left:${probeX}px`}>{probeText}</span>{/if}
  </div>

  {#if drawer}
    <div class="drawer" role="listbox" aria-label={`Colour of ${name}`}>
      {#each swatches as s (s.label)}
        <button class="sw" class:cur={s.label === current} type="button" role="option" aria-selected={s.label === current} aria-label={s.label} data-tip={s.label} style={`background:${s.css}`}
          onpointerdown={(e) => e.stopPropagation()} onclick={() => { oncolor(s); }}></button>
      {/each}
      <span class="gap"></span>
      <PaperKey quiet size={20} glyph="invert" label="Invert" on={invert} onpress={oninvert} />
      <PaperKey quiet size={20} glyph="reset" label="Back to how the image came" onpress={() => { onreset(); drawer = false; }} />
    </div>
  {/if}
</div>

<style>
  .strip { position: relative; box-sizing: border-box; padding: 5px 8px 9px; border-radius: 8px; background: var(--fxb-card); border: 1px solid var(--fxb-line); box-shadow: var(--fxb-lift); user-select: none; transition: border-color 90ms linear, background-color 90ms linear, opacity 120ms linear; }
  .strip.hand { border-color: color-mix(in oklab, var(--fxb-pink) 70%, transparent); background: color-mix(in oklab, var(--fxb-pink) 5%, var(--fxb-card)); }
  .strip.off { opacity: 0.5; }
  .strip.off.busy { opacity: 0.85; }
  .top { display: flex; align-items: center; gap: 6px; height: 22px; margin-bottom: 3px; min-width: 0; }
  /* The lamp: the channel's colour, its digit, and its switch. Off: a ring. */
  .lamp { flex: none; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 0; background: var(--ink); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 7px -1px var(--ink); font: 700 9.5px/16px var(--font-mono); text-align: center; cursor: var(--cursor-cross-hover); transition: background-color 90ms linear, box-shadow 90ms linear; }
  .strip.off .lamp { background: transparent; box-shadow: inset 0 0 0 1.5px var(--ink); color: var(--ink) !important; }
  .lamp.solo { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2.5px var(--fxb-pink); }
  .lamp:hover { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2.5px color-mix(in oklab, var(--ink) 55%, transparent); }
  .name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px var(--font-ui); color: var(--fxb-tx-hi); cursor: var(--cursor-cross-hover); letter-spacing: 0.005em; }
  /* The strip's own keys take their place only while the strip is wanted, so a long name is not cut short at rest. */
  .keys { display: none; gap: 1px; margin-left: auto; }
  .strip.busy .keys { display: flex; animation: fxc-keys 110ms linear backwards; }
  @keyframes fxc-keys { from { opacity: 0; } to { opacity: 1; } }
  .range { flex: none; display: inline-flex; align-items: center; gap: 3px; font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx-dim); }
  .strip:not(.busy) .range { margin-left: auto; }
  .strip.busy .keys + .range { margin-left: 2px; }
  .range i { width: 6px; height: 1px; background: currentColor; opacity: 0.6; }
  .num { padding: 1px 2px; margin: 0; border: 0; border-radius: 3px; background: none; color: var(--fxb-tx); font: inherit; cursor: var(--cursor-cross-hover); }
  .num:hover { background: rgba(255, 252, 240, 0.09); color: var(--fxb-tx-hi); }
  .range.lo .num.b, .range.hi .num.w { color: var(--fxb-pink-hi); }
  .num.in { width: 74px; height: 16px; box-sizing: border-box; background: #000; color: var(--fxb-tx-hi); outline: 1px solid var(--fxb-pink); text-align: right; cursor: text; }
  .wellbox { position: relative; }
  .well { display: block; border-radius: 4px; background: var(--fxb-well); box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.07); touch-action: none; overflow: hidden; }
  .clip { opacity: 0.2; pointer-events: none; }
  .stack { fill: rgba(255, 252, 240, 0.09); pointer-events: none; }
  .stack.alone { fill: none; }
  .out { fill: #6f6e69; opacity: 0.55; pointer-events: none; }
  .in { pointer-events: none; }
  .edge { fill: none; stroke: var(--ink); stroke-width: 1; stroke-opacity: 0.75; stroke-linejoin: round; pointer-events: none; }
  .strip.off .in { opacity: 0.3; }
  .strip.off .edge { stroke: #878580; }
  .curve { fill: none; stroke: var(--fxb-paper); stroke-width: 1; opacity: 0.5; pointer-events: none; }
  .share { fill: var(--fxb-tx-dim); font: 9px var(--font-mono); pointer-events: none; }
  .ghost { stroke: var(--fxb-pink); stroke-width: 1; stroke-dasharray: 3 2; opacity: 0.9; pointer-events: none; }
  .pt { stroke: var(--fxb-pink); stroke-width: 1.25; pointer-events: none; }
  .pt.lit { stroke: var(--fxb-pink-hi); stroke-width: 2; }
  .bend { fill: var(--fxb-paper); stroke: var(--fxb-pink); stroke-width: 1.5; pointer-events: none; }
  .bend.lit { fill: var(--fxb-pink); stroke: var(--fxb-paper); }
  .probe { fill: none; stroke: var(--fxb-paper); stroke-width: 1; opacity: 0.85; pointer-events: none; }
  /* A knob: paper with the pink of Flux's guides round it. In the hand it fills, grows and wears a halo. */
  .knob { position: absolute; top: 100%; width: 10px; height: 10px; margin: -5px 0 0 -5px; box-sizing: border-box; border-radius: 50%; background: var(--fxb-paper); border: 2px solid var(--fxb-pink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); pointer-events: none; transition: width 70ms linear, height 70ms linear, margin 70ms linear, background-color 70ms linear, box-shadow 70ms linear; }
  .knob.lit { width: 12px; height: 12px; margin: -6px 0 0 -6px; background: var(--fxb-pink); border-color: var(--fxb-paper); }
  .knob.held { box-shadow: 0 0 0 4px color-mix(in oklab, var(--fxb-pink) 32%, transparent), 0 1px 2px rgba(0, 0, 0, 0.6); }
  .probeval { position: absolute; top: 2px; margin-left: 5px; padding: 0 3px; border-radius: 3px; background: rgba(0, 0, 0, 0.72); color: var(--fxb-paper); font: 600 9.5px/13px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }
  .probeval.flip { margin-left: 0; transform: translateX(calc(-100% - 5px)); }
  .drawer { display: flex; align-items: center; gap: 5px; margin-top: 11px; padding-top: 7px; border-top: 1px solid var(--fxb-line); }
  .sw { flex: none; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid rgba(255, 252, 240, 0.28); cursor: var(--cursor-cross-hover); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); transition: transform 70ms linear, box-shadow 70ms linear; }
  .sw:hover { transform: scale(1.18); }
  .sw.cur { box-shadow: 0 0 0 2px var(--fxb-card), 0 0 0 3.5px var(--fxb-pink); }
  .gap { flex: 1; }
  @media (prefers-reduced-motion: reduce) { .sw, .knob { transition: none; } .sw:hover { transform: none; } }
</style>
