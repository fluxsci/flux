<script lang="ts">
  // The export summary — shown after a journal export (Nature, Science, Cell,
  // bioRxiv): what Flux did, what needs the author's attention, and what is
  // still to do outside Flux. Advisory by design: limits are warnings, nothing
  // was cut and nothing blocked the export. The same text is written beside the
  // file as <name>.submission.md (style/journalSummary.ts builds both).
  import { modalFocus } from "../../../lib/ui/modalFocus";
  import { popIn } from "../../../lib/motion/actions";
  import type { ExportSummary, SummarySeverity } from "../../../lib/style/journalSummary";

  let {
    summary,
    outPath,
    notesPath,
    onReveal,
    onClose,
  }: {
    summary: ExportSummary;
    outPath: string;
    notesPath?: string;
    onReveal?: (path: string) => void;
    onClose: () => void;
  } = $props();

  let root: HTMLDivElement | undefined = $state();
  const MARK: Record<SummarySeverity, string> = { warn: "!", info: "·", done: "✓", todo: "☐" };
  // "Checked" and "Figure files" start folded: the actionable sections lead.
  const startsOpen = (h: string) => h !== "Checked" && h !== "Figure files";

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" || (e.key === "Enter" && !(e.target instanceof HTMLButtonElement))) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  $effect(() => {
    root?.focus();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="summary-backdrop" onclick={onClose}></div>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="summary-panel"
  use:modalFocus
  role="dialog"
  aria-label="Export summary"
  aria-modal="true"
  tabindex="-1"
  bind:this={root}
  onkeydown={onKeydown}
  transition:popIn
  data-export-summary
