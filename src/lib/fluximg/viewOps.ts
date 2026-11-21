/**
 * The view recipe, resolved and edited (pure: no DOM, no Node, no Svelte).
 *
 * A placed fluximg stores a SPARSE `FluximgView` (absent = default). `resolveView` fills every default in from
 * the manifest; renderers, furniture and the UI read only the result. `patchView` is the one way a view is
 * edited (ops.setFluximgView goes through it). `planeRequests` names the planes a resolved view needs,
 * `pixelKey` names its pixels (the still cache key), and `describePosition` / `describeProjection` are the
 * words a stamp and the UI use for "where along depth / time".
 */
import type { FluximgManifest, FluximgLayer } from "./types";
import type {
  FluximgChannelView, FluximgLayerView, FluximgProjection, FluximgProjectionMode, FluximgStyleBy, FluximgView, FurnitureCorner,
  PixelRect, ResolvedChannel, ResolvedFurniture, ResolvedLayer, ResolvedView,
} from "./view";
import { hexToRgb } from "./lut";

const SPATIAL = new Set(["c", "y", "x"]);
const MODES: readonly FluximgProjectionMode[] = ["max", "mean", "min", "sum", "std"];
const CORNERS: readonly FurnitureCorner[] = ["bottom-right", "bottom-left", "top-right", "top-left"];
const NORMS = ["linear", "log", "gamma"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isColor = (v: unknown): v is string => typeof v === "string" && hexToRgb(v) !== null;
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const validRange = (r: unknown): r is [number, number] => Array.isArray(r) && r.length === 2 && finite(r[0]) && finite(r[1]) && r[1] > r[0];

/** Dimensions a position applies to: every dimension but c, y, x, in stored order. */
export function positionDims(manifest: FluximgManifest): string[] {
  return manifest.pixels.dims.filter((d) => !SPATIAL.has(d));
}
const dimSize = (manifest: FluximgManifest, dim: string): number => {
  const i = manifest.pixels.dims.indexOf(dim);
  return i >= 0 ? manifest.pixels.shape[i] : 0;
};

/** A colour / lut pair where exactly one is set: an override's colour wins, then its lut, then the base's. */
function pickColor(
  ov: { color?: string | null; lut?: string | null } | undefined,
  base: { color?: string | null; lut?: string | null },
): { color: string | null; lut: string | null } {
  if (ov && isColor(ov.color)) return { color: ov.color, lut: null };
  if (ov && isName(ov.lut)) return { color: null, lut: ov.lut };
  if (isColor(base.color)) return { color: base.color, lut: null };
  if (isName(base.lut)) return { color: null, lut: base.lut };
  return { color: null, lut: null };
}

function resolveChannel(manifest: FluximgManifest, i: number, ov: FluximgChannelView | null | undefined): ResolvedChannel {
  const base = manifest.channels[i];
  const o = isObj(ov) ? (ov as FluximgChannelView) : undefined;
  let { color, lut } = pickColor(o, base);
  if (!color && !lut) lut = "gray";
  const range: [number, number] = validRange(o?.range) ? [o!.range![0], o!.range![1]]
    : validRange(base.range) ? [base.range[0], base.range[1]]
    : validRange([base.stats?.min, base.stats?.max]) ? [base.stats.min, base.stats.max] : [0, 1];
  return {
    index: i,
    name: base.name,
    // the manifest's `visible` (contract update 2) is only the default: an element's view still wins
    visible: typeof o?.visible === "boolean" ? o.visible : base.visible !== false,
    color, lut, range,
    norm: o?.norm && (NORMS as readonly string[]).includes(o.norm) ? o.norm : "linear",
    gamma: finite(o?.gamma) && o!.gamma! > 0 ? o!.gamma! : 1,
    invert: o?.invert === true,
  };
}

/**
 * The request to style objects by table columns, cleaned (lenient: a stored view from anywhere must still draw).
 * Only the request: whether its columns exist is known where the table is (`objectStyle.objectStyles`).
 */
export function resolveStyleBy(v: unknown): FluximgStyleBy | null {
  if (!isObj(v)) return null;
  const out: FluximgStyleBy = {};
  const c = v.color, o = v.opacity;
  if (isObj(c) && isName(c.column)) {
    const color: NonNullable<FluximgStyleBy["color"]> = { column: c.column };
    if (isName(c.lut)) color.lut = c.lut;
    if (Array.isArray(c.palette)) { const pal = c.palette.filter(isColor); if (pal.length) color.palette = pal; }
    if (validRange(c.range)) color.range = [c.range[0], c.range[1]];
    if (c.reverse === true) color.reverse = true;
    out.color = color;
  }
  if (isObj(o) && isName(o.column)) {
    const opacity: NonNullable<FluximgStyleBy["opacity"]> = { column: o.column };
    if (validRange(o.range)) opacity.range = [o.range[0], o.range[1]];
    if (Array.isArray(o.to) && o.to.length === 2 && finite(o.to[0]) && finite(o.to[1])) opacity.to = [clamp01(o.to[0]), clamp01(o.to[1])];
    out.opacity = opacity;
  }
  if (!out.color && !out.opacity) return null;
  if (v.missing === "hide") out.missing = "hide";
  return out;
}

function resolveLayer(layer: FluximgLayer, ov: FluximgLayerView | undefined): ResolvedLayer {
  const o = isObj(ov) ? (ov as FluximgLayerView) : undefined;
  const intensity = layer.kind === "intensity";
  const manifestOpacity = intensity && typeof layer.opacity === "number" && Number.isFinite(layer.opacity) ? layer.opacity : 1;
  let { color, lut } = pickColor(o, { color: layer.color ?? null, lut: intensity ? layer.lut ?? null : null });
  if (!intensity) lut = null; // vector and label layers have a stroke colour or keep their own (null)
  if (intensity && !color && !lut) lut = "gray";
  const range = intensity ? (validRange(o?.range) ? [o!.range![0], o!.range![1]] as [number, number] : [layer.range[0], layer.range[1]] as [number, number]) : null;
  return {
    id: layer.id,
    kind: layer.kind,
    name: layer.name,
    visible: typeof o?.visible === "boolean" ? o.visible : layer.visible ?? false,
    opacity: clamp01(finite(o?.opacity) ? o!.opacity! : manifestOpacity),
    color, lut,
    strokeWidth: finite(o?.strokeWidth) && o!.strokeWidth! >= 0 ? o!.strokeWidth! : 1,
    fillOpacity: clamp01(finite(o?.fillOpacity) ? o!.fillOpacity! : layer.kind === "labels" ? 0.12 : 0),
    range,
    opacityFromValue: intensity && layer.opacity === "value",
    // Objects of a layer with a table only (a vector layer without one has nothing to style by).
    styleBy: intensity || (layer.kind === "vector" && !layer.table) ? null : resolveStyleBy(o?.styleBy),
  };
}

function resolveFurniture(manifest: FluximgManifest, f: FluximgView["furniture"]): ResolvedFurniture {
  const fur = isObj(f) ? f : {};
  const corner = (v: unknown, d: FurnitureCorner): FurnitureCorner => (CORNERS.includes(v as FurnitureCorner) ? (v as FurnitureCorner) : d);
  const size = (v: unknown, d: number): number => (finite(v) && v > 0 ? v : d);
  const color = (v: unknown, d: string): string => (isColor(v) ? v : d);
  const dims = positionDims(manifest);
  const objectLayers = manifest.layers.filter((l) => l.kind !== "intensity").map((l) => l.id);
  const sb = fur.scalebar, st = fur.stamp, cl = fur.channelLabels, nm = fur.names, cb = fur.colorbar, ky = fur.key;
  return {
    scalebar: isObj(sb)
      ? { length: finite(sb.length) && sb.length > 0 ? sb.length : null, corner: corner(sb.corner, "bottom-right"), color: color(sb.color, "#ffffff"),
          label: typeof sb.label === "boolean" ? sb.label : true, thickness: size(sb.thickness, 1.5), fontSize: size(sb.fontSize, 7) }
      : false,
    stamp: isObj(st)
      ? { dims: Array.isArray(st.dims) ? st.dims.filter((d) => dims.includes(d)) : dims, corner: corner(st.corner, "top-left"), color: color(st.color, "#ffffff"), fontSize: size(st.fontSize, 7) }
      : false,
    channelLabels: isObj(cl) ? { corner: corner(cl.corner, "top-right"), fontSize: size(cl.fontSize, 7) } : false,
    names: isObj(nm)
      ? { layers: Array.isArray(nm.layers) ? nm.layers.filter((id) => objectLayers.includes(id)) : objectLayers, fontSize: size(nm.fontSize, 6) }
      : false,
    colorbar: isObj(cb) ? { corner: corner(cb.corner, "bottom-left"), color: color(cb.color, "#ffffff"), fontSize: size(cb.fontSize, 6) } : false,
    key: isObj(ky)
      ? { layer: typeof ky.layer === "string" && objectLayers.includes(ky.layer) ? ky.layer : null, corner: corner(ky.corner, "top-right"), color: color(ky.color, "#ffffff"), fontSize: size(ky.fontSize, 6) }
      : false,
  };
}

function resolveProjection(manifest: FluximgManifest, p: FluximgProjection | null | undefined): FluximgProjection | null {
  if (!isObj(p) || typeof p.dim !== "string" || SPATIAL.has(p.dim) || !MODES.includes(p.mode)) return null;
  const n = dimSize(manifest, p.dim);
  if (!manifest.pixels.dims.includes(p.dim) || n < 1 || !finite(p.from) || !finite(p.to)) return null;
  const from = clampInt(p.from, 0, n), to = clampInt(p.to, 0, n);
  return to > from ? { dim: p.dim, mode: p.mode, from, to } : null;
}

export function resolveView(manifest: FluximgManifest, view?: FluximgView | null): ResolvedView {
  const v: FluximgView = isObj(view) ? view : {};
  const index: Record<string, number> = {};
  for (const d of positionDims(manifest)) {
    const n = dimSize(manifest, d);
    const given = v.index?.[d], dflt = manifest.defaults?.index?.[d];
    const raw = finite(given) ? given : finite(dflt) ? dflt : d === "z" ? Math.floor(n / 2) : 0;
    index[d] = clampInt(raw, 0, Math.max(0, n - 1));
  }
  const nC = manifest.channels.length;
  const channels = manifest.channels.map((_, i) => resolveChannel(manifest, i, Array.isArray(v.channels) ? v.channels[i] : undefined));

  const byId = new Map(manifest.layers.map((l) => [l.id, l]));
  const order: string[] = [];
  if (Array.isArray(v.layerOrder)) for (const id of v.layerOrder) if (byId.has(id) && !order.includes(id)) order.push(id);
  for (const l of manifest.layers) if (!order.includes(l.id)) order.push(l.id);
  const layerViews = isObj(v.layers) ? v.layers : {};
  const layers = order.map((id) => resolveLayer(byId.get(id)!, layerViews[id]));

  return {
    index,
    projection: resolveProjection(manifest, v.projection),
    channels,
    composite: v.composite === "single" ? "single" : "blend",
    solo: finite(v.solo) ? clampInt(v.solo, 0, Math.max(0, nC - 1)) : 0,
    smooth: v.smooth === true,
    background: v.background === "transparent" || isColor(v.background) ? v.background! : "#000000",
    layers,
    furniture: resolveFurniture(manifest, v.furniture),
    insetOf: typeof v.insetOf === "string" && v.insetOf ? v.insetOf : null,
    link: typeof v.link === "string" && v.link ? v.link : null,
  };
}

// ---------------------------------------------------------------------------------------------
// patchView
// ---------------------------------------------------------------------------------------------

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (isObj(v)) { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) o[k] = clone(x); return o as T; }
  return v;
}

