<script lang="ts">
  // The Plots rail's GALLERY pane: the project's plots (or the global library) as one continuous
  // scroll. Folders are sticky section headers (not places you navigate into); tiles sit in
  // justified rows at their true aspect, each on the backdrop the law chose for it. Click selects
  // (and makes that plot the Dissections pane's focus); double-click / Enter places the selection
  // in the active figure; drag places at the pointer; Space is Quick Look. Recent sort is one
  // newest-first list. Typing "_" offers the reserved companion collections.
  import { tick, untrack } from "svelte";
  import { get } from "svelte/store";
  import JustifiedGrid, { type GridItem, type GridSection, type TileFlags } from "./JustifiedGrid.svelte";
  import Tile from "./Tile.svelte";
  import RailMenu, { type RailMenuItem } from "./RailMenu.svelte";
  import GalleryExpandedPreview from "../plot/GalleryExpandedPreview.svelte";
  import { createPlotIndex, type PlotIndex, type PlotItem, type IndexState } from "./plotIndex";
  import { railPrefs, toggledFolders, saveToggledFolders, isCollapsed, TILE_H_MIN, TILE_H_MAX } from "./railPrefs";
  import { railQuickLook, plotsRailFocusRequest, takeRailFocus } from "./railState";
  import { offerFile, resolvePlotElement } from "./focusPlot";
  import { beginPlotDrag } from "./dragPlace";
  import { insertPlots } from "./insert";
  import { RESERVED_PLOT_FOLDERS } from "../project/plotsFolders";
  import { plotKeyFor } from "../dissect/rules";
  import { fileBridge, joinPath } from "../project/types";
  import { project, activeFigureId, selection, partSelection, embeddedProjectRoot, projectDir } from "../store";
  import { pushToast } from "../toast";
  import type { HitBridgeHolder } from "../interact/canvasHitBridge";

  let {
    active = true,
    hitBridge = null,
    refreshKey = 0,
    onShowDissections,
  }: {
    active?: boolean;
    hitBridge?: HitBridgeHolder | null;
    /** Bumped by the rail's ⋯ Refresh. */
    refreshKey?: number;
    /** A ⧉ chip / "Show dissections": make sure the Dissections pane is visible. */
    onShowDissections?: () => void;
  } = $props();

  const root = $derived($embeddedProjectRoot || $projectDir || "");
  const scope = $derived($railPrefs.scope);
  let collectionState = $state({ key: "", owner: "" });
  // A collection belongs to the project+scope it was entered in (switching either leaves it —
  // derived, so the index is built once for the new place, never for the stale collection).
  const collection = $derived(collectionState.owner === `${root}|${scope}` ? collectionState.key : "");
  let search = $state("");
  let searchEl = $state<HTMLInputElement>();
  let grid = $state<ReturnType<typeof JustifiedGrid>>();
  let libraryRoot = $state("");

  // ------------------------------------------------------------------ the index
  let index = $state.raw<PlotIndex | null>(null);
  const EMPTY: IndexState = { items: [], base: "", loading: false, loaded: false, truncated: false, error: "", version: 0 };
  // Raw: the index can hold 20,000 items — never deep-proxy them.
  let ix = $state.raw<IndexState>(EMPTY);
  let counts = $state.raw<Map<string, number>>(new Map());

  $effect(() => {
    const r = root, sc = scope, col = collection;
    if (!r && sc === "project") { index = null; ix = EMPTY; return; }
    const created = createPlotIndex({ scope: sc, collection: col || undefined, accept: "svg,png,glb", watch: true });
    index = created;
    const offState = created.subscribe((v) => { ix = v; });
    const offCounts = created.counts.subscribe((m) => { counts = m; });
    void created.load();
    return () => { offState(); offCounts(); created.dispose(); };
  });
  // Leaving the project or scope resets the browsing state that belonged to it.
  $effect(() => { root; scope; untrack(() => { selected = new Set(); focusId = ""; }); });
  $effect(() => {
    const k = refreshKey;
    if (k) untrack(() => void index?.refresh());
  });
  $effect(() => {
    void fileBridge()?.prefsGet?.().then((p) => { libraryRoot = typeof p?.plotLibraryResolved === "string" ? p.plotLibraryResolved : ""; }).catch(() => {});
  });
  // The global library is not watched: re-list when the rail regains the keyboard (≤ every 5 s).
  let lastLibraryRefresh = 0;
  function onFocusIn() {
    if (scope === "global" && Date.now() - lastLibraryRefresh > 5000) { lastLibraryRefresh = Date.now(); void index?.refresh(); }
  }

  // Placed sizes (header probes) for everything listed, in display order — layout first.
  $effect(() => {
    const st = ix, ixr = index;
    if (!ixr || !st.loaded) return;
    const missing = displayItems.filter((i) => !i.w).map((i) => i.abs);
    if (missing.length) untrack(() => void ixr.ensureSizes(missing));
  });

  // ------------------------------------------------------------------ what is shown
  const q = $derived(search.trim().toLowerCase());
  let toggled = $state.raw<Set<string>>(new Set());
  const base = $derived(ix.base);
  $effect(() => { const r = base; toggled = r ? toggledFolders(r) : new Set(); });

  let reservedHere = $state.raw<{ name: string; hint: string }[]>([]);
  $effect(() => {
    const base = scope === "project" && root ? joinPath(root, "plots") : scope === "global" ? libraryRoot : "";
    reservedHere = [];
    if (!base) return;
    let alive = true;
    void Promise.all(RESERVED_PLOT_FOLDERS.map(async (f) => ((await fileBridge()?.exists?.(joinPath(base, f.name))) ? f : null))).then((found) => {
      if (alive) reservedHere = found.filter((f): f is (typeof RESERVED_PLOT_FOLDERS)[number] => !!f);
    });
    return () => { alive = false; };
  });

  const matches = $derived.by(() => {
    void ix.version;
    if (q.startsWith("_") && !collection) return [];
    if (!q) return ix.items;
    return ix.items.filter((it) => it.rel.toLowerCase().includes(q));
  });
  const recent = $derived($railPrefs.sort === "recent");
  const rootLabel = $derived(collection || (scope === "global" ? (libraryRoot.split(/[\\/]/).pop() || "plot_library") : "plots"));

  const sections: GridSection[] = $derived.by(() => {
    void ix.version;
    const out: GridSection[] = [];
    if (q.startsWith("_") && !collection) {
      const rows = reservedHere.filter((f) => f.name.includes(q));
      out.push({ key: "reserved", title: "Companion collections", meta: rows.length ? "" : " · none here", depth: 0, collapsed: false, collapsible: false, headerH: 24,
        items: rows.map((f) => ({ id: `reserved:${f.name}`, aspect: 1, block: 30, data: { reserved: f } })) });
      return out;
    }
    if (recent) {
      const items = [...matches].sort((a, b) => b.mtimeMs - a.mtimeMs);
      out.push({ key: "recent", title: "", depth: 0, collapsed: false, collapsible: false, headerH: 0, items: items.map(toGrid) });
      return out;
    }
    let cur: GridSection | null = null;
    for (const it of matches) {
      if (!cur || cur.key !== `dir:${it.dir}`) {
        const depth = it.dir ? it.dir.split("/").length : 0;
        cur = { key: `dir:${it.dir}`, title: it.dir || rootLabel, depth: Math.min(3, depth), collapsed: !q && isCollapsed(it.dir, toggled), collapsible: true, headerH: 24, items: [] };
        out.push(cur);
      }
      cur.items.push(toGrid(it));
    }
    for (const s of out) s.meta = `· ${s.items.length}`;
    return out;
  });
  function toGrid(it: PlotItem): GridItem {
    return { id: it.abs, aspect: it.w && it.h ? it.w / it.h : 4 / 3, data: it };
  }
  /** The items in display order (expanded sections only) — Quick Look stepping, ranges, probes. */
  const displayItems = $derived(sections.filter((s) => !s.collapsed).flatMap((s) => s.items.map((i) => i.data as PlotItem)).filter((x) => x && "abs" in x));
  const fileCount = $derived(ix.items.length);

  // ------------------------------------------------------------------ canvas linkage
  // Paths compare with forward slashes: the worker reports native paths (\\ on Windows), element
  // sources and the renderer's joinPath use /.
  const slash = (p: string) => p.replace(/\\/g, "/");
  const absOf = (p: string) => slash(/^([a-zA-Z]:)?[\\/]/.test(p) ? p : root ? joinPath(root, p) : p);
  const idBySlash = $derived.by(() => { void ix.version; const m = new Map<string, string>(); for (const it of ix.items) m.set(slash(it.abs), it.abs); return m; });
  const linkedId = $derived.by(() => {
    const el = resolvePlotElement($project, $selection, $partSelection);
    const src = el?.type === "plot" ? el.source?.svgPath : "";
    return src ? idBySlash.get(absOf(src)) ?? "" : "";
  });
  let lastRevealed = "";
  $effect(() => {
    const id = linkedId;
    if (!active || !$railPrefs.autoReveal || !id || id === lastRevealed) return;
    lastRevealed = id;
    untrack(() => {
      const it = ix.items.find((i) => i.abs === id);
      if (it && !q && !recent && isCollapsed(it.dir, toggled)) toggleFolder(it.dir);
      void tick().then(() => grid?.reveal(id, "center"));
    });
  });

  const usage = $derived.by(() => {
    const m = new Map<string, { active: boolean; count: number }>();
    for (const f of $project.figures) for (const el of f.elements) {
      const src = el.type === "plot" ? el.source?.svgPath : "";
      if (!src) continue;
      const abs = absOf(src);
      const e = m.get(abs) ?? { active: false, count: 0 };
      e.count++;
      if (f.id === $activeFigureId) e.active = true;
      m.set(abs, e);
    }
    return m;
  });
  const destination = $derived($project.figures.find((f) => f.id === $activeFigureId)?.background ?? null);

  // ------------------------------------------------------------------ selection + focus
  let selected = $state.raw<Set<string>>(new Set());
  let focusId = $state("");
  let anchorId = "";
  let suppressClick = false;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  function itemOf(g: GridItem): PlotItem | null { const d = g.data as PlotItem; return d && "abs" in d ? d : null; }
  function focusPlotFor(it: PlotItem, delay = 0) {
    if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
    const go = () => offerFile(it.abs, root, scope);
    if (delay) focusTimer = setTimeout(go, delay); else go();
  }
  function onPress(g: GridItem, e: MouseEvent) {
    if (suppressClick) { suppressClick = false; return; }
    const res = (g.data as { reserved?: { name: string } }).reserved;
    if (res) { enterCollection(res.name); return; }
    const it = itemOf(g);
    if (!it) return;
    if (e.shiftKey && anchorId) {
      const order = displayItems.map((i) => i.abs);
      const a = order.indexOf(anchorId), b = order.indexOf(it.abs);
      if (a >= 0 && b >= 0) selected = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(it.abs)) next.delete(it.abs); else next.add(it.abs);
      selected = next;
      anchorId = it.abs;
    } else {
      selected = new Set([it.abs]);
      anchorId = it.abs;
    }
    focusId = it.abs;
    focusPlotFor(it);
    grid?.focusGrid();
  }
  function onOpen(g: GridItem, e: MouseEvent) {
    const it = itemOf(g);
    if (!it || e.ctrlKey || e.metaKey || e.shiftKey) return;
    void insert(selected.has(it.abs) ? orderedSelection() : [it.abs]);
  }
  function orderedSelection(): string[] {
    const order = displayItems.map((i) => i.abs).filter((a) => selected.has(a));
    // Selected files no longer displayed (search changed) still count, after the visible ones.
    for (const a of selected) if (!order.includes(a)) order.push(a);
    return order;
  }
  async function insert(paths: string[], at?: { figId: string; x: number; y: number; fx: number; fy: number }) {
    if (!paths.length) return;
    await insertPlots(paths, at);
  }

  // ------------------------------------------------------------------ drag to place
  function onPointerDown(g: GridItem, e: PointerEvent) {
    const it = itemOf(g);
    if (!it) return;
    // Read now: currentTarget is gone once the event has dispatched.
    const cell = e.currentTarget as HTMLElement;
    beginPlotDrag(e, () => {
      const pageEl = cell.querySelector<HTMLElement>(".page");
      if (!pageEl) return null;
      const paths = selected.has(it.abs) ? [it.abs, ...orderedSelection().filter((p) => p !== it.abs)] : [it.abs];
      const img = pageEl.querySelector<HTMLImageElement>("img");
      return {
        paths,
        thumbUrl: img?.src ?? "",
        tileRect: pageEl.getBoundingClientRect(),
        placed: it.w && it.h ? { w: it.w, h: it.h } : null,
        backdrop: getComputedStyle(pageEl).backgroundColor || null,
      };
    }, hitBridge, {
      onStart: () => { suppressClick = true; },
      onEnd: () => { setTimeout(() => { suppressClick = false; }, 0); },
      onDrop: (fig, at, paths) => { void insert(paths, { figId: fig.id, ...at }); },
      onMiss: () => pushToast("info", "Drop onto a figure to place it"),
    });
  }

  // ------------------------------------------------------------------ quick look
  let quick = $state.raw<PlotItem | null>(null);
  $effect(() => { railQuickLook.set(!!quick); });
  $effect(() => () => railQuickLook.set(false));
  const quickIndex = $derived(quick ? displayItems.findIndex((i) => i.abs === quick!.abs) : -1);
  function openQuick(it: PlotItem | null) { if (it) quick = it; }
  function stepQuick(d: number) {
    const next = displayItems[quickIndex + d];
    if (next) { quick = next; focusId = next.abs; selected = new Set([next.abs]); anchorId = next.abs; void tick().then(() => grid?.reveal(next.abs)); }
  }
  function closeQuick() { quick = null; void tick().then(() => grid?.focusGrid()); }

  // ------------------------------------------------------------------ menus
  let menu = $state.raw<{ x: number; y: number; items: RailMenuItem[] } | null>(null);
  function onContext(g: GridItem, e: MouseEvent) {
    const it = itemOf(g);
    if (!it) return;
    e.preventDefault();
    if (!selected.has(it.abs)) { selected = new Set([it.abs]); anchorId = it.abs; }
    focusId = it.abs;
    focusPlotFor(it);
    const paths = orderedSelection();
    const fig = $project.figures.find((f) => f.id === $activeFigureId);
    const fb = fileBridge();
    menu = { x: e.clientX, y: e.clientY, items: [
      { kind: "action", label: paths.length > 1 ? `Place ${paths.length} plots in ${fig?.nickname || fig?.name || "the figure"}` : `Place in ${fig?.nickname || fig?.name || "the figure"}`, hint: "Enter", disabled: !fig, run: () => void insert(paths) },
      { kind: "action", label: "Quick Look", hint: "Space", run: () => openQuick(it) },
      ...(scope === "project" ? [{ kind: "action" as const, label: "Show dissections", run: () => { offerFile(it.abs, root, scope); onShowDissections?.(); } }] : []),
      { kind: "separator" },
      { kind: "action", label: "Reveal in file manager", disabled: !fb?.revealPath, run: () => void fb?.revealPath?.(it.abs) },
      { kind: "action", label: "Copy path", run: () => void navigator.clipboard?.writeText(it.abs).catch(() => {}) },
    ] };
  }

  // ------------------------------------------------------------------ folders / collections
  function toggleFolder(dir: string) {
    const next = new Set(toggled);
    if (next.has(dir)) next.delete(dir); else next.add(dir);
    toggled = next;
    if (ix.base) saveToggledFolders(ix.base, next);
  }
  function onHeaderToggle(s: GridSection, e: MouseEvent) {
    if (!s.key.startsWith("dir:")) return;
    const dir = s.key.slice(4);
    // Alt+click: this folder only — collapse every other one (and expand this).
    if (e.altKey) {
      const dirs = [...new Set(ix.items.map((i) => i.dir))];
      const next = new Set<string>();
      for (const d of dirs) { const wantCollapsed = d !== dir; if (wantCollapsed !== (d.split("/").filter(Boolean).length >= 2)) next.add(d); }
      toggled = next;
      if (ix.base) saveToggledFolders(ix.base, next);
      return;
    }
    toggleFolder(dir);
  }
  function enterCollection(name: string) {
    collectionState = { key: name, owner: `${root}|${scope}` }; search = "";
    void tick().then(() => grid?.scrollToTop());
  }
  function leaveCollection() { collectionState = { key: "", owner: "" }; void tick().then(() => searchEl?.focus()); }

  // ------------------------------------------------------------------ keyboard
  function onGridKey(e: KeyboardEvent, focused: GridItem | null) {
    const it = focused ? itemOf(focused) : null;
    if (e.key === "Enter") {
      e.preventDefault();
      const res = focused && (focused.data as { reserved?: { name: string } }).reserved;
      if (res) { enterCollection(res.name); return; }
      const paths = selected.size ? orderedSelection() : it ? [it.abs] : [];
      void insert(paths);
      return;
    }
    if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openQuick(it);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (search) { search = ""; searchEl?.focus(); return; }
      if (collection) { leaveCollection(); return; }
      (e.currentTarget as HTMLElement).blur();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selected = new Set(displayItems.map((i) => i.abs));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+" || e.key === "-")) {
      e.preventDefault();
      zoom(e.key === "-" ? -1 : 1, focusId || grid?.firstVisibleId() || "");
      return;
    }
    // Typing goes to search (no single-letter commands live in the grid).
    if (e.key === "/" || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      e.preventDefault();
      if (e.key !== "/") search += e.key;
      searchEl?.focus();
    }
  }
  function onFocusChange(g: GridItem) {
    focusId = g.id;
    const it = itemOf(g);
    if (it) { selected = new Set([it.abs]); anchorId = it.abs; focusPlotFor(it, 60); }
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const first = displayItems[0];
      const firstReserved = sections[0]?.key === "reserved" ? sections[0].items[0] : null;
      if (firstReserved && e.key === "Enter") { enterCollection((firstReserved.data as { reserved: { name: string } }).reserved.name); return; }
      if (first && !focusId) { focusId = first.abs; selected = new Set([first.abs]); anchorId = first.abs; focusPlotFor(first); }
      grid?.focusGrid();
      if (focusId) grid?.reveal(focusId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (search) search = "";
      else if (collection) leaveCollection();
      else searchEl?.blur();
    } else if (e.key === "Backspace" && !search && collection) {
      e.preventDefault();
      leaveCollection();
    }
  }
  function onRootKey(e: KeyboardEvent) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "Digit1" || e.code === "Digit2")) {
      e.preventDefault();
      setScope(e.code === "Digit1" ? "project" : "global");
    }
  }
  function setScope(sc: "project" | "global") {
    if (sc === "global" && !libraryRoot) return;
    railPrefs.update((p) => ({ ...p, scope: sc }));
  }
  $effect(() => {
    void $plotsRailFocusRequest;
    if (active) untrack(() => { if (takeRailFocus()) void tick().then(() => { searchEl?.focus(); searchEl?.select(); }); });
  });

  // ------------------------------------------------------------------ zoom + visible work
  function zoom(dir: number, anchor: string) {
    const y = anchor ? grid?.screenYOf(anchor) ?? null : null;
    railPrefs.update((p) => ({ ...p, tileH: Math.max(TILE_H_MIN, Math.min(TILE_H_MAX, Math.round(p.tileH * (dir > 0 ? 1.15 : 1 / 1.15)))) }));
    if (anchor && y != null) void tick().then(() => grid?.anchorTo(anchor, y));
  }
  function onScrollState(s: { firstVisible: number }) {
    if (scope !== "project" || !index) return;
    const near = displayItems.slice(Math.max(0, s.firstVisible - 20), s.firstVisible + 80);
    const keys = near.map((i) => plotKeyFor(i.abs, root)).filter(Boolean);
    untrack(() => index?.ensureCounts(keys));
  }
  function dissectionsFor(it: PlotItem): number {
    if (scope !== "project" || collection) return 0;
    return counts.get(plotKeyFor(it.abs, root)) ?? 0;
  }
  const glyphFor = (it: PlotItem) => (it.model3d ? "3D" : it.snip ? "✂" : it.semantic ? "◆" : "");
  const glyphTitle = (it: PlotItem) => (it.model3d ? "3D model" : it.snip ? "Paper snip" : it.semantic ? "Fluxplot — editable parts and data" : "");
  const emptyText = $derived(
    !root && scope === "project" ? "Open a Flux project to browse its plots."
    : ix.error ? ix.error
    : !ix.loaded ? ""
    : q && !matches.length && !q.startsWith("_") ? `No plots match “${search.trim()}”.`
    : !fileCount ? (scope === "global" ? "Your global plot library is empty." : collection ? `${collection} is empty.` : "No plots yet — save SVG or PNG plots into plots/ and they appear here.")
    : "");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gallery" onkeydown={onRootKey} onfocusin={onFocusIn} data-plots-gallery>
  <div class="search-row">
    <svg class="mag" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
    {#if collection}<button class="chip-collection" title="Leave this collection (Backspace)" onclick={leaveCollection}>{collection} ✕</button>{/if}
    <input
      bind:this={searchEl}
      bind:value={search}
      class="search"
      aria-label="Search plots"
      placeholder={scope === "global" ? "Search the library" : collection ? `Search ${collection}` : "Search plots"}
      title="Search by name or folder · type _ for the companion collections"
      spellcheck="false"
      onkeydown={onSearchKey}
      data-plots-search />
    {#if search}<button class="clear" aria-label="Clear search" onclick={() => { search = ""; searchEl?.focus(); }}>×</button>{/if}
    <div class="scope" role="group" aria-label="Plot scope">
      <button class:chosen={scope === "project"} aria-pressed={scope === "project"} title="This project's plots (Alt+1)" onclick={() => setScope("project")} data-scope="project">Proj</button>
      <button class:chosen={scope === "global"} aria-pressed={scope === "global"} disabled={!libraryRoot} title={libraryRoot ? "Your global plot library (Alt+2)" : "The global plot library needs the desktop app"} onclick={() => setScope("global")} data-scope="global">Glob</button>
    </div>
  </div>
  {#if recent && !q.startsWith("_")}<div class="mode-note" data-recent-note>Newest first · <button onclick={() => railPrefs.update((p) => ({ ...p, sort: "folders" }))}>show folders</button></div>{/if}
  <JustifiedGrid
    bind:this={grid}
    {sections}
    rowHeight={$railPrefs.tileH}
    captionH={$railPrefs.names ? 14 : 0}
    minAspect={$railPrefs.names ? 0.6 : 0.33}
    {selected}
    {focusId}
    {linkedId}
    label="Plots"
    {emptyText}
    onItemPress={onPress}
    onItemOpen={onOpen}
    onItemContext={onContext}
    onItemPointerDown={onPointerDown}
    {onHeaderToggle}
    {onFocusChange}
    onKeyDown={onGridKey}
    onZoom={(d, id) => zoom(d, id)}
    {onScrollState}>
    {#snippet tile(g: GridItem, w: number, h: number, flags: TileFlags)}
      {@const res = (g.data as { reserved?: { name: string; hint: string } }).reserved}
      {#if res}
        <div class="reserved-row" data-reserved={res.name}><span class="arrow">↳</span><b>{res.name}</b><span class="hint">{res.hint}</span></div>
      {:else}
        {@const it = g.data as PlotItem}
        <Tile
          path={it.abs}
          stamp={it.stamp}
          aspect={g.aspect}
          {w}
          {h}
          captionH={$railPrefs.names ? 14 : 0}
          name={recent && it.dir ? `${it.dir}/${it.name.replace(/\.(svg|png|glb)$/i, "")}` : it.name.replace(/\.(svg|png|glb)$/i, "")}
          title={`${it.rel}${it.bad ? `\nPreview failed: ${it.bad}` : ""}\nDouble-click or Enter places it · drag onto a figure · Space for Quick Look`}
          stats={it.stats ?? null}
          paper={it.paper ?? null}
          backdrop={$railPrefs.backdrop}
          {destination}
          selected={flags.selected}
          focused={flags.focused}
          linked={flags.linked}
          priority={flags.priority}
          inUse={usage.get(slash(it.abs)) ?? null}
          dissections={dissectionsFor(it)}
          glyph={glyphFor(it)}
          glyphTitle={glyphTitle(it)}
          onDissections={() => { offerFile(it.abs, root, scope); onShowDissections?.(); }} />
      {/if}
    {/snippet}
  </JustifiedGrid>
  {#if ix.truncated}<div class="note">Showing the first 20,000 plots. Search or open a collection to reach the rest.</div>{/if}
  {#if scope === "global" && ix.loaded && !fileCount && libraryRoot && fileBridge()?.openPath}
    <div class="note"><button class="link" onclick={() => void fileBridge()?.openPath?.(libraryRoot)}>Open the library folder</button> — save SVG plots there, in any folders.</div>
  {/if}
  {#if menu}<RailMenu items={menu.items} x={menu.x} y={menu.y} label="Plot actions" onClose={() => (menu = null)} />{/if}
</div>
{#if quick}
  {#key quick.abs}
    <GalleryExpandedPreview
      file={{ abs: quick.abs, name: quick.name, rel: quick.rel, model3d: quick.model3d }}
      root={root}
      dissections={scope === "project" && !collection}
      onClose={closeQuick}
      onPrevious={quickIndex > 0 ? () => stepQuick(-1) : undefined}
      onNext={quickIndex >= 0 && quickIndex < displayItems.length - 1 ? () => stepQuick(1) : undefined} />
  {/key}
{/if}

<style>
  .gallery { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .search-row { display: flex; align-items: center; gap: 6px; height: 26px; flex-shrink: 0; padding: 0 6px 0 8px; border-bottom: 1px solid var(--c-line); background: var(--c-bg); }
  .search-row:focus-within { border-bottom-color: var(--c-accent); }
  .mag { width: 12px; height: 12px; flex-shrink: 0; fill: none; stroke: var(--c-tx-muted); stroke-width: 1.7; }
  .search { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; background: none; color: var(--c-tx); font: 11.5px var(--font-mono); }
  .search::placeholder { color: var(--c-tx-faint); }
  .clear { width: 18px; height: 18px; padding: 0; border: 0; background: none; color: var(--c-tx-muted); font-size: 13px; line-height: 1; border-radius: var(--r-ui); cursor: var(--cursor-cross-hover); }
  .clear:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  .chip-collection { flex-shrink: 0; height: 18px; padding: 0 6px; border: 1px solid var(--c-accent); border-radius: var(--r-ui); background: var(--c-accent-tint); color: var(--c-tx-hi); font: 10.5px var(--font-mono); cursor: var(--cursor-cross-hover); }
  .scope { display: inline-flex; flex-shrink: 0; height: 18px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); overflow: hidden; }
  .scope button { padding: 0 5px; border: 0; background: none; color: var(--c-tx-muted); font: 10px var(--font-mono); cursor: var(--cursor-cross-hover); }
  .scope button + button { border-left: 1px solid var(--c-line-strong); }
  .scope button:hover:not(:disabled) { color: var(--c-tx-hi); }
  .scope button:disabled { opacity: .4; cursor: var(--cursor-cross); }
  .scope .chosen { background: var(--c-accent-tint); color: var(--c-tx-hi); }
  .mode-note { flex-shrink: 0; padding: 3px 10px; font: 10.5px var(--font-ui); color: var(--c-tx-muted); border-bottom: 1px solid var(--c-line); }
  .mode-note button, .link { padding: 0; border: 0; background: none; color: var(--c-accent); font: inherit; cursor: var(--cursor-cross-hover); }
  .note { flex-shrink: 0; padding: 6px 10px; border-top: 1px solid var(--c-line); color: var(--c-tx-muted); font: 11px var(--font-ui); }
  .reserved-row { display: flex; align-items: center; gap: 8px; height: 100%; padding: 0 8px; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: var(--c-bg-raised); color: var(--c-tx); font: 11.5px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .reserved-row:hover { border-color: var(--c-line-strong); background: var(--c-surface); }
  .reserved-row b { font: 600 11.5px var(--font-mono); }
  .reserved-row .arrow { color: var(--c-tx-muted); }
  .reserved-row .hint { color: var(--c-tx-muted); font-size: 11px; }
</style>
