// ---------------------------------------------------------------------------
// Flux Slide — TRIM PATHS (animation rework §5): the full dash math behind the
// enriched drawOn/drawOff. Pure and DOM-free (unit-gated by verify-trim.ts);
// presets.ts feeds it measured geometry and turns the result into WAAPI
// keyframes (strokeDasharray/strokeDashoffset are already in the player's
// animated-prop set, and dasharray LISTS keep the same entry count across
// keyframes so WAAPI interpolates them numerically).
//
// The model: at progress p ∈ [0,1] a visible WINDOW of the stroke grows out of
// an ANCHOR point, in a MODE, within the final [from,to] sub-window. All
// window edges are piecewise-linear in p, so 2 keyframes suffice — 3 when a
// side saturates against a window edge mid-animation (the "knee"). Keyframe
// offsets live in eased-progress space, so any easing keeps the math exact.
//
// Semantics (documented here, pinned by the gate):
//  • open paths: [from,to] clamps the final window in PATH fractions; the
//    anchor is a full-path fraction clamped into it.
//      – single: grow from the anchor in `direction`; when that side hits the
//        window edge the remainder SPILLS to the other side (knee).
//      – both-ends: grow from the window's two ENDS, meet in the middle
//        (anchor ignored).
//      – middle-out: grow symmetrically about the anchor, per-side clamping
//        against the window edges (knee when the anchor is off-center).
//  • closed paths: no ends — `from`/`to` set the final arc LENGTH
//    (to − from)·L and the anchor sets its position: single grows the arc
//    from the anchor (forward/reverse), both-ends/middle-out grow it
//    symmetrically about the anchor. Everything is exactly linear (offset
//    rides the pattern), so always 2 keyframes.
//  • enter=false (drawOff) plays the same window math backwards.
// ---------------------------------------------------------------------------

export interface TrimSpec {
  /** Effective total path length — an explicit `pathLength` attribute when
   *  present (dash units must match it), else the measured length. */
  len: number;
  closed: boolean;
  /** Growth origin, 0..1 along the path (use resolveAnchor for named forms). */
  anchor: number;
  direction: "forward" | "reverse";
  mode: "single" | "both-ends" | "middle-out";
  /** Final window, 0..1 path fractions (defaults 0..1 = the whole stroke). */
  from: number;
  to: number;
}