/** Fields of `patch` over a copy of `old`: undefined is ignored, null deletes. */
function mergeFields(old: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(old) ? clone(old) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = clone(v);
  }
  return out;
}

/** A colour and a colour map exclude each other: the one the patch sets wins (the colour, if it sets both). */
function exclusiveColor(out: Record<string, unknown>, patch: Record<string, unknown>): void {
  if (typeof patch.color === "string") delete out.lut;
  else if (typeof patch.lut === "string") delete out.color;
}

const isEmpty = (o: Record<string, unknown>): boolean => Object.keys(o).length === 0;

/**
 * `styleBy` merges per key: `color` and `opacity` merge field by field while they keep their column (a patch that
 * names ANOTHER column starts that part afresh: a range or palette belongs to the column it was chosen for), null
 * clears, `missing` is replaced. Nothing left to style by: null (the key is dropped).
 */
function mergeStyleBy(old: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = isObj(old) ? clone(old) : {};
  for (const [k, pv] of Object.entries(patch)) {
    if (pv === undefined) continue;
    if (pv === null) { delete out[k]; continue; }
    if ((k === "color" || k === "opacity") && isObj(pv)) {
      const was = isObj(out[k]) ? (out[k] as Record<string, unknown>) : undefined;
      const same = was && (pv.column === undefined || pv.column === was.column);
      out[k] = mergeFields(same ? was : undefined, pv);
    } else out[k] = clone(pv);
  }
  for (const k of ["color", "opacity"]) if (isObj(out[k]) && isEmpty(out[k] as Record<string, unknown>)) delete out[k];
  return isObj(out.color) || isObj(out.opacity) ? out : null;
}

