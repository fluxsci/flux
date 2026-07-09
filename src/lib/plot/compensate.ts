// pt-true resize compensation — the Figma-parity contract for plots/SVGs:
// resizing an element rescales its GEOMETRY (axes box, data region) while text
// glyphs, tick/marker glyphs, stroke widths and dash patterns keep their true
// point size, exactly like changing matplotlib's figsize.
//
// Derived, never stored: factors come from (element box vs intrinsic size ×
// contentScale), computed fresh at every mount/export. User PartOverrides are
// applied BEFORE this pass, so an override fontSize/strokeWidth means true
// points at any box size ("composes on top"). The K scale tool multiplies
// contentScale instead — explicitly geometric scaling, Figma's Scale tool.
//
// The math (see the plan's §5.2): the outer <svg> maps viewBox units to the
// element box with preserveAspectRatio="none" (R = diag(Sx,Sy)). At TRUE size
// R0 = diag(Sx0,Sy0). For a text node with transform T (matplotlib rotates
// about the text's own x/y anchor), PREPENDING C = translate(a)·diag(fx,fy)·
// translate(−a) yields R·C·T whose linear part equals R0·cs·Rot(θ) for ANY
// rotation θ and ANY anisotropic resize — undistorted glyphs at true pt — and
// leaves the anchor position exactly where the geometry scale put it.
// Appending instead (R·T·C) shears rotated labels under non-uniform resize.
//
// vector-effect: non-scaling-stroke is deliberately NOT used — it normalizes
// to the outermost viewport (screen), which would freeze strokes across canvas
// zoom and break rasterized export.
//
// linkedom-safe: attribute/inline-style access only.

import { insideDefs } from "./derive";

export interface CompensateOpts {
  elW: number; // element box, canvas px
  elH: number;
  crop?: { x: number; y: number; width: number; height: number } | null; // intrinsic px
  contentScale?: number; // default 1 — the K tool's persisted geometric factor
  // Intrinsic CSS-px size of the SOURCE svg. Callers must capture it from the
  // pristine node BEFORE overwriting the clone's width/height with the element
  // box (a mutated clone no longer knows its true size). Fallback: read from
  // the instance (valid only when called pre-mutation).
  intrinsic?: { w: number; h: number };
}

const UNIT_TO_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

/** Intrinsic CSS-px size from width/height attrs (unit-converted like the
 *  browser: pt×4/3 etc.), falling back to the viewBox. Mirrors the contract of
 *  flux-core's svgIntrinsicSize and Asset.naturalWidth — one sizing chain. */
export function svgIntrinsicPx(root: Element): { w: number; h: number } {
  const parse = (v: string | null): number | null => {
    const m = (v ?? "").match(/^\s*([\d.]+)\s*(px|pt|pc|mm|cm|in)?\s*$/);
    if (!m) return null;
    return parseFloat(m[1]) * (UNIT_TO_PX[m[2] ?? "px"] ?? 1);
  };
  const w = parse(root.getAttribute("width"));
  const h = parse(root.getAttribute("height"));
  if (w && h) return { w, h };
  const vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  return { w: 0, h: 0 };
}

/** The viewBox string that shows exactly `crop` (intrinsic px) — shared by the
 *  live mount, the app exporter and flux-core so all three crop identically.
 *  viewBox speaks the svg's own units; convert via (viewBox span / intrinsic). */
export function cropViewBoxValue(
  vbAttr: string | null,
  intrinsic: { w: number; h: number },
  crop: { x: number; y: number; width: number; height: number },
): string {
  const vb = (vbAttr ?? "").split(/[\s,]+/).map(Number);
  const has = vb.length === 4 && vb.every((n) => Number.isFinite(n));
  const vbW = has ? vb[2] : intrinsic.w;
  const vbH = has ? vb[3] : intrinsic.h;
  const ux = intrinsic.w ? vbW / intrinsic.w : 1;
  const uy = intrinsic.h ? vbH / intrinsic.h : 1;
  const bx = has ? vb[0] : 0;
  const by = has ? vb[1] : 0;
  return `${bx + crop.x * ux} ${by + crop.y * uy} ${crop.width * ux} ${crop.height * uy}`;
}

const near = (v: number, t: number) => Math.abs(v - t) < 1e-6;
const SKIP_SUBTREES = new Set(["defs", "clippath", "style", "metadata", "title", "desc", "svg"]);
const STROKABLE = new Set(["path", "line", "polyline", "polygon", "rect", "circle", "ellipse"]);

