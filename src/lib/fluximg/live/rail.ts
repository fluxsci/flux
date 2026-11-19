/**
 * Navigator rail geometry: one dimension's positions laid along a track, and the plot of the stack drawn in it.
 *
 * Pure (no DOM, no Svelte). A rail runs along its ALONG axis for `extent` screen px and is `across` px thick;
 * a horizontal rail (time) has along = x, a vertical one (depth) has along = y. Each index owns an equal band of
 * the track and the playhead sits at the band's centre, so index 0 and the last index are never cut off at the ends.
 */
import type { FluximgAxis } from "../types";

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Centre of index `i`'s band, in px along the track. */
export function railPos(i: number, length: number, extent: number): number {
  return length <= 0 ? 0 : ((i + 0.5) / length) * extent;
}

/** The index whose band holds `pos`. */
export function railIndex(pos: number, length: number, extent: number): number {
  if (length <= 1 || !(extent > 0)) return 0;
  return clamp(Math.floor((pos / extent) * length), 0, length - 1);
}

/** Band edges of a run of planes (`from` inclusive, `to` exclusive), in px along the track. */
export function railSpan(from: number, to: number, length: number, extent: number): { start: number; end: number } {
  const f = clamp(Math.min(from, to), 0, length), t = clamp(Math.max(from, to), 0, length);
  return { start: (f / length) * extent, end: (t / length) * extent };
}

/** Physical position of an index, or null when the axis has none (a plain count, or named positions). */
export function axisValue(axis: FluximgAxis | undefined, i: number): number | null {
  if (!axis) return null;
  if (axis.coords && axis.coords[i] !== undefined) return axis.coords[i];
  if (typeof axis.scale === "number") return (axis.offset ?? 0) + axis.scale * i;
  return null;
}

const NICE = [1, 2, 5];
/** The smallest of 1, 2, 5 x 10^n that is at least `min`. */
export function niceStride(min: number): number {
  if (!(min > 1)) return 1;
  let p = Math.pow(10, Math.floor(Math.log10(min)));
  for (;;) {
    for (const m of NICE) if (m * p >= min - 1e-9) return m * p;
    p *= 10;
  }
}

export interface RailTick { index: number; pos: number; label: string }

/**
 * Sparse, evenly spaced ticks: every `stride`-th index, with at least `minGap` px between labels. The label is
 * the physical position when the axis has one (the unit is printed once by the rail, not on every tick), the
 * position's name for a categorical dimension, else the 1-based plane number.
 */
export function railTicks(axis: FluximgAxis | undefined, length: number, extent: number, format: (v: number) => string, minGap = 54): RailTick[] {
  if (length <= 0 || !(extent > 0)) return [];
  const stride = niceStride((length * minGap) / extent);
  const out: RailTick[] = [];
  for (let i = 0; i < length; i += stride) {
    const v = axisValue(axis, i);
    const label = axis?.labels?.[i] ?? (v !== null ? format(v) : String(i + 1));
    out.push({ index: i, pos: railPos(i, length, extent), label });
  }
  return out;
}

export interface ProfileShape {
  /** SVG path data in rail-local px (x along a horizontal rail; swapped for a vertical one). "" when empty. */
  d: string;
  /** True when the profile was reduced to a min/max envelope (more planes than pixels). */
  envelope: boolean;
}

/**
 * A channel's mean-per-plane profile as a path inside the rail. Values are normalized to the profile's own
 * range (every channel fills the rail, so shapes compare; magnitudes are the histogram's job). With more planes
 * than pixels the path is a filled min/max envelope, one column per pixel, so a spike in a 10,000-frame movie
 * still shows. A null (a plane with no data) breaks the line.
 *
 * `vertical` rails run top to bottom along y, and their value axis grows to the RIGHT.
 */
