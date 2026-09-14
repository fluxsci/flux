<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { fileBridge } from "../project/types";
  import { createGalleryTree, normalizeGalleryPath, type GalleryTreeFile, type GalleryTreeRow } from "./galleryTree";

  /** Absolute plots/ root. The tree never changes project/editor state. */
  export let root = "";
  export let currentDirectory = "";
  export let selectedPath = "";
  export let allowVideos = false;
  export let refreshKey = 0;
  export let onNavigate: (path: string) => void = () => {};
  export let onSelectFile: (file: GalleryTreeFile) => void = () => {};
  export let onPreviewFile: ((file: GalleryTreeFile) => void) | undefined = undefined;
  export let onInsertFile: ((file: GalleryTreeFile) => void) | undefined = undefined;

  let revision = 0;
  const tree = createGalleryTree(async path => {
    const bridge = fileBridge();
    if (!bridge?.readdir) throw new Error("Folder browsing is unavailable.");
    return bridge.readdir(path);
  }, () => revision++);
  onDestroy(() => tree.dispose());
  const inputs = { root: "", videos: false, refresh: 0, initialized: false };
  $: {
    const nextRoot = normalizeGalleryPath(root);
    if (!inputs.initialized || inputs.root !== nextRoot || inputs.videos !== allowVideos) {
      inputs.initialized = true; inputs.root = nextRoot; inputs.videos = allowVideos; inputs.refresh = refreshKey;
      void tree.reset(nextRoot, allowVideos);
    } else if (inputs.refresh !== refreshKey) { inputs.refresh = refreshKey; void tree.refresh(); }
  }
  function snapshot(_revision: number) { return tree.rows(); }
  $: rows = snapshot(revision);

  const ROW_HEIGHT = 28, OVERSCAN = 5;
  let viewport: HTMLDivElement;
  let height = 400, scrollTop = 0;
  let focusedPath = "";
  let lastExternalPath = "";
  $: externalPath = normalizeGalleryPath(selectedPath || currentDirectory || root);
  $: if (externalPath !== lastExternalPath) { lastExternalPath = externalPath; focusedPath = externalPath; }
  $: start = Math.max(0, Math.min(Math.max(0, rows.length - 1), Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  $: end = Math.min(rows.length, start + Math.ceil(height / ROW_HEIGHT) + 2 * OVERSCAN);
  $: shown = rows.slice(start, end);
  const rowId = (path: string) => `gallery-tree-${encodeURIComponent(path)}`;
  $: activeDescendant = shown.some(row => row.abs === focusedPath) ? rowId(focusedPath) : undefined;

  let reconnectSize = () => {};
  /** A pinned gallery moves this mounted subtree into another owner window. */
  export function reconnect() { reconnectSize(); }
  function trackSize(node: HTMLDivElement) {
    let observer: ResizeObserver;
    const measure = () => { height = node.clientHeight || 400; scrollTop = node.scrollTop; };
    reconnectSize = () => {
      observer?.disconnect();
      const ownerWindow = node.ownerDocument.defaultView as Window & typeof globalThis;
      observer = new ownerWindow.ResizeObserver(measure);
      observer.observe(node); measure();
    };
    reconnectSize();
    return { destroy() { observer.disconnect(); reconnectSize = () => {}; } };
  }
  function ensureVisible(path: string) {
    if (!viewport) return;
    const index = rows.findIndex(row => row.abs === path);
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + height) viewport.scrollTop = top + ROW_HEIGHT - height;
    scrollTop = viewport.scrollTop;
  }
  async function revealTarget(treeRoot: string, selected: string, directory: string) {
    const target = normalizeGalleryPath(selected || directory || treeRoot);
    await tree.reveal(target, !selected);
    await tick();
    if (target === externalPath) ensureVisible(target);
  }
  $: if (root) void revealTarget(root, selectedPath, currentDirectory);
  function focusRow(row: GalleryTreeRow) { focusedPath = row.abs; viewport?.focus(); ensureVisible(row.abs); }
  function toggle(row: GalleryTreeRow) {
    focusRow(row);
    if (row.expanded) tree.collapse(row.abs); else void tree.expand(row.abs);
  }
  function choose(row: GalleryTreeRow, preview = false) {
    focusRow(row);
    if (row.kind === "dir") { void tree.expand(row.abs); onNavigate(row.abs); }
    else if (preview && onPreviewFile) onPreviewFile(row);
    else onSelectFile(row);
  }
  function onKey(event: KeyboardEvent) {
    const index = Math.max(0, rows.findIndex(row => row.abs === focusedPath));
    const row = rows[index];
    if (!row) return;
    const key = event.key;
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " ", "F4"].includes(key)) return;
    // Tree focus may differ from the gallery highlight after arrow navigation.
    // Route insertion with the actual focused file instead of bubbling stale state.
    if (key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); event.stopPropagation();
      if (row.kind === "file") onInsertFile?.(row);
      return;
    }
    event.preventDefault(); event.stopPropagation();
    if (key === "ArrowDown" || key === "ArrowUp") focusRow(rows[Math.max(0, Math.min(rows.length - 1, index + (key === "ArrowDown" ? 1 : -1)))]);
    else if (key === "Home" || key === "End") focusRow(rows[key === "Home" ? 0 : rows.length - 1]);
    else if (key === "ArrowRight") {
      if (row.kind === "dir" && !row.expanded) void tree.expand(row.abs);
      else if (rows[index + 1]?.depth > row.depth) focusRow(rows[index + 1]);
    } else if (key === "ArrowLeft") {
      if (row.kind === "dir" && row.expanded) tree.collapse(row.abs);
      else {
        const parent = rows.slice(0, index).reverse().find(candidate => candidate.depth < row.depth);
        if (parent) focusRow(parent);
      }
    } else if (key === "F4") { if (row.kind === "file") choose(row, true); }
    else choose(row);
  }
  const description = (row: GalleryTreeRow) => row.error ? `${row.name}: ${row.error}` : row.hint || row.rel || "plots";
