// Asemic marginalia — a manuscript hand writing invented cursive: words of
// looping minim strokes along faint ruled baselines, an occasional red
// rubric initial, an underline flourish. Writing without meaning, which is
// exactly why you can watch it while you think.

import { makeRng, type Rng } from '../../core/prng'
import { finish, hairline, type Pt } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

function word(rng: Rng, x0: number, y0: number, slant: number, loopy: number): { pts: Pt[]; width: number } {
  const glyphs = rng.int(2, 6)
  const pts: Pt[] = []
  let x = x0
  for (let g = 0; g < glyphs; g++) {
    const kind = rng.next()
    const gw = rng.range(3.2, 5.5)
    if (kind < 0.55) {
      // minims: n/m/u humps
      const humps = rng.int(1, 2)
      for (let hp = 0; hp < humps; hp++) {
        pts.push({ x, y: y0 })
        pts.push({ x: x + gw * 0.25 + slant, y: y0 - rng.range(2.4, 3.6) })
        pts.push({ x: x + gw * 0.75 + slant, y: y0 - rng.range(2.4, 3.6) })
        pts.push({ x: x + gw, y: y0 })
        x += gw
      }
    } else if (kind < 0.55 + loopy * 0.3) {
      // ascender or descender loop
      const up = rng.chance(0.55)
      const hgt = rng.range(6, 9) * (up ? -1 : 1)
      pts.push({ x, y: y0 })
      pts.push({ x: x + gw * 0.15 + slant * 1.6, y: y0 + hgt })
      pts.push({ x: x + gw * 0.55 + slant * 1.6, y: y0 + hgt * 0.92 })
      pts.push({ x: x + gw * 0.5, y: y0 + hgt * 0.15 })
      pts.push({ x: x + gw, y: y0 })
      x += gw
    } else {
      // low connecting curve (like e/o/c)
      pts.push({ x, y: y0 })
      pts.push({ x: x + gw * 0.3 + slant, y: y0 - rng.range(1.4, 2.4) })
      pts.push({ x: x + gw * 0.7, y: y0 - rng.range(0.4, 1.2) })
      pts.push({ x: x + gw, y: y0 })
      x += gw
    }
  }
  return { pts, width: x - x0 }
}

export const asemic: Scene = {
  id: 'asemic',
  label: 'marginalia',
  blurb: 'A hand writing invented cursive along faint rules — marginalia in no language at all.',
  params: [
    { key: 'lines', label: 'Lines', min: 2, max: 6, step: 1, default: 4 },
    { key: 'slant', label: 'Slant', min: 0, max: 1, step: 0.01, default: 0.4 },
    { key: 'loopy', label: 'Loops & flourish', min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: 'rubric', label: 'Rubrication', min: 0, max: 1, step: 0.01, default: 0.35 },
  ],
  life: { rate: 2.4, maxConcurrent: 3, grow: 13, hold: 20, fade: 10 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|script|${index}`)
    const nLines = Math.round(k.lines)
    const lineGap = rng.range(15, 19)
    const blockW = rng.range(0.42, 0.62) * w
    const px = rng.range(w * 0.08, w - blockW - w * 0.08)
    const py = rng.range(h * 0.08, h - nLines * lineGap - h * 0.1)
    const slant = k.slant * 0.9
    const ops: AmbientOp[] = []
    let t = 0

    for (let l = 0; l < nLines; l++) {
      const y = py + l * lineGap
      const lineW = blockW * (l === nLines - 1 ? rng.range(0.4, 0.85) : rng.range(0.9, 1))
      // the ruled baseline, almost nothing
      hairline(
        ops,
        [
          { x: px - 2, y: y + 1.2 },
          { x: px + lineW + 2, y: y + 1.2 },
        ],
        { tone: 'base-300', alpha: 0.5, w: 0.4, t0: t, t1: t + 0.3 }
      )
      t += 0.4

      let x = px
      // rubric initial on the first line
      if (l === 0 && rng.chance(k.rubric)) {
        const caps = rng.range(8, 11)
        const swash: Pt[] = [
          { x, y },
          { x: x + caps * 0.1 + slant * 2, y: y - caps },
          { x: x + caps * 0.7 + slant * 2, y: y - caps * 0.85 },
          { x: x + caps * 0.35, y: y - caps * 0.3 },
          { x: x + caps * 0.8, y },
        ]
        hairline(ops, swash, { tone: 'red-600', alpha: 0.45, w: 0.9, t0: t, t1: t + 1.2 })
        x += caps + 3
        t += 1.4
      }
      while (x < px + lineW - 12) {
        const wd = word(rng, x, y, slant, k.loopy)
        const dur = wd.pts.length * 0.045
        hairline(ops, wd.pts, { tone: 'base-700', alpha: 0.36, w: 0.55, t0: t, t1: t + dur })
        t += dur + 0.18
        x += wd.width + rng.range(4.5, 7)
      }
      t += 0.5
    }

    // an underline flourish beneath something important
    if (rng.chance(k.loopy * 0.5)) {
      const l = rng.int(0, nLines - 1)
      const y = py + l * lineGap + 3.5
      const fx0 = px + rng.range(0, blockW * 0.3)
      const fw = rng.range(30, 70)
      const fl: Pt[] = []
      for (let i = 0; i <= 12; i++) {
        fl.push({ x: fx0 + (i / 12) * fw, y: y + Math.sin(i * 1.1) * 0.8 })
      }
      hairline(ops, fl, { tone: 'red-600', alpha: 0.3, w: 0.5, t0: t, t1: t + 0.8 })
    }

    return {
      ops,
      duration: finish(ops),
      bounds: { x: px - 14, y: py - 16, w: blockW + 28, h: nLines * lineGap + 26 },
    }
  },
}
