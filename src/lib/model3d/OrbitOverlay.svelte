<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { yieldsToShellModal, isAnnotateChord } from '../../shell/agent/annotationVisibility';
  import { project } from '../store';
  import { scene3dManifests, scene3dGeneration } from './store';
  import { setModelStates } from './semanticOps';
  import { setModelView } from './viewOps';
  import { runModelOrbit, modelOrbit, modelPreviews, modelOrbitIssues, applyModelOrbit, finishModelOrbit, markModelPreviewPainted, retireModelPreview } from './orbitSession';
  import type { FurnitureLayout } from './furnitureLayout';
  import { furnitureLayout } from './furnitureLayout';
  import { furnitureNodes } from './furniture';
  import { paintFurniture } from './furnitureDom';
  import { orbitPose, axisView, homeView, type AxisView } from './orbit';
  import { WheelStepper, wheelDelta, wheelMultiplier } from '../interact/wheelLaw';
  import type { Model3dAsset, Model3dElement } from './types';

  let { element, left, top, zoom, beginPan }: { element: Model3dElement; left: number; top: number; zoom: number; beginPan: () => void } = $props();
  const asset = $derived($project.assets.find(a => a.id === element.assetId && a.kind === 'glb') as Model3dAsset | undefined);
  const manifest = $derived($scene3dManifests[element.assetId]);
  const preview = $derived($modelPreviews[element.id]);
  const interactive = $derived($modelOrbit?.id === element.id);
  let wrapper: HTMLDivElement, canvas: HTMLCanvasElement, under: SVGSVGElement, over: SVGSVGElement;
  let paintedLayout = $state<FurnitureLayout | null>(null), paintedElement = $state<Model3dElement | null>(null);
  let ready = $state(false), fullRevision = $state(0), forceFull = $state(false);
  let closed = false, requestRevision = 0;
  let contextLost = $state(false);
  let retained: ReturnType<typeof import('./posterStore').retainModel3d> | undefined;
  let residency = $state<Promise<Awaited<ReturnType<typeof import('./posterStore').retainModel3d>['ready']>> | null>(null);
  const wheel = new WheelStepper();
  let wheelEnd: ReturnType<typeof setTimeout> | undefined;
  let pointer: { id: number; x: number; y: number } | null = null;
  let space = false;
  const layout = $derived(furnitureLayout(manifest, element, element.overrides));
  const boxStyle = $derived(`left:${left}px;top:${top}px;width:${element.width * zoom}px;height:${element.height * zoom}px;transform:rotate(${element.rotation}deg) scale(${element.flipX ? -1 : 1},${element.flipY ? -1 : 1});opacity:${element.opacity ?? 1}`);
  const displayedLayout = $derived(paintedLayout ?? layout);
  const displayedElement = $derived(paintedElement ?? element);
  const meshStyle = $derived(`left:${(displayedLayout.viewport.x - displayedElement.x) * zoom}px;top:${(displayedLayout.viewport.y - displayedElement.y) * zoom}px;width:${displayedLayout.viewport.width * zoom}px;height:${displayedLayout.viewport.height * zoom}px`);
  $effect(() => {
    const captured = asset, generation = $scene3dGeneration;
    if (!captured?.model || !captured.sha256) { fail('3D model file missing'); return; }
    let disposed = false, unsubscribe: (() => void) | undefined;
    const promise = import('./posterStore').then(api => {
      if (disposed) throw new DOMException('View closed', 'AbortError');
      const handle = api.retainModel3d(captured); retained = handle;
      return handle.ready;
    });
    residency = promise;
    void promise.then(loaded => {
      if (disposed) return;
      unsubscribe = loaded.service.subscribeContext(lost => {
        if (disposed) return;
        const wasLost = contextLost; contextLost = lost;
        if (lost) modelOrbitIssues.update(old => ({ ...old, [element.id]: '3D context interrupted; waiting for recovery' }));
        else if (wasLost) { modelOrbitIssues.update(old => { const next = { ...old }; delete next[element.id]; return next; }); forceFull = true; fullRevision++; }
      });
    }).catch(error => { if (!disposed && error?.name !== 'AbortError') fail(String(error?.message ?? error)); });
    return () => { disposed = true; unsubscribe?.(); retained?.release(); retained = undefined; };
  });
  function fail(reason: string) {
    if (contextLost) return; // retain the last coherent frame; restore requests the latest state
    modelOrbitIssues.update(old => ({ ...old, [element.id]: reason }));
    if (interactive) finishModelOrbit();
    retireModelPreview(element.id);
  }
  $effect(() => {
    if (interactive && ready && wrapper) void tick().then(() => { if (!closed && interactive) wrapper.focus({ preventScroll: true }); });
  });
  $effect(() => {
    const pending = residency, state = preview, final = fullRevision;
    if (!pending || !canvas || !under || !over || !asset || !state || contextLost) return;
    const snapshot = structuredClone(element), metadata = manifest ? structuredClone(manifest) : undefined;
    const bounds = structuredClone(asset.model.bounds);
    const scale = zoom * Math.min(devicePixelRatio || 1, 2);
    const currentLayout = furnitureLayout(metadata, snapshot, snapshot.overrides);
    const pose = orbitPose(snapshot, bounds, currentLayout.viewport);
    const nodes = furnitureNodes(metadata, snapshot, pose, currentLayout);
    const request = ++requestRevision, abort = new AbortController();
    const fullResolution = state.phase === 'settled' || forceFull;
    const inputTimeStamp = state.time, mode = interactive ? 'orbit' : 'scrub';
    const w = Math.max(1, Math.min(4096, Math.ceil(currentLayout.viewport.width * scale)));
    const h = Math.max(1, Math.min(4096, Math.ceil(currentLayout.viewport.height * scale)));
    void pending.then(async loaded => {
      const bitmap = await loaded.service.renderBitmap({ assetId: loaded.assetId, w, h, element: snapshot, manifest: metadata }, { lane: 'interactive', channel: `editor:${snapshot.id}`, signal: abort.signal, fullResolution });
      if (closed || abort.signal.aborted || request !== requestRevision) { bitmap.close(); return; }
      const context = canvas.getContext('bitmaprenderer');
      if (!context) { bitmap.close(); throw new Error('Interactive 3D canvas is unavailable'); }
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      context.transferFromImageBitmap(bitmap);
      paintFurniture(under, nodes.underNodes); paintFurniture(over, nodes.overNodes);
      canvas.dataset.model3dFrame = String(request);
      paintedLayout = currentLayout; paintedElement = snapshot;
      ready = true;
      markModelPreviewPainted(snapshot.id);
      canvas.dispatchEvent(new CustomEvent('flux-model3d-frame', { bubbles: true, detail: { elementId: snapshot.id, revision: request, inputTimeStamp, paintTime: performance.now(), fullResolution, mode } }));
    }).catch(error => { if (!abort.signal.aborted && error?.name !== 'AbortError') fail(String(error?.message ?? error)); });
    return () => abort.abort();
  });
  function down(event: PointerEvent) {
    if (!interactive) return;
    if (event.button === 1 || space) { finishModelOrbit(); return; }
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); wrapper.focus({ preventScroll: true });
    forceFull = false;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    wrapper.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId || !interactive) return;
    event.preventDefault(); event.stopPropagation();
    const sx = event.clientX - pointer.x, sy = event.clientY - pointer.y;
    pointer.x = event.clientX; pointer.y = event.clientY;
    const angle = element.rotation * Math.PI / 180;
    const dx = (sx * Math.cos(angle) + sy * Math.sin(angle)) * (element.flipX ? -1 : 1);
    const dy = (-sx * Math.sin(angle) + sy * Math.cos(angle)) * (element.flipY ? -1 : 1);
    if (event.altKey) applyModelOrbit({ orbitRoll: (element.orbitRoll ?? 0) + .4 * dx }, event.timeStamp);
    else if (event.shiftKey) {
      const factor = 2 / (element.orbitZoom * Math.max(1, Math.min(layout.viewport.width, layout.viewport.height) * zoom));
      applyModelOrbit({ orbitPanX: (element.orbitPanX ?? 0) - dx * factor, orbitPanY: (element.orbitPanY ?? 0) + dy * factor }, event.timeStamp);
    } else applyModelOrbit({ orbitAzimuth: element.orbitAzimuth - .4 * dx, orbitElevation: element.orbitElevation + .4 * dy }, event.timeStamp);
  }
  function up(event: PointerEvent) {
    if (pointer?.id !== event.pointerId) return;
    pointer = null;
    if (wrapper.hasPointerCapture(event.pointerId)) wrapper.releasePointerCapture(event.pointerId);
    forceFull = true; fullRevision++;
  }
  function onWheel(event: WheelEvent) {
    if (!interactive) return;
    if (event.ctrlKey || event.metaKey) { finishModelOrbit(); return; }
    event.preventDefault(); event.stopPropagation();
    forceFull = false;
    const steps = wheel.steps({ deltaY: wheelDelta(event), deltaMode: event.deltaMode, time: event.timeStamp });
    if (steps) applyModelOrbit({ orbitZoom: element.orbitZoom * 1.1 ** (steps * wheelMultiplier(event)) }, event.timeStamp);
    if (wheelEnd) clearTimeout(wheelEnd);
    wheelEnd = setTimeout(() => { wheel.reset(); forceFull = true; fullRevision++; }, 220);
  }
  function key(event: KeyboardEvent) {
    if (!interactive || yieldsToShellModal(event) || isAnnotateChord(event)) return;
    if (event.ctrlKey || event.metaKey) { finishModelOrbit(); return; }
    if (event.key === ' ') { space = true; beginPan(); finishModelOrbit(); event.preventDefault(); event.stopPropagation(); return; }
    const axes: AxisView[] = ['front','back','right','left','top','bottom'];
    if (/^[1-6]$/.test(event.key)) applyModelOrbit(axisView(axes[Number(event.key)-1], element.orbitAzimuth), event.timeStamp);
    else if (event.key === '0') runModelOrbit(p => { const view = homeView(asset, manifest); setModelView(p, [element.id], view); setModelStates(p, [element.id], view.modelStates ?? null); }, event.timeStamp);
    else if (event.key.toLowerCase() === 'p') applyModelOrbit({ orbitProjection: element.orbitProjection === 'orthographic' ? 'perspective' : 'orthographic' }, event.timeStamp);
    else if (event.key === 'Escape') finishModelOrbit(true);
    else if (event.key === 'Enter') finishModelOrbit();
    // Orbit owns unrecognized authoring keys too; no accidental canvas delete/nudge.
    event.preventDefault(); event.stopPropagation();
  }
  function outside(event: PointerEvent) { if (interactive && wrapper && !wrapper.contains(event.target as Node)) finishModelOrbit(); }
  function outsideWheel(event: WheelEvent) { if (interactive && wrapper && !wrapper.contains(event.target as Node)) finishModelOrbit(); }
  onDestroy(() => { closed = true; requestRevision++; retained?.release(); if (wheelEnd) clearTimeout(wheelEnd); });
