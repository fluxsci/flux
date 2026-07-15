<script lang="ts">
  // The PDF view — built on pdf.js's official PDFViewer (LEGACY build via
  // src/lib/pdf/pdfjs.ts: Electron 33 / Chromium 130 compatible, self-polyfilled).
  // The viewer owns scrolling/virtualization (detail-canvas zoom, capped raster),
  // anchor-preserving zoom (updateScale origin), fit modes, scroll/spread layouts,
  // the link service (live internal/external link annotations), and find-in-document
  // (PDFFindController, highlight-all). Flux owns what pdf.js can't: quote-anchored
  // highlights (annotations.ts) drawn into a per-page .hl-layer overlay, rebuilt on
  // every `textlayerrendered` (never cached across PDFPageView.reset), plus the
  // selection→colour-menu and highlight hover/click hit-testing.
  //
  // Fonts/cmaps/wasm/iccs are served from /pdfjs/ (vite.config.ts) — WITHOUT
  // standardFontDataUrl, non-embedded fonts fall back to Symbol and render Latin
  // text as Greek. Each instance gets its OWN PDFWorker (LR-12: the old shared
  // workerPort meant two readers fought over one worker; it also never terminated).
  import { onMount } from "svelte";
  import "pdfjs-dist/web/pdf_viewer.css";
  import PdfWorkerPort from "../../../lib/pdf/pdfjsWorker?worker";
  import {
    getDocument,
    PDFWorker,
    EventBus,
    PDFViewer,
    PDFLinkService,
    PDFFindController,
    LinkTarget,
    ScrollMode,
    SpreadMode,
  } from "../../../lib/pdf/pdfjs";
  import {
    makeQuoteAnchor,
    locateQuote,
    ANNOTATION_COLORS,
    type Annotation,
    type TextQuoteSelector,
  } from "../../../lib/references/annotations";
  import { hlPage, hlSwatch } from "../../../lib/references/annotationColors";
  import { mergeRectsIntoLines, hitTest, type HitEntry } from "../../../lib/pdf/highlightGeometry";
  import {
    extractBibEntryAt,
    flattenOutline,
    type TextItemLike,
    type FlatOutlineItem,
    type CitePreviewRequest,
  } from "../../../lib/pdf/citePreview";
  import type { PDFDocumentProxy } from "../../../lib/pdf/pdfjs";

  let {
    buffer,
    annotations = [],
    canHighlight = true,
    hoverId = null,
    onCreate,
    onSelect,
    onAskSelection,
    onAnnotationClick,
    onAnnotationHover,
    onCitePreview,
    onNavDepth,
    onRegionPop,
    onRegionSnip,
    onOrphans,
    onPage,
    onScale,
    initialView = null,
    scrollTo = null,
    find = null,
    onFind,
  }: {
    buffer: ArrayBuffer;
    annotations?: Annotation[];
    /** False on a supplement PDF — highlights anchor to the main paper only, so the
     *  selection menu hides its colour dots (✦ Ask Claude stays available). */
    canHighlight?: boolean;
    /** Externally-hovered annotation id (e.g. a sidebar row) → its on-page boxes glow. */
    hoverId?: string | null;
    /** Return/resolve `false` (or reject) when the create failed to persist — the
     *  selection is then kept alive so the user can retry. */
    onCreate?: (a: { page: number; anchor: TextQuoteSelector; color: string }) => void | boolean | Promise<void | boolean>;
    onSelect?: (text: string, page?: number) => void;
    /** ✦ on the selection menu — ask Claude about the selected passage (R3). */
    onAskSelection?: (text: string, page: number) => void;
    /** Click on a painted highlight (hit-tested — the boxes stay pointer-events:none). */
    onAnnotationClick?: (hit: { id: string; page: number; rect: DOMRect }) => void;
    onAnnotationHover?: (id: string | null) => void;
    /** R4: a link annotation is hovered (null = pointer left it; parent debounces hide). */
    onCitePreview?: (req: CitePreviewRequest | null) => void;
    /** R4: back-stack depth changed (link/outline jumps push; goBack pops). */
    onNavDepth?: (n: number) => void;
    /** R5: alt+drag marquee finished — a page region in PDF units [x1,y1,x2,y2]. */
    onRegionPop?: (req: { page: number; rect: [number, number, number, number] }) => void;
    /** Paper snips: ctrl+alt+drag marquee finished — same region contract as
     *  onRegionPop, plus the marquee's bottom-right client corner to anchor the
     *  naming popover at the spot the drag ended. */
    onRegionSnip?: (req: { page: number; rect: [number, number, number, number]; anchor: { x: number; y: number } }) => void;
    /** R5: restore a saved view (applied instead of the fit-width/page-1 defaults). */
    initialView?: { page?: number; scaleValue?: string } | null;
    /** LR-13: ids whose quote no longer locates on their (rendered) page → the annotations
     *  panel flags them as orphaned instead of silently showing no highlight. */
    onOrphans?: (ids: string[]) => void;
    /** LR-6: report the current page + total for the page indicator. */
    onPage?: (page: number, total: number) => void;
    /** Actual render scale (1 = 100%), from the viewer's scalechanging event. */
    onScale?: (scale: number) => void;
    scrollTo?: { id?: string; page?: number; nonce: number } | null;
    /** LR-6: find-in-document. Parent bumps `nonce` to (re)search or step; `dir` picks first
     *  match on a new query or next/prev on the same one. null clears the search. */
    find?: { query: string; nonce: number; dir: "first" | "next" | "prev" } | null;
    onFind?: (r: { total: number; index: number; page: number }) => void;
  } = $props();

  // See Reader R1: highlights blend at the LAYER level (multiply) with isolation on the
  // page. Escape hatch if GPU artifacts ever reappear: false → merged-line alpha.
  const HL_BLEND = true;

  let container = $state<HTMLDivElement | undefined>();
  let viewerDiv = $state<HTMLDivElement | undefined>();
  let status = $state<"loading" | "ready" | "error">("loading");
  let loadNote = $state(""); // big-PDF ingest progress, e.g. "42% of 96 MB"
  let errMsg = $state("");
  let numPages = $state(0);
  let rendered = $state(0); // monotonic count of page renders (a "did it draw" signal)

  let viewer: InstanceType<typeof PDFViewer> | undefined;
  let bus: InstanceType<typeof EventBus> | undefined;
  let linkSvc: InstanceType<typeof PDFLinkService> | undefined;
  let pdfDoc: PDFDocumentProxy | undefined;

  // Floating highlight menu shown on text selection (`below` = flipped under the
  // selection when it starts too close to the toolbar to fit the menu above).
  let menu = $state<{ x: number; y: number; below: boolean; page: number; anchor: TextQuoteSelector } | null>(null);

  // --- per-page state (rebuilt on every textlayerrendered) ----------------------
  type PageInfo = { text: string; nodes: { node: Text; start: number }[] };
  type PageEntry = { pageDiv: HTMLElement; textDiv: HTMLElement; hlLayer: HTMLDivElement; info: PageInfo };
  const pageInfos = new Map<number, PageEntry>();

  // --- text ↔ DOM mapping for anchoring (unchanged logic) -----------------------
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

  // --- highlights → dedicated overlay layer (never the text layer) --------------
  // LR-13: cache each annotation's located range keyed by its anchor identity —
  // locateQuote is a fuzzy full-page search; without this, adding one note re-located
  // ALL of them. `null` loc = orphan (quote not found on its rendered page).
  const locCache = new Map<string, { anchor: TextQuoteSelector; loc: { start: number; end: number } | null }>();
  const orphanIds = new Set<string>();
  function locOf(info: PageInfo, a: Annotation): { start: number; end: number } | null {
    const hit = locCache.get(a.id);
    if (hit && hit.anchor === a.anchor) return hit.loc;
    if (import.meta.env?.DEV) {
      // WS-8.5 gate hook: count fuzzy re-locates (cache misses) — the scale
      // gate asserts no locateQuote storm while scrolling an annotated doc.
      const w = window as unknown as { __fluxReaderPerf?: { locateCalls: number } };
      (w.__fluxReaderPerf ??= { locateCalls: 0 }).locateCalls++;
    }
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
  // WS-8.5: bucket annotations by page ONCE per annotations change — drawHighlights
  // used to iterate ALL annotations per page per textlayerrendered event.
  const annByPage = $derived.by(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of annotations) {
      const arr = m.get(a.page);
      if (arr) arr.push(a);
      else m.set(a.page, [a]);
    }
    return m;
  });
  function drawHighlights(p: number) {
    const st = pageInfos.get(p);
    if (!st || !st.hlLayer.isConnected) return;
    st.hlLayer.replaceChildren();
    const pageRect = st.pageDiv.getBoundingClientRect();
    const entries: HitEntry[] = [];
    for (const a of annByPage.get(p) ?? []) {
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
    // Prune cache/orphan entries for annotations deleted since the last pass, and page
    // entries whose layers were torn down by PDFPageView.reset (they re-attach on the
    // next textlayerrendered).
    const live = new Set(annotations.map((a) => a.id));
    for (const id of [...locCache.keys()]) if (!live.has(id)) locCache.delete(id);
    for (const id of [...orphanIds]) if (!live.has(id)) orphanIds.delete(id);
    for (const [p, st] of pageInfos) {
      if (!st.hlLayer.isConnected) {
        pageInfos.delete(p);
        hitMap.delete(p);
        continue;
      }
      drawHighlights(p);
    }
    onOrphans?.([...orphanIds]);
  }
  $effect(() => {
    void annotations;
    if (status === "ready") redrawAllLive();
  });

  // WS-8.5: buildPageText (a TreeWalker over the whole layer) used to run on
  // EVERY textlayerrendered — pdf.js re-fires it for layers that didn't change.
  // Cache per text-layer ELEMENT at a given zoom; a reset page gets a NEW div
  // (WeakMap entry dies with it), and a zoom change re-walks.
  const pageTextCache = new WeakMap<HTMLElement, { scale: number; info: PageInfo }>();

  // Attach Flux's overlay + text map to a page whose text layer just (re)rendered.
  function attachPage(p: number) {
    const view = viewer?.getPageView(p - 1);
    const pageDiv: HTMLElement | undefined = view?.div;
    const textDiv: HTMLElement | undefined = view?.textLayer?.div;
    if (!pageDiv || !textDiv) return;
    for (const el of pageDiv.querySelectorAll(":scope > .hl-layer")) el.remove();
    const hlLayer = document.createElement("div");
    hlLayer.className = "hl-layer";
    pageDiv.appendChild(hlLayer);
    const scale = viewer?.currentScale ?? 1;
    const cached = pageTextCache.get(textDiv);
    const info = cached && cached.scale === scale ? cached.info : buildPageText(textDiv);
    pageTextCache.set(textDiv, { scale, info });
    pageInfos.set(p, { pageDiv, textDiv, hlLayer, info });
    drawHighlights(p);
    onOrphans?.([...orphanIds]);
  }

  // Mirror the verify-harness hooks onto pdf.js's page divs (.pdf-page[data-page]).
  function aliasPages() {
    if (!viewer) return;
    for (let i = 0; i < viewer.pagesCount; i++) {
      const div = viewer.getPageView(i)?.div as HTMLElement | undefined;
      if (div) {
        div.classList.add("pdf-page");
        div.dataset.page = String(i + 1);
      }
    }
  }

  // --- LR-6: find-in-document via PDFFindController ------------------------------
  // The nonce-driven `find` prop protocol is unchanged for ReaderMode; internally it
  // forwards to the controller over the event bus (highlight-all, diacritic folding,
  // cross-span matching — the old hand-rolled index/overlay stack is gone).
  let lastFindNonce = -1;
  let lastQuery = "";
  $effect(() => {
    const f = find;
    if (status !== "ready" || !bus) return; // re-runs when status flips (pending search then fires)
    if (!f) {
      if (lastQuery) {
        lastQuery = "";
        bus.dispatch("findbarclose", { source: null }); // controller clears its highlights
      }
      lastFindNonce = -1;
      return;
    }
    if (f.nonce === lastFindNonce) return;
    lastFindNonce = f.nonce;
    const again = f.query === lastQuery && f.dir !== "first";
    lastQuery = f.query;
    bus.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query: f.query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: f.dir === "prev",
      matchDiacritics: false,
    });
  });
  function onMatchesCount(e: { matchesCount?: { current?: number; total?: number } }) {
    const m = e.matchesCount;
    if (!m || !viewer) return;
    onFind?.({ total: m.total ?? 0, index: (m.current ?? 0) - 1, page: viewer.currentPageNumber });
  }

  // --- scroll-to (annotation jump): page first, then refine to the exact highlight.
  $effect(() => {
    const t = scrollTo;
    if (!t || !viewer || status !== "ready") return;
    void t.nonce;
    if (t.page != null) viewer.currentPageNumber = Math.min(Math.max(1, t.page), numPages || 1);
    if (t.id) refineScroll(t.id, 12); // retries: the target page may still be rasterizing
  });
  function refineScroll(id: string, tries: number) {
    const el = container?.querySelector(`.annot-hl[data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (tries > 0) setTimeout(() => refineScroll(id, tries - 1), 150);
  }

  // --- zoom / fit / layout / paging — the imperative handle ReaderMode drives ----
  export function zoomIn() {
    viewer?.increaseScale({ steps: 1 });
  }
  export function zoomOut() {
    viewer?.decreaseScale({ steps: 1 });
  }
  /** Reset = fit the page width (the reader's home zoom). */
  export function zoomReset() {
    if (viewer) viewer.currentScaleValue = "page-width";
  }
  export function setFit(mode: "page-width" | "page-fit" | "page-actual") {
    if (viewer) viewer.currentScaleValue = mode;
  }
  const SCROLL: Record<string, number> = {
    vertical: ScrollMode.VERTICAL,
    horizontal: ScrollMode.HORIZONTAL,
    wrapped: ScrollMode.WRAPPED,
  };
  const SPREAD: Record<string, number> = { none: SpreadMode.NONE, odd: SpreadMode.ODD, even: SpreadMode.EVEN };
  export function setLayout(l: { scroll?: "vertical" | "horizontal" | "wrapped"; spread?: "none" | "odd" | "even" }) {
    if (!viewer) return;
    if (l.scroll) viewer.scrollMode = SCROLL[l.scroll];
    if (l.spread) viewer.spreadMode = SPREAD[l.spread];
  }
  export function goToPage(n: number, opts: { pushNav?: boolean } = {}) {
    if (!viewer || !numPages) return;
    if (opts.pushNav) pushNav();
    viewer.currentPageNumber = Math.min(numPages, Math.max(1, Math.floor(n) || 1));
  }
  export function pageStep(dir: 1 | -1) {
    if (dir > 0) viewer?.nextPage();
    else viewer?.previousPage();
  }

  // Ctrl/⌘+wheel (and trackpad pinch, which Chromium reports as ctrl+wheel): zoom
  // anchored at the cursor via the viewer's origin-preserving updateScale.
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!viewer || !container) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 15 : e.deltaY; // line-mode → px-ish
    // pdf.js subtracts container.offsetTop/Left from the origin — viewport coords only
    // when the container's offsetParent is <body> (true in pdf.js's own app, not inside
    // Flux's nested panes). Hand it the origin in ITS coordinate space.
    const rect = container.getBoundingClientRect();
    viewer.updateScale({
      drawingDelay: 400, // CSS-zoom immediately, re-rasterize when the gesture settles
      scaleFactor: Math.exp(-dy / 350),
      origin: [e.clientX - rect.left + container.offsetLeft, e.clientY - rect.top + container.offsetTop],
    });
  }

  // --- highlight hover/click (hit-tested; boxes stay pointer-events:none) --------
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
    const st = pageInfos.get(p);
    if (!st || !st.hlLayer.isConnected) return null; // page evicted — stale boxes don't hit
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
  // A link-annotation click: record where we were (goBack restores it) — in the
  // CAPTURE phase, because pdf.js's own handler on the <a> navigates synchronously
  // for cached dests (by bubble time the scroll has already jumped).
  function onClickCapture(e: MouseEvent) {
    if ((e.target as Element | null)?.closest?.(".annotationLayer a")) {
      pushNav();
      onCitePreview?.(null);
    }
  }
  function onContainerClick(e: MouseEvent) {
    if (skipNextClick) {
      skipNextClick = false;
      return; // the click that ends an alt+drag marquee
    }
    if ((e.target as Element | null)?.closest?.(".annotationLayer a")) return; // handled in capture
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // finishing a drag-selection, not a click
    const hit = hitAt(e.target as Element | null, e.clientX, e.clientY);
    if (hit) onAnnotationClick?.(hit);
  }

  // --- R4: citation hover preview + back-navigation ------------------------------
  const annotsCache = new Map<number, Promise<{ id: string; url?: string; dest?: unknown }[]>>();
  const itemsCache = new Map<number, Promise<TextItemLike[]>>();
  const annotsFor = (p: number) => {
    let hit = annotsCache.get(p);
    if (!hit) {
      hit = (async () => (pdfDoc ? await (await pdfDoc.getPage(p)).getAnnotations() : []))();
      annotsCache.set(p, hit);
    }
    return hit;
  };
  const itemsFor = (p: number) => {
    let hit = itemsCache.get(p);
    if (!hit) {
      hit = (async () => {
        if (!pdfDoc) return [];
        const tc = await (await pdfDoc.getPage(p)).getTextContent();
        // `"str" in i` narrows TextItem | TextMarkedContent to the text items.
        return tc.items.flatMap((i) => ("str" in i ? [{ str: i.str, x: i.transform[4], y: i.transform[5] }] : []));
      })();
      itemsCache.set(p, hit);
    }
    return hit;
  };
  let citeTimer: ReturnType<typeof setTimeout> | undefined;
  let citeSeq = 0; // hover moved on before an async resolve landed → drop the stale one
  function onOver(e: MouseEvent) {
    const a = (e.target as Element | null)?.closest?.(".annotationLayer a") as HTMLAnchorElement | null;
    if (!a || !onCitePreview) return;
    clearTimeout(citeTimer);
    const seq = ++citeSeq;
    citeTimer = setTimeout(() => void openCitePreview(a, seq), 200);
  }
  function onOut(e: MouseEvent) {
    if (!(e.target as Element | null)?.closest?.(".annotationLayer a")) return;
    clearTimeout(citeTimer);
    citeSeq++;
    onCitePreview?.(null);
  }
  async function openCitePreview(aEl: HTMLAnchorElement, seq: number) {
    if (!pdfDoc || !aEl.isConnected) return;
    const section = aEl.closest("section") as HTMLElement | null;
    const pageDiv = aEl.closest(".pdf-page") as HTMLElement | null;
    const annId = section?.dataset.annotationId;
    if (!annId || !pageDiv) return;
    const ann = (await annotsFor(Number(pageDiv.dataset.page))).find((x) => x.id === annId);
    if (!ann || seq !== citeSeq) return;
    const rect = aEl.getBoundingClientRect();
    if (ann.url) {
      onCitePreview?.({ kind: "external", url: ann.url, rect });
      return;
    }
    let dest = ann.dest;
    if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
    if (!Array.isArray(dest) || seq !== citeSeq) return;
    let pageIndex: number;
    try {
      pageIndex = await pdfDoc.getPageIndex(dest[0]);
    } catch {
      return;
    }
    const kind = (dest[1] as { name?: string } | undefined)?.name;
    const destY = kind === "XYZ" ? (dest[3] as number | null) : kind === "FitH" ? (dest[2] as number | null) : null;
    const items = await itemsFor(pageIndex + 1);
    if (seq !== citeSeq || !aEl.isConnected) return;
    onCitePreview?.({ kind: "internal", text: extractBibEntryAt(items, destY), destPage: pageIndex + 1, rect });
  }

  const navStack: { left: number; top: number }[] = [];
  function pushNav() {
    if (!container) return;
    navStack.push({ left: container.scrollLeft, top: container.scrollTop });
    if (navStack.length > 50) navStack.shift();
    onNavDepth?.(navStack.length);
  }
  export function goBack() {
    const s = navStack.pop();
    onNavDepth?.(navStack.length);
    if (s) container?.scrollTo({ left: s.left, top: s.top, behavior: "smooth" });
  }
  /** Document outline, flattened for the sidebar. Empty array = the PDF really has
   *  none; `null` = the document hasn't finished loading yet (callers must NOT cache
   *  it as "no outline" — retry once the doc is ready). */
  export async function getOutline(): Promise<FlatOutlineItem[] | null> {
    if (!pdfDoc) return null;
    try {
      return flattenOutline(await pdfDoc.getOutline());
    } catch {
      return [];
    }
  }
  /** Outline-panel jumps: push the back-stack, then let the link service navigate. */
  export function goToDestination(dest: unknown) {
    if (!linkSvc || dest == null) return;
    pushNav();
    void linkSvc.goToDestination(dest as string);
  }
  /** The restorable view state (persisted per paper by ReaderMode). */
  export function getViewState(): { page: number; scaleValue: string } | null {
    if (!viewer || status !== "ready") return null;
    return { page: viewer.currentPageNumber, scaleValue: viewer.currentScaleValue };
  }

  // --- R5: alt+drag a page region → floating figure panel; ctrl+alt+drag → paper snip
  let marquee = $state<{ x: number; y: number; w: number; h: number; snip: boolean } | null>(null);
  let marqueeStart: { x: number; y: number; pageDiv: HTMLElement; page: number; snip: boolean } | null = null;
  let skipNextClick = false; // the mouseup that ends a marquee still fires a click
  function onPointerDown(e: MouseEvent) {
    if (!e.altKey || e.button !== 0) return;
    const pageDiv = (e.target as Element | null)?.closest?.(".pdf-page") as HTMLElement | null;
    if (!pageDiv) return;
    e.preventDefault(); // no text selection while marqueeing
    const snip = e.ctrlKey || e.metaKey; // mode is decided at pointer-down, not release
    marqueeStart = { x: e.clientX, y: e.clientY, pageDiv, page: Number(pageDiv.dataset.page), snip };
    marquee = { x: e.clientX, y: e.clientY, w: 0, h: 0, snip };
  }
  function onMarqueeMove(e: MouseEvent) {
    if (!marqueeStart) return;
    marquee = {
      x: Math.min(marqueeStart.x, e.clientX),
      y: Math.min(marqueeStart.y, e.clientY),
      w: Math.abs(e.clientX - marqueeStart.x),
      h: Math.abs(e.clientY - marqueeStart.y),
      snip: marqueeStart.snip,
    };
  }
  function onMarqueeUp() {
    const start = marqueeStart;
    const m = marquee;
    marqueeStart = null;
    marquee = null;
    if (!start || !m || !viewer || m.w < 24 || m.h < 24) return;
    skipNextClick = true;
    const view = viewer.getPageView(start.page - 1);
    const vp = view?.viewport;
    if (!vp) return;
    const pr = start.pageDiv.getBoundingClientRect();
    const [ax, ay] = vp.convertToPdfPoint(m.x - pr.left, m.y - pr.top);
    const [bx, by] = vp.convertToPdfPoint(m.x + m.w - pr.left, m.y + m.h - pr.top);
    const rect: [number, number, number, number] = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    if (start.snip) onRegionSnip?.({ page: start.page, rect, anchor: { x: m.x + m.w, y: m.y + m.h } });
    else onRegionPop?.({ page: start.page, rect });
  }
  /** The page's PDF view box [x1,y1,x2,y2] (PDF points, y-up) — for clamping snip rects. */
  export async function pageBox(pageNo: number): Promise<[number, number, number, number] | null> {
    if (!pdfDoc) return null;
    const page = await pdfDoc.getPage(pageNo);
    return page.view as [number, number, number, number];
  }
  /** Render a page region (PDF units) at 2× the given CSS width → PNG data URL.
   *  An explicit `opts.scale` (px per PDF point) overrides the cssWidth sizing —
   *  the snip save path renders at SNIP_SCALE so the stamped dpi (72×scale) holds. */
  export async function renderRegion(
    pageNo: number,
    rect: [number, number, number, number],
    cssWidth = 460,
    opts: { scale?: number } = {},
  ): Promise<string | null> {
    if (!pdfDoc) return null;
    const page = await pdfDoc.getPage(pageNo);
    const [x1, y1, x2, y2] = rect;
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    const scale = opts.scale ?? (cssWidth * 2) / w;
    const vp = page.getViewport({ scale });
    const [vx, vy] = vp.convertToViewportPoint(x1, y2); // region's top-left in viewport space
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -vx, -vy] }).promise;
    } catch {
      return null;
    }
    return canvas.toDataURL("image/png");
  }

  // --- selection → highlight menu ------------------------------------------------
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
    const st = pageInfos.get(page);
    if (!st) return;
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
  async function pick(color: string) {
    if (!menu) return;
    // snapshot: menu is $state — hand callers a plain object, not a reactive proxy
    const req = { page: menu.page, anchor: $state.snapshot(menu.anchor), color };
    menu = null;
    try {
      const ok = await onCreate?.(req);
      if (ok === false) return; // create failed — keep the selection so a retry is one gesture
      window.getSelection()?.removeAllRanges();
    } catch {
      /* rejected create — same: keep the selection (the parent surfaces the error) */
    }
  }
  function askSelection() {
    if (menu) onAskSelection?.(menu.anchor.quote, menu.page);
    menu = null;
    window.getSelection()?.removeAllRanges();
  }

  onMount(() => {
    let cancelled = false;
    const host = container!;
    host.addEventListener("wheel", onWheel, { passive: false });

    bus = new EventBus();
    const linkService = new PDFLinkService({ eventBus: bus, externalLinkTarget: LinkTarget.BLANK });
    const findController = new PDFFindController({ eventBus: bus, linkService, updateMatchesCountOnProgress: true });
    const pdfViewer = new PDFViewer({
      container: host,
      viewer: viewerDiv,
      eventBus: bus,
      linkService,
      findController,
      removePageBorders: true, // page box == border box → the %-box overlay geometry is exact
    });
    viewer = pdfViewer;
    linkSvc = linkService;
    linkService.setViewer(pdfViewer);

    bus.on("pagesinit", () => {
      aliasPages();
      // Fit-width is the reader's home zoom; a saved per-paper view overrides it (R5).
      pdfViewer.currentScaleValue = initialView?.scaleValue || "page-width";
    });
    bus.on("pagesloaded", (e: { pagesCount: number }) => {
      numPages = e.pagesCount;
      status = "ready";
      if (initialView?.page && initialView.page > 1 && initialView.page <= e.pagesCount) {
        pdfViewer.currentPageNumber = initialView.page;
      }
      onPage?.(pdfViewer.currentPageNumber, e.pagesCount);
    });
    bus.on("pagerendered", () => {
      rendered += 1;
    });
    bus.on("textlayerrendered", (e: { pageNumber: number }) => {
      if (!cancelled) attachPage(e.pageNumber);
    });
    bus.on("pagechanging", (e: { pageNumber: number }) => {
      if (status === "ready") onPage?.(e.pageNumber, numPages);
    });
    bus.on("scalechanging", (e: { scale: number }) => onScale?.(e.scale));
    bus.on("updatefindmatchescount", onMatchesCount);
    bus.on("updatefindcontrolstate", onMatchesCount);

    const base = new URL("pdfjs/", document.baseURI).href; // dev: http://…/pdfjs/  prod: file://…/dist/pdfjs/
    // .create (not `new`): the constructor's upstream .d.ts mis-types `port` as null.
    const worker = PDFWorker.create({ port: new PdfWorkerPort() });
    const task = getDocument({
      data: new Uint8Array(buffer.slice(0)),
      worker,
      cMapUrl: base + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      wasmUrl: base + "wasm/",
      iccUrl: base + "iccs/",
      // Draw non-embedded fonts from the shipped standard fonts rather than the OS —
      // keeps rendering deterministic across machines (missing font → Symbol → Greek).
      useSystemFonts: false,
    });
    // Big-PDF feedback: fold the loading task's progress into the "Loading…" message.
    if ("onProgress" in task) {
      task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
        if (cancelled || !total || !Number.isFinite(total)) return;
        const mb = total / 1048576;
        loadNote = `${Math.min(100, Math.round((loaded / total) * 100))}% of ${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
      };
    }

    (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        pdfDoc = pdf;
        pdfViewer.setDocument(pdf);
        linkService.setDocument(pdf, null);
      } catch (e) {
        if (!cancelled) {
          status = "error";
          errMsg = (e as Error)?.message || String(e);
        }
      }
    })();

    return () => {
      cancelled = true;
      host.removeEventListener("wheel", onWheel);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      clearTimeout(citeTimer);
      pageInfos.clear();
      hitMap.clear();
      annotsCache.clear();
      itemsCache.clear();
      pdfDoc = undefined;
      linkSvc = undefined;
      try {
        pdfViewer.setDocument(null as never);
        linkService.setDocument(null, null);
      } catch {
        /* ignore */
      }
      void task.destroy().catch(() => {});
      try {
        worker.destroy();
      } catch {
        /* ignore */
      }
      viewer = undefined;
      bus = undefined;
    };
  });
