<script lang="ts" context="module">
  /** One picked plot, handed to `onPick` hosts in insertion (= placement) order. */
  export interface PlotPick {
    abs: string;
    rel: string;
    semantic: boolean;
  }
</script>

<script lang="ts">
  // Plot gallery (Alt+G): a windowed contact sheet over the project's plots/ dir —
  // or, via the Project | Global switch (Alt+1 / Alt+2), over the user's global plot
  // library (<FluxConfig>/plot_library, any folder structure, shared by every project).
  // Search by name/path, or browse folder-by-folder, in a dialog or a native utility.
  // What a search reaches is the Settings → Figure `plotSearchScope` preference,
  // resolved by plot/galleryScope (the rules) into cached walks owned here (the IO).
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
  // or browsing the explicit folder tree RE-SCOPES the search cache, so you search
  // inside it and nowhere else. Leaving restores the ordinary plots/ scope. The
  // global library follows the same rules. A plot inserted from it keeps its
  // library file as an external source (the project still stores its own copy).
  import { onDestroy, tick } from "svelte";
  import { get } from "svelte/store";
  import GalleryPreview from "./plot/GalleryPreview.svelte";
  import GalleryTree from "./plot/GalleryTree.svelte";
  import GalleryExpandedPreview from "./plot/GalleryExpandedPreview.svelte";
  import { createGalleryPreviews } from "./plot/galleryPreviews";
  import { galleryNameSimilarity } from "./plot/galleryNames";
  import { clearDissectCache } from "./dissect/loader";
  import { openGalleryWindow } from "./plot/galleryWindow";
  import { importerOpen, importerDetached, embeddedProjectRoot, projectDir, activeFigureId, project } from "./store";
  import { settings } from "./settings";
  import {
    GALLERY_SCOPES,
    gallerySearchPlan,
    inPlanFolder,
    sourceKey,
    type GalleryScope,
    type SearchPlan,
    type SearchSource,
  } from "./plot/galleryScope";
  import { fileBridge, joinPath } from "./project/types";
  import { importPlotsFromPaths } from "./io";
  import { pushToast, errMsg } from "./toast";
  import {
    RESERVED_PLOT_FOLDERS,
    VIDEO_DIRNAME,
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
  /** Slide-owned imports preserve the gallery's pinned/batch interaction. */
  export let importItems: ((picks: PlotPick[], canPlace: () => boolean) => Promise<number>) | undefined = undefined;
  export let allowVideos = false;
  export let importStatus = "";
  export let cancelImport: (() => void) | undefined = undefined;
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
    video?: boolean;
    scope: GalleryScope;
  }
  interface Row {
    kind: "up" | "dir" | "file";
    name: string;
    abs?: string;
    rel?: string;
    semantic?: boolean;
    snip?: boolean;
    video?: boolean;
    /** A reserved-folder row, surfaced by typing "_" (carries its own abs — it is
     *  always a child of plots/, never of the folder currently being browsed). */
    hint?: string;
    /** Which scope the file lives in (browse rows: the browsed one). */
    scope?: GalleryScope;
    /** Search rows: where the file sits ("figs/panels", or "Global · figs" when
     *  the results span a scope other than the browsed one). */
    where?: string;
  }
  interface ScanCache { recs: PlotRec[]; scanned: boolean; truncated: boolean }

  $: root = rootOverride || $embeddedProjectRoot || $projectDir || "";
  $: projectPlotsRoot = root ? joinPath(root, "plots") : "";
  /** <FluxConfig>/plot_library, resolved by the main process ("" = unavailable). */
  let libraryRoot = "";
  let browseScope: GalleryScope = "project";
  // The BROWSED root — the project's plots/ or the global library. A plain
  // variable assigned together with `cwd` (never a `$:`): loadDir and
  // reservedRootOf need it correct the instant the scope switches.
  let plotsRoot = "";
  function rootOf(scope: GalleryScope): string { return scope === "global" ? libraryRoot : projectPlotsRoot; }
  /** Videos stay project-only: clip import copies from the project's own plots/. */
  function videosFor(scope: GalleryScope): boolean { return allowVideos && scope === "project"; }
  $: browseVideos = allowVideos && browseScope === "project";

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
  let sidebar = true;
  let tree: GalleryTree | undefined;
  let treeRevision = 0;
  let expanded: PlotRec | undefined;
  let similarTo: string = "";
  try {
    const saved = JSON.parse(localStorage.getItem("flux-plot-gallery") ?? "{}");
    if (saved.view === "list") viewMode = "list";
    if (Number.isFinite(saved.size)) previewSize = Math.max(120, Math.min(800, saved.size));
    if (Number.isFinite(saved.spacing)) spacing = Math.max(4, Math.min(32, saved.spacing));
    if (typeof saved.labels === "boolean") labels = saved.labels;
    if (typeof saved.sidebar === "boolean") sidebar = saved.sidebar;
    if (saved.scope === "global") browseScope = "global";
  } catch { /* Invalid preferences fall back to the gallery defaults. */ }
  function rememberView() {
    try { localStorage.setItem("flux-plot-gallery", JSON.stringify({ view: viewMode, size: previewSize, spacing, labels, sidebar, scope: browseScope })); } catch {}
  }
  function focusInput() { void tick().then(() => inputEl?.focus()); }
  function pin() {
    try {
      popup = openGalleryWindow(wrapEl, close, () => { reconnectListSize(); tree?.reconnect(); });
      detached = true;
      importerDetached.set(true);
    } catch (e) { error = errMsg(e); }
  }
  function dock() {
    popup?.close(); popup = undefined;
    detached = false; importerDetached.set(false);
    expanded = undefined;
    focusInput();
  }
  function resetPreviews() {
    previews.dispose(); previews = createGalleryPreviews(); previewRevision++;
  }
  function teardown() {
    expanded = undefined;
    popup?.close(); popup = undefined;
    detached = false; importerDetached.set(false);
    dirGeneration++; scanGeneration++; scopeGeneration++;
    caches = new Map(); plotsRoot = "";
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
  $: cellHeight = viewMode === "gallery" ? Math.round(Math.min(previewSize, Math.max(120, listWidth - 32)) * .72) + (labels ? 54 : 18) : 28;
  $: gap = viewMode === "gallery" ? spacing : 0;
  $: stride = cellHeight + gap;
  $: start = Math.max(0, Math.min(Math.ceil(rows.length / columns) - 1, Math.floor(scrollTop / stride) - 2)) * columns;
  $: end = Math.min(rows.length, start + (Math.ceil(listHeight / stride) + 5) * columns);
  $: shown = rows.slice(start, end);
  $: fileCount = rows.filter(r => r.kind === "file").length;
  function resetScroll() { scrollTop = 0; if (listEl) listEl.scrollTop = 0; }
  $: { search; similarTo; viewMode; previewSize; spacing; labels; resetScroll(); }

  let openedRoot = "";
  $: if ($importerOpen && openedRoot && root !== openedRoot) close();
  let cwd = "";
  let entries: { name: string; dir: boolean }[] = [];
  // Recursive search caches, one per SOURCE (a scope's ordinary tree, or one
  // reserved collection inside it — plot/galleryScope sourceKey). Keyed, so a walk
  // for a scope you have since left simply waits in the cache for your return.
  let caches = new Map<string, ScanCache>();
  let search = "";
  let index = 0;
  let loading = false;
  let listEl: HTMLDivElement;
  let inputEl: HTMLInputElement;
  // The multi-select: keyed by ABSOLUTE path (stable across browse↔search rows and
  // immune to scan caps); insertion order = placement order. `rel` is normalized
  // to the plots/-relative path at toggle time (browse rows carry bare names).
  let picked = new Map<string, PlotPick>();
  $: pickedCount = picked.size;

  // Which reserved folders actually exist directly under the browsed root (read from
  // the root listing, so "_" offers only what is really there). Their rows carry an
  // absolute path because search is reachable from any folder, while a reserved
  // folder is always a child of the root itself.
  let rootReserved: ReservedPlotFolder[] = [];

  let prevOpen = false;
  $: {
    if ($importerOpen && !prevOpen) void open();
    if (!$importerOpen && prevOpen) teardown();
    prevOpen = $importerOpen;
  }
  async function open() {
    openedRoot = root;
    search = "";
    similarTo = "";
    index = 0;
    status = ""; error = "";
    picked = new Map();
    rootReserved = [];
    caches = new Map(); scanGeneration++;
    libraryRoot = await resolveLibraryRoot();
    if (!get(importerOpen) || root !== openedRoot) return;
    await enterScope(libraryRoot ? browseScope : "project");
    if (!get(importerOpen) || root !== openedRoot) return;
    focusInput();
  }

  async function resolveLibraryRoot(): Promise<string> {
    try {
      const prefs = await fileBridge()?.prefsGet?.();
      return typeof prefs?.plotLibraryResolved === "string" ? prefs.plotLibraryResolved : "";
    } catch { return ""; }
  }

  /** Browse a scope from its root. The global library is created on first use,
   *  so the folder exists for the user to fill (FluxConfig is theirs). */
  let scopeGeneration = 0;
  async function enterScope(scope: GalleryScope) {
    const generation = ++scopeGeneration;
    if (scope === "global") {
      try { await fileBridge()?.mkdir?.(libraryRoot); } catch { /* the listing reports it */ }
      if (generation !== scopeGeneration) return;
    }
    // Scope, root and folder change together, so no row is ever read against
    // the other scope's root.
    browseScope = scope;
    plotsRoot = rootOf(scope);
    cwd = plotsRoot;
    rootReserved = [];
    await loadDir(cwd);
  }
  async function switchScope(scope: GalleryScope) {
    if (scope === browseScope || scope === "global" && !libraryRoot) return;
    // The query and the picks survive: a search can follow you across scopes,
    // and one insertion can combine project and global plots.
    similarTo = ""; index = 0; status = ""; error = ""; resetScroll();
    await enterScope(scope);
    rememberView();
    focusInput();
  }

  /** The reserved folder a directory sits under, as its bare name ("" = ordinary
   *  content). Derived from the path so it is correct the instant `cwd` changes —
   *  a reactive `$:` would still be a flush behind the `loadDir` that follows.
   *  Both inputs are explicit, so reactive callers see them as dependencies. */
  function reservedRootIn(base: string, dir: string): string {
    if (!base || !dir || !dir.startsWith(base)) return "";
    return reservedRootOfPlotsRel(dir.slice(base.length).replace(/^\/+/, ""));
  }
  function reservedRootOf(dir: string): string { return reservedRootIn(plotsRoot, dir); }

  // Sidecars present in the CURRENT folder — kept from the raw listing (entries
  // filters them out), so browse rows can flag semantic plots (.fluxplot.json)
  // and paper snips (.snip.json). Search rows get the same flags from scan().
  let manifestNames = new Set<string>();
  let snipNames = new Set<string>();
  let listedDirectory = "";
  let dirGeneration = 0;
  let scanGeneration = 0;
  async function loadDir(dir: string) {
    const generation = ++dirGeneration;
    // cwd changes immediately. Old names must not become paths in the new
    // directory while its asynchronous listing is still arriving.
    if (listedDirectory !== dir) {
      listedDirectory = dir;
      entries = []; manifestNames = new Set(); snipNames = new Set();
    }
    const fig = fileBridge();
    if (!fig?.readdir || !dir) {
      entries = [];
      manifestNames = new Set();
      snipNames = new Set();
      loading = false;
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
    const videos = videosFor(browseScope);
    if (dir === plotsRoot)
      rootReserved = RESERVED_PLOT_FOLDERS.filter((f) => !(videos && f.name === VIDEO_DIRNAME) && es.some((e) => e.dir && e.name === f.name));
    // dirs first, then files, each alphabetical; show dirs + .svg plots + .png rasters (snips).
    // Reserved folders (_dissections, _lighttable) are companion material, not plots to
    // insert — they never appear here or in search (shared rule, see project/plotsFolders).
    // INSIDE one, though, everything is listed: getting in is the deliberate act.
    const inReserved = !!reservedRootOf(dir);
    entries = es
      .filter((e) => (e.dir ? inReserved || !isReservedPlotDirName(e.name) || videos && e.name === VIDEO_DIRNAME : /\.(svg|png)$/i.test(e.name) || videos && /\.(mp4|mov)$/i.test(e.name)))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    loading = false;
  }

  // Recursively collect every .svg/.png under one SOURCE (capped), flagging semantic
  // plots (.fluxplot.json sibling) and paper snips (.snip.json sibling) — no extra IO,
  // read from the dir listing. `reserved` is "" for a scope's ordinary tree (reserved
  // folders pruned at every depth) or a reserved folder name (that subtree, nothing
  // pruned). Paths stay root-relative either way, so rows read the same in both.
  async function scanSource(src: SearchSource) {
    const key = sourceKey(src), base = rootOf(src.scope);
    if (caches.has(key) || !base) return;
    const generation = scanGeneration;
    const entry: ScanCache = { recs: [], scanned: false, truncated: false };
    caches.set(key, entry); caches = caches;
    const fig = fileBridge();
    if (!fig?.readdir) { entry.scanned = true; caches = caches; return; }
    const videos = videosFor(src.scope);
    const out: PlotRec[] = [];
    const current = () => generation === scanGeneration && caches.get(key) === entry;
    const visit = async (dir: string, rel: string, depth: number) => {
      if (!current()) return;
      if (depth > 20 || out.length >= 20000) {
        entry.truncated = true;
        return;
      }
      const es = await fig.readdir!(dir);
      const names = new Set(es.map((e) => e.name));
      for (const e of es) {
        if (!current()) return;
        if (out.length >= 20000) { entry.truncated = true; return; }
        const abs = joinPath(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.dir) {
          if (src.reserved || !isReservedPlotDirName(e.name) || videos && e.name === VIDEO_DIRNAME) await visit(abs, r, depth + 1);
        }
        else if (/\.svg$/i.test(e.name))
          out.push({ abs, rel: r, name: e.name, scope: src.scope, semantic: names.has(e.name.replace(/\.svg$/i, ".fluxplot.json")) });
        else if (/\.png$/i.test(e.name))
          out.push({ abs, rel: r, name: e.name, scope: src.scope, semantic: false, snip: names.has(e.name.replace(/\.png$/i, ".snip.json")) });
        else if (videos && /\.(mp4|mov)$/i.test(e.name))
          out.push({ abs, rel: r, name: e.name, scope: src.scope, semantic: false, video: true });
      }
    };
    try { await visit(src.reserved ? joinPath(base, src.reserved) : base, src.reserved, 0); }
    catch (e) { if (current()) error = `Some folders could not be searched: ${errMsg(e)}`; }
    if (!current()) return; // refreshed or closed mid-walk
    entry.recs = out;
    entry.scanned = true;
    caches = caches;
  }
  function ensureScans(plan: SearchPlan) { for (const src of plan.sources) void scanSource(src); }

  // What a query reaches right now (the preference, the browsed scope, and whether
  // the current folder is inside a reserved collection). Scans warm in the
  // background as soon as the plan names a source that is not cached yet — on open,
  // on a scope switch, on entering/leaving a collection, or on a Settings change.
  $: plan = gallerySearchPlan({ mode: $settings.plotSearchScope, browse: browseScope, reserved: reservedRootIn(plotsRoot, cwd), cwd, browseRoot: plotsRoot });
  $: if ($importerOpen && plotsRoot) ensureScans(plan);
  // A source whose root is unavailable (no global library in this build) counts as
  // scanned-and-empty rather than scanning forever.
  $: planCaches = plan.sources.map((src) => rootOf(src.scope) ? caches.get(sourceKey(src)) : { recs: [], scanned: true, truncated: false });
  $: scanned = planCaches.every((c) => c?.scanned);
  $: truncated = planCaches.some((c) => c?.truncated);

  $: q = search.trim().toLowerCase();
  // Search mode when typing; otherwise the current-folder browse listing.
  $: rows = ((): Row[] => {
    if (q || similarTo) {
      const out: Row[] = [];
      // A query that STARTS with "_" also offers the reserved folders whose
      // names match it ("_" both, "_light" one). As with tree navigation, once
      // you are inside one the search below is already scoped to it.
      if (!reservedRootIn(plotsRoot, cwd) && !similarTo && q.startsWith("_"))
        for (const f of rootReserved)
          if (f.name.includes(q))
            out.push({ kind: "dir", name: f.name, abs: joinPath(plotsRoot, f.name), hint: f.hint });
      const matches = planCaches.flatMap((c) => c?.recs ?? [])
        .filter(p => inPlanFolder(plan, p.abs) && `${p.rel} ${p.name}`.toLowerCase().includes(q))
        .map(p => ({ p, score: similarTo ? galleryNameSimilarity(similarTo, p.name) : 0 }))
        .filter(({ score }) => !similarTo || score > 0)
        .sort((a, b) => b.score - a.score || rank(a.p, q) - rank(b.p, q)
          || Number(a.p.scope !== browseScope) - Number(b.p.scope !== browseScope) || a.p.rel.localeCompare(b.p.rel));
      const whereOf = (p: PlotRec) => {
        const dir = p.rel.includes("/") ? p.rel.replace(/\/[^/]+$/, "") : "";
        if (!plan.mixed) return dir;
        const label = p.scope === "global" ? "Global" : "Project";
        return dir ? `${label} · ${dir}` : label;
      };
      out.push(...matches.map(({ p }): Row => ({ kind: "file", name: p.name, abs: p.abs, rel: p.rel, semantic: p.semantic, snip: p.snip, video: p.video, scope: p.scope, where: whereOf(p) })));
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
          scope: browseScope,
          // entries drops sidecar files, so these checks read the raw listing's
          // sidecar names (a browse row was NEVER semantic before).
          semantic: manifestNames.has(e.name.replace(/\.svg$/i, ".fluxplot.json")),
          snip: /\.png$/i.test(e.name) && snipNames.has(e.name.replace(/\.png$/i, ".snip.json")),
          video: /\.(mp4|mov)$/i.test(e.name),
        });
    }
    return out;
  })();
  $: if (index >= rows.length) index = Math.max(0, rows.length - 1);
  $: relDir = cwd && plotsRoot ? cwd.slice(plotsRoot.length).replace(/^\//, "") : "";
  // The search box says what a query would actually reach (plot/galleryScope).
  $: searchHint = scanned ? plan.placeholder : "Scanning…";

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
    error = ""; status = ""; resetPreviews(); clearDissectCache(); treeRevision++;
    scanGeneration++; caches = new Map();
    await loadDir(cwd);
    ensureScans(plan);
  }
  async function goRoot() {
    cwd = plotsRoot; search = ""; similarTo = ""; index = 0; resetScroll();
    await loadDir(cwd); focusInput();
  }

  // A row's stable path relative to ITS scope's root (project plots/ or the global
  // library; consistent across search vs. browse rows, where r.rel differs) —
  // normalized once, at toggle time.
  function relFor(r: Row): string {
    const base = rootOf(r.scope ?? browseScope);
    return base && r.abs && r.abs.startsWith(base)
      ? r.abs.slice(base.length).replace(/^\/+/, "")
      : (r.rel ?? r.name);
  }

  /** Toggle a file row in/out of the picked set (no close, no insert). */
  function toggle(r: Row) {
    if (r.kind !== "file" || !r.abs) return;
    status = "";
    if (picked.has(r.abs)) picked.delete(r.abs);
    else picked.set(r.abs, { abs: r.abs, rel: relFor(r), semantic: !!r.semantic });
    picked = picked; // Map mutation → invalidate
  }

  /** Descend into a dir row (or ascend on the ".." row). Selection survives.
   * Tree entries and reserved-folder search rows carry their own absolute path.
   * Clear the search and scope the next query to the chosen collection. */
  async function descend(r: Row) {
    if (r.kind === "up") return up();
    if (r.kind !== "dir") return;
    cwd = r.abs ?? joinPath(cwd, r.name);
    search = "";
    similarTo = "";
    index = 0;
    resetScroll();
    await loadDir(cwd);
  }

  /** Use the shared import pipeline; a pinned gallery remains available for reuse. */
  let inserting = false;
  async function insertPicks(picks: PlotPick[]) {
    if (!picks.length || inserting || !canInsert) return;
    inserting = true;
    try {
      const target = $activeFigureId, sourceRoot = root;
      const canPlace = () => get(importerOpen) && active && root === sourceRoot && get(activeFigureId) === target;
      const count = onPick ? (await onPick(picks), picks.length) : importItems ? await importItems(picks, canPlace) : await importPlotsFromPaths(picks.map(p => p.abs), canPlace);
      if (count > 0) {
        // Preserve files newly picked while the asynchronous import was running.
        // A failed batch retains picks; a completed placement starts a fresh batch.
        for (const pick of picks) if (picked.get(pick.abs) === pick) picked.delete(pick.abs);
        picked = new Map(picked);
        index = -1;
      }
      if (detached && !onPick) {
        error = count < picks.length ? `${picks.length - count} files could not be read. Check their source files; ${count} were inserted.` : "";
        status = `Inserted ${count} ${count === 1 ? "item" : "items"} into ${destinationName}`;
        focusInput();
      } else importerOpen.set(false);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") { status = "Import cancelled"; return; }
      error = errMsg(e);
      if (!detached) pushToast("error", "Could not import the selection", { detail: error });
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
    search = ""; similarTo = "";
    index = 0;
    resetScroll();
    await loadDir(cwd); // stepping out of a reserved folder restores the ordinary search plan
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
    if ((e.ctrlKey || e.metaKey) && r.kind === "file") { e.preventDefault(); previewRow(r); return; }
    if (e.detail > 1) return;
    if (r.kind === "file") toggle(r);
    else void descend(r);
    focusInput();
  }

  // Double-click a file = insert the selection plus that file (just that file
  // when nothing else is picked — the single click already toggled it in).
  async function onRowDblClick(e: MouseEvent, r: Row) {
    if (e.ctrlKey || e.metaKey) return;
    if (r.kind !== "file" || !r.abs) return;
    const picks = [...picked.values()];
    if (!picked.has(r.abs)) picks.push({ abs: r.abs, rel: relFor(r), semantic: !!r.semantic });
    await insertPicks(picks);
  }

  function onKey(e: KeyboardEvent) {
    if (expanded || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    // Virtual scrolling can move another tile beneath a stationary pointer.
    // Keyboard navigation starts at the focused row, independently of hover.
    if (target !== inputEl) {
      const focusedIndex = Number(target.closest<HTMLElement>(".row")?.dataset.i);
      if (Number.isInteger(focusedIndex)) index = focusedIndex;
    }
    if (e.key === "Escape" && target !== inputEl) { e.preventDefault(); close(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void insertPicked(); return; }
    // Alt+1 / Alt+2: Project | Global (e.code — Alt changes e.key on macOS).
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "Digit1" || e.code === "Digit2")) {
      e.preventDefault(); void switchScope(e.code === "Digit1" ? "project" : "global"); return;
    }
    if (target.matches('input[type="range"], input[type="checkbox"], select')) return;
    if (target !== inputEl && !target.closest(".row")) return;
    const step = target === inputEl ? 1 : columns;
    if (e.key === "F4") {
      e.preventDefault(); previewRow(rows[index]);
    } else if (e.key === "ArrowDown") {
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
      if (q || similarTo) { search = ""; similarTo = ""; }
      else close();
    } else if (e.key === "Backspace" && !search && !q) {
      e.preventDefault();
      void up();
    }
  }

  function previewRow(row: Row | undefined) {
    if (row?.kind !== "file" || !row.abs) return;
    expanded = { abs: row.abs, rel: relFor(row), name: row.name, semantic: !!row.semantic, video: row.video, snip: row.snip, scope: row.scope ?? browseScope };
  }
  $: previewFiles = rows.filter((r): r is Row & { abs: string } => r.kind === "file" && !!r.abs);
  $: previewIndex = expanded ? previewFiles.findIndex(r => r.abs === expanded?.abs) : -1;
  function stepPreview(direction: number) {
    const next = previewFiles[previewIndex + direction];
    if (next) { index = rows.indexOf(next); previewRow(next); }
  }
  function closePreview() {
    expanded = undefined;
    void ensureVisible();
    focusInput();
  }
  function summonSimilar(file: { name: string }) {
    similarTo = file.name; search = ""; index = 0;
    closePreview();
  }
  async function navigateTree(path: string) {
    await descend({ kind: "dir", name: path.split("/").pop() || "plots", abs: path });
  }
  async function selectTreeFile(file: { abs: string }) {
    const folder = file.abs.replace(/\/[^/]+$/, "");
    const generation = dirGeneration + 1;
    await navigateTree(folder);
    // The directory read invalidates rows in the next Svelte flush.
    await tick();
    if (!get(importerOpen) || cwd !== folder || dirGeneration !== generation) return false;
    index = rows.findIndex(r => r.abs === file.abs);
    void ensureVisible();
    return true;
  }
  async function previewTreeFile(file: { abs: string }) {
    const selected = await selectTreeFile(file);
    if (selected && get(importerOpen) && rows[index]?.abs === file.abs) previewRow(rows[index]);
  }
  async function insertTreeFile(file: { abs: string }) {
    if (picked.size) { await insertPicked(); return; }
    if (await selectTreeFile(file)) {
      const row = rows[index];
      if (row?.abs === file.abs) await insertOne(row);
    }
  }
</script>

<svelte:window on:keydown={e => { if (active && detached && e.altKey && e.code === "KeyG") { e.preventDefault(); popup?.focus(); } }} />

{#if $importerOpen}
  {#if !detached}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ibackdrop" on:pointerdown={close}></div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="iwrap" class:detached bind:this={wrapEl} on:keydown={onKey}>
    <div class="importer" inert={!!expanded} role="dialog" aria-modal={!detached} aria-label={title} tabindex="-1">
      <header class="ihead">
        <div class="heading">
          <h2 class="ttl">{title}</h2>
          <div class="navigation">
            <div class="scope-switch" role="group" aria-label="Plot scope">
              {#each GALLERY_SCOPES as sc, n (sc.id)}
                <button class:chosen={browseScope === sc.id} aria-pressed={browseScope === sc.id} data-scope={sc.id}
                  disabled={sc.id === "global" && !libraryRoot}
                  title={sc.id === "global" && !libraryRoot ? "The global plot library needs the desktop app" : `${sc.title} (Alt+${n + 1})`}
                  on:click={() => void switchScope(sc.id)}>{sc.label}</button>
              {/each}
            </div>
            <div class="path">
              <button class="rootbtn" on:click={goRoot} title={browseScope === "global" ? `Browse the whole global library · ${plotsRoot}` : "Browse all plots"}>{browseScope === "global" ? plotsRoot.split("/").pop() || "plot_library" : "plots"}</button>
              <span class="cur" title={relDir}>{relDir}</span>
              {#if cwd && cwd !== plotsRoot}<button class="upbtn" on:click={up} title="Parent folder (Backspace)">↑ Up</button>{/if}
            </div>
            <button class="refreshbtn" on:click={refresh} disabled={loading} title="Reload this folder and its previews">↻ Refresh</button>
          </div>
        </div>
        <div class="head-actions">
          {#if detached}<button class="pinbtn" on:click={dock} title="Return this gallery to the editor">↙ Dock</button>
          {:else if !onPick}<button class="pinbtn" on:click={pin} title="Keep open in a movable, resizable window">↗ Pin open</button>{/if}
          <button class="closebtn" on:click={close} aria-label="Close plot gallery">×</button>
        </div>
      </header>
      <div class="search-row">
        <svg class="mag" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
        <input bind:this={inputEl} bind:value={search} class="search-in" aria-label="Search plots" placeholder={searchHint} spellcheck="false" on:input={() => { index = 0; status = ""; }} />
        {#if search}<button class="clear-search" on:click={() => { search = ""; index = 0; focusInput(); }} aria-label="Clear search">×</button>{/if}
      </div>
      <div class="viewbar">
        <button class="tree-toggle" class:chosen={sidebar} aria-label="Toggle folder sidebar" aria-expanded={sidebar} on:click={() => { sidebar = !sidebar; rememberView(); }}>Folders</button>
        <div class="view-switch" aria-label="Gallery view">
          <button class:chosen={viewMode === "gallery"} aria-pressed={viewMode === "gallery"} on:click={() => { viewMode = "gallery"; rememberView(); }} aria-label="Gallery view">Gallery</button>
          <button class:chosen={viewMode === "list"} aria-pressed={viewMode === "list"} on:click={() => { viewMode = "list"; rememberView(); }} aria-label="List view">List</button>
        </div>
        {#if viewMode === "gallery"}
          <label class="slider">Size <input type="range" aria-label="Preview size" min="120" max="800" step="10" bind:value={previewSize} on:change={rememberView} /><output>{previewSize}</output></label>
          <label class="slider">Space <input type="range" aria-label="Preview spacing" min="4" max="32" step="2" bind:value={spacing} on:change={rememberView} /></label>
          <label class="labels"><input type="checkbox" bind:checked={labels} on:change={rememberView} /> Names</label>
        {/if}
        <span class="count">{fileCount} {browseVideos ? (fileCount === 1 ? "item" : "items") : (fileCount === 1 ? "plot" : "plots")}</span>
      </div>
      {#if similarTo}<div class="similar-filter"><span>Names similar to <strong>{similarTo}</strong>{#if !scanned} · Scanning…{/if}</span><button aria-label="Clear similar names" on:click={() => { similarTo = ""; index = 0; focusInput(); }}>× Clear</button></div>{/if}
      <div class="gallery-body">
      {#if sidebar}<aside class="folder-sidebar"><GalleryTree bind:this={tree} root={plotsRoot} currentDirectory={cwd} selectedPath={rows[index]?.abs || ""} allowVideos={browseVideos} refreshKey={treeRevision} onNavigate={navigateTree} onSelectFile={selectTreeFile} onPreviewFile={previewTreeFile} onInsertFile={insertTreeFile} /></aside>{/if}
      <div class="list" class:gallery={viewMode === "gallery"} class:without-labels={!labels} bind:this={listEl} use:trackListSize on:scroll={() => scrollTop = listEl.scrollTop}>
        {#if !root}<div class="empty">Open a Flux project to browse its plots.</div>
        {:else if !fileBridge()?.readdir}<div class="empty">Folder browsing isn't available in this build.</div>
        {:else if !rows.length && !loading && !q && !similarTo && browseScope === "global" && cwd === plotsRoot}<div class="empty" data-global-empty><strong>Your global plot library is empty</strong><span>Save SVG plots or PNG images into <code>{plotsRoot}</code> — in any folders you like — and every project can insert them from here.</span>{#if fileBridge()?.openPath}<button class="previewbtn open-library" on:click={() => void fileBridge()?.openPath?.(plotsRoot)}>Open folder</button>{/if}</div>
        {:else if !rows.length && !loading}<div class="empty"><strong>{q || similarTo ? "No matching files" : "A little space for your next result"}</strong><span>{q || similarTo ? "Try another name or return to browsing." : browseVideos ? "Save SVG plots, PNG images, or MP4/MOV clips here. Videos can live in plots/_videos/." : "Save SVG plots or PNG images into this folder to see them here."}</span></div>
        {:else}
          <div style={`height:${Math.floor(start / columns) * stride}px`} aria-hidden="true"></div>
          <div class="items" style={`--columns:${columns}; --cell-height:${cellHeight}px; --gap:${gap}px`}>
            {#each shown as r, offset (r.kind + (r.abs ?? r.name) + previewRevision)}
              {@const i = start + offset}
              {@const selected = r.kind === "file" && !!r.abs && picked.has(r.abs)}
              <button class="row" class:sel={i === index} class:picked={selected} class:folder={r.kind !== "file"} data-i={i} data-kind={r.kind} data-path={r.abs} aria-pressed={r.kind === "file" ? selected : undefined} title={r.hint || (r.kind === "file" ? `${relFor(r)} · Ctrl/⌘-click to preview` : r.name)} on:focus={() => index = i} on:pointerenter={() => index = i} on:click={e => onRowClick(e, r)} on:dblclick={e => onRowDblClick(e, r)}>
                {#if viewMode === "gallery"}
                  <span class="tile-preview">
                    {#if r.kind === "file" && r.abs}<GalleryPreview path={r.abs} {previews} />
                    {:else}<svg class="folder-icon" viewBox="0 0 48 40" aria-hidden="true"><path d="M4 10V6h15l5 5h20v23H4Z"/>{#if r.kind === "up"}<path d="m18 23 6-6 6 6m-6-6v13"/>{/if}</svg><span class="folder-caption">{r.kind === "up" ? "Parent folder" : "Folder"}</span>{/if}
                  </span>
                {/if}
                <span class="row-meta">
                  <span class="ic">{selected ? "✓" : r.kind === "dir" ? "↳" : r.kind === "up" ? "↩" : r.video ? "▶" : r.semantic ? "◆" : "◇"}</span>
                  <span class="names"><span class="nm">{r.kind === "file" ? r.name.replace(/\.(svg|png|mp4|mov)$/i, "") : r.name}</span>{#if r.hint}<span class="rel">{r.hint}</span>{:else if (q || similarTo) && r.where}<span class="rel" data-where>{r.where}</span>{/if}</span>
                  {#if r.kind === "file" && r.semantic}<span class="badge">semantic</span>{/if}
                  {#if r.snip}<span class="badge">snip</span>{/if}
                  {#if r.video}<span class="badge">video</span>{/if}
                </span>
                {#if viewMode === "gallery" && selected}<span class="pick-mark" aria-hidden="true">✓</span>{/if}
              </button>
            {/each}
          </div>
          <div style={`height:${Math.max(0, Math.ceil(rows.length / columns) - Math.ceil(end / columns)) * stride}px`} aria-hidden="true"></div>
          {#if truncated}<div class="note">Search covers the first 20,000 plots and 20 folder levels of each scope. Browse a folder to see all of its images.</div>{/if}
        {/if}
      </div>
      </div>
      {#if !q && !similarTo && cwd === plotsRoot && rootReserved.length}<div class="note reserved" data-reserved-hint>Companion collections · Browse via <b>Folders</b> or type <b>_</b> for {rootReserved.map(f => f.name).join(" and ")}.</div>{/if}
      {#if error}<div class="message error" role="alert">{error}</div>{:else if status}<div class="message" role="status">{status}</div>{/if}
      {#if inserting && importStatus}<div class="message import-progress" role="status">{importStatus}{#if cancelImport}<button on:click={cancelImport}>Cancel import</button>{/if}</div>{/if}
      <footer class="foot">
        <div class="selection-info">
          {#if pickedCount > 0}<span class="pickpill">{pickedCount} selected</span><button class="clear-picks" on:click={() => picked = new Map()}>Clear</button>{:else}<span>{allowVideos ? "Choose plots or clips to place" : "Choose plots to place"}</span>{/if}
          <span class="destination" title={destinationName}>{canInsert ? `Into ${destinationName}` : "Return to the editor to insert"}</span>
        </div>
        <span class="keyhint">Ctrl/⌘-click preview · ↵ select</span>
        <button class="previewbtn" disabled={rows[index]?.kind !== "file"} title="Full-window preview (Ctrl/⌘-click or F4)" on:click={() => previewRow(rows[index])}>{rows[index]?.video ? "▶ Play video" : "⤢ Preview"}</button>
        <button class="insbtn" disabled={inserting || !canInsert || (!pickedCount && rows[index]?.kind !== "file")} on:click={() => void insertPicked()}>{inserting ? "Inserting…" : `Insert${pickedCount ? ` ${pickedCount}` : rows[index]?.video ? " video" : rows[index]?.kind === "file" || !allowVideos ? " plot" : ""}`}<span aria-hidden="true"> ↗</span></button>
      </footer>
    </div>
    {#if expanded}
      {#key expanded.abs + ":" + detached}
        <GalleryExpandedPreview file={expanded} {root} dissections={expanded.scope === "project"} refreshKey={previewRevision} initialAutoplay={!!expanded.video} onClose={closePreview} onSimilar={summonSimilar} onPrevious={previewIndex > 0 ? () => stepPreview(-1) : undefined} onNext={previewIndex >= 0 && previewIndex < previewFiles.length - 1 ? () => stepPreview(1) : undefined} />
      {/key}
    {/if}
  </div>
{/if}

<style>
  /* One calm technical surface (2026-09-15 surface redesign, SURFACE_SPEC):
     hairline-divided strips, flat fills, square rows/tiles, quiet tints. */
  .ibackdrop { position:fixed; inset:0; background:rgba(0,0,0,.2); z-index:320; }
  .iwrap { position:fixed; inset:0; z-index:321; display:flex; align-items:center; justify-content:center; padding:28px; pointer-events:none; }
  .importer { pointer-events:auto; width:1280px; height:880px; max-width:100%; max-height:100%; display:flex; flex-direction:column; border-radius:var(--r-panel); color:var(--c-tx); font:12px/1.35 var(--font-ui); -webkit-font-smoothing:antialiased; overflow:hidden; background:var(--c-surface); border:1px solid var(--c-line-strong); box-shadow:var(--elev-2); outline:none; }
  .detached { padding:0; }
  .detached .importer { width:100%; height:100%; border:0; border-radius:0; box-shadow:none; }
  button { font:inherit; color:inherit; cursor: var(--cursor-cross-hover); }
  button:focus-visible { outline:1px solid var(--c-accent); outline-offset:1px; }
  button:disabled { opacity:.4; cursor: var(--cursor-cross); }
  /* controls: bordered, 24px, barely rounded */
  .pinbtn, .previewbtn, .tree-toggle, .import-progress button { display:inline-flex; align-items:center; height:24px; padding:3px 8px; background:transparent; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); color:var(--c-tx); white-space:nowrap; }
  .pinbtn:hover, .previewbtn:hover:not(:disabled), .tree-toggle:hover, .import-progress button:hover { border-color:var(--c-tx-muted); color:var(--c-tx-hi); }
  .tree-toggle.chosen { background:var(--c-accent-tint); border-color:var(--c-accent); color:var(--c-tx-hi); }
  /* header: one 32px line — title · breadcrumb · refresh … pin · close */
  .ihead { display:flex; align-items:center; gap:12px; height:32px; flex-shrink:0; padding:0 8px 0 12px; background:var(--c-bg-raised); border-bottom:1px solid var(--c-line); }
  .heading { display:flex; align-items:center; gap:12px; flex:1; min-width:0; }
  .ttl { margin:0; flex-shrink:1; min-width:0; font:600 12px/1.35 var(--font-ui); color:var(--c-tx-hi); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .navigation { display:flex; align-items:center; gap:10px; flex:1; min-width:0; padding-left:12px; border-left:1px solid var(--c-line-strong); }
  .path { display:flex; gap:6px; align-items:center; min-width:0; font:11.5px var(--font-mono); }
  .cur { color:var(--c-tx-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cur:not(:empty)::before { content:"/ "; color:var(--c-tx-faint); }
  .scope-switch { display:inline-flex; flex-shrink:0; height:22px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); overflow:hidden; }
  .scope-switch button { border:0; border-radius:0; background:none; padding:0 8px; font-size:11px; color:var(--c-tx-2); }
  .scope-switch button + button { border-left:1px solid var(--c-line-strong); }
  .scope-switch button:hover:not(:disabled) { color:var(--c-tx-hi); }
  .scope-switch .chosen { background:var(--c-accent-tint); color:var(--c-tx-hi); }
  .empty code { font:11px var(--font-mono); color:var(--c-tx-2); word-break:break-all; }
  .empty .open-library { align-self:center; margin-top:8px; }
  .rootbtn, .upbtn, .refreshbtn, .clear-picks { background:none; border:0; padding:0; white-space:nowrap; }
  .rootbtn { color:var(--c-tx-2); }
  .rootbtn:hover { color:var(--c-tx-hi); }
  .upbtn, .refreshbtn, .clear-picks { color:var(--c-tx-muted); font-size:11px; }
  .upbtn:hover, .refreshbtn:hover:not(:disabled), .clear-picks:hover { color:var(--c-tx-hi); }
  .refreshbtn { margin-left:auto; }
  .head-actions { display:flex; gap:6px; align-items:center; flex-shrink:0; }
  .closebtn { width:24px; height:24px; padding:0; background:none; border:0; border-radius:var(--r-ui); font-size:16px; line-height:1; color:var(--c-tx-muted); }
  .closebtn:hover { color:var(--c-tx-hi); background:var(--c-surface-2); }
  /* search: flat, full-width, 30px */
  .search-row { display:flex; gap:8px; align-items:center; height:30px; flex-shrink:0; padding:0 12px; background:var(--c-bg); border-bottom:1px solid var(--c-line); }
  .search-row:focus-within { border-bottom-color:var(--c-accent); }
  .mag { width:14px; height:14px; fill:none; stroke:var(--c-tx-muted); stroke-width:1.6; flex-shrink:0; }
  .search-in { flex:1; min-width:0; height:100%; padding:0; border:0; outline:0; background:none; color:var(--c-tx); font:12px var(--font-mono); }
  .search-in::placeholder { color:var(--c-tx-muted); }
  .clear-search { width:20px; height:20px; padding:0; border:0; border-radius:var(--r-ui); background:none; color:var(--c-tx-muted); font-size:14px; line-height:1; }
  .clear-search:hover { color:var(--c-tx-hi); background:var(--c-surface-2); }
  /* view bar: 30px strip */
  .viewbar { display:flex; align-items:center; flex-wrap:wrap; gap:4px 12px; min-height:30px; flex-shrink:0; padding:2px 12px; background:var(--c-bg-raised); border-bottom:1px solid var(--c-line); font-size:11px; color:var(--c-tx-muted); }
  .view-switch { display:inline-flex; height:24px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); overflow:hidden; }
  .view-switch button { border:0; border-radius:0; background:none; padding:0 8px; font-size:11px; color:var(--c-tx); }
  .view-switch button + button { border-left:1px solid var(--c-line-strong); }
  .view-switch button:hover { color:var(--c-tx-hi); }
  .view-switch .chosen { background:var(--c-accent-tint); color:var(--c-tx-hi); }
  .slider { display:flex; gap:6px; align-items:center; white-space:nowrap; }
  .slider output { min-width:3ch; font:11px var(--font-mono); font-variant-numeric:tabular-nums; }
  input[type="range"] { width:72px; height:14px; margin:0; accent-color:var(--c-accent); }
  .labels { display:flex; align-items:center; gap:5px; white-space:nowrap; }
  input[type="checkbox"] { accent-color:var(--c-accent); margin:0; }
  .count { margin-left:auto; white-space:nowrap; font:11px var(--font-mono); font-variant-numeric:tabular-nums; }
  .similar-filter { display:flex; gap:12px; align-items:center; justify-content:space-between; min-height:28px; flex-shrink:0; padding:2px 12px; background:var(--c-surface); border-bottom:1px solid var(--c-line); color:var(--c-tx-2); }
  .similar-filter span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .similar-filter strong { color:var(--c-tx-hi); font-weight:600; }
  .similar-filter button { border:0; background:none; padding:0; color:var(--c-tx-muted); white-space:nowrap; }
  .similar-filter button:hover { color:var(--c-tx-hi); }
  /* body: folder sidebar | list */
  .gallery-body { display:flex; flex:1; min-height:0; overflow:hidden; position:relative; }
  .folder-sidebar { flex:0 0 auto; width:240px; min-width:150px; max-width:40%; border-right:1px solid var(--c-line); background:var(--c-bg-raised); resize:horizontal; overflow:auto; }
  .list { flex:1; min-width:0; min-height:0; overflow:auto; padding:16px; background:var(--c-bg); scrollbar-gutter:stable; }
  .list:not(.gallery) { padding:0; }
  .items { display:grid; grid-template-columns:repeat(var(--columns), minmax(0,1fr)); gap:var(--gap); grid-auto-rows:var(--cell-height); }
  /* list rows: 28px, hairline-separated */
  .row { position:relative; display:flex; align-items:center; min-width:0; padding:0 12px; border:0; border-bottom:1px solid var(--c-line); border-radius:var(--r-0); background:transparent; text-align:left; overflow:hidden; }
  .row:focus-visible { outline-offset:-1px; }
  .row:hover, .row.sel { background:var(--c-surface-2); }
  .row.picked { background:var(--c-accent-tint); box-shadow:inset 2px 0 0 var(--c-accent); color:var(--c-tx-hi); }
  .row.picked.sel { background:color-mix(in oklab, var(--c-accent) 24%, transparent); }
  .list:not(.gallery) .names { flex-direction:row; align-items:baseline; gap:8px; }
  /* gallery tiles: square, flat, quiet */
  .gallery .row { flex-direction:column; align-items:stretch; padding:6px; border:1px solid var(--c-line); background:var(--c-bg-raised); box-shadow:none; }
  .gallery .row:hover, .gallery .row.sel { border-color:var(--c-line-strong); background:var(--c-surface); }
  .gallery .row.picked { border-color:var(--c-accent); background:var(--c-accent-tint); box-shadow:none; }
  .gallery .row.picked.sel { background:color-mix(in oklab, var(--c-accent) 24%, transparent); }
  .tile-preview { flex:1; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center; border-radius:var(--r-0); overflow:hidden; }
  .folder .tile-preview { background:var(--c-surface); }
  .folder-icon { width:40px; height:34px; fill:none; stroke:var(--c-tx-muted); stroke-width:1.2; }
  .folder-caption { margin-top:8px; font:600 10px var(--font-mono); text-transform:uppercase; letter-spacing:.08em; color:var(--c-tx-muted); }
  .row-meta { display:flex; align-items:center; width:100%; min-width:0; gap:8px; }
  .gallery .row-meta { height:38px; flex-shrink:0; padding:6px 2px 0; }
  .names { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
  .nm { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
  .rel { font:10px var(--font-mono); color:var(--c-tx-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ic { width:14px; flex:0 0 14px; text-align:center; color:var(--c-tx-muted); font-size:11px; }
  .picked .ic { color:var(--c-accent); }
  .badge { margin-left:auto; padding:0 4px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); font:600 9px/14px var(--font-mono); text-transform:uppercase; letter-spacing:.06em; color:var(--c-tx-muted); }
  .gallery .badge { display:none; }
  .pick-mark { position:absolute; right:10px; top:10px; width:16px; height:16px; background:var(--c-accent); color:var(--c-on-accent); border-radius:var(--r-ui); text-align:center; font:600 11px/16px var(--font-mono); }
  .gallery.without-labels .row:not(.folder) .row-meta { display:none; }
  .empty { display:flex; flex-direction:column; gap:6px; padding:60px 20px; text-align:center; color:var(--c-tx-muted); font-size:12px; }
  .empty strong { font-size:13px; font-weight:600; color:var(--c-tx); }
  .note { padding:8px 12px; color:var(--c-tx-muted); font-size:11px; }
  .reserved { flex-shrink:0; padding:7px 12px; line-height:14px; border-top:1px solid var(--c-line); background:var(--c-bg-raised); }
  .reserved b { color:var(--c-tx-2); font-weight:600; }
  .message { flex-shrink:0; padding:7px 12px; line-height:14px; color:var(--c-tx-2); font-size:12px; border-top:1px solid var(--c-line); background:var(--c-bg-raised); }
  .message.error { color:var(--c-danger); }
  .import-progress { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:28px; padding:2px 12px; }
  /* footer: 40px strip, one primary action */
  .foot { display:flex; align-items:center; gap:12px; height:40px; flex-shrink:0; padding:0 12px; border-top:1px solid var(--c-line); background:var(--c-bg-raised); color:var(--c-tx-muted); }
  .selection-info { display:flex; gap:8px; align-items:center; min-width:0; flex:1; white-space:nowrap; overflow:hidden; }
  .pickpill { padding:0 6px; border-radius:var(--r-ui); background:var(--c-accent-tint); color:var(--c-tx-hi); font:600 11px/18px var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .destination { min-width:0; overflow:hidden; text-overflow:ellipsis; padding-left:8px; border-left:1px solid var(--c-line-strong); font-size:11px; }
  .keyhint { font:10.5px var(--font-mono); white-space:nowrap; color:var(--c-tx-faint); }
  .insbtn { display:inline-flex; align-items:center; height:24px; padding:3px 10px; background:var(--c-accent); color:var(--c-on-accent); border:1px solid var(--c-accent); border-radius:var(--r-ui); font-weight:600; white-space:nowrap; }
  .insbtn:hover:not(:disabled) { background:var(--c-accent-bright); border-color:var(--c-accent-bright); }
  @media (max-width:640px) { .iwrap:not(.detached) { padding:12px; } .ihead, .search-row, .viewbar, .similar-filter, .reserved, .message, .foot { padding-left:8px; padding-right:8px; } .viewbar { gap:4px 8px; } .slider output { display:none; } .keyhint { display:none; } .folder-sidebar { width:180px; } .foot { gap:8px; } }
</style>
