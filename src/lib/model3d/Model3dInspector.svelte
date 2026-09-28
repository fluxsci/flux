<script lang="ts">
  import { untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { project, selection, commit, mutate } from '../store';
  import { selectionTargets } from '../interact/selectionTargets';
  import NumberField from '../NumberField.svelte';
  import ColorField from '../ColorField.svelte';
  import { scene3dManifests, scene3dGeneration } from './store';
  import { modelOrbit, modelOrbitBlocked, modelOrbitIssues, beginModelOrbit } from './orbitSession';
  import { setModelView, type ModelViewNumber, type ModelViewPatch } from './viewOps';
  import { setModelStates } from './semanticOps';
  import { axisView, homeView, type AxisView } from './orbit';
  import type { Model3dElement, Model3dAsset } from './types';

  let { element, readOnly = false }: { element: Model3dElement; readOnly?: boolean } = $props();
  const asset = $derived($project.assets.find(a => a.id === element.assetId && a.kind === 'glb') as Model3dAsset | undefined);
  const assetIdentity = $derived(`${asset?.id}:${asset?.sha256}:${$scene3dGeneration}`);
  const manifest = $derived($scene3dManifests[element.assetId]);
  let availability = $state('Preparing interactive view');
  const unavailable = $derived(readOnly ? 'This selection is read-only' : $modelOrbitBlocked ? 'Finish choosing an animation target first' : $modelOrbitIssues[element.id] ?? availability);
  const numbers: Array<{ key: ModelViewNumber; label: string; step: number; min?: number; max?: number; factor?: number }> = [
    { key: 'orbitAzimuth', label: 'Azimuth°', step: 5 }, { key: 'orbitElevation', label: 'Elevation°', step: 5, min: -90, max: 90 },
    { key: 'orbitRoll', label: 'Roll°', step: 5 }, { key: 'orbitZoom', label: 'Zoom×', step: 1, factor: 1.1, min: .02, max: 50 },
    { key: 'orbitPanX', label: 'Pan X', step: .05 }, { key: 'orbitPanY', label: 'Pan Y', step: .05 },
  ];
  const axes: Array<[AxisView, string]> = [['front','Front'],['back','Back'],['right','Right'],['left','Left'],['top','Top'],['bottom','Bottom']];
  $effect(() => {
    assetIdentity; const captured = untrack(() => asset);
    let closed = false;
    availability = 'Preparing interactive view';
    if (!captured?.model || !captured.sha256) { availability = '3D model file missing'; return; }
    void import('./posterStore').then(api => api.appModel3dService()).then(async owner => {
      const result = await owner.service.available();
      if (!closed && owner.isCurrent()) availability = result.ok ? '' : result.reason ?? 'Interactive 3D is unavailable';
    }).catch(error => { if (!closed) availability = String(error?.message ?? error); });
    return () => { closed = true; };
  });
  function ids() {
    return get(project).figures.flatMap(f => selectionTargets(f, get(selection), { editable: true, supports: e => e.type === 'model3d' }).map(e => e.id));
  }
  function update(patch: ModelViewPatch, live = false) {
    if (readOnly) return;
    const selected = ids();
    (live ? mutate : commit)(p => setModelView(p, selected, patch));
  }
  function home() {
    if (readOnly) return;
    const view = homeView(asset, manifest), selected = ids();
    commit(p => { setModelView(p, selected, view); setModelStates(p, selected, view.modelStates ?? null); });
  }
</script>
<section class="model3d-properties" aria-label="3D model properties">
  <div class="heading"><h3>3D model</h3><button title={unavailable || 'Drag to orbit; Shift to pan; Alt to roll'} disabled={!!unavailable} onclick={() => beginModelOrbit(element.id)}>{$modelOrbit?.id === element.id ? 'Orbiting' : 'Orbit'}</button></div>
  <p class="info">{asset?.model?.triangles.toLocaleString() ?? '—'} triangles · {((asset?.bytes ?? 0) / 1048576).toFixed(1)} MiB{manifest?.units ? ` · ${manifest.units}` : ''}</p>
  {#if unavailable}<p class="info" data-model3d-orbit-unavailable>{unavailable}</p>{/if}
  <fieldset disabled={readOnly}>
    <div class="numbers">{#each numbers as field}
      <NumberField label={field.label} value={element[field.key] ?? 0} step={field.step} factor={field.factor} min={field.min ?? null} max={field.max ?? null}
        on:commit={event => update({ [field.key]: event.detail })} on:scrub={event => update({ [field.key]: event.detail }, true)} />
    {/each}</div>
    <label class="choice">Projection<select value={element.orbitProjection} onchange={event => update({ orbitProjection: event.currentTarget.value as Model3dElement['orbitProjection'] })}>
      <option value="orthographic">Orthographic</option><option value="perspective">Perspective</option>
    </select></label>
    {#if element.orbitProjection === 'perspective'}<NumberField label="FOV°" value={element.orbitFov} step={5} min={5} max={120} on:commit={event => update({ orbitFov: event.detail })} on:scrub={event => update({ orbitFov: event.detail }, true)} />{/if}
    <div class="axes">{#each axes as [axis, label]}<button title={`${label} view`} onclick={() => update(axisView(axis, element.orbitAzimuth))}>{label}</button>{/each}<button onclick={home}>Home</button></div>
    <label class="choice">Colours<select value={element.modelColors ?? 'uniform'} onchange={event => update({ modelColors: event.currentTarget.value as Model3dElement['modelColors'] })}><option value="uniform">Uniform</option><option value="source">Source</option></select></label>
    <fieldset disabled={element.modelColors === 'source'} title={element.modelColors === 'source' ? 'Choose Uniform to edit this colour' : ''}><ColorField label="Model colour" value={element.fill} fallback="#808080" onchange={fill => update({ fill })} /></fieldset>
    <label class="choice">Lighting<select value={element.modelLighting ?? 'studio'} onchange={event => update({ modelLighting: event.currentTarget.value as Model3dElement['modelLighting'] })}><option value="studio">Studio</option><option value="unlit">Unlit</option></select></label>
  </fieldset>
</section>
<style>
  .model3d-properties { border-top: 1px solid var(--c-line); padding: 10px; }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  h3 { margin: 0; font: 12px var(--font-ui); color: var(--c-tx); }
  .info { margin: 5px 0 9px; font: 10px var(--font-ui); color: var(--c-tx-muted); overflow-wrap: anywhere; }
  fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
  fieldset:disabled { opacity: .55; }
  .numbers { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .choice { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 9px 0; font: 11px var(--font-ui); }
  select { max-width: 140px; background: var(--c-bg); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 3px; font: 11px var(--font-ui); }
  .axes { display: flex; flex-wrap: wrap; gap: 4px; margin: 9px 0; }
  button { background: var(--c-bg); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 3px 6px; font: 10px var(--font-ui); }
  button:hover { border-color: var(--c-accent); }
  button:disabled { opacity: .5; }
</style>