</script>

<svelte:window onmousedown={() => (menu = null)} onmousemove={onMarqueeMove} onmouseup={onMarqueeUp} />

<div class="pdf-root" data-testid="pdf-root" data-pages={numPages} data-rendered={rendered} data-hl-blend={HL_BLEND ? "on" : "off"}>
  {#if status === "error"}
    <div class="msg err">Couldn't render this PDF: {errMsg}</div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events, a11y_no_noninteractive_tabindex, a11y_mouse_events_have_key_events -->
  <div
    class="pdf-scroll"
    bind:this={container}
    tabindex="-1"
    onmousedown={onPointerDown}
    onmouseup={onMouseUp}
    onmousemove={onPointerMove}
    onmouseover={onOver}
    onmouseout={onOut}
    onclick={onContainerClick}
    onclickcapture={onClickCapture}
    class:hidden={status === "error"}>
    <div class="pdfViewer" bind:this={viewerDiv}></div>
  </div>
  {#if marquee}
    <div class="marquee" class:snip={marquee.snip} style:left="{marquee.x}px" style:top="{marquee.y}px" style:width="{marquee.w}px" style:height="{marquee.h}px"></div>
  {/if}
  {#if status === "loading"}
    <div class="msg loading">Loading…{loadNote ? ` ${loadNote}` : ""}</div>
  {/if}

  {#if menu && (canHighlight || onAskSelection)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="hl-menu" class:below={menu.below} style:left="{menu.x}px" style:top="{menu.y}px" onmousedown={(e) => e.stopPropagation()}>
      {#if canHighlight}
        {#each ANNOTATION_COLORS as c}
          <button class="dot" style:background={hlSwatch(c)} title="Highlight ({c})" aria-label={`Highlight ${c}`} onclick={() => void pick(c)}></button>
        {/each}
      {/if}
      {#if onAskSelection}
        {#if canHighlight}<span class="mdiv"></span>{/if}
        <button class="mask" title="Ask Claude about this passage" aria-label="Ask Claude about this passage" onclick={askSelection}>✦</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pdf-root {
    position: absolute;
    inset: 0;
  }
  /* PDFViewer requires an absolutely-positioned scroll container. color-scheme pins
     pdf_viewer.css's light-dark() tokens to light — pages stay paper-white in the
     dark app chrome. */
  .pdf-scroll {
    position: absolute;
    inset: 0;
    overflow: auto;
    background: var(--c-surface);
    color-scheme: only light;
    padding: 16px 0;
    outline: none;
  }
  .pdf-scroll.hidden {
    display: none;
  }
  :global(.pdf-scroll .pdfViewer .page) {
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
    /* Scope the highlight layer's multiply blend to THIS page's stacking context.
       Without it the blend group is the whole app — the source of the GPU-readback
       smearing that made an earlier pass abandon mix-blend-mode entirely. */
    isolation: isolate;
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
  /* LR-6: find matches are painted by PDFFindController INSIDE the text layer
     (.highlight spans under the transparent glyphs) — retint from pdf.js purple to
     the reader's amber; the active match pops. */
  :global(.pdf-page .textLayer .highlight) {
    --highlight-bg-color: rgb(255 214 110 / 0.55);
    --highlight-selected-bg-color: rgb(255 150 40 / 0.75);
  }
  /* R5: the alt+drag figure marquee. */
  .marquee {
    position: fixed;
    z-index: 45;
    pointer-events: none;
    border: 1.5px dashed var(--c-accent);
    background: var(--c-accent-tint-2, rgba(67, 133, 190, 0.08));
    border-radius: 2px;
  }
  /* Snip capture reads as "camera", not "pop-out": solid border, no tint. */
  .marquee.snip {
    border-style: solid;
    background: transparent;
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
  .mdiv {
    width: 1px;
    align-self: stretch;
    background: var(--c-line);
    margin: 0 1px;
  }
  .mask {
    border: none;
    background: none;
    color: var(--c-accent);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0 3px;
  }
  .mask:hover {
    transform: scale(1.15);
  }
</style>
