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
  import { insetsMarkup, layerStyles, layerSvgPath, layerTablePath, stylesToDraw, unflipTransform, wantsTable } from "./static";
  import { missingStyle, shownObjects, type ObjectLegend } from "./objectStyle";
  import { fluximgTableIssues, fluximgTables, needTable, tableKey, tableOf } from "./live/objectTables";
  import type { FluximgManifest, FluximgTable } from "./types";
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
  // A layer styled by its table needs the table (and, coloured by numbers, the colour maps). Nothing is asked for,
  // and no table store is read, while no shown layer is styled: an unstyled image costs what it always did.
  const styled = $derived(objectLayers.filter((l) => wantsTable(l.lv)));
  $effect(() => {
    for (const l of styled) needTable(asset, layerTablePath(l.layer));
    if (styled.some((l) => l.lv.styleBy?.color)) void needLuts();
  });
  /** Layer id → its table, for the styled layers only. */
  const tables = $derived.by((): Record<string, FluximgTable | null> => {
    if (!styled.length) return {};
    const all = $fluximgTables, out: Record<string, FluximgTable | null> = {};
    for (const l of styled) out[l.lv.id] = tableOf(all, asset, layerTablePath(l.layer));
    return out;
  });
  // An object's identity in a memo signature (the store hands out the same table, the cache the same styles).
  const ids = new WeakMap<object, number>();
  let serial = 0;
  const tableId = (t: object | null | undefined): number => { if (!t) return 0; let n = ids.get(t); if (!n) { n = ++serial; ids.set(t, n); } return n; };
  /**
   * A styled layer waits for its table (and, coloured, for the colour maps) and keeps its last picture meanwhile:
   * drawing it unstyled, then grey, then coloured would flash. A table that cannot be read stops the wait (unstyled).
   */
  const waiting = (lv: (typeof objectLayers)[number]["lv"], layer: (typeof objectLayers)[number]["layer"]): boolean => {
    if (!lv.styleBy) return false;
    if (tables[lv.id]) return !!lv.styleBy.color && !$fluximgLutsReady;
    return !(tableKey(asset, layerTablePath(layer)) in $fluximgTableIssues);
  };
  /** The styles of each styled layer (cached per table and request in `objectStyle`), and its legend for the key. */
  const styles = $derived.by(() => {
    if (!styled.length) return null;
    void $fluximgLutsReady;
    const out: Record<string, ReturnType<typeof layerStyles>> = {};
    for (const l of styled) out[l.lv.id] = stylesToDraw(layerStyles(l.layer, l.lv, tables[l.lv.id], resolveLut));
    return out;
  });
  const legends = $derived.by((): Record<string, ObjectLegend | null> | undefined => {
    if (!styles) return undefined;
    const out: Record<string, ObjectLegend | null> = {};
    for (const [id, s] of Object.entries(styles)) out[id] = s?.legend ?? null;
    return out;
  });

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
      if (!lv.styleBy) return { id: lv.id, markup: memoized(`layer:${lv.id}`, `${geometry}|${JSON.stringify(lv)}|${text.length}`, () => layerMarkup(layer, text, lv, crop, box, prefix)) };
      if (waiting(lv, layer)) return { id: lv.id, markup: memo.get(`layer:${lv.id}`)?.markup ?? "" };
      const st = styles?.[lv.id] ?? null, t = tables[lv.id];
      return { id: lv.id, markup: memoized(`layer:${lv.id}`, `${geometry}|${JSON.stringify(lv)}|${text.length}|t${tableId(t)}|${st ? 1 : 0}|${$fluximgLutsReady ? 1 : 0}`,
        () => layerMarkup(layer, text, lv, crop, box, prefix, st?.byKey, st ? missingStyle(lv.styleBy) : null)) };
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
      // An object hidden by its styling (missing: "hide") has no name either.
      const st = lv.styleBy?.missing === "hide" ? styles?.[lv.id] ?? null : null;
      out += memoized(`names:${lv.id}`, `${geometry}|${n.fontSize}|${color}|${text.length}|${flipX ? 1 : 0}${flipY ? 1 : 0}|${tableId(st)}`,
        () => namesMarkup(shownObjects(objectIndex(text), st?.byKey, st ? missingStyle(lv.styleBy) : null), null, crop, box, { layerId: lv.id, fontSize: n.fontSize, color, flipX, flipY }, prefix));
    }
    return out;
  });
  // The calibration bar draws a colour map's own colours, so the tables must be loaded (lazily) when one is shown.
  $effect(() => { if (view.furniture.colorbar && view.channels.some((c) => c.lut)) void needLuts(); });
  const furniture = $derived.by(() => { void $fluximgLutsReady; try { return furnitureSvg(manifest, view, crop, box, prefix, resolveLut, view.furniture.key ? legends : undefined); } catch { return ""; } });
  // A mirrored element mirrors its pixels and shapes, never its words: text sits in a group that undoes the mirror.
  const unflip = $derived(unflipTransform(box, flipX, flipY) || undefined);
</script>

{#each layers as layer (layer.id)}{@html layer.markup}{/each}
{@html insetsMarkup(insets, crop, box, prefix)}
{#if unflip}<g transform={unflip}>{@html names}{@html furniture}</g>{:else}{@html names}{@html furniture}{/if}
