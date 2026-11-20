/**
 * What the live view can DO to an image, as plain functions over the session and the stores.
 *
 * The panel's rows, the rails, the on-image gestures, the wheel and the keyboard all call these, so every route
 * to a change shares one definition and one undo behaviour. Each function reads the live element fresh.
 */
import { get } from "svelte/store";
import { addFluximg } from "../../ops";
import { pushToast } from "../../toast";
import type { CropRect, FluximgElement, Project } from "../../types";
import { fluximgManifests } from "../store";
import { clampCrop, fullCrop } from "../still";
import type { FluximgManifest } from "../types";
import type { FluximgChannelView, FluximgFurnitureView, FluximgLayerView, FluximgProjectionMode, FluximgView, PixelRect, ResolvedView } from "../view";
import { positionDims, resolveView } from "../viewOps";
import { autoStepOf, autoWindow, histDomain, moveWindow, nudgeStep, sampleStepOf, sampleWindow, snapValue, sortedSample } from "./histogram";
import { framePeriod, playStep, resizeRun, slideRun, stepIndex, type PlayMode } from "./rail";
import { WHEEL_SETTLE_MS, cancelLiveEdit, fluximgLive, liveCrop, liveElement, liveMutate, liveSampler, liveView, setLive, settleLiveEdit } from "./session";

export interface LiveContext { element: FluximgElement; manifest: FluximgManifest; view: ResolvedView; crop: PixelRect }

/** The live element with its manifest and resolved view, or null while either is missing. */
export function liveContext(): LiveContext | null {
  const element = liveElement();
  if (!element) return null;
  const manifest = get(fluximgManifests)[element.assetId];
  if (!manifest) return null;
  return { element, manifest, view: resolveView(manifest, element.view), crop: clampCrop(manifest, element.crop) };
}

export const dimLength = (m: FluximgManifest, dim: string): number => { const i = m.pixels.dims.indexOf(dim); return i >= 0 ? m.pixels.shape[i] : 0; };

/** Dimensions worth a rail: every position dimension with more than one plane. Time first, then depth, then the rest. */
export function railDims(m: FluximgManifest): string[] {
  const dims = positionDims(m).filter((d) => dimLength(m, d) > 1);
  const rank = (d: string): number => (d === "t" ? 0 : d === "z" ? 1 : 2);
  return dims.slice().sort((a, b) => rank(a) - rank(b));
}

/**
 * The panel's keys, all under the left hand (the right stays on the mouse). `r` closes the view and `f` opens the
 * properties menu as everywhere; every other unmodified key is the panel's own (so none is given to `r`, `f`, or
 * to `s`, which the open choices use to step). A dimension's rail takes its own letter when it is free (t, z),
 * else a spare.
 */
export const LIVE_KEYS = {
  auto: "a", split: "x", projection: "e", layers: "d", frame: "v", smooth: "n", scalebar: "b", stamp: "w", channelNames: "c", colorbar: "g",
} as const;
const RAIL_SPARE = ["q", "`"];

export function dimKeys(m: FluximgManifest): Record<string, string> {
  const taken = new Set<string>(["r", "s", "f", ...Object.values(LIVE_KEYS)]);
  const out: Record<string, string> = {};
  for (const d of railDims(m)) {
    const own = d[0]?.toLowerCase() ?? "";
    const key = (own === "t" || own === "z") && !taken.has(own) ? own : RAIL_SPARE.find((k) => !taken.has(k)) ?? "";
    if (key) { out[d] = key; taken.add(key); }
  }
  return out;
}

// --- position -----------------------------------------------------------------------------------

/** Step along a dimension by planes (a projection's run slides instead). Wheel notches and arrow keys land here. */
export function stepPosition(dim: string, steps: number, settleAfter = WHEEL_SETTLE_MS): void {
  const c = liveContext();
  if (!c || !steps) return;
  const n = dimLength(c.manifest, dim);
  if (n <= 1) return;
  const p = c.view.projection;
  if (p && p.dim === dim) {
    const [from, to] = slideRun(p.from, p.to, steps, n);
    if (from !== p.from) liveView(`pos:${dim}`, { projection: { dim, mode: p.mode, from, to } }, settleAfter);
    return;
  }
  const next = stepIndex(c.view.index[dim] ?? 0, steps, n);
  if (next !== (c.view.index[dim] ?? 0)) liveView(`pos:${dim}`, { index: { [dim]: next } }, settleAfter);
}