export interface TrimKeyframe {
  /** WAAPI keyframe offset (present only on 3-keyframe knees). */
  offset?: number;
  strokeDasharray: string;
  strokeDashoffset: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmt = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
const dasharray = (parts: number[]) => parts.map((v) => String(fmt(Math.max(0, v)))).join(" ");

/** Are these params the legacy default draw (anchor start, forward, single,
 *  full window)? presets.ts uses this to keep old decks byte-identical (the
 *  legacy compile path animates offset over a constant dasharray). */
export function isDefaultTrim(p: { anchor?: unknown; direction?: unknown; mode?: unknown; from?: unknown; to?: unknown } | undefined): boolean {
  if (!p) return true;
  const anchorDefault = p.anchor == null || p.anchor === 0 || p.anchor === "start";
  return (
    anchorDefault &&
    (p.direction == null || p.direction === "forward") &&
    (p.mode == null || p.mode === "single") &&
    (p.from == null || p.from === 0) &&
    (p.to == null || p.to === 1)
  );
}

// --- named anchors ------------------------------------------------------------

export interface AnchorGeo {
  /** Lowercase svg tag of the strokable geometry ("rect" | "ellipse" |
   *  "circle" | "path" | "line" | "polyline" | "polygon"). */
  tag: string;
  width?: number;
  height?: number;
}

/** Resolve an anchor param (number 0..1 or a named position) to a path
 *  fraction for the given geometry. Conventions follow the SVG stroke origin:
 *  rects start at the TOP-LEFT corner and run clockwise; ellipses/circles
 *  start at 3 o'clock and sweep clockwise (screen coords); paths/lines run
 *  start → end. Unknown names fall back to 0. */
export function resolveAnchor(anchor: number | string | undefined, geo: AnchorGeo): number {
  if (anchor == null) return 0;
  if (typeof anchor === "number") return clamp(anchor, 0, 1);
  const name = anchor.trim().toLowerCase();
  const num = Number(name);
  if (Number.isFinite(num) && name !== "") return clamp(num, 0, 1);
  if (geo.tag === "rect") {
    const w = Math.max(1e-6, geo.width ?? 1);
    const h = Math.max(1e-6, geo.height ?? 1);
    const P = 2 * (w + h);
    const at: Record<string, number> = {
      "corner-tl": 0, start: 0,
      top: w / 2 / P,
      "corner-tr": w / P,
      right: (w + h / 2) / P,
      "corner-br": (w + h) / P, middle: (w + h) / P,
      bottom: (w + h + w / 2) / P,
      "corner-bl": (2 * w + h) / P,
      left: (2 * w + h + h / 2) / P,
      end: 1,
    };
    return at[name] ?? 0;
  }
  if (geo.tag === "ellipse" || geo.tag === "circle") {
    const at: Record<string, number> = {
      right: 0, start: 0,
      "corner-br": 0.125,
      bottom: 0.25,
      "corner-bl": 0.375,
      left: 0.5, middle: 0.5,
      "corner-tl": 0.625,
      top: 0.75,
      "corner-tr": 0.875,
      end: 1,
    };
    return at[name] ?? 0;
  }
  const at: Record<string, number> = { start: 0, end: 1, middle: 0.5, top: 0, left: 0, bottom: 1, right: 1 };
  return at[name] ?? 0;
}

// --- the window math ----------------------------------------------------------

/** The visible window [lo, hi) (full-path arc units) at progress p for the
 *  single/middle-out modes (both-ends builds its two dashes directly in
 *  openKeyframe). Open paths only — closed paths use the offset form below. */
function openWindow(spec: TrimSpec, p: number): { lo: number; hi: number } {
  const L = spec.len;
  const F = clamp(Math.min(spec.from, spec.to), 0, 1) * L;
  const T = clamp(Math.max(spec.from, spec.to), 0, 1) * L;
  const Lw = Math.max(0, T - F);
  const A = clamp(spec.anchor * L, F, T);
  const k = p * Lw;
  if (spec.mode === "middle-out") {
    const sA = A - F, sB = T - A;
    const half = k / 2;
    const left = Math.min(half + Math.max(0, half - sB), sA);
    const right = Math.min(half + Math.max(0, half - sA), sB);
    return { lo: A - left, hi: A + right };
  }
  // single
  const fwd = spec.direction !== "reverse";
  const capMain = fwd ? T - A : A - F;
  const main = Math.min(k, capMain);
  const spill = Math.max(0, k - capMain);
  return fwd ? { lo: A - spill, hi: A + main } : { lo: A - main, hi: A + spill };
}

/** The knee progress for open-path growth (null = fully linear). */
function openKnee(spec: TrimSpec): number | null {
  const L = spec.len;
  const F = clamp(Math.min(spec.from, spec.to), 0, 1) * L;
  const T = clamp(Math.max(spec.from, spec.to), 0, 1) * L;
  const Lw = Math.max(1e-9, T - F);
  const A = clamp(spec.anchor * L, F, T);
  if (spec.mode === "both-ends") return null;
  if (spec.mode === "middle-out") {
    const knee = (2 * Math.min(A - F, T - A)) / Lw;
    return knee > 1e-6 && knee < 1 - 1e-6 ? knee : null;
  }
  const cap = spec.direction !== "reverse" ? T - A : A - F;
  const knee = cap / Lw;
  return knee > 1e-6 && knee < 1 - 1e-6 ? knee : null;
}

/** One open-path keyframe: window(s) → a leading-zero dash list.
 *  single/middle-out: [0, lo, hi−lo, L] (4 entries).
 *  both-ends: [0, F, k, gapMid, k, L] (6 entries). */
function openKeyframe(spec: TrimSpec, p: number): TrimKeyframe {
  const L = spec.len;
  if (spec.mode === "both-ends") {
    const F = clamp(Math.min(spec.from, spec.to), 0, 1) * L;
    const T = clamp(Math.max(spec.from, spec.to), 0, 1) * L;
    const Lw = Math.max(0, T - F);
    const k = (p * Lw) / 2;
    return { strokeDasharray: dasharray([0, F, k, Lw - 2 * k, k, L]), strokeDashoffset: 0 };
  }
  const { lo, hi } = openWindow(spec, p);
  return { strokeDasharray: dasharray([0, lo, Math.max(0, hi - lo), L]), strokeDashoffset: 0 };
}

/** One closed-path keyframe: arc of length k placed by pattern offset.
 *  Pattern [k, L−k]; offset picks where the dash lands. All linear in p. */
function closedKeyframe(spec: TrimSpec, p: number): TrimKeyframe {
  const L = spec.len;
  const span = clamp(Math.abs(spec.to - spec.from), 0, 1) * L;
  const A = clamp(spec.anchor, 0, 1) * L;
  const k = p * span;
  let start: number; // arc start position (visible arc = [start, start+k))
  if (spec.mode === "both-ends" || spec.mode === "middle-out") start = A - k / 2;
  else if (spec.direction === "reverse") start = A - k;
  else start = A;
  // visible where (s + offset) mod L ∈ [0, k)  →  offset = −start
  return { strokeDasharray: dasharray([k, L - k]), strokeDashoffset: fmt(-start) };
}

/** Build the 2–3 dash keyframes for a trim animation. `enter` grows the
 *  window (drawOn); exits (drawOff) play the same list in reverse.
 *  @oracle gate-only: the player no longer calls this (drawPlan samples `trimDashAt`); verify-draw pins
 *  `trimDashAt` against the visible set these keyframes describe. */
export function trimKeyframes(spec: TrimSpec, enter: boolean): TrimKeyframe[] {
  const L = Math.max(1e-6, spec.len);
  const s: TrimSpec = { ...spec, len: L };
  const frames: TrimKeyframe[] = [];
  if (s.closed) {
    frames.push(closedKeyframe(s, 0), closedKeyframe(s, 1));
  } else {
    const knee = openKnee(s);
    frames.push(openKeyframe(s, 0));
    if (knee != null) frames.push({ ...openKeyframe(s, knee), offset: knee });
    frames.push(openKeyframe(s, 1));
  }
  if (!enter) {
    frames.reverse();
    for (const f of frames) if (f.offset != null) f.offset = 1 - f.offset;
  }
  return frames;
}

// ===========================================================================
// T3 — exact-window dash frames and the shared TRACE primitive.
//
// `windowDash` turns "the visible stretch(es) of the stroke are [lo,hi]" into
// the stroke-dasharray/-dashoffset pair that paints exactly that, with
//   • NO structural zero-length dashes (a round/square linecap paints a dot at
//     every zero dash — the reason trimAnim used to force butt caps and then
//     snap back to the authored cap at rest): one dash per window, one huge gap;
//   • an optional authored dash PATTERN preserved inside the window (a dashed
//     line draws dash by dash instead of solid-then-snap);
//   • null when nothing is visible (callers emit the offset-hidden frame).
// Pure and DOM-free like everything above; the player samples it per frame
// (NodeAnim.sample), so list lengths may differ frame to frame.
// ===========================================================================

export interface DashFrame { strokeDasharray: string; strokeDashoffset: number }
export interface WindowSpec { len: number; closed?: boolean; pattern?: number[] }
const MAX_DASHES = 3000;

/** Hidden: dash G / gap G at offset G leaves [0,G) in the gap (G ≥ len). */
export function hiddenDash(len: number): DashFrame {
  const G = fmt(len + 1);
  return { strokeDasharray: String(G), strokeDashoffset: G };
}

/** The length a FULL draw sweeps: the measured length plus a small margin for the dasher's
 *  undershoot (Chrome 156 measured: ellipse/circle 0.07-0.16 %, every other geometry 0 %). The margin
 *  also covers other engines (the previously documented Chromium figure for ellipses is 0.6 %): a
 *  residual undershoot would otherwise leave a sliver that pops when the transient dash is dropped
 *  at progress 1. NOT the old 5 % / >=4-unit slack, which finished a draw early (short strokes at
 *  34 % of their duration). */
export const DRAW_REACH_EPS = { round: 0.006, other: 0.002 } as const;
export function drawReach(len: number, tag: string): number {
  return len * (1 + (tag === "ellipse" || tag === "circle" ? DRAW_REACH_EPS.round : DRAW_REACH_EPS.other)) + 0.05;
}

/** Dash frame painting exactly the windows (sorted, disjoint, arc units) of a
 *  stroke of length `spec.len`; null if nothing is visible. */
export function windowsDash(spec: WindowSpec, windows: [number, number][]): DashFrame | null {
  const L = Math.max(1e-6, spec.len);
  const ws = windows.map(([a, b]) => [Math.max(0, a), Math.min(L, b)] as [number, number]).filter(([a, b]) => b - a > 1e-4);
  if (!ws.length) return null;
  // a pattern with a ZERO dash (a round-cap dotted line, `0 6`) has no dash length to window: it draws solid during
  // the draw and takes its dots at rest, as before T3 (review F4; dropping the dots would paint nothing at all)
  const pat0 = spec.pattern && spec.pattern.length && spec.pattern.some((v) => v > 0)
    ? (spec.pattern.length % 2 ? [...spec.pattern, ...spec.pattern] : spec.pattern) : null;
  const pat = pat0 && pat0.every((v, i) => i % 2 || v > 1e-4) ? pat0 : null;
  // 1. clip the dash pattern (or solid) to the windows → visible intervals
  const vis: [number, number][] = [];
  if (!pat) for (const w of ws) vis.push(w);
  else {
    const P = pat.reduce((s, v) => s + v, 0);
    if (L / P * pat.length / 2 > MAX_DASHES) { for (const w of ws) vis.push(w); }  // pathological dust: draw solid
    else for (const [a, b] of ws) {
      for (let k = Math.floor(a / P); k * P < b; k++) {
        let c = k * P;
        for (let j = 0; j < pat.length; c += pat[j], j++) {
          if (j % 2) continue; // gap entries
          const s = Math.max(a, c), e = Math.min(b, c + pat[j]);
          if (e - s > 1e-4) vis.push([s, e]);
        }
      }
    }
  }
  if (!vis.length) return null;
  // 2. closed single window that can wrap the seam keeps the exact period L
  if (spec.closed && vis.length === 1 && !pat) {
    const w = vis[0][1] - vis[0][0];
    if (w < L - 1e-4) return { strokeDasharray: `${fmt(w)} ${fmt(L - w)}`, strokeDashoffset: fmt(-vis[0][0]) };
  }
  // 3. [d1, g1, d2, …, dm, BIG] at offset −s1: one period longer than the path
  const list: number[] = [];
  for (let i = 0; i < vis.length; i++) {
    if (i) list.push(vis[i][0] - vis[i - 1][1]);
    list.push(vis[i][1] - vis[i][0]);
  }
  list.push(L + 1);
  return { strokeDasharray: dasharray(list), strokeDashoffset: fmt(-vis[0][0]) };
}
export const windowDash = (spec: WindowSpec, lo: number, hi: number) => windowsDash(spec, [[lo, hi]]);

/** The TRACE primitive (WP 2.2's Circumscribe / ShowPassingFlash build on it; no consumer in 1.4): a sliver whose TAIL and HEAD are
 *  independent path fractions (open paths clip to [0,1]; closed paths wrap, a
 *  window ≥ one lap is the whole stroke). With a dash pattern the pattern is
 *  clipped to the sliver (dashes stay intact, they do not crawl). */
export function traceDash(spec: WindowSpec, tail: number, head: number): DashFrame | null {
  const L = Math.max(1e-6, spec.len), w = head - tail;
  if (w <= 1e-6) return null;
  if (!spec.closed) return windowsDash(spec, [[Math.max(0, tail) * L, Math.min(1, head) * L]]);
  if (w >= 1 - 1e-6) return spec.pattern?.length ? windowsDash(spec, [[0, L]]) : { strokeDasharray: `${fmt(L)} ${fmt(1)}`, strokeDashoffset: 0 };
  const start = (((tail % 1) + 1) % 1) * L, end = start + w * L;
  // no pattern: ONE dash of exact period L — Skia joins the dash across the seam
  if (!spec.pattern?.length) return { strokeDasharray: `${fmt(w * L)} ${fmt(L - w * L)}`, strokeDashoffset: fmt(-start) };
  return windowsDash(spec, end > L ? [[0, end - L], [start, L]] : [[start, end]]);
}

/** PEN TOUCH-DOWN (lane J: "a draw's first frame shows no ink the pen has not reached"). A round or square cap paints a full disc at the
 *  head of the smallest dash, so the first frame of a draw used to blink a dot of one stroke width in at once. The stroke width therefore
 *  ramps with the ink laid down: `width * min(1, ink / width)`, i.e. the pen puts down over its first stroke-width of travel and the
 *  disc GROWS from nothing. Beyond that the stroke is the authored one, so the last frame is exactly the resting stroke (and, played
 *  backwards, a drawOff shrinks to nothing instead of ending on a dot). Pure: `ink` is in the stroke's own user units. */
export function penWidth(width: number, ink: number): number {
  return width > 0 ? width * Math.min(1, Math.max(0, ink) / width) : width;
}

/** The PEN-SLICE law: how the children of ONE target share one node window so they draw one after another at ONE pen speed
 *  (manim's `get_sub_alpha` generalised from equal slices to arc-length widths).
 *    child i:  window d_i = k·w_i,  start s_i = L·k·(w_0 + … + w_{i-1}),  k = 1 / max_i(L·P_i + w_i),  P_i = Σ_{q<i} w_q
 *  so the last end is exactly 1, `equal` weights are manim's equal slices, and with length weights every child runs at the
 *  SAME speed w_i/d_i = 1/k for any lag L. `lag` 1 = back to back (a constant-speed pen: each slice starts where the previous
 *  ends, i.e. an arrowhead after its shaft), 0 = all together. `minFrac`: no window may fall under that fraction of the node
 *  window (a 3 unit cap is never a one-frame flash): the weights of short children are raised and k re-solved (≤ 200 passes);
 *  if even equal minimum windows cannot fit, the LAG gives way, never the total. Pure; the caller eases ONCE PER SLOT
 *  (`c_i = ease(clamp((raw − s_i)/d_i))`, manim's per-child rate_func). At `lag` 1, `equal` false, `minFrac` 0 it is the
 *  within-unit shaft → head slicing of the draw plan, bit for bit. */
export function penSlices(weights: readonly number[], lag = 1, equal = false, minFrac = 0): [number, number][] {
  const n = weights.length;
  if (!n) return [];
  const w = weights.map((v) => (equal ? 1 : Number.isFinite(v) ? Math.max(v, 1e-9) : 1e-9));
  const L = n > 1 && minFrac > 0 ? Math.max(0, Math.min(lag, (1 / minFrac - 1) / (n - 1))) : Math.max(0, lag);
  const P = new Array<number>(n).fill(0);
  let m = 1; // the node window in weight units: k = 1 / m, so a slice is (L·P_i, L·P_i + w_i) / m
  const solve = () => {
    for (let i = 1; i < n; i++) P[i] = P[i - 1] + w[i - 1];
    m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, L * P[i] + w[i]);
  };
  solve();
  for (let pass = 0; pass < 200 && minFrac > 0; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) if (w[i] / m < minFrac * (1 - 1e-9)) { w[i] = minFrac * m; changed = true; }
    if (!changed) break;
    solve();
  }
  return w.map((wi, i) => [L * P[i] / m, Math.min(1, (L * P[i] + wi) / m)] as [number, number]);
}

