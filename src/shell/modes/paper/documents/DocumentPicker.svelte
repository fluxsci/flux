<script lang="ts">
  import { yieldsToShellModal } from "../../../agent/annotationVisibility";
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
  // Unfolding: the rows a folder just revealed arrive with a short fade (and a 3 px rise where
  // motion is allowed). Layout never animates: the rows are simply there, at once.
  let unfolding = $state('');
  let unfoldTimer: ReturnType<typeof setTimeout> | undefined;
  function toggle(path: string) {
    const opening = collapsed.includes(path);
    collapsed = opening ? collapsed.filter(p => p !== path) : [...collapsed, path];
    localStorage.setItem(`flux.paper.folders:${storageKey}`, JSON.stringify(collapsed));
    selectedFolder = path;
    clearTimeout(unfoldTimer);
    unfolding = opening ? path : '';
    if (opening) unfoldTimer = setTimeout(() => (unfolding = ''), 260);
  }
  const fresh = (path: string) => !!unfolding && path.startsWith(unfolding + '/');

  // A filter for projects with more documents than fit: any part of a title or path.
  /** A filter that matches thousands shows its first rows, never thousands of them. */
  const MATCH_ROWS = 200;
  let filter = $state('');
  let filterEl: HTMLInputElement;
  const needle = $derived(filter.trim().toLowerCase());
  const matches = $derived(needle ? docs.filter(d => d.title.toLowerCase().includes(needle) || d.path.toLowerCase().includes(needle)) : []);
  function filterKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && filter) { e.preventDefault(); e.stopPropagation(); filter = ''; }
    else if (e.key === 'Enter' && matches.length) { e.preventDefault(); onSelect(matches[0].path); filter = ''; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); navRows()[0]?.focus(); }
  }

  // The files are a tree you can walk: ↑/↓ between the rows on show, → opens a folder or steps
  // into it, ← closes it or steps out to its folder, Home/End. Enter and Space are the row's
  // own click. Alt+↑/↓ (reorder) and Delete stay with the document row.
  const navRows = () => [...scrollEl.querySelectorAll<HTMLElement>('.folder-label, .dp-item')];
  function treeKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = navRows(), at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const row = rows[at], isFolder = row.classList.contains('folder-label'), open = row.getAttribute('aria-expanded') === 'true';
    const depthOf = (el: HTMLElement) => Number(el.dataset.depth ?? 0);
    const go = (i: number) => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') { if (at === 0 && filterEl) { e.preventDefault(); filterEl.focus(); } else go(at - 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'ArrowRight' && isFolder) { if (!open) { e.preventDefault(); row.click(); } else go(at + 1); }
    else if (e.key === 'ArrowLeft') {
      if (isFolder && open) { e.preventDefault(); row.click(); }
      else for (let i = at - 1; i >= 0; i--) if (rows[i].classList.contains('folder-label') && depthOf(rows[i]) < depthOf(row)) return go(i);
    }
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
  onDestroy(() => { cancelDrag(); clearTimeout(unfoldTimer); });
</script>

<svelte:window onpointermove={dragMove} onpointerup={endDrag} onpointercancel={cancelDrag}
  onkeydown={(e) => { if (yieldsToShellModal(e)) return; if (e.key === 'Escape') cancelDrag(); }} onblur={cancelDrag} />

