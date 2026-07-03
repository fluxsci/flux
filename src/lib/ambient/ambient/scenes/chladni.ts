// Chladni sand — a plate rings at a random mode and sand settles onto the
// nodal lines, grain by grain. When the sprite fades, the tone has changed
// and the sand is shaken loose again.

import { makeRng } from '../../core/prng'
import { finish, hairline, type Dot } from '../brush'
import { fxa } from '../../core/palette'
import type { Scene, SpriteSpec } from '../types'

const SANDS = ['base-700', 'orange-800', 'blue-700', 'purple-700']

export const chladni: Scene = {
  id: 'chladni',
  label: 'chladni sand',
  blurb: 'A plate rings at a hidden tone; sand settles grain by grain onto the nodal lines.',
  params: [
    { key: 'modes', label: 'Highest mode', min: 3, max: 9, step: 1, default: 6 },
    { key: 'grains', label: 'Sand grains', min: 400, max: 2400, step: 50, default: 1200 },
    { key: 'tightness', label: 'Line tightness', min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: 'sand', label: 'Sand', min: 0, max: 1, step: 1, default: 0, options: ['ink', 'tinted'] },
    { key: 'area', label: 'Plate', min: 0, max: 1, step: 1, default: 0, options: ['square', 'full pane'] },
  ],
  life: { rate: 2.4, maxConcurrent: 2, grow: 10, hold: 24, fade: 10 },

  spawn(seed, index, w, h, k, occupied = []): SpriteSpec | null {
    const fullPane = Math.round(k.area) === 1
    if (fullPane && occupied.length) return null // the whole pane is one plate

    const rng = makeRng(`${seed}|chladni|${index}`)
    const side = Math.min(w, h) * 0.82
    const px = fullPane ? 6 : (w - side) / 2
    const py = fullPane ? 6 : rng.range(0.1, 0.9 - side / h) * h
    const rw = fullPane ? w - 12 : side
    const rh = fullPane ? h - 12 : side
    const m = rng.int(1, Math.round(k.modes))
    let n = rng.int(1, Math.round(k.modes))
    if (n === m) n = m + 1
    const eps = 0.18 - 0.13 * k.tightness
    const plate = (x: number, y: number) =>
      Math.cos(n * Math.PI * x) * Math.cos(m * Math.PI * y) -
      Math.cos(m * Math.PI * x) * Math.cos(n * Math.PI * y)

    const tone = Math.round(k.sand) === 1 ? rng.pick(SANDS) : 'base-700'
    const dots: Dot[] = []
    const target = Math.min(
      4200,
      Math.round(k.grains * (fullPane ? (w * h) / (side * side) : 1))
    )
    let guard = 0
    while (dots.length < target && guard++ < target * 40) {
      const ux = rng.next()
      const uy = rng.next()
      if (Math.abs(plate(ux, uy)) < eps) {
        dots.push({
          x: px + ux * rw,
          y: py + uy * rh,
          r: rng.range(0.5, 1.05),
          tone,
          alpha: rng.range(0.3, 0.52),
        })
      }
    }

    const ops: SpriteSpec['ops'] = []
    if (!fullPane) {
      // the plate itself, barely there
      const corners = [
        { x: px, y: py },
        { x: px + rw, y: py },
        { x: px + rw, y: py + rh },
        { x: px, y: py + rh },
        { x: px, y: py },
      ]
      hairline(ops, corners, { tone: 'base-400', alpha: 0.3, w: 0.5, t0: 0, t1: 1.5 })
    }

    // each grain bounces — fainter ghost taps skittering inward — then lands.
    // played back over the grow time, the whole plate shivers into pattern
    const ghostC1 = fxa(tone, 0.06)
    const ghostC2 = fxa(tone, 0.1)
    dots.forEach((d, i) => {
      const tLand = 3 + ((i * 7919) % target) / target * 34
      const nB = rng.chance(0.6) ? 2 : 3
      for (let b = 0; b < nB; b++) {
        const dist = (nB - b) * rng.range(3.5, 10)
        const a = rng.range(0, Math.PI * 2)
        const gx = d.x + Math.cos(a) * dist
        const gy = d.y + Math.sin(a) * dist
        const gr = d.r * rng.range(0.55, 0.8)
        const gc = b === nB - 1 ? ghostC2 : ghostC1
        ops.push({
          t: tLand - (nB - b) * 0.4,
          draw(ctx) {
            ctx.beginPath()
            ctx.arc(gx, gy, gr, 0, Math.PI * 2)
            ctx.fillStyle = gc
            ctx.fill()
          },
        })
      }
      const finalC = fxa(d.tone, d.alpha)
      ops.push({
        t: tLand,
        draw(ctx) {
          ctx.beginPath()
          ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
          ctx.fillStyle = finalC
          ctx.fill()
        },
      })
    })

    return {
      ops,
      duration: finish(ops),
      bounds: fullPane ? undefined : { x: px - 4, y: py - 4, w: rw + 8, h: rh + 8 },
    }
  },
}
