#!/usr/bin/env -S npx tsx
// 2026-09-15 — the crosshair is the app's cursor. No component may bring the
// pointing hand back: `cursor: pointer` / `cursor: default` are banned in
// src/**, the family lives in styles/cursors.css, and app.css declares the
// global policy (interactive → dotted, text → I-beam). Pure: a source scan.
//   Run: npx tsx scripts/verify-cursor-policy.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { CURSOR_DEFAULTS, CURSOR_FALLBACK, CURSOR_STATES, cursorVar } from "../src/lib/cursor/cursorFamily";

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
// 2026-10-21: the family is generated (src/lib/cursor/cursorFamily.ts) — every
// state is a hardware svg cursor with the hotspot at the mark's centre and its
// own OS fallback; verify-cursor-family pins the drawing itself.
// Two literal sets (drawn for light / dark surfaces) and a static mapping: the
// bare names point at the dark set (the app is dark), `.cursor-on-light` and
// `.cursor-on-dark` repoint them for a subtree. Static CSS — nothing per hover.
const hot = CURSOR_DEFAULTS.size / 2;
for (const state of CURSOR_STATES) {
  for (const tone of ["light", "dark"] as const) {
    const v = cursorVar(state, tone);
    assert(new RegExp(`${v}: url\\("data:image/svg\\+xml,[^"]+"\\) ${hot} ${hot}, ${CURSOR_FALLBACK[state]};`).test(cursors), `${v} is a hardware svg cursor with the ${hot} ${hot} hotspot and a ${CURSOR_FALLBACK[state]} fallback`);
  }
  assert(cursors.includes(`  ${cursorVar(state)}: var(${cursorVar(state, "dark")});`), `${cursorVar(state)} defaults to the dark-surface drawing`);
}
assert(/\.cursor-on-light \{[^}]*--cursor-cross: var\(--cursor-cross-light\);/.test(cursors) && /\.cursor-on-dark \{[^}]*--cursor-cross: var\(--cursor-cross-dark\);/.test(cursors), "the two tone classes repoint the bare names for their subtree");
assert(/<circle/.test(cursors.split("--cursor-cross-hover-light: ")[1].split("\n")[0]) && !/<circle/.test(cursors.split("--cursor-cross-light: ")[1].split("\n")[0]), "the hover variant carries the dot, the plain one does not");
// 2026-10-21: on the canvas itself every cursor is the family — guides, rulers,
// path nodes, the figure title bar and the node-insert markers included — so
// the owner never sees an OS crosshair or three different "move" drawings
// beside the mark. Only the host's pan (grab/grabbing) and the text tool keep
// OS cursors, and those live in the host's JS value, not in the stylesheet.
const canvas = readFileSync(path.join(root, "src/lib/Canvas.svelte"), "utf8");
const canvasStyle = canvas.slice(canvas.lastIndexOf("<style"));
const osInCanvas = [...canvasStyle.matchAll(/cursor:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => !v.startsWith("var(--cursor-"));
assert(osInCanvas.length === 0, `Canvas.svelte's stylesheet uses only the cursor family (${osInCanvas.length} OS cursor(s): ${osInCanvas.join(", ")})`);
const app = readFileSync(path.join(root, "src/app.css"), "utf8");
assert(/body \{[^}]*cursor: var\(--cursor-cross\);/s.test(app), "body uses the plain crosshair");
assert(/button,\n\[role="button"\],\na,[\s\S]*?cursor: var\(--cursor-cross-hover\);/.test(app), "interactive elements get the dotted variant globally");
assert(/textarea,[\s\S]*?cursor: text;/.test(app), "text fields keep the I-beam");
assert(/button:active,[\s\S]*?cursor: var\(--cursor-cross-press\);/.test(app), "a pressed control contracts the crosshair");
const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
assert(/import "\.\/styles\/cursors\.css";/.test(main), "main.ts loads the cursor family");
console.log("VERIFY-CURSOR-POLICY PASS");
