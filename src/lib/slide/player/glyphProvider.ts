// ---------------------------------------------------------------------------
// Flux Slide — the GLYPH PROVIDER (oct2 W3 §3.2): text elements → letter
// outlines for the geometry bridge (GeometryCtx.glyphs), in the browser.
//
// Fonts come from ONE registered loader per host: the GUI registers an
// IPC-backed loader (system font files parsed by text/glyphFont.ts), an exported
// deck registers its baked payload records, a host with neither (the plain dev
// browser) registers nothing and every letter lands as a glyph BOX. The loader is
// asynchronous; this module caches each request key's result for the session and
// bumps `glyphFontsRevision` when one resolves, so a plan built while a font was
// still loading (boxes) can be rebuilt with real outlines.
//
// Positions are measured, never guessed: each text state is rendered once
// through the ONE serializer (player/textMorph.ts measureTextChars) inside the
// host, and its glyphs are placed at the browser's own baseline start points.
// This module imports no font parser, so the exported runtime stays small.
// ---------------------------------------------------------------------------

import { writable } from "svelte/store";
import type { TextElement } from "../../types";
import type { StageOutline } from "../stageOutline";
import { fontRequestKey } from "../../text/fontRequest.mjs";
import { textGlyphNeeds, textGlyphOutlines, bakedSource, type GlyphSource, type GlyphStyle, type BakedGlyphFont } from "../../text/glyphOutlines";
import { layoutForMorph, measureTextChars } from "./textMorph";
import type { SlideRenderCtx } from "./render";

/** Resolve one font request to a glyph source (null: no readable outlines). */
export type GlyphFontLoader = (style: GlyphStyle) => Promise<GlyphSource | null>;

let loader: GlyphFontLoader | null = null;
const loaded = new Map<string, GlyphSource | null>();
const pending = new Map<string, Promise<void>>();
/** Bumped whenever a font request settles (and on registration). */
export const glyphFontsRevision = writable(0);
let revision = 0;
const bump = () => { revision++; glyphFontsRevision.set(revision); };

/** Install this host's font loader (null = none: letters land as boxes). */
export function registerGlyphFonts(next: GlyphFontLoader | null): void {
  loader = next; loaded.clear(); pending.clear(); bump();
}
export function glyphRevision(): number { return revision; }

/** The offline hosts' loader: baked payload records by request key (a font that
 *  was not baked lands as boxes). */
export function bakedGlyphLoader(baked: Record<string, BakedGlyphFont>): GlyphFontLoader {
  return (style) => { const hit = baked[fontRequestKey(style)]; return Promise.resolve(hit ? bakedSource(hit) : null); };
}

/** The cached source for a style: a source, null (unavailable), or undefined
 *  while it is still loading (the load is started on first ask). */
export function glyphFontSource(style: GlyphStyle): GlyphSource | null | undefined {
  const key = fontRequestKey(style);
  if (loaded.has(key)) return loaded.get(key)!;
  if (!loader) return null;
  if (!pending.has(key)) {
    const job = loader(style).then((src) => src, () => null).then((src) => { loaded.set(key, src); pending.delete(key); bump(); });
    pending.set(key, job);
  }
  return undefined;
}

/** Whether a text's letters will draw as real outlines ("ready"), as boxes
 *  because some font is unreadable ("missing"), or are still loading. */
export function textGlyphStatus(el: TextElement): "ready" | "missing" | "pending" {
  let status: "ready" | "missing" | "pending" = "ready";
  for (const need of textGlyphNeeds(el)) {
    const src = glyphFontSource(need.style);
    if (src === undefined) status = "pending";
    else if (src === null && status === "ready") status = "missing";
  }
  return status;
}

/** Resolves once every font `el` needs has settled (loaded or refused). */
export function textGlyphsReady(el: TextElement): Promise<void> {
  textGlyphStatus(el);
  return Promise.all(textGlyphNeeds(el).map((n) => pending.get(fontRequestKey(n.style)))).then(() => {});
}

export interface GlyphProvider {
  /** Unrotated stage outlines of a text state's letters (boxes for any letter
   *  without a font outline, and while a font is still loading); null when the
   *  host cannot measure the text right now. */
  outlines(el: TextElement): StageOutline[] | null;
  /** True when the last outlines for `el` were (partly) boxes. */
  boxes(el: TextElement): boolean;
  revision(): number;
  ready(el: TextElement): Promise<void>;
}

/** A provider bound to a rendering host (measurement happens inside it). */
export function createGlyphProvider(host: HTMLElement, ctx: SlideRenderCtx): GlyphProvider {
  const cache = new Map<string, { rev: number; outlines: StageOutline[] | null; boxes: boolean }>();
  const keyOf = (el: TextElement) => JSON.stringify([el.id, el.text, el.x, el.y, el.width, el.height, el.fontFamily, el.fontSize, el.fontWeight, el.fontStyle, el.align, el.valign, el.lineHeight, el.letterSpacing, el.paragraphSpacing, el.lines, el.lineWidths, el.runs, el.color, el.opacity, el.sizing]);
  function compute(el: TextElement) {
    const key = keyOf(el), hit = cache.get(key);
    if (hit && hit.rev === revision) return hit;
    const laid = layoutForMorph(el);
    const measured = measureTextChars(host, laid, ctx);
    if (!measured || measured === "later") return { rev: revision, outlines: null, boxes: false };
    const fontFor = (style: GlyphStyle) => glyphFontSource(style) ?? null; // pending → box for now
    const pendingNow = textGlyphStatus(laid) === "pending";
    const result = textGlyphOutlines(laid, measured.chars, fontFor);
    const entry = { rev: revision, outlines: result.outlines.length ? result.outlines : null, boxes: result.boxes || pendingNow };
    cache.set(key, entry);
    return entry;
  }
  return {
    outlines: (el) => compute(el).outlines,
    boxes: (el) => compute(el).boxes,
    revision: () => revision,
    ready: (el) => textGlyphsReady(el),
  };
}