{#snippet folderRow(path: string, label: string, depth: number, top = false)}
  {@const open = !collapsed.includes(path)}
  <div class="dp-folder" class:dp-head={top} class:unfold={!top && fresh(path)} class:drop-target={dropFolder === path} data-folder={path} style={`--depth:${depth}`}>
    <button class="folder-label" aria-expanded={open} data-depth={depth} title={path || 'Documents'} onclick={() => toggle(path)}>
      <svg class="chev" class:open width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
      {#if !top}
        <svg class="fold" width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">{#if open}<path d="M2 16V5h6l2 2h7v2.5M2 16l2.6-6.5h14L16 16z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />{:else}<path d="M2 5h6l2 2h8v10H2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />{/if}</svg>
      {/if}
      <span>{label}</span>
    </button>
    <button class="folder-action" title={`New document in ${label}`} aria-label={`New document in ${label}`} onclick={() => onNew(path)}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>
    {#if onFolder}<button class="folder-action" title={`New folder in ${label}`} aria-label={`New folder in ${label}`} onclick={() => onFolder?.(path)}><svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2zM10 9v6m-3-3h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg></button>{/if}
  </div>
{/snippet}

{#snippet docRow(d: DocEntry, depth: number, arriving = false)}
  <div class="dp-row" class:unfold={arriving} role="presentation" data-path={d.path} class:dragging={dragPath === d.path} onpointerdown={(e) => startDrag(e, d.path)}>
    <button class="dp-item" class:active={d.path === activePath} aria-current={d.path === activePath ? 'page' : undefined} data-depth={depth} title={d.path} onclick={() => pick(d.path)} onkeydown={(e) => rowKey(e,d)}>
      <svg class="doc-icon" width="14" height="16" viewBox="0 0 18 20" aria-hidden="true"><path d="M3 1h8l4 4v14H3zM10 1v5h5M6 10h6M6 13h6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
      <span class="dp-title">{d.title}</span>
      {#if d.isMain}<span class="dp-badge">main</span>{/if}
    </button>
    {#if canDelete(d.path)}<button class="dp-del" title="Delete this document…" aria-label={`Delete ${d.title}`} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); onDelete?.(d.path); }}><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg></button>{/if}
  </div>
{/snippet}

{#snippet treeRows(rows: Item[])}
  {#each rows as item (item.path)}
    <li style={`--depth:${item.depth}`}>
      {#if item.doc}
        {@render docRow(item.doc, item.depth + 1, fresh(item.path))}
      {:else}
        {@render folderRow(item.path, fileName(item.path), item.depth + 1)}
      {/if}
    </li>
  {/each}
{/snippet}

<aside class="docpicker" bind:this={pickerEl} aria-label="Project files">
  <div class="dp-filter">
    <svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true"><circle cx="6" cy="6" r="4.2" /><path d="M9.2 9.2l3.3 3.3" /></svg>
    <input bind:this={filterEl} bind:value={filter} onkeydown={filterKey} placeholder="Filter documents…" aria-label="Filter documents" spellcheck="false" autocomplete="off" />
    {#if needle}<span class="dp-hits">{matches.length.toLocaleString()}</span>{/if}
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dp-scroll" bind:this={scrollEl} bind:clientHeight={scrollHeight} onscroll={(e) => { scrollY = e.currentTarget.scrollTop; }} onkeydown={treeKey}>
    {#if needle}
      <ul class="dp-matches" aria-label="Matching documents">
        {#each matches.slice(0, MATCH_ROWS) as d (d.path)}<li style="--depth:0">{@render docRow(d, 0)}</li>{/each}
      </ul>
      {#if !matches.length}<p class="dp-empty">No document matches “{filter.trim()}”.</p>
      {:else if matches.length > MATCH_ROWS}<p class="dp-empty">The first {MATCH_ROWS} of {matches.length.toLocaleString()}. Keep typing to narrow it down.</p>{/if}
    {:else}
      {@render folderRow(root, 'Documents', 0, true)}
      <ul aria-label="Documents" style={`padding-top:${docWindow.before}px;padding-bottom:${docWindow.after}px`}>{@render treeRows(docWindow.rows)}</ul>
      {#if !docItems.length && !collapsed.includes(root)}<p class="dp-empty">Create a document to get started.</p>{/if}
      {@render folderRow('Context', 'Context', 0, true)}
      <ul aria-label="Context" style={`padding-top:${contextWindow.before}px;padding-bottom:${contextWindow.after}px`}>{@render treeRows(contextWindow.rows)}</ul>
    {/if}
  </div>
  <div class="dp-footer">
    <button class="dp-new" title={`New document in ${targetFolder}`} onclick={() => onNew(targetFolder)}>+ New document</button>
    {#if onFolder}<button class="dp-new-folder" title={`New folder in ${targetFolder}`} onclick={() => onFolder?.(targetFolder)}>New folder</button>{/if}
  </div>
</aside>

<style>
  .docpicker { display:flex; flex-direction:column; min-height:0; height:100%; color:var(--c-tx); --dp-row: calc(30px * var(--ts-scale)); --dp-step: calc(14px * var(--ts-scale, 1)); }
  .dp-scroll { flex:1; min-height:0; overflow:auto; padding:6px; scrollbar-width:thin; scrollbar-color:color-mix(in oklab, var(--c-tx) 22%, transparent) transparent; }
  ul { list-style:none; padding:0; margin:0; }
  li { margin:0; }
  button { font:inherit; cursor: var(--cursor-cross-hover); border:0; background:transparent; color:var(--c-tx-2); border-radius:var(--r-1); transition: background 70ms linear, color 70ms linear, box-shadow 70ms linear; }
  button:focus-visible { outline:2px solid var(--c-accent); outline-offset:-2px; }
  button:hover { background:var(--c-accent-tint-2); color:var(--c-tx-hi); }
  button:active { background:var(--c-accent-tint); }

  /* ---- the filter ---- */
  .dp-filter { flex:none; display:flex; align-items:center; gap:7px; height:calc(30px * var(--ts-scale, 1)); margin:6px 6px 0; padding:0 9px; border:1px solid var(--c-line-strong); border-radius:var(--r-1); background:#fffefa; color:var(--c-tx-faint); transition: border-color 80ms linear, box-shadow 80ms linear; }
  .dp-filter:focus-within { border-color:var(--c-accent); box-shadow:0 0 0 3px var(--c-accent-tint-2); }
  .dp-filter svg { flex:none; fill:none; stroke:currentColor; stroke-width:1.4; stroke-linecap:round; }
  .dp-filter input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--c-tx); font:var(--ts-xs) var(--font-serif); }
  .dp-filter input::placeholder { color:var(--c-tx-faint); }
  .dp-hits { flex:none; font:calc(10px * var(--ts-scale, 1)) var(--font-mono); font-variant-numeric:tabular-nums; }

  /* ---- section heads (Documents, Context): mono eyebrows ---- */
  .dp-folder { display:flex; align-items:center; padding-left:calc(var(--depth) * var(--dp-step)); border-radius:var(--r-1); }
  .dp-head { margin-top:10px; border-bottom:1px solid var(--c-line); border-radius:0; }
  .dp-head:first-child { margin-top:0; }
  .dp-head .folder-label { font:600 calc(10px * var(--ts-scale, 1))/1.2 var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--c-tx-muted); }
  .folder-label { display:flex; gap:6px; align-items:center; flex:1; min-width:0; text-align:left; height:var(--dp-row); padding:0 5px; font-size:var(--ts-sm); }
  .folder-label span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .folder-label svg { flex:none; color:var(--c-tx-faint); }
  .chev { transition: transform 80ms linear; }
  .chev.open { transform:rotate(90deg); }
  .folder-label:hover svg { color:var(--c-accent); }
  .folder-action { display:grid; place-items:center; width:24px; height:24px; padding:0; opacity:0; flex:none; color:var(--c-tx-muted); }
  .dp-folder:hover .folder-action, .dp-folder:focus-within .folder-action { opacity:1; }
  .dp-head .folder-action { opacity:1; }
  .drop-target { background:var(--c-accent-tint); box-shadow:inset 0 0 0 1.5px var(--c-accent); }

  /* ---- rows. The indent carries one hairline per level: a folder's extent reads down the rail. ---- */
  li > .dp-row, li > .dp-folder {
    background-image: repeating-linear-gradient(to right, transparent 0 calc(var(--dp-step) * .86), var(--c-line-strong) calc(var(--dp-step) * .86) calc(var(--dp-step) * .86 + 1px), transparent calc(var(--dp-step) * .86 + 1px) var(--dp-step));
    background-size: calc(var(--depth) * var(--dp-step)) 100%; background-repeat:no-repeat; background-position: 2px 0;
  }
  .dp-row { display:flex; align-items:center; padding-left:calc(16px + var(--depth) * var(--dp-step)); min-width:0; }
  .dp-matches .dp-row { padding-left:2px; }
  .dp-item { display:flex; align-items:center; flex:1; min-width:0; gap:7px; text-align:left; height:var(--dp-row); padding:4px 6px; font-size:var(--ts-sm); }
  .doc-icon { flex:none; color:var(--c-tx-faint); }
  /* The open document: a tint and a rail in the accent, the same "this one" as the outline's
     current section below it. */
  .dp-item.active, .dp-item.active:hover { background:var(--c-accent-tint); color:var(--c-accent); font-weight:600; box-shadow:inset 2px 0 0 var(--c-accent); }
  .dp-item.active .doc-icon { color:var(--c-accent); }
  .dp-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dp-badge { flex:none; padding:1px 5px; border:1px solid color-mix(in oklab, var(--c-accent) 45%, transparent); border-radius:var(--r-pill); font:600 calc(8.5px * var(--ts-scale, 1))/1.3 var(--font-mono); letter-spacing:.06em; text-transform:uppercase; color:var(--c-accent); }
  .dp-del { display:grid; place-items:center; width:22px; height:24px; flex:none; padding:0; opacity:0; color:var(--c-tx-faint); }
  .dp-row:hover .dp-del, .dp-row:focus-within .dp-del { opacity:1; }
  .dp-del:hover { color:var(--c-danger); background:color-mix(in oklab, var(--c-danger) 10%, transparent); }
  .dragging { opacity:.55; }
  .unfold { animation: dp-fade var(--dur-fade) linear both, dp-rise var(--dur-instant) var(--ease-enter) both; }
  @keyframes dp-fade { from { opacity:0; } }
  @keyframes dp-rise { from { transform:translateY(-3px); } }

  .dp-footer { display:flex; align-items:center; gap:4px; padding:6px; border-top:1px solid var(--c-line); }
  .dp-new, .dp-new-folder { height:calc(26px * var(--ts-scale, 1)); padding:0 8px; font-size:var(--ts-xs); white-space:nowrap; color:var(--c-tx-muted); }
  .dp-new { flex:1; text-align:left; }
  .dp-empty { margin:8px 10px 14px; color:var(--c-tx-faint); font-size:var(--ts-xs); font-style:italic; }
</style>
