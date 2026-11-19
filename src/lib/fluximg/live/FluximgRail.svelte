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
  import { profileShape, railIndex, railPos, railSpan, railTicks } from "./rail";

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
  function move(e: PointerEvent) {
    if (!track) return;
    hover = Math.min(extent, Math.max(0, along(e)));
    if (!drag || e.pointerId !== drag.pointer) return;
    const i = at(e);
    if (drag.kind === "scrub") onscrub(i, "move");
    else if (drag.kind === "draw") onrun(Math.min(drag.origin, i), Math.max(drag.origin, i) + 1, "move");
    else if (drag.kind === "slide") {
      const n = drag.to - drag.from, f = Math.min(length - n, Math.max(0, drag.from + (i - drag.origin)));
      onrun(f, f + n, "move");
    } else if (drag.kind === "from") onrun(Math.min(i, drag.to - 1), drag.to, "move");
    else onrun(drag.from, Math.max(i + 1, drag.from + 1), "move");
  }
  function finish(e: PointerEvent, phase: "end" | "cancel") {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag;
    drag = null;
    if (track?.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    if (d.kind === "scrub") onscrub(phase === "end" ? at(e) : d.origin, phase);
    else onrun(d.from, d.to, phase === "end" ? "end" : "cancel");
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
  <button class="cap" type="button" onpointerdown={(e) => { e.stopPropagation(); }} onclick={onarm} title={`${dim}: wheel or drag to move (${hotkey})`} aria-label={`Arm ${dim}`}>
    <span class="hk">{hotkey}</span>
  </button>
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
        <line class="head" {x1} {y1} {x2} {y2} />
      {/if}
      {#if hover !== null && !drag}
        {@const [x1, y1] = xy(hover, 0)}
        {@const [x2, y2] = xy(hover, ACROSS)}
        <line class="hover" {x1} {y1} {x2} {y2} />
      {/if}
    </svg>
    {#if !band}
      <!-- The thumb straddles the track's outer edge, so it never hides the trace under the playhead. -->
      <span class="thumb" style={vertical ? `top:${head}px` : `left:${head}px`}></span>
    {/if}
    <div class="ticks" aria-hidden="true">
      {#each ticks as t (t.index)}
        <span class="tick" style={vertical ? `top:${t.pos}px` : `left:${t.pos}px`}>{t.label}</span>
      {/each}
      {#if unit && !vertical}<span class="unit">{unit}</span>{/if}
    </div>
  </div>
  <div class="readout" aria-live="off">{#each readout.split(" · ") as part, i (i)}<span class:first={i === 0}>{part}</span>{/each}</div>
  {#if onplay && !run}
    <button class="play" class:on={playing} type="button" onpointerdown={(e) => e.stopPropagation()} onclick={onplay} title={playing ? "Stop (Space)" : "Play (Space)"} aria-label={playing ? `Stop ${dim}` : `Play ${dim}`}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">{#if playing}<rect x="1.5" y="1.5" width="7" height="7" />{:else}<path d="M2 1 L9 5 L2 9 Z" />{/if}</svg>
    </button>
  {/if}
</div>

<style>
  .rail { display: flex; align-items: flex-start; gap: 6px; color: var(--c-tx-2); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; user-select: none; }
  .rail.vertical { flex-direction: column; align-items: flex-start; gap: 5px; }
  .cap { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 26px; padding: 0; border: 0; background: none; cursor: var(--cursor-cross-hover); flex: none; }
  .rail.vertical .cap { width: 26px; height: 18px; }
  .hk { color: var(--c-tx-muted); min-width: 17px; height: 16px; }
  .rail.armed .hk { color: var(--c-accent); background: var(--c-accent-tint); }
  .trackwrap { position: relative; flex: none; }
  .track { display: block; background: var(--c-bg); outline: 1px solid var(--c-line-strong); outline-offset: 0; border-radius: var(--r-ui); touch-action: none; }
  .rail.armed .track { outline-color: var(--c-accent); }
  .profile { fill: none; stroke: var(--p); stroke-width: 1.25; stroke-linejoin: round; stroke-linecap: round; opacity: 0.92; vector-effect: non-scaling-stroke; }
  /* More planes than pixels: the trace is the band between each pixel's lowest and highest plane. */
  .profile.envelope { fill: var(--p); stroke-width: 0.75; fill-opacity: 0.55; }
  .band { fill: var(--c-accent-tint); }
  .edge, .head { stroke: var(--c-accent); stroke-width: 1.5; }
  .rail:not(.armed) .head { stroke: var(--c-tx-hi); stroke-width: 1; }
  .grip { fill: var(--c-tx-hi); stroke: var(--c-accent); stroke-width: 1; }
  .hover { stroke: var(--c-tx-muted); stroke-width: 1; opacity: 0.6; pointer-events: none; }
  .thumb { position: absolute; width: 9px; height: 9px; box-sizing: border-box; background: var(--c-tx-hi); border: 1.5px solid var(--c-accent); pointer-events: none; }
  .rail:not(.vertical) .thumb { bottom: -5px; transform: translateX(-50%); }
  .rail.vertical .thumb { right: -5px; transform: translateY(-50%); }
  .rail:not(.armed) .thumb { border-color: var(--c-tx-muted); }
  .ticks { position: absolute; pointer-events: none; color: var(--c-tx-muted); font-size: 9.5px; line-height: 11px; white-space: nowrap; }
  .rail:not(.vertical) .ticks { left: 0; right: 0; top: calc(100% + 7px); height: 11px; }
  .rail.vertical .ticks { top: 0; bottom: 0; left: calc(100% + 9px); width: 44px; }
  .tick { position: absolute; }
  .rail:not(.vertical) .tick { transform: translateX(-50%); }
  .rail.vertical .tick { transform: translateY(-50%); }
  .unit { position: absolute; color: var(--c-tx-faint); }
  .rail:not(.vertical) .unit { left: calc(100% + 6px); top: 0; }
  .rail.vertical .unit { top: calc(100% + 4px); left: 0; }
  /* The position in words: the plane number first, then where that is. Fixed size, so nothing shifts while scrubbing. */
  .readout { display: flex; color: var(--c-tx-2); font-size: 10.5px; line-height: 13px; white-space: nowrap; min-height: 13px; }
  .readout .first { color: var(--c-tx-hi); }
  .rail:not(.vertical) .readout { align-self: center; flex-direction: column; padding-left: 6px; width: 132px; }
  .rail.vertical .readout { flex-direction: column; width: 74px; min-height: 26px; }
  .play { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; flex: none; align-self: center; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); cursor: var(--cursor-cross-hover); }
  .rail.vertical .play { align-self: flex-start; }
  .play svg { fill: currentColor; }
  .play:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .play.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
</style>
