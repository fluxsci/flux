/**
 * fluximg vector and label layers as SVG: a strict sanitizer for the layer SVG a bundle carries, the markup that
 * places a layer's shapes on an element, an index of its objects, and the object-name labels.
 *
 * Pure string building: no DOM, no Node, no Svelte (twin-engine rule). The layer SVG comes from a file anyone
 * may have written, so it is never passed through: it is parsed against an allow-list (SPEC §6, "Layer SVG")
 * and the output is rebuilt from the parsed numbers and colours only.
 *
 * Coordinates: a layer's shapes are in level-0 image pixels; everything this module EMITS is in the element's
 * box (origin top-left, `box.width` x `box.height` canvas px), placed by one transform per layer.
 */
import type { FluximgLayer, FluximgTable } from "./types";
import type { PixelRect, ResolvedLayer } from "./view";

// ---------------------------------------------------------------------------------------------
// Small shared string helpers (furniture.ts and static.ts use them too)
// ---------------------------------------------------------------------------------------------

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
/** XML-escape text or an attribute value. */
export const escapeXml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);
/** A number as SVG text: at most 4 decimals, no "-0", no exponent noise. Deterministic. */
export function svgNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? "0" : String(r);
}

/** A number to 10 significant digits (transforms, where 4 decimals are not enough). */
export function preciseNum(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  return String(Number(n.toPrecision(10)));
}

// ---------------------------------------------------------------------------------------------
// The sanitizer
// ---------------------------------------------------------------------------------------------

export type LayerShapeTag = "path" | "polyline" | "polygon" | "line" | "circle" | "ellipse" | "rect";
export interface LayerShape {
  tag: LayerShapeTag;
  /** `data-key`: names the object (unique in the layer). */
  key: string;
  /** `data-label`: the integer label of a label layer's outline. */
  label?: string;
  /** Geometry and presentation attributes only, every value validated. */
  attrs: Record<string, string>;
}
export interface SanitizedLayerSvg {
  /** From the root's `viewBox` (else its width / height): the image size in pixels. */
  width: number;
  height: number;
  /** Presentation attributes of the root `<svg>` and the layer's `<g>`: the shapes' defaults. */
  groupAttrs: Record<string, string>;
  shapes: LayerShape[];
}

const SHAPE_TAGS = new Set<string>(["path", "polyline", "polygon", "line", "circle", "ellipse", "rect"]);
const FORBIDDEN_TAGS = new Set(["script", "style", "image", "use", "foreignobject"]);
/** Geometry each shape needs; a shape missing one is dropped. Order = emission order. */
const GEOMETRY: Record<LayerShapeTag, string[]> = {
  path: ["d"], polyline: ["points"], polygon: ["points"], line: ["x1", "y1", "x2", "y2"],
  circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"], rect: ["x", "y", "width", "height"],
};
/** Optional geometry (defaults are SVG's). */
const GEOMETRY_OPTIONAL: Partial<Record<LayerShapeTag, string[]>> = { rect: ["rx", "ry"] };
const PRESENTATION = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity"] as const;

const NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
const NUMBER_RE = new RegExp(`^\\s*${NUM}\\s*$`);
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
const POINTS_RE = /^[0-9eE.,+\-\s]*$/;
const PAINT_RE = /^(?:none|#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|[a-zA-Z]{3,30}|rgba?\(\s*[\d.]+%?(?:\s*[,\s]\s*[\d.]+%?){2}(?:\s*[,/]\s*[\d.]+%?)?\s*\))$/;
const DASH_RE = /^(?:none|[\d.eE+]+(?:[\s,]+[\d.eE+]+)*)$/;
const ENUMS: Record<string, Set<string>> = {
  "fill-rule": new Set(["nonzero", "evenodd"]),
  "stroke-linecap": new Set(["butt", "round", "square"]),
  "stroke-linejoin": new Set(["miter", "round", "bevel", "miter-clip", "arcs"]),
};

function validGeometry(name: string, v: string): boolean {
  if (name === "d") return PATH_RE.test(v);
  if (name === "points") return POINTS_RE.test(v);
  return NUMBER_RE.test(v);
}
function validPresentation(name: string, v: string): boolean {
  if (name === "fill" || name === "stroke") return PAINT_RE.test(v);
  if (name === "stroke-dasharray") return DASH_RE.test(v);
  if (ENUMS[name]) return ENUMS[name].has(v);
  return NUMBER_RE.test(v) && Number(v) >= 0; // opacities and stroke-width
}

class LayerSvgError extends Error {
  constructor(what: string) { super(`fluximg layer SVG: ${what} is not allowed`); this.name = "LayerSvgError"; }
}

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(v: string): string {
  return v.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);/g, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return PREDEFINED[e];
  });
}

