// Contour survey — isolines of a hidden landscape, drawn like an old survey
// map: hairline contours, one heavier index line with tick marks, tiny
// spot-height crosses at the summits. The landscape drifts a little between
// sprites, so the map keeps being resurveyed.

import { makeRng } from '../../core/prng'
import { makeNoise2D } from '../noise2'
import { finish, hairline, TAU, type Pt } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

/** Marching squares for one level; returns raw segments. */
function marchingSquares(
  f: Float32Array,
  cols: number,
  rows: number,
  cell: number,
  lv: number
): Array<[Pt, Pt]> {
  const segs: Array<[Pt, Pt]> = []
  const at = (i: number, j: number) => f[j * cols + i]
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const v00 = at(i, j)
      const v10 = at(i + 1, j)
      const v01 = at(i, j + 1)
      const v11 = at(i + 1, j + 1)
      const c =
        (v00 > lv ? 1 : 0) | (v10 > lv ? 2 : 0) | (v11 > lv ? 4 : 0) | (v01 > lv ? 8 : 0)
      if (c === 0 || c === 15) continue
      const x = i * cell
      const y = j * cell
      const lerp = (va: number, vb: number) => (lv - va) / (vb - va || 1e-9)
      const eTop = (): Pt => ({ x: x + lerp(v00, v10) * cell, y })
      const eRight = (): Pt => ({ x: x + cell, y: y + lerp(v10, v11) * cell })
      const eBottom = (): Pt => ({ x: x + lerp(v01, v11) * cell, y: y + cell })
      const eLeft = (): Pt => ({ x, y: y + lerp(v00, v01) * cell })
      switch (c) {
        case 1:
        case 14:
          segs.push([eLeft(), eTop()])
          break
        case 2:
        case 13:
          segs.push([eTop(), eRight()])
          break
        case 3:
        case 12:
          segs.push([eLeft(), eRight()])
          break
        case 4:
        case 11:
          segs.push([eRight(), eBottom()])
          break
        case 6:
        case 9:
          segs.push([eTop(), eBottom()])
          break
        case 7:
        case 8:
          segs.push([eLeft(), eBottom()])
          break
        case 5:
          segs.push([eLeft(), eTop()])
          segs.push([eRight(), eBottom()])
          break
        case 10:
          segs.push([eTop(), eRight()])
          segs.push([eLeft(), eBottom()])
          break
      }
    }
  }
  return segs
}

/** Chain segments into polylines by matching endpoints. */
function chain(segs: Array<[Pt, Pt]>): Pt[][] {
  const key = (p: Pt) => `${Math.round(p.x * 4)},${Math.round(p.y * 4)}`
  const byEnd = new Map<string, number[]>()
  segs.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const kk = key(p)
      const list = byEnd.get(kk)
      if (list) list.push(i)
      else byEnd.set(kk, [i])
    }
  })
  const used = new Array(segs.length).fill(false)
  const lines: Pt[][] = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const line: Pt[] = [segs[i][0], segs[i][1]]
    // extend forward then backward
    for (const dir of [1, -1]) {
      for (;;) {
        const end = dir === 1 ? line[line.length - 1] : line[0]
        const candidates = byEnd.get(key(end)) ?? []
        let found = -1
        for (const cI of candidates) if (!used[cI]) found = cI
        if (found < 0) break
        used[found] = true
        const [a, b] = segs[found]
        const next = key(a) === key(end) ? b : a
        if (dir === 1) line.push(next)
        else line.unshift(next)
      }
    }
    if (line.length > 3) lines.push(line)
  }
  return lines
}

