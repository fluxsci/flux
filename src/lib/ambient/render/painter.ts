// The painter turns a PlantModel into a flat, time-sorted list of paint ops
// (individual brush strokes / washes). Rendering is accumulative: ops are
// drawn once, in order, onto un-cleared paper with multiply compositing, so
// overlapping pigment deepens like real watercolor. Because the op list is
// fixed at plan time, the finished image is deterministic regardless of
// frame rate or playback speed.

import { fx, fxa } from '../core/palette'
import { hash01 } from '../core/prng'
import type { PlantModel, Stem, Leaf, Flower, Tick, Berry } from '../core/model'

export interface PaintParams {
  opacity: number // global pigment multiplier
  jitter: number // stroke wobble in px
  wash: number // watercolor underlay width multiplier
}

export interface PaintOp {
  t: number
  draw(ctx: CanvasRenderingContext2D): void
}

export interface PaintPlan {
  ops: PaintOp[]
  duration: number
}

const TAU = Math.PI * 2
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// Deterministic smooth wobble along a path; phase separates passes/prims so
// the pencil passes don't sit exactly on top of each other.
function wob(i: number, phase: number): number {
  return (
    Math.sin(i * 0.31 + phase * 1.7) * 0.62 +
    Math.sin(i * 0.117 + phase * 3.9 + 1.3) * 0.38
  )
}

interface RPt {
  x: number
  y: number
  w: number
  t: number
  nx: number
  ny: number
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)
  )
}

/** Smooth + densify a stem polyline to ~`spacing` px point spacing, with normals. */
function resampleStem(stem: Stem, spacing: number): RPt[] {
  const n = stem.nodes
  if (n.length < 2) return []
  const pts: RPt[] = []
  for (let i = 0; i < n.length - 1; i++) {
    const p0 = n[Math.max(0, i - 1)]
    const p1 = n[i]
    const p2 = n[i + 1]
    const p3 = n[Math.min(n.length - 1, i + 2)]
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const steps = Math.max(1, Math.round(d / spacing))
    for (let s = 0; s < steps; s++) {
      const u = s / steps
      pts.push({
        x: catmull(p0.x, p1.x, p2.x, p3.x, u),
        y: catmull(p0.y, p1.y, p2.y, p3.y, u),
        w: p1.w + (p2.w - p1.w) * u,
        t: p1.t + (p2.t - p1.t) * u,
        nx: 0,
        ny: 0,
      })
    }
  }
  const last = n[n.length - 1]
  pts.push({ x: last.x, y: last.y, w: last.w, t: last.t, nx: 0, ny: 0 })
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    pts[i].nx = -dy / len
    pts[i].ny = dx / len
  }
  return pts
}

function planStem(stem: Stem, p: PaintParams, ops: PaintOp[], prim: number): void {
  const pts = resampleStem(stem, 2.6)
  if (pts.length < 2) return
  const CHUNK = 4
  const washTone = stem.wash ?? stem.shade
  const passes = [
    { wMul: 2.6 * p.wash, alpha: 0.05, tone: washTone, dt: 0, jMul: 0.5 },
    { wMul: 1.0, alpha: 0.2, tone: stem.shade, dt: 0.2, jMul: 1 },
    { wMul: 0.72, alpha: 0.15, tone: stem.shade, dt: 0.45, jMul: 1.15 },
  ]
  for (let pi = 0; pi < passes.length; pi++) {
    const pass = passes[pi]
    if (pass.wMul <= 0) continue
    const phase = prim * 2.39 + pi * 7.73
    const color = fxa(pass.tone, clamp01(pass.alpha * p.opacity))
    for (let a = 0; a < pts.length - 1; a += CHUNK) {
      const b = Math.min(pts.length - 1, a + CHUNK)
      const seg = pts.slice(a, b + 1)
      let wSum = 0
      for (const q of seg) wSum += q.w
      const width = Math.max(0.35, (wSum / seg.length) * pass.wMul)
      const jit = p.jitter * pass.jMul
      const t = seg[seg.length - 1].t + pass.dt
      // butt caps: adjacent chunks share an endpoint, and round caps would
      // double-paint a disc there — multiply turns that into a beaded stem
      ops.push({
        t,
        draw(ctx) {
          ctx.strokeStyle = color
          ctx.lineWidth = width
          ctx.lineCap = 'butt'
          ctx.lineJoin = 'round'
          ctx.beginPath()
          for (let k = 0; k < seg.length; k++) {
            const q = seg[k]
            const o = wob(a + k, phase) * jit
            const x = q.x + q.nx * o
            const y = q.y + q.ny * o
            if (k === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.stroke()
        },
      })
    }
  }

  // bark fibers: short broken strokes riding the stem, for woody texture
  const tex = stem.texture ?? 0
  if (tex > 0.05) {
    const fibC = fxa(stem.shade, clamp01(0.1 * tex * p.opacity))
    for (let i = 2; i < pts.length - 3; i += 3) {
      if (hash01(i, prim * 7 + 3) > 0.2 + 0.55 * tex) continue
      const q0 = pts[i]
      const q1 = pts[i + 2]
      const o = (hash01(i, prim + 11) - 0.5) * q0.w * 1.1
      ops.push({
        t: q1.t + 0.5,
        draw(ctx) {
          ctx.beginPath()
          ctx.moveTo(q0.x + q0.nx * o, q0.y + q0.ny * o)
          ctx.lineTo(q1.x + q1.nx * o, q1.y + q1.ny * o)
          ctx.strokeStyle = fibC
          ctx.lineWidth = Math.max(0.3, q0.w * 0.3)
          ctx.lineCap = 'round'
          ctx.stroke()
        },
      })
    }
  }
}

/** Leaf silhouette in local coords: base at origin, pointing +x. */
function leafPath(ctx: CanvasRenderingContext2D, size: number, curl: number, narrow = 1): void {
  const tipY = curl * size * 0.28
  const hw = size * 0.38 * narrow
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.quadraticCurveTo(size * 0.42, -hw + tipY * 0.4, size, tipY)
  ctx.quadraticCurveTo(size * 0.48, hw + tipY * 0.4, 0, 0)
}

function withXf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  scale: number,
  body: () => void
): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.scale(scale, scale)
  body()
  ctx.restore()
}

