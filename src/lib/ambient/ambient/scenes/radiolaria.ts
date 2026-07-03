// Radiolaria — Haeckel's microscopic glass skeletons: n-fold symmetric
// lattice shells assembling ring by ring, spokes, node beads, and radiating
// spines. Mineral geometry with a hand-drawn tremor.

import { makeRng } from '../../core/prng'
import { finish, hairline, ringPts, softDisc, TAU, type Pt } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const HUES: ReadonlyArray<{ ink: string; wash: string }> = [
  { ink: 'cyan-700', wash: 'cyan-200' },
  { ink: 'base-700', wash: 'base-300' },
  { ink: 'blue-700', wash: 'blue-200' },
  { ink: 'orange-800', wash: 'orange-200' },
]

export const radiolaria: Scene = {
  id: 'radiolaria',
  label: 'radiolaria',
  blurb: 'Glass skeletons of the open sea, after Haeckel — symmetric shells built ring by ring.',
  params: [
    { key: 'symmetry', label: 'Symmetry', min: 5, max: 9, step: 1, default: 6 },
    { key: 'rings', label: 'Shell rings', min: 2, max: 5, step: 1, default: 3 },
    { key: 'spines', label: 'Spines', min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: 'size', label: 'Size', min: 0.6, max: 1.5, step: 0.01, default: 1 },
  ],
  life: { rate: 3.5, maxConcurrent: 5, grow: 9, hold: 18, fade: 8 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|radio|${index}`)
    const sym = rng.chance(0.3) ? rng.int(5, Math.round(k.symmetry)) : Math.round(k.symmetry)
    const nRings = Math.round(k.rings)
    const R = Math.min(w, h) * rng.range(0.09, 0.15) * k.size
    const spineLen = R * rng.range(0.35, 0.65)
    const pad = R + spineLen + 10
    const cx = rng.range(pad, w - pad)
    const cy = rng.range(pad, h - pad)
    const hue = HUES[rng.chance(0.6) ? 0 : rng.int(1, 3)]
    const proj = rng.range(0.88, 1)
    const rot = rng.range(0, TAU)

    const ops: AmbientOp[] = []
    // inner glow
    softDisc(ops, cx, cy, R * 0.5, hue.wash, 0.12, 0, rng.range(0, 60))

    // shell rings — alternating smooth rings and polygonal lattice rings
    const ringRs: number[] = []
    for (let i = 0; i < nRings; i++) ringRs.push(R * ((i + 1) / nRings) * rng.range(0.94, 1.06))
    ringRs.forEach((r, i) => {
      const t0 = 1 + i * 1.6
      if (i % 2 === 0) {
        const pts = ringPts(cx, cy, r, Math.max(30, Math.round(r * 1.2)), 0.7, rng.range(0, 90), proj)
        hairline(ops, pts, { tone: hue.ink, alpha: 0.3, w: i === nRings - 1 ? 0.7 : 0.5, t0, t1: t0 + 1.3 })
      } else {
        // polygon ring: vertices at symmetry points
        const pts: Pt[] = []
        for (let v = 0; v <= sym * 2; v++) {
          const a = rot + (v / (sym * 2)) * TAU
          const rr = r * (v % 2 === 0 ? 1 : 0.88)
          pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * proj })
        }
        hairline(ops, pts, { tone: hue.ink, alpha: 0.26, w: 0.45, t0, t1: t0 + 1.3 })
      }
    })

    // radial spokes + node beads
    const spokeT = 1 + nRings * 1.6
    const beadC = fxa(hue.ink, 0.4)
    for (let s = 0; s < sym; s++) {
      const a = rot + (s / sym) * TAU
      const pts: Pt[] = []
      for (let i = 0; i <= 6; i++) {
        const r = R * 0.18 + (R * 0.82 * i) / 6
        pts.push({
          x: cx + Math.cos(a) * r + (i > 0 ? rng.range(-0.6, 0.6) : 0),
          y: cy + Math.sin(a) * r * proj,
        })
      }
      hairline(ops, pts, { tone: hue.ink, alpha: 0.26, w: 0.45, t0: spokeT + s * 0.4, t1: spokeT + s * 0.4 + 0.8 })
      // beads where spokes cross rings
      ringRs.forEach((r, i) => {
        const bx = cx + Math.cos(a) * r
        const by = cy + Math.sin(a) * r * proj
        ops.push({
          t: spokeT + s * 0.4 + 1 + i * 0.15,
          draw(ctx) {
            ctx.beginPath()
            ctx.arc(bx, by, 0.9, 0, TAU)
            ctx.fillStyle = beadC
            ctx.fill()
          },
        })
      })
    }

    // spines radiating from the outer shell
    if (k.spines > 0.05) {
      const spineT = spokeT + sym * 0.4 + 1.5
      const nSpines = rng.chance(0.5) ? sym : sym * 2
      for (let s = 0; s < nSpines; s++) {
        if (!rng.chance(k.spines)) continue
        const a = rot + (s / nSpines) * TAU + (nSpines === sym ? 0 : TAU / (sym * 4))
        const len = spineLen * rng.range(0.7, 1.25)
        const base = { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * proj }
        const tip = { x: cx + Math.cos(a) * (R + len), y: cy + Math.sin(a) * (R + len) * proj }
        const mid = {
          x: (base.x + tip.x) / 2 + rng.range(-1.5, 1.5),
          y: (base.y + tip.y) / 2 + rng.range(-1.5, 1.5),
        }
        hairline(ops, [base, mid, tip], {
          tone: hue.ink,
          alpha: 0.32,
          w: 0.8,
          taperTo: 0.25,
          t0: spineT + s * 0.3,
          t1: spineT + s * 0.3 + 0.7,
        })
      }
    }

    return {
      ops,
      duration: finish(ops),
      bounds: { x: cx - pad, y: cy - pad, w: pad * 2, h: pad * 2 },
    }
  },
}
