// Harmonograph — a damped double pendulum guiding a pen. Random integer
// frequency ratios with a whisper of detune, random phases and decay, traced
// slowly tip-first like the Victorian parlor instrument. The figure shrinks
// inward as the pendulums die.

import { makeRng } from '../../core/prng'
import { finish, hairline, TAU, type Pt } from '../brush'
import type { Scene, SpriteSpec } from '../types'

const ACCENTS = ['blue', 'purple', 'magenta', 'cyan', 'red', 'orange']

export const harmonograph: Scene = {
  id: 'harmonograph',
  label: 'harmonograph',
  blurb: 'A damped pendulum pen tracing Lissajous figures — never the same curve twice.',
  params: [
    { key: 'complexity', label: 'Complexity', min: 1, max: 4, step: 1, default: 2 },
    { key: 'damping', label: 'Damping', min: 0.3, max: 1.6, step: 0.01, default: 0.8 },
    { key: 'ink', label: 'Ink', min: 0, max: 2, step: 1, default: 2, options: ['graphite', 'color', 'two-tone'] },
    { key: 'scale', label: 'Scale', min: 0.5, max: 1.4, step: 0.01, default: 1 },
    { key: 'overlap', label: 'Placement', min: 0, max: 1, step: 1, default: 0, options: ['avoid others', 'free'] },
  ],
  life: { rate: 2.2, maxConcurrent: 3, grow: 20, hold: 26, fade: 10 },

  spawn(seed, index, w, h, k, occupied = []): SpriteSpec | null {
    const rng = makeRng(`${seed}|harmo|${index}`)
    const maxF = 1 + Math.round(k.complexity)
    const f = [rng.int(1, maxF), rng.int(1, maxF), rng.int(1, maxF), rng.int(1, maxF)].map(
      (v) => v + rng.range(-0.015, 0.015)
    )
    const ph = [rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU)]
    const dmp = [0, 1, 2, 3].map(() => (0.0022 + rng.next() * 0.0018) * k.damping)

    const R = Math.min(w, h) * 0.36 * k.scale * rng.range(0.8, 1.1)
    const mixX = rng.range(0.35, 0.65)
    const mixY = rng.range(0.35, 0.65)

    // place anywhere the figure fits; optionally reject spots that overlap
    // figures already on the pane (a crossed harmonograph is a ruined one)
    const pad = R + 14
    const loX = Math.min(pad, w / 2)
    const hiX = Math.max(w - pad, w / 2)
    const loY = Math.min(pad, h / 2)
    const hiY = Math.max(h - pad, h / 2)
    let cx = w / 2
    let cy = h / 2
    let placed = false
    for (let tries = 0; tries < 16; tries++) {
      cx = rng.range(loX, hiX)
      cy = rng.range(loY, hiY)
      if (Math.round(k.overlap) === 1) {
        placed = true
        break
      }
      const bx = cx - pad
      const by = cy - pad
      const bs = pad * 2
      placed = occupied.every(
        (o) => bx + bs < o.x || o.x + o.w < bx || by + bs < o.y || o.y + o.h < by
      )
      if (placed) break
    }
    if (!placed) return null // wait for room — the compositor will retry

    const dMin = Math.min(...dmp)
    const tEnd = Math.min(1.3 / Math.max(1e-4, dMin), 360)
    const trace = (shift: number): Pt[] => {
      const pts: Pt[] = []
      for (let t = 0; t < tEnd; t += 0.09) {
        const x =
          R * mixX * Math.sin(f[0] * t + ph[0] + shift) * Math.exp(-dmp[0] * t) +
          R * (1 - mixX) * Math.sin(f[1] * t + ph[1]) * Math.exp(-dmp[1] * t)
        const y =
          R * mixY * Math.sin(f[2] * t + ph[2] + shift * 0.6) * Math.exp(-dmp[2] * t) +
          R * (1 - mixY) * Math.sin(f[3] * t + ph[3]) * Math.exp(-dmp[3] * t)
        pts.push({ x: cx + x, y: cy + y })
      }
      return pts
    }

    const inkMode = Math.round(k.ink)
    const fam = rng.pick(ACCENTS)
    const mainTone = inkMode === 1 ? `${fam}-600` : 'base-700'
    const ops: SpriteSpec['ops'] = []
    hairline(ops, trace(0), { tone: mainTone, alpha: 0.13, w: 0.45, t0: 0, t1: 100 })
    if (inkMode === 2) {
      hairline(ops, trace(0.13), { tone: `${fam}-600`, alpha: 0.07, w: 0.45, t0: 1.5, t1: 101.5 })
    }
    // the pen's resting point
    ops.push({
      t: 102,
      draw(ctx) {
        ctx.beginPath()
        ctx.arc(cx, cy, 0.9, 0, TAU)
        ctx.fillStyle = 'rgba(16,15,15,0.25)'
        ctx.fill()
      },
    })

    return {
      ops,
      duration: finish(ops),
      bounds: { x: cx - pad, y: cy - pad, w: pad * 2, h: pad * 2 },
    }
  },
}
