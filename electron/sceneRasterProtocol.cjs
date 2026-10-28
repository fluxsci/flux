"use strict";
// Small JSON metadata + raw binary body. In particular the 64 MiB SVG is NOT
// JSON-stringified on Electron's main thread, and PNGs are never base64 encoded.
function writeFrame(stream, header, body) {
  const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.length;
  const meta = Buffer.from(JSON.stringify({ ...header, bodyBytes: bytes }));
  const size = Buffer.allocUnsafe(4); size.writeUInt32BE(meta.length);
  stream.write(size); stream.write(meta); stream.write(body);
}
function readFrames(stream, onFrame, onError, maxBody = 64 * 1024 * 1024) {
  let chunks = [], length = 0, wanted = 4, header = null, metaSize = null, failed = false;
  const consume = n => {
    if (chunks[0]?.length === n) { length -= n; return chunks.shift(); }
    const result = Buffer.allocUnsafe(n); let at = 0;
    while (at < n) { const c = chunks[0], take = Math.min(c.length, n - at); c.copy(result, at, 0, take); at += take; if (take === c.length) chunks.shift(); else chunks[0] = c.subarray(take); }
    length -= n; return result;
  };
  stream.on("data", chunk => {
    if (failed) return;
    chunks.push(chunk); length += chunk.length;
    try {
      while (length >= wanted) {
        const part = consume(wanted);
        if (metaSize === null) { metaSize = part.readUInt32BE(); if (metaSize < 2 || metaSize > 65536) throw Error("Invalid raster frame header"); wanted = metaSize; }
        else if (header === null) { header = JSON.parse(part.toString("utf8")); if (!Number.isInteger(header.bodyBytes) || header.bodyBytes < 0 || header.bodyBytes > maxBody) throw Error("Invalid raster frame body"); wanted = header.bodyBytes; }
        else { const h = header; header = null; metaSize = null; wanted = 4; onFrame(h, part); }
      }
    } catch (error) { failed = true; chunks = []; length = 0; onError(error); }
  });
}
module.exports = { writeFrame, readFrames };
