/**
 * The neutral stand-in for a placed fluximg until its still renderer lands (wave 2).
 *
 * ONE pure function so every surface that draws an element (the canvas, the static export, flux-core, the slide
 * player) shows the same thing, and wave 2 replaces every call site in one step: grep for
 * `fluximg: wave 2 replaces this placeholder`. Pure: no DOM, no measurement (character-count truncation, explicit
 * sizes), so Chromium and resvg draw it identically. It never touches pixels.
 */
import type { FluximgElement } from "./element";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number): string => String(Math.round(n * 100) / 100);

/** A dark rectangle over the element's box with the asset's name, in canvas coordinates (no transform: callers wrap
 *  rotation / flips / opacity the way they do for an image). `asset` may be absent where a surface has no asset
 *  lookup; the label then falls back to the element's name. */
export function fluximgPlaceholderSvg(
  el: Pick<FluximgElement, "x" | "y" | "width" | "height" | "assetId" | "name">,
  asset?: { name?: string } | null,
): string {
  const w = Math.max(0, el.width), h = Math.max(0, el.height);
  const label = asset?.name || el.name || "Image";
  // Explicit size from the box only (no text measurement): about 1/8 of the short side, clamped to a readable range.
  const fontSize = Math.max(6, Math.min(14, Math.min(w, h) / 8));
  // Average glyph advance of a sans-serif is about 0.6 em; keep the label inside the box with a margin.
  const maxChars = Math.max(1, Math.floor((w - fontSize) / (fontSize * 0.6)));
  const text = label.length > maxChars ? label.slice(0, Math.max(1, maxChars - 1)) + "…" : label;
  // The baseline sits 0.35 em below the centre (no dominant-baseline: resvg and Chromium disagree on it).
  const showText = w >= fontSize * 2 && h >= fontSize * 1.5;
  return (
    `<g data-fluximg-placeholder="${esc(el.assetId)}">` +
    `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(w)}" height="${num(h)}" fill="#1c1b1a"/>` +
    (showText
      ? `<text x="${num(el.x + w / 2)}" y="${num(el.y + h / 2 + fontSize * 0.35)}" fill="#b7b5ac" font-family="sans-serif" ` +
        `font-size="${num(fontSize)}" text-anchor="middle">${esc(text)}</text>`
      : "") +
    `</g>`
  );
}
