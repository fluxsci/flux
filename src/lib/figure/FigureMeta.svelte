<script lang="ts">
  import { registerTargetResolver, boundsOf } from "../bridge/targetResolvers";
  import { describeTarget, type TargetRef } from "../project/targets";
  import { focusedMode } from "../../shell/paneStore";

  import { yieldsToShellModal, isAnnotateChord } from "../../shell/agent/annotationVisibility";

  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import type { Project, Figure } from '../types';
  import { project, activeFigureId, globalRev, figureRev } from '../store';
  import { assetData } from '../assets';
  import { settings } from '../settings';
  import { plotGen, plotManifests } from '../plot/store';
  import { storeTenantState } from '../tenancy';
  import { projectModel } from '../../shell/shellStore';
  import { figRevision } from '../../shell/scholar/revisions';
  import { registerFlushable, flushOwnerRevision, flushByIdChecked } from '../../shell/lifecycle';
  import { figureMeta, figureMetaDetached } from './metadataState';
  import { metadataUsesLiveFigure, readMetadataProject, writeMetadataChange } from './metadataBridge';
  import { type MetadataChange, reverseMetadataChange } from './metadata';
  import { familyMap, familyById, formatCaptionLabel } from '../figfamily';
  import { captionBlocks, composeCaption, POSTSCRIPT_CAPTION } from '../captions';
  import { loadFigures, renderFigureImageUrl, captureFigureExport, figureSvgImageUrl } from '../../shell/modes/paper/scholar/figures';
  import { openUtilityWindow } from '../plot/galleryWindow';
  import { modalFocus } from '../ui/modalFocus';
  import { pointerDrag } from '../ui/pointerDrag';
  import { autogrow } from '../ui/autogrow';
  import FigureIdentityForm from './FigureIdentityForm.svelte';
  import FigureMetaPreview from './FigureMetaPreview.svelte';
  import Icon from '../../shell/Icon.svelte';

  const root = get(projectModel)?.root ?? null;
  $: if (($projectModel?.root ?? null) !== root) figureMeta.set(null);
  let model: Project | null = null;
  let chosen = get(figureMeta)?.figureId ?? (get(storeTenantState) === 'figure' ? get(activeFigureId) : null);
  let tab: 'captions' | 'name' = get(figureMeta)?.tab ?? 'captions';
  let query = '', family = '', canvas = '';
  let error = '', status = '', saving = false;
  let preview = '', previewError = '', previewFor = '', ownedPreview = '';
  function releasePreview() { if (ownedPreview) URL.revokeObjectURL(ownedPreview); ownedPreview = ''; }
  let reconnectList = () => {};
  function listSize(node: HTMLElement) {
    let observer: ResizeObserver;
    reconnectList = () => { observer?.disconnect(); const owner = node.ownerDocument.defaultView as Window & typeof globalThis; observer = new owner.ResizeObserver(() => listHeight = node.clientHeight); observer.observe(node); listHeight = node.clientHeight; };
    reconnectList(); return { destroy() { observer.disconnect(); reconnectList = () => {}; } };
  }
  onDestroy(registerTargetResolver({ get surface() { return get(focusedMode); }, root: () => wrap ?? null,
    revision: () => [selected, drafts, tab],
    current() {
      if (!selected) return [];
      const block = wrap?.ownerDocument.activeElement?.closest('[data-caption-panel]');
      return block ? [{ kind: "caption", figureId: selected.id, panel: block.getAttribute('data-caption-panel') || undefined, figureName: selected.nickname || selected.name }]
        : [{ kind: "figure", figureId: selected.id, name: selected.nickname || selected.name }];
    },
    at(_x, _y, node) {
      if (!selected || !node) return [];
      const block = node.closest('[data-caption-panel]');
      const ref: TargetRef = block ? { kind: "caption", figureId: selected.id, panel: block.getAttribute('data-caption-panel') || undefined, figureName: selected.nickname || selected.name }
        : { kind: "figure", figureId: selected.id, name: selected.nickname || selected.name };
      return [{ ref, bounds: boundsOf(block ?? wrap), label: describeTarget(ref) }];
    },
  }));
  function moved() { reconnectList(); previewView?.reconnect(); for (const textarea of wrap?.querySelectorAll('textarea') ?? []) textarea.dispatchEvent(new Event('flux:document-change')); }
  let detached = false, wrap: HTMLDivElement, splitEl: HTMLDivElement;
  let nameForm: FigureIdentityForm | undefined;
  let previewView: FigureMetaPreview | undefined;
  let collapsed = new Set<string>(), addedPs = new Set<string>();
  let split = .52, scroll = 0, listHeight = 500;
  let listEl: HTMLElement, revealedFigure = '';
  $: if (selected && filtered.length && selected.id !== revealedFigure) {
    revealedFigure = selected.id; void revealSelected(selected.id, filtered);
  }
  async function revealSelected(id: string, figures: Figure[]) {
    await tick();
    const index = figures.findIndex(f => f.id === id);
    if (alive && listEl && index >= 0) listEl.scrollTop = Math.max(0, index*54-listHeight/2+27);
  }
  let popup: ReturnType<typeof openUtilityWindow> | undefined;
  let cancelDrag: (() => void) | undefined;
  let alive = true, generation = 0, renderGeneration = 0;
  let history: MetadataChange[] = [], redo: MetadataChange[] = [];
  let drafts = new Map<string, Extract<MetadataChange, {kind:'caption'}>>();
  let pending: Promise<boolean> = Promise.resolve(true);
  try { const saved = Number(localStorage.getItem('flux.figureMeta.split')); if (saved >= .25 && saved <= .75) split = saved; } catch {}
  let live = false;
  $: { void $storeTenantState; void $flushOwnerRevision; void $project; live = metadataUsesLiveFigure(root); }
  $: if (live) model = $project;
  $: if (!live) { void $figRevision; void $storeTenantState; void $flushOwnerRevision; void refresh(); }
  $: selected = model?.figures.find(f => f.id === chosen) ?? model?.figures[0] ?? null;
  $: families = [...familyMap(model?.figureFamilies).values()];
  $: filtered = model?.figures.filter(f => (!family || (f.family ?? 'figure') === family) && (!canvas || f.canvasId === canvas) && `${f.name} ${f.nickname ?? ''} ${f.referenceKey ?? ''}`.toLowerCase().includes(query.toLowerCase().trim())) ?? [];
  // A new filter starts the list at its top: the element's own scroll, not only its mirror
  // (the mirror alone left the rows drawn for the old offset).
  $: { query; family; canvas; scroll = 0; if (listEl) listEl.scrollTop = 0; }
  $: start = Math.max(0, Math.min(Math.max(0, filtered.length - 1), Math.floor(scroll / 54) - 3));
  $: shown = filtered.slice(start, start + Math.ceil(listHeight / 54) + 7);
  $: blocks = selected ? [...captionBlocks(selected), ...(addedPs.has(selected.id) && !selected.captions?.[POSTSCRIPT_CAPTION]?.trim() ? [{id:POSTSCRIPT_CAPTION,label:'ps'}] : [])] : [];
  $: previewFigure = selected ? { ...selected, captions: { ...selected.captions, ...Object.fromEntries([...drafts.values()].filter(d => d.figureId === selected?.id).map(d => [d.key, d.after])) } } : null;
  $: caption = previewFigure ? composeCaption(previewFigure) : '';
  const countWords = (text: string) => (text.trim().match(/\S+/g) ?? []).length;
  /** Words in a figure's saved caption: the list shows how much each figure has, and which have none. */
  const captionWords = (f: Figure) => countWords(composeCaption(f));
  $: captionWordCount = countWords(caption);
  $: captionLabel = selected ? formatCaptionLabel(familyById(selected.family, model?.figureFamilies), selected.number ?? 1) : '';
  $: if (selected) { void $globalRev; void $figureRev; void $plotGen; void $figRevision; void updatePreview(selected, live); }


  async function refresh() {
    const n = ++generation;
    try {
      const result = await readMetadataProject(root);
      if (!alive || n !== generation || metadataUsesLiveFigure(root)) return;
      model = result;
      await loadFigures(root);
      if (selected) void updatePreview(selected, false);
    } catch (e) { if (alive && n === generation) error = String((e as Error).message); }
  }
  async function updatePreview(f: Figure, useLive: boolean) {
    const n = ++renderGeneration;
    if (previewFor !== f.id) { previewFor = f.id; preview = ''; }
    // Yield so choosing a row paints before SVG preparation; never re-render on
    // caption keystrokes. Paper's idle render cache supplies the cold preview.
    await tick();
    if (!alive || n !== renderGeneration) return;
    try {
      let url: string | undefined;
      if (useLive) {
        // Reuse Paper's sliced serializer and standalone font/image renderer,
        // supplied with a snapshot of the current unsaved Figure model.
        const snapshot = captureFigureExport({ figures:{[f.id]:f}, assetData:get(assetData), assetManifests:get(plotManifests), assets:get(project).assets });
        const svg = await snapshot.render(f.id, true, () => alive && n === renderGeneration);
        if (!alive || n !== renderGeneration) return;
        url = svg ? await figureSvgImageUrl(svg) : undefined;
      } else url = await renderFigureImageUrl(f.id);
      if (!alive || n !== renderGeneration) { if (useLive && url) URL.revokeObjectURL(url); return; }
      releasePreview(); ownedPreview = useLive ? url ?? '' : '';
      preview = url ?? ''; previewError = url ? '' : 'Preview unavailable';
    } catch (e) { if (alive && n === renderGeneration) { preview = ''; previewError = (e as Error).message; } }
  }
  function draftValue(key: string) { return drafts.get(`${selected?.id}:${key}`)?.after ?? selected?.captions?.[key] ?? ''; }
  function editCaption(key: string, value: string) {
    if (!selected) return;
    const id = `${selected.id}:${key}`;
    const prior = drafts.get(id);
    drafts.set(id, { kind:'caption', figureId:selected.id, key, before:prior?.before ?? selected.captions?.[key] ?? '', after:value });
    drafts = new Map(drafts); status = 'Unsaved changes';
  }
  async function apply(change: MetadataChange, record = true): Promise<boolean> {
    const work = pending.then(async () => {
      saving = true; error = '';
      try {
        await writeMetadataChange(root, change);
        if (record) { history = [...history, change]; redo = []; }
        status = live ? 'Saved to figure · autosaving' : 'Saved';
        if (!live) await refresh();
        return true;
      } catch (e) { error = (e as Error).message; status = 'Changes not saved'; return false; }
      finally { saving = false; }
    });
    pending = work; return work;
  }
  let captionsPending: Promise<boolean> | null = null;
  function flushCaptions(): Promise<boolean> {
    if (captionsPending) return captionsPending;
    captionsPending = saveCaptions().finally(() => { captionsPending = null; });
    return captionsPending;
  }
  async function saveCaptions(): Promise<boolean> {
    // An input may change while a disk write is pending. Drain those newer
    // versions too before navigation, shutdown or a project switch proceeds.
    while (drafts.size) {
      for (const [id, draft] of [...drafts]) {
        if (draft.before !== draft.after && !await apply(draft)) return false;
        if (drafts.get(id) === draft) drafts.delete(id);
        else { const newer = drafts.get(id); if (newer) newer.before = draft.after; }
        drafts = new Map(drafts);
      }
    }
    return true;
  }
  async function flush(): Promise<boolean> {
    await pending;
    if (!await flushCaptions()) return false;
    if (nameForm && !await nameForm.flush()) { if (!error) error = 'Finish or cancel the new family and enter a valid figure number.'; return false; }
    return true;
  }
  function discardDrafts() { drafts = new Map(); nameForm?.reset(); error = ''; status = 'Draft discarded'; void refresh(); }
  async function choose(id: string) { if (id !== chosen && await flush()) { chosen = id; error = ''; status = ''; } }
  async function selectTab(next: 'captions' | 'name') { if (tab !== next && await flush()) tab = next; }
  async function close() { if (await flush()) figureMeta.set(null); else if (detached && popup) dock(); }
  function pin() {
    if (detached) { popup?.focus(); return; }
    try {
      popup = openUtilityWindow(wrap, () => void close(), moved, { page:'figure-meta.html', frame:'flux-figure-meta', title:'Figure-Meta', focus:'.meta-search' });
      detached = true; figureMetaDetached.set(true);
    } catch (e) { error = (e as Error).message; }
  }
  function dock() { popup?.close(); popup = undefined; detached = false; figureMetaDetached.set(false); void tick().then(() => { if (alive) wrap.querySelector<HTMLInputElement>('.meta-search')?.focus(); }); }
  async function undoMeta(back = true) {
    if (!await flush()) return;
    const list = back ? history : redo, change = list.at(-1);
    if (!change || !await apply(back ? reverseMetadataChange(change) : change, false)) return;
    if (back) { history = history.slice(0,-1); redo = [...redo, change]; }
    else { redo = redo.slice(0,-1); history = [...history, change]; }
  }
  function onKey(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); nameForm?.reset(); void close(); }
    else if (e.altKey && !mod && e.code === 'KeyM') { e.preventDefault(); if (e.shiftKey) pin(); else void close(); }
    else if (mod && e.code === 'KeyR') { e.preventDefault(); void close(); }
    else if (mod && !e.shiftKey && e.code === 'KeyS') { e.preventDefault(); void flush(); }
    else if (mod && e.code === 'KeyZ' && !['INPUT','TEXTAREA'].includes((e.target as HTMLElement).tagName)) { e.preventDefault(); void undoMeta(!e.shiftKey); }
  }
  /** From the search: ↑/↓ walk the figures, Enter goes to the first field of the chosen one. */
  function searchKeys(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!filtered.length) return;
      const at = filtered.findIndex(f => f.id === selected?.id);
      const next = filtered[Math.max(0, Math.min(filtered.length - 1, (at < 0 ? (e.key === 'ArrowDown' ? -1 : filtered.length) : at) + (e.key === 'ArrowDown' ? 1 : -1)))];
      void choose(next.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      wrap.querySelector<HTMLElement>('.fields textarea, .fields input')?.focus();
    }
  }
  function resize(e: PointerEvent) {
    if (e.button !== 0) return;
    const initial = split, box = splitEl.getBoundingClientRect();
    cancelDrag = pointerDrag(e, event => split = Math.max(.25, Math.min(.75, (event.clientX-box.left)/box.width)), () => split = initial, () => { cancelDrag = undefined; try { localStorage.setItem('flux.figureMeta.split', String(split)); } catch {} });
  }
  function splitKeys(e: KeyboardEvent) { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); split = Math.max(.25, Math.min(.75, split + (e.key === 'ArrowLeft' ? -.02 : .02))); try { localStorage.setItem('flux.figureMeta.split', String(split)); } catch {} }
  function changeTextSize(delta: number) { settings.update(s => ({...s, captionFontSize:Math.max(9,Math.min(28,s.captionFontSize+delta))})); }
  function toggleBlock(id: string) {
    const key = `${selected?.id}:${id}`;
    const next = new Set(collapsed); if (next.has(key)) next.delete(key); else next.add(key); collapsed = next;
  }
  async function addPostscript() {
    if (!selected) return;
    addedPs = new Set([...addedPs,selected.id]);
    collapsed.delete(`${selected.id}:${POSTSCRIPT_CAPTION}`); collapsed = new Set(collapsed);
    await tick(); wrap.querySelector<HTMLTextAreaElement>('[aria-label="ps caption"]')?.focus();
  }
  async function removePostscript() {
    if (!selected) return;
    const id = selected.id;
    editCaption(POSTSCRIPT_CAPTION,'');
    if (await flushCaptions()) { addedPs.delete(id); addedPs = new Set(addedPs); }
  }
  async function copyReference() { if (!selected) return; try { await navigator.clipboard.writeText(`@${selected.referenceKey}`); status = 'Reference copied'; } catch { status = 'Select the reference below to copy it.'; } }

  const unregister = registerFlushable({ id:'metadata', isDirty:() => drafts.size > 0 || saving || !!nameForm?.isDirty(), flush:async () => { if (!await flush()) throw new Error(error || 'Figure metadata could not be saved');
    // The Figure owner may have flushed before this draft became a model edit.
    // A shutdown/project handoff must include that last commit in saved bytes.
    if (root && metadataUsesLiveFigure(root) && !(await flushByIdChecked('figure')).ok) throw new Error('Figure metadata is still waiting for the figure save.'); } });
  onMount(() => {
    if (!model) void refresh();
    let initial = true;
    const unsub = figureMeta.subscribe(request => {
      if (!request) return;
      if (!initial) void flush().then(ok => { if (ok && alive) { if (request.figureId) chosen = request.figureId; tab = request.tab; if (request.pinned) pin(); else popup?.focus(); } });
      initial = false;
    });
    if (get(figureMeta)?.pinned) pin();
    return unsub;
  });
  onDestroy(() => { alive = false; releasePreview(); generation++; renderGeneration++; cancelDrag?.(); popup?.close(); figureMetaDetached.set(false); figureMeta.set(null); unregister(); });
