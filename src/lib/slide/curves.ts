/** Pure timing curves shared by playback, compilation and authoring. Resolve
 *  once when building a spec; the returned samplers allocate nothing per frame. */
import { EASE, cubicBezierFn, influenceToCss, smoothEasing, smoothstep, type Bezier } from "../motion/tokens";
import { defaultEasingFor, PRESET_CATALOG } from "./presetCatalog";
import type { TrackFamily } from "./family";
import type { EasingToken, Track } from "./types";

export const EASING_TOKENS = ["smooth", "standard", "enter", "exit", "linear"] as const;
export type Curve =
  | { kind: "bezier"; p: [x1: number, y1: number, x2: number, y2: number] }
  | { kind: "spring"; bounce: number; velocity?: number }
  | { kind: "steps"; n: number; jump?: "start" | "end" };

export interface ResolvedCurve {
  key: string;
  /** Exact endpoints, with overshoot available to box/camera channels. */
  fn: (t: number) => number;
  clamped: (t: number) => number;
  /** Native effects use the clamped curve; legacy strings stay byte-identical. */
  css: string;
  overshoots: boolean;
  /** First arrival at 90%, in units of the track's duration. */
  arrival: number;
}

export const SPRING_SETTLE = 0.005;
const CURVE_SAMPLES = 1000;
const LINEAR_TOLERANCE = 0.002;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const clampBounce = (n: number) => Math.max(-0.5, Math.min(0.8, n));
const clampSteps = (n: number) => Math.max(1, Math.min(60, Math.round(n)));
const zetaOf = (b: number) => b >= 0 ? 1 - b : 1 / (1 + b);

function springParts(z: number, w: number, v: number) {
  if (Math.abs(z - 1) < 1e-6) {
    const A = -1, B = v - w;
    return { y: (t: number) => Math.exp(-w * t) * (A + B * t),
      dy: (t: number) => Math.exp(-w * t) * (B - w * (A + B * t)) };
  }
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z), A = -1, B = (v - z * w) / wd;
    return { y: (t: number) => Math.exp(-z * w * t) * (A * Math.cos(wd * t) + B * Math.sin(wd * t)),
      dy: (t: number) => {
        const e = Math.exp(-z * w * t), c = Math.cos(wd * t), s = Math.sin(wd * t);
        return e * (-z * w * (A * c + B * s) + wd * (B * c - A * s));
      } };
  }
  const s = Math.sqrt(z * z - 1), r1 = -w * (z - s), r2 = -w * (z + s);
  const C2 = (v + r1) / (r2 - r1), C1 = -1 - C2;
  return { y: (t: number) => C1 * Math.exp(r1 * t) + C2 * Math.exp(r2 * t),
    dy: (t: number) => C1 * r1 * Math.exp(r1 * t) + C2 * r2 * Math.exp(r2 * t) };
}

/** Fit the energy bound at t=1, then spread its residual over the whole flight. */
export function springFn(bounce: number, velocity = 0): (t: number) => number {
  const z = zetaOf(clampBounce(bounce));
  let lo = 0.1, hi = 2000;
  for (let i = 0; i < 60; i++) {
    const w = Math.sqrt(lo * hi), p = springParts(z, w, velocity);
    if (Math.hypot(p.y(1), p.dy(1) / w) > SPRING_SETTLE) lo = w; else hi = w;
  }
  const { y } = springParts(z, hi, velocity), y1 = y(1);
  return t => t <= 0 ? 0 : t >= 1 ? 1 : 1 + y(t) - t * y1;
}

export function bezierFn(p: Bezier): (t: number) => number {
  // The shared solver already leaves y unclamped; only time handles are bounded.
  return cubicBezierFn([clamp01(p[0]), p[1], clamp01(p[2]), p[3]]);
}

export function stepsFn(n: number, jump: "start" | "end" = "end"): (t: number) => number {
  const count = clampSteps(n), offset = jump === "start" ? 1 : 0;
  // Track endpoints snap exactly. jump-start takes its first step just after 0;
  // CSS has that step at 0 itself, where the player restores the authored state.
  return t => t <= 0 ? 0 : t >= 1 ? 1 : Math.min(1, (Math.floor(t * count) + offset) / count);
}

function normalizeCurve(curve: Curve): Curve {
  switch (curve.kind) {
    case "spring": return { ...curve, bounce: clampBounce(curve.bounce) };
    case "steps": return { ...curve, n: clampSteps(curve.n) };
    case "bezier": return { kind: "bezier", p: [clamp01(curve.p[0]), Math.max(-1, Math.min(2, curve.p[1])), clamp01(curve.p[2]), Math.max(-1, Math.min(2, curve.p[3]))] };
  }
}

/** Douglas–Peucker with vertical error: CSS interpolates value at a fixed time,
 *  so perpendicular distance would understate error on steep spring segments. */
