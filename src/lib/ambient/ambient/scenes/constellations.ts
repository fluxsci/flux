// Constellations — star patches twinkle in one glint at a time, then thin
// dashed asterism lines join them into a figure nobody has named yet.
// Occasionally just a sprinkle of lone background stars.

import { makeRng, type Rng } from '../../core/prng'
import { dashedLine, finish, hairline, ringPts, TAU } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const STAR_TONES = ['yellow-500', 'blue-400', 'red-400', 'purple-400', 'cyan-500']

function drawStar(
  ops: AmbientOp[],
  x: number,
  y: number,
  s: number,
  tone: string,
  t: number,
  rng: Rng,
  glow: number
): void {
  const halo1 = fxa(tone, 0.07 + glow * 0.07)
  const halo2 = fxa(tone, 0.09 + glow * 0.09)
  const dot = fxa(tone, 0.7)
  const rayC = fxa(tone, 0.4)
  const rot = rng.range(-0.15, 0.15)
  const rayLen = s * rng.range(1.9, 2.7) * (0.8 + glow * 0.4)
  const haloR = s * (1.8 + glow * 2.4)
  const diag = rng.chance(0.4)
  // luminous halo first — two soft pools of light
  ops.push({
    t,
    draw(ctx) {
      ctx.beginPath()
      ctx.arc(x, y, haloR, 0, TAU)
      ctx.fillStyle = halo1
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x, y, haloR * 0.55, 0, TAU)
      ctx.fillStyle = halo2
      ctx.fill()
    },
  })
  // core + short tapered glints (slivers, not crosshairs)
  ops.push({
    t: t + 0.4,
    draw(ctx) {
      ctx.beginPath()
      ctx.arc(x, y, s * 0.6, 0, TAU)
      ctx.fillStyle = dot
      ctx.fill()
      ctx.fillStyle = rayC
      const spike = (a: number, len: number) => {
        const bx = x + Math.cos(a) * s * 0.45
        const by = y + Math.sin(a) * s * 0.45
        const tx = x + Math.cos(a) * len
        const ty = y + Math.sin(a) * len
        const nx = -Math.sin(a) * 0.55
        const ny = Math.cos(a) * 0.55
        ctx.beginPath()
        ctx.moveTo(bx + nx, by + ny)
        ctx.lineTo(tx, ty)
        ctx.lineTo(bx - nx, by - ny)
        ctx.closePath()
        ctx.fill()
      }
      for (let k = 0; k < 4; k++) spike(rot + (k * TAU) / 4, rayLen)
      if (diag) for (let k = 0; k < 4; k++) spike(rot + TAU / 8 + (k * TAU) / 4, rayLen * 0.45)
    },
  })
}

export const constellations: Scene = {
  id: 'constellations',
  label: 'constellations',
  blurb: 'Unnamed asterisms twinkle in star by star, get their dashed lines, and set again.',
  params: [
    { key: 'patch', label: 'Patch size', min: 0.5, max: 1.5, step: 0.01, default: 1 },
    { key: 'stars', label: 'Stars', min: 3, max: 10, step: 1, default: 6 },
    { key: 'link', label: 'Lines', min: 0, max: 2, step: 1, default: 0, options: ['dashed', 'solid', 'none'] },
    { key: 'hueMix', label: 'Star hues', min: 0, max: 1, step: 0.01, default: 0.55 },
    { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
  life: { rate: 6, maxConcurrent: 8, grow: 6, hold: 18, fade: 8 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|stars|${index}`)
    const ops: AmbientOp[] = []
    const pickTone = () => (rng.next() < k.hueMix ? rng.pick(STAR_TONES) : 'base-600')

    // a third of spawns are just background sprinkle
    if (rng.chance(0.3)) {
      const n = rng.int(4, 8)
      for (let i = 0; i < n; i++) {
        drawStar(
          ops,
          rng.range(w * 0.05, w * 0.95),
          rng.range(h * 0.05, h * 0.95),
          rng.range(0.9, 1.5),
          pickTone(),
          i * 1.1,
          rng,
          k.glow
        )
      }
      return { ops, duration: finish(ops) }
    }

    const R = Math.min(w, h) * rng.range(0.16, 0.26) * k.patch
    const cx = rng.range(R + 8, w - R - 8)
    const cy = rng.range(R + 8, h - R - 8)
    const n = Math.round(k.stars)
    const pts: Array<{ x: number; y: number; s: number }> = []
    let guard = 0
    while (pts.length < n && guard++ < 200) {
      const a = rng.range(0, TAU)
      const r = R * Math.sqrt(rng.next())
      const x = cx + Math.cos(a) * r
      const y = cy + Math.sin(a) * r
      if (pts.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 > (R * 0.38) ** 2)) {
        pts.push({ x, y, s: rng.range(1.1, 2.1) })
      }
    }
    pts.forEach((p, i) => drawStar(ops, p.x, p.y, p.s, pickTone(), i * 1.2, rng, k.glow))

    // asterism lines: greedy minimum spanning tree
    const linkMode = Math.round(k.link)
    if (linkMode !== 2 && pts.length > 2) {
      const inTree = [0]
      const edges: Array<[number, number]> = []
      while (inTree.length < pts.length) {
        let best: [number, number] = [-1, -1]
        let bestD = Infinity
        for (const a of inTree)
          for (let b = 0; b < pts.length; b++) {
            if (inTree.includes(b)) continue
            const d = (pts[a].x - pts[b].x) ** 2 + (pts[a].y - pts[b].y) ** 2
            if (d < bestD) {
              bestD = d
              best = [a, b]
            }
          }
        edges.push(best)
        inTree.push(best[1])
      }
      edges.forEach(([a, b], e) => {
        const A = pts[a]
        const B = pts[b]
        // stop short of the glints
        const d = Math.hypot(B.x - A.x, B.y - A.y) || 1
        const inset = Math.min(6, d * 0.2)
        const ax = A.x + ((B.x - A.x) / d) * inset
        const ay = A.y + ((B.y - A.y) / d) * inset
        const bx = B.x - ((B.x - A.x) / d) * inset
        const by = B.y - ((B.y - A.y) / d) * inset
        const t0 = n * 1.2 + 1 + e * 1.4
        const line = [
          { x: ax, y: ay },
          { x: bx, y: by },
        ]
        if (linkMode === 0)
          dashedLine(ops, line, { tone: 'base-500', alpha: 0.4, w: 0.5, dash: 2.6, gap: 3.2, t0, t1: t0 + 1.1 })
        else hairline(ops, line, { tone: 'base-500', alpha: 0.26, w: 0.5, t0, t1: t0 + 1.1 })
      })
    }

    // sometimes one star is ringed, like a note in the margin of a sky atlas
    if (rng.chance(0.28) && pts.length) {
      const p = rng.pick(pts)
      const ring = ringPts(p.x, p.y, p.s * 4.5, 26, 0.5, rng.range(0, 60))
      hairline(ops, ring, { tone: 'base-500', alpha: 0.16, w: 0.4, t0: n * 1.2 + 6, t1: n * 1.2 + 7.2 })
    }

    const pad = R + 22
    return {
      ops,
      duration: finish(ops),
      bounds: { x: cx - pad, y: cy - pad, w: pad * 2, h: pad * 2 },
    }
  },
}
