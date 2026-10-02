// Minimal typings for the slice of opentype.js (MIT) Flux uses: parse a font,
// map a character to its glyph, read the glyph's outline commands. The package
// ships no declarations.
declare module "opentype.js" {
  export interface PathCommand { type: "M" | "L" | "Q" | "C" | "Z"; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
  export interface Path { commands: PathCommand[] }
  export interface Glyph { index: number; unicode?: number; advanceWidth?: number; getPath(x: number, y: number, fontSize: number): Path }
  export interface Font { unitsPerEm: number; ascender: number; descender: number; charToGlyph(c: string): Glyph | null; names: unknown }
  export function parse(buffer: ArrayBuffer, opts?: Record<string, unknown>): Font;
}
