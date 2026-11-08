<script lang="ts">
  // The word-count popover (click the status-bar count): the manuscript's
  // budget the way the chosen journal counts it — abstract, main text,
  // Methods and legends against the venue's limits, the top-level sections as
  // bars, and an optional word target kept in the front matter
  // (`word-target:`). Every number is the shared counter's (wordCounts.svelte.ts
  // → src/lib/manuscript/wordBudget.ts), refreshed on the idle tick only.
  // Limits are advice, never enforcement (journalSummary's owner ruling).
  import { journalStyleOptions } from "../../../lib/style/journalPresets";
  import { MAIN_TEXT_ROLES } from "../../../lib/manuscript/wordBudget";
  import type { PaperWordCounts } from "./wordCounts.svelte";

  let { counts, onStats }: { counts: PaperWordCounts; onStats: () => void } = $props();

  const venues = journalStyleOptions();
  const b = $derived(counts.budget);
  const lim = $derived(counts.style.limits);
  const titleBlock = $derived(counts.style.manuscript?.titleBlock);
  const abstractLabel = $derived(titleBlock === "nature" ? "Summary paragraph" : titleBlock === "cell" ? "Summary" : "Abstract");
  const mainNote = $derived(
    titleBlock === "cell" ? "main legends included" : !titleBlock || titleBlock === "nature" ? "summary paragraph included" : "",
  );
  const fmt = (n: number) => n.toLocaleString("en-US");

  interface Row { id: string; label: string; words: number; limit?: number; note?: string }
  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    if (b.abstract || lim.abstractWords) out.push({ id: "abstract", label: abstractLabel, words: b.abstract, limit: lim.abstractWords });
    out.push({ id: "main", label: "Main text", words: b.main, limit: lim.mainTextWords, note: mainNote });
    if (b.methods || lim.methodsWords) out.push({ id: "methods", label: "Methods", words: b.methods, limit: lim.methodsWords });
    if (b.legends || lim.legendWords) {
      const cap = lim.legendWordsHard ?? lim.legendWords;
      out.push({
        id: "legends",
        label: "Legends",
        words: b.legends,
        note: b.longestLegend ? `longest ${fmt(b.longestLegend.words)}${cap ? ` of ${fmt(cap)}` : ""}` : cap ? `${fmt(cap)} each` : "",
      });
    }
    if (b.tables) out.push({ id: "tables", label: "Tables", words: b.tables, note: "not counted" });
    return out;
  });

  const legendOver = $derived(
    !!b.longestLegend && !!(lim.legendWordsHard ?? lim.legendWords) && b.longestLegend.words > (lim.legendWordsHard ?? lim.legendWords)!,
  );

  // Section bars: a main-text section is drawn as its share of the main-text
  // limit; anything else against the largest section.
  const sections = $derived.by(() => {
    const tops = b.sections.filter((s) => s.top);
    const max = Math.max(1, b.preamble.words, ...tops.map((s) => s.words));
    const out = tops.map((s) => {
      const scale = MAIN_TEXT_ROLES.includes(s.role) && lim.mainTextWords
        ? lim.mainTextWords
        : s.role === "methods" && lim.methodsWords ? lim.methodsWords : max;
      return { key: String(s.from), label: s.heading.replace(/\s*\{[^}]*\}\s*$/, ""), words: s.words, frac: Math.min(1, s.words / scale) };
    });
    if (b.preamble.words) out.unshift({ key: "pre", label: abstractLabel, words: b.preamble.words, frac: Math.min(1, b.preamble.words / (lim.abstractWords ?? max)) });
    return out;
  });

  let targetDraft = $state("");
  function applyTarget() {
    const n = Number(targetDraft.replace(/[,_\s]/g, ""));
    if (Number.isFinite(n) && n >= 1) counts.setTarget(n);
    targetDraft = "";
  }
</script>

