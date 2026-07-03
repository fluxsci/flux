// Loom automata — turmites (two-dimensional Turing machines) weaving over a
// coarse grid. Each visited cell gets a soft pixel wash that deepens with
// every revisit; the reveal order is the walk itself, so you watch the
// tapestry being woven by rules nobody chose.

import { makeRng } from '../../core/prng'
import { finish } from '../brush'
import { fxa } from '../../core/palette'
import type { AmbientOp, Scene, SpriteSpec } from '../types'

const FAMS = ['blue', 'purple', 'cyan', 'magenta', 'red', 'orange', 'olive']
const RAMP = ['100', '150', '200', '300', '400', '500']

export const loom: Scene = {
  id: 'loom',
  label: 'loom automata',
  blurb: 'Turmites with random rules weave a pixel tapestry — pigment deepens where they return.',
  params: [
    { key: 'pitch', label: 'Cell size', min: 5, max: 11, step: 0.5, default: 7 },
    { key: 'steps', label: 'Steps', min: 300, max: 4000, step: 50, default: 1600 },
    { key: 'walkers', label: 'Weavers', min: 1, max: 6, step: 1, default: 2 },
    { key: 'spread', label: 'Weaver spread', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'hues', label: 'Distinct hues', min: 0, max: 4, step: 1, default: 0, options: ['auto', '1', '2', '3', '4'] },
    { key: 'states', label: 'Rule states', min: 2, max: 4, step: 1, default: 3 },
  ],
  life: { rate: 1.8, maxConcurrent: 2, grow: 16, hold: 22, fade: 11 },

  spawn(seed, index, w, h, k): SpriteSpec {
    const rng = makeRng(`${seed}|loom|${index}`)
    const pitch = k.pitch
    // the whole pane is the loom — weavers roam freely, wrapping at the edges
    const cols = Math.max(8, Math.floor(w / pitch))
    const rows = Math.max(8, Math.floor(h / pitch))
    const px = (w - cols * pitch) / 2
    const py = (h - rows * pitch) / 2

    const nStates = Math.round(k.states)
    // random turmite rule: per cell state -> turn direction (L/R/U/N).
    // resample until it contains both a left and a right turn — one-sided
    // rules degenerate into straight "highways" instead of weaving
    let turns: number[] = []
    for (let tries = 0; tries < 20; tries++) {
      turns = Array.from({ length: nStates }, () => rng.pick([-1, 1, 1, -1, 2, 0]))
      if (turns.includes(-1) && turns.includes(1)) break
    }

    // weaver hues: 'auto' = one shared family with occasional strays;
    // otherwise guarantee at least N distinct families across the weavers
    const nW = Math.round(k.walkers)
    const nHues = Math.round(k.hues)
    const deck = [...FAMS]
    const drawFam = () => deck.splice(rng.int(0, deck.length - 1), 1)[0]
    let weaverFams: string[]
    if (nHues > 0) {
      const chosen = Array.from({ length: Math.min(nHues, deck.length) }, drawFam)
      weaverFams = Array.from({ length: nW }, (_, i) => chosen[i % chosen.length])
    } else {
      const famA = rng.pick(FAMS)
      const famB = rng.chance(0.4) ? rng.pick(FAMS) : famA
      weaverFams = Array.from({ length: nW }, (_, i) => (i === 0 ? famA : famB))
    }

    const grid = new Uint8Array(cols * rows)
    // scatter a little pre-existing "thread" so the rule has texture to react to
    for (let i = 0; i < cols * rows * 0.05; i++) {
      grid[rng.int(0, cols * rows - 1)] = rng.int(1, nStates - 1)
    }

    interface Mite {
      x: number
      y: number
      dir: number // 0 E, 1 S, 2 W, 3 N
      fam: string
    }
    // spawn positions: the spread knob sets how far apart weavers begin
    const sep = k.spread * Math.min(cols, rows) * 0.7
    const placed: Array<[number, number]> = []
    for (let i = 0; i < nW; i++) {
      let bx = rng.int(2, cols - 3)
      let by = rng.int(2, rows - 3)
      let bestD = -1
      for (let tries = 0; tries < 30; tries++) {
        const cxc = rng.int(2, cols - 3)
        const cyc = rng.int(2, rows - 3)
        const dMin = placed.length
          ? Math.min(...placed.map(([qx, qy]) => Math.hypot(qx - cxc, qy - cyc)))
          : Infinity
        if (dMin >= sep) {
          bx = cxc
          by = cyc
          bestD = Infinity
          break
        }
        if (dMin > bestD) {
          bestD = dMin
          bx = cxc
          by = cyc
        }
      }
      placed.push([bx, by])
    }
    const mites: Mite[] = placed.map(([mx, my], i) => ({
      x: mx,
      y: my,
      dir: rng.int(0, 3),
      fam: weaverFams[i],
    }))

    const ops: AmbientOp[] = []
    const steps = Math.round(k.steps)
    const DX = [1, 0, -1, 0]
    const DY = [0, 1, 0, -1]
    let t = 0
    for (let s = 0; s < steps; s++) {
      for (const m of mites) {
        const cell = m.y * cols + m.x
        const state = grid[cell]
        // paint: deepen with visit count
        const shade = RAMP[Math.min(RAMP.length - 1, state + 1)]
        const color = fxa(`${m.fam}-${shade}`, 0.16)
        const cx2 = px + m.x * pitch
        const cy2 = py + m.y * pitch
        ops.push({
          t,
          draw(ctx) {
            ctx.beginPath()
            ctx.roundRect(cx2 + 0.8, cy2 + 0.8, pitch - 1.6, pitch - 1.6, pitch * 0.28)
            ctx.fillStyle = color
            ctx.fill()
          },
        })
        // turn, write, move — with the rare stray thread pulling it off course
        m.dir = rng.chance(0.008) ? rng.int(0, 3) : (m.dir + turns[state] + 4) % 4
        grid[cell] = (state + 1) % nStates
        m.x = (m.x + DX[m.dir] + cols) % cols
        m.y = (m.y + DY[m.dir] + rows) % rows
      }
      t += 0.05
    }

    return { ops, duration: finish(ops) }
  },
}