/** Jump to a plane (a rail scrub). The caller settles the gesture on release. */
export function setPosition(dim: string, index: number, key = `pos:${dim}`): void {
  const c = liveContext();
  if (!c) return;
  const next = stepIndex(index, 0, dimLength(c.manifest, dim));
  if (next !== (c.view.index[dim] ?? 0)) liveView(key, { index: { [dim]: next } });
}

// --- projections --------------------------------------------------------------------------------

export const PROJECTION_MODES: readonly FluximgProjectionMode[] = ["max", "mean", "min", "sum", "std"];

/** Set the run of planes a projection covers (a rail drag). A run needs a mode: the current one, else max. */
export function setRun(dim: string, from: number, to: number, key = `run:${dim}`, settleAfter = 0): void {
  const c = liveContext();
  if (!c) return;
  const n = dimLength(c.manifest, dim), f = Math.max(0, Math.min(n - 1, Math.round(from))), t = Math.max(f + 1, Math.min(n, Math.round(to)));
  liveView(key, { projection: { dim, mode: c.view.projection?.mode ?? "max", from: f, to: t } }, settleAfter);
}

/** Grow or shrink the run around its middle (the wheel while a run is armed). */
export function resizeProjection(steps: number): void {
  const c = liveContext(), p = c?.view.projection;
  if (!c || !p || !steps) return;
  const [from, to] = resizeRun(p.from, p.to, steps, dimLength(c.manifest, p.dim));
  if (from !== p.from || to !== p.to) liveView(`run:${p.dim}`, { projection: { dim: p.dim, mode: p.mode, from, to } }, WHEEL_SETTLE_MS);
}

/**
 * Choose what a dimension shows: one plane (`null`) or a statistic over a run. Turning a projection on starts
 * with the whole dimension (the usual "max projection of the stack"); turning it off returns to the plane at the
 * run's middle, so the picture does not jump to somewhere unrelated.
 */
export function setProjectionMode(dim: string, mode: FluximgProjectionMode | null, key = "projection"): void {
  const c = liveContext();
  if (!c) return;
  const p = c.view.projection;
  if (!mode) {
    if (!p) return;
    liveView(key, { projection: null, index: { [p.dim]: Math.floor((p.from + p.to - 1) / 2) } });
    return;
  }
  const n = dimLength(c.manifest, dim);
  if (n <= 1) return;
  const same = p && p.dim === dim;
  liveView(key, { projection: { dim, mode, from: same ? p.from : 0, to: same ? p.to : n } });
}

// --- channels -----------------------------------------------------------------------------------

/** A sparse channel patch for channel `i` (holes are null: "leave the others alone"). */
function channelPatch(i: number, patch: FluximgChannelView): FluximgView {
  const channels: Array<FluximgChannelView | null> = [];
  for (let k = 0; k < i; k++) channels.push(null);
  channels.push(patch);
  return { channels };
}

const integerData = (m: FluximgManifest): boolean => m.pixels.encoding.kind === "exact" && !m.pixels.dtype.startsWith("float");

export function setChannel(i: number, patch: FluximgChannelView, key = `channel:${i}`, settleAfter = 0): void {
  liveView(key, channelPatch(i, patch), settleAfter);
}

/** Move a channel's black point (0), white point (1) or whole window (2) by wheel notches. */
export function nudgeWindow(i: number, which: 0 | 1 | 2, steps: number, fine = 1): void {
  const c = liveContext(), ch = c?.view.channels[i];
  if (!c || !ch || !steps) return;
  const stats = c.manifest.channels[i].stats, d = histDomain(stats, ch.range), integer = integerData(c.manifest);
  const step = nudgeStep(d, integer) * fine;
  const moved = moveWindow(ch.range, which, steps * step, integer ? 1 : step / 100);
  setChannel(i, { range: [snapValue(moved[0], d, integer && fine >= 1), snapValue(moved[1], d, integer && fine >= 1)] }, `window:${i}:${which}`, WHEEL_SETTLE_MS);
}

