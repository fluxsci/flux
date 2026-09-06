// TypeScript mirror of the FluxPlot manifest (the `*.fluxplot.json` sidecar
// emitted by the Python library). The app reads this to know a plot's parts,
// data values, coordinate mapping, and build order. See Flux_SemanticSVG_Spec.md.

export interface FluxPlotAxis {
  supported?: boolean;
  units?: { kind: string; [key: string]: unknown };
  ticks?: { value: number; label: string }[];
  scale: string; // linear | log | ...
  label?: string;
  base?: number; // for log scales
  domain: [number, number];
  anchors: { data: number; svg: number }[]; // data↔SVG-pixel mapping (interpolate)
}

export interface FluxPlotSeries {
  id: string;
  name?: string;
  kind?: string | null;
  roles?: string[];
  svg: { line?: string; points?: string; bars?: string[]; [k: string]: string | string[] | undefined };
  data?: { x: (number | null)[]; y: (number | null)[] };
  panelId?: string;
  rasterized?: boolean;
  capabilities?: { dataMorph: boolean };
  components?: { role: string; svgId: string; members?: string[] }[];
  field?: FluxPlotField;
  label?: string;
  points?: { index: number; svgId: string; x: number; y: number }[];
}

export interface FluxPlotGuide {
  id: string;
  svgId?: string;
  role: string;
  axis?: string;
  mappable?: string;
  parts?: { svgId: string; role: string }[];
  entries?: { series: string }[];
}

export interface FluxPlotOverlay {
  id: string;
  svgId: string;
  role: string;
  name?: string;
  label?: string;
  between?: string[];
  p?: number;
}

export interface FluxPlotManifest {
  spec: string;
  schemaVersion: string;
  generator?: { name: string; version: string; matplotlib?: string };
  plotType: string;
  svg: string;
  size: { width: number; height: number; unit: string };
  artifact?: { svgSha256?: string };
  panels?: { id: string; svgId: string; label?: string; index?: number }[];
  axes: { id?: string; svgId?: string; panelId?: string; projection?: string; x: FluxPlotAxis; y: FluxPlotAxis; pixelBox?: unknown }[];
  series: FluxPlotSeries[];
  guides?: FluxPlotGuide[];
  overlays?: FluxPlotOverlay[];
  parts?: PartNode;
  build?: { order: string[]; presets?: Record<string, FluxPlotBuildPreset> };
}

/** A node in the manifest's hierarchical part tree (the scene graph the generator
 *  emits). A leaf has `id`/`ref`; a group carries `members` (concrete leaf ids); a
 *  container carries `children`. Consumed by buildPartTree/resolveTargets and the
 *  slide player's part targeting. */
export interface PartNode {
  id?: string;
  ref?: string;
  role?: string;
  axis?: string;
  groupRole?: string;
  // Authored display label. fluxplot doesn't emit one (labels derive from role);
  // DERIVED manifests (plot/derive.ts, for non-fluxplot SVGs) set it so the
  // X-ray shows "X tick 3" instead of the raw "xtick_3" node id.
  label?: string;
  members?: string[];
  children?: PartNode[];
}

/** A per-role default animation the generator suggests (manifest.build.presets),
 *  e.g. { animation: "draw-on", durationMs: 400 } or stagger-in with staggerMs. */
export interface FluxPlotBuildPreset {
  animation: string;
  durationMs?: number;
  staggerMs?: number;
}

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

/** A field's source-data color contract. Raster color changes require regeneration. */
export interface FluxPlotField {
  kind: "heatmap" | "contour" | "contourf";
  shape: number[];
  controlKey: string;
  cmap: string;
  normalization: { kind: string; vmin: number | null; vmax: number | null; [key: string]: unknown };
  maskedIndices?: number[];
  values?: (number | null)[][];
  levels?: number[];
  extent?: number[];
  grid?: { x: number[] | number[][]; y: number[] | number[][] };
}
