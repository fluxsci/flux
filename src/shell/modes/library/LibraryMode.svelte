<script lang="ts">
  // The Library mode — a full-window, searchable table over the WHOLE machine-global
  // FluxLib, showing OpenAlex enrichment (abstract, topics, keywords, citation count),
  // plus a "World" scope that searches ALL of OpenAlex — by keyword OR by meaning
  // (semantic) — with one-click add + per-entry citing / similar / author lookups.
  import { onMount } from "svelte";
  import { runQuery } from "../../../lib/references/query";
  import type { RefEntry } from "../../../lib/references/types";
  import { mergeEnrich, type EnrichMap, type EnrichedEntry } from "../../../lib/references/enrich";
  import { loadFluxLib, ensureFluxLib, loadEnrichMap } from "../../../lib/references/fluxlibBridge";
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
  import { fluxLibRevision } from "../../../lib/references/revision";
  import { addUrlOrDoiToLibrary } from "../paper/scholar/bibLoad";
  import { fileBridge } from "../../../lib/project/types";
  import { BOOKMARKLET_HREF } from "./bookmarklet";
  import { openInReader } from "../reader/readerStore";
  import { fetchPdfForEntry, fetchViaProxyForEntry } from "../../../lib/references/pdfFinderBridge";
  import { listPdfKeys, ingestPdfFile, listFailedKeys, readFetchFailure, clearFetchFailure } from "../../../lib/references/itemsBridge";
  import { pdfFetchJob } from "../../../lib/references/pdfFetchJob.svelte";
  import { safeKey, type FetchFailure } from "../../../lib/references/items";

  let { focused = true }: { focused?: boolean } = $props();

  // $state.raw (not deep-reactive): these are replaced wholesale on reload, never mutated
  // in place. The enrich graph is ~12 MB / 140k+ nested IDs — deep-proxying it on every
  // load is what made the Library crawl. .raw keeps them plain objects.
  let entries = $state.raw<RefEntry[]>([]);
  let enrichMap = $state.raw<EnrichMap>({});
  let loading = $state(true);
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
  let bmCopied = $state(false); // bookmarklet copied-to-clipboard feedback

  // Enrich (hydration) state.
  let enriching = $state(false);
  let enrichProg = $state("");

  // PDF acquisition (FluxFinder) — which keys have a PDF on disk + fetch progress.
  let pdfKeys = $state.raw<Set<string>>(new Set());
  let fetchingKey = $state(""); // citekey currently fetching (per-row)
  // The bulk "Get all PDFs" run lives in a module-level job (pdfFetchJob) so it survives
  // navigating away from Library; these mirror it for this view's button/row states.
  const fetchingAll = $derived(pdfFetchJob.running);
  // Keys with a recorded both-routes fetch failure (Part C) — drives the ⚠ chip + filter +
  // the "failed N" count. Refreshed on reload and after a bulk run.
  let failedKeys = $state.raw<Set<string>>(new Set());
  let failureInfo = $state<Record<string, FetchFailure>>({}); // lazily loaded per expanded row
  let showFailedOnly = $state(false);

  // API keys panel — stored in ~/FluxLib/keys.json (machine-global, every project).
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

  const enriched = $derived(mergeEnrich(entries, enrichMap) as EnrichedEntry[]);
  // LR-4: precompute each entry's PDF-dir key (safeKey → 3 regexes + trim, then a Unicode
  // NFC normalize) ONCE per load. hasPdf()/isFailed() run 4–6× per row per render across
  // every result row plus the coverage stats; without this they re-ran the whole regex+
  // normalize chain each time, which dominated re-renders on a multi-thousand-item library.
  const nfcOf = $derived(new Map(entries.map((e) => [e.key, safeKey(e.key).normalize("NFC")])));
  const nfc = (key: string) => nfcOf.get(key) ?? safeKey(key).normalize("NFC");
  // Debounce the query: runQuery scans every entry's title+abstract (multi-MB over 1710
  // entries), so running it on each keystroke janks. Recompute ~150ms after typing stops.
  let queryDebounced = $state("");
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
  const isFailed = (key: string) => failedKeys.has(nfc(key));
  const results = $derived(
    showFailedOnly
      ? runQuery(enriched, queryDebounced).filter((r) => isFailed(r.key))
      : runQuery(enriched, queryDebounced),
  );
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
    [entries, enrichMap, pdfKeys, failedKeys] = await Promise.all([
      loadFluxLib(),
      loadEnrichMap(),
      listPdfKeys(),
      listFailedKeys(),
    ]);
    loading = false;
  }
  onMount(() => {
    void ensureFluxLib()
      .then(reload)
      .catch(() => (loading = false));
    void refreshProxy();
    let first = true;
    return fluxLibRevision.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      void reload();
    });
  });

  $effect(() => {
    if (highlighted > results.length - 1) highlighted = Math.max(0, results.length - 1);
  });

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
    await fileBridge()?.proxyClearCredentials?.();
    proxyUser = "";
    proxyPass = "";
    credHasPass = false;
  }
  async function saveKeysPanel() {
    await fileBridge()?.keysSet?.({
      openAlexKey: keyOpenAlex.trim(),
      s2Key: keyS2.trim(),
      mailto: keyMailto.trim(),
      ezproxyPrefix: keyEzproxy.trim(),
    });
    keysSaved = true;
    setTimeout(() => (keysSaved = false), 2000);
    void refreshProxy();
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
      const r = await fetchViaProxyForEntry(entry, enrichMap[entry.key]);
      if (r.status === "got") {
        pdfKeys = await listPdfKeys();
        await dropFailure(entry.key); // success clears any prior failure record + ⚠
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
    const next = new Set(failedKeys);
    next.delete(nfc(key));
    failedKeys = next;
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
            ? "No open-access PDF found (library proxy support is coming)."
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
    if (fetchingKey || loading || !entries.length) return;
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
    const sum = await pdfFetchJob.start(
      entries,
      enrichMap,
      { proxyConfigured, proxySignedIn },
      { retryFailed, onTick },
    );
    if (tickTimer) clearTimeout(tickTimer);
    tickBuf = [];
    pdfKeys = await listPdfKeys();
    failedKeys = await listFailedKeys();
    if (!sum) return;
    if (sum.cancelled) {
      addStatus = "added";
      addedTitle = `Stopped · ${sum.oaGot + sum.proxyGot} fetched so far`;
    } else {
      const parts = [`${sum.oaGot} open-access`];
      if (sum.proxyGot || proxySignedIn) parts.push(`${sum.proxyGot} via library`);
      addStatus = "added";
      addedTitle =
        `Fetched ${sum.oaGot + sum.proxyGot} (${parts.join(" · ")})` +
        (sum.failedNew ? ` · ${sum.failedNew} failed` : "") +
        (sum.needSignIn ? ` · ${sum.needSignIn} need library sign-in` : "") +
        (sum.errors ? ` · ${sum.errors} error` : "");
    }
    setTimeout(() => {
      if (addStatus === "added") addStatus = "";
    }, 5200);
  }

  async function submitAdd() {
    const v = addValue.trim();
    if (!v || addStatus === "fetching") return;
    addError = "";
    addStatus = "fetching";
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
  function toggleExpand(e: MouseEvent, key: string) {
    e.stopPropagation();
    expanded = expanded === key ? "" : key;
    // Lazily load the failure record for the diagnostic banner when a failed row opens.
    if (expanded === key && isFailed(key) && !failureInfo[key]) {
      void readFetchFailure(key).then((f) => {
        if (f) failureInfo = { ...failureInfo, [key]: f };
      });
    }
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

  function onWinKey(e: KeyboardEvent) {
    if (!focused) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      addEl?.focus();
      addEl?.select();
    }
  }
  function gridKey(e: KeyboardEvent) {
    if (scope !== "library") return;
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
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
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

  function bookmarkletLink(node: HTMLAnchorElement) {
    node.href = BOOKMARKLET_HREF;
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
        class:busy={fetchingAll}
        onclick={() => getAllPdfs(false)}
        disabled={(fetchingKey !== "" && !fetchingAll) || loading || coverage.total === 0}
        title={fetchingAll
          ? "Click to stop the running fetch"
          : "Find & download PDFs for your whole library: open-access first, then your library proxy for the rest. Runs in the background — keep working."}>
        {#if fetchingAll}
          {pdfFetchJob.phase === "proxy" ? "Library" : "OA"} {pdfFetchJob.done}/{pdfFetchJob.total} ✕
        {:else if pdfCoverage.have === 0}
          Get PDFs
        {:else if pdfCoverage.have < pdfCoverage.total}
          PDFs {pdfCoverage.have}/{pdfCoverage.total}
        {:else}
          PDFs ✓
        {/if}
      </button>
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
        <span class="khint">Stored in ~/FluxLib/keys.json · used across every project · keyless still works</span>
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
        ? "Search your library  ·  author:smith  abstract:dopamine  topic:reward"
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
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
    <div class="grid" tabindex="0" bind:this={gridEl} onkeydown={gridKey}>
      <div class="grow ghead">
        <span>Authors</span><span>Title</span><span>Journal</span><span class="gy">Year</span><span
          class="gc">Cited</span><span class="gx"></span>
      </div>
      {#each results as r, i (r.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="grow"
          class:hl={i === highlighted}
          title={`Click to copy @${r.key}`}
          onclick={() => {
            highlighted = i;
            void copyKey(r.key);
          }}>
          <span class="ga">{r.authors.slice(0, 2).join(", ")}{r.authors.length > 2 ? " et al." : ""}</span>
          <span class="gt" title={r.enrich?.abstract || r.title}>
            {r.title}
            {#if r.enrich?.primaryTopic?.name}<span class="topic">{r.enrich.primaryTopic.name}</span>{/if}
          </span>
          <span class="gj">{r.container ?? ""}</span>
          <span class="gy">{r.year}</span>
          <span class="gc">{fmtCount(r.enrich?.citedByCount)}</span>
          <span class="gx">
            {#if copied === r.key}
              <span class="copied">✓</span>
            {:else}
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
              {#if !hasPdf(r.key) && isFailed(r.key)}
                <button
                  class="ico failchip"
                  title="Fetch failed both open-access and library routes — click for details"
                  aria-label="Fetch failed"
                  onclick={(e) => toggleExpand(e, r.key)}>⚠</button>
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
        {#if expanded === r.key}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="detail" onclick={(e) => e.stopPropagation()}>
            {#if !hasPdf(r.key) && isFailed(r.key)}
              <div class="failbanner">
                <span class="fbtag">⚠ PDF fetch failed</span>
                {#if failureInfo[r.key]}
                  {@const f = failureInfo[r.key]}
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
            <div class="dbtns">
              {#if hasPdf(r.key)}
                <button class="prim" onclick={(e) => readPaper(e, r.key)}>Read PDF →</button>
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
      {#if !loading && results.length === 0}
        <div class="none">
          {entries.length ? "No matches." : "Your FluxLib is empty — paste a DOI or URL above."}
        </div>
      {/if}
    </div>

    <footer class="webcap">
      <span class="lbl">Add from the web</span>
      <!-- svelte-ignore a11y_invalid_attribute -->
      <a
        class="bm"
        href="#"
        use:bookmarkletLink
        draggable="true"
        ondragstart={(e) => {
          // Populate the drag explicitly so a drop on the (cross-app) bookmarks bar
          // receives the javascript: URL — Electron→browser drags otherwise carry nothing.
          e.dataTransfer?.setData("text/uri-list", BOOKMARKLET_HREF);
          e.dataTransfer?.setData("text/plain", BOOKMARKLET_HREF);
        }}
        onclick={async (e) => {
          e.preventDefault();
          try {
            await navigator.clipboard.writeText(BOOKMARKLET_HREF);
            bmCopied = true;
            setTimeout(() => (bmCopied = false), 2600);
          } catch {
            /* clipboard blocked */
          }
        }}
        title="Drag to your bookmarks bar, or click to copy">Add to FluxLib</a>
      <span class="hint"
        >{bmCopied
          ? "Copied ✓ — make a new bookmark, then paste this as its URL"
          : "drag to your bookmarks bar (or click to copy), then click it on any paper page"}</span>
    </footer>
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
  .grow.hl {
    background: var(--c-accent-tint-2);
  }
  .grow:hover:not(.ghead) {
    background: var(--c-accent-tint-2);
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
  .ico.failchip {
    color: var(--c-danger);
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
  .bm {
    display: inline-block;
    padding: 4px 12px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-pill);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    font-size: var(--ts-sm);
    font-weight: 600;
    text-decoration: none;
    cursor: grab;
    user-select: none;
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .toast.err {
    border-color: var(--c-danger);
  }
</style>
