<script lang="ts">
  /**
   * A navigator rail: one dimension of the stack as a track you can read and grab.
   *
   * The track is a plot of the stack itself (each shown channel's mean signal per plane), with the current plane
   * as a playhead and a projection's run as a band. Time-like dimensions lie horizontally under the image;
   * depth stands vertically at its side, so moving through z is moving up and down.
   *
   * Presentational: it reports gestures and draws what it is given. The overlay owns the model.
   */
  import type { FluximgAxis } from "../types";
  import { axisValue, profileShape, railIndex, railPos, railSpan, railTicks } from "./rail";

  type Phase = "start" | "move" | "end" | "cancel";
  let {
    dim, hotkey, length, index, run = null, profiles = [], axis = undefined, vertical = false, extent, armed = false,
    readout = "", unit = "", format = (v: number) => String(v), playing = false, onscrub, onrun, onarm, onplay = undefined,
  }: {
    dim: string;
    /** The key that arms this rail (shown as a key cap). */
    hotkey: string;
    length: number;
    index: number;
    /** A projection's run of planes, `from` inclusive, `to` exclusive. */
    run?: { from: number; to: number } | null;
    profiles?: Array<{ color: string; values: ReadonlyArray<number | null> }>;
    axis?: FluximgAxis | undefined;
    vertical?: boolean;
    /** Track length in screen px. */
    extent: number;
    armed?: boolean;
    /** The position in words ("12/25 · −13 µm"). */
    readout?: string;
    unit?: string;
    format?: (v: number) => string;
    onscrub: (index: number, phase: Phase) => void;
    onrun: (from: number, to: number, phase: Phase) => void;
    onarm: () => void;
    /** Present when the dimension can be played (not while a run is shown); the rail then offers a play button. */
    playing?: boolean;
    onplay?: (() => void) | undefined;
  } = $props();

  /** Track thickness (px across) and the grab zone of a run's edge. */
  const ACROSS = 26, EDGE = 6;

  const shapes = $derived(profiles.map((p) => ({ color: p.color, ...profileShape(p.values, extent, ACROSS, vertical) })));
  const head = $derived(railPos(index, length, extent));
  const band = $derived(run ? railSpan(run.from, run.to, length, extent) : null);
  const ticks = $derived(railTicks(axis, length, extent, format, vertical ? 30 : 54));
  let hover = $state<number | null>(null);
  /** The plane under the pointer and what a click there would show: the rail's axis cursor. */
  const hoverAt = $derived.by(() => {
    if (hover === null || drag) return null;
    const i = railIndex(hover, length, extent), v = axisValue(axis, i);
    const where = axis?.labels?.[i] ?? (v !== null ? `${format(Number(v.toPrecision(5)))}${unit ? ` ${unit}` : ""}` : "");
    return { index: i, pos: railPos(i, length, extent), label: where ? `${i + 1} · ${where}` : String(i + 1) };
  });

  let track = $state<SVGSVGElement>();
  type Drag = { pointer: number; kind: "scrub" | "draw" | "slide" | "from" | "to"; origin: number; from: number; to: number };
  let drag = $state<Drag | null>(null);

  /** Pointer position along the track, in px from its start. */
  function along(e: PointerEvent): number {
    const r = track!.getBoundingClientRect();
    return vertical ? e.clientY - r.top : e.clientX - r.left;
  }
  const at = (e: PointerEvent): number => railIndex(along(e), length, extent);

  function down(e: PointerEvent) {
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
  function move(e: PointerEvent) {
    if (!track) return;
    hover = Math.min(extent, Math.max(0, along(e)));
    if (!drag || e.pointerId !== drag.pointer) return;
    const i = at(e);
    if (drag.kind === "scrub") onscrub(i, "move");
    else { const [f, t] = runAt(drag, i); onrun(f, t, "move"); }
  }
  function finish(e: PointerEvent, phase: "end" | "cancel") {
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
  const w = $derived(vertical ? ACROSS : extent), h = $derived(vertical ? extent : ACROSS);
  /** A point along / across the track as SVG x, y. */
  const xy = (a: number, c: number): [number, number] => (vertical ? [c, a] : [a, c]);
</script>

<div class="rail" class:vertical class:armed data-fluximg-rail={dim}>
  {#snippet cap()}
    <button class="cap" type="button" onpointerdown={(e) => { e.stopPropagation(); }} onclick={onarm} title={`${dim}: wheel or drag to move (${hotkey})`} aria-label={`Arm ${dim}`}>
      <span class="hk">{hotkey}</span>
    </button>
  {/snippet}
  {#snippet words()}
    <div class="readout" aria-live="off">{#each readout.split(" · ") as part, i (i)}<span class:first={i === 0}>{part}</span>{/each}</div>
  {/snippet}
  {#snippet player()}
    {#if onplay && !run}
      <button class="play" class:on={playing} type="button" onpointerdown={(e) => e.stopPropagation()} onclick={onplay} title={playing ? "Stop (Space)" : "Play (Space)"} aria-label={playing ? `Stop ${dim}` : `Play ${dim}`}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">{#if playing}<rect x="1.5" y="1.5" width="7" height="7" />{:else}<path d="M2 1 L9 5 L2 9 Z" />{/if}</svg>
      </button>
    {/if}
  {/snippet}
  <!-- Depth stands at the image's side: its key, play and position sit in one line above the track. Time lies under
       the image: key at the track's start, position and play at its end. -->
  {#if vertical}<div class="head">{@render cap()}{@render player()}{@render words()}</div>{:else}{@render cap()}{/if}
  <div class="trackwrap" style={vertical ? `height:${extent}px;width:${ACROSS}px` : `width:${extent}px;height:${ACROSS}px`}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg bind:this={track} class="track" width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={`cursor:${cursor}`}
      onpointerdown={down} onpointermove={move} onpointerup={(e) => finish(e, "end")} onpointercancel={(e) => finish(e, "cancel")}
      onlostpointercapture={(e) => finish(e, "cancel")} onpointerleave={() => { if (!drag) hover = null; }}>
      {#if band}
        {@const [bx, by] = xy(band.start, 0)}
        <rect class="band" x={bx} y={by} width={vertical ? ACROSS : band.end - band.start} height={vertical ? band.end - band.start : ACROSS} />
      {/if}
      {#each shapes as s, i (i)}
        {#if s.d}<path class="profile" class:envelope={s.envelope} d={s.d} style={`--p:${s.color}`} />{/if}
      {/each}
      {#if band}
        {#each [band.start, band.end] as edge, i (i)}
          {@const [x1, y1] = xy(edge, 0)}
          {@const [x2, y2] = xy(edge, ACROSS)}
          <line class="edge" {x1} {y1} {x2} {y2} />
          {@const [gx, gy] = xy(edge, ACROSS / 2)}
          <rect class="grip" x={gx - (vertical ? 5 : 2)} y={gy - (vertical ? 2 : 5)} width={vertical ? 10 : 4} height={vertical ? 4 : 10} rx="1" />
        {/each}
      {:else}
        {@const [x1, y1] = xy(head, 0)}
        {@const [x2, y2] = xy(head, ACROSS)}
        <line class="head-line" {x1} {y1} {x2} {y2} />
      {/if}
      {#if hoverAt}
        {@const [x1, y1] = xy(hoverAt.pos, 0)}
        {@const [x2, y2] = xy(hoverAt.pos, ACROSS)}
        <line class="hover" {x1} {y1} {x2} {y2} />
      {/if}
    </svg>
    {#if !band}
      <!-- The thumb straddles the track's outer edge, so it never hides the trace under the playhead. -->
      <span class="thumb" style={vertical ? `top:${head}px` : `left:${head}px`}></span>
    {/if}
    <div class="ticks" class:hovering={!!hoverAt} aria-hidden="true">
      {#each ticks as t (t.index)}
        <span class="tick" style={vertical ? `top:${t.pos}px` : `left:${t.pos}px`}>{t.label}</span>
      {/each}
    </div>
    <!-- The axis cursor: the plane under the pointer, named where the ticks are (a click goes there). -->
    {#if hoverAt}<span class="cursor" data-fluximg-railcursor style={vertical ? `top:${hoverAt.pos}px` : `left:${Math.min(extent - 4, Math.max(4, hoverAt.pos))}px`}>{hoverAt.label}</span>{/if}
  </div>
  {#if !vertical}{@render words()}{@render player()}{/if}
</div>

<style>
  /* One small, tight surface per rail (hairline, no shadow), like Flux's other on-canvas readouts: the paper or
     pasteboard behind it is never known, and its numbers must read on either. */
  .rail { display: flex; align-items: flex-start; gap: 6px; padding: 4px 6px 5px 4px; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); color: var(--c-tx-2); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; user-select: none; }
  .rail:not(.vertical) { padding-bottom: 17px; }
  .rail.vertical { flex-direction: column; gap: 5px; padding: 4px 4px 6px; width: 78px; box-sizing: border-box; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; }
  .cap, .play { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; flex: none; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); cursor: var(--cursor-cross-hover); }
  .rail:not(.vertical) .cap { margin-top: 3px; }
  .hk { color: var(--c-tx-muted); min-width: 0; height: auto; border: 0; background: none; font: 500 10px var(--font-mono); }
  .rail.armed .cap { border-color: var(--c-accent); background: color-mix(in oklab, var(--c-accent) 16%, var(--c-surface)); }
  .rail.armed .hk { color: var(--c-accent-bright); }
  .trackwrap { position: relative; flex: none; }
  .track { display: block; background: var(--c-bg); outline: 1px solid var(--c-line-strong); outline-offset: 0; border-radius: var(--r-ui); touch-action: none; }
  .rail.armed .track { outline-color: var(--c-accent); }
  .profile { fill: none; stroke: var(--p); stroke-width: 1.25; stroke-linejoin: round; stroke-linecap: round; opacity: 0.92; vector-effect: non-scaling-stroke; }
  /* More planes than pixels: the trace is the band between each pixel's lowest and highest plane. */
  .profile.envelope { fill: var(--p); stroke-width: 0.75; fill-opacity: 0.55; }
  .band { fill: var(--c-accent-tint); }
  .edge, .head-line { stroke: var(--c-accent); stroke-width: 1.5; }
  .rail:not(.armed) .head-line { stroke: var(--c-tx-hi); stroke-width: 1; }
  .grip { fill: var(--c-tx-hi); stroke: var(--c-accent); stroke-width: 1; }
  .hover { stroke: var(--c-tx-muted); stroke-width: 1; opacity: 0.6; pointer-events: none; }
  .thumb { position: absolute; width: 9px; height: 9px; box-sizing: border-box; background: var(--c-tx-hi); border: 1.5px solid var(--c-accent); pointer-events: none; }
  .rail:not(.vertical) .thumb { bottom: -5px; transform: translateX(-50%); }
  .rail.vertical .thumb { right: -5px; transform: translateY(-50%); }
  .rail:not(.armed) .thumb { border-color: var(--c-tx-muted); }
  .ticks { position: absolute; pointer-events: none; color: var(--c-tx-muted); font-size: 9.5px; line-height: 11px; white-space: nowrap; }
  .rail:not(.vertical) .ticks { left: 0; right: 0; top: calc(100% + 7px); height: 11px; }
  .rail.vertical .ticks { top: 0; bottom: 0; left: calc(100% + 8px); width: 36px; }
  .tick { position: absolute; }
  .ticks.hovering { opacity: 0.35; }
  .cursor { position: absolute; z-index: 1; padding: 0 4px; height: 13px; line-height: 13px; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-hi); font-size: 9.5px; white-space: nowrap; pointer-events: none; }
  .rail:not(.vertical) .cursor { top: calc(100% + 5px); transform: translateX(-50%); }
  .rail.vertical .cursor { left: calc(100% + 6px); transform: translateY(-50%); }
  .rail:not(.vertical) .tick { transform: translateX(-50%); }
  .rail.vertical .tick { transform: translateY(-50%); }
  /* The position in words: the plane number first, then where that is. It never changes size while scrubbing. */
  .readout { display: flex; flex-direction: column; color: var(--c-tx-2); font-size: 10.5px; line-height: 13px; white-space: nowrap; }
  /* Depth: under its key, as wide as the rail; a projection's range may take a second and third line. */
  .rail.vertical .readout { flex: 1 1 100%; white-space: normal; min-height: 39px; }
  .readout .first { color: var(--c-tx-hi); }
  .rail:not(.vertical) .readout { align-self: flex-start; padding: 0 2px 0 4px; min-width: 96px; min-height: 26px; justify-content: center; }
  .play { color: var(--c-tx-2); }
  .rail:not(.vertical) .play { margin-top: 3px; }
  .play svg { fill: currentColor; }
  .play:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .play.on { background: color-mix(in oklab, var(--c-accent) 16%, var(--c-surface)); border-color: var(--c-accent); color: var(--c-tx-hi); }
</style>
