/**
 * PackBits (compression 32773) decoding. Pure. Output bounded by `maxOut`.
 *
 * A header byte n: 0..127 copies the next n + 1 bytes, -1..-127 repeats the next byte 1 - n times, -128 is a no-op.
 */
export function packbitsDecode(src: Uint8Array, maxOut: number): Uint8Array {
  const out = new Uint8Array(maxOut);
  let ip = 0, op = 0;
  while (ip < src.length && op < maxOut) {
    const n = (src[ip++] << 24) >> 24;
    if (n >= 0) {
      const k = Math.min(n + 1, src.length - ip, maxOut - op);
      out.set(src.subarray(ip, ip + k), op);
      ip += n + 1; op += k;
    } else if (n !== -128) {
      if (ip >= src.length) break;
      const k = Math.min(1 - n, maxOut - op);
      out.fill(src[ip++], op, op + k);
      op += k;
    }
  }
  return out.subarray(0, op);
}
