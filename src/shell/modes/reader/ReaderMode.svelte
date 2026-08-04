<script lang="ts">
  // FluxReader — the PDF reading mode shell. Everything scoped to ONE open paper lives
  // in ReaderDoc.svelte (one instance per live tab); this shell owns what is shared
  // across documents: the tab strip, the keep-alive policy, the tab keyboard, the
  // empty state, and the persistent terminal pane (terminalSession — the SAME shell
  // the Paper margin mounts), which must have exactly one mount.
  import { tick, untrack } from "svelte";
  import {
    readerTabs,
    paneActiveTab,
    readerTerminalPane,
    activateReaderTab,
    closeReaderTab,
    cycleReaderTab,
    openReaderTabInSplit,
  } from "./readerStore";
  import ReaderDoc from "./ReaderDoc.svelte";
  import ReaderTabs from "./ReaderTabs.svelte";
  import TerminalPane from "../../terminal/TerminalPane.svelte";
  import { prefill as terminalPrefill } from "../../terminal/terminalSession";

  let { focused = true, paneId = "" }: { focused?: boolean; paneId?: string } = $props();

  const tabs = $derived($readerTabs.tabs);
  // This pane's shown paper: its own assignment when split panes have diverged,
  // else the global active (single-pane common case).
  const activeKey = $derived($paneActiveTab[paneId] ?? $readerTabs.active);

  // Keep-alive: the active document plus the most recently viewed others stay
  // mounted (hidden ModeContent-style — visibility flip, so switching among warm
  // tabs is instantaneous); older tabs render nothing and cold-reopen through the
  // flux-reader-view restore. The cap bounds the real cost — each live doc holds
  // its PDF bytes (up to ~3× the file: doc buffer + PdfView's copy + the worker
  // transfer) plus a pdf.js worker — while the tab COUNT stays uncapped.
  const MAX_LIVE_DOCS = 3;
  let liveKeys = $state<string[]>([]);
  $effect(() => {
    const k = activeKey;
    const open = new Set(tabs.map((t) => t.key));
    const cur = untrack(() => liveKeys);
    let next = cur.filter((x) => open.has(x)); // closed tabs release their instance
    if (k && open.has(k)) {
      next = next.filter((x) => x !== k);
      next.push(k); // MRU order, active last
      while (next.length > MAX_LIVE_DOCS) next.shift();
    }
    if (next.length !== cur.length || next.some((x, i) => x !== cur[i])) liveKeys = next;
  });

  // R3 (terminal-first rework): "Ask AI" opens the shared terminal and PREFILLS
  // a question about the passage — never submits. Run whatever agent you like
  // there (`flux principal` typically); the quote grounds it, and the live
  // context file / MCP get_reading_context carry the full reader state.
  // The terminal session has ONE detached host div, so exactly one reader pane
  // hosts it at a time (readerTerminalPane) — opening it here closes it there.
  const agentOpen = $derived($readerTerminalPane === paneId);
  function toggleAgent() {
    readerTerminalPane.update((id) => (id === paneId ? null : paneId));
  }
  async function askAgent(prefix: string, quote: string) {
    readerTerminalPane.set(paneId);
    await tick(); // mount the terminal pane before prefilling
    const q = quote.length > 220 ? quote.slice(0, 220) + "…" : quote;
    terminalPrefill(`${prefix} "${q}" —`);
  }

  // Tab chords. ReaderDoc's own handler never claims these (its ctrl branch is
  // F/J only; its bare PageUp/Down branch requires no modifier), so the two
  // window listeners stay disjoint. Ctrl only — on macOS Cmd+W stays the app
  // menu's close-window.
  function onShellKey(e: KeyboardEvent) {
    if (!focused) return; // kept-alive hidden panes must not react
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (!ctrl) return;
    if (e.key === "Tab") {
      e.preventDefault();
      cycleReaderTab(e.shiftKey ? -1 : 1, paneId);
    } else if (!e.shiftKey && (e.key === "PageDown" || e.key === "PageUp")) {
      e.preventDefault();
      cycleReaderTab(e.key === "PageDown" ? 1 : -1, paneId);
    } else if (!e.shiftKey && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      if (activeKey) closeReaderTab(activeKey);
    }
  }
</script>

<svelte:window onkeydown={onShellKey} />

<div class="reader">
  {#if !tabs.length}
    <div class="empty">
      <span class="h">FluxReader</span>
      <span>Open a paper from the Library (the “Read” action) to start reading.</span>
    </div>
  {:else}
    <ReaderTabs
      {tabs}
      {activeKey}
      onActivate={(k) => activateReaderTab(k, paneId)}
      onClose={closeReaderTab}
      onSplit={openReaderTabInSplit} />
    <div class="docs">
      {#each liveKeys as key (key)}
        <div class="docslot" class:hidden={key !== activeKey} inert={key !== activeKey}>
          <ReaderDoc
            citekey={key}
            active={key === activeKey}
            focused={focused && key === activeKey}
            {agentOpen}
            onToggleAgent={toggleAgent}
            onAsk={askAgent}>
            {#snippet agentPane()}
              <div class="agentpane">
                <div class="agentpane-bar">
                  <span class="agentpane-title">Terminal</span>
                  <span class="agentpane-hint">run `flux principal` here — Ask AI prefills questions</span>
                  <button class="agentpane-close" onclick={() => readerTerminalPane.set(null)} title="Ctrl+J">Close</button>
                </div>
                <TerminalPane />
              </div>
            {/snippet}
          </ReaderDoc>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .reader {
    position: absolute;
    inset: 0;
    background: var(--c-bg);
    display: flex;
    flex-direction: column;
  }
  .docs {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .docslot {
    position: absolute;
    inset: 0;
  }
  /* visibility:hidden (not display:none) keeps the box laid out so pdf.js viewer
     geometry survives being backgrounded; inert (markup) blocks focus + input. */
  .docslot.hidden {
    visibility: hidden;
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