function planLeaf(leaf: Leaf, p: PaintParams, ops: PaintOp[], prim: number): void {
  const al = (a: number) => clamp01(a * p.opacity)
  const nar = leaf.narrow ?? 1
  const fill1 = fxa(leaf.fill, al(0.18))
  const fill2 = fxa(leaf.fill, al(0.15))
  const veinC = fxa(leaf.vein, al(0.26))
  // two wash layers (second slightly smaller -> pigment pools toward the base)
  ops.push({
    t: leaf.t,
    draw(ctx) {
      withXf(ctx, leaf.x, leaf.y, leaf.angle, 1, () => {
        leafPath(ctx, leaf.size, leaf.curl, nar)
        ctx.fillStyle = fill1
        ctx.fill()
      })
    },
  })
  ops.push({
    t: leaf.t + 1.2,
    draw(ctx) {
      withXf(ctx, leaf.x, leaf.y, leaf.angle, 0.8, () => {
        leafPath(ctx, leaf.size, leaf.curl * 1.15, nar)
        ctx.fillStyle = fill2
        ctx.fill()
      })
    },
  })
  // midrib
  const bend = leaf.curl * leaf.size
  ops.push({
    t: leaf.t + 2,
    draw(ctx) {
      withXf(ctx, leaf.x, leaf.y, leaf.angle, 1, () => {
        ctx.beginPath()
        ctx.moveTo(leaf.size * 0.05, 0)
        ctx.quadraticCurveTo(leaf.size * 0.5, bend * 0.14, leaf.size * 0.88, bend * 0.25)
        ctx.strokeStyle = veinC
        ctx.lineWidth = 0.7
        ctx.lineCap = 'round'
        ctx.stroke()
      })
    },
  })
  // partial outline on one side for a touch of pencil definition
  const side = hash01(prim, 3) < 0.5 ? 1 : -1
  ops.push({
    t: leaf.t + 2.4,
    draw(ctx) {
      withXf(ctx, leaf.x, leaf.y, leaf.angle, 1, () => {
        const hw = leaf.size * 0.34 * nar * side
        const tipY = leaf.curl * leaf.size * 0.28
        ctx.beginPath()
        ctx.moveTo(leaf.size * 0.04, hw * 0.1)
        ctx.quadraticCurveTo(leaf.size * (side > 0 ? 0.48 : 0.42), hw + tipY * 0.4, leaf.size, tipY)
        ctx.strokeStyle = fxa(leaf.vein, al(0.16))
        ctx.lineWidth = 0.6
        ctx.lineCap = 'round'
        ctx.stroke()
      })
    },
  })
  // side veinlets branching off the midrib
  const det = leaf.detail ?? 0
  if (det > 0.05) {
    const vlC = fxa(leaf.vein, al(0.12 * det))
    const bend = leaf.curl * leaf.size
    ops.push({
      t: leaf.t + 2.6,
      draw(ctx) {
        withXf(ctx, leaf.x, leaf.y, leaf.angle, 1, () => {
          ctx.strokeStyle = vlC
          ctx.lineWidth = 0.45
          ctx.lineCap = 'round'
          for (let k = 0; k < 3; k++) {
            const u = 0.28 + k * 0.18
            const vside = k % 2 === 0 ? -1 : 1
            const x0 = leaf.size * u
            const y0 = bend * u * u * 0.14
            const x1 = leaf.size * (u + 0.16)
            const y1 = y0 + vside * leaf.size * 0.3 * nar * (1 - u)
            ctx.beginPath()
            ctx.moveTo(x0, y0)
            ctx.quadraticCurveTo((x0 + x1) / 2 + leaf.size * 0.05, (y0 + y1) / 2, x1, y1)
            ctx.stroke()
          }
        })
      },
    })
  }
}