/**
 * The view after a sparse patch. `index`, `layers` and `furniture` merge per key, `channels` per index (a null or
 * absent patch entry keeps the old one; within an entry fields merge); a null value anywhere clears what it
 * names (`projection: null`, `index: {z: null}`, `channels: [{range: null}]`, `furniture: {scalebar: null}`), and
 * furniture `false` is the default (off) so it clears too; undefined is ignored. Setting `color` clears `lut` and
 * vice versa. Empty objects are dropped so a view equal to the defaults serializes as `{}`. Inputs are never
 * mutated.
 */
export function patchView(view: FluximgView | undefined, patch: FluximgView): FluximgView {
  const out = (isObj(view) ? clone(view) : {}) as Record<string, unknown>;
  for (const [key, pv] of Object.entries((isObj(patch) ? patch : {}) as Record<string, unknown>)) {
    if (pv === undefined) continue;
    if (pv === null) { delete out[key]; continue; }
    switch (key) {
      case "index": case "projection": {
        if (!isObj(pv)) break;
        out[key] = mergeFields(out[key] as Record<string, unknown>, pv);
        break;
      }
      case "layers": {
        if (!isObj(pv)) break;
        const layers: Record<string, unknown> = isObj(out.layers) ? out.layers : {};
        for (const [id, lv] of Object.entries(pv)) {
          if (lv === undefined) continue;
          if (lv === null || !isObj(lv)) { delete layers[id]; continue; }
          const old = layers[id] as Record<string, unknown> | undefined;
          const merged = mergeFields(old, lv);
          exclusiveColor(merged, lv);
          if (isObj(lv.styleBy)) {
            const sb = mergeStyleBy(isObj(old?.styleBy) ? (old!.styleBy as Record<string, unknown>) : undefined, lv.styleBy);
            if (sb) merged.styleBy = sb; else delete merged.styleBy;
          }
          layers[id] = merged;
        }
        out.layers = layers;
        break;
      }
      case "furniture": {
        if (!isObj(pv)) break;
        const fur: Record<string, unknown> = isObj(out.furniture) ? out.furniture : {};
        for (const [k, fv] of Object.entries(pv)) {
          if (fv === undefined) continue;
          if (fv === null || fv === false || !isObj(fv)) { delete fur[k]; continue; }
          // An empty object is meaningful here: "on, with defaults".
          fur[k] = mergeFields(isObj(fur[k]) ? (fur[k] as Record<string, unknown>) : undefined, fv);
        }
        out.furniture = fur;
        break;
      }
      case "channels": {
        if (!Array.isArray(pv)) break;
        const old = Array.isArray(out.channels) ? (out.channels as unknown[]) : [];
        const len = Math.max(old.length, pv.length);
        const next: Array<Record<string, unknown> | null> = [];
        for (let i = 0; i < len; i++) {
          const o = isObj(old[i]) ? (old[i] as Record<string, unknown>) : null;
          const p = pv[i];
          if (!isObj(p)) { next.push(o); continue; }
          const merged = mergeFields(o ?? undefined, p);
          exclusiveColor(merged, p);
          next.push(merged);
        }
        out.channels = next;
        break;
      }
      case "layerOrder": {
        if (Array.isArray(pv)) out.layerOrder = pv.filter((id) => typeof id === "string");
        break;
      }
      default:
        out[key] = clone(pv);
    }
  }
  // Drop what is empty, so the default view is `{}`.
  for (const key of ["index", "projection", "furniture"]) if (isObj(out[key]) && isEmpty(out[key] as Record<string, unknown>)) delete out[key];
  if (isObj(out.layers)) {
    const layers = out.layers as Record<string, unknown>;
    for (const id of Object.keys(layers)) if (!isObj(layers[id]) || isEmpty(layers[id] as Record<string, unknown>)) delete layers[id];
    if (isEmpty(layers)) delete out.layers;
  }
  if (Array.isArray(out.channels)) {
    const ch = (out.channels as unknown[]).map((c) => (isObj(c) && !isEmpty(c) ? c : null));
    while (ch.length && ch[ch.length - 1] === null) ch.pop();
    if (ch.length) out.channels = ch; else delete out.channels;
  }
  if (Array.isArray(out.layerOrder) && (out.layerOrder as unknown[]).length === 0) delete out.layerOrder;
  return out as FluximgView;
}

