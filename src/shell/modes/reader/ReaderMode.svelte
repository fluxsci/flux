<script lang="ts">
  import { yieldsToShellModal, isAnnotateChord } from "../../agent/annotateChord";

  // FluxReader — the PDF reading mode shell. Everything scoped to ONE open paper lives
  // in ReaderDoc.svelte (one instance per live tab); this shell owns what is shared
  // across documents: the tab strip, the keep-alive policy, the tab keyboard, the
  // empty state.
  import { untrack } from "svelte";
  import {
    readerTabs,
    paneActiveTab,
    activateReaderTab,
    closeReaderTab,
    cycleReaderTab,
    openReaderTabInSplit,
    moveReaderTab,
  } from "./readerStore";
  import ReaderDoc from "./ReaderDoc.svelte";
  import ReaderTabs from "./ReaderTabs.svelte";

  let { focused = true, paneId = "" }: { focused?: boolean; paneId?: string } = $props();

  const tabs = $derived($readerTabs.tabs);
  // This pane's shown paper: its own assignment when split panes have diverged,
  // else the global active (single-pane common case).
  const activeKey = $derived($paneActiveTab[paneId] ?? $readerTabs.active);

  // Keep-alive: the active document plus the most recently viewed others stay
  // mounted (hidden ModeContent-style — visibility flip, so switching among warm
  // tabs is instantaneous); older tabs render nothing and cold-reopen through the
  // flux-reader-view restore. The cap bounds the real cost — each live doc costs
  // ~2× its file size (the doc's master buffer, plus the copy PdfView TRANSFERS to
  // its worker: pdf.js sends `data.buffer` in the postMessage transfer list, which
  // detaches it, which is exactly why the master is copied first) plus a pdf.js
  // worker and its live page canvases — while the tab COUNT stays uncapped.
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

  // Tab chords. ReaderDoc's own handler never claims these (its ctrl branch is
  // F and B/Shift+B; its bare PageUp/Down branch requires no modifier), so the two
  // window listeners stay disjoint. Ctrl only — on macOS Cmd+W stays the app
  // menu's close-window.
  function onShellKey(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
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
      onSplit={openReaderTabInSplit}
      onMove={moveReaderTab} />
    <div class="docs">
      {#each liveKeys as key (key)}
        <div class="docslot" class:hidden={key !== activeKey} inert={key !== activeKey}>
          <ReaderDoc
            {paneId}
            citekey={key}
            active={key === activeKey}
            focused={focused && key === activeKey} />
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
