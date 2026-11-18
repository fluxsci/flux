<script lang="ts">
  import { notifyPlotsWritten } from "../../../lib/plotsRail/plotIndex";
  import { yieldsToShellModal, isAnnotateChord } from "../../agent/annotationVisibility";

  import { readerContext } from "../../../lib/bridge/contextStamp";
  import { registerReaderTargets } from "../../../lib/bridge/readerTargets";
  import { requestAsk } from "../../agent/askChord";
  import { requestAnnotation } from "../../agent/annotateChord";

  // FluxReader document — everything scoped to ONE open paper. Loads the paper named by
  // the (immutable) `citekey` prop from <FluxLib>/items/<citekey>/ (PDF bytes +
  // annotations) and renders it with PdfView, flanked by a reference sidebar (the
  // paper's OpenAlex referenced_works → add to FluxLib) and a Highlights panel (this
  // paper's highlights → click to scroll, delete). Highlights persist to
  // items/<citekey>/annotations.json. ReaderMode hosts one instance per open document;
  // switching papers mounts a fresh instance, so per-paper state needs no reset path.
  import { onMount, onDestroy, tick } from "svelte";
  import { readerFind } from "./readerStore";
  import { fluxLibRevision } from "../../../lib/references/revision";
  import {
    readerPdfBytes,
    readerPdfIdentity,
    listSupplements,
    readSupplementManifest,
    readerSupplementBytes,
    ingestSupplementFile,
    revealReaderPdf,
  } from "../../../lib/references/itemsBridge";
  import { fileBridge } from "../../../lib/project/types";
  import { createReaderSourceOwner } from "./readerSession";
  import { createReaderContextPublisher } from "./readerContextPublisher";
  import { pushToast, errMsg } from "../../../lib/toast";
  import { withIpcLock } from "../../../lib/references/libLock";
  import { loadAnnotations, addAnnotation, updateAnnotation, deleteAnnotation, annotationsRev } from "../../../lib/references/annotationsBridge";
  import { saveAnnotationsMarkdown } from "../../../lib/io";
  import { hlSwatch } from "../../../lib/references/annotationColors";
  import { loadFluxLib, resolveFluxLibPath } from "../../../lib/references/fluxlibBridge";
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
  import VirtualFixedList from "../../../lib/ui/VirtualFixedList.svelte";
  import PdfView from "./PdfView.svelte";
  import Icon from "../../Icon.svelte";
  import HighlightPopover from "./HighlightPopover.svelte";
  import CitePreview from "./CitePreview.svelte";
  import FigurePanel from "./FigurePanel.svelte";
  import SnipNamePopover from "./SnipNamePopover.svelte";
  import { get } from "svelte/store";
  import { currentProject } from "../../shellStore";
  import { createReaderSnipController, type ReaderSnipRequest } from "./readerSnips";
  import {
    SNIP_DIR,
    composeSnipCitation,
    defaultSnipName,
    dedupSnipName,
    type SnipMeta,
    type SnipRect,
  } from "../../../lib/references/snips";

  let {
    citekey: citekeyProp,
    paneId = "",
    active = true,
    focused = true,
  }: {
    /** The paper this instance renders — immutable for the instance's lifetime. */
    citekey: string;
    paneId?: string;
    /** This document is its pane's visible one (hidden kept-alive instances pass false). */
    active?: boolean;
    /** Active AND the hosting pane is focused — gates the window keyboard handler. */
    focused?: boolean;
  } = $props();

  // The citekey never changes for a mounted instance (a paper switch mounts a fresh
  // ReaderDoc), so capture it once as a plain constant — every load/persistence call
  // below deliberately binds the initial value.
  // svelte-ignore state_referenced_locally
  const citekey = citekeyProp;

  // This instance's claim token on the module-level reader-context ownership.
  const contextPublisher = createReaderContextPublisher({
    claim: async (root,owner) => fileBridge()?.readerContextClaim?.({root,owner}) ?? null,
    publish: async (token,generation,context) => fileBridge()?.readerContextPublish?.({token,generation,context}) ?? false,
    renew: async (token,generation) => fileBridge()?.readerContextRenew?.({token,generation}) ?? false,
    release: async token => fileBridge()?.readerContextRelease?.(token),
  }, crypto.randomUUID());
  let libraryRoot = $state<string|null>(null);
  let windowFocused = $state(document.hasFocus());
  const reloadOwner = createReaderSourceOwner(resolveFluxLibPath);
  const supplementOwner = createReaderSourceOwner(resolveFluxLibPath);
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
  /** filename → the publisher's own label, from supplements/manifest.json (advisory). */
  let suppLabels = $state<Record<string, string>>({});
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
  const matchGroups = $derived(matches.length <= 200 ? groupMatches(matches, sections) : []);
  let hitList = $state<{ ensureVisible: (index: number) => void } | undefined>();
  const hitSection = (page: number) => [...sections].filter(s => s.page <= page).sort((a,b) => b.page-a.page)[0]?.title || `Page ${page}`;
  // The open hit's row stays in view as you step (Enter, the arrows, or a search that starts
  // from the page you are on): the windowed list is asked for it, the grouped one is scrolled
  // by the least that shows the row (its CSS scroll margin clears the pinned section heading).
  let searchPane = $state<HTMLElement | undefined>();
  $effect(() => {
    const index = activeIdx, count = matches.length;
    if (index < 0 || !count) return;
    if (count > 200) { hitList?.ensureVisible(index); return; }
    void tick().then(() => searchPane?.querySelector(".hit.on")?.scrollIntoView({ block: "nearest" }));
  });
  /** PDF.js starts a new search from the page in view, so its selected hit is often not the
   *  document's first. The list and the counter follow what the page actually shows. */
  function onFindPosition(r: { index: number; settled: boolean }) {
    if (r.settled && r.index >= 0 && r.index !== activeIdx) activeIdx = r.index;
  }
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
      findDir = "first"; // a changed query starts a fresh search (PdfView rebuilds the set)
      activeIdx = 0; // …until PDF.js reports the hit it selected (onFindPosition)
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
    if (f.key !== citekey || !active) return;
    lastFindOpenNonce = f.nonce;
    if (f.page !== undefined) scrollTo = { page: Math.max(1, f.page), nonce: ++nonce };
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

  let citersRequest = 0;
  async function loadCiters(force = false) {
    const request = ++citersRequest, key = citekey, epoch = sourceEpoch;
    const sort = citersSort;
    if (!force) {
      const hit = await cachedCiters(citekey, sort);
      if (!alive || request !== citersRequest || epoch !== sourceEpoch || key !== citekey || sort !== citersSort) return;
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
      if (!alive || request !== citersRequest || epoch !== sourceEpoch || key !== citekey || sort !== citersSort) return;
      citers = list;
      citersState = "done";
      citersAt = new Date().toISOString();
      void cacheCiters(citekey, sort, list);
    } catch (e) {
      if (!alive || request !== citersRequest || epoch !== sourceEpoch || key !== citekey || sort !== citersSort) return;
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
  let snipReq = $state<(ReaderSnipRequest & { anchor: { x: number; y: number } }) | null>(null);
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
    const epoch = sourceEpoch, view = pdfView;
    const sourcePdf: SnipMeta["sourcePdf"] = activePdf.kind === "supp" ? { supplement: activePdf.name } : "main";
    const name = await dedupSnipName(defaultSnipName(citekey, req.page), snipExists(root));
    if (!alive || epoch !== sourceEpoch) return;
    snipError = "";
    snipPreview = null;
    const snapshot = { ...req, citekey, name, citation: composeSnipCitation(entry, citekey), projectRoot: root, sourceEpoch: epoch, sourcePdf, view };
    snipReq = snapshot;
    void view?.renderRegion(req.page, req.rect, 130).then((src) => {
      if (snipReq === snapshot && sourceEpoch === epoch) snipPreview = src;
    }).catch(() => {});
  }
  const snipController = createReaderSnipController({
    current: req => alive && sourceEpoch === req.sourceEpoch && get(currentProject)?.path === req.projectRoot,
    bridge: fileBridge,
    withLease: (root, publish) => withIpcLock("project", "snips", lease => publish(async () => { await lease.assertOwned?.(); }), {root}),
  });
  async function saveSnip(rawName: string) {
    const req = snipReq;
    const root = req?.projectRoot;
    if (!req || !root || snipSaving) return;
    snipSaving = true;
    snipError = "";
    try {
      const {base,name,meta} = await snipController.save(req,rawName);
      notifyPlotsWritten([`${root}/${SNIP_DIR}/${name}.png`]); // the watcher skips the app's own writes
      if (snipReq === req) { snipReq = null; snipPreview = null; }
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
  let annotationEpoch = 0;
  let srcStamp: string | null = null;
  let bufferGen = $state(0);
  async function refreshReader(initial = false) {
    const annotationAtStart=annotationEpoch;
    await reloadOwner.run(async () => {
      const [af,lib,identity,sup,man]=await Promise.all([loadAnnotations(citekey),loadFluxLib(),readerPdfIdentity(citekey),listSupplements(citekey),readSupplementManifest(citekey)]);
      const changed=initial||identity!==srcStamp;
      const fresh=changed?await readerPdfBytes(citekey):buffer;
      return {af,lib,identity,sup,man,changed,fresh};
    },({af,lib,identity,sup,man,changed,fresh},root)=>{
      libraryRoot=root;
      if(annotationAtStart===annotationEpoch)annotations=af.annotations;
      entry=lib.find(e=>e.key===citekey)??null;
      libDois=new Set(lib.map(e=>bareDoi(e.doi)).filter((d):d is string=>!!d));
      libKeyByDoi=new Map(lib.flatMap(e=>{const d=bareDoi(e.doi);return d?[[d,e.key] as [string,string]]:[];}));
      if(changed){sourceEpoch++;selection='';selPage=1;supplementOwner.invalidate();srcStamp=identity;buffer=fresh;
        if(activePdf.kind==='main'){bufferGen++;outline=null;totalPages=0;}}
      supplements=sup;suppLabels=Object.fromEntries(man.items.filter(r=>r.label).map(r=>[r.name,r.label as string]));
      if(activePdf.kind==='supp'&&!sup.includes(activePdf.name))showMain();
      loading=false;
    },error=>{loading=false;pushToast('error',"Couldn't load this paper",{detail:errMsg(error)});});
  }
  // The initial load and watcher refresh share one latest-result owner.
  void refreshReader(true);
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

  // W10 (LR-3): an external FluxLib write (e.g. an agent's add_highlight, or a new
  // paper) refreshes the open paper's annotations + library membership in place —
  // and, if paper.pdf itself changed on disk (re-fetch, manual ingest), reloads the
  // bytes and remounts the PDF view (bufferGen keys it) instead of rendering stale bytes.
  onMount(() => {
    let first = true;
    return fluxLibRevision.subscribe(() => {
      if (first) { first = false; return; }
      void refreshReader();
    });
  });

  // Foreign-write sync: another view of THIS paper (a split pane, a kept-alive tab)
  // writing a highlight bumps annotationsRev → reload from disk. Our OWN writes update
  // `annotations` optimistically (object identity keeps PdfView's locate cache hot), so
  // we skip exactly the bumps we caused — every bridge mutation produces one bump, and
  // the handlers below count theirs before awaiting.
  const annotationOrigin = crypto.randomUUID();

  onMount(() => {
    let first = true;
    return annotationsRev.subscribe((r) => {
      if (first) { first = false; return; }
      if (r.key !== citekey) return;
      if (r.origin === annotationOrigin) { annotationEpoch++; return; }
      const epoch = ++annotationEpoch;
      void loadAnnotations(citekey).then((af) => {
        if (!alive || epoch !== annotationEpoch) return;
        annotations = af.annotations;
      }).catch(error => pushToast("error", "Couldn't reload highlights", { detail: errMsg(error) }));
    });
  });

  // R6: PDF switcher. Show the main paper (its already-loaded buffer) or a supplement
  // (loaded on demand into suppBuffer). bufferGen remounts PdfView with the new bytes.
  // Prefer the publisher's own wording for a captured supplement ("Supplementary Video 1",
  // "Reporting Summary") over its filename — `41592_2023_1863_MOESM3_ESM` tells a reader
  // nothing. Falls back to the bare filename when nothing was indexed.
  const suppLabel = (n: string) => {
    const label = suppLabels[n]?.trim();
    if (label) return label.replace(/\s*\((?:download\s+\w+\s*)\)\s*$/i, "").trim() || label;
    return n.replace(/\.pdf$/i, "");
  };
  let sourceEpoch = 0;
  function showMain() {
    sourceEpoch++;
    selection="";selPage=1;
    supplementOwner.invalidate();
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
    if (activePdf.kind === "supp" && activePdf.name === name) { sourceEpoch++;supplementOwner.invalidate();return; }
    const epoch = ++sourceEpoch;
    await supplementOwner.run(()=>readerSupplementBytes(citekey,name),b=>{
      if(!alive||epoch!==sourceEpoch)return;
      if(!b){pushToast('error',`Couldn't open ${name} — it may have been moved`);return;}
      sourceEpoch++; // Invalidate snips started on the old visible PDF while this load was pending.
      suppBuffer=b;activePdf={kind:'supp',name};selection='';selPage=1;outline=null;totalPages=0;bufferGen++;
    },error=>pushToast('error',`Couldn't open ${name}`,{detail:errMsg(error)}));
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
    try {
      const ann = await addAnnotation(citekey, { page: a.page, anchor: a.anchor, color: a.color }, annotationOrigin);
      annotations = [...annotations, ann];
      return true;
    } catch (e) {
      pushToast("error", "Couldn't save highlight", { detail: errMsg(e) });
      return false;
    }
  }
  async function handleDelete(id: string) {
    if (popover?.id === id) popover = null;
    try {
      await deleteAnnotation(citekey, id, annotationOrigin);
      annotations = annotations.filter((a) => a.id !== id);
    } catch (e) {
      pushToast("error", "Couldn't delete highlight", { detail: errMsg(e) });
    }
  }
  // Patch note/color/tags. The patched object keeps its anchor reference, so PdfView's
  // located-range cache stays hot — a recolor is a repaint, not a re-locate.
  async function handleUpdate(id: string, patch: Partial<Annotation>) {
    try {
      await updateAnnotation(citekey, id, patch, annotationOrigin);
      annotations = annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
    } catch (e) {
      pushToast("error", "Couldn't update highlight", { detail: errMsg(e) });
      throw e;
    }
  }
  function jumpTo(a: Annotation) {
    scrollTo = { id: a.id, page: a.page, nonce: ++nonce };
  }
  // Anchor the popover near a highlight's on-page rect (or a sidebar row's rect),
  // clamped to the viewport, flipped above when there's no room below.
  function openPopover(hit: { id: string; rect: DOMRect }) {
    const W = 340; // HighlightPopover's width
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
  /** A row of the windowed result list (more than 200 hits): three lines of text and a hairline. */
  const HIT_ROW = 66;
  // The toolbar's two file glyphs (16-unit grid, drawn as strokes): the paper, and a supplement.
  const ICON_DOC = "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3";
  const ICON_CLIP = "M12 7.3 7.6 11.7a2.3 2.3 0 0 1-3.3-3.3l4.9-4.9a1.5 1.5 0 0 1 2.2 2.2L6.7 10.4";
  // Highlights in reading order: by page, then by where each starts in its page's text (known
  // once that page has rendered: PdfView reports it), then by when it was made.
  let hlStarts = $state.raw(new Map<string, number>());
  const orderedAnns = $derived([...annotations].sort((a, b) =>
    a.page - b.page || (hlStarts.get(a.id) ?? Infinity) - (hlStarts.get(b.id) ?? Infinity) || a.createdAt.localeCompare(b.createdAt)));
  const annotationSummary = $derived.by(() => {
    const n = annotations.length, notes = annotations.reduce((k, a) => k + (a.note ? 1 : 0), 0);
    return `${n} highlight${n === 1 ? "" : "s"}${notes ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""}`;
  });

  const readingStamp = () => ({ citekey, title: entry?.title, page: popAnn?.page ?? (selection ? selPage : curPage),
    selection: popAnn?.anchor.quote ?? selection, highlightId: popAnn?.id,
    source: activePdf.kind === "main" ? "main" as const : { supplement: activePdf.name } });
  onDestroy(registerReaderTargets(() => rootEl ?? null, readingStamp, () => focused && active));
  $effect(() => {
    if (!focused || !active) return;
    const stamp = readingStamp(); readerContext.set(stamp);
    return () => { if (get(readerContext) === stamp) readerContext.set(null); };
  });
  function askPassage(quote: string, page: number, highlightId?: string) {
    requestAsk({ targets: [{ kind: "passage", citekey, title: entry?.title, page, quote, highlightId }] });
  }
  function annotatePassage(quote: string, page: number, highlightId?: string) {
    requestAnnotation({ targets: [{ kind: "passage", citekey, title: entry?.title, page, quote, highlightId }] });
  }
  function handleSelect(text: string, page?: number) {
    selection = text;
    if (page != null) selPage = page;
  }

  // Native sender/root claims make focus and publication one protocol. A focused
  // long read (including external-agent focus) renews every10s; whole-app crashes
  // expire after30s without renewal. OS blur retains the timestamped last selection.
  $effect(() => {
    const ctx: ReaderContext = {
      citekey,title:entry?.title,authors:entry?.authors,year:entry?.year,doi:entry?.doi,
      page:selection?selPage:curPage,selection:selection||undefined,
      sourcePdf:activePdf.kind==="main"?"main":{supplement:activePdf.name},pdfIdentity:activePdf.kind==="main"?srcStamp||undefined:undefined,
      annotations:activePdf.kind==="main"?annotations.map(a=>({page:a.page,color:a.color,quote:a.anchor.quote,note:a.note})):[],
      updatedAt:new Date().toISOString(),
    };
    contextPublisher.update(libraryRoot,buffer?ctx:null,focused,windowFocused);
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
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if (!focused) return; // kept-alive hidden panes must not react (inert blocks focus, not window listeners)
    // Alt chords: the panels (R = library, A = highlights).
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
      // The topmost thing first: the selection's menu, the PDF switcher, a highlight's popover.
      if (pdfView?.dismissSelectionMenu()) e.preventDefault();
      else if (switchOpen) switchOpen = false;
      else if (popover) popover = null;
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
    reloadOwner.dispose();supplementOwner.dispose();
    void contextPublisher.dispose();
    // Flush the final view state (tab close / keep-alive eviction / app close) —
    // the debounced save may not have fired yet.
    clearTimeout(saveTimer);
    if (viewRestored) {
      const vs = pdfView?.getViewState() ?? lastVs;
      if (vs) persistView(vs);
    }

  });
</script>

<svelte:window onkeydown={onKey} onpointerdown={onWinPointer} onfocus={() => { windowFocused=true; }} onblur={() => { windowFocused=false; }} />

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
    <div class="rtitle2" class:unclamped={expandedRefId === b.openalexId} title={b.title}>{b.title}</div>
    <div class="rmeta">
      <span class="rauth">{b.authors.slice(0, 2).join(", ")}{b.authors.length > 2 ? " et al." : ""}</span>{#if b.year}<span class="ryear">{b.year}</span>{/if}
      {#if b.citedByCount != null}<span class="rcite" title={`Cited ${b.citedByCount.toLocaleString()} times`}>{b.citedByCount.toLocaleString()}×</span>{/if}
    </div>
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
          <button class="zbtn ic" title="Back (after a link or outline jump)" aria-label="Back" disabled={!navDepth} onclick={() => pdfView?.goBack()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3.5M7.5 4l-4 4 4 4" /></svg></button>
          <span class="tsep"></span>
          <div class="zgrp" role="group" aria-label="Zoom">
            <button class="zbtn ic" title="Zoom out (−)" aria-label="Zoom out" onclick={() => pdfView?.zoomOut()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" /></svg></button>
            <button class="zbtn zpct" title="Fit width (0)" onclick={() => pdfView?.zoomReset()}>{scalePct}%</button>
            <button class="zbtn ic" title="Zoom in (+)" aria-label="Zoom in" onclick={() => pdfView?.zoomIn()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8M8 4v8" /></svg></button>
          </div>
          <button class="zbtn ic" title="Fit page height" aria-label="Fit page" onclick={() => pdfView?.setFit("page-fit")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7v11h-7z" /><path d="M8 5.5v5M6.7 6.8 8 5.5l1.3 1.3M6.7 9.2 8 10.5l1.3-1.3" /></svg></button>
          <span class="zselw">
            <select class="zsel" title="Page layout" aria-label="Page layout" bind:value={layout} onchange={applyLayout}>
              <option value="vertical">1-up</option>
              <option value="two-up">2-up</option>
              <option value="wrapped">Grid</option>
              <option value="horizontal">Row</option>
            </select>
            <svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>
          </span>
          <span class="tsep"></span>
          <span class="pgind">
            <input class="pgin" type="number" min="1" max={totalPages || 1} value={curPage}
              aria-label="Jump to page" title="Jump to a page" onchange={jumpFromInput} />
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
            <svg viewBox="0 0 16 16" aria-hidden="true">{#if activePdf.kind === "supp"}<path d={ICON_CLIP} />{:else}<path d={ICON_DOC} />{/if}</svg>
            <span class="pdfswlbl">{activePdf.kind === "supp" ? suppLabel(activePdf.name) : supplements.length ? `Paper (${supplements.length + 1})` : "PDF"}</span>
            <svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>
          </button>
          {#if switchOpen}
            <div class="pdfmenu" role="menu" data-testid="pdf-menu">
              <button class="pdfitem" class:sel={activePdf.kind === "main"} role="menuitem" onclick={showMain}>
                <svg class="pdfic" viewBox="0 0 16 16" aria-hidden="true"><path d={ICON_DOC} /></svg><span class="pdfnm">Main paper</span>{#if activePdf.kind === "main"}<svg class="pdfck" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>{/if}
              </button>
              {#each supplements as s (s)}
                <button class="pdfitem" class:sel={activePdf.kind === "supp" && activePdf.name === s} role="menuitem" onclick={() => showSupplement(s)}>
                  <svg class="pdfic" viewBox="0 0 16 16" aria-hidden="true"><path d={ICON_CLIP} /></svg><span class="pdfnm" title={s}>{suppLabel(s)}</span>{#if activePdf.kind === "supp" && activePdf.name === s}<svg class="pdfck" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>{/if}
                </button>
              {/each}
              <div class="pdfsep"></div>
              <button class="pdfitem add" role="menuitem" disabled={attaching} onclick={attachSupplement}>
                <svg class="pdfic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg><span class="pdfnm">{attaching ? "Adding…" : "Add supplement…"}</span>
              </button>
              <button class="pdfitem" role="menuitem" data-testid="pdf-reveal" title="Open the folder holding this PDF, with the file selected"
                onclick={() => { switchOpen = false; void revealReaderPdf(citekey, activePdf.kind === "supp" ? activePdf.name : undefined); }}>
                <svg class="pdfic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4L7.5 6H14v6.5H2z" /></svg><span class="pdfnm">Show in folder</span>
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
              <div class="srch" data-testid="reader-search" bind:this={searchPane}>
                <div class="srchbar">
                  <svg class="srchic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
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
                    <button class="srchx" title="Clear (Esc)" aria-label="Clear search" onclick={clearFind}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg></button>
                  {/if}
                </div>
                <div class="srchnav">
                  <span class="srchcount"
                    >{findQuery.trim() ? (matches.length ? `${Math.max(activeIdx, 0) + 1} of ${matches.length}` : "No results") : ""}</span>
                  <button class="cbtn step" title="Previous match (Shift+Enter)" aria-label="Previous match"
                    disabled={!matches.length} onclick={() => stepFind("prev")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5" /></svg></button>
                  <button class="cbtn step" title="Next match (Enter)" aria-label="Next match"
                    disabled={!matches.length} onclick={() => stepFind("next")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5 11 8l-4.5 4.5" /></svg></button>
                </div>
                {#if matches.length > 200}
                  <!-- More than 200 hits: a windowed list of compact rows, each tagged with its page
                       (the section is the row's tooltip). It scrolls in its own box, like the grouped
                       list, so the query and the counter stay where they are. -->
                  <div class="hitscroll">
                    <VirtualFixedList bind:this={hitList} items={matches} rowHeight={HIT_ROW} overscan={5} getKey={m => `${m.page}:${m.matchInPage}`} listClass="hitlist" let:item={m}>
                      <li class="hitgroup fixed" style:height={`${HIT_ROW}px`}>
                        <button class="hit" class:on={activeIdx === m.index} title={`${hitSection(m.page)} · p.${m.page}`} onclick={() => goToMatch(m)}>
                          <span class="hittext"><span class="hitctx">{m.before.length >= 40 ? "…" : ""}{m.before}</span><mark class="hitmark">{m.hit}</mark><span class="hitctx">{m.after}{m.after.length >= 40 ? "…" : ""}</span></span>
                          <span class="hitpg">p.{m.page}</span>
                        </button>
                      </li>
                    </VirtualFixedList>
                  </div>
                {:else if matchGroups.length}
                  <ul class="hitlist">
                    {#each matchGroups as g (g.label + g.page)}
                      <li class="hitgroup">
                        <div class="hithead"><span class="hitsec" title={g.label}>{g.label}</span><span class="hitpg">p.{g.page}</span></div>
                        <ul class="hitrows">
                          {#each g.matches as m (m.index)}
                            <li>
                              <button class="hit" class:on={activeIdx === m.index} onclick={() => goToMatch(m)}>
                                <span class="hitctx">{m.before.length >= 40 ? "…" : ""}{m.before}</span><mark class="hitmark">{m.hit}</mark><span class="hitctx">{m.after}{m.after.length >= 40 ? "…" : ""}</span>
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
                  aria-label="Refresh citers" onclick={() => void loadCiters(true)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" /></svg></button>
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
                      <button class="outitem" class:top={o.depth === 0} style:padding-left="{12 + o.depth * 14}px" style:--guides="{o.depth * 14}px" onclick={() => pdfView?.goToDestination(o.dest)}>{o.title}</button>
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
              <PdfView bind:this={pdfView} buffer={viewBuffer ?? buffer} annotations={onSupplement ? [] : annotations} canHighlight={!onSupplement} {scrollTo} {initialView} hoverId={sideHoverId} find={findProp} onFind={onFindPosition} onMatchList={(m) => (matches = m)} onCreate={handleCreate} onSelect={handleSelect} onAnnotate={annotatePassage} onAsk={askPassage} onAnnotationClick={openPopover} onAnnotationHover={(id) => (pageHoverId = id)} onCitePreview={handleCitePreview} onNavDepth={(n) => (navDepth = n)} onRegionPop={(r) => void popRegion(r)} onRegionSnip={(r) => void snipRegion(r)} onOrphans={(ids) => (orphans = new Set(ids))} onOrder={(starts) => (hlStarts = starts)} onScale={(s) => (scalePct = Math.round(s * 100))} onPage={(p, t) => { curPage = p; totalPages = t; if (!viewRestored) { viewRestored = true; if (layout !== "vertical") applyLayout(); } }} />
            {/key}
          </div>
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
            {paneId}
            draftKey={`${paneId}:${citekey}:${ann.id}`}
            x={popover.x}
            y={popover.y}
            place={popover.place}
            onSaveNote={(n) => handleUpdate(ann.id, { note: n || undefined })}
            onRecolor={(c) => void handleUpdate(ann.id, { color: c }).catch(() => {})}
            onCopy={() => copyQuote(ann)}
            onAnnotate={() => annotatePassage(ann.anchor.quote, ann.page, ann.id)}
            onAsk={() => askPassage(ann.anchor.quote, ann.page, ann.id)}
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
              <button class="stab" class:on={$readerLayout.rightTab === "annots"} title="Highlights (Alt+A)" data-n={annotations.length || undefined}
                onclick={() => readerLayout.update((s) => ({ ...s, rightTab: "annots" }))}>Highlights</button>
              <button class="stab" class:on={$readerLayout.rightTab === "library"} title="Search your reference library (Alt+R)"
                onclick={summonLibrary}>Library</button>
            </div>
            {#if $readerLayout.rightTab === "annots" && annotations.length}
              <div class="annbar">
                <span>{annotationSummary}</span>
                <button
                  class="expnotes"
                  title="Export these highlights & notes as Markdown"
                  onclick={() => void saveAnnotationsMarkdown(citekey, annotations, { title: entry?.title, authors: entry?.authors, year: entry?.year, doi: entry?.doi, order: hlStarts })}>Export notes…</button>
              </div>
            {/if}
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
                    data-id={a.id}
                    class:orphan={orphans.has(a.id)}
                    class:pagehover={pageHoverId === a.id}
                    onclick={() => jumpTo(a)}
                    onmouseenter={() => (sideHoverId = a.id)}
                    onmouseleave={() => (sideHoverId = null)}>
                    <div class="arow">
                      <span class="swatch" style:background={hlSwatch(a.color)}></span>
                      <span class="aquote" title={a.anchor.quote}>{a.anchor.quote}</span>
                      {#if orphans.has(a.id)}<span class="odot" title="This highlight's text wasn't found on its page — the PDF may have changed.">detached</span>{/if}
                      <span class="apage">p.{a.page}</span>
                      <button class="edit" title="Comment / edit highlight" aria-label="Edit highlight"
                        onclick={(e) => { e.stopPropagation(); openPopover({ id: a.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5 3.6 10 10.5 3.1a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2L6 12.4 3 12.5Z" /></svg></button>
                      <button class="del" title="Delete highlight" aria-label="Delete highlight"
                        onclick={(e) => { e.stopPropagation(); handleDelete(a.id); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
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
  /* The toolbar: sidebar toggles at its ends, the paper's title in the middle, and one row of
     quiet controls (back, zoom, fit, layout, page, which PDF). Icons are strokes, values are
     mono, words are serif; nothing here is a glyph from a symbol font. */
  .rtoolbar {
    flex: 0 0 36px;
    height: 36px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-surface);
  }
  .rtoolbar svg {
    display: block;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .rtoolbar svg.chev {
    width: 10px;
    height: 10px;
    color: var(--c-tx-muted);
  }
  .rtitle {
    flex: 1 1 auto;
    min-width: 0;
    text-align: center;
    font: 13px var(--font-serif);
    color: var(--c-tx);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tgl {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 7px 0 8px;
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-ui);
    font: 12px var(--font-serif);
    cursor: var(--cursor-cross-hover);
    white-space: nowrap;
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  .tgl:hover {
    background: var(--c-surface-2);
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .tgl.on {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  /* R6: PDF switcher (paper.pdf + items/<key>/supplements/) */
  .pdfswitch {
    position: relative;
    flex: 0 0 auto;
  }
  .pdfswbtn {
    max-width: 220px;
  }
  .pdfswlbl {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pdfswbtn.muted:not(:hover):not(.on) {
    color: var(--c-tx-muted);
    border-color: var(--c-line);
  }
  .pdfmenu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 80;
    min-width: 220px;
    max-width: 340px;
    padding: 4px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-3);
    display: flex;
    flex-direction: column;
    gap: 1px;
    transform-origin: top right;
    animation: pdfmenu-in 90ms ease-out;
  }
  @keyframes pdfmenu-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  .pdfitem {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 28px;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--c-tx);
    border-radius: var(--r-ui);
    padding: 0 8px;
    font: 12.5px var(--font-serif);
    cursor: var(--cursor-cross-hover);
  }
  .pdfitem:hover:not(:disabled) {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .pdfitem:active:not(:disabled) {
    background: var(--c-accent-tint);
  }
  .pdfitem.sel {
    background: var(--c-accent-tint);
    box-shadow: inset 2px 0 0 var(--c-accent);
    color: var(--c-tx-hi);
  }
  .pdfitem:disabled {
    opacity: 0.5;
    cursor: var(--cursor-cross);
  }
  .pdfitem.add {
    color: var(--c-tx-2);
  }
  .rtoolbar svg.pdfic {
    color: var(--c-tx-muted);
  }
  .pdfitem:hover .pdfic,
  .pdfitem.sel .pdfic {
    color: inherit;
  }
  .pdfnm {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rtoolbar svg.pdfck {
    color: var(--c-accent-bright);
    stroke-width: 1.6;
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
    gap: 6px;
    color: var(--c-tx-2);
  }
  .tsep {
    flex: 0 0 1px;
    height: 16px;
    margin: 0 2px;
    background: var(--c-line);
  }
  .zbtn {
    display: inline-grid;
    place-items: center;
    height: 24px;
    min-width: 24px;
    padding: 0 6px;
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-ui);
    font: 11px var(--font-mono);
    line-height: 1;
    cursor: var(--cursor-cross-hover);
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  .zbtn.ic {
    width: 24px;
    padding: 0;
  }
  .zbtn:hover:not(:disabled) {
    position: relative;
    background: var(--c-surface-2);
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .zbtn:active:not(:disabled) {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
  }
  .zbtn:disabled {
    opacity: 0.35;
    cursor: var(--cursor-cross);
  }
  /* Out, the value, in: one control. */
  .zgrp {
    display: flex;
  }
  .zgrp .zbtn {
    margin-left: -1px;
    border-radius: 0;
  }
  .zgrp .zbtn:first-child {
    margin-left: 0;
    border-radius: var(--r-ui) 0 0 var(--r-ui);
  }
  .zgrp .zbtn:last-child {
    border-radius: 0 var(--r-ui) var(--r-ui) 0;
  }
  .zpct {
    min-width: 48px;
    font-variant-numeric: tabular-nums;
  }
  .zselw {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .zselw .chev {
    position: absolute;
    right: 7px;
    pointer-events: none;
  }
  .zsel {
    height: 24px;
    appearance: none;
    padding: 0 22px 0 8px;
    border: 1px solid var(--c-line-strong);
    background: var(--c-bg);
    color: var(--c-tx-2);
    border-radius: var(--r-ui);
    font: 12px var(--font-serif);
    cursor: var(--cursor-cross-hover);
    transition: border-color 80ms linear, color 80ms linear;
  }
  .zsel:hover {
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .zsel:focus-visible,
  .pgin:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 3px var(--c-accent-tint-2);
  }
  .pgind {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    font: 11px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .pgin {
    width: 40px;
    height: 24px;
    box-sizing: border-box;
    padding: 0 6px;
    text-align: right;
    background: var(--c-bg);
    color: var(--c-tx-hi);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    font: inherit;
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .pgin::-webkit-inner-spin-button,
  .pgin::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
  }
  .pgin:hover {
    border-color: var(--c-tx-muted);
  }
  .pgtot {
    color: var(--c-tx-muted);
  }
  /* Rail toggles — the two panel icons that bookend the toolbar. */
  .railtgl {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 26px;
    height: 24px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--c-tx-muted);
    border-radius: var(--r-ui);
    cursor: var(--cursor-cross-hover);
    transition: background-color 80ms linear, color 80ms linear;
  }
  .railtgl:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .railtgl.on {
    color: var(--c-accent-bright);
    background: var(--c-accent-tint);
  }
  /* ---- The two sidebars, in the house vocabulary (2026-11-18 rebuild; owner: "the formatting of
     the left and right sidebars"): tabs that fit the default rail and are underlined when
     chosen, serif words, mono eyebrows and values, hairlines, tint + inset rail for the row that
     is open. ----------------------------------------------------------------------------- */
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
    font: 12.5px/1.4 var(--font-serif);
    color: var(--c-tx);
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
  .side svg {
    display: block;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .side button {
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
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
  /* The tab strip. Four words fit the default 268 px rail with room to spare; the chosen one is
     underlined, like the modes in the title bar. */
  .shead {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: stretch;
    flex: 0 0 32px;
    height: 32px;
    padding: 0 6px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
  }
  .stabs {
    gap: 0;
  }
  .stab {
    position: relative;
    flex: 0 1 auto;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 7px;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    font: 12.5px var(--font-serif);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
  }
  .stab:hover {
    color: var(--c-tx-hi);
  }
  .stab.on {
    color: var(--c-tx-hi);
    font-weight: 600;
  }
  .stab.on::before {
    content: "";
    position: absolute;
    left: 5px;
    right: 5px;
    bottom: -1px;
    height: 2px;
    background: var(--c-accent);
  }
  /* How many there are, beside the word (drawn, so the tab's text stays its name). */
  .stab[data-n]::after {
    content: attr(data-n);
    color: var(--c-tx-muted);
    font: 400 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
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
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    margin: 8px 8px 6px;
    padding: 0 6px 0 8px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
    transition: border-color 80ms linear;
  }
  .srchbar:hover {
    border-color: var(--c-tx-muted);
  }
  .srchbar:focus-within {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 3px var(--c-accent-tint-2);
  }
  .srchic {
    width: 13px;
    height: 13px;
  }
  .srchin {
    flex: 1 1 auto;
    min-width: 0;
    height: 26px;
    padding: 0;
    background: transparent;
    color: var(--c-tx-hi);
    border: 0;
    outline: none;
    font: 13px var(--font-serif);
  }
  .srchin::placeholder {
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .srchx {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    cursor: var(--cursor-cross-hover);
  }
  .srchx svg {
    width: 10px;
    height: 10px;
    stroke-width: 1.6;
  }
  .srchx:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .srchnav {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 8px 7px;
    border-bottom: 1px solid var(--c-line);
  }
  .srchcount {
    flex: 1 1 auto;
    font: 11px var(--font-mono);
    color: var(--c-tx-muted);
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
    padding-bottom: 6px;
  }
  /* Rows of a long result list are drawn by the shared virtual list, whose <ul> is outside
     this component's scope: this rule reaches it. */
  .srch :global(ul.hitlist) {
    list-style: none;
    margin: 0;
    padding: 0 0 6px;
    min-height: 0;
  }
  /* The windowed list (more than 200 hits) scrolls in its own box; its rows are a fixed height:
     three lines of text, the page at the right, a hairline under. */
  .hitscroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .hitgroup.fixed {
    box-sizing: border-box;
    overflow: hidden;
    border-bottom: 1px solid var(--c-line);
  }
  .hitgroup.fixed .hit {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    height: 100%;
  }
  .hittext {
    flex: 1 1 auto;
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .hitgroup.fixed .hitpg {
    padding-top: 2px;
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .hithead {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 12px 4px;
    background: var(--c-surface);
    color: var(--c-tx-muted);
    font: 600 10px var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .hitsec {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hitpg {
    flex: 0 0 auto;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--c-tx-faint);
  }
  .hit {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    color: var(--c-tx-2);
    font: 12.5px/1.45 var(--font-serif);
    padding: 5px 12px 5px 14px;
    cursor: var(--cursor-cross-hover);
  }
  .hit {
    scroll-margin: 30px 0 6px;
  }
  .hit:hover {
    background: var(--c-surface-2);
    color: var(--c-tx);
  }
  .hit:active {
    background: var(--c-accent-tint);
  }
  .hit.on {
    background: var(--c-accent-tint);
    box-shadow: inset 2px 0 0 var(--c-accent);
    color: var(--c-tx-hi);
  }
  .hitctx {
    color: inherit;
    opacity: 0.72;
  }
  /* The found words themselves: the accent as a tint with a rule under them. */
  .hitmark {
    background: var(--c-accent-tint);
    box-shadow: inset 0 -1px 0 var(--c-accent);
    color: var(--c-tx-hi);
    font-weight: 600;
    border-radius: 1px;
    padding: 0 1px;
  }

  /* Cited-by controls: sort toggle + refresh (the list is a cached live query). */
  .csort {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 7px 8px;
    border-bottom: 1px solid var(--c-line);
  }
  .cbtn {
    height: 22px;
    padding: 0 9px;
    margin-left: -1px;
    border: 1px solid var(--c-line-strong);
    border-radius: 0;
    background: transparent;
    color: var(--c-tx-2);
    font: 12px var(--font-serif);
    cursor: var(--cursor-cross-hover);
  }
  .cbtn:first-of-type {
    margin-left: 0;
    border-radius: var(--r-ui) 0 0 var(--r-ui);
  }
  .cbtn:hover:not(:disabled) {
    position: relative;
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .cbtn:disabled {
    opacity: 0.35;
  }
  .cbtn.on {
    position: relative;
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .cbtn.step {
    display: grid;
    place-items: center;
    width: 24px;
    padding: 0;
  }
  .cbtn.step svg {
    width: 13px;
    height: 13px;
  }
  .cbtn.step:last-of-type,
  .csort .cbtn:nth-of-type(2) {
    border-radius: 0 var(--r-ui) var(--r-ui) 0;
  }
  .cbtn.refresh {
    display: grid;
    place-items: center;
    width: 24px;
    margin-left: auto;
    border-radius: var(--r-ui);
    padding: 0;
  }
  .cbtn.refresh svg {
    width: 13px;
    height: 13px;
  }
  .linkbtn {
    border: none;
    background: none;
    color: var(--c-accent-bright);
    font: inherit;
    font-size: inherit;
    font-style: normal;
    padding: 0;
    cursor: var(--cursor-cross-hover);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .outlist {
    list-style: none;
    margin: 0;
    padding: 6px 0;
  }
  .outitem {
    position: relative;
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    color: var(--c-tx-2);
    font: 12.5px/1.35 var(--font-serif);
    padding: 5px 12px;
    cursor: var(--cursor-cross-hover);
  }
  .outitem.top {
    color: var(--c-tx);
    font-weight: 600;
  }
  /* A hairline per level, so a subsection shows what it belongs to. */
  .outitem::before {
    content: "";
    position: absolute;
    left: 14px;
    top: 0;
    bottom: 0;
    width: var(--guides, 0);
    background: repeating-linear-gradient(to right, var(--c-line) 0 1px, transparent 1px 14px);
    pointer-events: none;
  }
  .outitem:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .outitem:active {
    background: var(--c-accent-tint);
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
    padding: 16px 14px;
    font: italic 12.5px/1.5 var(--font-serif);
    color: var(--c-tx-muted);
  }
  .smsg :global(code) {
    font: 10.5px var(--font-mono);
    font-style: normal;
    color: var(--c-tx-2);
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
    padding: 0 0 6px;
  }
  /* A reference: what it is, who and when, what you can do with it. */
  .ref {
    padding: 9px 12px 9px 14px;
    border-bottom: 1px solid var(--c-line);
    cursor: var(--cursor-cross-hover);
  }
  .ref:hover {
    background: var(--c-surface-2);
  }
  .ref.expanded {
    background: var(--c-accent-tint-2);
    box-shadow: inset 2px 0 0 var(--c-accent);
  }
  .rtitle2 {
    font: 13px/1.35 var(--font-serif);
    color: var(--c-tx-hi);
    margin: 0 0 4px;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rtitle2.unclamped {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .rmeta {
    display: flex;
    align-items: baseline;
    gap: 4px;
    color: var(--c-tx-muted);
    font: 11.5px var(--font-serif);
  }
  .rauth {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ryear {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
  .ryear::before {
    content: "· ";
  }
  .rcite {
    flex: 0 0 auto;
    margin-left: auto;
    padding-left: 6px;
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--c-tx-faint);
  }
  .rcontainer {
    margin-top: 5px;
    font: italic 11.5px var(--font-serif);
    color: var(--c-tx-2);
  }
  .rabstract {
    font: 12px/1.5 var(--font-serif);
    color: var(--c-tx-2);
    margin: 6px 0 2px;
    max-height: 14em;
    overflow: auto;
  }
  .ractions {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 0;
    margin-top: 7px;
  }
  .ractions:empty {
    display: none;
  }
  .pdfbtn,
  .addbtn {
    height: 22px;
    padding: 0 9px;
    border: 1px solid color-mix(in oklab, var(--c-accent) 60%, transparent);
    border-radius: var(--r-ui);
    background: var(--c-accent-tint);
    color: var(--c-tx-hi);
    font: 12px var(--font-serif);
    cursor: var(--cursor-cross-hover);
  }
  .addbtn {
    background: transparent;
    border-color: var(--c-line-strong);
    color: var(--c-tx-2);
  }
  .pdfbtn:hover,
  .addbtn:hover:not(:disabled) {
    background: color-mix(in oklab, var(--c-accent) 28%, transparent);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .addbtn:disabled {
    opacity: 0.5;
  }
  .inlib {
    font: 11.5px var(--font-serif);
    color: var(--c-success);
  }
  .rdoi {
    border: none;
    background: none;
    font: 11.5px var(--font-serif);
    color: var(--c-accent-bright);
    padding: 0;
    cursor: var(--cursor-cross-hover);
  }
  .rdoi:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* Highlights: how many, and the way to take them with you. */
  .annbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px 6px 12px;
    border-bottom: 1px solid var(--c-line);
    color: var(--c-tx-muted);
    font: 10.5px var(--font-mono);
    white-space: nowrap;
  }
  .annbar span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .expnotes {
    flex: 0 0 auto;
    height: 22px;
    padding: 0 9px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    background: transparent;
    color: var(--c-tx-2);
    font: 12px var(--font-serif);
    cursor: var(--cursor-cross-hover);
  }
  .expnotes:hover {
    background: var(--c-surface-2);
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  /* A highlight: its colour as the row's rail, the passage in the paper's voice, your note under it. */
  .ann {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 8px 9px 16px;
    border-bottom: 1px solid var(--c-line);
    cursor: var(--cursor-cross-hover);
  }
  .ann:hover,
  .ann.pagehover {
    background: var(--c-surface-2);
  }
  .arow {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .swatch {
    position: absolute;
    left: 6px;
    top: 9px;
    bottom: 9px;
    width: 3px;
    border-radius: 1px;
  }
  .aquote {
    flex: 1 1 auto;
    min-width: 0;
    font: italic 12.5px/1.4 var(--font-serif);
    color: var(--c-tx);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ann:hover .aquote {
    color: var(--c-tx-hi);
  }
  .apage {
    flex: 0 0 auto;
    padding-top: 2px;
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--c-tx-faint);
  }
  .anote {
    padding: 5px 8px;
    background: var(--c-bg);
    border-radius: var(--r-ui);
    color: var(--c-tx-2);
    font: 12px/1.45 var(--font-serif);
    white-space: pre-wrap;
  }
  .ann.orphan .aquote {
    text-decoration: line-through;
    color: var(--c-tx-faint);
  }
  .odot {
    flex: 0 0 auto;
    padding: 0 4px;
    border: 1px solid var(--c-warning, #ad8301);
    border-radius: var(--r-ui);
    color: var(--c-warning, #ad8301);
    font: 9.5px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* Edit and delete wait until the row is under the pointer (or has the keyboard). */
  .del,
  .edit {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    opacity: 0;
    cursor: var(--cursor-cross-hover);
  }
  .del svg,
  .edit svg {
    width: 12px;
    height: 12px;
  }
  .ann:hover .del,
  .ann:hover .edit,
  .del:focus-visible,
  .edit:focus-visible {
    opacity: 1;
  }
  .del:hover {
    background: var(--c-surface);
    color: var(--c-danger);
  }
  .edit:hover {
    background: var(--c-surface);
    color: var(--c-tx-hi);
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
  @media (prefers-reduced-motion: reduce) {
    .side button,
    .srchbar,
    .tgl,
    .zbtn,
    .zsel,
    .railtgl {
      transition: none;
    }
    .pdfmenu {
      animation: none;
    }
  }
</style>