// ---------------------------------------------------------------------------------------------
// viewPatch: the inverse of patchView
// ---------------------------------------------------------------------------------------------

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
  }
  return false;
}

/** Field by field (mergeFields' inverse): changed or new fields as `after` has them, null for a field `after` drops. */
function fieldsPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k], b = after[k];
    if (b === undefined || b === null) { if (a !== undefined && a !== null) out[k] = null; }
    else if (!same(a, b)) out[k] = clone(b);
  }
  return out;
}

/** A field patch of a channel or a layer, with the colour/colour-map exclusion of `exclusiveColor` accounted for. */
function colourFieldsPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out = fieldsPatch(before, after);
  // patchView clears the colour when a patch sets only the colour map: where `after` holds both (the colour wins when
  // resolved), restate the colour, which keeps what `after` shows.
  if (typeof out.lut === "string" && typeof after.color === "string") out.color = after.color;
  return out;
}

/** mergeStyleBy's inverse: a part that keeps its column patches field by field, one on another column is restated whole. */
function styleByPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k], b = after[k];
    if (b === undefined || b === null) { if (a !== undefined && a !== null) out[k] = null; continue; }
    if (same(a, b)) continue;
    if ((k === "color" || k === "opacity") && isObj(b)) {
      if (isObj(a) && a.column === b.column) { const f = fieldsPatch(a, b); if (!isEmpty(f)) out[k] = f; }
      // a part without a column cannot be stated over one that has it (it would merge): it means nothing, so it clears
      else out[k] = b.column === undefined && isObj(a) ? null : clone(b);
    } else out[k] = clone(b);
  }
  return out;
}