const OPEN_RE = /<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const CLOSE_RE = /<\/\s*([A-Za-z_][\w:.-]*)\s*>/y;
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const localName = (n: string): string => { const i = n.indexOf(":"); return (i >= 0 ? n.slice(i + 1) : n).toLowerCase(); };

function parseAttrs(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1], value = decodeEntities(m[2] ?? m[3] ?? "");
    const ln = localName(name);
    if (ln.startsWith("on")) throw new LayerSvgError(`an event-handler attribute (${name})`);
    if (ln === "href") throw new LayerSvgError(`an href (${name})`);
    if (/url\s*\(/i.test(value)) throw new LayerSvgError("url(…)");
    out.push([name, value]);
  }
  return out;
}

function presentationOf(attrs: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v0] of attrs) {
    const v = v0.trim();
    if ((PRESENTATION as readonly string[]).includes(k) && validPresentation(k, v)) out[k] = v;
  }
  return out;
}

interface Parsed extends SanitizedLayerSvg {
  /** Per shape: its geometry's bounding box in image pixels (null = no geometry to speak of). */
  boxes: Array<Box | null>;
}
interface Box { x0: number; y0: number; x1: number; y1: number }

function parseLayerSvg(svgText: string): Parsed {
  const text = String(svgText);
  if (/<!\[CDATA\[/.test(text)) throw new LayerSvgError("CDATA");
  if (/<!(?!--)/.test(text)) throw new LayerSvgError("a DOCTYPE or entity declaration");
  // Only the five predefined entities and numeric references; anything else is an entity that needs a DTD.
  const named = /&([A-Za-z][\w.-]*);/g;
  for (const m of text.matchAll(named)) if (!(m[1] in PREDEFINED)) throw new LayerSvgError(`the entity &${m[1]};`);
  if (/&(?!(?:[A-Za-z][\w.-]*|#\d+|#x[0-9a-fA-F]+);)/.test(text)) throw new LayerSvgError("a bare '&'");

  type Entry = { name: string; kind: "svg" | "g" | "shape" | "skip"; inherited: Record<string, string> };
  const stack: Entry[] = [];
  let width = 0, height = 0, sawRoot = false, groupAttrs: Record<string, string> | null = null;
  const shapes: LayerShape[] = [];
  const usedKeys = new Set<string>();
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) throw new Error("fluximg layer SVG: an unterminated comment");
      i = end + 3; continue;
    }
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) throw new Error("fluximg layer SVG: an unterminated processing instruction");
      i = end + 2; continue;
    }
    if (text.startsWith("</", i)) {
      CLOSE_RE.lastIndex = i;
      const m = CLOSE_RE.exec(text);
      if (!m) throw new Error(`fluximg layer SVG: a malformed closing tag at ${i}`);
      const top = stack.pop();
      if (!top || top.name !== m[1]) throw new Error(`fluximg layer SVG: </${m[1]}> does not close <${top?.name ?? "nothing"}>`);
      i = CLOSE_RE.lastIndex; continue;
    }
    OPEN_RE.lastIndex = i;
    const m = OPEN_RE.exec(text);
    if (!m) throw new Error(`fluximg layer SVG: a malformed tag at ${i}`);
    i = OPEN_RE.lastIndex;
    const name = m[1], ln = localName(name), selfClosing = m[3] === "/";
    if (FORBIDDEN_TAGS.has(ln)) throw new LayerSvgError(`<${name}>`);
    const attrs = parseAttrs(m[2]); // throws on handlers / href / url() even inside dropped subtrees
    const parent = stack[stack.length - 1];
    let entry: Entry;
    if (!sawRoot) {
      if (ln !== "svg") throw new Error("fluximg layer SVG: the root element must be <svg>");
      sawRoot = true;
      const a = Object.fromEntries(attrs);
      const vb = (a.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb.every(Number.isFinite)) { width = vb[2]; height = vb[3]; }
      else { width = Number(a.width) || 0; height = Number(a.height) || 0; }
      entry = { name, kind: "svg", inherited: presentationOf(attrs) };
    } else if (!parent || parent.kind === "skip" || parent.kind === "shape") {
      // Inside something we do not draw (a shape's <title>, <defs>, <clipPath>, …): parse, check, drop.
      entry = { name, kind: "skip", inherited: {} };
    } else if (ln === "g") {
      const inherited = { ...parent.inherited, ...presentationOf(attrs) };
      if (!groupAttrs) groupAttrs = inherited;
      entry = { name, kind: "g", inherited };
    } else if (SHAPE_TAGS.has(ln)) {
      entry = { name, kind: "shape", inherited: {} };
      const shape = buildShape(ln as LayerShapeTag, attrs, parent.inherited, groupAttrs ?? parent.inherited, shapes.length, usedKeys);
      if (shape) shapes.push(shape);
    } else {
      entry = { name, kind: "skip", inherited: {} };
    }
    if (!selfClosing) stack.push(entry);
  }
  if (!sawRoot) throw new Error("fluximg layer SVG: no <svg> element");
  if (stack.length) throw new Error(`fluximg layer SVG: <${stack[stack.length - 1].name}> is never closed`);
  // A layer whose shapes sit directly in <svg> has no group: its root's presentation is the default.
  const ga = groupAttrs ?? {};
  return { width, height, groupAttrs: ga, shapes, boxes: shapes.map(shapeBox) };
}

