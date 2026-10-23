// ---------------------------------------------------------------------------
// Flux Slide — the `encircle` overlay (T6): manim's Circumscribe. A MorphController in the
// stage-space FLIGHT layer (`RenderedSlide.flight`, inside the camera): a pure function of
// (eased progress, raw progress), hidden at raw <= 0 and >= 1, so a seek, a static export, a video
// frame and the exported HTML player all show the same thing (nothing) outside the effect.
// The band is T3's `traceDash`/`passingFlash` on a pathLength=1000 rounded rect.
// ---------------------------------------------------------------------------
import type { MorphController } from "../../plot/project";
import { traceDash, passingFlash } from "./trim";
import type { EncircleShape, EncircleParams } from "../encircleGeometry";
import type { Rect } from "../../geometry";

const NS = "http://www.w3.org/2000/svg";
export interface OverlayHandle { anchor: SVGGElement; controller: MorphController }
const PL = 1000;

export function createEncircle(flight: SVGSVGElement, shape: EncircleShape, color: string, p: EncircleParams): OverlayHandle {
  const anchor = document.createElementNS(NS, "g");
  anchor.setAttribute("class", "sl-fx");
  (anchor as unknown as HTMLElement).style.display = "none";
  if (shape.rotation) anchor.setAttribute("transform", `rotate(${shape.rotation} ${shape.cx} ${shape.cy})`);
  const rect = document.createElementNS(NS, "rect") as unknown as HTMLElement;
  for (const [k, v] of Object.entries({ x: shape.x, y: shape.y, width: shape.w, height: shape.h, rx: shape.radius, ry: shape.radius, pathLength: PL, fill: "none", stroke: color, "stroke-width": p.width, "stroke-linecap": "butt" })) rect.setAttribute(k, String(v));
  anchor.appendChild(rect);
  flight.appendChild(anchor);
  const spec = { len: PL, closed: false };
  return { anchor, controller: {
    seek(u, raw = u) {
      const st = (anchor as unknown as HTMLElement).style;
      if (raw <= 0 || raw >= 1) { st.display = "none"; return; }
      const { tail, head } = passingFlash(p.window, Math.max(0, Math.min(1, u)));
      const d = traceDash(spec, tail, head);
      if (!d) { st.display = "none"; return; }
      st.display = "";
      rect.style.strokeDasharray = d.strokeDasharray;
      rect.style.strokeDashoffset = String(d.strokeDashoffset);
    },
    dispose() { anchor.remove(); },
  } };
}

/** Text ink extent in the element's UNROTATED local frame (stage units), or undefined. Measured on a hidden
 *  CLONE of the wrapper in the camera layer, so the answer never depends on the animation state of the live node
 *  (a text mid-scaleIn measures the same as at rest). `k` = the host's CSS scale, read off the clone itself. */
export function measureTextInk(wrap: HTMLElement, box: { w: number; h: number }, host: HTMLElement): Rect | undefined {
  if (!(box.w > 0 && box.h > 0) || typeof document.createRange !== "function") return undefined;
  const probe = wrap.cloneNode(true) as HTMLElement;
  probe.removeAttribute("id");
  const s = probe.style;
  s.position = "absolute"; s.left = "0"; s.top = "0"; s.width = `${box.w}px`; s.height = `${box.h}px`;
  s.transform = "none"; s.opacity = "1"; s.visibility = "hidden"; s.pointerEvents = "none"; s.clipPath = "none";
  for (const n of Array.from(probe.querySelectorAll<HTMLElement>("*"))) {
    if (n.classList?.contains("sl-effects")) { n.style.transform = "none"; n.style.opacity = "1"; n.style.clipPath = "none"; }
  }
  host.appendChild(probe);
  try {
    const pr = probe.getBoundingClientRect(), k = pr.width / box.w;
    if (!(k > 0) || !Number.isFinite(k)) return undefined;
    // TEXT NODES only: selectNodeContents(probe) would also return the box of every element fully inside the range
    // (the <svg> a text element renders into = the whole 500-unit box, exactly what we are trying not to circle).
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.textContent ?? "").trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) rects.push(r);
    }
    if (!rects.length) return undefined;
    const x0 = Math.min(...rects.map(r => r.left)), y0 = Math.min(...rects.map(r => r.top));
    const x1 = Math.max(...rects.map(r => r.right)), y1 = Math.max(...rects.map(r => r.bottom));
    return { x: (x0 - pr.left) / k, y: (y0 - pr.top) / k, w: (x1 - x0) / k, h: (y1 - y0) / k };
  } finally { probe.remove(); }
}
