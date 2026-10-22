#!/usr/bin/env -S npx tsx
// 2026-09-15 — the crosshair is the app's cursor. No component may bring the
// pointing hand back: `cursor: pointer` / `cursor: default` are banned in
// src/**, the family lives in styles/cursors.css, and app.css declares the
// global policy (interactive → dotted, text → I-beam). Pure: a source scan.
//   Run: npx tsx scripts/verify-cursor-policy.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { ARROW_HOTSPOT, CURSOR_DEFAULTS, CURSOR_FALLBACK, CURSOR_SCOPE, CURSOR_STATES, cursorVar } from "../src/lib/cursor/cursorFamily";

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
const hot = Math.floor(CURSOR_DEFAULTS.size / 2); // the middle pixel (the mark is centred on ITS centre)
const ARROW_STATES = new Set(["cross", "cross-hover", "cross-press", "move", "move-copy"]);
for (const state of CURSOR_STATES) {
  // the default family is the classic arrow: its arrow-shaped states carry the tip hotspot and a `default` fallback
  const arrow = CURSOR_DEFAULTS.style === "classic" && ARROW_STATES.has(state);
  const hx = arrow ? ARROW_HOTSPOT[0] : hot;
  const hy = arrow ? ARROW_HOTSPOT[1] : hot;
  const fb = arrow ? (state === "move-copy" ? "copy" : "default") : CURSOR_FALLBACK[state];
  for (const tone of ["light", "dark"] as const) {
    const v = cursorVar(state, tone);
    assert(new RegExp(`${v}: url\\("data:image/svg\\+xml,[^"]+"\\) ${hx} ${hy}, ${fb};`).test(cursors), `${v} is a hardware svg cursor with the ${hx} ${hy} hotspot and a ${fb} fallback`);
  }
  assert(cursors.includes(`  ${cursorVar(state)}: var(${cursorVar(state, "dark")});`), `${cursorVar(state)} defaults to the dark-surface drawing`);
}
// The bare names consumers use exist only inside the Figure and Slide editors:
// everywhere else `var(--cursor-…)` is undefined and `cursor` falls back to auto.
const scoped = cursors.split(`${CURSOR_SCOPE} {`)[1]?.split("}")[0] ?? "";
assert(scoped.includes(`${cursorVar("cross")}: var(${cursorVar("cross", "dark")});`) && !/^:root \{[^}]*--cursor-cross: var/m.test(cursors), "the bare-name mapping lives under the Figure/Slide scope, not on :root");
assert(/^:root \{[^}]*--cursor-cross-light: url/m.test(cursors), "the literal sets live on :root (the theme writer overrides them there)");
assert(/\.cursor-on-light \{[^}]*--cursor-cross: var\(--cursor-cross-light\);/.test(cursors) && /\.cursor-on-dark \{[^}]*--cursor-cross: var\(--cursor-cross-dark\);/.test(cursors), "the two tone classes repoint the bare names for their subtree");
assert(/<path d='M/.test(cursors.split("--cursor-cross-light: ")[1].split("\n")[0]) && /paint-order='stroke'/.test(cursors.split("--cursor-cross-light: ")[1].split("\n")[0]), "the default resting mark is the classic arrow: a filled path outlined underneath (paint-order stroke)");
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
assert(!/body \{[^}]*cursor:/s.test(app), "body declares NO cursor: Paper, Reader, Library, Home and the shell keep the system's (owner, 2026-10-21)");
assert(/\.figure-mode,\n\.slide-mode \{\n  cursor: var\(--cursor-cross\);/.test(app), "the Figure and Slide editors carry the family's resting mark");
assert(/:is\(\.figure-mode, \.slide-mode\) :is\(button, \[role="button"\], a,[^{]*\{\n  cursor: var\(--cursor-cross-hover\);/.test(app), "interactive elements inside the editors take the hover variant");
assert(/:is\(\.figure-mode, \.slide-mode\) :is\(button:active,[^{]*\{\n  cursor: var\(--cursor-cross-press\);/.test(app), "a pressed control inside the editors takes the press variant");
assert(/textarea,[\s\S]*?cursor: text;/.test(app), "text fields keep the I-beam");
const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
assert(/import "\.\/styles\/cursors\.css";/.test(main), "main.ts loads the cursor family");
console.log("VERIFY-CURSOR-POLICY PASS");
