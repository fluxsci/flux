// TypeScript mirror of the FluxPlot manifest (the `*.fluxplot.json` sidecar
// emitted by the Python library). The app reads this to know a plot's parts,
// data values, coordinate mapping, and build order. See Flux_SemanticSVG_Spec.md.

import type * as Gen from "./types.gen";

// The generated contract (json-schema-to-typescript over the vendored fluxplot schemas —
// scripts/sync-fluxplot-schemas.mjs). Everything below DERIVES from it: new manifest fields
// arrive by re-syncing, and the few narrowings the app relies on are spelled out here.
export type { Gen };

export type FluxPlotAxis = Gen.Axis;

/** A series. `svg` and `points` are narrowed: the app indexes `svg.line` / `svg.points` as
 *  strings and `svg.bars` as a list, and a listed point always has finite coordinates
 *  (fluxplot drops null-coordinate points from `points[]`). */
export interface FluxPlotSeries extends Omit<Gen.Series, "svg" | "points"> {
  svg: { line?: string; points?: string; bars?: string[]; [k: string]: string | string[] | undefined };
  points?: { index: number; svgId: string; x: number; y: number }[];
}

export type FluxPlotGuide = Gen.Guide;
export type FluxPlotOverlay = Gen.Overlay;
export type FluxPlotColorScale = Gen.ColorScale;
export type FluxPlotRecipe = Gen.FluxPlotRecipeGen;

/** The manifest. `spec` is widened (DERIVED manifests for vanilla svgs carry their own spec),
 *  `parts` / `build` stay optional (pre-0.2.0 manifests lack them). */
export interface FluxPlotManifest
  extends Omit<Gen.FluxPlotManifestGen, "spec" | "series" | "guides" | "overlays" | "parts" | "build"> {
  spec: string;
  series: FluxPlotSeries[];
  guides?: FluxPlotGuide[];
  overlays?: FluxPlotOverlay[];
  parts?: PartNode;
  build?: { order: string[]; presets?: Record<string, FluxPlotBuildPreset> };
}

/** A node in the manifest's hierarchical part tree (the scene graph the generator
 *  emits). A leaf has `id`/`ref` (+ `role` since fluxplot 0.3.1); a group carries
 *  `members` (concrete leaf ids) with `groupRole` / `memberRole`; a container carries
 *  `children`. DERIVED manifests (plot/derive.ts) set `label` so the X-ray reads friendly.
 *  Consumed by buildPartTree/resolveTargets and the slide player's part targeting. */
export type PartNode = Gen.PartNode;

/** A per-role default animation the generator suggests (manifest.build.presets):
 *  `animation` is fluxplot's closed vocabulary, `delayMs` offsets the reveal inside its
 *  phase, `staggerBy` names the data attribute a stagger-in orders its members by. */
export type FluxPlotBuildPreset = NonNullable<Gen.FluxPlotManifestGen["build"]["presets"]>[string];

/** A field's source-data colour contract; the portable law is colorScales[field.colorScale]. */
export type FluxPlotField = Gen.Field;

// Flat lookup of one addressable part, resolved from the manifest by semantic id.
export interface PartInfo {
  id: string;
  role: string;
  series?: string;
  index?: number;
  x?: number;
  y?: number;
  label?: string;
}

