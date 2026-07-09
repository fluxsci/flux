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
  // Model version. 2 = text sizing modes replace autoWidth (+ named text styles).
  // migrate.ts brings older docs up; loaders (store.normalizeProject, flux-core
  // loadFigModel) run it on every load.
  version: 2;
  name: string;
  canvases: Canvas[]; // pages (Figma-style); each figure belongs to one
  figures: Figure[];
  assets: Asset[];
  palette: string[]; // ad-hoc / recent custom colours, e.g. "#1b9e77"
  colorGroups?: ColorGroup[]; // imported palettes (e.g. Flexoki), grouped by hue
  // Named text styles (project-level). A machine-global LIBRARY of styles also
  // exists (FileBridge read/writeGlobalTextStyles); applying a library style
  // COPIES it in here (copy-on-apply — no live cross-project sync).
  textStyles?: TextStyle[];
}

// A named, reusable text style ("Panel Label" = Arial 8 pt bold). fontSize is
// stored in canvas px (pt × 4/3), the same storage unit as TextElement.fontSize.
// Elements link via `styleId` (live: editing the style re-applies to linked
// elements; a manual font edit on an element detaches it). Optional props
// (underline/lineHeight/color/align) apply only when defined.
export interface TextStyle {
  id: Id;
  name: string;
  fontFamily: string;
  fontSize: number; // canvas px
  fontWeight: number;
  fontStyle: "normal" | "italic";
  underline?: boolean;
  lineHeight?: number;
  color?: string;
  align?: "left" | "center" | "right";
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
  // Ruler guides (Feature 11), figure-local. `x` = vertical guide lines at those
  // x positions; `y` = horizontal guides. Elements snap to them while moving.
  guides?: { x?: number[]; y?: number[] };
}

// An imported source file, stored once and referenced by `image` (png) /
// `plot` (svg — every svg is a semantic plot) elements.
export interface Asset {
  id: Id;
  name: string;
  kind: "png" | "svg";
  // Relative path inside the project dir, e.g. "assets/plot1.svg".
  path: string;
  // Intrinsic dimensions in px (used to seed placement size / aspect ratio).
  // For SVG these are CSS px (the browser converts pt/mm/in at 96 px/inch), so they
  // ARE the declared physical size in canvas units. For PNG they are raw pixels.
  naturalWidth: number;
  naturalHeight: number;
  // Physical resolution a PNG declared via its pHYs chunk (px/inch), captured at
  // import. Physical size in canvas px = natural × 96/dpi. Absent for SVG (already
  // physical) and for rasters that declare nothing (screenshots: 1 px = 1 canvas px).
  dpi?: number;
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
  // Whole-element visibility (Layers panel eye). Hidden elements are not
  // rendered, not hit-testable, and omitted from export — but stay in the model
  // and the Layers list so they can be toggled back on.
  hidden?: boolean;
  // Constrain proportions (Figma's chain-link toggle next to W/H). When on,
  // editing one dimension scales the other to keep the aspect ratio, and a
  // canvas corner-resize is forced uniform (no Shift needed).
  lockAspect?: boolean;
  opacity?: number; // 0..1
  // Elements sharing a groupId are selected and moved together.
  groupId?: Id;
}

// Crop window in INTRINSIC content px (assetDisplaySize units: SVG natural px,
// PNG natural×96/dpi). Rendering shows exactly this sub-rect stretched into the
// element box (inline svg → viewBox sub-rect; <image> → nested-svg viewport).
// Ctrl-drag on a resize handle edits it Figma-style (content pinned).
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A raster (PNG) placement. SVGs never take this shape — every svg asset is a
// SemanticPlotElement (inline live DOM), with `<image>` only as its fallback.
export interface ImageElement extends ElementBase {
  type: "image";
  assetId: Id;
  crop?: CropRect;
}

