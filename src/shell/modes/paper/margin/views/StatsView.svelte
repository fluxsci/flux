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
</script>

<div class="stats">
  <div class="hero" data-stats-words={stats.words}>
    <span class="n">{stats.words.toLocaleString()}</span>
    <span class="l">main-text words</span>
    <span class="venue">counted for {wc.venueId === "flux" ? "no journal (house rules)" : wc.style.name}</span>
  </div>
  <div class="grid">
    <div class="cell"><span class="n">{stats.total.toLocaleString()}</span><span class="l">all words</span></div>
    <div class="cell"><span class="n">{stats.abstract.toLocaleString()}</span><span class="l">abstract</span></div>
    <div class="cell"><span class="n">{stats.methods.toLocaleString()}</span><span class="l">methods</span></div>
    <div class="cell"><span class="n">{stats.legends.toLocaleString()}</span><span class="l">legends</span></div>
    <div class="cell"><span class="n">{stats.chars.toLocaleString()}</span><span class="l">characters</span></div>
    <div class="cell"><span class="n">~{stats.readMins}</span><span class="l">min read</span></div>
    <div class="cell"><span class="n">{stats.sentences.toLocaleString()}</span><span class="l">sentences</span></div>
    <div class="cell"><span class="n">{stats.paras.toLocaleString()}</span><span class="l">paragraphs</span></div>
    <div class="cell"><span class="n">{stats.headings}</span><span class="l">headings</span></div>
    <div class="cell"><span class="n">{host.citedKeys.size}</span><span class="l">citations</span></div>
  </div>
</div>

<style>
  .stats {
    padding: var(--sp-4);
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--sp-5) 0 var(--sp-4);
    border-bottom: 1px solid var(--c-line);
    margin-bottom: var(--sp-4);
  }
  .hero .n {
    font-family: var(--font-serif);
    font-size: 44px;
    font-weight: 700;
    color: var(--c-tx-hi);
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .hero .l {
    margin-top: 6px;
    font-size: var(--ts-sm);
    color: var(--c-tx-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .hero .venue {
    margin-top: 4px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-3);
    background: var(--c-surface);
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
  }
  .cell .n {
    font-family: var(--font-serif);
    font-size: var(--ts-lg);
    font-weight: 700;
    color: var(--c-tx);
    font-variant-numeric: tabular-nums;
  }
  .cell .l {
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
