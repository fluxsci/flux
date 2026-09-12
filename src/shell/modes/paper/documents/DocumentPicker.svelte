<script lang="ts">
  import { tick, onDestroy, untrack } from 'svelte';
  import type { DocEntry } from './documents';
  import { documentRemovalBlocker } from '../../../../lib/project/docOrder';
  import { parentDir, fileName } from '../../../../lib/project/documentFiles';
  import { documentTree, type DocumentTreeItem as Item } from './documentTree';
  import { CONTEXT_DOC_RELS } from '../../../../lib/project/contextTemplates';
  import { paperTextScale } from '../view-mode/paperTextScaleStore';
  import { clampScale } from '../view-mode/paperTextScale';

  let { docs, folders = [], root = 'paper', storageKey = '', activePath, onSelect, onNew, onFolder, onMove, onReorder, onDelete }: {
    docs: DocEntry[]; folders?: string[]; root?: string; storageKey?: string; activePath: string;
    onSelect: (path: string) => void; onNew: (folder?: string) => void;
    onFolder?: (parent: string) => void; onMove?: (path: string, folder: string) => void;
    onReorder?: (path: string, toIndex: number) => void; onDelete?: (path: string) => void;
  } = $props();
  let collapsed = $state<string[]>([]);
  let selectedFolder = $state('');
  let pickerEl: HTMLElement;
  let dragPath = $state<string | null>(null);
  let dropFolder = $state<string | null>(null);
  let dragFrom: { path: string; x: number; y: number } | null = null;
  let dragMoved = false;
  let scrollEl: HTMLDivElement;
  let dragFrame = 0;
  let pointer = { x: 0, y: 0 };
  let savedKey = '';
  $effect(() => {
    if (savedKey === storageKey) return;
    savedKey = storageKey;
    try { collapsed = JSON.parse(localStorage.getItem(`flux.paper.folders:${storageKey}`) || '[]'); } catch { collapsed = []; }
  });
  function toggle(path: string) {
    collapsed = collapsed.includes(path) ? collapsed.filter(p => p !== path) : [...collapsed, path];
    localStorage.setItem(`flux.paper.folders:${storageKey}`, JSON.stringify(collapsed));
    selectedFolder = path;
  }
  // Opening a document from the palette reveals its ancestors once; manual
  // collapsing remains possible while that document stays active.
  $effect(() => {
    const path = activePath;
    if (!path) return;
    untrack(() => { collapsed = collapsed.filter(p => !path.startsWith(p + '/')); });
    selectedFolder = parentDir(path);
  });
  const canDelete = (path: string) => !!onDelete && !documentRemovalBlocker(docs, path);
  const docItems = $derived(documentTree(docs, folders, root, false, collapsed));
  const contextItems = $derived(documentTree(docs, folders, root, true, collapsed));
  let scrollY = $state(0);
  let scrollHeight = $state(500);
  // Row height is the ONE number the virtual window and the CSS must agree on,
  // and the sidebar's text size moves it (a 30px row clips 150% type). Both
  // sides read this: the window arithmetic below, and --dp-row in the style
  // block. The 8-row overscan absorbs the small drift in the header offsets.
  const ROW_H = $derived(Math.round(30 * clampScale($paperTextScale.scale.sidebar)));
  // One shared scrollbar; only the visible rows mount for a large project.
  function visible(items: Item[], offset: number, rowH: number) {
    if (items.length < 250) return { rows: items, before: 0, after: 0 };
    const first = Math.max(0, Math.min(items.length, Math.floor((scrollY - offset) / rowH) - 8));
    const last = Math.max(first, Math.min(items.length, Math.ceil((scrollY + scrollHeight - offset) / rowH) + 8));
    return { rows: items.slice(first,last), before: first * rowH, after: (items.length-last) * rowH };
  }
  const docWindow = $derived(visible(docItems, 36, ROW_H));
  const contextWindow = $derived(visible(contextItems, 74 + docItems.length * ROW_H, ROW_H));
  const targetFolder = $derived(selectedFolder || root);

  function startDrag(e: PointerEvent, path: string) {
    if (e.button !== 0) return;
    dragFrom = { path, x: e.clientX, y: e.clientY }; dragMoved = false;
  }
  function dragMove(e: PointerEvent) {
    if (!dragFrom) return;
    pointer = { x: e.clientX, y: e.clientY };
    if (!dragPath) {
      if (Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) < 4) return;
      dragPath = dragFrom.path; dragMoved = true;
      dragFrame = requestAnimationFrame(autoScroll);
    }
    const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const folder = hit?.closest<HTMLElement>('[data-folder]')?.dataset.folder;
    dropFolder = folder && folder !== parentDir(dragPath) && !CONTEXT_DOC_RELS.includes(dragPath) ? folder : null;
    if (folder) return;
    const row = hit?.closest<HTMLElement>('.dp-row[data-path]')?.dataset.path;
    if (!row || row === dragPath || parentDir(row) !== parentDir(dragPath)) return;
    const group = docs.filter(d => !!d.isContext === !!docs.find(x => x.path === dragPath)?.isContext);
    const at = group.findIndex(d => d.path === row);
    if (at >= 0) onReorder?.(dragPath, at);
  }
  function autoScroll() {
    if (!dragPath) return;
    const r = scrollEl.getBoundingClientRect();
    if (pointer.x >= r.left && pointer.x <= r.right) {
      const delta = pointer.y < r.top + 26 ? -10 : pointer.y > r.bottom - 26 ? 10 : 0;
      if (delta) {
        scrollEl.scrollTop += delta;
        const hit = document.elementFromPoint(pointer.x, pointer.y) as HTMLElement | null;
        const folder = hit?.closest<HTMLElement>('[data-folder]')?.dataset.folder;
        dropFolder = folder != null && folder !== parentDir(dragPath) && !CONTEXT_DOC_RELS.includes(dragPath) ? folder : null;
      }
    }
    dragFrame = requestAnimationFrame(autoScroll);
  }
  function endDrag() {
    const path = dragPath, folder = dropFolder;
    cancelDrag();
    if (path && folder) onMove?.(path, folder);
  }
  function cancelDrag() { cancelAnimationFrame(dragFrame); dragPath = null; dragFrom = null; dropFolder = null; }
  function pick(path: string) { if (!dragMoved) onSelect(path); }
  async function rowKey(e: KeyboardEvent, d: DocEntry) {
    if (e.key === 'Delete' && !e.altKey && !e.ctrlKey && !e.metaKey && canDelete(d.path)) {
      e.preventDefault(); e.stopPropagation(); onDelete?.(d.path); return;
    }
    if (!onReorder || !e.altKey || e.ctrlKey || e.metaKey || !['ArrowUp','ArrowDown'].includes(e.key)) return;
    const siblings = docs.filter(x => parentDir(x.path) === parentDir(d.path));
    const at = siblings.findIndex(x => x.path === d.path) + (e.key === 'ArrowUp' ? -1 : 1);
    if (at < 0 || at >= siblings.length) return;
    const group = docs.filter(x => !!x.isContext === !!d.isContext);
    e.preventDefault(); e.stopPropagation();
    onReorder(d.path, group.findIndex(x => x.path === siblings[at].path));
    await tick();
    [...pickerEl.querySelectorAll<HTMLElement>('.dp-item')].find(b => b.title === d.path)?.focus();
  }
  onDestroy(cancelDrag);