function linearCss(fn: (t: number) => number): string {
  const values = new Float64Array(CURVE_SAMPLES + 1), kept = [0];
  for (let i = 0; i <= CURVE_SAMPLES; i++) values[i] = fn(i / CURVE_SAMPLES);
  const simplify = (a: number, b: number): void => {
    let error = LINEAR_TOLERANCE, split = 0;
    const slope = (values[b] - values[a]) / (b - a);
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(values[i] - (values[a] + slope * (i - a)));
      if (d > error) { error = d; split = i; }
    }
    if (split) { simplify(a, split); simplify(split, b); } else kept.push(b);
  };
  simplify(0, CURVE_SAMPLES);
  return `linear(${kept.map(i => `${Number(values[i].toFixed(6))} ${100 * i / CURVE_SAMPLES}%`).join(", ")})`;
}

function arrivalAt(fn: (t: number) => number, level: number): number {
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    if (fn(i / CURVE_SAMPLES) < level) continue;
    let lo = (i - 1) / CURVE_SAMPLES, hi = i / CURVE_SAMPLES;
    for (let j = 0; j < 30; j++) { const mid = (lo + hi) / 2; if (fn(mid) >= level) hi = mid; else lo = mid; }
    return hi;
  }
  return 1;
}

const curves = new Map<string, ResolvedCurve>();
export function resolveCurve(track: Pick<Track, "easing" | "influence" | "curve" | "preset">, family?: TrackFamily): ResolvedCurve {
  let key: string, css: string | undefined, make: () => (t: number) => number;
  if (track.curve) {
    const curve = normalizeCurve(track.curve);
    switch (curve.kind) {
      case "spring":
        key = `spring:${curve.bounce}:${curve.velocity ?? 0}`;
        make = () => springFn(curve.bounce, curve.velocity);
        break;
      case "bezier":
        key = `bezier:${curve.p.join(":")}`;
        make = () => bezierFn(curve.p);
        if (curve.p[1] >= 0 && curve.p[1] <= 1 && curve.p[3] >= 0 && curve.p[3] <= 1) css = `cubic-bezier(${curve.p.join(", ")})`;
        break;
      case "steps":
        key = `steps:${curve.n}:${curve.jump ?? "end"}`;
        make = () => stepsFn(curve.n, curve.jump);
        css = `steps(${curve.n}, jump-${curve.jump ?? "end"})`;
        break;
    }
  } else if (track.influence && (track.influence.in > 0 || track.influence.out > 0)) {
    // Legacy sampling used the CSS-rounded handles, not the unrounded influence.
    css = influenceToCss(track.influence);
    key = `infl:${css}`;
    const coefficients = css.match(/-?\d*\.?\d+/g)!.map(Number) as Bezier;
    make = () => cubicBezierFn(coefficients);
  } else {
    const preset = track.preset ?? (family && Object.values(PRESET_CATALOG).find(def => def.family === family)?.name);
    const token = track.easing ?? defaultEasingFor(preset);
    key = `tok:${token}`;
    css = token === "smooth" ? smoothEasing() : token === "linear" ? "linear" : EASE[token] ?? EASE.standard;
    const legacyCss = css;
    make = () => token === "smooth" ? smoothstep : token === "linear" ? t => t : cubicBezierFn(legacyCss.match(/-?\d*\.?\d+/g)!.map(Number) as Bezier);
  }
  const cached = curves.get(key);
  if (cached) return cached;
  const fn = make(), clamped = (t: number) => clamp01(fn(t));
  let overshoots = false;
  for (let i = 0; i <= CURVE_SAMPLES; i++) { const y = fn(i / CURVE_SAMPLES); if (y < 0 || y > 1) { overshoots = true; break; } }
  const resolved: ResolvedCurve = { key, fn, clamped, css: css ?? linearCss(clamped), overshoots, arrival: arrivalAt(fn, 0.9) };
  curves.set(key, resolved);
  return resolved;
}

/** Overshoot is a fraction of travel; arrival times are fractions of duration.
 *  Crossings exclude the exact final endpoint, which is not another oscillation. */
export function springStats(bounce: number, velocity = 0): { overshoot: number; arrival90: number; arrival98: number; crossings: number } {
  const { fn, arrival } = resolveCurve({ curve: { kind: "spring", bounce, velocity } });
  let peak = 1, crossings = 0, sign = -1;
  for (let i = 1; i < CURVE_SAMPLES; i++) {
    const y = fn(i / CURVE_SAMPLES);
    peak = Math.max(peak, y);
    if (y !== 1) { const next = y > 1 ? 1 : -1; if (next !== sign) crossings++; sign = next; }
  }
  return { overshoot: peak - 1, arrival90: arrival, arrival98: arrivalAt(fn, 0.98), crossings };
}