function petalPath(ctx: CanvasRenderingContext2D, len: number, hw: number, e = 1): void {
  // e < 1 -> control point farther out (round petal); e > 1 -> pulled toward
  // the base (slim, pointed petal)
  const cpx = len * Math.min(0.58, Math.max(0.3, 0.45 / Math.sqrt(e)))
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.quadraticCurveTo(cpx, -hw, len, 0)
  ctx.quadraticCurveTo(cpx, hw, 0, 0)
}

function planFlower(f: Flower, p: PaintParams, ops: PaintOp[], prim: number): void {
  const al = (a: number) => clamp01(a * p.opacity)
  const open = clamp01(f.open)
  const isBud = open < 0.55
  const nBase = isBud ? Math.min(3, f.petals) : f.petals
  const size = f.size * (0.45 + 0.55 * open)
  const e = f.petalE ?? 1
  const hwR = f.petalHw ?? 0.42
  const rings = isBud ? 1 : Math.max(1, Math.min(2, f.layers ?? 1))
  let tLast = f.t
  for (let ring = 0; ring < rings; ring++) {
    const spread = isBud ? 0.9 : TAU
    const a0 = (isBud ? f.angle - spread / 2 : f.angle) + (ring * Math.PI) / nBase
    const rScale = ring === 0 ? 1 : 0.55
    const tRing = f.t + ring * nBase * 0.4
    for (let k = 0; k < nBase; k++) {
      const ang = a0 + (k / nBase) * spread + (hash01(prim * 31 + k, 7 + ring) - 0.5) * 0.22
      const len = size * rScale * (0.85 + hash01(prim * 31 + k, 11 + ring) * 0.3)
      const hw = len * (isBud ? 0.3 : hwR)
      const t = tRing + k * (ring === 0 ? 0.7 : 0.35)
      tLast = Math.max(tLast, t)
      const fill = ring === 0 ? fxa(f.petal, al(0.24)) : fxa(f.edge, al(0.14))
      const inner = fxa(f.edge, al(0.12))
      const edge = fxa(f.edge, al(ring === 0 ? 0.2 : 0.14))
      ops.push({
        t,
        draw(ctx) {
          withXf(ctx, f.x, f.y, ang, 1, () => {
            petalPath(ctx, len, hw, e)
            ctx.fillStyle = fill
            ctx.fill()
            ctx.strokeStyle = edge
            ctx.lineWidth = 0.5
            ctx.stroke()
          })
        },
      })
      if (ring === 0) {
        // deeper wash pooling toward the petal base
        ops.push({
          t: t + 0.4,
          draw(ctx) {
            withXf(ctx, f.x, f.y, ang, 1, () => {
              petalPath(ctx, len * 0.55, hw * 0.6, e)
              ctx.fillStyle = inner
              ctx.fill()
            })
          },
        })
      }
    }
  }
  if (!isBud) {
    const style = f.centerStyle ?? 'dot'
    const centerC = fxa(f.center, al(0.45))
    const stamenC = fxa(f.edge, al(0.4))
    const tC = tLast + 0.8
    if (style === 'stamens') {
      ops.push({
        t: tC,
        draw(ctx) {
          const ns = 6
          for (let k = 0; k < ns; k++) {
            const ang = f.angle + (k / ns) * TAU + 0.3
            const r = size * 0.34
            const ex = f.x + Math.cos(ang) * r
            const ey = f.y + Math.sin(ang) * r
            ctx.beginPath()
            ctx.moveTo(f.x, f.y)
            ctx.lineTo(ex, ey)
            ctx.strokeStyle = stamenC
            ctx.lineWidth = 0.45
            ctx.lineCap = 'round'
            ctx.stroke()
            ctx.beginPath()
            ctx.arc(ex, ey, 0.9, 0, TAU)
            ctx.fillStyle = centerC
            ctx.fill()
          }
        },
      })
    } else if (style === 'disc') {
      ops.push({
        t: tC,
        draw(ctx) {
          ctx.beginPath()
          ctx.arc(f.x, f.y, Math.max(1.2, size * 0.22), 0, TAU)
          ctx.fillStyle = fxa(f.center, al(0.32))
          ctx.fill()
          const dots = 8
          for (let k = 0; k < dots; k++) {
            const ang = f.angle + (k / dots) * TAU
            const r = size * 0.15
            ctx.beginPath()
            ctx.arc(f.x + Math.cos(ang) * r, f.y + Math.sin(ang) * r, 0.55, 0, TAU)
            ctx.fillStyle = stamenC
            ctx.fill()
          }
        },
      })
    } else {
      ops.push({
        t: tC,
        draw(ctx) {
          ctx.beginPath()
          ctx.arc(f.x, f.y, Math.max(1, size * 0.16), 0, TAU)
          ctx.fillStyle = centerC
          ctx.fill()
          const dots = 5
          for (let k = 0; k < dots; k++) {
            const ang = f.angle + (k / dots) * TAU + 0.4
            const r = size * 0.26
            ctx.beginPath()
            ctx.arc(f.x + Math.cos(ang) * r, f.y + Math.sin(ang) * r, 0.7, 0, TAU)
            ctx.fillStyle = stamenC
            ctx.fill()
          }
        },
      })
    }
  }
}

