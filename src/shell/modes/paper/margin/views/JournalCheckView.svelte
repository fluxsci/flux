<script lang="ts">
  // Journal Check — the venue's rulebook, as advice.
  //
  // Never blocking, and it never edits your prose. Nature is explicitly flexible
  // about format at initial submission, so findings are information until the
  // stage says otherwise; and Flux only auto-formats references it OWNS
  // (structured @fig- tokens), never hand-typed prose, because it cannot tell
  // "our Figure 2, panel D" from a citation of someone else's Figure 2D.
  //
  // Runs on summon and on IDLE — never per keystroke. A whole-document sweep is
  // not a typing-path operation (Nielsen §6).
  import { untrack } from "svelte";
  import type { MarginHost } from "../types";
  import {
    checkCompliance,
    sortFindings,
    type Finding,
    type SubmissionStage,
  } from "../../../../../lib/manuscript/compliance";
  import { JOURNAL_ROLE_ALIASES } from "../../../../../lib/manuscript/sections";
  import { resolveJournalStyle } from "../../../../../lib/style/journalStyle";
  import { BUILTIN_JOURNAL_STYLES, journalStyleOptions } from "../../../../../lib/style/journalPresets";

  let { host }: { host: MarginHost } = $props();

  // Opens on the venue the word count is reading for (the status-bar popover's pick).
  const initialVenue = untrack(() => host.wordCounts.venueId);
  let styleId = $state(initialVenue === "flux" ? "nature" : initialVenue);
  let stage = $state<SubmissionStage>("initial");

  const options = journalStyleOptions().filter((o) => o.id !== "flux");
  const style = $derived(resolveJournalStyle(styleId, BUILTIN_JOURNAL_STYLES));

  const captions = $derived(new Map(host.figures.map((f) => [f.label, f.caption] as const)));

  // `latestIdle` is the 150ms-debounced mirror; the sweep rides it so typing
  // never pays for a whole-document scan.
  const findings = $derived.by<Finding[]>(() => {
    const doc = host.latestIdle;
    if (!doc) return [];
    return sortFindings(
      checkCompliance({
        doc,
        style,
        // The word budget reads the same heading vocabulary as the export
        // assembler and the status bar's popover, so the numbers agree.
        aliases: JOURNAL_ROLE_ALIASES,
        stage,
        figureCount: host.figures.length,
        mainRefCount: host.citedKeys.size,
        legendFor: (label) => captions.get(label),
      }),
    );
  });

  const warnCount = $derived(findings.filter((f) => f.severity === "warn").length);

  function jump(f: Finding) {
    if (f.from == null || !host.view) return;
    const v = host.view;
    const max = v.state.doc.length;
    const from = Math.min(f.from, max);
    const to = Math.min(f.to ?? f.from, max);
    v.dispatch({
      selection: { anchor: from, head: to },
      effects: [],
      scrollIntoView: true,
    });
    v.focus();
  }
</script>

<div class="jc mk-pane">
  <div class="jc-controls">
    <select class="mk-select" aria-label="Journal" bind:value={styleId}>
      {#each options as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
    </select>
    <select class="mk-select" aria-label="Submission stage" bind:value={stage}>
      <option value="initial">Initial submission</option>
      <option value="final">Accepted / final</option>
    </select>
  </div>

  {#if !findings.length}
    <p class="jc-clean mk-empty">Nothing to flag for {style.name}.</p>
  {:else}
    <p class="jc-summary">
      <b class="mk-num">{findings.length}</b> item{findings.length === 1 ? "" : "s"}{#if warnCount}<span class="dot" aria-hidden="true">·</span><span class="tofix"><b class="mk-num">{warnCount}</b> to fix</span>{/if}
      <span class="advice">Advice only: exports are never blocked.</span>
    </p>
    <ul class="jc-list mk-list">
      {#each findings as f, i (f.ruleId + ":" + (f.from ?? i))}
        <li class="jc-item mk-find" class:warn={f.severity === "warn"}>
          <button class="jc-msg mk-find-msg" disabled={f.from == null} onclick={() => jump(f)} title={f.from == null ? undefined : "Go to this place in the manuscript"}>
            {#if f.excerpt}<span class="jc-excerpt mk-quote">{f.excerpt}</span>{/if}
            <span>{f.message}</span>
            {#if f.suggestion}<span class="jc-sugg mk-sugg">→ {f.suggestion}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .jc-controls {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
    gap: 6px;
  }
  .jc-summary {
    flex: 0 0 auto;
    margin: 0;
    font-size: var(--ts-sm);
    line-height: 1.4;
    color: var(--c-tx);
  }
  .jc-summary b {
    font-weight: 600;
    font-size: 1em;
  }
  .dot {
    margin: 0 6px;
    color: var(--c-tx-faint);
  }
  .tofix {
    color: var(--c-warning);
  }
  .advice {
    display: block;
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    font-style: italic;
  }
  .jc-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
