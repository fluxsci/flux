// Hitomezashi — sashiko stitching. Random binary sequences seed the rows and
// columns; where they interlock, the classic offset stitch patterns emerge,
// sewn one stitch at a time in muted thread.

import { makeRng } from '../../core/prng'
import { finish, wob, TAU } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const THREADS = ['blue', 'red', 'olive', 'purple', 'cyan', 'magenta']

export const hitomezashi: Scene = {
  id: 'hitomezashi',
  label: 'hitomezashi',
  blurb: 'Sashiko stitch patterns grown from random row and column seeds, sewn stitch by stitch.',
  params: [
    { key: 'pitch', label: 'Stitch pitch', min: 6, max: 14, step: 0.5, default: 9 },
    { key: 'patch', label: 'Patch size', min: 0.5, max: 1.5, step: 0.01, default: 1 },
    { key: 'thread', label: 'Thread', min: 0, max: 2, step: 1, default: 1, options: ['indigo', 'accent rows', 'ink'] },
    { key: 'weave', label: 'Cross stitches', min: 0, max: 1, step: 0.01, default: 1 },
    { key: 'area', label: 'Cloth', min: 0, max: 1, step: 1, default: 0, options: ['patch', 'full pane'] },
  ],
  life: { rate: 2.4, maxConcurrent: 3, grow: 13, hold: 22, fade: 10 },

  spawn(seed, index, w, h, k, occupied = []): SpriteSpec | null {
    const fullPane = Math.round(k.area) === 1
    if (fullPane && occupied.length) return null // one cloth at a time

    const rng = makeRng(`${seed}|stitch|${index}`)
    const pitch = k.pitch
    const cols = fullPane
      ? Math.floor((w - 16) / pitch)
      : Math.round((rng.range(0.32, 0.55) * w * k.patch) / pitch)
    const rows = fullPane
      ? Math.floor((h - 16) / pitch)
      : Math.round((rng.range(0.2, 0.42) * h * k.patch) / pitch)
    if (cols < 4 || rows < 4) return { ops: [], duration: 1 }
    const pw = cols * pitch
    const ph = rows * pitch
    const px = fullPane ? (w - pw) / 2 : rng.range(8, Math.max(9, w - pw - 8))
    const py = fullPane ? (h - ph) / 2 : rng.range(8, Math.max(9, h - ph - 8))

    const a: number[] = Array.from({ length: rows + 1 }, () => (rng.chance(0.5) ? 1 : 0))
    const b: number[] = Array.from({ length: cols + 1 }, () => (rng.chance(0.5) ? 1 : 0))

    const threadMode = Math.round(k.thread)
    const baseFam = threadMode === 2 ? 'base' : 'blue'
    const accentFam = rng.pick(THREADS)
    const rowFams: string[] = Array.from({ length: rows + 1 }, () =>
      threadMode === 1 && rng.chance(0.18) ? accentFam : baseFam
    )

    const ops: AmbientOp[] = []
    let stitchN = 0
    const stitch = (x0: number, y0: number, x1: number, y1: number, fam: string, t: number) => {
      const color = fxa(`${fam}-600`, 0.4)
      const mx = (x0 + x1) / 2 + wob(stitchN, index * 7) * 0.5
      const my = (y0 + y1) / 2 + wob(stitchN, index * 7 + 30) * 0.5
      stitchN++
      ops.push({
        t,
        draw(ctx) {
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.quadraticCurveTo(mx, my, x1, y1)
          ctx.strokeStyle = color
          ctx.lineWidth = 0.9
          ctx.lineCap = 'round'
          ctx.stroke()
        },
      })
    }

    // horizontal stitches, row by row (boustrophedon needle rhythm)
    let t = 0
    const inset = pitch * 0.14
    for (let j = 0; j <= rows; j++) {
      const y = py + j * pitch
      for (let i = 0; i < cols; i++) {
        const ii = j % 2 === 0 ? i : cols - 1 - i
        if ((a[j] + ii) % 2 === 0) {
          stitch(px + ii * pitch + inset, y, px + (ii + 1) * pitch - inset, y, rowFams[j], t)
          t += 0.09
        }
      }
      t += 0.25
    }
    // vertical stitches, column by column; the weave knob thins them out
    t += 1
    for (let i = 0; i <= cols; i++) {
      if (rng.next() > k.weave) continue
      const x = px + i * pitch
      for (let j = 0; j < rows; j++) {
        if ((b[i] + j) % 2 === 0) {
          stitch(x, py + j * pitch + inset, x, py + (j + 1) * pitch - inset, baseFam, t)
          t += 0.09
        }
      }
      t += 0.2
    }

    return {
      ops,
      duration: finish(ops),
      bounds: { x: px - 4, y: py - 4, w: pw + 8, h: ph + 8 },
    }
  },
}