/** Set a channel's window outright (a handle drag). Keeps black below white. */
export function setWindow(i: number, range: [number, number], key = `window:${i}`): void {
  const c = liveContext(), ch = c?.view.channels[i];
  if (!c || !ch) return;
  const integer = integerData(c.manifest), gap = integer ? 1 : Math.abs(ch.range[1] - ch.range[0]) * 1e-6 || 1e-12;
  const lo = Math.min(range[0], range[1] - gap), hi = Math.max(range[1], lo + gap);
  if (Number.isFinite(lo) && Number.isFinite(hi)) setChannel(i, { range: [lo, hi] }, key);
}

export function nudgeGamma(i: number, steps: number): void {
  const c = liveContext(), ch = c?.view.channels[i];
  if (!c || !ch || !steps) return;
  const g = Math.min(5, Math.max(0.1, Number((ch.gamma * Math.pow(1.05, steps)).toFixed(3))));
  setChannel(i, g === 1 ? { gamma: null as unknown as undefined, norm: null as unknown as undefined } : { norm: "gamma", gamma: g }, `gamma:${i}`, WHEEL_SETTLE_MS);
}

/**
 * Auto contrast for one channel, or all of them, from the PIXELS IN VIEW: the plane (or projection) on screen,
 * inside the frame. The window snaps to their percentiles; pressing again tightens it (0.1–99.9 %, then 1–99.8 %,
 * 1–99 %), and a fourth press shows their full range. Before the first frame is on screen (or outside the live
 * view's canvas) the stack's stored percentiles stand in.
 */
export function autoContrast(i: number | "all"): void {
  const c = liveContext();
  if (!c) return;
  const which = i === "all" ? c.view.channels.map((ch) => ch.index) : [i];
  const integer = integerData(c.manifest);
  const seen = new Map<number, Float64Array>();
  for (const s of liveSampler.read?.() ?? []) {
    if (!which.includes(s.channel)) continue;
    const m = s.map, nodata = m && m.nodata !== null ? m.nodata : NaN;
    const decode = m ? (v: number): number => (v === nodata || v !== v ? NaN : m.add + m.mul * (v - m.sub)) : (v: number): number => v;
    const sorted = sortedSample(s.data, s.width, s.height, s.rect, decode);
    if (sorted.length >= 16) seen.set(s.channel, sorted);
  }
  // One step for all channels, taken from the first: "Auto" on a composite must not mix tightness between channels.
  const lead = c.view.channels[which[0]];
  const leadSample = lead ? seen.get(lead.index) : undefined;
  const step = !lead ? 0 : leadSample ? sampleStepOf(leadSample, lead.range, integer) + 1 : autoStepOf(c.manifest.channels[lead.index].stats, lead.range) + 1;
  const channels: Array<FluximgChannelView | null> = c.view.channels.map(() => null);
  for (const k of which) {
    const sorted = seen.get(k);
    let w = sorted ? sampleWindow(sorted, step) : null;
    if (w && integer) { w = [Math.round(w[0]), Math.round(w[1])]; if (!(w[1] > w[0])) w = null; }
    channels[k] = { range: w ?? autoWindow(c.manifest.channels[k].stats, step) };
  }
  liveView(`auto:${i}`, { channels });
  settleLiveEdit();
}

export function toggleChannel(i: number): void {
  const c = liveContext(), ch = c?.view.channels[i];
  if (!c || !ch) return;
  if (c.view.composite === "single") { liveView(`show:${i}`, { solo: i }); settleLiveEdit(); return; }
  // Stored only when it differs from what the image itself says (a channel may start hidden in the bundle).
  const byDefault = c.manifest.channels[i]?.visible !== false, next = !ch.visible;
  setChannel(i, { visible: next === byDefault ? (null as unknown as undefined) : next }, `show:${i}`);
  settleLiveEdit();
}

/** Show only this channel (again: back to the composite). */
export function soloChannel(i: number): void {
  const c = liveContext();
  if (!c) return;
  const on = c.view.composite === "single" && c.view.solo === i;
  liveView(`solo:${i}`, on ? { composite: null as unknown as undefined, solo: null as unknown as undefined } : { composite: "single", solo: i });
  settleLiveEdit();
}

