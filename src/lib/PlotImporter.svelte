<script lang="ts">
  // Plot Importer (Alt+I): a quick-open window over the project's plots/ dir.
  // Type to fuzzy-search every plot by name/path, or browse folder-by-folder;
  // Enter imports the chosen FluxPlot svg (manifest + recipe sidecars resolved)
  // into the active figure via the normal import pipeline.
  import { fade, scale } from "svelte/transition";
  import { importerOpen, embeddedProjectRoot, projectDir } from "./store";
  import { fileBridge, joinPath, basename } from "./project/types";
  import { importPlotFromPath } from "./io";

  // Reuse beyond Figure mode: when `onPick` is provided (e.g. Slide mode), a chosen
  // plot is handed to it (abs path + project-relative `rel` under plots/ + whether
  // it's semantic) instead of being imported into the active figure. `title` lets
  // a host relabel the header. Defaults preserve the original figure-import behavior.
  export let onPick:
    | ((p: { abs: string; rel: string; semantic: boolean }) => void | Promise<void>)
    | undefined = undefined;
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
  }
  interface Row {
    kind: "up" | "dir" | "file";
    name: string;
    abs?: string;
    rel?: string;
    semantic?: boolean;
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

  let prevOpen = false;
  $: {
    if ($importerOpen && !prevOpen) open();
    prevOpen = $importerOpen;
  }
  async function open() {
    search = "";
    index = 0;
    all = [];
    scanned = false;
    truncated = false;
    cwd = plotsRoot;
    await loadDir(cwd);
    void scan(); // warm the search cache in the background
    requestAnimationFrame(() => inputEl?.focus());
  }

  async function loadDir(dir: string) {
    const fig = fileBridge();
    if (!fig?.readdir || !dir) {
      entries = [];
      return;
    }
    loading = true;
    const es = await fig.readdir(dir);
    // dirs first, then files, each alphabetical; only show dirs + .svg plots.
    entries = es
      .filter((e) => e.dir || /\.svg$/i.test(e.name))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    loading = false;
  }

  // Recursively collect every .svg under plots/ (capped), flagging semantic ones
  // (those with a .fluxplot.json sibling) — no extra IO, read from the dir listing.
  async function scan() {
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
        if (e.dir) await visit(abs, r, depth + 1);
        else if (/\.svg$/i.test(e.name))
          out.push({ abs, rel: r, name: e.name, semantic: names.has(e.name.replace(/\.svg$/i, ".fluxplot.json")) });
      }
    };
    await visit(plotsRoot, "", 0);
    all = out;
    scanned = true;
  }

  $: q = search.trim().toLowerCase();
  // Search mode when typing; otherwise the current-folder browse listing.
  $: rows = ((): Row[] => {
    if (q) {
      return all
        .filter((p) => `${p.rel} ${p.name}`.toLowerCase().includes(q))
        .sort((a, b) => rank(a, q) - rank(b, q))
        .slice(0, 300)
        .map((p) => ({ kind: "file", name: p.name, abs: p.abs, rel: p.rel, semantic: p.semantic }));
    }
    const out: Row[] = [];
    if (cwd && cwd !== plotsRoot) out.push({ kind: "up", name: ".." });
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      if (e.dir) out.push({ kind: "dir", name: e.name });
      else
        out.push({
          kind: "file",
          name: e.name,
          abs: joinPath(cwd, e.name),
          rel: e.name,
          semantic: names.has(e.name.replace(/\.svg$/i, ".fluxplot.json")),
        });
    }
    return out;
  })();
  $: if (index >= rows.length) index = Math.max(0, rows.length - 1);
  $: relDir = cwd && plotsRoot ? cwd.slice(plotsRoot.length).replace(/^\//, "") : "";

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

  async function activate(r: Row) {
    if (r.kind === "up") return up();
    if (r.kind === "dir") {
      cwd = joinPath(cwd, r.name);
      index = 0;
      await loadDir(cwd);
      return;
    }
    if (r.abs) {
      if (onPick) {
        // hand back a stable project-relative path under plots/ (consistent across
        // search vs. browse rows, where r.rel differs)
        const rel = plotsRoot && r.abs.startsWith(plotsRoot) ? r.abs.slice(plotsRoot.length).replace(/^\/+/, "") : (r.rel ?? r.name);
        await onPick({ abs: r.abs, rel, semantic: !!r.semantic });
      } else {
        await importPlotFromPath(r.abs);
      }
      importerOpen.set(false);
    }
  }
  async function up() {
    if (!cwd || cwd === plotsRoot) return;
    cwd = cwd.replace(/\/[^/]+$/, "");
    index = 0;
    await loadDir(cwd);
  }
  function close() {
    importerOpen.set(false);
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
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[index]) void activate(rows[index]);
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
        <span class="ttl">{title}</span>
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
          placeholder={scanned ? "Search plots by name…  (or browse below)" : "Scanning plots/…"}
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
              data-i={i}
              on:pointerenter={() => (index = i)}
              on:click={() => activate(r)}
            >
              <span class="ic">{r.kind === "dir" ? "📁" : r.kind === "up" ? "↩" : r.semantic ? "◆" : "◇"}</span>
              <span class="nm">{r.kind === "file" ? r.name.replace(/\.svg$/i, "") : r.name}</span>
              {#if q && r.rel && r.rel !== r.name}<span class="rel">{r.rel.replace(/\/[^/]+$/, "")}</span>{/if}
              {#if r.kind === "file" && r.semantic}<span class="badge">semantic</span>{/if}
            </div>
          {/each}
          {#if truncated}<div class="note">Showing the first 2000 plots — narrow your search.</div>{/if}
        {/if}
      </div>

      <div class="foot">
        <span><b>↑↓</b> navigate</span>
        <span><b>↵</b> open / import</span>
        <span><b>⌫</b> up a folder</span>
        <span><b>esc</b> close</span>
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
</style>
