// Suminagashi — floating-ink marbling. Rings of ink spread from a dip point
// and are gently combed by an invisible current; outer rings drift furthest.

import { makeRng } from '../../core/prng'
import { makeNoise2D, curl2 } from '../noise2'
import { finish, hairline, TAU, type Pt } from '../brush'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const INK_SETS: ReadonlyArray<[string, string]> = [
  ['base-700', 'blue-600'],
  ['base-700', 'base-500'],
  ['blue-700', 'cyan-600'],
  ['purple-700', 'magenta-600'],
]

export const suminagashi: Scene = {
  id: 'suminagashi',
  label: 'suminagashi',
  blurb: 'Floating ink dropped on water, ring after ring, combed by a current no one sees.',
  params: [
    { key: 'rings', label: 'Rings', min: 5, max: 16, step: 1, default: 10 },
    { key: 'comb', label: 'Combing', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'spread', label: 'Ring spread', min: 5, max: 14, step: 0.25, default: 8.5 },
    { key: 'ink', label: 'Ink pair', min: 0, max: 3, step: 1, default: 0, options: ['sumi+indigo', 'sumi', 'indigo', 'plum'] },
  ],
  life: { rate: 2.6, maxConcurrent: 3, grow: 11, hold: 18, fade: 10 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const field = makeNoise2D(makeRng(`${seed}|marblefield`))
    const rng = makeRng(`${seed}|marble|${index}`)
    const nR = Math.round(k.rings)
    const spread = k.spread
    const maxR = spread * nR
    const cx = rng.range(w * 0.15, w * 0.85)
    const cy = rng.range(Math.min(maxR, h * 0.2), h - Math.min(maxR, h * 0.2))
    const inks = INK_SETS[Math.min(3, Math.round(k.ink))]
    const s = 2.0 / Math.min(w, h)
    const ox = index * 3.1

    const ops: AmbientOp[] = []
    // dip point
    ops.push({
      t: 0,
      draw(ctx) {
        ctx.beginPath()
        ctx.arc(cx, cy, 1.4, 0, TAU)
        ctx.fillStyle = `rgba(16,15,15,0.35)`
        ctx.fill()
      },
    })

    let drawn = 0
    for (let i = 1; i <= nR; i++) {
      const r = spread * i * rng.range(0.92, 1.08)
      const nP = Math.max(40, Math.round(r * 1.1))
      let pts: Pt[] = []
      for (let p = 0; p <= nP; p++) {
        const a = (p / nP) * TAU
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
      }
      // comb: advect ring points through the current — outer rings further
      const combSteps = Math.round(i * 2.2 * k.comb)
      for (let c = 0; c < combSteps; c++) {
        pts = pts.map((p) => {
          const [dx, dy] = curl2(field, p.x * s + ox, p.y * s)
          return { x: p.x + dx * 1.6, y: p.y + dy * 1.6 }
        })
      }
      const tone = i % 2 === 0 ? inks[0] : inks[1]
      const t0 = 1 + drawn * 2
      hairline(ops, pts, {
        tone,
        alpha: i % 2 === 0 ? 0.34 : 0.22,
        w: i % 2 === 0 ? 0.7 : 0.5,
        t0,
        t1: t0 + 1.8,
        breaks: 0.04,
        breakPhase: index * 5 + i,
      })
      drawn++
    }

    const pad = maxR + 30 * k.comb + 12
    return {
      ops,
      duration: finish(ops),
      bounds: { x: cx - pad, y: cy - pad, w: pad * 2, h: pad * 2 },
    }
  },
}
