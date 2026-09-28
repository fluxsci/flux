<script lang="ts">
  import { onDestroy } from 'svelte';
  import { yieldsToShellModal, isAnnotateChord } from '../../shell/agent/annotationVisibility';
  import NumberField from '../NumberField.svelte';
  import { resolvedColormap } from './colormap';
  import ColormapPicker from '../ColormapPicker.svelte';
  import { project, commit, mutate, undo, redo, activeFigureId, embeddedProjectRoot } from '../store';
  import { scene3dManifests } from './store';
  import { scene3dFields, buildScene3dPartIndex, scene3dPartLineage } from './scene3d';
  import { setModelField, setModelStates, setModelFrame, modelFrame, modelDefaultStates, modelStateWeight, type ModelFieldPatch } from './semanticOps';
  import { mergePartOverride } from '../ops';
  import { selectionTargets } from '../interact/selectionTargets';
  import { editSession } from '../interact/editSession';
  import type { Project } from '../types';
  import type { Model3dElement } from './types';
  export let element: Model3dElement;
  /** X-ray may focus one value field without duplicating its controls. */
  export let fieldId: string | undefined = undefined;
  export let showShape = true;
  const sliderSession = editSession();
  onDestroy(sliderSession.finish);
  let picker: string | null = null;
  let weightsOpen = false, shapeOwner = "";
  $: manifest = $scene3dManifests[element.assetId];
  $: shapeKey = JSON.stringify([element.assetId, Boolean(manifest)]);
  $: if (shapeKey !== shapeOwner) { weightsOpen = !manifest?.sequence; shapeOwner = shapeKey; }
  $: fields = Object.entries(scene3dFields(manifest)).filter(([id]) => !fieldId || id === fieldId);
  $: names = $project.assets.find(a => a.id === element.assetId)?.model?.states ?? [];
  $: frame = modelFrame(element.modelStates, names);
  $: editable = $project.figures.some(f => selectionTargets(f, new Set([element.id]), { editable: true }).length > 0);
  $: ownerKey = JSON.stringify([element.id, $activeFigureId, $embeddedProjectRoot]);
  let priorOwner = '';
  $: if (ownerKey !== priorOwner) { sliderSession.finish(); picker = null; priorOwner = ownerKey; }
  function apply(fn: (p: Project) => void, live = false) {
    if (!editable) return;
    (live ? mutate : commit)(fn);
  }
  function field(id: string, patch: ModelFieldPatch | null, live = false) {
    apply(p => setModelField(p, [element.id], id, patch), live);
  }
  function range(id: string, fallback: [number, number], end: 0 | 1, value: number, live = false) {
    const next: [number, number] = [...(element.fields?.[id]?.range ?? fallback)];
    next[end] = end === 0 ? Math.min(value, next[1]) : Math.max(value, next[0]);
    field(id, { range: next }, live);
  }
  function weight(name: string, value: number, live = false) {
    apply(p => setModelStates(p, [element.id], { ...element.modelStates, [name]: value }), live);
  }
  function sliderKeydown(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if (e.key === 'Escape') {
      sliderSession.cancel(); e.preventDefault(); e.stopPropagation();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
      // Range inputs have no text undo stack. Settle the drag before routing
      // history, while keeping focus so keyboard adjustment remains available.
      sliderSession.finish(); e.preventDefault(); e.stopPropagation();
      e.key.toLowerCase() === 'y' || e.shiftKey ? redo() : undo();
    }
  }
  function setFrame(value: number, live = false) { apply(p => setModelFrame(p, [element.id], names, value), live); }
  function filledAncestors(id: string): string[] {
    const index = manifest ? buildScene3dPartIndex(manifest) : Object.create(null);
    return scene3dPartLineage(index, id).filter(part => element.overrides?.[part.id]?.fill != null).map(part => part.id);
  }
  function resetPartFill(id: string) {
    const ids = filledAncestors(id);
    apply(p => { for (const fig of p.figures) for (const el of fig.elements) if (el.id === element.id && el.type === 'model3d') for (const key of ids) mergePartOverride(el, key, { fill: null }); });
  }
</script>

