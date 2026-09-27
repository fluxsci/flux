<script lang="ts">
  import { registerTargetResolver, boundsOf } from "../bridge/targetResolvers";
  import { describeTarget, type TargetRef } from "../project/targets";
  import { focusedMode } from "../../shell/paneStore";

  import { yieldsToShellModal, isAnnotateChord } from "../../shell/agent/annotateChord";

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
  import Logomark from '../../shell/Logomark.svelte';
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
  $: { query; family; canvas; scroll = 0; }
  $: start = Math.max(0, Math.min(Math.max(0, filtered.length - 1), Math.floor(scroll / 54) - 3));
  $: shown = filtered.slice(start, start + Math.ceil(listHeight / 54) + 7);
  $: blocks = selected ? [...captionBlocks(selected), ...(addedPs.has(selected.id) && !selected.captions?.[POSTSCRIPT_CAPTION]?.trim() ? [{id:POSTSCRIPT_CAPTION,label:'ps'}] : [])] : [];
  $: previewFigure = selected ? { ...selected, captions: { ...selected.captions, ...Object.fromEntries([...drafts.values()].filter(d => d.figureId === selected?.id).map(d => [d.key, d.after])) } } : null;
  $: caption = previewFigure ? composeCaption(previewFigure) : '';
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
    <header><div class="brand"><Logomark size={30} /><span class="brand-word">Flux</span><div class="brand-title"><b>Figure-Meta</b><span>Alt + M</span></div></div><span class="space"></span><button title="Undo metadata edit" aria-label="Undo metadata edit" disabled={!history.length || saving} on:click={() => undoMeta()}>↶</button><button title="Redo metadata edit" aria-label="Redo metadata edit" disabled={!redo.length || saving} on:click={() => undoMeta(false)}>↷</button><button class="pin" title={detached ? 'Return to workspace' : 'Pin in a separate window (Shift+Alt+M)'} on:click={() => detached ? dock() : pin()}>{detached ? 'Dock' : 'Pin open'} ↗</button><button aria-label="Close Figure-Meta" title="Close (Esc)" on:click={close}>✕</button></header>
    <div class="body">
      <aside>
        <div class="filters"><div class="section-label">Collection <span>{model?.figures.length ?? 0}</span></div><input class="meta-search" aria-label="Search figures" placeholder="Search figures…" bind:value={query} /><select aria-label="Filter figure family" bind:value={family}><option value="">All families</option>{#each families as f (f.id)}<option value={f.id}>{f.displayName}</option>{/each}</select>{#if (model?.canvases.length ?? 0) > 1}<select aria-label="Filter figure canvas" bind:value={canvas}><option value="">All canvases</option>{#each model?.canvases ?? [] as c (c.id)}<option value={c.id}>{c.name}</option>{/each}</select>{/if}</div>
        <nav aria-label="Figures" class="figure-list" bind:this={listEl} use:listSize on:scroll={e => scroll = e.currentTarget.scrollTop}>
          <div style={`height:${filtered.length*54}px;position:relative`}>
            {#each shown as f,i (f.id)}<button class="figure-row" class:selected={f.id === selected?.id} aria-current={f.id === selected?.id ? 'true' : undefined} style={`top:${(start+i)*54}px`} on:click={() => choose(f.id)}><b>{f.name}</b><span>{f.nickname || (model?.canvases.find(c => c.id === f.canvasId)?.name ?? '')}</span></button>{/each}
          </div>
          {#if !filtered.length}<p class="empty">{model ? 'No figures match.' : 'Opening figures…'}</p>{/if}
        </nav><footer>{filtered.length} / {model?.figures.length ?? 0} figures</footer>
      </aside>
      <div class="detail" bind:this={splitEl} style={`--preview-share:${split*100}%`}>
        <div class="preview-pane">
          {#if selected}
            <div class="figure-heading"><span>{selected.name}</span><h2>{selected.nickname || 'Untitled figure'}</h2></div>
            <FigureMetaPreview bind:this={previewView} figureId={selected.id} title={selected.nickname || selected.name} image={preview} error={previewError} {caption} {captionLabel} aspect={selected.width/selected.height} />
          {/if}
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="splitter" role="separator" aria-label="Resize figure preview" aria-orientation="vertical" aria-valuenow={Math.round(split*100)} aria-valuemin="25" aria-valuemax="75" tabindex="0" on:pointerdown={resize} on:keydown={splitKeys} on:dblclick={() => split = .52}></div>
        <div class="edit-pane">
          <div class="tabs" role="tablist" aria-label="Figure metadata">
            <button role="tab" aria-selected={tab==='captions'} class:on={tab==='captions'} on:click={() => selectTab('captions')}><Icon name="textFlow" size={18} /><span>Captions<small>The story behind the figure</small></span></button>
            <button role="tab" aria-selected={tab==='name'} class:on={tab==='name'} on:click={() => selectTab('name')}><Icon name="hash" size={18} /><span>Name<small>Title, family & number</small></span></button>
          </div>
          <div class="fields" role="tabpanel" aria-label={tab === 'captions' ? 'Captions' : 'Name'}>
            {#if selected && model}
              {#key selected.id}
                {#if tab==='captions'}
                  <div class="caption-toolbar"><span class="section-label">Caption blocks</span><div class="text-size" role="group" aria-label="Caption text size"><span>Aa</span><button aria-label="Decrease caption text size" title="Smaller caption text" disabled={$settings.captionFontSize<=9} on:click={() => changeTextSize(-1)}><Icon name="min" size={13} /></button><output aria-label="Caption text size">{$settings.captionFontSize}</output><button aria-label="Increase caption text size" title="Larger caption text" disabled={$settings.captionFontSize>=28} on:click={() => changeTextSize(1)}><Icon name="plus" size={13} /></button></div></div>
                  <p class="hint">Click a label to fold its caption.</p>
                  {#each blocks as block (block.id)}
                    {@const folded = collapsed.has(`${selected.id}:${block.id}`)}
                    <div class="caption-block" data-caption-panel={block.id === "__figure__" ? "" : block.label || block.id} class:folded class:postscript={block.id===POSTSCRIPT_CAPTION}>
                      <div class="block-heading">
                        <button class="block-toggle" aria-expanded={!folded} aria-controls={`caption-${selected.id}-${block.id}`} aria-label={`${folded ? 'Expand' : 'Collapse'} ${block.label || 'Figure'} caption`} on:click={() => toggleBlock(block.id)}><span class="block-tag">{block.label || 'Figure'}</span><span class="block-rule"></span><span class="block-kind">{block.id==='__figure__' ? 'Opening' : block.id===POSTSCRIPT_CAPTION ? 'Closing' : 'Panel'}</span><Icon name={folded ? 'chevronRight' : 'chevronDown'} size={12} /></button>
                        {#if block.id===POSTSCRIPT_CAPTION}<button class="remove-ps" aria-label="Remove closing caption" title="Remove closing caption (undo available)" on:click={removePostscript}><Icon name="x" size={12} /></button>{/if}
                      </div>
                      {#if !folded}<div class="caption-content" id={`caption-${selected.id}-${block.id}`}><textarea aria-label={`${block.label || 'Figure'} caption`} style={`font-size:${$settings.captionFontSize}px`} value={draftValue(block.id)} rows="2" placeholder={block.id==='__figure__' ? 'Introduce the figure…' : block.id===POSTSCRIPT_CAPTION ? 'Add a closing sentence…' : `Describe panel ${block.label}…`} on:input={e => editCaption(block.id,e.currentTarget.value)} on:change={() => flushCaptions()} use:autogrow={{value:draftValue(block.id),fs:$settings.captionFontSize}}></textarea></div>{/if}
                    </div>
                  {/each}
                  {#if !blocks.some(b => b.id===POSTSCRIPT_CAPTION)}<button class="add-ps" on:click={addPostscript}><Icon name="plus" size={13} /><span>Add closing caption <b>ps</b></span></button>{:else}<p class="hint ps-hint">The closing text follows the last panel, without a label.</p>{/if}
                  {#if blocks.every(b => b.id==='__figure__' || b.id===POSTSCRIPT_CAPTION)}<p class="hint">Mark text as a Panel label in the F-menu to add panel captions.</p>{/if}
                {:else}<FigureIdentityForm {model} figure={selected} save={apply} bind:this={nameForm} />{/if}
              {/key}
              <div class="reference"><span>Permanent reference</span><code>@{selected.referenceKey}</code><button on:click={copyReference}>Copy</button></div>
            {:else}<p class="empty">{model ? 'This project has no figures yet.' : 'Opening figures…'}</p>{/if}
          </div>
        </div>
      </div>
    </div>
    <div class="status" role="status"><span class:error>{error || (saving ? 'Saving…' : status || 'Alt+M · Figure-Meta')}</span>{#if error || drafts.size}<button on:click={flush}>Retry save</button>{/if}{#if error}<button on:click={discardDrafts}>Discard unsaved draft</button>{/if}<span class="space"></span><span>{detached ? 'Pinned window' : 'Shift+Alt+M to pin'}</span></div>
  </div>
</div>
<style>
  .meta-wrap { position:fixed; inset:0; z-index:110; display:grid; place-items:center; padding:24px; box-sizing:border-box; pointer-events:none; }
  .backdrop { position:absolute; inset:0; border:0; background:#0005; pointer-events:auto; }
  .figure-meta { position:relative; pointer-events:auto; width:min(1420px,100%); height:min(920px,100%); display:flex; flex-direction:column; overflow:hidden; background:var(--c-surface); color:var(--c-tx); font:12px/1.4 var(--font-ui); border:1px solid var(--c-line-strong); border-radius:var(--r-panel); box-shadow:var(--elev-2); outline:none; }
  .detached { padding:0; } .detached .figure-meta { width:100%; height:100%; border:0; border-radius:0; box-shadow:none; }
  header { display:flex; align-items:center; gap:8px; height:62px; flex-shrink:0; padding:0 16px; border-bottom:1px solid var(--c-line); }
  .brand { display:flex; align-items:center; gap:10px; } .brand-word { font:20px var(--font-serif); letter-spacing:-.04em; } .brand-title { display:flex; flex-direction:column; gap:3px; margin-left:5px; padding-left:15px; border-left:1px solid var(--c-line-strong); } .brand-title b { font:13px var(--font-ui); letter-spacing:.02em; } .brand-title span { font:9px var(--font-mono); color:var(--c-tx-muted); }
  .space { flex:1; } button { color:var(--c-tx-2); background:transparent; border:1px solid var(--c-line); border-radius:var(--r-ui); padding:4px 8px; font:inherit; } button:hover:not(:disabled) { color:var(--c-accent); border-color:var(--c-accent); } button:disabled { opacity:.35; } button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:1px solid var(--c-accent); outline-offset:1px; }
  .body { flex:1; min-height:0; display:flex; } aside { width:200px; flex-shrink:0; min-height:0; display:flex; flex-direction:column; border-right:1px solid var(--c-line); }
  .filters { padding:15px 12px 12px; display:flex; flex-direction:column; gap:8px; border-bottom:1px solid var(--c-line); } .section-label { display:flex; align-items:center; justify-content:space-between; font:10px var(--font-mono); text-transform:uppercase; letter-spacing:.09em; color:var(--c-tx-muted); } .section-label span { color:var(--c-accent); }
  input,select { min-width:0; width:100%; box-sizing:border-box; height:28px; background:var(--c-bg); border:1px solid var(--c-line); border-radius:var(--r-ui); color:var(--c-tx); font:12px var(--font-ui); padding:4px 6px; }
  .figure-list { flex:1; min-height:0; overflow:auto; } .figure-row { position:absolute; left:0; width:100%; height:54px; display:flex; flex-direction:column; align-items:start; justify-content:center; gap:4px; text-align:left; border:0; border-radius:0; padding:6px 14px; } .figure-row.selected { background:var(--c-accent-tint); box-shadow:inset 2px 0 var(--c-accent); } .figure-row b { font:12px var(--font-ui); color:var(--c-tx); } .figure-row span { font:11px var(--font-ui); color:var(--c-tx-muted); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  footer { padding:9px 12px; border-top:1px solid var(--c-line); color:var(--c-tx-muted); font:10px var(--font-mono); }
  .detail { display:grid; grid-template-columns:minmax(0,var(--preview-share)) 5px minmax(0,1fr); flex:1; min-width:0; min-height:0; }
  .preview-pane { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:var(--c-bg); } .figure-heading { padding:20px 20px 15px; border-bottom:1px solid var(--c-line); } .figure-heading span { font:10px var(--font-mono); color:var(--c-accent); text-transform:uppercase; letter-spacing:.08em; } h2 { font:22px/1.2 var(--font-serif); margin:5px 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .splitter { background:var(--c-line); cursor:col-resize; touch-action:none; } .splitter:hover,.splitter:focus-visible { background:var(--c-accent); }
  .edit-pane { display:flex; flex-direction:column; min-width:0; min-height:0; } .tabs { display:flex; gap:6px; padding:12px; border-bottom:1px solid var(--c-line); } .tabs button { display:flex; flex:1; align-items:center; gap:9px; text-align:left; border-color:transparent; padding:10px; font:13px var(--font-ui); } .tabs button span { display:flex; flex-direction:column; gap:4px; } .tabs small { font:9px var(--font-ui); color:var(--c-tx-muted); } .tabs .on { background:var(--c-accent-tint); color:var(--c-accent); box-shadow:inset 2px 0 var(--c-accent); border-color:var(--c-line); }
  .fields { flex:1; min-height:0; overflow:auto; padding:18px; } .caption-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; } .text-size { display:flex; align-items:center; gap:3px; } .text-size>span { margin-right:6px; font:15px var(--font-serif); color:var(--c-tx-muted); } .text-size button { display:grid; place-items:center; width:25px; height:25px; padding:0; } .text-size output { min-width:24px; text-align:center; font:11px var(--font-mono); color:var(--c-tx-2); }
  .caption-toolbar { position:sticky; top:-18px; z-index:1; background:var(--c-surface); margin:-18px -18px 12px; padding:14px 18px 10px; border-bottom:1px solid var(--c-line); }
  .hint { margin:0 0 12px; color:var(--c-tx-muted); font:11px/1.5 var(--font-ui); } .caption-block { display:flex; flex-direction:column; gap:7px; margin-bottom:12px; } .block-heading { display:flex; align-items:center; gap:3px; } .block-toggle { display:flex; align-items:center; flex:1; min-width:0; gap:8px; padding:0; border:0; text-align:left; } .block-tag { min-width:22px; padding:3px 5px; box-sizing:border-box; text-align:center; font:11px var(--font-mono); color:var(--c-accent); border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:var(--c-accent-tint); } .block-rule { height:1px; flex:1; background:var(--c-line); } .block-kind { font:9px var(--font-mono); color:var(--c-tx-muted); } .folded { gap:0; } .folded .block-tag { background:transparent; } .remove-ps { display:grid; place-items:center; padding:3px; border:0; }
  textarea { box-sizing:border-box; width:100%; min-height:60px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:var(--c-bg); color:var(--c-tx); padding:10px; font:16px/1.55 var(--font-serif); resize:none; overflow:hidden; display:block; } textarea::placeholder { color:var(--c-tx-muted); opacity:.7; } .caption-content { animation:caption-reveal 80ms ease-out; } @keyframes caption-reveal { from {opacity:0} to {opacity:1} } @media(prefers-reduced-motion:reduce) { .caption-content { animation:none; } }
  .add-ps { display:flex; align-items:center; justify-content:center; gap:7px; width:100%; padding:10px; border-style:dashed; font:11px var(--font-ui); color:var(--c-tx-muted); margin:4px 0 10px; } .add-ps b { margin-left:6px; font:10px var(--font-mono); color:var(--c-accent); } .ps-hint { margin-top:-7px; }
  .reference { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:14px; padding-top:10px; border-top:1px solid var(--c-line); color:var(--c-tx-muted); font-size:10px; } .reference code { flex:1; font:11px var(--font-mono); overflow-wrap:anywhere; user-select:text; } .reference>span { font:9px var(--font-mono); text-transform:uppercase; letter-spacing:.06em; }
  .status { min-height:30px; display:flex; gap:10px; align-items:center; padding:4px 12px; border-top:1px solid var(--c-line); color:var(--c-tx-muted); font:10px var(--font-mono); } .status .error { color:var(--c-danger); } .empty { padding:12px; color:var(--c-tx-muted); }
  @media(max-width:1100px) { .tabs small { display:none; } .tabs button { padding:8px; } }
  @media(max-width:900px) { .meta-wrap { padding:10px; } .detached { padding:0; } aside { width:150px; } .fields { padding:12px; } .caption-toolbar { top:-12px; margin:-12px -12px 12px; padding:10px 12px; } .figure-heading { padding:12px; } .brand-title span { display:none; } }
  @media(max-width:650px) { aside { width:125px; } .detail { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(180px,40%) minmax(0,1fr); } .splitter { display:none; } .preview-pane { border-bottom:1px solid var(--c-line); } .figure-heading { display:none; } header { gap:4px; padding:0 8px; } .brand-word { display:none; } .brand-title { border:0; margin:0; padding:0; } .brand-title b { font-size:11px; } .brand { gap:4px; } .caption-toolbar>.section-label { font-size:9px; } }
</style>
