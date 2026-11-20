/**
 * The Inspector's edits to a fluximg view, as sparse patches (pure: no DOM, no Node, no Svelte).
 *
 * The Inspector shows the RESOLVED view and writes the SPARSE recipe. Every function here returns a patch for
 * `ops.setFluximgView` in which a value equal to its default is written as null, so `patchView` removes the key
 * and the stored view stays minimal (an all-default view is no view at all). The live view's `actions.ts` acts on
 * the live element through its session; these act on any element, and take the same decisions (Auto's percentile
 * ladder, gamma 1 = linear, a projection starting over the whole dimension, black kept below white).
 */
import type { FluximgManifest } from "./types";
import type {
  FluximgChannelView, FluximgFurnitureView, FluximgLayerView, FluximgProjectionMode, FluximgView, FurnitureCorner,
  ResolvedLayer, ResolvedView,
} from "./view";
import { resolveView } from "./viewOps";
import { autoStepOf, autoWindow } from "./live/histogram";

/** null typed as "absent": `patchView` reads a null field as "clear back to the default". */
const CLEAR = null as unknown as undefined;
/** The same for an entry of a record whose type has no room for absence (`index`). */
const CLEAR_N = null as unknown as number;

export const dimLength = (m: FluximgManifest, dim: string): number => {
  const i = m.pixels.dims.indexOf(dim);
  return i >= 0 ? m.pixels.shape[i] : 0;
};

/** Integer data: stored exactly as integers, so windows and steps move by whole values. */
export const integerData = (m: FluximgManifest): boolean => m.pixels.encoding.kind === "exact" && !m.pixels.dtype.startsWith("float");

/** The view with nothing set. Every furniture piece is switched on so its defaults are readable too. */
export function defaultView(m: FluximgManifest): ResolvedView {
  return resolveView(m, { furniture: { scalebar: {}, stamp: {}, channelLabels: {}, names: {}, colorbar: {} } });
}

