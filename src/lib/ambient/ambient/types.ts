// The ambient-scene contract. A Scene is a small generator: given a seed and
// sprite index it returns one "sprite" — a time-sorted op list that draws
// itself in, plus optional bounds so small sprites get small layers. The
// AmbientBox compositor gives every sprite the shared lifecycle: bloom in
// (ops revealed over `grow` seconds), linger, fade back into the paper.

import type { ParamSpec } from '../core/model'

export interface AmbientOp {
  t: number
  draw(ctx: CanvasRenderingContext2D): void
}

export interface SpriteSpec {
  ops: AmbientOp[] // must be sorted by t; coordinates are pane coordinates
  duration: number
  /** Omit for full-pane sprites. */
  bounds?: { x: number; y: number; w: number; h: number }
}

export interface SceneLife {
  rate: number // spawns per minute
  maxConcurrent: number
  grow: number // seconds to draw a sprite in
  hold: number
  fade: number
}

export interface Scene {
  id: string
  label: string
  blurb: string
  params: ParamSpec[]
  life: SceneLife // per-scene lifecycle defaults
  spawn(
    seed: string,
    index: number,
    w: number,
    h: number,
    knobs: Record<string, number>,
    /** Bounds of currently-active sprites — for overlap avoidance / one-at-a-time scenes. */
    occupied?: Array<{ x: number; y: number; w: number; h: number }>
  ): SpriteSpec | null
}
