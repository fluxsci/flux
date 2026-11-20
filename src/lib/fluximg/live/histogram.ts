/**
 * Channel-histogram geometry for the live view's contrast control: where values sit along the control, the
 * histogram's outline, the transfer curve, and the "Auto" windows. Pure (no DOM, no Svelte).
 *
 * The manifest's histogram covers the channel's 0.1 .. 99.9 percentiles in 256 bins. The control's DOMAIN is
 * wider whenever a handle or the data's true extremes lie outside that, so a handle is never off the control.
 */
import type { FluximgHistogram, FluximgStats } from "../types";

export interface HistDomain { lo: number; hi: number }

const finite = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The value range the control spans: the histogram's own range, widened to hold both handles, with a little
 * room past each handle so it can still be dragged outward. Never empty.
 */
export function histDomain(stats: FluximgStats, range: readonly [number, number]): HistDomain {
  let lo = finite(stats.hist?.lo) ? stats.hist.lo : stats.min;
  let hi = finite(stats.hist?.hi) ? stats.hist.hi : stats.max;
  if (!finite(lo) || !finite(hi)) { lo = 0; hi = 1; }
  if (hi <= lo) { lo = Math.min(lo, stats.min); hi = Math.max(hi, stats.max); }
  if (hi <= lo) hi = lo + 1;
  const a = Math.min(range[0], range[1]), b = Math.max(range[0], range[1]);
  const pad = 0.04 * (Math.max(hi, b) - Math.min(lo, a));
  if (finite(a) && a < lo) lo = a - pad;
  if (finite(b) && b > hi) hi = b + pad;
  return { lo, hi };
}

export function valueToX(v: number, d: HistDomain, width: number): number {
  return ((v - d.lo) / (d.hi - d.lo)) * width;
}
export function xToValue(x: number, d: HistDomain, width: number): number {
  return d.lo + (x / width) * (d.hi - d.lo);
}

/**
 * The histogram as a closed area path, `width` x `height` px, baseline at the bottom. Counts are log-scaled,
 * since a microscope image is mostly background and a linear histogram is one spike. The area
 * is stepped (one flat top per bin), which is what a histogram is; bins narrower than a pixel merge by maximum.
 */
export function histogramPath(hist: FluximgHistogram | undefined, d: HistDomain, width: number, height: number, scale: "span" | "log" | "linear" = "span"): string {
  const counts = hist?.counts;
  if (!counts?.length || !(width > 0) || !(height > 0) || !(hist!.hi > hist!.lo)) return "";
  let most = 0, least = Infinity;
  for (const c of counts) { if (c > most) most = c; if (c > 0 && c < least) least = c; }
  if (!(most > 0)) return "";
  // `span`: the log of the count, drawn between the rarest occupied bin and the commonest. A plain log scale
  // measures from a count of 1, so an image whose every bin holds thousands of pixels is a solid block; this way
  // the same image has a shape, at a word's height as well as at full size. A nearly flat histogram IS flat.
  const floor = Math.log(least) - 1, spread = Math.log(most) - floor;
  const f = scale === "log" ? Math.log1p
    : scale === "span" && most / least >= 4 ? (c: number): number => (c > 0 ? (Math.log(c) - floor) / spread : 0)
    : (c: number): number => c;
  let peak = 0;
  for (const c of counts) { const v = f(c); if (v > peak) peak = v; }
  if (!(peak > 0)) return "";
  const n = counts.length, bw = (hist!.hi - hist!.lo) / n;
  const x0 = valueToX(hist!.lo, d, width), x1 = valueToX(hist!.hi, d, width);
  // Never a hairline spike at the very top: leave 2 px of headroom.
  const usable = Math.max(1, height - 2);
  const y = (c: number): number => height - (f(c) / peak) * usable;
  const px = Math.max(1, Math.round(x1 - x0));
  let dPath = `M${r2(x0)} ${height}`;
  if (px >= n) {
    for (let i = 0; i < n; i++) {
      const xa = valueToX(hist!.lo + i * bw, d, width), xb = valueToX(hist!.lo + (i + 1) * bw, d, width), yy = r2(y(counts[i]));
      dPath += `L${r2(xa)} ${yy}L${r2(xb)} ${yy}`;
    }
  } else {
    for (let c = 0; c < px; c++) {
      const a = Math.floor((c / px) * n), b = Math.max(a + 1, Math.floor(((c + 1) / px) * n));
      let m = 0;
      for (let i = a; i < b && i < n; i++) if (counts[i] > m) m = counts[i];
      const xa = x0 + (c / px) * (x1 - x0), xb = x0 + ((c + 1) / px) * (x1 - x0), yy = r2(y(m));
      dPath += `L${r2(xa)} ${yy}L${r2(xb)} ${yy}`;
    }
  }
  return `${dPath}L${r2(x1)} ${height}Z`;
}

