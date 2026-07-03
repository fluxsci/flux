// Seeded, deterministic randomness. Same seed string -> same stream, forever.

export interface Rng {
  next(): number // [0, 1)
  range(a: number, b: number): number
  int(a: number, b: number): number // inclusive
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
  gauss(): number // approx normal, mean 0, sd ~0.7, clamped to [-2, 2]
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeRng(seed: string): Rng {
  const next = mulberry32(xmur3(seed)())
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => Math.floor(a + (b - a + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    gauss: () => next() + next() + next() + next() - 2,
  }
}

// Order-independent per-index hash in [0,1) — used for paint jitter so that
// changing one parameter never reshuffles the randomness of everything else.
export function hash01(i: number, j = 0): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
