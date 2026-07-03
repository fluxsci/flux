import type { Rng } from '../core/prng'

// Seeded 2D value noise in ~[-1, 1], plus a curl operator for gentle
// divergence-free flow fields (ink wind, suminagashi combing).

export type Noise2D = (x: number, y: number) => number

export function makeNoise2D(rng: Rng): Noise2D {
  const N = 256
  const vals = new Float32Array(N * N)
  for (let i = 0; i < vals.length; i++) vals[i] = rng.next() * 2 - 1
  const at = (ix: number, iy: number) => vals[((iy & (N - 1)) * N + (ix & (N - 1))) | 0]
  return (x: number, y: number) => {
    const xf = Math.floor(x)
    const yf = Math.floor(y)
    const fx = x - xf
    const fy = y - yf
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const a = at(xf, yf)
    const b = at(xf + 1, yf)
    const c = at(xf, yf + 1)
    const d = at(xf + 1, yf + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
}

/** Unit-ish curl vector of the noise field at (x, y) — flows along contours. */
export function curl2(n: Noise2D, x: number, y: number, eps = 0.35): [number, number] {
  const dx = (n(x + eps, y) - n(x - eps, y)) / (2 * eps)
  const dy = (n(x, y + eps) - n(x, y - eps)) / (2 * eps)
  const len = Math.hypot(dx, dy) || 1
  return [dy / len, -dx / len]
}
