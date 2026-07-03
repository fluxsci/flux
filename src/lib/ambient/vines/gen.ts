// Living-vines generator. Each call grows one vine that starts at a random
// point on the pane's inner perimeter and either dives across the pane
// (steered by a hidden target on the far side) or clings to the edges,
// following the walls around corners — the `cling` knob blends between the
// two habits. Output is a PlantModel for the shared watercolor painter, with
// the texture knob adding bark fibers, thorns, node ticks, and leaf veinlets,
// and with per-flower style variation: petal count/shape/rings/centers, buds
// on the young growth near the tips, and the occasional berry cluster.

import { makeRng, type Rng } from '../core/prng'
import { makeNoise1D } from '../core/noise'
import type { PlantModel, Primitive, StemNode } from '../core/model'

export interface VineKnobs {
  cling: number // 0 = cross the pane, 1 = hug the edges
  wander: number
  length: number // reach relative to the pane
  branchiness: number
  leafDensity: number
  texture: number // 0..1 bark fibers, thorns, node ticks, leaf veinlets
  flowerRate: number
  berryRate: number
  flowerSize: number
  palette: number // 0 = one family for the whole pane, 1 = random per flower
}

export const VINE_FAMILIES = ['red', 'orange', 'yellow', 'magenta', 'purple', 'blue', 'cyan']
const PETAL_SHADES = [200, 300, 400, 500]
const BERRY_FAMILIES = ['red', 'purple', 'magenta', 'orange']
const CENTER_STYLES = ['dot', 'disc', 'stamens'] as const

interface FlowerStyleCtx {
  rng: Rng
  palette: number
  homeFam: string
  flowerSize: number
}

function makeFlower(
  c: FlowerStyleCtx,
  x: number,
  y: number,
  t: number,
  open: number,
  sizeMul: number
): Primitive {
  const rng = c.rng
  const fam = c.palette > 0.5 ? rng.pick(VINE_FAMILIES) : c.homeFam
  const shade = rng.pick(PETAL_SHADES)
  return {
    kind: 'flower',
    x,
    y,
    size: rng.range(6.5, 11) * c.flowerSize * sizeMul,
    petals: rng.int(4, 7),
    angle: rng.range(0, Math.PI * 2),
    open,
    t,
    petal: `${fam}-${shade}`,
    edge: `${fam}-600`,
    center: fam === 'yellow' ? 'orange-600' : rng.chance(0.7) ? 'yellow-500' : 'yellow-600',
    petalE: rng.range(0.7, 1.45),
    petalHw: rng.range(0.32, 0.5),
    layers: rng.chance(0.22) ? 2 : 1,
    centerStyle: rng.pick(CENTER_STYLES),
  }
}

function makeBerry(c: FlowerStyleCtx, x: number, y: number, t: number): Primitive {
  const rng = c.rng
  const fam = c.palette > 0.5 ? rng.pick(BERRY_FAMILIES) : c.homeFam
  return {
    kind: 'berry',
    x,
    y,
    r: rng.range(1.8, 2.8) * c.flowerSize,
    n: rng.int(3, 7),
    tone: `${fam}-400`,
    deep: `${fam}-700`,
    t,
  }
}

interface Walker {
  x: number
  y: number
  heading: number
  width: number
  stepsLeft: number
  totalSteps: number
  t: number
  depth: number
  phase: number
  leafClock: number
  leafSide: number
  sinceBranch: number
  sinceThorn: number
  tx: number // hidden crossing target
  ty: number
}

export function generateVine(
  seed: string,
  index: number,
  w: number,
  h: number,
  k: VineKnobs,
  homeFam: string
): PlantModel {
  // a vine born pointing the wrong way can die against the wall within a few
  // steps — retry with a fresh substream rather than show a stillborn sprout
  let best: { model: PlantModel; frac: number } | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const grown = growVine(makeRng(`${seed}|vine|${index}|a${attempt}`), w, h, k, homeFam)
    if (!best || grown.frac > best.frac) best = grown
    if (grown.frac > 0.5) break
  }
  return best!.model
}

