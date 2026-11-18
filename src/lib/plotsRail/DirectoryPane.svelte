<script lang="ts">
  // The Plots rail's folder navigator (Alt+/): every folder under the gallery's base — empty
  // ones too, reserved companion trees pruned — searchable, windowed, keyboard-led. Choosing a
  // folder scopes the gallery to it; the counts are the gallery's own listing.
  //
  // 2026-11-18 (owner: "the feel … when expanding/collapsing, selecting, searching, and I'd
  // also love the option for this to NOT take over the dissection pane"): by default it opens
  // BESIDE the rail, as a panel off the rail's edge that leaves Dissections where it is
  // (PlotsRail hosts it; `floating`), and the button in its header moves it into the lower
  // pane and back. The search leads: the caret stays in the field while ↑ / ↓ move through the
  // folders and Enter chooses; matches are marked in the names; typing in the tree types into
  // the search. Rows have guide lines, an open or closed folder, and one highlight.
  import { fileBridge, joinPath } from "../project/types";
  import { isReservedPlotDirName } from "../project/plotsFolders";

  let { base, selected = "", counts, onChoose, onClose, floating = false, onPlacement }: {
    base: string;
    selected?: string;
    /** Listed plots under each folder (nested ones included); "" is the whole base. */
    counts: ReadonlyMap<string, number>;
    onChoose: (folder: string) => void;
    onClose: () => void;
    /** Hosted beside the rail rather than in its lower pane. */
    floating?: boolean;
    /** Move it to the other place (beside the rail ↔ the lower pane). */
    onPlacement?: () => void;
  } = $props();

  type Folder = { rel: string; name: string; depth: number };
  const ROW = 26, MAX_FOLDERS = 20000, READERS = 8, INDENT = 14;
  const order = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  let folders = $state.raw<Folder[]>([]), search = $state(""), error = $state(""), loading = $state(false), capped = $state(false);
  let collapsed = $state.raw(new Set<string>()), focus = $state(""), revision = $state(0);
  let input = $state<HTMLInputElement>();
  let viewport = $state<HTMLDivElement>();
  let viewportHeight = $state(300), scrollTop = $state(0);

  const parentOf = (rel: string) => rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  let first = true;
  $effect(() => {
    const root = base; revision;
    let alive = true;
    error = "";
    // A re-read keeps what is on screen until the new tree arrives; a new base starts empty.
    if (!root) { folders = []; return; }
    const fb = fileBridge(), readdir = fb?.readdir?.bind(fb);
    if (!readdir) { error = "Folder navigation needs the desktop app"; return; }
    loading = true;
    void (async () => {
      const out: Folder[] = [{ rel: "", name: root.split(/[\\/]/).pop() || "plots", depth: 0 }];
      let full = false;
      // Level by level, a few reads in flight: a deep library is hundreds of IPC round trips.
      // An unreadable folder is skipped, not fatal.
      for (let level = [""]; level.length && alive && !full; ) {
        const next: string[] = [];
        for (let i = 0; i < level.length && alive && !full; i += READERS) {
          const batch = await Promise.all(level.slice(i, i + READERS).map((rel) =>
            readdir(rel ? joinPath(root, rel) : root, true).then((entries) => ({ rel, entries }), () => ({ rel, entries: [] }))));
          for (const { rel, entries } of batch) for (const e of entries) {
            if (!e.dir || isReservedPlotDirName(e.name) || e.name.startsWith(".") || /[\\/]/.test(e.name)) continue;
            // A library this large still opens: the first 20,000 folders, and a line that says so.
            if (out.length >= MAX_FOLDERS) { full = true; break; }
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
      folders = out; capped = full;
      if (first) { first = false; focus = selected; void Promise.resolve().then(() => reveal(selected, "center")); }
    })().catch((e) => { if (alive) error = String(e?.message ?? e); }).finally(() => { if (alive) loading = false; });
    return () => { alive = false; };
  });
  // Live: when the gallery lists plots under a folder this tree has not seen, read the tree again
  // (once per new set of folders: a companion folder the tree leaves out on purpose must not loop).
  let seenMissing = "";
  $effect(() => {
    if (loading || !folders.length || capped) return;
    const known = new Set(folders.map((f) => f.rel));
    const missing = [...counts.keys()].filter((rel) => rel && !known.has(rel) && !rel.split("/").some((part) => isReservedPlotDirName(part) || part.startsWith("."))).sort().join("\n");
    if (missing && missing !== seenMissing) { seenMissing = missing; revision++; }
  });

  const q = $derived(search.trim().toLocaleLowerCase());
  const parents = $derived(new Set(folders.filter((f) => f.rel).map((f) => parentOf(f.rel))));
  const matches = $derived(q ? folders.filter((f) => f.rel && f.name.toLocaleLowerCase().includes(q)).length : 0);
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
  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 5));
  const windowed = $derived(shown.slice(start, start + Math.ceil(viewportHeight / ROW) + 10));
  /** A name cut around the search, for marking the match without innerHTML. */
  function parts(name: string): { text: string; hit: boolean }[] {
    if (!q) return [{ text: name, hit: false }];
    const at = name.toLocaleLowerCase().indexOf(q);
    if (at < 0) return [{ text: name, hit: false }];
    return [{ text: name.slice(0, at), hit: false }, { text: name.slice(at, at + q.length), hit: true }, { text: name.slice(at + q.length), hit: false }].filter((p) => p.text);
  }

  function reveal(rel: string, at: "nearest" | "center" = "nearest") {
    if (!viewport) return;
    const i = shown.findIndex((f) => f.rel === rel);
    if (i < 0) return;
    const y = i * ROW;
    if (at === "center") viewport.scrollTop = Math.max(0, y - (viewportHeight - ROW) / 2);
    else if (y < viewport.scrollTop) viewport.scrollTop = y;
    else if (y + ROW > viewport.scrollTop + viewportHeight) viewport.scrollTop = y + ROW - viewportHeight;
  }
  function choose(folder: Folder, keepFocus = false) { focus = folder.rel; onChoose(folder.rel); if (!keepFocus) viewport?.focus(); }
  function toggle(folder: Folder, deep = false) {
    const next = new Set(collapsed);
    const closing = !next.has(folder.rel);
    // Alt: the whole branch under it, opened or closed with it.
    const branch = deep ? folders.filter((f) => (f.rel === folder.rel || f.rel.startsWith(`${folder.rel}/`)) && parents.has(f.rel)) : [folder];
    for (const f of branch) { if (closing) next.add(f.rel); else next.delete(f.rel); }
    collapsed = next;
  }
  /** Move the highlight by `delta` rows (or to an end), keeping it in view. */
  function move(delta: number, to?: "first" | "last") {
    if (!shown.length) return;
    const i = Math.max(0, shown.findIndex((f) => f.rel === focus));
    focus = shown[to === "first" ? 0 : to === "last" ? shown.length - 1 : Math.max(0, Math.min(shown.length - 1, i + delta))].rel;
    queueMicrotask(() => reveal(focus));
  }
  const page = () => Math.max(1, Math.floor(viewportHeight / ROW) - 1);
  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target === input) return;
    const i = Math.max(0, shown.findIndex((f) => f.rel === focus)), row = shown[i];
    if (!row) return;
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(page());
    else if (e.key === "PageUp") move(-page());
    else if (e.key === "Home") move(0, "first");
    else if (e.key === "End") move(0, "last");
    else if (e.key === "Enter" || e.key === " ") choose(row);
    else if (e.key === "ArrowRight") { if (collapsed.has(row.rel)) toggle(row); else if (parents.has(row.rel)) move(1); }
    else if (e.key === "ArrowLeft") { if (!collapsed.has(row.rel) && parents.has(row.rel) && !q) toggle(row); else if (row.rel) { focus = parentOf(row.rel); queueMicrotask(() => reveal(focus)); } }
    else if (e.key === "Escape") { if (search) search = ""; else onClose(); }
    else if (e.key === "/" || (e.key.length === 1 && e.key !== " ")) {
      // Typing in the tree types into the search.
      input?.focus();
      if (e.key === "/") e.preventDefault();
      return;
    }
    else return;
    e.preventDefault();
  }
  // The search leads: the caret stays in the field while the arrows walk the tree under it.
  function onSearchKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(page()); }
    else if (e.key === "PageUp") { e.preventDefault(); move(-page()); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const focused = shown.find((f) => f.rel === focus);
      const hit = q && !(focused && focused.rel.toLocaleLowerCase().includes(q)) ? shown.find((f) => f.rel && f.name.toLocaleLowerCase().includes(q)) : focused;
      if (hit) choose(hit, true);
    }
    else if (e.key === "Escape") { e.preventDefault(); if (search) search = ""; else onClose(); }
  }
  // A search puts the highlight on its first match, so Enter takes it.
  $effect(() => {
    if (!q) return;
    const hit = shown.find((f) => f.rel && f.name.toLocaleLowerCase().includes(q));
    if (hit) { focus = hit.rel; queueMicrotask(() => reveal(hit.rel)); }
  });
  // Opened from the keyboard, it is ready to type into.
  $effect(() => { if (floating) input?.focus({ preventScroll: true }); });