/**
 * The transfer curve: displayed brightness (0 at the bottom, 1 at the top) against value, as an open path.
 * Flat at 0 below the black point and at 1 above the white point; the shape between is the norm's.
 */
export function transferPath(range: readonly [number, number], norm: "linear" | "log" | "gamma", gamma: number, d: HistDomain, width: number, height: number, samples = 48): string {
  const [b, w] = range;
  if (!(w > b) || !(width > 0) || !(height > 0)) return "";
  const xb = valueToX(b, d, width), xw = valueToX(w, d, width);
  const map = (t: number): number => {
    if (norm === "gamma") return Math.pow(t, gamma > 0 ? gamma : 1);
    if (norm === "log") {
      // The same shape colorscale's log norm gives a positive window; a window touching zero falls back to linear.
      if (!(b > 0)) return t;
      const v = b + t * (w - b);
      return Math.log(v / b) / Math.log(w / b);
    }
    return t;
  };
  let p = `M0 ${height}L${r2(xb)} ${height}`;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    p += `L${r2(xb + t * (xw - xb))} ${r2(height - map(t) * height)}`;
  }
  return `${p}L${r2(width)} 0`;
}

/**
 * The share of the channel's values at or below `v` (0 .. 1), read off the manifest's histogram. The histogram
 * spans the 0.1 .. 99.9 percentiles, so it holds the middle 99.8 % and each tail beyond it is its 0.1 %, spread
 * evenly out to the data's true extreme. Null when the image carries no usable histogram.
 */
export function shareBelow(stats: FluximgStats, v: number): number | null {
  const h = stats.hist, counts = h?.counts;
  if (!counts?.length || !finite(h.lo) || !finite(h.hi) || !(h.hi > h.lo) || !finite(v)) return null;
  let total = 0;
  for (const c of counts) total += c;
  if (!(total > 0)) return null;
  const TAIL = 0.001;
  if (v < h.lo) return finite(stats.min) && stats.min < h.lo ? TAIL * Math.min(1, Math.max(0, (v - stats.min) / (h.lo - stats.min))) : 0;
  if (v >= h.hi) return finite(stats.max) && stats.max > h.hi ? 1 - TAIL * Math.min(1, Math.max(0, (stats.max - v) / (stats.max - h.hi))) : 1;
  const at = ((v - h.lo) / (h.hi - h.lo)) * counts.length, whole = Math.floor(at);
  let below = 0;
  for (let i = 0; i < whole; i++) below += counts[i];
  below += (counts[whole] ?? 0) * (at - whole);
  return TAIL + (1 - 2 * TAIL) * (below / total);
}

/**
 * What a display window clips, as shares of the channel's values (0 .. 1): `black` shown as the map's first
 * colour (at or below the black point), `white` as its last (at or above the white point). Null without a histogram.
 */
export function clippedShares(stats: FluximgStats, range: readonly [number, number]): { black: number; white: number } | null {
  const b = shareBelow(stats, range[0]), w = shareBelow(stats, range[1]);
  return b === null || w === null ? null : { black: b, white: 1 - w };
}