{#if fields.length}
  <section class="model-semantics" aria-label="3D value fields">
    <div class="heading">Value fields</div>
    {#each fields as [id, source] (id)}
      <div class="value-field" data-model-field={id}>
        <div class="field-head"><span>{source.label ?? manifest?.parts?.find(p => p.id === id)?.label ?? id}</span><button disabled={!editable || !element.fields?.[id]} on:click={() => field(id, null)} title="Restore the source colormap and range">Reset</button></div>
        <button class="map-choice" aria-label={`${source.label ?? id} colormap`} disabled={!editable} on:click={() => picker = picker === id ? null : id} aria-expanded={picker === id}><span class="map-bar" style={`background:linear-gradient(to right,${resolvedColormap(source, element.fields?.[id]).map(([v,c]) => `${c} ${v*100}%`).join(",")})`}></span><span>{element.fields?.[id]?.cmap ?? source.cmap.name}</span></button>
        {#if picker === id}<div class="picker"><ColormapPicker mode="map" value={element.fields?.[id]?.cmap ?? source.cmap.name} onPick={value => { field(id, { cmap: value }); picker = null; }} onCancel={() => picker = null}/></div>{/if}
        <div class="range">
          <NumberField label="Min" value={element.fields?.[id]?.range?.[0] ?? source.range[0]} max={element.fields?.[id]?.range?.[1] ?? source.range[1]} step={0.1} disabled={!editable} on:commit={e => range(id, source.range, 0, e.detail)} on:scrub={e => range(id, source.range, 0, e.detail, true)}/>
          <NumberField label="Max" value={element.fields?.[id]?.range?.[1] ?? source.range[1]} min={element.fields?.[id]?.range?.[0] ?? source.range[0]} step={0.1} disabled={!editable} on:commit={e => range(id, source.range, 1, e.detail)} on:scrub={e => range(id, source.range, 1, e.detail, true)}/>
        </div>
        {#if filledAncestors(id).length}<div class="note">A part colour overrides this field. <button disabled={!editable} on:click={() => resetPartFill(id)}>Reset part colour</button></div>{/if}
      </div>
    {/each}
  </section>
{/if}
{#if showShape && names.length}
  <section class="model-semantics" aria-label="3D shape">
    <div class="field-head heading"><span>Shape</span><button disabled={!editable} on:click={() => apply(p => setModelStates(p, [element.id], modelDefaultStates(manifest, names)))}>Reset shape</button></div>
    {#if manifest?.sequence}
      <div class="sequence"><NumberField label="Frame" value={frame ?? 0} mixed={frame === null} mixedLabel="Custom" min={0} max={names.length} step={1} disabled={!editable} on:commit={e => setFrame(e.detail)} on:scrub={e => setFrame(e.detail, true)}/><span class="frame-label">{frame === null ? 'Custom' : frame === 0 ? 'Base' : Number.isInteger(frame) ? (manifest?.states?.find(s => s.name === names[frame - 1])?.label ?? names[frame - 1]) : `Blend ${frame.toFixed(2)}`}</span></div>
    {/if}
    <details class="weights" bind:open={weightsOpen}><summary>Shape weights</summary>
    {#each names as name (name)}
      <div class="shape-weight" data-model-state={name}>
        <NumberField label={manifest?.states?.find(s => s.name === name)?.label ?? name} value={modelStateWeight(element.modelStates, name)} min={0} max={1} step={0.05} disabled={!editable} on:commit={e => weight(name, e.detail)} on:scrub={e => weight(name, e.detail, true)}/>
        <input type="range" aria-label={`${name} shape weight`} min="0" max="1" step="0.01" value={modelStateWeight(element.modelStates, name)} disabled={!editable} on:input={e => sliderSession.run(() => weight(name, +(e.currentTarget.value), true))} on:change={sliderSession.finish} on:blur={sliderSession.finish} on:keydown={sliderKeydown}/>
      </div>
    {/each}
    </details>
  </section>
{/if}

<style>
  .model-semantics { margin-top: 10px; display: grid; gap: 8px; }
  .heading { color: var(--c-tx-muted); font-size: 11px; }
  .field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .field-head > span { overflow: hidden; text-overflow: ellipsis; }
  .value-field { display: grid; gap: 6px; min-width: 0; }
  button { color: var(--c-tx); background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); font: 11px var(--font-ui); padding: 3px 6px; cursor: var(--cursor-cross-hover); }
  button:disabled { opacity: .45; }
  .map-choice { display: flex; justify-content: space-between; gap: 8px; text-align: left; }
  .map-bar { width: 60px; height: 12px; flex: none; }
  .map-choice span { overflow: hidden; text-overflow: ellipsis; }
  .range { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .picker { border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); overflow: hidden; }
  .note, .frame-label { color: var(--c-tx-muted); font-size: 11px; }
  .sequence { display: grid; gap: 4px; }
  .shape-weight { display: grid; grid-template-columns: minmax(75px, 1fr) minmax(60px, 1.3fr); align-items: end; gap: 8px; margin-top: 6px; }
  .weights summary { color: var(--c-tx-muted); font-size: 11px; cursor: var(--cursor-cross-hover); }
  input[type=range] { width: 100%; accent-color: var(--c-accent); cursor: var(--cursor-cross-hover); }
</style>
