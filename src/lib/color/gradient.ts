// Gradient paints (2026-09-16, owner note): a colormap chosen for a fill or a
// stroke is not one colour off the map but the WHOLE map, laid across the
// element's box as a linear gradient along one axis — x runs left→right, y runs
// bottom→top (low values at the bottom, as on a plot's y axis). Pure and
// DOM-free: the canvas (Element.svelte) and the export serializer (export.ts,
// hence flux-core's headless render) both paint through `elementPaints`, so
// what the owner sees is what the SVG/PNG/TIFF carries. The stops live ON the
// element (GradientFill.stops, resolved by color/collections.makeGradientFill
// when the map is applied), so this module imports no colormap table: the
// exported deck runtime, which bundles the serializer, stays small and offline
// by construction. A fill whose stops are missing (a hand-edited project) falls
// back to the element's solid colour — never a broken `url(#…)`.
import type { Element, GradientFill } from "../types";

export type GradientAxis = GradientFill["axis"];
export const GRADIENT_AXES: readonly GradientAxis[] = ["x", "y"];

export interface GradientStop {
  /** 0–1 along the gradient vector. */
  offset: number;
  color: string;
}

export interface GradientDef {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  units: "objectBoundingBox" | "userSpaceOnUse";
  stops: GradientStop[];
}

/** Everything a renderer needs to paint one element. `heads` paints arrowheads
 *  (line/path polygons + vees), which share the stroke's gradient. */
