/**
 * TIFF predictors, undone in place. Pure.
 *
 * Predictor 2 (horizontal differencing) works on samples in the HOST byte order, so a big-endian file is
 * byte-swapped first. Predictor 3 (floating point, TIFF technical note 3) works on bytes: each row's samples are
 * split into byte planes, most significant first, then differenced; it yields host-order floats whatever the
 * file's byte order. All writers apply both per row (a strip's or a tile's row), with a stride of the samples per
 * pixel when samples are interleaved.
 */
import { TiffError } from "./io";

/**
 * Undo predictor 2 on `rows` rows of `rowPixels` pixels with `stride` interleaved samples of `bits` bits each.
 * `buf` holds the samples in host byte order and is 8-byte aligned.
 */
export function undoHorizontal(buf: Uint8Array, bits: number, rowPixels: number, rows: number, stride: number): void {
  const n = rowPixels * stride;
  if (bits === 8) return accumulate(buf, n, rows, stride);
  if (bits === 16) return accumulate(new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1), n, rows, stride);
  if (bits === 32) return accumulate(new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2), n, rows, stride);
  if (bits === 64) {
    // Two 32-bit halves (little-endian host) with a carry: no BigInt on the hot path.
    const w = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    for (let r = 0; r < rows; r++) {
      const base = r * n;
      for (let i = stride; i < n; i++) {
        const a = (base + i) * 2, b = (base + i - stride) * 2;
        const lo = w[a] + w[b];
        w[a] = lo >>> 0;
        w[a + 1] = (w[a + 1] + w[b + 1] + (lo > 0xffffffff ? 1 : 0)) >>> 0;
      }
    }
    return;
  }
  throw new TiffError("codec", `Horizontal prediction of ${bits}-bit samples is not supported`);
}

function accumulate(a: Uint8Array | Uint16Array | Uint32Array, n: number, rows: number, stride: number): void {
  for (let r = 0; r < rows; r++) {
    const base = r * n;
    for (let i = base + stride, end = base + n; i < end; i++) a[i] = a[i] + a[i - stride];
  }
}

/**
 * Undo predictor 3 on `rows` rows of `rowPixels` pixels with `stride` interleaved samples of `bytes` bytes
 * each. `buf` is rewritten with host-order (little-endian) floats.
 */
export function undoFloat(buf: Uint8Array, bytes: number, rowPixels: number, rows: number, stride: number): void {
  const wc = rowPixels * stride, rowBytes = wc * bytes;
  const tmp = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const row = buf.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = stride; i < rowBytes; i++) row[i] = (row[i] + row[i - stride]) & 255;
    tmp.set(row);
    for (let k = 0; k < wc; k++) for (let j = 0; j < bytes; j++) row[k * bytes + j] = tmp[(bytes - 1 - j) * wc + k];
  }
}

/** Reverse the byte order of every `bytes`-byte sample in place. */
export function swapBytes(buf: Uint8Array, bytes: number): void {
  if (bytes === 2) { for (let i = 0; i + 1 < buf.length; i += 2) { const t = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = t; } return; }
  if (bytes === 4) {
    for (let i = 0; i + 3 < buf.length; i += 4) {
      let t = buf[i]; buf[i] = buf[i + 3]; buf[i + 3] = t;
      t = buf[i + 1]; buf[i + 1] = buf[i + 2]; buf[i + 2] = t;
    }
    return;
  }
  if (bytes === 8) {
    for (let i = 0; i + 7 < buf.length; i += 8) for (let j = 0; j < 4; j++) { const t = buf[i + j]; buf[i + j] = buf[i + 7 - j]; buf[i + 7 - j] = t; }
  }
}
