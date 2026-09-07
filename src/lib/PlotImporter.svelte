<script lang="ts" context="module">
  /** One picked plot, handed to `onPick` hosts in insertion (= placement) order. */
  export interface PlotPick {
    abs: string;
    rel: string;
    semantic: boolean;
  }
</script>

<script lang="ts">
  // Plot gallery (Alt+I): a windowed contact sheet over the project's plots/ dir.
  // Search by name/path, or browse folder-by-folder, in a dialog or a native utility.
  // Multi-select: Enter (or Space with an empty search box, or a click) TOGGLES
  // a plot into the picked set (✓); Ctrl/Cmd+Enter inserts everything picked —
  // or just the highlighted plot when nothing is picked. The picked set survives
  // folder navigation and browse↔search, so cross-folder picking is the point.
  //
  // Reserved folders (plots/_dissections, plots/_lighttable — shared rule, see
  // project/plotsFolders) are companion material, not plots to compose: they are
  // absent from browse rows and from the search cache, so a plain search can never
  // surface a per-subject panel or one of ten thousand sweep images. Hidden is not
  // unreachable — typing "_" offers them as enterable rows, and entering one
  // RE-SCOPES the search cache to that folder, so from then on you are searching
  // inside it and nowhere else. Leaving restores the ordinary plots/ scope.
  import { onDestroy, tick } from "svelte";
  import { get } from "svelte/store";
  import GalleryPreview from "./plot/GalleryPreview.svelte";
  import { createGalleryPreviews } from "./plot/galleryPreviews";
  import { openGalleryWindow } from "./plot/galleryWindow";
  import { importerOpen, importerDetached, embeddedProjectRoot, projectDir, activeFigureId, project } from "./store";
  import { fileBridge, joinPath } from "./project/types";
  import { importPlotsFromPaths } from "./io";
  import { pushToast, errMsg } from "./toast";
  import {
    RESERVED_PLOT_FOLDERS,
    isReservedPlotDirName,
    reservedRootOfPlotsRel,
    type ReservedPlotFolder,
  } from "./project/plotsFolders";

  // Reuse beyond Figure mode: when `onPick` is provided (e.g. Slide mode), the
  // chosen plots are handed to it as an ARRAY of picks (abs path + project-relative
  // `rel` under plots/ + whether each is semantic) instead of being imported into
  // the active figure. Single-plot inserts arrive as a one-element array. `title`
  // lets a host relabel the header. Defaults preserve figure-import behavior.
  export let onPick: ((picks: PlotPick[]) => void | Promise<void>) | undefined = undefined;
  export let title = "Plot gallery";
  export let active = true;
  // Host can pin the project root (Slide mode passes its own pm.root so the
  // browsed plots/ matches the path its loadDeckAssets reads). Falls back to the
  // global figure-mode stores.
  export let rootOverride = "";

  interface PlotRec {
    abs: string;
    rel: string;
    name: string;
    semantic: boolean;
    /** A paper snip: a PNG with an `X.snip.json` provenance sidecar. */
    snip?: boolean;
  }
  interface Row {
    kind: "up" | "dir" | "file";
    name: string;
    abs?: string;
    rel?: string;
    semantic?: boolean;
    snip?: boolean;
    /** A reserved-folder row, surfaced by typing "_" (carries its own abs — it is
     *  always a child of plots/, never of the folder currently being browsed). */
    hint?: string;
  }

  $: root = rootOverride || $embeddedProjectRoot || $projectDir || "";
  $: plotsRoot = root ? joinPath(root, "plots") : "";

  let wrapEl: HTMLDivElement;
  let popup: ReturnType<typeof openGalleryWindow> | undefined;
  let detached = false;
  let status = "";
  let error = "";
  let previews = createGalleryPreviews();
  let previewRevision = 0;
  let viewMode: "gallery" | "list" = "gallery";
  let previewSize = 200;
  let spacing = 16;
  let labels = true;
  try {
    const saved = JSON.parse(localStorage.getItem("flux-plot-gallery") ?? "{}");
    if (saved.view === "list") viewMode = "list";
    if (Number.isFinite(saved.size)) previewSize = Math.max(120, Math.min(360, saved.size));
    if (Number.isFinite(saved.spacing)) spacing = Math.max(4, Math.min(32, saved.spacing));
    if (typeof saved.labels === "boolean") labels = saved.labels;
  } catch { /* Invalid preferences fall back to the gallery defaults. */ }
  function rememberView() {
    try { localStorage.setItem("flux-plot-gallery", JSON.stringify({ view: viewMode, size: previewSize, spacing, labels })); } catch {}
  }
  function focusInput() { void tick().then(() => inputEl?.focus()); }
  function pin() {
    try {
      popup = openGalleryWindow(wrapEl, close, () => reconnectListSize());
      detached = true;
      importerDetached.set(true);
    } catch (e) { error = errMsg(e); }
  }
  function dock() {
    popup?.close(); popup = undefined;
    detached = false; importerDetached.set(false);
    focusInput();
  }
  function resetPreviews() {
    previews.dispose(); previews = createGalleryPreviews(); previewRevision++;
  }
  function teardown() {
    popup?.close(); popup = undefined;
    detached = false; importerDetached.set(false);
    dirGeneration++; scanGeneration++;
    resetPreviews();
  }
  onDestroy(() => {
    teardown(); previews.dispose();
    if (get(importerOpen)) importerOpen.set(false);
  });
  $: destination = $project.figures.find(f => f.id === $activeFigureId);
  $: canInsert = active && !!destination;
  $: destinationName = destination?.nickname || destination?.name || "a figure";
  let listWidth = 800, listHeight = 400, scrollTop = 0;
  let reconnectListSize = () => {};
  function trackListSize(node: HTMLDivElement) {
    let observer: ResizeObserver;
    const measure = () => { listWidth = node.clientWidth; listHeight = node.clientHeight; };
    reconnectListSize = () => {
      observer?.disconnect();
      // Resize delivery follows the observer's window. The opener may be hidden
      // while this same mounted list lives in the pinned gallery (and vice versa).
      const ownerWindow = node.ownerDocument.defaultView as Window & typeof globalThis;
      observer = new ownerWindow.ResizeObserver(measure);
      observer.observe(node);
      measure();
    };
    reconnectListSize();
    return { destroy() { observer.disconnect(); reconnectListSize = () => {}; } };
  }
  $: columns = viewMode === "gallery" ? Math.max(1, Math.floor((listWidth - 32 + spacing) / (previewSize + spacing))) : 1;
  $: cellHeight = viewMode === "gallery" ? Math.round(previewSize * .72) + (labels ? 54 : 18) : 44;
  $: gap = viewMode === "gallery" ? spacing : 4;
  $: stride = cellHeight + gap;
  $: start = Math.max(0, Math.min(Math.ceil(rows.length / columns) - 1, Math.floor(scrollTop / stride) - 2)) * columns;
  $: end = Math.min(rows.length, start + (Math.ceil(listHeight / stride) + 5) * columns);
  $: shown = rows.slice(start, end);
  $: fileCount = rows.filter(r => r.kind === "file").length;
  function resetScroll() { scrollTop = 0; if (listEl) listEl.scrollTop = 0; }
  $: { search; viewMode; previewSize; spacing; labels; resetScroll(); }

  let openedRoot = "";
  $: if ($importerOpen && openedRoot && root !== openedRoot) close();
  let cwd = "";
  let entries: { name: string; dir: boolean }[] = [];
  let all: PlotRec[] = []; // recursive cache, for search
  let search = "";
  let index = 0;
  let loading = false;
  let scanned = false;
  let truncated = false;
  let listEl: HTMLDivElement;
  let inputEl: HTMLInputElement;
  // The multi-select: keyed by ABSOLUTE path (stable across browse↔search rows and
  // immune to scan caps); insertion order = placement order. `rel` is normalized
  // to the plots/-relative path at toggle time (browse rows carry bare names).
  let picked = new Map<string, PlotPick>();
  $: pickedCount = picked.size;

  // Which reserved folders actually exist directly under plots/ (read from the root
  // listing, so "_" offers only what is really there). Their rows carry an absolute
  // path because search is reachable from any folder, while a reserved folder is
  // always a child of plots/ itself.
  let rootReserved: ReservedPlotFolder[] = [];
  // The plots/-relative root the search cache covers: "" = the whole tree with the
  // reserved folders pruned; a reserved name = that folder alone.
  let scanScope = "";

  let prevOpen = false;
  $: {
    if ($importerOpen && !prevOpen) void open();
    if (!$importerOpen && prevOpen) teardown();
    prevOpen = $importerOpen;
  }
  async function open() {
    openedRoot = root;
    search = "";
    index = 0;
    status = ""; error = "";
    picked = new Map();
    rootReserved = [];
    cwd = plotsRoot;
    await loadDir(cwd);
    if (!get(importerOpen) || root !== openedRoot) return;
    void scanFor(""); // warm the search cache in the background
    focusInput();
  }

  /** The reserved folder a directory sits under, as its bare name ("" = ordinary
   *  content). Derived from the path so it is correct the instant `cwd` changes —
   *  a reactive `$:` would still be a flush behind the `loadDir` that follows. */
  function reservedRootOf(dir: string): string {
    if (!plotsRoot || !dir || !dir.startsWith(plotsRoot)) return "";
    return reservedRootOfPlotsRel(dir.slice(plotsRoot.length).replace(/^\/+/, ""));
  }

  // Sidecars present in the CURRENT folder — kept from the raw listing (entries
  // filters them out), so browse rows can flag semantic plots (.fluxplot.json)
  // and paper snips (.snip.json). Search rows get the same flags from scan().
  let manifestNames = new Set<string>();
  let snipNames = new Set<string>();
  let dirGeneration = 0;
  let scanGeneration = 0;
  async function loadDir(dir: string) {
    const generation = ++dirGeneration;
    const fig = fileBridge();
    if (!fig?.readdir || !dir) {
      entries = [];
      manifestNames = new Set();
      snipNames = new Set();
      return;
    }
    loading = true;
    let es: { name: string; dir: boolean }[];
    try { es = await fig.readdir(dir); }
    catch (e) {
      if (generation === dirGeneration) { error = errMsg(e); entries = []; loading = false; }
      return;
    }
    if (generation !== dirGeneration) return;
    manifestNames = new Set(es.filter((e) => !e.dir && /\.fluxplot\.json$/i.test(e.name)).map((e) => e.name));
    snipNames = new Set(es.filter((e) => !e.dir && /\.snip\.json$/i.test(e.name)).map((e) => e.name));
    // The plots/ root is where the reserved folders live — remember which are present so
    // "_" can offer exactly those.
    if (dir === plotsRoot)
      rootReserved = RESERVED_PLOT_FOLDERS.filter((f) => es.some((e) => e.dir && e.name === f.name));
    // dirs first, then files, each alphabetical; show dirs + .svg plots + .png rasters (snips).
    // Reserved folders (_dissections, _lighttable) are companion material, not plots to
    // insert — they never appear here or in search (shared rule, see project/plotsFolders).
    // INSIDE one, though, everything is listed: getting in is the deliberate act.
    const inReserved = !!reservedRootOf(dir);
    entries = es
      .filter((e) => (e.dir ? inReserved || !isReservedPlotDirName(e.name) : /\.(svg|png)$/i.test(e.name)))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    loading = false;
  }

  // Recursively collect every .svg/.png in the current SCOPE (capped), flagging semantic
  // plots (.fluxplot.json sibling) and paper snips (.snip.json sibling) — no extra IO,
  // read from the dir listing. `scopeRel` is "" for the ordinary plots/ tree (reserved
  // folders pruned at every depth) or a reserved folder name (that subtree, nothing
  // pruned). Paths stay plots/-relative either way, so rows read the same in both scopes.
  async function scanFor(scopeRel: string) {
    const generation = ++scanGeneration;
    scanScope = scopeRel;
    all = [];
    scanned = false;
    truncated = false;
    const fig = fileBridge();
    if (!fig?.readdir || !plotsRoot) {
      scanned = true;
      return;
    }
    const out: PlotRec[] = [];
    const visit = async (dir: string, rel: string, depth: number) => {
      if (generation !== scanGeneration) return;
      if (depth > 20 || out.length >= 20000) {
        truncated = true;
        return;
      }
      const es = await fig.readdir!(dir);
      const names = new Set(es.map((e) => e.name));
      for (const e of es) {
        if (generation !== scanGeneration) return;
        if (out.length >= 20000) { truncated = true; return; }
        const abs = joinPath(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.dir) {
          if (scopeRel || !isReservedPlotDirName(e.name)) await visit(abs, r, depth + 1);
        }
        else if (/\.svg$/i.test(e.name))
          out.push({ abs, rel: r, name: e.name, semantic: names.has(e.name.replace(/\.svg$/i, ".fluxplot.json")) });
        else if (/\.png$/i.test(e.name))
          out.push({ abs, rel: r, name: e.name, semantic: false, snip: names.has(e.name.replace(/\.png$/i, ".snip.json")) });
      }
    };
    try { await visit(scopeRel ? joinPath(plotsRoot, scopeRel) : plotsRoot, scopeRel, 0); }
    catch (e) { if (generation === scanGeneration) error = `Some folders could not be searched: ${errMsg(e)}`; }
    if (generation !== scanGeneration) return; // a newer scope superseded this walk mid-flight
    all = out;
    scanned = true;
  }

  /** Keep the search cache aligned with where we are: entering (or leaving) a reserved
   *  folder is the only thing that changes what a search can reach. */
  function syncScanScope() {
    const want = reservedRootOf(cwd);
    if (want !== scanScope) void scanFor(want);
  }

  $: q = search.trim().toLowerCase();
  // Search mode when typing; otherwise the current-folder browse listing.
  $: rows = ((): Row[] => {
    if (q) {
      const out: Row[] = [];
      // The one way in: a query that STARTS with "_" offers the reserved folders whose
      // names match it ("_" both, "_light" one). Nothing else surfaces them, and once
      // you are inside one the search below is already scoped to it.
      if (!scanScope && q.startsWith("_"))
        for (const f of rootReserved)
          if (f.name.includes(q))
            out.push({ kind: "dir", name: f.name, abs: joinPath(plotsRoot, f.name), hint: f.hint });
      out.push(
        ...all
          .filter((p) => `${p.rel} ${p.name}`.toLowerCase().includes(q))
          .sort((a, b) => rank(a, q) - rank(b, q))
          .map((p): Row => ({ kind: "file", name: p.name, abs: p.abs, rel: p.rel, semantic: p.semantic, snip: p.snip })),
      );
      return out;
    }
    const out: Row[] = [];
    if (cwd && cwd !== plotsRoot) out.push({ kind: "up", name: ".." });
    for (const e of entries) {
      if (e.dir) out.push({ kind: "dir", name: e.name });
      else
        out.push({
          kind: "file",
          name: e.name,
          abs: joinPath(cwd, e.name),
          rel: e.name,
          // entries drops sidecar files, so these checks read the raw listing's
          // sidecar names (a browse row was NEVER semantic before).
          semantic: manifestNames.has(e.name.replace(/\.svg$/i, ".fluxplot.json")),
          snip: /\.png$/i.test(e.name) && snipNames.has(e.name.replace(/\.png$/i, ".snip.json")),
        });
    }
    return out;
  })();
  $: if (index >= rows.length) index = Math.max(0, rows.length - 1);
  $: relDir = cwd && plotsRoot ? cwd.slice(plotsRoot.length).replace(/^\//, "") : "";
  // The search box says what a query would actually reach — scoped searches are the one
  // place the importer is NOT looking at the whole project.
  $: searchHint = !scanned
    ? `Scanning ${scanScope ? `${scanScope}/` : "plots/"}…`
    : scanScope
      ? `Search inside ${scanScope}/…`
      : "Search plots by name…  (or browse below)";

  function rank(p: PlotRec, q: string): number {
    const n = p.name.toLowerCase();
    if (n === q || n === `${q}.svg`) return 0;
    if (n.startsWith(q)) return 1;
    if (p.rel.toLowerCase().includes(`/${q}`)) return 2;
    return 3;
  }

  async function ensureVisible(focusRow = false) {
    if (!listEl) return;
    const targetIndex = index;
    const top = Math.floor(targetIndex / columns) * stride;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (top + cellHeight > listEl.scrollTop + listHeight) listEl.scrollTop = top + cellHeight - listHeight;
    scrollTop = listEl.scrollTop;
    if (focusRow) { await tick(); listEl.querySelector<HTMLButtonElement>(`[data-i="${targetIndex}"]`)?.focus(); }
  }
  async function refresh() {
    error = ""; status = ""; resetPreviews();
    await loadDir(cwd);
    void scanFor(reservedRootOf(cwd));
  }
  async function goRoot() {
    cwd = plotsRoot; search = ""; index = 0; resetScroll();
    await loadDir(cwd); syncScanScope(); focusInput();
  }

  // A row's stable project-relative path under plots/ (consistent across search
  // vs. browse rows, where r.rel differs) — normalized once, at toggle time.
  function relFor(r: Row): string {
    return plotsRoot && r.abs && r.abs.startsWith(plotsRoot)
      ? r.abs.slice(plotsRoot.length).replace(/^\/+/, "")
      : (r.rel ?? r.name);
  }

  /** Toggle a file row in/out of the picked set (no close, no insert). */
  function toggle(r: Row) {
    if (r.kind !== "file" || !r.abs) return;
    if (picked.has(r.abs)) picked.delete(r.abs);
    else picked.set(r.abs, { abs: r.abs, rel: relFor(r), semantic: !!r.semantic });
    picked = picked; // Map mutation → invalidate
  }

  /** Descend into a dir row (or ascend on the ".." row). Selection survives.
   *  A reserved-folder row carries its own absolute path (it hangs off plots/, not off
   *  whatever folder is being browsed) and can only be reached from a "_" search, so the
   *  search box is cleared: you land in the folder's listing, scoped for the next query. */
  async function descend(r: Row) {
    if (r.kind === "up") return up();
    if (r.kind !== "dir") return;
    cwd = r.abs ?? joinPath(cwd, r.name);
    search = "";
    index = 0;
    resetScroll();
    await loadDir(cwd);
    syncScanScope();
  }

  /** Use the shared import pipeline; a pinned gallery remains available for reuse. */
  let inserting = false;
  async function insertPicks(picks: PlotPick[]) {
    if (!picks.length || inserting || !canInsert) return;
    inserting = true;
    try {
      const target = $activeFigureId, sourceRoot = root;
      const count = onPick ? (await onPick(picks), picks.length) : await importPlotsFromPaths(picks.map(p => p.abs),
        () => get(importerOpen) && active && root === sourceRoot && get(activeFigureId) === target);
      if (detached && !onPick) {
        error = count < picks.length ? `${picks.length - count} plots could not be read. Check their source files; ${count} were inserted.` : "";
        status = `Inserted ${count} ${count === 1 ? "plot" : "plots"} into ${destinationName}`;
        focusInput();
      } else importerOpen.set(false);
    } catch (e) {
      error = errMsg(e);
      if (!detached) pushToast("error", "Could not use that plot", { detail: error });
    } finally { inserting = false; }
  }

  /** Insert just this file row (the nothing-picked Ctrl+Enter / legacy path). */
  async function insertOne(r: Row) {
    if (r.kind !== "file" || !r.abs) return;
    await insertPicks([{ abs: r.abs, rel: relFor(r), semantic: !!r.semantic }]);
  }

  /** Insert everything picked, in pick order; falls back to the highlighted file
   *  when nothing is picked (no-op if that row is a dir / ".."). */
  async function insertPicked() {
    if (picked.size) return insertPicks([...picked.values()]);
    const r = rows[index];
    if (r) await insertOne(r);
  }

  async function up() {
    if (!cwd || cwd === plotsRoot) return;
    cwd = cwd.replace(/\/[^/]+$/, "");
    index = 0;
    resetScroll();
    await loadDir(cwd);
    syncScanScope(); // stepping out of a reserved folder restores the ordinary plots/ scope
  }
  function close() {
    importerOpen.set(false);
    dock();
  }

  // Row clicks: toggle files, descend dirs — then RETURN FOCUS to the search input
  // (all keyboard handling is bound there; a click would otherwise strand it).
  // `e.detail > 1` = the second click of a double-click: ignore it so dblclick
  // doesn't toggle the file back off (files) or hit a row in the freshly-loaded
  // listing (dirs).
  function onRowClick(e: MouseEvent, r: Row) {
    if (e.detail > 1) return;
    if (r.kind === "file") toggle(r);
    else void descend(r);
    focusInput();
  }

  // Double-click a file = insert the selection plus that file (just that file
  // when nothing else is picked — the single click already toggled it in).
  async function onRowDblClick(r: Row) {
    if (r.kind !== "file" || !r.abs) return;
    const picks = [...picked.values()];
    if (!picked.has(r.abs)) picks.push({ abs: r.abs, rel: relFor(r), semantic: !!r.semantic });
    await insertPicks(picks);
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (e.key === "Escape" && target !== inputEl) { e.preventDefault(); close(); return; }
    if (target.matches('input[type="range"], input[type="checkbox"], select')) return;
    if (target !== inputEl && !target.closest(".row")) return;
    const step = target === inputEl ? 1 : columns;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      index = Math.min(rows.length - 1, index + step);
      void ensureVisible(target !== inputEl);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      index = Math.max(0, index - step);
      void ensureVisible(target !== inputEl);
    } else if (target !== inputEl && (e.key === "Home" || e.key === "End")) {
      e.preventDefault(); index = e.key === "Home" ? 0 : rows.length - 1; void ensureVisible(true);
    } else if (target !== inputEl && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault(); index = Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowRight" ? 1 : -1))); void ensureVisible(true);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void insertPicked();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[index];
      if (!r) return;
      if (r.kind === "file") toggle(r); // toggle, don't close — Ctrl+Enter inserts
      else void descend(r);
    } else if (e.key === " " && !search) {
      // Space toggles ONLY while the search box is empty — otherwise it types
      // (plot filenames contain spaces).
      e.preventDefault();
      const r = rows[index];
      if (r) toggle(r);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (q) search = "";
      else close();
    } else if (e.key === "Backspace" && !search && !q) {
      e.preventDefault();
      void up();
    }
  }
