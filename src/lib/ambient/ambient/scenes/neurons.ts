// Cajal neurons — Golgi-stained cells the way Ramón y Cajal drew them: an
// irregular soma, thinning dendrites beaded with varicosities and bristling
// with spines, and one long fine axon wandering off toward the edge of the
// plate. Growth is tip-wise, like the stain spreading.

import { makeRng, type Rng } from '../../core/prng'
import { makeNoise1D } from '../../core/noise'
import { finish, inkStroke, hairline, ringPts, TAU, type Pt } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const STAINS: ReadonlyArray<{ ink: string; wash: string; soma: string }> = [
  { ink: 'base-800', wash: 'base-400', soma: 'base-600' }, // golgi
  { ink: 'orange-850', wash: 'orange-400', soma: 'orange-800' }, // cajal sepia
  { ink: 'purple-700', wash: 'purple-300', soma: 'purple-600' }, // nissl violet
]

export const neurons: Scene = {
  id: 'neurons',
  label: 'cajal neurons',
  blurb: 'Golgi-stained neurons growing dendrite by dendrite, spines and all, after Ramón y Cajal.',
  params: [
    { key: 'arbors', label: 'Dendrites', min: 3, max: 8, step: 1, default: 5 },
    { key: 'reach', label: 'Arbor reach', min: 0.5, max: 1.6, step: 0.01, default: 1 },
    { key: 'spines', label: 'Spininess', min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: 'stain', label: 'Stain', min: 0, max: 2, step: 1, default: 1, options: ['golgi', 'cajal', 'nissl'] },
    { key: 'axon', label: 'Axon', min: 0, max: 1, step: 1, default: 1, options: ['off', 'on'] },
  ],
  life: { rate: 2.4, maxConcurrent: 3, grow: 15, hold: 24, fade: 10 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|neuron|${index}`)
    const noise = makeNoise1D(rng)
    const stain = STAINS[Math.min(2, Math.round(k.stain))]
    const ops: AmbientOp[] = []

    const somaR = rng.range(5.5, 10)
    const reach = Math.min(w, h) * 0.32 * k.reach
    const cx = rng.range(reach * 0.5, w - reach * 0.5)
    const cy = rng.range(reach * 0.5, h - reach * 0.5)

    // soma: irregular blob, two washes and an ink rim
    const somaPts = ringPts(cx, cy, somaR, 22, somaR * 0.22, rng.range(0, 60))
    const somaFill = fxa(stain.soma, 0.3)
    const somaFill2 = fxa(stain.ink, 0.25)
    ops.push({
      t: 0,
      draw(ctx) {
        ctx.beginPath()
        ctx.moveTo(somaPts[0].x, somaPts[0].y)
        for (const p of somaPts) ctx.lineTo(p.x, p.y)
        ctx.closePath()
        ctx.fillStyle = somaFill
        ctx.fill()
        ctx.beginPath()
        ctx.arc(cx + somaR * 0.1, cy - somaR * 0.1, somaR * 0.55, 0, TAU)
        ctx.fillStyle = somaFill2
        ctx.fill()
      },
    })
    hairline(ops, somaPts, { tone: stain.ink, alpha: 0.35, w: 0.6, t0: 0.3, t1: 1.2 })

    const spineC = fxa(stain.ink, 0.3)
    const boutonC = fxa(stain.ink, 0.3)

    interface DWalk {
      x: number
      y: number
      heading: number
      w: number
      left: number
      t: number
      depth: number
      phase: number
    }
    const nArbors = Math.round(k.arbors)
    const rot0 = rng.range(0, TAU)
    const queue: DWalk[] = []
    for (let a = 0; a < nArbors; a++) {
      const ang = rot0 + (a / nArbors) * TAU + rng.gauss() * 0.25
      queue.push({
        x: cx + Math.cos(ang) * somaR * 0.9,
        y: cy + Math.sin(ang) * somaR * 0.9,
        heading: ang,
        w: rng.range(1.3, 1.9),
        left: Math.round(rng.range(14, 34) * k.reach),
        t: 1 + a * 0.6,
        depth: 0,
        phase: rng.range(0, 200),
      })
    }

    while (queue.length) {
      const wk = queue.shift()!
      const pts: Pt[] = [{ x: wk.x, y: wk.y }]
      const widths: number[] = [wk.w]
      const total = wk.left
      let sN = 0
      while (wk.left-- > 0) {
        wk.heading += noise(sN * 0.25 + wk.phase) * 0.5
        // dendrites meander but always grow away from the soma — never loop
        const ra = Math.atan2(wk.y - cy, wk.x - cx)
        let dev = wk.heading - ra
        while (dev > Math.PI) dev -= TAU
        while (dev < -Math.PI) dev += TAU
        const maxDev = Math.PI * 0.42
        if (dev > maxDev) wk.heading = ra + maxDev
        else if (dev < -maxDev) wk.heading = ra - maxDev
        const step = rng.range(3.2, 4.6)
        wk.x += Math.cos(wk.heading) * step
        wk.y += Math.sin(wk.heading) * step
        wk.t += 0.55
        sN++
        if (wk.x < 4 || wk.x > w - 4 || wk.y < 4 || wk.y > h - 4) break
        pts.push({ x: wk.x, y: wk.y })
        const frac = sN / total
        const width = Math.max(0.3, wk.w * (1 - 0.8 * frac))
        widths.push(width)

        // dendritic spines
        if (rng.chance(k.spines * 0.55)) {
          const side = rng.chance(0.5) ? 1 : -1
          const sx2 = wk.x
          const sy2 = wk.y
          const sa = wk.heading + side * rng.range(1.2, 1.9)
          const sl = rng.range(1.2, 2.4)
          const st = wk.t + 0.3
          ops.push({
            t: st,
            draw(ctx) {
              ctx.beginPath()
              ctx.moveTo(sx2, sy2)
              ctx.lineTo(sx2 + Math.cos(sa) * sl, sy2 + Math.sin(sa) * sl)
              ctx.strokeStyle = spineC
              ctx.lineWidth = 0.45
              ctx.lineCap = 'round'
              ctx.stroke()
            },
          })
        }
        // branch
        if (wk.depth < 3 && wk.left > 6 && rng.chance(0.14)) {
          const side = rng.chance(0.5) ? 1 : -1
          queue.push({
            x: wk.x,
            y: wk.y,
            heading: wk.heading + side * rng.range(0.5, 1.1),
            w: width * 0.85,
            left: Math.round(wk.left * rng.range(0.5, 0.85)),
            t: wk.t,
            depth: wk.depth + 1,
            phase: rng.range(0, 200),
          })
        }
      }
      if (pts.length > 2) {
        inkStroke(ops, pts, {
          w0: widths[0],
          w1: widths[widths.length - 1],
          tone: stain.ink,
          washTone: stain.wash,
          alpha: 0.9,
          t0: wk.t - pts.length * 0.55,
          t1: wk.t,
        })
      }
    }

    // the axon: one long fine wire with boutons, headed off-plate
    if (Math.round(k.axon) === 1) {
      const ang = rot0 + Math.PI / nArbors + rng.range(-0.2, 0.2)
      let x = cx + Math.cos(ang) * somaR
      let y = cy + Math.sin(ang) * somaR
      let heading = ang
      const pts: Pt[] = [{ x, y }]
      const phase = rng.range(0, 200)
      const bt0 = 4
      for (let sN = 0; sN < 220; sN++) {
        heading += noise(sN * 0.08 + phase) * 0.18
        // axons arc but never lasso back on themselves
        let dev = heading - ang
        while (dev > Math.PI) dev -= TAU
        while (dev < -Math.PI) dev += TAU
        const maxDev = Math.PI * 0.55
        if (dev > maxDev) heading = ang + maxDev
        else if (dev < -maxDev) heading = ang - maxDev
        x += Math.cos(heading) * 4
        y += Math.sin(heading) * 4
        if (x < 2 || x > w - 2 || y < 2 || y > h - 2) break
        pts.push({ x, y })
        if (rng.chance(0.04)) {
          const bx = x
          const by = y
          ops.push({
            t: bt0 + sN * 0.12,
            draw(ctx) {
              ctx.beginPath()
              ctx.arc(bx, by, 0.7, 0, TAU)
              ctx.fillStyle = boutonC
              ctx.fill()
            },
          })
        }
      }
      hairline(ops, pts, {
        tone: stain.ink,
        alpha: 0.32,
        w: 0.5,
        t0: bt0,
        t1: bt0 + pts.length * 0.12,
      })
    }

    return { ops, duration: finish(ops) }
  },
}
