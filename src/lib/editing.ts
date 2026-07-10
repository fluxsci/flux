import type { CropRect, Element } from "./types";
import type { DrawStyle, Tool } from "./store";
import { newId } from "./ids";
import { elementBBox, rotatePoint, type Rect } from "./geometry";
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

// ---------------------------------------------------------------------------
// Crop (figure-v1 P5) — ctrl/meta-drag on a resize handle crops an image/plot
// exactly like Figma: the dragged edge moves the element BOX, and the crop
// window follows so the content stays PINNED on the canvas. Pure per-frame
// math; the gesture commits the result once on pointer-up (ops.setCrop).
// ---------------------------------------------------------------------------

export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface CropMods {
  /** Shift — the box keeps its original aspect ratio (computeResizeBox rules). */
  shift?: boolean;
  /** Alt — edges move symmetrically about the box centre. */
  alt?: boolean;
}

/** The one-commit result: the element's new box + its crop window (intrinsic
 *  content px, assetDisplaySize units). */
export interface CropRemapResult {
  x: number;
  y: number;
  width: number;
  height: number;
  crop: CropRect;
}

/**
 * Per-frame crop math. `orig` is the element as it was at pointer-down (the
 * gesture snapshot — NEVER the live element), `localPt` the pointer in
 * figure-local coords, `disp` the intrinsic content size in CSS px
 * (ops.assetDisplaySize — passed in so this module stays a pure leaf).
 *
 * Invariant: the content→canvas mapping is held FIXED for the whole gesture,
 * so the content stays pinned while the window moves. Unflipped, content
 * pixel u renders at Ox + u·kx (kx = orig.width / cropW0, Ox = orig.x −
 * crop0.x·kx). A flip mirrors the mapping about the box — flipX means
 * screenX(u) = Sx − u·kx with Sx = (orig.x + orig.width) + crop0.x·kx. The
 * dragged edge moves the BOX (which follows the pointer directly — a flip
 * maps the box onto itself, so box edges never remap); the crop window is the
 * box read back through the fixed (flip-aware) mapping. That read-back IS the
 * plan's "flip remaps handle roles": cropping from the visually-right edge of
 * a flipX'd element eats the LOW-content-x side.
 *
 * Rotation: the pointer is inverse-rotated into the unrotated local frame
 * about the bbox centre (the element's render pivot; flip needs no pointer
 * un-mirroring for the reason above). Clamps: the window never leaves the
 * content ([0,disp]) and never collapses below max(1 intrinsic px, 1 canvas
 * px). NO grid/pixel snapping — ever.
 */
