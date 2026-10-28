<script lang="ts">
  // The Plots rail's lower pane as a folder navigator (Alt+/): every folder under the gallery's
  // base — empty ones too, reserved companion trees pruned — searchable, windowed, keyboard-led.
  // Choosing a folder scopes the gallery above to it; the counts are the gallery's own listing.
  import { fileBridge, joinPath } from "../project/types";
  import { isReservedPlotDirName } from "../project/plotsFolders";

  let { base, selected = "", counts, onChoose, onClose }: {
    base: string;
    selected?: string;
    /** Listed plots under each folder (nested ones included); "" is the whole base. */
    counts: ReadonlyMap<string, number>;
    onChoose: (folder: string) => void;
    onClose: () => void;
  } = $props();

  type Folder = { rel: string; name: string; depth: number };
  const ROW = 24, MAX_FOLDERS = 20000, READERS = 8;
  const order = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  let folders = $state.raw<Folder[]>([]), search = $state(""), error = $state(""), loading = $state(false);
  let collapsed = $state.raw(new Set<string>()), focus = $state(""), revision = $state(0);
  let input = $state<HTMLInputElement>();
  let viewport = $state<HTMLDivElement>();
  let viewportHeight = $state(300), scrollTop = $state(0);

  const parentOf = (rel: string) => rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  $effect(() => {
    const root = base; revision;
    let alive = true;
    folders = []; error = "";
    if (!root) return;
    const fb = fileBridge(), readdir = fb?.readdir?.bind(fb);
    if (!readdir) { error = "Folder navigation needs the desktop app"; return; }
    loading = true;
    void (async () => {
      const out: Folder[] = [{ rel: "", name: root.split(/[\\/]/).pop() || "plots", depth: 0 }];
      // Level by level, a few reads in flight: a deep library is hundreds of IPC round trips.
      // An unreadable folder is skipped, not fatal.
      for (let level = [""]; level.length && alive; ) {
        const next: string[] = [];
        for (let i = 0; i < level.length && alive; i += READERS) {
          const batch = await Promise.all(level.slice(i, i + READERS).map((rel) =>
            readdir(rel ? joinPath(root, rel) : root, true).then((entries) => ({ rel, entries }), () => ({ rel, entries: [] }))));
          for (const { rel, entries } of batch) for (const e of entries) {
            if (!e.dir || isReservedPlotDirName(e.name) || e.name.startsWith(".") || /[\\/]/.test(e.name)) continue;
            if (out.length >= MAX_FOLDERS) throw new Error("More than 20,000 folders — narrow the plot library to browse it");
            const child = rel ? `${rel}/${e.name}` : e.name;
            out.push({ rel: child, name: e.name, depth: child.split("/").length });
            next.push(child);
          }
        }
        level = next;
      }
      out.sort((a, b) => {
        const aa = a.rel.split("/"), bb = b.rel.split("/");
        for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return order.compare(aa[i], bb[i]);
        return aa.length - bb.length;
      });
      if (!alive) return;
      folders = out; focus = selected;
      void Promise.resolve().then(() => reveal(selected, "center"));
    })().catch((e) => { if (alive) error = String(e?.message ?? e); }).finally(() => { if (alive) loading = false; });
    return () => { alive = false; };
  });

  const q = $derived(search.trim().toLocaleLowerCase());
  const parents = $derived(new Set(folders.filter((f) => f.rel).map((f) => parentOf(f.rel))));
  const shown = $derived.by(() => {
    if (q) {
      // A match shows with its ancestry, so the tree still reads as a tree.
      const matching = new Set<string>([""]);
      for (const f of folders) if (f.rel.toLocaleLowerCase().includes(q)) {
        for (let rel = f.rel; rel; rel = parentOf(rel)) matching.add(rel);
      }
      return folders.filter((f) => matching.has(f.rel));
    }
    return folders.filter((f) => {
      for (let rel = f.rel; rel; ) { rel = parentOf(rel); if (collapsed.has(rel)) return false; if (!rel) break; }
      return true;
    });
  });
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 5));
  const windowed = $derived(shown.slice(first, first + Math.ceil(viewportHeight / ROW) + 10));

  function reveal(rel: string, at: "nearest" | "center" = "nearest") {
    if (!viewport) return;
    const i = shown.findIndex((f) => f.rel === rel);
    if (i < 0) return;
    const y = i * ROW;
    if (at === "center") viewport.scrollTop = Math.max(0, y - (viewportHeight - ROW) / 2);
    else if (y < viewport.scrollTop) viewport.scrollTop = y;
    else if (y + ROW > viewport.scrollTop + viewportHeight) viewport.scrollTop = y + ROW - viewportHeight;
  }
  function choose(folder: Folder) { focus = folder.rel; onChoose(folder.rel); viewport?.focus(); }
  function toggle(folder: Folder) {
    const next = new Set(collapsed);
    if (!next.delete(folder.rel)) next.add(folder.rel);
    collapsed = next;
  }
  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target === input) return;
    const i = Math.max(0, shown.findIndex((f) => f.rel === focus)), row = shown[i];
    if (!row) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") focus = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].rel;
    else if (e.key === "Home" || e.key === "End") focus = shown[e.key === "Home" ? 0 : shown.length - 1].rel;
    else if (e.key === "Enter" || e.key === " ") choose(row);
    else if (e.key === "ArrowRight" && collapsed.has(row.rel)) toggle(row);
    else if (e.key === "ArrowLeft") { if (!collapsed.has(row.rel) && parents.has(row.rel)) toggle(row); else focus = parentOf(row.rel); }
    else if (e.key === "Escape") { if (search) search = ""; else onClose(); }
    else return;
    e.preventDefault();
    queueMicrotask(() => reveal(focus));
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); viewport?.focus(); }
    else if (e.key === "Enter" && q) { e.preventDefault(); const hit = shown.find((f) => f.rel.toLocaleLowerCase().includes(q)); if (hit) choose(hit); }
    else if (e.key === "Escape") { e.preventDefault(); if (search) search = ""; else onClose(); }
  }
