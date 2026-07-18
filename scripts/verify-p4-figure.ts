#!/usr/bin/env -S npx tsx
// Phase 4 — Figure bug sweep. The flagship correctness fix (FIG-2) is tested for real against
// the pure exporter; the rest (store/DOM/component-bound) are asserted present here and covered
// by svelte-check + the figure regressions.
//
//  FIG-2  (tested): rotate/flip pivots on the element's TRUE bbox centre. Lines/arrows carry
//         width/height 0, so the old `e.x + width/2` pivoted on endpoint 1 — a rotated line swung
//         about its end, wrong on screen AND in every export. Now both Element.svelte and
//         export.ts use elementBBox() centre. A rect (real width/height) is unchanged.
//  FIG-3  (presence): paste remaps groupId so pasted copies aren't group-linked to the source.
//  FIG-10 (presence): setting W/H on auto-width text switches it to a fixed box (fields were dead).
//  FIG-11 (presence): prefixIds rewrites url(#…) in inline styles + <style> blocks (plot collisions).
//  FIG-13 (presence): pruneSelection clears a dangling selectedFrameId after undo.
//  FIG-14 (presence): plot regenerate surfaces the real recipe stderr / parse error.
//   Run: npx tsx scripts/verify-p4-figure.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { figureToSvg } from "../src/lib/export";
import type { Figure, LineElement, RectElement } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// --- FIG-2: rotate pivot is the bbox centre, for a line AND a rect --------------------------
const line: LineElement = {
  id: "l1", type: "line", x: 0, y: 0, width: 0, height: 0, rotation: 90,
  x1: 10, y1: 10, x2: 110, y2: 50, stroke: "#000", strokeWidth: 2, arrowStart: false, arrowEnd: false,
};
// bbox = x[10..110], y[10..50] → centre (60, 30). The OLD code used e.x + width/2 = 0 → wrong.
const rect: RectElement = {
  id: "r1", type: "rect", x: 20, y: 40, width: 100, height: 40, rotation: 90,
  fill: "#eee", stroke: "#000", strokeWidth: 1, cornerRadius: 0,
};
// rect centre = (20+50, 40+20) = (70, 60) — unchanged by the fix (real width/height).
const figLine: Figure = { id: "f", name: "f", x: 0, y: 0, width: 200, height: 200, elements: [line] };
const figRect: Figure = { id: "f", name: "f", x: 0, y: 0, width: 200, height: 200, elements: [rect] };

const svgLine = figureToSvg(figLine, () => undefined);
const svgRect = figureToSvg(figRect, () => undefined);

assert(svgLine.includes("rotate(90 60 30)"), "FIG-2: rotated LINE pivots on its bbox centre (60,30), not endpoint 1");
assert(!svgLine.includes("rotate(90 0 0)"), "FIG-2: the line no longer pivots on (0,0)/endpoint");
assert(svgRect.includes("rotate(90 70 60)"), "FIG-2: rotated RECT still pivots on its centre (70,60) — unchanged");

// --- presence of the store/DOM/component-bound fixes ---------------------------------------
const read = (p: string) => fs.readFile(path.join(import.meta.dirname, "..", p), "utf8");
const [keyboard, opsSrc, parse, store, xray] = await Promise.all([
  read("src/lib/keyboard.ts"),
  // FIG-10's setDim moved from Inspector.svelte to ops.setBoxDim (2026-07-18,
  // aspect-lock fix — the Inspector and the FluxFig menu now share it).
  read("src/lib/ops.ts"),
  read("src/lib/plot/parse.ts"),
  read("src/lib/store.ts"),
  // P8: PlotXray.svelte became the unified Xray.svelte — the FIG-14 regenerate
  // contract (real stderr / parse error surfaced) moved with it, unchanged.
  read("src/lib/Xray.svelte"),
]);
// (P7: the hand-rolled groupRemap loop became the shared groups.ts
// cloneGroupsFor — same FIG-3 contract, one core; behavior covered for real in
// figenh-16-groups.ts / figenh-16-parity.ts.)
assert(/cloneGroupsFor\(clipboardGroups, clipboard, remap\)/.test(keyboard) && /paste/.test(keyboard), "FIG-3: paste() remaps group ids (via cloneGroupsFor)");
// FIG-10 (v2, figure-v1 P3): sizing modes replaced autoWidth — a manual W on a
// hugging box switches it to wrap ("auto-h"), a manual H pins it "fixed";
// otherwise applyTextLayout would re-hug and overwrite the typed value.
assert(
  /if \(which === "h"\) el\.sizing = "fixed";/.test(opsSrc) &&
    /else if \(el\.sizing === "auto"\) el\.sizing = "auto-h";/.test(opsSrc),
  "FIG-10: setBoxDim W→auto-h (wrap) / H→fixed on text (fields stay live)",
);
assert(/getAttribute\("style"\)/.test(parse) && /querySelectorAll\("style"\)/.test(parse), "FIG-11: prefixIds rewrites inline styles + <style> blocks");
assert(/selectedFrameId\.update\(\(id\) =>/.test(store), "FIG-13: pruneSelection clears a dangling selectedFrameId");
assert(/regenMsg = "error: "/.test(xray) && /res\.stderr/.test(xray), "FIG-14: regenerate surfaces the real failure");

console.log("\nP4 FIGURE VERIFY: PASS");