</script>

<svelte:window onpointermove={dragMove} onpointerup={endDrag} onpointercancel={cancelDrag}
  onkeydown={(e) => { if (e.key === 'Escape') cancelDrag(); }} onblur={cancelDrag} />

{#snippet folderRow(path: string, label: string, depth: number, top = false)}
  <div class="dp-folder" class:dp-head={top} class:drop-target={dropFolder === path} data-folder={path} style={`--depth:${depth}`}>
    <button class="folder-label" aria-expanded={!collapsed.includes(path)} title={path || 'Documents'} onclick={() => toggle(path)}>
      <svg class:open={!collapsed.includes(path)} width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2z" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
      <span>{label}</span>
    </button>
    <button class="folder-action" title={`New document in ${label}`} aria-label={`New document in ${label}`} onclick={() => onNew(path)}>+</button>
    {#if onFolder}<button class="folder-action" title={`New folder in ${label}`} aria-label={`New folder in ${label}`} onclick={() => onFolder?.(path)}><svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2zM10 9v6m-3-3h6" fill="none" stroke="currentColor" stroke-width="1.3" /></svg></button>{/if}
  </div>
{/snippet}

{#snippet treeRows(rows: Item[])}
  {#each rows as item (item.path)}
    <li style={`--depth:${item.depth}`}>
      {#if item.doc}
        {@const d = item.doc}
        <div class="dp-row" role="presentation" data-path={d.path} class:dragging={dragPath === d.path} onpointerdown={(e) => startDrag(e, d.path)}>
          <button class="dp-item" class:active={d.path === activePath} title={d.path} onclick={() => pick(d.path)} onkeydown={(e) => rowKey(e,d)}>
            <svg class="doc-icon" width="14" height="16" viewBox="0 0 18 20" aria-hidden="true"><path d="M3 1h8l4 4v14H3zM10 1v5h5M6 10h6M6 13h6" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
            <span class="dp-title">{d.title}</span>
            {#if d.isMain}<span class="dp-badge">main</span>{/if}
          </button>
          {#if canDelete(d.path)}<button class="dp-del" title="Delete this document…" aria-label={`Delete ${d.title}`} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); onDelete?.(d.path); }}>×</button>{/if}
        </div>
      {:else}
        {@render folderRow(item.path, fileName(item.path), item.depth + 1)}
      {/if}
    </li>
  {/each}
{/snippet}

<aside class="docpicker" bind:this={pickerEl} aria-label="Project files">
  <div class="dp-scroll" bind:this={scrollEl} bind:clientHeight={scrollHeight} onscroll={(e) => { scrollY = e.currentTarget.scrollTop; }}>
    {@render folderRow(root, 'Documents', 0, true)}
    <ul aria-label="Documents" style={`padding-top:${docWindow.before}px;padding-bottom:${docWindow.after}px`}>{@render treeRows(docWindow.rows)}</ul>
    {#if !docItems.length && !collapsed.includes(root)}<p class="dp-empty">Create a document to get started.</p>{/if}
    {@render folderRow('Context', 'Context', 0, true)}
    <ul aria-label="Context" style={`padding-top:${contextWindow.before}px;padding-bottom:${contextWindow.after}px`}>{@render treeRows(contextWindow.rows)}</ul>
  </div>
  <div class="dp-footer">
    <button class="dp-new" title={`New document in ${targetFolder}`} onclick={() => onNew(targetFolder)}>+ New document</button>
    {#if onFolder}<button class="dp-new-folder" title={`New folder in ${targetFolder}`} onclick={() => onFolder?.(targetFolder)}>New folder</button>{/if}
  </div>
</aside>

<style>
  .docpicker { display:flex; flex-direction:column; min-height:0; height:100%; color:var(--c-tx); --dp-row: calc(30px * var(--ts-scale)); }
  .dp-scroll { flex:1; min-height:0; overflow:auto; padding:6px; }
  ul { list-style:none; padding:0; margin:0; }
  li { margin:0; }
  button { font:inherit; cursor:pointer; border:0; background:transparent; color:var(--c-tx-2); border-radius:var(--r-1); }
  button:focus-visible { outline:2px solid var(--c-accent); outline-offset:-2px; }
  button:hover { background:var(--c-ui-hover); color:var(--c-tx-hi); }
  .dp-folder { display:flex; align-items:center; padding-left:calc(var(--depth) * 14px); border-radius:var(--r-1); }
  .dp-head { margin-top:8px; font-weight:600; font-size:var(--ts-sm); }
  .dp-head:first-child { margin-top:0; }
  .folder-label { display:flex; gap:6px; align-items:center; flex:1; min-width:0; text-align:left; height:var(--dp-row); padding:0 5px; }
  .folder-label span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .folder-label svg { flex:none; color:var(--c-tx-faint); }
  .folder-label svg:first-child.open { transform:rotate(90deg); }
  .folder-action { display:grid; place-items:center; width:24px; height:24px; padding:0; opacity:0; flex:none; }
  .dp-folder:hover .folder-action, .dp-folder:focus-within .folder-action { opacity:1; }
  .dp-head .folder-action { opacity:1; }
  .drop-target { background:var(--c-ui-hover); box-shadow:inset 0 0 0 2px var(--c-accent); }
  .dp-row { display:flex; align-items:center; padding-left:calc(16px + var(--depth) * 14px); min-width:0; }
  .dp-item { display:flex; align-items:center; flex:1; min-width:0; gap:7px; text-align:left; height:var(--dp-row); padding:4px 6px; font-size:var(--ts-sm); }
  .doc-icon { flex:none; color:var(--c-tx-faint); }
  .dp-item.active { background:var(--c-ui-hover); color:var(--c-tx-hi); font-weight:600; }
  .dp-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dp-badge { font-size:9px; text-transform:uppercase; color:var(--c-accent-bright); }
  .dp-del { width:22px; height:24px; flex:none; padding:0; opacity:0; font-size:16px; }
  .dp-row:hover .dp-del, .dp-row:focus-within .dp-del { opacity:1; }
  .dp-del:hover { color:var(--c-danger); }
  .dragging { opacity:.55; }
  .dp-footer { display:flex; align-items:center; gap:4px; padding:6px; border-top:1px solid var(--c-line); }
  .dp-new, .dp-new-folder { padding:6px; font-size:var(--ts-xs); white-space:nowrap; }
  .dp-new { flex:1; text-align:left; }
  .dp-empty { margin:8px 10px 14px; color:var(--c-tx-faint); font-size:var(--ts-xs); }
</style>