export interface TextElement extends ElementBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  underline?: boolean; // rendered as text-decoration: underline
  // Line height as a multiple of fontSize (CSS-style). Default 1.2 (text.ts
  // LINE_HEIGHT) — the one source; render/export/editor all use lineH(el).
  lineHeight?: number;
  align: "left" | "center" | "right";
  color: string;
  // Sizing mode (replaces the old boolean autoWidth; migrate.ts converts):
  //   "auto"   — the box hugs the text, no wrapping (Figma auto-width)
  //   "auto-h" — wrap at the box width, height hugs the wrapped lines
  //   "fixed"  — both dimensions fixed; wrapped text may overflow (unclipped)
  sizing: "auto" | "auto-h" | "fixed";
  // DERIVED wrap cache — the visual lines last computed by text.ts
  // applyTextLayout (GUI recomputes on every text mutation + load). Headless
  // edits DELETE it instead (no font metrics under Node); renderers fall back
  // to the hard lines via visualLines(el). Never edit by hand.
  lines?: string[];
  // Linked named style (Project.textStyles). Manual font edits detach it.
  styleId?: Id;
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

// A bezier vector node (Feature 1). Element-local coords; handles are relative
// offsets from the node point. `smooth` keeps hIn/hOut colinear (mirrored) while
// editing; `corner` allows independent tangents (or none → straight segments).
export interface VectorHandle {
  dx: number;
  dy: number;
}
export interface VectorNode {
  x: number;
  y: number;
  type: "corner" | "smooth";
  hIn?: VectorHandle;
  hOut?: VectorHandle;
}

export interface PathElement extends ElementBase {
  type: "path";
  // SVG path data in element-local coords. Rendered/exported form — kept in sync
  // with `nodes` when present (regenerated via path.ts nodesToPath).
  d: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  closed: boolean;
  // When present, the AUTHORITATIVE editable geometry; `d` is derived from it.
  // Absent on legacy paths (d-only) until they're parsed for node editing.
  nodes?: VectorNode[];
}

// A semantic plot — EVERY imported SVG is one (figure-v1 P4; the old opaque
// `type:"svg"` <image> kind is gone, migrate.ts converts legacy docs). It is
// rendered INLINE so its tagged nodes (data-role / semantic ids like
// "control.point.3") are live, hit-testable DOM that can be addressed and
// restyled part-by-part. A fluxplot ships a real sidecar manifest; a vanilla
// SVG gets a DERIVED one at cachePlot (plot/derive.ts — never persisted). The
// plot's geometry stays authoritative in the SVG; the manifest (loaded
// separately, keyed by assetId) holds the data / coordinate mapping / build
// order. See Flux_SemanticSVG_Spec.md.
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
  // Crop window (intrinsic px) — rendered as a viewBox sub-rect.
  crop?: CropRect;
  // Geometric content scale persisted by the K/Scale tool. Plain resize keeps
  // text/strokes pt-true (plot/compensate.ts); K multiplies this instead.
  contentScale?: number;
}

// A style override for one semantic part. Open-ended; each key maps to a
// presentation property applied to the matching inlined node(s).
//
// Application rules (see plot/parse.ts applyOverrides): `hidden`, `opacity`,
// and the `dx`/`dy` translation apply to the id-carrying wrapper node; paint
// and font properties are drilled down to the DRAWABLE descendants (text/path/
// use/…) because generators like matplotlib put explicit inline styles on
// those children, which would defeat styles inherited from the wrapper.
export interface PartOverride {
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  opacity?: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  textDecoration?: string; // "underline" | "none"
  // Part translation in PLOT-LOCAL user units (survives regeneration — id-keyed
  // like every other override). Composed as a `translate(dx dy)` prepended to
  // the wrapper's own transform attribute.
  dx?: number;
  dy?: number;
  hidden?: boolean; // hide/show the part (display:none)
  [prop: string]: string | number | boolean | undefined;
}

export type Element =
  | ImageElement
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
