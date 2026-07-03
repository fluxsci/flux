import type { Rng } from './prng'

// Smooth 1D value noise in ~[-1, 1]. Cheap and plenty organic for steering
// walkers — sample it at low frequency to get gentle meandering headings.
export type Noise1D = (x: number) => number

export function makeNoise1D(rng: Rng): Noise1D {
  const N = 256
  const vals = new Float32Array(N)
  for (let i = 0; i < N; i++) vals[i] = rng.next() * 2 - 1
  return (x: number) => {
    const xf = Math.floor(x)
    const f = x - xf
    const u = f * f * (3 - 2 * f)
    const a = vals[xf & (N - 1)]
    const b = vals[(xf + 1) & (N - 1)]
    return a + (b - a) * u
  }
}
