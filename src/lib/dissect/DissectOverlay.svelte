<script lang="ts">
  import { yieldsToShellModal, isAnnotateChord } from "../../shell/agent/annotationVisibility";

  // The Dissect viewer (plain `d` on a selected plot): full-screen overlay by default,
  // shrinkable to a draggable/resizable floating window (the FigurePanel chrome), showing a
  // plot's companion material from plots/_dissections/<key>/ in the Plots rail's sections
  // (Summary tables, one section per group, Other files; DissectSections). Grid → Enter →
  // detail (zoom/pan for images, a real table for CSV/TSV). The keyboard is modal while open (keyboard.ts yields; this handler runs in
  // the capture phase so canvas-level window listeners never see swallowed keys — except
  // Space, which the detail's hand tool owns). Live: a watcher bump on the dissections
  // subsystem re-lists in place, keeping the selection by name.
  import { onDestroy } from "svelte";
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
  import DissectSections, { zoomDissectRows } from "./DissectSections.svelte";
  import { arrangeDissections } from "../plotsRail/dissectionsModel";
  import DissectDetail from "./DissectDetail.svelte";
  import PlotNotes from "./PlotNotes.svelte";

  const LAYOUT_KEY = "flux-dissect-layout";
  interface Layout {
    mode: "full" | "win";
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const defaults: Layout = { mode: "full", x: 90, y: 70, w: 940, h: 640 };
  function loadLayout(): Layout {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p === "object" ? { mode: p.mode === "win" ? "win" : "full", x: +p.x || defaults.x, y: +p.y || defaults.y, w: +p.w || defaults.w, h: +p.h || defaults.h } : { ...defaults };
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

  let listing = $state.raw<DissectListing | null>(null);
  // Files are named by group + name: a re-list keeps them across fresh absolute paths.
  type Ref = { group: string; name: string };
  let selectedRef = $state.raw<Ref | null>(null);
  let detailAt = $state.raw<Ref | null>(null);
  let notesOpen = $state(false);
  let sectionsRef = $state<ReturnType<typeof DissectSections> | null>(null);
  let detailView = $state<{ toggleFit: () => void; zoomBy: (f: number) => void; resetZoom: () => void } | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  const target = $derived($dissectTarget);
  const sections = $derived(arrangeDissections(listing));
  const files = $derived(sections.flatMap((sec) => sec.files));
  const relPath = $derived(target ? `plots/_dissections/${target.key}/` : "");
  const find = (r: Ref | null) => (r ? files.find((f) => f.group === r.group && f.name === r.name) ?? files.find((f) => f.name === r.name) ?? null : null);
  const selectedFile = $derived(find(selectedRef) ?? files[0] ?? null);
  const detailFile = $derived(find(detailAt));
  const detailPos = $derived(detailFile ? files.indexOf(detailFile) : 0);

  let refreshEpoch = 0;
  onDestroy(() => { refreshEpoch++; });
  async function refresh() {
    const t = target, epoch = ++refreshEpoch, root = dissectRoot();
    if (!t) return;
    let next: DissectListing;
    try { next = await listDissections(root, t.key); } catch { return; }
    if (epoch !== refreshEpoch || target !== t || dissectRoot() !== root) return; // switched/closed while listing
    listing = next;
    // The open file vanished → back to the grid.
    if (detailAt && !find(detailAt)) detailAt = null;
  }

  // Open / retarget: fresh listing, top of the first group.
  let lastKey: string | null = null;
  $effect(() => {
    const t = target;
    if (!t) {
      refreshEpoch++;
      lastKey = null;
      listing = null;
      detailAt = null;
      return;
    }
    const identity = `${dissectRoot()}\0${t.key}\0${t.initial ? `${t.initial.group}/${t.initial.name}` : ""}`;
    if (identity === lastKey) return;
    lastKey = identity;
    listing = null;
    notesOpen = false;
    // Opened on a file (the Plots rail): land in its detail view.
    selectedRef = t.initial ?? null;
    detailAt = t.initial ?? null;
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
    void refresh();
  });

  function close() {
    closeDissect();
  }
  const refOf = (f: DissectFile & { group: string }): Ref => ({ group: f.group, name: f.name });
  function openDetail(f: DissectFile & { group: string }) {
    selectedRef = detailAt = refOf(f);
  }
  function backToGrid() {
    detailAt = null;
    queueMicrotask(() => { if (selectedFile) sectionsRef?.reveal(selectedFile.abs); });
  }
  function showNotes() {
    notesOpen = true;
    detailAt = null;
  }
  async function createFolder() {
    const t = target;
    if (!t) return;
    await createDissectionRoot(dissectRoot(), t.key);
    await refresh();
  }

  // ---- modal keyboard (capture phase; Space passes through to the detail's hand tool) ----
  function onKeyDown(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if (!target) return;
    if (e.code === "Space" && detailFile) return; // the hand tool owns held-Space
    if (e.key === "Alt" || e.key === "Control" || e.key === "Shift" || e.key === "Meta") return;
    const typing = (e.target as HTMLElement | null)?.closest("input,textarea,select,[contenteditable='true']");
    if (typing) return;
    e.stopPropagation();
    const inDetail = !!detailFile;
    if (e.key === "Escape") {
      e.preventDefault();
      inDetail ? backToGrid() : close();
      return;
    }
    if (notesOpen) return;
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      detailAt = null;
      sectionsRef?.jumpTo(Number(e.key) - 1);
      return;
    }
    if (inDetail) {
      if (e.key === "ArrowLeft" && detailPos > 0) openDetail(files[detailPos - 1]);
      else if (e.key === "ArrowRight" && detailPos < files.length - 1) openDetail(files[detailPos + 1]);
      else if (e.key === "Enter") detailView?.toggleFit();
      else if (e.key === "+" || e.key === "=") detailView?.zoomBy(1.25);
      else if (e.key === "-") detailView?.zoomBy(1 / 1.25);
      else if (e.key === "0") detailView?.resetZoom();
      else return; // unhandled: swallowed (stopPropagation), no preventDefault
      e.preventDefault();
      return;
    }
    if (!files.length) return;
    if (sectionsRef?.navigate(e)) return;
    if ((e.key === "Enter" || e.code === "Space") && selectedFile) openDetail(selectedFile);
    else if (e.key === "[" || e.key === "]") zoomDissectRows(e.key === "]" ? 1 : -1);
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
      {#if listing?.total}<span class="count">{listing.total}</span>{/if}
      <nav class="views" aria-label="Plot companion views">
        <button class:chosen={!notesOpen} aria-pressed={!notesOpen} onclick={() => { notesOpen = false; }}>Files</button>
        <button class:chosen={notesOpen} aria-pressed={notesOpen} aria-label="Plot text notes" onclick={() => notesOpen ? (notesOpen = false) : showNotes()}>✎ Notes</button>
      </nav>
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
      {#if notesOpen}
        <PlotNotes root={dissectRoot()} plotKey={target.key} onChanged={() => void refresh()} />
      {:else if !listing}
        <div class="empty">Loading…</div>
      {:else if listing.groups === null}
        <div class="empty" data-dissect-empty>
          <p>No dissections yet for <b>{target.displayName}</b>.</p>
          <p class="path">{relPath}</p>
          <button class="mkbtn" data-dissect-create onclick={createFolder}>Create dissection folder</button>
          <p class="hint">Drop per-subject panels, alternative analyses, or _stats CSVs there — subfolders become sections.</p>
        </div>
      {:else if listing.total === 0}
        <div class="empty" data-dissect-empty>
          <p>The dissection folder is empty.</p>
          <p class="path">{relPath}</p>
          <p class="hint">Drop images (svg/png) and CSVs there — subfolders become sections. They appear here live.</p>
        </div>
      {:else}
        <DissectSections
          bind:this={sectionsRef}
          {listing}
          selected={selectedFile?.abs ?? ""}
          onSelect={(f) => (selectedRef = refOf(f))}
          onOpen={openDetail} />
        {#if detailFile}
          <DissectDetail
            bind:this={detailView}
            file={detailFile}
            pos={detailPos}
            count={files.length}
            groupName={detailFile.group}
            onClose={backToGrid}
            noteOwner={{ root: dissectRoot(), key: target.key, group: detailFile.group }}
          />
        {/if}
      {/if}
    </div>

    <div class="dfoot">
      {#if notesOpen}
        <span><b>esc</b> close</span>
      {:else if detailFile}
        <span><b>←→</b> prev/next</span>
        {#if detailFile.kind === "image"}
          <span><b>ctrl+scroll</b> zoom</span>
          <span><b>space+drag</b> pan</span>
          <span><b>↵</b> fit/1:1</span>
          <span><b>0</b> reset</span>
        {/if}
        <span><b>esc</b> back</span>
      {:else}
        <span><b>←→↑↓</b> navigate</span>
        <span><b>↵</b> open</span>
        <span><b>[ ]</b> size</span>
        {#if sections.length > 1}<span><b>1–{Math.min(9, sections.length)}</b> section</span>{/if}
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
    font: 12px/1.35 var(--font-ui);
    overflow: hidden;
    z-index: 331;
    box-shadow: var(--elev-3, 0 12px 40px rgba(0, 0, 0, 0.5));
  }
  .dpanel.full {
    position: fixed;
    inset: 14px;
    border-radius: var(--r-panel);
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
    gap: 8px;
    padding: 0 4px 0 10px;
    min-height: 30px;
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
    font: 600 10px var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
  }
  .plot {
    font-size: 12px;
    color: var(--c-tx-hi);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    flex-shrink: 0;
    color: var(--c-tx-faint);
    font: 10.5px var(--font-mono);
  }
  /* Files | Notes: the rail pane's view switch. */
  .views {
    display: flex;
    gap: 2px;
    margin-left: 6px;
  }
  .views button {
    padding: 3px 7px;
    border: 0;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    font: 11px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .views button:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .views .chosen {
    background: var(--c-accent-tint);
    color: var(--c-accent);
  }
  .grow {
    flex: 1;
  }
  .hb {
    border: none;
    background: none;
    color: var(--c-tx-muted);
    cursor: var(--cursor-cross-hover);
    font-size: 14px;
    padding: 2px 6px;
    border-radius: var(--r-1, 4px);
  }
  .hb:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .dbody {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--c-bg-raised);
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
    cursor: var(--cursor-cross-hover);
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
    padding: 5px 10px;
    border-top: 1px solid var(--c-line);
    font: 10.5px var(--font-mono);
    color: var(--c-tx-muted);
  }
  .dfoot b {
    color: var(--c-accent-bright);
  }
</style>