function planTick(tick: Tick, p: PaintParams, ops: PaintOp[]): void {
  const color = fxa(tick.tone, clamp01(tick.alpha * p.opacity))
  ops.push({
    t: tick.t,
    draw(ctx) {
      ctx.beginPath()
      ctx.moveTo(tick.x, tick.y)
      ctx.lineTo(tick.x + Math.cos(tick.angle) * tick.len, tick.y + Math.sin(tick.angle) * tick.len)
      ctx.strokeStyle = color
      ctx.lineWidth = tick.w
      ctx.lineCap = 'round'
      ctx.stroke()
    },
  })
}

function planBerry(berry: Berry, p: PaintParams, ops: PaintOp[], prim: number): void {
  const al = (a: number) => clamp01(a * p.opacity)
  const body = fxa(berry.tone, al(0.26))
  const rim = fxa(berry.deep, al(0.28))
  const dot = fxa(berry.deep, al(0.4))
  for (let k = 0; k < berry.n; k++) {
    const ang = k * 2.4 + hash01(prim, k) * 0.8
    const d = berry.r * 1.9 * Math.sqrt((k + 0.5) / berry.n)
    const bx = berry.x + Math.cos(ang) * d
    const by = berry.y + Math.sin(ang) * d
    const br = berry.r * (0.8 + hash01(prim + 1, k) * 0.45)
    ops.push({
      t: berry.t + k * 0.35,
      draw(ctx) {
        ctx.beginPath()
        ctx.arc(bx, by, br, 0, TAU)
        ctx.fillStyle = body
        ctx.fill()
        ctx.strokeStyle = rim
        ctx.lineWidth = 0.5
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(bx + br * 0.25, by - br * 0.25, br * 0.22, 0, TAU)
        ctx.fillStyle = dot
        ctx.fill()
      },
    })
  }
}

export function planOps(model: PlantModel, p: PaintParams): PaintPlan {
  const ops: PaintOp[] = []
  for (let i = 0; i < model.prims.length; i++) {
    const prim = model.prims[i]
    if (prim.kind === 'stem') planStem(prim, p, ops, i)
    else if (prim.kind === 'leaf') planLeaf(prim, p, ops, i)
    else if (prim.kind === 'flower') planFlower(prim, p, ops, i)
    else if (prim.kind === 'tick') planTick(prim, p, ops)
    else planBerry(prim, p, ops, i)
  }
  ops.sort((a, b) => a.t - b.t)
  const duration = ops.length ? ops[ops.length - 1].t : 1
  return { ops, duration }
}

/** Fill paper and switch to pigment (multiply) compositing. */
export function preparePaper(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = fx('paper')
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'multiply'
}
