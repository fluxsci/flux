// The shared plant model: every engine reduces to these primitives, each
// stamped with a birth time `t` on an abstract growth clock. The painter
// turns the model into timed brush strokes; it never needs to know which
// algorithm grew the plant.

export interface StemNode {
  x: number
  y: number
  w: number // stroke width at this node (px)
  t: number // birth time (growth-clock units)
}

export interface Stem {
  kind: 'stem'
  nodes: StemNode[]
  shade: string // flexoki token for the pencil line
  wash?: string // flexoki token for the wide watercolor underlay (defaults to shade)
  texture?: number // 0..1 — adds broken bark-fiber strokes along the stem
}

export interface Leaf {
  kind: 'leaf'
  x: number
  y: number
  angle: number // radians; direction the leaf points
  size: number // length in px
  curl: number // -1..1 asymmetric bend
  t: number
  fill: string // wash token
  vein: string // midrib token
  narrow?: number // width multiplier (0.6 willow .. 1.3 broad); default 1
  detail?: number // 0..1 — side veinlets
}

export interface Flower {
  kind: 'flower'
  x: number
  y: number
  size: number // petal length in px
  petals: number
  angle: number
  open: number // 0..1 — bud to full bloom
  t: number
  petal: string
  edge: string
  center: string
  petalE?: number // petal tip shape: <1 rounder, >1 slimmer/pointed; default 1
  petalHw?: number // half-width as fraction of petal length; default 0.42
  layers?: number // 1 or 2 petal rings; default 1
  centerStyle?: 'dot' | 'disc' | 'stamens' // default 'dot'
}

/** A single fine stroke — thorns, node marks, small accents. */
export interface Tick {
  kind: 'tick'
  x: number
  y: number
  angle: number
  len: number
  w: number
  tone: string
  alpha: number
  t: number
}

/** A small cluster of berries. */
export interface Berry {
  kind: 'berry'
  x: number
  y: number
  r: number // radius of one berry
  n: number // berries in the cluster
  tone: string // body wash token
  deep: string // rim/dot token
  t: number
}

export type Primitive = Stem | Leaf | Flower | Tick | Berry

export interface PlantModel {
  prims: Primitive[]
  duration: number // max birth time
}

export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  /** If present, the numeric value is an index into these labels (segmented control). */
  options?: string[]
}

export interface Engine {
  id: string
  label: string
  blurb: string
  params: ParamSpec[]
  generate(seed: string, w: number, h: number, p: Record<string, number>): PlantModel
}