const same = (a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** A channel patch for channel `i`; the others are holes (null: "leave that channel alone"). */
export function channelPatch(i: number, patch: FluximgChannelView): FluximgView {
  const channels: Array<FluximgChannelView | null> = [];
  for (let k = 0; k < i; k++) channels.push(null);
  channels.push(patch);
  return { channels };
}

// --- channels ---------------------------------------------------------------------------------

/**
 * Set a channel's black point (`which` 0) or white point (1). Black stays below white (by one for integer data);
 * `snap` rounds integer data to whole values (scrubbing and the wheel), a typed value is kept as typed.
 */
export function windowPatch(m: FluximgManifest, rv: ResolvedView, i: number, which: 0 | 1, value: number, snap = false): FluximgView | null {
  const ch = rv.channels[i];
  if (!ch || !Number.isFinite(value)) return null;
  const integer = integerData(m);
  const v = snap && integer ? Math.round(value) : value;
  const gap = integer ? 1 : Math.abs(ch.range[1] - ch.range[0]) * 1e-6 || 1e-12;
  let [b, w] = ch.range;
  if (which === 0) b = Math.min(v, w - gap); else w = Math.max(v, b + gap);
  const range: [number, number] = [b, w];
  return channelPatch(i, { range: same(range, defaultView(m).channels[i].range) ? CLEAR : range });
}

/** Gamma 1 is linear: back to the default norm. Any other gamma switches the norm to gamma. */
export function gammaPatch(i: number, gamma: number): FluximgView | null {
  if (!(gamma > 0) || !Number.isFinite(gamma)) return null;
  return channelPatch(i, gamma === 1 ? { gamma: CLEAR, norm: CLEAR } : { norm: "gamma", gamma });
}

/** Choose a norm. Gamma starts at 0.5 when the channel's gamma is still 1 (a gamma norm of 1 would change nothing). */
export function normPatch(rv: ResolvedView, i: number, norm: "linear" | "log" | "gamma"): FluximgView | null {
  const ch = rv.channels[i];
  if (!ch) return null;
  if (norm === "linear") return channelPatch(i, { norm: CLEAR, gamma: CLEAR });
  if (norm === "log") return channelPatch(i, { norm: "log", gamma: CLEAR });
  return channelPatch(i, { norm: "gamma", gamma: ch.gamma === 1 ? 0.5 : ch.gamma });
}

/** A colour for a channel; the manifest's own colour clears the override. */
export function colorPatch(m: FluximgManifest, i: number, color: string): FluximgView {
  const base = defaultView(m).channels[i];
  return channelPatch(i, base?.color && base.color.toLowerCase() === color.toLowerCase() ? { color: CLEAR, lut: CLEAR } : { color });
}

/**
 * Auto contrast, the live view's ladder: the window snaps to the stack's percentiles; again tightens it
 * (0.1–99.9 %, then 1–99.8 %, 1–99 %), a fourth time shows the full range. "All" takes its step from the first
 * channel, so a composite never mixes tightness between channels.
 */
export function autoPatch(m: FluximgManifest, rv: ResolvedView, i: number | "all"): FluximgView | null {
  const which = i === "all" ? rv.channels.map((c) => c.index) : [i];
  const lead = rv.channels[which[0]];
  if (!lead) return null;
  const step = autoStepOf(m.channels[lead.index].stats, lead.range) + 1;
  const d = defaultView(m);
  const channels: Array<FluximgChannelView | null> = rv.channels.map(() => null);
  for (const k of which) {
    const w = autoWindow(m.channels[k].stats, step);
    channels[k] = { range: same(w, d.channels[k].range) ? CLEAR : w };
  }
  return { channels };
}

/** Show or hide a channel. With one channel shown at a time, "show" makes it the one. */
export function showChannelPatch(rv: ResolvedView, i: number, show: boolean, m?: FluximgManifest): FluximgView | null {
  if (!rv.channels[i]) return null;
  if (rv.composite === "single") return show ? { solo: i === 0 ? CLEAR : i } : null;
  // A channel can start hidden in the image itself (manifest `visible: false`): the override is cleared only when
  // it says what the image already says.
  const byDefault = m?.channels[i]?.visible !== false;
  return channelPatch(i, { visible: show === byDefault ? CLEAR : show });
}

export function compositePatch(mode: "blend" | "single", solo?: number): FluximgView {
  if (mode === "blend") return { composite: CLEAR, solo: CLEAR };
  return { composite: "single", ...(solo === undefined ? {} : { solo: solo === 0 ? CLEAR : solo }) };
}

// --- position and projection ---------------------------------------------------------------------

/** Go to plane `index` (0-based, clamped) along `dim`. */
export function indexPatch(m: FluximgManifest, dim: string, index: number): FluximgView | null {
  const n = dimLength(m, dim);
  if (n < 1 || !Number.isFinite(index)) return null;
  const i = Math.min(n - 1, Math.max(0, Math.round(index)));
  return { index: { [dim]: i === defaultView(m).index[dim] ? CLEAR_N : i } };
}

/**
 * One plane (`mode` null) or a statistic over a run along `dim`. A new projection covers the whole dimension; a
 * new mode on the same dimension keeps the run; back to one plane lands on the run's middle.
 */
export function projectionPatch(m: FluximgManifest, rv: ResolvedView, dim: string, mode: FluximgProjectionMode | null): FluximgView | null {
  const p = rv.projection;
  if (!mode) {
    if (!p) return null;
    const mid = Math.floor((p.from + p.to - 1) / 2);
    return { projection: CLEAR, index: { [p.dim]: mid === defaultView(m).index[p.dim] ? CLEAR_N : mid } };
  }
  const n = dimLength(m, dim);
  if (n <= 1) return null;
  const keep = p && p.dim === dim;
  return { projection: { dim, mode, from: keep ? p.from : 0, to: keep ? p.to : n } };
}

/** Set the run's first plane (`end` "from") or last plane (`end` "to"), both 0-based INCLUSIVE; the run never empties. */
export function runPatch(m: FluximgManifest, rv: ResolvedView, end: "from" | "to", plane: number): FluximgView | null {
  const p = rv.projection;
  if (!p || !Number.isFinite(plane)) return null;
  const n = dimLength(m, p.dim), k = Math.round(plane);
  const from = end === "from" ? Math.min(p.to - 1, Math.max(0, k)) : p.from;
  const to = end === "to" ? Math.max(p.from + 1, Math.min(n, k + 1)) : p.to;
  return { projection: { dim: p.dim, mode: p.mode, from, to } };
}

// --- layers -------------------------------------------------------------------------------------

type LayerNumber = "opacity" | "strokeWidth" | "fillOpacity";

/** Show or hide a layer. */
export function showLayerPatch(m: FluximgManifest, id: string, show: boolean): FluximgView | null {
  const d = defaultView(m).layers.find((l) => l.id === id);
  if (!d) return null;
  return { layers: { [id]: { visible: show === d.visible ? CLEAR : show } } };
}

/** A layer's opacity, stroke width or fill opacity; its own default clears the override. */
export function layerNumberPatch(m: FluximgManifest, id: string, key: LayerNumber, value: number): FluximgView | null {
  const d = defaultView(m).layers.find((l) => l.id === id);
  if (!d || !Number.isFinite(value)) return null;
  const v = key === "strokeWidth" ? Math.max(0, value) : Math.min(1, Math.max(0, value));
  const patch: FluximgLayerView = { [key]: v === d[key] ? CLEAR : v };
  return { layers: { [id]: patch } };
}

/** An intensity layer's black point (0) or white point (1). */
export function layerWindowPatch(m: FluximgManifest, layer: ResolvedLayer, which: 0 | 1, value: number): FluximgView | null {
  const d = defaultView(m).layers.find((l) => l.id === layer.id);
  if (!d?.range || !layer.range || !Number.isFinite(value)) return null;
  const gap = Math.abs(layer.range[1] - layer.range[0]) * 1e-6 || 1e-12;
  let [b, w] = layer.range;
  if (which === 0) b = Math.min(value, w - gap); else w = Math.max(value, b + gap);
  const range: [number, number] = [b, w];
  return { layers: { [layer.id]: { range: same(range, d.range) ? CLEAR : range } } };
}

// --- annotations --------------------------------------------------------------------------------

export type FurniturePiece = keyof FluximgFurnitureView;

/** Switch a piece of furniture on (with defaults) or off. */
export function furnitureOnPatch(piece: FurniturePiece, on: boolean): FluximgView {
  return { furniture: { [piece]: on ? {} : CLEAR } as FluximgFurnitureView };
}

/** One field of a piece of furniture that is on; its default clears the field (the piece stays on). */
export function furnitureFieldPatch(m: FluximgManifest, piece: "scalebar" | "stamp" | "channelLabels" | "names" | "colorbar", key: string, value: string | number | boolean | null): FluximgView {
  const d = defaultView(m).furniture[piece] as unknown as Record<string, unknown>;
  const v = value === null || (d && d[key] === value) ? CLEAR : value;
  return { furniture: { [piece]: { [key]: v } } as FluximgFurnitureView };
}

/** Object names on or off for one object layer. None left: names off; every object layer: the default list. */
export function namesLayerPatch(m: FluximgManifest, rv: ResolvedView, layerId: string, on: boolean): FluximgView {
  const all = m.layers.filter((l) => l.kind !== "intensity").map((l) => l.id);
  const cur = rv.furniture.names ? rv.furniture.names.layers : [];
  const next = all.filter((id) => (id === layerId ? on : cur.includes(id)));
  if (!next.length) return furnitureOnPatch("names", false);
  return { furniture: { names: { layers: next.length === all.length ? CLEAR : next } } };
}

export const CORNERS: ReadonlyArray<[FurnitureCorner, string]> = [
  ["top-left", "Top left"], ["top-right", "Top right"], ["bottom-left", "Bottom left"], ["bottom-right", "Bottom right"],
];

// --- the rest of the view -----------------------------------------------------------------------

export function smoothPatch(smooth: boolean): FluximgView {
  return { smooth: smooth ? true : CLEAR };
}

/** A hex colour or "transparent"; black is the default. */
export function backgroundPatch(background: string): FluximgView {
  return { background: background.toLowerCase() === "#000000" ? CLEAR : background };
}

// --- words --------------------------------------------------------------------------------------

/** A long path shortened in the middle, so both the root and the bundle's name stay readable. */
export function middleEllipsis(s: string, max = 34): string {
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) * 0.6), head = max - 1 - tail;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