</script>

<section class="directory" data-plots-directories>
  <header>
    <span class="eyebrow">Folders</span>
    <span class="grow"></span>
    <button aria-label="Refresh folders" title="Re-read the folders" onclick={() => revision++}>↻</button>
    <button aria-label="Show dissections" title="Back to Dissections (Alt+/)" onclick={onClose}>✕</button>
  </header>
  <input bind:this={input} bind:value={search} aria-label="Search plot folders" placeholder="Find a folder" spellcheck="false" onkeydown={onSearchKey} />
  <div class="tree" bind:this={viewport} bind:clientHeight={viewportHeight} role="tree" tabindex="0" aria-label="Plot folders"
    aria-activedescendant={windowed.some((f) => f.rel === focus) ? `plot-folder-${encodeURIComponent(focus)}` : undefined}
    onkeydown={onKey} onscroll={() => scrollTop = viewport?.scrollTop ?? 0}>
    <div class="tree-space" role="none" style:height={`${shown.length * ROW}px`}>
      {#each windowed as folder, i (folder.rel)}
        {@const children = parents.has(folder.rel)}
        {@const n = counts.get(folder.rel) ?? 0}
        <!-- svelte-ignore a11y_click_events_have_key_events (the tree owns keyboard navigation) -->
        <div id={`plot-folder-${encodeURIComponent(folder.rel)}`} class="row" class:selected={selected === folder.rel} class:focused={focus === folder.rel} class:empty={!n}
          role="treeitem" aria-level={folder.depth + 1} aria-selected={selected === folder.rel} aria-expanded={children ? !collapsed.has(folder.rel) : undefined} tabindex="-1"
          style:top={`${(first + i) * ROW}px`} style:padding-left={`${4 + folder.depth * 12}px`} onclick={() => choose(folder)} ondblclick={() => toggle(folder)}>
          <button class="disclose" class:open={!collapsed.has(folder.rel)} tabindex="-1" disabled={!children || !!q} aria-label={`${collapsed.has(folder.rel) ? "Expand" : "Collapse"} ${folder.name}`}
            onclick={(e) => { e.stopPropagation(); toggle(folder); }}><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.2 1.8 L6.6 5 L3.2 8.2" /></svg></button>
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4V2.5h5l1.5 1.5h6.5v9.5h-13Z" /></svg>
          <span class="name">{folder.name}</span>
          {#if n}<span class="count">{n}</span>{/if}
        </div>
      {/each}
    </div>
    {#if loading}<p>Reading folders…</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if !loading && q && shown.length <= 1}<p>No matching folders.</p>{/if}
  </div>
</section>

<style>
  .directory { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--c-bg-raised); font: 11.5px var(--font-ui); }
  header { display: flex; align-items: center; gap: 2px; height: 28px; flex-shrink: 0; padding: 0 4px 0 8px; border-bottom: 1px solid var(--c-line); }
  .eyebrow { color: var(--c-tx-muted); font: 600 10px var(--font-mono); text-transform: uppercase; letter-spacing: .08em; }
  .grow { flex: 1; }
  header button { width: 22px; height: 22px; padding: 0; border: 0; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover); }
  header button:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  input { flex-shrink: 0; height: 26px; min-width: 0; padding: 0 8px; border: 0; border-bottom: 1px solid var(--c-line); outline: 0; background: var(--c-bg); color: var(--c-tx); font: 11.5px var(--font-mono); }
  input:focus { border-bottom-color: var(--c-accent); }
  .tree { flex: 1; min-height: 0; overflow: auto; outline: 0; }
  .tree-space { position: relative; min-width: 100%; }
  .row { position: absolute; left: 0; right: 0; box-sizing: border-box; display: flex; align-items: center; gap: 4px; height: 24px; padding-right: 8px; color: var(--c-tx-2); cursor: var(--cursor-cross-hover); }
  .row:hover { background: var(--c-surface-2); }
  .row.selected { background: var(--c-accent-tint); box-shadow: inset 2px 0 var(--c-accent); color: var(--c-tx-hi); }
  .tree:focus .row.focused { outline: 1px solid var(--c-accent); outline-offset: -1px; }
  .row.empty { color: var(--c-tx-muted); }
  .disclose { flex: 0 0 14px; width: 14px; height: 14px; padding: 0; border: 0; background: none; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover); }
  .disclose:disabled { visibility: hidden; }
  .disclose svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.4; transition: transform 80ms linear; }
  .disclose.open svg { transform: rotate(90deg); }
  .icon { flex: 0 0 13px; width: 13px; height: 13px; fill: none; stroke: var(--c-tx-muted); stroke-width: 1.1; stroke-linejoin: round; }
  .row.selected .icon { stroke: var(--c-accent); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { flex-shrink: 0; color: var(--c-tx-muted); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; }
  .tree p { margin: 0; padding: 8px; color: var(--c-tx-muted); font-size: 11px; }
  @media (prefers-reduced-motion: reduce) { .disclose svg { transition: none; } }
</style>
