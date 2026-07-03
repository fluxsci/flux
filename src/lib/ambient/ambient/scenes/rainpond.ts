// Rain pond — raindrop events on still water. Each sprite is one drop:
// concentric hand-wobbled rings appearing outward in sequence, width and
// pigment thinning with radius, then the whole ripple stills and fades.

import { makeRng } from '../../core/prng'
import { finish, hairline, ringPts, softDisc } from '../brush'
import type { Scene, SpriteSpec } from '../types'

const INKS: ReadonlyArray<[string, string]> = [
  ['blue-600', 'blue-200'],
  ['cyan-600', 'cyan-200'],
  ['base-600', 'base-300'],
]

export const rainpond: Scene = {
  id: 'rainpond',
  label: 'rain pond',
  blurb: 'Raindrops on still water — ripple rings bloom outward, still, and dissolve.',
  params: [
    { key: 'rings', label: 'Rings per drop', min: 2, max: 6, step: 1, default: 4 },
    { key: 'spacing', label: 'Ring spacing', min: 6, max: 22, step: 0.5, default: 12 },
    { key: 'size', label: 'Scale', min: 0.6, max: 1.8, step: 0.01, default: 1 },
    { key: 'hue', label: 'Ink', min: 0, max: 2, step: 1, default: 0, options: ['water', 'ink', 'mixed'] },
  ],
  life: { rate: 10, maxConcurrent: 8, grow: 5, hold: 7, fade: 6 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|rain|${index}`)
    const nR = Math.round(k.rings)
    const spacing = k.spacing * k.size
    const maxR = spacing * (0.75 + (nR - 1)) + 8
    const cx = rng.range(w * 0.06, w * 0.94)
    const cy = rng.range(h * 0.06, h * 0.94)
    const hueMode = Math.round(k.hue)
    const ink =
      hueMode === 2
        ? rng.pick(INKS)
        : hueMode === 1
          ? INKS[2]
          : rng.pick(INKS.slice(0, 2))

    const ops: SpriteSpec['ops'] = []
    // the strike point
    softDisc(ops, cx, cy, spacing * 0.4, ink[1], 0.09, 0.15, rng.range(0, 60))

    for (let i = 0; i < nR; i++) {
      const r = spacing * (0.75 + i)
      const pts = ringPts(cx, cy, r, Math.max(26, Math.round(r * 0.9)), 1 + i * 0.5, rng.range(0, 90))
      const t0 = 0.4 + i * 1.5
      hairline(ops, pts, {
        tone: ink[0],
        alpha: Math.max(0.1, 0.3 - i * 0.045),
        w: Math.max(0.4, 0.85 - i * 0.1),
        t0,
        t1: t0 + 1.3,
        breaks: 0.06,
        breakPhase: index * 3 + i,
      })
    }

    return {
      ops,
      duration: finish(ops),
      bounds: { x: cx - maxR, y: cy - maxR, w: maxR * 2, h: maxR * 2 },
    }
  },
}
