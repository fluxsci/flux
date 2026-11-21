/**
 * The window's lookup of an image's OBJECT index (stage 2, W8): the provider every compile, the X-ray, picks and the
 * Animate panel reach through `fluximg/parts.fluximgPartsLookup` when they name none. It reads the window's stores (the
 * image's manifest and layer texts) and asks for what is missing; the stores' updates bump `fluximgPartsRevision`, so
 * whatever depends on an index recomputes when it lands. Nothing here runs for a deck whose tracks name no image objects:
 * the lookup is only ever called for a part-bound track (or a pick, or an X-ray row) on an image.
 */
import { derived, get } from "svelte/store";
import { project } from "../store";
import type { Asset } from "../types";
import { fluximgLayerText, fluximgManifests, needLayerText, needManifest } from "./store";
import { fluximgTableIssues, fluximgTables, needTable, tableKey, tableOf } from "./live/objectTables";
import { partIndexFromTexts, registerFluximgParts, type FluximgPartIndex } from "./parts";
import type { FluximgTable } from "./types";

type FluximgAsset = Asset & { kind: "fluximg" };
const assetOf = (id: string): FluximgAsset | undefined => get(project).assets.find((a): a is FluximgAsset => a.id === id && a.kind === "fluximg");

/** An image's object index from the window's stores, loading what is missing (undefined until its manifest is here; a
 *  layer whose text has not landed is listed not loaded). */
export function appFluximgParts(assetId: string): FluximgPartIndex | undefined {
  const asset = assetOf(assetId);
  if (!asset) return undefined;
  const manifest = get(fluximgManifests)[assetId];
  if (!manifest) { void needManifest(asset).catch(() => {}); return undefined; }
  const texts = get(fluximgLayerText);
  return partIndexFromTexts(manifest, (path) => {
    const text = texts[`${assetId}|${path}`];
    if (text === undefined) needLayerText(asset, path);
    return text;
  });
}

/** A layer's table from the window's store (loading it on a miss): undefined while it loads, null when unreadable. */
export function appFluximgTable(assetId: string, path: string): FluximgTable | null | undefined {
  const asset = assetOf(assetId);
  if (!asset) return null;
  const table = tableOf(get(fluximgTables), asset, path);
  if (table) return table;
  if (tableKey(asset, path) in get(fluximgTableIssues)) return null;
  needTable(asset, path);
  return undefined;
}

/** Bumps whenever something an index or a column order is built from lands (manifests, layer texts, tables). */
export const fluximgPartsRevision = derived([fluximgManifests, fluximgLayerText, fluximgTables], (_, set: (n: number) => void) => { set(++revision); }, 0);
let revision = 0;

registerFluximgParts(appFluximgParts, appFluximgTable);