/**
 * The smallest patch that turns `before` into `after` (the inverse of `patchView`, in the same language
 * `set-image-view --view` speaks): `patchView(before, viewPatch(before, after))` resolves to exactly what `after`
 * resolves to, and `viewPatch(v, v)` is `{}`. A key `after` drops that `before` holds is `null` (clear to the
 * image's default). Shapes, as patchView merges them:
 *   - `index` per dimension, `layers` per layer and within a layer per field (`styleBy` per part), `furniture` per
 *     piece and within a piece per field (a piece switched on is stated whole, `{}` included);
 *   - `channels` per channel index and within a channel per field: a patch entry `null` keeps that channel as it
 *     was, so a channel `after` clears entirely is a patch of nulls for each field it had;
 *   - `projection` is ONE value (like a crop): restated whole when it differs, so a step's run never merges with
 *     another run's fields;
 *   - everything else (`composite`, `solo`, `smooth`, `background`, `layerOrder`, `insetOf`, `link`) is replaced.
 * A container `after` lacks altogether (`index`, `channels`, `layers`, `furniture`) is cleared entry by entry, never
 * with one top-level null, so a later Design edit of an entry the step never held survives the step.
 */
export function viewPatch(before: FluximgView | null | undefined, after: FluximgView | null | undefined): FluximgView {
  const A = (isObj(before) ? before : {}) as Record<string, unknown>, B = (isObj(after) ? after : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const a = A[key];
    let b = B[key];
    // A container `after` drops is cleared entry by entry (narrowly: a later Design edit of another entry survives).
    if ((b === undefined || b === null) && CONTAINERS.has(key) && (key === "channels" ? Array.isArray(a) : isObj(a))) b = key === "channels" ? [] : {};
    if (b === undefined || b === null) { if (a !== undefined && a !== null) out[key] = null; continue; }
    if (same(a, b)) continue;
    switch (key) {
      case "index": {
        if (!isObj(b)) { out[key] = clone(b); break; }
        const f = fieldsPatch(isObj(a) ? a : {}, b);
        if (!isEmpty(f)) out[key] = f;
        break;
      }
      case "projection": {
        // Whole: mergeFields over the old run would keep a field the new one lacks, so name every old field.
        const whole: Record<string, unknown> = isObj(b) ? clone(b) : {};
        if (isObj(a) && isObj(b)) for (const k of Object.keys(a)) if (b[k] === undefined) whole[k] = null;
        out[key] = isObj(b) ? whole : clone(b);
        break;
      }
      case "layers": {
        if (!isObj(b)) { out[key] = null; break; }
        const la: Record<string, unknown> = isObj(a) ? a : {}, layers: Record<string, unknown> = {};
        for (const id of new Set([...Object.keys(la), ...Object.keys(b)])) {
          const x = la[id], y = b[id];
          if (!isObj(y)) { if (isObj(x)) layers[id] = null; continue; }
          const xo: Record<string, unknown> = isObj(x) ? x : {};
          const { styleBy: sa, ...ra } = xo, { styleBy: sb, ...rb } = y;
          const f = colourFieldsPatch(ra, rb);
          if (!same(sa, sb)) {
            if (isObj(sb)) { const s = styleByPatch(isObj(sa) ? sa : {}, sb); if (!isEmpty(s)) f.styleBy = s; }
            else if (sa !== undefined && sa !== null) f.styleBy = null;
          }
          if (!isEmpty(f)) layers[id] = f;
        }
        if (!isEmpty(layers)) out[key] = layers;
        break;
      }
      case "furniture": {
        if (!isObj(b)) { out[key] = null; break; }
        const fa: Record<string, unknown> = isObj(a) ? a : {}, fur: Record<string, unknown> = {};
        for (const k of new Set([...Object.keys(fa), ...Object.keys(b)])) {
          const x = fa[k], y = b[k];
          if (!isObj(y)) { if (isObj(x)) fur[k] = null; continue; }
          if (!isObj(x)) { fur[k] = clone(y); continue; }
          const f = fieldsPatch(x, y);
          if (!isEmpty(f)) fur[k] = f;
        }
        if (!isEmpty(fur)) out[key] = fur;
        break;
      }
      case "channels": {
        if (!Array.isArray(b)) { out[key] = null; break; }
        const ca: unknown[] = Array.isArray(a) ? a : [], n = Math.max(ca.length, b.length), next: Array<Record<string, unknown> | null> = [];
        for (let i = 0; i < n; i++) {
          const x: Record<string, unknown> = isObj(ca[i]) ? (ca[i] as Record<string, unknown>) : {}, y: Record<string, unknown> = isObj(b[i]) ? (b[i] as Record<string, unknown>) : {};
          const f = colourFieldsPatch(x, y);
          next.push(isEmpty(f) ? null : f);
        }
        while (next.length && next[next.length - 1] === null) next.pop();
        if (next.length) out[key] = next;
        break;
      }
      default: out[key] = clone(b);
    }
  }
  return out as FluximgView;
}

