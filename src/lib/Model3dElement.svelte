<script lang="ts">
  import { modelPreviews, modelOrbitIssues, retireModelPreview } from './model3d/orbitSession';
  import { tick, untrack } from 'svelte';
  import { project, embeddedProjectRoot, projectDir, viewport } from './store';
  import { scene3dManifests, model3dPosterRevision } from './model3d/store';
  import { furnitureLayout } from './model3d/furnitureLayout';
  import { furnitureSvg } from './model3d/furniture';
  import { orbitPose } from './model3d/orbit';
  import { framingBounds } from './model3d/framing';
  import { posterKey, posterPixels } from './model3d/poster';
  import type { Model3dAsset, Model3dElement } from './model3d/types';

  let { element }: { element: Model3dElement } = $props();
  const asset = $derived($project.assets.find(a => a.id === element.assetId && a.kind === 'glb') as Model3dAsset | undefined);
  const manifest = $derived($scene3dManifests[element.assetId]);
  const layout = $derived(furnitureLayout(manifest, element, element.overrides));
  const pose = $derived(asset?.model ? orbitPose(element, framingBounds(asset.model.bounds, manifest), layout.viewport) : null);
  let furniture = $state({ under: '', over: '' });
  $effect(() => { if ($modelPreviews[element.id]?.phase !== 'active') furniture = pose ? furnitureSvg(manifest, element, pose, layout) : { under: '', over: '' }; });
  const surface = $derived({ kind: 'editor' as const, onscreen: { w: layout.viewport.width * $viewport.zoom, h: layout.viewport.height * $viewport.zoom }, dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 });
  const key = $derived(asset?.model && asset.sha256 ? posterKey(element, asset, manifest, posterPixels(layout.viewport, surface)) : 'missing');
  // Root + asset identity only: a same-root reload keeps the displayed poster
  // until its (content-addressed) successor is ready — never a placeholder flash.
  const ownerKey = $derived(`${$embeddedProjectRoot ?? $projectDir ?? ''}:${asset?.id}:${asset?.sha256}`);
  let contextLost = $state(false);
  const PREPARING = 'Preparing 3D preview';
  let url = $state(''), displayedKey = $state(''), reason = $state(PREPARING);
  const shortReason = $derived(reason.length > 70 ? reason.slice(0, 67) + '…' : reason);
  // Loading is a sub-second navigation cost (Nielsen: no feedback needed): show
  // only a hairline frame, and the labelled tile after 1 s or on a real problem.
  const preparing = $derived(!url && reason === PREPARING);
  let slow = $state(false);
  $effect(() => {
    if (!preparing) { slow = false; return; }
    const timer = setTimeout(() => { slow = true; }, 1000);
    return () => clearTimeout(timer);
  });
  // Placeholder text is set in screen points so it stays legible at any zoom.
  const textScale = $derived(1 / Math.max(0.05, $viewport.zoom));
  const displayed = { owner: '' };

  // Snapshot invalidation includes unavailable/missing transitions as well as
  // successful posters; a cached zoom proxy must agree with the visible scene.
  $effect(() => {
    url; reason; ownerKey;
    let closed = false;
    void tick().then(() => { if (!closed) model3dPosterRevision.update(n => n + 1); });
    return () => { closed = true; };
  });

  // Pin bytes only while a placement is mounted; duplicate/resize views share a worker.
  $effect(() => {
    ownerKey;
    if (!asset?.model || !asset.sha256) return;
    const requested = asset;
    let closed = false, retained: { release(): void } | undefined, unsubscribe: (() => void) | undefined;
    void import('./model3d/posterStore').then(api => {
      if (closed) return;
      const handle = api.retainModel3d(requested); retained = handle;
      void handle.ready.then(loaded => {
        if (closed) return;
        unsubscribe = loaded.service.subscribeContext(lost => {
          if (closed) return;
          contextLost = lost;
          modelOrbitIssues.update(old => { const next = { ...old }; if (lost) next[element.id] = '3D context interrupted; waiting for recovery'; else delete next[element.id]; return next; });
        });
      }).catch(error => { if (!closed && error?.name !== 'AbortError') { reason = String(error?.message ?? error); modelOrbitIssues.update(old => ({ ...old, [element.id]: reason })); } });
    });
    return () => { closed = true; unsubscribe?.(); retained?.release(); };
  });
  $effect(() => {
    const requestedKey = key; ownerKey;
    const preview = $modelPreviews[element.id];
    if (preview?.phase === 'active' || contextLost) return;
    if (displayed.owner !== ownerKey) { displayed.owner = ownerKey; url = ''; }
    if (!asset?.model || !asset.sha256) { reason = '3D model file missing'; return; }
    const request = untrack(() => ({ element: structuredClone(element), asset: structuredClone(asset!), manifest: manifest ? structuredClone(manifest) : undefined, surface }));
    const abort = new AbortController();
    const publish = (value: string) => {
      if (abort.signal.aborted) return;
      url = value; displayedKey = requestedKey; reason = '';
      void tick().then(() => { if (!abort.signal.aborted && preview?.phase === 'settled') retireModelPreview(element.id); });
    };
    void import('./model3d/posterStore').then(api => api.modelPosterUrl(request, { signal: abort.signal, onPreview: publish })).then(publish).catch(error => {
      if (!abort.signal.aborted && error?.name !== 'AbortError') { reason = String(error?.message ?? error); url = ''; if (preview?.phase === 'settled') retireModelPreview(element.id); }
    });
    return () => abort.abort();
  });
