import type { Element } from "./types";
import type { DrawStyle, Tool } from "./store";
import { newId } from "./ids";
import { elementBBox, type Rect } from "./geometry";
import { applyTextLayout } from "./text";
import { scaleNodes, nodesToPath, pathToNodes, constrain45 } from "./path";

export interface Pt {
  x: number;
  y: number;
}

// Creation modifiers (Feature 12): transform a draw drag (start → cur) before the
// element is built. Shift constrains a rect/ellipse to a square/circle (equal
// extents, drag direction kept) and a line/arrow to the nearest 0/45/90°; Alt
// expands symmetrically about the start point; Shift+Alt combines both. Pure.
export function applyDrawModifiers(
  tool: Tool,
  start: Pt,
  cur: Pt,
  shift: boolean,
  alt: boolean,
): { p0: Pt; p1: Pt } {
  let dx = cur.x - start.x;
  let dy = cur.y - start.y;
  if (shift) {
    if (tool === "line" || tool === "arrow") {
      ({ dx, dy } = constrain45(dx, dy));
    } else {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * m;
      dy = (dy < 0 ? -1 : 1) * m;
    }
  }
  if (alt) return { p0: { x: start.x - dx, y: start.y - dy }, p1: { x: start.x + dx, y: start.y + dy } };
  return { p0: start, p1: { x: start.x + dx, y: start.y + dy } };
}

// Build a new element from a drag (p0 -> p1) for a given drawing tool.
export function createDrawElement(
  tool: Tool,
  p0: Pt,
  p1: Pt,
  style: DrawStyle,
): Element | null {
  const x = Math.min(p0.x, p1.x);
  const y = Math.min(p0.y, p1.y);
  const w = Math.abs(p1.x - p0.x);
  const h = Math.abs(p1.y - p0.y);

  switch (tool) {
    case "rect":
      return {
        type: "rect",
        id: newId("rect"),
        x,
        y,
        width: w,
        height: h,
        rotation: 0,
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        cornerRadius: 0,
      };
    case "ellipse":
      return {
        type: "ellipse",
        id: newId("ellipse"),
        x,
        y,
        width: w,
        height: h,
        rotation: 0,
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
      };
    case "line":
    case "arrow":
      return {
        type: "line",
        id: newId("line"),
        x: p0.x,
        y: p0.y,
        width: 0,
        height: 0,
        rotation: 0,
        x1: 0,
        y1: 0,
        x2: p1.x - p0.x,
        y2: p1.y - p0.y,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        arrowStart: false,
        arrowEnd: tool === "arrow",
      };
    default:
      return null;
  }
}

export function createTextElement(p: Pt, style: DrawStyle): Element {
  const el: Element = {
    type: "text",
    id: newId("text"),
    x: p.x,
    y: p.y,
    width: 240,
    height: style.fontSize * 1.4,
    rotation: 0,
    text: "Text",
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: "normal",
    align: "left",
    color: style.textColor,
    sizing: "auto",
  };
  applyTextLayout(el);
  return el;
}

// Proportional SCALE remap (Feature 5, the K tool): like resizeRemap, but also
// multiplies the "weight" properties — strokeWidth, cornerRadius, fontSize (the
// EXPLICIT geometric scaler; plain resize never touches fonts) — and a plot/svg
// element's contentScale (plot/compensate.ts consumes it, so K scales a plot's
// glyphs/strokes geometrically while plain resize stays pt-true). The Scale tool
// forces a uniform box, so sx == sy; we use s = nb.w/ob.w (falls back to the
// average if a degenerate axis sneaks in).
export function scaleRemap(e: Element, orig: Element, ob: Rect, nb: Rect) {
  const sx = ob.w === 0 ? 1 : nb.w / ob.w;
  const sy = ob.h === 0 ? 1 : nb.h / ob.h;
  const s = ob.w !== 0 ? sx : sy || (sx + sy) / 2;
  if (e.type === "text" && orig.type === "text") {
    // K scales text fully: box AND font together (wrap points stay put). The
    // sizing mode is untouched — scaling is not a mode change.
    const ob2 = elementBBox(orig);
    e.x = nb.x + (ob2.x - ob.x) * sx;
    e.y = nb.y + (ob2.y - ob.y) * sy;
    e.fontSize = Math.max(2, orig.fontSize * s);
    e.width = Math.max(1, orig.width * sx);
    e.height = Math.max(1, orig.height * sy);
    applyTextLayout(e); // headless-safe (drops the stale wrap cache)
  } else {
    resizeRemap(e, orig, ob, nb);
  }
  if ("strokeWidth" in e && "strokeWidth" in orig) e.strokeWidth = Math.max(0, orig.strokeWidth * s);
  if (e.type === "rect" && orig.type === "rect") e.cornerRadius = Math.max(0, orig.cornerRadius * s);
  if ((e.type === "svg" || e.type === "plot") && (orig.type === "svg" || orig.type === "plot")) {
    e.contentScale = Math.max(0.01, (orig.contentScale ?? 1) * s);
  }
}

