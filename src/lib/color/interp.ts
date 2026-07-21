// ---------------------------------------------------------------------------
// Pure color interpolation for the transform tween (the repo's FIRST JS color
// math — keep it tiny and hard-gated; verify-color-interp.ts). OKLab is the
// blend space: perceptually uniform, so a red→blue tween passes through
// tasteful muted purples instead of sRGB's muddy grey trench.
//
// Scope is deliberately small (the model stores CSS color STRINGS, in practice
// hex/rgb() from the palette): #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba()
// (comma or space syntax), "none"/"transparent". Anything else (var(),
// gradients, exotic names) is non-interpolable → the caller steps at t=0.5.
// No DOM, no Node — flux-core and the export runtime both load this.
// ---------------------------------------------------------------------------

export interface RGBA {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..1
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp255 = (v: number) => Math.min(255, Math.max(0, v));

/** Parse a supported CSS color string. Returns null for "none"/unparseable —
 *  callers distinguish "none" themselves (isNone) before falling back. */
export function parseColor(s: string): RGBA | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,4})$/.exec(t);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
      a: h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1,
    };
  }
  m = /^#([0-9a-f]{6}([0-9a-f]{2})?)$/.exec(t);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(t);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: clamp255(parseFloat(m[1])), g: clamp255(parseFloat(m[2])), b: clamp255(parseFloat(m[3])), a: clamp01(a) };
  }
  return null;
}

/** "none" (SVG's paint-off keyword) — interpolable as the alpha-0 endpoint of
 *  the OTHER side's color. */
export function isNone(s: string): boolean {
  return typeof s === "string" && s.trim().toLowerCase() === "none";
}

/** Format: #rrggbb when opaque, #rrggbbaa otherwise (round-trips parseColor). */
export function formatColor(c: RGBA): string {
  const h = (v: number) => Math.round(clamp255(v)).toString(16).padStart(2, "0");
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  if (c.a >= 1) return base;
  return base + Math.round(clamp01(c.a) * 255).toString(16).padStart(2, "0");
}

// --- sRGB ⇄ OKLab (Björn Ottosson's reference constants) ---------------------
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const delin = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp255(c * 255);
};

interface Lab { L: number; a: number; b: number; alpha: number }

function toOklab(c: RGBA): Lab {
  const r = lin(c.r), g = lin(c.g), b = lin(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    alpha: c.a,
  };
}

function fromOklab(c: Lab): RGBA {
  const l = (c.L + 0.3963377774 * c.a + 0.2158037573 * c.b) ** 3;
  const m = (c.L - 0.1055613458 * c.a - 0.0638541728 * c.b) ** 3;
  const s = (c.L - 0.0894841775 * c.a - 1.291485548 * c.b) ** 3;
  return {
    r: delin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: delin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: delin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    a: c.alpha,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A per-step OKLCh delta (cascade color ramps). dH is in DEGREES. */
export interface OklchDelta {
  dL?: number;
  dC?: number;
  dH?: number;
}

/** Shift a model color string k steps in OKLCh: L + k·dL (clamped 0..1),
 *  C + k·dC (floored at 0), H + k·dH (wraps). The k-scaled delta is applied in
 *  ONE conversion — never iterate single steps, per-step clamping would
 *  accumulate error. Returns null for "none"/unparseable (callers skip the
 *  write and keep the value untouched). Alpha is preserved. */
export function shiftOklch(s: string, d: OklchDelta, k: number): string | null {
  if (isNone(s)) return null;
  const c = parseColor(s);
  if (!c) return null;
  const lab = toOklab(c);
  const C = Math.hypot(lab.a, lab.b);
  const H = Math.atan2(lab.b, lab.a);
  const L2 = clamp01(lab.L + k * (d.dL ?? 0));
  const C2 = Math.max(0, C + k * (d.dC ?? 0));
  const H2 = H + (k * (d.dH ?? 0) * Math.PI) / 180;
  return formatColor(fromOklab({ L: L2, a: C2 * Math.cos(H2), b: C2 * Math.sin(H2), alpha: lab.alpha }));
}

/** Interpolate two model color strings at t ∈ [0,1]:
 *  • both parseable → OKLab blend (+ linear alpha), formatted as hex
 *  • "none" ↔ color → the color with its alpha ramped from/to 0
 *  • both "none" → "none"
 *  • anything unparseable → step at t = 0.5 (predictable, never garbage)
 *  t ≤ 0 / ≥ 1 return the ORIGINAL strings verbatim (endpoint identity). */
export function lerpColor(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const aNone = isNone(a), bNone = isNone(b);
  if (aNone && bNone) return a;
  const ca = aNone ? null : parseColor(a);
  const cb = bNone ? null : parseColor(b);
  if (aNone && cb) return formatColor({ ...cb, a: cb.a * t });
  if (bNone && ca) return formatColor({ ...ca, a: ca.a * (1 - t) });
  if (!ca || !cb) return t < 0.5 ? a : b;
  const la = toOklab(ca), lb = toOklab(cb);
  return formatColor(
    fromOklab({ L: lerp(la.L, lb.L, t), a: lerp(la.a, lb.a, t), b: lerp(la.b, lb.b, t), alpha: lerp(la.alpha, lb.alpha, t) }),
  );
}