<div class="wc ts-scaled" role="dialog" aria-label="Word count" data-word-count-popover>
  <div class="wc-head">
    <span>Word count</span>
    <select aria-label="Count for journal" value={counts.venueId} onchange={(e) => counts.setVenue(e.currentTarget.value)}>
      {#each venues as v (v.id)}<option value={v.id}>{v.id === "flux" ? "No journal (house rules)" : v.label}</option>{/each}
    </select>
  </div>

  {#each rows as r (r.id)}
    {@const over = (r.limit != null && r.words > r.limit) || (r.id === "legends" && legendOver)}
    <div class="wc-row" data-bucket={r.id} class:over>
      <span class="wc-label">{r.label}</span>
      <span class="wc-n" data-words={r.words}>{fmt(r.words)}{#if r.limit}<span class="wc-lim">{` / ${fmt(r.limit)}`}</span>{/if}</span>
      {#if r.limit}
        <span class="wc-bar" aria-hidden="true"><span style:width="{Math.min(100, (r.words / r.limit) * 100)}%"></span></span>
      {/if}
      {#if r.note}<span class="wc-note">{r.note}</span>{/if}
    </div>
  {/each}

  <div class="wc-row wc-target" class:over={counts.target != null && b.main > counts.target}>
    <span class="wc-label">Target</span>
    {#if counts.target != null}
      <span class="wc-n" data-target={counts.target}>{fmt(b.main)}<span class="wc-lim">{` / ${fmt(counts.target)}`}</span></span>
      <span class="wc-bar" aria-hidden="true"><span style:width="{Math.min(100, (b.main / counts.target) * 100)}%"></span></span>
      <button class="wc-link" onclick={() => counts.setTarget(null)}>Clear</button>
    {:else}
      <form class="wc-set" onsubmit={(e) => { e.preventDefault(); applyTarget(); }}>
        <input aria-label="Word target" inputmode="numeric" placeholder={lim.mainTextWords ? fmt(lim.mainTextWords) : "3,000"} bind:value={targetDraft} />
        <button class="wc-link" type="submit">Set</button>
      </form>
    {/if}
  </div>

  {#if sections.length}
    <div class="wc-rule"></div>
    <div class="wc-sub">Sections</div>
    {#each sections as s (s.key)}
      <div class="wc-sec">
        <span class="wc-sec-label" title={s.label}>{s.label}</span>
        <span class="wc-sec-n">{fmt(s.words)}</span>
        <span class="wc-bar thin" aria-hidden="true"><span style:width="{s.frac * 100}%"></span></span>
      </div>
    {/each}
  {/if}

  <div class="wc-rule"></div>
  <div class="wc-foot">
    <span>Citations, code, math, embeds and markup are not words.</span>
    <button class="wc-link" onclick={onStats}>Statistics</button>
  </div>
</div>

<style>
  .wc {
    position: absolute;
    right: 0;
    bottom: calc(100% + 7px);
    z-index: 40;
    pointer-events: auto;
    width: 288px;
    max-height: min(70vh, 560px);
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    background: var(--c-surface);
    box-shadow: 0 10px 28px rgb(0 0 0 / 24%);
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    font-variant-numeric: lining-nums tabular-nums;
    --ts-scale: 1;
  }
  .wc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 6px;
    color: var(--c-tx-faint);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    font-size: 0.9em;
  }
  .wc-head select {
    font: inherit;
    text-transform: none;
    letter-spacing: normal;
    color: var(--c-tx-2);
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 1px 4px;
    max-width: 170px;
  }
  .wc-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    column-gap: 8px;
    row-gap: 3px;
    padding: 4px 0;
  }
  .wc-label {
    color: var(--c-tx);
  }
  .wc-n {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--c-tx);
  }
  .wc-lim {
    color: var(--c-tx-faint);
  }
  .wc-note {
    grid-column: 1 / -1;
    color: var(--c-tx-faint);
  }
  .wc-bar {
    grid-column: 1 / -1;
    display: block;
    height: 4px;
    border-radius: 2px;
    background: var(--c-line);
    overflow: hidden;
  }
  .wc-bar.thin {
    height: 3px;
  }
  .wc-bar > span {
    display: block;
    height: 100%;
    background: var(--c-accent);
  }
  .over .wc-bar > span {
    background: var(--c-warning);
  }
  .over .wc-n {
    color: var(--c-warning);
  }
  .wc-target .wc-link {
    grid-column: 1 / -1;
    justify-self: end;
  }
  .wc-set {
    display: flex;
    gap: 4px;
  }
  .wc-set input {
    width: 64px;
    font: inherit;
    color: var(--c-tx);
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 1px 4px;
  }
  .wc-link {
    font: inherit;
    color: var(--c-tx-2);
    background: none;
    border: 1px solid var(--c-line);
    border-radius: var(--r-pill);
    padding: 1px 8px;
    cursor: var(--cursor-cross-hover);
  }
  .wc-link:hover {
    color: var(--c-accent);
    border-color: var(--c-accent);
  }
  .wc-rule {
    height: 1px;
    margin: 6px 0;
    background: var(--c-line);
  }
  .wc-sub {
    color: var(--c-tx-faint);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    font-size: 0.9em;
    padding-bottom: 2px;
  }
  .wc-sec {
    display: grid;
    grid-template-columns: 1fr auto;
    column-gap: 8px;
    row-gap: 2px;
    padding: 3px 0;
  }
  .wc-sec-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wc-sec-n {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--c-tx-faint);
  }
  .wc-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--c-tx-faint);
    line-height: 1.4;
  }
</style>
