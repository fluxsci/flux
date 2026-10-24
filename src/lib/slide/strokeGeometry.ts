// ---------------------------------------------------------------------------
// Flux Slide — the drawable geometry under a target (pure; shared by the drawOn/drawOff presets
// and by the auto-build's pen-speed measure `partLength.ts`, so "which strokes draw" has ONE
// definition). Moved verbatim from player/presets.ts.
// ---------------------------------------------------------------------------
import { readPaint } from "../plot/paint";

/** Inside a <defs> subtree? Such geometry is a shared TEMPLATE (fluxplot ticks
 *  reference one defs path via <use> per tick) — dashing it would animate every
 *  referencing instance at once. Never draw-on defs content. */
export function inDefs(el: Element): boolean {
  for (let p: Element | null = el.parentElement ?? (el.parentNode as Element | null); p; p = p.parentElement ?? (p.parentNode as Element | null)) {
    if (p.tagName?.toLowerCase() === "defs") return true;
  }
  return false;
}
/** The attribute of the lead dot an x-clock sweep inserts beside its line while the slide plays (presets.ts `sweepPen`): player-made,
 *  never geometry of the target, so no draw, measure or later track ever selects it. */
export const SWEEP_PEN_ATTR = "data-flux-sweep-pen";
/** Marks the geometry of an ATTACHED connector (render.ts normalizeAttachedDash): its draw samplers read it live (presets.ts). */
export const ATTACHED_GEOMETRY_ATTR = "data-flux-attached";
/** Geometry a draw may select: not a shared <defs> template, not a player-made lead dot. */
export const drawable = (el: Element): boolean => !inDefs(el) && !el.hasAttribute?.(SWEEP_PEN_ATTR);

/** The drawable geometry under a target, SPLIT by how it paints. Dash windows
 *  hide the STROKE alone, so only stroke-rendered geometry (stroke set, fill
 *  none/absent) can self-draw; FILL-rendered geometry (filled arrowhead
 *  polygons, area fills, filled shapes) would flash its fill before its beat
 *  if dashed — it gets an end-timed opacity reveal instead, so an arrow's
 *  head pops in as the stroke reaches it. FluxPlot wraps each part in a
 *  <g id="…"> and the real geometry lives inside — drill to descendants.
 *  <use> and anything living in <defs> are excluded (a <use>'s length can't
 *  be measured and its defs path is shared); both lists empty → callers pick
 *  the whole-node fade fallback instead of silently no-oping. */
export const GEO_TAGS = "path,line,polyline,polygon,rect,ellipse,circle";
export function paintOf(el: Element): { stroked: boolean; filled: boolean } {
  const paint = readPaint(el);
  return { stroked: paint.stroke !== "none", filled: paint.fill !== "none" };
}
export function drawGeometry(node: Element): { strokes: SVGElement[]; fills: SVGElement[] } {
  const el = node as Element;
  const tag = el.tagName?.toLowerCase();
  const all: SVGElement[] = [];
  if (tag && new RegExp(`^(${GEO_TAGS.replace(/,/g, "|")})$`).test(tag)) {
    if (drawable(el)) all.push(el as SVGElement);
  } else {
    for (const g of Array.from(el.querySelectorAll?.(GEO_TAGS) ?? []) as SVGElement[]) {
      if (drawable(g)) all.push(g);
    }
  }
  const strokes: SVGElement[] = [];
  const fills: SVGElement[] = [];
  for (const g of all) {
    const p = paintOf(g);
    if (p.stroked && !p.filled) strokes.push(g);
    else if (p.filled) fills.push(g); // filled (or stroke+fill) → opacity reveal
  }
  return { strokes, fills };
}


/** Is this a MULTI-PATH drawing: a root holding at least two stroke-rendered geometries (a house, its roof and a sun)? Only such a target
 *  has strokes to put in order (`params.order`); a lone stroke, an arrow (shaft + filled head) or a filled shape does not. One definition
 *  for the Animator (the plot store's parsed DOM) and the headless verbs (a parse of the plot's own SVG). */
export function multiStroke(root: ParentNode | Element | null | undefined): boolean {
  return !!root && drawGeometry(root as Element).strokes.length > 1;
}
