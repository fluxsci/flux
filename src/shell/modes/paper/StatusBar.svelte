<script lang="ts">
  // Persistent, glanceable status — a slim translucent pill bottom-right of
  // the editor column (Obsidian's placement). Dumb component: PaperMode feeds
  // it already-computed values (words from the 150ms-debounced latestIdle —
  // nothing here touches the typing hot path). Vim's mode indicator lives in
  // vim's own bottom panel, not here.
  let {
    words,
    status,
    onStats,
    onExport,
    exporting = false,
  }: {
    words: number;
    status: "demo" | "saved" | "saving" | "error";
    onStats: () => void;
    onExport: () => void;
    exporting?: boolean;
  } = $props();
</script>

<div class="statusbar">
  <button class="seg" onclick={onExport} disabled={exporting} title="Export — PDF · HTML · Word (also in ⌘K)">
    {exporting ? "Exporting…" : "Export"}
  </button>
  <button class="seg" onclick={onStats} title="Statistics (⌘K → Statistics)">
    {words.toLocaleString()} words
  </button>
  {#if status !== "saved"}
    <span class="seg state" class:error={status === "error"}>
      {status === "saving" ? "saving…" : status}
    </span>
  {/if}
</div>

<style>
  .statusbar {
    position: absolute;
    right: 14px;
    bottom: 10px;
    transition: bottom var(--dur-instant) var(--ease-standard);
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--c-surface) 85%, transparent);
    backdrop-filter: blur(3px);
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    pointer-events: none;
  }
  /* Vim's bottom status panel spans the column and would cover the pill —
     ride above it whenever the panel is in the DOM. */
  :global(.editor-col:has(.cm-vim-panel)) .statusbar {
    bottom: 36px;
  }
  .seg {
    pointer-events: auto;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    padding: 2px 7px;
    border-radius: var(--r-pill);
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .seg:hover:not(:disabled) {
    color: var(--c-tx-2);
    background: var(--c-surface);
  }
  .seg:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .state {
    cursor: default;
    pointer-events: none;
  }
  .state.error {
    color: var(--c-danger);
  }
</style>