</script>

<rect class="model3d-hit-area" x={element.x} y={element.y} width={element.width} height={element.height} fill="transparent" />
<g data-model3d-furniture="under">{@html furniture.under}</g>
{#if url}
  <image data-model3d-poster data-model3d-key={displayedKey} x={layout.viewport.x} y={layout.viewport.y} width={layout.viewport.width} height={layout.viewport.height} preserveAspectRatio="none" href={url} />
{:else if preparing && !slow}
  <rect data-model3d-placeholder data-model3d-preparing x={layout.viewport.x} y={layout.viewport.y} width={layout.viewport.width} height={layout.viewport.height} fill="none" stroke="#B7B5AC" stroke-width={0.75 * textScale} stroke-dasharray={`${3 * textScale} ${3 * textScale}`} aria-label={`${element.name ?? asset?.name ?? '3D model'}: ${reason}`} />
{:else}
  {@const cx = layout.viewport.x + layout.viewport.width / 2}
  {@const cy = layout.viewport.y + layout.viewport.height / 2}
  {@const fit = Math.min(textScale, layout.viewport.height / 60, layout.viewport.width / 140)}
  <g data-model3d-placeholder role="img" aria-label={`${element.name ?? asset?.name ?? '3D model'}: ${reason}`}>
    <title>{reason}</title>
    <rect x={layout.viewport.x} y={layout.viewport.y} width={layout.viewport.width} height={layout.viewport.height} fill="#F2F0E5" stroke="#B7B5AC" stroke-width={0.75 * textScale} />
    <text x={cx} y={cy - 12 * fit} text-anchor="middle" font-family="Inter, sans-serif" font-size={14 * fit} fill={preparing ? '#6F6E69' : '#BC5215'}>{preparing ? '◈ 3D' : '⚠ 3D'}</text>
    <text x={cx} y={cy + 5 * fit} text-anchor="middle" font-family="Inter, sans-serif" font-size={11 * fit} fill="#403E3C">{element.name ?? asset?.name ?? '3D model'}</text>
    <text x={cx} y={cy + 20 * fit} text-anchor="middle" font-family="Inter, sans-serif" font-size={10 * fit} fill="#6F6E69">{shortReason}</text>
  </g>
{/if}
<g data-model3d-furniture="over" data-model3d-guide-overflow={layout.overflow || undefined}>{#if layout.overflow}<title>Enlarge this 3D model box to fit its guide labels at the current font size.</title>{/if}{@html furniture.over}</g>
