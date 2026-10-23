// ---------------------------------------------------------------------------
// Flux Slide — countUp: the number tween ("n = 1,247 patients" counts up as you
// land the stat). A bespoke driver like morph — not WAAPI keyframes — sharing
// the MorphController {seek} contract, so the player's rAF driver, static-state
// seek(0|1), reduced-motion snap-to-1, and export bundling all come for free.
//
// Format is INFERRED from the target's current text (prefix/suffix around the
// first number, its decimals, thousands separators) so authors just type the
// final text and add the track; params can override every piece.
// ---------------------------------------------------------------------------

import type { Track } from "../types";
import type { MorphController } from "../../plot/project";
import type { TargetNode } from "./presets";
import { presetParam } from "../presetCatalog";

interface CountUpParams {
  from?: number;
  to?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Thousands separators in the output (default: inferred from the text). */
  separator?: boolean;
  /** Place-value slots keep digits still on SVG text (default on); `false` is the kill switch. */
  steadyDigits?: boolean;
}

/** Build a countUp driver over ONE node (a text box, a block, or any element
 *  whose textContent carries the number). seek(0) shows `from`; seek(1) restores
 *  the authored final text exactly. */
export function countUpText(original: string, track: Track): (t: number, raw?: number) => string {
  const m = original.match(/-?\d[\d,]*\.?\d*/);
  const parsed = m ? Number(m[0].replace(/,/g, "")) : NaN;
  const p = (track.params ?? {}) as CountUpParams;
  const to = p.to ?? (Number.isFinite(parsed) ? parsed : 100);
  const from = p.from ?? 0;
  const decimals = p.decimals ?? (m?.[0].includes(".") ? (m[0].split(".")[1]?.length ?? 0) : 0);
  const prefix = p.prefix ?? (m ? original.slice(0, m.index) : "");
  const suffix = p.suffix ?? (m ? original.slice((m.index ?? 0) + m[0].length) : "");
  const separator = p.separator ?? (m?.[0].includes(",") ?? false);

  const fmt = (v: number): string => {
    let s = v.toFixed(decimals);
    if (separator) {
      const [i, d] = s.split(".");
      s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
    }
    return prefix + s + suffix;
  };

  // raw=1 restores authored text verbatim (no rounding drift in the rest state).
  return (t, raw = t) => raw >= 1 && m && p.to == null ? original : fmt(from + (to - from) * Math.max(0, Math.min(1, t)));
}

// ---------------------------------------------------------------------------
// PLACE-VALUE SLOTS (WP 2.3, D5). A proportional font makes a counting number's digits wander: a "1" is narrower than an
// "8", so the decimal point and every digit to its right jitter as the digits change (glyph-centre jitter on a 0 -> 1,234.5
// ramp at 192 px/em: median 2.9, p90 23.4, max 49.6 px). `tabular-nums` is no answer (Georgia, the theme's first family, has
// no `tnum`). Instead each digit is centred in a SLOT as wide as the FINAL text's digit at the same place value (units,
// tens, tenths ...), through an SVG `dx` list on the one text chunk (so `text-anchor` still works). Slot widths never change
// during the count, so every digit's centre is fixed (jitter 0); at the end the shown digit IS the final digit, so every
// offset is exactly 0 and, at raw >= 1, the node's own `dx` is restored and the text is byte-identical to the authored one:
// no relax step, no snap. A new order of magnitude (a new leading digit, a comma) still shifts the digits to its right once,
// as on any pinned number. A `middle` / `end` anchored number is held about its anchor too (see `slotDx`). SVG text only (HTML
// text has no per-glyph offsets); `params.steadyDigits: false` turns it off.
// ---------------------------------------------------------------------------
const NUMBER = /-?\d[\d,]*\.?\d*/;
const SVG_NS = "http://www.w3.org/2000/svg";
const isDigit = (ch: string) => ch >= "0" && ch <= "9";

/** The advance of each digit 0-9 in the node's computed font, or null when it cannot be measured (a text with no rendering,
 *  e.g. detached, throws or reports 0; headless DOMs have no `getSubStringLength`). */
function digitAdvances(node: Element): number[] | null {
  const t = node as unknown as SVGTextContentElement;
  if (typeof t.getSubStringLength !== "function") return null;
  const keep = node.textContent, dx = node.getAttribute("dx");
  try {
    node.removeAttribute("dx"); node.textContent = "0123456789";
    const out = Array.from({ length: 10 }, (_, i) => t.getSubStringLength(i, 1));
    return out.every(v => v > 0) ? out : null;
  } catch { return null; }
  finally { node.textContent = keep; if (dx !== null) node.setAttribute("dx", dx); }
}

