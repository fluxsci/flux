<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { project, embeddedProjectRoot, projectDir, viewport } from './store';
  import { scene3dManifests, scene3dGeneration, model3dPosterRevision } from './model3d/store';
  import { furnitureLayout } from './model3d/furnitureLayout';
  import { furnitureSvg } from './model3d/furniture';
  import { orbitPose } from './model3d/orbit';
  import { posterKey, posterPixels } from './model3d/poster';
  import type { Model3dAsset, Model3dElement } from './model3d/types';

  let { element }: { element: Model3dElement } = $props();
  const asset = $derived($project.assets.find(a => a.id === element.assetId && a.kind === 'glb') as Model3dAsset | undefined);
  const manifest = $derived($scene3dManifests[element.assetId]);
  const layout = $derived(furnitureLayout(manifest, element, element.overrides));
  const pose = $derived(asset?.model ? orbitPose(element, asset.model.bounds, layout.viewport) : null);
  const furniture = $derived(pose ? furnitureSvg(manifest, element, pose, layout) : { under: '', over: '' });
  const surface = $derived({ kind: 'editor' as const, onscreen: { w: layout.viewport.width * $viewport.zoom, h: layout.viewport.height * $viewport.zoom }, dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 });
  const key = $derived(asset?.model && asset.sha256 ? posterKey(element, asset, manifest, posterPixels(layout.viewport, surface)) : 'missing');
  const ownerKey = $derived(`${$embeddedProjectRoot ?? $projectDir ?? ''}:${$scene3dGeneration}:${asset?.id}:${asset?.sha256}`);
  let url = $state(''), displayedKey = $state(''), reason = $state('Preparing 3D preview');
  const shortReason = $derived(reason.length > 70 ? reason.slice(0, 67) + '…' : reason);
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
    let closed = false, retained: { release(): void } | undefined;
    void import('./model3d/posterStore').then(api => {
      if (closed) return;
      const handle = api.retainModel3d(requested); retained = handle;
      void handle.ready.catch(error => { if (!closed && error?.name !== 'AbortError') reason = String(error?.message ?? error); });
    });
    return () => { closed = true; retained?.release(); };
  });
  $effect(() => {
    const requestedKey = key; ownerKey;
    if (displayed.owner !== ownerKey) { displayed.owner = ownerKey; url = ''; }
    if (!asset?.model || !asset.sha256) { reason = '3D model file missing'; return; }
    const request = untrack(() => ({ element: structuredClone(element), asset: structuredClone(asset!), manifest: manifest ? structuredClone(manifest) : undefined, surface }));
    const abort = new AbortController();
    const publish = (value: string) => {
      if (abort.signal.aborted || value === url) return;
      url = value; displayedKey = requestedKey; reason = '';
    };
    void import('./model3d/posterStore').then(api => api.modelPosterUrl(request, { signal: abort.signal, onPreview: publish })).then(publish).catch(error => {
      if (!abort.signal.aborted && error?.name !== 'AbortError') { reason = String(error?.message ?? error); url = ''; }
    });
    return () => abort.abort();
  });
</script>

<rect class="model3d-hit-area" x={element.x} y={element.y} width={element.width} height={element.height} fill="transparent" />
<g data-model3d-furniture="under">{@html furniture.under}</g>
{#if url}
  <image data-model3d-poster data-model3d-key={displayedKey} x={layout.viewport.x} y={layout.viewport.y} width={layout.viewport.width} height={layout.viewport.height} preserveAspectRatio="none" href={url} />
{:else}
  <g data-model3d-placeholder role="img" aria-label={`${element.name ?? asset?.name ?? '3D model'}: ${reason}`}>
    <title>{reason}</title>
    <rect x={layout.viewport.x} y={layout.viewport.y} width={layout.viewport.width} height={layout.viewport.height} fill="#F2F0E5" stroke="#B7B5AC" stroke-width="0.75" />
    <text x={layout.viewport.x + layout.viewport.width / 2} y={layout.viewport.y + layout.viewport.height / 2 - 12} text-anchor="middle" font-family="Inter, sans-serif" font-size="14" fill="#6F6E69">◈ 3D</text>
    <text x={layout.viewport.x + layout.viewport.width / 2} y={layout.viewport.y + layout.viewport.height / 2 + 5} text-anchor="middle" font-family="Inter, sans-serif" font-size="10" fill="#6F6E69">{element.name ?? asset?.name ?? '3D model'}</text>
    <text x={layout.viewport.x + layout.viewport.width / 2} y={layout.viewport.y + layout.viewport.height / 2 + 20} text-anchor="middle" font-family="Inter, sans-serif" font-size="8" fill="#6F6E69">{shortReason}</text>
  </g>
{/if}
<g data-model3d-furniture="over">{@html furniture.over}</g>
