<script lang="ts">
  /**
   * A rail: one dimension of the stack as an instrument you read and grab. Depth stands at the image's side like
   * a y axis, time lies under it like an x axis.
   *
   * Its well is a plot of the stack itself (each shown channel's mean signal per plane), so you see where to go
   * before you go there. The pink line is the plane on screen, a dot rides each channel's trace on it, and a paper
   * flag beside it says where that is. Drag to scrub; Shift-drag draws a run (a projection), which then has grips.
   * The round key plays, the dial under it is the speed, and the far key lays the planes onto one.
   *
   * Presentational: it reports gestures and draws what it is given. The board owns the model.
   */
  import type { FluximgAxis } from "../types";
  import PaperKey from "./PaperKey.svelte";
  import { axisValue, profileLevel, profileShape, railIndex, railPos, railSpan, railTicks } from "./rail";

  type Phase = "start" | "move" | "end" | "cancel";
  let {
    dim, hotkey, label, length, index, run = null, mode = null, profiles = [], axis = undefined, vertical = false, side = "left", w, h, armed = false,
    unit = "", format = (v: number) => String(v), playing = false, speed = 1, choosing = false, modes = [], choice = 0,
    onscrub, onrun, onarm, ontake, onplay = undefined, onspeed = undefined, onproject, onmode,
  }: {
    dim: string;
    /** The key that takes this rail in hand (shown as its name). */
    hotkey: string;
    /** "Depth", "Time": for the labels. */
    label: string;
    length: number;
    index: number;
    /** A projection's run of planes, `from` inclusive, `to` exclusive. */
    run?: { from: number; to: number } | null;
    /** The projection's statistic while a run is shown ("max", "mean"…). */
    mode?: string | null;
    profiles?: Array<{ color: string; values: ReadonlyArray<number | null> }>;
    axis?: FluximgAxis | undefined;
    vertical?: boolean;
    /** A vertical rail's side of the image: its well faces the image, its scale faces away. */
    side?: "left" | "right";
    /** The rail's box (px). */
    w: number;
    h: number;
    armed?: boolean;
    unit?: string;
    format?: (v: number) => string;
    playing?: boolean;
    /** Playback speed as a multiple of the dimension's own rate. */
    speed?: number;
    /** The projection chooser is open on this rail. */
    choosing?: boolean;
    modes?: ReadonlyArray<{ label: string; on: boolean }>;
    /** The chooser's cursor (keyboard). */
    choice?: number;
    onscrub: (index: number, phase: Phase) => void;
    onrun: (from: number, to: number, phase: Phase) => void;
    /** A gesture on the rail began: the wheel over the image follows this rail from now on. */
    onarm: () => void;
    /** The rail's own key was pressed: it is taken in hand (the wheel anywhere moves it). */
    ontake: () => void;
    /** Present when the dimension can be played. */
    onplay?: (() => void) | undefined;
    onspeed?: ((by: number) => void) | undefined;
    /** The projection key. */
    onproject: () => void;
    onmode: (i: number) => void;
  } = $props();

  // --- geometry: the well inside the rail's box ---------------------------------------------------
  const ACROSS_H = 42, ACROSS_V = 36, EDGE = 6;
  const across = $derived(vertical ? ACROSS_V : ACROSS_H);
  /** The well's box, and the lane beside it where the scale and the flag are. */
  const well = $derived(vertical
    ? { x: side === "left" ? w - 7 - ACROSS_V : 7, y: 38, w: ACROSS_V, h: Math.max(40, h - 38 - 36) }
    : { x: 46, y: 8, w: Math.max(40, w - 46 - 38), h: ACROSS_H });
  const extent = $derived(vertical ? well.h : well.w);
  const lane = $derived(vertical
    ? (side === "left" ? { x: 4, w: well.x - 4 - 5 } : { x: well.x + well.w + 5, w: w - (well.x + well.w + 5) - 4 })
    : { x: well.x, w: well.w });

  const shapes = $derived(profiles.map((p) => ({ color: p.color, ...profileShape(p.values, extent, across, vertical) })));
  const head = $derived(railPos(index, length, extent));
  const band = $derived(run ? railSpan(run.from, run.to, length, extent) : null);
  const ticks = $derived(railTicks(axis, length, extent, format, vertical ? 30 : 58));
  /** What the scale's numbers are: the axis' unit, or nothing when they are plane numbers or names. */
  const scaleUnit = $derived(axis && !axis.labels && (typeof axis.scale === "number" || axis.coords) ? unit : "");
  const dots = $derived(run ? [] : profiles.map((p) => ({ color: p.color, level: profileLevel(p.values, index, across, vertical) })).filter((d): d is { color: string; level: number } => d.level !== null));

  /** A plane in the flag's words: its number, and where that is. */
  function words(i: number): { n: string; at: string } {
    const v = axisValue(axis, i);
    const at = axis?.labels?.[i] ?? (v !== null ? `${format(Number(v.toPrecision(5))).replace("-", "−")}${unit ? ` ${unit}` : ""}` : "");
    return { n: String(i + 1), at };
  }
  const here = $derived.by(() => {
    if (run) {
      const a = axisValue(axis, run.from), b = axisValue(axis, run.to - 1);
      const span = a !== null && b !== null ? `${format(Number(a.toPrecision(5))).replace("-", "−")} – ${format(Number(b.toPrecision(5))).replace("-", "−")}${unit ? ` ${unit}` : ""}` : "";
      return { n: run.to - run.from === 1 ? String(run.from + 1) : `${run.from + 1}–${run.to}`, at: vertical ? "" : span, tag: mode ?? "" };
    }
    return { ...words(index), tag: "" };
  });
  /** Where the flag stands along the rail: on the playhead, or on the middle of a run. */
  const flagAt = $derived(band ? (band.start + band.end) / 2 : head);

  let hover = $state<number | null>(null);
  /** The plane under the pointer and what a click there would show. */
  const hoverAt = $derived.by(() => {
    if (hover === null || drag) return null;
    const i = railIndex(hover, length, extent);
    return { index: i, pos: railPos(i, length, extent), ...words(i) };
  });

  // --- gestures -----------------------------------------------------------------------------------
  let track = $state<SVGSVGElement>();
  type Drag = { pointer: number; kind: "scrub" | "draw" | "slide" | "from" | "to"; origin: number; from: number; to: number };
  let drag = $state<Drag | null>(null);
  function along(e: PointerEvent): number {
    const r = track!.getBoundingClientRect();
    return vertical ? e.clientY - r.top : e.clientX - r.left;
  }
  const at = (e: PointerEvent): number => railIndex(along(e), length, extent);
  function down(e: PointerEvent): void {
    if (e.button !== 0 || !track) return;
    e.preventDefault(); e.stopPropagation();
    onarm();
    const pos = along(e), i = at(e);
    track.setPointerCapture(e.pointerId);
    if (band && run) {
      // An edge moves that edge; inside slides the run; outside draws a new one from here.
      const kind = Math.abs(pos - band.start) <= EDGE ? "from" : Math.abs(pos - band.end) <= EDGE ? "to" : pos > band.start && pos < band.end ? "slide" : "draw";
      drag = { pointer: e.pointerId, kind, origin: i, from: run.from, to: run.to };
      if (kind === "draw") onrun(i, i + 1, "start"); else onrun(run.from, run.to, "start");
    } else if (e.shiftKey) {
      drag = { pointer: e.pointerId, kind: "draw", origin: i, from: i, to: i + 1 };
      onrun(i, i + 1, "start");
    } else {
      drag = { pointer: e.pointerId, kind: "scrub", origin: i, from: i, to: i + 1 };
      onscrub(i, "start");
    }
  }
  /** The run a run-drag gives with the pointer over plane `i` (draw, slide, or move one edge). */
  function runAt(d: Drag, i: number): [number, number] {
    if (d.kind === "draw") return [Math.min(d.origin, i), Math.max(d.origin, i) + 1];
    if (d.kind === "slide") { const n = d.to - d.from, f = Math.min(length - n, Math.max(0, d.from + (i - d.origin))); return [f, f + n]; }
    if (d.kind === "from") return [Math.min(i, d.to - 1), d.to];
    return [d.from, Math.max(i + 1, d.from + 1)];
  }
  function move(e: PointerEvent): void {
    if (!track) return;
    hover = Math.min(extent, Math.max(0, along(e)));
    if (!drag || e.pointerId !== drag.pointer) return;
    const i = at(e);
    if (drag.kind === "scrub") onscrub(i, "move");
    else { const [f, t] = runAt(drag, i); onrun(f, t, "move"); }
  }
  function finish(e: PointerEvent, phase: "end" | "cancel"): void {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag;
    drag = null;
    if (track?.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    if (d.kind === "scrub") onscrub(phase === "end" ? at(e) : d.origin, phase);
    // Release where the pointer is (not where the drag began: that undid every run drawn, resized or slid).
    else if (phase === "end") { const [f, t] = runAt(d, at(e)); onrun(f, t, "end"); }
    else onrun(d.from, d.to, "cancel");
  }
  // A cursor that says which way the thing moves; a run's edges say "resize".
  const cursor = $derived.by(() => {
    if (!band || hover === null) return vertical ? "ns-resize" : "ew-resize";
    const edge = Math.abs(hover - band.start) <= EDGE || Math.abs(hover - band.end) <= EDGE;
    return edge ? (vertical ? "row-resize" : "col-resize") : hover > band.start && hover < band.end ? "grab" : vertical ? "ns-resize" : "ew-resize";
  });
  /** A point along / across the well as SVG x, y. */
  const xy = (a: number, c: number): [number, number] => (vertical ? [c, a] : [a, c]);
  /** How far through the stack the playhead is, for the play key's ring. */
  const progress = $derived(length > 1 ? index / (length - 1) : 0);
  const speedWords = $derived(speed === 0.25 ? "¼×" : speed === 0.5 ? "½×" : `${speed}×`);
  // The flag hides the scale's numbers it stands on.
  const FLAG_REACH = $derived(vertical ? 15 : 36);
  const hidden = (pos: number): boolean => Math.abs(pos - flagAt) < FLAG_REACH || (hoverAt !== null && Math.abs(pos - hoverAt.pos) < FLAG_REACH);
</script>

<div class="rail" class:vertical class:armed class:left={vertical && side === "left"} class:playing class:hasrun={!!run} style={`width:${w}px;height:${h}px`} data-fxb-rail={dim} data-fxb-wheel={`rail:${dim}`}>
  <!-- The play key, with a ring that fills as the stack goes by; the dimension's own key; the speed dial. -->
  <div class="ends a">
    {#if onplay}
      <span class="playwrap">
        <svg class="ring" viewBox="0 0 30 30" aria-hidden="true"><circle class="base" cx="15" cy="15" r="13.5" /><circle class="go" cx="15" cy="15" r="13.5" pathLength="100" stroke-dasharray={`${Math.round(progress * 1000) / 10} 100`} /></svg>
        <PaperKey round size={22} glyph={playing ? "stop" : "play"} label={playing ? "Stop" : `Play ${label.toLowerCase()}`} hotkey="Space" on={playing} id={`play:${dim}`} onpress={() => onplay?.()} />
      </span>
    {/if}
    <span class="tags">
      <button class="dimkey" type="button" data-tip={`${label} in hand: the wheel and the arrows move it`} data-hk={hotkey.toUpperCase() || undefined} onpointerdown={(e) => e.stopPropagation()} onclick={ontake}>{hotkey || dim}</button>
      {#if onplay && onspeed}<button class="dial" class:off={speed === 1} type="button" data-tip="Speed · click or roll" data-fxb-wheel={`speed:${dim}`} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => onspeed?.(e.shiftKey ? -1 : 1)}>{speedWords}</button>{/if}
    </span>
  </div>

  <div class="wellbox" style={`left:${well.x}px;top:${well.y}px;width:${well.w}px;height:${well.h}px`}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg bind:this={track} class="well" width={well.w} height={well.h} viewBox={`0 0 ${well.w} ${well.h}`} style={`cursor:${cursor}`} data-fxb-track
      onpointerdown={down} onpointermove={move} onpointerup={(e) => finish(e, "end")} onpointercancel={(e) => finish(e, "cancel")}
      onlostpointercapture={(e) => finish(e, "cancel")} onpointerleave={() => { if (!drag) hover = null; }}>
      {#if band}
        {@const [bx, by] = xy(band.start, 0)}
        <rect class="band" x={bx} y={by} width={vertical ? across : band.end - band.start} height={vertical ? band.end - band.start : across} />
      {/if}
      <!-- The scale's ticks carried across the well as hairlines: a ruled instrument, not a blank box. -->
      {#each ticks as t (t.pos)}
        {@const [x1, y1] = xy(t.pos, 0)}
        {@const [x2, y2] = xy(t.pos, across)}
        <line class="rule" {x1} {y1} {x2} {y2} />
      {/each}
      {#each shapes as s, i (i)}
        {#if s.d}<path class="trace" class:envelope={s.envelope} d={s.d} style={`--p:${s.color}`} />{/if}
      {/each}
      {#if hoverAt}
        {@const [x1, y1] = xy(hoverAt.pos, 0)}
        {@const [x2, y2] = xy(hoverAt.pos, across)}
        <line class="hoverline" {x1} {y1} {x2} {y2} />
      {/if}
      {#if band}
        {#each [band.start, band.end] as edge, i (i)}
          {@const [x1, y1] = xy(edge, 0)}
          {@const [x2, y2] = xy(edge, across)}
          <line class="head" {x1} {y1} {x2} {y2} />
          {@const [gx, gy] = xy(edge, across / 2)}
          <rect class="grip" x={gx - (vertical ? 6 : 2.5)} y={gy - (vertical ? 2.5 : 6)} width={vertical ? 12 : 5} height={vertical ? 5 : 12} rx="2.5" />
        {/each}
      {:else}
        {@const [x1, y1] = xy(head, 0)}
        {@const [x2, y2] = xy(head, across)}
        <line class="head" {x1} {y1} {x2} {y2} />
        {#each dots as d, i (i)}
          {@const [cx, cy] = xy(head, d.level)}
          <circle class="dot" {cx} {cy} r="2.6" style={`--p:${d.color}`} />
        {/each}
      {/if}
    </svg>
  </div>

  <!-- The scale: quiet numbers in the lane beside the well. -->
  <div class="scale" aria-hidden="true" style={vertical ? `left:${lane.x}px;top:${well.y}px;width:${lane.w}px;height:${well.h}px` : `left:${well.x}px;top:${well.y + well.h + 3}px;width:${well.w}px`}>
    {#each ticks as t (t.pos)}
      {#if !hidden(t.pos)}<span class="tick" style={vertical ? `top:${t.pos}px` : `left:${t.pos}px`}>{t.label.replace("-", "−")}</span>{/if}
    {/each}
    <!-- The scale's unit, said once, where the scale begins (depth) or ends (time). -->
    {#if scaleUnit}<span class="unit">{scaleUnit}</span>{/if}
    {#if hoverAt && Math.abs(hoverAt.pos - flagAt) >= FLAG_REACH}
      <span class="flag ghostflag" class:atstart={!vertical && hoverAt.pos < 40} class:atend={!vertical && hoverAt.pos > extent - 40} data-fxb-railcursor style={vertical ? `top:${Math.min(extent - 12, Math.max(12, hoverAt.pos))}px` : `left:${hoverAt.pos}px`}><b>{hoverAt.n}</b>{#if hoverAt.at}<i>{hoverAt.at}</i>{/if}</span>
    {/if}
    <!-- The playhead reaches out of the well to its flag. -->
    {#if !band}<span class="stem" style={vertical ? `top:${head}px` : `left:${head}px`}></span>{/if}
    <!-- The flag: the plane on screen, in words, riding the playhead. -->
    <span class="flag" class:atstart={!vertical && flagAt < 40} class:atend={!vertical && flagAt > extent - 40} data-fxb-flag style={vertical ? `top:${Math.min(extent - 12, Math.max(12, flagAt))}px` : `left:${flagAt}px`}>{#if here.tag}<em>{here.tag}</em>{/if}<b>{here.n}</b>{#if here.at}<i>{here.at}</i>{/if}</span>
  </div>

  <div class="ends z">
    <PaperKey size={22} glyph="project" label={run ? `Projection: ${mode}` : "Projection · or Shift-drag a run on the rail"} hotkey="E" on={!!run} id={`project:${dim}`} onpress={onproject} />
  </div>

  {#if choosing}
    <div class="chooser" role="listbox" aria-label="Projection" data-fxb-chooser>
      {#each modes as m, i (m.label)}
        <button class="chip" class:on={m.on} class:cur={i === choice} type="button" role="option" aria-selected={m.on} onpointerdown={(e) => e.stopPropagation()} onclick={() => onmode(i)}><kbd>{i + 1}</kbd>{m.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .rail { position: relative; box-sizing: border-box; border-radius: 11px; background: var(--fxb-card); border: 1px solid var(--fxb-line); box-shadow: var(--fxb-lift), var(--fxb-shadow); color: var(--fxb-tx); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; user-select: none; transition: border-color 90ms linear; }
  .rail.armed { border-color: color-mix(in oklab, var(--fxb-pink) 62%, transparent); }
  .ends { position: absolute; display: flex; align-items: center; gap: 5px; }
  .rail:not(.vertical) .ends.a { left: 0; top: 0; bottom: 0; width: 46px; flex-direction: column; justify-content: center; gap: 3px; }
  .rail:not(.vertical) .ends.z { right: 0; top: 0; width: 38px; height: 58px; justify-content: center; }
  /* A standing rail is two columns: the scale's (away from the image) and the well's (beside it). The play key
     and the projection key stand over and under the well; the rail's key and its speed over the scale. */
  .rail.vertical .ends.a { left: 5px; right: 10px; top: 4px; height: 30px; justify-content: space-between; flex-direction: row-reverse; }
  .rail.vertical.left .ends.a { flex-direction: row-reverse; }
  .rail.vertical:not(.left) .ends.a { flex-direction: row; }
  .rail.vertical .ends.z { bottom: 6px; height: 24px; width: 36px; justify-content: center; }
  .rail.vertical.left .ends.z { right: 7px; }
  .rail.vertical:not(.left) .ends.z { left: 7px; }
  .playwrap { position: relative; display: grid; place-items: center; width: 30px; height: 30px; flex: none; }
  .ring { position: absolute; inset: 0; width: 30px; height: 30px; transform: rotate(-90deg); fill: none; pointer-events: none; }
  .ring .base { stroke: rgba(255, 252, 240, 0.1); stroke-width: 1.5; }
  .ring .go { stroke: var(--fxb-pink); stroke-width: 1.5; stroke-linecap: round; opacity: 0.55; }
  .rail.playing .ring .go { opacity: 1; stroke-width: 2; }
  .tags { display: flex; align-items: center; gap: 4px; }
  .rail.vertical .tags { flex-direction: column; gap: 0; align-items: flex-end; }
  .rail.vertical:not(.left) .tags { align-items: flex-start; }
  .dimkey, .dial { padding: 0 3px; margin: 0; min-width: 14px; height: 14px; border: 0; border-radius: 3px; background: none; color: var(--fxb-tx-dim); font: 600 10px/14px var(--font-mono); cursor: var(--cursor-cross-hover); }
  .dimkey { text-transform: uppercase; }
  .dimkey:hover, .dial:hover { background: rgba(255, 252, 240, 0.1); color: var(--fxb-tx-hi); }
  .rail.armed .dimkey { color: var(--fxb-pink-hi); }
  .dial { font-weight: 500; }
  .dial:not(.off) { color: var(--fxb-pink-hi); }
  .wellbox { position: absolute; }
  .well { display: block; border-radius: 4px; background: var(--fxb-well); box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.07); touch-action: none; overflow: hidden; }
  .trace { fill: none; stroke: var(--p); stroke-width: 1.3; stroke-linejoin: round; stroke-linecap: round; opacity: 0.95; pointer-events: none; }
  /* More planes than pixels: the trace is the band between each pixel's lowest and highest plane. */
  .trace.envelope { fill: var(--p); stroke-width: 0.6; fill-opacity: 0.6; }
  .band { fill: color-mix(in oklab, var(--fxb-pink) 24%, transparent); pointer-events: none; }
  .head { stroke: var(--fxb-pink); stroke-width: 1.5; pointer-events: none; }
  .rail.armed .head { stroke: var(--fxb-pink-hi); stroke-width: 2; }
  .grip { fill: var(--fxb-paper); stroke: var(--fxb-pink); stroke-width: 1.5; pointer-events: none; }
  .hoverline { stroke: var(--fxb-paper); stroke-width: 1; opacity: 0.45; pointer-events: none; }
  .rule { stroke: var(--fxb-paper); stroke-width: 1; opacity: 0.07; pointer-events: none; }
  /* A dot rides each channel's trace where the playhead crosses it. */
  .dot { fill: var(--p); stroke: var(--fxb-well); stroke-width: 1.25; pointer-events: none; }
  .scale { position: absolute; pointer-events: none; color: var(--fxb-tx-dim); font-size: 9.5px; line-height: 12px; white-space: nowrap; }
  .tick { position: absolute; }
  .unit { position: absolute; color: var(--fxb-tx-dim); opacity: 0.75; }
  .rail.vertical .unit { top: calc(100% + 9px); }
  .rail.vertical.left .unit { right: 3px; }
  .rail.vertical:not(.left) .unit { left: 3px; }
  .rail:not(.vertical) .unit { left: calc(100% + 9px); top: 0; }
  .rail:not(.vertical) .tick { top: 0; transform: translateX(-50%); }
  .rail.vertical .tick { transform: translateY(-50%); }
  .rail.vertical.left .tick { right: 3px; }
  .rail.vertical:not(.left) .tick { left: 3px; }
  .stem { position: absolute; background: var(--fxb-pink); pointer-events: none; }
  .rail.armed .stem { background: var(--fxb-pink-hi); }
  .rail:not(.vertical) .stem { top: -3px; width: 1.5px; height: 4px; margin-left: -0.75px; }
  .rail.vertical .stem { width: 6px; height: 1.5px; margin-top: -0.75px; }
  .rail.vertical.left .stem { right: -5px; }
  .rail.vertical:not(.left) .stem { left: -5px; }
  /* The flag: Flux's paper, the plane's number in ink and where that is beside it. */
  .flag { position: absolute; display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 5px; border-radius: 8px; background: var(--fxb-paper); color: #100f0f; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); font: 10px/13px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .flag b { font-weight: 700; }
  .flag i { font-style: normal; color: #575653; }
  .flag em { font-style: normal; font-weight: 700; color: var(--flx-magenta-600); }
  .rail:not(.vertical) .flag { top: -1px; transform: translateX(-50%); }
  /* Near an end the flag stands inside the scale instead of half outside it. */
  .rail:not(.vertical) .flag.atstart { left: 0 !important; transform: none; }
  .rail:not(.vertical) .flag.atend { left: auto !important; right: 0; transform: none; }
  .rail.vertical .flag { flex-direction: column; align-items: flex-end; gap: 0; padding: 2px 5px; border-radius: 6px; transform: translateY(-50%); line-height: 12px; }
  .rail.vertical.left .flag { right: 0; }
  .rail.vertical:not(.left) .flag { left: 0; align-items: flex-start; }
  .rail.vertical .flag b { font-size: 11px; }
  .rail.vertical .flag i { font-size: 9px; }
  .flag.ghostflag { background: #343331; color: var(--fxb-tx-hi); box-shadow: none; }
  .flag.ghostflag i { color: var(--fxb-tx); }
  /* The chooser: what the planes of a run become. It lies over the scale while it is open. */
  .chooser { position: absolute; z-index: 3; display: flex; gap: 3px; padding: 2px; border-radius: 8px; background: var(--fxb-card); border: 1px solid color-mix(in oklab, var(--fxb-pink) 62%, transparent); box-shadow: var(--fxb-shadow); }
  .rail:not(.vertical) .chooser { right: 5px; top: 44px; }
  .rail.vertical .chooser { flex-direction: column; left: 50%; bottom: 34px; transform: translateX(-50%); }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px 0 3px; margin: 0; border-radius: 10px; border: 1px solid color-mix(in oklab, var(--c-layout-gap) 45%, transparent); background: var(--fxb-paper); color: var(--flx-magenta-600); font: 600 10.5px var(--font-mono); cursor: var(--cursor-cross-hover); white-space: nowrap; }
  .chip kbd { min-width: 13px; height: 13px; padding: 0 2px; border: 0; border-radius: 6px; background: color-mix(in oklab, var(--c-layout-gap) 20%, transparent); color: var(--flx-magenta-600); font: 600 9px/13px var(--font-mono); }
  .chip:hover, .chip.cur { background: color-mix(in oklab, var(--c-layout-gap) 18%, var(--fxb-paper)); border-color: var(--c-layout-gap); }
  .chip.on { background: var(--c-layout-gap); color: var(--fxb-paper); }
  .chip.on kbd { background: rgba(255, 252, 240, 0.25); color: var(--fxb-paper); }
</style>
