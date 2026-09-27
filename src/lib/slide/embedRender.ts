import type { Deck } from "./types";
import type { ExportPayload } from "./payload";
import type { Figure } from "../types";
import { preparePlot } from "../plot/parse";
import { buildPlotMarkup } from "../plot/inlineMarkup";
import { figureToSvg } from "../export";
import { compileSlide } from "./compile";
import { resolveTheme } from "./theme";
import type { PlayerOpts } from "./player/player";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
export const serializeSvg = (node: globalThis.Element): string => typeof XMLSerializer !== "undefined" ? new XMLSerializer().serializeToString(node) : String(node);
const prepared = new WeakMap<ExportPayload, Map<string, SVGSVGElement>>();
/** No authoring cache writes; pristine roots are shared only by this immutable payload. */
export function embedPlayerOptions(payload: ExportPayload): PlayerOpts {
  let roots = prepared.get(payload);
  if (!roots) {
    roots = new Map();
    for (const [id, plot] of Object.entries(payload.plots ?? {})) {
      const root = preparePlot(plot.svg, plot.manifest).root;
      if (root) roots.set(id, root as unknown as SVGSVGElement);
    }
    prepared.set(payload, roots);
  }
  return { theme: resolveTheme(payload.deck.theme), mode: "export", manualSteps: true, reducedMotion: false,
    plotRoot: id => roots.get(id), plotManifest: id => payload.plots?.[id]?.manifest,
    assetUrl: id => payload.videos?.[id] ?? payload.assets?.[id], assetSize: id => payload.assetSizes?.[id] };
}
/** Namespace an ephemeral rendering copy. Canonical IDs and bytes are untouched. */
export function namespaceEmbedDeck(deck: Deck, prefix: string): Deck {
  const copy = structuredClone(deck);
  for (const slide of copy.slides) {
    const ids = new Map(slide.elements.map(e => [e.id, `${prefix}-${e.id}`]));
    const groups = new Map(Object.keys(slide.groups ?? {}).map(id => [id, `${prefix}-${id}`]));
    for (const e of slide.elements) { e.id = ids.get(e.id)!; if (e.groupId) e.groupId = groups.get(e.groupId) ?? e.groupId; }
    slide.groups = Object.fromEntries(Object.entries(slide.groups ?? {}).map(([id, g]) => [groups.get(id)!, { ...g, id: groups.get(id)!, ...(g.parentId ? { parentId: groups.get(g.parentId) ?? g.parentId } : {}) }]));
    for (const b of slide.beats) for (const t of b.tracks) { t.target = ids.get(t.target) ?? t.target; if (t.ghostFrom) t.ghostFrom = ids.get(t.ghostFrom) ?? t.ghostFrom; }
  }
  return copy;
}

/** A slide evaluated at one build step, ready for any static writer: the
 *  elements as they stand (unborn or invisible ones marked hidden, appearance
 *  opacity folded in), a plot's markup with its part states applied, the
 *  camera and the background. The one source for the SVG poster (Word, PDF,
 *  plain Quarto, the PDF deck export) and the PowerPoint export. */
export interface EvaluatedSlide {
  slide: Deck["slides"][number];
  elements: Figure["elements"];
  groups: Figure["groups"];
  plotMarkup: (el: Figure["elements"][number]) => string | undefined;
  camera: { x: number; y: number; zoom: number } | undefined;
  background: string;
  stage: { width: number; height: number };
}
export function evaluateSlide(payload: ExportPayload, step = 0): EvaluatedSlide {
  const deck = payload.deck, slide = deck.slides[0];
  if (!slide) throw new Error("Cannot render an absent slide");
  const frame = compileSlide(slide, deck.stage, { plotManifest: id => payload.plots?.[id]?.manifest }).sample(step);
  const unavailable = new Set(frame.presentation.unbornElementIds ?? []);
  for (const el of frame.elements) {
    const appearance = frame.presentation.elementStates[el.id];
    if (unavailable.has(el.id) || appearance && !appearance.visible) el.hidden = true;
    if (appearance) el.opacity = (el.opacity ?? 1) * appearance.opacity;
  }
  const plotMarkup = (el: Figure["elements"][number]) => {
    if (el.type !== "plot") return undefined;
    const plot = payload.plots?.[el.assetId];
    if (!plot) throw new Error(`Missing slide plot ${el.assetId}`);
    const markup = buildPlotMarkup(plot.svg, el, el.overrides, plot.manifest);
    if (!markup) throw new Error(`Cannot render slide plot ${el.assetId}`);
    const parts = frame.partStates[el.id];
    if (!parts) return markup;
    const root = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    for (const node of Array.from(root.querySelectorAll("[id]"))) {
      const key = node.id.startsWith(`${el.id}__`) ? node.id.slice(el.id.length + 2) : "";
      const state = parts[key];
      if (!state) continue;
      const styled = node as SVGElement;
      const own = styled.style.opacity || node.getAttribute("opacity") || "1";
      styled.style.opacity = String(Number(own) * state.opacity);
      if (!state.visible) styled.style.visibility = "hidden";
    }
    return serializeSvg(root);
  };
  const background = slide.background ?? deck.background ?? resolveTheme(deck.theme).background;
  return { slide, elements: frame.elements, groups: slide.groups, plotMarkup, camera: frame.camera, background, stage: deck.stage };
}

/** Shared evaluated endpoints → ordinary SVG, usable by Word, PDF and plain Quarto. */
export function renderSlidePosterSvg(payload: ExportPayload, step = 0): string {
  const ev = evaluateSlide(payload, step);
  const fig: Figure = { id: `poster-${ev.slide.id}`, name: ev.slide.name ?? ev.slide.id, canvasId: "slide-poster", x: 0, y: 0,
    width: ev.stage.width, height: ev.stage.height, background: "transparent", elements: ev.elements, groups: ev.groups };
  let svg = figureToSvg(fig, id => payload.assets?.[id], ev.plotMarkup, id => payload.assetSizes?.[id]);
  const { width: w, height: h } = ev.stage;
  const c = ev.camera, camera = c ? `translate(${w / 2} ${h / 2}) scale(${c.zoom}) translate(${-c.x} ${-c.y})` : "";
  const start = svg.indexOf(">") + 1, end = svg.lastIndexOf("</svg>");
  svg = svg.slice(0, start) + `<rect width="${w}" height="${h}" fill="${xml(ev.background)}"/><g${camera ? ` transform="${camera}"` : ""}>${svg.slice(start, end)}</g></svg>`;
  return svg;
}
