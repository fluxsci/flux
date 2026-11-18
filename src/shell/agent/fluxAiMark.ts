// The Flux AI mark: the 13-dot seed of the Flux bloom (Logomark.svelte), top-left of every
// agent surface (Ask, Annotate, Inbox), always turning. One description of it here, because
// Ask's synchronous bootstrap builds its header by hand before any component has loaded and
// the lazy surface that adopts it must draw the same thing (FluxAiMark.svelte renders this
// list; `fluxAiMarkElement` builds the same SVG without a component). The look and the turn
// are global CSS (app.css, .flux-ai-mark) for the same reason.
//
// TONE is what the colour says:
//   ready  the bloom's own colours: nothing is running
//   live   blue, and a faster turn: an agent is working, or will pick this up as you send it
//   wait   the annotation gold: something is waiting for you
//   done   green: finished
//   error  red
import { logoDots } from "../logoDots";

export type FluxAiTone = "ready" | "live" | "wait" | "done" | "error";
export interface FluxAiDot { cx: number; cy: number; r: number; fill: string; /** 1 at the centre, fading outward: the tinted tones keep the seed's depth. */ o: number }

const SEED = logoDots().slice(0, 13);
export const FLUX_AI_DOTS: FluxAiDot[] = SEED.map((d, i) => ({ cx: d.x, cy: d.y, r: +(d.r * 1.15).toFixed(3), fill: d.fill, o: +(1 - (i / (SEED.length - 1)) * 0.5).toFixed(2) }));
export const FLUX_AI_VIEWBOX = "34 34 32 32";

/** The mark as plain DOM, for code that runs before any component is available. */
export function fluxAiMarkElement(doc: Document, size = 16, tone: FluxAiTone = "ready"): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("class", "flux-ai-mark");
  svg.setAttribute("data-tone", tone);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", FLUX_AI_VIEWBOX);
  svg.setAttribute("aria-hidden", "true");
  for (const dot of FLUX_AI_DOTS) {
    const circle = doc.createElementNS(NS, "circle");
    circle.setAttribute("cx", String(dot.cx));
    circle.setAttribute("cy", String(dot.cy));
    circle.setAttribute("r", String(dot.r));
    circle.setAttribute("fill", dot.fill);
    circle.style.setProperty("--o", String(dot.o));
    svg.append(circle);
  }
  return svg;
}
