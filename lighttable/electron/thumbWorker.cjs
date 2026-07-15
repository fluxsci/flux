"use strict";
// Thumbnail worker — an Electron utilityProcess (Node runtime, crash-isolated
// from the main process). All @napi-rs/canvas work happens here; see
// lib/thumbGen.cjs for why it must not run in main. Protocol: one message per
// job {id, src, px, out} -> one reply {id, ok, path | error}.
const { generateThumb } = require("./lib/thumbGen.cjs");

process.parentPort.on("message", (e) => {
  const { id, src, px, out } = e.data || {};
  generateThumb(src, px, out).then(
    (p) => process.parentPort.postMessage({ id, ok: true, path: p }),
    (err) => process.parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) })
  );
});
