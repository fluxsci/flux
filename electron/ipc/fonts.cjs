"use strict";
// fonts:lookup (oct2 W3 §3.2) — resolve a CSS font request to the system font
// file the renderer's text actually paints with, and return its bytes, so a
// text ↔ shape Become can fly real letter outlines. The ONE resolver is
// src/lib/text/fontFiles.mjs (shared with flux-core's export bake); this file
// only validates the request, memoizes per request key, and points the
// macOS/Windows face index at the machine config dir (lowercase, fluxPaths).
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let core;
const loadCore = () => (core ??= import(pathToFileURL(path.join(__dirname, "../../src/lib/text/fontFiles.mjs")).href));

/** Reject anything that is not a plain font request (bounded strings/numbers). */
function cleanRequest(request) {
  const family = typeof request?.family === "string" ? request.family.slice(0, 512) : "";
  const weight = Number.isFinite(Number(request?.weight)) ? Math.min(1000, Math.max(1, Number(request.weight))) : 400;
  const style = request?.style === "italic" || request?.style === "oblique" ? "italic" : "normal";
  if (!family.trim()) throw new Error("fonts:lookup needs a font family");
  return { family, weight, style };
}

function createFontsFamily({ configDir }) {
  const memo = new Map();
  function registerHandlers(ipcMain) {
    ipcMain.handle("fonts:lookup", async (_event, request) => {
      const req = cleanRequest(request);
      const { lookupFont, fontRequestKey } = await loadCore();
      const key = fontRequestKey(req);
      let hit = memo.get(key);
      if (!hit) {
        hit = lookupFont(req, { cacheFile: path.join(configDir(), "fonts-index.json") })
          .then((r) => ({ key: r.key, bytes: r.bytes ? Buffer.from(r.bytes) : null, format: r.format ?? null }))
          .catch(() => ({ key, bytes: null, format: null }));
        memo.set(key, hit);
      }
      return hit;
    });
  }
  return { registerHandlers };
}

module.exports = { createFontsFamily, cleanRequest };
