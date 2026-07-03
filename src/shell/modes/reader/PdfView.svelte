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
  import { hlPage, hlSwatch } from "../../../lib/references/annotationColors";
  import { mergeRectsIntoLines, hitTest, type HitEntry } from "../../../lib/pdf/highlightGeometry";
  import { findMatchesInPages, stepIndex, type SearchMatch } from "../../../lib/pdf/search";

  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

  let {
    buffer,
    documentId = "paper",
    scale = 1.35,
    annotations = [],
    hoverId = null,
    onCreate,
    onSelect,
    onAnnotationClick,
    onAnnotationHover,
    onOrphans,
    onPage,
    scrollTo = null,
    find = null,
    onFind,
  }: {
    buffer: ArrayBuffer;
    documentId?: string;
    scale?: number;
    annotations?: Annotation[];
    /** Externally-hovered annotation id (e.g. a sidebar row) → its on-page boxes glow. */
    hoverId?: string | null;
    onCreate?: (a: { page: number; anchor: TextQuoteSelector; color: string }) => void;
    onSelect?: (text: string, page?: number) => void;
    /** Click on a painted highlight (hit-tested — the boxes stay pointer-events:none). */
    onAnnotationClick?: (hit: { id: string; page: number; rect: DOMRect }) => void;
    onAnnotationHover?: (id: string | null) => void;
    /** LR-13: ids whose quote no longer locates on their (rendered) page → the annotations
     *  panel flags them as orphaned instead of silently showing no highlight. */
    onOrphans?: (ids: string[]) => void;
    /** LR-6: report the page centred in the viewport + the total, for the page indicator. */
    onPage?: (page: number, total: number) => void;
    scrollTo?: { id?: string; page?: number; nonce: number } | null;
    /** LR-6: find-in-document. Parent bumps `nonce` to (re)search or step; `dir` picks first
     *  match on a new query or next/prev on the same one. null clears the search. */
    find?: { query: string; nonce: number; dir: "first" | "next" | "prev" } | null;
    onFind?: (r: { total: number; index: number; page: number }) => void;
  } = $props();

  // Highlights paint with `mix-blend-mode: multiply` (marker look — the black canvas
  // text stays crisp under the colour). An earlier pass avoided blending after seeing
  // GPU-readback smearing over large HiDPI canvases; the fix is `isolation: isolate`
  // on each .pdf-page (see styles), which scopes the blend group to one page's canvas.
  // Escape hatch if artifacts ever reappear: flip HL_BLEND to false → merged-line
  // translucent alpha (still far better than the old per-rect stacking).
  const HL_BLEND = true;

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
    hlLayer?: HTMLDivElement; // annotation highlight overlay (sibling of the text layer)
    sLayer?: HTMLDivElement; // LR-6: find-in-document match overlay (separate from annotations)
    info?: PageInfo;
    task?: import("pdfjs-dist").RenderTask;
    rendering: boolean;
    done: boolean;
  };
  const pages = new Map<number, PageState>();
  let observer: IntersectionObserver | undefined;

  // Floating highlight menu shown on text selection (`below` = flipped under the
  // selection when it starts too close to the toolbar to fit the menu above).
  let menu = $state<{ x: number; y: number; below: boolean; page: number; anchor: TextQuoteSelector } | null>(null);

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
  // Per-page hit-test entries (id → merged line boxes in % of the page), rebuilt with
  // each paint. The painted divs stay pointer-events:none so text selection through a
  // highlight keeps working; hover/click resolve against this map instead.
  const hitMap = new Map<number, HitEntry[]>();
  function drawHighlights(p: number) {
    const st = pages.get(p);
    if (!st || !st.done || !st.info || !st.hlLayer) return;
    st.hlLayer.replaceChildren();
    const pageRect = st.pageDiv.getBoundingClientRect();
    const entries: HitEntry[] = [];
    for (const a of annotations) {
      if (a.page !== p) continue;
      const loc = locOf(st.info, a);
      if (!loc) continue;
      const r = rangeFor(st.info, loc.start, loc.end);
      if (!r) continue;
      // One box per text line (merged, % of page) — not one per raw client rect.
      const boxes = mergeRectsIntoLines([...r.getClientRects()], pageRect, { bleedY: 1 });
      if (!boxes.length) continue;
      entries.push({ id: a.id, boxes });
      for (const b of boxes) {
        const d = document.createElement("div");
        d.className = "annot-hl";
        d.dataset.id = a.id;
        d.style.cssText = `left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%;background:${hlPage(a.color)};`;
        st.hlLayer.appendChild(d);
      }
    }
    hitMap.set(p, entries);
    applyHoverClasses();
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

  // --- LR-6: find-in-document -------------------------------------------------
  // A search match is drawn like an annotation (into a dedicated per-page overlay) and located
  // with the SAME quote anchor + fuzzy locator, so it survives virtualized re-render and bridges
  // the small gap between the extracted text (getTextContent) and the rendered text layer.
  const searchText = new Map<number, string>(); // per-page plain text (lazy)
  type SMatch = SearchMatch & { anchor: TextQuoteSelector };
  let searchMatches: SMatch[] = [];
  let activeMatch = -1;
  let searchQuery = "";
  let lastFindNonce = -1;
  let focusTries = 0;

  async function ensureSearchText() {
    if (searchText.size >= numPages) return;
    for (const [p, st] of pages) {
      if (searchText.has(p)) continue;
      try {
        const tc = await st.page.getTextContent();
        // Join with "" to mirror how the text layer concatenates item spans (buildPageText).
        searchText.set(p, tc.items.map((i) => ("str" in i ? i.str : "")).join(""));
      } catch {
        searchText.set(p, ""); // a page that won't extract just contributes no matches
      }
    }
  }
  function clearSearchOverlays() {
    for (const st of pages.values()) st.sLayer?.replaceChildren();
  }
  function drawSearch(p: number) {
    const st = pages.get(p);
    if (!st || !st.done || !st.info || !st.sLayer) return;
    st.sLayer.replaceChildren();
    if (!searchMatches.length) return;
    const pageRect = st.pageDiv.getBoundingClientRect();
    searchMatches.forEach((m, i) => {
      if (m.page !== p) return;
      const loc = locateQuote(st.info!.text, m.anchor);
      if (!loc) return;
      const r = rangeFor(st.info!, loc.start, loc.end);
      if (!r) return;
      for (const b of mergeRectsIntoLines([...r.getClientRects()], pageRect)) {
        const d = document.createElement("div");
        d.className = i === activeMatch ? "search-hl active" : "search-hl";
        d.style.cssText = `left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%;`;
        st.sLayer!.appendChild(d);
      }
    });
  }
  function redrawAllSearch() {
    for (const [p, st] of pages) if (st.done) drawSearch(p);
  }
  function focusActiveMatch() {
    redrawAllSearch();
    const el = container?.querySelector(".search-hl.active") as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      focusTries = 0;
    } else if (focusTries < 12) {
      focusTries++;
      setTimeout(focusActiveMatch, 80); // the target page may still be rasterizing its text layer
    } else {
      focusTries = 0;
    }
  }
  async function runFind(f: NonNullable<typeof find>) {
    const q = f.query.trim();
    if (q !== searchQuery) {
      searchQuery = q; // new query → rebuild the match set
      await ensureSearchText();
      const raw = findMatchesInPages([...searchText].map(([page, text]) => ({ page, text })), q);
      searchMatches = raw.map((m) => ({ ...m, anchor: makeQuoteAnchor(searchText.get(m.page) ?? "", m.start, m.end) }));
      activeMatch = stepIndex(searchMatches.length, -1, "first");
    } else {
      activeMatch = stepIndex(searchMatches.length, activeMatch, f.dir);
    }
    if (activeMatch < 0) {
      clearSearchOverlays();
      onFind?.({ total: 0, index: -1, page: 0 });
      return;
    }
    const m = searchMatches[activeMatch];
    onFind?.({ total: searchMatches.length, index: activeMatch, page: m.page });
    (container?.querySelector(`.pdf-page[data-page="${m.page}"]`) as HTMLElement | null)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    void renderPage(m.page);
    focusTries = 0;
    focusActiveMatch();
  }
  $effect(() => {
    const f = find;
    if (!f) {
      if (searchQuery) {
        searchQuery = "";
        searchMatches = [];
        activeMatch = -1;
        clearSearchOverlays();
      }
      lastFindNonce = -1;
      return;
    }
    if (status !== "ready") return; // re-runs when status flips to ready (a pending search then fires)
    if (f.nonce === lastFindNonce) return;
    lastFindNonce = f.nonce;
    void runFind(f);
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

      const sLayer = document.createElement("div");
      sLayer.className = "search-layer";
      pageDiv.appendChild(sLayer);

      st.layer = layer;
      st.hlLayer = hlLayer;
      st.sLayer = sLayer;
      st.info = buildPageText(layer);
      st.task = undefined;
      st.done = true;
      rendered += 1;
      drawHighlights(p);
      drawSearch(p); // LR-6: re-paint any find matches that fall on this (re)rendered page
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
    st.sLayer?.remove();
    try {
      st.page.cleanup();
    } catch {
      /* ignore */
    }
    st.canvas = st.layer = st.hlLayer = st.sLayer = undefined;
    st.info = undefined;
    st.task = undefined;
    st.done = false;
    st.rendering = false;
    hitMap.delete(p);
  }
  // Keep only MAX_LIVE rasterized pages — free the ones farthest from page `near`.
  function freeExcess(near: number) {
    const done = [...pages.entries()].filter(([, st]) => st.done).map(([p]) => p);
    if (done.length <= MAX_LIVE) return;
    done.sort((a, b) => Math.abs(b - near) - Math.abs(a - near));
    for (const p of done.slice(0, done.length - MAX_LIVE)) freePage(p);
  }

  // --- highlight hover/click (hit-tested; boxes stay pointer-events:none) ------
  let hoverAnnId: string | null = null; // pointer-derived (vs the external `hoverId` prop)
  let hoverRaf = 0;
  function applyHoverClasses() {
    if (!container) return;
    const want = hoverAnnId ?? hoverId ?? null;
    for (const el of container.querySelectorAll(".annot-hl.hover")) el.classList.remove("hover");
    if (want)
      for (const el of container.querySelectorAll(`.annot-hl[data-id="${CSS.escape(want)}"]`))
        el.classList.add("hover");
    container.style.cursor = hoverAnnId ? "pointer" : "";
  }
  $effect(() => {
    void hoverId;
    applyHoverClasses();
  });
  function hitAt(target: Element | null, x: number, y: number): { id: string; page: number; rect: DOMRect } | null {
    const pageDiv = (target as HTMLElement | null)?.closest?.(".pdf-page") as HTMLElement | null;
    if (!pageDiv) return null;
    const p = Number(pageDiv.dataset.page);
    const entries = hitMap.get(p);
    if (!entries?.length) return null;
    const r = pageDiv.getBoundingClientRect();
    const id = hitTest(((x - r.left) / r.width) * 100, ((y - r.top) / r.height) * 100, entries);
    if (!id) return null;
    const el = pageDiv.querySelector(`.annot-hl[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    return { id, page: p, rect: el?.getBoundingClientRect() ?? new DOMRect(x, y, 0, 0) };
  }
  function onPointerMove(e: MouseEvent) {
    if (hoverRaf) return;
    const { clientX, clientY } = e;
    const target = e.target as Element | null;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const id = hitAt(target, clientX, clientY)?.id ?? null;
      if (id !== hoverAnnId) {
        hoverAnnId = id;
        applyHoverClasses();
        onAnnotationHover?.(id);
      }
    });
  }
  function onContainerClick(e: MouseEvent) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // finishing a drag-selection, not a click
    const hit = hitAt(e.target as Element | null, e.clientX, e.clientY);
    if (hit) onAnnotationClick?.(hit);
  }

  // --- selection → highlight menu ----------------------------------------------
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
    // Clamp within the viewport; flip below the selection when the toolbar is too close.
    const x = Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80);
    const below = rect.top < 140;
    menu = { x, y: below ? rect.bottom + 10 : rect.top - 8, below, page, anchor };
    onSelect?.(anchor.quote, page);
  }
  function pick(color: string) {
    // snapshot: menu is $state — hand callers a plain object, not a reactive proxy
    if (menu) onCreate?.({ page: menu.page, anchor: $state.snapshot(menu.anchor), color });
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
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
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

<div class="pdf-root" data-testid="pdf-root" data-pages={numPages} data-rendered={rendered} data-hl-blend={HL_BLEND ? "on" : "off"}>
  {#if status === "error"}
    <div class="msg err">Couldn't render this PDF: {errMsg}</div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="pdf-scroll"
    bind:this={container}
    onmouseup={onMouseUp}
    onmousemove={onPointerMove}
    onclick={onContainerClick}
    class:hidden={status === "error"}></div>
  {#if status === "loading"}
    <div class="msg loading">Loading…</div>
  {/if}

  {#if menu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="hl-menu" class:below={menu.below} style:left="{menu.x}px" style:top="{menu.y}px" onmousedown={(e) => e.stopPropagation()}>
      {#each ANNOTATION_COLORS as c}
        <button class="dot" style:background={hlSwatch(c)} title="Highlight ({c})" aria-label={`Highlight ${c}`} onclick={() => pick(c)}></button>
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
    /* Scope the highlight layer's multiply blend to THIS page's stacking context.
       Without it the blend group is the whole app — the source of the GPU-readback
       smearing that made an earlier pass abandon mix-blend-mode entirely. */
    isolation: isolate;
  }
  :global(.pdf-page .pdf-canvas) {
    display: block;
  }
  /* The text layer is an invisible selection surface over the canvas: its glyphs must
     stay transparent in EVERY state. The app-wide `::selection` (app.css) recolors
     selected text with var(--c-tx-hi) — near-white in the dark theme — which painted
     ghost glyphs over the canvas text ("corrupted" selections). Force transparency
     here (the app rule is intentionally untouched — the paper editor depends on it)
     and keep the wash as the only visible sign of selection. */
  :global(.pdf-page .textLayer span),
  :global(.pdf-page .textLayer br) {
    color: transparent !important;
  }
  :global(.pdf-page .textLayer span::selection),
  :global(.pdf-page .textLayer br::selection) {
    color: transparent !important;
    background: rgba(67, 133, 190, 0.28) !important; /* accent-blue wash tuned for white pages */
  }
  /* Highlight overlay sits above the canvas + text layer, never inside .textLayer.
     The multiply blend lives on THIS wrapper, not the boxes: the wrapper's z-index
     makes it a stacking context, and a child's mix-blend-mode would composite against
     the wrapper's transparent backdrop instead of the canvas (opaque bars hiding the
     text — verified in headless Chrome). Blending the layer as a group also means
     overlapping highlights hand off cleanly instead of double-darkening. */
  :global(.pdf-page .hl-layer) {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
    mix-blend-mode: multiply;
  }
  /* Marker look: page × colour, canvas text stays crisp black underneath. Boxes are
     merged per-line %-of-page rects (highlightGeometry.ts) — no stacking-alpha seams. */
  :global(.pdf-page .hl-layer .annot-hl) {
    position: absolute;
    pointer-events: none;
    border-radius: 2px;
  }
  :global(.pdf-page .hl-layer .annot-hl.hover) {
    filter: brightness(0.92) saturate(1.3);
  }
  /* HL_BLEND escape hatch — merged-line translucent alpha, no blending. */
  :global(.pdf-root[data-hl-blend="off"] .hl-layer) {
    mix-blend-mode: normal;
  }
  :global(.pdf-root[data-hl-blend="off"] .hl-layer .annot-hl) {
    opacity: 0.35;
  }
  /* LR-6: find-in-document matches, drawn above annotations so the active hit is always
     visible. Same wrapper-level blend as .hl-layer (same stacking-context constraint). */
  :global(.pdf-page .search-layer) {
    position: absolute;
    inset: 0;
    z-index: 4;
    pointer-events: none;
    mix-blend-mode: multiply;
  }
  :global(.pdf-page .search-layer .search-hl) {
    position: absolute;
    pointer-events: none;
    border-radius: 2px;
    background: #ffd9a1;
  }
  :global(.pdf-page .search-layer .search-hl.active) {
    background: #ffb054;
    outline: 1.5px solid rgba(205, 88, 0, 0.95);
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
  .hl-menu.below {
    transform: translate(-50%, 0);
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