/** A share as the panel prints it: "0 %", "<0.1 %", "0.4 %", "12 %". */
export function formatShare(share: number): string {
  const p = share * 100;
  if (!(p > 0)) return "0 %";
  if (p < 0.1) return "<0.1 %";
  if (p > 99.9 && p < 100) return ">99.9 %";
  return `${p < 10 ? Number(p.toFixed(1)) : Math.round(p)} %`;
}

/** The percentile pairs "Auto" walks through, gentlest first; the last entry is the full data range. */
export const AUTO_STEPS: ReadonlyArray<readonly [string, string] | "full"> = [["0.1", "99.9"], ["1", "99.8"], ["1", "99"], "full"];

/** The window for Auto step `step` (wraps). Falls back to min .. max when a percentile is missing or the pair is empty. */
export function autoWindow(stats: FluximgStats, step: number): [number, number] {
  const s = AUTO_STEPS[((step % AUTO_STEPS.length) + AUTO_STEPS.length) % AUTO_STEPS.length];
  if (s !== "full") {
    const lo = stats.percentiles?.[s[0]], hi = stats.percentiles?.[s[1]];
    if (finite(lo) && finite(hi) && hi > lo) return [lo, hi];
  }
  return stats.max > stats.min ? [stats.min, stats.max] : [stats.min, stats.min + 1];
}

/** The percentile pairs of `AUTO_STEPS` as numbers (the last step is the sample's full range). */
const AUTO_PERCENT: ReadonlyArray<readonly [number, number]> = [[0.1, 99.9], [1, 99.8], [1, 99], [0, 100]];

/**
 * The valid VALUES of a plane inside a rectangle, sorted, thinned to at most `cap` by a regular stride (so a
 * 4-megapixel plane costs a few milliseconds, once, on a key press). `decode` turns a stored sample into a value
 * or NaN.
 */
export function sortedSample(data: ArrayLike<number>, width: number, height: number, rect: { x: number; y: number; width: number; height: number }, decode: (s: number) => number, cap = 200_000): Float64Array {
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width)), y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  const n = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (!n) return new Float64Array(0);
  // A stride along each axis, so the thinning never lines up with a scan pattern along one of them.
  const stride = Math.max(1, Math.ceil(Math.sqrt(n / cap)));
  const out = new Float64Array(Math.ceil((x1 - x0) / stride) * Math.ceil((y1 - y0) / stride));
  let k = 0;
  for (let y = y0; y < y1; y += stride) {
    const row = y * width;
    for (let x = x0; x < x1; x += stride) { const v = decode(data[row + x]); if (v === v) out[k++] = v; }
  }
  return out.subarray(0, k).sort();
}

/** The Auto window for step `step` (wraps) from a sorted sample; null when the sample cannot give one. */
export function sampleWindow(sorted: Float64Array, step: number): [number, number] | null {
  const n = sorted.length;
  if (n < 2) return null;
  const [lo, hi] = AUTO_PERCENT[((step % AUTO_PERCENT.length) + AUTO_PERCENT.length) % AUTO_PERCENT.length];
  const at = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))))];
  const a = at(lo), b = at(hi);
  if (b > a) return [a, b];
  // A flat percentile pair (mostly background): fall back to the sample's full range, if it has one.
  return sorted[n - 1] > sorted[0] ? [sorted[0], sorted[n - 1]] : null;
}

/**
 * The Auto step the next press shows, for a sorted sample: the first step after the current window's whose
 * window is DIFFERENT (see `nextAutoStep`: coinciding percentiles must not make the ladder stick).
 */
export function nextSampleStep(sorted: Float64Array, range: readonly [number, number], integer = false): number {
  const n = AUTO_PERCENT.length;
  const windowAt = (i: number): [number, number] | null => {
    const w = sampleWindow(sorted, i);
    return w && integer ? [Math.round(w[0]), Math.round(w[1])] : w;
  };
  const same = (w: readonly [number, number] | null): boolean => {
    if (!w) return false;
    const tol = 1e-9 * Math.max(1, Math.abs(w[0]), Math.abs(w[1]));
    return Math.abs(w[0] - range[0]) <= tol && Math.abs(w[1] - range[1]) <= tol;
  };
  let at = -1;
  for (let i = 0; i < n; i++) if (same(windowAt(i))) at = i;
  for (let k = 1; k <= n; k++) { const i = (at + k) % n; if (!same(windowAt(i))) return i; }
  return Math.max(0, at);
}

