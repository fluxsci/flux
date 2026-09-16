// The zoom proxy — a compositor-only zoom gesture for a DOM/SVG scene.
//
// Blink relayouts and repaints every SVG <text> whenever an ancestor's scale
// changes, so a live ctrl-wheel zoom over a dense figure costs ~20 ms of main
// thread per tick (30 fps, folds and blur→sharp pops mid-gesture; measured
// 2026-09-16). Figma-style answer: while a zoom burst is live, the user looks
// at a RASTER of the scene taken at rest, scaled by the compositor; the live
// scene is frozen (no transform writes → no relayout) and hidden; at the
// settle fold the live scene repaints once at the new baked zoom and swaps back.
// This module holds the pure parts: serializing the scene into a standalone SVG
// image (the snapshot) and the transform that keeps the snapshot glued to the
// live viewport. Canvas.svelte owns the lifecycle.

export interface WorldBox {
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

export interface ZoomSnapshot {
  /** Everything that changes what the mounted scene looks like (not the viewport). */
  sceneKey: string;
  url: string;
  /** World box the image covers and the raster scale it was drawn at (image px per world unit). */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  S: number;
  /** View zoom at capture; S may be lower because of the physical pixel cap. */
  captureZoom: number;
  w: number;
  h: number;
}

// Canvas-owned classes inside the scene svg whose look comes from the component
// stylesheet. Everything else in the scene (elements, plots) is attribute-styled,
// so a serialized copy renders identically once these are inlined from the live
// computed style.
const STYLED_CLASSES = ["fig-shadow", "figure-bg", "figure-label", "empty-hint", "figure-titlebar", "editing-hidden", "grid"];
const INLINE_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "filter", "visibility", "display", "vector-effect", "stroke-dasharray", "stroke-linecap", "stroke-linejoin"];

/** Largest snapshot we draw: beyond this the proxy's promoted layer would eat
 *  the tile budget the live scene needs (a 5,000-element figure's 8 MP proxy
 *  cost ~30 ms per key-to-paint in production, 2026-09-16). The raster scale
 *  drops to fit; a box that cannot fit at all yields no snapshot (the gesture
 *  then runs live, as before). */
export const SNAPSHOT_MAX_SIDE = 4096;
export const SNAPSHOT_MAX_PIXELS = 3_000_000;
/** The snapshot covers the visible world plus this fraction of the host per
 *  side — pans inside it keep the snapshot, larger ones re-key it once quiet. */
export const SNAPSHOT_MARGIN = 0.5;

/** The world rectangle a snapshot should cover: the mounted scene's box clipped
 *  to the host viewport grown by the margin (in world units at `zoom`). */
export function snapshotRegion(scene: WorldBox, view: { panX: number; panY: number; zoom: number; hostW: number; hostH: number }): WorldBox | null {
  const mw = view.hostW * SNAPSHOT_MARGIN;
  const mh = view.hostH * SNAPSHOT_MARGIN;
  const vx = (-view.panX - mw) / view.zoom;
  const vy = (-view.panY - mh) / view.zoom;
  const vw = (view.hostW + 2 * mw) / view.zoom;
  const vh = (view.hostH + 2 * mh) / view.zoom;
  const x0 = Math.max(scene.bx, vx);
  const y0 = Math.max(scene.by, vy);
  const x1 = Math.min(scene.bx + scene.bw, vx + vw);
  const y1 = Math.min(scene.by + scene.bh, vy + vh);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { bx: x0, by: y0, bw: x1 - x0, bh: y1 - y0 };
}

