// Sumi mountains — misty ridgelines composing themselves stratum by stratum:
// a dry-brush ink crest, pale washes settling beneath it, untouched paper
// for the mist. Distant ridges are paler; sometimes a small moon.

import { makeRng } from '../../core/prng'
import { makeNoise1D } from '../../core/noise'
import { finish, hairline, ringPts, softDisc, type Pt } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const TINTS: ReadonlyArray<[string, string]> = [
  ['base-700', 'base-300'],
  ['blue-700', 'blue-200'],
  ['olive-700', 'olive-200'],
]

export const mountains: Scene = {
  id: 'mountains',
  label: 'sumi mountains',
  blurb: 'Misty ridgelines settle one behind another — ink crests, quiet washes, paper for fog.',
  params: [
    { key: 'rough', label: 'Ridge roughness', min: 0.3, max: 1.5, step: 0.01, default: 0.8 },
    { key: 'tint', label: 'Ink', min: 0, max: 2, step: 1, default: 0, options: ['sumi', 'indigo', 'moss'] },
    { key: 'washes', label: 'Wash depth', min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: 'moon', label: 'Moon chance', min: 0, max: 1, step: 0.01, default: 0.2 },
  ],
  life: { rate: 3, maxConcurrent: 5, grow: 8, hold: 26, fade: 12 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|ridge|${index}`)
    const noise = makeNoise1D(rng)
    const ops: AmbientOp[] = []

    // occasionally the sprite is just a moon in the upper sky
    if (rng.chance(k.moon * 0.5)) {
      const mr = rng.range(9, 16)
      const mx = rng.range(w * 0.2, w * 0.8)
      const my = rng.range(h * 0.08, h * 0.3)
      softDisc(ops, mx, my, mr, 'yellow-300', 0.22, 0.5, rng.range(0, 60))
      hairline(ops, ringPts(mx, my, mr, 30, 0.4, rng.range(0, 90)), {
        tone: 'yellow-600',
        alpha: 0.2,
        w: 0.5,
        t0: 1.2,
        t1: 2.2,
      })
      return {
        ops,
        duration: finish(ops),
        bounds: { x: mx - mr - 6, y: my - mr - 6, w: mr * 2 + 12, h: mr * 2 + 12 },
      }
    }

    const yBase = rng.range(h * 0.18, h * 0.9)
    const distance = 1 - yBase / h // higher on the page reads as farther away
    const amp = h * rng.range(0.045, 0.11) * k.rough
    const tint = TINTS[Math.min(2, Math.round(k.tint))]
    const fade = 0.55 + 0.45 * (1 - distance) // distant ridges are paler

    // the ridgeline
    const f1 = rng.range(0.006, 0.012)
    const f2 = f1 * rng.range(2.5, 4)
    const ph1 = rng.range(0, 200)
    const ph2 = rng.range(0, 200)
    const crest: Pt[] = []
    for (let x = -4; x <= w + 4; x += 3) {
      const y = yBase - Math.abs(noise(x * f1 + ph1)) * amp - noise(x * f2 + ph2) * amp * 0.25
      crest.push({ x, y })
    }
    hairline(ops, crest, {
      tone: tint[0],
      alpha: 0.42 * fade,
      w: 0.9,
      t0: 0,
      t1: 6,
      breaks: 0.1,
      breakPhase: index * 3,
    })

    // washes settling under the crest, shallower each pass
    const nWash = 1 + Math.round(2 * k.washes)
    for (let l = 0; l < nWash; l++) {
      const depth = h * (0.02 + 0.022 * l)
      const washC = fxa(tint[1], 0.09 * fade)
      const top = crest.map((p) => ({ x: p.x, y: p.y + l * 2 }))
      const t0 = 2 + l * 1.5
      ops.push({
        t: t0,
        draw(ctx) {
          ctx.beginPath()
          ctx.moveTo(top[0].x, top[0].y)
          for (const p of top) ctx.lineTo(p.x, p.y)
          for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i].x, top[i].y + depth)
          ctx.closePath()
          ctx.fillStyle = washC
          ctx.fill()
        },
      })
    }

    return { ops, duration: finish(ops) }
  },
}