function growVine(
  rng: Rng,
  w: number,
  h: number,
  k: VineKnobs,
  homeFam: string
): { model: PlantModel; frac: number } {
  const noise = makeNoise1D(rng)
  const prims: Primitive[] = []
  const fc: FlowerStyleCtx = { rng, palette: k.palette, homeFam, flowerSize: k.flowerSize }

  const m = Math.max(12, Math.min(w, h) * 0.04)
  const band = m * 1.9 // preferred distance from the wall when clinging
  const step = Math.min(7, Math.max(3.5, Math.max(w, h) / 150))
  let maxT = 0

  // start point on the inner perimeter + inward normal
  const perim = 2 * (w + h)
  let s = rng.range(0, perim)
  let sx: number, sy: number, inAng: number
  if (s < w) {
    sx = s
    sy = m * 1.4
    inAng = Math.PI / 2
  } else if ((s -= w) < h) {
    sx = w - m * 1.4
    sy = s
    inAng = Math.PI
  } else if ((s -= h) < w) {
    sx = w - s
    sy = h - m * 1.4
    inAng = -Math.PI / 2
  } else {
    s -= w
    sx = m * 1.4
    sy = h - s
    inAng = 0
  }
  // heading: inward when crossing, along the wall when clinging
  const tangent = inAng + (rng.chance(0.5) ? 1 : -1) * (Math.PI / 2)
  const heading0 =
    k.cling > 0.5 ? tangent + rng.range(-0.3, 0.3) : inAng + rng.range(-0.6, 0.6)

  const pickTarget = (): [number, number] => [
    Math.min(w - m, Math.max(m, w - sx + rng.range(-w * 0.25, w * 0.25))),
    Math.min(h - m, Math.max(m, h - sy + rng.range(-h * 0.25, h * 0.25))),
  ]
  const [tx0, ty0] = pickTarget()

  const total = Math.round(
    Math.min(700, Math.max(40, ((Math.max(w, h) * 1.25 * k.length) / step) * rng.range(0.8, 1.2)))
  )

  const shade = rng.chance(0.85) ? (['olive-600', 'olive-300'] as const) : (['base-600', 'base-300'] as const)
  const queue: Walker[] = [
    {
      x: sx,
      y: sy,
      heading: heading0,
      width: rng.range(1.9, 2.5),
      stepsLeft: total,
      totalSteps: total,
      t: 0,
      depth: 0,
      phase: rng.range(0, 200),
      leafClock: rng.int(3, 8),
      leafSide: rng.chance(0.5) ? 1 : -1,
      sinceBranch: 0,
      sinceThorn: 0,
      tx: tx0,
      ty: ty0,
    },
  ]
  const leafEvery = k.leafDensity < 0.05 ? Infinity : Math.round(18 - 11 * k.leafDensity)
  // per-vine leaf character
  const leafNarrow = rng.range(0.65, 1.3)
  const leafSizeMul = rng.range(0.85, 1.2)
  let rootFrac = 0

  while (queue.length) {
    const wk = queue.shift()!
    const nodes: StemNode[] = [{ x: wk.x, y: wk.y, w: wk.width, t: wk.t }]
    let sN = 0
    let alive = true
    let tendril = 0
    let tendrilDir = 1
    let curStep = step

    while (alive && (wk.stepsLeft > 0 || tendril > 0)) {
      const frac = 1 - wk.stepsLeft / wk.totalSteps
      if (tendril > 0) {
        wk.heading += tendrilDir * (0.3 + (1 - tendril / 20) * 0.25)
        curStep *= 0.94
        tendril--
        if (tendril === 0) alive = false
      } else {
        wk.heading += noise(sN * 0.055 + wk.phase) * 0.42 * k.wander
        let vx = Math.cos(wk.heading)
        let vy = Math.sin(wk.heading)
        // emerging: for the first steps the root vine is pushed firmly off
        // its birth wall so it can't stall against it
        if (wk.depth === 0 && sN < 14) {
          const boost = ((14 - sN) / 14) * 0.8
          vx += Math.cos(inAng) * boost
          vy += Math.sin(inAng) * boost
        }
        // crossing pull toward the hidden far-side target
        if (k.cling < 0.98) {
          let dx = wk.tx - wk.x
          let dy = wk.ty - wk.y
          let d = Math.hypot(dx, dy) || 1
          if (d < 70) {
            // arrived — pick somewhere new and far, or the vine would orbit
            // its target in tell-tale circles
            let bx = wk.tx
            let by = wk.ty
            let bd = -1
            for (let c = 0; c < 3; c++) {
              const cx2 = rng.range(m, w - m)
              const cy2 = rng.range(m, h - m)
              const cd = (cx2 - wk.x) ** 2 + (cy2 - wk.y) ** 2
              if (cd > bd) {
                bd = cd
                bx = cx2
                by = cy2
              }
            }
            wk.tx = bx
            wk.ty = by
            dx = wk.tx - wk.x
            dy = wk.ty - wk.y
            d = Math.hypot(dx, dy) || 1
          }
          const pull = 0.09 * (1 - k.cling)
          vx += (dx / d) * pull
          vy += (dy / d) * pull
        }
        // edge cling: hold a comfortable distance from the nearest wall,
        // following it around corners
        if (k.cling > 0.02) {
          const dl = wk.x
          const dr = w - wk.x
          const dt2 = wk.y
          const db = h - wk.y
          const dmin = Math.min(dl, dr, dt2, db)
          let nx = 0
          let ny = 0
          if (dmin === dl) nx = 1
          else if (dmin === dr) nx = -1
          else if (dmin === dt2) ny = 1
          else ny = -1
          const err = Math.max(-1, Math.min(1, (dmin - band) / band))
          vx -= nx * err * 0.24 * k.cling
          vy -= ny * err * 0.24 * k.cling
        }
        // hard repulsion very close to the paper edge
        const closeBand = m * 0.9
        if (wk.x < closeBand) vx += ((closeBand - wk.x) / closeBand) * 0.5
        if (wk.x > w - closeBand) vx -= ((wk.x - (w - closeBand)) / closeBand) * 0.5
        if (wk.y < closeBand) vy += ((closeBand - wk.y) / closeBand) * 0.5
        if (wk.y > h - closeBand) vy -= ((wk.y - (h - closeBand)) / closeBand) * 0.5
        wk.heading = Math.atan2(vy, vx)
        // when crossing, keep loosely aimed at the target — sustained noise
        // would otherwise curl the vine into tell-tale circles; edge-huggers
        // keep full freedom so they can round corners
        if (k.cling < 0.6) {
          const ta = Math.atan2(wk.ty - wk.y, wk.tx - wk.x)
          let dev = wk.heading - ta
          while (dev > Math.PI) dev -= 2 * Math.PI
          while (dev < -Math.PI) dev += 2 * Math.PI
          const maxDev = Math.PI * (0.55 + 0.45 * (k.cling / 0.6))
          if (dev > maxDev) wk.heading = ta + maxDev
          else if (dev < -maxDev) wk.heading = ta - maxDev
        }
      }

      wk.x += Math.cos(wk.heading) * curStep
      wk.y += Math.sin(wk.heading) * curStep
      wk.t += 1
      wk.stepsLeft--
      wk.sinceBranch++
      wk.sinceThorn++
      sN++
      maxT = Math.max(maxT, wk.t)

      const width =
        tendril > 0
          ? Math.max(0.35, nodes[nodes.length - 1].w * 0.93)
          : Math.max(0.55, wk.width * (1 - 0.75 * Math.pow(frac, 0.85)))
      nodes.push({ x: wk.x, y: wk.y, w: width, t: wk.t })

      if (wk.x < 4 || wk.x > w - 4 || wk.y < 4 || wk.y > h - 4) {
        alive = false
        tendril = 0
      }
      if (tendril > 0) continue

      // thorns riding the stem
      if (k.texture > 0.05 && wk.sinceThorn > 6 && rng.chance(k.texture * 0.28)) {
        wk.sinceThorn = 0
        const side = rng.chance(0.5) ? 1 : -1
        prims.push({
          kind: 'tick',
          x: wk.x,
          y: wk.y,
          angle: wk.heading + side * rng.range(1.9, 2.5),
          len: rng.range(2.5, 4.5),
          w: 0.9,
          tone: 'olive-700',
          alpha: 0.35,
          t: wk.t + 0.8,
        })
      }

      // leaves, alternating sides
      if (--wk.leafClock <= 0 && leafEvery !== Infinity) {
        wk.leafClock = leafEvery + rng.int(-2, 2)
        wk.leafSide *= -1
        prims.push({
          kind: 'leaf',
          x: wk.x,
          y: wk.y,
          angle: wk.heading + wk.leafSide * rng.range(0.85, 1.3),
          size: Math.min(22, 9 + width * 6) * rng.range(0.85, 1.15) * leafSizeMul,
          curl: rng.range(-0.55, 0.55),
          t: wk.t + 0.6,
          fill: rng.chance(0.45) ? 'olive-300' : 'olive-400',
          vein: 'olive-700',
          narrow: leafNarrow,
          detail: k.texture,
        })
        // node tick where the leaf meets the stem
        if (k.texture > 0.3) {
          prims.push({
            kind: 'tick',
            x: wk.x,
            y: wk.y,
            angle: wk.heading + Math.PI / 2,
            len: width * 1.6,
            w: 0.6,
            tone: shade[0],
            alpha: 0.3,
            t: wk.t + 0.7,
          })
        }
        // axil decoration: bud/flower on old growth, or a berry cluster
        if (rng.chance(k.berryRate * 0.14)) {
          prims.push(makeBerry(fc, wk.x + rng.range(-3, 3), wk.y + rng.range(-3, 3), wk.t + 1.2))
        } else if (rng.chance(k.flowerRate * 0.16)) {
          const young = frac > 0.72
          prims.push(
            makeFlower(
              fc,
              wk.x - Math.cos(wk.heading) * 2,
              wk.y - Math.sin(wk.heading) * 2,
              wk.t + 1.2,
              young ? rng.range(0.28, 0.5) : rng.range(0.8, 1),
              young ? 0.7 : 1
            )
          )
        }
      }

      // branching
      if (
        wk.depth < 2 &&
        wk.stepsLeft > 20 &&
        wk.sinceBranch > 14 &&
        rng.chance(k.branchiness * 0.05)
      ) {
        wk.sinceBranch = 0
        const side = rng.chance(0.5) ? 1 : -1
        const childSteps = Math.round(wk.stepsLeft * rng.range(0.3, 0.55))
        const [ntx, nty] = pickTarget()
        queue.push({
          x: wk.x,
          y: wk.y,
          heading: wk.heading + side * rng.range(0.4, 0.95),
          width: width * 0.8,
          stepsLeft: childSteps,
          totalSteps: childSteps,
          t: wk.t,
          depth: wk.depth + 1,
          phase: rng.range(0, 200),
          leafClock: rng.int(4, 9),
          leafSide: side,
          sinceBranch: 0,
          sinceThorn: 0,
          tx: ntx,
          ty: nty,
        })
      }

      // tip: bloom, berries, or a curling tendril
      if (wk.stepsLeft === 0) {
        if (rng.chance(k.berryRate * 0.35)) {
          prims.push(makeBerry(fc, wk.x, wk.y, wk.t + 1))
        } else if (rng.chance(k.flowerRate * 0.85)) {
          const nFlowers = rng.chance(0.4) ? 2 : 1
          for (let q = 0; q < nFlowers; q++) {
            prims.push(
              makeFlower(
                fc,
                wk.x + rng.range(-5, 5) * q,
                wk.y + rng.range(-5, 5) * q,
                wk.t + 1 + q * 2,
                q ? rng.range(0.4, 0.7) : rng.range(0.85, 1),
                q ? 0.75 : 1.1
              )
            )
          }
        } else if (rng.chance(0.65)) {
          tendril = rng.int(12, 20)
          tendrilDir = rng.chance(0.5) ? 1 : -1
        }
      }
    }

    if (wk.depth === 0) rootFrac = Math.min(1, sN / wk.totalSteps)

    if (nodes.length > 2) {
      prims.push({
        kind: 'stem',
        nodes,
        shade: shade[0],
        wash: shade[1],
        texture: k.texture,
      })
    }
  }

  return { model: { prims, duration: Math.max(1, maxT) }, frac: rootFrac }
}
