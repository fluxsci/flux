// ---------------------------------------------------------------------------
// Flux — GLYPH FONTS (oct2 W3 §3.2): font bytes → per-character outline path
// data, the one place opentype.js (MIT) is used. Pure given the bytes, so the
// GUI renderer (IPC-fetched system fonts) and flux-core (the export bake) produce
// the same records; the exported deck carries those baked records and never this
// parser. TTF/OTF/WOFF parse; WOFF2 and anything unparsable yield null and the
// caller falls back to glyph boxes.
// ---------------------------------------------------------------------------

import * as opentype from "opentype.js";
import type { PathCommand } from "opentype.js";

// Bundlers resolve the package's ESM build (named exports); Node resolves its UMD
// build, whose CommonJS namespace arrives as the default export.
const parse: typeof opentype.parse = (opentype as unknown as { parse?: typeof opentype.parse }).parse
  ?? (opentype as unknown as { default: { parse: typeof opentype.parse } }).default.parse;

import type { GlyphRecord, GlyphSource, BakedGlyphFont } from "./glyphOutlines";
export type { GlyphRecord, GlyphSource, BakedGlyphFont } from "./glyphOutlines";

const num = (v: number | undefined) => {
  const r = Math.round((v ?? 0) * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
};

/** Serialize opentype path commands deterministically (0.1 font-unit grid). */
export function commandsToD(commands: PathCommand[]): string {
  let d = "";
  for (const c of commands) {
    if (c.type === "M" || c.type === "L") d += `${c.type}${num(c.x)} ${num(c.y)}`;
    else if (c.type === "Q") d += `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`;
    else if (c.type === "C") d += `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`;
    else if (c.type === "Z") d += "Z";
  }
  return d;
}

/** Parse font bytes into a cached glyph source, or null (WOFF2, damaged, …). */
export function parseGlyphFont(bytes: Uint8Array): GlyphSource | null {
  if (bytes.length >= 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "wOF2") return null;
  let font: ReturnType<typeof parse>;
  try { font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); }
  catch { return null; }
  if (!font?.unitsPerEm) return null;
  const upm = font.unitsPerEm, cache = new Map<string, GlyphRecord | null>();
  return {
    unitsPerEm: upm,
    glyph(ch) {
      if (cache.has(ch)) return cache.get(ch)!;
      let rec: GlyphRecord | null = null;
      try {
        const g = font.charToGlyph(ch);
        if (g && g.index !== 0) rec = { d: commandsToD(g.getPath(0, 0, upm).commands), advance: Math.round((g.advanceWidth ?? 0) * 10) / 10 };
      } catch { rec = null; }
      cache.set(ch, rec);
      return rec;
    },
  };
}

/** Bake exactly `chars` (code points) from a source, keys sorted so both engines
 *  emit identical bytes. */
export function bakeGlyphs(src: GlyphSource, chars: Iterable<string>): BakedGlyphFont {
  const glyphs: Record<string, GlyphRecord> = {};
  for (const ch of [...new Set(chars)].sort()) { const g = src.glyph(ch); if (g) glyphs[ch] = g; }
  return { unitsPerEm: src.unitsPerEm, glyphs };
}
