<script module lang="ts">
  // LR-7: the run-seq of the last bulk-fetch whose summary we've already surfaced. Module-scoped
  // so it persists across Library mount/unmount within one session — that's what lets us show the
  // summary of a run that FINISHED while the user was in another mode, exactly once, on return.
  let shownFetchSeq = 0;
  // The run-seq of the last assign-inbox scan whose summary we've surfaced (module-scoped, same
  // rationale as shownFetchSeq). Also gates the once-per-session auto-scan on Library mount.
  let shownAssignSeq = 0;
  let assignAutoScanned = false;
  // The run-seq of the last Zotero sync whose disk changes we've re-listed (the toast itself
  // comes from the job; this only refreshes the table/pills for a run that landed while away).
  let shownZoteroSeq = 0;
</script>

<script lang="ts">
  // The Library mode — a full-window, searchable table over the WHOLE machine-global
  // FluxLib, showing OpenAlex enrichment (abstract, topics, keywords, citation count),
  // plus a "World" scope that searches ALL of OpenAlex — by keyword OR by meaning
  // (semantic) — with one-click add + per-entry citing / similar / author lookups.
  import { onMount, untrack } from "svelte";
  import { runQuery, extractFulltext, hasFulltext, attachHaystacks, createQueryRunner } from "../../../lib/references/query";
  import type { RefEntry } from "../../../lib/references/types";
  import { mergeEnrich, type EnrichMap, type EnrichedEntry } from "../../../lib/references/enrich";
  import {
    loadFluxLib,
    ensureFluxLib,
    loadEnrichMap,
    materializeIntoProject,
    removeFromFluxLib,
    addToFluxLib,
  } from "../../../lib/references/fluxlibBridge";
  import { pushToast } from "../../../lib/toast";
  import { currentProject } from "../../shellStore";
  import {
    hydrateFluxLib,
    searchWorld,
    searchWorldSemantic,
    similarOpenAlexByKey,
    citingWorksByKey,
    authorWorksByKey,
    s2SimilarByKey,
    s2CitingByKey,
  } from "../../../lib/references/enrichBridge";
  import type { WorldBrief } from "../../../lib/references/openalex";
  import { fluxLibRevision, assignInboxRevision } from "../../../lib/references/revision";
  import { addUrlOrDoiToLibrary } from "../paper/scholar/bibLoad";
  import { fileBridge } from "../../../lib/project/types";
  import { fade } from "svelte/transition";
  import { captureLastAt } from "../../../lib/references/captureStatus";
  import ImportDialog from "./ImportDialog.svelte";
  import ZoteroPanel from "./ZoteroPanel.svelte";
  import { zoteroSyncJob } from "../../../lib/references/zoteroSyncJob.svelte";
  import { openInReader } from "../reader/readerStore";
  import { fetchPdfForEntry, fetchViaProxyForEntry, fetchSupplementsForEntries } from "../../../lib/references/pdfFinderBridge";
  import { listPdfKeys, ingestPdfFile, listFailures, clearFetchFailure, searchFulltext, type FulltextHit } from "../../../lib/references/itemsBridge";
  import { parseQueryTerms } from "../../../lib/references/textFold";
  import { loadAnnotations } from "../../../lib/references/annotationsBridge";
  import { saveAnnotationsMarkdown } from "../../../lib/io";
  import { loadOrganize, organizeSetTags, organizeSetStatus, organizeBulkAddTag } from "../../../lib/references/organizeBridge";
  import { mergeOrganize, organizeOf, allTags, allCollections, emptyOrganize, READING_STATUSES, type OrganizeData, type ReadingStatus } from "../../../lib/references/organize";
  import { pdfFetchJob, type GuiFetchSummaryLite } from "../../../lib/references/pdfFetchJob.svelte";
  import { assignJob, countInbox } from "../../../lib/references/assignJob.svelte";
  import { safeKey, fetchOutcome, type FetchFailure, type FetchOutcome } from "../../../lib/references/items";

  let { focused = true }: { focused?: boolean } = $props();

  // $state.raw (not deep-reactive): these are replaced wholesale on reload, never mutated
  // in place. The enrich graph is ~12 MB / 140k+ nested IDs — deep-proxying it on every
  // load is what made the Library crawl. .raw keeps them plain objects.
  let entries = $state.raw<RefEntry[]>([]);
  let enrichMap = $state.raw<EnrichMap>({});
  // 3.3 library organization (tags / reading-status / collections), keyed by citekey.
  let organizeData = $state.raw<OrganizeData>(emptyOrganize());
  let loading = $state(true);
  let loadError = $state(""); // non-empty when the FluxLib read failed (vs. genuinely empty)
  let query = $state("");
  let scope = $state<"library" | "world">("library");
  let worldMode = $state<"lexical" | "semantic">("lexical");
  let highlighted = $state(0);
  let expanded = $state(""); // citekey whose detail strip is open
  let gridEl = $state<HTMLElement | undefined>(undefined);
  let searchEl = $state<HTMLInputElement | undefined>(undefined);
  let addEl = $state<HTMLInputElement | undefined>(undefined);

  // Add-by-DOI/URL box.
  let addValue = $state("");
  let addStatus = $state<"" | "fetching" | "error" | "added">("");
  let addError = $state("");
  let addedTitle = $state("");
  let copied = $state("");

  // Enrich (hydration) state.
  let enriching = $state(false);
  let enrichProg = $state("");

  // PDF acquisition (FluxFinder) — which keys have a PDF on disk + fetch progress.
  let pdfKeys = $state.raw<Set<string>>(new Set());
  let fetchingKey = $state(""); // citekey currently fetching (per-row)
  // "Assign PDFs" watched inbox (<FluxLib>/pdfs_to_assign/) — count of pending files + the
  // module-level scan job (survives mode switches, mirrors pdfFetchJob).
  let inboxCount = $state(0);
  const assigning = $derived(assignJob.running);
  // The bulk "Get all PDFs" run lives in a module-level job (pdfFetchJob) so it survives
  // navigating away from Library; these mirror it for this view's button/row states.
  const fetchingAll = $derived(pdfFetchJob.running);
  // LR-7: one eager map of every recorded fetch failure (keyed NFC) — the single source for
  // the per-row outcome pill (no DOI / no OA / failed), the diagnostic banner, and the
  // "failed N" filter. failedKeys derives from it so reload/refresh/clear stay in one place.
  // Failures are the minority (only attempted-and-failed papers have a record), so reading
  // each record on reload is a handful of extra file reads, not a per-row cost.
  let failures = $state.raw<Record<string, FetchFailure>>({});
  const failedKeys = $derived(new Set(Object.keys(failures)));
  let showFailedOnly = $state(false);
  /** Narrow the list by whether a reference has a stored main text. Cycles all → missing → have. */
  let pdfFilter = $state<"all" | "missing" | "have">("all");
  // LR-U2: row multiselect (by citekey) → bulk "add to project". Keyed by citekey so a selection
  // survives query/scope changes; the Clear action + select-all operate on the currently-shown rows.
  let selected = $state.raw<Set<string>>(new Set());

  // 2.4 bulk-import modal (.bib/.ris → FluxLib, optional Zotero PDF attach).
  let importOpen = $state(false);
  // Zotero connection panel (BBT auto-export sync — zoteroSyncJob).
  let zoteroOpen = $state(false);
  // API keys panel — stored in <FluxLib>/keys.json (machine-global, every project).
  let keysOpen = $state(false);
  let keyOpenAlex = $state("");
  let keyS2 = $state("");
  let keyMailto = $state("");
  let keyEzproxy = $state("");
  let keysSaved = $state(false);

  // Library proxy (EZProxy) status — drives the sign-in button + "Get via library".
  let proxyConfigured = $state(false);
  let proxySignedIn = $state(false);
  let proxyBusy = $state(false);
  let preflightBusy = $state(false); // bulk-fetch pre-flight auth probe in progress
  // Stored (OS-keychain) proxy credentials for seamless auto-login.
  let proxyUser = $state("");
  let proxyPass = $state("");
  let credAvailable = $state(false);
  let credHasPass = $state(false);
  let credSaved = $state(false);

  // World scope state.
  let worldResults = $state<WorldBrief[]>([]);
  let worldLabel = $state("");
  let worldBusy = $state(false);
  let worldError = $state("");
  let worldSort = $state<"relevance" | "citations" | "date">("relevance");
  let addedIds = $state<Set<string>>(new Set());
  let worldLoadMore = $state<(() => Promise<void>) | null>(null);
  let worldPage = 1;
  // Active per-entry lookup (citing/similar/author) — lets the source toggle re-run it.
  let lookupCtx = $state<{ kind: "citing" | "author" | "similar"; key: string; label: string } | null>(null);
  let lookupSource = $state<"openalex" | "s2">("openalex");

  // WS-8.1: attachHaystacks stamps each merged entry's lowercased free-text
  // haystack ONCE per rebuild — clauseMatches("any") then does a single
  // .includes per entry per keystroke instead of a 9-field join+lowercase.
  const enriched = $derived(attachHaystacks(mergeOrganize(mergeEnrich(entries, enrichMap), organizeData) as EnrichedEntry[]));
  // LR-4: precompute each entry's PDF-dir key (safeKey → 3 regexes + trim, then a Unicode
  // NFC normalize) ONCE per load. hasPdf()/isFailed() run 4–6× per row per render across
  // every result row plus the coverage stats; without this they re-ran the whole regex+
  // normalize chain each time, which dominated re-renders on a multi-thousand-item library.
  const nfcOf = $derived(new Map(entries.map((e) => [e.key, safeKey(e.key).normalize("NFC")])));
  const nfc = (key: string) => nfcOf.get(key) ?? safeKey(key).normalize("NFC");
  // Debounce the query: runQuery scans every entry's title+abstract (multi-MB over 1710
  // entries), so running it on each keystroke janks. Recompute ~150ms after typing stops.
  let queryDebounced = $state("");
  // WS-8.1: incremental refinement — typing another character rescans only the
  // previous result set (pure free-text queries only; see createQueryRunner).
  const queryRun = createQueryRunner<EnrichedEntry>();
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const q = query;
    clearTimeout(queryTimer);
    if (!q) {
      queryDebounced = "";
      return;
    }
    queryTimer = setTimeout(() => (queryDebounced = q), 150);
  });

  // 2.3 Full-text search. A `ft:`/`fulltext:`/`text:` prefix switches the Library into
  // full-text mode: the tail is scanned against every stored PDF's extracted text
  // (items/*/fulltext.txt) in the main process (bundled CLI, W13), and any leading
  // metadata clauses restrict the scan's scope. Results show only matched papers, ranked
  // by hit count, with page-numbered snippets that jump into the reader at the term.
  const ftMode = $derived(scope === "library" && hasFulltext(queryDebounced));
  let ftSeq = 0;
  let ftHits = $state.raw<Map<string, FulltextHit>>(new Map());
  let ftBusy = $state(false);
  let ftError = $state("");
  let ftScanned = $state(0);
  let ftMissing = $state(0);
  let ftTruncated = $state(false);
  let ftTerm = $state(""); // the extracted full-text query (drives the reader jump + status)
  $effect(() => {
    const q = queryDebounced;
    const active = scope === "library" && hasFulltext(q);
    if (!active) {
      if (ftHits.size || ftBusy || ftError) {
        ftHits = new Map();
        ftBusy = false;
        ftError = "";
        ftTerm = "";
      }
      return;
    }
    const { fulltext, rest } = extractFulltext(q);
    ftTerm = fulltext;
    if (!fulltext) {
      ftHits = new Map();
      ftBusy = false;
      ftError = "";
      return;
    }
    // A leading metadata query (`author:smith ft:…`) restricts the scan to those keys.
    // Read `enriched` untracked so hydration bumps don't re-fire the scan mid-typing.
    const scopeKeys = rest.trim() ? untrack(() => runQuery(enriched, rest)).map((e) => e.key) : undefined;
    const seq = ++ftSeq;
    ftBusy = true;
    ftError = "";
    void searchFulltext(fulltext, { keys: scopeKeys, limit: 200 }).then((r) => {
      if (seq !== ftSeq) return; // a newer query superseded this scan
      ftBusy = false;
      ftError = r.error ?? "";
      ftScanned = r.scanned;
      ftMissing = r.missingText.length;
      ftTruncated = r.truncated;
      ftHits = new Map(r.hits.map((h) => [nfc(h.key), h]));
    });
  });
  // The term handed to the reader's find-in-document on a snippet click — the primary
  // needle (first phrase, else first term) of the full-text query. pdf.js find is
  // case/diacritic-insensitive, so the folded needle locates the original text.
  function ftReaderTerm(): string {
    const { terms, phrases } = parseQueryTerms(ftTerm);
    return phrases[0] ?? terms[0] ?? ftTerm.trim();
  }
  function openSnippet(e: MouseEvent, key: string) {
    e.stopPropagation();
    openInReader(key, { find: ftReaderTerm() });
  }

  const isFailed = (key: string) => failedKeys.has(nfc(key));
  // LR-7: the durable, categorized per-row outcome pill (replaces the ambiguous ⚠). Environment
  // failures (session-expired / cancelled) are never recorded, so they stay plain "missing".
  const OUTCOME_PILL: Record<FetchOutcome, { label: string; tone: "danger" | "muted"; title: string }> = {
    "no-id": {
      label: "no DOI",
      tone: "muted",
      title: "No DOI/identifier on this entry, so no fetch route could be tried — add a DOI (↗), then retry.",
    },
    "no-oa": {
      label: "no OA",
      tone: "danger",
      title: "No open-access copy exists and the library-proxy route didn't return a PDF — click for details.",
    },
    failed: {
      label: "failed",
      tone: "danger",
      title: "A fetch route erred (paywall wall / not-a-PDF / network) — click for details.",
    },
  };
  const outcomePill = (key: string) => {
    const f = failures[nfc(key)];
    return f ? OUTCOME_PILL[fetchOutcome(f)] : null;
  };
  // Column sorting (library scope): click a header to sort by it, click it again to
  // reverse. "" = the library's natural (file) order. Numeric columns start descending
  // (newest / most-cited first); text columns start ascending.
  type SortCol = "" | "authors" | "title" | "journal" | "year" | "cited";
  let sortCol = $state<SortCol>("");
  let sortDir = $state<1 | -1>(1);
  function setSort(col: Exclude<SortCol, "">) {
    if (sortCol === col) {
      sortDir = sortDir === 1 ? -1 : 1;
    } else {
      sortCol = col;
      sortDir = col === "year" || col === "cited" ? -1 : 1;
    }
  }
  const sortVal = (r: EnrichedEntry, col: SortCol): string | number =>
    col === "authors"
      ? (r.authors[0] ?? "").toLowerCase()
      : col === "title"
        ? r.title.toLowerCase()
        : col === "journal"
          ? (r.container ?? "").toLowerCase()
          : col === "year"
            ? parseInt(r.year, 10) || 0
            : (r.enrich?.citedByCount ?? -1);
  const results = $derived.by(() => {
    // Full-text mode: show only papers whose stored text matched (from the async scan);
    // otherwise the metadata query. showFailedOnly narrows either.
    let base = ftMode ? enriched.filter((r) => ftHits.has(nfc(r.key))) : queryRun(enriched, queryDebounced);
    if (showFailedOnly) base = base.filter((r) => isFailed(r.key));
    // PDF presence isn't a metadata field — it's disk state (pdfKeys), so it narrows the
    // result set here rather than living in the query grammar.
    if (pdfFilter !== "all") base = base.filter((r) => hasPdf(r.key) === (pdfFilter === "have"));
    if (sortCol) {
      const col = sortCol;
      const dir = sortDir;
      return [...base].sort((a, b) => {
        const va = sortVal(a, col);
        const vb = sortVal(b, col);
        const c = typeof va === "number" ? va - (vb as number) : va.localeCompare(vb as string);
        return dir * c;
      });
    }
    // Default full-text ranking: most hits first (an explicit column sort overrides above).
    if (ftMode) return [...base].sort((a, b) => (ftHits.get(nfc(b.key))?.count ?? 0) - (ftHits.get(nfc(a.key))?.count ?? 0));
    return base;
  });

  // WS-8.2: hand-rolled grid windowing. All N result rows used to render (CSS
  // content-visibility only cheapens layout off-screen); at 5k+ entries the DOM
  // itself is the cost. The collapsed non-ftMode grid renders a ±12-row window
  // between two spacers (ROW_H matches the existing contain-intrinsic-size);
  // ftMode keeps the old full render (already capped at 200 results).
  const ROW_H = 37;
  const WIN_BUFFER = 12;
  const WIN_MIN = 150; // below this, windowing buys nothing — render all
  let gridScrollTop = $state(0);
  let gridViewH = $state(600);
  let expandedH = $state(0); // measured height of the single open detail strip
  const winActive = $derived(!ftMode && results.length > WIN_MIN);
  const expandedIdx = $derived(winActive && expanded ? results.findIndex((r) => r.key === expanded) : -1);
  const gridWin = $derived.by(() => {
    if (!winActive) return { first: 0, last: results.length - 1, topPx: 0, bottomPx: 0 };
    const exH = expandedIdx >= 0 ? expandedH : 0;
    // Locate the first visible row, correcting for the expanded strip when the
    // viewport sits below it.
    let scan = gridScrollTop - ROW_H; // header row
    const expTop = expandedIdx >= 0 ? (expandedIdx + 1) * ROW_H : Infinity;
    if (scan > expTop + exH) scan -= exH;
    else if (scan > expTop) scan = expTop;
    const first = Math.max(0, Math.floor(scan / ROW_H) - WIN_BUFFER);
    const visRows = Math.ceil(gridViewH / ROW_H) + WIN_BUFFER * 2;
    const last = Math.min(results.length - 1, first + visRows);
    const topPx = first * ROW_H + (expandedIdx >= 0 && expandedIdx < first ? exH : 0);
    const bottomPx = Math.max(0, (results.length - 1 - last) * ROW_H) + (expandedIdx > last ? exH : 0);
    return { first, last, topPx, bottomPx };
  });
  const winRows = $derived(winActive ? results.slice(gridWin.first, gridWin.last + 1) : results);
  function onGridScroll() {
    if (gridEl) gridScrollTop = gridEl.scrollTop;
  }
  // Keyboard nav: keep the highlighted row inside the rendered window (the
  // window follows scrollTop, so scrolling it into view also renders it).
  $effect(() => {
    const i = highlighted;
    if (!winActive || !gridEl) return;
    const rowTop = ROW_H + i * ROW_H + (expandedIdx >= 0 && i > expandedIdx ? expandedH : 0);
    const rowBot = rowTop + ROW_H;
    const st = gridEl.scrollTop;
    if (rowTop < st + ROW_H) gridEl.scrollTop = Math.max(0, rowTop - ROW_H);
    else if (rowBot > st + gridEl.clientHeight) gridEl.scrollTop = rowBot - gridEl.clientHeight;
  });
  // LR-U2: selection helpers + the "add N to the open project" bulk action. materializeIntoProject
  // is idempotent and lock-guarded ("references"), so re-adding already-cited keys is a no-op.
  const isSel = (key: string) => selected.has(key);
  function toggleSel(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }
  const allShownSelected = $derived(results.length > 0 && results.every((r) => selected.has(r.key)));
  function toggleSelectAll() {
    const next = new Set(selected);
    if (allShownSelected) for (const r of results) next.delete(r.key);
    else for (const r of results) next.add(r.key);
    selected = next;
  }
  const projectRoot = $derived($currentProject?.path ?? null);
  const projectName = $derived($currentProject?.name ?? "project");
  let addingToProject = $state(false);
  async function addSelectedToProject() {
    const root = projectRoot;
    if (!root || !selected.size || addingToProject) return;
    addingToProject = true;
    const keys = [...selected];
    try {
      const { added } = await materializeIntoProject(root, keys);
      addStatus = "added";
      addedTitle = added.length
        ? `Added ${added.length} to ${projectName}` +
          (added.length < keys.length ? ` · ${keys.length - added.length} already there` : "")
        : `All ${keys.length} already in ${projectName}`;
      selected = new Set();
      setTimeout(() => {
        if (addStatus === "added") addStatus = "";
      }, 5200);
    } catch (e) {
      pushToast("error", "Couldn't add to the project", { detail: e instanceof Error ? e.message : String(e) });
    } finally {
      addingToProject = false;
    }
  }
  // Delete references from FluxLib — the checked rows, or the highlighted row (Alt+Del).
  // No confirm dialog: the toast offers Undo (re-adds the exact raw BibTeX under the same
  // keys). items/<key>/ (PDF, notes) stays on disk either way, so undo loses nothing.
  let deleting = $state(false);
  async function deleteRefs(keys: string[]) {
    if (!keys.length || deleting) return;
    deleting = true;
    try {
      const { removed } = await removeFromFluxLib(keys);
      if (!removed.length) return;
      const gone = new Set(removed.map((r) => r.key));
      // Update the local list immediately (the revision bump re-reads from disk right after).
      entries = entries.filter((e) => !gone.has(e.key));
      selected = new Set([...selected].filter((k) => !gone.has(k)));
      if (gone.has(expanded)) expanded = "";
      const raws = removed.map((r) => r.raw).filter(Boolean) as string[];
      pushToast(
        "success",
        `Deleted ${removed.length} reference${removed.length === 1 ? "" : "s"} from FluxLib`,
        {
          ttl: 8000,
          action: raws.length
            ? { label: "Undo", run: () => void undoDelete(raws.join("\n\n")) }
            : undefined,
        },
      );
    } catch (e) {
      pushToast("error", "Couldn't delete from FluxLib", { detail: e instanceof Error ? e.message : String(e) });
    } finally {
      deleting = false;
    }
  }
  // The Undo action must actually confirm the re-add before claiming success —
  // addToFluxLib can throw on lock contention just like the delete did.
  async function undoDelete(raw: string) {
    try {
      await addToFluxLib(raw, { source: "bibtex" });
      pushToast("success", "Restored");
    } catch (e) {
      pushToast("error", "Couldn't restore — the references are still deleted", {
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const coverage = $derived({
    total: entries.length,
    hydrated: entries.filter((e) => enrichMap[e.key]).length,
  });
  const hasPdf = (key: string) => pdfKeys.has(nfc(key));
  const canFetch = (r: EnrichedEntry) => !!(r.doi || r.enrich?.openAccess?.url || r.enrich?.ids?.pmcid);
  const pdfCoverage = $derived({
    total: entries.length,
    have: entries.filter((e) => hasPdf(e.key)).length,
  });

  function fmtCount(n?: number): string {
    if (n == null) return "";
    if (n >= 10000) return Math.round(n / 1000) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }
  const friendlyErr = (e: unknown) => {
    const m = (e as Error)?.message || String(e);
    return /429|rate/i.test(m)
      ? "Rate-limited (semantic is 1/s) — add a free OpenAlex key in ⚙ Keys for 10×, then retry."
      : m;
  };
  // Semantic Scholar is unusable without a key (the shared keyless pool is throttled).
  // If none is configured, say so instead of surfacing a raw HTTP error.
  async function s2ErrMsg(e: unknown): Promise<string> {
    try {
      const k = await fileBridge()?.keysGet?.();
      if (!k?.s2Key)
        return "Semantic Scholar needs a free API key — add it in ⚙ Keys (the keyless pool is rate-limited).";
    } catch {
      /* ignore */
    }
    return (e as Error)?.message || String(e);
  }

  async function reload() {
    try {
      [entries, enrichMap, pdfKeys, failures, organizeData] = await Promise.all([
        loadFluxLib(),
        loadEnrichMap(),
        listPdfKeys(),
        listFailures(),
        loadOrganize(),
      ]);
      loadError = "";
    } catch (e) {
      // A read failure must NOT masquerade as "your library is empty".
      loadError = e instanceof Error ? e.message : String(e);
      pushToast("error", "Couldn't read your FluxLib", {
        detail: loadError,
        action: { label: "Retry", run: () => void reload() },
      });
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void ensureFluxLib()
      .then(reload)
      .catch((e) => {
        loadError = e instanceof Error ? e.message : String(e);
        loading = false;
        pushToast("error", "Couldn't open your FluxLib", {
          detail: loadError,
          action: { label: "Retry", run: () => void reload() },
        });
      });
    void refreshProxy();
    // Zotero: make the header button reflect the connection without opening the panel.
    if (!zoteroSyncJob.settingsLoaded) void zoteroSyncJob.loadSettings();
    // Startup scan: on the first Library mount of the session, auto-process anything already in
    // the watched inbox — but never offline (a network blink must not defer the whole inbox).
    // Re-mounts only re-scan if new files arrived (processed files are removed).
    void countInbox().then((n) => {
      inboxCount = n;
      if (n > 0 && !assignAutoScanned && !assignJob.running && navigator.onLine !== false) {
        assignAutoScanned = true;
        void runAssign();
      }
    });
    let first = true;
    const unsubLib = fluxLibRevision.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      void reload();
    });
    // A PDF landed in the drop-inbox (watcher) — refresh the button count live. The
    // assignJob module owns the debounced auto-scan; this is display-only.
    let firstInbox = true;
    const unsubInbox = assignInboxRevision.subscribe(() => {
      if (firstInbox) {
        firstInbox = false;
        return;
      }
      void countInbox().then((n) => (inboxCount = n));
    });
    return () => {
      unsubLib();
      unsubInbox();
    };
  });

  $effect(() => {
    if (highlighted > results.length - 1) highlighted = Math.max(0, results.length - 1);
  });

  // LR-7: surface a finished bulk-run's summary from the job singleton — whether it completed
  // while Library was open OR while the user was away in another mode (the old code only showed
  // the summary via the awaited start() call, which resolved on a since-destroyed component and
  // was silently lost). Fires once per run (guarded by the module-scoped shownFetchSeq), and
  // re-lists coverage + failure pills since a run that finished while we were away changed disk.
  $effect(() => {
    if (pdfFetchJob.running) return;
    const seq = pdfFetchJob.runSeq;
    const sum = pdfFetchJob.lastSummary;
    if (!sum || seq <= shownFetchSeq) return;
    shownFetchSeq = seq;
    showFetchSummary(sum);
    void (async () => {
      [pdfKeys, failures] = await Promise.all([listPdfKeys(), listFailures()]);
    })();
  });

  // Zotero sync finished (here or while away) → re-list the library + PDF pills. The
  // summary toast comes from the job itself; this effect only refreshes what's shown.
  $effect(() => {
    if (zoteroSyncJob.running) return;
    const seq = zoteroSyncJob.runSeq;
    if (seq <= shownZoteroSeq) return;
    shownZoteroSeq = seq;
    void (async () => {
      await reload();
      pdfKeys = await listPdfKeys();
    })();
  });

  // Assign-inbox scan finished (here or while away) → surface a summary + re-list disk/library.
  $effect(() => {
    if (assignJob.running) return;
    const seq = assignJob.runSeq;
    if (seq <= shownAssignSeq) return;
    shownAssignSeq = seq;
    const r = assignJob.lastResults;
    if (r.length) {
      const a = assignJob.attached + assignJob.added;
      const bits = [
        a ? `${a} filed` : "",
        assignJob.discarded ? `${assignJob.discarded} duplicate${assignJob.discarded === 1 ? "" : "s"} kept in supplements` : "",
        assignJob.unresolved ? `${assignJob.unresolved} unresolved` : "",
        assignJob.deferred ? `${assignJob.deferred} deferred (network)` : "",
      ].filter(Boolean);
      const suffix = assignJob.offline
        ? " — network unavailable; files left in the inbox to retry"
        : assignJob.unresolved
          ? " — see pdfs_to_assign/_unresolved/"
          : "";
      pushToast(assignJob.unresolved ? "error" : "success", `Assigned ${r.length} PDF${r.length === 1 ? "" : "s"}`, {
        detail: bits.join(" · ") + suffix,
        ttl: 6000,
      });
    }
    void (async () => {
      inboxCount = await countInbox();
      await reload();
    })();
  });

  /** Kick a scan of the watched inbox (or cancel a running one). */
  async function runAssign() {
    if (assignJob.running) {
      assignJob.cancel();
      return;
    }
    inboxCount = await countInbox();
    if (inboxCount === 0) return;
    await assignJob.start();
  }

  async function toggleKeys() {
    if (!keysOpen) {
      const k = (await fileBridge()?.keysGet?.()) ?? {};
      keyOpenAlex = (k.openAlexKey as string) || "";
      keyS2 = (k.s2Key as string) || "";
      keyMailto = (k.mailto as string) || "";
      keyEzproxy = (k.ezproxyPrefix as string) || "";
      keysSaved = false;
      const c = await fileBridge()?.proxyHasCredentials?.();
      proxyUser = c?.username || "";
      credAvailable = !!c?.available;
      credHasPass = !!c?.hasPassword;
      proxyPass = "";
    }
    keysOpen = !keysOpen;
  }
  async function saveCredentials() {
    const r = await fileBridge()?.proxySetCredentials?.(proxyUser.trim(), proxyPass);
    if (r && "error" in r && r.error) {
      addStatus = "error";
      addError = r.error;
      setTimeout(() => {
        if (addStatus === "error") addStatus = "";
      }, 4200);
      return;
    }
    if (proxyPass) credHasPass = true;
    proxyPass = "";
    credSaved = true;
    setTimeout(() => (credSaved = false), 2000);
  }
  async function clearCredentials() {
    try {
      await fileBridge()?.proxyClearCredentials?.();
      proxyUser = "";
      proxyPass = "";
      credHasPass = false;
    } catch (e) {
      pushToast("error", "Couldn't clear the saved credentials", { detail: e instanceof Error ? e.message : String(e) });
    }
  }
  async function saveKeysPanel() {
    try {
      await fileBridge()?.keysSet?.({
        openAlexKey: keyOpenAlex.trim(),
        s2Key: keyS2.trim(),
        mailto: keyMailto.trim(),
        ezproxyPrefix: keyEzproxy.trim(),
      });
      keysSaved = true;
      setTimeout(() => (keysSaved = false), 2000);
      void refreshProxy();
    } catch (e) {
      pushToast("error", "Couldn't save API keys", { detail: e instanceof Error ? e.message : String(e) });
    }
  }

  async function refreshProxy() {
    const s = await fileBridge()?.proxyStatus?.();
    proxyConfigured = !!s?.configured;
    proxySignedIn = !!s?.signedIn;
  }
  async function signInProxy() {
    if (proxyBusy) return;
    proxyBusy = true;
    try {
      const r = await fileBridge()?.proxyLogin?.();
      if (r && "error" in r && r.error) {
        addStatus = "error";
        addError = r.error;
        setTimeout(() => {
          if (addStatus === "error") addStatus = "";
        }, 3600);
      }
      await refreshProxy();
    } finally {
      proxyBusy = false;
    }
  }
  async function getViaProxy(e: MouseEvent, entry: EnrichedEntry) {
    e.stopPropagation();
    if (fetchingKey || fetchingAll) return;
    fetchingKey = entry.key;
    try {
      // One paper, user-initiated: grab its supplementary files too. The article page is
      // already loaded and authenticated, so this is a few extra same-session GETs — a cost
      // only bulk runs can't afford.
      const r = await fetchViaProxyForEntry(entry, enrichMap[entry.key], { withSupplements: true });
      if (r.status === "got") {
        pdfKeys = await listPdfKeys();
        await dropFailure(entry.key); // success clears any prior failure record + ⚠
        if (r.supplements) pushToast("info", `Also saved ${r.supplements} supplementary file${r.supplements === 1 ? "" : "s"}`);
      } else {
        addStatus = "error";
        addError = r.error || (r.status === "no-oa" ? "The proxy didn’t return a PDF (are you signed in?)." : "Proxy fetch failed.");
        setTimeout(() => {
          if (addStatus === "error") addStatus = "";
        }, 4200);
      }
    } finally {
      fetchingKey = "";
    }
  }
  // Clear a paper's failure record + the local ⚠ set (on any successful per-row fetch).
  async function dropFailure(key: string) {
    if (!isFailed(key)) return;
    await clearFetchFailure(key);
    const { [nfc(key)]: _dropped, ...rest } = failures;
    failures = rest;
  }

  async function runEnrich() {
    if (enriching) return;
    enriching = true;
    enrichProg = "";
    try {
      const r = await hydrateFluxLib({ onProgress: (d, t) => (enrichProg = `${d}/${t}`) });
      addStatus = "added";
      addedTitle = `Enriched ${r.fetched} (+${r.crossrefBackfill} abstracts) · ${r.withAbstract}/${r.total} with abstracts`;
      setTimeout(() => {
        if (addStatus === "added") addStatus = "";
      }, 3600);
    } catch (e) {
      addStatus = "error";
      addError = (e as Error).message || "Enrichment failed.";
      setTimeout(() => {
        if (addStatus === "error") addStatus = "";
      }, 3600);
    } finally {
      enriching = false;
      enrichProg = "";
      await reload();
    }
  }

  // --- FluxFinder: acquire OA PDFs ------------------------------------------
  function readPaper(e: MouseEvent, key: string) {
    e.stopPropagation();
    openInReader(key);
  }
  // 3.2: export a paper's highlights/notes as Markdown (loads them on demand).
  async function exportNotes(e: MouseEvent, r: EnrichedEntry) {
    e.stopPropagation();
    const af = await loadAnnotations(r.key);
    await saveAnnotationsMarkdown(r.key, af.annotations, { title: r.title, authors: r.authors, year: r.year, doi: r.doi });
  }
  // 3.3 organization: reading-status cycle, tag add/remove, and bulk-tag the selection.
  const orgOf = (key: string) => organizeOf(organizeData, key);
  const STATUS_NEXT: Record<string, ReadingStatus | undefined> = { unread: "reading", reading: "read", read: undefined };
  const STATUS_DOT: Record<string, { label: string; title: string }> = {
    unread: { label: "○", title: "Unread — click to mark reading" },
    reading: { label: "◐", title: "Reading — click to mark read" },
    read: { label: "●", title: "Read — click to clear" },
  };
  // Organize writes go through a cross-writer lock (CLI/MCP/agents write too), so
  // they can legitimately reject with "library is busy" — surface that, never swallow.
  const orgErr = (e: unknown) => pushToast("error", "Couldn't update the library", { detail: e instanceof Error ? e.message : String(e) });
  async function cycleStatus(e: MouseEvent, key: string) {
    e.stopPropagation();
    const cur = orgOf(key).status ?? "unread";
    try {
      organizeData = await organizeSetStatus(key, STATUS_NEXT[cur]);
    } catch (err) {
      orgErr(err);
    }
  }
  // Returns true only if the tag was actually persisted — the caller clears the
  // input on success so a failed write doesn't silently lose what was typed.
  async function addTagToValue(key: string, value: string): Promise<boolean> {
    const t = value.trim();
    if (!t) return false;
    try {
      organizeData = await organizeSetTags(key, [...orgOf(key).tags, t]);
      return true;
    } catch (err) {
      orgErr(err);
      return false;
    }
  }
  async function removeTagFrom(key: string, tag: string) {
    try {
      organizeData = await organizeSetTags(key, orgOf(key).tags.filter((x) => x.toLowerCase() !== tag.toLowerCase()));
    } catch (err) {
      orgErr(err);
    }
  }
  let bulkTagDraft = $state("");
  async function bulkTagSelected() {
    const t = bulkTagDraft.trim();
    if (!t || !selected.size) return;
    try {
      organizeData = await organizeBulkAddTag([...selected], t);
      bulkTagDraft = ""; // clear only after the write lands
    } catch (err) {
      orgErr(err);
    }
  }
  // Facets: the distinct tags / collections in the library, for one-click filtering.
  const facetTags = $derived(allTags(organizeData));
  const facetCollections = $derived(allCollections(organizeData));
  // Match a `field:value` clause on a whole-token boundary so prefix-overlapping
  // values can't collide (status:read vs status:reading; tag:neuro vs neuroscience).
  function facetClause(field: "tag" | "status" | "collection", value: string): string {
    return value.includes(" ") ? `${field}:"${value}"` : `${field}:${value}`;
  }
  function facetActive(field: "tag" | "status" | "collection", value: string): boolean {
    const esc = facetClause(field, value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${esc}(?=\\s|$)`).test(query);
  }
  // Append (or toggle off) a `field:value` clause on the search query.
  function toggleFacet(field: "tag" | "status" | "collection", value: string) {
    const clause = facetClause(field, value);
    const esc = clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\s)${esc}(?=\\s|$)`);
    query = re.test(query)
      ? query.replace(re, " ").replace(/\s{2,}/g, " ").trim()
      : (query ? `${query} ${clause}` : clause);
  }
  let facetsOpen = $state(false);
  // Ctrl+Shift+click: open the PDF in the reader, fetching it first if it isn't on disk —
  // open-access routes, then (if configured) the library proxy. Failures surface in the
  // shared error toast with the reason.
  async function readOrFetch(entry: EnrichedEntry) {
    if (hasPdf(entry.key)) {
      openInReader(entry.key);
      return;
    }
    if (fetchingKey || fetchingAll) return;
    fetchingKey = entry.key;
    try {
      const oa = await fetchPdfForEntry(entry, enrichMap[entry.key]);
      let got = oa.status === "got" || oa.status === "have";
      let err = "";
      if (!got) {
        if (oa.status === "no-id") {
          err = "No DOI / PMCID on this entry — Enrich it first.";
        } else if (oa.status === "error") {
          err = oa.error || "PDF fetch failed.";
        } else if (proxyConfigured) {
          const p = await fetchViaProxyForEntry(entry, enrichMap[entry.key], { withSupplements: true });
          got = p.status === "got";
          if (!got)
            err = `No open-access copy, and the library proxy didn’t return a PDF${
              p.error ? ` (${p.error})` : proxySignedIn ? "" : " (are you signed in? ⚙ Keys)"
            }.`;
        } else {
          err = "No open-access PDF found — set a library proxy in ⚙ Keys for paywalled access.";
        }
      }
      if (got) {
        pdfKeys = await listPdfKeys();
        await dropFailure(entry.key);
        openInReader(entry.key);
      } else {
        addStatus = "error";
        addError = err;
        setTimeout(() => {
          if (addStatus === "error") addStatus = "";
        }, 5200);
      }
    } finally {
      fetchingKey = "";
    }
  }
  async function getPdf(e: MouseEvent, entry: EnrichedEntry) {
    e.stopPropagation();
    if (fetchingKey || fetchingAll) return;
    fetchingKey = entry.key;
    try {
      const r = await fetchPdfForEntry(entry, enrichMap[entry.key]);
      if (r.status === "got" || r.status === "have") {
        pdfKeys = await listPdfKeys();
        await dropFailure(entry.key);
      } else {
        addStatus = "error";
        addError =
          r.status === "no-oa"
            ? proxyConfigured
              ? 'No open-access PDF found — try "Get via library ⚿" in the row\'s details.'
              : "No open-access PDF found — for paywalled PDFs, set up your library proxy in ⚙ Keys."
            : r.status === "no-id"
              ? "No DOI / PMCID on this entry — Enrich it first."
              : r.error || "PDF fetch failed.";
        setTimeout(() => {
          if (addStatus === "error") addStatus = "";
        }, 3600);
      }
    } finally {
      fetchingKey = "";
    }
  }
  async function ingest(e: MouseEvent, key: string) {
    e.stopPropagation();
    if (fetchingKey || fetchingAll) return;
    const picked = await fileBridge()?.openFiles?.([{ name: "PDF", extensions: ["pdf"] }]);
    const file = picked?.[0];
    if (!file) return;
    fetchingKey = key;
    try {
      if (await ingestPdfFile(key, file)) {
        pdfKeys = await listPdfKeys();
      } else {
        addStatus = "error";
        addError = "That file isn’t a valid PDF.";
        setTimeout(() => {
          if (addStatus === "error") addStatus = "";
        }, 3600);
      }
    } finally {
      fetchingKey = "";
    }
  }
  // Bulk fetch: OA waterfall then, for anything still missing, the library proxy — running in
  // a module-level job so it keeps going after the user leaves Library. If a run is active the
  // button cancels it. `retryFailed` ignores the Part C skip-list (the "Retry failed" action).
  async function getAllPdfs(retryFailed = false) {
    if (pdfFetchJob.running) {
      pdfFetchJob.cancel();
      return;
    }
    await runFetch(entries, retryFailed);
  }
  // Alt+F / selection-bar action: the same two-phase pipeline over just the checked rows.
  // Explicitly-picked papers bypass the failure skip-list + OA-miss ledger (retryFailed) —
  // checking a box IS the retry gesture.
  async function fetchSelectedPdfs() {
    if (pdfFetchJob.running || !selected.size) return;
    await runFetch(
      entries.filter((e) => selected.has(e.key)),
      true,
    );
  }
  // Web capture onboarding. The extension is the whole story now; the panel exists because a
  // browser will NOT let a page navigate to chrome://extensions or about:addons, so the honest
  // affordances are "open the folder for you" and "open the add-on file for you", with the
  // address copied to paste. The live status is the important part — extension onboarding
  // usually fails because the user can't tell whether it worked, and Flux knows exactly when a
  // capture arrives.
  let capOpen = $state(false);
  let capInfo = $state<{ dir: string; hasDir: boolean; xpi: string | null } | null>(null);
  let capNote = $state("");
  let capCopied = $state("");
  const CHROME_URL = "chrome://extensions";
  async function openCaptureSetup() {
    capOpen = !capOpen;
    if (capOpen && !capInfo) capInfo = (await fileBridge()?.captureExtensionInfo?.()) ?? null;
  }
  async function revealExtension() {
    const r = await fileBridge()?.revealCaptureExtension?.();
    capNote = r?.ok ? "opened the folder — pick it in the browser's Load unpacked dialog" : (r?.error ?? "couldn't open the folder");
  }
  async function installXpi() {
    const r = await fileBridge()?.installCaptureXpi?.();
    capNote = r?.ok ? "Firefox should be asking you to confirm the install" : (r?.error ?? "couldn't open the add-on");
  }
  async function copyAddr(addr: string) {
    try {
      await navigator.clipboard.writeText(addr);
      capCopied = addr;
      setTimeout(() => (capCopied = ""), 2400);
    } catch {
      capNote = "couldn't copy — select and copy the address by hand";
    }
  }
  /** "just now" / "3m ago" — the proof that capture is working. */
  function sinceLabel(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const m = Math.floor(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }

  // Backfill supplements for the checked rows. Separate from "Get PDFs" on purpose: it never
  // touches a paper.pdf that's already there, it asks the repository (Europe PMC) first, and
  // it only walks the publisher's page for what the repository doesn't hold — which is where
  // the per-publisher rate limiter matters most.
  let fetchingSupps = $state(false);
  let suppProgress = $state("");
  async function fetchSelectedSupplements() {
    if (fetchingSupps || pdfFetchJob.running || !selected.size) return;
    const list = entries.filter((e) => selected.has(e.key));
    fetchingSupps = true;
    suppProgress = `0/${list.length}`;
    try {
      const s = await fetchSupplementsForEntries(
        list.map((e) => ({ entry: e, enrich: enrichMap[e.key] })),
        {
          allowProxy: proxyConfigured && proxySignedIn,
          onProgress: (done, total) => (suppProgress = `${done}/${total}`),
        },
      );
      pushToast(
        s.files ? "info" : "info",
        s.files ? `Saved ${s.files} supplementary file${s.files === 1 ? "" : "s"} across ${s.papers} paper${s.papers === 1 ? "" : "s"}` : "No supplements found for those papers",
        s.files || proxyConfigured ? undefined : { detail: "Europe PMC covers open-access papers only — configure the library proxy (⚙ Keys) to reach publisher-hosted supplements." },
      );
    } catch (e) {
      pushToast("error", "Supplement fetch failed", { detail: e instanceof Error ? e.message : String(e) });
    } finally {
      fetchingSupps = false;
      suppProgress = "";
    }
  }
  async function runFetch(list: RefEntry[], retryFailed: boolean) {
    if (fetchingKey || loading || !list.length || preflightBusy) return;
    // PRE-FLIGHT: re-probe library authentication at click time (ground truth — a real
    // proxied navigation in main, not the possibly-stale pill state). If the proxy is
    // configured but the session is dead, START NOTHING: a bulk run would burn the whole
    // library phase on session-expired bounces. The OA phase avoids the ban-prone
    // publishers and needs no auth — it's gated here only when the user has a proxy
    // configured and expects the paywalled route to work.
    preflightBusy = true;
    try {
      await refreshProxy();
      if (proxyConfigured && !proxySignedIn) {
        addStatus = "error";
        addError = "Library session inactive — nothing started. Sign in via ⚙ Keys → Sign in, then run Get PDFs again.";
        setTimeout(() => {
          if (addStatus === "error") addStatus = "";
        }, 6000);
        return;
      }
    } finally {
      preflightBusy = false;
    }
    // Optimistically tick the local PDF set as papers land, so coverage updates live while
    // Library is mounted (the job also re-lists on completion). LR-4: coalesce the updates —
    // the old code allocated a fresh Set and reassigned pdfKeys per landed PDF, re-rendering
    // every row, so a 500-paper bulk fetch was O(N²). Buffer landed keys and fold them into
    // ONE new Set at most every ~250ms.
    let tickBuf: string[] = [];
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    const flushTicks = () => {
      tickTimer = undefined;
      if (!tickBuf.length) return;
      const next = new Set(pdfKeys);
      for (const k of tickBuf) next.add(nfc(k));
      tickBuf = [];
      pdfKeys = next;
    };
    const onTick = (key: string, got: boolean) => {
      if (got && !hasPdf(key)) {
        tickBuf.push(key);
        if (!tickTimer) tickTimer = setTimeout(flushTicks, 250);
      }
    };
    await pdfFetchJob.start(list, enrichMap, { proxyConfigured, proxySignedIn }, { retryFailed, onTick });
    if (tickTimer) clearTimeout(tickTimer);
    tickBuf = [];
    // The summary + coverage re-list are handled by the completion $effect above, so they also
    // fire when a run finishes after the user leaves and returns to Library (not only here).
  }

  // LR-7: render a finished run's summary into the shared add/status pill. Called by the
  // completion $effect for every run (whether or not Library was mounted when it finished).
  function showFetchSummary(sum: GuiFetchSummaryLite) {
    if (sum.errorNote) {
      // The run threw — surface it as a real error, not a "you stopped it" summary.
      pushToast("error", "PDF fetch stopped on an error", { detail: sum.errorNote });
      addedTitle = `Stopped on an error · ${sum.oaGot + sum.proxyGot} fetched first`;
    } else if (sum.cancelled) {
      addedTitle = `Stopped · ${sum.oaGot + sum.proxyGot} fetched so far`;
    } else {
      const parts = [`${sum.oaGot} open-access`];
      if (sum.proxyGot || proxySignedIn) parts.push(`${sum.proxyGot} via library`);
      addedTitle =
        `Fetched ${sum.oaGot + sum.proxyGot} (${parts.join(" · ")})` +
        (sum.failedNew ? ` · ${sum.failedNew} failed` : "") +
        (sum.needSignIn ? ` · ${sum.needSignIn} need library sign-in` : "") +
        (sum.oaSkipped ? ` · ${sum.oaSkipped} known no-OA skipped` : "") +
        (sum.blockedSkipped ? ` · ${sum.blockedSkipped} deferred (publisher blocking)` : "") +
        (sum.errors ? ` · ${sum.errors} error` : "");
    }
    addStatus = "added";
    setTimeout(() => {
      if (addStatus === "added") addStatus = "";
    }, 5200);
  }

  async function submitAdd() {
    const v = addValue.trim();
    if (!v || addStatus === "fetching") return;
    addError = "";
    addStatus = "fetching";
    try {
      const r = await addUrlOrDoiToLibrary(v);
      if ("error" in r) {
        addStatus = "error";
        addError = r.error;
        setTimeout(() => {
          if (addStatus === "error") addStatus = "";
        }, 3200);
        return;
      }
      addStatus = "added";
      addedTitle = r.title || r.key;
      addValue = "";
      setTimeout(() => {
        if (addStatus === "added") addStatus = "";
      }, 2600);
    } catch (e) {
      // A thrown add (IPC reject, lock contention) must not strand the spinner.
      addStatus = "error";
      addError = e instanceof Error ? e.message : String(e);
      setTimeout(() => {
        if (addStatus === "error") addStatus = "";
      }, 3200);
    }
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText("@" + key);
      copied = key;
      setTimeout(() => {
        if (copied === key) copied = "";
      }, 1200);
    } catch {
      /* clipboard blocked */
    }
  }
  function openDoi(e: MouseEvent, doi?: string) {
    e.stopPropagation();
    if (doi) void fileBridge()?.openExternal?.("https://doi.org/" + doi);
  }
  // Alt+click on a row: open the DOI in the default browser (toast if there isn't one).
  function openDoiOrWarn(e: MouseEvent, doi?: string) {
    if (doi) {
      openDoi(e, doi);
      return;
    }
    addStatus = "error";
    addError = "No DOI on this entry — Enrich it or add one first.";
    setTimeout(() => {
      if (addStatus === "error") addStatus = "";
    }, 3600);
  }
  function toggleExpand(e: MouseEvent, key: string) {
    e.stopPropagation();
    expanded = expanded === key ? "" : key;
  }
  // Clear a paper's failure record so the next bulk run retries it (and drop the ⚠).
  async function clearFailure(e: MouseEvent, key: string) {
    e.stopPropagation();
    await dropFailure(key);
  }

  // --- World scope ---------------------------------------------------------
  function setScope(s: "library" | "world") {
    scope = s;
    if (s === "world" && query.trim() && worldResults.length === 0) void doWorldSearch();
  }
  const lexSort = () =>
    worldSort === "citations" ? "cited_by_count:desc" : worldSort === "date" ? "publication_date:desc" : undefined;

  function setLexicalLoadMore(fetchPage: (page: number) => Promise<WorldBrief[]>) {
    worldLoadMore = async () => {
      worldPage += 1;
      const more = await fetchPage(worldPage);
      if (more.length) worldResults = [...worldResults, ...more];
      if (more.length < 50) worldLoadMore = null;
    };
  }
  async function loadMore() {
    if (!worldLoadMore || worldBusy) return;
    worldBusy = true;
    try {
      await worldLoadMore();
    } catch (e) {
      worldError = friendlyErr(e);
    }
    worldBusy = false;
  }

  async function doWorldSearch() {
    const q = query.trim();
    if (!q) return;
    worldBusy = true;
    worldError = "";
    worldLoadMore = null;
    worldPage = 1;
    lookupCtx = null; // a fresh search clears any active per-entry lookup
    try {
      if (worldMode === "semantic") {
        worldResults = await searchWorldSemantic(q, { sort: worldSort === "citations" ? "citations" : "relevance" });
        worldLabel = `Semantic: “${q}”`;
      } else {
        const sort = lexSort();
        worldResults = await searchWorld(q, { sort, perPage: 50, page: 1 });
        setLexicalLoadMore((p) => searchWorld(q, { sort, perPage: 50, page: p }));
        if (worldResults.length < 50) worldLoadMore = null;
        worldLabel = `Keyword: “${q}”`;
      }
    } catch (e) {
      worldError = friendlyErr(e);
      worldResults = [];
    }
    worldBusy = false;
  }

  async function lookup(
    kind: "citing" | "author" | "similar",
    key: string,
    label: string,
    source: "openalex" | "s2" = "openalex",
  ) {
    scope = "world";
    expanded = "";
    worldBusy = true;
    worldError = "";
    worldResults = [];
    worldLoadMore = null;
    worldPage = 1;
    lookupCtx = { kind, key, label };
    lookupSource = source;
    const head = kind === "citing" ? "Citing" : kind === "author" ? "More by author of" : "Similar to";
    const srcName = source === "s2" ? "Sem. Scholar" : "OpenAlex";
    worldLabel = `${head}: ${label}${kind === "author" ? "" : ` · ${srcName}`}`;
    try {
      if (kind === "similar") {
        worldResults =
          source === "s2"
            ? await s2SimilarByKey(key)
            : await similarOpenAlexByKey(key, { sort: worldSort === "citations" ? "citations" : "relevance" });
      } else if (kind === "citing") {
        if (source === "s2") {
          worldResults = await s2CitingByKey(key); // citing papers WITH contexts + influential flags
        } else {
          worldResults = await citingWorksByKey(key, { sort: "cited_by_count:desc", perPage: 50, page: 1 });
          setLexicalLoadMore((p) => citingWorksByKey(key, { sort: "cited_by_count:desc", perPage: 50, page: p }));
          if (worldResults.length < 50) worldLoadMore = null;
        }
      } else {
        worldResults = await authorWorksByKey(key, { perPage: 50, page: 1 });
        setLexicalLoadMore((p) => authorWorksByKey(key, { perPage: 50, page: p }));
        if (worldResults.length < 50) worldLoadMore = null;
      }
    } catch (e) {
      worldError = lookupSource === "s2" ? await s2ErrMsg(e) : friendlyErr(e);
    }
    worldBusy = false;
  }

  async function addBrief(b: WorldBrief) {
    if (!b.doi) {
      worldError = "That result has no DOI to add.";
      setTimeout(() => (worldError = ""), 2600);
      return;
    }
    const r = await addUrlOrDoiToLibrary(b.doi);
    if ("error" in r) {
      worldError = r.error;
      setTimeout(() => (worldError = ""), 3000);
      return;
    }
    addedIds = new Set(addedIds).add(b.openalexId);
  }

  // A text-entry target: a field where single keystrokes mean "type text", not "trigger a
  // shortcut / grid nav". Checkboxes/radios/buttons are inputs but NOT typing — focus lands
  // on them right after a click and the chords/nav must still work there.
  function isTypingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return (
      !!el &&
      (el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        (el.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((el as HTMLInputElement).type)))
    );
  }

  function onWinKey(e: KeyboardEvent) {
    if (!focused) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      addEl?.focus();
      addEl?.select();
      return;
    }
    // Library-scope Alt-chords. Never fire while typing in a text field (Alt+Backspace is
    // "delete word" there), and stay off Ctrl/Meta combos.
    if (scope !== "library" || !e.altKey || e.metaKey || e.ctrlKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      // Alt+Del: delete the checked rows, else the highlighted row.
      e.preventDefault();
      const r = results[highlighted];
      void deleteRefs(selected.size ? [...selected] : r ? [r.key] : []);
    } else if (e.code === "KeyF") {
      // Alt+F: run the PDF-fetch pipeline (OA → library proxy) over the checked rows.
      e.preventDefault();
      void fetchSelectedPdfs();
    }
  }
  function gridKey(e: KeyboardEvent) {
    if (scope !== "library") return;
    // The grid contains focusable text fields (the per-row tag editor). Their keystrokes
    // bubble here — don't treat them as grid nav / type-to-search, or the first character
    // typed into a tag would steal focus back to the search box.
    if (isTypingTarget(e.target)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = Math.min(results.length - 1, highlighted + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (highlighted <= 0) searchEl?.focus();
      else highlighted -= 1;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[highlighted];
      if (r) void copyKey(r.key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      searchEl?.focus();
    } else if (e.key === " ") {
      // Space toggles selection of the highlighted row (must precede the single-char catch-all,
      // which would otherwise treat Space as a search keystroke and steal focus).
      e.preventDefault();
      const r = results[highlighted];
      if (r) toggleSel(r.key);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      searchEl?.focus();
    }
  }
  function searchKey(e: KeyboardEvent) {
    if (scope === "world") {
      if (e.key === "Enter") {
        e.preventDefault();
        void doWorldSearch();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = 0;
      gridEl?.focus();
    }
  }

  const authorLabel = (r: RefEntry) => `${r.authors[0] ?? r.key}${r.year ? ` ${r.year}` : ""}`;
</script>

<svelte:window onkeydown={onWinKey} />

<div class="lib">
  <header class="lhead">
    <div class="ltitle">
      <span class="h">FluxLib</span>
      <span class="count"
        >{loading ? "…" : `${entries.length} reference${entries.length === 1 ? "" : "s"}`}</span>
    </div>
    <div class="hactions">
      <button class="gear" class:on={keysOpen} onclick={toggleKeys} title="API keys (OpenAlex, Semantic Scholar)" aria-label="API keys">⚙</button>
      <button
        class="enrich"
        class:busy={enriching}
        onclick={runEnrich}
        disabled={enriching || loading}
        title="Fetch abstracts, topics, keywords & citation counts from OpenAlex (no API key needed)">
        {#if enriching}
          Enriching… {enrichProg}
        {:else if coverage.total === 0}
          Enrich
        {:else if coverage.hydrated < coverage.total}
          Enrich {coverage.hydrated}/{coverage.total}
        {:else}
          Enriched ✓
        {/if}
      </button>
      <button
        class="enrich getpdfs"
        class:busy={fetchingAll || preflightBusy}
        onclick={() => getAllPdfs(false)}
        disabled={(fetchingKey !== "" && !fetchingAll) || loading || coverage.total === 0 || preflightBusy}
        title={fetchingAll
          ? "Click to stop the running fetch"
          : "Find & download PDFs for your whole library: open repositories first (PMC · Europe PMC · arXiv · bioRxiv), then your library proxy for the rest. Never hits publisher sites directly. Runs in the background — keep working."}>
        {#if preflightBusy}
          Checking sign-in…
        {:else if fetchingAll}
          {pdfFetchJob.phase === "proxy" ? "Library" : "OA"} {pdfFetchJob.done}/{pdfFetchJob.total} ✕
        {:else if pdfCoverage.have === 0}
          Get PDFs
        {:else if pdfCoverage.have < pdfCoverage.total}
          PDFs {pdfCoverage.have}/{pdfCoverage.total}
        {:else}
          PDFs ✓
        {/if}
      </button>
      <button
        class="enrich"
        onclick={() => (importOpen = true)}
        title="Bulk-import references from a .bib or .ris file (Zotero, EndNote, Mendeley, BibTeX) — with an optional pull of their attached PDFs">
        Import…
      </button>
      <button
        class="enrich"
        onclick={() => (zoteroOpen = true)}
        title={zoteroSyncJob.settings
          ? "Zotero is connected — new Zotero references flow into FluxLib automatically. Click for status, Sync now, and settings."
          : "Connect FluxLib to Zotero: point Flux at a Better BibTeX auto-export and anything you add in Zotero appears here (one-way; nothing is written back)."}>
        {#if zoteroSyncJob.running}
          Zotero ⟳
        {:else if zoteroSyncJob.settings}
          Zotero ✓
        {:else}
          Zotero
        {/if}
      </button>
      {#if inboxCount > 0 || assigning}
        <button
          class="enrich assignpdfs"
          class:busy={assigning}
          onclick={() => void runAssign()}
          title={assigning
            ? "Click to stop the running scan"
            : `Identify each PDF in FluxLib's pdfs_to_assign/ inbox from its content and file it into the matching reference (add the reference if it's new). ${inboxCount} waiting.`}>
          {#if assigning}
            Assigning {assignJob.done}/{assignJob.total} ✕
          {:else}
            Assign PDFs ({inboxCount})
          {/if}
        </button>
      {/if}
      {#if pdfCoverage.total > 0}
        <button
          class="enrich pdffilter"
          class:on={pdfFilter !== "all"}
          onclick={() => (pdfFilter = pdfFilter === "all" ? "missing" : pdfFilter === "missing" ? "have" : "all")}
          title={pdfFilter === "all"
            ? `Filter by PDF: ${pdfCoverage.total - pdfCoverage.have} reference(s) have no main text. Click to show only those; click again for only those WITH a PDF.`
            : pdfFilter === "missing"
              ? "Showing only references with NO PDF. Click for only those WITH a PDF."
              : "Showing only references WITH a PDF. Click to clear the filter."}>
          {#if pdfFilter === "missing"}
            ⬇ No PDF ({pdfCoverage.total - pdfCoverage.have})
          {:else if pdfFilter === "have"}
            ▦ Has PDF ({pdfCoverage.have})
          {:else}
            ⬇ No PDF ({pdfCoverage.total - pdfCoverage.have})
          {/if}
        </button>
      {/if}
      {#if failedKeys.size > 0 && !fetchingAll}
        <button
          class="enrich retryfailed"
          class:on={showFailedOnly}
          onclick={() => (showFailedOnly = !showFailedOnly)}
          ondblclick={() => getAllPdfs(true)}
          title="{failedKeys.size} paper(s) failed both open-access and library routes. Click to filter to them; double-click to retry them all (ignores the skip-list).">
          ⚠ {failedKeys.size} failed
        </button>
      {/if}
      <div class="adddoi" class:failed={addStatus === "error"}>
        <input
          bind:this={addEl}
          bind:value={addValue}
          placeholder="Add by DOI or URL…  (⌘K)"
          spellcheck="false"
          autocomplete="off"
          onkeydown={(e) => {
            if (e.key === "Enter") submitAdd();
          }} />
        <button onclick={submitAdd} disabled={addStatus === "fetching"} title="Add to FluxLib"
          >{addStatus === "fetching" ? "…" : "+"}</button>
      </div>
    </div>
  </header>

  {#if keysOpen}
    <div class="keyspanel">
      <label class="krow">
        <span class="klbl">OpenAlex key <span class="ksub">free · 10× daily limit · optional</span></span>
        <input bind:value={keyOpenAlex} placeholder="key from openalex.org/settings/api" spellcheck="false"
          autocomplete="off" />
      </label>
      <label class="krow">
        <span class="klbl">Semantic Scholar key <span class="ksub">free · enables S2 similar + contexts</span></span>
        <input bind:value={keyS2} placeholder="key from semanticscholar.org/product/api" spellcheck="false"
          autocomplete="off" />
      </label>
      <label class="krow">
        <span class="klbl">Polite email <span class="ksub">mailto — OpenAlex/CrossRef etiquette</span></span>
        <input bind:value={keyMailto} placeholder="you@example.com" spellcheck="false" autocomplete="off" />
      </label>
      <label class="krow">
        <span class="klbl">Library EZProxy prefix
          <span class="ksub">optional · paywalled PDFs · UW-Madison: https://ezproxy.library.wisc.edu/login?url=</span></span>
        <input bind:value={keyEzproxy} placeholder="https://ezproxy.library.wisc.edu/login?url=" spellcheck="false"
          autocomplete="off" />
      </label>
      {#if proxyConfigured}
        <label class="krow">
          <span class="klbl">Library username <span class="ksub">NetID — stored in your OS keychain, auto-fills login</span></span>
          <input bind:value={proxyUser} placeholder="your NetID" spellcheck="false" autocomplete="off" />
        </label>
        <label class="krow">
          <span class="klbl">Library password
            <span class="ksub">{credAvailable ? (credHasPass ? "saved ✓ · leave blank to keep" : "encrypted at rest (safeStorage)") : "OS keychain unavailable on this system"}</span></span>
          <input bind:value={proxyPass} type="password" placeholder={credHasPass ? "•••••••• (unchanged)" : "your password"}
            spellcheck="false" autocomplete="off" disabled={!credAvailable} />
        </label>
        <div class="krow proxyrow">
          <span class="klbl">Library access
            <span class="ksub">{proxySignedIn ? "signed in — paywalled fetch available" : "sign in once; the session + saved credentials keep you in"}</span></span>
          <div class="proxybtns">
            {#if credHasPass}<button class="proxybtn" onclick={clearCredentials} title="Remove stored credentials">Clear</button>{/if}
            <button class="proxybtn" onclick={saveCredentials} disabled={!credAvailable}>{credSaved ? "Saved ✓" : "Save credentials"}</button>
            <button class="proxybtn" class:on={proxySignedIn} disabled={proxyBusy} onclick={signInProxy}
              >{proxyBusy ? "…" : proxySignedIn ? "Re-sign in" : "Sign in"}</button>
          </div>
        </div>
      {/if}
      <div class="kfoot">
        <span class="khint">Stored in FluxLib/keys.json · used across every project · keyless still works</span>
        <button onclick={saveKeysPanel}>{keysSaved ? "Saved ✓" : "Save keys"}</button>
      </div>
    </div>
  {/if}

  <div class="scopebar">
    <div class="seg" role="tablist">
      <button class:on={scope === "library"} onclick={() => setScope("library")}>Library</button>
      <button class:on={scope === "world"} onclick={() => setScope("world")} title="Search all of OpenAlex"
        >World</button>
    </div>
    <input
      class="search"
      bind:this={searchEl}
      bind:value={query}
      onkeydown={searchKey}
      placeholder={scope === "library"
        ? "Search your library  ·  author:smith  topic:reward  ·  ft:optogenetic silencing (full text)"
        : worldMode === "semantic"
          ? "Search OpenAlex by meaning — press Enter"
          : "Keyword-search all of OpenAlex — press Enter"}
      spellcheck="false"
      autocomplete="off" />
    {#if scope === "world"}
      <div class="seg sub" title="Keyword (BM25) vs semantic (meaning) search">
        <button class:on={worldMode === "lexical"} onclick={() => (worldMode = "lexical")}>Keyword</button>
        <button class:on={worldMode === "semantic"} onclick={() => (worldMode = "semantic")}>Semantic</button>
      </div>
      <select class="sort" bind:value={worldSort} onchange={() => query.trim() && doWorldSearch()}>
        <option value="relevance">Relevance</option>
        <option value="citations">Most cited</option>
        {#if worldMode === "lexical"}<option value="date">Newest</option>{/if}
      </select>
    {/if}
  </div>

  {#if scope === "library"}
    {#if ftMode && ftTerm}
      <div class="ftbar" class:err={!!ftError}>
        {#if ftError}
          <span class="ftlbl">Full-text search failed</span><span class="ftmeta">{ftError}</span>
        {:else if ftBusy}
          <span class="ftlbl">Searching stored PDF text…</span>
        {:else}
          <span class="ftlbl">Full text</span>
          <span class="ftmeta"
            >{results.length} paper{results.length === 1 ? "" : "s"} match “{ftTerm}” · scanned {ftScanned} text{ftScanned === 1 ? "" : "s"}{ftTruncated ? " · showing the top matches — refine to narrow" : ""}{ftMissing ? ` · ${ftMissing} PDF${ftMissing === 1 ? "" : "s"} not yet text-extracted` : ""}</span>
        {/if}
      </div>
    {/if}
    {#if selected.size > 0}
      <div class="selbar">
        <span class="selcount">{selected.size} selected</span>
        <button
          class="selact"
          disabled={!projectRoot || addingToProject}
          title={projectRoot
            ? `Add ${selected.size} reference(s) to ${projectName}'s library.bib`
            : "Open a project first to add references to it"}
          onclick={addSelectedToProject}
          >{addingToProject ? "Adding…" : `+ Add to ${projectRoot ? projectName : "project"}${projectRoot ? "" : " (none open)"}`}</button>
        <button
          class="selfetch"
          disabled={fetchingAll || preflightBusy || fetchingKey !== ""}
          title="Fetch PDFs for the checked references — open access first, then your library proxy (Alt+F)"
          onclick={fetchSelectedPdfs}>⬇ Get {selected.size} PDF{selected.size === 1 ? "" : "s"}</button>
        <button
          class="selfetch"
          disabled={fetchingSupps || fetchingAll || preflightBusy || fetchingKey !== ""}
          title="Fetch supplementary files for the checked references — Europe PMC first, then your library proxy. Never replaces a PDF you already have."
          onclick={fetchSelectedSupplements}>{fetchingSupps ? `⧉ Supplements ${suppProgress}` : `⧉ Get supplements`}</button>
        <input
          class="bulktag"
          bind:value={bulkTagDraft}
          placeholder="Tag {selected.size}…"
          onkeydown={(e) => e.key === "Enter" && void bulkTagSelected()}
          title="Type a tag and press Enter to apply it to all selected references" />
        <button
          class="seldel"
          disabled={deleting}
          title="Delete the checked references from FluxLib (Alt+Del) — Undo stays available for a few seconds"
          onclick={() => deleteRefs([...selected])}>Delete {selected.size}</button>
        <button class="selclear" onclick={() => (selected = new Set())}>Clear</button>
      </div>
    {/if}
    {#if facetTags.length || facetCollections.length}
      <div class="facets">
        <button class="facettoggle" onclick={() => (facetsOpen = !facetsOpen)} title="Filter by tag, status, or collection"
          >{facetsOpen ? "▾" : "▸"} Filters</button>
        {#if facetsOpen}
          <div class="facetgroups">
            <div class="facetgroup">
              <span class="facetlbl">Status</span>
              {#each READING_STATUSES as s}
                <button class="facet" class:on={facetActive("status", s)} onclick={() => toggleFacet("status", s)}>{s}</button>
              {/each}
            </div>
            {#if facetTags.length}
              <div class="facetgroup">
                <span class="facetlbl">Tags</span>
                {#each facetTags as t}
                  <button class="facet" class:on={facetActive("tag", t)} onclick={() => toggleFacet("tag", t)}>{t}</button>
                {/each}
              </div>
            {/if}
            {#if facetCollections.length}
              <div class="facetgroup">
                <span class="facetlbl">Collections</span>
                {#each facetCollections as c}
                  <button class="facet coll" class:on={facetActive("collection", c)} onclick={() => toggleFacet("collection", c)}>{c}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
    <div
      class="grid"
      tabindex="0"
      bind:this={gridEl}
      bind:clientHeight={gridViewH}
      onscroll={onGridScroll}
      onkeydown={gridKey}
      data-total={results.length}>
      <div class="grow ghead selectable">
        <span class="gsel"
          ><input
            type="checkbox"
            checked={allShownSelected}
            onchange={toggleSelectAll}
            aria-label="Select all shown"
            title="Select all shown" /></span>
        {#snippet sortArrow(col: string)}
          {#if sortCol === col}<span class="sarr">{sortDir === 1 ? "▲" : "▼"}</span>{/if}
        {/snippet}
        <button class="hcol" title="Sort by first author" onclick={() => setSort("authors")}
          >Authors{@render sortArrow("authors")}</button>
        <button class="hcol" title="Sort by title" onclick={() => setSort("title")}
          >Title{@render sortArrow("title")}</button>
        <button class="hcol" title="Sort by journal" onclick={() => setSort("journal")}
          >Journal{@render sortArrow("journal")}</button>
        <button class="hcol gy" title="Sort by year" onclick={() => setSort("year")}
          >Year{@render sortArrow("year")}</button>
        <button class="hcol gc" title="Sort by citation count" onclick={() => setSort("cited")}
          >Cited{@render sortArrow("cited")}</button>
        <span class="gx"></span>
      </div>
      {#if gridWin.topPx > 0}<div class="gspacer" style="height:{gridWin.topPx}px"></div>{/if}
      {#each winRows as r, wi (r.key)}
        {@const i = gridWin.first + wi}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="grow selectable"
          class:hl={i === highlighted}
          class:sel={isSel(r.key)}
          title={`Click to copy @${r.key} · Ctrl+click: details · Ctrl+Shift+click: read PDF · Alt+click: open DOI`}
          onclick={(e) => {
            highlighted = i;
            if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
              void readOrFetch(r);
            } else if (e.ctrlKey || e.metaKey) {
              expanded = expanded === r.key ? "" : r.key;
            } else if (e.altKey) {
              openDoiOrWarn(e, r.doi);
            } else {
              void copyKey(r.key);
            }
          }}>
          <span class="gsel"
            ><input
              type="checkbox"
              checked={isSel(r.key)}
              onclick={(e) => e.stopPropagation()}
              onchange={() => toggleSel(r.key)}
              aria-label="Select {r.key}" /></span>
          <span class="ga">{r.authors.slice(0, 2).join(", ")}{r.authors.length > 2 ? " et al." : ""}</span>
          <span class="gt" title={r.enrich?.abstract || r.title}>
            {r.title}
            {#if r.enrich?.primaryTopic?.name}<span class="topic">{r.enrich.primaryTopic.name}</span>{/if}
            {#each orgOf(r.key).tags as t}<span class="rtag">{t}</span>{/each}
          </span>
          <span class="gj">{r.container ?? ""}</span>
          <span class="gy">{r.year}</span>
          <span class="gc">{fmtCount(r.enrich?.citedByCount)}</span>
          <span class="gx">
            {#if copied === r.key}
              <span class="copied">✓</span>
            {:else}
              {@const st = orgOf(r.key).status ?? "unread"}
              <button class="statusdot s-{st}" title={STATUS_DOT[st].title} aria-label="Reading status: {st}" onclick={(e) => cycleStatus(e, r.key)}>{STATUS_DOT[st].label}</button>
              {#if hasPdf(r.key)}
                <button class="ico haspdf" title="Read PDF" aria-label="Read PDF" onclick={(e) => readPaper(e, r.key)}
                  >▦</button>
              {:else if canFetch(r)}
                <button
                  class="ico"
                  title="Get open-access PDF"
                  aria-label="Get PDF"
                  disabled={fetchingKey === r.key || fetchingAll}
                  onclick={(e) => getPdf(e, r)}>{fetchingKey === r.key ? "…" : "⬇"}</button>
              {/if}
              {#if !hasPdf(r.key)}
                {@const pill = outcomePill(r.key)}
                {#if pill}
                  <button
                    class="fpill t-{pill.tone}"
                    title={pill.title}
                    aria-label="Fetch outcome: {pill.label} — click for details"
                    onclick={(e) => toggleExpand(e, r.key)}>{pill.label}</button>
                {/if}
              {/if}
              {#if r.doi}
                <button class="ico" title="Open DOI" aria-label="Open DOI" onclick={(e) => openDoi(e, r.doi)}
                  >↗</button>
              {/if}
              <button
                class="ico"
                title="Details · similar · citers"
                aria-label="Toggle details"
                onclick={(e) => toggleExpand(e, r.key)}>{expanded === r.key ? "▾" : "▸"}</button>
            {/if}
          </span>
        </div>
        {#if ftMode}
          {@const hit = ftHits.get(nfc(r.key))}
          {#if hit}
            <div class="ftsnips">
              {#each hit.snippets as s}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <button class="ftsnip" title={hasPdf(r.key) ? "Open in reader and jump to this match" : "PDF not on disk — fetch it to jump to the match"} onclick={(e) => openSnippet(e, r.key)}>
                  <span class="ftpage">p{s.page}</span><span class="fttext">{s.text}</span>
                </button>
              {/each}
              {#if hit.count > hit.snippets.length}
                <span class="ftmore">+{hit.count - hit.snippets.length} more match{hit.count - hit.snippets.length === 1 ? "" : "es"}</span>
              {/if}
            </div>
          {/if}
        {/if}
        {#if expanded === r.key}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="detail" bind:clientHeight={expandedH} onclick={(e) => e.stopPropagation()}>
            {#if !hasPdf(r.key) && isFailed(r.key)}
              <div class="failbanner">
                <span class="fbtag">⚠ PDF fetch failed</span>
                {#if failures[nfc(r.key)]}
                  {@const f = failures[nfc(r.key)]}
                  <span class="fbwhy"
                    >{f.proxy?.reason || "no route"}{f.host ? ` · ${f.host}` : ""}{f.attempts > 1 ? ` · ${f.attempts}×` : ""}</span>
                  {#if f.proxy?.detail}<span class="fbdetail">{f.proxy.detail}</span>{/if}
                {/if}
                <button class="fbretry" onclick={(e) => getViaProxy(e, r)} title="Try the library proxy again now">Retry via library ⚿</button>
                <button class="fbclear" onclick={(e) => clearFailure(e, r.key)} title="Forget this failure so bulk runs retry it">Clear</button>
              </div>
            {/if}
            {#if r.enrich?.abstract}
              <p class="dabs">{r.enrich.abstract}</p>
            {:else}
              <p class="dabs muted">No abstract yet — click <em>Enrich</em> to fetch from OpenAlex/CrossRef.</p>
            {/if}
            {#if r.enrich?.topics?.length}
              <div class="dchips"><span class="clbl">Topics</span>
                {#each r.enrich.topics.slice(0, 5) as t}<span class="chip">{t.name}</span>{/each}
              </div>
            {/if}
            {#if r.enrich?.keywords?.length}
              <div class="dchips"><span class="clbl">Keywords</span>
                {#each r.enrich.keywords.slice(0, 10) as k}<span class="chip kw">{k}</span>{/each}
              </div>
            {/if}
            <div class="dchips"><span class="clbl">Tags</span>
              {#each orgOf(r.key).tags as t}
                <span class="chip tag">{t}<button class="tagx" title="Remove tag" aria-label="Remove {t}" onclick={() => void removeTagFrom(r.key, t)}>×</button></span>
              {/each}
              <input
                class="taginput"
                placeholder="+ tag"
                onkeydown={async (e) => {
                  if (e.key !== "Enter") return;
                  const el = e.currentTarget;
                  if (await addTagToValue(r.key, el.value)) el.value = ""; // keep the text if the write failed
                }} />
            </div>
            <div class="dbtns">
              {#if hasPdf(r.key)}
                <button class="prim" onclick={(e) => readPaper(e, r.key)}>Read PDF →</button>
                <button onclick={(e) => void exportNotes(e, r)} title="Export this paper's highlights & notes as Markdown">Export notes…</button>
              {:else}
                <button
                  disabled={fetchingKey === r.key || fetchingAll || !canFetch(r)}
                  onclick={(e) => getPdf(e, r)}
                  title={canFetch(r) ? "Find an open-access PDF" : "Needs a DOI/PMCID — Enrich first"}
                  >{fetchingKey === r.key ? "Fetching…" : "Get PDF ⬇"}</button>
                <button
                  disabled={fetchingKey === r.key || fetchingAll}
                  onclick={(e) => ingest(e, r.key)}
                  title="File a PDF you already downloaded">Add PDF…</button>
                {#if proxyConfigured}
                  <button
                    class="proxy"
                    disabled={fetchingKey === r.key || fetchingAll || !canFetch(r)}
                    onclick={(e) => getViaProxy(e, r)}
                    title={proxySignedIn ? "Fetch via your library proxy (paywalled)" : "Sign in to your library first (⚙ Keys)"}
                    >{fetchingKey === r.key ? "Via library…" : "Get via library ⚿"}</button>
                {/if}
              {/if}
              {#if r.doi}<button onclick={(e) => openDoi(e, r.doi)}>Open DOI ↗</button>{/if}
              <button disabled={!r.enrich?.openalexId} onclick={() => lookup("citing", r.key, authorLabel(r))}
                >Who cites this →</button>
              <button onclick={() => lookup("similar", r.key, authorLabel(r))}>Similar (semantic) →</button>
              <button disabled={!r.enrich?.authors?.length} onclick={() => lookup("author", r.key, authorLabel(r))}
                >More by author →</button>
              {#if r.enrich?.citedByCount != null}<span class="dcite"
                  >{r.enrich.citedByCount.toLocaleString()} citations</span>{/if}
            </div>
          </div>
        {/if}
      {/each}
      {#if gridWin.bottomPx > 0}<div class="gspacer" style="height:{gridWin.bottomPx}px"></div>{/if}
      {#if loading}
        <div class="none">Loading your library…</div>
      {:else if loadError}
        <div class="none err">
          <div>Couldn't read your FluxLib.</div>
          <div class="submuted">{loadError}</div>
          <button class="retry" onclick={() => { loading = true; void reload(); }}>Retry</button>
        </div>
      {:else if results.length === 0}
        <div class="none">
          {#if ftMode && ftTerm && !ftBusy && !ftError}
            No stored PDF text matches “{ftTerm}”.{ftMissing ? ` ${ftMissing} PDF${ftMissing === 1 ? " has" : "s have"} no extracted text yet — open ${ftMissing === 1 ? "it" : "them"} once in the reader to index.` : ""}
          {:else if ftMode && ftBusy}
            Searching…
          {:else}
            {entries.length ? "No matches." : "Your FluxLib is empty — paste a DOI or URL above."}
          {/if}
        </div>
      {/if}
    </div>

    <footer class="webcap">
      <span class="lbl">Web capture</span>
      <button class="capdot" class:on={!!$captureLastAt} onclick={openCaptureSetup} title={$captureLastAt ? "Web capture is working. Click for setup details." : "Save any paper from your browser in one click. Click to set it up."}>
        <span class="dot"></span>{$captureLastAt ? `Connected — last capture ${sinceLabel($captureLastAt)}` : "Not set up"}
      </button>
      <button class="bminstall" onclick={openCaptureSetup}>{capOpen ? "Hide" : $captureLastAt ? "Setup…" : "Set up…"}</button>
    </footer>
    {#if capOpen}
      <div class="capsetup" transition:fade={{ duration: 120 }}>
        <p class="caplead">Save any paper from your browser in one click — the PDF and its supplementary files, straight into FluxLib.</p>
        <div class="capcols">
          <section>
            <h4>Firefox</h4>
            <button class="capbtn" onclick={installXpi} disabled={!capInfo?.xpi} title={capInfo?.xpi ? "Opens the Flux add-on; Firefox will ask you to confirm" : "The signed add-on isn't bundled in this build yet"}>Install for Firefox</button>
          </section>
          <section>
            <h4>Chrome, Edge or Brave</h4>
            <ol>
              <li><button class="caplink" onclick={revealExtension} disabled={!capInfo?.hasDir}>Show me the folder</button></li>
              <li>
                <button class="caplink" onclick={() => copyAddr(CHROME_URL)}>{capCopied === CHROME_URL ? "Copied ✓" : "Copy address"}</button>
                <code>{CHROME_URL}</code> — paste it in a new tab
              </li>
              <li>Turn on <strong>Developer mode</strong>, then <strong>Load unpacked</strong> and pick that folder</li>
            </ol>
          </section>
        </div>
        <p class="capstatus" class:ok={!!$captureLastAt}>
          {$captureLastAt ? `✓ Connected — last capture ${sinceLabel($captureLastAt)}` : "Waiting for your first capture…"}
        </p>
        {#if capNote}<p class="capnote">{capNote}</p>{/if}
      </div>
    {/if}
  {:else}
    <!-- World scope: live OpenAlex results -->
    <div class="worldhead">
      <span class="wlabel"
        >{worldBusy && !worldResults.length ? "Searching…" : worldLabel || "Search all of OpenAlex"}</span>
      {#if lookupCtx && lookupCtx.kind !== "author"}
        <div class="seg sub" title="Compare sources — OpenAlex vs Semantic Scholar">
          <button
            class:on={lookupSource === "openalex"}
            onclick={() => lookupCtx && lookup(lookupCtx.kind, lookupCtx.key, lookupCtx.label, "openalex")}
            >OpenAlex</button>
          <button
            class:on={lookupSource === "s2"}
            onclick={() => lookupCtx && lookup(lookupCtx.kind, lookupCtx.key, lookupCtx.label, "s2")}
            >Sem. Scholar</button>
        </div>
      {/if}
      {#if worldResults.length}<span class="wcount">{worldResults.length} results</span>{/if}
    </div>
    <div class="grid">
      <div class="grow ghead">
        <span>Authors</span><span>Title</span><span>Journal</span><span class="gy">Year</span><span
          class="gc">Cited</span><span class="gx"></span>
      </div>
      {#each worldResults as b (b.openalexId)}
        <div class="grow">
          <span class="ga">{b.authors.slice(0, 2).join(", ")}{b.authors.length > 2 ? " et al." : ""}</span>
          <span class="gt" title={b.context || b.tldr || b.abstract || b.title}>
            {#if b.relevanceScore != null}<span class="rel" title="semantic similarity"
                >{b.relevanceScore.toFixed(2)}</span>{/if}
            {#if b.influential}<span class="infl" title="influential citation (Semantic Scholar)">★</span>{/if}
            {b.title}
            {#if b.topic}<span class="topic">{b.topic}</span>{/if}
          </span>
          <span class="gj">{b.container ?? ""}</span>
          <span class="gy">{b.year}</span>
          <span class="gc">{fmtCount(b.citedByCount)}</span>
          <span class="gx">
            {#if addedIds.has(b.openalexId)}
              <span class="copied">✓</span>
            {:else}
              <button class="addbtn" disabled={!b.doi} title={b.doi ? "Add to FluxLib" : "No DOI"}
                onclick={() => addBrief(b)}>+ Add</button>
            {/if}
          </span>
        </div>
      {/each}
      {#if worldLoadMore && worldResults.length}
        <button class="loadmore" onclick={loadMore} disabled={worldBusy}>
          {worldBusy ? "Loading…" : "Load more"}
        </button>
      {/if}
      {#if !worldBusy && worldResults.length === 0}
        <div class="none">{worldError || "Type a query above and press Enter to search all of OpenAlex."}</div>
      {/if}
    </div>
    {#if worldError && worldResults.length}<div class="werr">{worldError}</div>{/if}
  {/if}

  {#if addStatus === "added" || addStatus === "error"}
    <div class="toast" class:err={addStatus === "error"} role="status">
      {addStatus === "added" ? `${addedTitle} ✓` : addError || "Couldn't add that."}
    </div>
  {/if}

  {#if importOpen}
    <ImportDialog onClose={() => (importOpen = false)} onImported={() => void reload()} onEnrich={() => void runEnrich()} />
  {/if}

  {#if zoteroOpen}
    <ZoteroPanel projectRoot={projectRoot} onClose={() => (zoteroOpen = false)} />
  {/if}
</div>

<style>
  .lib {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: var(--c-bg);
  }
  .lhead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--sp-3);
  }
  .ltitle {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
  }
  .h {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--ts-lg, 20px);
    color: var(--c-tx-hi);
  }
  .count {
    font-size: var(--ts-sm);
    color: var(--c-tx-muted);
  }
  .hactions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .enrich {
    flex: 0 0 auto;
    padding: 6px 12px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-pill);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    font: inherit;
    font-size: var(--ts-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .enrich:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .enrich:disabled {
    opacity: 0.7;
    cursor: default;
  }
  /* "Get PDFs" — a secondary pill next to the primary Enrich pill. */
  .getpdfs {
    border-color: var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
  }
  .getpdfs:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
    border-color: var(--c-accent);
  }
  .getpdfs.busy {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  /* "⚠ N failed" pill — muted warning tone; toggles the failed-only filter. */
  .retryfailed {
    border-color: var(--c-danger);
    background: transparent;
    color: var(--c-danger);
  }
  .retryfailed:hover:not(:disabled),
  .retryfailed.on {
    background: var(--c-danger);
    color: var(--c-on-accent);
  }
  /* PDF-presence filter — a neutral pill (it narrows the view, it doesn't warn). */
  .pdffilter {
    border-color: var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
  }
  .pdffilter:hover:not(:disabled),
  .pdffilter.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .gear {
    flex: 0 0 auto;
    width: 32px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
    font-size: var(--ts-md);
  }
  .gear:hover,
  .gear.on {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .keyspanel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    background: var(--c-surface);
  }
  .krow {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .klbl {
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
  }
  .ksub {
    color: var(--c-tx-faint);
    margin-left: 6px;
  }
  .krow input {
    padding: 6px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
    outline: none;
  }
  .krow input:focus {
    border-color: var(--c-accent);
  }
  .kfoot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 2px;
  }
  .khint {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .kfoot button {
    padding: 5px 14px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
    background: var(--c-accent);
    color: var(--c-on-accent);
    font: inherit;
    font-size: var(--ts-sm);
    font-weight: 600;
    cursor: pointer;
  }
  .adddoi {
    display: flex;
    gap: 5px;
    width: min(340px, 40vw);
  }
  .adddoi input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
    outline: none;
  }
  .adddoi.failed input {
    border-color: var(--c-danger);
  }
  .adddoi input:focus {
    border-color: var(--c-accent);
  }
  .adddoi button {
    flex: 0 0 auto;
    width: 30px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
    font-size: var(--ts-md);
  }
  .adddoi button:hover:not(:disabled) {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .scopebar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .seg {
    display: inline-flex;
    flex: 0 0 auto;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    overflow: hidden;
  }
  .seg button {
    border: none;
    background: var(--c-bg);
    color: var(--c-tx-muted);
    padding: 7px 12px;
    font: inherit;
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  .seg.sub button {
    padding: 7px 10px;
    font-size: var(--ts-xs);
  }
  .seg button.on {
    background: var(--c-accent);
    color: var(--c-on-accent);
    font-weight: 600;
  }
  .search {
    flex: 1 1 auto;
    min-width: 0;
    box-sizing: border-box;
    padding: 8px 11px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font-family: var(--font-mono);
    font-size: var(--ts-sm);
    outline: none;
  }
  .search:focus {
    border-color: var(--c-accent);
  }
  .sort {
    flex: 0 0 auto;
    padding: 7px 8px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm);
  }
  .grid {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    outline: none;
  }
  .grid:focus-within {
    border-color: var(--c-accent);
  }
  .gspacer {
    /* WS-8.2 window spacers — pure height, no other layout participation */
    flex: none;
  }
  .grow {
    display: grid;
    grid-template-columns: 1.2fr 2.2fr 1fr 0.5fr 0.55fr 64px;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--c-line);
    font-size: var(--ts-sm);
    cursor: pointer;
    /* Skip layout/paint for off-screen rows — the library can have 1000s of entries.
       contain-intrinsic-size reserves the collapsed row height so the scrollbar is
       correct; `auto` remembers each row's real size once it has been rendered. */
    content-visibility: auto;
    contain-intrinsic-size: auto 37px;
  }
  .ghead {
    position: sticky;
    top: 0;
    background: var(--c-surface);
    color: var(--c-tx-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    cursor: default;
    z-index: 1;
    content-visibility: visible; /* header is always on-screen */
  }
  /* Sortable column headers — plain-text buttons that inherit the .ghead look. */
  .hcol {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }
  .hcol:hover {
    color: var(--c-tx-hi);
  }
  .hcol.gy,
  .hcol.gc {
    text-align: right;
  }
  .sarr {
    margin-left: 3px;
    font-size: 8px;
    color: var(--c-accent);
  }
  .grow.hl {
    background: var(--c-accent-tint-2);
  }
  .grow:hover:not(.ghead) {
    background: var(--c-accent-tint-2);
  }
  /* LR-U2: the library grid gains a leading checkbox column (the World grid keeps the base 6). */
  .grow.selectable {
    grid-template-columns: 26px 1.2fr 2.2fr 1fr 0.5fr 0.55fr 64px;
  }
  .grow.sel {
    background: color-mix(in srgb, var(--c-accent) 12%, transparent);
  }
  .gsel {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .gsel input {
    cursor: pointer;
    margin: 0;
  }
  /* Bulk-selection action bar (shown while ≥1 row is selected). */
  .selbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
    background: color-mix(in srgb, var(--c-accent) 8%, transparent);
    margin-bottom: 8px;
    font-size: var(--ts-sm);
  }
  .selcount {
    font-weight: 600;
    color: var(--c-tx);
  }
  .selact {
    padding: 4px 12px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
    background: var(--c-accent);
    color: var(--c-bg);
    cursor: pointer;
  }
  .selact:disabled {
    opacity: 0.5;
    cursor: default;
    background: none;
    color: var(--c-tx-faint);
  }
  .selclear {
    margin-left: auto;
    padding: 4px 12px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: none;
    color: var(--c-tx-2);
    cursor: pointer;
  }
  /* Bulk fetch-PDFs for the checked rows (Alt+F). */
  .selfetch {
    padding: 4px 12px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
    background: none;
    color: var(--c-accent);
    cursor: pointer;
  }
  .selfetch:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .selfetch:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Bulk delete of the checked rows (Alt+Del) — danger tone, Undo via toast. */
  .seldel {
    padding: 4px 12px;
    border: 1px solid var(--c-danger);
    border-radius: var(--r-1);
    background: none;
    color: var(--c-danger);
    cursor: pointer;
  }
  .seldel:hover:not(:disabled) {
    background: var(--c-danger);
    color: var(--c-on-accent);
  }
  .seldel:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ga {
    color: var(--c-tx);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gt {
    color: var(--c-tx-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .rel {
    flex: 0 0 auto;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--c-accent);
    border: 1px solid var(--c-accent);
    border-radius: var(--r-pill);
    padding: 0 5px;
  }
  .infl {
    flex: 0 0 auto;
    font-size: 11px;
    color: #d4a017;
  }
  .topic {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--c-accent);
    background: var(--c-accent-tint);
    border-radius: var(--r-pill);
    padding: 1px 7px;
    white-space: nowrap;
  }
  /* 3.3 library organization */
  .rtag {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--c-tx-muted);
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-pill);
    padding: 0 7px;
    white-space: nowrap;
  }
  .statusdot {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0 3px;
    color: var(--c-tx-faint);
  }
  .statusdot.s-reading {
    color: var(--c-accent);
  }
  .statusdot.s-read {
    color: var(--c-success);
  }
  .facets {
    margin-bottom: 8px;
    font-size: var(--ts-sm);
  }
  .facettoggle {
    border: none;
    background: none;
    color: var(--c-tx-muted);
    cursor: pointer;
    font-size: var(--ts-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 0;
  }
  .facetgroups {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 0 2px;
  }
  .facetgroup {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
  }
  .facetlbl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-tx-faint);
    min-width: 66px;
  }
  .facet {
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-pill);
    padding: 1px 9px;
    cursor: pointer;
    text-transform: capitalize;
  }
  .facet:hover {
    border-color: var(--c-accent);
  }
  .facet.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-bg);
  }
  .facet.coll {
    text-transform: none;
    border-style: dashed;
  }
  .bulktag {
    width: 120px;
    padding: 3px 8px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font-size: var(--ts-sm);
  }
  .chip.tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--c-tx-2);
    border-style: solid;
  }
  .tagx {
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    padding: 0;
    font-size: 12px;
    line-height: 1;
  }
  .tagx:hover {
    color: var(--c-danger, #c0392b);
  }
  .taginput {
    width: 70px;
    padding: 1px 7px;
    border: 1px dashed var(--c-line);
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--c-tx);
    font-size: var(--ts-xs);
  }
  .gj {
    color: var(--c-tx-muted);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gy {
    color: var(--c-tx-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .gc {
    color: var(--c-tx-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .gx {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
  }
  .ico {
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 2px 3px;
    border-radius: var(--r-1);
  }
  .ico:hover {
    color: var(--c-accent-bright);
  }
  .ico:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ico.haspdf {
    color: var(--c-accent);
  }
  .ico.haspdf:hover {
    color: var(--c-accent-bright);
  }
  /* LR-7: durable per-row fetch-outcome pill (no DOI / no OA / failed). */
  .fpill {
    border: 1px solid;
    background: none;
    cursor: pointer;
    font-size: var(--ts-xs);
    line-height: 1;
    padding: 2px 6px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .fpill.t-danger {
    color: var(--c-danger);
    border-color: color-mix(in srgb, var(--c-danger) 45%, transparent);
    background: color-mix(in srgb, var(--c-danger) 8%, transparent);
  }
  .fpill.t-muted {
    color: var(--c-tx-faint);
    border-color: var(--c-line-strong);
  }
  .fpill:hover {
    filter: brightness(1.15);
  }
  /* Failure diagnostic banner inside an expanded failed row. */
  .failbanner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0 0 10px;
    padding: 7px 10px;
    border: 1px solid var(--c-danger);
    border-radius: var(--r-1);
    background: color-mix(in srgb, var(--c-danger) 8%, transparent);
    font-size: var(--ts-xs);
  }
  .fbtag {
    font-weight: 700;
    color: var(--c-danger);
  }
  .fbwhy {
    color: var(--c-tx-2);
    font-family: var(--font-mono, monospace);
  }
  .fbdetail {
    color: var(--c-tx-3);
    flex: 1 1 100%;
  }
  .fbretry,
  .fbclear {
    margin-left: auto;
    padding: 3px 9px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    background: var(--c-surface);
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .fbclear {
    margin-left: 0;
  }
  .fbretry:hover,
  .fbclear:hover {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .copied {
    color: var(--c-accent-bright);
    font-size: var(--ts-xs);
  }
  /* 2.3 Full-text search: status bar + per-row snippet strip. */
  .ftbar {
    display: flex;
    align-items: baseline;
    gap: 9px;
    padding: 6px 12px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
    background: color-mix(in srgb, var(--c-accent) 8%, transparent);
    margin-bottom: 8px;
    font-size: var(--ts-sm);
  }
  .ftbar.err {
    border-color: var(--c-danger, #c0392b);
    background: color-mix(in srgb, var(--c-danger, #c0392b) 8%, transparent);
  }
  .ftbar .ftlbl {
    font-weight: 600;
    color: var(--c-tx);
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.05em;
  }
  .ftbar .ftmeta {
    color: var(--c-tx-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ftsnips {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 14px 8px 40px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-surface);
  }
  .ftsnip {
    display: flex;
    align-items: baseline;
    gap: 8px;
    text-align: left;
    width: 100%;
    padding: 3px 8px;
    border: none;
    border-left: 2px solid transparent;
    border-radius: var(--r-1);
    background: none;
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    line-height: 1.5;
    cursor: pointer;
  }
  .ftsnip:hover {
    background: var(--c-bg);
    border-left-color: var(--c-accent);
  }
  .ftsnip .ftpage {
    flex: none;
    font-variant-numeric: tabular-nums;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    min-width: 2.4em;
  }
  .ftsnip .fttext {
    color: var(--c-tx-2);
  }
  .ftmore {
    padding: 1px 8px 0 10px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .detail {
    padding: 10px 14px 12px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-surface);
    cursor: default;
  }
  .dabs {
    margin: 0 0 8px;
    font-size: var(--ts-sm);
    line-height: 1.5;
    color: var(--c-tx-2);
    max-height: 8.4em;
    overflow: auto;
  }
  .dabs.muted {
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .dchips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    margin-bottom: 7px;
  }
  .clbl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-tx-faint);
    margin-right: 2px;
  }
  .chip {
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-pill);
    padding: 1px 9px;
  }
  .chip.kw {
    color: var(--c-tx-muted);
    border-style: dashed;
  }
  .dbtns {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .dbtns button {
    border: 1px solid var(--c-line-strong);
    background: var(--c-bg);
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 4px 10px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .dbtns button:hover:not(:disabled) {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .dbtns button.prim {
    border-color: var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    font-weight: 600;
  }
  .dbtns button.prim:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .dbtns button.proxy:hover:not(:disabled) {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .proxyrow {
    align-items: center;
  }
  .proxybtns {
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }
  .proxybtn {
    flex: 0 0 auto;
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 4px 10px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .proxybtn.on {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .proxybtn:hover:not(:disabled) {
    border-color: var(--c-accent);
  }
  .dbtns button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .dcite {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .none {
    padding: var(--sp-5);
    text-align: center;
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
  }
  .none.err {
    color: var(--c-danger);
    font-style: normal;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
  }
  .none .submuted {
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    font-family: var(--font-mono);
    max-width: 80%;
    word-break: break-word;
  }
  .none .retry {
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 6px;
    padding: 5px 14px;
    cursor: pointer;
    font: inherit;
    font-size: var(--ts-sm);
  }
  .none .retry:hover {
    background: var(--c-ui-hover);
  }
  .loadmore {
    display: block;
    width: 100%;
    padding: 9px;
    border: none;
    border-top: 1px solid var(--c-line);
    background: var(--c-surface);
    color: var(--c-accent);
    font: inherit;
    font-size: var(--ts-sm);
    font-weight: 600;
    cursor: pointer;
  }
  .loadmore:hover:not(:disabled) {
    background: var(--c-accent-tint);
  }
  .loadmore:disabled {
    color: var(--c-tx-faint);
    cursor: default;
  }
  .worldhead {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
  }
  .wlabel {
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
  }
  .wcount {
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
  }
  .werr {
    font-size: var(--ts-xs);
    color: var(--c-danger);
    padding: 2px 4px;
  }
  .addbtn {
    border: 1px solid var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    border-radius: var(--r-pill);
    padding: 2px 9px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .addbtn:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .addbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .webcap {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-wrap: wrap;
  }
  .lbl {
    font-size: var(--ts-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-tx-muted);
  }
  /* Web-capture onboarding: a live status the user can trust, plus the two affordances a
     browser actually permits (open the folder, open the add-on file). */
  .capdot {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: none;
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    cursor: pointer;
    padding: 0;
  }
  .capdot .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1px solid var(--c-line-strong);
    background: transparent;
  }
  .capdot.on .dot {
    background: var(--c-accent);
    border-color: var(--c-accent);
  }
  .capdot.on {
    color: var(--c-tx);
  }
  .capsetup {
    border-top: 1px solid var(--c-line);
    padding: var(--sp-3) var(--sp-4) var(--sp-4);
    background: var(--c-surface-2, var(--c-surface));
  }
  .caplead {
    margin: 0 0 var(--sp-3);
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
  }
  .capcols {
    display: flex;
    gap: var(--sp-5);
    flex-wrap: wrap;
  }
  .capcols section {
    min-width: 220px;
    flex: 1 1 220px;
  }
  .capcols h4 {
    margin: 0 0 var(--sp-2);
    font-size: var(--ts-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-tx-faint);
  }
  .capcols ol {
    margin: 0;
    padding-left: 1.1rem;
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
  }
  .capcols li {
    margin: 4px 0;
  }
  .capbtn {
    padding: 5px 14px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-pill);
    background: var(--c-accent);
    color: var(--c-on-accent);
    font-size: var(--ts-sm);
    font-weight: 600;
    cursor: pointer;
  }
  .capbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .caplink {
    border: 0;
    background: none;
    padding: 0;
    color: var(--c-accent);
    font-size: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .caplink:disabled {
    color: var(--c-tx-faint);
    text-decoration: none;
    cursor: default;
  }
  .capstatus {
    margin: var(--sp-3) 0 0;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .capstatus.ok {
    color: var(--c-accent);
  }
  .capnote {
    margin: 4px 0 0;
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
  }
  .bminstall {
    padding: 4px 12px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-pill);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    font-size: var(--ts-sm);
    font-weight: 600;
    cursor: pointer;
  }
  .bminstall:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .bminstall:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .hint {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .toast {
    position: absolute;
    left: 50%;
    bottom: var(--sp-5);
    transform: translateX(-50%);
    padding: 8px 16px;
    border-radius: var(--r-pill);
    background: var(--c-surface);
    border: 1px solid var(--c-accent-bright);
    color: var(--c-tx);
    font-size: var(--ts-sm);
    box-shadow: var(--elev-2);
    max-width: 80%;
    /* Wrap up to a few lines so an actionable error tail isn't clipped (P10). */
    white-space: normal;
    overflow-wrap: anywhere;
    text-align: center;
    line-height: 1.35;
  }
  .toast.err {
    border-color: var(--c-danger);
  }
</style>
