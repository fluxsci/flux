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
  import type { MarginHost } from "../types";
  import {
    checkCompliance,
    sortFindings,
    type Finding,
    type SubmissionStage,
  } from "../../../../../lib/manuscript/compliance";
  import { NATURE_ROLE_ALIASES } from "../../../../../lib/manuscript/sections";
  import { resolveJournalStyle } from "../../../../../lib/style/journalStyle";
  import { BUILTIN_JOURNAL_STYLES, journalStyleOptions } from "../../../../../lib/style/journalPresets";

  let { host }: { host: MarginHost } = $props();

  let styleId = $state("nature");
  let stage = $state<SubmissionStage>("initial");

  const options = journalStyleOptions().filter((o) => o.id !== "flux");
  const style = $derived(resolveJournalStyle(styleId, BUILTIN_JOURNAL_STYLES));

  // `latestIdle` is the 150ms-debounced mirror; the sweep rides it so typing
  // never pays for a whole-document scan.
  const findings = $derived.by<Finding[]>(() => {
    const doc = host.latestIdle;
    if (!doc) return [];
    return sortFindings(
      checkCompliance({
        doc,
        style,
        aliases: NATURE_ROLE_ALIASES,
        stage,
        figureCount: host.figures.length,
        mainRefCount: host.citedKeys.size,
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

<div class="jc">
  <div class="jc-controls">
    <select aria-label="Journal" bind:value={styleId}>
      {#each options as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
    </select>
    <select aria-label="Submission stage" bind:value={stage}>
      <option value="initial">Initial submission</option>
      <option value="final">Accepted / final</option>
    </select>
  </div>

  {#if !findings.length}
    <p class="jc-clean">Nothing to flag for {style.name}.</p>
  {:else}
    <p class="jc-summary">
      {findings.length} item{findings.length === 1 ? "" : "s"}{warnCount ? ` · ${warnCount} to fix` : ""}
      — advice only, exports are never blocked.
    </p>
    <ul class="jc-list">
      {#each findings as f, i (f.ruleId + ":" + (f.from ?? i))}
        <li class="jc-item" class:warn={f.severity === "warn"}>
          <button class="jc-msg" disabled={f.from == null} onclick={() => jump(f)}>
            {#if f.excerpt}<span class="jc-excerpt">{f.excerpt}</span>{/if}
            <span>{f.message}</span>
            {#if f.suggestion}<span class="jc-sugg">→ {f.suggestion}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .jc {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    height: 100%;
    overflow: auto;
    font-size: var(--ts-sm);
  }
  .jc-controls {
    display: flex;
    gap: var(--sp-2);
  }
  .jc-controls select {
    flex: 1 1 0;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: inherit;
    font: inherit;
    font-size: var(--ts-sm);
  }
  .jc-clean,
  .jc-summary {
    margin: 0;
    color: var(--c-tx-2);
  }
  .jc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .jc-item {
    border-left: 2px solid var(--c-line-strong);
    padding-left: var(--sp-2);
  }
  .jc-item.warn {
    border-left-color: var(--c-danger);
  }
  .jc-msg {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 2px 0;
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  .jc-msg:disabled {
    cursor: default;
  }
  .jc-msg:hover:not(:disabled) {
    color: var(--c-tx-hi);
  }
  .jc-excerpt {
    font-family: var(--font-mono, monospace);
    color: var(--c-tx-hi);
  }
  .jc-sugg {
    color: var(--c-accent-bright);
  }
</style>
