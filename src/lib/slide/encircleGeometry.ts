// ---------------------------------------------------------------------------
// Flux Slide — pure geometry of the `encircle` overlay (WP 2.2; manim Circumscribe). No DOM. Gate: verify-appear-emphasis.
//
// The band must hug what the VIEWER sees, so the box is built in the target's own frame:
//  • box-like elements (rect, ellipse, image, whole plot, text, model3d …): the stored UNROTATED box, drawn in a
//    `rotate(rotation, cx, cy)` group, so a 40-degree rectangle is circled by a 40-degree band;
//  • text: the INK extent (measured by the player in the unrotated layout) instead of the fixed text box, so "circle this
//    word / this sentence" hugs the text;
//  • lines, paths and plot parts: the union of the target's STAGE outlines (arrowheads included, rotation already applied)
//    padded by half the stroke, axis-aligned, nothing to rotate.
// ---------------------------------------------------------------------------
import type { Rect } from "../geometry";
import { elementBBox, unionRect } from "../geometry";
import { PRESET_PARAMS, presetParam } from "./presetCatalog";

export interface EncircleShape {
  /** The band's rounded rectangle in the (pre-rotation) local frame, gap and stroke already added. */
  x: number; y: number; w: number; h: number; radius: number;
  /** Rotation in degrees about the pivot (cx, cy); 0 for union boxes. */
  rotation: number; cx: number; cy: number;
}
export interface EncircleParams { gap: number; radius: number; width: number; window: number }
/** The table's defaults (`PRESET_PARAMS.encircle`): the only copy of 6 / 6 / 3.5 / 0.3. */
export const ENCIRCLE_DEFAULTS: EncircleParams = {
  gap: PRESET_PARAMS.encircle.gap.default as number, radius: PRESET_PARAMS.encircle.radius.default as number,
  width: PRESET_PARAMS.encircle.width.default as number, window: PRESET_PARAMS.encircle.window.default as number,
};
/** Every free-form number an agent / the CLI can write, read through the one table: clamped into its range, NaN / a string /
 *  a missing key = the default (no negative sizes or NaN ever reach the DOM). */
export function encircleParams(params: Record<string, unknown> | undefined): EncircleParams {
  const source = { preset: "encircle", params };
  return {
    gap: presetParam(source, "gap", "encircle"), radius: presetParam(source, "radius", "encircle"),
    width: presetParam(source, "width", "encircle"), window: presetParam(source, "window", "encircle"),
  };
}

export interface EncircleInput {
  el?: { type: string; x: number; y: number; width: number; height: number; rotation?: number; strokeWidth?: number };
  /** Stage-space boxes of the target's outlines (lines / paths / plot parts). */
  boxes?: Rect[];
  /** Text ink rectangle in the element's UNROTATED local frame (stage units), when measured. */
  ink?: Rect;
}
export function encircleShape(input: EncircleInput, p: EncircleParams): EncircleShape | undefined {
  const { el, boxes, ink } = input;
  const unionBox = boxes?.length ? unionRect(boxes) : null;
  let base: Rect | null = null, rotation = 0, cx = 0, cy = 0, inflate = 0;
  if (el && (el.type === "line" || el.type === "path" || !!boxes?.length && el.type === "plot")) {
    if (!unionBox) return undefined;
    base = unionBox; inflate = (el.strokeWidth ?? 2) / 2; cx = base.x + base.w / 2; cy = base.y + base.h / 2;
  } else if (!el && unionBox) {
    base = unionBox; cx = base.x + base.w / 2; cy = base.y + base.h / 2;
  } else if (el) {
    const b = elementBBox(el as never);
    cx = b.x + b.w / 2; cy = b.y + b.h / 2; rotation = el.rotation ?? 0;
    base = ink && ink.w > 0 && ink.h > 0 ? { x: b.x + ink.x, y: b.y + ink.y, w: ink.w, h: ink.h } : b;
  }
  if (!base || !(base.w >= 0) || !(base.h >= 0)) return undefined;
  const m = p.gap + inflate + p.width / 2;
  const w = base.w + 2 * m, h = base.h + 2 * m;
  return { x: base.x - m, y: base.y - m, w, h, radius: Math.min(p.radius, Math.min(w, h) / 2), rotation, cx, cy };
}
