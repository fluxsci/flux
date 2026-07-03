// Orrery — small diagrams from an old astronomy atlas: a warm sun, dashed
// elliptical orbits, tinted planets with short motion trails, the occasional
// comet with a stippled tail.

import { makeRng } from '../../core/prng'
import { dashedLine, finish, hairline, softDisc, stipple, TAU, type Pt, type Dot } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const PLANET_TONES = ['blue', 'red', 'orange', 'purple', 'cyan', 'magenta']

export const orrery: Scene = {
  id: 'orrery',
  label: 'orrery',
  blurb: 'Little planetary diagrams from a forgotten atlas — orbits, trails, and passing comets.',
  params: [
    { key: 'orbits', label: 'Orbits', min: 2, max: 5, step: 1, default: 3 },
    { key: 'tilt', label: 'Orbit tilt', min: 0.3, max: 1, step: 0.01, default: 0.65 },
    { key: 'comet', label: 'Comet chance', min: 0, max: 1, step: 0.01, default: 0.35 },
    { key: 'size', label: 'Size', min: 0.6, max: 1.5, step: 0.01, default: 1 },
  ],
  life: { rate: 2.8, maxConcurrent: 3, grow: 9, hold: 22, fade: 9 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|orrery|${index}`)
    const nOrb = Math.round(k.orbits)
    const Rmax = Math.min(w, h) * rng.range(0.16, 0.24) * k.size
    const pad = Rmax + 16
    const cx = rng.range(pad, w - pad)
    const cy = rng.range(pad, h - pad)
    const tilt = k.tilt * rng.range(0.85, 1.15)
    const rot = rng.range(0, Math.PI)

    const ops: AmbientOp[] = []
    // the sun
    softDisc(ops, cx, cy, 3.2 * k.size, 'yellow-400', 0.35, 0, rng.range(0, 60))
    const sunC = fxa('yellow-600', 0.5)
    ops.push({
      t: 0.4,
      draw(ctx) {
        ctx.beginPath()
        ctx.arc(cx, cy, 1.6 * k.size, 0, TAU)
        ctx.fillStyle = sunC
        ctx.fill()
      },
    })

    const orbitPt = (r: number, a: number): Pt => {
      const ex = Math.cos(a) * r
      const ey = Math.sin(a) * r * tilt
      return {
        x: cx + ex * Math.cos(rot) - ey * Math.sin(rot),
        y: cy + ex * Math.sin(rot) + ey * Math.cos(rot),
      }
    }

    const hasComet = rng.chance(k.comet)
    for (let o = 0; o < nOrb; o++) {
      const r = Rmax * ((o + 1) / nOrb) * rng.range(0.92, 1.08)
      const t0 = 1 + o * 1.8
      const ring: Pt[] = []
      for (let i = 0; i <= 72; i++) ring.push(orbitPt(r, (i / 72) * TAU))
      dashedLine(ops, ring, { tone: 'base-500', alpha: 0.5, w: 0.55, dash: 2.8, gap: 3.2, t0, t1: t0 + 1.6 })

      if (hasComet && o === nOrb - 1) continue // comet replaces the outer planet

      // the planet, its trail, and sometimes a moon
      const fam = rng.pick(PLANET_TONES)
      const pa = rng.range(0, TAU)
      const p = orbitPt(r, pa)
      const pr = rng.range(1.6, 3.2) * k.size
      const tP = t0 + 2
      softDisc(ops, p.x, p.y, pr, `${fam}-300`, 0.4, tP, rng.range(0, 60))
      const rimC = fxa(`${fam}-600`, 0.55)
      ops.push({
        t: tP + 0.3,
        draw(ctx) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, pr, 0, TAU)
          ctx.strokeStyle = rimC
          ctx.lineWidth = 0.5
          ctx.stroke()
        },
      })
      // motion trail along the orbit
      const trail: Pt[] = []
      for (let i = 0; i <= 14; i++) trail.push(orbitPt(r, pa - 0.05 - (i / 14) * rng.range(0.35, 0.6)))
      hairline(ops, trail, { tone: `${fam}-600`, alpha: 0.45, w: 0.9, taperTo: 0.2, t0: tP + 0.5, t1: tP + 1.3 })
      if (rng.chance(0.3)) {
        const ma = rng.range(0, TAU)
        const mx = p.x + Math.cos(ma) * pr * 2.4
        const my = p.y + Math.sin(ma) * pr * 2.4
        const moonC = fxa('base-600', 0.45)
        ops.push({
          t: tP + 1.5,
          draw(ctx) {
            ctx.beginPath()
            ctx.arc(mx, my, 0.8, 0, TAU)
            ctx.fillStyle = moonC
            ctx.fill()
          },
        })
      }
    }

    if (hasComet) {
      // a comet cutting across on a parabolic path
      const a0 = rng.range(0, TAU)
      const head = orbitPt(Rmax * rng.range(0.9, 1.05), a0)
      const path: Pt[] = []
      for (let i = 0; i <= 20; i++) {
        const a = a0 - (i / 20) * rng.range(0.9, 1.4)
        const r = Rmax * (1 + (i / 20) * 0.5)
        path.push(orbitPt(r, a))
      }
      const tC = 1 + nOrb * 1.8 + 1
      dashedLine(ops, path, { tone: 'base-500', alpha: 0.42, w: 0.5, dash: 1.8, gap: 2.6, t0: tC, t1: tC + 1.4 })
      softDisc(ops, head.x, head.y, 2 * k.size, 'cyan-200', 0.35, tC + 1.6, rng.range(0, 60))
      // stippled tail pointing away from the sun
      const away = Math.atan2(head.y - cy, head.x - cx)
      const tail: Dot[] = []
      for (let i = 0; i < 26; i++) {
        const d = 4 + i * 1.4 + rng.range(0, 1.5)
        const spreadA = away + rng.range(-0.22, 0.22)
        tail.push({
          x: head.x + Math.cos(spreadA) * d,
          y: head.y + Math.sin(spreadA) * d,
          r: Math.max(0.3, 0.9 - i * 0.02),
          tone: 'cyan-600',
          alpha: Math.max(0.08, 0.3 - i * 0.008),
        })
      }
      stipple(ops, tail, tC + 1.8, tC + 3)
    }

    const pad2 = pad + 34
    return {
      ops,
      duration: finish(ops),
      bounds: { x: cx - pad2, y: cy - pad2, w: pad2 * 2, h: pad2 * 2 },
    }
  },
}
