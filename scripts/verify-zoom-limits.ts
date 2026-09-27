#!/usr/bin/env -S npx tsx
// 2026-09-25 — the editor's zoom range lives in ONE module (src/lib/interact/zoomLimits.ts)
// and every user-input zoom route clamps through it. The owner raised the ceiling from 16×
// to 256×: this pins the range so it is never quietly lowered again, and pins the sharing so
// the wheel and the toolbar cannot drift apart (each used to carry its own literal clamp).
//   Run: node --import tsx scripts/verify-zoom-limits.ts
import { readFileSync } from "node:fs";
import { ZOOM_MIN, ZOOM_MAX, clampZoom } from "../src/lib/interact/zoomLimits";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-zoom-limits");

h.section("range");
h.ok(ZOOM_MAX >= 256, `ceiling is at least 256× (owner request 2026-09-25) — got ${ZOOM_MAX}×`);
h.ok(ZOOM_MIN > 0 && ZOOM_MIN <= 0.05, `floor is a positive zoom no higher than 5% — got ${ZOOM_MIN}`);
h.eq(clampZoom(1e9), ZOOM_MAX, "above the ceiling clamps to the ceiling");
h.eq(clampZoom(ZOOM_MAX * 1.25), ZOOM_MAX, "one toolbar step past the ceiling clamps to the ceiling");
h.eq(clampZoom(0), ZOOM_MIN, "zero clamps to the floor");
h.eq(clampZoom(-3), ZOOM_MIN, "a negative zoom clamps to the floor");
for (const z of [ZOOM_MIN, 0.6, 1, 16, 100, ZOOM_MAX]) h.eq(clampZoom(z), z, `${z}× inside the range passes through unchanged`);

h.section("every user-input route shares the clamp");
const canvas = readFileSync("src/lib/Canvas.svelte", "utf8");
const toolbar = readFileSync("src/lib/Toolbar.svelte", "utf8");
h.ok(/from "\.\/interact\/zoomLimits"/.test(canvas) && /clampZoom\(\$viewport\.zoom \* factor\)/.test(canvas), "Canvas.svelte's Ctrl-wheel clamps through clampZoom");
h.ok(/from "\.\/interact\/zoomLimits"/.test(toolbar) && (toolbar.match(/setZoom\(clampZoom\(/g) ?? []).length === 2, "Toolbar.svelte's − and + buttons both clamp through clampZoom");
h.ok(!/\b(MIN|MAX)_ZOOM\b/.test(canvas + toolbar), "no private zoom-limit constants survive in the editor or toolbar");
h.ok(!/Math\.(min|max)\(\s*[\d.]+\s*,\s*\$viewport\.zoom/.test(canvas + toolbar), "no literal clamp on $viewport.zoom survives outside zoomLimits.ts");

await h.done();
