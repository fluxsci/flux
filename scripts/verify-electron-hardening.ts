#!/usr/bin/env -S npx tsx
// Electron main-process security-hardening gate (V0.1 B1/B2/B3). The Electron
// main modules run as plain CJS with no bundler/lint/execution gate, so these
// window/spawn guards can only regress silently — this pins their SOURCE SHAPE
// (the verify-electron-no-undef precedent). Concerns:
//   B1 recipe:run requires per-project workspace trust before spawning a
//      project-supplied command (arbitrary-code-execution gate);
//   B2 the proxy-capture window (loads hostile publisher pages) denies
//      window.open and non-http(s) navigation;
//   B3 the print/export window runs javascript:false and its figure template
//      carries a script-blocking CSP.
//   npx tsx scripts/verify-electron-hardening.ts

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-electron-hardening");
const root = path.join(import.meta.dirname, "..");
const main = await fs.readFile(path.join(root, "electron", "main.cjs"), "utf8");
const proxy = await fs.readFile(path.join(root, "electron", "proxyFetch.cjs"), "utf8");

/** Slice the recipe:run handler body (from its ipcMain.handle to the matching end). */
function recipeRunHandler(): string {
  const start = main.indexOf('ipcMain.handle("recipe:run"');
  if (start < 0) return "";
  const end = main.indexOf("\nipcMain.handle(", start + 1);
  return main.slice(start, end < 0 ? undefined : end);
}

// --- B1: recipe workspace trust ------------------------------------------------
h.section("B1 — recipe:run workspace trust");
const rr = recipeRunHandler();
h.ok(!!rr, "recipe:run handler present");
const trustIdx = rr.indexOf("confirmRecipeTrust");
const spawnIdx = rr.indexOf("spawn(recipe.command");
h.ok(trustIdx >= 0, "recipe:run calls confirmRecipeTrust");
h.ok(spawnIdx >= 0 && trustIdx < spawnIdx, "the trust gate runs BEFORE spawn(recipe.command)");
h.ok(/if \(!\(await confirmRecipeTrust[\s\S]{0,120}return \{/.test(rr), "an untrusted recipe returns early (no spawn)");
h.ok(/function confirmRecipeTrust/.test(main) && /dialog\.showMessageBox/.test(main), "confirmRecipeTrust prompts via dialog.showMessageBox");
h.ok(/function isRecipeTrusted/.test(main) && /trustedRecipeRoots/.test(main), "trust is persisted per project (trustedRecipeRoots in prefs)");
h.ok(/function trustRecipeRoot[\s\S]{0,200}writePrefs\(/.test(main), "trustRecipeRoot writes through the atomic prefs writer");

// --- B2: proxy-capture window containment --------------------------------------
h.section("B2 — proxy-capture window containment");
h.ok(/setWindowOpenHandler\(\s*\(\)\s*=>\s*\(\{\s*action:\s*["']deny["']/.test(proxy), "proxy window denies window.open (setWindowOpenHandler → deny)");
h.ok(/on\("will-navigate"/.test(proxy) && /on\("will-redirect"/.test(proxy), "proxy window guards will-navigate AND will-redirect");
h.ok(/allowNav\s*=\s*\(u\)\s*=>\s*\/\^\(https\?:\|about:\)/.test(proxy), "navigation is restricted to http(s)/about schemes");

// --- B3: print/export window ---------------------------------------------------
h.section("B3 — print/export window");
const gpw = main.slice(main.indexOf("function getPrintWin"));
h.ok(/javascript:\s*false/.test(gpw.slice(0, 400)), "print window runs javascript:false");
h.ok(/http-equiv="Content-Security-Policy"[\s\S]{0,160}script-src 'none'/.test(main), "the figure export template carries a script-blocking CSP");

await h.done();
