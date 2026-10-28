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

import { parseColor } from "../color/interp";

/** An opaque matte INSIDE the canvas host's paint context. Transparent hosts
 * may use solid ancestor backgrounds; gradients/images/filters remain live. */
export function snapshotMatte(host: HTMLElement): string | null {
  const colors: string[] = [];
  let foundOpaque = false;
  for (let node: HTMLElement | null = host, depth = 0; node && depth < 32; node = node.parentElement, depth++) {
    const style = getComputedStyle(node), color = parseColor(style.backgroundColor);
    if (!color || (style.backgroundImage || "none") !== "none") return null;
    colors.push(style.backgroundColor);
    if (color.a === 1) { foundOpaque = true; break; }
    if ((style.filter || "none") !== "none" || (style.backdropFilter || "none") !== "none" || (style.mixBlendMode || "normal") !== "normal") return null;
  }
  if (!foundOpaque) return null;
  if (colors.length === 1) return colors[0];
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  for (const color of colors.reverse()) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
  const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
  canvas.width = canvas.height = 0;
  return alpha === 255 ? `rgb(${r}, ${g}, ${b})` : null;
}

export interface WorldBox {
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

/** A raster placed in world space: image-local (u, v) is world (bx + u·bw/w, by + v·bh/h). */
export interface ProxyRaster {
  /** The bitmap itself (a 2D canvas the SVG snapshot was drawn into once). */
  canvas: HTMLCanvasElement;
  bx: number;
  by: number;
  bw: number;
  bh: number;
  w: number;
  h: number;
}

export interface ZoomSnapshot {
  /** Everything that changes what the mounted scene looks like (not the viewport). */
  sceneKey: string;
  /** Serial of this capture (exposed as data-snap; a retake changes it). */
  gen: number;
  canvas: HTMLCanvasElement;
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
  /** The WHOLE mounted scene at a low raster scale, drawn behind the sharp
   *  region. A zoom-out that leaves the sharp box (zoomed in, 2× out) is still
   *  covered — and a zoom-out is exactly when a coarse raster is enough. */
  coarse?: ProxyRaster | null;
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

/** The coarse backing raster's budget (CSS px², before device scale): the
 *  whole mounted scene at the scale where it would fill ~1 MP. */
export const SNAPSHOT_COARSE_PIXELS = 1_000_000;
/** Image px per world unit for the coarse whole-scene raster, or null when the
 *  sharp region already holds the whole scene at a comparable scale. */
export function coarseScale(scene: WorldBox, sharp: WorldBox, sharpS: number, dpr = 1): number | null {
  if (!(scene.bw > 0) || !(scene.bh > 0)) return null;
  const covered = sharp.bx <= scene.bx + 0.5 && sharp.by <= scene.by + 0.5 &&
    sharp.bx + sharp.bw >= scene.bx + scene.bw - 0.5 && sharp.by + sharp.bh >= scene.by + scene.bh - 0.5;
  if (covered) return null; // the sharp image IS the whole scene
  const S = Math.min(sharpS, SNAPSHOT_MAX_SIDE / (scene.bw * dpr), SNAPSHOT_MAX_SIDE / (scene.bh * dpr), Math.sqrt(SNAPSHOT_COARSE_PIXELS / (scene.bw * scene.bh)) / dpr);
  return S > 0.005 ? S : null;
}

/** Does the viewport's scene part lie inside the sharp raster or, failing that, the coarse one? */
export function proxyCovers(snap: ZoomSnapshot, scene: WorldBox, view: { panX: number; panY: number; zoom: number; hostW: number; hostH: number }): boolean {
  return snapshotCovers(snap, scene, view) || (!!snap.coarse && snapshotCovers(snap.coarse, scene, view));
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
  // macOS font smoothing is inherited by the live SVG, but an SVG image has
  // its own document. Preserve it too so zooming does not change glyph weight.
  for (const p of ["font-family", "font-size", "font-weight", "font-style", "color", "letter-spacing", "text-rendering", "-webkit-font-smoothing"]) {
    (root as SVGElement | null)?.style.setProperty(p, inherited.getPropertyValue(p));
  }
  const style = fontCss ? `<style>${fontCss}</style>` : "";
  // innerHTML is the HTML fragment serializer even for SVG content: it writes
  // U+00A0 as `&nbsp;`, an entity XML does not define, and the image decoder
  // then rejects the WHOLE snapshot (every matplotlib label with a no-break
  // space → no proxy, every zoom live; 2026-09-30). `&nbsp;` is the only
  // non-XML entity that serializer emits (&amp; &lt; &gt; &quot; are XML's own),
  // and a literal "&nbsp;" in text serializes as "&amp;nbsp;", so this is exact.
  const body = clone.innerHTML.replace(/&nbsp;/g, "&#160;");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" ` +
    `viewBox="${box.bx} ${box.by} ${box.bw} ${box.bh}" preserveAspectRatio="none">${style}${body}</svg>`;
  return { svg, w, h };
}

export interface SnapshotSerializationOptions {
  /** Capture ownership is checked again after every cooperative yield. */
  current: () => boolean;
  yield?: () => Promise<void>;
  budgetMs?: number;
  maxNodes?: number;
  maxChars?: number;
  /** Bounded detached markup prepared by the shared renderer for culled art. */
  before?: ReadonlyMap<Node, string>;
  after?: ReadonlyMap<Node, string>;
  append?: ReadonlyMap<Node, string>;
}

/** Prepare a dense scene without one deep clone or one whole-tree serializer call.
 * Each shallow node retains XML namespaces/escaping through XMLSerializer. Only
 * component-owned styles need computed-style reads; plot attributes stay authored.
 * The caller may retire the capture between slices without ever touching live DOM. */
export async function serializeSceneSnapshotCooperative(
  sceneSvg: SVGSVGElement, box: WorldBox, S: number, options: SnapshotSerializationOptions,
): Promise<{ svg: string; w: number; h: number } | null> {
  if (!options.current() || !sceneSvg.isConnected) return null;
  const yieldWork = options.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const budget = Math.max(1, Math.min(12, options.budgetMs ?? 6));
  // Includes whitespace/comment nodes as well as the renderer's bounded
  // 150k drawable-element residency; source SVG indentation is not artwork.
  const maxNodes = options.maxNodes ?? 450_000;
  const maxChars = options.maxChars ?? 64 * 1024 * 1024;
  const serializer = new XMLSerializer();
  const styled = new Set(STYLED_CLASSES);
  const root = sceneSvg.firstElementChild;
  const inherited = getComputedStyle(sceneSvg);
  const inheritance = ["font-family", "font-size", "font-weight", "font-style", "color", "letter-spacing", "text-rendering", "-webkit-font-smoothing"]
    .map(key => [key, inherited.getPropertyValue(key)] as const);
  const parts: string[] = [];
  type Work = { node: Node } | { close: string; node: Node };
  const stack: Work[] = [];
  for (let n = sceneSvg.lastChild; n; n = n.previousSibling) stack.push({ node: n });
  let nodes = 0, chars = 0, slice = performance.now();
  const append = (text: string) => { chars += text.length; parts.push(text); return chars <= maxChars; };
  while (stack.length) {
    if (!options.current() || !sceneSvg.isConnected) return null;
    const work = stack.pop()!;
    if ("close" in work) {
      if (!append(options.append?.get(work.node) ?? "") || !append(work.close) || !append(options.after?.get(work.node) ?? "")) return null;
    } else {
      const node = work.node;
      if (++nodes > maxNodes) return null;
      if (!append(options.before?.get(node) ?? "")) return null;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const live = node as SVGElement, copy = live.cloneNode(false) as SVGElement;
        if ([...live.classList].some(cls => styled.has(cls))) {
          const style = getComputedStyle(live);
          for (const key of INLINE_PROPS) {
            const value = style.getPropertyValue(key);
            if (value) copy.style.setProperty(key, value);
          }
        }
        // Resolve the browser's font cascade once while preparing the capture.
        // A child rasterizer must not infer an unrelated plot's italic CSS from
        // a frame label's family, or silently substitute an unsupported face.
        if (["text", "tspan", "textPath"].includes(live.localName)) {
          const style = getComputedStyle(live);
          for (const key of ["font-family", "font-size", "font-weight", "font-style"])
            copy.style.setProperty(key, style.getPropertyValue(key));
        }
        if (node === root) {
          copy.removeAttribute("transform");
          for (const [key, value] of inheritance) copy.style.setProperty(key, value);
        }
        let shallow = serializer.serializeToString(copy);
        if (live.namespaceURI === "http://www.w3.org/2000/svg" &&
          (!live.parentElement || live.parentNode === sceneSvg || live.parentElement.namespaceURI === live.namespaceURI))
          shallow = shallow.replace(' xmlns="http://www.w3.org/2000/svg"', "");
        if (!node.firstChild && !options.append?.has(node)) {
          if (!append(shallow) || !append(options.after?.get(node) ?? "")) return null;
        } else {
          // XMLSerializer emits an empty XML element for a shallow SVG clone.
          // HTML foreignObject descendants may instead have an explicit end tag.
          const name = /^<([^\s/>]+)/.exec(shallow)?.[1];
          if (!name) return null;
          const close = `</${name}>`;
          const open = shallow.endsWith("/>") ? shallow.slice(0, -2) + ">"
            : shallow.endsWith(close) ? shallow.slice(0, -close.length) : null;
          if (open === null || !append(open)) return null;
          stack.push({ close, node });
          for (let n = node.lastChild; n; n = n.previousSibling) stack.push({ node: n });
        }
      } else if (!append(serializer.serializeToString(node)) || !append(options.after?.get(node) ?? "")) return null;
    }
    if (performance.now() - slice >= budget && stack.length) {
      await yieldWork();
      slice = performance.now();
    }
  }
  if (!options.current() || !sceneSvg.isConnected) return null;
  const w = Math.max(1, Math.floor(box.bw * S)), h = Math.max(1, Math.floor(box.bh * S));
  const body = parts.join("");
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="${box.bx} ${box.by} ${box.bw} ${box.bh}" preserveAspectRatio="none">${body}</svg>`,
    w, h,
  };
}

/** The proxy image's transform for the live viewport: image-local (u, v) is world
 *  (bx + u/S, by + v/S), and a world point lands on screen at pan + zoom·world. */
export function proxyTransform(snap: ProxyRaster, panX: number, panY: number, zoom: number): string {
  // Raster dimensions are integral. Use both actual axes, not the requested
  // scale, or rounding introduces an aspect/position jump at the swap.
  return `translate3d(${panX + zoom * snap.bx}px, ${panY + zoom * snap.by}px, 0) scale(${zoom * snap.bw / snap.w}, ${zoom * snap.bh / snap.h})`;
}

export { svgFontCss as snapshotFontCss } from "../svgFonts";
