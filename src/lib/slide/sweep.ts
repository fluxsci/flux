// T8 x-clock sweep: PURE geometry for a data line that is revealed at a constant x rate (eased progress t == the
// front's normalised x), not at constant arc length. DOM-free (the player parses `d`, this module does the math) so a
// headless gate can pin pen-to-line accuracy. Keyframe OFFSETS live in eased space (player frameSampler), so the
// slide's `curve` is the front's x-clock.
/** A vertex; `move` marks the start of a later subpath (a NaN gap in the data: the pen lifts, the jump lays no length). */
export interface XY { x: number; y: number; move?: boolean }
export interface SweepSample { x: number; y: number; s: number }

/** An absolute M/L polyline (matplotlib's line path; a NaN gap starts a new `M` subpath); null for anything else (curves, relative
 *  commands, a close). */
export function parsePolyline(d: string | null | undefined): XY[] | null {
  if (!d) return null;
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/g);
  if (!tokens || tokens[0] !== "M") return null;
  const pts: XY[] = [];
  let i = 0;
  while (i < tokens.length) {
    const c = tokens[i++];
    if (c !== "M" && c !== "L") return null;
    // numbers until the next letter; after an M, further pairs are implicit L
    let first = c === "M" && pts.length > 0;
    while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
      const x = Number(tokens[i]), y = Number(tokens[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      pts.push(first ? { x, y, move: true } : { x, y }); first = false; i += 2;
    }
  }
  return pts.length >= 2 ? pts : null;
}

/** Cumulative arc length per vertex (a subpath jump lays none: the dash runs on the drawn length only), x made monotone by a running max/min. Returns null when x runs backwards by more
 *  than `tol` of the span (a loop or a reversing line has no x clock) or the line has no x extent. */
export function sweepSamples(pts: readonly XY[], tol = 0.003): SweepSample[] | null {
  if (pts.length < 2) return null;
  const x0 = pts[0].x, span = pts[pts.length - 1].x - x0;
  if (!(Math.abs(span) > 1e-6)) return null;
  const dir = Math.sign(span), slack = Math.abs(span) * tol;
  let run = x0, s = 0;
  const out: SweepSample[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i && !pts[i].move) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if ((pts[i].x - run) * dir < -slack) return null;
    run = dir > 0 ? Math.max(run, pts[i].x) : Math.min(run, pts[i].x);
    out.push({ x: run, y: pts[i].y, s });
  }
  return out;
}

/** Bound the keyframe count: past `max` samples keep, per x bucket, the first, last, min-y and max-y vertex (so spikes
 *  survive and the pen never cuts a corner by more than a bucket's width in x). */
export function decimateSweep(samples: readonly SweepSample[], max = 4000, buckets = 1000): SweepSample[] {
  if (samples.length <= max) return samples.slice();
  const x0 = samples[0].x, span = samples[samples.length - 1].x - x0, keep = new Set<number>([0, samples.length - 1]);
  let b = -1, first = 0, lo = 0, hi = 0;
  const flush = (last: number) => { keep.add(first); keep.add(lo); keep.add(hi); keep.add(last); };
  samples.forEach((p, i) => {
    const bi = Math.min(buckets - 1, Math.floor(Math.abs((p.x - x0) / span) * buckets));
    if (bi !== b) { if (b >= 0) flush(i - 1); b = bi; first = lo = hi = i; }
    else { if (p.y < samples[lo].y) lo = i; if (p.y > samples[hi].y) hi = i; }
  });
  flush(samples.length - 1);
  return [...keep].sort((a, c) => a - c).map(i => samples[i]);
}

export interface SweepKeys { offset: number; s: number; x: number; y: number }
/** The x range a sweep's clock runs over: by default the line's own [first x, last x]; several lines drawn by ONE track share the union
 *  of theirs, so one front crosses them all at one x rate (a line that starts later is untouched until the front reaches it). */