export function resetChannel(i: number): void {
  const channels: Array<FluximgChannelView | null> = [];
  for (let k = 0; k < i; k++) channels.push(null);
  // Null fields clear the override: the manifest's own window, colour and norm come back.
  channels.push({ range: null, color: null, lut: null, norm: null, gamma: null, invert: null, visible: null } as unknown as FluximgChannelView);
  liveView(`reset:${i}`, { channels });
  settleLiveEdit();
}

// --- layers -------------------------------------------------------------------------------------

export function setLayer(id: string, patch: FluximgLayerView, key = `layer:${id}`, settleAfter = 0): void {
  liveView(key, { layers: { [id]: patch } }, settleAfter);
}
export function toggleLayer(id: string): void {
  const c = liveContext(), L = c?.view.layers.find((l) => l.id === id);
  if (!L) return;
  setLayer(id, { visible: !L.visible }, `layer-show:${id}`);
  settleLiveEdit();
}
export function nudgeLayerOpacity(id: string, steps: number): void {
  const c = liveContext(), L = c?.view.layers.find((l) => l.id === id);
  if (!L || !steps) return;
  const o = Math.min(1, Math.max(0, Math.round((L.opacity + steps * 0.05) * 100) / 100));
  if (o !== L.opacity) setLayer(id, { opacity: o }, `layer-opacity:${id}`, WHEEL_SETTLE_MS);
}
/** Move a layer one place up (+1, drawn later, on top) or down in the stack. */
export function moveLayer(id: string, by: 1 | -1): void {
  const c = liveContext();
  if (!c) return;
  const order = c.view.layers.map((l) => l.id), i = order.indexOf(id), j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  liveView(`layer-order:${id}`, { layerOrder: order });
  settleLiveEdit();
}

// --- furniture ----------------------------------------------------------------------------------

export type FurnitureKind = keyof FluximgFurnitureView;
export function toggleFurniture(kind: FurnitureKind): void {
  const c = liveContext();
  if (!c) return;
  const on = !!c.view.furniture[kind as keyof ResolvedView["furniture"]];
  // `{}` means "on, with defaults"; null clears it (off is the default).
  liveView(`furniture:${kind}`, { furniture: { [kind]: on ? null : {} } as FluximgFurnitureView });
  settleLiveEdit();
}
export function toggleSmooth(): void {
  const c = liveContext();
  if (!c) return;
  liveView("smooth", { smooth: c.view.smooth ? (null as unknown as undefined) : true });
  settleLiveEdit();
}

// --- the frame (crop as a viewport) ---------------------------------------------------------------

/**
 * Zoom the image inside its frame about an image point (level-0 pixels): the element keeps its box, the crop
 * shrinks or grows around the point and keeps the box's aspect. `factor` > 1 zooms in.
 */
export function zoomFrame(factor: number, about: { x: number; y: number } | null, key = "frame-zoom", settleAfter = WHEEL_SETTLE_MS): void {
  const c = liveContext();
  if (!c || !(factor > 0)) return;
  const full = fullCrop(c.manifest), old = c.crop;
  const ax = about ? about.x : old.x + old.width / 2, ay = about ? about.y : old.y + old.height / 2;
  // Never past one image pixel per 24 box pixels (beyond that nothing more is revealed), never larger than the image.
  const minW = Math.max(1, c.element.width / 24), aspect = old.height / old.width;
  let w = Math.min(full.width, Math.max(minW, old.width / factor)), h = w * aspect;
  if (h > full.height) { h = full.height; w = h / aspect; }
  let x = ax - ((ax - old.x) / old.width) * w, y = ay - ((ay - old.y) / old.height) * h;
  x = Math.min(full.width - w, Math.max(0, x)); y = Math.min(full.height - h, Math.max(0, y));
  writeFrame(c, { x, y, width: w, height: h }, key, settleAfter);
}

