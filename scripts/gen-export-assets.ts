// W13 build step: prebake the deck-independent slide-export assets (runtime IIFE,
// Gelasio @font-face CSS, inlined KaTeX CSS) into dist/slide-export-assets.json so
// the packaged app can export decks without esbuild / node_modules / src/ at
// runtime. Reuses the real compute functions from exportDeck.ts (no drift).
//
// Run via tsx (dev machine has esbuild + node_modules + src): part of `npm run build`.

import { writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { computeExportAssets } from "../src/lib/slide/export/exportDeck";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(repoRoot, "dist", "slide-export-assets.json");

const assets = await computeExportAssets();
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(assets));

const kb = (s: string) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(0);
console.log(
  `✓ dist/slide-export-assets.json — runtime ${kb(assets.runtime)}kB, ` +
    `gelasio ${kb(assets.gelasio)}kB, katex ${kb(assets.katexCss)}kB`,
);
