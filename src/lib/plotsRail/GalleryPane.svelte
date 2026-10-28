<script lang="ts">
  // The Plots rail's GALLERY pane: the project's plots (or the global library) as one continuous
  // scroll. Folders are sticky section headers (not places you navigate into); tiles sit in
  // justified rows at their true aspect, each on the backdrop the law chose for it. Click selects
  // (and makes that plot the Dissections pane's focus); double-click / Enter places the selection
  // in the active figure; drag places at the pointer; Space is Quick Look. Recent sort is one
  // newest-first list. Typing "_" offers the reserved companion collections.
  //
  // Narrowing (P3), all visible as chips under/in the search row: the ⋯ filters (Unused ·
  // Fluxplots only · Has dissections), a focus folder (context menu "Show only this folder";
  // Backspace climbs), Similar names (a flat ranked list). Variant stacks (⋯, off by default)
  // fold fig1_a…f / _v1…_v7 into one tile. Fresh dots mark what changed since the rail last
  // listed it. Hovering a tile 350 ms (or Shift+Space) shows Peek. Idle time pre-warms the
  // thumbnail cache for everything listed.
  import { tick, untrack } from "svelte";
  import { get } from "svelte/store";
  import JustifiedGrid, { type GridItem, type GridSection, type TileFlags } from "./JustifiedGrid.svelte";
  import Tile from "./Tile.svelte";
  import RailMenu, { type RailMenuItem } from "./RailMenu.svelte";
  import GalleryExpandedPreview from "../plot/GalleryExpandedPreview.svelte";
  import { createPlotIndex, freshPlots, clearFresh, type PlotIndex, type PlotItem, type IndexState } from "./plotIndex";
  import { applyFilters, anyFilter, inFolder, parentFolder, similarTo, stackVariants, widthClass, type StackEntry } from "./galleryModel";
  import { peekHover, peekToggle, hidePeek, type PlotPeek } from "./peek";
  import { setPrewarm, clearPrewarm, type WarmJob } from "./thumbClient";
  import { railPrefs, toggledFolders, saveToggledFolders, isCollapsed, TILE_H_MIN, TILE_H_MAX } from "./railPrefs";
  import { railQuickLook, plotsRailFocusRequest, takeRailFocus, railFolder, rememberRailFolder } from "./railState";
  import { offerFile, resolvePlotElement } from "./focusPlot";
  import { beginPlotDrag } from "./dragPlace";
  import { insertPlots, destinationName, type PlaceAdapter } from "./insert";
  import { RESERVED_PLOT_FOLDERS, VIDEO_DIRNAME } from "../project/plotsFolders";
  import { plotKeyFor } from "../dissect/rules";
  import { indexPlotNotes, matchPlotNotes, notesRevision, type IndexedPlotNote } from "../dissect/notes";
  import { dissectionsRevision } from "../../shell/scholar/revisions";
  import { fileBridge, joinPath } from "../project/types";
  import { project, activeFigureId, selection, partSelection, embeddedProjectRoot, projectDir } from "../store";
  import { pushToast } from "../toast";
  import { storeTenant } from "../tenancy";
  import { settings } from "../settings";
  import type { HitBridgeHolder } from "../interact/canvasHitBridge";

  let {
    active = true,
    hitBridge = null,
    refreshKey = 0,
    onShowDissections,
    accept = "svg,png,glb",
    place = null,
    onBrowseChange,
  }: {
    active?: boolean;
    hitBridge?: HitBridgeHolder | null;
    /** Bumped by the rail's ⋯ Refresh. */
    refreshKey?: number;
    /** A ⧉ chip / "Show dissections": make sure the Dissections pane is visible. */
    onShowDissections?: () => void;
    /** What the tree lists (Slide adds mp4,mov). */
    accept?: string;
    /** The mode's placement route (Slide); the shared pipeline when null. */
    place?: PlaceAdapter | null;
    onBrowseChange?: (view: { base: string; folder: string; counts: ReadonlyMap<string, number> }) => void;
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
    // Clips are the project's own (plots/_videos): Slide's video reader and importer refuse
    // anything else, so the library never lists them.
    const acc = sc === "global" ? accept.split(",").filter((x) => x !== "mp4" && x !== "mov").join(",") : accept;
    const created = createPlotIndex({ scope: sc, collection: col || undefined, accept: acc, watch: true });
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
      // Clips live in _videos: offered only where the rail can place them (Slide).
      if (alive) reservedHere = found.filter((f): f is (typeof RESERVED_PLOT_FOLDERS)[number] => !!f && (f.name !== VIDEO_DIRNAME || /\bmp4\b/.test(accept)));
    });
    return () => { alive = false; };
  });

  // ---- narrowing: focus folder → search → filters (→ similar names)
  let folderState = $state({ dir: "", owner: "" });
  const browseOwner = $derived(`${root}|${scope}|${collection}`);
  const focusDir = $derived(folderState.owner === browseOwner ? folderState.dir : railFolder(browseOwner));
  // Listed plots per folder, nested folders included: the folder navigator's counts.
  const folderCounts = $derived.by(() => {
    void ix.version;
    const m = new Map<string, number>();
    for (const it of ix.items) for (let d = it.dir; ; d = parentFolder(d)) { m.set(d, (m.get(d) ?? 0) + 1); if (!d) break; }
    return m;
  });
  $effect(() => { onBrowseChange?.({ base, folder: focusDir, counts: folderCounts }); });
  let noteMode = $state(false), notesLoading = $state(false), notesError = $state("");
  let noteIndex = $state.raw<IndexedPlotNote[]>([]);
  const noteOwners = $derived(ix.items.map(i => i.abs).join("\n"));
  $effect(() => {
    const enabled = noteMode && scope === "project" && !collection, r = root;
    noteOwners; $notesRevision; $dissectionsRevision;
    noteIndex = []; notesError = "";
    if (!enabled || !r) return;
    const abort = new AbortController();
    notesLoading = true;
    void indexPlotNotes(r, untrack(() => ix.items), abort.signal).then(result => {
      if (abort.signal.aborted) return;
      noteIndex = result.notes;
      notesError = result.incomplete ? "Note search reached its limit; some notes are not included." : result.errors ? `${result.errors} notes or folders could not be read.` : "";
    }).catch(e => { if (!abort.signal.aborted) notesError = String(e?.message ?? e); }).finally(() => { if (!abort.signal.aborted) notesLoading = false; });
    return () => abort.abort();
  });
  const noteMatches = $derived(matchPlotNotes(noteIndex, search));
  const searchingNotes = $derived(noteMode && scope === "project" && !collection);
  const noteMatchPlots = $derived(new Set(noteMatches.map(n => n.plot)));
  /** A note hit opens that note in the lower pane, beside its plot's tile — not a new viewer. */
  function openNoteMatch(match: IndexedPlotNote) {
    offerFile(match.path, root, scope);
    onShowDissections?.();
    focusId = match.plot; selected = new Set([match.plot]); anchorId = match.plot;
    void tick().then(() => grid?.reveal(match.plot, "center"));
  }
  let similarState = $state.raw<{ item: PlotItem | null; owner: string }>({ item: null, owner: "" });
  const similar = $derived(similarState.owner === `${root}|${scope}|${collection}` ? similarState.item : null);
  const filters = $derived({ unused: $railPrefs.filterUnused, fluxplot: $railPrefs.filterFluxplot, dissected: $railPrefs.filterDissected && scope === "project" && !collection });
  const filtering = $derived(anyFilter(filters));
  const matches = $derived.by(() => {
    void ix.version;
    if (q.startsWith("_") && !collection && !searchingNotes) return [];
    // Similar names ranks the whole tree — across folders, past the folder focus and filters.
    if (similar) return similarTo(ix.items.some((it) => it.abs === similar.abs) ? ix.items : [similar, ...ix.items], similar);
    let out = ix.items;
    if (focusDir && !searchingNotes) out = out.filter((it) => inFolder(it.dir, focusDir));
    if (q) out = searchingNotes ? out.filter(it => noteMatchPlots.has(it.abs)) : out.filter((it) => it.rel.toLowerCase().includes(q));
    if (filtering) out = applyFilters(out, filters, (it) => (placedSet.has(slash(it.abs)) ? 1 : 0), (it) => { const n = counts.get(plotKeyFor(it.abs, root)); return n === undefined ? null : n; });
    return out;
  });
  // Has-dissections needs every listed plot's count, not only the visible ones'.
  $effect(() => {
    if (!filters.dissected || !index || !ix.loaded) return;
    void ix.version;
    const keys = ix.items.map((i) => plotKeyFor(i.abs, root)).filter(Boolean);
    untrack(() => index?.ensureCounts(keys));
  });
  // Variant stacks: expanded keys (dir/key) for this session.
  let expandedStacks = $state.raw<Set<string>>(new Set());
  function toggleStack(key: string) {
    const next = new Set(expandedStacks);
    if (next.has(key)) next.delete(key); else next.add(key);
    expandedStacks = next;
  }
  const recent = $derived($railPrefs.sort === "recent");
  const rootLabel = $derived(collection || (scope === "global" ? (libraryRoot.split(/[\\/]/).pop() || "plot_library") : "plots"));

  const sections: GridSection[] = $derived.by(() => {
    void ix.version;
    const out: GridSection[] = [];
    if (q.startsWith("_") && !collection && !searchingNotes) {
      const rows = reservedHere.filter((f) => f.name.includes(q));
      out.push({ key: "reserved", title: "Companion collections", meta: rows.length ? "" : " · none here", depth: 0, collapsed: false, collapsible: false, headerH: 24,
        items: rows.map((f) => ({ id: `reserved:${f.name}`, aspect: 1, block: 30, data: { reserved: f } })) });
      return out;
    }
    if (similar) {
      out.push({ key: "similar", title: "", depth: 0, collapsed: false, collapsible: false, headerH: 0, items: matches.map((it) => toGrid(it)) });
      return out;
    }
    if (recent) {
      const items = [...matches].sort((a, b) => b.mtimeMs - a.mtimeMs);
      out.push({ key: "recent", title: "", depth: 0, collapsed: false, collapsible: false, headerH: 0, items: items.map((it) => toGrid(it)) });
      return out;
    }
    const stacking = $railPrefs.stacks && !q;
    let cur: GridSection | null = null;
    let run: PlotItem[] = [];
    const flush = () => {
      if (!cur) return;
      if (stacking) for (const e of stackVariants(run, expandedStacks)) cur.items.push(entryToGrid(e));
      else for (const it of run) cur.items.push(toGrid(it));
      cur.meta = `· ${run.length}`;
      run = [];
    };
    for (const it of matches) {
      if (!cur || cur.key !== `dir:${it.dir}`) {
        flush();
        const depth = it.dir ? it.dir.split("/").length - (focusDir ? focusDir.split("/").length : 0) : 0;
        cur = { key: `dir:${it.dir}`, title: it.dir || rootLabel, depth: Math.max(0, Math.min(3, depth)), collapsed: !q && it.dir !== focusDir && isCollapsed(it.dir, toggled), collapsible: it.dir !== focusDir || !focusDir, headerH: 24, items: [] };
        out.push(cur);
      }
      run.push(it);
    }
    flush();
    return out;
  });
  type StackData = { stack: { key: string; members: PlotItem[] }; item: PlotItem };
  type HeadData = { head: { key: string; count: number }; item: PlotItem };
  // Videos have no header size: their poster's aspect, once it loads.
  let posterAspect = $state.raw<Map<string, number>>(new Map());
  function aspectOf(it: PlotItem): number {
    return it.w && it.h ? it.w / it.h : posterAspect.get(it.abs) ?? (/\.(mp4|mov)$/i.test(it.name) ? 16 / 9 : 4 / 3);
  }
  function toGrid(it: PlotItem): GridItem {
    return { id: it.abs, aspect: aspectOf(it), data: it };
  }
  function entryToGrid(e: StackEntry<PlotItem>): GridItem {
    if (e.kind === "stack") return { id: e.top.abs, aspect: aspectOf(e.top), data: { stack: { key: e.key, members: e.members }, item: e.top } satisfies StackData };
    if (e.head) return { id: e.item.abs, aspect: aspectOf(e.item), data: { head: e.head, item: e.item } satisfies HeadData };
    return toGrid(e.item);
  }
  /** The plot a grid item shows (a stack shows its newest variant). */
  function plotOf(g: GridItem | null | undefined): PlotItem | null {
    const d = g?.data as PlotItem | StackData | HeadData | undefined;
    if (!d) return null;
    if ("abs" in d) return d;
    if ("item" in d) return d.item;
    return null;
  }
  const stackOf = (g: GridItem) => (g.data as Partial<StackData>).stack ?? null;
  const headOf = (g: GridItem) => (g.data as Partial<HeadData>).head ?? null;
  /** The items in display order (expanded sections only) — Quick Look stepping, ranges, probes. */
  const displayItems = $derived(sections.filter((s) => !s.collapsed).flatMap((s) => s.items.map((i) => plotOf(i))).filter((x): x is PlotItem => !!x));
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
      // Inside a collapsed variant stack whose top is another variant: open the stack.
      for (const sec of sections) for (const g of sec.items) {
        const st = stackOf(g);
        if (st && g.id !== id && st.members.some((m) => m.abs === id)) toggleStack(st.key);
      }
      void tick().then(() => grid?.reveal(id, "center"));
    });
  });

  const usage = $derived.by(() => {
    const m = new Map<string, { active: boolean; count: number; figs: string[] }>();
    for (const f of $project.figures) for (const el of f.elements) {
      // Placed plots carry their source path; images and video clips are copied (no in-use mark).
      const src = el.type === "plot" ? el.source?.svgPath : "";
      if (!src) continue;
      const abs = absOf(src);
      const e = m.get(abs) ?? { active: false, count: 0, figs: [] };
      e.count++;
      if (!e.figs.includes(f.id)) e.figs.push(f.id);
      if (f.id === $activeFigureId) e.active = true;
      m.set(abs, e);
    }
    return m;
  });
  // The placed sources as one string: a commit that moves or restyles an element leaves it equal,
  // so a filtered gallery does not re-filter and re-lay-out 20,000 plots on every edit.
  const placedSig = $derived([...usage.keys()].sort().join("\n"));
  const placedSet = $derived(new Set(placedSig ? placedSig.split("\n") : []));
  const destination = $derived($project.figures.find((f) => f.id === $activeFigureId)?.background ?? null);

  // ------------------------------------------------------------------ selection + focus
  let selected = $state.raw<Set<string>>(new Set());
  let focusId = $state("");
  let anchorId = "";
  let suppressClick = false;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  function itemOf(g: GridItem): PlotItem | null { return plotOf(g); }
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
    clearFresh(it.abs);
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
    // A stack opens (which variant to place is the user's choice); a plot is placed.
    const st = stackOf(g);
    if (st) { toggleStack(st.key); return; }
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
    for (const p of paths) clearFresh(p);
    const n = await insertPlots(paths, at, place);
    // Under Unused the placed plots leave the list: drop them from the selection too, or the
    // next Enter would place them again (the selection keeps hidden plots on purpose).
    if (n > 0 && filters.unused) {
      await tick();
      const shownNow = new Set(displayItems.map((i) => i.abs));
      selected = new Set([...selected].filter((a) => shownNow.has(a)));
    }
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
      onStart: () => { suppressClick = true; hidePeek(); },
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
    const destName = destinationName(fig);
    const onto = storeTenant() === "slide" ? "on" : "in";
    const st = stackOf(g), head = headOf(g);
    menu = { x: e.clientX, y: e.clientY, items: [
      { kind: "action", label: paths.length > 1 ? `Place ${paths.length} plots ${onto} ${destName || "the figure"}` : `Place ${onto} ${destName || "the figure"}`, hint: "Enter", disabled: !fig, run: () => void insert(paths) },
      { kind: "action", label: "Quick Look", hint: "Space", run: () => openQuick(it) },
      ...(scope === "project" && !collection ? [{ kind: "action" as const, label: "Show dissections", run: () => { offerFile(it.abs, root, scope); onShowDissections?.(); } }] : []),
      ...(st ? [{ kind: "action" as const, label: `Show all ${st.members.length} variants`, hint: "Enter", run: () => toggleStack(st.key) }] : []),
      ...(head ? [{ kind: "action" as const, label: `Stack these ${head.count} variants`, run: () => toggleStack(head.key) }] : []),
      { kind: "separator" },
      { kind: "action", label: "Similar names", hint: "≈", run: () => showSimilar(it) },
      { kind: "action", label: it.dir ? `Show only ${it.dir.split("/").pop()}` : "Show only this folder", disabled: !it.dir || it.dir === focusDir, run: () => focusFolder(it.dir) },
      { kind: "separator" },
      { kind: "action", label: "Reveal in file manager", disabled: !fb?.revealPath, run: () => void fb?.revealPath?.(it.abs) },
      { kind: "action", label: "Copy path", run: () => void navigator.clipboard?.writeText(it.abs).catch(() => {}) },
    ] };
  }
  function onHeaderContext(sec: GridSection, e: MouseEvent) {
    if (!sec.key.startsWith("dir:")) return;
    const dir = sec.key.slice(4);
    menu = { x: e.clientX, y: e.clientY, items: [
      { kind: "action", label: "Show only this folder", disabled: !dir || dir === focusDir, run: () => focusFolder(dir) },
      { kind: "action", label: sec.collapsed ? "Expand" : "Collapse", run: () => toggleFolder(dir) },
      { kind: "action", label: "Collapse the others", hint: "Alt+click ▾", run: () => onHeaderToggle(sec, new MouseEvent("click", { altKey: true })) },
    ] };
  }

  // ------------------------------------------------------------------ focus folder / similar
  /** The folder navigator's choice: a new place, so the old name query no longer applies. */
  export function showFolder(dir: string) { search = ""; focusFolder(dir); }
  function focusFolder(dir: string) {
    folderState = { dir, owner: browseOwner };
    rememberRailFolder(browseOwner, dir);
    similarState = { item: null, owner: "" };
    void tick().then(() => grid?.scrollToTop());
  }
  function showSimilar(it: PlotItem) {
    similarState = { item: it, owner: `${root}|${scope}|${collection}` };
    search = "";
    void tick().then(() => { grid?.scrollToTop(); grid?.focusGrid(); });
  }
  function clearSimilar() {
    const was = similar;
    similarState = { item: null, owner: "" };
    if (was) void tick().then(() => grid?.reveal(was.abs, "center"));
  }
  /** Backspace in an empty search: leave Similar, then climb the focus folder, then the collection. */
  function stepOut(): boolean {
    if (similar) { clearSimilar(); return true; }
    if (focusDir) { focusFolder(parentFolder(focusDir)); return true; }
    if (collection) { leaveCollection(); return true; }
    return false;
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
    if (e.code === "Space" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (focused && it) peekToggle(() => plotPeekFor(it), cellOf(focused.id));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const res = focused && (focused.data as { reserved?: { name: string } }).reserved;
      if (res) { enterCollection(res.name); return; }
      const st = focused ? stackOf(focused) : null;
      if (st && !e.ctrlKey && !e.metaKey && selected.size <= 1) { toggleStack(st.key); return; }
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
      if (similar) { clearSimilar(); return; }
      if (collection) { leaveCollection(); return; }
      (e.currentTarget as HTMLElement).blur();
      return;
    }
    if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      stepOut();
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
      else if (similar) clearSimilar();
      else if (collection) leaveCollection();
      else searchEl?.blur();
    } else if (e.key === "Backspace" && !search && (similar || focusDir || collection)) {
      e.preventDefault();
      stepOut();
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
    firstVisible = s.firstVisible;
    if (scope !== "project" || !index) return;
    const near = displayItems.slice(Math.max(0, s.firstVisible - 20), s.firstVisible + 80);
    const keys = near.map((i) => plotKeyFor(i.abs, root)).filter(Boolean);
    untrack(() => index?.ensureCounts(keys));
  }
  function dissectionsFor(it: PlotItem): number {
    if (scope !== "project" || collection) return 0;
    return counts.get(plotKeyFor(it.abs, root)) ?? 0;
  }
  const isVideo = (it: PlotItem) => /\.(mp4|mov)$/i.test(it.name);
  const glyphFor = (it: PlotItem) => (it.model3d ? "3D" : isVideo(it) ? "▶" : it.snip ? "✂" : it.semantic ? "◆" : "");
  const glyphTitle = (it: PlotItem) => (it.model3d ? "3D model" : isVideo(it) ? "Video clip" : it.snip ? "Paper snip" : it.semantic ? "Fluxplot — editable parts and data" : "");

  // ------------------------------------------------------------------ peek
  function cellOf(id: string): HTMLElement | null {
    return gallery?.querySelector<HTMLElement>(`[data-grid-id="${CSS.escape(id)}"]`) ?? null;
  }
  function plotPeekFor(it: PlotItem): PlotPeek {
    const u = usage.get(slash(it.abs));
    const figs = $project.figures;
    const placements = (u?.figs ?? []).map((id) => { const f = figs.find((x) => x.id === id); return { name: destinationName(f), active: id === $activeFigureId }; });
    placements.sort((a, b) => Number(b.active) - Number(a.active));
    const key = scope === "project" && !collection ? plotKeyFor(it.abs, root) : "";
    const lib = scope === "global" ? (libraryRoot.split(/[\\/]/).pop() || "plot_library") : collection ? `plots/${collection}` : "plots";
    const fresh = $freshPlots.has(it.abs);
    clearFresh(it.abs);
    return {
      kind: "plot", abs: it.abs, stamp: it.stamp, name: it.name, folder: it.dir ? `${lib}/${it.dir}` : lib,
      aspect: aspectOf(it), physMm: it.physMm ?? null, size: it.size, mtimeMs: it.mtimeMs,
      kindLabel: it.model3d ? "3D model" : isVideo(it) ? "▶ video clip" : it.snip ? "✂ paper snip" : it.semantic ? "◆ fluxplot" : /\.png$/i.test(it.name) ? "PNG image" : "SVG",
      placements, dissectKey: key, dissections: key ? counts.get(key) ?? 0 : 0,
      stats: it.stats ?? null, paper: it.paper ?? null, fresh,
      placeholder: cellOf(it.abs)?.querySelector<HTMLImageElement>(".page img")?.src ?? "",
    };
  }
  function onItemHover(g: GridItem | null, cell: HTMLElement | null) {
    const it = g ? itemOf(g) : null;
    peekHover(it ? () => plotPeekFor(it) : null, it ? cell : null);
  }

  // ------------------------------------------------------------------ pre-warm
  // Once a listing settles (1.5 s quiet), everything listed — nearest the view first, then the
  // collapsed folders — is handed to the thumbnail client's idle queue at the bucket its tile
  // uses (the laid-out width, or an estimate for collapsed folders).
  const warmOwner = {};
  let firstVisible = 0;
  $effect(() => {
    const st = ix, on = active, h = $railPrefs.tileH;
    void displayItems;
    if (!on || !st.loaded || !st.items.length) { clearPrewarm(warmOwner); return; }
    const t = setTimeout(() => untrack(() => {
      const shown = displayItems;
      const start = Math.min(firstVisible, shown.length);
      const ordered = [...shown.slice(start), ...shown.slice(0, start)];
      const seen = new Set(ordered.map((i) => i.abs));
      for (const i of st.items) if (!seen.has(i.abs)) ordered.push(i);
      const jobs: WarmJob[] = ordered.map((i) => ({ path: i.abs, stamp: i.stamp, size: i.size, cssWidth: grid?.widthOf(i.abs) ?? Math.min(360, h * aspectOf(i)) }));
      setPrewarm(warmOwner, jobs, window.devicePixelRatio || 1);
    }), 1500);
    return () => clearTimeout(t);
  });
  $effect(() => () => { clearPrewarm(warmOwner); hidePeek(); });
  let gallery = $state<HTMLDivElement>();
  const filterChips = $derived([
    ...(filters.unused ? [{ key: "filterUnused", label: "Unused" }] : []),
    ...(filters.fluxplot ? [{ key: "filterFluxplot", label: "Fluxplots" }] : []),
    ...(filters.dissected ? [{ key: "filterDissected", label: "Has dissections" }] : []),
  ] as { key: "filterUnused" | "filterFluxplot" | "filterDissected"; label: string }[]);
  const emptyText = $derived(
    !root && scope === "project" ? "Open a Flux project to browse its plots."
    : ix.error ? ix.error
    : !ix.loaded ? ""
    : q && !matches.length && !q.startsWith("_") ? `No plots match “${search.trim()}”.`
    : fileCount && !matches.length && filtering ? "No plots pass the filters."
    : fileCount && !matches.length && focusDir ? `${focusDir} has no plots.`
    : !fileCount ? (scope === "global" ? "Your global plot library is empty." : collection ? `${collection} is empty.` : "No plots yet — save SVG or PNG plots into plots/ and they appear here.")
    : "");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gallery" bind:this={gallery} onkeydown={onRootKey} onfocusin={onFocusIn} data-plots-gallery>
  <div class="search-row">
    <svg class="mag" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
    {#if collection}<button class="chip-collection" title="Leave this collection (Backspace)" onclick={leaveCollection}>{collection} ✕</button>{/if}
    {#if focusDir}<button class="chip-collection" title={`Showing only ${focusDir} — Backspace goes up a folder; click to show everything`} onclick={() => focusFolder("")} data-focus-folder={focusDir}>{focusDir.split("/").pop()} ✕</button>{/if}
    {#if similar}<button class="chip-collection" title={`Names similar to ${similar.name} — click or Esc to leave`} onclick={clearSimilar} data-similar={similar.name}>≈ {similar.name.replace(/\.[^.]+$/, "")} ✕</button>{/if}
    <input
      bind:this={searchEl}
      bind:value={search}
      class="search"
      aria-label="Search plots"
      placeholder={noteMode && scope === "project" && !collection ? "Search all plot notes · #TODO" : scope === "global" ? "Search the library" : collection ? `Search ${collection}` : "Search plots"}
      title="Search by name or folder · type _ for the companion collections"
      spellcheck="false"
      onkeydown={onSearchKey}
      data-plots-search />
    {#if search}<button class="clear" aria-label="Clear search" onclick={() => { search = ""; searchEl?.focus(); }}>×</button>{/if}
    {#if scope === "project" && !collection}<button class="notes-toggle" class:on={noteMode} aria-pressed={noteMode} title="Search note contents across all project plots" onclick={() => { noteMode = !noteMode; searchEl?.focus(); }} data-notes-search>Notes</button>{/if}
    <div class="scope" role="group" aria-label="Plot scope">
      <button class:chosen={scope === "project"} aria-pressed={scope === "project"} title="This project's plots (Alt+1)" onclick={() => setScope("project")} data-scope="project">Proj</button>
      <button class:chosen={scope === "global"} aria-pressed={scope === "global"} disabled={!libraryRoot} title={libraryRoot ? "Your global plot library (Alt+2)" : "The global plot library needs the desktop app"} onclick={() => setScope("global")} data-scope="global">Glob</button>
    </div>
  </div>
  {#if noteMode && scope === "project" && !collection}
    <div class="note-results" data-note-results>
      {#if notesLoading}<p>Reading plot notes…</p>{/if}
      {#if notesError}<p role="status">{notesError}</p>{/if}
      {#if !q}<p>Search the text of every plot's .txt notes, including tags such as #TODO.</p>{/if}
      {#each noteMatches.slice(0, 200) as match (match.path)}
        <button onclick={() => openNoteMatch(match)} data-note-match={match.path}>
          <span class="where"><b>{match.key.split("/").pop()}</b><span class="note">· {match.group ? `${match.group}/` : ""}{match.name}<span class="ln">:{match.line}</span></span></span>
          <span class="snip">{match.snippet.slice(0, match.at)}<mark>{match.snippet.slice(match.at, match.at + match.length)}</mark>{match.snippet.slice(match.at + match.length)}</span>
        </button>
      {/each}
      {#if noteMatches.length > 200}<p>Showing 200 matching notes. Narrow the search to see more.</p>{/if}
      {#if q && !notesLoading && !noteMatches.length}<p>No matching plot notes.</p>{/if}
    </div>
  {/if}
  {#if filterChips.length}
    <div class="filter-line" data-filter-chips>
      <span class="fl">Only</span>
      {#each filterChips as f (f.key)}<button class="fchip" title={`Remove the ${f.label} filter`} onclick={() => railPrefs.update((p) => ({ ...p, [f.key]: false }))} data-filter-chip={f.key}>{f.label} ✕</button>{/each}
      <span class="fcount">{matches.length} of {fileCount}</span>
    </div>
  {/if}
  {#if recent && !q.startsWith("_") && !similar}<div class="mode-note" data-recent-note>Newest first · <button onclick={() => railPrefs.update((p) => ({ ...p, sort: "folders" }))}>show folders</button></div>{/if}
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
    {onScrollState}
    {onItemHover}
    {onHeaderContext}
    onScrolled={hidePeek}>
    {#snippet tile(g: GridItem, w: number, h: number, flags: TileFlags)}
      {@const res = (g.data as { reserved?: { name: string; hint: string } }).reserved}
      {#if res}
        <div class="reserved-row" data-reserved={res.name}><span class="arrow">↳</span><b>{res.name}</b><span class="hint">{res.hint}</span></div>
      {:else}
        {@const it = plotOf(g)!}
        {@const st = stackOf(g)}
        {@const head = headOf(g)}
        <Tile
          path={it.abs}
          stamp={it.stamp}
          aspect={g.aspect}
          {w}
          {h}
          captionH={$railPrefs.names ? 14 : 0}
          name={(recent || similar) && it.dir ? `${it.dir}/${it.name.replace(/\.(svg|png|glb|mp4|mov)$/i, "")}` : it.name.replace(/\.(svg|png|glb|mp4|mov)$/i, "")}
          title={st ? `${it.rel} — the newest of ${st.members.length} variants\nEnter or double-click shows them all · drag places this one` : `${it.rel}${it.bad ? `\nPreview failed: ${it.bad}` : ""}\nDouble-click or Enter places it · drag onto a ${storeTenant() === "slide" ? "slide" : "figure"} · Space for Quick Look`}
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
          fresh={$freshPlots.has(it.abs)}
          badge={$railPrefs.widthBadge ? widthClass(it.physMm, $settings.physicalUnit) : null}
          stack={st ? st.members.length : 0}
          stackHead={head ? head.count : 0}
          onStackToggle={() => { const k = st?.key ?? head?.key; if (k) toggleStack(k); }}
          darkMedia={it.model3d || isVideo(it)}
          onAspect={isVideo(it) && !it.w ? (a) => { if (Math.abs((posterAspect.get(it.abs) ?? 0) - a) > 0.01) posterAspect = new Map(posterAspect).set(it.abs, a); } : undefined}
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
      onSimilar={() => { const it = quick; closeQuick(); if (it) showSimilar(it); }}
      onPrevious={quickIndex > 0 ? () => stepQuick(-1) : undefined}
      onNext={quickIndex >= 0 && quickIndex < displayItems.length - 1 ? () => stepQuick(1) : undefined} />
  {/key}
{/if}

<style>
  .gallery { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .notes-toggle { flex-shrink:0; padding:1px 4px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:none; color:var(--c-tx-muted); font:10px var(--font-ui); } .notes-toggle.on { color:var(--c-accent); border-color:var(--c-accent); background:var(--c-accent-tint); }
  .note-results { flex-shrink:0; max-height:42%; overflow:auto; border-bottom:1px solid var(--c-line); } .note-results p { margin:0; padding:5px 8px; color:var(--c-tx-muted); font:10.5px/1.4 var(--font-ui); } .note-results button { display:flex; flex-direction:column; gap:2px; width:100%; padding:5px 8px; border:0; border-bottom:1px solid var(--c-line); background:none; color:var(--c-tx-muted); text-align:left; font:10.5px var(--font-mono); cursor:var(--cursor-cross-hover); } .note-results button:hover { background:var(--c-surface-2); } .note-results .where { display:flex; gap:4px; min-width:0; white-space:nowrap; } .note-results b { min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--c-tx-hi); font-weight:500; } .note-results .note { flex-shrink:0; } .note-results .ln { color:var(--c-tx-faint); } .note-results .snip { color:var(--c-tx-2); white-space:pre-wrap; overflow-wrap:anywhere; } .note-results mark { background:var(--c-accent-tint); color:var(--c-accent-bright); }
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
  .filter-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; flex-shrink: 0; padding: 3px 8px; border-bottom: 1px solid var(--c-line); font: 10.5px var(--font-ui); color: var(--c-tx-muted); }
  .fchip { height: 18px; padding: 0 6px; border: 1px solid var(--c-accent); border-radius: var(--r-ui); background: var(--c-accent-tint); color: var(--c-tx-hi); font: 10.5px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .fchip:hover { background: var(--c-surface-2); }
  .fcount { margin-left: auto; font: 10px var(--font-mono); color: var(--c-tx-faint); }
  .chip-collection { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mode-note { flex-shrink: 0; padding: 3px 10px; font: 10.5px var(--font-ui); color: var(--c-tx-muted); border-bottom: 1px solid var(--c-line); }
  .mode-note button, .link { padding: 0; border: 0; background: none; color: var(--c-accent); font: inherit; cursor: var(--cursor-cross-hover); }
  .note { flex-shrink: 0; padding: 6px 10px; border-top: 1px solid var(--c-line); color: var(--c-tx-muted); font: 11px var(--font-ui); }
  .reserved-row { display: flex; align-items: center; gap: 8px; height: 100%; padding: 0 8px; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: var(--c-bg-raised); color: var(--c-tx); font: 11.5px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .reserved-row:hover { border-color: var(--c-line-strong); background: var(--c-surface); }
  .reserved-row b { font: 600 11.5px var(--font-mono); }
  .reserved-row .arrow { color: var(--c-tx-muted); }
  .reserved-row .hint { color: var(--c-tx-muted); font-size: 11px; }
</style>