export const contours: Scene = {
  id: 'contours',
  label: 'contour survey',
  blurb: 'Isolines of a hidden, slowly drifting landscape — a map forever being resurveyed.',
  params: [
    { key: 'levels', label: 'Contour levels', min: 3, max: 8, step: 1, default: 5 },
    { key: 'zoom', label: 'Terrain zoom', min: 0.6, max: 2.5, step: 0.01, default: 1.2 },
    { key: 'drift', label: 'Drift per survey', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'water', label: 'Lowland tint', min: 0, max: 1, step: 1, default: 1, options: ['off', 'on'] },
    { key: 'hues', label: 'Coloring', min: 0, max: 1, step: 1, default: 0, options: ['ink', 'hypsometric'] },
  ],
  life: { rate: 1.6, maxConcurrent: 2, grow: 14, hold: 20, fade: 12 },

  spawn(seed, index, w, h, k): SpriteSpec {
    // one fixed landscape per seed; each survey samples it slightly shifted
    const field = makeNoise2D(makeRng(`${seed}|contourfield`))
    const rng = makeRng(`${seed}|contours|${index}`)
    const cell = 8
    const cols = Math.ceil(w / cell) + 1
    const rows = Math.ceil(h / cell) + 1
    const s = (2.6 * k.zoom) / Math.min(w, h)
    const ox = index * k.drift * 1.7
    const oy = index * k.drift * 1.1
    const f = new Float32Array(cols * rows)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const x = i * cell
        const y = j * cell
        f[j * cols + i] =
          field(x * s + ox, y * s + oy) * 0.72 + field(x * s * 2.3 + ox + 31, y * s * 2.3 + oy + 47) * 0.28
      }

    const nL = Math.round(k.levels)
    const ops: AmbientOp[] = []
    const indexLevel = Math.floor(nL / 2)
    // hypsometric tints, sea to summit
    const HYPSO = ['blue-600', 'cyan-600', 'olive-600', 'orange-700', 'red-600']
    const hypso = Math.round(k.hues) === 1
    let tCursor = 0
    for (let L = 0; L < nL; L++) {
      const lv = -0.5 + (L / (nL - 1)) * 1.0 + rng.range(-0.02, 0.02)
      const lines = chain(marchingSquares(f, cols, rows, cell, lv))
      const isIndex = L === indexLevel
      const isWater = Math.round(k.water) === 1 && L === 0
      const tone = hypso
        ? HYPSO[Math.min(HYPSO.length - 1, Math.floor((L / Math.max(1, nL - 1)) * HYPSO.length))]
        : isWater
          ? 'blue-500'
          : 'base-500'
      for (const line of lines) {
        const t0 = tCursor + rng.range(0, 1.5)
        const t1 = t0 + Math.min(4, line.length * 0.03)
        hairline(ops, line, {
          tone,
          alpha: isIndex ? 0.3 : isWater ? 0.24 : 0.2,
          w: isIndex ? 0.75 : 0.45,
          t0,
          t1,
        })
        // tick marks riding the index contour
        if (isIndex && line.length > 20) {
          const tickC = fxa('base-500', 0.24)
          for (let i = 10; i < line.length - 2; i += 24) {
            const p = line[i]
            const q2 = line[i + 1]
            const dx = q2.x - p.x
            const dy = q2.y - p.y
            const dl = Math.hypot(dx, dy) || 1
            const px = p.x
            const py = p.y
            const nx = -dy / dl
            const ny = dx / dl
            ops.push({
              t: t1 + 0.3,
              draw(ctx) {
                ctx.beginPath()
                ctx.moveTo(px, py)
                ctx.lineTo(px + nx * 2.4, py + ny * 2.4)
                ctx.strokeStyle = tickC
                ctx.lineWidth = 0.5
                ctx.stroke()
              },
            })
          }
        }
      }
      tCursor += 2.2
    }

    // spot heights at a few summits
    const peaks: Array<[number, number, number]> = []
    for (let j = 2; j < rows - 2; j++)
      for (let i = 2; i < cols - 2; i++) {
        const v = f[j * cols + i]
        if (v < 0.45) continue
        let isMax = true
        for (let dj = -2; dj <= 2 && isMax; dj++)
          for (let di = -2; di <= 2; di++) {
            if (!di && !dj) continue
            if (f[(j + dj) * cols + (i + di)] > v) {
              isMax = false
              break
            }
          }
        if (isMax) peaks.push([i * cell, j * cell, v])
      }
    const crossC = fxa('base-600', 0.4)
    peaks.slice(0, 4).forEach(([px, py], i) => {
      ops.push({
        t: tCursor + 1 + i * 0.5,
        draw(ctx) {
          ctx.strokeStyle = crossC
          ctx.lineWidth = 0.6
          ctx.beginPath()
          ctx.moveTo(px - 2.2, py)
          ctx.lineTo(px + 2.2, py)
          ctx.moveTo(px, py - 2.2)
          ctx.lineTo(px, py + 2.2)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(px, py, 0.7, 0, TAU)
          ctx.fillStyle = crossC
          ctx.fill()
        },
      })
    })

    return { ops, duration: finish(ops) }
  },
}
