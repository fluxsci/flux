<script lang="ts" module>
  // One reader-context writer at a time across every mounted ReaderDoc (paper switches
  // today; tabs/split panes later): the last instance to WRITE owns
  // <FluxLib>/.fluxlib/reader-context.json, and only the owner clears it on destroy —
  // a departing instance must never wipe the context another open document just wrote.
  let ctxOwner: symbol | null = null;
</script>

<script lang="ts">
  // FluxReader document — everything scoped to ONE open paper. Loads the paper named by
  // the (immutable) `citekey` prop from <FluxLib>/items/<citekey>/ (PDF bytes +
  // annotations) and renders it with PdfView, flanked by a reference sidebar (the
  // paper's OpenAlex referenced_works → add to FluxLib) and an annotations panel (this
  // paper's highlights → click to scroll, delete). Highlights persist to
  // items/<citekey>/annotations.json. ReaderMode hosts one instance per open document;
  // switching papers mounts a fresh instance, so per-paper state needs no reset path.
  import { onMount, onDestroy, tick, type Snippet } from "svelte";
  import { readerFind } from "./readerStore";
  import { fluxLibRevision } from "../../../lib/references/revision";
  import {
    readerPdfBytes,
    readerSource,
    writeReaderContext,
    clearReaderContext,
    listSupplements,
    readerSupplementBytes,
    ingestSupplementFile,
  } from "../../../lib/references/itemsBridge";
  import { fileBridge } from "../../../lib/project/types";
  import { pushToast, errMsg } from "../../../lib/toast";
  import { loadAnnotations, addAnnotation, updateAnnotation, deleteAnnotation, annotationsRev } from "../../../lib/references/annotationsBridge";
  import { saveAnnotationsMarkdown } from "../../../lib/io";
  import { hlSwatch } from "../../../lib/references/annotationColors";
  import { loadFluxLib } from "../../../lib/references/fluxlibBridge";
  import { referencedWorksByKey, citingWorksByKey } from "../../../lib/references/enrichBridge";
  import { cachedCiters, cacheCiters, type CitersSort } from "../../../lib/references/citersCache";
  import { pdfKeys, refreshPdfKeys, hasPdfIn } from "../../../lib/references/pdfPresence";
  import { readerLayout, READER_LAYOUT_DEFAULTS } from "./readerLayoutStore";
  import { openReaderTab } from "./readerStore";
  import ReaderLibraryPanel from "./ReaderLibraryPanel.svelte";
  import { addDoiToLibrary } from "../paper/scholar/bibLoad";
  import { bareDoi } from "../../../lib/references/pdfFinder";
  import type { WorldBrief } from "../../../lib/references/openalex";
  import type { RefEntry } from "../../../lib/references/types";
  import type { Annotation, TextQuoteSelector } from "../../../lib/references/annotations";
  import type { ReaderContext } from "../../../lib/references/items";
  import { matchRefToBriefs, type CitePreviewRequest, type FlatOutlineItem } from "../../../lib/pdf/citePreview";
  import { groupMatches, type FindMatch, type OutlineSection } from "../../../lib/pdf/findMatches";
  import PdfView from "./PdfView.svelte";
  import Icon from "../../Icon.svelte";
  import HighlightPopover from "./HighlightPopover.svelte";
  import CitePreview from "./CitePreview.svelte";
  import FigurePanel from "./FigurePanel.svelte";
  import SnipNamePopover from "./SnipNamePopover.svelte";
  import { get } from "svelte/store";
  import { currentProject } from "../../shellStore";
  import { dataUrlToBytes } from "../../../lib/assets";
  import { injectPngDpi, injectPngText } from "../../../lib/figure/pngDpi";
  import {
    SNIP_DIR,
    SNIP_SCALE,
    SNIP_TEXT_KEYWORD,
    composeSnipCitation,
    defaultSnipName,
    sanitizeSnipName,
    dedupSnipName,
    normSnipRect,
    snipRasterPlan,
    encodeSnipMeta,
    sidecarText,
    type SnipMeta,
    type SnipRect,
  } from "../../../lib/references/snips";

  let {
    citekey: citekeyProp,
    active = true,
    focused = true,
    agentOpen = false,
    onToggleAgent,
    onAsk,
    agentPane,
  }: {
    /** The paper this instance renders — immutable for the instance's lifetime. */
    citekey: string;
    /** This document is its pane's visible one (hidden kept-alive instances pass false). */
    active?: boolean;
    /** Active AND the hosting pane is focused — gates the window keyboard handler. */
    focused?: boolean;
    /** The shell's shared-terminal state + toggle (the terminal itself is ReaderMode's). */
    agentOpen?: boolean;
    onToggleAgent?: () => void;
    /** Route an Ask-AI question (prefix + quote) into the shell's shared terminal. */
    onAsk?: (prefix: string, quote: string) => void;
    /** The shell-owned terminal pane, rendered inside this doc's PDF column when open. */
    agentPane?: Snippet;
  } = $props();

  // The citekey never changes for a mounted instance (a paper switch mounts a fresh
  // ReaderDoc), so capture it once as a plain constant — every load/persistence call
  // below deliberately binds the initial value.
  // svelte-ignore state_referenced_locally
  const citekey = citekeyProp;

  // This instance's claim token on the module-level reader-context ownership.
  const ctxToken = Symbol();
  // False once destroyed — guards async continuations (loads resolving after unmount).
  let alive = true;

  let buffer = $state<ArrayBuffer | null>(null); // the MAIN paper.pdf bytes (source of truth)
  let annotations = $state<Annotation[]>([]);
  let loading = $state(true);

  // R6: multiple PDFs per paper. paper.pdf is the main text; items/<key>/supplements/ holds
  // optional supplementary PDFs. A "Switch PDF" dropdown lets the reader view any of them.
  // The main buffer is never overwritten (so annotations / re-fetch stay anchored to it); a
  // supplement is loaded into suppBuffer and the viewer renders whichever is active.
  let supplements = $state<string[]>([]);
  let activePdf = $state<{ kind: "main" } | { kind: "supp"; name: string }>({ kind: "main" });
  let suppBuffer = $state<ArrayBuffer | null>(null);
  let switchOpen = $state(false);
  let attaching = $state(false);
  const onSupplement = $derived(activePdf.kind === "supp");
  const viewBuffer = $derived(activePdf.kind === "main" ? buffer : suppBuffer);
  let entry = $state<RefEntry | null>(null);
  let libDois = $state<Set<string>>(new Set());

  // Reference sidebar (the paper's referenced_works).
  let refs = $state<WorldBrief[]>([]);
  let refsState = $state<"idle" | "loading" | "done" | "error">("idle");
  let addingId = $state("");

  // Forward citations — the papers that cite THIS one. A live OpenAlex query (unlike
  // the immutable reference list), so it loads lazily on first tab activation and is
  // cached per sort; ⟳ re-queries. citingWorksByKey THROWS when the paper hasn't been
  // enriched (no OpenAlex id), which is a distinct empty state from "nobody cites it".
  let citers = $state<WorldBrief[]>([]);
  let citersState = $state<"idle" | "loading" | "done" | "error" | "unenriched">("idle");
  let citersSort = $state<CitersSort>("cited");
  let citersAt = $state<string | null>(null);
  // DOI → citekey for everything in FluxLib, so a brief can offer "open its PDF".
  let libKeyByDoi = $state<Map<string, string>>(new Map());

  // R5: per-paper view persistence (page/zoom/layout/sidebars) — localStorage, this
  // machine's reading state, not FluxLib data. Loaded ONCE here, before PdfView mounts.
  const viewKey = (k: string) => `flux-reader-view:${k}`;
  type SavedView = {
    page?: number;
    scaleValue?: string;
    layout?: "vertical" | "horizontal" | "wrapped" | "two-up";
    showRefs?: boolean;
    showAnnots?: boolean;
    at?: number; // last-saved stamp (drives the LRU trim)
  };
  function loadView(k: string): SavedView | null {
    try {
      return JSON.parse(localStorage.getItem(viewKey(k)) ?? "null") as SavedView | null;
    } catch {
      return null;
    }
  }
  const saved0 = loadView(citekey);

  // Sidebar visibility + a scroll signal for the PDF (click an annotation → scroll).
  let showRefs = $state(typeof saved0?.showRefs === "boolean" ? saved0.showRefs : true);
  let showAnnots = $state(typeof saved0?.showAnnots === "boolean" ? saved0.showAnnots : true);
  let scrollTo = $state<{ id?: string; page?: number; nonce: number } | null>(null);
  // LR-13: ids whose quote no longer locates on their rendered page (PdfView reports them).
  let orphans = $state<Set<string>>(new Set());
  // LR-6: zoom/fit/layout/page-nav — PdfView (pdf.js PDFViewer) owns the mechanics; the
  // toolbar drives it through the bound instance and reads the live scale back.
  let pdfView = $state<PdfView | undefined>();
  let scalePct = $state(100);
  const LAYOUTS: Record<string, { scroll: "vertical" | "horizontal" | "wrapped"; spread: "none" | "odd" }> = {
    vertical: { scroll: "vertical", spread: "none" },
    horizontal: { scroll: "horizontal", spread: "none" },
    wrapped: { scroll: "wrapped", spread: "none" },
    "two-up": { scroll: "vertical", spread: "odd" },
  };
  let layout = $state<"vertical" | "horizontal" | "wrapped" | "two-up">(
    saved0?.layout && saved0.layout in LAYOUTS ? saved0.layout : "vertical",
  );
  let curPage = $state(1);
  let totalPages = $state(0);
  function applyLayout() {
    pdfView?.setLayout(LAYOUTS[layout]);
  }
  function jumpToPage(n: number) {
    pdfView?.goToPage(n);
  }
  // A cleared/garbled page input must not coerce to 0 and warp to page 1 — restore
  // the current page instead of navigating.
  function jumpFromInput(e: Event & { currentTarget: EventTarget & HTMLInputElement }) {
    const v = Number(e.currentTarget.value);
    if (!Number.isInteger(v) || v < 1) {
      e.currentTarget.value = String(curPage);
      return;
    }
    jumpToPage(v);
  }
  let nonce = 0;

  // LR-6: find-in-document. The heavy lifting (all-page text index, match location, overlay) lives
  // in PdfView; here we own the search bar + drive it via a nonce-bumped `find` prop and read back
  // the {total,index,page} result for the counter.
  // Find lives in the left rail's SEARCH tab (Ctrl+F): the query box, the counter, the
  // step buttons and the full result list are all there, so a search is something you
  // keep beside the page rather than a bar that covers it. PdfView still owns the
  // mechanics (highlight-all, stepping) through the same nonce protocol.
  let findQuery = $state("");
  let findNonce = $state(0);
  let findDir = $state<"first" | "next" | "prev">("first");
  // The result list is AUTHORITATIVE for which hit is current: pdf.js re-reports its
  // position several times per advance (and once more after a jump lands), so letting
  // its events drive the selected row makes the counter jitter backwards.
  let activeIdx = $state(-1);
  let findInput = $state<HTMLInputElement | undefined>(undefined);
  let findDebounce: ReturnType<typeof setTimeout> | undefined;
  let matches = $state<FindMatch[]>([]);
  let sections = $state<OutlineSection[]>([]);
  const findProp = $derived(findQuery.trim() ? { query: findQuery.trim(), nonce: findNonce, dir: findDir } : null);
  const matchGroups = $derived(groupMatches(matches, sections));
  function openFind() {
    showRefs = true;
    sideTab = "search";
    // Section labels need the outline resolved to page numbers — once per document.
    if (!sections.length) void pdfView?.outlineSections().then((s) => { if (alive) sections = s; });
    setTimeout(() => findInput?.select(), 0);
  }
  function clearFind() {
    findQuery = "";
    matches = [];
    activeIdx = -1;
    clearTimeout(findDebounce);
  }
  function onFindInput() {
    clearTimeout(findDebounce);
    findDebounce = setTimeout(() => {
      findDir = "first"; // a changed query always jumps to the first hit (PdfView rebuilds the set)
      activeIdx = 0; // …which is the hit PdfView selects
      findNonce++;
    }, 200);
  }
  /** Step through the list — the same jump the rows use, so ‹ › and clicking agree. */
  function stepFind(dir: "next" | "prev") {
    if (!matches.length) return;
    const n = matches.length;
    activeIdx = (((activeIdx < 0 ? 0 : activeIdx) + (dir === "next" ? 1 : -1)) % n + n) % n;
    pdfView?.goToMatch(matches[activeIdx], findQuery.trim());
  }
  /** Click a result row → jump straight to that hit, wherever it is in the document. */
  function goToMatch(m: FindMatch) {
    activeIdx = m.index;
    pdfView?.goToMatch(m, findQuery.trim());
  }
  // 2.3: a full-text hit in the Library opens the reader here AND jumps to the term.
  // openInReader bumps readerFind; we mirror it into the find bar. PdfView's find effect
  // waits for `status==="ready"`, so setting this before the new PDF loads is safe — it
  // fires once the pages mount. `term:""` (a plain open) closes any transient search.
  // The intent carries the target citekey, so an instance ignores intents addressed to
  // another paper (a fresh mount must not adopt a stale find from a previous open).
  let lastFindOpenNonce = -1;
  $effect(() => {
    const f = $readerFind;
    if (f.nonce === lastFindOpenNonce) return;
    lastFindOpenNonce = f.nonce;
    if (f.key !== citekey) return;
    if (!f.term) {
      clearFind();
      return;
    }
    openFind();
    findQuery = f.term;
    findDir = "first";
    findNonce++;
  });
  function findKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      stepFind(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      clearFind();
    }
  }

  // The human's live text selection (pushed via reader-context.json for any agent
  // session's get_reading_context).
  let selection = $state("");
  let selPage = $state<number | undefined>(undefined);
  let ctxTimer: ReturnType<typeof setTimeout> | undefined;

  // Highlight popover (click a highlight on the page, or ✎ on a sidebar row).
  let popover = $state<{ id: string; x: number; y: number; place: "above" | "below" } | null>(null);
  const popAnn = $derived(popover ? (annotations.find((a) => a.id === popover!.id) ?? null) : null);
  // Hover sync: page → sidebar row, sidebar row → page boxes.
  let pageHoverId = $state<string | null>(null);
  let sideHoverId = $state<string | null>(null);

  // R4: citation hover card + left-sidebar tab (references | outline) + back-stack.
  let cite = $state<
    | null
    | {
        kind: "internal" | "external";
        text?: string;
        url?: string;
        destPage?: number;
        x: number;
        y: number;
        place: "above" | "below";
        brief: WorldBrief | null;
      }
  >(null);
  let citeHide: ReturnType<typeof setTimeout> | undefined;
  function handleCitePreview(req: CitePreviewRequest | null) {
    if (!req) {
      // Debounced hide: moving from the link onto the card keeps it open.
      clearTimeout(citeHide);
      citeHide = setTimeout(() => (cite = null), 300);
      return;
    }
    clearTimeout(citeHide);
    const brief =
      req.kind === "internal"
        ? (req.text ? (matchRefToBriefs(req.text, refs)?.brief ?? null) : null)
        : (refs.find((b) => {
            const d = bareDoi(b.doi);
            return !!d && (req.url ?? "").toLowerCase().includes(d);
          }) ?? null);
    const x = Math.min(Math.max(req.rect.left + req.rect.width / 2, 182), window.innerWidth - 182);
    const below = req.rect.bottom + 230 < window.innerHeight;
    cite = {
      kind: req.kind,
      text: req.text,
      url: req.url,
      destPage: req.destPage,
      x,
      y: below ? req.rect.bottom + 6 : req.rect.top - 6,
      place: below ? "below" : "above",
      brief,
    };
  }
  const citeKeepOpen = () => clearTimeout(citeHide);
  const citeClose = () => {
    clearTimeout(citeHide);
    cite = null;
  };
  let navDepth = $state(0);
  let sideTab = $state<"refs" | "citers" | "search" | "outline">("refs");
  let outline = $state<FlatOutlineItem[] | null>(null); // null = not fetched yet (or doc not ready)
  async function showOutline() {
    sideTab = "outline";
    if (outline !== null) return;
    const o = await pdfView?.getOutline();
    // null/undefined = the document is still parsing — keep the "Loading outline…"
    // state (the effect below retries once pages exist) instead of caching a false
    // "This PDF has no outline".
    if (o) outline = o;
  }
  // Retry a too-early outline fetch: totalPages flips 0 → N when a (re)mounted
  // document finishes loading, so a click that landed mid-parse resolves itself.
  $effect(() => {
    if (sideTab === "outline" && outline === null && totalPages > 0) void showOutline();
  });

  async function loadCiters(force = false) {
    const sort = citersSort;
    if (!force) {
      const hit = await cachedCiters(citekey, sort);
      if (!alive || sort !== citersSort) return;
      if (hit) {
        citers = hit.briefs;
        citersAt = hit.fetchedAt;
        citersState = "done";
        return;
      }
    }
    citersState = "loading";
    try {
      const list = await citingWorksByKey(citekey, {
        sort: sort === "cited" ? "cited_by_count:desc" : "publication_date:desc",
        perPage: 50,
        page: 1,
      });
      if (!alive || sort !== citersSort) return;
      citers = list;
      citersState = "done";
      citersAt = new Date().toISOString();
      void cacheCiters(citekey, sort, list);
    } catch (e) {
      if (!alive || sort !== citersSort) return;
      // "Enrich this entry first…" is a setup state, not a failure.
      citersState = /enrich/i.test(errMsg(e)) ? "unenriched" : "error";
    }
  }
  function showCiters() {
    sideTab = "citers";
    if (citersState === "idle") void loadCiters();
  }
  function setCitersSort(s: CitersSort) {
    if (citersSort === s) return;
    citersSort = s;
    citers = [];
    citersAt = null;
    citersState = "idle";
    void loadCiters();
  }
  // R5: click a reference row → expand its abstract/details in place.
  let expandedRefId = $state("");
  const toggleRef = (id: string) => (expandedRefId = expandedRefId === id ? "" : id);

  // "Show in sidebar" from the hover card: reveal + flash the matched reference row.
  // Scoped to THIS doc's root: ref-row ids repeat across kept-alive documents that
  // share references, so a document-wide getElementById could scroll a hidden sibling.
  let rootEl = $state<HTMLElement | undefined>();
  let flashRefId = $state("");
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  async function showRefInSidebar(b: WorldBrief) {
    showRefs = true;
    sideTab = "refs";
    citeClose();
    await tick();
    rootEl?.querySelector(`[id="ref-${b.openalexId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    flashRefId = b.openalexId;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashRefId = ""), 1600);
  }

  // R5: floating figure panels (alt+drag a page region) — scoped to this paper.
  let figPanels = $state<{ id: number; src: string; page: number; x: number; y: number; z: number }[]>([]);
  let figSeq = 0;
  let figZ = 70;
  async function popRegion(req: { page: number; rect: [number, number, number, number] }) {
    const src = await pdfView?.renderRegion(req.page, req.rect);
    if (!src) return;
    const n = ++figSeq;
    figPanels = [...figPanels, { id: n, src, page: req.page, x: 140 + (n % 5) * 30, y: 110 + (n % 5) * 26, z: ++figZ }];
  }
  const raiseFig = (id: number) => {
    figPanels = figPanels.map((f) => (f.id === id ? { ...f, z: ++figZ } : f));
  };

  // Paper snips: ctrl+alt+drag a region → naming popover → 288dpi PNG (+ provenance
  // tEXt chunk + .snip.json sidecar) into <project>/plots/paper_snips/. The popover
  // opens instantly on mouseup; the full-quality render happens on save (§6).
  let snipReq = $state<{ page: number; rect: SnipRect; anchor: { x: number; y: number }; name: string; citation: string } | null>(null);
  let snipPreview = $state<string | null>(null);
  let snipSaving = $state(false);
  let snipError = $state("");
  const snipExists = (root: string) => (name: string) => fileBridge()?.exists(`${root}/${SNIP_DIR}/${name}.png`) ?? Promise.resolve(false);
  async function snipRegion(req: { page: number; rect: SnipRect; anchor: { x: number; y: number } }) {
    const root = get(currentProject)?.path ?? null;
    if (!root) {
      pushToast("info", "Open a project to save paper snips");
      return;
    }
    const name = await dedupSnipName(defaultSnipName(citekey, req.page), snipExists(root));
    snipError = "";
    snipPreview = null;
    snipReq = { ...req, name, citation: composeSnipCitation(entry, citekey) };
    void pdfView?.renderRegion(req.page, req.rect, 130).then((src) => {
      if (snipReq) snipPreview = src;
    });
  }
  async function saveSnip(rawName: string) {
    const req = snipReq;
    const root = get(currentProject)?.path ?? null;
    if (!req || !root || snipSaving) return;
    snipSaving = true;
    snipError = "";
    try {
      const base = sanitizeSnipName(rawName) || req.name;
      const name = await dedupSnipName(base, snipExists(root));
      const box = await pdfView?.pageBox(req.page);
      const rect = box ? normSnipRect(req.rect, box) : req.rect;
      const src = await pdfView?.renderRegion(req.page, rect, 460, { scale: SNIP_SCALE });
      if (!src) throw new Error("couldn't render the region");
      const meta: SnipMeta = {
        citekey,
        page: req.page,
        rect,
        sourcePdf: activePdf.kind === "supp" ? { supplement: activePdf.name } : "main",
        capturedAt: new Date().toISOString(),
        citation: req.citation,
      };
      let bytes = dataUrlToBytes(src);
      bytes = injectPngDpi(bytes, snipRasterPlan(rect, SNIP_SCALE).dpi);
      bytes = injectPngText(bytes, SNIP_TEXT_KEYWORD, encodeSnipMeta(meta));
      const fb = fileBridge();
      if (!fb) throw new Error("no file bridge available");
      await fb.mkdir(`${root}/plots`);
      await fb.mkdir(`${root}/${SNIP_DIR}`);
      await fb.writeFile(`${root}/${SNIP_DIR}/${name}.png`, bytes);
      await fb.writeText(`${root}/${SNIP_DIR}/${name}.snip.json`, sidecarText(meta));
      snipReq = null;
      snipPreview = null;
      pushToast("info", `Snip saved${name !== base ? ` as ${name}` : ""}`, { detail: `${SNIP_DIR}/${name}.png · ${meta.citation}` });
    } catch (e) {
      snipError = errMsg(e);
      pushToast("error", `Snip save failed: ${errMsg(e)}`);
    } finally {
      snipSaving = false;
    }
  }

  let initialView = $state<{ page?: number; scaleValue?: string } | null>(
    saved0 ? { page: saved0.page, scaleValue: saved0.scaleValue } : null,
  );
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let viewRestored = false; // don't persist the defaults that flash by before restore
  // Shadow of the last known view state for the destroy-time flush: PdfView may
  // already be torn down when onDestroy runs (child-before-parent destroy order),
  // so the flush must not depend on a live viewer.
  let lastVs: { page: number; scaleValue?: string } | null = null;
  function persistView(vs: { page: number; scaleValue?: string }) {
    const saved: SavedView = { page: vs.page, scaleValue: vs.scaleValue, layout, showRefs, showAnnots, at: Date.now() };
    try {
      localStorage.setItem(viewKey(citekey), JSON.stringify(saved));
      trimViewStates();
    } catch {
      /* storage full/blocked — reading state is best-effort */
    }
  }
  $effect(() => {
    void curPage;
    void scalePct;
    void layout;
    void showRefs;
    void showAnnots;
    if (!totalPages || !viewRestored) return;
    lastVs = pdfView?.getViewState() ?? lastVs;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const vs = pdfView?.getViewState();
      if (!vs) return;
      persistView(vs);
    }, 400);
  });

  // LRU cap: one entry per paper ever opened grows without bound over a library's
  // lifetime — keep the ~50 most recently read (entries predating the `at` stamp
  // count as oldest). Runs on the debounced save only.
  function trimViewStates(max = 50) {
    const prefix = "flux-reader-view:";
    const entries: { k: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(prefix)) continue;
      let at = 0;
      try {
        at = (JSON.parse(localStorage.getItem(k) ?? "{}") as SavedView).at ?? 0;
      } catch {
        /* unparseable → treat as oldest */
      }
      entries.push({ k, at });
    }
    if (entries.length <= max) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries.slice(0, entries.length - max)) localStorage.removeItem(e.k);
  }

  // Stamp of the on-disk PDF (source.json identity) so an external re-fetch/replace of
  // paper.pdf refreshes the open reader in place; bufferGen remounts PdfView.
  let srcStamp: string | null = null;
  let bufferGen = $state(0);
  const stampOf = (s: Awaited<ReturnType<typeof readerSource>>, b: ArrayBuffer | null) =>
    s ? `${s.sha256 ?? ""}:${s.bytes ?? ""}:${s.fetchedAt ?? ""}` : b ? "present" : "absent";

  // Load the paper. citekey is fixed for the life of this instance (a paper switch
  // mounts a fresh ReaderDoc), so the only staleness guard needed is `alive`.
  void Promise.all([
    readerPdfBytes(citekey),
    loadAnnotations(citekey),
    loadFluxLib(),
    readerSource(citekey),
    listSupplements(citekey),
  ]).then(([b, af, lib, src, sup]) => {
    if (!alive) return;
    buffer = b;
    annotations = af.annotations;
    entry = lib.find((e) => e.key === citekey) ?? null;
    libDois = new Set(lib.map((e) => bareDoi(e.doi)).filter((d): d is string => !!d));
    libKeyByDoi = new Map(lib.flatMap((e) => { const d = bareDoi(e.doi); return d ? [[d, e.key] as [string, string]] : []; }));
    srcStamp = stampOf(src, b);
    supplements = sup;
    loading = false;
  }).catch((e) => {
    // A rejected IPC/bridge call must not strand the pane on "Loading…" forever.
    if (!alive) return;
    loading = false;
    pushToast("error", "Couldn't load this paper", { detail: errMsg(e) });
  });
  // Which library papers have a PDF on disk — one throttled readdir, shared app-wide
  // (never a per-row exists() call), so reference rows can offer "open its PDF".
  refreshPdfKeys();

  // Reference list loads independently (network; needs the paper hydrated).
  refsState = "loading";
  void referencedWorksByKey(citekey).then((r) => {
    if (!alive) return;
    refs = r;
    refsState = "done";
  }).catch(() => {
    if (alive) refsState = "error";
  });

  // W10 (LR-3): an external FluxLib write (e.g. an agent's add_annotation, or a new
  // paper) refreshes the open paper's annotations + library membership in place —
  // and, if paper.pdf itself changed on disk (re-fetch, manual ingest), reloads the
  // bytes and remounts the PDF view (bufferGen keys it) instead of rendering stale bytes.
  onMount(() => {
    let first = true;
    return fluxLibRevision.subscribe(() => {
      if (first) { first = false; return; }
      void Promise.all([loadAnnotations(citekey), loadFluxLib(), readerSource(citekey)]).then(async ([af, lib, src]) => {
        if (!alive) return;
        annotations = af.annotations;
        libDois = new Set(lib.map((e) => bareDoi(e.doi)).filter((d): d is string => !!d));
    libKeyByDoi = new Map(lib.flatMap((e) => { const d = bareDoi(e.doi); return d ? [[d, e.key] as [string, string]] : []; }));
        const b = buffer;
        const stamp = stampOf(src, b);
        if (stamp !== srcStamp) {
          const fresh = await readerPdfBytes(citekey);
          if (!alive) return;
          srcStamp = stampOf(src, fresh);
          buffer = fresh;
          if (activePdf.kind === "main") {
            bufferGen++;
            outline = null; // new bytes → the cached outline belongs to the old doc
            totalPages = 0;
          }
        }
        // R6: reflect supplements added/removed on disk; if the shown one vanished, fall back.
        const sup = await listSupplements(citekey);
        if (!alive) return;
        supplements = sup;
        if (activePdf.kind === "supp" && !sup.includes(activePdf.name)) showMain();
      });
    });
  });

  // Foreign-write sync: another view of THIS paper (a split pane, a kept-alive tab)
  // writing a highlight bumps annotationsRev → reload from disk. Our OWN writes update
  // `annotations` optimistically (object identity keeps PdfView's locate cache hot), so
  // we skip exactly the bumps we caused — every bridge mutation produces one bump, and
  // the handlers below count theirs before awaiting.
  let selfAnnWrites = 0;
  onMount(() => {
    let first = true;
    return annotationsRev.subscribe((r) => {
      if (first) { first = false; return; }
      if (r.key !== citekey) return;
      if (selfAnnWrites > 0) { selfAnnWrites--; return; }
      void loadAnnotations(citekey).then((af) => {
        if (!alive) return;
        annotations = af.annotations;
      });
    });
  });

  // R6: PDF switcher. Show the main paper (its already-loaded buffer) or a supplement
  // (loaded on demand into suppBuffer). bufferGen remounts PdfView with the new bytes.
  const suppLabel = (n: string) => n.replace(/\.pdf$/i, "");
  function showMain() {
    switchOpen = false;
    if (activePdf.kind === "main") return;
    activePdf = { kind: "main" };
    suppBuffer = null;
    outline = null; // the outline sidebar tracks the VISIBLE document
    totalPages = 0;
    bufferGen++;
  }
  async function showSupplement(name: string) {
    switchOpen = false;
    if (activePdf.kind === "supp" && activePdf.name === name) return;
    const b = await readerSupplementBytes(citekey, name);
    if (!alive) return;
    if (!b) {
      pushToast("error", `Couldn't open ${name} — it may have been moved`);
      return;
    }
    suppBuffer = b;
    activePdf = { kind: "supp", name };
    outline = null; // the outline sidebar tracks the VISIBLE document
    totalPages = 0;
    bufferGen++;
  }
  // Attach a PDF (OS picker) into this paper's supplements/ folder, then show it.
  async function attachSupplement() {
    if (attaching) return;
    switchOpen = false;
    const picked = await fileBridge()?.openFiles?.([{ name: "PDF", extensions: ["pdf"] }]);
    const file = picked?.[0];
    if (!file) return;
    attaching = true;
    try {
      const name = await ingestSupplementFile(citekey, file);
      if (!alive) return;
      if (!name) {
        pushToast("error", "That file isn't a readable PDF");
        return;
      }
      supplements = await listSupplements(citekey);
      await showSupplement(name);
    } catch (e) {
      pushToast("error", "Couldn't attach the PDF", { detail: errMsg(e) });
    } finally {
      attaching = false;
    }
  }

  // Returns false when nothing was persisted — PdfView then keeps the text selection
  // alive so the user can retry the highlight without re-selecting.
  async function handleCreate(a: { page: number; anchor: TextQuoteSelector; color: string }): Promise<boolean> {
    if (onSupplement) return false; // highlights anchor to the MAIN text only
    selfAnnWrites++;
    try {
      const ann = await addAnnotation(citekey, { page: a.page, anchor: a.anchor, color: a.color });
      annotations = [...annotations, ann];
      return true;
    } catch (e) {
      selfAnnWrites--; // failed before the bump
      pushToast("error", "Couldn't save highlight", { detail: errMsg(e) });
      return false;
    }
  }
  async function handleDelete(id: string) {
    if (popover?.id === id) popover = null;
    selfAnnWrites++;
    try {
      await deleteAnnotation(citekey, id);
      annotations = annotations.filter((a) => a.id !== id);
    } catch (e) {
      selfAnnWrites--; // failed before the bump
      pushToast("error", "Couldn't delete highlight", { detail: errMsg(e) });
    }
  }
  // Patch note/color/tags. The patched object keeps its anchor reference, so PdfView's
  // located-range cache stays hot — a recolor is a repaint, not a re-locate.
  async function handleUpdate(id: string, patch: Partial<Annotation>) {
    selfAnnWrites++;
    try {
      await updateAnnotation(citekey, id, patch);
      annotations = annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
    } catch (e) {
      selfAnnWrites--; // failed before the bump
      pushToast("error", "Couldn't update highlight", { detail: errMsg(e) });
    }
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
  /** Returns the clipboard promise — the popover shows "Copied ✓" only on resolve. */
  function copyQuote(a: Annotation): Promise<void> {
    return navigator.clipboard
      ? navigator.clipboard.writeText(a.anchor.quote)
      : Promise.reject(new Error("Clipboard unavailable"));
  }
  function sendHighlightToTerminal(a: Annotation) {
    const note = a.note ? ` (my note: ${a.note})` : "";
    onAsk?.(`About my highlight on p${a.page}${note}:`, a.anchor.quote);
  }
  async function addRef(b: WorldBrief) {
    if (!b.doi || addingId) return;
    addingId = b.openalexId;
    try {
      const r = await addDoiToLibrary(b.doi);
      if ("error" in r) pushToast("error", "Couldn't add to FluxLib", { detail: r.error });
      else libDois = new Set(libDois).add(bareDoi(b.doi)!);
    } catch (e) {
      pushToast("error", "Couldn't add to FluxLib", { detail: errMsg(e) });
    } finally {
      addingId = "";
    }
  }

  const inLib = (b: WorldBrief) => !!(b.doi && libDois.has(bareDoi(b.doi)!));
  /** The FluxLib citekey for a brief (matched by DOI), or null if it isn't in the library. */
  const libKeyOf = (b: WorldBrief) => (b.doi ? (libKeyByDoi.get(bareDoi(b.doi)!) ?? null) : null);
  /** The citekey to read, i.e. in the library AND with a PDF on disk. */
  function readableKey(b: WorldBrief): string | null {
    const k = libKeyOf(b);
    return k && hasPdfIn($pdfKeys, k) ? k : null;
  }
  /** Open a cited/citing paper as a tab in this pane. */
  function openBriefPdf(b: WorldBrief) {
    const k = readableKey(b);
    if (k) openReaderTab(k);
  }
  const openDoi = (doi: string) => void fileBridge()?.openExternal?.(`https://doi.org/${bareDoi(doi)}`);
  const title = $derived(entry?.title ?? citekey);
  // Annotations in reading order (page, then first-seen).
  const orderedAnns = $derived([...annotations].sort((a, b) => a.page - b.page));

  function handleSelect(text: string, page?: number) {
    selection = text;
    if (page != null) selPage = page;
  }

  // Push the live reading context to <FluxLib>/.fluxlib/reader-context.json (debounced)
  // so the agent's get_reading_context tool can see the paper + selection + highlights.
  // Only the focused document publishes — hidden kept-alive tabs (and, later,
  // unfocused panes) must not overwrite what the paper being read just wrote.
  $effect(() => {
    if (!focused) return;
    const sel = selection;
    const e = entry;
    const anns = annotations;
    if (!buffer) return;
    clearTimeout(ctxTimer);
    const ctx: ReaderContext = {
      citekey,
      title: e?.title,
      authors: e?.authors,
      year: e?.year,
      doi: e?.doi,
      page: selPage,
      selection: sel || undefined,
      annotations: anns.map((a) => ({ page: a.page, color: a.color, quote: a.anchor.quote, note: a.note })),
      updatedAt: new Date().toISOString(),
    };
    ctxTimer = setTimeout(() => {
      ctxOwner = ctxToken;
      void writeReaderContext(ctx);
    }, 250);
  });

  // --- draggable rail edges → sidebar widths (the figure/slide gutter pattern;
  // persists via readerLayout). No preventDefault on pointerdown — it would suppress
  // the derived dblclick (reset affordance); text selection during the drag is blocked
  // via body user-select instead. The gutters are flex siblings OUTSIDE the scrolling
  // <aside>s, so they never scroll away.
  let rbodyEl = $state<HTMLElement | null>(null);
  const railMax = (min: number) => Math.max(min, Math.round(window.innerWidth * 0.4));
  function railDrag(apply: (x: number, rect: DOMRect) => void) {
    return () => {
      document.body.style.userSelect = "none";
      const move = (e: PointerEvent) => {
        if (rbodyEl) apply(e.clientX, rbodyEl.getBoundingClientRect());
      };
      const up = () => {
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
  }
  const startRefsDrag = railDrag((x, rect) => {
    const w = Math.max(180, Math.min(railMax(520), x - rect.left));
    readerLayout.update((s) => ({ ...s, refsW: Math.round(w) }));
  });
  const startAnnotsDrag = railDrag((x, rect) => {
    const w = Math.max(180, Math.min(railMax(560), rect.right - x));
    readerLayout.update((s) => ({ ...s, annotsW: Math.round(w) }));
  });
  const resetRefsW = () => readerLayout.update((s) => ({ ...s, refsW: READER_LAYOUT_DEFAULTS.refsW }));
  const resetAnnotsW = () => readerLayout.update((s) => ({ ...s, annotsW: READER_LAYOUT_DEFAULTS.annotsW }));

  // Alt+R (the manuscript writer's chord) summons the library search in the right rail.
  // It is a PANEL, not a transient layer: it stays until you switch tabs or hide the
  // rail — Escape deliberately does not close it.
  let librarySearchReq = $state(0);
  function summonLibrary() {
    showAnnots = true;
    readerLayout.update((s) => ({ ...s, rightTab: "library" }));
    librarySearchReq++; // focus the search box (fresh nonce even when already open)
  }
  function summonAnnotations() {
    showAnnots = true;
    readerLayout.update((s) => ({ ...s, rightTab: "annots" }));
  }

  function onKey(e: KeyboardEvent) {
    if (!focused) return; // kept-alive hidden panes must not react (inert blocks focus, not window listeners)
    // Alt chords: the panels (R = library, A = annotations, T = terminal).
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.code === "KeyR") {
        e.preventDefault();
        summonLibrary();
        return;
      }
      if (e.code === "KeyA") {
        e.preventDefault();
        summonAnnotations();
        return;
      }
      if (e.code === "KeyT") {
        e.preventDefault();
        onToggleAgent?.();
        return;
      }
    }
    const tag = (e.target as HTMLElement | null)?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      showAnnots = !showAnnots;
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      showRefs = !showRefs;
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      if (!buffer) return; // only when this reader pane has a PDF open
      e.preventDefault();
      openFind();
    } else if (e.key === "Escape") {
      if (switchOpen) switchOpen = false;
      else if (popover) popover = null;
      else if (agentOpen) onToggleAgent?.();
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

  // R6: dismiss the PDF-switch dropdown on any pointerdown outside it.
  let switchEl = $state<HTMLElement | undefined>();
  function onWinPointer(e: PointerEvent) {
    if (switchOpen && switchEl && !switchEl.contains(e.target as Node)) switchOpen = false;
  }

  onDestroy(() => {
    alive = false;
    // Flush the final view state (tab close / keep-alive eviction / app close) —
    // the debounced save may not have fired yet.
    clearTimeout(saveTimer);
    if (viewRestored) {
      const vs = pdfView?.getViewState() ?? lastVs;
      if (vs) persistView(vs);
    }
    clearTimeout(ctxTimer);
    if (ctxOwner === ctxToken) {
      ctxOwner = null;
      void clearReaderContext();
    }
  });
</script>

<svelte:window onkeydown={onKey} onpointerdown={onWinPointer} />

<!-- One row shape for both scholarly lists — the paper's references and the papers
     citing it. A brief that's in FluxLib with a PDF on disk opens as a tab. -->
{#snippet briefRow(b: WorldBrief)}
  {@const readable = readableKey(b)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <li
    class="ref"
    id={`ref-${b.openalexId}`}
    class:flash={flashRefId === b.openalexId}
    class:expanded={expandedRefId === b.openalexId}
    onclick={() => toggleRef(b.openalexId)}>
    <div class="rmeta">
      <span class="rauth">{b.authors.slice(0, 2).join(", ")}{b.authors.length > 2 ? " et al." : ""}{b.year ? ` · ${b.year}` : ""}</span>
      {#if b.citedByCount != null}<span class="rcite">{b.citedByCount.toLocaleString()}×</span>{/if}
    </div>
    <div class="rtitle2" class:unclamped={expandedRefId === b.openalexId} title={b.title}>{b.title}</div>
    {#if expandedRefId === b.openalexId}
      {#if b.container}<div class="rcontainer">{b.container}</div>{/if}
      {#if b.abstract}<div class="rabstract">{b.abstract}</div>{/if}
    {/if}
    <div class="ractions">
      {#if readable}
        <!-- The PDF is the point — reading it beats every other action on the row. -->
        <button class="pdfbtn" title="Open this paper's PDF in a tab"
          onclick={(e) => { e.stopPropagation(); openBriefPdf(b); }}>Open PDF</button>
      {:else if inLib(b)}
        <span class="inlib">✓ in library</span>
      {:else if b.doi}
        <button class="addbtn" disabled={addingId === b.openalexId} onclick={(e) => { e.stopPropagation(); addRef(b); }}
          >{addingId === b.openalexId ? "Adding…" : "+ FluxLib"}</button>
      {/if}
      {#if expandedRefId === b.openalexId && b.doi}
        <button class="rdoi" title="Open the DOI in your browser"
          onclick={(e) => { e.stopPropagation(); openDoi(b.doi!); }}>DOI ↗</button>
      {/if}
    </div>
  </li>
{/snippet}

<div class="rdoc" bind:this={rootEl} data-doc-key={citekey} data-doc-active={active}>
  {#if loading}
    <div class="empty">Loading “{citekey}”…</div>
  {:else if !buffer}
    <div class="empty">
      No PDF on disk for “{citekey}”. Use <strong>Get PDF</strong> in the Library to fetch it first.
    </div>
  {:else}
    <div class="chrome">
      <div class="rtoolbar">
        <button class="railtgl" class:on={showRefs} onclick={() => (showRefs = !showRefs)}
          aria-label="Toggle the left sidebar" title="Toggle the left sidebar (Ctrl+B)">
          <Icon name={showRefs ? "panelLeftFill" : "panelLeft"} size={16} />
        </button>
        <span class="rtitle" title={title}>{title}</span>
        <div class="rnav">
          <button class="zbtn" title="Back (after a link/outline jump)" aria-label="Back" disabled={!navDepth} onclick={() => pdfView?.goBack()}>←</button>
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
              aria-label="Jump to page" onchange={jumpFromInput} />
            <span class="pgtot">/ {totalPages || "…"}</span>
          </span>
        </div>
        <div class="pdfswitch" bind:this={switchEl}>
          <button
            class="tgl pdfswbtn"
            class:on={switchOpen || onSupplement}
            class:muted={!supplements.length && !onSupplement}
            data-testid="pdf-switch"
            aria-haspopup="menu"
            aria-expanded={switchOpen}
            title={supplements.length ? "Switch between the paper and its supplements" : "Attach a supplementary PDF"}
            onclick={() => (switchOpen = !switchOpen)}>
            {#if activePdf.kind === "supp"}⇄ {suppLabel(activePdf.name)}{:else if supplements.length}⇄ Paper ({supplements.length + 1}){:else}⧉ PDF{/if} ▾
          </button>
          {#if switchOpen}
            <div class="pdfmenu" role="menu" data-testid="pdf-menu">
              <button class="pdfitem" class:sel={activePdf.kind === "main"} role="menuitem" onclick={showMain}>
                <span class="pdfic">📄</span><span class="pdfnm">Main paper</span>{#if activePdf.kind === "main"}<span class="pdfck">✓</span>{/if}
              </button>
              {#each supplements as s (s)}
                <button class="pdfitem" class:sel={activePdf.kind === "supp" && activePdf.name === s} role="menuitem" onclick={() => showSupplement(s)}>
                  <span class="pdfic">📎</span><span class="pdfnm" title={s}>{suppLabel(s)}</span>{#if activePdf.kind === "supp" && activePdf.name === s}<span class="pdfck">✓</span>{/if}
                </button>
              {/each}
              <div class="pdfsep"></div>
              <button class="pdfitem add" role="menuitem" disabled={attaching} onclick={attachSupplement}>
                <span class="pdfic">＋</span><span class="pdfnm">{attaching ? "Adding…" : "Add supplement…"}</span>
              </button>
            </div>
          {/if}
        </div>
        <button class="railtgl" class:on={showAnnots} onclick={() => (showAnnots = !showAnnots)}
          aria-label="Toggle the right sidebar" title="Toggle the right sidebar (Ctrl+Shift+B)">
          <Icon name={showAnnots ? "panelRightFill" : "panelRight"} size={16} />
        </button>
      </div>
      <div
        class="rbody"
        bind:this={rbodyEl}
        style={`--refs-w:${$readerLayout.refsW}px; --annots-w:${$readerLayout.annotsW}px`}>
        {#if showRefs}
          <aside class="side refs">
            <div class="shead stabs">
              <button class="stab" class:on={sideTab === "refs"} onclick={() => (sideTab = "refs")}>References</button>
              <button class="stab" class:on={sideTab === "citers"} onclick={showCiters} title="Papers that cite this one">Cited by</button>
              <button class="stab" class:on={sideTab === "search"} onclick={openFind} title="Search this PDF (Ctrl+F)">Search</button>
              <button class="stab" class:on={sideTab === "outline"} onclick={() => void showOutline()}>Outline</button>
            </div>
            {#if sideTab === "search"}
              <div class="srch" data-testid="reader-search">
                <div class="srchbar">
                  <input
                    class="srchin"
                    bind:this={findInput}
                    bind:value={findQuery}
                    placeholder="Search this PDF"
                    aria-label="Search this PDF"
                    spellcheck="false"
                    oninput={onFindInput}
                    onkeydown={findKey} />
                  {#if findQuery}
                    <button class="srchx" title="Clear" aria-label="Clear search" onclick={clearFind}>✕</button>
                  {/if}
                </div>
                <div class="srchnav">
                  <span class="srchcount"
                    >{findQuery.trim() ? (matches.length ? `${Math.max(activeIdx, 0) + 1} of ${matches.length}` : "No results") : ""}</span>
                  <button class="cbtn" title="Previous match (Shift-Enter)" aria-label="Previous match"
                    disabled={!matches.length} onclick={() => stepFind("prev")}>‹</button>
                  <button class="cbtn" title="Next match (Enter)" aria-label="Next match"
                    disabled={!matches.length} onclick={() => stepFind("next")}>›</button>
                </div>
                {#if matchGroups.length}
                  <ul class="hitlist">
                    {#each matchGroups as g (g.label + g.page)}
                      <li class="hitgroup">
                        <div class="hithead"><span class="hitsec" title={g.label}>{g.label}</span><span class="hitpg">p.{g.page}</span></div>
                        <ul class="hitrows">
                          {#each g.matches as m (m.index)}
                            <li>
                              <button class="hit" class:on={activeIdx === m.index} onclick={() => goToMatch(m)}>
                                <span class="hitctx">…{m.before}</span><mark class="hitmark">{m.hit}</mark><span class="hitctx">{m.after}…</span>
                              </button>
                            </li>
                          {/each}
                        </ul>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {:else if sideTab === "citers"}
              <div class="csort">
                <button class="cbtn" class:on={citersSort === "cited"} onclick={() => setCitersSort("cited")}>Most cited</button>
                <button class="cbtn" class:on={citersSort === "recent"} onclick={() => setCitersSort("recent")}>Newest</button>
                <button class="cbtn refresh" title={citersAt ? `Fetched ${new Date(citersAt).toLocaleString()} — re-query` : "Re-query"}
                  aria-label="Refresh citers" onclick={() => void loadCiters(true)}>⟳</button>
              </div>
              {#if citersState === "loading"}
                <div class="smsg">Looking up citing papers…</div>
              {:else if citersState === "unenriched"}
                <div class="smsg">No OpenAlex id yet — <em>Enrich</em> this paper in the Library to look up its citers.</div>
              {:else if citersState === "error"}
                <div class="smsg">Couldn’t reach OpenAlex. <button class="linkbtn" onclick={() => void loadCiters(true)}>Try again</button></div>
              {:else if citers.length === 0}
                <div class="smsg">No citing papers found yet.</div>
              {:else}
                <ul class="reflist">
                  {#each citers as b (b.openalexId)}
                    {@render briefRow(b)}
                  {/each}
                </ul>
              {/if}
            {:else if sideTab === "outline"}
              {#if outline === null}
                <div class="smsg">Loading outline…</div>
              {:else if outline.length === 0}
                <div class="smsg">This PDF has no outline.</div>
              {:else}
                <ul class="outlist">
                  {#each outline as o, i (i)}
                    <li>
                      <button class="outitem" style:padding-left="{12 + o.depth * 14}px" onclick={() => pdfView?.goToDestination(o.dest)}>{o.title}</button>
                    </li>
                  {/each}
                </ul>
              {/if}
            {:else if refsState === "loading"}
              <div class="smsg">Loading references…</div>
            {:else if refsState === "error"}
              <div class="smsg">Couldn’t load references.</div>
            {:else if refs.length === 0}
              <div class="smsg">No reference list — <em>Enrich</em> this paper in the Library to fetch its
                <code>referenced_works</code>.</div>
            {:else}
              <ul class="reflist">
                {#each refs as b (b.openalexId)}
                  {@render briefRow(b)}
                {/each}
              </ul>
            {/if}
          </aside>
          <div
            class="rail-gutter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize references (double-click resets)"
            onpointerdown={startRefsDrag}
            ondblclick={resetRefsW}>
          </div>
        {/if}

        <div class="pdfwrap">
          <div class="pdfarea">
            {#key bufferGen}
              <PdfView bind:this={pdfView} buffer={viewBuffer ?? buffer} annotations={onSupplement ? [] : annotations} canHighlight={!onSupplement} {scrollTo} {initialView} hoverId={sideHoverId} find={findProp} onMatchList={(m) => (matches = m)} onCreate={handleCreate} onSelect={handleSelect} onAskSelection={(text, page) => onAsk?.(`About this passage on p${page}:`, text)} onAnnotationClick={openPopover} onAnnotationHover={(id) => (pageHoverId = id)} onCitePreview={handleCitePreview} onNavDepth={(n) => (navDepth = n)} onRegionPop={(r) => void popRegion(r)} onRegionSnip={(r) => void snipRegion(r)} onOrphans={(ids) => (orphans = new Set(ids))} onScale={(s) => (scalePct = Math.round(s * 100))} onPage={(p, t) => { curPage = p; totalPages = t; if (!viewRestored) { viewRestored = true; if (layout !== "vertical") applyLayout(); } }} />
            {/key}
          </div>
          {#if agentOpen && active}
            {@render agentPane?.()}
          {/if}
        </div>

        {#each figPanels as f (f.id)}
          <FigurePanel
            src={f.src}
            page={f.page}
            x={f.x}
            y={f.y}
            z={f.z}
            onClose={() => (figPanels = figPanels.filter((p) => p.id !== f.id))}
            onJump={() => pdfView?.goToPage(f.page, { pushNav: true })}
            onFocus={() => raiseFig(f.id)} />
        {/each}

        {#if snipReq}
          <SnipNamePopover
            name={snipReq.name}
            dir={SNIP_DIR}
            citation={snipReq.citation}
            page={snipReq.page}
            preview={snipPreview}
            saving={snipSaving}
            error={snipError}
            x={snipReq.anchor.x}
            y={snipReq.anchor.y}
            onSave={(n) => void saveSnip(n)}
            onCancel={() => {
              snipReq = null;
              snipPreview = null;
              snipError = "";
            }} />
        {/if}

        {#if cite}
          <CitePreview
            kind={cite.kind}
            text={cite.text}
            url={cite.url}
            destPage={cite.destPage}
            brief={cite.brief}
            x={cite.x}
            y={cite.y}
            place={cite.place}
            inLib={cite.brief ? inLib(cite.brief) : false}
            adding={cite.brief ? addingId === cite.brief.openalexId : false}
            onAdd={() => cite?.brief && addRef(cite.brief)}
            onShow={() => cite?.brief && void showRefInSidebar(cite.brief)}
            onJump={() => { if (cite?.destPage) pdfView?.goToPage(cite.destPage, { pushNav: true }); citeClose(); }}
            onEnter={citeKeepOpen}
            onLeave={() => handleCitePreview(null)} />
        {/if}

        {#if popover && popAnn}
          <!-- {@const} pins the annotation for the callbacks: the popover's destroy-time
               note flush fires AFTER `popover` is nulled, when `popAnn` is already gone. -->
          {@const ann = popAnn}
          <HighlightPopover
            annotation={ann}
            x={popover.x}
            y={popover.y}
            place={popover.place}
            onSaveNote={(n) => void handleUpdate(ann.id, { note: n || undefined })}
            onRecolor={(c) => void handleUpdate(ann.id, { color: c })}
            onCopy={() => copyQuote(ann)}
            onAsk={() => sendHighlightToTerminal(ann)}
            onDelete={() => void handleDelete(ann.id)}
            onClose={() => (popover = null)} />
        {/if}

        {#if showAnnots}
          <div
            class="rail-gutter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the right panel (double-click resets)"
            onpointerdown={startAnnotsDrag}
            ondblclick={resetAnnotsW}>
          </div>
          <aside class="side annots">
            <div class="shead stabs">
              <button class="stab" class:on={$readerLayout.rightTab === "annots"}
                onclick={() => readerLayout.update((s) => ({ ...s, rightTab: "annots" }))}>Annotations</button>
              <button class="stab" class:on={$readerLayout.rightTab === "library"} title="Search your reference library (Alt+R)"
                onclick={summonLibrary}>Library</button>
              {#if $readerLayout.rightTab === "annots" && annotations.length}
                <button
                  class="expnotes"
                  title="Export these highlights & notes as Markdown"
                  onclick={() => void saveAnnotationsMarkdown(citekey, annotations, { title: entry?.title, authors: entry?.authors, year: entry?.year, doi: entry?.doi })}>Export notes…</button>
              {/if}
            </div>
            {#if $readerLayout.rightTab === "library"}
              <ReaderLibraryPanel focusReq={librarySearchReq} onOpenPdf={(k) => openReaderTab(k)} />
            {:else if orderedAnns.length === 0}
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
  .rdoc {
    position: absolute;
    inset: 0;
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
  /* R6: PDF switcher (paper.pdf + items/<key>/supplements/) */
  .pdfswitch {
    position: relative;
    flex: 0 0 auto;
  }
  .pdfswbtn {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pdfswbtn.muted {
    color: var(--c-tx-3);
    border-color: var(--c-line);
  }
  .pdfmenu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 80;
    min-width: 212px;
    max-width: 340px;
    padding: 4px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .pdfitem {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--c-tx-1);
    border-radius: var(--r-1);
    padding: 6px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .pdfitem:hover:not(:disabled) {
    background: var(--c-surface-2);
  }
  .pdfitem.sel {
    color: var(--c-accent);
  }
  .pdfitem:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pdfitem.add {
    color: var(--c-tx-2);
  }
  .pdfic {
    flex: 0 0 auto;
    width: 16px;
    text-align: center;
    opacity: 0.85;
  }
  .pdfnm {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pdfck {
    flex: 0 0 auto;
    color: var(--c-accent);
  }
  .pdfsep {
    height: 1px;
    margin: 4px 2px;
    background: var(--c-line);
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
  /* Rail toggles — the two panel icons that bookend the toolbar. */
  .railtgl {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 26px;
    height: 22px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--c-tx-faint);
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .railtgl:hover {
    color: var(--c-tx-1);
    border-color: var(--c-line);
  }
  .railtgl.on {
    color: var(--c-accent);
    background: var(--c-accent-tint);
  }
  /* Search pane (Ctrl+F): query, counter + stepping, then the grouped hit list. */
  .srch {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
  }
  .srchbar {
    position: relative;
    flex: 0 0 auto;
    margin: 8px;
  }
  .srchin {
    width: 100%;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 4px 24px 4px 8px;
    font: inherit;
    font-size: var(--ts-xs);
  }
  .srchin:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .srchx {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    border: none;
    background: none;
    color: var(--c-tx-faint);
    font: inherit;
    font-size: var(--ts-xs);
    line-height: 1;
    padding: 2px 4px;
    cursor: pointer;
  }
  .srchx:hover {
    color: var(--c-tx-1);
  }
  .srchnav {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px 6px;
    border-bottom: 1px solid var(--c-line);
  }
  .srchcount {
    flex: 1 1 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-variant-numeric: tabular-nums;
  }
  .hitlist,
  .hitrows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .hitlist {
    overflow: auto;
    min-height: 0;
    padding-bottom: 4px;
  }
  .hithead {
    position: sticky;
    top: 0;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    padding: 5px 12px 3px;
    background: var(--c-surface);
    font-size: var(--ts-xs);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
  }
  .hitsec {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hitpg {
    flex: 0 0 auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .hit {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-left: 2px solid transparent;
    background: none;
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-xs);
    line-height: 1.4;
    padding: 4px 12px;
    cursor: pointer;
  }
  .hit:hover {
    background: var(--c-bg);
  }
  .hit.on {
    border-left-color: var(--c-accent);
    background: var(--c-bg);
    color: var(--c-tx-1);
  }
  .hitctx {
    color: var(--c-tx-faint);
  }
  .hitmark {
    background: var(--c-accent-tint);
    color: var(--c-accent);
    border-radius: 2px;
    padding: 0 1px;
  }
  .rbody {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .side {
    overflow: auto;
    background: var(--c-surface);
    display: flex;
    flex-direction: column;
  }
  .side.refs {
    flex: 0 0 var(--refs-w, 268px);
    width: var(--refs-w, 268px);
    border-right: 1px solid var(--c-line);
  }
  .side.annots {
    flex: 0 0 var(--annots-w, 268px);
    width: var(--annots-w, 268px);
    border-left: 1px solid var(--c-line);
  }
  /* Drag-to-resize rail edges (the figure/slide gutter pattern). Sits OUTSIDE the
     scrolling aside so it never scrolls away; negative margins overlay the 1px seam
     without stealing layout width. */
  .rail-gutter {
    flex: 0 0 5px;
    margin: 0 -2px;
    cursor: col-resize;
    z-index: 5;
    background: transparent;
  }
  .rail-gutter:hover {
    background: color-mix(in srgb, var(--c-accent) 35%, transparent);
  }
  .shead {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    font-size: var(--ts-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
    background: var(--c-surface);
    border-bottom: 1px solid var(--c-line);
  }
  .expnotes {
    border: 1px solid var(--c-line);
    background: var(--c-bg);
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 2px 8px;
    font-size: var(--ts-xs);
    letter-spacing: 0;
    text-transform: none;
    cursor: pointer;
  }
  .expnotes:hover {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .stabs {
    display: flex;
    gap: 2px;
    padding: 5px 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .stabs::-webkit-scrollbar {
    display: none;
  }
  .stabs .expnotes {
    margin-left: auto;
  }
  .stab {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: var(--c-tx-faint);
    font: inherit;
    font-size: var(--ts-xs);
    letter-spacing: 0;
    text-transform: uppercase;
    white-space: nowrap;
    padding: 3px 4px;
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .stab.on {
    color: var(--c-tx-1);
    background: var(--c-bg);
  }
  /* Cited-by controls: sort toggle + refresh (the list is a cached live query). */
  .csort {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--c-line);
  }
  .cbtn {
    border: 1px solid var(--c-line);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 2px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .cbtn.on {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .cbtn.refresh {
    margin-left: auto;
    padding: 2px 7px;
  }
  .linkbtn {
    border: none;
    background: none;
    color: var(--c-accent);
    font: inherit;
    font-size: inherit;
    font-style: normal;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  .outlist {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  .outitem {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    color: var(--c-tx-1);
    font: inherit;
    font-size: var(--ts-sm);
    line-height: 1.35;
    padding: 5px 12px;
    cursor: pointer;
  }
  .outitem:hover {
    background: var(--c-bg);
    color: var(--c-accent);
  }
  .ref.flash {
    animation: refflash 1.6s ease-out;
  }
  @keyframes refflash {
    0%, 40% {
      background: var(--c-accent-tint);
    }
    100% {
      background: transparent;
    }
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
  .reflist,
  .annlist {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  .ref {
    padding: 8px 12px;
    border-bottom: 1px solid var(--c-line);
    cursor: pointer;
  }
  .ref:hover {
    background: var(--c-bg);
  }
  .rtitle2.unclamped {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .rcontainer {
    font-size: var(--ts-xs);
    font-style: italic;
    color: var(--c-tx-2);
    margin-bottom: 3px;
  }
  .rabstract {
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    line-height: 1.45;
    margin: 2px 0 5px;
    max-height: 14em;
    overflow: auto;
  }
  .rdoi {
    border: none;
    background: none;
    font: inherit;
    font-size: var(--ts-xs);
    color: var(--c-accent);
    padding: 0;
    margin-left: 6px;
    cursor: pointer;
  }
  .rdoi:hover {
    text-decoration: underline;
  }
  .pdfbtn {
    border: 1px solid var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    border-radius: var(--r-1);
    padding: 1px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .pdfbtn:hover {
    background: var(--c-accent);
    color: var(--c-on-accent);
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
</style>
