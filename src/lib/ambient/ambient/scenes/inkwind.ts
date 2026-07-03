// Ink wind — streamlines of a slowly changing breeze, drawn tip-first like
// the lines on a wind map. A few gusts get a pale wash; the weather drifts
// between sprites.

import { makeRng } from '../../core/prng'
import { makeNoise2D, curl2 } from '../noise2'
import { finish, hairline, inkStroke, TAU, type Pt } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const GUST_TONES = ['blue', 'cyan', 'purple', 'magenta']
const ALL_TONES = ['red', 'orange', 'yellow', 'olive', 'green', 'cyan', 'blue', 'purple', 'magenta']

export const inkwind: Scene = {
  id: 'inkwind',
  label: 'ink wind',
  blurb: 'Streamlines of an invisible breeze, drawn like a wind map. The weather keeps drifting.',
  params: [
    { key: 'lines', label: 'Streamlines', min: 15, max: 90, step: 1, default: 45 },
    { key: 'flow', label: 'Flow scale', min: 0.5, max: 2.5, step: 0.01, default: 1.2 },
    { key: 'length', label: 'Line length', min: 0.4, max: 1.6, step: 0.01, default: 1 },
    { key: 'accent', label: 'Colored gusts', min: 0, max: 1, step: 0.01, default: 0.3 },
    { key: 'hues', label: 'Gust hues', min: 0, max: 2, step: 1, default: 0, options: ['one', 'duo', 'all flexoki'] },
  ],
  life: { rate: 2.2, maxConcurrent: 2, grow: 12, hold: 18, fade: 10 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const field = makeNoise2D(makeRng(`${seed}|windfield`))
    const rng = makeRng(`${seed}|wind|${index}`)
    const s = (2.2 * k.flow) / Math.min(w, h)
    const ox = index * 2.3
    const oy = index * 1.4
    const flow = (x: number, y: number) => curl2(field, x * s + ox, y * s + oy)

    const ops: AmbientOp[] = []
    const nLines = Math.round(k.lines)
    const hueMode = Math.round(k.hues)
    const famA = rng.pick(GUST_TONES)
    const famB = rng.pick(ALL_TONES)
    const gustFam = () => (hueMode === 2 ? rng.pick(ALL_TONES) : hueMode === 1 ? (rng.chance(0.5) ? famA : famB) : famA)
    for (let i = 0; i < nLines; i++) {
      let x = rng.range(w * 0.03, w * 0.97)
      let y = rng.range(h * 0.03, h * 0.97)
      const steps = Math.round(rng.range(50, 150) * k.length)
      const pts: Pt[] = [{ x, y }]
      for (let sN = 0; sN < steps; sN++) {
        const [dx, dy] = flow(x, y)
        x += dx * 2.6
        y += dy * 2.6
        if (x < 2 || x > w - 2 || y < 2 || y > h - 2) break
        pts.push({ x, y })
      }
      if (pts.length < 8) continue
      const t0 = rng.range(0, 24)
      const t1 = t0 + pts.length * 0.05
      if (rng.chance(k.accent * 0.55)) {
        const fam = gustFam()
        inkStroke(ops, pts, {
          w0: 0.9,
          w1: 0.5,
          tone: `${fam}-600`,
          washTone: `${fam}-200`,
          alpha: 1,
          t0,
          t1,
        })
      } else {
        hairline(ops, pts, {
          tone: 'base-600',
          alpha: 0.26,
          w: 0.55,
          taperTo: 0.5,
          t0,
          t1,
        })
      }
      // a seed dot where the line was released
      if (rng.chance(0.35)) {
        const p0 = pts[0]
        const dotC = fxa('base-600', 0.3)
        ops.push({
          t: t0,
          draw(ctx) {
            ctx.beginPath()
            ctx.arc(p0.x, p0.y, 0.8, 0, TAU)
            ctx.fillStyle = dotC
            ctx.fill()
          },
        })
      }
    }

    return { ops, duration: finish(ops) }
  },
}
