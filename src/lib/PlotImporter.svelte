<script lang="ts" context="module">
  /** One picked plot, handed to `onPick` hosts in insertion (= placement) order. */
  export interface PlotPick {
    abs: string;
    rel: string;
    semantic: boolean;
  }
</script>

<script lang="ts">
  // Plot Importer (Alt+I): a quick-open window over the project's plots/ dir.
  // Type to fuzzy-search every plot by name/path, or browse folder-by-folder.
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
  import { fade, scale } from "svelte/transition";
  import { importerOpen, embeddedProjectRoot, projectDir } from "./store";
  import { fileBridge, joinPath } from "./project/types";
  import { importPlotsFromPaths } from "./io";
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
  export let title = "Import plot";
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
    if ($importerOpen && !prevOpen) open();
    prevOpen = $importerOpen;
  }
  async function open() {
    search = "";
    index = 0;
    picked = new Map();
    rootReserved = [];
    cwd = plotsRoot;
    await loadDir(cwd);
    void scanFor(""); // warm the search cache in the background
    requestAnimationFrame(() => inputEl?.focus());
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
  async function loadDir(dir: string) {
    const fig = fileBridge();
    if (!fig?.readdir || !dir) {
      entries = [];
      manifestNames = new Set();
      snipNames = new Set();
      return;
    }
    loading = true;
    const es = await fig.readdir(dir);
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
      if (depth > 6 || out.length > 2000) {
        if (out.length > 2000) truncated = true;
        return;
      }
      const es = await fig.readdir!(dir);
      const names = new Set(es.map((e) => e.name));
      for (const e of es) {
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
    await visit(scopeRel ? joinPath(plotsRoot, scopeRel) : plotsRoot, scopeRel, 0);
    if (scanScope !== scopeRel) return; // a newer scope superseded this walk mid-flight
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
          .slice(0, 300)
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

  function ensureVisible() {
    requestAnimationFrame(() => listEl?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" }));
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
    await loadDir(cwd);
    syncScanScope();
  }

  /** Hand the picks off (host callback or figure batch import), then close. */
  async function insertPicks(picks: PlotPick[]) {
    if (!picks.length) return;
    if (onPick) await onPick(picks);
    else await importPlotsFromPaths(picks.map((p) => p.abs));
    importerOpen.set(false);
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
    await loadDir(cwd);
    syncScanScope(); // stepping out of a reserved folder restores the ordinary plots/ scope
  }
  function close() {
    importerOpen.set(false);
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
    requestAnimationFrame(() => inputEl?.focus());
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
    if (e.key === "ArrowDown") {
      e.preventDefault();
      index = Math.min(rows.length - 1, index + 1);
      ensureVisible();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      index = Math.max(0, index - 1);
      ensureVisible();
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

{#if $importerOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ibackdrop" transition:fade={{ duration: 110 }} on:pointerdown={close}></div>
  <div class="iwrap">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="importer" transition:scale={{ duration: 150, start: 0.97 }} on:pointerdown|stopPropagation>
      <div class="ihead">
        <span class="ttlwrap">
          <span class="ttl">{title}</span>
          {#if pickedCount > 0}<span class="pickpill">{pickedCount} selected</span>{/if}
        </span>
        <span class="path">
          plots{relDir ? "/" : ""}<span class="cur">{relDir}</span>
          {#if !q && cwd && cwd !== plotsRoot}<button class="upbtn" on:click={up}>↑ up</button>{/if}
        </span>
      </div>

      <div class="search-row">
        <span class="mag">⌕</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={inputEl}
          bind:value={search}
          class="search-in"
          placeholder={searchHint}
          spellcheck="false"
          on:keydown={onKey}
        />
      </div>

      <div class="list" bind:this={listEl}>
        {#if !root}
          <div class="empty">Open a Flux project first.</div>
        {:else if !fileBridge()?.readdir}
          <div class="empty">Folder browsing isn't available in this build.</div>
        {:else if loading && !rows.length}
          <div class="empty">Loading…</div>
        {:else if !rows.length}
          <div class="empty">{q ? "No matching plot." : "This folder has no plots."}</div>
        {:else}
          {#each rows as r, i (r.kind + (r.abs ?? r.name) + i)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="row"
              class:sel={i === index}
              class:picked={r.kind === "file" && !!r.abs && picked.has(r.abs)}
              data-i={i}
              on:pointerenter={() => (index = i)}
              on:click={(e) => onRowClick(e, r)}
              on:dblclick={() => onRowDblClick(r)}
            >
              <span class="ic"
                >{r.kind === "dir" ? "📁" : r.kind === "up" ? "↩" : r.abs && picked.has(r.abs) ? "✓" : r.semantic ? "◆" : "◇"}</span
              >
              <span class="nm">{r.kind === "file" ? r.name.replace(/\.(svg|png)$/i, "") : r.name}</span>
              {#if r.hint}<span class="rel">{r.hint}</span>{/if}
              {#if q && r.rel && r.rel !== r.name}<span class="rel">{r.rel.replace(/\/[^/]+$/, "")}</span>{/if}
              {#if r.kind === "file" && r.semantic}<span class="badge">semantic</span>{/if}
              {#if r.kind === "file" && r.snip}<span class="badge">snip</span>{/if}
            </div>
          {/each}
          {#if truncated}<div class="note">Showing the first 2000 plots — narrow your search.</div>{/if}
          {#if !q && cwd === plotsRoot && rootReserved.length}
            <div class="note" data-reserved-hint>
              Type <b>_</b> to reach {rootReserved.map((f) => f.name).join(" and ")}.
            </div>
          {/if}
        {/if}
      </div>

      <div class="foot">
        <span><b>↵</b> select</span>
        <span><b>space</b> select</span>
        <span><b>ctrl+↵</b> insert {pickedCount > 0 ? pickedCount : 1}</span>
        <span><b>⌫</b> up</span>
        <span><b>esc</b> close</span>
        {#if pickedCount > 0}
          <button class="insbtn" on:click={() => void insertPicked()}>Insert {pickedCount}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .ibackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    z-index: 320;
  }
  .iwrap {
    position: fixed;
    inset: 0;
    z-index: 321;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 76px;
    pointer-events: none;
  }
  .importer {
    pointer-events: auto;
    width: 560px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    border-radius: var(--r-3);
    color: var(--c-tx);
    font-family: var(--font-serif);
    overflow: hidden;
    background:
      linear-gradient(180deg, color-mix(in oklab, var(--c-tx-hi) 6%, transparent), transparent 42%),
      color-mix(in oklab, var(--c-surface) 96%, transparent);
    backdrop-filter: blur(16px) saturate(120%);
    -webkit-backdrop-filter: blur(16px) saturate(120%);
    border: 1px solid var(--c-line-strong);
    box-shadow: var(--elev-3), 0 0 26px -6px var(--c-accent-glow);
  }
  .ihead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 16px 6px;
  }
  .ttl {
    font-size: 18px;
    color: var(--c-tx-hi);
  }
  .ttlwrap {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex: 0 0 auto;
  }
  .pickpill {
    font-size: 11.5px;
    letter-spacing: 0.3px;
    color: var(--c-accent-bright);
    border: 1px solid var(--c-accent);
    background: var(--c-accent-tint);
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .path {
    font-size: 12px;
    color: var(--c-tx-muted);
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    white-space: nowrap;
  }
  .cur {
    color: var(--c-accent-bright);
  }
  .upbtn {
    background: none;
    border: 1px solid var(--c-line);
    border-radius: 5px;
    color: var(--c-tx-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    padding: 1px 6px;
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 12px 8px;
    padding: 8px 12px;
    background: color-mix(in oklab, var(--c-tx-hi) 4%, transparent);
    border: 1px solid var(--c-accent);
    border-radius: 8px;
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
  .mag {
    color: var(--c-tx-muted);
    font-size: 16px;
  }
  .search-in {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--c-tx);
    font-size: 16px;
    font-family: inherit;
  }
  .list {
    overflow-y: auto;
    padding: 2px 8px 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 7px;
    cursor: pointer;
  }
  .row.sel {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  /* Picked (multi-selected) rows: accent tint + an inset accent bar — visually
     distinct from `.sel` (the highlight cursor); a row can be both at once. */
  .row.picked {
    background: var(--c-accent-tint);
    box-shadow: inset 3px 0 0 var(--c-accent);
  }
  .row.picked.sel {
    background: var(--c-accent);
    box-shadow: inset 3px 0 0 var(--c-accent-bright);
  }
  .ic {
    width: 18px;
    flex: 0 0 18px;
    text-align: center;
    font-size: 13px;
    color: var(--c-accent-bright);
  }
  .row.sel .ic {
    color: var(--c-on-accent);
  }
  .nm {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14.5px;
  }
  .rel {
    flex: 1;
    font-size: 11.5px;
    opacity: 0.55;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    margin-left: auto;
    font-size: 10.5px;
    letter-spacing: 0.3px;
    color: var(--c-accent-bright);
    border: 1px solid var(--c-accent-tint);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .row.sel .badge {
    color: var(--c-on-accent);
    border-color: var(--c-on-accent);
  }
  .empty {
    padding: 26px 16px;
    text-align: center;
    color: var(--c-tx-muted);
    font-style: italic;
  }
  .note {
    padding: 8px 10px;
    font-size: 12px;
    color: var(--c-tx-muted);
    font-style: italic;
  }
  .note b {
    color: var(--c-accent-bright);
    font-style: normal;
  }
  .foot {
    display: flex;
    gap: 16px;
    padding: 9px 16px;
    border-top: 1px solid var(--c-line);
    font-size: 12px;
    color: var(--c-tx-muted);
  }
  .foot b {
    color: var(--c-accent-bright);
  }
  .insbtn {
    margin-left: auto;
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    padding: 3px 12px;
  }
  .insbtn:hover {
    background: var(--c-accent-bright);
  }
</style>
