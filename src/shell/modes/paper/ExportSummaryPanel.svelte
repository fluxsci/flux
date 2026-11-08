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
    <div class="title">{summary.title}</div>
    <div class="sub">{summary.subtitle}</div>
    <div class="badges">
      {#if summary.warnings}<span class="badge warn" data-summary-warnings={summary.warnings}>{summary.warnings} to check</span>{:else}<span class="badge ok">Nothing flagged</span>{/if}
      {#if summary.todos}<span class="badge todo">{summary.todos} outside Flux</span>{/if}
    </div>
  </header>

  <div class="body">
    {#each summary.sections as sec (sec.heading)}
      <details open={startsOpen(sec.heading)}>
        <summary>{sec.heading} <span class="count">{sec.items.length}</span></summary>
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
    {#if notesPath}<span class="notes" title={notesPath}>Saved as {notesPath.replace(/^.*[\\/]/, "")}</span>{/if}
    {#if onReveal}<button class="ghost" onclick={() => onReveal?.(outPath)}>Reveal file</button>{/if}
    <button class="primary" onclick={onClose}>Done</button>
  </div>
</div>

<style>
  .summary-backdrop {
    position: absolute;
    inset: 0;
    z-index: 70;
    background: rgba(0, 0, 0, 0.18);
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
    background: var(--c-surface, #fff);
    border: 1px solid var(--c-line-strong, #ccc);
    border-radius: 10px;
    box-shadow: var(--elev-2);
    outline: none;
  }
  header {
    padding: var(--sp-4) var(--sp-4) var(--sp-2);
    border-bottom: 1px solid var(--c-line, #e5e5e5);
  }
  .title {
    font-weight: 600;
    font-size: var(--ts-md, 15px);
  }
  .sub {
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    margin-top: 2px;
  }
  .badges {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .badge {
    font-size: var(--ts-xs, 11px);
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--c-line-strong, #ccc);
  }
  .badge.warn {
    color: var(--c-or, #bc5215);
    border-color: currentColor;
  }
  .badge.ok {
    color: var(--c-gr, #66800b);
    border-color: currentColor;
  }
  .badge.todo {
    color: var(--c-tx-2);
  }
  .body {
    overflow: auto;
    padding: var(--sp-2) var(--sp-4);
  }
  details {
    margin: var(--sp-2) 0;
  }
  summary {
    cursor: var(--cursor-cross-hover);
    font-size: var(--ts-sm);
    font-weight: 600;
    color: var(--c-tx-1, inherit);
  }
  .count {
    font-weight: 400;
    color: var(--c-tx-3, #999);
    margin-left: 4px;
  }
  ul {
    list-style: none;
    margin: var(--sp-1) 0 0;
    padding: 0;
  }
  li {
    display: flex;
    gap: 8px;
    font-size: var(--ts-sm);
    line-height: 1.45;
    padding: 2px 0;
  }
  .mark {
    flex: 0 0 14px;
    text-align: center;
    color: var(--c-tx-3, #999);
  }
  li.warn .mark {
    color: var(--c-or, #bc5215);
    font-weight: 700;
  }
  li.done .mark {
    color: var(--c-gr, #66800b);
  }
  .advisory {
    font-size: var(--ts-xs, 11px);
    color: var(--c-tx-3, #999);
    margin: var(--sp-2) 0;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--c-line, #e5e5e5);
  }
  .ghost,
  .primary {
    padding: var(--sp-1) var(--sp-3);
    border-radius: 6px;
    font: inherit;
    font-size: var(--ts-sm);
    cursor: var(--cursor-cross-hover);
  }
  .ghost {
    border: 1px solid var(--c-line, #ddd);
    background: transparent;
    color: inherit;
  }
  .primary {
    border: 1px solid var(--c-accent-bright);
    background: var(--c-accent-bright);
    color: var(--c-bg);
  }
  .notes {
    margin-right: auto;
    font-size: var(--ts-xs, 11px);
    color: var(--c-tx-3, #999);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