</script>

<svelte:window onpointerdowncapture={outside} onwheelcapture={outsideWheel} onblur={() => { if (interactive) finishModelOrbit(); }} />
<!-- This application surface implements its own documented keyboard scope. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div bind:this={wrapper} class="model3d-overlay" class:ready style={boxStyle} style:pointer-events={interactive ? 'auto' : 'none'}
  data-model3d-orbit={interactive ? element.id : undefined} data-model3d-preview={interactive ? undefined : element.id}
  data-command-scope="model3d-orbit" role="application" aria-label="Orbit 3D model" tabindex={interactive ? 0 : -1}
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onlostpointercapture={up}
  onkeydown={key} onkeyup={event => { if (event.key === ' ') space = false; }} onwheel={onWheel}>
  <svg bind:this={under} class="furniture" viewBox={`${displayedElement.x} ${displayedElement.y} ${displayedElement.width} ${displayedElement.height}`} aria-hidden="true"></svg>
  <canvas bind:this={canvas} data-model3d-live style={meshStyle}></canvas>
  <svg bind:this={over} class="furniture" viewBox={`${displayedElement.x} ${displayedElement.y} ${displayedElement.width} ${displayedElement.height}`} aria-hidden="true"></svg>
</div>
{#if interactive}
  <div class="model3d-hud" style={`left:${left}px;top:${top + element.height * zoom + 6}px`}>
    az {element.orbitAzimuth.toFixed(0)}° · el {element.orbitElevation.toFixed(0)}° · ×{element.orbitZoom.toFixed(2)} · {element.orbitProjection === 'orthographic' ? 'ortho' : 'persp'}
    <span>{contextLost ? '3D context interrupted; waiting for recovery' : 'Drag orbit · Shift pan · Alt roll · Enter done · Esc cancel'}</span>
  </div>
{/if}
<style>
  .model3d-overlay { position: absolute; transform-origin: center; outline: none; touch-action: none; visibility: hidden; }
  .model3d-overlay.ready { visibility: visible; }
  .model3d-overlay[data-model3d-orbit] { cursor: grab; }
  .model3d-overlay[data-model3d-orbit]:active { cursor: grabbing; }
  canvas { position: absolute; }
  .furniture { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
  .model3d-hud { position: absolute; pointer-events: none; font: 11px var(--font-mono); color: var(--c-tx); background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-ui); padding: 5px 7px; white-space: nowrap; }
  .model3d-hud span { display: block; margin-top: 3px; color: var(--c-tx-muted); font: 10px var(--font-ui); }
</style>