</script>

<aside class="gallery-tree" aria-label="Plot files">
  <div class="tree-heading">Files</div>
  <div class="tree-viewport" bind:this={viewport} use:trackSize role="tree" aria-label="Files in plots" aria-activedescendant={activeDescendant} tabindex="0" on:keydown={onKey} on:scroll={() => scrollTop = viewport.scrollTop} data-total={rows.length} data-start={start}>
    <div class="tree-space" role="none" style:height={`${rows.length * ROW_HEIGHT}px`}>
      {#each shown as row, i (row.abs)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div id={rowId(row.abs)} class="tree-row" class:focused={focusedPath === row.abs} class:selected={normalizeGalleryPath(selectedPath || currentDirectory || root) === row.abs} role="treeitem" tabindex="-1" aria-level={row.depth + 1} aria-selected={focusedPath === row.abs} aria-expanded={row.kind === "dir" ? row.expanded : undefined} aria-busy={row.status === "loading" || undefined} data-path={row.abs} data-kind={row.kind} title={description(row)} style:top={`${(start + i) * ROW_HEIGHT}px`} style:padding-left={`${6 + row.depth * 14}px`} on:click={event => choose(row, event.ctrlKey || event.metaKey)}>
          {#if row.kind === "dir"}
            <button class="tree-disclosure" tabindex="-1" aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.name}`} on:click|stopPropagation={() => toggle(row)}>{row.expanded ? "▾" : "▸"}</button>
          {:else}<span class="tree-disclosure" aria-hidden="true"></span>{/if}
          <span class="tree-icon" aria-hidden="true">{row.kind === "dir" ? "▰" : row.video ? "▷" : "▧"}</span>
          <span class="tree-name">{row.name}</span>
          {#if row.status === "loading"}<span class="tree-status" aria-label="Loading">…</span>{/if}
          {#if row.status === "error"}<button class="tree-retry" tabindex="-1" aria-label={`Retry ${row.name}`} on:click|stopPropagation={() => void tree.retry(row.abs)}>↻</button>{/if}
        </div>
      {/each}
    </div>
    {#if !root}<p class="tree-empty">Open a project to browse plots.</p>{/if}
  </div>
</aside>

<style>
  .gallery-tree { display:flex; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0; background:var(--c-bg); color:var(--c-tx); }
  .tree-heading { padding:10px 12px 7px; color:var(--c-tx-muted); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
  .tree-viewport { flex:1; min-height:0; overflow:auto; outline:none; padding-bottom:8px; }
  .tree-space { position:relative; min-width:100%; }
  .tree-row { position:absolute; left:0; right:0; height:28px; display:flex; align-items:center; gap:5px; padding-right:6px; font-size:12px; cursor:default; box-sizing:border-box; }
  .tree-row:hover { background:var(--c-ui-hover); }
  .tree-row.selected { background:var(--c-surface); }
  .tree-viewport:focus .tree-row.focused { outline:1px solid var(--c-accent); outline-offset:-1px; background:var(--c-ui-hover); }
  .tree-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .tree-disclosure { display:inline-flex; align-items:center; justify-content:center; width:14px; height:22px; flex-shrink:0; padding:0; background:none; border:0; border-radius:3px; color:var(--c-tx-muted); font:inherit; }
  button.tree-disclosure:hover, .tree-retry:hover { background:var(--c-ui-hover); color:var(--c-tx); }
  .tree-icon { width:14px; flex-shrink:0; color:var(--c-tx-muted); }
  .tree-status { margin-left:auto; color:var(--c-tx-muted); }
  .tree-retry { margin-left:auto; border:0; background:none; color:var(--c-accent); padding:2px 4px; }
  .tree-empty { padding:8px 12px; font-size:12px; color:var(--c-tx-muted); }
</style>