export function profileShape(values: ReadonlyArray<number | null>, extent: number, across: number, vertical: boolean, pad = 3): ProfileShape {
  const n = values.length;
  if (!n || !(extent > 0) || !(across > 0)) return { d: "", envelope: false };
  let lo = Infinity, hi = -Infinity;
  for (const v of values) if (v !== null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(lo <= hi)) return { d: "", envelope: false };
  const span = hi - lo || 1, room = Math.max(1, across - 2 * pad);
  // Horizontal: large values go UP (small y). Vertical: large values go RIGHT (large x).
  const q = (v: number): number => { const t = (v - lo) / span; return vertical ? pad + t * room : across - pad - t * room; };
  const pt = (a: number, c: number): string => (vertical ? `${r2(c)} ${r2(a)}` : `${r2(a)} ${r2(c)}`);
  const cols = Math.max(1, Math.floor(extent));
  if (n <= cols) {
    let d = "", pen = false;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || !Number.isFinite(v)) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${pt(railPos(i, n, extent), q(v))}`;
      pen = true;
    }
    // A single plane has no line to draw: a short tick marks its level.
    if (n === 1 && d) d += `l${vertical ? "0 0.01" : "0.01 0"}`;
    return { d, envelope: false };
  }
  // One min/max pair per pixel column; runs of columns with data become closed bands.
  const mins = new Float64Array(cols).fill(Infinity), maxs = new Float64Array(cols).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    const c = Math.min(cols - 1, Math.floor((i / n) * cols));
    if (v < mins[c]) mins[c] = v;
    if (v > maxs[c]) maxs[c] = v;
  }
  let d = "";
  const step = extent / cols;
  let c = 0;
  while (c < cols) {
    if (!(mins[c] <= maxs[c])) { c++; continue; }
    let e = c;
    while (e + 1 < cols && mins[e + 1] <= maxs[e + 1]) e++;
    let top = "", bottom = "";
    for (let k = c; k <= e; k++) top += `${k === c ? "M" : "L"}${pt((k + 0.5) * step, q(maxs[k]))}`;
    for (let k = e; k >= c; k--) bottom += `L${pt((k + 0.5) * step, q(mins[k]))}`;
    d += `${top}${bottom}Z`;
    c = e + 1;
  }
  return { d, envelope: true };
}

const r2 = (v: number): string => String(Math.round(v * 100) / 100);

/** Step a position by wheel notches or arrow keys, staying inside the dimension. */
export function stepIndex(i: number, steps: number, length: number): number {
  return clamp(Math.round(i + steps), 0, Math.max(0, length - 1));
}

/**
 * Grow or shrink a projection run around its centre by `steps` planes on each side, never below one plane and
 * never outside the dimension. Returns [from, to) .
 */
export function resizeRun(from: number, to: number, steps: number, length: number): [number, number] {
  let f = Math.round(from - steps), t = Math.round(to + steps);
  if (t - f < 1) { const mid = Math.round((from + to - 1) / 2); f = mid; t = mid + 1; }
  f = clamp(f, 0, length - 1); t = clamp(t, f + 1, length);
  return [f, t];
}

/** Slide a projection run by `steps` planes, keeping its length. */
export function slideRun(from: number, to: number, steps: number, length: number): [number, number] {
  const n = Math.max(1, to - from);
  const f = clamp(Math.round(from + steps), 0, Math.max(0, length - n));
  return [f, f + n];
}

/** How playback advances: `loop` wraps, `bounce` reverses at the ends, `once` stops on the last plane. */
export type PlayMode = "loop" | "bounce" | "once";
export interface PlayState { index: number; direction: 1 | -1; done: boolean }

/** The position after `advance` planes of playback from `state` (advance may exceed the dimension's length). */
export function playStep(state: PlayState, advance: number, length: number, mode: PlayMode): PlayState {
  if (length <= 1 || advance <= 0) return { ...state, done: length <= 1 };
  let { index, direction } = state;
  if (mode === "loop") return { index: (((index + advance) % length) + length) % length, direction: 1, done: false };
  if (mode === "once") { const i = Math.min(length - 1, index + advance); return { index: i, direction: 1, done: i >= length - 1 }; }
  // Bounce: walk a triangle wave of period 2 (length - 1).
  const period = 2 * (length - 1);
  let phase = direction === 1 ? index : period - index;
  phase = (phase + advance) % period;
  if (phase <= length - 1) { index = phase; direction = 1; } else { index = period - phase; direction = -1; }
  return { index, direction, done: false };
}

/** Seconds between planes of a time-like axis, or null when it is not evenly spaced in seconds. */
export function framePeriod(axis: FluximgAxis | undefined): number | null {
  if (!axis) return null;
  const unit = (axis.unit ?? "").trim();
  const k = unit === "s" || unit === "sec" || unit === "second" || unit === "seconds" ? 1 : unit === "ms" ? 1e-3 : unit === "min" ? 60 : unit === "h" ? 3600 : 0;
  if (!k) return null;
  if (typeof axis.scale === "number" && axis.scale > 0) return axis.scale * k;
  const c = axis.coords;
  if (c && c.length > 1) { const dt = (c[c.length - 1] - c[0]) / (c.length - 1); return dt > 0 ? dt * k : null; }
  return null;
}
