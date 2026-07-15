"use strict";
// The actual raster work: loadImage -> offscreen canvas -> webp -> atomic
// write, behind a small concurrency pool. This module runs IN-PROCESS under
// plain Node (verify-node, any CLI use) and inside an Electron utilityProcess
// in the app (electron/thumbWorker.cjs) — NEVER in the Electron main process:
// @napi-rs/canvas segfaults the main process under burst load there
// (measured 2026-07-15 flinging a 1500-image set; a utilityProcess is
// crash-isolated and respawnable).
const fsp = require("node:fs/promises");
const os = require("node:os");
const crypto = require("node:crypto");

// Lazy-required so callers can fall back to serving originals if the native
// module is unavailable on some platform.
let canvasMod;
function canvas() {
  if (canvasMod === undefined) {
    try {
      canvasMod = require("@napi-rs/canvas");
    } catch {
      canvasMod = null;
    }
  }
  return canvasMod;
}

// Never block an event loop on a pile of decodes — at most ~one generation
// per core, the rest queue.
const MAX_CONCURRENT = Math.max(2, Math.min(8, os.cpus().length));
let active = 0;
const queue = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

// Generate a thumbnail for srcAbs with longest edge <= px (never upscales)
// into `out`. Throws on any failure — the caller decides the fallback.
function generateThumb(srcAbs, px, out) {
  return withSlot(async () => {
    const mod = canvas();
    if (!mod) throw new Error("@napi-rs/canvas unavailable");
    const img = await mod.loadImage(srcAbs);
    const w = img.width;
    const h = img.height;
    if (!w || !h) throw new Error("zero-sized image");
    const scale = Math.min(1, px / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const cnv = mod.createCanvas(tw, th);
    cnv.getContext("2d").drawImage(img, 0, 0, tw, th);
    const buf = await cnv.encode("webp", 80);
    // Atomic write: temp + rename (concurrent writers race to rename
    // identical bytes — last rename wins harmlessly).
    const tmp = `${out}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, out);
    return out;
  });
}

module.exports = { generateThumb };