function declaredStrokeProps(el: Element): { width: number | null; dash: string | null; hasStroke: boolean } {
  const style = el.getAttribute("style") ?? "";
  const sw = style.match(/(?:^|;)\s*stroke-width\s*:\s*([\d.]+)/i);
  const dash = style.match(/(?:^|;)\s*stroke-dasharray\s*:\s*([^;]+)/i);
  const stroke =
    style.match(/(?:^|;)\s*stroke\s*:\s*([^;]+)/i)?.[1]?.trim() ?? el.getAttribute("stroke") ?? null;
  return {
    width: sw ? parseFloat(sw[1]) : el.getAttribute("stroke-width") ? parseFloat(el.getAttribute("stroke-width")!) : null,
    dash: dash ? dash[1].trim() : el.getAttribute("stroke-dasharray"),
    hasStroke: stroke != null && stroke !== "none",
  };
}

/** Counter-scale pt-true content inside an inlined plot instance. Runs on the
 *  per-placement CLONE, after applyOverrides, before insertion/serialization. */
export function compensatePtTrue(inst: Element, o: CompensateOpts): void {
  const { w: nW, h: nH } = o.intrinsic ?? svgIntrinsicPx(inst);
  if (!nW || !nH) return;
  const visW = o.crop?.width ?? nW;
  const visH = o.crop?.height ?? nH;
  const cs = o.contentScale ?? 1;
  const clamp = (v: number) => Math.min(100, Math.max(0.01, v));
  const fx = clamp((visW / Math.max(o.elW, 0.01)) * cs);
  const fy = clamp((visH / Math.max(o.elH, 0.01)) * cs);
  if (near(fx, 1) && near(fy, 1)) return; // true size → output untouched
  const fs = Math.sqrt(fx * fy); // scalar stroke factor (exact under uniform resize)

  const prependAnchored = (el: Element, ax: number, ay: number) => {
    const C =
      ax || ay ? `translate(${ax} ${ay}) scale(${fx} ${fy}) translate(${-ax} ${-ay})` : `scale(${fx} ${fy})`;
    const orig = el.getAttribute("transform") ?? "";
    el.setAttribute("transform", [C, orig].filter(Boolean).join(" "));
  };

  const walk = (el: Element, underCompensated: boolean) => {
    const tag = el.tagName?.toLowerCase() ?? "";
    if (SKIP_SUBTREES.has(tag) && el !== inst) return; // nested <svg> = alien unit space
    if (insideDefs(el)) return;

    if (tag === "text") {
      // Anchor = the text's own x/y (matplotlib's rotate() pivots there too).
      const ax = parseFloat(el.getAttribute("x") ?? "0") || 0;
      const ay = parseFloat(el.getAttribute("y") ?? "0") || 0;
      prependAnchored(el, ax, ay);
      return; // descendants (tspans) ride the transform
    }
    if (el.getAttribute("data-flux-glyph") === "1") {
      // Inlined tick/marker glyph: geometry drawn about its translate anchor —
      // APPEND the scale so it applies to the glyph-local coordinates.
      const orig = el.getAttribute("transform") ?? "";
      el.setAttribute("transform", [orig, `scale(${fx} ${fy})`].filter(Boolean).join(" "));
      // Its stroke scales with the appended transform — already pt-true.
      return;
    }
    if (tag === "use") {
      // A <use> that survived normalization (non-defs reference): same anchor
      // treatment as glyphs, about its x/y.
      const ax = parseFloat(el.getAttribute("x") ?? "0") || 0;
      const ay = parseFloat(el.getAttribute("y") ?? "0") || 0;
      prependAnchored(el, ax, ay);
      return;
    }

    if (!underCompensated && STROKABLE.has(tag)) {
      const d = declaredStrokeProps(el);
      if (d.hasStroke || d.width != null) {
        const w = d.width ?? 1;
        (el as SVGElement).style.strokeWidth = String(w * fs);
      }
      if (d.dash && d.dash !== "none") {
        const scaled = d.dash
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((n) => String(parseFloat(n) * fs))
          .join(" ");
        (el as SVGElement).style.strokeDasharray = scaled;
      }
    }

    for (const c of Array.from(el.children ?? [])) walk(c as Element, underCompensated);
  };

  for (const c of Array.from(inst.children ?? [])) walk(c as Element, false);
}