export interface CurveCatalogEntry {
  id: string;
  group: "Ease" | "Overshoot" | "Spring" | "Discrete";
  label: string;
  spec: Curve | EasingToken;
}
export const CURVE_CATALOG: readonly CurveCatalogEntry[] = [
  { id: "standard", group: "Ease", label: "Standard", spec: "standard" },
  { id: "smooth", group: "Ease", label: "Smooth", spec: "smooth" },
  { id: "enter", group: "Ease", label: "Enter", spec: "enter" },
  { id: "exit", group: "Ease", label: "Exit", spec: "exit" },
  { id: "linear", group: "Ease", label: "Linear", spec: "linear" },
  { id: "gentle", group: "Ease", label: "Gentle", spec: { kind: "bezier", p: [0.37, 0, 0.63, 1] } },
  { id: "overshoot", group: "Overshoot", label: "Overshoot", spec: { kind: "bezier", p: [0.34, 1.56, 0.64, 1] } },
  { id: "anticipate", group: "Overshoot", label: "Anticipate", spec: { kind: "bezier", p: [0.36, 0, 0.66, -0.56] } },
  { id: "anticipate + overshoot", group: "Overshoot", label: "Anticipate + overshoot", spec: { kind: "bezier", p: [0.68, -0.6, 0.32, 1.6] } },
  { id: "settle", group: "Spring", label: "Settle", spec: { kind: "spring", bounce: 0 } },
  { id: "snappy", group: "Spring", label: "Snappy", spec: { kind: "spring", bounce: 0.2 } },
  { id: "bouncy", group: "Spring", label: "Bouncy", spec: { kind: "spring", bounce: 0.35 } },
  { id: "playful", group: "Spring", label: "Playful", spec: { kind: "spring", bounce: 0.5 } },
  { id: "steps", group: "Discrete", label: "Steps", spec: { kind: "steps", n: 8 } },
  { id: "hold", group: "Discrete", label: "Hold", spec: { kind: "steps", n: 1, jump: "end" } },
];

export function catalogMatch(curve: Curve | EasingToken): string | null {
  return CURVE_CATALOG.find(({ spec }) => {
    if (typeof spec === "string" || typeof curve === "string") return spec === curve;
    if (spec.kind !== curve.kind) return false;
    switch (spec.kind) {
      case "spring": return curve.kind === "spring" && spec.bounce === curve.bounce && spec.velocity === curve.velocity;
      case "steps": return curve.kind === "steps" && spec.n === curve.n && spec.jump === curve.jump;
      case "bezier": return curve.kind === "bezier" && spec.p.every((v, i) => v === curve.p[i]);
    }
  })?.id ?? null;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/;
const numberOf = (s: string): number | null => NUMBER.test(s) && Number.isFinite(Number(s)) ? Number(s) : null;
export function parseCurve(s: string): Curve | EasingToken | null {
  const text = s.trim().toLowerCase().replace(/\u2212/g, "-");
  const named = CURVE_CATALOG.find(entry => entry.id === text);
  if (named) return typeof named.spec === "string" ? named.spec : normalizeCurve(named.spec);
  const call = /^(spring|bezier|cubic-bezier|steps)\((.*)\)$/.exec(text);
  if (!call) return null;
  const args = call[2].split(",").map(arg => arg.trim()), values = args.map(numberOf);
  if (call[1] === "bezier" || call[1] === "cubic-bezier") {
    return args.length === 4 && values.every(v => v !== null) ? normalizeCurve({ kind: "bezier", p: values as Bezier }) : null;
  }
  if (call[1] === "steps") {
    const n = values[0], jump = args[1];
    if (n === null || !Number.isInteger(n) || args.length > 2 || (jump !== undefined && jump !== "start" && jump !== "end")) return null;
    return normalizeCurve({ kind: "steps", n, ...(jump ? { jump } : {}) });
  }
  if (values[0] !== null) {
    if (args.length === 1) return normalizeCurve({ kind: "spring", bounce: values[0] });
    const match = /^v\s*=\s*(.+)$/.exec(args[1]), velocity = match ? numberOf(match[1]) : null;
    return args.length === 2 && velocity !== null ? normalizeCurve({ kind: "spring", bounce: values[0], velocity }) : null;
  }
  const physical = new Map<string, number>();
  for (const arg of args) {
    const match = /^([kcm])\s*=\s*(.+)$/.exec(arg), value = match ? numberOf(match[2]) : null;
    if (!match || value === null || physical.has(match[1])) return null;
    physical.set(match[1], value);
  }
  const k = physical.get("k"), c = physical.get("c"), m = physical.get("m");
  if (k === undefined || c === undefined || m === undefined || k <= 0 || m <= 0 || c < 0) return null;
  const z = (c / 2) / Math.sqrt(k) / Math.sqrt(m);
  return { kind: "spring", bounce: clampBounce(z <= 1 ? 1 - z : 1 / z - 1) };
}

export function formatCurve(curve: Curve | EasingToken): string {
  if (typeof curve === "string") return curve;
  const c = normalizeCurve(curve);
  switch (c.kind) {
    case "spring": return `spring(${c.bounce}${c.velocity === undefined ? "" : `, v=${c.velocity}`})`;
    case "bezier": return `bezier(${c.p.join(", ")})`;
    case "steps": return `steps(${c.n}${c.jump === undefined ? "" : `, ${c.jump}`})`;
  }
}
