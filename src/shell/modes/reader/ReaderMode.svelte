<script lang="ts">
  // FluxReader — the PDF reading mode. Loads the paper named by readerKey from
  // ~/FluxLib/items/<citekey>/ (PDF bytes + annotations) and renders it with PdfView,
  // flanked by a reference sidebar (the paper's OpenAlex referenced_works → add to
  // FluxLib) and an annotations panel (this paper's highlights → click to scroll,
  // delete). Highlights persist to items/<citekey>/annotations.json.
  import { onMount, onDestroy } from "svelte";
  import { readerKey } from "./readerStore";
  import { fluxLibRevision } from "../../../lib/references/revision";
  import { readerPdfBytes, readerSource, writeReaderContext, clearReaderContext } from "../../../lib/references/itemsBridge";
  import { loadAnnotations, addAnnotation, updateAnnotation, deleteAnnotation } from "../../../lib/references/annotationsBridge";
  import { hlSwatch } from "../../../lib/references/annotationColors";
  import { loadFluxLib } from "../../../lib/references/fluxlibBridge";
  import { referencedWorksByKey } from "../../../lib/references/enrichBridge";
  import { addDoiToLibrary } from "../paper/scholar/bibLoad";
  import { bareDoi } from "../../../lib/references/pdfFinder";
  import type { WorldBrief } from "../../../lib/references/openalex";
  import type { RefEntry } from "../../../lib/references/types";
  import type { Annotation, TextQuoteSelector } from "../../../lib/references/annotations";
  import type { ReaderContext } from "../../../lib/references/items";
  import PdfView from "./PdfView.svelte";
  import AgentDrawer from "./AgentDrawer.svelte";
  import HighlightPopover from "./HighlightPopover.svelte";

  let { focused = true }: { focused?: boolean } = $props();

  let buffer = $state<ArrayBuffer | null>(null);
  let annotations = $state<Annotation[]>([]);
  let loading = $state(false);
  let curKey = $state<string | null>(null);
  let entry = $state<RefEntry | null>(null);
  let libDois = $state<Set<string>>(new Set());

  // Reference sidebar (the paper's referenced_works).
  let refs = $state<WorldBrief[]>([]);
  let refsState = $state<"idle" | "loading" | "done" | "error">("idle");
  let addingId = $state("");

  // Sidebar visibility + a scroll signal for the PDF (click an annotation → scroll).
  let showRefs = $state(true);
  let showAnnots = $state(true);
  let scrollTo = $state<{ id?: string; page?: number; nonce: number } | null>(null);
  // LR-13: ids whose quote no longer locates on their rendered page (PdfView reports them).
  let orphans = $state<Set<string>>(new Set());
  // LR-6: zoom/fit/layout/page-nav — PdfView (pdf.js PDFViewer) owns the mechanics; the
  // toolbar drives it through the bound instance and reads the live scale back.
  let pdfView = $state<PdfView | undefined>();
  let scalePct = $state(100);
  let layout = $state<"vertical" | "horizontal" | "wrapped" | "two-up">("vertical");
  let curPage = $state(1);
  let totalPages = $state(0);
  const LAYOUTS: Record<string, { scroll: "vertical" | "horizontal" | "wrapped"; spread: "none" | "odd" }> = {
    vertical: { scroll: "vertical", spread: "none" },
    horizontal: { scroll: "horizontal", spread: "none" },
    wrapped: { scroll: "wrapped", spread: "none" },
    "two-up": { scroll: "vertical", spread: "odd" },
  };
  function applyLayout() {
    pdfView?.setLayout(LAYOUTS[layout]);
  }
  function jumpToPage(n: number) {
    pdfView?.goToPage(n);
  }
  let nonce = 0;

  // LR-6: find-in-document. The heavy lifting (all-page text index, match location, overlay) lives
  // in PdfView; here we own the search bar + drive it via a nonce-bumped `find` prop and read back
  // the {total,index,page} result for the counter.
  let findOpen = $state(false);
  let findQuery = $state("");
  let findNonce = $state(0);
  let findDir = $state<"first" | "next" | "prev">("first");
  let findResult = $state<{ total: number; index: number; page: number } | null>(null);
  let findInput = $state<HTMLInputElement | undefined>(undefined);
  let findDebounce: ReturnType<typeof setTimeout> | undefined;
  const findProp = $derived(
    findOpen && findQuery.trim() ? { query: findQuery.trim(), nonce: findNonce, dir: findDir } : null,
  );
  function openFind() {
    findOpen = true;
    setTimeout(() => findInput?.select(), 0);
  }
  function closeFind() {
    findOpen = false;
    findQuery = "";
    findResult = null;
    clearTimeout(findDebounce);
  }
  function onFindInput() {
    clearTimeout(findDebounce);
    findDebounce = setTimeout(() => {
      findDir = "first"; // a changed query always jumps to the first hit (PdfView rebuilds the set)
      findNonce++;
    }, 200);
  }
  function stepFind(dir: "next" | "prev") {
    if (!findQuery.trim()) return;
    findDir = dir;
    findNonce++;
  }
  function findKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      stepFind(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  }

  // Agent drawer (Claude Code) + the human's live text selection (pushed to the agent).
  let agentOpen = $state(false);
  let selection = $state("");
  let selPage = $state<number | undefined>(undefined);
  let ctxTimer: ReturnType<typeof setTimeout> | undefined;

  // Highlight popover (click a highlight on the page, or ✎ on a sidebar row).
  let popover = $state<{ id: string; x: number; y: number; place: "above" | "below" } | null>(null);
  const popAnn = $derived(popover ? (annotations.find((a) => a.id === popover!.id) ?? null) : null);
  // Hover sync: page → sidebar row, sidebar row → page boxes.
  let pageHoverId = $state<string | null>(null);
  let sideHoverId = $state<string | null>(null);

  // Stamp of the on-disk PDF (source.json identity) so an external re-fetch/replace of
  // paper.pdf refreshes the open reader in place; bufferGen remounts PdfView.
  let srcStamp: string | null = null;
  let bufferGen = $state(0);
  const stampOf = (s: Awaited<ReturnType<typeof readerSource>>, b: ArrayBuffer | null) =>
    s ? `${s.sha256 ?? ""}:${s.bytes ?? ""}:${s.fetchedAt ?? ""}` : b ? "present" : "absent";

  $effect(() => {
    const key = $readerKey;
    if (key === curKey) return;
    curKey = key;
    buffer = null;
    annotations = [];
    entry = null;
    refs = [];
    refsState = "idle";
    popover = null;
    if (!key) return;
    loading = true;
    void Promise.all([readerPdfBytes(key), loadAnnotations(key), loadFluxLib(), readerSource(key)]).then(
      ([b, af, lib, src]) => {
        if (curKey !== key) return;
        buffer = b;
        annotations = af.annotations;
        entry = lib.find((e) => e.key === key) ?? null;
        libDois = new Set(lib.map((e) => bareDoi(e.doi)).filter((d): d is string => !!d));
        srcStamp = stampOf(src, b);
        loading = false;
      },
    );
    // Reference list loads independently (network; needs the paper hydrated).
    refsState = "loading";
    void referencedWorksByKey(key).then((r) => {
      if (curKey !== key) return;
      refs = r;
      refsState = "done";
    }).catch(() => {
      if (curKey === key) refsState = "error";
    });
  });

  // W10 (LR-3): an external FluxLib write (e.g. an agent's add_annotation, or a new
  // paper) refreshes the open paper's annotations + library membership in place —
  // and, if paper.pdf itself changed on disk (re-fetch, manual ingest), reloads the
  // bytes and remounts the PDF view (bufferGen keys it) instead of rendering stale bytes.
  onMount(() => {
    let first = true;
    return fluxLibRevision.subscribe(() => {
      if (first) { first = false; return; }
      const key = curKey;
      if (!key) return;
      void Promise.all([loadAnnotations(key), loadFluxLib(), readerSource(key)]).then(async ([af, lib, src]) => {
        if (curKey !== key) return;
        annotations = af.annotations;
        libDois = new Set(lib.map((e) => bareDoi(e.doi)).filter((d): d is string => !!d));
        const b = buffer;
        const stamp = stampOf(src, b);
        if (stamp !== srcStamp) {
          const fresh = await readerPdfBytes(key);
          if (curKey !== key) return;
          srcStamp = stampOf(src, fresh);
          buffer = fresh;
          bufferGen++;
        }
      });
    });
  });

  async function handleCreate(a: { page: number; anchor: TextQuoteSelector; color: string }) {
    const key = $readerKey;
    if (!key) return;
    const ann = await addAnnotation(key, { page: a.page, anchor: a.anchor, color: a.color });
    annotations = [...annotations, ann];
  }
  async function handleDelete(id: string) {
    const key = $readerKey;
    if (!key) return;
    if (popover?.id === id) popover = null;
    await deleteAnnotation(key, id);
    annotations = annotations.filter((a) => a.id !== id);
  }
  // Patch note/color/tags. The patched object keeps its anchor reference, so PdfView's
  // located-range cache stays hot — a recolor is a repaint, not a re-locate.
  async function handleUpdate(id: string, patch: Partial<Annotation>) {
    const key = $readerKey;
    if (!key) return;
    await updateAnnotation(key, id, patch);
    annotations = annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
  }
  function jumpTo(a: Annotation) {
    scrollTo = { id: a.id, page: a.page, nonce: ++nonce };
  }
  // Anchor the popover near a highlight's on-page rect (or a sidebar row's rect),
  // clamped to the viewport, flipped above when there's no room below.
  function openPopover(hit: { id: string; rect: DOMRect }) {
    const W = 300;
    const pad = 12;
    const x = Math.min(Math.max(hit.rect.left + hit.rect.width / 2, W / 2 + pad), window.innerWidth - W / 2 - pad);
    const below = hit.rect.bottom + 300 < window.innerHeight;
    popover = { id: hit.id, x, y: below ? hit.rect.bottom + 8 : hit.rect.top - 8, place: below ? "below" : "above" };
  }
  function copyQuote(a: Annotation) {
    navigator.clipboard?.writeText(a.anchor.quote).catch(() => {});
  }
  function askClaudeAbout(a: Annotation) {
    void a; // the reader context already carries the highlights; Phase 3 injects a prompt
    agentOpen = true;
  }
  async function addRef(b: WorldBrief) {
    if (!b.doi || addingId) return;
    addingId = b.openalexId;
    try {
      const r = await addDoiToLibrary(b.doi);
      if (!("error" in r)) libDois = new Set(libDois).add(bareDoi(b.doi)!);
    } finally {
      addingId = "";
    }
  }

  const inLib = (b: WorldBrief) => !!(b.doi && libDois.has(bareDoi(b.doi)!));
  const title = $derived(entry?.title ?? $readerKey ?? "");
  // Annotations in reading order (page, then first-seen).
  const orderedAnns = $derived([...annotations].sort((a, b) => a.page - b.page));

  function handleSelect(text: string, page?: number) {
    selection = text;
    if (page != null) selPage = page;
  }

  // Push the live reading context to ~/FluxLib/.fluxlib/reader-context.json (debounced)
  // so the agent's get_reading_context tool can see the paper + selection + highlights.
  $effect(() => {
    const key = $readerKey;
    const sel = selection;
    const e = entry;
    const anns = annotations;
    if (!key || !buffer) return;
    clearTimeout(ctxTimer);
    const ctx: ReaderContext = {
      citekey: key,
      title: e?.title,
      authors: e?.authors,
      year: e?.year,
      doi: e?.doi,
      page: selPage,
      selection: sel || undefined,
      annotations: anns.map((a) => ({ page: a.page, color: a.color, quote: a.anchor.quote, note: a.note })),
      updatedAt: new Date().toISOString(),
    };
    ctxTimer = setTimeout(() => void writeReaderContext(ctx), 250);
  });

  function onKey(e: KeyboardEvent) {
    if (!focused) return; // kept-alive hidden panes must not react (inert blocks focus, not window listeners)
    const tag = (e.target as HTMLElement | null)?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      if (!$readerKey || !buffer) return; // only when this reader pane has a PDF open
      e.preventDefault();
      openFind();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      agentOpen = !agentOpen;
    } else if (e.key === "Escape") {
      if (popover) popover = null;
      else if (findOpen) closeFind();
      else if (agentOpen) agentOpen = false;
    } else if (!typing && buffer && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Reader nav keys (skipped while typing in find/note/page inputs).
      if (e.key === "+" || e.key === "=") pdfView?.zoomIn();
      else if (e.key === "-") pdfView?.zoomOut();
      else if (e.key === "0") pdfView?.zoomReset();
      else if (e.key === "PageDown") pdfView?.pageStep(1);
      else if (e.key === "PageUp") pdfView?.pageStep(-1);
      else if (e.key === "Home") pdfView?.goToPage(1);
      else if (e.key === "End") pdfView?.goToPage(totalPages);
      else return;
      e.preventDefault();
    }
  }

  onDestroy(() => {
    clearTimeout(ctxTimer);
    void clearReaderContext();
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="reader">
  {#if !$readerKey}
    <div class="empty">
      <span class="h">FluxReader</span>
      <span>Open a paper from the Library (the “Read” action) to start reading.</span>
    </div>
  {:else if loading}
    <div class="empty">Loading “{$readerKey}”…</div>
  {:else if !buffer}
    <div class="empty">
      No PDF on disk for “{$readerKey}”. Use <strong>Get PDF</strong> in the Library to fetch it first.
    </div>
  {:else}
    <div class="chrome">
      <div class="rtoolbar">
        <button class="tgl" class:on={showRefs} onclick={() => (showRefs = !showRefs)} title="Toggle references"
          >☰ References{refs.length ? ` (${refs.length})` : ""}</button>
        <span class="rtitle" title={title}>{title}</span>
        <div class="rnav">
          <button class="zbtn" title="Zoom out (−)" aria-label="Zoom out" onclick={() => pdfView?.zoomOut()}>−</button>
          <button class="zbtn zpct" title="Fit width (0)" onclick={() => pdfView?.zoomReset()}>{scalePct}%</button>
          <button class="zbtn" title="Zoom in (+)" aria-label="Zoom in" onclick={() => pdfView?.zoomIn()}>+</button>
          <button class="zbtn" title="Fit page height" aria-label="Fit page" onclick={() => pdfView?.setFit("page-fit")}>⤢</button>
          <select class="zsel" title="Page layout" aria-label="Page layout" bind:value={layout} onchange={applyLayout}>
            <option value="vertical">1-up</option>
            <option value="two-up">2-up</option>
            <option value="wrapped">Grid</option>
            <option value="horizontal">Row</option>
          </select>
          <span class="pgind">
            <input class="pgin" type="number" min="1" max={totalPages || 1} value={curPage}
              aria-label="Jump to page" onchange={(e) => jumpToPage(+e.currentTarget.value)} />
            <span class="pgtot">/ {totalPages || "…"}</span>
          </span>
        </div>
        {#if findOpen}
          <div class="rfind">
            <input
              class="rfind-in"
              bind:this={findInput}
              bind:value={findQuery}
              placeholder="Find in document"
              aria-label="Find in document"
              oninput={onFindInput}
              onkeydown={findKey} />
            <span class="rfind-count"
              >{findQuery.trim() ? (findResult && findResult.total ? `${findResult.index + 1}/${findResult.total}` : "0/0") : ""}</span>
            <button class="rfind-btn" title="Previous match (Shift-Enter)" aria-label="Previous match" disabled={!findResult?.total} onclick={() => stepFind("prev")}>↑</button>
            <button class="rfind-btn" title="Next match (Enter)" aria-label="Next match" disabled={!findResult?.total} onclick={() => stepFind("next")}>↓</button>
            <button class="rfind-btn" title="Close (Esc)" aria-label="Close find" onclick={closeFind}>✕</button>
          </div>
        {:else}
          <button class="tgl" title="Find in document (⌘/Ctrl-F)" aria-label="Find in document" onclick={openFind}>🔍</button>
        {/if}
        <button class="tgl" class:on={showAnnots} onclick={() => (showAnnots = !showAnnots)} title="Toggle annotations"
          >Notes ({annotations.length}) ✎</button>
        <button class="tgl agentbtn" class:on={agentOpen} onclick={() => (agentOpen = !agentOpen)}
          title="Ask Claude Code about this paper — it sees your selection + highlights (⌘/Ctrl-J)">✦ Ask Claude</button>
      </div>
      <div class="rbody">
        {#if showRefs}
          <aside class="side refs">
            <div class="shead">References</div>
            {#if refsState === "loading"}
              <div class="smsg">Loading references…</div>
            {:else if refsState === "error"}
              <div class="smsg">Couldn’t load references.</div>
            {:else if refs.length === 0}
              <div class="smsg">No reference list — <em>Enrich</em> this paper in the Library to fetch its
                <code>referenced_works</code>.</div>
            {:else}
              <ul class="reflist">
                {#each refs as b (b.openalexId)}
                  <li class="ref">
                    <div class="rmeta">
                      <span class="rauth">{b.authors.slice(0, 2).join(", ")}{b.authors.length > 2 ? " et al." : ""}{b.year ? ` · ${b.year}` : ""}</span>
                      {#if b.citedByCount != null}<span class="rcite">{b.citedByCount.toLocaleString()}×</span>{/if}
                    </div>
                    <div class="rtitle2" title={b.title}>{b.title}</div>
                    <div class="ractions">
                      {#if inLib(b)}
                        <span class="inlib">✓ in library</span>
                      {:else if b.doi}
                        <button class="addbtn" disabled={addingId === b.openalexId} onclick={() => addRef(b)}
                          >{addingId === b.openalexId ? "Adding…" : "+ FluxLib"}</button>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </aside>
        {/if}

        <div class="pdfwrap">
          <div class="pdfarea">
            {#key `${$readerKey}#${bufferGen}`}
              <PdfView bind:this={pdfView} {buffer} {annotations} {scrollTo} hoverId={sideHoverId} find={findProp} onFind={(r) => (findResult = r)} onCreate={handleCreate} onSelect={handleSelect} onAnnotationClick={openPopover} onAnnotationHover={(id) => (pageHoverId = id)} onOrphans={(ids) => (orphans = new Set(ids))} onScale={(s) => (scalePct = Math.round(s * 100))} onPage={(p, t) => { curPage = p; totalPages = t; }} />
            {/key}
          </div>
          {#if agentOpen}
            <div class="agentpane">
              <AgentDrawer onClose={() => (agentOpen = false)} />
            </div>
          {/if}
        </div>

        {#if popover && popAnn}
          <HighlightPopover
            annotation={popAnn}
            x={popover.x}
            y={popover.y}
            place={popover.place}
            onSaveNote={(n) => handleUpdate(popAnn!.id, { note: n || undefined })}
            onRecolor={(c) => handleUpdate(popAnn!.id, { color: c })}
            onCopy={() => copyQuote(popAnn!)}
            onAsk={() => askClaudeAbout(popAnn!)}
            onDelete={() => handleDelete(popAnn!.id)}
            onClose={() => (popover = null)} />
        {/if}

        {#if showAnnots}
          <aside class="side annots">
            <div class="shead">Annotations</div>
            {#if orderedAnns.length === 0}
              <div class="smsg">Select text in the PDF and pick a colour to add a highlight.</div>
            {:else}
              <ul class="annlist">
                {#each orderedAnns as a (a.id)}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                  <li
                    class="ann"
                    class:orphan={orphans.has(a.id)}
                    class:pagehover={pageHoverId === a.id}
                    onclick={() => jumpTo(a)}
                    onmouseenter={() => (sideHoverId = a.id)}
                    onmouseleave={() => (sideHoverId = null)}>
                    <div class="arow">
                      <span class="swatch" style:background={hlSwatch(a.color)}></span>
                      <span class="aquote" title={a.anchor.quote}>{a.anchor.quote}</span>
                      {#if orphans.has(a.id)}<span class="odot" title="This highlight's text wasn't found on its page — the PDF may have changed.">detached</span>{/if}
                      <span class="apage">p{a.page}</span>
                      <button class="edit" title="Comment / edit highlight" aria-label="Edit highlight"
                        onclick={(e) => { e.stopPropagation(); openPopover({ id: a.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }); }}>✎</button>
                      <button class="del" title="Delete highlight" aria-label="Delete highlight"
                        onclick={(e) => { e.stopPropagation(); handleDelete(a.id); }}>×</button>
                    </div>
                    {#if a.note}
                      <div class="anote">{a.note}</div>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </aside>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .reader {
    position: absolute;
    inset: 0;
    background: var(--c-bg);
  }
  .chrome {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .rtoolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 6px 10px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-surface);
  }
  .rtitle {
    flex: 1 1 auto;
    text-align: center;
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    color: var(--c-tx-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tgl {
    flex: 0 0 auto;
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 3px 9px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .tgl.on {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  /* LR-6: zoom + page-jump group */
  .rnav {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
  }
  .zbtn {
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    min-width: 22px;
    padding: 3px 6px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
    line-height: 1;
  }
  .zbtn:hover {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .zpct {
    min-width: 42px;
    font-variant-numeric: tabular-nums;
  }
  .zsel {
    border: 1px solid var(--c-line-strong);
    background: var(--c-bg);
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 2px 4px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .zsel:hover {
    border-color: var(--c-accent);
  }
  .pgind {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: var(--sp-2);
    white-space: nowrap;
  }
  .pgin {
    width: 3.2em;
    text-align: right;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 2px 4px;
    font: inherit;
    font-size: var(--ts-xs);
    font-variant-numeric: tabular-nums;
  }
  .pgtot {
    color: var(--c-tx-faint);
  }
  /* LR-6: find-in-document bar (toolbar-inline). */
  .rfind {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 4px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
  }
  .rfind-in {
    width: 12em;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 2px 6px;
    font: inherit;
    font-size: var(--ts-xs);
  }
  .rfind-in:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .rfind-count {
    min-width: 3em;
    text-align: center;
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    font-variant-numeric: tabular-nums;
  }
  .rfind-btn {
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    min-width: 20px;
    padding: 2px 5px;
    font: inherit;
    font-size: var(--ts-xs);
    line-height: 1;
    cursor: pointer;
  }
  .rfind-btn:hover:not(:disabled) {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .rfind-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .rbody {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .side {
    flex: 0 0 268px;
    width: 268px;
    overflow: auto;
    background: var(--c-surface);
    display: flex;
    flex-direction: column;
  }
  .side.refs {
    border-right: 1px solid var(--c-line);
  }
  .side.annots {
    border-left: 1px solid var(--c-line);
  }
  .shead {
    position: sticky;
    top: 0;
    padding: 8px 12px;
    font-size: var(--ts-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
    background: var(--c-surface);
    border-bottom: 1px solid var(--c-line);
  }
  .smsg {
    padding: 12px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
    line-height: 1.5;
  }
  .pdfwrap {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .pdfarea {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .agentpane {
    position: relative;
    flex: 0 0 42%;
    min-height: 140px;
    border-top: 1px solid var(--c-line-strong);
  }
  .agentbtn.on {
    border-color: var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
  }
  .reflist,
  .annlist {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  .ref {
    padding: 8px 12px;
    border-bottom: 1px solid var(--c-line);
  }
  .rmeta {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .rtitle2 {
    font-size: var(--ts-sm);
    color: var(--c-tx-1);
    margin: 2px 0 5px;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .addbtn {
    border: 1px solid var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    border-radius: var(--r-1);
    padding: 2px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .addbtn:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .inlib {
    font-size: var(--ts-xs);
    color: var(--c-accent);
  }
  .ann {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--c-line);
    cursor: pointer;
  }
  .ann:hover,
  .ann.pagehover {
    background: var(--c-bg);
  }
  .arow {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .anote {
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    line-height: 1.4;
    padding-left: 15px; /* aligns under the quote, past the swatch */
    white-space: pre-wrap;
  }
  .swatch {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border-radius: 2px;
    align-self: center;
  }
  .aquote {
    flex: 1 1 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-1);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .apage {
    flex: 0 0 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .ann.orphan .aquote {
    text-decoration: line-through;
    color: var(--c-tx-faint);
  }
  .odot {
    flex: 0 0 auto;
    font-size: var(--ts-xs);
    color: var(--c-warning, #ad8301);
    border: 1px solid var(--c-warning, #ad8301);
    border-radius: var(--r-1);
    padding: 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .del,
  .edit {
    flex: 0 0 auto;
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-md);
    line-height: 1;
    padding: 0 2px;
  }
  .edit {
    font-size: var(--ts-sm);
  }
  .del:hover {
    color: var(--c-danger);
  }
  .edit:hover {
    color: var(--c-accent);
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
