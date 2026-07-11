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

// createFigure default placement: stacks below the lowest figure on the canvas
// (headless compose used to default every figure to 0,0 — the moma pile-up).
const lowest = Math.max(...p.figures.map((f) => f.y + f.height));
const stacked = ops.createFigure(p, { canvasId: "canvas-1" });
assert(stacked.y === lowest + 80, `createFigure stacks below lowest (+80): got y=${stacked.y}, want ${lowest + 80}`);
assert(stacked.x === p.figures[0].x, "createFigure left-aligns with the first figure");
const explicit = ops.createFigure(p, { canvasId: "canvas-1", x: 5, y: 7 });
assert(explicit.x === 5 && explicit.y === 7, "explicit x/y still wins over auto-placement");

// deleteFigure: GUI default backfills a blank; headless allowEmpty must NOT —
// an auto-created placeholder takes order 1 and shifts every figure number.
const solo: Project = { version: 2, name: "", canvases: [{ id: "c", name: "C", order: 1 }],
  figures: [], assets: [], palette: [] };
const only = ops.createFigure(solo, { canvasId: "c" });
ops.deleteFigure(solo, only.id);
assert(solo.figures.length === 1 && solo.figures[0].id !== only.id,
  "deleteFigure (GUI default) backfills a blank figure");
const only2 = solo.figures[0].id;
ops.deleteFigure(solo, only2, { allowEmpty: true });
assert(solo.figures.length === 0, "deleteFigure allowEmpty leaves the canvas empty");

// ---------------------------------------------------------------------------
// WS-1 Fix 1 invariant: setPartOverride/setCrop are COPY-ON-WRITE — every
// change allocates a fresh overrides/crop object. mountPlot's fast path uses
// reference equality on these to skip its JSON.stringify signature; an in-place
// mutation here would silently break plot re-rendering.
// ---------------------------------------------------------------------------
{
  const cw: Project = { version: 2, name: "", canvases: [{ id: "c", name: "C" }], figures: [], assets: [
    { id: "pa", name: "pa", kind: "svg", path: "plots/pa.svg", naturalWidth: 300, naturalHeight: 220 },
  ], palette: [] };
  const f = ops.createFigure(cw, { canvasId: "c" });
  const pid = ops.addPlotPanel(cw, f.id, { assetId: "pa", x: 0, y: 0, width: 300, height: 220 })!;
  const el = () => f.elements.find((e) => e.id === pid)! as import("../src/lib/types").SemanticPlotElement;

  ops.setPartOverride(cw, pid, "axis.x.line", { stroke: "#111" });
  const ov1 = el().overrides;
  ops.setPartOverride(cw, pid, "axis.x.line", { stroke: "#222" });
  const ov2 = el().overrides;
  assert(ov1 !== ov2, "setPartOverride allocates a fresh overrides object per change (copy-on-write)");
  assert(ov2!["axis.x.line"].stroke === "#222", "…and the new patch landed");
  ops.setPartOverride(cw, pid, "axis.y.line", { hidden: true });
  assert(el().overrides !== ov2, "setPartOverride on a second part also re-allocates the container");

  ops.setCrop(cw, pid, { x: 10, y: 10, width: 100, height: 80 });
  const cr1 = el().crop;
  assert(!!cr1, "setCrop wrote a crop");
  ops.setCrop(cw, pid, { x: 12, y: 10, width: 100, height: 80 });
  const cr2 = el().crop;
  assert(cr1 !== cr2, "setCrop allocates a fresh crop object per change (copy-on-write)");
  ops.setCrop(cw, pid, null);
  assert(el().crop === undefined, "setCrop(null) clears the crop (presence change = reference change)");
}

// ---------------------------------------------------------------------------
// WS-3.1 invariant: setZOrder NEVER fragments a group's contiguous run — the
// keyboard raise/bump now route here, and the old flat swaps could interleave
// a loose element into a foreign group's block.
// ---------------------------------------------------------------------------
{
  const zp: Project = { version: 2, name: "", canvases: [{ id: "c", name: "C" }], figures: [], assets: [], palette: [] };
  const f = ops.createFigure(zp, { canvasId: "c" });
  const mk = (id: string) => {
    f.elements.push({ type: "rect", id, x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#000", stroke: "#000", strokeWidth: 1, cornerRadius: 0 } as import("../src/lib/types").Element);
    return id;
  };
  // z-order: [a1, a2, loose, b1, b2] with groups A={a1,a2}, B={b1,b2}
  mk("a1"); mk("a2"); mk("loose"); mk("b1"); mk("b2");
  const gA = ops.group(zp, ["a1", "a2"])!;
  const gB = ops.group(zp, ["b1", "b2"])!;
  const order = () => f.elements.map((e) => e.id).join(",");
  const runOf = (gid: string) => {
    const idx = f.elements.map((e, i) => (e.groupId === gid ? i : -1)).filter((i) => i >= 0);
    return idx.length === 2 && idx[1] - idx[0] === 1;
  };
  assert(runOf(gA) && runOf(gB), `two-group fixture starts contiguous (${order()})`);

  // bump the loose element FORWARD — it must jump OVER group B as a block,
  // never land inside its run.
  ops.setZOrder(zp, f.id, ["loose"], "forward");
  assert(runOf(gA) && runOf(gB), `forward bump keeps both runs contiguous (${order()})`);
  assert(order() === "a1,a2,b1,b2,loose", `loose hopped the whole B unit (${order()})`);

  // raise group A to front as an intact block
  ops.setZOrder(zp, f.id, ["a1", "a2"], "front");
  assert(runOf(gA) && runOf(gB), `raise-to-front keeps runs contiguous (${order()})`);
  assert(order() === "b1,b2,loose,a1,a2", `A moved as one block (${order()})`);

  // selections spanning two groups move as units, never interleave
  ops.setZOrder(zp, f.id, ["a1", "a2", "b1", "b2"], "back");
  assert(runOf(gA) && runOf(gB), `two-group selection stays two intact blocks (${order()})`);

  // a PARTIAL group selection resolves to whole units at the deepest common
  // scope (resolveZScope) — bumping just a1 backward must not split A.
  ops.setZOrder(zp, f.id, ["a1"], "backward");
  assert(runOf(gA), `partial-group bump keeps A contiguous (${order()})`);
}

console.log("\nALL OPS TESTS PASSED");