export interface ElementPaints {
  fill: string;
  stroke: string;
  heads: string;
  defs: GradientDef[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A document-unique, attribute-safe id for an element's gradient. */
export function gradientId(elementId: string, target: "fill" | "stroke", variant = ""): string {
  return `fxg-${String(elementId).replace(/[^A-Za-z0-9_-]/g, "_")}-${target}${variant ? "-" + variant : ""}`;
}

/** The stored stops as SVG offsets; discrete maps become hard bands. Null when there are none. */
export function gradientStops(g: GradientFill | null | undefined): GradientStop[] | null {
  const cols = g?.stops ?? [];
  if (!cols.length) return null;
  if (cols.length === 1) return [{ offset: 0, color: cols[0] }, { offset: 1, color: cols[0] }];
  if (g!.discrete) {
    const out: GradientStop[] = [];
    const n = cols.length;
    cols.forEach((c, i) => out.push({ offset: i / n, color: c }, { offset: (i + 1) / n, color: c }));
    return out;
  }
  return cols.map((c, i) => ({ offset: i / (cols.length - 1), color: c }));
}

/** The gradient vector for an axis over a box (the unit box for objectBoundingBox). */
export function gradientVector(axis: GradientAxis, box: Box = { x: 0, y: 0, w: 1, h: 1 }): Pick<GradientDef, "x1" | "y1" | "x2" | "y2"> {
  return axis === "y"
    ? { x1: box.x, y1: box.y + box.h, x2: box.x, y2: box.y }
    : { x1: box.x, y1: box.y, x2: box.x + box.w, y2: box.y };
}

/** A full gradient definition; `box` (user space) makes it userSpaceOnUse. */
export function gradientDef(id: string, g: GradientFill, box?: Box | null): GradientDef | null {
  const stops = gradientStops(g);
  if (!stops) return null;
  const axis: GradientAxis = g.axis === "y" ? "y" : "x";
  return box
    ? { id, ...gradientVector(axis, box), units: "userSpaceOnUse", stops }
    : { id, ...gradientVector(axis), units: "objectBoundingBox", stops };
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

/** Serialize one definition (export.ts). */
export function gradientSvg(d: GradientDef): string {
  const stops = d.stops.map((s) => `<stop offset="${num(s.offset)}" stop-color="${s.color}"/>`).join("");
  return (
    `<linearGradient id="${d.id}" x1="${num(d.x1)}" y1="${num(d.y1)}" x2="${num(d.x2)}" y2="${num(d.y2)}" ` +
    `gradientUnits="${d.units}">${stops}</linearGradient>`
  );
}

/** `<defs>…</defs>` for an element's gradients, or "" — so an element without
 *  a map serializes byte-identically to before gradients existed. */
export function paintDefsSvg(P: ElementPaints): string {
  return P.defs.length ? `<defs>${P.defs.map(gradientSvg).join("")}</defs>` : "";
}

/** CSS preview of a gradient fill (menu chips, Inspector swatches); null without stops. */
export function gradientCss(g: GradientFill | null | undefined): string | null {
  const stops = gradientStops(g);
  if (!stops) return null;
  const list = g!.discrete
    ? stops.map((s) => `${s.color} ${(s.offset * 100).toFixed(3)}%`).join(", ")
    : stops.map((s) => s.color).join(", ");
  return `linear-gradient(${g!.axis === "y" ? "to top" : "to right"}, ${list})`;
}

/** Human label for a gradient fill. */
export function gradientLabel(g: GradientFill): string {
  return `${g.map} · along ${g.axis === "y" ? "y" : "x"}`;
}

function lineBox(e: Extract<Element, { type: "line" }>): Box {
  const x = Math.min(e.x1, e.x2);
  const y = Math.min(e.y1, e.y2);
  return { x: e.x + x, y: e.y + y, w: Math.abs(e.x2 - e.x1), h: Math.abs(e.y2 - e.y1) };
}

/** A path's local box from its nodes (or the numbers of its `d`): an estimate
 *  (curve bulges ignored) used only to key the arrowheads' gradient to the
 *  path's own; the path itself uses its exact bounding box. */
export function pathLocalBox(e: Extract<Element, { type: "path" }>): Box | null {
  let xs: number[] = [];
  let ys: number[] = [];
  if (e.nodes?.length) {
    xs = e.nodes.map((n) => n.x);
    ys = e.nodes.map((n) => n.y);
  } else {
    const nums = (e.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      xs.push(nums[i]);
      ys.push(nums[i + 1]);
    }
  }
  if (!xs.length) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Resolve an element's paints — solid colours unless a map is set and known. */
export function elementPaints(e: Element): ElementPaints {
  const defs: GradientDef[] = [];
  const paint = (solid: string, g: GradientFill | null | undefined, target: "fill" | "stroke", box?: Box | null, variant = "") => {
    if (!g?.stops?.length) return solid;
    const def = gradientDef(gradientId(e.id, target, variant), g, box);
    if (!def) return solid;
    defs.push(def);
    return `url(#${def.id})`;
  };
  switch (e.type) {
    case "text":
      return { fill: paint(e.color, e.fillMap, "fill"), stroke: "none", heads: "none", defs };
    case "rect":
    case "ellipse": {
      const fill = paint(e.fill, e.fillMap, "fill");
      const stroke = paint(e.stroke, e.strokeMap, "stroke");
      return { fill, stroke, heads: stroke, defs };
    }
    case "line": {
      // one figure-space gradient shared by the line and its arrowheads
      const stroke = paint(e.stroke, e.strokeMap, "stroke", lineBox(e));
      return { fill: "none", stroke, heads: stroke, defs };
    }
    case "path": {
      const fill = paint(e.closed ? e.fill : "none", e.closed ? e.fillMap : null, "fill");
      const stroke = paint(e.stroke, e.strokeMap, "stroke");
      // arrowheads sit outside the path's translate(): a figure-space twin
      let heads = stroke;
      if (e.strokeMap?.stops?.length && stroke !== e.stroke) {
        const lb = pathLocalBox(e);
        heads = lb ? paint(e.stroke, e.strokeMap, "stroke", { x: e.x + lb.x, y: e.y + lb.y, w: lb.w, h: lb.h }, "heads") : e.stroke;
      }
      return { fill, stroke, heads, defs };
    }
    default:
      return { fill: "none", stroke: "none", heads: "none", defs };
  }
}
