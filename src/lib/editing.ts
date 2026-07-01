import type { Element } from "./types";
import type { DrawStyle, Tool } from "./store";
import { newId } from "./store";
import { elementBBox, type Rect } from "./geometry";
import { applyAutoWidth } from "./text";
import { scaleNodes, nodesToPath, pathToNodes } from "./path";

export interface Pt {
  x: number;
  y: number;
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
    autoWidth: true,
  };
  applyAutoWidth(el);
  return el;
}

// Remap one element when the selection bounding box changes from ob -> nb.
export function resizeRemap(e: Element, orig: Element, ob: Rect, nb: Rect) {
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

  // Text: scale the font (not the box), then let auto-width re-fit the box.
  if (e.type === "text" && orig.type === "text") {
    e.x = fx(ob2.x);
    e.y = fy(ob2.y);
    e.fontSize = Math.max(2, orig.fontSize * ((sx + sy) / 2));
    if (e.autoWidth) {
      applyAutoWidth(e);
    } else {
      e.width = Math.max(1, orig.width * sx);
      e.height = Math.max(1, orig.height * sy);
    }
    return;
  }

  e.x = fx(ob2.x);
  e.y = fy(ob2.y);
  if ("width" in e && "width" in orig) e.width = Math.max(1, orig.width * sx);
  if ("height" in e && "height" in orig) e.height = Math.max(1, orig.height * sy);
}
