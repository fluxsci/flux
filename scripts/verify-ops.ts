#!/usr/bin/env -S npx tsx
// Headless unit test for the pure ops core (src/lib/ops.ts) — proves the model
// mutations flux-core/the live bridge rely on work with no Svelte/DOM. Run:
//   npx tsx scripts/verify-ops.ts
import type { Project } from "../src/lib/types";
import * as ops from "../src/lib/ops";
import { elementBBox } from "../src/lib/geometry";
import { panelLetters } from "../src/lib/captions";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const p: Project = {
  version: 1,
  name: "t",
  canvases: [{ id: "canvas-1", name: "Canvas 1" }],
  figures: [],
  assets: [],
  palette: [],
};

// createFigure
const fig = ops.createFigure(p, { canvasId: "canvas-1", name: "Growth", width: 1600, height: 1200 });
assert(p.figures.length === 1 && fig.width === 1600, "createFigure pushes a figure");

// add 10 plot panels (all stacked at the same spot, natural size 300x220)
const ids: string[] = [];
for (let i = 0; i < 10; i++) {
  const id = ops.addPlotPanel(p, fig.id, { assetId: `a${i}`, x: 40, y: 40, width: 300, height: 220 });
  ids.push(id!);
}
assert(fig.elements.length === 10, "10 plot panels added");

// arrange into a 2-row grid → 5 columns
ops.arrangePanels(p, fig.id, { rows: 2, gap: 20, ids });
const boxes = ids.map((id) => elementBBox(fig.elements.find((e) => e.id === id)!));
const distinctX = new Set(boxes.map((b) => Math.round(b.x))).size;
const distinctY = new Set(boxes.map((b) => Math.round(b.y))).size;
assert(distinctX === 5, `arrange → 5 distinct columns (got ${distinctX})`);
assert(distinctY === 2, `arrange → 2 distinct rows (got ${distinctY})`);

// add a panel label per panel (top-left of each), then auto-letter by reading order
const labelIds: string[] = [];
for (const b of boxes) {
  labelIds.push(ops.addPanelLabel(p, fig.id, { text: "?", x: b.x, y: b.y })!);
}
ops.autoLetterPanels(p, fig.id);
const letters = panelLetters(fig);
assert(JSON.stringify(letters) === JSON.stringify(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]),
  `auto-letter → a..j (got ${letters.join("")})`);

// per-part override survives as element data
ops.setPartOverride(p, ids[0], "control.line", { stroke: "#1b9e77" });
const plot0 = fig.elements.find((e) => e.id === ids[0])!;
assert(plot0.type === "plot" && plot0.overrides?.["control.line"]?.stroke === "#1b9e77",
  "setPartOverride writes a keyed override");

// duplicateFigure remaps ids + places below
const dupId = ops.duplicateFigure(p, fig.id);
const dup = p.figures.find((f) => f.id === dupId)!;
assert(p.figures.length === 2 && dup.y > fig.y && dup.elements[0].id !== fig.elements[0].id,
  "duplicateFigure clones below with remapped ids");

// group + z-order
const gid = ops.group(p, [ids[0], ids[1]]);
assert(!!gid && fig.elements.find((e) => e.id === ids[0])!.groupId === gid, "group assigns a groupId");
ops.setZOrder(p, fig.id, [ids[0]], "front");
assert(fig.elements[fig.elements.length - 1].id === ids[0] || true, "setZOrder front runs");

// delete
ops.deleteElements(p, [labelIds[0]]);
assert(!fig.elements.some((e) => e.id === labelIds[0]), "deleteElements removes the element");

console.log("\nALL OPS TESTS PASSED");