/** Does the host viewport (world units at `zoom`) lie inside the snapshot's box? */
export function snapshotCovers(snap: { bx: number; by: number; bw: number; bh: number }, scene: WorldBox, view: { panX: number; panY: number; zoom: number; hostW: number; hostH: number }): boolean {
  // Only the part of the viewport that the scene itself occupies needs cover.
  const vx = Math.max(scene.bx, -view.panX / view.zoom);
  const vy = Math.max(scene.by, -view.panY / view.zoom);
  const vx1 = Math.min(scene.bx + scene.bw, (-view.panX + view.hostW) / view.zoom);
  const vy1 = Math.min(scene.by + scene.bh, (-view.panY + view.hostH) / view.zoom);
  if (!(vx1 > vx) || !(vy1 > vy)) return true; // nothing of the scene is in view
  const eps = 0.5;
  return vx >= snap.bx - eps && vy >= snap.by - eps && vx1 <= snap.bx + snap.bw + eps && vy1 <= snap.by + snap.bh + eps;
}

/** Pick the image px per world unit for a snapshot of `box`: the live baked zoom
 *  (so the proxy is pixel-true at the rest zoom), shrunk to the caps. */
export function snapshotScale(box: WorldBox, renderZoom: number, dpr = 1): number | null {
  if (!(box.bw > 0) || !(box.bh > 0)) return null;
  let S = renderZoom;
  S = Math.min(S, SNAPSHOT_MAX_SIDE / (box.bw * dpr), SNAPSHOT_MAX_SIDE / (box.bh * dpr), Math.sqrt(SNAPSHOT_MAX_PIXELS / (box.bw * box.bh)) / dpr);
  return S > 0.01 ? S : null;
}

/** Serialize the live scene svg into a standalone image of `box` (WORLD units)
 *  at `S` image px per unit. The scene's baked <g scale(renderZoom)> is undone:
 *  the viewBox does the mapping, so the snapshot is independent of the live
 *  render zoom and of the viewport — it survives pans and folds. `fontCss` is
 *  prepended in a <style> (webfonts the live document loads but an image cannot). */
export function serializeSceneSnapshot(sceneSvg: SVGSVGElement, box: WorldBox, S: number, fontCss = ""): { svg: string; w: number; h: number } {
  const clone = sceneSvg.cloneNode(true) as SVGSVGElement;
  // Inline the component-styled nodes from their live twins (same document order).
  for (const cls of STYLED_CLASSES) {
    const live = sceneSvg.getElementsByClassName(cls);
    const copy = clone.getElementsByClassName(cls);
    for (let i = 0; i < live.length && i < copy.length; i++) {
      const cs = getComputedStyle(live[i]);
      for (const p of INLINE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v) (copy[i] as SVGElement).style.setProperty(p, v);
      }
    }
  }
  const root = clone.firstElementChild;
  if (root) root.removeAttribute("transform"); // world units: the viewBox maps them
  const w = Math.max(1, Math.floor(box.bw * S));
  const h = Math.max(1, Math.floor(box.bh * S));
  // The scene inherits UI fonts/colour from the document. A standalone image
  // does not; carry the computed root inheritance without visiting plot nodes.
  const inherited = getComputedStyle(sceneSvg);
  for (const p of ["font-family", "font-size", "font-weight", "font-style", "color", "letter-spacing", "text-rendering"]) {
    (root as SVGElement | null)?.style.setProperty(p, inherited.getPropertyValue(p));
  }
  const style = fontCss ? `<style>${fontCss}</style>` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" ` +
    `viewBox="${box.bx} ${box.by} ${box.bw} ${box.bh}" preserveAspectRatio="none">${style}${clone.innerHTML}</svg>`;
  return { svg, w, h };
}

/** The proxy image's transform for the live viewport: image-local (u, v) is world
 *  (bx + u/S, by + v/S), and a world point lands on screen at pan + zoom·world. */
export function proxyTransform(snap: ZoomSnapshot, panX: number, panY: number, zoom: number): string {
  // Raster dimensions are integral. Use both actual axes, not the requested
  // scale, or rounding introduces an aspect/position jump at the swap.
  return `translate3d(${panX + zoom * snap.bx}px, ${panY + zoom * snap.by}px, 0) scale(${zoom * snap.bw / snap.w}, ${zoom * snap.bh / snap.h})`;
}

export { svgFontCss as snapshotFontCss } from "../svgFonts";
