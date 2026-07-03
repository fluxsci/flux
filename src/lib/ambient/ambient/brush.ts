// The shared ink kit — the style contract in code. Two mark types: hairline
// ink and soft wash, both hand-wobbled, both revealed progressively via
// t-stamped ops. Every scene draws with these (or follows their alphas and
// weights when pushing raw ops), which is what keeps fourteen different
// subjects feeling like one sketchbook.

import { fxa } from '../core/palette'
import { hash01 } from '../core/prng'
import type { AmbientOp } from './types'

export interface Pt {
  x: number
  y: number
}

export const TAU = Math.PI * 2

/** Smooth deterministic wobble, unique per phase. */
export function wob(i: number, phase: number): number {
  return Math.sin(i * 0.9 + phase) * 0.6 + Math.sin(i * 0.37 + phase * 2.7 + 1.1) * 0.4
}

const chunkPath = (ctx: CanvasRenderingContext2D, pts: Pt[], a: number, b: number) => {
  ctx.beginPath()
  ctx.moveTo(pts[a].x, pts[a].y)
  for (let i = a + 1; i <= b; i++) ctx.lineTo(pts[i].x, pts[i].y)
}

export interface HairlineOpts {
  tone: string
  alpha: number
  w?: number
  t0: number
  t1: number
  /** taper the width toward the end (1 = none, 0 = to nothing) */
  taperTo?: number
  /** skip chunks at this probability — dry-brush breaks */
  breaks?: number
  breakPhase?: number
}

/** A fine ink line revealed start→end between t0 and t1. Points come pre-wobbled. */
export function hairline(ops: AmbientOp[], pts: Pt[], o: HairlineOpts): void {
  if (pts.length < 2) return
  const CHUNK = 6
  const color = fxa(o.tone, o.alpha)
  const w = o.w ?? 0.55
  const taperTo = o.taperTo ?? 1
  const n = pts.length - 1
  for (let a = 0; a < n; a += CHUNK) {
    const b = Math.min(n, a + CHUNK)
    if (o.breaks && hash01(a, (o.breakPhase ?? 0) + 17) < o.breaks) continue
    const frac = (a + b) / 2 / n
    const width = Math.max(0.3, w * (1 - (1 - taperTo) * frac))
    const t = o.t0 + (o.t1 - o.t0) * (b / n)
    ops.push({
      t,
      draw(ctx) {
        chunkPath(ctx, pts, a, b)
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.lineCap = 'butt'
        ctx.lineJoin = 'round'
        ctx.stroke()
      },
    })
  }
}

export interface InkStrokeOpts {
  w0: number
  w1?: number
  tone: string
  washTone?: string
  alpha?: number
  t0: number
  t1: number
}

/** The full painterly stroke: wide faint wash under two pencil passes. */
export function inkStroke(ops: AmbientOp[], pts: Pt[], o: InkStrokeOpts): void {
  if (pts.length < 2) return
  const CHUNK = 5
  const w1 = o.w1 ?? o.w0
  const alpha = o.alpha ?? 1
  const passes = [
    { wMul: 2.4, alpha: 0.05 * alpha, tone: o.washTone ?? o.tone, dt: 0 },
    { wMul: 1.0, alpha: 0.2 * alpha, tone: o.tone, dt: 0.05 },
    { wMul: 0.7, alpha: 0.15 * alpha, tone: o.tone, dt: 0.1 },
  ]
  const n = pts.length - 1
  for (const pass of passes) {
    const color = fxa(pass.tone, pass.alpha)
    for (let a = 0; a < n; a += CHUNK) {
      const b = Math.min(n, a + CHUNK)
      const frac = (a + b) / 2 / n
      const width = Math.max(0.35, (o.w0 + (w1 - o.w0) * frac) * pass.wMul)
      const t = o.t0 + (o.t1 - o.t0) * (b / n) + pass.dt
      ops.push({
        t,
        draw(ctx) {
          chunkPath(ctx, pts, a, b)
          ctx.strokeStyle = color
          ctx.lineWidth = width
          ctx.lineCap = 'butt'
          ctx.lineJoin = 'round'
          ctx.stroke()
        },
      })
    }
  }
}