>
  <header>
    <span class="done-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg></span>
    <div class="heading">
      <div class="title">{summary.title}</div>
      <div class="sub">{summary.subtitle}</div>
    </div>
    <div class="badges">
      {#if summary.warnings}<span class="badge warn" data-summary-warnings={summary.warnings}>{summary.warnings} to check</span>{:else}<span class="badge ok">Nothing flagged</span>{/if}
      {#if summary.todos}<span class="badge todo">{summary.todos} outside Flux</span>{/if}
    </div>
  </header>

  <div class="body">
    {#each summary.sections as sec (sec.heading)}
      <details open={startsOpen(sec.heading)}>
        <summary><svg class="tw" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M2.5 1.2L5.8 4 2.5 6.8" /></svg>{sec.heading} <span class="count">{sec.items.length}</span></summary>
        <ul>
          {#each sec.items as item, i (i)}
            <li class={item.severity}><span class="mark" aria-hidden="true">{MARK[item.severity]}</span><span>{item.text}</span></li>
          {/each}
        </ul>
      </details>
    {/each}
    <p class="advisory">Limits are advisory: Flux never cuts text or blocks an export.</p>
  </div>

  <div class="actions">
    {#if notesPath}<span class="notes" title={notesPath}>Saved beside the file as <b>{notesPath.replace(/^.*[\\/]/, "")}</b></span>{/if}
    {#if onReveal}<button class="ghost" onclick={() => onReveal?.(outPath)}>Reveal file</button>{/if}
    <button class="primary" onclick={onClose}>Done</button>
  </div>
</div>

<style>
  /* The export dialog's sibling: the same sheet, header bar and buttons. Every colour is a
     token READ here, inside `.paper`: the numbered aliases (--c-tx-1, --c-tx-3) are declared on
     :root and resolve to the DARK theme's values there, which put pale grey text on cream. */
  .summary-backdrop {
    position: absolute;
    inset: 0;
    z-index: 70;
    background: color-mix(in oklab, var(--flx-black) 26%, transparent);
  }
  .summary-panel {
    position: absolute;
    z-index: 71;
    top: 8vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(640px, 94%);
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    background: var(--flx-paper);
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    box-shadow:
      0 24px 60px -18px rgba(40, 30, 10, 0.5),
      0 6px 16px -6px rgba(40, 30, 10, 0.28);
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    overflow: hidden;
    outline: none;
  }
  header {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: 11px;
    row-gap: 9px;
    align-items: center;
    padding: 14px 18px 13px;
    border-bottom: 1px solid var(--c-line-strong);
  }
  .done-mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: color-mix(in oklab, var(--c-success) 14%, transparent);
    color: var(--c-success);
  }
  .done-mark svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .heading {
    min-width: 0;
  }
  .title {
    font-size: var(--ts-md);
    font-weight: 600;
    letter-spacing: -0.005em;
    color: var(--c-tx-hi);
    line-height: 1.25;
  }
  .sub {
    margin-top: 1px;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badges {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .badge {
    padding: 2px 9px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    font-size: var(--ts-xs);
    line-height: 1.45;
    color: var(--c-tx-2);
  }
  .badge.warn {
    border-color: color-mix(in oklab, var(--c-warning) 55%, transparent);
    background: color-mix(in oklab, var(--c-warning) 9%, transparent);
    color: var(--c-warning);
  }
  .badge.ok {
    border-color: color-mix(in oklab, var(--c-success) 55%, transparent);
    background: color-mix(in oklab, var(--c-success) 9%, transparent);
    color: var(--c-success);
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 6px 18px 12px;
    scrollbar-width: thin;
  }
  details {
    border-bottom: 1px solid var(--c-line);
  }
  summary {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 0;
    list-style: none;
    color: var(--c-tx);
    font: 600 10px/1.2 var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: var(--cursor-cross-hover);
    user-select: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    color: var(--c-accent);
  }
  summary:focus-visible {
    outline: 2px solid var(--c-accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .tw {
    flex: 0 0 auto;
    fill: none;
    stroke: var(--c-tx-faint);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 80ms linear;
  }
  details[open] > summary .tw {
    transform: rotate(90deg);
  }
  .count {
    margin-left: auto;
    color: var(--c-tx-muted);
    font-weight: 500;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0 0 11px 15px;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    column-gap: 6px;
    align-items: baseline;
    color: var(--c-tx-2);
    line-height: 1.45;
  }
  .mark {
    color: var(--c-tx-faint);
    font-family: var(--font-mono);
    text-align: center;
  }
  li.warn {
    color: var(--c-tx);
  }
  li.warn .mark {
    color: var(--c-warning);
    font-weight: 700;
  }
  li.done .mark {
    color: var(--c-success);
  }
  li.todo .mark {
    color: var(--c-accent);
  }
  .advisory {
    margin: 11px 0 0;
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    font-style: italic;
  }
  .actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 14px 12px 18px;
    border-top: 1px solid var(--c-line-strong);
    background: var(--c-surface);
  }
  .notes {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
  }
  .notes b {
    font: 600 0.95em var(--font-mono);
    color: var(--c-tx-2);
  }
  .ghost,
  .primary {
    flex: 0 0 auto;
    height: 30px;
    padding: 0 14px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--flx-paper);
    color: var(--c-tx-2);
    font: 600 var(--ts-sm) var(--font-serif);
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      border-color 80ms linear,
      color 80ms linear,
      transform 60ms linear;
  }
  .ghost:hover {
    background: var(--c-ui);
    color: var(--c-tx);
  }
  .ghost:active,
  .primary:active {
    transform: translateY(0.5px) scale(0.985);
  }
  .primary {
    min-width: 84px;
    margin-left: auto;
    border-color: var(--c-accent);
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .notes + .ghost,
  .notes ~ .primary {
    margin-left: 0;
  }
  .primary:hover {
    background: var(--c-accent-bright);
    border-color: var(--c-accent-bright);
  }
  .ghost:focus-visible,
  .primary:focus-visible {
    outline: 2px solid var(--c-accent);
    outline-offset: 1px;
  }
</style>