function buildShape(tag: LayerShapeTag, attrs: Array<[string, string]>, inherited: Record<string, string>, groupAttrs: Record<string, string>, ordinal: number, used: Set<string>): LayerShape | null {
  const a = new Map(attrs);
  const out: Record<string, string> = {};
  for (const g of GEOMETRY[tag]) {
    const v = a.get(g);
    if (v === undefined || !validGeometry(g, v)) return null; // half a shape is not a shape
    out[g] = v.trim().replace(/\s+/g, " ");
  }
  for (const g of GEOMETRY_OPTIONAL[tag] ?? []) {
    const v = a.get(g);
    if (v !== undefined && validGeometry(g, v)) out[g] = v.trim();
  }
  // Presentation inherited from groups nested below the layer's own <g> is folded into the shape.
  const own = presentationOf(attrs);
  for (const k of PRESENTATION) {
    const v = own[k] ?? (inherited[k] !== groupAttrs[k] ? inherited[k] : undefined);
    if (v !== undefined) out[k] = v;
  }
  let key = a.get("data-key") ?? `#${ordinal}`;
  if (used.has(key)) { let k = 2; while (used.has(`${key}~${k}`)) k++; key = `${key}~${k}`; }
  used.add(key);
  const label = a.get("data-label");
  return { tag, key, ...(label !== undefined ? { label } : {}), attrs: out };
}

// A tiny cache: the same layer text is placed again on every view change (crop, contrast, …). Map lookups by
// the same string object reuse its cached hash, so a hit costs nothing next to re-parsing thousands of outlines.
const CACHE_MAX = 16;
const cache = new Map<string, Parsed>();
function parsed(svgText: string): Parsed {
  const hit = cache.get(svgText);
  if (hit) { cache.delete(svgText); cache.set(svgText, hit); return hit; }
  const p = parseLayerSvg(svgText);
  cache.set(svgText, p);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return p;
}

/**
 * Parse a layer SVG against the allow-list. Keeps `path`, `polyline`, `polygon`, `line`, `circle`, `ellipse`,
 * `rect` with their geometry, presentation attributes and `data-key` / `data-label`; drops everything else;
 * THROWS on a forbidden construct (script, style, image, use, foreignObject, event handlers, href, url(…),
 * entities / DOCTYPE, CDATA) or on markup that is not well-formed.
 */