export interface SweepFrame { x0: number; span: number }
export const ownFrame = (samples: readonly SweepSample[]): SweepFrame => ({ x0: samples[0].x, span: samples[samples.length - 1].x - samples[0].x });
/** The union frame of several lines running the same way, or null when they run opposite ways (each keeps its own frame then). */
export function unionFrame(lines: readonly (readonly SweepSample[])[]): SweepFrame | null {
  const frames = lines.map(ownFrame), dir = Math.sign(frames[0]?.span ?? 0);
  if (!dir || frames.some((f) => Math.sign(f.span) !== dir)) return null;
  const ends = frames.flatMap((f) => [f.x0, f.x0 + f.span]), lo = Math.min(...ends), hi = Math.max(...ends);
  return dir > 0 ? { x0: lo, span: hi - lo } : { x0: hi, span: lo - hi };
}
/** Strictly increasing offsets (normalised x in `frame`). A vertical run (same x, longer s) keeps its LONGEST s at that x, and the
 *  pen keeps its LAST y there; the pen never goes backwards. In its own frame a line's keys run 0..1 exactly. */
export function sweepKeys(samples: readonly SweepSample[], frame: SweepFrame = ownFrame(samples)): SweepKeys[] {
  const own = frame.x0 === samples[0].x && frame.span === samples[samples.length - 1].x - samples[0].x;
  const { x0, span } = frame, out: SweepKeys[] = [];
  for (const p of samples) {
    const at = Math.max(0, Math.min(1, (p.x - x0) / span));
    if (out.length && at <= out[out.length - 1].offset + 1e-6) { Object.assign(out[out.length - 1], { s: p.s, y: p.y }); continue; }
    out.push({ offset: at, s: p.s, x: p.x, y: p.y });
  }
  if (own) { out[0].offset = 0; out[out.length - 1].offset = 1; }
  return out;
}

/** Interpolate the keys at normalised x `at` (what a sampler does between two keyframes): the dash length and the pen. */
export function sweepAt(keys: readonly SweepKeys[], at: number): { s: number; x: number; y: number } {
  if (at <= keys[0].offset) return keys[0]; if (at >= keys[keys.length - 1].offset) return keys[keys.length - 1];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].offset <= at) lo = m; else hi = m; }
  const a = keys[lo], b = keys[hi], u = (at - a.offset) / (b.offset - a.offset || 1);
  return { s: a.s + (b.s - a.s) * u, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/** Darken a #rgb[a] / #rrggbb[aa] / rgb[a]() colour by factor f (0..1) for the lead dot; anything else is returned unchanged. */
export function darken(color: string, f = 0.35): string {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim()); // alpha digits are dropped: the lead dot is opaque
  let rgb: number[] | null = null;
  if (hex) { const h = hex[1].length <= 4 ? [...hex[1]].map(c => c + c).join("") : hex[1]; rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
  else { const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(color.trim()); if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])]; }
  return rgb ? `rgb(${rgb.map(v => Math.round(v * (1 - f))).join(",")})` : color;
}

/** Do these (pixel) coordinates stray from even spacing by more than `tol` of the mean step (T8: 3 %)? Only then do a sweep's markers
 *  need `Stagger.spacing: "true"` to appear at the pen: evenly spaced markers already do with ordinal ranks, and the deck keeps the
 *  fields every build reads. */
export const SWEEP_SPACING_TOL = 0.03;
export function sweepSpacingNeeded(coords: readonly (number | null)[], tol = SWEEP_SPACING_TOL): boolean {
  const xs = coords.filter((c): c is number => c != null && Number.isFinite(c)).sort((a, b) => a - b);
  if (xs.length < 3) return false;
  const step = (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
  return step > 0 && xs.some((x, i) => Math.abs(x - (xs[0] + i * step)) > tol * step);
}

/** The one sweep duration per plot PANEL (all its sweep series share the clock): stage units of x extent x 2.8 ms,
 *  clamped, rounded to 100 ms, never below the profile's drawOn floor. */
export const SWEEP_MS_PER_UNIT = 2.8, SWEEP_MIN_MS = 1000, SWEEP_MAX_MS = 2000;
export function sweepDuration(xExtentStageUnits: number, floorMs = 0): number {
  const raw = Number.isFinite(xExtentStageUnits) && xExtentStageUnits > 0 ? xExtentStageUnits * SWEEP_MS_PER_UNIT : 1600;
  return Math.round(Math.max(floorMs, Math.min(SWEEP_MAX_MS, Math.max(SWEEP_MIN_MS, raw))) / 100) * 100;
}
