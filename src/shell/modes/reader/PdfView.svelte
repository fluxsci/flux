<script lang="ts">
  // The PDF view — pdf.js (Mozilla; vanilla JS). Renders pages to canvas + a selectable
  // DOM text layer, VIRTUALIZED (only near-visible pages are rasterized; offscreen pages
  // are freed) so long PDFs don't exhaust canvas/GPU memory and stall the app. Highlights
  // are drawn into a dedicated per-page overlay (never mutating the text layer) and anchored
  // by quote (annotations.ts) so they survive re-render. Fonts/cmaps/wasm are served from
  // /pdfjs/ (vite.config.ts) — WITHOUT standardFontDataUrl, non-embedded fonts fall back to
  // Symbol and render Latin text as Greek. Worker carries a base64/hex + Map polyfill for
  // Electron 33's Chromium 130 (src/lib/pdf/*).
  import { onMount } from "svelte";
  import "../../../lib/pdf/uint8Polyfill"; // main-thread toBase64/getOrInsertComputed (Electron 33)
  import * as pdfjs from "pdfjs-dist";
  import PdfWorker from "../../../lib/pdf/pdfjsWorker?worker";
  import "pdfjs-dist/web/pdf_viewer.css";
  import {
    makeQuoteAnchor,
    locateQuote,
    ANNOTATION_COLORS,
    type Annotation,
    type TextQuoteSelector,
  } from "../../../lib/references/annotations";

  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

  let {
    buffer,
    documentId = "paper",
    scale = 1.35,
    annotations = [],
    onCreate,
    onSelect,
    onOrphans,
    onPage,
    scrollTo = null,
  }: {
    buffer: ArrayBuffer;
    documentId?: string;
    scale?: number;
    annotations?: Annotation[];
    onCreate?: (a: { page: number; anchor: TextQuoteSelector; color: string }) => void;
    onSelect?: (text: string, page?: number) => void;
    /** LR-13: ids whose quote no longer locates on their (rendered) page → the annotations
     *  panel flags them as orphaned instead of silently showing no highlight. */
    onOrphans?: (ids: string[]) => void;
    /** LR-6: report the page centred in the viewport + the total, for the page indicator. */
    onPage?: (page: number, total: number) => void;
    scrollTo?: { id?: string; page?: number; nonce: number } | null;
  } = $props();

  // Highlighter colours — plain translucent rgba (NO mix-blend-mode: blending over a large
  // HiDPI canvas triggers GPU-readback artifacts / smearing under memory pressure).
  const HL: Record<string, string> = {
    yellow: "rgba(255,214,10,0.38)",
    green: "rgba(94,189,108,0.36)",
    blue: "rgba(67,133,190,0.30)",
    pink: "rgba(225,90,140,0.30)",
    orange: "rgba(218,160,23,0.36)",
  };

  const DPR = Math.min(window.devicePixelRatio || 1, 2); // cap backing-store size
  const MAX_LIVE = 6; // rasterized pages kept in memory at once

  let container = $state<HTMLDivElement | undefined>();
  let status = $state<"loading" | "ready" | "error">("loading");
  let errMsg = $state("");
  let numPages = $state(0);
  let rendered = $state(0); // monotonic count of first-renders (a "did it draw" signal)

  type PageInfo = { text: string; nodes: { node: Text; start: number }[] };
  type PageState = {
    page: import("pdfjs-dist").PDFPageProxy;
    viewport: import("pdfjs-dist").PageViewport;
    pageDiv: HTMLDivElement;
    canvas?: HTMLCanvasElement;
    layer?: HTMLDivElement; // text layer
    hlLayer?: HTMLDivElement; // highlight overlay (sibling of the text layer)
    info?: PageInfo;
    task?: import("pdfjs-dist").RenderTask;
    rendering: boolean;
    done: boolean;
  };
  const pages = new Map<number, PageState>();
  let observer: IntersectionObserver | undefined;

  // Floating highlight menu shown on text selection.
  let menu = $state<{ x: number; y: number; page: number; anchor: TextQuoteSelector } | null>(null);

  // --- text ↔ DOM mapping for anchoring (unchanged logic) ---------------------
  function buildPageText(layer: HTMLElement): PageInfo {
    const nodes: { node: Text; start: number }[] = [];
    let text = "";
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n as Text, start: text.length });
      text += n.textContent ?? "";
    }
    return { text, nodes };
  }
  function charOffset(info: PageInfo, node: Node, offset: number): number | null {
    let textNode: Text | null = node.nodeType === Node.TEXT_NODE ? (node as Text) : null;
    if (!textNode) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      textNode = walker.nextNode() as Text | null;
      offset = 0;
    }
    if (!textNode) return null;
    const entry = info.nodes.find((e) => e.node === textNode);
    return entry ? entry.start + offset : null;
  }
  function nodeAt(info: PageInfo, off: number): { node: Text; local: number } | null {
    let res: { node: Text; start: number } | null = null;
    for (const e of info.nodes) {
      if (e.start <= off) res = e;
      else break;
    }
    return res ? { node: res.node, local: Math.max(0, Math.min(off - res.start, res.node.length)) } : null;
  }
  function rangeFor(info: PageInfo, start: number, end: number): Range | null {
    const s = nodeAt(info, start);
    const e = nodeAt(info, Math.max(start, end));
    if (!s || !e) return null;
    const r = document.createRange();
    try {
      r.setStart(s.node, s.local);
      r.setEnd(e.node, e.local);
      return r;
    } catch {
      return null;
    }
  }

  // --- highlights → dedicated overlay layer (never the text layer) ------------
  // LR-13: cache each annotation's located range keyed by its anchor identity. drawHighlights
  // runs on every `annotations` change (add/delete/scroll) across up to 6 live pages, and
  // locateQuote is a fuzzy full-page search — without this, adding one note re-located ALL of
  // them. `null` loc = orphan (quote no longer found on its rendered page); those ids are
  // reported to the annotations panel so a detached highlight isn't just silently invisible.
  const locCache = new Map<string, { anchor: TextQuoteSelector; loc: { start: number; end: number } | null }>();
  const orphanIds = new Set<string>();
  function locOf(info: PageInfo, a: Annotation): { start: number; end: number } | null {
    const hit = locCache.get(a.id);
    if (hit && hit.anchor === a.anchor) return hit.loc;
    const loc = locateQuote(info.text, a.anchor) ?? null;
    locCache.set(a.id, { anchor: a.anchor, loc });
    if (loc) orphanIds.delete(a.id);
    else orphanIds.add(a.id);
    return loc;
  }
  function drawHighlights(p: number) {
    const st = pages.get(p);
    if (!st || !st.done || !st.info || !st.hlLayer) return;
    st.hlLayer.replaceChildren();
    const pageRect = st.pageDiv.getBoundingClientRect();
    for (const a of annotations) {
      if (a.page !== p) continue;
      const loc = locOf(st.info, a);
      if (!loc) continue;
      const r = rangeFor(st.info, loc.start, loc.end);
      if (!r) continue;
      for (const rect of r.getClientRects()) {
        const d = document.createElement("div");
        d.className = "annot-hl";
        d.dataset.id = a.id;
        d.style.cssText =
          `position:absolute;left:${rect.left - pageRect.left}px;top:${rect.top - pageRect.top}px;` +
          `width:${rect.width}px;height:${rect.height}px;background:${HL[a.color] ?? HL.yellow};` +
          `border-radius:1px;pointer-events:none;`;
        st.hlLayer.appendChild(d);
      }
    }
  }
  function redrawAllLive() {
    // Prune cache/orphan entries for annotations that were deleted since the last pass.
    const live = new Set(annotations.map((a) => a.id));
    for (const id of [...locCache.keys()]) if (!live.has(id)) locCache.delete(id);
    for (const id of [...orphanIds]) if (!live.has(id)) orphanIds.delete(id);
    for (const [p, st] of pages) if (st.done) drawHighlights(p);
    onOrphans?.([...orphanIds]);
  }
  $effect(() => {
    void annotations;
    if (status === "ready") redrawAllLive();
  });

  // Scroll to a page (rendering it if needed), then refine to the exact highlight.
  $effect(() => {
    const t = scrollTo;
    if (!t || !container) return;
    void t.nonce;
    const div =
      (t.page != null && (container.querySelector(`.pdf-page[data-page="${t.page}"]`) as HTMLElement | null)) || null;
    if (div) {
      div.scrollIntoView({ behavior: "smooth", block: "center" });
      if (t.id) setTimeout(() => refineScroll(t.id!), 450);
    } else if (t.id) {
      refineScroll(t.id);
    }
  });
  function refineScroll(id: string) {
    const el = container?.querySelector(`.annot-hl[data-id="${id}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // --- virtualized render / free ----------------------------------------------
  async function renderPage(p: number) {
    const st = pages.get(p);
    if (!st || st.done || st.rendering) return;
    st.rendering = true;
    try {
      const { page, viewport, pageDiv } = st;
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      canvas.width = Math.floor(viewport.width * DPR);
      canvas.height = Math.floor(viewport.height * DPR);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      pageDiv.appendChild(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: DPR !== 1 ? [DPR, 0, 0, DPR, 0, 0] : undefined,
      });
      st.task = task;
      st.canvas = canvas;
      await task.promise;

      const layer = document.createElement("div");
      layer.className = "textLayer";
      pageDiv.appendChild(layer);
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();

      const hlLayer = document.createElement("div");
      hlLayer.className = "hl-layer";
      pageDiv.appendChild(hlLayer);

      st.layer = layer;
      st.hlLayer = hlLayer;
      st.info = buildPageText(layer);
      st.task = undefined;
      st.done = true;
      rendered += 1;
      drawHighlights(p);
      freeExcess(p);
    } catch {
      /* cancelled or failed — freePage will have cleaned partial state on unmount */
    } finally {
      st.rendering = false;
    }
  }

  function freePage(p: number) {
    const st = pages.get(p);
    if (!st) return;
    try {
      st.task?.cancel();
    } catch {
      /* ignore */
    }
    if (st.canvas) {
      st.canvas.width = 0; // release the backing store
      st.canvas.height = 0;
      st.canvas.remove();
    }
    st.layer?.remove();
    st.hlLayer?.remove();
    try {
      st.page.cleanup();
    } catch {
      /* ignore */
    }
    st.canvas = st.layer = st.hlLayer = undefined;
    st.info = undefined;
    st.task = undefined;
    st.done = false;
    st.rendering = false;
  }
  // Keep only MAX_LIVE rasterized pages — free the ones farthest from page `near`.
  function freeExcess(near: number) {
    const done = [...pages.entries()].filter(([, st]) => st.done).map(([p]) => p);
    if (done.length <= MAX_LIVE) return;
    done.sort((a, b) => Math.abs(b - near) - Math.abs(a - near));
    for (const p of done.slice(0, done.length - MAX_LIVE)) freePage(p);
  }

  // --- selection → highlight menu (unchanged) ---------------------------------
  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      menu = null;
      onSelect?.("");
      return;
    }
    const range = sel.getRangeAt(0);
    const pageDiv = (range.startContainer.parentElement as HTMLElement | null)?.closest(".pdf-page") as HTMLElement | null;
    if (!pageDiv) {
      menu = null;
      return;
    }
    const page = Number(pageDiv.dataset.page);
    const st = pages.get(page);
    if (!st?.info) return;
    const start = charOffset(st.info, range.startContainer, range.startOffset);
    const end = charOffset(st.info, range.endContainer, range.endOffset);
    if (start == null || end == null || start === end) {
      menu = null;
      return;
    }
    const anchor = makeQuoteAnchor(st.info.text, Math.min(start, end), Math.max(start, end));
    if (!anchor.quote.trim()) {
      menu = null;
      return;
    }
    const rect = range.getBoundingClientRect();
    menu = { x: rect.left + rect.width / 2, y: rect.top - 8, page, anchor };
    onSelect?.(anchor.quote, page);
  }
  function pick(color: string) {
    if (menu) onCreate?.({ page: menu.page, anchor: menu.anchor, color });
    menu = null;
    window.getSelection()?.removeAllRanges();
  }

  // --- LR-6: current-page indicator (scroll-centred) --------------------------
  let curPage = 0;
  let pageRaf = 0;
  function updateCurrentPage() {
    if (!container || !numPages) return;
    const mid = container.scrollTop + container.clientHeight / 2;
    let best = 1;
    for (const [p, st] of pages) {
      if (st.pageDiv.offsetTop <= mid) best = p;
      else break;
    }
    if (best !== curPage) {
      curPage = best;
      onPage?.(best, numPages);
    }
  }
  function onScroll() {
    if (pageRaf) return;
    pageRaf = requestAnimationFrame(() => {
      pageRaf = 0;
      updateCurrentPage();
    });
  }

  // --- LR-6: zoom — rebuild page viewports when `scale` changes after load. Freeing done
  // pages re-rasterizes them at the new scale (via the observer / the manual near-page pass);
  // the DPR cap still applies in renderPage, so a big zoom doesn't blow the canvas budget.
  let lastBuiltScale = 0; // set to the real scale once the pages are built (see the load below)
  $effect(() => {
    const s = scale;
    if (status !== "ready" || s === lastBuiltScale) return;
    lastBuiltScale = s;
    const near = curPage || 1;
    for (const [p, st] of pages) {
      if (st.done) freePage(p);
      const viewport = st.page.getViewport({ scale: s });
      st.viewport = viewport;
      st.pageDiv.style.width = `${Math.floor(viewport.width)}px`;
      st.pageDiv.style.height = `${Math.floor(viewport.height)}px`;
      st.pageDiv.style.setProperty("--total-scale-factor", String(s));
      st.pageDiv.style.setProperty("--scale-factor", String(s));
    }
    for (let p = Math.max(1, near - 1); p <= Math.min(numPages, near + 1); p++) void renderPage(p);
    updateCurrentPage();
  });

  onMount(() => {
    let cancelled = false;
    const base = new URL("pdfjs/", document.baseURI).href; // dev: http://…/pdfjs/  prod: file://…/dist/pdfjs/
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      cMapUrl: base + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      wasmUrl: base + "wasm/",
      iccUrl: base + "iccs/",
      // Draw non-embedded fonts from the shipped standard fonts rather than the OS. On a
      // machine without a font like "ITCSymbolStd" installed, the system path fails and
      // pdf.js falls back to Symbol encoding (Latin → Greek); this keeps it deterministic.
      useSystemFonts: false,
    });

    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void renderPage(Number((e.target as HTMLElement).dataset.page));
        }
      },
      { root: container, rootMargin: "1200px 0px" },
    );

    (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        numPages = pdf.numPages;
        const host = container;
        if (!host) return;
        host.replaceChildren();
        pages.clear();
        // Phase 1: cheap placeholders sized to each page (no rasterization) → correct
        // scrollbar + zero layout shift; the observer rasterizes near-visible pages.
        for (let p = 1; p <= pdf.numPages; p++) {
          if (cancelled) return;
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale });
          const pageDiv = document.createElement("div");
          pageDiv.className = "pdf-page";
          pageDiv.dataset.page = String(p);
          pageDiv.style.width = `${Math.floor(viewport.width)}px`;
          pageDiv.style.height = `${Math.floor(viewport.height)}px`;
          // pdf.js v6 sizes text-layer spans off --total-scale-factor (only defined under
          // its own .pdfViewer .page). We use our own classes, so set it here or every span
          // mis-sizes → wrong getClientRects → corrupted highlights.
          pageDiv.style.setProperty("--total-scale-factor", String(scale));
          pageDiv.style.setProperty("--scale-factor", String(scale));
          host.appendChild(pageDiv);
          pages.set(p, { page, viewport, pageDiv, rendering: false, done: false });
          observer!.observe(pageDiv);
        }
        lastBuiltScale = scale; // the pageDivs above were built at the current scale
        status = "ready";
        container?.addEventListener("scroll", onScroll, { passive: true });
        onPage?.(1, pdf.numPages); // seed the indicator at page 1
      } catch (e) {
        if (!cancelled) {
          status = "error";
          errMsg = (e as Error)?.message || String(e);
        }
      }
    })();

    return () => {
      cancelled = true;
      container?.removeEventListener("scroll", onScroll);
      if (pageRaf) cancelAnimationFrame(pageRaf);
      observer?.disconnect();
      for (const st of pages.values()) {
        try {
          st.task?.cancel();
        } catch {
          /* ignore */
        }
        try {
          st.page.cleanup();
        } catch {
          /* ignore */
        }
      }
      pages.clear();
      try {
        task.destroy();
      } catch {
        /* ignore */
      }
    };
  });
</script>

<svelte:window onmousedown={() => (menu = null)} />

<div class="pdf-root" data-testid="pdf-root" data-pages={numPages} data-rendered={rendered}>
  {#if status === "error"}
    <div class="msg err">Couldn't render this PDF: {errMsg}</div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pdf-scroll" bind:this={container} onmouseup={onMouseUp} class:hidden={status === "error"}></div>
  {#if status === "loading"}
    <div class="msg loading">Loading…</div>
  {/if}

  {#if menu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="hl-menu" style:left="{menu.x}px" style:top="{menu.y}px" onmousedown={(e) => e.stopPropagation()}>
      {#each ANNOTATION_COLORS as c}
        <button class="dot" style:background={HL[c]} title="Highlight ({c})" aria-label={`Highlight ${c}`} onclick={() => pick(c)}></button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .pdf-root {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .pdf-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    background: var(--c-surface);
    padding: 16px 0;
  }
  .pdf-scroll.hidden {
    display: none;
  }
  :global(.pdf-page) {
    position: relative;
    margin: 0 auto 14px;
    background: #fff;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
  }
  :global(.pdf-page .pdf-canvas) {
    display: block;
  }
  /* highlight overlay sits above the canvas + text layer, never inside .textLayer */
  :global(.pdf-page .hl-layer) {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
  }
  .msg {
    padding: 16px;
    text-align: center;
    color: var(--c-tx-faint);
    font-size: var(--ts-sm);
    font-style: italic;
  }
  .msg.loading {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
  }
  .msg.err {
    color: var(--c-danger);
  }
  .hl-menu {
    position: fixed;
    transform: translate(-50%, -100%);
    display: flex;
    gap: 5px;
    padding: 5px 7px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    box-shadow: var(--elev-2, 0 2px 8px rgba(0, 0, 0, 0.25));
    z-index: 50;
  }
  .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--c-line);
    cursor: pointer;
    padding: 0;
  }
  .dot:hover {
    transform: scale(1.15);
  }
</style>