/** manim ShowPassingFlash's window (time_width w): head = lerp(0, 1+w, p), tail = head − w. */
export function passingFlash(width: number, p: number): { tail: number; head: number } {
  const head = p * (1 + width);
  return { tail: head - width, head };
}

/** The dash frame of the (legacy) trim model at progress p — the same windows
 *  openWindow/closedKeyframe describe, painted with NO structural zero dashes. */
export function trimDashAt(spec: TrimSpec, p: number, pattern?: number[]): DashFrame | null {
  const L = Math.max(1e-6, spec.len), ws: WindowSpec = { len: L, closed: spec.closed, pattern };
  if (spec.closed) {
    const span = clamp(Math.abs(spec.to - spec.from), 0, 1) * L, A = clamp(spec.anchor, 0, 1) * L, k = p * span;
    const start = spec.mode === "both-ends" || spec.mode === "middle-out" ? A - k / 2 : spec.direction === "reverse" ? A - k : A;
    return traceDash(ws, start / L, (start + k) / L);
  }
  if (spec.mode === "both-ends") {
    const F = clamp(Math.min(spec.from, spec.to), 0, 1) * L, T = clamp(Math.max(spec.from, spec.to), 0, 1) * L;
    const k = (p * (T - F)) / 2;
    return windowsDash(ws, [[F, F + k], [T - k, T]]);
  }
  const { lo, hi } = openWindow(spec, p);
  return windowsDash(ws, [[lo, hi]]);
}
