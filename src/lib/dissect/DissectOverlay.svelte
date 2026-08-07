<script lang="ts">
  // The Dissect viewer (plain `d` on a selected plot): full-screen overlay by default,
  // shrinkable to a draggable/resizable floating window (the FigurePanel chrome), showing a
  // plot's companion material from plots/_dissections/<key>/ — subfolders are group tabs,
  // loose files the default group. Grid → Enter → detail (zoom/pan for images, a real table
  // for CSV/TSV). The keyboard is modal while open (keyboard.ts yields; this handler runs in
  // the capture phase so canvas-level window listeners never see swallowed keys — except
  // Space, which the detail's hand tool owns). Live: a watcher bump on the dissections
  // subsystem re-lists in place, keeping the selection by name.
  import { fade } from "svelte/transition";
  import { dissectTarget, closeDissect, dissectRoot } from "./state";
  import { dissectionsRevision } from "../../shell/scholar/revisions";
  import {
    listDissections,
    createDissectionRoot,
    clearDissectCache,
    type DissectListing,
    type DissectFile,
  } from "./loader";
  import DissectGrid from "./DissectGrid.svelte";
  import DissectDetail from "./DissectDetail.svelte";

  const LAYOUT_KEY = "flux-dissect-layout";
  interface Layout {
    mode: "full" | "win";
    x: number;
    y: number;
    w: number;
    h: number;
    cols: number;
  }
  const defaults: Layout = { mode: "full", x: 90, y: 70, w: 940, h: 640, cols: 4 };
  function loadLayout(): Layout {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p === "object" ? { ...defaults, ...p } : { ...defaults };
    } catch {
      return { ...defaults };
    }
  }
  let layout = $state<Layout>(loadLayout());
  // Persist debounced — a header drag writes layout per mousemove.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const json = JSON.stringify({ ...layout });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, json);
      } catch {}
    }, 300);
  });

  let listing = $state<DissectListing | null>(null);
  let groupIdx = $state(0);
  let selectedIdx = $state(0);
  let detailIdx = $state<number | null>(null);
  let detailRef = $state<{ toggleFit: () => void; zoomBy: (f: number) => void; resetZoom: () => void } | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  const target = $derived($dissectTarget);
  const groups = $derived(listing?.groups ?? null);
  const group = $derived(groups && groups.length ? groups[Math.min(groupIdx, groups.length - 1)] : null);
  const files = $derived<DissectFile[]>(group?.files ?? []);
  const relPath = $derived(target ? `plots/_dissections/${target.key}/` : "");
  const detailFile = $derived(detailIdx !== null && files[detailIdx] ? files[detailIdx] : null);

  async function refresh(keepBy?: { sel?: string; detail?: string; group?: string }) {
    const t = target;
    if (!t) return;
    const next = await listDissections(dissectRoot(), t.key);
    if (target !== t) return; // switched/closed while listing
    listing = next;
    const gs = next.groups ?? [];
    const gi = keepBy?.group ? gs.findIndex((g) => g.name === keepBy.group) : -1;
    groupIdx = gi >= 0 ? gi : Math.min(groupIdx, Math.max(0, gs.length - 1));
    const fs = gs[groupIdx]?.files ?? [];
    const si = keepBy?.sel ? fs.findIndex((f) => f.name === keepBy.sel) : -1;
    selectedIdx = si >= 0 ? si : Math.min(selectedIdx, Math.max(0, fs.length - 1));
    if (detailIdx !== null) {
      const di = keepBy?.detail ? fs.findIndex((f) => f.name === keepBy.detail) : -1;
      detailIdx = di >= 0 ? di : null; // the open file vanished → back to the grid
    }
  }

  // Open / retarget: fresh listing, top of the first group.
  let lastKey: string | null = null;
  $effect(() => {
    const t = target;
    if (!t) {
      lastKey = null;
      listing = null;
      detailIdx = null;
      return;
    }
    if (t.key === lastKey) return;
    lastKey = t.key;
    listing = null;
    groupIdx = 0;
    selectedIdx = 0;
    detailIdx = null;
    void refresh();
  });

  // Live: external writes under _dissections bump the revision → re-list in place,
  // fresh bytes (the LRU would otherwise serve the stale image).
  let lastRev: number | null = null;
  $effect(() => {
    const rev = $dissectionsRevision;
    if (!target) {
      lastRev = rev;
      return;
    }
    if (lastRev === null || rev === lastRev) {
      lastRev = rev;
      return;
    }
    lastRev = rev;
    clearDissectCache();
    void refresh({
      group: group?.name,
      sel: files[selectedIdx]?.name,
      detail: detailFile?.name ?? undefined,
    });
  });

  function close() {
    closeDissect();
  }
  function openDetail(i: number) {
    selectedIdx = i;
    detailIdx = i;
  }
  function backToGrid() {
    detailIdx = null;
  }
  function switchGroup(i: number) {
    if (!groups || i < 0 || i >= groups.length || i === groupIdx) return;
    groupIdx = i;
    selectedIdx = 0;
    detailIdx = null;
  }
  async function createFolder() {
    const t = target;
    if (!t) return;
    await createDissectionRoot(dissectRoot(), t.key);
    await refresh();
  }

  // ---- modal keyboard (capture phase; Space passes through to the detail's hand tool) ----
  function onKeyDown(e: KeyboardEvent) {
    if (!target) return;
    if (e.code === "Space" && detailIdx !== null) return; // the hand tool owns held-Space
    if (e.key === "Alt" || e.key === "Control" || e.key === "Shift" || e.key === "Meta") return;
    e.stopPropagation();
    const inDetail = detailIdx !== null;
    if (e.key === "Escape") {
      e.preventDefault();
      inDetail ? backToGrid() : close();
      return;
    }
    if (/^[1-9]$/.test(e.key) && groups && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      switchGroup(Number(e.key) - 1);
      return;
    }
    if (inDetail) {
      if (e.key === "ArrowLeft" && detailIdx! > 0) openDetail(detailIdx! - 1);
      else if (e.key === "ArrowRight" && detailIdx! < files.length - 1) openDetail(detailIdx! + 1);
      else if (e.key === "Enter") detailRef?.toggleFit();
      else if (e.key === "+" || e.key === "=") detailRef?.zoomBy(1.25);
      else if (e.key === "-") detailRef?.zoomBy(1 / 1.25);
      else if (e.key === "0") detailRef?.resetZoom();
      else return; // unhandled: swallowed (stopPropagation), no preventDefault
      e.preventDefault();
      return;
    }
    const n = files.length;
    if (!n) return;
    const cols = layout.cols;
    if (e.key === "ArrowLeft") selectedIdx = Math.max(0, selectedIdx - 1);
    else if (e.key === "ArrowRight") selectedIdx = Math.min(n - 1, selectedIdx + 1);
    else if (e.key === "ArrowUp") selectedIdx = Math.max(0, selectedIdx - cols);
    else if (e.key === "ArrowDown") selectedIdx = Math.min(n - 1, selectedIdx + cols);
    else if (e.key === "Home") selectedIdx = 0;
    else if (e.key === "End") selectedIdx = n - 1;
    else if (e.key === "Enter" || e.code === "Space") openDetail(selectedIdx);
    else if (e.key === "[") layout.cols = Math.max(1, layout.cols - 1);
    else if (e.key === "]") layout.cols = Math.min(8, layout.cols + 1);
    else return;
    e.preventDefault();
  }
  $effect(() => {
    if (!target) return;
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  });

  // ---- window-mode chrome: drag by header, CSS resize persisted via RO -------------------
  let drag: { dx: number; dy: number } | null = null;
  function headerDown(e: MouseEvent) {
    if (layout.mode !== "win") return;
    drag = { dx: e.clientX - layout.x, dy: e.clientY - layout.y };
    e.preventDefault();
  }
  function windowMove(e: MouseEvent) {
    if (!drag) return;
    layout.x = Math.min(Math.max(e.clientX - drag.dx, 8), window.innerWidth - 120);
    layout.y = Math.min(Math.max(e.clientY - drag.dy, 34), window.innerHeight - 60);
  }
  const windowUp = () => (drag = null);
  $effect(() => {
    const el = panelEl;
    if (!el || layout.mode !== "win") return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      if (w && h && (w !== layout.w || h !== layout.h)) {
        layout.w = w;
        layout.h = h;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<svelte:window onmousemove={windowMove} onmouseup={windowUp} />

{#if target}
  {#if layout.mode === "full"}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dbackdrop" data-dissect-backdrop transition:fade={{ duration: 110 }} onpointerdown={close}></div>
  {/if}
  <div
    class="dpanel"
    class:full={layout.mode === "full"}
    class:win={layout.mode === "win"}
    data-dissect
    bind:this={panelEl}
    style={layout.mode === "win"
      ? `left:${layout.x}px; top:${layout.y}px; width:${layout.w}px; height:${layout.h}px;`
      : ""}
    role="dialog"
    aria-modal={layout.mode === "full"}
    aria-label="Dissections of {target.displayName}"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dhead" class:draggable={layout.mode === "win"} onmousedown={headerDown}>
      <span class="ttl">Dissect</span>
      <span class="plot" title={relPath}>{target.displayName}</span>
      {#if groups && groups.length > 0}
        <span class="tabs">
          {#each groups as g, i}
            <button class="tab" class:cur={i === groupIdx} data-dissect-tab={g.name || "·"} onclick={() => switchGroup(i)}>
              {g.name || "·"}<span class="cnt">{g.files.length}</span>
            </button>
          {/each}
        </span>
      {/if}
      <span class="grow"></span>
      <button
        class="hb"
        title={layout.mode === "full" ? "Shrink to a window" : "Expand to full screen"}
        onclick={() => (layout.mode = layout.mode === "full" ? "win" : "full")}
      >
        {layout.mode === "full" ? "⧉" : "⛶"}
      </button>
      <button class="hb" title="Close (Esc)" onclick={close}>✕</button>
    </div>

    <div class="dbody">
      {#if !listing}
        <div class="empty">Loading…</div>
      {:else if listing.groups === null}
        <div class="empty" data-dissect-empty>
          <p>No dissections yet for <b>{target.displayName}</b>.</p>
          <p class="path">{relPath}</p>
          <button class="mkbtn" data-dissect-create onclick={createFolder}>Create dissection folder</button>
          <p class="hint">Drop per-subject panels, alternative analyses, or _stats CSVs there — subfolders become tabs.</p>
        </div>
      {:else if listing.total === 0}
        <div class="empty" data-dissect-empty>
          <p>The dissection folder is empty.</p>
          <p class="path">{relPath}</p>
          <p class="hint">Drop images (svg/png) and CSVs there — subfolders become tabs. They appear here live.</p>
        </div>
      {:else}
        <DissectGrid {files} cols={layout.cols} {selectedIdx} onSelect={(i) => (selectedIdx = i)} onOpen={openDetail} />
        {#if detailFile}
          <DissectDetail
            bind:this={detailRef}
            file={detailFile}
            pos={detailIdx ?? 0}
            count={files.length}
            groupName={group?.name ?? ""}
            onClose={backToGrid}
          />
        {/if}
      {/if}
    </div>

    <div class="dfoot">
      {#if detailIdx !== null}
        <span><b>←→</b> prev/next</span>
        {#if detailFile?.kind === "image"}
          <span><b>ctrl+scroll</b> zoom</span>
          <span><b>space+drag</b> pan</span>
          <span><b>↵</b> fit/1:1</span>
          <span><b>0</b> reset</span>
        {/if}
        <span><b>esc</b> grid</span>
      {:else}
        <span><b>←→↑↓</b> navigate</span>
        <span><b>↵</b> open</span>
        <span><b>[ ]</b> columns</span>
        {#if (groups?.length ?? 0) > 1}<span><b>1–9</b> tab</span>{/if}
        <span><b>esc</b> close</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .dbackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.32);
    z-index: 330;
  }
  .dpanel {
    display: flex;
    flex-direction: column;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    font-family: var(--font-serif);
    overflow: hidden;
    z-index: 331;
    box-shadow: var(--elev-3, 0 12px 40px rgba(0, 0, 0, 0.5));
  }
  .dpanel.full {
    position: fixed;
    inset: 14px;
    border-radius: var(--r-3, 10px);
  }
  .dpanel.win {
    position: fixed;
    min-width: 380px;
    min-height: 260px;
    max-width: 96vw;
    max-height: 94vh;
    border-radius: var(--r-2, 8px);
    resize: both;
  }
  .dhead {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
    user-select: none;
  }
  .dhead.draggable {
    cursor: grab;
  }
  .dhead.draggable:active {
    cursor: grabbing;
  }
  .ttl {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
  }
  .plot {
    font-size: 15px;
    color: var(--c-tx-hi);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--c-line);
    background: none;
    color: var(--c-tx-2);
    border-radius: 999px;
    padding: 2px 10px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab:hover {
    border-color: var(--c-line-strong);
  }
  .tab.cur {
    border-color: var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent-bright);
  }
  .cnt {
    font-size: 10px;
    color: var(--c-tx-muted);
  }
  .tab.cur .cnt {
    color: var(--c-accent-bright);
  }
  .grow {
    flex: 1;
  }
  .hb {
    border: none;
    background: none;
    color: var(--c-tx-muted);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: var(--r-1, 4px);
  }
  .hb:hover {
    color: var(--c-accent-bright);
  }
  .dbody {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--c-tx-muted);
    text-align: center;
    padding: 24px;
  }
  .empty b {
    color: var(--c-tx);
  }
  .path {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--c-accent-bright);
    user-select: text;
  }
  .hint {
    font-size: 12px;
    font-style: italic;
    max-width: 420px;
  }
  .mkbtn {
    margin-top: 4px;
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    padding: 6px 14px;
  }
  .mkbtn:hover {
    background: var(--c-accent-bright);
  }
  .dfoot {
    flex: 0 0 auto;
    display: flex;
    gap: 16px;
    padding: 7px 14px;
    border-top: 1px solid var(--c-line);
    font-size: 12px;
    color: var(--c-tx-muted);
  }
  .dfoot b {
    color: var(--c-accent-bright);
  }
</style>