const CONTAINERS = new Set(["index", "layers", "furniture", "channels"]);

/** True when a patch changes nothing (`viewPatch(v, v)`). */
export const isEmptyViewPatch = (p: FluximgView | null | undefined): boolean => !isObj(p) || isEmpty(p as Record<string, unknown>);

/**
 * A resolved view written back as a stored view that says every setting explicitly (`resolveView(m, explicitView(rv))`
 * is `rv` again): what a sample of a slide at a moment between two steps holds as its image's `view`.
 */
export function explicitView(rv: ResolvedView): FluximgView {
  const out: FluximgView = { index: { ...rv.index } };
  if (rv.projection) out.projection = { ...rv.projection };
  out.channels = rv.channels.map((c): FluximgChannelView => ({
    visible: c.visible, ...(c.color ? { color: c.color } : c.lut ? { lut: c.lut } : {}),
    range: [c.range[0], c.range[1]], norm: c.norm, gamma: c.gamma, invert: c.invert,
  }));
  out.composite = rv.composite;
  out.solo = rv.solo;
  out.smooth = rv.smooth;
  out.background = rv.background;
  if (rv.layers.length) {
    const layers: Record<string, FluximgLayerView> = {};
    for (const l of rv.layers) {
      const o: FluximgLayerView = { visible: l.visible, opacity: l.opacity, strokeWidth: l.strokeWidth, fillOpacity: l.fillOpacity };
      if (l.color) o.color = l.color; else if (l.lut) o.lut = l.lut;
      if (l.range) o.range = [l.range[0], l.range[1]];
      if (l.styleBy) o.styleBy = clone(l.styleBy);
      layers[l.id] = o;
    }
    out.layers = layers;
    out.layerOrder = rv.layers.map((l) => l.id);
  }
  const fur: Record<string, unknown> = {};
  for (const [k, piece] of Object.entries(rv.furniture)) {
    if (!isObj(piece)) continue;
    const p: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(piece)) if (v !== null && v !== undefined) p[f] = clone(v);
    fur[k] = p;
  }
  if (!isEmpty(fur)) out.furniture = fur as FluximgView["furniture"];
  if (rv.insetOf) out.insetOf = rv.insetOf;
  if (rv.link) out.link = rv.link;
  return out;
}