export function sanitizeLayerSvg(svgText: string): SanitizedLayerSvg {
  const p = parsed(svgText);
  return {
    width: p.width, height: p.height, groupAttrs: { ...p.groupAttrs },
    shapes: p.shapes.map((s) => ({ tag: s.tag, key: s.key, ...(s.label !== undefined ? { label: s.label } : {}), attrs: { ...s.attrs } })),
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry: bounding boxes
// ---------------------------------------------------------------------------------------------

const NUM_G = new RegExp(NUM, "g");
const nums = (s: string): number[] => (s.match(NUM_G) ?? []).map(Number);

/** Bounding box of path data. M/L/H/V/Z (absolute and relative) are exact; for curves and arcs the control
 *  and end points are included (a superset of the curve's box: good enough for an index and for culling). */
function pathBox(d: string): Box | null {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number): void => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  let cx = 0, cy = 0, sx = 0, sy = 0, cmd = "", k = 0;
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  while (k < toks.length) {
    const t = toks[k];
    if (/[A-Za-z]/.test(t)) { cmd = t; k++; if (cmd === "Z" || cmd === "z") { cx = sx; cy = sy; } continue; }
    if (!cmd) return null;
    const lower = cmd.toLowerCase(), rel = cmd !== cmd.toUpperCase(), need = arity[lower];
    if (!need || k + need > toks.length) break;
    const v = toks.slice(k, k + need).map(Number);
    k += need;
    if (lower === "h") { cx = rel ? cx + v[0] : v[0]; add(cx, cy); continue; }
    if (lower === "v") { cy = rel ? cy + v[0] : v[0]; add(cx, cy); continue; }
    if (lower === "a") { const ex = rel ? cx + v[5] : v[5], ey = rel ? cy + v[6] : v[6]; add(ex, ey); cx = ex; cy = ey; continue; }
    // m, l, t take one point; c, s, q list control points and end with the new current point.
    for (let p = 0; p < need; p += 2) add(rel ? cx + v[p] : v[p], rel ? cy + v[p + 1] : v[p + 1]);
    const ex = rel ? cx + v[need - 2] : v[need - 2], ey = rel ? cy + v[need - 1] : v[need - 1];
    cx = ex; cy = ey;
    if (lower === "m") { sx = cx; sy = cy; cmd = rel ? "l" : "L"; } // implicit lineto after a moveto
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

function shapeBox(s: LayerShape): Box | null {
  const a = s.attrs, f = (k: string, d = 0): number => (a[k] !== undefined ? Number(a[k]) : d);
  switch (s.tag) {
    case "path": return pathBox(a.d);
    case "polyline": case "polygon": {
      const v = nums(a.points);
      if (v.length < 2) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < v.length; i += 2) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]); }
      return { x0, y0, x1, y1 };
    }
    case "line": return { x0: Math.min(f("x1"), f("x2")), y0: Math.min(f("y1"), f("y2")), x1: Math.max(f("x1"), f("x2")), y1: Math.max(f("y1"), f("y2")) };
    case "circle": { const r = Math.abs(f("r")); return { x0: f("cx") - r, y0: f("cy") - r, x1: f("cx") + r, y1: f("cy") + r }; }
    case "ellipse": { const rx = Math.abs(f("rx")), ry = Math.abs(f("ry")); return { x0: f("cx") - rx, y0: f("cy") - ry, x1: f("cx") + rx, y1: f("cy") + ry }; }
    case "rect": { const w = Math.abs(f("width")), h = Math.abs(f("height")); return { x0: f("x"), y0: f("y"), x1: f("x") + w, y1: f("y") + h }; }
  }
}

export interface LayerObject { key: string; x: number; y: number; width: number; height: number; cx: number; cy: number }

