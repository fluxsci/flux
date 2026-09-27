"use strict";
const fs = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
/** Bound allocation and IPC payload before decoding, including files that grow
 * after stat. Never return half of a UTF-8 code point at the prefix boundary. */
async function readTextBounded(file, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new Error('Invalid bounded text limit');
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Expected a regular text file');
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(1, info.size)));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, null);
    const truncated = extra.bytesRead > 0;
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(buffer.subarray(0, used)) + (truncated ? '' : decoder.end());
    return { text, truncated, totalBytes: Math.max(info.size, used + extra.bytesRead) };
  } finally { await handle.close(); }
}
module.exports = { readTextBounded };
