#!/usr/bin/env node
// Regenerate the DEFAULT cursor family in src/styles/cursors.css from the pure
// builder (src/lib/cursor/cursorFamily.ts). The stylesheet keeps static
// literals so the first paint has the family before any JS runs; this script
// is the ONE way those literals change, and verify-cursor-family.ts (pure)
// fails when they drift from the builder.
//   node --import tsx scripts/gen-cursors.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cursorCssBlock } from "../src/lib/cursor/cursorFamily.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "src/styles/cursors.css");
const BEGIN = "/* @generated-cursors-begin — node --import tsx scripts/gen-cursors.mjs */";
const END = "/* @generated-cursors-end */";

export function renderCursorsCss(existing) {
  const block = `${BEGIN}\n${cursorCssBlock()}${END}\n`;
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (b < 0 || e < 0) throw new Error("cursors.css lacks the @generated-cursors markers");
  return existing.slice(0, b) + block + existing.slice(e + END.length + 1);
}

const existing = readFileSync(file, "utf8");
const next = renderCursorsCss(existing);
if (process.argv.includes("--check")) {
  if (next !== existing) {
    console.error("cursors.css is stale — run: node --import tsx scripts/gen-cursors.mjs");
    process.exit(1);
  }
  console.log("cursors.css is current");
} else if (next !== existing) {
  writeFileSync(file, next);
  console.log("wrote", path.relative(root, file));
} else console.log("cursors.css unchanged");