// Remap one element when the selection bounding box changes from ob -> nb.
// `axes` (from the drag handle: e/w = width-only, n/s = height-only, corners =
// both) drives the TEXT sizing-mode transitions; without it, the box delta
// decides (bridge/ops callers).
export function resizeRemap(
  e: Element,
  orig: Element,
  ob: Rect,
  nb: Rect,
  axes?: { w: boolean; h: boolean },
) {
  const sx = ob.w === 0 ? 1 : nb.w / ob.w;
  const sy = ob.h === 0 ? 1 : nb.h / ob.h;
  const fx = (px: number) => nb.x + (px - ob.x) * sx;
  const fy = (py: number) => nb.y + (py - ob.y) * sy;

  if (orig.type === "line") {
    const e2 = e as typeof orig;
    const ax1 = fx(orig.x + orig.x1);
    const ay1 = fy(orig.y + orig.y1);
    const ax2 = fx(orig.x + orig.x2);
    const ay2 = fy(orig.y + orig.y2);
    e2.x = ax1;
    e2.y = ay1;
    e2.x1 = 0;
    e2.y1 = 0;
    e2.x2 = ax2 - ax1;
    e2.y2 = ay2 - ay1;
    return;
  }

  const ob2 = elementBBox(orig);

  // Path: rescale the ACTUAL geometry (previously the bug — only x/y/w/h changed
  // and `d` snapped back). Scale the authoritative nodes if present, else parse
  // the legacy `d`, scale, and regenerate — so resize persists on commit + export.
  if (e.type === "path" && orig.type === "path") {
    e.x = fx(ob2.x);
    e.y = fy(ob2.y);
    if (orig.nodes && orig.nodes.length) {
      e.nodes = scaleNodes(orig.nodes, sx, sy);
      e.d = nodesToPath(e.nodes, e.closed);
    } else {
      e.d = nodesToPath(scaleNodes(pathToNodes(orig.d), sx, sy), e.closed);
    }
    e.width = Math.max(1, orig.width * sx);
    e.height = Math.max(1, orig.height * sy);
    return;
  }

  // Text: the box changes, the FONT NEVER does (Figma contract — the K/Scale
  // tool is the intentional font scaler). A width drag turns a hugging "auto"
  // box into "auto-h" (wrap at the new width, height hugs); any height drag
  // pins the box "fixed". applyTextLayout re-wraps + re-hugs per the mode.
  if (e.type === "text" && orig.type === "text") {
    e.x = fx(ob2.x);
    e.y = fy(ob2.y);
    e.width = Math.max(1, orig.width * sx);
    e.height = Math.max(1, orig.height * sy);
    const wDrag = axes ? axes.w : Math.abs(nb.w - ob.w) > 1e-9;
    const hDrag = axes ? axes.h : Math.abs(nb.h - ob.h) > 1e-9;
    if (hDrag) e.sizing = "fixed";
    else if (wDrag && e.sizing === "auto") e.sizing = "auto-h";
    applyTextLayout(e);
    return;
  }

  e.x = fx(ob2.x);
  e.y = fy(ob2.y);
  if ("width" in e && "width" in orig) e.width = Math.max(1, orig.width * sx);
  if ("height" in e && "height" in orig) e.height = Math.max(1, orig.height * sy);
}
