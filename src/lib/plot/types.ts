// TypeScript mirror of the FluxPlot manifest (the `*.fluxplot.json` sidecar
// emitted by the Python library). The app reads this to know a plot's parts,
// data values, coordinate mapping, and build order. See Flux_SemanticSVG_Spec.md.

export interface FluxPlotAxis {
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
  data?: { x: number[]; y: number[] };
  label?: string;
  points?: { index: number; svgId: string; x: number; y: number }[];
}

export interface FluxPlotGuide {
  id: string;
  svgId: string;
  role: string;
  axis?: string;
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
  axes: { id?: string; svgId?: string; x: FluxPlotAxis; y: FluxPlotAxis; pixelBox?: unknown }[];
  series: FluxPlotSeries[];
  guides?: FluxPlotGuide[];
  overlays?: FluxPlotOverlay[];
  parts?: unknown;
  build?: { order: string[]; presets?: Record<string, unknown> };
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
