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
  FluximgChannelView, FluximgLayerView, FluximgProjection, FluximgProjectionMode, FluximgView, FurnitureCorner,
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
    visible: typeof o?.visible === "boolean" ? o.visible : true,
    color, lut, range,
    norm: o?.norm && (NORMS as readonly string[]).includes(o.norm) ? o.norm : "linear",
    gamma: finite(o?.gamma) && o!.gamma! > 0 ? o!.gamma! : 1,
    invert: o?.invert === true,
  };
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
  };
}

function resolveFurniture(manifest: FluximgManifest, f: FluximgView["furniture"]): ResolvedFurniture {
  const fur = isObj(f) ? f : {};
  const corner = (v: unknown, d: FurnitureCorner): FurnitureCorner => (CORNERS.includes(v as FurnitureCorner) ? (v as FurnitureCorner) : d);
  const size = (v: unknown, d: number): number => (finite(v) && v > 0 ? v : d);
  const color = (v: unknown, d: string): string => (isColor(v) ? v : d);
  const dims = positionDims(manifest);
  const objectLayers = manifest.layers.filter((l) => l.kind !== "intensity").map((l) => l.id);
  const sb = fur.scalebar, st = fur.stamp, cl = fur.channelLabels, nm = fur.names, cb = fur.colorbar;
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
          const merged = mergeFields(layers[id] as Record<string, unknown>, lv);
          exclusiveColor(merged, lv);
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
