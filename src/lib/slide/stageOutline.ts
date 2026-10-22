// ---------------------------------------------------------------------------
// Flux Slide — STAGE OUTLINES (animation v2 §3.2): the one geometry currency a
// Become's two sides share. Anything that can morph — a drawn element, a plot
// part (a box, a spine, a marker glyph), the members of a group — is expressed
// as one or more outlines in STAGE pixels (the slide's fixed StageSize frame,
// rotation/flips/plot mapping baked in) with its paint, so the correspondence
// planner (slide/correspondence.ts) never has to know which object owns which
// side. `slide/targetGeometry.ts` produces them; the hand-off driver draws
// the sampled result on the stage flight layer.
//
// Types only — pure by construction. Kept separate so the producer and the
// consumer packets build against one definition.
// ---------------------------------------------------------------------------

import type { Id, VectorNode } from "../types";

/** Which target an outline came from, and what it means. `data` carries the
 *  datum a data-bearing part encodes (from the manifest's part index) so the
 *  `data` pairing policy can land a point at ITS x on a curve. */
export interface OutlineOwner {
  elementId: Id;
  /** Plot part (leaf) id; absent for a drawn element or a raster box. */
  partId?: string;
  role?: string;
  series?: string;
  index?: number;
  data?: { x?: number; y?: number };
  /** Constituent leaves when several outlines were merged into one chain
   *  (two spines → one L); the reveal at t = 1 flips every constituent. */
  members?: { elementId: Id; partId?: string }[];
}

/** The paint of one outline in STAGE units (stroke width already scaled by the
 *  plot's pt-true factor). `none`/transparent paints are the literal string
 *  "none". `text`/`raster` mark outlines that have no drawable geometry of their
 *  own: the planner crossfades those over a box tween instead of morphing. */
export interface OutlinePaint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash?: number[];
  cap: "butt" | "round" | "square";
  opacity?: number;
  /** Per-channel alpha (absent = opaque) and colormap gradients of a DRAWN element:
   *  the hand-off driver used to drop them, so a translucent or gradient-filled
   *  source popped to opaque flat colour on its first flight frame. */
  fillOpacity?: number;
  strokeOpacity?: number;
  fillMap?: import("../types").GradientFill | null;
  strokeMap?: import("../types").GradientFill | null;
  /** The ELEMENT's stage box a gradient is laid over (userSpaceOnUse). Pieces cut from one
   *  element (arcs, fill triangles, strips) inherit it through `{...paint}`, so every piece
   *  shows its slice of ONE ramp, not a whole ramp per piece. */
  gradBox?: { x: number; y: number; w: number; h: number };
  arrowStart?: boolean;
  arrowEnd?: boolean;
  arrowStyle?: "filled" | "vee";
  arrowSize?: number;
  /** A text run: no outline, box + crossfade. */
  text?: boolean;
  /** An image/video/raster plot fallback: no outline, box + crossfade. */
  raster?: boolean;
}

/** One ring (closed) or one open chain, in stage px. `bbox` is the outline's
 *  own axis-aligned box (the unit frame the 1↔1 correspondence normalizes in). */
export interface StageOutline {
  nodes: VectorNode[];
  closed: boolean;
  bbox: { x: number; y: number; w: number; h: number };
  owner: OutlineOwner;
  paint: OutlinePaint;
}
