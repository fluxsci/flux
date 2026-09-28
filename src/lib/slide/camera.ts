import type { StageSize } from "./types";

/** World centre and positive zoom; shared by inspected and played frames. */
export type CameraPose = { x: number; y: number; zoom: number };
export type CameraPath = "pole" | "fly";

const RHO = Math.SQRT2;
const PAN_EPSILON = 1e-6;

// van Wijk–Nuij, as in d3-interpolate's interpolateZoom (ISC, Mike Bostock).
// -asinh(b) = log(sqrt(b*b + 1) - b), without subtractive cancellation.
function flyR(w0: number, w1: number, d: number, end: boolean): number {
  return -Math.asinh((w1 * w1 - w0 * w0 + (end ? -4 : 4) * d * d) / (4 * (end ? w1 : w0) * d));
}

/** Natural path length S in seconds at unit speed. UI milliseconds = 1000·S. */
export function flyDuration(a: CameraPose, b: CameraPose, stage: StageSize): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y), w0 = stage.width / a.zoom, w1 = stage.width / b.zoom;
  return d < PAN_EPSILON ? Math.abs(Math.log(w1 / w0)) / RHO
    : (flyR(w0, w1, d, true) - flyR(w0, w1, d, false)) / RHO;
}

/** Geometric zoom about the screen-space pole, or a zoom-out/pan/zoom-in Fly.
 * Eased u may overshoot. Supply out to reuse a pose without frame allocations. */
export function sampleCamera(a: CameraPose, b: CameraPose, u: number, stage: StageSize, path: CameraPath = "pole", out: CameraPose = { x: 0, y: 0, zoom: 1 }): CameraPose {
  if (u === 0 || u === 1) {
    const c = u === 0 ? a : b;
    out.x = c.x; out.y = c.y; out.zoom = c.zoom;
    return out;
  }
  const dx = b.x - a.x, dy = b.y - a.y, logK = Math.log(b.zoom / a.zoom);
  if (path === "fly") {
    const d = Math.hypot(dx, dy);
    if (d >= PAN_EPSILON) {
      const w0 = stage.width / a.zoom, w1 = stage.width / b.zoom;
      const r0 = flyR(w0, w1, d, false), r1 = flyR(w0, w1, d, true);
      const s = u * (r1 - r0), cosh = Math.cosh(s + r0);
      const position = w0 / (2 * d) * Math.sinh(s) / cosh;
      out.x = a.x + dx * position; out.y = a.y + dy * position;
      out.zoom = a.zoom * cosh / Math.cosh(r0);
      return out;
    }
  }
  const zoom = a.zoom * Math.exp(u * logK);
  if (path === "fly" || Math.abs(logK) < 1e-4) {
    out.x = a.x + dx * u; out.y = a.y + dy * u;
  } else {
    // τ(u) = τ0 + (τ1−τ0)·expm1(u·ln k)/expm1(ln k), equivalent to the
    // fixed-pole formula without explicitly constructing a distant pole.
    const f = Math.expm1(u * logK) / Math.expm1(logK);
    const tx0 = stage.width / 2 - a.x * a.zoom, ty0 = stage.height / 2 - a.y * a.zoom;
    const tx1 = stage.width / 2 - b.x * b.zoom, ty1 = stage.height / 2 - b.y * b.zoom;
    out.x = (stage.width / 2 - (tx0 + (tx1 - tx0) * f)) / zoom;
    out.y = (stage.height / 2 - (ty0 + (ty1 - ty0) * f)) / zoom;
  }
  out.zoom = zoom;
  return out;
}