export function cropRemap(
  orig: Element,
  handle: CropHandle,
  localPt: Pt,
  mods: CropMods,
  disp: { width: number; height: number },
): CropRemapResult | null {
  if (orig.type !== "image" && orig.type !== "plot") return null;
  const dispW = disp.width;
  const dispH = disp.height;
  if (!(dispW > 0) || !(dispH > 0) || !(orig.width > 0) || !(orig.height > 0)) return null;
  const crop0: CropRect = orig.crop ?? { x: 0, y: 0, width: dispW, height: dispH };
  if (!(crop0.width > 0) || !(crop0.height > 0)) return null;

  // The fixed content→canvas mapping (per axis, flip-aware).
  const kx = orig.width / crop0.width;
  const ky = orig.height / crop0.height;
  const Ox = orig.x - crop0.x * kx; // unflipped content origin on canvas
  const Oy = orig.y - crop0.y * ky;
  const Sx = orig.x + orig.width + crop0.x * kx; // flipped-mapping anchor
  const Sy = orig.y + orig.height + crop0.y * ky;

  // Pointer → the unrotated local frame, about the current bbox centre.
  const cx = orig.x + orig.width / 2;
  const cy = orig.y + orig.height / 2;
  let p: Pt = { x: localPt.x, y: localPt.y };
  if (orig.rotation) p = rotatePoint(p, { x: cx, y: cy }, -orig.rotation);

  const hx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const hy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;

  // Drag the edges (Alt mirrors the moved edge about the centre).
  let L = orig.x;
  let R = orig.x + orig.width;
  let T = orig.y;
  let B = orig.y + orig.height;
  if (hx === 1) R = p.x;
  else if (hx === -1) L = p.x;
  if (hy === 1) B = p.y;
  else if (hy === -1) T = p.y;
  if (mods.alt) {
    if (hx === 1) L = 2 * cx - R;
    else if (hx === -1) R = 2 * cx - L;
    if (hy === 1) T = 2 * cy - B;
    else if (hy === -1) B = 2 * cy - T;
  }

  // Shift: keep the ORIGINAL box aspect (same rule as computeResizeBox — the
  // dominant ratio wins; min-edges re-anchor at their opposite edge, or about
  // the centre with Alt). Clamping below may break the aspect at the content
  // bounds — accepted (matches resize-at-min behavior).
  if (mods.shift) {
    const s = Math.max((R - L) / orig.width, (B - T) / orig.height);
    const w = orig.width * s;
    const h = orig.height * s;
    if (mods.alt) {
      L = cx - w / 2;
      R = cx + w / 2;
      T = cy - h / 2;
      B = cy + h / 2;
    } else {
      if (hx === -1) L = R - w;
      else R = L + w;
      if (hy === -1) T = B - h;
      else B = T + h;
    }
  }

  // Clamp: the window may never leave the content (bounds mirror with flip)...
  const CL = orig.flipX ? Sx - dispW * kx : Ox;
  const CR = orig.flipX ? Sx : Ox + dispW * kx;
  const CT = orig.flipY ? Sy - dispH * ky : Oy;
  const CB = orig.flipY ? Sy : Oy + dispH * ky;
  L = Math.min(Math.max(L, CL), CR);
  R = Math.min(Math.max(R, CL), CR);
  T = Math.min(Math.max(T, CT), CB);
  B = Math.min(Math.max(B, CT), CB);
  // ...nor collapse below max(1 intrinsic px, 1 canvas px). The MOVED edge
  // yields (Alt: both edges yield symmetrically, re-clamped into the content).
  const minW = Math.max(kx, 1);
  const minH = Math.max(ky, 1);
  if (R - L < minW) {
    if (mods.alt && hx !== 0) {
      const c = (L + R) / 2;
      L = Math.min(Math.max(c - minW / 2, CL), CR - minW);
      R = L + minW;
    } else if (hx === -1) L = Math.max(R - minW, CL);
    else R = Math.min(L + minW, CR);
    if (R - L < minW) {
      // pinned against a content edge — push the other edge out
      if (R >= CR) L = R - minW;
      else R = L + minW;
    }
  }
  if (B - T < minH) {
    if (mods.alt && hy !== 0) {
      const c = (T + B) / 2;
      T = Math.min(Math.max(c - minH / 2, CT), CB - minH);
      B = T + minH;
    } else if (hy === -1) T = Math.max(B - minH, CT);
    else B = Math.min(T + minH, CB);
    if (B - T < minH) {
      if (B >= CB) T = B - minH;
      else B = T + minH;
    }
  }

  // Read the crop back through the fixed mapping (flip mirrors which content
  // edge each box edge shows) + FP-noise clamp so the stored window is EXACTLY
  // inside [0,disp].
  const cw = Math.min((R - L) / kx, dispW);
  const ch = Math.min((B - T) / ky, dispH);
  const rawCx = orig.flipX ? (Sx - R) / kx : (L - Ox) / kx;
  const rawCy = orig.flipY ? (Sy - B) / ky : (T - Oy) / ky;
  const cxp = Math.min(Math.max(rawCx, 0), dispW - cw);
  const cyp = Math.min(Math.max(rawCy, 0), dispH - ch);
  return {
    x: L,
    y: T,
    width: R - L,
    height: B - T,
    crop: { x: cxp, y: cyp, width: cw, height: ch },
  };
}

// Proportional SCALE remap (Feature 5, the K tool): like resizeRemap, but also
// multiplies the "weight" properties — strokeWidth, cornerRadius, fontSize (the
// EXPLICIT geometric scaler; plain resize never touches fonts) — and a plot
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
  if (e.type === "plot" && orig.type === "plot") {
    e.contentScale = Math.max(0.01, (orig.contentScale ?? 1) * s);
  }
}

/** Figma-parity endpoint pivot: move ONE endpoint of a line to `to` (figure-
 *  local) while the other stays FIXED. Shift constrains the moving endpoint to
 *  45° steps ABOUT THE FIXED ONE. Rotation/flip must already be baked into the
 *  two points (grab-time world endpoints — geometry.lineWorldEndpoints); the
 *  result is normalized the way the model stores lines anyway: origin =
 *  endpoint 1, x1/y1 = 0, rotation 0 (resizeRemap's line shape). */
export function lineEndpointRemap(
  e: Element,
  which: 1 | 2,
  fixed: Pt,
  to: Pt,
  shift = false,
): void {
  if (e.type !== "line") return;
  let mx = to.x;
  let my = to.y;
  if (shift) {
    const { dx, dy } = constrain45(mx - fixed.x, my - fixed.y);
    mx = fixed.x + dx;
    my = fixed.y + dy;
  }
  const p1 = which === 1 ? { x: mx, y: my } : fixed;
  const p2 = which === 2 ? { x: mx, y: my } : fixed;
  e.x = p1.x;
  e.y = p1.y;
  e.x1 = 0;
  e.y1 = 0;
  e.x2 = p2.x - p1.x;
  e.y2 = p2.y - p1.y;
  e.width = 0;
  e.height = 0;
  e.rotation = 0;
  delete e.flipX;
  delete e.flipY;
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
