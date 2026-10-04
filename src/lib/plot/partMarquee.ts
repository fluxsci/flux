// The marquee law for plot PARTS — one pure module shared by the Figure
// canvas (ctrl-drag from a plot's whitespace picks the parts inside the box)
// and the Become picker (`pick/pickModel.ts` builds its object/leaf law on
// top of it). DOM-free: `verify-become-picker.ts` and `verify-part-marquee.ts`
// pin it in the pure tier; measuring the candidate boxes is the caller's job.

import type { FluxPlotManifest } from "./types";
import { buildPartTree } from "./tree";
import { buildPartIndex } from "./parse";
import { isScaffoldPart } from "./partStyle";

export interface Box { x: number; y: number; w: number; h: number }

/** One leaf part of one plot with its measured box (any consistent space). */
export interface PartBoxCandidate {
  partId: string;
  rect: Box;
  /** A DATA mark (point, bar, box, line, …) rather than guide furniture. */
  data: boolean;
}

const EPS = 0.5;
/** `r` lies fully inside `box` (half-pixel tolerance for anti-aliased edges). */
export function rectInside(r: Box, box: Box): boolean {
  return r.x >= box.x - EPS && r.y >= box.y - EPS && r.x + r.w <= box.x + box.w + EPS && r.y + r.h <= box.y + box.h + EPS;
}

/** Normalize a drag box from any two corners. */
export function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Leaf roles that are guide furniture rather than data (the marquee's preference). */
export const FURNITURE_ROLES: ReadonlySet<string> = new Set([
  "tick", "tick-label", "spine", "gridline", "axis-title", "title", "subtitle", "label", "legend", "legend-entry",
  "legend-label", "legend-handle", "colorbar", "colorbar-label", "colorbar-tick", "colorbar-tick-label", "colorbar-outline",
  "annotation", "reference-line", "significance-bracket", "text",
]);
export const isDataRole = (role: string | undefined): boolean => !!role && !FURNITURE_ROLES.has(role);

/** Data marks preferred: when any data mark of ONE object is in the set, its
 *  guide furniture (ticks, labels, spines) is left out; furniture is picked
 *  only when no data mark is. Order is preserved. */
export function preferData<T extends { data?: boolean }>(leaves: readonly T[]): T[] {
  return leaves.some((l) => l.data) ? leaves.filter((l) => l.data) : [...leaves];
}

/** The in-plot marquee law: every leaf part whose box is FULLY inside, data
 *  marks preferred over furniture. Zero-area boxes never count. Candidates
 *  arrive — and come back — in paint order. */
export function partsInside(candidates: readonly PartBoxCandidate[], box: Box): string[] {
  const inside = candidates.filter((c) => (c.rect.w > 0 || c.rect.h > 0) && rectInside(c.rect, box));
  return preferData(inside).map((c) => c.partId);
}

const indexes = new WeakMap<FluxPlotManifest, ReturnType<typeof buildPartIndex>>();
/** A manifest's part index, built once per manifest identity. */
export function partIndexOf(manifest: FluxPlotManifest | undefined): ReturnType<typeof buildPartIndex> {
  if (!manifest) return {};
  let idx = indexes.get(manifest);
  if (!idx) { idx = buildPartIndex(manifest); indexes.set(manifest, idx); }
  return idx;
}

const leafLists = new WeakMap<FluxPlotManifest, string[]>();
/** A manifest's concrete non-scaffold leaf part ids, in tree order (memoized
 *  per manifest identity — manifests are immutable; regeneration replaces them). */
export function leafPartIds(manifest: FluxPlotManifest | undefined): string[] {
  if (!manifest) return [];
  let leaves = leafLists.get(manifest);
  if (!leaves) {
    leaves = [...new Set(buildPartTree(manifest)?.targets ?? [])].filter((pid) => !isScaffoldPart(manifest, pid));
    leafLists.set(manifest, leaves);
  }
  return leaves;
}
