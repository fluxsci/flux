// PNG metadata chunk surgery: pHYs (physical resolution, 3.1) and tEXt (keyword-tagged
// text, e.g. paper-snip provenance). The canvas PNG encoder writes neither, so a
// journal-spec PNG (exported at a target dpi) would still report 96dpi to a layout tool,
// and a snip would lose its source-paper linkage when copied. Chunks are inserted right
// after IHDR, replacing any existing same-kind/same-keyword one. Pure byte-surgery
// (no DOM, no Node) — loads in the renderer, flux-core, and tests alike.

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Standard PNG CRC-32 (polynomial 0xEDB88320), table built once.
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a pHYs chunk (length+type+data+crc) for the given dpi. */
function physChunk(dpi: number): Uint8Array {
  const ppm = Math.max(1, Math.round(dpi / 0.0254)); // pixels per metre
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); // data length
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm); // X ppm
  dv.setUint32(12, ppm); // Y ppm
  chunk[16] = 1; // unit = metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17))); // CRC over type+data
  return chunk;
}

/** Read the physical resolution (dpi) a PNG declares in its pHYs chunk, or null when
 *  absent / non-metric (unit 0 = aspect-only) / not a PNG. The import path uses this to
 *  place a raster at its true physical size instead of 1 image px = 1 canvas px. */
export function readPngDpi(png: Uint8Array): number | null {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) return null;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p + 12 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === "pHYs" && len === 9) {
      if (png[p + 16] !== 1) return null; // unit 0 = pixel aspect ratio only, no physical size
      const ppmX = dv.getUint32(p + 8);
      if (!ppmX) return null;
      return ppmX * 0.0254; // pixels-per-metre → pixels-per-inch
    }
    if (type === "IDAT" || type === "IEND") return null; // pHYs must precede IDAT
    p += 12 + len;
  }
  return null;
}

/** Read the text of the first tEXt chunk carrying `keyword`, or null when absent /
 *  not a PNG. tEXt is Latin-1; callers store ASCII-only payloads (e.g. \uXXXX-escaped
 *  JSON — see snips.ts encodeSnipMeta) so a plain byte→char read is lossless. */
export function readPngText(png: Uint8Array, keyword: string): string | null {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) return null;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p + 12 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === "tEXt" && len > keyword.length) {
      const data = png.subarray(p + 8, p + 8 + len);
      let ok = data[keyword.length] === 0;
      for (let i = 0; ok && i < keyword.length; i++) ok = data[i] === keyword.charCodeAt(i);
      if (ok) {
        let text = "";
        for (let i = keyword.length + 1; i < data.length; i++) text += String.fromCharCode(data[i]);
        return text;
      }
    }
    if (type === "IEND") return null;
    p += 12 + len;
  }
  return null;
}

/** Build a tEXt chunk (length+type+keyword+NUL+text+crc). Latin-1 payload assumed. */
function textChunk(keyword: string, text: string): Uint8Array {
  const dataLen = keyword.length + 1 + text.length;
  const chunk = new Uint8Array(4 + 4 + dataLen + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, dataLen);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
  for (let i = 0; i < keyword.length; i++) chunk[8 + i] = keyword.charCodeAt(i) & 0xff;
  chunk[8 + keyword.length] = 0;
  for (let i = 0; i < text.length; i++) chunk[8 + keyword.length + 1 + i] = text.charCodeAt(i) & 0xff;
  dv.setUint32(8 + dataLen, crc32(chunk.subarray(4, 8 + dataLen)));
  return chunk;
}

/** Return a copy of `png` with a tEXt chunk carrying `keyword: text` inserted after
 *  IHDR (any existing same-keyword tEXt replaced). Non-PNG input returned unchanged —
 *  same best-effort posture as injectPngDpi. */
export function injectPngText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) return png;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  let insertAt = -1;
  const keep: Array<[number, number]> = [];
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const end = p + 12 + len;
    let drop = false;
    if (type === "tEXt" && len > keyword.length) {
      const data = png.subarray(p + 8, p + 8 + len);
      drop = data[keyword.length] === 0;
      for (let i = 0; drop && i < keyword.length; i++) drop = data[i] === keyword.charCodeAt(i);
    }
    if (!drop) {
      keep.push([p, end]);
      if (type === "IHDR") insertAt = keep.length;
    }
    if (type === "IEND") {
      p = end;
      break;
    }
    p = end;
  }
  if (insertAt < 0) return png; // malformed — no IHDR
  const chunk = textChunk(keyword, text);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  keep.forEach(([s, e], idx) => {
    parts.push(png.subarray(s, e));
    if (idx + 1 === insertAt) parts.push(chunk);
  });
  const outLen = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Return a copy of `png` with a pHYs chunk declaring `dpi` (any existing pHYs replaced).
 *  If the input isn't a PNG, it's returned unchanged (best-effort — the PNG still exports). */
export function injectPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) return png;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Walk chunks; find the end of IHDR (first chunk) and drop any existing pHYs.
  let p = 8;
  let insertAt = -1;
  const keep: Array<[number, number]> = []; // [start,end) ranges of chunks to keep
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const end = p + 12 + len; // length(4)+type(4)+data+crc(4)
    if (type === "pHYs") {
      // skip it (we re-insert a fresh one)
    } else {
      keep.push([p, end]);
      if (type === "IHDR") insertAt = keep.length; // insert right after IHDR
    }
    if (type === "IEND") {
      p = end;
      break;
    }
    p = end;
  }
  if (insertAt < 0) return png; // malformed — no IHDR
  const phys = physChunk(dpi);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  keep.forEach(([s, e], idx) => {
    parts.push(png.subarray(s, e));
    if (idx + 1 === insertAt) parts.push(phys);
  });
  const outLen = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
