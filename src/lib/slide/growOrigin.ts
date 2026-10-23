// ---------------------------------------------------------------------------
// Flux Slide — pure bar-growth geometry (WP 1.2, origins are data). No DOM, so the player's preset
// compilers and any headless consumer share ONE answer (twin-engine rule).
//
//  • barGrow()        — which axis a bar scales along and which EDGE of its own fill box is its baseline.
//  • isManifestBar()  — does the manifest list this part id as a bar?
//  • barGrowWeight()  — the scale of a bar that exists in only ONE version of a plot Change (WP 2.3, D8a).
// ---------------------------------------------------------------------------
import type { FluxPlotManifest } from "../plot/types";

export interface BarGrow {
  /** CSS scale function the entrance animates: scaleY for vertical bars, scaleX for horizontal. */
  fn: "scaleY" | "scaleX";
  /** The baseline edge of the bar's own box, as a `transform-origin` (percent of its fill-box). */
  origin: string;
}

type BarInfo = { orientation?: string; length?: (number | null)[] };

type BarEntry = { bar?: BarInfo; index: number };
// One part-id -> (series bar info, index) map per manifest, built on first use: a histogram of thousands of bins must not
// scan every series' bar list for every node (O(bars^2) at build). Manifests are immutable once loaded.
const barIndexes = new WeakMap<object, Map<string, BarEntry>>();
function barIndex(manifest: FluxPlotManifest): Map<string, BarEntry> {
  let map = barIndexes.get(manifest);
  if (!map) {
    map = new Map();
    for (const s of manifest.series ?? []) {
      const bars = s.svg?.bars;
      if (!Array.isArray(bars)) continue;
      const bar = (s as unknown as { bar?: BarInfo }).bar;
      bars.forEach((id, index) => { if (!map!.has(id)) map!.set(id, { bar, index }); });
    }
    barIndexes.set(manifest, map);
  }
  return map;
}

/** The series info and index that list `partId` among their bars, or undefined (the first series to list it wins). */
const barSeries = (manifest: FluxPlotManifest | undefined, partId: string): BarEntry | undefined => manifest ? barIndex(manifest).get(partId) : undefined;

/** Is `partId` one of the manifest's bars (`series[].svg.bars`)? */
export const isManifestBar = (manifest: FluxPlotManifest | undefined, partId: string): boolean => !!barSeries(manifest, partId);

/** Orientation + sign of one bar. Orientation is `series[].bar.orientation`; the sign is the signed
 *  `bar.length[i]` (value − baseline), else the node's own `data-x` (horizontal) / `data-y` (vertical)
 *  value. Absent manifest/bar info = the legacy reading: a vertical bar growing up from its bottom edge.
 *  Inverted VALUE axes are not detected (axis anchors cannot be matched to a series' panel reliably);
 *  inverted CATEGORY axes (ranked barh lists) never move the value axis. */
export function barGrow(manifest: FluxPlotManifest | undefined, partId: string, dataAttrs?: { x?: number | null; y?: number | null }): BarGrow {
  const found = barSeries(manifest, partId);
  const horizontal = found?.bar?.orientation === "horizontal";
  const length = found?.bar?.length?.[found.index];
  const datum = horizontal ? dataAttrs?.x : dataAttrs?.y;
  const negative = typeof length === "number" ? length < 0 : typeof datum === "number" && datum < 0;
  return horizontal
    ? { fn: "scaleX", origin: negative ? "100% 50%" : "0% 50%" }
    : { fn: "scaleY", origin: negative ? "50% 0%" : "50% 100%" };
}

/** Scale (0..1) of a keyed bar that exists in only one version of a plot Change, at Change progress `t`: an entering
 *  bar grows over the later part of the Change (t .45 -> 1), a leaving bar shrinks over the earlier part (t 0 -> .55),
 *  both on a smoothstep, so the two windows overlap the narrowing/widening of the paired bars and nothing fades
 *  (manim: shapes grow, they do not fade). 0 = flat on its baseline, 1 = at rest. */
export function barGrowWeight(entering: boolean, t: number): number {
  const u = entering ? (t - .45) / .55 : 1 - t / .55, c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
}