/** Every shape's key, bounding box and centre (the box's centre) in IMAGE pixels, from its geometry. */
export function objectIndex(svgText: string): LayerObject[] {
  const p = parsed(svgText);
  const out: LayerObject[] = [];
  p.shapes.forEach((s, i) => {
    const b = p.boxes[i];
    if (!b) return;
    out.push({ key: s.key, x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

/** Image pixels → box: x' = x * sx + tx. Scales differ slightly when the crop's aspect is not the box's. */
export function cropTransform(crop: PixelRect, box: { width: number; height: number }): { sx: number; sy: number; tx: number; ty: number } {
  const sx = box.width / crop.width, sy = box.height / crop.height;
  return { sx, sy, tx: -crop.x * sx, ty: -crop.y * sy };
}

/** A stroke `screenPx` wide, in image units under this scale. With unequal scales the geometric mean is used
 *  (they differ by a fraction of a pixel in practice). Explicit width, never `vector-effect` (resvg ignores it). */
export function imageStrokeWidth(screenPx: number, sx: number, sy: number): number {
  return screenPx / Math.sqrt(sx * sy);
}

const ORDER = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity"];
const attrText = (o: Record<string, string>, keys: readonly string[]): string => keys.filter((k) => o[k] !== undefined).map((k) => ` ${k}="${escapeXml(o[k])}"`).join("");

/**
 * One `<g>` placing a vector or label layer's shapes in the element's box for this crop, styled by the resolved
 * view: `lv.color` (when set) replaces every stroke and tints every fill that is not `none`; `lv.fillOpacity`
 * replaces the file's fill opacity; `lv.opacity` is the group's; `lv.strokeWidth` is in SCREEN px. Shapes keep
 * their true image-space size. Shapes wholly outside the crop are left out: cheaper, and resvg aborts on a
 * layered node (opacity < 1) lying far outside its canvas (guide §9). "" when there is nothing to draw.
 */
export function layerMarkup(layer: FluximgLayer, svgText: string, lv: ResolvedLayer, crop: PixelRect, box: { width: number; height: number }, idPrefix: string): string {
  if (!lv.visible || layer.kind === "intensity" || !(lv.opacity > 0)) return "";
  if (!(crop.width > 0 && crop.height > 0 && box.width > 0 && box.height > 0)) return "";
  const p = parsed(svgText);
  const { sx, sy, tx, ty } = cropTransform(crop, box);
  const sw = imageStrokeWidth(Math.max(0, lv.strokeWidth), sx, sy);
  // Cull against the crop, widened by the stroke so an edge that only pokes in still draws.
  const m = sw / 2 + 1e-9, cx0 = crop.x - m, cy0 = crop.y - m, cx1 = crop.x + crop.width + m, cy1 = crop.y + crop.height + m;
  const color = lv.color;
  const recolor = (v: string | undefined): string | undefined => (color && v !== undefined && v !== "none" ? color : v);
  const shapes: string[] = [];
  p.shapes.forEach((s, i) => {
    const b = p.boxes[i];
    if (!b || b.x1 < cx0 || b.x0 > cx1 || b.y1 < cy0 || b.y0 > cy1) return;
    const own: Record<string, string> = { ...s.attrs };
    delete own["stroke-width"]; delete own["fill-opacity"]; // the resolved view owns these
    if (color) { own.stroke = recolor(own.stroke)!; own.fill = recolor(own.fill)!; }
    const geo = [...GEOMETRY[s.tag], ...(GEOMETRY_OPTIONAL[s.tag] ?? [])];
    shapes.push(`<${s.tag} id="${escapeXml(`${idPrefix}${layer.id}/${s.key}`)}" data-key="${escapeXml(s.key)}"${s.label !== undefined ? ` data-label="${escapeXml(s.label)}"` : ""}${attrText(own, geo)}${attrText(own, ORDER)}/>`);
  });
  if (!shapes.length) return "";
  const g: Record<string, string> = { ...p.groupAttrs };
  delete g.opacity;
  if (color) { g.stroke = color; if (g.fill !== undefined && g.fill !== "none") g.fill = color; }
  else if (g.stroke === undefined) g.stroke = layer.color ?? "#ffffff";
  // SVG's default fill is black: a layer that never says otherwise is outlines only.
  if (g.fill === undefined) g.fill = "none";
  g["fill-opacity"] = svgNum(Math.min(1, Math.max(0, lv.fillOpacity)));
  if (lv.opacity < 1) g.opacity = svgNum(lv.opacity);
  // Full precision here: a 4-decimal scale would drift by pixels across a large image.
  const transform = `matrix(${preciseNum(sx)} 0 0 ${preciseNum(sy)} ${preciseNum(tx)} ${preciseNum(ty)})`;
  // stroke-width keeps full precision too (4 decimals would round a 0.0012-unit stroke on a big zoom-out).
  g["stroke-width"] = preciseNum(sw);
  return `<g id="${escapeXml(`${idPrefix}layer.${layer.id}`)}" data-layer="${escapeXml(layer.id)}" transform="${transform}"${attrText(g, ORDER)}>${shapes.join("")}</g>`;
}

// ---------------------------------------------------------------------------------------------
// Object names
// ---------------------------------------------------------------------------------------------

/** The font Flux's figure text defaults to (store.ts `drawStyle`: Arial, 400). */
export const FURNITURE_FONT = "Arial";
export const FURNITURE_WEIGHT = 400;
/** Points → canvas px. */
export const PT = 4 / 3;
/** Above this many objects in view, names would be noise: none are drawn. */
export const MAX_NAMES = 200;

export interface NamesOptions {
  /** The layer the objects belong to (ids are `${idPrefix}name.${layerId}/${key}`). */
  layerId: string;
  /** Points. */
  fontSize: number;
  color: string;
  /**
   * The element is mirrored: its shapes are drawn mirrored by the element's own transform, and the names sit in a
   * group that undoes the mirror (so the words read normally). Positions are therefore mirrored HERE.
   */
  flipX?: boolean;
  flipY?: boolean;
}

/**
 * Small labels beside the objects whose centre lies inside the crop: anchored up-right of the object's box,
 * clamped inside the element box. The text is the object's key. No text measurement (twin-engine rule): an
 * estimated width (0.55 em per character) only decides whether a label near the right edge flips to end-anchored.
 * `table` is accepted for a later "name column" choice and is not read yet. "" above MAX_NAMES objects.
 */
export function namesMarkup(index: readonly LayerObject[], table: FluximgTable | null | undefined, crop: PixelRect, box: { width: number; height: number }, opts: NamesOptions, idPrefix: string): string {
  void table;
  const placed = namePlacements(index, crop, box, opts);
  if (!placed) return "";
  const texts = placed.map((n) => `<text id="${escapeXml(`${idPrefix}name.${opts.layerId}/${n.key}`)}" data-key="${escapeXml(n.key)}" x="${svgNum(n.x)}" y="${svgNum(n.y)}" text-anchor="${n.anchor}">${escapeXml(n.key)}</text>`);
  return `<g id="${escapeXml(`${idPrefix}names.${opts.layerId}`)}" data-part="names" fill="${escapeXml(opts.color)}" font-family="${FURNITURE_FONT}" font-weight="${FURNITURE_WEIGHT}" font-size="${svgNum(namesFontPx(opts.fontSize))}">${texts.join("")}</g>`;
}

/** The names' font size in canvas px for a size in points. */
export const namesFontPx = (fontSize: number): number => fontSize * PT;

/** Where each name of `namesMarkup` goes (box px, before rounding), or null when none are drawn. The slide player
 *  moves its name nodes by these when a Change zooms, instead of rebuilding them. */
export function namePlacements(index: readonly LayerObject[], crop: PixelRect, box: { width: number; height: number }, opts: Pick<NamesOptions, "fontSize" | "flipX" | "flipY">): Array<{ key: string; x: number; y: number; anchor: "start" | "end" }> | null {
  if (!(crop.width > 0 && crop.height > 0)) return null;
  const inView = index.filter((o) => o.cx >= crop.x && o.cx < crop.x + crop.width && o.cy >= crop.y && o.cy < crop.y + crop.height);
  if (!inView.length || inView.length > MAX_NAMES) return null;
  const { sx, sy, tx, ty } = cropTransform(crop, box);
  const fs = namesFontPx(opts.fontSize), gap = Math.max(1, fs * 0.25), edge = 1;
  return inView.map((o) => {
    // The object's box on screen; a mirrored element shows it mirrored about the box centre.
    const l0 = o.x * sx + tx, r0 = (o.x + o.width) * sx + tx, t0 = o.y * sy + ty, b0 = (o.y + o.height) * sy + ty;
    const right = opts.flipX ? box.width - l0 : r0, top = opts.flipY ? box.height - b0 : t0;
    let x = Math.min(box.width - edge, Math.max(edge, right + gap));
    let anchor: "start" | "end" = "start";
    if (x + 0.55 * fs * o.key.length > box.width - edge) { anchor = "end"; x = box.width - edge; }
    const y = Math.min(box.height - edge - 0.21 * fs, Math.max(edge + 0.72 * fs, top - gap));
    return { key: o.key, x, y, anchor };
  });
}
