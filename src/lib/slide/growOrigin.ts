// ---------------------------------------------------------------------------
// Flux Slide — pure bar-growth geometry (WP 1.2, origins are data). No DOM, so the player's preset
// compilers and any headless consumer share ONE answer (twin-engine rule).
//
//  • barGrow()        — which axis a bar scales along and which EDGE of its own fill box is its baseline.
//  • isManifestBar()  — does the manifest list this part id as a bar?
// ---------------------------------------------------------------------------
import type { FluxPlotManifest } from "../plot/types";

export interface BarGrow {
  /** CSS scale function the entrance animates: scaleY for vertical bars, scaleX for horizontal. */
  fn: "scaleY" | "scaleX";
  /** The baseline edge of the bar's own box, as a `transform-origin` (percent of its fill-box). */
  origin: string;
}

type BarInfo = { orientation?: string; length?: (number | null)[] };

/** The series and index that list `partId` among their bars, or undefined. */
function barSeries(manifest: FluxPlotManifest | undefined, partId: string): { bar?: BarInfo; index: number } | undefined {
  for (const s of manifest?.series ?? []) {
    const bars = s.svg?.bars;
    if (!Array.isArray(bars)) continue;
    const index = bars.indexOf(partId);
    if (index >= 0) return { bar: (s as unknown as { bar?: BarInfo }).bar, index };
  }
  return undefined;
}

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
