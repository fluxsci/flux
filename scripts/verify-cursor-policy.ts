#!/usr/bin/env -S npx tsx
// 2026-09-15 — the crosshair is the app's cursor. No component may bring the
// pointing hand back: `cursor: pointer` / `cursor: default` are banned in
// src/**, the family lives in styles/cursors.css, and app.css declares the
// global policy (interactive → dotted, text → I-beam). Pure: a source scan.
//   Run: npx tsx scripts/verify-cursor-policy.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const root = path.join(import.meta.dirname, "..");
const files: string[] = [];
(function walk(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(svelte|css|ts)$/.test(f)) files.push(p);
  }
})(path.join(root, "src"));
// The exported / embedded slide players run OUTSIDE the app's stylesheet (a
// reader's page, a bare HTML export), so they keep the platform pointer.
const OUTSIDE_THE_APP = [/src\/lib\/slide\/embedPlayer\.ts$/, /src\/lib\/slide\/export\//, /src\/lib\/slide\/player\/media\.ts$/];
const offenders: string[] = [];
for (const f of files) {
  // Compare POSIX: the exemptions are written with forward slashes, and on
  // Windows a backslash path matched none of them — every exempt player read
  // as an offender (2026-09-22).
  const posix = f.split(path.sep).join("/");
  if (OUTSIDE_THE_APP.some((re) => re.test(posix))) continue;
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(/cursor:\s*(pointer|default)\b/g)) offenders.push(`${path.relative(root, f)}: ${m[0]}`);
}
assert(offenders.length === 0, `no component says cursor: pointer / default (${offenders.length}: ${offenders.slice(0, 3).join("; ")})`);
const cursors = readFileSync(path.join(root, "src/styles/cursors.css"), "utf8");
for (const v of ["--cursor-cross", "--cursor-cross-hover", "--cursor-cross-press"]) {
  assert(new RegExp(`${v}: url\\("data:image/svg\\+xml,[^"]+"\\) 12 12, crosshair;`).test(cursors), `${v} is a hardware svg cursor with the 12 12 hotspot and a crosshair fallback`);
}
assert(/<circle/.test(decodeURIComponent(cursors.split("--cursor-cross-hover")[1].split("\n")[0])) && !/<circle/.test(decodeURIComponent(cursors.split("--cursor-cross: ")[1].split("\n")[0])), "the hover variant carries the dot, the plain one does not");
const app = readFileSync(path.join(root, "src/app.css"), "utf8");
assert(/body \{[^}]*cursor: var\(--cursor-cross\);/s.test(app), "body uses the plain crosshair");
assert(/button,\n\[role="button"\],\na,[\s\S]*?cursor: var\(--cursor-cross-hover\);/.test(app), "interactive elements get the dotted variant globally");
assert(/textarea,[\s\S]*?cursor: text;/.test(app), "text fields keep the I-beam");
assert(/button:active,[\s\S]*?cursor: var\(--cursor-cross-press\);/.test(app), "a pressed control contracts the crosshair");
const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
assert(/import "\.\/styles\/cursors\.css";/.test(main), "main.ts loads the cursor family");
console.log("VERIFY-CURSOR-POLICY PASS");