</script>

<div class="meta-wrap" class:detached bind:this={wrap}>
  {#if !detached}<button class="backdrop" aria-label="Close Figure-Meta" on:click={close}></button>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="figure-meta" role="dialog" aria-label="Figure-Meta" aria-modal={!detached} tabindex="-1" use:modalFocus on:keydown={onKey}>
    <header>
      <span class="mark" aria-hidden="true"><Icon name="figure" size={16} /></span>
      <b class="title">Figure-Meta</b>
      <span class="vsep" aria-hidden="true"></span>
      <span class="ctx">{#if selected}<em>{selected.name}</em>{selected.nickname ? ` · ${selected.nickname}` : ''}{:else}captions and names{/if}</span>
      <span class="chord" aria-hidden="true"><kbd>Alt</kbd><kbd>M</kbd></span>
      <span class="steps" role="group" aria-label="Undo and redo">
        <button title="Undo metadata edit (Ctrl+Z outside a field)" aria-label="Undo metadata edit" disabled={!history.length || saving} on:click={() => undoMeta()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5h5.5a3 3 0 0 1 0 6H7M4 6.5l2.5-2.5M4 6.5 6.5 9" /></svg></button>
        <button title="Redo metadata edit (Ctrl+Shift+Z outside a field)" aria-label="Redo metadata edit" disabled={!redo.length || saving} on:click={() => undoMeta(false)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 6.5H6.5a3 3 0 0 0 0 6H9M12 6.5 9.5 4M12 6.5 9.5 9" /></svg></button>
      </span>
      <button class="pin" title={detached ? 'Return to workspace' : 'Pin in a separate window (Shift+Alt+M)'} on:click={() => detached ? dock() : pin()}>{detached ? 'Dock' : 'Pin open'} ↗</button>
      <button class="x" aria-label="Close Figure-Meta" title="Close (Esc)" on:click={close}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg></button>
    </header>
    <div class="body">
      <aside>
        <div class="filters">
          <div class="section-label">Figures <span>{filtered.length === (model?.figures.length ?? 0) ? filtered.length : `${filtered.length} of ${model?.figures.length ?? 0}`}</span></div>
          <label class="find">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
            <input class="meta-search" aria-label="Search figures" placeholder="Search figures" bind:value={query} on:keydown={searchKeys} />
          </label>
          <select aria-label="Filter figure family" bind:value={family}><option value="">All families</option>{#each families as f (f.id)}<option value={f.id}>{f.displayName}</option>{/each}</select>{#if (model?.canvases.length ?? 0) > 1}<select aria-label="Filter figure canvas" bind:value={canvas}><option value="">All canvases</option>{#each model?.canvases ?? [] as c (c.id)}<option value={c.id}>{c.name}</option>{/each}</select>{/if}
        </div>
        <nav aria-label="Figures" class="figure-list" bind:this={listEl} use:listSize on:scroll={e => scroll = e.currentTarget.scrollTop}>
          <div style={`height:${filtered.length*54}px;position:relative`}>
            {#each shown as f,i (f.id)}
              {@const words = captionWords(f)}
              <button class="figure-row" class:selected={f.id === selected?.id} aria-current={f.id === selected?.id ? 'true' : undefined} style={`top:${(start+i)*54}px`} on:click={() => choose(f.id)}><b>{f.name}</b><span>{f.nickname || (model?.canvases.find(c => c.id === f.canvasId)?.name ?? '')}</span><i class="words" class:none={!words} title={words ? `Its caption has ${words} word${words === 1 ? '' : 's'}` : 'No caption yet'} aria-hidden="true">{words || ''}</i></button>
            {/each}
          </div>
          {#if !filtered.length}<p class="empty">{model ? 'No figures match.' : 'Opening figures…'}</p>{/if}
        </nav><footer><kbd>↑</kbd><kbd>↓</kbd> in the search moves through them</footer>
      </aside>
      <div class="detail" bind:this={splitEl} style={`--preview-share:${split*100}%`}>
        <div class="preview-pane">
          {#if selected}
            <FigureMetaPreview bind:this={previewView} figureId={selected.id} title={selected.nickname || selected.name} image={preview} error={previewError} {caption} {captionLabel} aspect={selected.width/selected.height} />
          {/if}
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="splitter" role="separator" aria-label="Resize figure preview" aria-orientation="vertical" aria-valuenow={Math.round(split*100)} aria-valuemin="25" aria-valuemax="75" tabindex="0" on:pointerdown={resize} on:keydown={splitKeys} on:dblclick={() => split = .52}></div>
        <div class="edit-pane">
          <div class="tabs" role="tablist" aria-label="Figure metadata">
            <button role="tab" aria-selected={tab==='captions'} class:on={tab==='captions'} title="The story behind the figure" on:click={() => selectTab('captions')}><Icon name="textFlow" size={15} /><span>Captions</span></button>
            <button role="tab" aria-selected={tab==='name'} class:on={tab==='name'} title="Title, family and number" on:click={() => selectTab('name')}><Icon name="hash" size={15} /><span>Name</span></button>
          </div>
          <div class="fields" role="tabpanel" aria-label={tab === 'captions' ? 'Captions' : 'Name'}>
            {#if selected && model}
              {#key selected.id}
                {#if tab==='captions'}
                  <div class="caption-toolbar"><span class="section-label">Caption <span class="count">{captionWordCount} word{captionWordCount === 1 ? '' : 's'}</span></span><div class="text-size" role="group" aria-label="Caption text size"><span>Aa</span><button aria-label="Decrease caption text size" title="Smaller caption text" disabled={$settings.captionFontSize<=9} on:click={() => changeTextSize(-1)}><Icon name="min" size={12} /></button><output aria-label="Caption text size">{$settings.captionFontSize}</output><button aria-label="Increase caption text size" title="Larger caption text" disabled={$settings.captionFontSize>=28} on:click={() => changeTextSize(1)}><Icon name="plus" size={12} /></button></div></div>
                  {#each blocks as block (block.id)}
                    {@const folded = collapsed.has(`${selected.id}:${block.id}`)}
                    <div class="caption-block" data-caption-panel={block.id === "__figure__" ? "" : block.label || block.id} class:folded class:postscript={block.id===POSTSCRIPT_CAPTION}>
                      <div class="block-heading">
                        <button class="block-toggle" aria-expanded={!folded} aria-controls={`caption-${selected.id}-${block.id}`} aria-label={`${folded ? 'Expand' : 'Collapse'} ${block.label || 'Figure'} caption`} title="Fold or unfold this caption" on:click={() => toggleBlock(block.id)}><span class="block-chev" class:open={!folded} aria-hidden="true"></span><span class="block-tag">{block.label || 'Figure'}</span><span class="block-kind">{block.id==='__figure__' ? 'opens the caption' : block.id===POSTSCRIPT_CAPTION ? 'closes the caption' : 'panel'}</span><span class="block-rule"></span></button>
                        {#if block.id===POSTSCRIPT_CAPTION}<button class="remove-ps" aria-label="Remove closing caption" title="Remove closing caption (undo available)" on:click={removePostscript}><Icon name="x" size={12} /></button>{/if}
                      </div>
                      {#if !folded}<div class="caption-content" id={`caption-${selected.id}-${block.id}`}><textarea aria-label={`${block.label || 'Figure'} caption`} style={`font-size:${$settings.captionFontSize}px`} value={draftValue(block.id)} rows="2" placeholder={block.id==='__figure__' ? 'Introduce the figure…' : block.id===POSTSCRIPT_CAPTION ? 'Add a closing sentence…' : `Describe panel ${block.label}…`} on:input={e => editCaption(block.id,e.currentTarget.value)} on:change={() => flushCaptions()} use:autogrow={{value:draftValue(block.id),fs:$settings.captionFontSize}}></textarea></div>{/if}
                    </div>
                  {/each}
                  {#if !blocks.some(b => b.id===POSTSCRIPT_CAPTION)}<button class="add-ps" on:click={addPostscript}><Icon name="plus" size={13} /><span>Add a closing caption <b>ps</b></span></button>{:else}<p class="hint ps-hint">The closing text follows the last panel, without a label.</p>{/if}
                  {#if blocks.every(b => b.id==='__figure__' || b.id===POSTSCRIPT_CAPTION)}<p class="hint">To caption a panel, mark its letter as a <b>Panel label</b>: select the text on the figure and press <kbd>Alt</kbd><kbd>L</kbd>.</p>{/if}
                {:else}<FigureIdentityForm {model} figure={selected} save={apply} bind:this={nameForm} />{/if}
              {/key}
              <div class="reference"><span>Permanent reference</span><code>@{selected.referenceKey}</code><button on:click={copyReference}>Copy</button></div>
            {:else}<p class="empty">{model ? 'This project has no figures yet.' : 'Opening figures…'}</p>{/if}
          </div>
        </div>
      </div>
    </div>
    <div class="status" role="status" data-state={error ? 'error' : saving ? 'saving' : drafts.size ? 'draft' : status.startsWith('Saved') ? 'saved' : 'idle'}><span class="state" class:error>{error || (saving ? 'Saving…' : status || 'Captions save as you leave a field')}</span>{#if error || drafts.size}<button on:click={flush}>{error ? 'Retry save' : 'Save now'}</button>{/if}{#if error}<button on:click={discardDrafts}>Discard unsaved draft</button>{/if}<span class="space"></span><span class="hints"><span><kbd>Ctrl</kbd><kbd>S</kbd> save</span><span>{#if detached}pinned window{:else}<kbd>Shift</kbd><kbd>Alt</kbd><kbd>M</kbd> pin{/if}</span><span><kbd>Esc</kbd> close</span></span></div>
  </div>
</div>
<style>
  /* Figure-Meta in the house vocabulary (2026-11-18 rebuild; owner: "sloppy and unpleasant and
     feels a bit half-baked"): one 36 px header, serif words, mono eyebrows and values, hairlines,
     tint + inset rail for the chosen figure, and a preview that is a page proof. Three columns:
     which figure · how it will print · what you write. */
  .meta-wrap { position:fixed; inset:0; z-index:110; display:grid; place-items:center; padding:24px; box-sizing:border-box; pointer-events:none; }
  .backdrop { position:absolute; inset:0; border:0; background:#0005; pointer-events:auto; }
  .figure-meta { position:relative; pointer-events:auto; width:min(1440px,100%); height:min(920px,100%); display:flex; flex-direction:column; overflow:hidden; background:var(--c-surface); color:var(--c-tx); font:13px/1.4 var(--font-serif); border:1px solid var(--c-line-strong); border-radius:var(--r-panel); box-shadow:var(--elev-3); outline:none; }
  .detached { padding:0; } .detached .figure-meta { width:100%; height:100%; border:0; border-radius:0; box-shadow:none; }
  svg { display:block; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
  header { display:flex; align-items:center; gap:10px; height:36px; flex-shrink:0; padding:0 6px 0 12px; background:var(--c-bg-raised); border-bottom:1px solid var(--c-line); }
  .mark { display:inline-flex; } .title { font:600 14px var(--font-serif); color:var(--c-tx-hi); white-space:nowrap; }
  .vsep { flex:0 0 1px; height:14px; background:var(--c-line-strong); }
  .ctx { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--c-tx-muted); font:12.5px var(--font-serif); } .ctx em { font-style:normal; color:var(--c-tx-2); }
  .chord { display:inline-flex; gap:3px; }
  .steps { display:inline-flex; border:1px solid var(--c-line); border-radius:var(--r-ui); } .steps button { display:grid; place-items:center; width:24px; height:22px; padding:0; border:0; border-radius:0; } .steps button + button { border-left:1px solid var(--c-line); } .steps svg { width:14px; height:14px; }
  .space { flex:1; }
  button { color:var(--c-tx-2); background:transparent; border:1px solid var(--c-line); border-radius:var(--r-ui); padding:0 9px; height:24px; font:12.5px var(--font-serif); transition:background-color 80ms linear,border-color 80ms linear,color 80ms linear; }
  button:hover:not(:disabled) { color:var(--c-tx-hi); background:var(--c-surface-2); border-color:var(--c-line-strong); } button:active:not(:disabled) { background:var(--c-accent-tint); border-color:var(--c-accent); } button:disabled { opacity:.35; }
  button:focus-visible, select:focus-visible { outline:1px solid var(--c-accent); outline-offset:1px; }
  .pin { border-color:transparent; color:var(--c-tx-muted); font:11.5px var(--font-ui); white-space:nowrap; }
  .x { display:grid; place-items:center; width:24px; padding:0; border-color:transparent; color:var(--c-tx-muted); } .x svg { width:12px; height:12px; }

  /* ---- which figure ---------------------------------------------------------------------- */
  .body { flex:1; min-height:0; display:flex; } aside { width:224px; flex-shrink:0; min-height:0; display:flex; flex-direction:column; background:var(--c-bg-raised); border-right:1px solid var(--c-line); }
  .filters { padding:11px 10px 10px; display:flex; flex-direction:column; gap:7px; border-bottom:1px solid var(--c-line); }
  .section-label { display:flex; align-items:baseline; justify-content:space-between; gap:8px; font:600 10px var(--font-mono); text-transform:uppercase; letter-spacing:.08em; color:var(--c-tx-muted); } .section-label span { font-weight:400; letter-spacing:0; text-transform:none; color:var(--c-tx-faint); font-variant-numeric:tabular-nums; }
  .find { display:flex; align-items:center; gap:7px; height:26px; padding:0 8px; background:var(--c-bg); border:1px solid var(--c-line-strong); border-radius:var(--r-ui); color:var(--c-tx-muted); cursor:text; transition:border-color 80ms linear; } .find:hover { border-color:var(--c-tx-muted); } .find:focus-within { border-color:var(--c-accent); } .find svg { width:13px; height:13px; }
  input { flex:1; min-width:0; height:24px; margin:0; padding:0; background:transparent; border:0; outline:none; color:var(--c-tx-hi); font:13px var(--font-serif); } input::placeholder { color:var(--c-tx-faint); font-style:italic; }
  select { appearance:none; -webkit-appearance:none; min-width:0; width:100%; box-sizing:border-box; height:24px; padding:0 24px 0 8px; background:var(--c-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23878580' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5l3-3'/%3E%3C/svg%3E") no-repeat right 7px center / 11px 11px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); color:var(--c-tx); font:12px var(--font-ui); text-overflow:ellipsis; } select:hover { border-color:var(--c-tx-muted); }
  .figure-list { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; }
  .figure-row { position:absolute; left:0; width:100%; height:54px; display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-rows:auto auto; align-content:center; column-gap:8px; row-gap:3px; text-align:left; border:0; border-bottom:1px solid var(--c-line); border-radius:0; padding:0 10px 0 13px; }
  .figure-row:hover:not(:disabled) { background:var(--c-surface-2); } .figure-row.selected, .figure-row.selected:hover { background:var(--c-accent-tint); box-shadow:inset 2px 0 var(--c-accent); }
  .figure-row b { grid-column:1; font:13px var(--font-serif); font-weight:400; color:var(--c-tx); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .figure-row.selected b { color:var(--c-tx-hi); font-weight:600; }
  .figure-row span { grid-column:1; font:11.5px var(--font-serif); color:var(--c-tx-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* How much caption the figure has, in words; a ring when it has none yet. */
  .words { grid-column:2; grid-row:1 / 3; align-self:center; min-width:8px; text-align:right; font:10px var(--font-mono); font-style:normal; font-variant-numeric:tabular-nums; color:var(--c-tx-faint); }
  .words.none { width:7px; height:7px; min-width:0; box-sizing:border-box; border:1px solid var(--c-tx-faint); border-radius:50%; }
  footer { display:flex; align-items:center; gap:4px; height:28px; padding:0 10px; border-top:1px solid var(--c-line); color:var(--c-tx-muted); font:10.5px var(--font-ui); white-space:nowrap; overflow:hidden; } footer kbd { margin-right:1px; } footer kbd + kbd { margin-right:4px; }

  /* ---- how it will print · what you write ------------------------------------------------- */
  .detail { display:grid; grid-template-columns:minmax(0,var(--preview-share)) 5px minmax(0,1fr); flex:1; min-width:0; min-height:0; }
  .preview-pane { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:var(--c-bg); }
  .splitter { position:relative; background:var(--c-line); cursor:col-resize; touch-action:none; transition:background-color 80ms linear; } .splitter::after { content:""; position:absolute; left:1px; top:calc(50% - 12px); width:3px; height:24px; border-radius:1px; background:var(--c-line-strong); } .splitter:hover,.splitter:focus-visible { background:var(--c-accent); } .splitter:hover::after,.splitter:focus-visible::after { background:var(--c-on-accent, #fff); }
  .edit-pane { display:flex; flex-direction:column; min-width:0; min-height:0; }
  /* Two tabs, the chosen one underlined, like the title bar's modes. */
  .tabs { display:flex; gap:2px; height:36px; flex-shrink:0; padding:0 12px; border-bottom:1px solid var(--c-line); }
  .tabs button { position:relative; display:flex; align-items:center; gap:7px; height:35px; padding:0 10px; border:0; border-radius:0; color:var(--c-tx-muted); font:13px var(--font-serif); }
  .tabs button:hover:not(:disabled) { background:transparent; color:var(--c-tx-hi); }
  .tabs .on { color:var(--c-tx-hi); font-weight:600; } .tabs .on::after { content:""; position:absolute; left:8px; right:8px; bottom:-1px; height:2px; background:var(--c-accent); }
  .fields { flex:1; min-height:0; overflow:auto; padding:16px 18px 18px; scrollbar-gutter:stable; }
  .caption-toolbar { position:sticky; top:-16px; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:8px; margin:-16px -18px 14px; padding:10px 18px 9px; background:var(--c-surface); border-bottom:1px solid var(--c-line); }
  .caption-toolbar .section-label { justify-content:flex-start; gap:10px; }
  .text-size { display:flex; align-items:center; border:1px solid var(--c-line); border-radius:var(--r-ui); background:var(--c-bg); } .text-size>span { padding:0 8px 0 9px; font:13px var(--font-serif); color:var(--c-tx-muted); } .text-size button { display:grid; place-items:center; width:22px; height:22px; padding:0; border:0; border-left:1px solid var(--c-line); border-radius:0; } .text-size output { min-width:26px; padding:0 2px; text-align:center; border-left:1px solid var(--c-line); font:11px/22px var(--font-mono); color:var(--c-tx); font-variant-numeric:tabular-nums; }
  .hint { margin:0 0 12px; color:var(--c-tx-muted); font:11.5px/1.5 var(--font-serif); } .hint b { color:var(--c-tx-2); font-weight:600; } .hint kbd { margin:0 1px; vertical-align:1px; }
  .caption-block { display:flex; flex-direction:column; gap:7px; margin-bottom:14px; } .block-heading { display:flex; align-items:center; gap:3px; }
  .block-toggle { display:flex; align-items:center; flex:1; min-width:0; gap:8px; height:22px; padding:0; border:0; text-align:left; } .block-toggle:hover:not(:disabled) { background:transparent; }
  .block-chev { width:8px; height:8px; flex-shrink:0; background:var(--c-tx-muted); -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat; transition:rotate 90ms var(--ease-standard); } .block-chev.open { rotate:90deg; } .block-toggle:hover .block-chev { background:var(--c-tx-hi); }
  .block-tag { min-width:22px; height:18px; padding:0 6px; box-sizing:border-box; text-align:center; font:600 11px/16px var(--font-mono); color:var(--c-accent-bright); border:1px solid color-mix(in oklab,var(--c-accent) 50%,transparent); border-radius:var(--r-ui); background:var(--c-accent-tint); }
  .block-kind { font:11.5px var(--font-serif); font-style:italic; color:var(--c-tx-muted); white-space:nowrap; } .block-rule { height:1px; flex:1; background:var(--c-line); }
  .folded { gap:0; margin-bottom:8px; } .folded .block-tag { background:transparent; color:var(--c-tx-2); border-color:var(--c-line-strong); } .remove-ps { display:grid; place-items:center; width:22px; height:22px; padding:0; border-color:transparent; }
  textarea { box-sizing:border-box; width:100%; min-height:60px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:var(--c-bg); color:var(--c-tx-hi); padding:10px 12px; font:16px/1.55 var(--font-serif); resize:none; overflow:hidden; display:block; outline:none; transition:border-color 80ms linear, box-shadow 80ms linear; } textarea:hover { border-color:var(--c-tx-muted); } textarea:focus { border-color:var(--c-accent); box-shadow:0 0 0 3px var(--c-accent-tint-2); } textarea::placeholder { color:var(--c-tx-faint); font-style:italic; } .caption-content { animation:caption-reveal 80ms ease-out; } @keyframes caption-reveal { from {opacity:0} to {opacity:1} } @media(prefers-reduced-motion:reduce) { .caption-content { animation:none; } button, textarea, .find, .splitter, .block-chev { transition:none; } }
  .add-ps { display:flex; align-items:center; justify-content:center; gap:7px; width:100%; height:32px; border-style:dashed; border-color:var(--c-line-strong); color:var(--c-tx-muted); margin:2px 0 12px; } .add-ps b { margin-left:5px; font:600 10px var(--font-mono); color:var(--c-accent-bright); } .ps-hint { margin-top:-7px; }
  .reference { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:16px; padding-top:11px; border-top:1px solid var(--c-line); color:var(--c-tx-muted); } .reference code { flex:1; font:11.5px var(--font-mono); color:var(--c-tx-2); overflow-wrap:anywhere; user-select:text; } .reference>span { font:600 10px var(--font-mono); text-transform:uppercase; letter-spacing:.08em; } .reference button { height:22px; }
  /* The state of your words, said once: a dot and a line. */
  .status { min-height:30px; display:flex; gap:10px; align-items:center; padding:0 10px 0 12px; background:var(--c-bg-raised); border-top:1px solid var(--c-line); color:var(--c-tx-muted); font:11px var(--font-ui); }
  .status .state { display:inline-flex; align-items:center; gap:7px; } .status .state::before { content:""; width:7px; height:7px; border-radius:50%; box-sizing:border-box; border:1px solid var(--c-tx-faint); }
  .status[data-state="saved"] .state { color:var(--c-tx-2); } .status[data-state="saved"] .state::before { background:var(--c-success); border-color:var(--c-success); }
  .status[data-state="draft"] .state::before, .status[data-state="saving"] .state::before { background:var(--c-comment); border-color:var(--c-comment); }
  .status .error { color:var(--c-danger); } .status[data-state="error"] .state::before { background:var(--c-danger); border-color:var(--c-danger); }
  .status button { height:20px; padding:0 7px; font:11px var(--font-ui); }
  .hints { display:inline-flex; gap:14px; white-space:nowrap; } .hints kbd { margin-right:3px; }
  .empty { padding:14px; color:var(--c-tx-muted); }
  @media(max-width:1100px) { .hints span:first-child { display:none; } }
  @media(max-width:900px) { .meta-wrap { padding:10px; } .detached { padding:0; } aside { width:160px; } .fields { padding:12px; } .caption-toolbar { top:-12px; margin:-12px -12px 12px; padding:9px 12px; } .chord { display:none; } footer { display:none; } }
  @media(max-width:650px) { aside { width:128px; } .detail { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(180px,40%) minmax(0,1fr); } .splitter { display:none; } .preview-pane { border-bottom:1px solid var(--c-line); } header { gap:6px; padding:0 4px 0 8px; } .ctx, .vsep { display:none; } .title { flex:1; } .hints { display:none; } }
</style>
