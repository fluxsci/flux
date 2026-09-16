// The colour collections the app ships (2026-09-16): fluxplot's colormap and
// palette definitions, bundled by scripts/gen-color-collections.mjs. Pure: the
// pickers, the Inspector, the settings dialog and the gates all read through
// these helpers, so a map is one thing everywhere — `crameri.batlow` in the
// picker is the very name fluxplot regenerates a plot with.
import { COLORMAP_COLLECTIONS, PALETTE_COLLECTIONS, type ColormapCollection, type ColormapDef, type ColormapType, type PaletteCollection } from "./collections.gen";
import type { ColorGroup, GradientFill } from "../types";

export type { ColormapCollection, ColormapDef, ColormapType, PaletteCollection };
export { COLORMAP_COLLECTIONS, PALETTE_COLLECTIONS };

/** The types in the order the picker lists them. */
export const COLORMAP_TYPES: ColormapType[] = ["sequential", "diverging", "cyclic", "qualitative", "misc"];

export const DEFAULT_COLORMAP_COLLECTION = "mpl";
export const DEFAULT_PALETTE_COLLECTION = "flexoki";

export function colormapCollection(id: string): ColormapCollection | null {
  return COLORMAP_COLLECTIONS.find((c) => c.id === id) ?? null;
}
export function paletteCollection(id: string): PaletteCollection | null {
  return PALETTE_COLLECTIONS.find((c) => c.id === id) ?? null;
}

/** `crameri.batlow` → the collection id and the map; a bare name resolves through
 *  the collections in order (matplotlib first — the same rule fluxplot applies);
 *  a trailing `_r` marks the reversed map. */
export function findColormap(name: string): { collection: ColormapCollection; map: ColormapDef; reversed: boolean } | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const reversed = trimmed.endsWith("_r");
  const base = reversed ? trimmed.slice(0, -2) : trimmed;
  const dot = base.indexOf(".");
  if (dot > 0) {
    let cid = base.slice(0, dot);
    if (cid === "cmr") cid = "cmasher";
    const bare = base.slice(dot + 1);
    const collection = colormapCollection(cid);
    const map = collection?.maps.find((m) => m.name === bare);
    return collection && map ? { collection, map, reversed } : null;
  }
  for (const collection of COLORMAP_COLLECTIONS) {
    const map = collection.maps.find((m) => m.name === base);
    if (map) return { collection, map, reversed };
  }
  return null;
}

/** The qualified name fluxplot understands. */
export const qualifiedName = (collection: ColormapCollection | string, map: ColormapDef | string, reversed = false) =>
  `${typeof collection === "string" ? collection : collection.id}.${typeof map === "string" ? map : map.name}${reversed ? "_r" : ""}`;

/** The map's stops, reversed when asked. */
export function colormapStops(map: ColormapDef, reversed = false): string[] {
  return reversed ? [...map.colors].reverse() : map.colors;
}

/** A CSS gradient for a preview bar: hard steps for a discrete map, a smooth
 *  ramp otherwise. */
export function colormapGradient(map: ColormapDef, reversed = false): string {
  const stops = colormapStops(map, reversed);
  if (stops.length === 1) return stops[0];
  return `linear-gradient(to right, ${gradientStopsCss(map, reversed)})`;
}

/** A gradient fill for the model: the map's stops resolved NOW and stored on the
 *  element (types.ts GradientFill), so renderers never look the map up. Null when
 *  the name is unknown. */
export function makeGradientFill(map: string, axis: GradientFill["axis"]): GradientFill | null {
  const hit = findColormap(map);
  if (!hit) return null;
  const stops = colormapStops(hit.map, hit.reversed);
  if (!stops.length) return null;
  const g: GradientFill = { map: qualifiedName(hit.collection, hit.map, hit.reversed), axis: axis === "y" ? "y" : "x", stops };
  if (hit.map.discrete) g.discrete = true;
  return g;
}

/** The stop list of a CSS linear-gradient for a map (hard bands when discrete). */
export function gradientStopsCss(map: ColormapDef, reversed = false): string {
  const stops = colormapStops(map, reversed);
  if (map.discrete) {
    const w = 100 / stops.length;
    return stops.map((c, i) => `${c} ${(i * w).toFixed(3)}% ${((i + 1) * w).toFixed(3)}%`).join(", ");
  }
  return stops.join(", ");
}

/** The colour at position `t` (0–1) along the map — the nearest stop for a
 *  discrete map, linear interpolation between stops otherwise. */
export function colormapColorAt(map: ColormapDef, t: number, reversed = false): string {
  const stops = colormapStops(map, reversed);
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  if (stops.length === 1) return stops[0];
  if (map.discrete) return stops[Math.min(stops.length - 1, Math.floor(x * stops.length))];
  const pos = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = hexBytes(stops[i]), b = hexBytes(stops[i + 1]);
  const mix = (u: number, v: number) => Math.round(u + (v - u) * f);
  return "#" + [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function hexBytes(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The maps of a collection grouped by type, in COLORMAP_TYPES order (empty types skipped). */
export function colormapsByType(collection: ColormapCollection): { type: ColormapType; maps: ColormapDef[] }[] {
  return COLORMAP_TYPES.map((type) => ({ type, maps: collection.maps.filter((m) => m.type === type) })).filter((g) => g.maps.length);
}

/** A palette collection as the picker's rows (ColorGroup[]); the project's own
 *  imported palette is offered as a collection too when it has groups. */
export function paletteGroups(id: string, project?: { colorGroups?: ColorGroup[] } | null): ColorGroup[] {
  if (id === "project") return project?.colorGroups ?? [];
  return paletteCollection(id)?.groups ?? [];
}

/** The palette collections available for a project: the shipped ones plus
 *  "project" when the project imported its own palette. */
export function availablePaletteCollections(project?: { colorGroups?: ColorGroup[] } | null): { id: string; name: string }[] {
  const list = PALETTE_COLLECTIONS.map((c) => ({ id: c.id, name: c.name }));
  if (project?.colorGroups?.length) list.push({ id: "project", name: "Project" });
  return list;
}

/** Cycle to the next id in a list (Shift+Tab in the pickers). */
export function nextId(ids: string[], current: string, step = 1): string {
  if (!ids.length) return current;
  const i = ids.indexOf(current);
  return ids[(i < 0 ? 0 : i + step + ids.length) % ids.length];
}