/**
 * The part of a patch that linked panels share: position, projection, and each channel's window, norm and gamma.
 * Null when the patch touches none of those. (Visibility, colours, the composite mode, layers, furniture and the
 * frame belong to one panel: a grey single-channel panel beside its composite differs in exactly those.)
 */
export function sharedPatch(patch: FluximgView): FluximgView | null {
  const out: FluximgView = {};
  if (patch.index !== undefined) out.index = patch.index;
  if (patch.projection !== undefined) out.projection = patch.projection;
  if (Array.isArray(patch.channels)) {
    let any = false;
    const channels = patch.channels.map((c) => {
      if (!isObj(c)) return null;
      const keep: Record<string, unknown> = {};
      for (const k of ["range", "norm", "gamma"] as const) if (k in c) keep[k] = (c as Record<string, unknown>)[k];
      if (!Object.keys(keep).length) return null;
      any = true;
      return keep as FluximgChannelView;
    });
    if (any) out.channels = channels;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Planes and pixels
// ---------------------------------------------------------------------------------------------

export type PlaneRequest =
  | { channel: number; leading: number[] }
  | { channel: number; leading: number[]; dim: string; from: number; to: number; mode: FluximgProjectionMode };

/** The channels whose pixels a view shows: every visible one for `blend`, only `solo` for `single`. */
export function contributingChannelIndices(rv: ResolvedView): number[] {
  if (rv.composite === "single") return rv.channels.some((c) => c.index === rv.solo) ? [rv.solo] : [];
  return rv.channels.filter((c) => c.visible).map((c) => c.index);
}

/**
 * One request per contributing channel. `leading` holds an index for every dimension before y, x in stored
 * order: the channel at `c`'s position, the view's index elsewhere, and a placeholder 0 at a projected
 * dimension (the request then carries `dim`, `from`, `to`, `mode`: reduce that run of planes).
 */
export function planeRequests(manifest: FluximgManifest, rv: ResolvedView): PlaneRequest[] {
  const dims = manifest.pixels.dims;
  const lead = dims.slice(0, Math.max(0, dims.length - 2));
  const p = rv.projection;
  return contributingChannelIndices(rv).map((channel) => {
    const leading = lead.map((d) => (d === "c" ? channel : p && d === p.dim ? 0 : rv.index[d] ?? 0));
    return p ? { channel, leading, dim: p.dim, from: p.from, to: p.to, mode: p.mode } : { channel, leading };
  });
}

const num = (v: number): string => (Object.is(v, -0) ? "0" : String(v));
/** A colour as the pixels see it ("#F00" and "#ff0000" are the same key). */
const colorKey = (c: string): string => { const rgb = hexToRgb(c); return rgb ? rgb.join(",") : c; };

/**
 * A canonical string over everything that changes the still's PIXELS and nothing else: the crop and output size,
 * the position along every non-projected dimension, the projection, each contributing channel's colour, window,
 * effective norm and invert (not its name, not hidden channels, not whether "blend" with one channel or "single"
 * produced it), the background, `smooth` only where it can act (magnifying), and the visible intensity layers
 * with their colour, window and opacity, in order. Furniture, vector and label layers, layer names and `insetOf`
 * are not pixels. Callers prefix the asset identity.
 */
export function pixelKey(manifest: FluximgManifest, rv: ResolvedView, crop: PixelRect, outWidth: number, outHeight: number): string {
  const parts: string[] = ["fx1", `crop=${num(crop.x)},${num(crop.y)},${num(crop.width)},${num(crop.height)}`, `out=${outWidth}x${outHeight}`];
  const p = rv.projection;
  for (const d of positionDims(manifest)) if (!(p && p.dim === d)) parts.push(`${d}=${rv.index[d] ?? 0}`);
  if (p) parts.push(`proj=${p.mode}:${p.dim}:${p.from}:${p.to}`);
  for (const i of contributingChannelIndices(rv)) {
    const c = rv.channels[i];
    // The norm as the renderer will apply it: gamma 1 is linear, a log window with a black point <= 0 is linear.
    const norm = c.norm === "gamma" && c.gamma !== 1 ? `gamma${num(c.gamma)}` : c.norm === "log" && c.range[0] > 0 ? "log" : "linear";
    parts.push(`c${i}=${c.color ? colorKey(c.color) : `lut:${c.lut}`}|${num(c.range[0])},${num(c.range[1])}|${norm}|${c.invert ? "inv" : ""}`);
  }
  parts.push(`bg=${rv.background === "transparent" ? "none" : colorKey(rv.background)}`);
  const sx = crop.width / outWidth, sy = crop.height / outHeight;
  const identity = sx === 1 && sy === 1 && Number.isInteger(crop.x) && Number.isInteger(crop.y);
  if (rv.smooth && sx <= 1 && sy <= 1 && !identity) parts.push("smooth");
  for (const l of rv.layers) {
    if (l.kind !== "intensity" || !l.visible || !(l.opacity > 0)) continue;
    const r = l.range ?? [0, 1];
    parts.push(`L${l.id}=${l.color ? colorKey(l.color) : `lut:${l.lut}`}|${num(r[0])},${num(r[1])}|${num(l.opacity)}${l.opacityFromValue ? "v" : ""}`);
  }
  return parts.join(";");
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

/** At most 4 decimals (4 significant digits below 1), no trailing zeros, U+2212 for minus. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  let s = a !== 0 && a < 1 ? a.toPrecision(4) : a.toFixed(4);
  if (s.includes("e")) s = String(Number(s));
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "0" || v > 0 ? s : `−${s}`;
}

/** The physical position of `index` along `dim`, or null when the axis does not say one. */
function positionOf(manifest: FluximgManifest, dim: string, index: number): number | null {
  const a = manifest.axes?.[dim];
  if (!a) return null;
  if (Array.isArray(a.coords)) return finite(a.coords[index]) ? a.coords[index] : null;
  const scale = finite(a.scale) ? a.scale : 1, offset = finite(a.offset) ? a.offset : 0;
  // A bare index axis (no unit, unit steps from 0) has no position worth printing beside the index.
  if (!a.unit && scale === 1 && offset === 0) return null;
  return offset + scale * index;
}
const withUnit = (manifest: FluximgManifest, dim: string, s: string): string => {
  const u = manifest.axes?.[dim]?.unit;
  return u ? `${s} ${u}` : s;
};

/** "z 12/21 · −50.5 µm"; categorical: "trial b (2/3)"; no position known: "t 3/24". */
export function describePosition(manifest: FluximgManifest, dim: string, index: number): string {
  const n = dimSize(manifest, dim), i = clampInt(finite(index) ? index : 0, 0, Math.max(0, n - 1));
  const labels = manifest.axes?.[dim]?.labels;
  if (Array.isArray(labels) && labels[i] != null) return `${dim} ${labels[i]} (${i + 1}/${n})`;
  const pos = positionOf(manifest, dim, i);
  return pos === null ? `${dim} ${i + 1}/${n}` : `${dim} ${i + 1}/${n} · ${withUnit(manifest, dim, formatNumber(pos))}`;
}

/** "max z 8–15 · −54.5 to −47.5 µm" (plane numbers 1-based, inclusive); categorical: "max trial a–c (1–3)". */
export function describeProjection(manifest: FluximgManifest, p: FluximgProjection): string {
  const first = p.from, last = p.to - 1;
  const planes = first === last ? `${first + 1}` : `${first + 1}–${last + 1}`;
  const labels = manifest.axes?.[p.dim]?.labels;
  if (Array.isArray(labels) && labels[first] != null && labels[last] != null) {
    return `${p.mode} ${p.dim} ${first === last ? labels[first] : `${labels[first]}–${labels[last]}`} (${planes})`;
  }
  const a = positionOf(manifest, p.dim, first), b = positionOf(manifest, p.dim, last);
  if (a === null || b === null) return `${p.mode} ${p.dim} ${planes}`;
  const span = first === last ? formatNumber(a) : `${formatNumber(a)} to ${formatNumber(b)}`;
  return `${p.mode} ${p.dim} ${planes} · ${withUnit(manifest, p.dim, span)}`;
}
