/**
 * TIFF LZW (compression 5) decoding. Pure.
 *
 * Codes are 9 to 12 bits, most significant bit first. Code 256 clears the table, 257 ends the strip. The code width
 * grows one code EARLY (when the next free entry would be 511, 1023, 2047), as every TIFF writer since libtiff 3
 * does. The "old-style" LSB-first variant of very old writers is refused.
 *
 * The output is bounded by `maxOut` (the strip's expected size): a crafted strip cannot expand without limit.
 */
import { TiffError } from "./io";

const CLEAR = 256, EOI = 257;

export function lzwDecode(src: Uint8Array, maxOut: number): Uint8Array {
  if (src.length >= 2 && src[0] === 0 && (src[1] & 1)) {
    throw new TiffError("codec", "This file uses the old-style LZW of very early TIFF writers", "Re-save it with LZW or no compression");
  }
  const out = new Uint8Array(maxOut);
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; length[i] = 1; }
  const nbits = src.length * 8;
  let bit = 0, width = 9, next = 258, old = -1, op = 0;
  while (bit + width <= nbits && op < maxOut) {
    // Read `width` bits MSB-first (at most 12, so three bytes always hold them).
    const byte = bit >>> 3;
    const word = (src[byte] << 16) | ((src[byte + 1] ?? 0) << 8) | (src[byte + 2] ?? 0);
    const code = (word >>> (24 - (bit & 7) - width)) & ((1 << width) - 1);
    bit += width;
    if (code === EOI) break;
    if (code === CLEAR) { width = 9; next = 258; old = -1; continue; }
    if (old === -1) {
      if (code > 255) throw new TiffError("codec", "An LZW strip is damaged (it starts with an undefined code)");
      out[op++] = code;
      old = code;
      continue;
    }
    let entry: number;
    if (code < next) {
      entry = code;
      if (next < 4096) { prefix[next] = old; suffix[next] = first[code]; first[next] = first[old]; length[next] = length[old] + 1; next++; }
    } else if (code === next && next < 4096) {
      prefix[next] = old; suffix[next] = first[old]; first[next] = first[old]; length[next] = length[old] + 1; next++;
      entry = code;
    } else throw new TiffError("codec", "An LZW strip is damaged (a code refers to an entry that does not exist yet)");
    // Write the entry's string back to front; whatever passes maxOut is cut (the caller checks the length).
    const len = length[entry];
    let at = op + len - 1;
    for (let c = entry; c >= 0; c = prefix[c]) { if (at < maxOut) out[at] = suffix[c]; at--; }
    op = Math.min(maxOut, op + len);
    old = code;
    if (next >= (1 << width) - 1 && width < 12) width++;
  }
  return out.subarray(0, op);
}
