// Baseline TIFF encoder (3.1 journal-spec figure export). Journals routinely require
// TIFF at 300/600 dpi with the physical resolution embedded; browsers can't ENCODE TIFF
// (only rare decode), so this hand-rolls a minimal, spec-correct baseline writer —
// uncompressed, little-endian, RGB or RGBA — fed straight from the export canvas's
// ImageData. No native dependency. The crucial bits journals check are the resolution
// tags (XResolution/YResolution + ResolutionUnit = inch), so a placed figure prints at
// exactly its intended column width.

export interface TiffOpts {
  dpi: number; // pixels per inch, stored in XResolution/YResolution
  alpha?: boolean; // keep the alpha channel (transparent background) → 4 samples/pixel
}

// TIFF field types we use.
const T_SHORT = 3;
const T_LONG = 4;
const T_RATIONAL = 5;

/** Encode RGBA pixel data (as produced by CanvasRenderingContext2D.getImageData) into a
 *  baseline TIFF. `rgba` is width*height*4 bytes, row-major, top-to-bottom. */
export function encodeTiff(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, opts: TiffOpts): Uint8Array {
  if (width <= 0 || height <= 0) throw new Error("encodeTiff: non-positive dimensions");
  if (rgba.length < width * height * 4) throw new Error("encodeTiff: pixel buffer too small");
  const dpi = Math.max(1, Math.round(opts.dpi));
  const alpha = !!opts.alpha;
  const spp = alpha ? 4 : 3; // samples per pixel
  const stripBytes = width * height * spp;

  // Entries (kept in ascending tag order, as baseline TIFF requires).
  const hasExtra = alpha;
  const numEntries = 12 + (hasExtra ? 1 : 0);
  const ifdOffset = 8;
  const ifdSize = 2 + numEntries * 12 + 4;
  // Out-of-line blocks placed right after the IFD: BitsPerSample (spp shorts) + two RATIONALs.
  const bpsOffset = ifdOffset + ifdSize;
  const bpsSize = spp * 2;
  const xResOffset = bpsOffset + bpsSize;
  const yResOffset = xResOffset + 8;
  const stripOffset = yResOffset + 8;
  const total = stripOffset + stripBytes;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const LE = true;

  // --- header ---
  dv.setUint16(0, 0x4949, LE); // "II" little-endian
  dv.setUint16(2, 42, LE); // magic
  dv.setUint32(4, ifdOffset, LE);

  // --- IFD ---
  dv.setUint16(ifdOffset, numEntries, LE);
  let p = ifdOffset + 2;
  const entry = (tag: number, type: number, count: number, valueOrOffset: number) => {
    dv.setUint16(p, tag, LE);
    dv.setUint16(p + 2, type, LE);
    dv.setUint32(p + 4, count, LE);
    dv.setUint32(p + 8, valueOrOffset, LE);
    p += 12;
  };
  entry(256, T_LONG, 1, width); // ImageWidth
  entry(257, T_LONG, 1, height); // ImageLength
  entry(258, T_SHORT, spp, bpsOffset); // BitsPerSample → out of line (spp shorts)
  entry(259, T_SHORT, 1, 1); // Compression = none
  entry(262, T_SHORT, 1, 2); // PhotometricInterpretation = RGB
  entry(273, T_LONG, 1, stripOffset); // StripOffsets
  entry(277, T_SHORT, 1, spp); // SamplesPerPixel
  entry(278, T_LONG, 1, height); // RowsPerStrip (one strip)
  entry(279, T_LONG, 1, stripBytes); // StripByteCounts
  entry(282, T_RATIONAL, 1, xResOffset); // XResolution → out of line
  entry(283, T_RATIONAL, 1, yResOffset); // YResolution → out of line
  entry(296, T_SHORT, 1, 2); // ResolutionUnit = inch
  if (hasExtra) entry(338, T_SHORT, 1, 2); // ExtraSamples = unassociated alpha
  dv.setUint32(p, 0, LE); // next IFD = none

  // --- out-of-line values ---
  for (let i = 0; i < spp; i++) dv.setUint16(bpsOffset + i * 2, 8, LE); // 8 bits/sample
  dv.setUint32(xResOffset, dpi, LE); // XResolution numerator
  dv.setUint32(xResOffset + 4, 1, LE); // denominator
  dv.setUint32(yResOffset, dpi, LE);
  dv.setUint32(yResOffset + 4, 1, LE);

  // --- strip: pack RGB(A), dropping alpha when opaque ---
  let o = stripOffset;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const s = i * 4;
    u8[o++] = rgba[s];
    u8[o++] = rgba[s + 1];
    u8[o++] = rgba[s + 2];
    if (alpha) u8[o++] = rgba[s + 3];
  }
  return u8;
}