/** Pan the image inside its frame by image pixels. */
export function panFrame(dx: number, dy: number, key = "frame-pan", from?: PixelRect): void {
  const c = liveContext();
  if (!c) return;
  const full = fullCrop(c.manifest), base = from ?? c.crop;
  const x = Math.min(full.width - base.width, Math.max(0, base.x + dx)), y = Math.min(full.height - base.height, Math.max(0, base.y + dy));
  writeFrame(c, { x, y, width: base.width, height: base.height }, key, 0);
}

/**
 * Write a crop WITHOUT moving or resizing the element's box (ops.setCrop keeps the content still and moves the
 * box; a viewport change wants the opposite). The whole image is stored as "no crop".
 */
function writeFrame(c: LiveContext, crop: PixelRect, key: string, settleAfter: number): void {
  const full = fullCrop(c.manifest);
  const whole = crop.x <= 1e-6 && crop.y <= 1e-6 && crop.width >= full.width - 1e-6 && crop.height >= full.height - 1e-6;
  const id = c.element.id;
  liveMutate(key, (p) => {
    for (const f of p.figures) for (const e of f.elements) {
      if (e.id !== id || e.type !== "fluximg") continue;
      if (whole) delete e.crop; else e.crop = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    }
  }, settleAfter);
}

/** Show the whole image again, in the box it has (the box takes the image's aspect at its current width). */
export function resetFrame(): void {
  const c = liveContext();
  if (!c || !c.element.crop) return;
  liveCrop("frame-reset", null);
  settleLiveEdit();
}

// --- new elements -------------------------------------------------------------------------------

function elementFigure(p: Project, id: string): { figureId: string; element: FluximgElement } | null {
  for (const f of p.figures) for (const e of f.elements) if (e.id === id && e.type === "fluximg") return { figureId: f.id, element: e };
  return null;
}

/**
 * Split channels: one panel per channel to the right of the image (each showing that channel alone, in gray so
 * intensities read on a neutral scale), the composite staying where it is. One undo step.
 */
export function splitChannels(): void {
  const c = liveContext();
  if (!c) return;
  const n = c.view.channels.length;
  if (n < 2) { pushToast("info", "This image has one channel"); return; }
  const id = c.element.id, gap = 6;
  const created: string[] = [];
  liveMutate("split", (p) => {
    const found = elementFigure(p, id);
    const asset = p.assets.find((a) => a.id === c.element.assetId);
    if (!found || !asset) return;
    const src = found.element;
    // The composite and its channel panels move together from now on (position, projection, each channel's window).
    const link = src.view?.link ?? `split-${src.id}`;
    src.view = { ...(src.view ?? {}), link };
    for (let i = 0; i < n; i++) {
      const channels: Array<FluximgChannelView | null> = [];
      for (let k = 0; k < n; k++) channels.push(k === i ? { ...(src.view?.channels?.[k] ?? {}), lut: "gray", color: null as unknown as undefined } : (src.view?.channels?.[k] ?? null));
      const view: FluximgView = { ...structuredClone(src.view ?? {}), link, composite: "single", solo: i, channels, furniture: { channelLabels: {} } };
      const nid = addFluximg(p, {
        figureId: found.figureId, asset, x: src.x + (i + 1) * (src.width + gap), y: src.y, width: src.width,
        view, ...(src.crop ? { crop: { ...src.crop } } : {}), ...(src.source ? { source: structuredClone(src.source) } : {}),
      });
      const el = p.figures.find((f) => f.id === found.figureId)!.elements.find((e) => e.id === nid)!;
      el.height = src.height; el.name = `${src.name ?? asset.name} · ${c.view.channels[i].name}`;
      created.push(nid);
    }
  });
  settleLiveEdit();
  if (created.length) pushToast("info", `Split into ${created.length} channel panels`);
}

/**
 * Blow-out: a new panel beside the image showing the current frame, while the image itself returns to `restore`
 * (the frame it had before the region was chosen). The new panel remembers its parent, which draws its frame.
 */
