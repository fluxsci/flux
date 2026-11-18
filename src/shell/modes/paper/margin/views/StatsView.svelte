<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";
  import { stripFrontMatter } from "./stats";

  let { host }: { host: MarginHost; margin: MarginApi } = $props();

  // Words come from THE shared counter via the pane's wordCounts (the same
  // object the status bar reads, so the two never disagree): main text the
  // chosen journal's way, plus the buckets it is made of.
  const wc = $derived(host.wordCounts);
  const stats = $derived.by(() => {
    // latestIdle (the 150ms PAP-7 mirror), NOT latest: with this pane open, whole-doc
    // regexes per keystroke would tax the typing hot path.
    const body = stripFrontMatter(host.latestIdle);
    const b = wc.budget;
    const sentences = (body.match(/[.!?]+(?:\s|$)/g) ?? []).length;
    const paras = body.split(/\n\s*\n/).filter((s) => s.trim() && !/^#{1,6}\s/.test(s.trim())).length;
    const headings = (body.match(/^#{1,6}\s/gm) ?? []).length;
    return {
      words: b.main,
      total: b.total,
      abstract: b.abstract,
      methods: b.methods,
      legends: b.legends,
      chars: body.replace(/\s/g, "").length,
      sentences,
      paras,
      headings,
      readMins: Math.max(1, Math.round(b.total / 200)),
    };
  });
  // Where the words are: the top-level sections, in document order, against the longest one.
  // The same idle-tick budget the outline's per-heading counts come from, so nothing new runs.
  const sections = $derived(wc.budget.sections.filter((x) => x.top && x.words > 0));
  const longest = $derived(Math.max(1, ...sections.map((x) => x.words)));
  const target = $derived(wc.target);
  const fmt = (n: number) => n.toLocaleString();
</script>

<div class="stats mk-pane">
  <div class="hero" data-stats-words={stats.words}>
    <span class="n">{fmt(stats.words)}</span>
    <span class="mk-eyebrow">main-text words</span>
    <span class="venue">counted for {wc.venueId === "flux" ? "no journal (house rules)" : wc.style.name}</span>
    {#if target}
      {@const over = stats.words > target}
      <div class="goal" class:over title="word-target: {fmt(target)} (front matter)">
        <div class="track"><i style="transform:scaleX({Math.min(1, stats.words / target)})"></i></div>
        <span class="mk-num">{over ? `${fmt(stats.words - target)} over` : `${fmt(target - stats.words)} to go`} · target {fmt(target)}</span>
      </div>
    {/if}
  </div>

  <dl class="ledger">
    <div><dt>All words</dt><dd>{fmt(stats.total)}</dd></div>
    <div><dt>Abstract</dt><dd>{fmt(stats.abstract)}</dd></div>
    <div><dt>Methods</dt><dd>{fmt(stats.methods)}</dd></div>
    <div><dt>Legends</dt><dd>{fmt(stats.legends)}</dd></div>
    <div><dt>Characters</dt><dd>{fmt(stats.chars)}</dd></div>
    <div><dt>Reading</dt><dd>~{stats.readMins} min</dd></div>
    <div><dt>Sentences</dt><dd>{fmt(stats.sentences)}</dd></div>
    <div><dt>Paragraphs</dt><dd>{fmt(stats.paras)}</dd></div>
    <div><dt>Headings</dt><dd>{stats.headings}</dd></div>
    <div><dt>Citations</dt><dd>{host.citedKeys.size}</dd></div>
  </dl>

  {#if sections.length > 1}
    <div class="bysec">
      <div class="mk-eyebrow">By section</div>
      <ol>
        {#each sections as sec (sec.from)}
          <li title="{sec.heading}: {fmt(sec.words)} words">
            <span class="sname mk-clip">{sec.heading}</span>
            <span class="swords mk-num">{fmt(sec.words)}</span>
            <span class="sbar"><i style="transform:scaleX({sec.words / longest})"></i></span>
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</div>

<style>
  .stats {
    height: auto;
    min-height: 100%;
    gap: 14px;
    padding-top: 12px;
    padding-bottom: 14px;
  }
  .hero {
    display: grid;
    justify-items: center;
    gap: 5px;
    padding: 6px 0 2px;
  }
  .hero .n {
    font-family: var(--font-serif);
    font-size: calc(38px * var(--ts-scale, 1));
    font-weight: 400;
    letter-spacing: -0.01em;
    color: var(--c-tx-hi);
    line-height: 1;
    font-variant-numeric: lining-nums tabular-nums;
  }
  .hero .venue {
    font-size: var(--ts-xs);
    font-style: italic;
    color: var(--c-tx-faint);
  }
  .goal {
    width: 100%;
    display: grid;
    justify-items: center;
    gap: 5px;
    margin-top: 6px;
    color: var(--c-tx-muted);
    font-size: calc(10.5px * var(--ts-scale, 1));
  }
  .track,
  .sbar {
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--c-line);
    overflow: hidden;
  }
  .track {
    width: 100%;
  }
  .track i,
  .sbar i {
    display: block;
    height: 100%;
    background: var(--pane-c);
    transform-origin: left center;
  }
  .goal.over {
    color: var(--c-warning);
  }
  .goal.over .track i {
    background: var(--c-warning);
  }
  /* Label left, figure right, a hairline under each pair: a ledger, not a wall of tiles. */
  .ledger {
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 16px;
    margin: 0;
    border-top: 1px solid var(--c-line-strong);
  }
  .ledger div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    padding: calc(6px * var(--ts-scale, 1)) 1px;
    border-bottom: 1px solid var(--c-line);
  }
  .ledger dt {
    font: 600 calc(9.5px * var(--ts-scale, 1)) / 1.2 var(--font-mono);
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--c-tx-muted);
    white-space: nowrap;
  }
  .ledger dd {
    margin: 0;
    font-family: var(--font-serif);
    font-size: var(--ts-base);
    font-variant-numeric: lining-nums tabular-nums;
    color: var(--c-tx);
    white-space: nowrap;
  }
  .bysec {
    display: grid;
    gap: 7px;
  }
  .bysec ol {
    display: grid;
    gap: calc(7px * var(--ts-scale, 1));
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .bysec li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 8px;
    row-gap: 3px;
    align-items: baseline;
  }
  .sname {
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
  }
  .swords {
    font-size: calc(10.5px * var(--ts-scale, 1));
    color: var(--c-tx-muted);
  }
  .sbar {
    grid-column: 1 / -1;
  }
</style>
