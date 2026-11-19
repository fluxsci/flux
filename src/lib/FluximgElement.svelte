<script lang="ts">
  /**
   * A placed fluximg at rest: one still (a PNG data URL drawn by the reference renderer in a worker) plus
   * everything vector (layers, object names, furniture) as inline SVG. No WebGL here: this component is mounted
   * twice during resize previews, and it must survive being photographed (the zoom proxy) and serialized.
   *
   * The still follows the view: any change to what the pixels are (plane, contrast, crop, size tier) asks the
   * service for a new one and keeps showing the old one until it arrives, so nothing ever flashes. While the
   * live view streams a gesture over this element the request waits, so decode workers serve the live view first.
   */
  import { tick, untrack } from "svelte";
  import { project, viewport } from "./store";
  import { fluximgBundle, fluximgIdentity, fluximgIssues, fluximgManifests, fluximgService, fluximgStillRevision, needManifest } from "./fluximg/store";
  import FluximgVectors from "./fluximg/FluximgVectors.svelte";
  import { fluximgLive, fluximgLiveBusy } from "./fluximg/live/session";
  import { pixelKey, resolveView } from "./fluximg/viewOps";
  import { clampCrop, tieredStillSize } from "./fluximg/still";
  import { svgNum } from "./fluximg/layers";
  import { PLACEHOLDER_FILL, fluximgIdPrefix, insetsOf } from "./fluximg/static";
  import type { FluximgElement } from "./types";

  let { element }: { element: FluximgElement } = $props();

  /** Still pixels per canvas pixel at rest: sharp up to 2x zoom (or a 2x display at 1x). Zooming further in asks for
   *  a denser still, one octave at a time, up to the image's own pixels. */
  const BASE_SCALE = 2;
  // The density follows the zoom only once it has SETTLED: a zoom gesture must not order a still per wheel notch.
  let density = $state(BASE_SCALE);
  $effect(() => {
    const need = $viewport.zoom * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
    const octave = need <= BASE_SCALE ? BASE_SCALE : Math.pow(2, Math.ceil(Math.log2(need)));
    if (octave === density) return;
    const timer = setTimeout(() => { density = octave; }, 260);
    return () => clearTimeout(timer);
  });

  const asset = $derived($project.assets.find((a) => a.id === element.assetId && a.kind === "fluximg"));
  const manifest = $derived(asset ? $fluximgManifests[asset.id] : undefined);
  const issue = $derived(!asset ? "Image file missing" : $fluximgIssues[asset.id]);
  $effect(() => { if (asset && !manifest && !$fluximgIssues[asset.id]) void needManifest(asset).catch(() => {}); });

  const rv = $derived(manifest ? resolveView(manifest, element.view) : null);
  const crop = $derived(manifest ? clampCrop(manifest, element.crop) : null);
  const box = $derived({ width: element.width, height: element.height });
  const size = $derived(crop ? tieredStillSize(crop, box, density) : null);
  const key = $derived(asset && manifest && rv && crop && size ? `${fluximgIdentity(asset)}|${pixelKey(manifest, rv, crop, size.width, size.height)}` : "");
  /** What the still LOOKS like, whatever its resolution: only a change of this is news for cached pictures of the scene. */
  const look = $derived(key.replace(/;out=\d+x\d+/, ""));
  const prefix = $derived(fluximgIdPrefix(element.id));
  // Blow-outs of this image elsewhere in its figure: their frames are outlined on it.
  const insets = $derived.by(() => {
    for (const f of $project.figures) if (f.elements.some((e) => e.id === element.id)) return insetsOf(f.elements, element.id, element.assetId);
    return [];
  });

  // --- the still -------------------------------------------------------------------------------
  let shown = $state<{ href: string; key: string; look: string; native: boolean } | null>(null);
  let failed = $state("");
  // Each mounted copy asks in its own slot: a resize preview's twin must not cancel this one's request.
  const slot = `el:${Math.random().toString(36).slice(2)}`;
  // A live gesture on THIS element is streaming: the live view covers it, so its still can wait for the pause.
  const deferred = $derived($fluximgLiveBusy && $fluximgLive?.elementId === element.id);

  $effect(() => {
    const wanted = key;
    if (!wanted || !asset || !crop || !size || deferred) return;
    if (untrack(() => shown?.key) === wanted) return;
    let closed = false;
    const request = untrack(() => ({
      bundle: fluximgBundle(asset), view: element.view ? structuredClone(element.view) : null,
      crop: { ...crop }, outWidth: size.width, outHeight: size.height, slot,
    }));
    const native = size.native, wantedLook = look;
    fluximgService().still(wanted, request).then(
      (href) => {
        if (closed) return;
        const changed = untrack(() => shown?.look) !== wantedLook;
        shown = { href, key: wanted, look: wantedLook, native }; failed = "";
        // After different pixels are in the DOM, any cached picture of the scene is out of date. A sharper copy of
        // the same picture is not news (it arrives because of a zoom, and must not retake the scene mid-view).
        if (changed) void tick().then(() => { if (!closed) fluximgStillRevision.update((n) => n + 1); });
      },
      (error: unknown) => {
        if (closed) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "cancelled") failed = message;
      },
    );
    return () => { closed = true; };
  });

  // Loading is normally well under a second: show a quiet frame, and words only when it is slow or broken.
  const preparing = $derived(!shown && !issue && !failed);
  let slow = $state(false);
  $effect(() => {
    if (!preparing) { slow = false; return; }
    const timer = setTimeout(() => { slow = true; }, 1000);
    return () => clearTimeout(timer);
  });

  const label = $derived(element.name ?? asset?.name ?? "Image");
  const reason = $derived(issue || failed || "Preparing image");
  const w = $derived(svgNum(box.width)), h = $derived(svgNum(box.height));
  const background = $derived(rv && rv.background !== "transparent" ? rv.background : null);