</script>

<section class="directory" class:floating data-plots-directories data-placement={floating ? "beside" : "below"}>
  <header>
    <svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4V2.5h5l1.5 1.5h6.5v9.5h-13Z" /></svg>
    <span class="eyebrow">Folders</span>
    {#if folders.length > 1}<span class="n">{folders.length - 1}</span>{/if}
    <span class="grow"></span>
    {#if onPlacement}
      <button aria-label={floating ? "Dock the folders in the lower pane" : "Float the folders beside the rail"} title={floating ? "Dock in the lower pane (takes the place of Dissections)" : "Float beside the rail (leaves Dissections in place)"} onclick={onPlacement} data-directory-placement>
        <svg viewBox="0 0 16 16" aria-hidden="true">{#if floating}<path d="M2.5 2.5h11v11h-11zM2.5 9h11" />{:else}<path d="M2.5 2.5h11v11h-11zM8.5 2.5v11" />{/if}</svg>
      </button>
    {/if}
    <button aria-label="Refresh folders" title="Read the folders again" onclick={() => revision++}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" /></svg></button>
    <button aria-label="Close folders" title={floating ? "Close (Alt+/ or Esc)" : "Back to Dissections (Alt+/)"} onclick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
  </header>
  <label class="find">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
    <input bind:this={input} bind:value={search} aria-label="Search plot folders" placeholder="Find a folder" spellcheck="false" autocomplete="off" onkeydown={onSearchKey} />
    {#if q}<span class="found">{matches}</span>{/if}
  </label>
  <div class="tree" bind:this={viewport} bind:clientHeight={viewportHeight} role="tree" tabindex="0" aria-label="Plot folders"
    aria-activedescendant={windowed.some((f) => f.rel === focus) ? `plot-folder-${encodeURIComponent(focus)}` : undefined}
    onkeydown={onKey} onscroll={() => scrollTop = viewport?.scrollTop ?? 0}>
    <div class="tree-space" role="none" style:height={`${shown.length * ROW}px`}>
      {#each windowed as folder, i (folder.rel)}
        {@const children = parents.has(folder.rel)}
        {@const open = children && (!!q || !collapsed.has(folder.rel))}
        {@const n = counts.get(folder.rel) ?? 0}
        <!-- svelte-ignore a11y_click_events_have_key_events (the tree owns keyboard navigation) -->
        <div id={`plot-folder-${encodeURIComponent(folder.rel)}`} class="row" class:selected={selected === folder.rel} class:focused={focus === folder.rel} class:empty={!n} class:root={!folder.rel}
          role="treeitem" aria-level={folder.depth + 1} aria-selected={selected === folder.rel} aria-expanded={children ? !collapsed.has(folder.rel) : undefined} tabindex="-1"
          style:top={`${(start + i) * ROW}px`} style:padding-left={`${6 + folder.depth * INDENT}px`} style:--guides={`${folder.depth * INDENT}px`} onclick={() => choose(folder)} ondblclick={() => toggle(folder)}>
          <button class="disclose" class:open tabindex="-1" disabled={!children || !!q} aria-label={`${collapsed.has(folder.rel) ? "Expand" : "Collapse"} ${folder.name}`} title="Alt-click opens or closes the whole branch"
            onclick={(e) => { e.stopPropagation(); toggle(folder, e.altKey); }}><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.2 1.8 L6.6 5 L3.2 8.2" /></svg></button>
          <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">{#if open}<path d="M1.5 12.5V2.5h5l1.5 1.5h5.5v2M1.5 12.5l2-6.5h11l-2 6.5z" />{:else}<path d="M1.5 4V2.5h5l1.5 1.5h6.5v9.5h-13Z" />{/if}</svg>
          <span class="name">{#each parts(folder.name) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
          {#if n}<span class="count">{n}</span>{/if}
        </div>
      {/each}
    </div>
    {#if loading && !folders.length}<p>Reading folders…</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if !loading && q && shown.length <= 1}<p>No folder matches <b>{search.trim()}</b>.</p>{/if}
  </div>
  {#if capped}<p class="cap">Showing the first {MAX_FOLDERS.toLocaleString()} folders. Search finds only these.</p>{/if}
  <footer><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> show</span><span><kbd>←</kbd><kbd>→</kbd> fold</span><span class="grow"></span><span><kbd>Esc</kbd></span></footer>
</section>

<style>
  .directory { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--c-bg-raised); color: var(--c-tx); font: 12px var(--font-ui); }
  /* Beside the rail: a panel of its own, off the rail's edge. */
  .directory.floating { height: 100%; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); box-shadow: var(--elev-3); overflow: hidden; }
  svg { display: block; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
  header { display: flex; align-items: center; gap: 6px; height: 30px; flex-shrink: 0; padding: 0 4px 0 9px; border-bottom: 1px solid var(--c-line); }
  .floating header { background: var(--c-bg-raised); }
  .mark { width: 13px; height: 13px; color: var(--c-tx-muted); }
  .eyebrow { color: var(--c-tx-muted); font: 600 10px var(--font-mono); text-transform: uppercase; letter-spacing: .08em; }
  .n { color: var(--c-tx-faint); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; }
  .grow { flex: 1; }
  header button { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, color 80ms linear; }
  header button svg { width: 13px; height: 13px; }
  header button:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  header button:active { background: var(--c-accent-tint); }
  .find { display: flex; align-items: center; gap: 7px; flex-shrink: 0; height: 28px; padding: 0 9px; border-bottom: 1px solid var(--c-line); background: var(--c-bg); color: var(--c-tx-muted); cursor: text; transition: box-shadow 80ms linear; }
  .find:focus-within { box-shadow: inset 0 -1px 0 var(--c-accent); color: var(--c-tx-2); }
  .find svg { width: 12px; height: 12px; stroke-width: 1.8; }
  input { flex: 1; min-width: 0; height: 26px; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; color: var(--c-tx-hi); font: 12px var(--font-ui); }
  input::placeholder { color: var(--c-tx-faint); }
  .found { color: var(--c-tx-muted); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; }
  .tree { flex: 1; min-height: 0; overflow: auto; outline: 0; }
  .tree-space { position: relative; min-width: 100%; }
  .row { position: absolute; left: 0; right: 0; box-sizing: border-box; display: flex; align-items: center; gap: 5px; height: 26px; padding-right: 9px; color: var(--c-tx-2); cursor: var(--cursor-cross-hover); }
  /* One hairline per level of nesting, so a deep folder shows what it sits under. */
  .row::before { content: ""; position: absolute; left: 13px; top: 0; bottom: 0; width: var(--guides); background: repeating-linear-gradient(to right, var(--c-line) 0 1px, transparent 1px 14px); pointer-events: none; }
  .row:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .row:active { background: var(--c-accent-tint); }
  .row.selected { background: var(--c-accent-tint); box-shadow: inset 2px 0 var(--c-accent); color: var(--c-tx-hi); }
  /* The highlight the keys move: shown while the navigator has the keyboard (its tree or its search). */
  .directory:focus-within .row.focused { outline: 1px solid var(--c-accent); outline-offset: -1px; }
  .row.empty { color: var(--c-tx-muted); }
  .row.root .name { font-weight: 600; }
  .disclose { position: relative; display: grid; place-items: center; flex: 0 0 14px; width: 14px; height: 18px; padding: 0; border: 0; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover); }
  .disclose:hover { color: var(--c-tx-hi); background: var(--c-line); }
  .disclose:disabled { visibility: hidden; }
  .disclose svg { width: 10px; height: 10px; stroke-width: 1.5; transition: transform 80ms linear; }
  .disclose.open svg { transform: rotate(90deg); }
  .icon { position: relative; flex: 0 0 14px; width: 14px; height: 14px; color: var(--c-tx-muted); }
  .row.selected .icon { color: var(--c-accent-bright); }
  .name { position: relative; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  mark { background: var(--c-accent-tint); box-shadow: inset 0 -1px 0 var(--c-accent); border-radius: 1px; color: var(--c-tx-hi); }
  .count { position: relative; flex-shrink: 0; color: var(--c-tx-muted); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; }
  .row.selected .count { color: var(--c-tx-2); }
  .tree p, .cap { margin: 0; padding: 9px 10px; color: var(--c-tx-muted); font: 11.5px/1.45 var(--font-serif); } .tree p b { color: var(--c-tx-2); font-weight: 600; }
  .cap { flex-shrink: 0; border-top: 1px solid var(--c-line); font-style: italic; }
  footer { display: flex; align-items: center; gap: 10px; height: 24px; flex-shrink: 0; padding: 0 9px; border-top: 1px solid var(--c-line); color: var(--c-tx-faint); font: 10.5px var(--font-ui); white-space: nowrap; overflow: hidden; }
  footer kbd { margin-right: 2px; }
  @media (prefers-reduced-motion: reduce) { .disclose svg, header button, .find { transition: none; } }
</style>
