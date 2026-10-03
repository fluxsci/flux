// The GUI's glyph-font loader (oct2 W3 §3.2): system font bytes over the
// `fonts:lookup` IPC, parsed by text/glyphFont.ts (opentype.js), which is loaded
// lazily — nothing about letter outlines costs startup. Outside Electron (the
// plain dev browser) there is no bridge and letters land as glyph boxes.
import { fileBridge } from "../project/types";
import type { GlyphFontLoader } from "../slide/player/glyphProvider";

export function guiGlyphFontLoader(): GlyphFontLoader | null {
  const fig = typeof window === "undefined" ? undefined : fileBridge();
  if (!fig?.fontLookup) return null;
  return async (style) => {
    const result = await fig.fontLookup!({ family: style.family, weight: style.weight, style: style.style });
    if (!result?.bytes) return null;
    const { parseGlyphFont } = await import("./glyphFont");
    return parseGlyphFont(new Uint8Array(result.bytes));
  };
}
