/**
 * The OBJECTS of an image as slide parts (stage 2, plan D9): THE LAW (pure: no DOM globals, no Node, no Svelte).
 *
 *   part ids    `layer:<layerId>` names a whole label or vector layer: a CONTAINER that resolves to its objects, in the
 *               layer's own order (as a plot group resolves to its leaves); `<layerId>/<key>` names one object, `key`
 *               being its `data-key` (the text of the layer table's key column). Layer ids are `[a-z][a-z0-9_]*`, so the
 *               first "/" splits. Intensity layers and channels are not parts.
 *   the index   `fluximgPartIndex(manifest, layerTexts)`: per label / vector layer its objects (key, part id, centre, box
 *               and outline geometry in level-0 image pixels), from the sanitised layer SVG (`layers.objectIndex` and
 *               the sanitiser's shapes: one parse, cached by text). A layer whose text is not loaded is listed with
 *               `loaded: false` and no objects. Built once per (manifest, texts), never per frame.
 *   lookup      the compiler, player and authoring reach an image's index the way they reach plot and model manifests:
 *               `CompileOptions.fluximgParts`, else the provider the window registers (`registerFluximgParts`), else
 *               none. A part-bound track on an image with no index is a compile ISSUE ("the image's objects are not
 *               loaded"), never a crash and never silently the whole element.
 *   nodes       every host draws an object as a shape with `data-key` under a group with `data-layer`
 *               (`layers.layerMarkup`): the editor element, the live board, the slide player's overlay and every export.
 *               `fluximgPartNode` finds a part's node by those attributes, never by a host's id prefix.
 *   keys        `keyText` / `sameKey`: trimmed, case-insensitive text; a number written as text equals that number
 *               ("3", "3.0", " 03 " all equal 3). The Become pair policy "key" uses it (an object's key against a plot
 *               series' name or id, or against another layer's object keys).
 */
import type { FluximgLayer, FluximgManifest, FluximgTable } from "./types";
import type { PixelRect } from "./view";
import { objectIndex, sanitizeLayerSvg, type LayerShapeTag } from "./layers";
import { layerSvgPath } from "./static";
import { clampCrop } from "./crop";
import { compareCells, type Cell } from "./objectStyle";

export const FLUXIMG_PARTS_SPEC = "fluximg/parts";
export const LAYER_PART_PREFIX = "layer:";

export interface FluximgPartObject {
  key: string;
  /** `<layerId>/<key>` */
  partId: string;
  /** Centre and box of the shape's geometry, level-0 image pixels. */
  cx: number;
  cy: number;
  box: { x: number; y: number; width: number; height: number };
  /** The shape's outline as path data in image pixels (every tag converted), for Become flights. */
  d: string;
  /** The outline is a closed ring (a label footprint, a polygon, a circle) rather than an open line. */
  closed: boolean;
  tag: LayerShapeTag;
  /** The shape's own paint in the file (absent: the layer group's). */
  stroke?: string;
  fill?: string;
  opacity?: number;
}
export interface FluximgPartLayer {
  id: string;
  name: string;
  kind: "labels" | "vector";
  /** The table column whose text is each object's key (null: the shapes' own data-key). */
  key: string | null;
  /** The layer's table file in the bundle, when it has one. */
  table: string | null;
  /** False while the layer's SVG text is not loaded: its objects are unknown. */
  loaded: boolean;
  /** The layer group's paint in the file (what a shape that says nothing inherits). */
  groupStroke?: string;
  groupFill?: string;
  objects: FluximgPartObject[];
}
export interface FluximgPartIndex {
  spec: typeof FLUXIMG_PARTS_SPEC;
  /** The manifest this index was built from (in memory only: geometry needs its size and resolved layers). */
  manifest: FluximgManifest;
  layers: FluximgPartLayer[];
}

export function isFluximgPartIndex(m: unknown): m is FluximgPartIndex {
  return !!m && (m as { spec?: unknown }).spec === FLUXIMG_PARTS_SPEC;
}

