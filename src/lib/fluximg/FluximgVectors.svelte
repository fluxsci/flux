<svelte:options namespace="svg" />

<script lang="ts">
  /**
   * The vector half of a placed fluximg, as SVG children of the element's box: vector and label layers, object
   * names, then furniture. The element at rest and the live view both mount this, so what you adjust is what
   * stays. The strings come from the same pure builders the export uses (`layers.ts`, `furniture.ts`).
   */
  import { fluximgLayerText, fluximgLutsReady, needLayerText, needLuts, resolveLut } from "./store";
  import { layerMarkup, namesMarkup, objectIndex } from "./layers";
  import { furnitureSvg } from "./furniture";
  import { insetsMarkup, layerSvgPath, unflipTransform } from "./static";
  import type { FluximgManifest } from "./types";
  import type { PixelRect, ResolvedView } from "./view";

  let { asset, manifest, view, crop, box, prefix, flipX = false, flipY = false, insets = [] }: {
    asset: { id: string; path: string };
    manifest: FluximgManifest;
    view: ResolvedView;
    /** Level-0 image pixels shown in the box. */
    crop: PixelRect;
    box: { width: number; height: number };
    prefix: string;
    flipX?: boolean;
    flipY?: boolean;
    /** Blow-outs of this element: each one's frame is outlined on it. */
    insets?: Array<{ id: string; crop: PixelRect }>;
  } = $props();

  const objectLayers = $derived.by(() => {
    const byId = new Map(manifest.layers.map((l) => [l.id, l]));
    const out = [];
    for (const lv of view.layers) {
      if (!lv.visible || lv.kind === "intensity") continue;
      const layer = byId.get(lv.id), path = layerSvgPath(layer);
      if (layer && path) out.push({ lv, layer, path });
    }
    return out;
  });
  $effect(() => { for (const l of objectLayers) needLayerText(asset, l.path); });

  // Markup is rebuilt only when its own inputs change: stepping through planes must not re-place 20,000 outlines.
  const memo = new Map<string, { sig: string; markup: string }>();
  function memoized(id: string, sig: string, build: () => string): string {
    const hit = memo.get(id);
    if (hit && hit.sig === sig) return hit.markup;
    // A layer file anyone may have written can be refused by the sanitizer: draw nothing rather than break the figure.
    let markup = "";
    try { markup = build(); } catch { markup = ""; }
    memo.set(id, { sig, markup });
    return markup;
  }
  const geometry = $derived(`${crop.x},${crop.y},${crop.width},${crop.height}|${box.width}x${box.height}|${prefix}`);
  const layers = $derived.by(() => {
    const texts = $fluximgLayerText;
    return objectLayers.map(({ lv, layer, path }) => {
      const text = texts[`${asset.id}|${path}`];
      if (text === undefined) return { id: lv.id, markup: "" };
      return { id: lv.id, markup: memoized(`layer:${lv.id}`, `${geometry}|${JSON.stringify(lv)}|${text.length}`, () => layerMarkup(layer, text, lv, crop, box, prefix)) };
    });
  });
  const names = $derived.by(() => {
    const n = view.furniture.names;
    if (!n) return "";
    const texts = $fluximgLayerText;
    let out = "";
    for (const { lv, layer, path } of objectLayers) {
      if (!n.layers.includes(lv.id)) continue;
      const text = texts[`${asset.id}|${path}`];
      if (text === undefined) continue;
      const color = lv.color ?? layer.color ?? "#ffffff";
      out += memoized(`names:${lv.id}`, `${geometry}|${n.fontSize}|${color}|${text.length}|${flipX ? 1 : 0}${flipY ? 1 : 0}`,
        () => namesMarkup(objectIndex(text), null, crop, box, { layerId: lv.id, fontSize: n.fontSize, color, flipX, flipY }, prefix));
    }
    return out;
  });
  // The calibration bar draws a colour map's own colours, so the tables must be loaded (lazily) when one is shown.
  $effect(() => { if (view.furniture.colorbar && view.channels.some((c) => c.lut)) void needLuts(); });
  const furniture = $derived.by(() => { void $fluximgLutsReady; try { return furnitureSvg(manifest, view, crop, box, prefix, resolveLut); } catch { return ""; } });
  // A mirrored element mirrors its pixels and shapes, never its words: text sits in a group that undoes the mirror.
  const unflip = $derived(unflipTransform(box, flipX, flipY) || undefined);
</script>

{#each layers as layer (layer.id)}{@html layer.markup}{/each}
{@html insetsMarkup(insets, crop, box, prefix)}
{#if unflip}<g transform={unflip}>{@html names}{@html furniture}</g>{:else}{@html names}{@html furniture}{/if}
