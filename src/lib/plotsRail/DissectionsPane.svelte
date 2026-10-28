<script lang="ts">
  // The Plots rail's DISSECTIONS pane: the companion material of the FOCUS PLOT (focusPlot.ts —
  // the plot last clicked on the canvas or in the gallery; sticky; pinnable), live.
  //
  // Summary first (every table, `_stats` groups first), then each image group as a section,
  // then other files. Groups over GROUP_CAP files show their first tiles and a "Show all"
  // (remembered per group NAME — the same group recurs across plots). Moving the focus to a plot
  // with a same-named group and file keeps that file selected at the same screen height
  // ("aligned flipping": click plot A on s07, click plot B, B's s07 is under your eye).
  // Double-click / Enter / Space opens the Dissect viewer at the file; drag places an image on
  // the canvas; 1–9 jump between sections; `p` pins.
  import { tick, untrack } from "svelte";
  import { get } from "svelte/store";
  import JustifiedGrid, { type GridItem, type GridSection, type TileFlags } from "./JustifiedGrid.svelte";
  import Tile from "./Tile.svelte";
  import TableCard from "./TableCard.svelte";
  import { tablePreview, tableCardHeight, type TablePreview } from "./tableCard";
  import RailMenu, { type RailMenuItem } from "./RailMenu.svelte";
  import { focusPlot, setPinned } from "./focusPlot";
  import { createDissectionsModel, type DissectionSection, type DissectionsState } from "./dissectionsModel";
  import { railPrefs, dissectGroupState, saveDissectGroupState, TILE_H_MIN, TILE_H_MAX } from "./railPrefs";
  import { beginPlotDrag } from "./dragPlace";
  import { insertPlots, type PlaceAdapter } from "./insert";
  import { peekHover, peekToggle, hidePeek, type DissectionPeek } from "./peek";
  import { acquireThumb } from "./thumbClient";
  import { dissectTarget } from "../dissect/state";
  import { createDissectionRoot, dissectionRootAbs } from "../dissect/loader";
  import { DISSECT_TABLE_RE } from "../dissect/rules";
  import PlotNotes from "../dissect/PlotNotes.svelte";
  import { fileBridge } from "../project/types";
  import { project, activeFigureId, embeddedProjectRoot, projectDir } from "../store";
  import { pushToast } from "../toast";
  import type { HitBridgeHolder } from "../interact/canvasHitBridge";

  let {
    active = true,
    hitBridge = null,
    collapsed = false,
    galleryCollapsed = false,
    onCollapse,
    onMaximize,
    place = null,
    onDirectories,
  }: {
    active?: boolean;
    hitBridge?: HitBridgeHolder | null;
    collapsed?: boolean;
    galleryCollapsed?: boolean;
    /** ▾ — collapse this pane (or restore it). */
    onCollapse?: () => void;
    /** ▴ — give this pane the whole height (collapse the gallery), or restore the split. */
    onMaximize?: () => void;
    /** The mode's placement route (Slide); the shared pipeline when null. */
    place?: PlaceAdapter | null;
    onDirectories?: () => void;
  } = $props();

  const GROUP_CAP = 60;
  const CAPPED_SHOW = 12;
  // Files | Notes: the lower pane can show the plot's .txt notes as an editor instead.
  let noteView = $state(false);
  let noteFocus = $state.raw<{ group: string; name: string; seq: number } | null>(null);
  let noteSeq = 0;
  function openNote(group: string, name: string) { noteFocus = { group, name, seq: ++noteSeq }; noteView = true; }

  const root = $derived($embeddedProjectRoot || $projectDir || "");
  const focus = $derived($focusPlot);
  const target = $derived(focus.target);
  const model = createDissectionsModel();
  let ds = $state.raw<DissectionsState>(model.current());
  $effect(() => model.subscribe((v) => { ds = v; }));

  const wantKey = $derived(target && (target.kind === "plot" || target.kind === "sourceless") ? target.key : "");
  // A focus that names a note (a Notes search hit) opens it.
  $effect(() => { const f = target?.file; if (f && /\.txt$/i.test(f.name)) untrack(() => openNote(f.group, f.name)); });
  $effect(() => {
    const r = root, k = wantKey;
    if (!active) return;
    untrack(() => { rememberAnchor(); void model.show(r, k); });
  });

  // Live: a watcher batch under THIS plot's dissection folder re-lists in place.
  $effect(() => {
    const fb = fileBridge();
    const off = fb?.onFsChangedBatch?.((info) => {
      if (info.subsystem !== "dissections" || !ds.key || !root) return;
      // Forward slashes on both sides: the watcher reports native paths (\\ on Windows).
      const dir = dissectionRootAbs(root, ds.key).replace(/\\/g, "/");
      if (info.rescan || info.paths.some((p) => { const q = p.replace(/\\/g, "/"); return q === dir || q.startsWith(dir + "/"); })) { rememberAnchor(); void model.refresh(); }
    });
    return () => off?.();
  });

  // ------------------------------------------------------------------ sizes, stamps, tables
  let sizes = $state.raw<Map<string, { w: number; h: number; stamp: string; physMm: [number, number] | null; mtimeMs: number }>>(new Map());
  let tables = $state.raw<Map<string, TablePreview>>(new Map());
  // Peek's longer look at a table: its first 20 rows (the card shows 6).
  let peekTables = $state.raw<Map<string, TablePreview>>(new Map());
  // What is on screen: a listing whose sizes and tables are in. The previous one stays (dimmed)
  // until the next is complete — never a blank frame between two plots.
  let view = $state.raw<{ key: string; rev: number; sections: DissectionSection[] }>({ key: "", rev: -1, sections: [] });
  $effect(() => {
    if (noteView) return;
    const rev = ds.rev;
    const st = untrack(() => ds);
    const files = st.sections.flatMap((s) => s.files);
    let alive = true;
    void (async () => {
      const fb = fileBridge();
      const images = files.filter((f) => f.kind === "image").map((f) => f.abs);
      const nextSizes = new Map<string, { w: number; h: number; stamp: string; physMm: [number, number] | null; mtimeMs: number }>();
      if (images.length && fb?.plotsProbe) {
        try {
          for (const p of await fb.plotsProbe(images)) nextSizes.set(p.abs, { w: p.w ?? 0, h: p.h ?? 0, stamp: `${p.size ?? 0}:${p.mtimeMs ?? 0}`, physMm: p.physMm ?? null, mtimeMs: p.mtimeMs ?? 0 });
        } catch { /* layout falls back to 4:3 */ }
      }
      const nextTables = new Map<string, TablePreview>(), nextPeek = new Map<string, TablePreview>();
      await Promise.all(files.filter((f) => f.kind === "table" || DISSECT_TABLE_RE.test(f.name)).map(async (f) => {
        try {
          const r = await fb?.readTextBounded?.(f.abs, 64 * 1024);
          nextTables.set(f.abs, r ? tablePreview(r.text, f.name, r.truncated) : { header: [], rows: [], rowCount: 0, complete: true, cols: 0, transposed: false, error: "Unreadable" });
          if (r) nextPeek.set(f.abs, tablePreview(r.text, f.name, r.truncated, 20));
        } catch { nextTables.set(f.abs, { header: [], rows: [], rowCount: 0, complete: true, cols: 0, transposed: false, error: "Unreadable" }); }
      }));
      if (!alive) return;
      sizes = nextSizes; tables = nextTables; peekTables = nextPeek; view = { key: st.key, rev, sections: st.sections };
      await tick();
      applyAnchor();
    })();
    return () => { alive = false; };
  });

  // ------------------------------------------------------------------ sections
  let groupState = $state.raw(dissectGroupState());
  function toggleGroup(name: string, which: "collapsed" | "expanded") {
    const next = { collapsed: new Set(groupState.collapsed), expanded: new Set(groupState.expanded) };
    const set = next[which];
    if (set.has(name)) set.delete(name); else set.add(name);
    groupState = next;
    saveDissectGroupState(next);
  }
  type DissectItem = { abs: string; name: string; group: string; kind: "image" | "table" | "other"; semantic?: boolean };
  const shown = $derived(view.key === ds.key && view.rev === ds.rev);
  const gridSections: GridSection[] = $derived.by(() => {
    return view.sections.map((sec: DissectionSection, si) => {
      const name = sec.kind === "images" ? sec.group || "·" : sec.id;
      const isCollapsed = groupState.collapsed.has(name);
      let files = sec.files;
      const capped = sec.kind === "images" && files.length > GROUP_CAP && !groupState.expanded.has(name);
      if (capped) files = files.slice(0, CAPPED_SHOW);
      const items: GridItem[] = files.map((f) => {
        const item: DissectItem = { abs: f.abs, name: f.name, group: f.group, kind: f.kind === "image" ? "image" : f.kind === "table" ? "table" : "other", semantic: f.semantic };
        if (item.kind === "table") return { id: f.abs, aspect: 1, block: tableCardHeight(tables.get(f.abs) ?? null), data: item };
        if (item.kind === "other") return { id: f.abs, aspect: 1, block: 24, data: item };
        const sz = sizes.get(f.abs);
        return { id: f.abs, aspect: sz && sz.w && sz.h ? sz.w / sz.h : 4 / 3, data: item };
      });
      if (capped) items.push({ id: `showall:${name}`, aspect: 1, block: 26, data: { showAll: name, total: sec.files.length } });
      else if (sec.kind === "images" && sec.files.length > GROUP_CAP) items.push({ id: `showless:${name}`, aspect: 1, block: 26, data: { showLess: name } });
      return { key: sec.id, title: sec.title, meta: `· ${sec.files.length}`, depth: 0, collapsed: isCollapsed, collapsible: true, headerH: 24, items,
        onHeaderMenu: view.sections.length > 1 ? (e: MouseEvent) => jumpMenu(e, si) : undefined };
    });
  });
  const total = $derived(ds.listing?.total ?? 0);
  const viewTotal = $derived(view.sections.reduce((n, sec) => n + sec.files.length, 0));

  // ------------------------------------------------------------------ selection + aligned flipping
  let grid = $state<ReturnType<typeof JustifiedGrid>>();
  let selectedId = $state("");
  let anchor: { group: string; name: string; y: number | null } | null = null;
  function itemOf(g: GridItem): DissectItem | null { const d = g.data as DissectItem; return d && "abs" in d ? d : null; }
  function rememberAnchor() {
    const cur = view.sections.flatMap((s) => s.files).find((f) => f.abs === selectedId);
    anchor = cur ? { group: cur.group, name: cur.name, y: grid?.screenYOf(cur.abs) ?? null } : null;
  }
  function applyAnchor() {
    const files = ds.sections.flatMap((s) => s.files);
    // A focus that came from a placed dissection FILE selects that file.
    const want = target?.file && target.key === ds.key ? target.file : anchor;
    const hit = want ? files.find((f) => f.name === want.name && f.group === want.group) ?? files.find((f) => f.name === want.name) : null;
    if (hit) {
      selectedId = hit.abs;
      const y = anchor && hit.name === anchor.name ? anchor.y : null;
      if (y != null) grid?.anchorTo(hit.abs, y); else grid?.reveal(hit.abs, "center");
    } else {
      selectedId = "";
      grid?.scrollToTop();
    }
    anchor = null;
  }

  function openInViewer(it: DissectItem) {
    if (it.kind === "other") {
      if (/\.txt$/i.test(it.name)) openNote(it.group, it.name);
      else void fileBridge()?.openPath?.(it.abs);
      return;
    }
    if (!ds.key) return;
    dissectTarget.set({ key: ds.key, displayName: ds.key.split("/").pop() ?? ds.key, initial: { group: it.group, name: it.name } });
  }
  function onPress(g: GridItem) {
    const d = g.data as { showAll?: string; showLess?: string };
    if (d.showAll) { toggleGroup(d.showAll, "expanded"); return; }
    if (d.showLess) { toggleGroup(d.showLess, "expanded"); return; }
    const it = itemOf(g);
    if (!it) return;
    if (suppressClick) { suppressClick = false; return; }
    selectedId = it.abs;
    grid?.focusGrid();
  }
  function onOpen(g: GridItem) { const it = itemOf(g); if (it) openInViewer(it); }
  function peekFor(it: DissectItem, cell: HTMLElement | null): DissectionPeek | null {
    if (it.kind === "other") return null;
    const sz = sizes.get(it.abs);
    return {
      kind: "dissection", abs: it.abs, stamp: sz?.stamp ?? "?", name: it.name, group: it.group,
      aspect: sz && sz.w && sz.h ? sz.w / sz.h : 4 / 3,
      physMm: sz?.physMm ?? null, mtimeMs: sz?.mtimeMs ?? 0,
      table: it.kind === "table" ? peekTables.get(it.abs) ?? tables.get(it.abs) ?? null : null,
      placeholder: cell?.querySelector<HTMLImageElement>(".page img")?.src ?? "",
    };
  }
  function onItemHover(g: GridItem | null, cell: HTMLElement | null) {
    const it = g ? itemOf(g) : null;
    peekHover(it && it.kind !== "other" ? () => peekFor(it, cell) : null, it ? cell : null);
  }
  function onKey(e: KeyboardEvent, focused: GridItem | null) {
    const it = focused ? itemOf(focused) : null;
    if (e.code === "Space" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const cell = focused ? sectionEl?.querySelector<HTMLElement>(`[data-grid-id="${CSS.escape(focused.id)}"]`) ?? null : null;
      if (it) peekToggle(() => peekFor(it, cell), cell);
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const d = focused?.data as { showAll?: string; showLess?: string } | undefined;
      if (d?.showAll || d?.showLess) { toggleGroup((d.showAll ?? d.showLess)!, "expanded"); return; }
      if (it) openInViewer(it);
      return;
    }
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const sec = gridSections[Number(e.key) - 1];
      const first = sec?.items[0];
      if (first) { selectedId = first.id; grid?.reveal(first.id, "nearest"); }
      return;
    }
    if (e.key.toLowerCase() === "p" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setPinned(!focus.pinned);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); }
  }
  function jumpMenu(e: MouseEvent, current: number) {
    menu = { x: e.clientX, y: e.clientY + 8, items: [
      { kind: "heading", label: "Jump to" },
      ...gridSections.map((s, i): RailMenuItem => ({ kind: "action", label: `${s.title}  ${s.meta ?? ""}`, hint: i < 9 ? String(i + 1) : undefined, checked: i === current, run: () => { const first = s.items[0]; if (first) { selectedId = first.id; grid?.reveal(first.id, "nearest"); } } })),
    ] };
  }
  let menu = $state.raw<{ x: number; y: number; items: RailMenuItem[] } | null>(null);

  // ------------------------------------------------------------------ drag to place
  let suppressClick = false;
  function onPointerDown(g: GridItem, e: PointerEvent) {
    const it = itemOf(g);
    if (!it || it.kind !== "image") return;
    const cell = e.currentTarget as HTMLElement;
    beginPlotDrag(e, () => {
      const pageEl = cell.querySelector<HTMLElement>(".page");
      if (!pageEl) return null;
      const sz = sizes.get(it.abs);
      return { paths: [it.abs], thumbUrl: pageEl.querySelector<HTMLImageElement>("img")?.src ?? "", tileRect: pageEl.getBoundingClientRect(),
        placed: sz && sz.w ? { w: sz.w, h: sz.h } : null, backdrop: getComputedStyle(pageEl).backgroundColor || null };
    }, hitBridge, {
      onStart: () => { suppressClick = true; hidePeek(); },
      onEnd: () => { setTimeout(() => { suppressClick = false; }, 0); },
      onDrop: (fig, at, paths) => { void insertPlots(paths, { figId: fig.id, ...at }, place); },
      onMiss: () => pushToast("info", "Drop onto a figure to place it"),
    });
  }

  // ------------------------------------------------------------------ header thumbnail
  let headThumb = $state("");
  // Keyed by the file's version (size:mtime from a header probe), re-probed when the watcher
  // names the file — a regenerated plot's header picture is fresh, an unchanged one is cached.
  let headRev = $state(0);
  $effect(() => {
    const abs = target?.abs;
    const off = fileBridge()?.onFsChangedBatch?.((info) => {
      if (info.subsystem === "plots" && abs && (info.rescan || info.paths.some((p) => p.replace(/\\/g, "/") === abs.replace(/\\/g, "/")))) headRev++;
    });
    return () => off?.();
  });
  $effect(() => {
    const abs = target?.abs;
    void headRev;
    headThumb = "";
    if (!abs || !/\.(svg|png)$/i.test(abs)) return;
    let release: (() => void) | null = null, alive = true;
    void (async () => {
      let stamp = "?";
      try { const [p] = (await fileBridge()?.plotsProbe?.([abs])) ?? []; if (p?.size != null) stamp = `${p.size}:${p.mtimeMs}`; } catch { /* the cached picture, if any */ }
      if (!alive) return;
      release = acquireThumb(abs, stamp, 40, window.devicePixelRatio || 1, 0, (st) => { headThumb = st.url; });
    })();
    return () => { alive = false; release?.(); };
  });

  async function createFolder() {
    if (!ds.key && wantKey) {
      await createDissectionRoot(root, wantKey);
      void model.refresh();
      return;
    }
    await createDissectionRoot(root, ds.key);
    void model.refresh();
  }
  const destination = $derived($project.figures.find((f) => f.id === $activeFigureId)?.background ?? null);
  const loading = $derived(ds.loadingKey !== "" || !shown);
  let sectionEl = $state<HTMLElement>();
  const relPath = $derived(ds.key ? `plots/_dissections/${ds.key}/` : wantKey ? `plots/_dissections/${wantKey}/` : "");
