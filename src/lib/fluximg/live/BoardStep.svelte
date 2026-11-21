<script lang="ts">
  /**
   * The "this step" card: on a slide, what the step the board edits does to the image, and the keys that author it
   * (stage 2). In Design it only says so. At "Edit after step N": the step in a few words (`describeViewChange`),
   * then the walk's keys (Play through, the pace dial, Blend planes) and the movie's (Start, Pause, Stop and how it
   * runs). Keys preview before they act (Play through and Start show their walk on the rail); every press is one
   * undo step. Presentational: the board hands it the card and owns every action (`step.ts`).
   */
  import PaperKey from "./PaperKey.svelte";
  import type { StepCard } from "./step";

  type Ghost = { dim: string; from: number; to: number } | null;
  let { card, width, hotkeys, onthrough, onpace, onblend, onmovie, onmode, onghost, onnatural }: {
    card: StepCard;
    width: number;
    /** The keyboard's words for the keys (Shift + the first rail's key, …). */
    hotkeys: { through: string; blend: string; movie: string };
    onthrough: () => void;
    onpace: (by: number) => void;
    onblend: () => void;
    onmovie: (action: "start" | "pause" | "stop") => void;
    onmode: () => void;
    /** A key that previews a walk is hovered (null: it is left). */
    onghost: (g: Ghost, which: "through" | "movie" | null) => void;
    onnatural: (h: number) => void;
  } = $props();

  const speedWords = (s: number): string => (s === 0.25 ? "¼×" : s === 0.5 ? "½×" : `${s}×`);
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const MODE_WORDS = { loop: "loops", bounce: "bounces back and forth", once: "plays once" } as const;
  const MODE_VERB = { loop: "loop", bounce: "bounce back and forth", once: "play once" } as const;
  const NEXT_MODE = { loop: "bounce", bounce: "once", once: "loop" } as const;
  /** The rate a paced walk keeps, in words: a time axis plays in real time (× the pace), any other at its planes a second. */
  const rateWords = (dim: string | undefined, pace: number): string => {
    const r = dim ? card.rates[dim] : undefined;
    if (!r || r.realTime) return `${pace !== 1 ? `${speedWords(pace)} ` : ""}real time`;
    return `${Number((r.perSecond * pace).toPrecision(3))} planes/s`;
  };
  const pacedWords = (dim: string | undefined): string => { const r = dim ? card.rates[dim] : undefined; return !r || r.realTime ? "in real time" : `at ${Number(r.perSecond.toPrecision(3))} planes a second`; };
  /** What Play through walks along (the first rail), in words. */
  const throughWords = $derived(card.dims[0] === "t" ? "time" : card.dims[0] === "z" ? "depth" : card.dims[0] ?? "");
  let h = $state(0);
  $effect(() => { if (h) onnatural(h); });
  const stop = (e: Event): void => e.stopPropagation();
  const movieGhost = (): Ghost => (card.playback ? { dim: card.playback.dim, from: card.playback.from, to: card.playback.to - 1 } : null);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="stepcard" class:design={card.design} style={`width:${width}px`} bind:offsetHeight={h} data-fxb-step={card.design ? "design" : String(card.index)} onpointerdown={stop} ondblclick={stop}>
  <div class="l1">
    <span class="ttl">{card.design ? "Design" : `Step ${card.index}`}</span>
    {#if !card.design && card.durationMs !== null && card.change}<span class="dur" data-fxb-step-duration>{seconds(card.durationMs)}{#if card.pace !== null}<i>{` · ${rateWords(card.walk?.dim, card.pace)}`}</i>{/if}</span>{/if}
  </div>
  <div class="words" data-fxb-step-words>
    {#if card.design}<span class="quiet">the image before any step · choose a step to animate it</span>
    {:else if !card.words.length}<span class="quiet">nothing changes at this step yet</span>
    {:else}{#each card.words.slice(0, 3) as w (w)}<span class="w">{w}</span>{/each}{#if card.words.length > 3}<span class="quiet">+{card.words.length - 3}</span>{/if}{/if}
  </div>
  {#if !card.design && card.dims.length}
    <div class="keys">
      <span class="grp">
        <PaperKey glyph="through" label={card.walk ? `Play through again: ${throughWords} to the other end, ${pacedWords(card.dims[0])}` : `Play through: this step plays ${throughWords} to the other end, ${pacedWords(card.dims[0])}`} hotkey={hotkeys.through} id="step-through" on={!!card.walk && card.pace !== null}
          onpress={onthrough} onenter={() => onghost(null, "through")} onleave={() => onghost(null, null)} />
        <button class="dial" class:off={!card.walk || card.pace === null || card.pace === 1} type="button" disabled={!card.walk} data-tip={!card.walk ? "Pace: use Play through first" : card.pace === null ? "Pace: custom (the duration you set) · click to pace it" : "Pace of the play-through · click or roll"} data-fxb-wheel="pace" data-fxb-key="step-pace"
          onpointerdown={stop} onclick={(e) => onpace(e.shiftKey ? -1 : 1)}>{card.pace !== null ? speedWords(card.pace) : card.walk ? "custom" : "1×"}</button>
        <PaperKey glyph="blend" label={!card.walk ? "Blend planes: use Play through first" : card.blend ? "Planes blend · click to show them one at a time" : "Blend planes: crossfade from one plane to the next as it plays"} hotkey={hotkeys.blend} id="step-blend" on={card.blend} disabled={!card.walk} onpress={onblend} />
      </span>
      <span class="sep"></span>
      <span class="grp" data-fxb-movie={card.movieState}>
        <span class="mlamp" class:run={card.movieState === "running"} class:held={card.movieState === "paused"} data-tip={card.movieState === "running" ? "After this step the movie is playing" : card.movieState === "paused" ? "After this step the movie is paused" : "After this step no movie is playing"}></span>
        <PaperKey glyph="play" label={card.movie === "videoStart" ? "This step starts the movie · click to take that away" : "Start the movie at this step"} hotkey={hotkeys.movie} id="step-start" on={card.movie === "videoStart"} onpress={() => onmovie("start")}
          onenter={() => onghost(movieGhost(), "movie")} onleave={() => onghost(null, null)} />
        <PaperKey glyph="pause" label={card.movie === "videoPause" ? "This step pauses the movie · click to take that away" : "Pause the movie at this step"} id="step-pause" on={card.movie === "videoPause"} onpress={() => onmovie("pause")} />
        <PaperKey glyph="halt" label={card.movie === "videoStop" ? "This step stops the movie · click to take that away" : "Stop the movie at this step (the image goes back to its own plane)"} id="step-stop" on={card.movie === "videoStop"} onpress={() => onmovie("stop")} />
        {#if card.playback}
          <PaperKey quiet glyph={card.playback.mode} label={`The movie ${MODE_WORDS[card.playback.mode]} · click to make it ${MODE_VERB[NEXT_MODE[card.playback.mode]]}`} id="step-mode" onpress={onmode} />
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .stepcard { box-sizing: border-box; padding: 6px 7px 7px 10px; border-radius: 11px; background: var(--fxb-card); border: 1px solid var(--fxb-line); box-shadow: var(--fxb-lift), var(--fxb-shadow); color: var(--fxb-tx); user-select: none; }
  .l1 { display: flex; align-items: baseline; gap: 8px; height: 19px; }
  .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13px var(--font-serif); color: var(--fxb-tx-hi); }
  .dur { flex: none; font: 600 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-pink-hi); }
  .dur i { font-style: normal; font-weight: 500; color: var(--fxb-tx-dim); }
  .words { display: flex; flex-wrap: wrap; gap: 3px 10px; min-height: 15px; padding: 1px 0 0; font: 10.5px/14px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx-hi); }
  .w { white-space: nowrap; }
  .w + .w::before { content: "·"; margin-right: 10px; color: var(--fxb-tx-dim); }
  .quiet { color: var(--fxb-tx-dim); }
  .keys { display: flex; align-items: center; gap: 7px; margin-top: 7px; }
  .grp { display: inline-flex; align-items: center; gap: 3px; }
  .sep { width: 1px; height: 16px; background: var(--fxb-line); }
  /* The pace dial: the rail's speed dial, here for this step's walk. */
  .dial { padding: 0 4px; margin: 0; min-width: 22px; height: 18px; border: 0; border-radius: 3px; background: none; color: var(--fxb-pink-hi); font: 600 10.5px/18px var(--font-mono); cursor: var(--cursor-cross-hover); }
  .dial.off { color: var(--fxb-tx-dim); font-weight: 500; }
  .dial:hover:not(:disabled) { background: rgba(255, 252, 240, 0.1); color: var(--fxb-tx-hi); }
  .dial:disabled { opacity: 0.4; cursor: var(--cursor-cross); }
  /* Whether the movie runs once this step has played: a steady lamp, never animated. */
  .mlamp { flex: none; width: 7px; height: 7px; margin: 0 3px 0 1px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--fxb-tx-dim); }
  .mlamp.run { background: var(--fxb-pink); box-shadow: 0 0 6px 0 var(--fxb-pink); }
  .mlamp.held { box-shadow: inset 0 0 0 1.5px var(--fxb-pink); }
</style>