/** The place value of each character of `text`'s first number (integer places n-1 ... 0, then -1, -2 ...); null for every
 *  other character. */
function placesOf(text: string): (number | null)[] {
  const out: (number | null)[] = Array.from(text, () => null), m = text.match(NUMBER);
  if (!m || m.index === undefined) return out;
  const dot = m[0].indexOf("."), intPart = dot < 0 ? m[0] : m[0].slice(0, dot);
  let integers = 0; for (const ch of intPart) if (isDigit(ch)) integers++;
  let place = integers - 1;
  for (let k = 0; k < m[0].length; k++) {
    const ch = m[0][k];
    if (ch === ".") { place = -1; continue; }
    if (isDigit(ch)) out[m.index + k] = place--;
  }
  return out;
}

/** The `dx` list that centres each digit of `text` in its slot (`slots`: place value -> slot width; a place the final text
 *  has no digit at gets the widest digit). Offsets are cumulative on the text chunk, so each entry is a delta.
 *
 *  `anchor` is the share of the text's width that sits LEFT of its anchor point: 0 for `text-anchor:start`, .5 for `middle`, 1
 *  for `end`. The browser derives the anchor shift from the text's natural advance PLUS every `dx` but the first glyph's
 *  (measured in Chrome: a first-glyph `dx` translates the text rigidly, any later one widens it), while the slotted layout is
 *  `shift` wider than the natural one. The first glyph's `dx` therefore takes back the difference, so every frame of one length
 *  has the same extent about the same anchor and a centred or right-aligned number holds still as a left-pinned one does. */
function slotDx(text: string, slots: ReadonlyMap<number, number>, advance: readonly number[], anchor: number): string {
  const widest = Math.max(...advance), places = placesOf(text);
  let shift = 0; const offsets: number[] = [];
  Array.from(text).forEach((ch, k) => {
    const place = places[k];
    let offset = shift;
    if (isDigit(ch) && place != null) {
      const slot = slots.get(place) ?? widest, a = advance[ch.charCodeAt(0) - 48];
      offset = shift + (slot - a) / 2; shift += slot - a;
    }
    offsets[k] = offset;
  });
  const last = offsets.length - 1;
  const correction = last < 0 ? 0 : anchor * (offsets[last] - offsets[0] - shift);
  return offsets.map((offset, k) => ((k ? offset - offsets[k - 1] : offset + correction)).toFixed(3)).join(" ");
}
const ANCHOR_SHARE: Record<string, number> = { start: 0, middle: .5, end: 1 };

export function createCountUp(node: TargetNode, track: Track): MorphController {
  const sample = countUpText(node.textContent ?? "", track);
  const own = node.getAttribute("dx");
  // Slots need per-glyph offsets (SVG text), real layout (measured advances) and a text chunk the layout does not justify
  // (`textLength` fights `dx`).
  const steady = node.namespaceURI === SVG_NS && presetParam<boolean>(track, "steadyDigits", "countUp") && !node.hasAttribute("textLength");
  let measured: { key: string; advance: number[]; slots: Map<number, number>; anchor: number } | undefined;
  const fonts = (node.ownerDocument as Document | null)?.fonts;
  const refont = () => { measured = undefined; };
  if (steady) fonts?.addEventListener?.("loadingdone", refont);
  // Measured per computed font. A failed measurement (no layout yet) is NOT cached: the next seek retries.
  const measure = () => {
    if (typeof (node as unknown as SVGTextContentElement).getSubStringLength !== "function") return null;
    const cs = getComputedStyle(node), key = [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.fontStyle, cs.fontStretch, cs.letterSpacing, cs.fontVariantNumeric, cs.textAnchor].join("|");
    if (measured?.key === key) return measured;
    const advance = digitAdvances(node); if (!advance) return null;
    const final = sample(1, 1), places = placesOf(final), slots = new Map<number, number>();
    Array.from(final).forEach((ch, k) => { const place = places[k]; if (place != null && isDigit(ch)) slots.set(place, advance[ch.charCodeAt(0) - 48]); });
    return measured = { key, advance, slots, anchor: ANCHOR_SHARE[cs.textAnchor] ?? 0 };
  };
  return {
    seek(u, raw = Math.max(0, Math.min(1, u))) {
      const text = sample(Math.max(0, Math.min(1, u)), raw);
      node.textContent = text;
      if (!steady) return;
      if (raw >= 1) { if (own === null) node.removeAttribute("dx"); else node.setAttribute("dx", own); return; }
      const m = measure();
      if (m) node.setAttribute("dx", slotDx(text, m.slots, m.advance, m.anchor));
    },
    dispose() { fonts?.removeEventListener?.("loadingdone", refont); },
  };
}
