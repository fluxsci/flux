// Slide deck -> PDF (2026-09-24, owner request: "export slides in PDF format
// besides HTML").
//
// A PDF is static, so each page is a slide's POSTER: the evaluated state at a
// build step, rendered by the same path that puts slides into Word/PDF
// documents (embedRender.renderSlidePosterSvg -> figureToSvg). Plots stay
// vector, text stays text. Two page plans:
//   * "final" — one page per slide, every build step applied (a handout);
//   * "steps" — one page per build step, so a build reads as a flip-book.
// The HTML is printed by the main process's static print worker (print:pdf):
// scripts off, only file:/data:/blob: loads, @page sized to the stage.
//
// Renderer-only (DOMParser/XMLSerializer); the deck comes from DISK, so the
// caller saves first, like the HTML export.
import { readEmbedDeck, gatherSlidePayload, type SlidePayloadIO } from "../payload";
import { renderSlidePosterSvg } from "../embedRender";

export type DeckPdfPages = "final" | "steps";

export interface DeckPdfDocument {
  html: string;
  pages: number;
  warnings: string[];
}

/** The build steps a slide contributes as pages. Step 0 is the design state;
 *  the last step is the slide with every build applied. */
export function pdfStepsFor(beatCount: number, plan: DeckPdfPages): number[] {
  const last = Math.max(0, beatCount - 1);
  return plan === "steps" ? Array.from({ length: last + 1 }, (_, i) => i) : [last];
}

const css = (w: number, h: number, fonts: string) =>
  `@page{size:${w}px ${h}px;margin:0}` +
  `html,body{margin:0;padding:0;background:#fff}` +
  // Each page is exactly one stage. break-after keeps one slide per sheet;
  // the last one must not push a blank page after itself.
  `.page{width:${w}px;height:${h}px;overflow:hidden;break-after:page;page-break-after:always}` +
  `.page:last-child{break-after:auto;page-break-after:auto}` +
  // A full-height inline SVG leaves a text baseline below it (export:pdf's
  // note): block display at the exact size prevents a spill onto a new page.
  `.page>svg{display:block;width:${w}px;height:${h}px}` +
  fonts;

/** Build the printable HTML for a saved deck. */
export async function deckPdfDocument(
  root: string,
  deckId: string,
  io: SlidePayloadIO,
  plan: DeckPdfPages = "final",
): Promise<DeckPdfDocument> {
  // Static pages show a video's poster frame; never stream or inline the movie.
  const staticIO: SlidePayloadIO = { ...io, videoUrl: async () => "" };
  const deck = await readEmbedDeck(root, deckId, staticIO);
  if (!deck.slides.length) throw new Error("This deck has no slides to export");
  const fonts = (await import("../../../../.generated/slide-embed-assets.json")).default.fonts as string;
  const { width: w, height: h } = deck.stage;
  const pages: string[] = [];
  const warnings: string[] = [];
  for (const slide of deck.slides) {
    const result = await gatherSlidePayload(root, deck, slide.id, staticIO);
    for (const warning of result.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    for (const step of pdfStepsFor(slide.beats.length, plan)) {
      pages.push(`<div class="page">${renderSlidePosterSvg(result.payload, step)}</div>`);
    }
  }
  const title = deck.title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css(w, h, fonts)}</style></head><body>${pages.join("")}</body></html>`;
  return { html, pages: pages.length, warnings };
}
