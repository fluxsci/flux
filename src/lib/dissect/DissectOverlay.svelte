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
  //
  // 2026-11-18 rebuild (owner: "BOTH the visual design/appearance AND the UI/UX and
  // features/functionality could be so much better! … roladexes to view dissection plots,
  // better formatting for tables, stats, notes"):
  //   · an open file has the ROLODEX under it (DissectFilmstrip): every file of the plot in
  //     one strip, the open one in the middle; ← / → flip, ↑ / ↓ step a whole group, Home / End
  //     and 1–9 jump, all without leaving the open view;
  //   · tables read like results (format.ts, DissectTable): rounded numbers with the file's
  //     own text one click away, p-value marks, and test results as copyable sentences;
  //   · notes are a page to write on (PlotNotes, roomy);
  //   · the chrome is the house's: serif words, mono eyebrows, key caps, hairlines.
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
  import { groupLabel, keyStem } from "./names";
  import DissectDetail from "./DissectDetail.svelte";
  import DissectFilmstrip from "./DissectFilmstrip.svelte";
  import PlotNotes from "./PlotNotes.svelte";
  import type { DissectionImageSize } from "../plotsRail/dissectionsModel";

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
  // The opened view is where the viewer starts (owner, 2026-11-18: "make this view the default").
  // Esc pops ONE level: a file reached from the grid goes back to the grid; the file the viewer
  // opened on, or one flipped to from it, closes the viewer.
  let fromGrid = $state(false);
  let landing = false; // the next listing should open its first picture
  let notesOpen = $state(false);
  let sectionsRef = $state<ReturnType<typeof DissectSections> | null>(null);
  let detailView = $state<{ toggleFit: () => void; zoomBy: (f: number) => void; resetZoom: () => void } | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);
  let imageSizes = $state.raw<Map<string, DissectionImageSize>>(new Map());
  let detailZoom = $state("fit");

  const target = $derived($dissectTarget);
  const sections = $derived(arrangeDissections(listing));
  const files = $derived(sections.flatMap((sec) => sec.files));
  const relPath = $derived(target ? `plots/_dissections/${target.key}/` : "");
  const find = (r: Ref | null) => (r ? files.find((f) => f.group === r.group && f.name === r.name) ?? files.find((f) => f.name === r.name) ?? null : null);
  const selectedFile = $derived(find(selectedRef) ?? files[0] ?? null);
  const detailFile = $derived(find(detailAt));
  const detailPos = $derived(detailFile ? files.indexOf(detailFile) : 0);
  const detailSection = $derived(detailFile ? sections.findIndex((sec) => sec.files.includes(detailFile)) : -1);
  const detailSec = $derived(sections[detailSection] ?? null);
  /** The plot's own name: labels drop it from their front (names.ts). */
  const stem = $derived(target ? keyStem(target.key) : "");
  const noteCount = $derived(files.filter((f) => /\.txt$/i.test(f.name)).length);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  let refreshEpoch = 0;
  onDestroy(() => { refreshEpoch++; });
  async function refresh() {
    const t = target, epoch = ++refreshEpoch, root = dissectRoot();
    if (!t) return;
    let next: DissectListing;
    try { next = await listDissections(root, t.key); } catch { return; }
    if (epoch !== refreshEpoch || target !== t || dissectRoot() !== root) return; // switched/closed while listing
    listing = next;
    if (landing) {
      landing = false;
      // Start on the plot's first picture (its overview), else on its first file.
      const all = arrangeDissections(next).flatMap((sec) => sec.files), first = all.find((f) => f.kind === "image") ?? all[0];
      if (first) { selectedRef = detailAt = refOf(first); fromGrid = false; }
    }
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
    // Opened on a file (the Plots rail): land in its detail view; else on the first picture.
    selectedRef = t.initial ?? null;
    detailAt = t.initial ?? null;
    fromGrid = false;
    landing = !t.initial;
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
  function openDetail(f: DissectFile & { group: string }, viaGrid?: boolean) {
    if (viaGrid !== undefined) fromGrid = viaGrid;
    selectedRef = detailAt = refOf(f);
  }
  function backToGrid() {
    detailAt = null;
    fromGrid = false;
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
      inDetail && fromGrid ? backToGrid() : close();
      return;
    }
    if (notesOpen) return;
    // G: all files ↔ the file that was open.
    if (e.code === "KeyG" && !e.ctrlKey && !e.metaKey && !e.altKey && files.length) {
      e.preventDefault();
      if (inDetail) backToGrid(); else if (selectedFile) openDetail(selectedFile, true);
      return;
    }
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      // In an open file the digit flips to that section's first file; in the grid it scrolls there.
      const first = sections[Number(e.key) - 1]?.files[0];
      if (inDetail) { if (first) openDetail(first); }
      else sectionsRef?.jumpTo(Number(e.key) - 1);
      return;
    }
    if (inDetail) {
      const sectionStep = (delta: number) => { const first = sections[detailSection + delta]?.files[0]; if (first) openDetail(first); };
      if (e.key === "ArrowLeft") { if (detailPos > 0) openDetail(files[detailPos - 1]); }
      else if (e.key === "ArrowRight") { if (detailPos < files.length - 1) openDetail(files[detailPos + 1]); }
      else if (e.key === "ArrowUp") sectionStep(-1);
      else if (e.key === "ArrowDown") sectionStep(1);
      else if (e.key === "Home") openDetail(files[0]);
      else if (e.key === "End") openDetail(files[files.length - 1]);
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
    if ((e.key === "Enter" || e.code === "Space") && selectedFile) openDetail(selectedFile, true);
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
    <div class="dbackdrop" data-dissect-backdrop transition:fade={{ duration: 80 }} onpointerdown={close}></div>
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
      <svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h6v5h-6zM10.5 3.5h3M10.5 6h3M10.5 8.5h3M2.5 11h11M2.5 13.5h7" /></svg>
      <span class="ttl">Dissect</span>
      <span class="vsep" aria-hidden="true"></span>
      <span class="plot" title={relPath}>{target.displayName}</span>
      {#if listing?.total}<span class="count" title={`${listing.total} file${listing.total === 1 ? "" : "s"} in ${relPath}`}>{listing.total}</span>{/if}
      <nav class="views" aria-label="Plot companion views">
        <button class:chosen={!notesOpen} aria-pressed={!notesOpen} onclick={() => { notesOpen = false; }}>Files</button>
        <button class:chosen={notesOpen} aria-pressed={notesOpen} aria-label="Plot text notes" onclick={() => notesOpen ? (notesOpen = false) : showNotes()}>Notes{#if noteCount}<i>{noteCount}</i>{/if}</button>
      </nav>
      <span class="grow"></span>
      <button
        class="hb"
        title={layout.mode === "full" ? "Shrink to a window" : "Expand to full screen"}
        aria-label={layout.mode === "full" ? "Shrink to a window" : "Expand to full screen"}
        onclick={() => (layout.mode = layout.mode === "full" ? "win" : "full")}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">{#if layout.mode === "full"}<path d="M5.5 2.5h8v8h-8zM2.5 5.5v8h8" />{:else}<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />{/if}</svg>
      </button>
      <button class="hb" title="Close (Esc)" aria-label="Close" onclick={close}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
    </div>

    <div class="dbody">
      {#if notesOpen}
        <PlotNotes root={dissectRoot()} plotKey={target.key} onChanged={() => void refresh()} roomy />
      {:else if !listing}
        <div class="empty">Opening…</div>
      {:else if listing.groups === null}
        <div class="empty" data-dissect-empty>
          <p class="lead">No dissections yet for <b>{target.displayName}</b>.</p>
          <p class="path">{relPath}</p>
          <button class="mkbtn" data-dissect-create onclick={createFolder}>Create dissection folder</button>
          <p class="hint">Drop per-subject panels, alternative analyses, or _stats CSVs there — subfolders become sections.</p>
        </div>
      {:else if listing.total === 0}
        <div class="empty" data-dissect-empty>
          <p class="lead">The dissection folder is empty.</p>
          <p class="path">{relPath}</p>
          <p class="hint">Drop images (svg/png) and CSVs there — subfolders become sections. They appear here live.</p>
        </div>
      {:else}
        <DissectSections
          bind:this={sectionsRef}
          {listing}
          {stem}
          selected={selectedFile?.abs ?? ""}
          onSelect={(f) => (selectedRef = refOf(f))}
          onOpen={(f) => openDetail(f, true)}
          onProbed={(sizes) => (imageSizes = sizes)} />
        {#if detailFile}
          <!-- The open file, and the rolodex under it. -->
          <div class="opened">
            <div class="crumbs">
              <button class="back" title="All files, as a grid (G)" onclick={backToGrid}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z" /></svg>All files</button>
              <span class="sec" title={detailSec?.kind === "images" && detailSec.group ? detailSec.group : undefined}>{detailSec ? (detailSec.kind === "images" && detailSec.group ? groupLabel(detailSec.group, stem) : detailSec.title) : ""}</span>
              <span class="sep" aria-hidden="true">›</span>
              <span class="fname" title={detailFile.name}>{detailFile.name}</span>
              <span class="grow"></span>
              {#if detailFile.kind === "image"}<span class="zoom" data-dissect-zoom>{detailZoom}</span>{/if}
              <span class="pos"><b>{detailPos + 1}</b> of {files.length}</span>
              <span class="flip" role="group" aria-label="Previous and next file">
                <button title="Previous file (←)" aria-label="Previous file" disabled={detailPos === 0} onclick={() => openDetail(files[detailPos - 1])}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5" /></svg></button>
                <button title="Next file (→)" aria-label="Next file" disabled={detailPos >= files.length - 1} onclick={() => openDetail(files[detailPos + 1])}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5 11 8l-4.5 4.5" /></svg></button>
              </span>
            </div>
            <div class="opened-file">
              <DissectDetail
                bind:this={detailView}
                bind:zoomLabel={detailZoom}
                file={detailFile}
                pos={detailPos}
                count={files.length}
                groupName={detailFile.group}
                onClose={() => { if (fromGrid) backToGrid(); }}
                caption={false}
                roomy
                noteOwner={{ root: dissectRoot(), key: target.key, group: detailFile.group }}
              />
            </div>
            {#if files.length > 1}<DissectFilmstrip {sections} {stem} sizes={imageSizes} current={detailFile.abs} onPick={(f) => openDetail(f)} />{/if}
          </div>
        {/if}
      {/if}
    </div>

    <div class="dfoot">
      {#if notesOpen}
        <span><kbd>{mac ? "⌘" : "Ctrl"}</kbd><kbd>S</kbd> save now</span>
        <span><kbd>Esc</kbd> close</span>
      {:else if detailFile}
        <span><kbd>←</kbd><kbd>→</kbd> flip</span>
        {#if sections.length > 1}<span><kbd>↑</kbd><kbd>↓</kbd> group</span><span><kbd>1</kbd>–<kbd>{Math.min(9, sections.length)}</kbd> section</span>{/if}
        {#if detailFile.kind === "image"}
          <span><kbd>{mac ? "⌘" : "Ctrl"}</kbd> wheel zooms</span>
          <span><kbd>Space</kbd> drag pans</span>
          <span><kbd>↵</kbd> fit / 1:1</span>
          <span><kbd>0</kbd> reset</span>
        {/if}
        <span><kbd>G</kbd> all files</span>
        <span class="grow"></span>
        <span><kbd>Esc</kbd> {fromGrid ? "back" : "close"}</span>
      {:else}
        <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>G</kbd> back to the file</span>
        <span><kbd>[</kbd><kbd>]</kbd> size</span>
        {#if sections.length > 1}<span><kbd>1</kbd>–<kbd>{Math.min(9, sections.length)}</kbd> section</span>{/if}
        <span class="grow"></span>
        <span><kbd>Esc</kbd> close</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .dbackdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.32); z-index: 330; }
  .dpanel { display: flex; flex-direction: column; background: var(--c-surface); border: 1px solid var(--c-line-strong); color: var(--c-tx); font: 13px/1.35 var(--font-serif); overflow: hidden; z-index: 331; box-shadow: var(--elev-3, 0 12px 40px rgba(0, 0, 0, 0.5)); }
  .dpanel.full { position: fixed; inset: 14px; border-radius: var(--r-panel); }
  .dpanel.win { position: fixed; min-width: 380px; min-height: 260px; max-width: 96vw; max-height: 94vh; border-radius: var(--r-panel); resize: both; }
  svg { display: block; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  button { cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear; }
  button:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 1px; }
  .grow { flex: 1; }

  /* ---- header: Dissect │ which plot · how much … Files | Notes … window, close ---------------- */
  .dhead { flex: 0 0 36px; display: flex; align-items: center; gap: 10px; padding: 0 6px 0 12px; background: var(--c-bg-raised); border-bottom: 1px solid var(--c-line); user-select: none; }
  .dhead.draggable { cursor: grab; } .dhead.draggable:active { cursor: grabbing; }
  .mark { width: 15px; height: 15px; color: var(--c-tx-muted); }
  .ttl { font: 600 14px var(--font-serif); color: var(--c-tx-hi); white-space: nowrap; }
  .vsep { flex: 0 0 1px; height: 14px; background: var(--c-line-strong); }
  .plot { min-width: 0; font: 13px var(--font-serif); color: var(--c-tx); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count { flex-shrink: 0; color: var(--c-tx-muted); font: 11px var(--font-mono); font-variant-numeric: tabular-nums; }
  /* Files | Notes: two tabs, the open one underlined. */
  .views { display: flex; gap: 2px; align-self: stretch; margin-left: 8px; }
  .views button { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 0; background: none; color: var(--c-tx-muted); font: 13px var(--font-serif); }
  .views button:hover { color: var(--c-tx-hi); }
  .views .chosen { color: var(--c-tx-hi); font-weight: 600; }
  .views .chosen::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; background: var(--c-accent); }
  .views i { font: 400 10.5px var(--font-mono); font-style: normal; color: var(--c-tx-muted); }
  .hb { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 1px solid transparent; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); }
  .hb svg { width: 14px; height: 14px; }
  .hb:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }

  .dbody { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; background: var(--c-bg-raised); }
  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; padding: 24px; color: var(--c-tx-muted); text-align: center; }
  .empty p { margin: 0; } .empty .lead { font: 15px var(--font-serif); color: var(--c-tx-2); } .empty b { color: var(--c-tx-hi); font-weight: 600; }
  .path { font: 11.5px var(--font-mono); color: var(--c-accent-bright); user-select: text; }
  .hint { max-width: 440px; font: italic 12.5px/1.5 var(--font-serif); }
  .mkbtn { height: 26px; margin-top: 4px; padding: 0 14px; background: var(--c-accent-tint); border: 1px solid color-mix(in oklab, var(--c-accent) 60%, transparent); border-radius: var(--r-ui); color: var(--c-tx-hi); font: 600 12.5px var(--font-serif); }
  .mkbtn:hover { background: color-mix(in oklab, var(--c-accent) 28%, transparent); border-color: var(--c-accent); }

  /* ---- an open file: where it is · the file · the rolodex -------------------------------------- */
  .opened { position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column; background: var(--c-bg); }
  .crumbs { flex: 0 0 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 6px; background: var(--c-surface); border-bottom: 1px solid var(--c-line); white-space: nowrap; }
  .back { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 8px 0 4px; border: 1px solid transparent; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); font: 12.5px var(--font-serif); }
  .back svg { width: 13px; height: 13px; }
  .back:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .sec { color: var(--c-tx-muted); font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
  .sep { color: var(--c-tx-faint); }
  .fname { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--c-tx-hi); font: 600 13px var(--font-serif); }
  .zoom, .pos { flex-shrink: 0; color: var(--c-tx-muted); font: 11px var(--font-mono); font-variant-numeric: tabular-nums; } .pos b { color: var(--c-tx-hi); font-weight: 600; }
  .flip { display: inline-flex; border: 1px solid var(--c-line); border-radius: var(--r-ui); }
  .flip button { display: grid; place-items: center; width: 24px; height: 20px; padding: 0; border: 0; background: none; color: var(--c-tx-2); } .flip button + button { border-left: 1px solid var(--c-line); }
  .flip svg { width: 13px; height: 13px; }
  .flip button:hover:not(:disabled) { background: var(--c-surface-2); color: var(--c-tx-hi); } .flip button:active:not(:disabled) { background: var(--c-accent-tint); } .flip button:disabled { opacity: .3; }
  .opened-file { position: relative; flex: 1; min-height: 0; }

  /* ---- foot: the keys that work right now ---------------------------------------------------- */
  .dfoot { flex: 0 0 28px; display: flex; align-items: center; gap: 16px; padding: 0 12px; background: var(--c-bg-raised); border-top: 1px solid var(--c-line); color: var(--c-tx-muted); font: 11px var(--font-ui); white-space: nowrap; overflow: hidden; }
  .dfoot kbd { margin-right: 3px; } .dfoot kbd + kbd { margin-left: -1px; }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
