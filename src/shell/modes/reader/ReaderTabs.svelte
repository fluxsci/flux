<script lang="ts">
  // The reader's tab strip — one slim row above the document. Pure presentation:
  // the tab list + active key come in as props, every mutation goes back through
  // callbacks (readerStore owns the semantics). Labels come from the live FluxLib
  // mirror (fluxLibEntries) and fall back to the citekey until it populates.
  import { fluxLibEntries } from "../../../lib/references/revision";
  import type { ReaderTab } from "./readerStore";

  let {
    tabs,
    activeKey,
    onActivate,
    onClose,
    onSplit,
  }: {
    tabs: ReaderTab[];
    activeKey: string | null;
    onActivate: (key: string) => void;
    onClose: (key: string) => void;
    /** Alt/Cmd-click a tab → open it in the other pane (titlebar split convention). */
    onSplit?: (key: string) => void;
  } = $props();

  const titleByKey = $derived(new Map($fluxLibEntries.map((e) => [e.key, e.title])));
  const label = (key: string) => titleByKey.get(key) || key;
</script>

<div class="rtabs" data-testid="reader-tabs" role="tablist" aria-label="Open papers">
  {#each tabs as t (t.key)}
    <div class="rtab" class:on={t.key === activeKey} data-key={t.key}>
      <button
        class="rtab-main"
        role="tab"
        aria-selected={t.key === activeKey}
        title={`${label(t.key)}  (Alt-click: open in split)`}
        onclick={(e) => (e.altKey || e.metaKey ? (onSplit ?? onActivate)(t.key) : onActivate(t.key))}
        onauxclick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose(t.key);
          }
        }}>{label(t.key)}</button>
      <button
        class="rtab-x"
        title="Close (Ctrl+W)"
        aria-label={`Close ${label(t.key)}`}
        onclick={() => onClose(t.key)}>×</button>
    </div>
  {/each}
</div>

<style>
  .rtabs {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 8px 0;
    background: var(--c-surface);
    border-bottom: 1px solid var(--c-line);
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .rtab {
    flex: 0 1 auto;
    display: flex;
    align-items: center;
    min-width: 72px;
    max-width: 220px;
    border: 1px solid var(--c-line);
    border-bottom: none;
    border-radius: var(--r-1) var(--r-1) 0 0;
    background: var(--c-bg);
    color: var(--c-tx-2);
  }
  .rtab.on {
    border-color: var(--c-line-strong);
    background: var(--c-bg-raised, var(--c-bg));
    color: var(--c-tx-1);
    box-shadow: inset 0 2px 0 var(--c-accent);
  }
  .rtab-main {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: var(--ts-xs);
    text-align: left;
    padding: 4px 2px 4px 9px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .rtab-x {
    flex: 0 0 auto;
    border: none;
    background: none;
    color: var(--c-tx-faint);
    font: inherit;
    font-size: var(--ts-sm);
    line-height: 1;
    padding: 2px 7px 2px 3px;
    cursor: pointer;
    border-radius: var(--r-1);
  }
  .rtab-x:hover {
    color: var(--c-danger);
  }
</style>