/** `layer:<id>` → { layer }, `<layer>/<key>` → { layer, key }; null for anything else. */
export function parseFluximgPartId(id: string): { layer: string; key?: string } | null {
  if (id.startsWith(LAYER_PART_PREFIX)) { const layer = id.slice(LAYER_PART_PREFIX.length); return layer ? { layer } : null; }
  const i = id.indexOf("/");
  if (i <= 0 || i === id.length - 1) return null;
  return { layer: id.slice(0, i), key: id.slice(i + 1) };
}
export const objectPartId = (layerId: string, key: string): string => `${layerId}/${key}`;
export const layerPartId = (layerId: string): string => `${LAYER_PART_PREFIX}${layerId}`;

// --- geometry of a shape as path data ------------------------------------------------------------------------

const n = (v: string | undefined, d = 0): number => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const NUMS = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
/** A sanitised shape as path data (image pixels) and whether it is a closed ring. */
export function shapePath(tag: LayerShapeTag, a: Record<string, string>): { d: string; closed: boolean } {
  switch (tag) {
    case "path": return { d: a.d ?? "", closed: /z\s*$/i.test((a.d ?? "").trim()) };
    case "polyline": case "polygon": {
      const v = (a.points?.match(NUMS) ?? []).map(Number), pts: string[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push(`${i ? "L" : "M"}${v[i]} ${v[i + 1]}`);
      return { d: pts.join(" ") + (tag === "polygon" && pts.length ? " Z" : ""), closed: tag === "polygon" };
    }
    case "line": return { d: `M${n(a.x1)} ${n(a.y1)} L${n(a.x2)} ${n(a.y2)}`, closed: false };
    case "rect": { const x = n(a.x), y = n(a.y), w = Math.abs(n(a.width)), h = Math.abs(n(a.height)); return { d: `M${x} ${y} H${x + w} V${y + h} H${x} Z`, closed: true }; }
    case "circle": case "ellipse": {
      const cx = n(a.cx), cy = n(a.cy), rx = Math.abs(n(tag === "circle" ? a.r : a.rx)), ry = Math.abs(n(tag === "circle" ? a.r : a.ry));
      // Four quarter arcs (C) approximate the ellipse to 0.03 %: the outline machinery reads C, not A, best.
      const k = 0.5522847498, ox = rx * k, oy = ry * k;
      return { d: `M${cx + rx} ${cy} C${cx + rx} ${cy + oy} ${cx + ox} ${cy + ry} ${cx} ${cy + ry} C${cx - ox} ${cy + ry} ${cx - rx} ${cy + oy} ${cx - rx} ${cy} C${cx - rx} ${cy - oy} ${cx - ox} ${cy - ry} ${cx} ${cy - ry} C${cx + ox} ${cy - ry} ${cx + rx} ${cy - oy} ${cx + rx} ${cy} Z`, closed: true };
    }
  }
}

// --- the index -------------------------------------------------------------------------------------------------

/** The object layers of an image (label and vector layers, manifest order). */
export const objectLayers = (manifest: FluximgManifest): Array<Exclude<FluximgLayer, { kind: "intensity" }>> =>
  manifest.layers.filter((l): l is Exclude<FluximgLayer, { kind: "intensity" }> => l.kind === "labels" || l.kind === "vector");

/** Counts for gates: how many indexes were built (pins "once per image when first needed, never per frame"). */
export const partIndexWork = { builds: 0 };

/**
 * Every object of every label / vector layer, in each layer's own (file) order, from the layer SVG texts (by layer
 * id; a missing text = a layer not loaded yet). A text the sanitiser refuses gives that layer no objects.
 */
export function fluximgPartIndex(manifest: FluximgManifest, layerTexts: Readonly<Record<string, string | undefined>>): FluximgPartIndex {
  partIndexWork.builds++;
  const layers: FluximgPartLayer[] = [];
  for (const layer of objectLayers(manifest)) {
    const text = layerTexts[layer.id];
    const entry: FluximgPartLayer = { id: layer.id, name: layer.name || layer.id, kind: layer.kind, key: layer.key ?? null, table: layer.table ?? null, loaded: text !== undefined, objects: [] };
    if (text !== undefined) {
      try {
        const sane = sanitizeLayerSvg(text), shapes = sane.shapes, boxes = new Map(objectIndex(text).map((o) => [o.key, o]));
        if (sane.groupAttrs.stroke !== undefined) entry.groupStroke = sane.groupAttrs.stroke;
        if (sane.groupAttrs.fill !== undefined) entry.groupFill = sane.groupAttrs.fill;
        for (const s of shapes) {
          const b = boxes.get(s.key);
          if (!b) continue; // no geometry to speak of: nothing to animate or outline
          const { d, closed } = shapePath(s.tag, s.attrs);
          const op = s.attrs.opacity !== undefined ? Number(s.attrs.opacity) : undefined;
          entry.objects.push({ key: s.key, partId: objectPartId(layer.id, s.key), cx: b.cx, cy: b.cy, box: { x: b.x, y: b.y, width: b.width, height: b.height }, d, closed, tag: s.tag,
            ...(s.attrs.stroke !== undefined ? { stroke: s.attrs.stroke } : {}), ...(s.attrs.fill !== undefined ? { fill: s.attrs.fill } : {}), ...(op !== undefined && Number.isFinite(op) ? { opacity: op } : {}) });
        }
      } catch { /* refused by the sanitiser: drawn nowhere, so no parts */ }
    }
    layers.push(entry);
  }
  return { spec: FLUXIMG_PARTS_SPEC, manifest, layers };
}

const built = new WeakMap<FluximgManifest, { texts: Array<string | undefined>; index: FluximgPartIndex }>();
/**
 * The index of an image from a layer-text lookup by bundle path (`SlideRenderCtx.fluximgLayerText`, the stores): one
 * build per (manifest object, texts); a later call with the same texts returns the same object. Asking for a text may
 * start loading it (the hosts' lookups do).
 */
export function partIndexFromTexts(manifest: FluximgManifest, layerText: (path: string) => string | undefined): FluximgPartIndex {
  const layers = objectLayers(manifest);
  const texts = layers.map((l) => { const p = layerSvgPath(l); return p ? layerText(p) : undefined; });
  const hit = built.get(manifest);
  if (hit && hit.texts.length === texts.length && hit.texts.every((t, i) => t === texts[i])) return hit.index;
  const index = fluximgPartIndex(manifest, Object.fromEntries(layers.map((l, i) => [l.id, texts[i]])));
  built.set(manifest, { texts, index });
  return index;
}

// --- the provider the window registers ---------------------------------------------------------------------------

export type FluximgPartsLookup = (assetId: string) => FluximgPartIndex | undefined;
export type FluximgTableLookup = (assetId: string, path: string) => FluximgTable | null | undefined;
let provider: FluximgPartsLookup | null = null, tableProvider: FluximgTableLookup | null = null;
/** The window's (or a host's) default index and table lookups, used by every compile that names none. One per process. */
export function registerFluximgParts(lookup: FluximgPartsLookup | null, tables: FluximgTableLookup | null = null): void { provider = lookup; tableProvider = tables; }
/** `explicit` when given, else the registered table lookup. */
export function fluximgTableLookup(explicit?: FluximgTableLookup): FluximgTableLookup | undefined { return explicit ?? tableProvider ?? undefined; }
/** `explicit` when given, else the registered provider. */
export function fluximgPartsLookup(explicit?: FluximgPartsLookup): FluximgPartsLookup | undefined {
  return explicit ?? provider ?? undefined;
}

// --- binding resolution ------------------------------------------------------------------------------------------

interface Binding { part?: string; parts?: string[]; selector?: { role?: string; series?: string; index?: number | number[]; except?: string[] } }
const bindingIds = (b: Binding): string[] => [...new Set([b.part, ...(b.parts ?? [])].filter((x): x is string => !!x))];

/** The object part ids one part id stands for: a layer → its objects in order, an object → itself (when it exists). */
export function fluximgLeavesOf(index: FluximgPartIndex | undefined, id: string): string[] {
  const p = parseFluximgPartId(id);
  if (!p || !index) return [];
  const layer = index.layers.find((l) => l.id === p.layer);
  if (!layer) return [];
  if (p.key === undefined) return layer.objects.map((o) => o.partId);
  return layer.objects.some((o) => o.key === p.key) ? [id] : [];
}

/**
 * The object part ids a track's binding resolves to: every `part`/`parts` id expanded (a layer → its objects in the
 * layer's order, an object → itself), then the selector's hits (`role: "object"`, `series` = a layer id, `index` = the
 * object's ordinal in its layer), minus `selector.except` (expanded likewise). Unknown ids resolve to nothing.
 */
export function fluximgPartTargets(binding: Binding, index: FluximgPartIndex | undefined): string[] {
  if (!index) return [];
  const out: string[] = [], seen = new Set<string>();
  const push = (id: string) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
  for (const id of bindingIds(binding)) for (const leaf of fluximgLeavesOf(index, id)) push(leaf);
  const sel = binding.selector;
  if (sel && (sel.role != null || sel.series != null || sel.index != null) && (sel.role == null || sel.role === "object")) {
    const want = sel.index == null ? null : new Set(Array.isArray(sel.index) ? sel.index : [sel.index]);
    for (const layer of index.layers) {
      if (sel.series != null && sel.series !== layer.id) continue;
      layer.objects.forEach((o, i) => { if (!want || want.has(i)) push(o.partId); });
    }
  }
  if (sel?.except?.length) {
    const drop = new Set(sel.except.flatMap((id) => fluximgLeavesOf(index, id)));
    return out.filter((id) => !drop.has(id));
  }
  return out;
}

/** Whether a binding names a layer of this image whose objects are not loaded yet (its parts cannot be resolved). */
export function fluximgPartsPending(binding: Binding, index: FluximgPartIndex | undefined): boolean {
  if (!index) return true;
  const layers = new Set<string>();
  for (const id of [...bindingIds(binding), ...(binding.selector?.except ?? [])]) { const p = parseFluximgPartId(id); if (p) layers.add(p.layer); }
  if (binding.selector?.series) layers.add(binding.selector.series);
  else if (binding.selector && (binding.selector.role === "object" || binding.selector.index != null)) for (const l of index.layers) layers.add(l.id);
  return index.layers.some((l) => layers.has(l.id) && !l.loaded);
}

/** One object of the index by part id. */
export function fluximgObject(index: FluximgPartIndex | undefined, partId: string): (FluximgPartObject & { layer: FluximgPartLayer }) | null {
  const p = parseFluximgPartId(partId);
  if (!p?.key || !index) return null;
  const layer = index.layers.find((l) => l.id === p.layer);
  const o = layer?.objects.find((x) => x.key === p.key);
  return o && layer ? { ...o, layer } : null;
}

// --- nodes -------------------------------------------------------------------------------------------------------

/** A CSS attribute-selector string value (no DOM `CSS.escape` in every engine). */
const cssString = (s: string): string => `"${s.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
interface QueryRoot { querySelector(selector: string): unknown; querySelectorAll(selector: string): ArrayLike<unknown> }

/**
 * THE node of an image part under `root` (the element's wrapper in any host: the editor element at rest, the live
 * board, the slide player's overlay, an exported page): an object is the shape with its `data-key` directly under the
 * group whose `data-layer` is its layer; a layer is that group. Null when it is not drawn (a hidden layer, an object
 * outside the crop in a host that culls). The image twin of `plot/parse.partDomId`.
 */
export function fluximgPartNode<T = Element>(root: QueryRoot | null | undefined, partId: string): T | null {
  const p = parseFluximgPartId(partId);
  if (!root || !p) return null;
  const group = `[data-layer=${cssString(p.layer)}]`;
  // a descendant, not a child: the player wraps an animated object in an effect group of its own (player.imageEffectNode)
  return (root.querySelector(p.key === undefined ? group : `${group} [data-key=${cssString(p.key)}]`) as T | null) ?? null;
}

/** Many parts at once: one walk of the image's layer groups instead of a query per object (a 2,000-object stagger). */
export function fluximgPartNodes<T = Element>(root: QueryRoot | null | undefined, partIds: readonly string[]): Array<T | null> {
  if (!root) return partIds.map(() => null);
  if (partIds.length <= 8) return partIds.map((id) => fluximgPartNode<T>(root, id));
  const byLayer = new Map<string, Map<string, T>>();
  for (const g of Array.from(root.querySelectorAll("[data-layer]")) as Array<{ getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null }> }>) {
    const id = g.getAttribute("data-layer");
    if (!id || byLayer.has(id)) continue;
    const keys = new Map<string, T>();
    for (const c of Array.from(g.querySelectorAll("[data-key]"))) { const k = c.getAttribute("data-key"); if (k !== null && !keys.has(k)) keys.set(k, c as unknown as T); }
    byLayer.set(id, keys);
  }
  return partIds.map((id) => {
    const p = parseFluximgPartId(id);
    return p?.key !== undefined ? byLayer.get(p.layer)?.get(p.key) ?? null : null;
  });
}

interface PartNodeLike { getAttribute?(n: string): string | null; parentElement?: PartNodeLike | null; firstElementChild?: PartNodeLike | null }
/** The part id of a drawn object node (its `data-key` and its layer group's `data-layer`), or of the player's effect
 *  wrapper around one; null for anything else. */
export function fluximgPartIdOf(node: PartNodeLike | null | undefined): string | null {
  const shape = node?.getAttribute?.("data-key") != null ? node : node?.getAttribute?.("data-sl-fx") ? node.firstElementChild : null;
  const key = shape?.getAttribute?.("data-key");
  let up = shape?.parentElement, layer: string | null | undefined = null;
  for (let i = 0; up && i < 3 && !layer; i++, up = up.parentElement) layer = up.getAttribute?.("data-layer");
  return key != null && layer ? objectPartId(layer, key) : null;
}

// --- placement in the element's box and on the stage ---------------------------------------------------------------

export type Matrix = readonly [number, number, number, number, number, number];
/** Image pixels → the element's box (`layers.cropTransform` as a matrix, for this crop). */
export function imageToBox(manifest: FluximgManifest, crop: PixelRect | null | undefined, box: { width: number; height: number }): Matrix {
  const c = clampCrop(manifest, crop);
  const sx = box.width / c.width, sy = box.height / c.height;
  return [sx, 0, 0, sy, -c.x * sx, -c.y * sy];
}
/**
 * Image pixels → STAGE (or canvas) px for an element: its crop and box (the matrix `layerMarkup` writes on the layer
 * group), then its position, then flips and rotation about its box centre (flips first, as the renderer applies them).
 */
export function imageToStage(manifest: FluximgManifest, el: { x: number; y: number; width: number; height: number; rotation?: number; flipX?: boolean; flipY?: boolean; crop?: PixelRect | null }): Matrix {
  const [a, , , d, e, f] = imageToBox(manifest, el.crop, el);
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  const ang = ((el.rotation ?? 0) * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
  const fx = el.flipX ? -1 : 1, fy = el.flipY ? -1 : 1;
  // p_box = (a x + e, d y + f); p_canvas = p_box + (el.x, el.y); then R·F about (cx, cy).
  // q = R·F·(p_canvas − C) + C
  const A = c * fx * a, B = s * fx * a, Cc = -s * fy * d, D = c * fy * d;
  const ux = e + el.x - cx, uy = f + el.y - cy;
  return [A, B, Cc, D, c * fx * ux - s * fy * uy + cx, s * fx * ux + c * fy * uy + cy];
}
export const applyMatrix = (m: Matrix, x: number, y: number): { x: number; y: number } => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

// --- keys --------------------------------------------------------------------------------------------------------

const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A key as it is compared: trimmed, lower-cased; a number written as text is its number ("03", "3.0" → "3"). */
export function keyText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (NUMBER_TEXT.test(s)) { const x = Number(s); if (Number.isFinite(x)) return String(x); }
  return s.toLowerCase();
}
export const sameKey = (a: unknown, b: unknown): boolean => { const x = keyText(a); return x !== null && x === keyText(b); };

/** Who a Become member is, for the "key" pair policy: an image object's key, or a plot series' id and name. */
export interface KeyedMember { keys: readonly string[] }
/** The keys an image object or a plot part answers to (normalised; empty = it pairs with nothing by key). */
export function memberKeys(owner: { key?: string; series?: string; seriesName?: string }): string[] {
  const out: string[] = [];
  for (const v of [owner.key, owner.series, owner.seriesName]) { const k = keyText(v); if (k !== null && !out.includes(k)) out.push(k); }
  return out;
}

/**
 * The pairing by key of two member lists: groups of (source indices, destination indices) sharing a key, in source
 * order, plus the members left unmatched. A member matches the FIRST key it shares with the other side. `pairs` counts
 * the matched keys (one footprint and one trace = 1 pair).
 */
export function keyGroups(A: readonly KeyedMember[], B: readonly KeyedMember[]): { groups: Array<{ key: string; a: number[]; b: number[] }>; unmatchedA: number[]; unmatchedB: number[]; pairs: number } {
  const bByKey = new Map<string, number[]>();
  B.forEach((m, j) => { for (const k of m.keys) { let l = bByKey.get(k); if (!l) bByKey.set(k, l = []); if (!l.includes(j)) l.push(j); } });
  const groups = new Map<string, { key: string; a: number[]; b: number[] }>(), usedB = new Set<number>(), unmatchedA: number[] = [];
  A.forEach((m, i) => {
    const k = m.keys.find((x) => bByKey.has(x));
    if (k === undefined) { unmatchedA.push(i); return; }
    let g = groups.get(k);
    if (!g) { g = { key: k, a: [], b: bByKey.get(k)!.filter((j) => !usedB.has(j)) }; for (const j of g.b) usedB.add(j); groups.set(k, g); }
    g.a.push(i);
  });
  const list = [...groups.values()].filter((g) => g.b.length);
  const leftA = [...groups.values()].filter((g) => !g.b.length).flatMap((g) => g.a);
  const unmatchedB = B.map((_, j) => j).filter((j) => !usedB.has(j));
  return { groups: list, unmatchedA: [...unmatchedA, ...leftA].sort((x, y) => x - y), unmatchedB, pairs: list.length };
}

/**
 * Whether "auto" pairs by key (plan D10): at least two keys match and more than half of the SMALLER side's members
 * are matched. Members are counted by distinct key on each side (a series drawn as a line and 40 points is one member).
 */
export function keyPolicyApplies(A: readonly KeyedMember[], B: readonly KeyedMember[]): boolean {
  const distinct = (side: readonly KeyedMember[]) => new Set(side.map((m) => m.keys.join("\u0000")).filter(Boolean));
  const a = distinct(A), b = distinct(B);
  if (!a.size || !b.size) return false;
  const { groups } = keyGroups(A, B);
  if (groups.length < 2) return false;
  const smaller = Math.min(a.size, b.size);
  return groups.length * 2 > smaller;
}

// --- stagger by a table column ------------------------------------------------------------------------------------

/**
 * Each object's rank coordinate under a table column, for `Stagger.by = { column: <name> }` on image objects: numbers
 * ascending, strings in natural order (`objectStyle.compareCells`: numbers, then strings, then booleans), each
 * distinct value one rank; a null value, an object without a row or a column the table lacks → null (after the
 * ranked ones, in their own order: `staggerRanks`). The row of an object is the first row whose key text is the
 * object's key (as `objectStyle` reads it).
 */
export function columnCoordinates(table: FluximgTable | null | undefined, layerKey: string | null | undefined, column: string, partIds: readonly string[]): Array<number | null> {
  const values = table?.columns?.[column];
  if (!table || !Array.isArray(values)) return partIds.map(() => null);
  const keyName = layerKey && Array.isArray(table.columns[layerKey]) ? layerKey : table.key;
  const keyCol = table.columns[keyName];
  if (!Array.isArray(keyCol)) return partIds.map(() => null);
  const byKey = new Map<string, Cell>();
  keyCol.forEach((k, r) => { if (k === null || k === undefined) return; const s = String(k); if (!byKey.has(s)) byKey.set(s, (values[r] ?? null) as Cell); });
  const cells = partIds.map((id) => { const p = parseFluximgPartId(id); const v = p?.key !== undefined ? byKey.get(p.key) : undefined; return v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v)) ? null : v; });
  const order = [...new Set(cells.filter((c): c is Exclude<Cell, null> => c !== null).map((c) => `${typeof c}:${String(c)}`))];
  const sample = new Map<string, Exclude<Cell, null>>();
  for (const c of cells) if (c !== null) sample.set(`${typeof c}:${String(c)}`, c);
  order.sort((x, y) => compareCells(sample.get(x)!, sample.get(y)!));
  const rank = new Map(order.map((k, i) => [k, i]));
  return cells.map((c) => (c === null ? null : rank.get(`${typeof c}:${String(c)}`)!));
}

/** The names a stagger row offers for an image's objects: its object layers' table columns (the key column and the
 *  integer `label` of a label layer are names, not orders). */
export function staggerColumns(table: FluximgTable | null | undefined, layer: { kind: string; key?: string | null } | null | undefined): string[] {
  if (!table?.columns) return [];
  const skip = new Set<string>([table.key, ...(layer?.key ? [layer.key] : []), ...(layer?.kind === "labels" ? ["label"] : [])]);
  return Object.keys(table.columns).filter((c) => !skip.has(c) && Array.isArray(table.columns[c]));
}

/**
 * The stagger coordinates of an image's objects (both engines call this: the compiler for `sample`, the player for its
 * delays): `{ column: <name> }` → `columnCoordinates` over that column of each object's layer table; "x" / "y" → the
 * objects' centres in image pixels; "radial" → the distance
 * from `origin` (image pixels; absent = the centre of the objects); anything else (or no index) → undefined (plain order).
 */
export function objectStaggerCoordinates(index: FluximgPartIndex | undefined, partIds: readonly string[],
  stagger: { by?: unknown; origin?: { x: number; y: number } } | undefined, tableFor: (layer: FluximgPartLayer) => FluximgTable | null | undefined): Array<number | null> | undefined {
  const by = stagger?.by;
  if (!index || !by || by === "index") return undefined;
  const objects = partIds.map((id) => fluximgObject(index, id));
  if (by === "x" || by === "y") return objects.map((o) => (o ? (by === "x" ? o.cx : o.cy) : null));
  if (by === "radial") {
    const known = objects.filter((o): o is NonNullable<typeof o> => !!o);
    const c = stagger?.origin ?? (known.length ? { x: known.reduce((a, o) => a + o.cx, 0) / known.length, y: known.reduce((a, o) => a + o.cy, 0) / known.length } : { x: 0, y: 0 });
    return objects.map((o) => (o ? Math.hypot(o.cx - c.x, o.cy - c.y) : null));
  }
  const column = typeof by === "object" && by && typeof (by as { column?: unknown }).column === "string" ? (by as { column: string }).column : null;
  if (!column) return undefined;
  // One column read per layer (a stagger may span the objects of several layers).
  const out: Array<number | null> = partIds.map(() => null);
  const byLayer = new Map<FluximgPartLayer, number[]>();
  objects.forEach((o, i) => { if (o) { const l = byLayer.get(o.layer); if (l) l.push(i); else byLayer.set(o.layer, [i]); } });
  for (const [layer, at] of byLayer) {
    const table = tableFor(layer);
    if (!Array.isArray(table?.columns?.[column])) {
      if (column === "index") for (const i of at) out[i] = layer.objects.findIndex((o) => o.partId === partIds[i]);
      continue;
    }
    columnCoordinates(table, layer.key, column, at.map((i) => partIds[i])).forEach((v, k) => { out[at[k]] = v; });
  }
  return out;
}
