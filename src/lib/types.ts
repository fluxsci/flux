// ---------------------------------------------------------------------------
// Flux figure data model
//
// A Project is a flat collection of figures (= Figma frames) positioned on an
// infinite canvas, plus an asset library and a colour palette. Each figure owns
// an ordered list of elements (z-order = array order). Elements are positioned
// in the figure's local coordinate space (0,0 = figure top-left).
//
// This shape is what gets serialised to `project.json`. Keep it JSON-friendly
// (no class instances, no functions) so the on-disk format stays open and
// inspectable.
// ---------------------------------------------------------------------------

export type Id = string;

export interface Project {
  version: 1;
  name: string;
  canvases: Canvas[]; // pages (Figma-style); each figure belongs to one
  figures: Figure[];
  assets: Asset[];
  palette: string[]; // ad-hoc / recent custom colours, e.g. "#1b9e77"
  colorGroups?: ColorGroup[]; // imported palettes (e.g. Flexoki), grouped by hue
}

// A canvas = an infinite 2-D page that holds figures (like a Figma page).
export interface Canvas {
  id: Id;
  name: string;
}

export interface ColorSwatch {
  name: string;
  hex: string; // "#rrggbb" or "#rrggbbaa"
}
export interface ColorGroup {
  name: string;
  swatches: ColorSwatch[];
}

export interface Figure {
  id: Id;
  name: string;
  // Which canvas (page) this figure lives on.
  canvasId: Id;
  // Position + size on the infinite canvas (world units == points/px at 1x).
  x: number;
  y: number;
  width: number;
  height: number;
  background: string; // CSS colour or "transparent"
  elements: Element[];
  // Per-panel caption text, keyed by the panel-label element's id (see
  // captions.ts / CaptionEditor.svelte). Edited via the caption editor (Alt+C).
  captions?: Record<Id, string>;
}

// An imported source file, stored once and referenced by `image`/`svg` elements.
export interface Asset {
  id: Id;
  name: string;
  kind: "png" | "svg";
  // Relative path inside the project dir, e.g. "assets/plot1.svg".
  path: string;
  // Intrinsic dimensions in px (used to seed placement size / aspect ratio).
  naturalWidth: number;
  naturalHeight: number;
}

// Common transform/style fields shared by every element. Exported so the Flux
// Slide element superset (src/lib/slide/types.ts) can extend it — the slide-only
// types (textBox/math/video/embedFigure) reuse the same base so position/size/
// rotation/opacity/group + the editor's drag/resize/snap are uniform.
export interface ElementBase {
  id: Id;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees, around the element's centre
  // Mirror flags, applied around the element's centre (see Element.svelte /
  // export.ts). Independent of rotation; both can be set.
  flipX?: boolean;
  flipY?: boolean;
  locked?: boolean;
  opacity?: number; // 0..1
  // Elements sharing a groupId are selected and moved together.
  groupId?: Id;
}

export interface ImageElement extends ElementBase {
  type: "image";
  assetId: Id;
}

export interface SvgElement extends ElementBase {
  type: "svg";
  assetId: Id;
}

export interface TextElement extends ElementBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  align: "left" | "center" | "right";
  color: string;
  // Auto-width: the box hugs the text (no wrapping). Default on, Figma-style.
  autoWidth: boolean;
  // Marked (Alt+L / inspector) as a figure panel label. Each marked text becomes
  // a caption block in the caption editor. Survives copy/duplicate (it's plain
  // element data, structuredClone'd like everything else). See captions.ts.
  panelLabel?: boolean;
}

export interface RectElement extends ElementBase {
  type: "rect";
  fill: string;
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
}

export interface EllipseElement extends ElementBase {
  type: "ellipse";
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface LineElement extends ElementBase {
  type: "line";
  // Endpoints in element-local coords (relative to x,y).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  arrowStart: boolean;
  arrowEnd: boolean;
}

export interface PathElement extends ElementBase {
  type: "path";
  // SVG path data in element-local coords.
  d: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  closed: boolean;
}

// A FluxPlot semantic plot. Unlike SvgElement (an opaque <image>), this is
// rendered INLINE so its tagged nodes (data-role / semantic ids like
// "control.point.3") are live, hit-testable DOM that can be addressed and
// restyled part-by-part. The plot's geometry stays authoritative in the SVG;
// the sidecar manifest (loaded separately, keyed by assetId) holds the data /
// coordinate mapping / build order. See Flux_SemanticSVG_Spec.md.
export interface SemanticPlotElement extends ElementBase {
  type: "plot";
  // The .svg bytes, stored as an Asset (reuses asset storage → free <image>
  // fallback + existing persistence).
  assetId: Id;
  // Where the plot + sidecars live in the project's user-owned plots/ dir
  // (relative to project root), for relink / regenerate.
  source?: { svgPath: string; manifestPath?: string; recipePath?: string };
  // Spec version / content hash of the manifest this was placed against.
  manifestRef?: { specVersion: string; hash?: string };
  // Per-part style overrides, keyed by STABLE semantic id (e.g. "control.line").
  // Because ids are deterministic, these survive plot regeneration (recipe rerun).
  overrides?: Record<string, PartOverride>;
}

// A style override for one semantic part. Open-ended; each key maps to a
// presentation attribute applied to the matching inlined node.
export interface PartOverride {
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  opacity?: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  hidden?: boolean; // hide/show the part (display:none)
  [prop: string]: string | number | boolean | undefined;
}

export type Element =
  | ImageElement
  | SvgElement
  | TextElement
  | RectElement
  | EllipseElement
  | LineElement
  | PathElement
  | SemanticPlotElement;

export type ElementType = Element["type"];

// ---------------------------------------------------------------------------
// Viewport — not persisted; lives in the editor only.
// ---------------------------------------------------------------------------
export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}
