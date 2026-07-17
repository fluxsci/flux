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
 *  window (drawOn); exits (drawOff) play the same list in reverse. */
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
