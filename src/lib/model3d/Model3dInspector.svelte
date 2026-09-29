<script lang="ts">
  import { modelSourceStatuses, modelSourceBusy, updateModelFromSource } from './sourceBridge';
  import { pushToast, errMsg } from '../toast';
  import { untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { project, selection, commit, mutate } from '../store';
  import { selectionTargets } from '../interact/selectionTargets';
  import NumberField from '../NumberField.svelte';
  import ColorField from '../ColorField.svelte';
  import Model3dSemantics from './Model3dSemantics.svelte';
  import { scene3dManifests, scene3dGeneration } from './store';
  import { modelOrbit, modelOrbitBlocked, modelOrbitIssues, requestModelOrbit, finishModelOrbit, modelOrbitBlockedReason } from './orbitSession';
  import { setModelView, type ModelViewNumber, type ModelViewPatch } from './viewOps';
  import { modelDefaultStates, setModelStates } from './semanticOps';
  import { axisView, homeView, type AxisView } from './orbit';
  import type { Model3dElement, Model3dAsset } from './types';

  let { element, readOnly = false }: { element: Model3dElement; readOnly?: boolean } = $props();
  const asset = $derived($project.assets.find(a => a.id === element.assetId && a.kind === 'glb') as Model3dAsset | undefined);
  const assetIdentity = $derived(`${asset?.id}:${asset?.sha256}:${$scene3dGeneration}`);
  const manifest = $derived($scene3dManifests[element.assetId]);
  // Only real problems are shown; preparing the worker is a sub-second navigation
  // cost that needs no message (and must not shift the layout on every mount).
  let availability = $state('');
  const unavailable = $derived(readOnly ? 'This selection is read-only' : $modelOrbitBlocked ? modelOrbitBlockedReason($modelOrbitBlocked) : $modelOrbitIssues[element.id] ?? availability);
  const numbers: Array<{ key: ModelViewNumber; label: string; step: number; min?: number; max?: number; factor?: number }> = [
    { key: 'orbitAzimuth', label: 'Azimuth°', step: 5 }, { key: 'orbitElevation', label: 'Elevation°', step: 5, min: -90, max: 90 },
    { key: 'orbitRoll', label: 'Roll°', step: 5 }, { key: 'orbitZoom', label: 'Zoom×', step: 1, factor: 1.1, min: .02, max: 50 },
    { key: 'orbitPanX', label: 'Pan X', step: .05 }, { key: 'orbitPanY', label: 'Pan Y', step: .05 },
  ];
  // Order matches the orbit-mode number keys 1–6.
  const axes: Array<[AxisView, string]> = [['front','Front'],['back','Back'],['right','Right'],['left','Left'],['top','Top'],['bottom','Bottom']];
  const orbiting = $derived($modelOrbit?.id === element.id);
  const sourceStatus = $derived($modelSourceStatuses[element.id]);
  function toggleOrbit() { if (orbiting) finishModelOrbit(); else requestModelOrbit(element.id); }
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
  }
  $effect(() => {
    assetIdentity; const captured = untrack(() => asset);
    let closed = false;
    availability = '';
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
  async function updateSource() { try { await updateModelFromSource(element.id); } catch (error) { pushToast('error', '3D source update failed', { detail: errMsg(error) }); } }
  function home() {
    if (readOnly) return;
    const view = homeView(asset, manifest), selected = ids();
    commit(p => { setModelView(p, selected, view); setModelStates(p, selected, modelDefaultStates(manifest, asset?.model?.states ?? [])); });
  }
</script>
<section class="model3d-properties" aria-label="3D model properties">
  <h4 class="heading">3D view<span class="grow"></span><button class="orbit" class:on={orbiting} data-model3d-orbit-toggle disabled={readOnly}
    title={orbiting ? 'Finish orbiting (Enter)' : unavailable || 'Orbit the model: drag to turn, Shift pan, Alt roll, wheel zoom'} onclick={toggleOrbit}>{orbiting ? 'Done' : 'Orbit'}</button></h4>
  <div class="secbody">
    <!-- A current source shows no chip; the state stays observable here. -->
    <p class="meta" data-model3d-source-status={element.source?.glbPath && sourceStatus?.status === 'current' ? 'current' : undefined}>{asset?.model?.triangles.toLocaleString() ?? '—'} triangles · {formatBytes(asset?.bytes ?? 0)}{manifest?.units ? ` · ${manifest.units}` : ''}</p>
    {#if unavailable && !readOnly}<p class="note" data-model3d-orbit-unavailable>{unavailable}</p>{/if}
    {#if element.source?.glbPath && sourceStatus && sourceStatus.status !== 'current'}
      <div class="source-status" data-model3d-source-status={sourceStatus.status}>
        {#if sourceStatus.status === 'changed'}<strong>Source changed</strong>{:else if sourceStatus.status === 'missing'}<strong class="muted">Source file missing</strong>{:else if sourceStatus.status === 'frozen'}<p class="note">Source link is frozen.</p>{/if}
        {#if sourceStatus.detail}<p class="note">{sourceStatus.detail}</p>{/if}
        {#if sourceStatus.status === 'changed' || sourceStatus.status === 'unknown'}
          <button class="prim" disabled={readOnly || element.source.frozen || $modelSourceBusy.has(element.id)} onclick={updateSource}>{$modelSourceBusy.has(element.id) ? 'Updating…' : 'Update from source'}</button>
        {/if}
      </div>
    {/if}
    <fieldset disabled={readOnly}>
      <div class="numbers">{#each numbers as field}
        <NumberField label={field.label} value={element[field.key] ?? 0} step={field.step} factor={field.factor} min={field.min ?? null} max={field.max ?? null}
          on:commit={event => update({ [field.key]: event.detail })} on:scrub={event => update({ [field.key]: event.detail }, true)} />
      {/each}</div>
      <div class="axes" role="group" aria-label="Views">{#each axes as [axis, label], i}<button data-axis={axis} title={`${label} view (${i + 1})`} onclick={() => update(axisView(axis, element.orbitAzimuth))}>{label}</button>{/each}<button data-axis="home" title="Home view (0)" onclick={home}>Home</button></div>
      <div class="choice"><span>Projection</span><div class="seg" role="group" aria-label="Projection">
        <button class:on={element.orbitProjection === 'orthographic'} title="True proportions; scale bars stay exact (P)" onclick={() => update({ orbitProjection: 'orthographic' })}>Ortho</button>
        <button class:on={element.orbitProjection === 'perspective'} title="Perspective (P)" onclick={() => update({ orbitProjection: 'perspective' })}>Persp</button>
      </div></div>
      {#if element.orbitProjection === 'perspective'}<div class="fov"><NumberField label="FOV°" value={element.orbitFov} step={5} min={5} max={120} on:commit={event => update({ orbitFov: event.detail })} on:scrub={event => update({ orbitFov: event.detail }, true)} /></div>
        {#if manifest?.parts?.some(part => part.role === 'scalebar')}<p class="note">Scale bars are shown in orthographic view.</p>{/if}
      {/if}
    </fieldset>
  </div>
</section>
<section class="model3d-properties" aria-label="3D model appearance">
  <h4>Appearance</h4>
  <div class="secbody">
    <fieldset disabled={readOnly}>
      <div class="choice"><span>Colours</span><div class="seg" role="group" aria-label="Colours">
        <button class:on={(element.modelColors ?? 'uniform') === 'uniform'} title="One colour for the whole model" onclick={() => update({ modelColors: 'uniform' })}>Uniform</button>
        <button class:on={element.modelColors === 'source'} title="Part colours and value fields saved in the file" onclick={() => update({ modelColors: 'source' })}>From file</button>
      </div></div>
      {#if (element.modelColors ?? 'uniform') === 'uniform'}<div class="colour"><ColorField label="Model colour" value={element.fill} fallback="#808080" onchange={fill => update({ fill })} /></div>{/if}
      <div class="choice"><span>Lighting</span><div class="seg" role="group" aria-label="Lighting">
        <button class:on={(element.modelLighting ?? 'studio') === 'studio'} title="Soft studio lights that turn with the view" onclick={() => update({ modelLighting: 'studio' })}>Studio</button>
        <button class:on={element.modelLighting === 'unlit'} title="Flat colour, no shading" onclick={() => update({ modelLighting: 'unlit' })}>Unlit</button>
      </div></div>
    </fieldset>
  </div>
</section>
<fieldset class="model3d-properties semantics" disabled={readOnly}><Model3dSemantics {element} /></fieldset>
<style>
  /* Mirrors Inspector.svelte's section chrome (eyebrow h4, .secbody, 24px
     controls, accent-tint .seg) — the 2026-09-15 surface contract. */
  .model3d-properties { border-bottom: 1px solid var(--c-line); }
  h4 { margin: 0; height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 10px; font: 600 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-tx-muted); border-bottom: 1px solid var(--c-line); }
  .grow { flex: 1; }
  h4 button { text-transform: none; letter-spacing: 0; height: 20px; font: 11px var(--font-ui); }
  .secbody { padding: 8px 10px 10px; }
  .meta { margin: 0 0 8px; font: 10px var(--font-mono); color: var(--c-tx-muted); }
  .note { margin: 0 0 8px; font: 10.5px var(--font-ui); color: var(--c-tx-muted); overflow-wrap: anywhere; }
  .source-status { margin: 0 0 10px; padding: 7px 8px; border: 1px solid var(--c-line); border-left: 2px solid var(--c-accent); border-radius: var(--r-ui); font: 11px var(--font-ui); display: grid; gap: 6px; }
  .source-status strong { color: var(--c-tx-hi); font-weight: 600; }
  .source-status strong.muted { color: var(--c-tx-muted); }
  .source-status .note { margin: 0; }
  fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
  /* Sections dim independently (never nested), so opacity never compounds. */
  fieldset:disabled { opacity: .55; }
  .numbers { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .fov { margin-top: 6px; max-width: 50%; }
  .axes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 8px 0; }
  .choice { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0 0; font: 10.5px var(--font-ui); color: var(--c-tx-muted); }
  .choice:first-child { margin-top: 0; }
  .colour { margin-top: 6px; }
  button { height: 24px; background: transparent; color: var(--c-tx-2); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 0 8px; font: 12px var(--font-ui); cursor: var(--cursor-cross-hover); }
  button:hover:not(:disabled) { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  button:disabled { opacity: .5; }
  button.prim { border-color: var(--c-accent); color: var(--c-tx-hi); justify-self: start; }
  button.orbit.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .axes button { padding: 0 4px; font-size: 11px; }
  .seg { display: flex; flex: 0 0 auto; }
  .seg button { flex: 1 0 auto; min-width: 58px; white-space: nowrap; border-radius: 0; border-right-width: 0; font-size: 11px; }
  .seg button:first-child { border-radius: var(--r-ui) 0 0 var(--r-ui); }
  .seg button:last-child { border-radius: 0 var(--r-ui) var(--r-ui) 0; border-right-width: 1px; }
  .seg button.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .semantics { display: block; border-bottom: 0; }
</style>