</script>

<rect class="fluximg-hit-area" x={element.x} y={element.y} width={element.width} height={element.height} fill="transparent" />
<svg data-fluximg={element.assetId} data-fluximg-key={shown?.key ?? ""} x={element.x} y={element.y} width={w} height={h} viewBox={`0 0 ${w} ${h}`} overflow="hidden" style="overflow:hidden">
  {#if shown}
    {#if background}<rect id={`${prefix}background`} x="0" y="0" width={w} height={h} fill={background} />{/if}
    <image id={`${prefix}still`} x="0" y="0" width={w} height={h} preserveAspectRatio="none" href={shown.href}
      style={shown.native && !rv?.smooth ? "image-rendering:pixelated" : undefined} />
  {:else if preparing && !slow}
    <rect data-fluximg-placeholder data-fluximg-preparing x="0" y="0" width={w} height={h} fill={PLACEHOLDER_FILL} />
  {:else}
    {@const fit = Math.max(6, Math.min(13, Math.min(box.width / 14, box.height / 5)))}
    <g data-fluximg-placeholder role="img" aria-label={`${label}: ${reason}`}>
      <title>{reason}</title>
      <rect x="0" y="0" width={w} height={h} fill={PLACEHOLDER_FILL} />
      <text x={box.width / 2} y={box.height / 2 - fit * 0.4} text-anchor="middle" font-family="Inter, sans-serif" font-size={fit} fill={preparing ? "#b7b5ac" : "#d0a215"}>{preparing ? label : `⚠ ${label}`}</text>
      <text x={box.width / 2} y={box.height / 2 + fit * 1.0} text-anchor="middle" font-family="Inter, sans-serif" font-size={fit * 0.8} fill="#878580">{reason.length > 64 ? `${reason.slice(0, 61)}…` : reason}</text>
    </g>
  {/if}
  {#if asset && manifest && rv && crop}
    <FluximgVectors {asset} {manifest} view={rv} {crop} {box} {prefix} flipX={!!element.flipX} flipY={!!element.flipY} {insets} />
  {/if}
</svg>