/** Which Auto step of a sorted sample a window already is, or -1. */
export function sampleStepOf(sorted: Float64Array, range: readonly [number, number], integer = false): number {
  for (let i = 0; i < AUTO_PERCENT.length; i++) {
    const w = sampleWindow(sorted, i);
    if (!w) continue;
    const a = integer ? Math.round(w[0]) : w[0], b = integer ? Math.round(w[1]) : w[1];
    const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - range[0]) <= tol && Math.abs(b - range[1]) <= tol) return i;
  }
  return -1;
}

/** Which Auto step a window already is (so the next press moves on), or -1. */
export function autoStepOf(stats: FluximgStats, range: readonly [number, number]): number {
  for (let i = 0; i < AUTO_STEPS.length; i++) {
    const w = autoWindow(stats, i), tol = 1e-9 * Math.max(1, Math.abs(w[0]), Math.abs(w[1]));
    if (Math.abs(w[0] - range[0]) <= tol && Math.abs(w[1] - range[1]) <= tol) return i;
  }
  return -1;
}

/**
 * The Auto step the next press shows: the first after the current window's step whose window is DIFFERENT. Two
 * percentiles often coincide (8-bit data: 1 % and 0.1 % are both 0), and stepping onto an identical window made
 * the ladder stick there for ever: every press after it changed nothing. When every step is the same window, it
 * stays.
 */
export function nextAutoStep(stats: FluximgStats, range: readonly [number, number]): number {
  const n = AUTO_STEPS.length;
  const same = (w: readonly [number, number]): boolean => {
    const tol = 1e-9 * Math.max(1, Math.abs(w[0]), Math.abs(w[1]));
    return Math.abs(w[0] - range[0]) <= tol && Math.abs(w[1] - range[1]) <= tol;
  };
  let at = -1;
  for (let i = 0; i < n; i++) if (same(autoWindow(stats, i))) at = i; // the LAST step showing this window
  for (let k = 1; k <= n; k++) { const i = (at + k) % n; if (!same(autoWindow(stats, i))) return i; }
  return Math.max(0, at);
}

/**
 * One wheel notch for a handle: about a hundredth of the control's span, snapped to 1, 2, 5 x 10^n so the
 * numbers stay readable. Integer data never moves by less than 1.
 */
export function nudgeStep(d: HistDomain, integer: boolean): number {
  const raw = (d.hi - d.lo) / 100;
  if (!(raw > 0)) return integer ? 1 : 0.01;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  return integer ? Math.max(1, Math.round(step)) : Number(step.toPrecision(12));
}

/** Round a handle value to the precision the control can show: integers for integer data, 4 significant steps else. */
export function snapValue(v: number, d: HistDomain, integer: boolean): number {
  if (integer) return Math.round(v);
  const span = d.hi - d.lo;
  if (!(span > 0)) return v;
  const q = Math.pow(10, Math.floor(Math.log10(span)) - 3);
  return Number((Math.round(v / q) * q).toPrecision(12));
}

/**
 * Move one end of the window, keeping black strictly below white by at least `minGap`.
 * `which`: 0 = black point, 1 = white point, 2 = slide both (the window keeps its width).
 */
export function moveWindow(range: readonly [number, number], which: 0 | 1 | 2, delta: number, minGap: number): [number, number] {
  let [b, w] = range;
  if (which === 2) return [b + delta, w + delta];
  if (which === 0) b = Math.min(b + delta, w - minGap); else w = Math.max(w + delta, b + minGap);
  return [b, w];
}

const r2 = (v: number): string => String(Math.round(v * 100) / 100);