</script>

<section class="dissections" class:collapsed data-plots-dissections bind:this={sectionEl}>
  <header class="head">
    {#if headThumb}<img class="mini" src={headThumb} alt="" />{:else}<span class="mini blank"></span>{/if}
    <span class="eyebrow">Dissections</span>
    <span class="name" class:stale={target && !focus.live && focus.source === "canvas"} title={target ? `${target.name}${target.key ? ` · ${relPath}` : ""}${!focus.live && focus.source === "canvas" ? " — no longer selected" : ""}` : "No plot in focus"} data-dissect-focus={target?.key ?? ""}>{target?.name ?? "—"}</span>
    {#if total}<span class="count" title={`${total} files`}>{total}</span>{/if}
    <span class="grow"></span>
    <button class="hb" class:on={focus.pinned} aria-pressed={focus.pinned} title={focus.pinned ? "Unpin — follow the clicked plot again (P)" : "Pin to this plot (P)"} disabled={!target} onclick={() => setPinned(!focus.pinned)} data-dissect-pin><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2h4l-.6 4.2L12 8.5V10H8.6L8 14l-.6-4H4V8.5l2.6-2.3Z"/></svg></button>
    <button class="hb" title="Open in the Dissect viewer (D)" disabled={!ds.key || !total} onclick={() => ds.key && dissectTarget.set({ key: ds.key, displayName: ds.key.split("/").pop() ?? ds.key })}>⤢</button>
    <button class="hb" title={galleryCollapsed ? "Restore the split" : "Give Dissections the full height"} onclick={() => onMaximize?.()} aria-label={galleryCollapsed ? "Restore the split" : "Maximize dissections"}>{galleryCollapsed ? "▾" : "▴"}</button>
    <button class="hb" title={collapsed ? "Show Dissections" : "Collapse Dissections"} onclick={() => onCollapse?.()} aria-label={collapsed ? "Show dissections" : "Collapse dissections"} aria-expanded={!collapsed}>{collapsed ? "▴" : "▾"}</button>
  </header>
  {#if !collapsed}
    <nav class="pane-views" aria-label="Plot companion views">
      <button class:chosen={!noteView} aria-pressed={!noteView} onclick={() => noteView = false}>Files</button>
      <button class:chosen={noteView} aria-label="Plot text notes" aria-pressed={noteView} disabled={!wantKey} onclick={() => noteView = !noteView} data-plot-notes-toggle>✎ Notes</button>
      <span class="grow"></span><button aria-label="Browse plot folders" title="Browse the plot folders (Alt+/)" onclick={onDirectories} data-directory-toggle><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4V2.5h5l1.5 1.5h6.5v9.5h-13Z" /></svg>Folders <kbd>Alt+/</kbd></button>
    </nav>
    <div class="body" class:dim={!noteView && loading && viewTotal > 0}>
      {#if noteView && wantKey}
        {#key `${root}|${wantKey}`}<PlotNotes {root} plotKey={wantKey} focus={noteFocus} onChanged={() => void model.refresh()} />{/key}
      {:else if !target}
        <p class="state">Click a plot — on the canvas or above — to see its dissections.</p>
      {:else if target.kind === "external"}
        <p class="state">Library plots have no dissections. Dissections live in a project's <code>plots/_dissections</code>.</p>
      {:else if target.kind === "none"}
        <p class="state">This element isn't a file under <code>plots/</code>, so it has no dissection folder.</p>
      {:else if ds.error && !loading}
        <p class="state">Couldn't read the dissections: {ds.error} <button class="link" onclick={() => void model.refresh()}>Retry</button></p>
      {:else if shown && ds.key === wantKey && ds.listing && ds.listing.groups === null}
        <div class="state" data-dissect-none>
          <p>No dissections for <b>{target.name}</b>{target.kind === "sourceless" ? " (matched by file name)" : ""}.</p>
          <p class="path" title="Copy" >{relPath}</p>
          <button class="btn" onclick={createFolder} data-dissect-create>Create folder</button>
        </div>
      {:else if shown && ds.key === wantKey && ds.listing && total === 0}
        <div class="state" data-dissect-empty>
          <p>Empty. Drop images or CSVs into <code>{relPath}</code>; subfolders become groups.</p>
          {#if fileBridge()?.openPath}<button class="btn" onclick={() => void fileBridge()?.openPath?.(dissectionRootAbs(root, ds.key))}>Open folder</button>{/if}
        </div>
      {:else}
        {#if target.kind === "sourceless" && ds.key === wantKey}<p class="note">Matched by file name — this element has no plots/ source.</p>{/if}
        <JustifiedGrid
          bind:this={grid}
          sections={gridSections}
          rowHeight={$railPrefs.dissectTileH}
          captionH={$railPrefs.names ? 14 : 0}
          minAspect={$railPrefs.names ? 0.6 : 0.33}
          selected={new Set(selectedId ? [selectedId] : [])}
          focusId={selectedId}
          label="Dissection files"
          onItemPress={onPress}
          onItemOpen={onOpen}
          onItemPointerDown={onPointerDown}
          onHeaderToggle={(s) => toggleGroup(s.key.startsWith("images:") ? s.key.slice(7) || "·" : s.key, "collapsed")}
          onFocusChange={(g) => { selectedId = g.id; }}
          onKeyDown={onKey}
          {onItemHover}
          onScrolled={hidePeek}
          onZoom={(d) => railPrefs.update((p) => ({ ...p, dissectTileH: Math.max(TILE_H_MIN, Math.min(TILE_H_MAX, Math.round(p.dissectTileH * (d > 0 ? 1.15 : 1 / 1.15)))) }))}>
          {#snippet tile(g: GridItem, w: number, h: number, flags: TileFlags)}
            {@const d = g.data as DissectItem & { showAll?: string; total?: number; showLess?: string }}
            {#if d.showAll}
              <button class="more" tabindex="-1" data-show-all={d.showAll}>Show all {d.total}</button>
            {:else if d.showLess}
              <button class="more" tabindex="-1">Show fewer</button>
            {:else if d.kind === "table"}
              <TableCard name={d.name} preview={tables.get(d.abs) ?? null} selected={flags.selected} focused={flags.focused} />
            {:else if d.kind === "other"}
              <div class="other" class:selected={flags.selected} title={d.name.toLowerCase().endsWith(".txt") ? `${d.name} — double-click to edit it in Notes` : `${d.name} — double-click to open`}><span class="ic">{d.name.toLowerCase().endsWith(".txt") ? "✎" : "📄"}</span>{d.name}</div>
            {:else}
              <Tile
                path={d.abs}
                stamp={sizes.get(d.abs)?.stamp ?? "?"}
                aspect={g.aspect}
                {w}
                {h}
                captionH={$railPrefs.names ? 14 : 0}
                name={d.name.replace(/\.(svg|png|jpe?g|gif|webp)$/i, "")}
                title={`${d.group ? `${d.group}/` : ""}${d.name}\nDouble-click or Enter opens it in the Dissect viewer · drag onto a figure to place it`}
                backdrop={$railPrefs.backdrop}
                {destination}
                selected={flags.selected}
                focused={flags.focused}
                priority={flags.priority + 1000}
                glyph={d.semantic ? "◆" : ""}
                glyphTitle="Fluxplot" />
            {/if}
          {/snippet}
        </JustifiedGrid>
      {/if}
    </div>
  {/if}
  {#if menu}<RailMenu items={menu.items} x={menu.x} y={menu.y} label="Dissection groups" onClose={() => (menu = null)} />{/if}
</section>

<style>
  .dissections { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--c-bg-raised); }
  .dissections.collapsed { flex: 0 0 auto; }
  .head { display: flex; align-items: center; gap: 6px; height: 28px; flex-shrink: 0; padding: 0 4px 0 8px; border-bottom: 1px solid var(--c-line); }
  .collapsed .head { border-bottom: 0; }
  .mini { width: 20px; height: 16px; flex: 0 0 20px; object-fit: contain; background: var(--flx-paper); border-radius: var(--r-ui); box-shadow: 0 0 0 1px var(--c-line); }
  .mini.blank { background: var(--c-surface-2); }
  .eyebrow { flex-shrink: 0; color: var(--c-tx-muted); font: 600 10px var(--font-mono); text-transform: uppercase; letter-spacing: .08em; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-hi); font: 11.5px var(--font-ui); }
  .name.stale { color: var(--c-tx-2); }
  .count { flex-shrink: 0; color: var(--c-tx-faint); font: 10.5px var(--font-mono); }
  .grow { flex: 1; }
  .hb { width: 22px; height: 22px; flex: 0 0 22px; padding: 0; border: 0; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); font-size: 11px; line-height: 1; cursor: var(--cursor-cross-hover); }
  .hb:hover:not(:disabled) { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .hb:disabled { opacity: .35; cursor: var(--cursor-cross); }
  .hb.on { background: var(--c-accent-tint); color: var(--c-accent); }
  .hb svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linejoin: round; vertical-align: -2px; }
  .hb.on svg { fill: currentColor; }
  .body { display: flex; flex-direction: column; flex: 1; min-height: 0; transition: opacity 80ms linear; }
  .pane-views { display:flex; align-items:center; gap:2px; min-height:25px; flex-shrink:0; padding:0 5px; border-bottom:1px solid var(--c-line); background:var(--c-bg-raised); } .pane-views button { padding:3px 5px; border:0; border-radius:var(--r-ui); background:none; color:var(--c-tx-muted); font:10.5px var(--font-ui); cursor:var(--cursor-cross-hover); } .pane-views button:hover { background:var(--c-surface-2); color:var(--c-tx-hi); } .pane-views .chosen { background:var(--c-accent-tint); color:var(--c-accent); } .pane-views button:disabled { opacity:.4; } .pane-views kbd { margin-left:4px; color:var(--c-tx-faint); font:9px var(--font-mono); } .pane-views svg { width:11px; height:11px; margin-right:4px; vertical-align:-1.5px; fill:none; stroke:currentColor; stroke-width:1.2; stroke-linejoin:round; }
  .body.dim { opacity: .6; }
  .state { margin: 0; padding: 12px; color: var(--c-tx-muted); font: 11.5px/1.45 var(--font-ui); }
  .state p { margin: 0 0 6px; }
  .state b { color: var(--c-tx); font-weight: 600; }
  .state .path, code { font: 10.5px var(--font-mono); color: var(--c-tx-2); word-break: break-all; user-select: text; }
  .note { margin: 0; padding: 4px 10px; color: var(--c-tx-muted); font: 10.5px var(--font-ui); border-bottom: 1px solid var(--c-line); }
  .btn { height: 22px; padding: 0 8px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: none; color: var(--c-tx); font: 11.5px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .btn:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .link { padding: 0; border: 0; background: none; color: var(--c-accent); font: inherit; cursor: var(--cursor-cross-hover); }
  .more { position: absolute; inset: 0; width: 100%; border: 1px dashed var(--c-line-strong); border-radius: var(--r-ui); background: none; color: var(--c-tx-2); font: 11px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .more:hover { color: var(--c-tx-hi); border-color: var(--c-tx-muted); }
  .other { position: absolute; inset: 0; display: flex; align-items: center; gap: 6px; padding: 0 6px; border: 1px solid transparent; border-radius: var(--r-ui); color: var(--c-tx-2); font: 11px var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .other.selected { border-color: var(--c-accent); background: var(--c-accent-tint); color: var(--c-tx-hi); }
  .other .ic { font-size: 11px; }
  @media (prefers-reduced-motion: reduce) { .body { transition: none; } }
</style>