</script>

<svelte:window on:keydown={e => { if (active && detached && e.altKey && e.code === "KeyI") { e.preventDefault(); popup?.focus(); } }} />

{#if $importerOpen}
  {#if !detached}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ibackdrop" on:pointerdown={close}></div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="iwrap" class:detached bind:this={wrapEl} on:keydown={onKey}>
    <div class="importer" role="dialog" aria-modal={!detached} aria-label={title} tabindex="-1">
      <header class="ihead">
        <div class="heading"><span class="eyebrow">FLUX / FIGURE</span><h2 class="ttl">{title}</h2></div>
        <div class="head-actions">
          {#if detached}<button class="pinbtn" on:click={dock} title="Return this gallery to the editor">↙ Dock</button>
          {:else if !onPick}<button class="pinbtn" on:click={pin} title="Keep open in a movable, resizable window">↗ Pin open</button>{/if}
          <button class="closebtn" on:click={close} aria-label="Close plot gallery">×</button>
        </div>
      </header>
      <div class="navigation">
        <div class="path">
          <button class="rootbtn" on:click={goRoot} title="Browse all plots">plots</button>
          <span class="cur" title={relDir}>{relDir}</span>
          {#if cwd && cwd !== plotsRoot}<button class="upbtn" on:click={up} title="Parent folder (Backspace)">↑ Up</button>{/if}
        </div>
        <button class="refreshbtn" on:click={refresh} disabled={loading} title="Reload this folder and its previews">↻ Refresh</button>
      </div>
      <div class="search-row">
        <svg class="mag" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
        <input bind:this={inputEl} bind:value={search} class="search-in" aria-label="Search plots" placeholder={searchHint} spellcheck="false" on:input={() => { index = 0; status = ""; }} />
        {#if search}<button class="clear-search" on:click={() => { search = ""; index = 0; focusInput(); }} aria-label="Clear search">×</button>{/if}
      </div>
      <div class="viewbar">
        <div class="view-switch" aria-label="Gallery view">
          <button class:chosen={viewMode === "gallery"} aria-pressed={viewMode === "gallery"} on:click={() => { viewMode = "gallery"; rememberView(); }} aria-label="Gallery view">▦ Gallery</button>
          <button class:chosen={viewMode === "list"} aria-pressed={viewMode === "list"} on:click={() => { viewMode = "list"; rememberView(); }} aria-label="List view">☰ List</button>
        </div>
        {#if viewMode === "gallery"}
          <label class="slider">Size <input type="range" aria-label="Preview size" min="120" max="360" step="10" bind:value={previewSize} on:change={rememberView} /></label>
          <label class="slider">Space <input type="range" aria-label="Preview spacing" min="4" max="32" step="2" bind:value={spacing} on:change={rememberView} /></label>
          <label class="labels"><input type="checkbox" bind:checked={labels} on:change={rememberView} /> Names</label>
        {/if}
        <span class="count">{fileCount} {fileCount === 1 ? "plot" : "plots"}</span>
      </div>
      <div class="list" class:gallery={viewMode === "gallery"} class:without-labels={!labels} bind:this={listEl} use:trackListSize on:scroll={() => scrollTop = listEl.scrollTop}>
        {#if !root}<div class="empty">Open a Flux project to browse its plots.</div>
        {:else if !fileBridge()?.readdir}<div class="empty">Folder browsing isn't available in this build.</div>
        {:else if !rows.length && !loading}<div class="empty"><strong>{q ? "No matching plots" : "A little space for your next result"}</strong><span>{q ? "Try another name or return to browsing." : "Save SVG plots or PNG images into this folder to see them here."}</span></div>
        {:else}
          <div style={`height:${Math.floor(start / columns) * stride}px`} aria-hidden="true"></div>
          <div class="items" style={`--columns:${columns}; --cell-height:${cellHeight}px; --gap:${gap}px`}>
            {#each shown as r, offset (r.kind + (r.abs ?? r.name) + previewRevision)}
              {@const i = start + offset}
              {@const selected = r.kind === "file" && !!r.abs && picked.has(r.abs)}
              <button class="row" class:sel={i === index} class:picked={selected} class:folder={r.kind !== "file"} data-i={i} data-kind={r.kind} aria-pressed={r.kind === "file" ? selected : undefined} title={r.hint || r.rel || r.name} on:focus={() => index = i} on:pointerenter={() => index = i} on:click={e => onRowClick(e, r)} on:dblclick={() => onRowDblClick(r)}>
                {#if viewMode === "gallery"}
                  <span class="tile-preview">
                    {#if r.kind === "file" && r.abs}<GalleryPreview path={r.abs} {previews} />
                    {:else}<svg class="folder-icon" viewBox="0 0 48 40" aria-hidden="true"><path d="M4 10V6h15l5 5h20v23H4Z"/>{#if r.kind === "up"}<path d="m18 23 6-6 6 6m-6-6v13"/>{/if}</svg><span class="folder-caption">{r.kind === "up" ? "Parent folder" : "Folder"}</span>{/if}
                  </span>
                {/if}
                <span class="row-meta">
                  <span class="ic">{selected ? "✓" : r.kind === "dir" ? "↳" : r.kind === "up" ? "↩" : r.semantic ? "◆" : "◇"}</span>
                  <span class="names"><span class="nm">{r.kind === "file" ? r.name.replace(/\.(svg|png)$/i, "") : r.name}</span>{#if r.hint}<span class="rel">{r.hint}</span>{:else if q && r.rel && r.rel !== r.name}<span class="rel">{r.rel.replace(/\/[^/]+$/, "")}</span>{/if}</span>
                  {#if r.kind === "file" && r.semantic}<span class="badge">semantic</span>{/if}
                  {#if r.snip}<span class="badge">snip</span>{/if}
                </span>
                {#if viewMode === "gallery" && selected}<span class="pick-mark" aria-hidden="true">✓</span>{/if}
              </button>
            {/each}
          </div>
          <div style={`height:${Math.max(0, Math.ceil(rows.length / columns) - Math.ceil(end / columns)) * stride}px`} aria-hidden="true"></div>
          {#if truncated}<div class="note">Search covers the first 20,000 plots and 20 folder levels. Browse a folder to see all of its images.</div>{/if}
        {/if}
      </div>
      {#if !q && cwd === plotsRoot && rootReserved.length}<div class="note reserved" data-reserved-hint>Companion collections · Type <b>_</b> to browse {rootReserved.map(f => f.name).join(" and ")}.</div>{/if}
      {#if error}<div class="message error" role="alert">{error}</div>{:else if status}<div class="message" role="status">{status}</div>{/if}
      <footer class="foot">
        <div class="selection-info">
          {#if pickedCount > 0}<span class="pickpill">{pickedCount} selected</span><button class="clear-picks" on:click={() => picked = new Map()}>Clear</button>{:else}<span>Choose plots to place</span>{/if}
          <span class="destination" title={destinationName}>{canInsert ? `Into ${destinationName}` : "Return to the editor to insert"}</span>
        </div>
        <span class="keyhint">↵ select · {typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}↵ insert</span>
        <button class="insbtn" disabled={inserting || !canInsert || (!pickedCount && rows[index]?.kind !== "file")} on:click={() => void insertPicked()}>{inserting ? "Inserting…" : `Insert${pickedCount ? ` ${pickedCount}` : " plot"}`}<span aria-hidden="true"> ↗</span></button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .ibackdrop { position:fixed; inset:0; background:rgb(0 0 0 / .28); z-index:320; }
  .iwrap { position:fixed; inset:0; z-index:321; display:flex; align-items:center; justify-content:center; padding:28px; pointer-events:none; }
  .importer { pointer-events:auto; width:980px; height:740px; max-width:100%; max-height:100%; display:flex; flex-direction:column; border-radius:12px; color:var(--c-tx); font-family:var(--font-serif); overflow:hidden; background:var(--c-bg-raised); border:1px solid var(--c-line-strong); box-shadow:var(--elev-3); outline:none; }
  .detached { padding:0; }
  .detached .importer { width:100%; height:100%; border:0; border-radius:0; box-shadow:none; }
  button { font-family:inherit; color:inherit; cursor:pointer; }
  button:focus-visible { outline:2px solid var(--c-accent); outline-offset:2px; }
  button:disabled { opacity:.4; cursor:default; }
  .ihead { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:20px 24px 14px; }
  .eyebrow { color:var(--c-tx-muted); font-family:var(--font-mono); letter-spacing:1.6px; font-size:9px; }
  h2 { margin:4px 0 0; font-weight:400; font-size:25px; letter-spacing:-.5px; color:var(--c-tx-hi); }
  .head-actions { display:flex; gap:12px; align-items:center; }
  .pinbtn { background:var(--c-surface); border:1px solid var(--c-line-strong); border-radius:6px; padding:7px 11px; font-size:12px; }
  .pinbtn:hover { background:var(--c-accent-tint); border-color:var(--c-accent); }
  .closebtn { background:none; border:0; font-size:24px; color:var(--c-tx-muted); padding:0 4px; }
  .navigation { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 24px 12px; font-size:12px; }
  .path { display:flex; gap:8px; align-items:center; min-width:0; }
  .cur { color:var(--c-tx-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cur:not(:empty)::before { content:"/ "; opacity:.5; }
  .rootbtn, .upbtn, .refreshbtn, .clear-picks { background:none; border:0; padding:2px 0; font-size:12px; white-space:nowrap; }
  .rootbtn { color:var(--c-accent-bright); }
  .upbtn, .refreshbtn, .clear-picks { color:var(--c-tx-muted); }
  .upbtn:hover, .refreshbtn:hover, .clear-picks:hover { color:var(--c-tx-hi); }
  .search-row { display:flex; gap:10px; align-items:center; margin:0 24px 14px; padding:10px 12px; border:1px solid var(--c-line-strong); background:var(--c-surface); border-radius:7px; }
  .search-row:focus-within { border-color:var(--c-accent); box-shadow:0 0 0 2px var(--c-accent-tint); }
  .mag { width:18px; height:18px; fill:none; stroke:var(--c-tx-muted); stroke-width:1.5; flex-shrink:0; }
  .search-in { flex:1; min-width:0; padding:0; border:0; outline:0; background:none; color:var(--c-tx); font:14px var(--font-serif); }
  .search-in::placeholder { color:var(--c-tx-muted); }
  .clear-search { border:0; background:none; font-size:18px; line-height:1; }
  .viewbar { display:flex; align-items:center; flex-wrap:wrap; gap:18px; padding:0 24px 14px; font-size:11px; color:var(--c-tx-muted); border-bottom:1px solid var(--c-line); }
  .view-switch { display:flex; gap:2px; border:1px solid var(--c-line); border-radius:6px; padding:2px; }
  .view-switch button { border:0; background:none; padding:5px 9px; border-radius:4px; font-size:11px; }
  .view-switch .chosen { background:var(--c-surface-2); color:var(--c-tx-hi); }
  .slider { display:flex; gap:7px; align-items:center; }
  input[type="range"] { width:74px; height:14px; margin:0; accent-color:var(--c-accent); }
  .labels { display:flex; align-items:center; gap:5px; }
  input[type="checkbox"] { accent-color:var(--c-accent); margin:0; }
  .count { margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .list { flex:1; min-height:0; overflow:auto; padding:16px; background:var(--c-bg); scrollbar-gutter:stable; }
  .items { display:grid; grid-template-columns:repeat(var(--columns), minmax(0,1fr)); gap:var(--gap); grid-auto-rows:var(--cell-height); }
  .row { position:relative; display:flex; min-width:0; padding:5px 10px; border:1px solid transparent; border-radius:6px; background:transparent; text-align:left; overflow:hidden; }
  .row.sel { border-color:var(--c-line-strong); background:var(--c-surface); }
  .row.picked { background:var(--c-accent-tint); border-color:var(--c-accent); }
  .gallery .row { padding:7px; flex-direction:column; background:var(--c-bg-raised); border-color:var(--c-line); }
  .gallery .row.sel { border-color:var(--c-tx-muted); }
  .gallery .row.picked { border-color:var(--c-accent); box-shadow:0 0 0 1px var(--c-accent); }
  .tile-preview { flex:1; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center; border-radius:4px; overflow:hidden; }
  .folder .tile-preview { background:var(--c-surface); }
  .folder-icon { width:48px; height:40px; fill:none; stroke:var(--c-tx-muted); stroke-width:1.2; }
  .folder-caption { margin-top:8px; font-size:11px; color:var(--c-tx-muted); }
  .row-meta { display:flex; align-items:center; width:100%; min-width:0; gap:8px; }
  .gallery .row-meta { height:38px; flex-shrink:0; padding:6px 2px 0; }
  .names { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
  .nm { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
  .rel { font-size:10px; color:var(--c-tx-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ic { width:14px; flex:0 0 14px; text-align:center; color:var(--c-accent-bright); font-size:11px; }
  .badge { margin-left:auto; font:8px var(--font-mono); color:var(--c-tx-muted); }
  .gallery .badge { display:none; }
  .pick-mark { position:absolute; right:12px; top:12px; background:var(--c-accent); color:var(--c-on-accent); border:2px solid var(--c-bg-raised); border-radius:50%; width:23px; height:23px; text-align:center; line-height:19px; font-size:12px; }
  .gallery.without-labels .row:not(.folder) .row-meta { display:none; }
  .empty { display:flex; flex-direction:column; gap:8px; padding:60px 20px; text-align:center; color:var(--c-tx-muted); font-size:13px; }
  .empty strong { font-size:20px; font-weight:400; color:var(--c-tx); }
  .note { padding:10px 12px; color:var(--c-tx-muted); font-size:11px; }
  .reserved { padding:9px 24px; border-top:1px solid var(--c-line); }
  .message { padding:9px 24px; color:var(--c-accent-bright); font-size:12px; border-top:1px solid var(--c-line); }
  .message.error { color:var(--c-danger); }
  .foot { display:flex; align-items:center; gap:16px; padding:14px 24px; border-top:1px solid var(--c-line); font-size:12px; color:var(--c-tx-muted); }
  .selection-info { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; min-width:0; flex:1; }
  .pickpill { color:var(--c-accent-bright); white-space:nowrap; }
  .destination { flex-basis:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px; }
  .keyhint { font-size:10px; white-space:nowrap; }
  .insbtn { background:var(--c-accent); color:var(--c-on-accent); border:1px solid var(--c-accent); border-radius:6px; padding:9px 15px; font-size:13px; white-space:nowrap; }
  .insbtn:hover:not(:disabled) { background:var(--c-accent-bright); }
  @media (max-width:640px) { .iwrap:not(.detached) { padding:12px; } .ihead { padding:16px; } .navigation, .viewbar { padding-left:16px; padding-right:16px; } .search-row { margin-left:16px; margin-right:16px; } .viewbar { gap:10px; } .foot { padding:12px 16px; } .keyhint { display:none; } h2 { font-size:22px; } }
</style>
