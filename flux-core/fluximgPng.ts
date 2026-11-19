/**
 * PNG for fluximg stills in Node: an encoder for the reference renderer's straight-alpha RGBA, and a decoder that
 * gates use to read a still back out of an export.
 *
 * The window encodes its stills with the browser's canvas; Node has no canvas, so this is the one small encoder on
 * `node:zlib`. Exactness is the point: the PNG holds the renderer's bytes unchanged (8 bits per sample, no gamma,
 * no colour-profile chunks, straight alpha). A still with no transparency is written as RGB (a quarter smaller);
 * the pixels are the same.
 */
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  const native = (zlib as unknown as { crc32?: (data: Uint8Array) => number }).crc32;
  if (native) return native(bytes) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Straight-alpha RGBA (row-major, `width * height * 4` bytes) as a PNG. Rows use the Up filter: one subtraction per
 * byte, and on images (smooth along y) it compresses close to adaptive filtering at a fraction of the time.
 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, options: { level?: number } = {}): Buffer {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new Error(`PNG size must be positive integers, got ${width} x ${height}`);
  if (rgba.length !== width * height * 4) throw new Error(`PNG pixels: expected ${width * height * 4} bytes, got ${rgba.length}`);
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4, stride = width * channels;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  const row = new Uint8Array(stride), prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    if (opaque) for (let x = 0, j = 0; x < width; x++, j += 3) { const i = src + x * 4; row[j] = rgba[i]; row[j + 1] = rgba[i + 1]; row[j + 2] = rgba[i + 2]; }
    else row.set(rgba.subarray(src, src + stride));
    const at = y * (stride + 1);
    raw[at] = 2; // Up (row 0: the previous row is zero, so this is None)
    for (let k = 0; k < stride; k++) raw[at + 1 + k] = (row[k] - prev[k]) & 0xff;
    prev.set(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = opaque ? 2 : 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: options.level ?? 4 })), chunk("IEND", new Uint8Array(0))]);
}

/** `data:image/png;base64,…` of `encodePng`. */
export function pngDataUrl(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): string {
  return `data:image/png;base64,${encodePng(rgba, width, height).toString("base64")}`;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Any 8-bit, non-interlaced, non-palette PNG (gray, gray + alpha, RGB, RGBA; every filter type) → straight RGBA.
 * Enough for every still Flux writes (this encoder, or a browser canvas); anything else is refused by name.
 */
export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let at = 8, width = 0, height = 0, type = -1;
  const idat: Buffer[] = [];
  while (at + 8 <= b.length) {
    const len = b.readUInt32BE(at), name = b.toString("ascii", at + 4, at + 8), data = b.subarray(at + 8, at + 8 + len);
    if (name === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9];
      if (data[8] !== 8 || data[12] !== 0 || ![0, 2, 4, 6].includes(type)) throw new Error(`unsupported PNG (bit depth ${data[8]}, colour type ${type}, interlace ${data[12]})`);
    } else if (name === "IDAT") idat.push(data);
    else if (name === "IEND") break;
    at += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || !width || !height) throw new Error("PNG without a usable header");
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is short");
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    if (f > 4) throw new Error(`bad PNG filter ${f}`);
    for (let k = 0; k < stride; k++) {
      const x = raw[src + k], a = k >= channels ? px[dst + k - channels] : 0, u = y > 0 ? px[up + k] : 0, c = y > 0 && k >= channels ? px[up + k - channels] : 0;
      px[dst + k] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + u : f === 3 ? x + ((a + u) >> 1) : x + paeth(a, u, c)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels >= 3) { rgba[o] = px[j]; rgba[o + 1] = px[j + 1]; rgba[o + 2] = px[j + 2]; rgba[o + 3] = channels === 4 ? px[j + 3] : 255; }
    else { rgba[o] = rgba[o + 1] = rgba[o + 2] = px[j]; rgba[o + 3] = channels === 2 ? px[j + 1] : 255; }
  }
  return { width, height, rgba };
}

/** The bytes of a `data:image/png;base64,` URL. */
export function dataUrlPngBytes(url: string): Buffer {
  const m = /^data:image\/png;base64,(.*)$/s.exec(url);
  if (!m) throw new Error("not a base64 PNG data URL");
  return Buffer.from(m[1], "base64");
}
