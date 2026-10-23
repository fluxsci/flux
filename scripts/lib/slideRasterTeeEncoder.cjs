#!/usr/bin/env node
"use strict";
// Test-only stand-in for the video worker's `job.encoder`: forwards argv and stdin to the REAL ffmpeg
// ($FLUX_RASTER_REAL_FFMPEG) so the production encode/colour path runs unchanged, and ALSO splits the PNG stream into
// $FLUX_RASTER_FRAMES_DIR/f%04d.png (the exact lossless frames the worker captured) plus encoder-args.json.
const { spawn } = require("node:child_process"), fs = require("node:fs"), path = require("node:path");
const dir = process.env.FLUX_RASTER_FRAMES_DIR, real = process.env.FLUX_RASTER_REAL_FFMPEG, args = process.argv.slice(2);
if (!real) { console.error("FLUX_RASTER_REAL_FFMPEG is required"); process.exit(2); }
if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "encoder-args.json"), JSON.stringify(args)); }
const child = spawn(real, args, { stdio: ["pipe", "ignore", "inherit"] });
child.stdin.on("error", () => {});
let buf = Buffer.alloc(0), n = 0;
function drain() {
  for (;;) {
    if (buf.length < 8) return;
    let p = 8;
    for (;;) {
      if (buf.length < p + 8) return;
      const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8);
      if (buf.length < p + 12 + len) return;
      p += 12 + len;
      if (type === "IEND") break;
    }
    const png = buf.subarray(0, p); buf = buf.subarray(p);
    if (dir) fs.writeFileSync(path.join(dir, `f${String(n).padStart(4, "0")}.png`), png);
    n++;
  }
}
process.stdin.on("data", d => { child.stdin.write(d); buf = Buffer.concat([buf, d]); drain(); });
process.stdin.on("end", () => child.stdin.end());
child.on("close", code => process.exit(code ?? 1));