export function makeInset(restore: CropRect | null): string | null {
  const c = liveContext();
  if (!c) return null;
  const full = fullCrop(c.manifest), region = c.crop;
  if (region.width >= full.width - 1e-6 && region.height >= full.height - 1e-6) { pushToast("info", "Zoom into a region first, then pull it out as an inset"); return null; }
  const id = c.element.id;
  let created: string | null = null;
  liveMutate("inset", (p) => {
    const found = elementFigure(p, id), asset = p.assets.find((a) => a.id === c.element.assetId);
    if (!found || !asset) return;
    const src = found.element;
    // A blow-out follows its parent through planes and contrast (it is the same picture, closer).
    const link = src.view?.link ?? `inset-${src.id}`;
    src.view = { ...(src.view ?? {}), link };
    const view: FluximgView = { ...structuredClone(src.view ?? {}), link, insetOf: src.id, furniture: { scalebar: {} } };
    created = addFluximg(p, {
      figureId: found.figureId, asset, x: src.x + src.width + 8, y: src.y, width: src.height * (region.width / region.height),
      view, crop: { x: region.x, y: region.y, width: region.width, height: region.height }, ...(src.source ? { source: structuredClone(src.source) } : {}),
    });
    const el = p.figures.find((f) => f.id === found.figureId)!.elements.find((e) => e.id === created)!;
    el.name = `${src.name ?? asset.name} · inset`;
    if (restore) src.crop = { ...restore }; else delete src.crop;
  });
  settleLiveEdit();
  return created;
}

// --- playback -----------------------------------------------------------------------------------

let playTimer = 0, playClock = 0, playCarry = 0, playDirection: 1 | -1 = 1;

/** Planes per second for a dimension: its real rate when it is time in seconds, else a steady 12. */
export function naturalRate(m: FluximgManifest, dim: string): number {
  const period = framePeriod(m.axes?.[dim]);
  return period ? 1 / period : 12;
}

export function stopPlayback(): void {
  if (playTimer) cancelAnimationFrame(playTimer);
  playTimer = 0;
  if (get(fluximgLive)?.playing) { setLive({ playing: null }); settleLiveEdit(); }
}

/** Play along a dimension at `fps` planes per second (default: its natural rate, capped to what a screen shows). */
export function togglePlayback(dim: string, mode: PlayMode = "loop", fps?: number): void {
  const live = get(fluximgLive);
  if (!live) return;
  if (live.playing) { stopPlayback(); return; }
  const c = liveContext();
  if (!c || dimLength(c.manifest, dim) <= 1 || c.view.projection?.dim === dim) return;
  const rate = fps ?? naturalRate(c.manifest, dim);
  setLive({ playing: { dim, fps: rate, mode }, armed: `pos:${dim}` });
  playClock = performance.now(); playCarry = 0; playDirection = 1;
  const tick = (now: number): void => {
    const state = get(fluximgLive), ctx = liveContext();
    if (!state?.playing || !ctx) { playTimer = 0; return; }
    // Advance by elapsed time, so a slow frame drops planes instead of slowing the movie down.
    playCarry += ((now - playClock) / 1000) * state.playing.fps;
    playClock = now;
    const advance = Math.floor(playCarry);
    if (advance > 0) {
      playCarry -= advance;
      const n = dimLength(ctx.manifest, dim);
      const next = playStep({ index: ctx.view.index[dim] ?? 0, direction: playDirection, done: false }, advance, n, state.playing.mode);
      playDirection = next.direction;
      liveView(`play:${dim}`, { index: { [dim]: next.index } });
      if (next.done) { stopPlayback(); return; }
    }
    playTimer = requestAnimationFrame(tick);
  };
  playTimer = requestAnimationFrame(tick);
}

// --- leaving ------------------------------------------------------------------------------------

/** Esc: back out one level. Returns true when something was backed out of (false = the caller closes the view). */
export function backOut(): boolean {
  const live = get(fluximgLive);
  if (!live) return false;
  if (live.playing) { stopPlayback(); return true; }
  if (live.zone !== "home") { cancelLiveEdit(); setLive({ zone: "home", armed: defaultArmed() }); return true; }
  return false;
}

/** What the wheel drives when nothing else has been asked for: the first rail, if the image has one. */
export function defaultArmed(): string | null {
  const c = liveContext();
  if (!c) return null;
  const dims = railDims(c.manifest);
  return dims.length ? `pos:${dims[0]}` : null;
}