export interface DashOpts {
  tone: string
  alpha: number
  w?: number
  dash: number
  gap: number
  t0: number
  t1: number
}

/** Dashed hairline along a polyline, dashes appearing in travel order. */
export function dashedLine(ops: AmbientOp[], pts: Pt[], o: DashOpts): void {
  if (pts.length < 2) return
  const color = fxa(o.tone, o.alpha)
  const w = o.w ?? 0.5
  // resample finely, then group runs of points into dash / gap segments
  const rs: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]
    const q = pts[i]
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    const steps = Math.max(1, Math.round(d / 1.5))
    for (let s = 1; s <= steps; s++)
      rs.push({ x: p.x + ((q.x - p.x) * s) / steps, y: p.y + ((q.y - p.y) * s) / steps })
  }
  const dashes: Pt[][] = []
  let cur: Pt[] = []
  let acc = 0
  let on = true
  for (let i = 0; i < rs.length; i++) {
    if (on) cur.push(rs[i])
    if (i === rs.length - 1) break
    acc += Math.hypot(rs[i + 1].x - rs[i].x, rs[i + 1].y - rs[i].y)
    if (acc >= (on ? o.dash : o.gap)) {
      acc = 0
      if (on && cur.length > 1) dashes.push(cur)
      cur = []
      on = !on
    }
  }
  if (on && cur.length > 1) dashes.push(cur)
  const nD = dashes.length
  dashes.forEach((seg, k) => {
    const t = o.t0 + (o.t1 - o.t0) * (k / Math.max(1, nD - 1))
    ops.push({
      t,
      draw(ctx) {
        ctx.beginPath()
        ctx.moveTo(seg[0].x, seg[0].y)
        for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y)
        ctx.strokeStyle = color
        ctx.lineWidth = w
        ctx.lineCap = 'round'
        ctx.stroke()
      },
    })
  })
}

export interface Dot {
  x: number
  y: number
  r: number
  tone: string
  alpha: number
}

/** Dots revealed in array order between t0 and t1. */
export function stipple(ops: AmbientOp[], dots: Dot[], t0: number, t1: number): void {
  const n = dots.length
  dots.forEach((d, k) => {
    const color = fxa(d.tone, d.alpha)
    ops.push({
      t: t0 + (t1 - t0) * (k / Math.max(1, n - 1)),
      draw(ctx) {
        ctx.beginPath()
        ctx.arc(d.x, d.y, d.r, 0, TAU)
        ctx.fillStyle = color
        ctx.fill()
      },
    })
  })
}

/** Hand-wobbled ring as a point array (closed — last point equals first). */
export function ringPts(
  cx: number,
  cy: number,
  r: number,
  n: number,
  wobAmp: number,
  phase: number,
  squashY = 1
): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU
    const rr = r + wob(i === n ? 0 : i, phase) * wobAmp
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * squashY })
  }
  return pts
}

/** Two stacked wash fills — a soft pigment pool. */
export function softDisc(
  ops: AmbientOp[],
  x: number,
  y: number,
  r: number,
  tone: string,
  alpha: number,
  t: number,
  phase = 0
): void {
  const c1 = fxa(tone, alpha)
  const c2 = fxa(tone, alpha * 0.8)
  ops.push({
    t,
    draw(ctx) {
      ctx.beginPath()
      const pts = ringPts(x, y, r, 18, r * 0.09, phase)
      ctx.moveTo(pts[0].x, pts[0].y)
      for (const p of pts) ctx.lineTo(p.x, p.y)
      ctx.closePath()
      ctx.fillStyle = c1
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x + r * 0.12, y - r * 0.08, r * 0.55, 0, TAU)
      ctx.fillStyle = c2
      ctx.fill()
    },
  })
}

/** Sort ops in place and return their duration. */
export function finish(ops: AmbientOp[]): number {
  ops.sort((a, b) => a.t - b.t)
  return ops.length ? ops[ops.length - 1].t : 1
}
