<script lang="ts">
  // FluxReader — the PDF reading mode shell. Everything scoped to ONE open paper lives
  // in ReaderDoc.svelte (mounted per open document); this shell owns what is shared
  // across documents: the empty state and the persistent terminal pane (terminalSession
  // — the SAME shell the Paper margin mounts), which must have exactly one mount.
  import { tick } from "svelte";
  import { readerKey } from "./readerStore";
  import ReaderDoc from "./ReaderDoc.svelte";
  import TerminalPane from "../../terminal/TerminalPane.svelte";
  import { prefill as terminalPrefill } from "../../terminal/terminalSession";

  let { focused = true }: { focused?: boolean } = $props();

  // R3 (terminal-first rework): "Ask AI" opens the shared terminal and PREFILLS
  // a question about the passage — never submits. Run whatever agent you like
  // there (`flux principal` typically); the quote grounds it, and the live
  // context file / MCP get_reading_context carry the full reader state.
  let agentOpen = $state(false);
  async function askAgent(prefix: string, quote: string) {
    agentOpen = true;
    await tick(); // mount the terminal pane before prefilling
    const q = quote.length > 220 ? quote.slice(0, 220) + "…" : quote;
    terminalPrefill(`${prefix} "${q}" —`);
  }
</script>

<div class="reader">
  {#if !$readerKey}
    <div class="empty">
      <span class="h">FluxReader</span>
      <span>Open a paper from the Library (the “Read” action) to start reading.</span>
    </div>
  {:else}
    {#key $readerKey}
      <ReaderDoc
        citekey={$readerKey}
        active
        {focused}
        {agentOpen}
        onToggleAgent={() => (agentOpen = !agentOpen)}
        onAsk={askAgent}>
        {#snippet agentPane()}
          <div class="agentpane">
            <div class="agentpane-bar">
              <span class="agentpane-title">Terminal</span>
              <span class="agentpane-hint">run `flux principal` here — Ask AI prefills questions</span>
              <button class="agentpane-close" onclick={() => (agentOpen = false)} title="Ctrl+J">Close</button>
            </div>
            <TerminalPane />
          </div>
        {/snippet}
      </ReaderDoc>
    {/key}
  {/if}
</div>

<style>
  .reader {
    position: absolute;
    inset: 0;
    background: var(--c-bg);
  }
  .agentpane {
    position: relative;
    flex: 0 0 42%;
    min-height: 140px;
    border-top: 1px solid var(--c-line-strong);
    display: flex;
    flex-direction: column;
  }
  .agentpane-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 10px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-surface);
  }
  .agentpane-title {
    font-size: var(--ts-xs, 11px);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--c-tx-faint);
  }
  .agentpane-hint {
    font-size: var(--ts-xs, 11px);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .agentpane-close {
    margin-left: auto;
    font: inherit;
    font-size: var(--ts-xs, 11px);
    background: none;
    border: 1px solid var(--c-edge);
    border-radius: var(--r-1, 4px);
    color: var(--c-tx-2);
    padding: 1px 8px;
    cursor: pointer;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
    text-align: center;
    padding: var(--sp-5);
  }
  .empty .h {
    font-family: var(--font-serif);
    font-size: var(--ts-lg);
    color: var(--c-tx-2);
    font-style: italic;
  }
</style>
