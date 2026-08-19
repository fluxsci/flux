// Figure ORDER — the pure contract behind the sidebar's drag-to-reorder and the
// Alt+↑/↓ chord (src/lib/ops.ts reorderFigures + the store's selectedFigureIds
// fallback). The order is the model's array order per canvas: planFigSave
// numbers `order` from it and writes the canvas file in it, so the list order
// the user drags is what round-trips through fig/.
//
// What must hold, and why:
//   • order changes, NOTHING else — no geometry (the figure must not move on
//     the canvas) and no family/number (renumbering stays the namer's job)
//   • a multi-row pick moves as ONE block, relative order kept, even when the
//     picked rows were not adjacent
//   • other canvases are untouched — their figures keep their exact slots in
//     the shared p.figures array
//   • the round trip through the shared persistence core preserves it
//   Run: npx tsx scripts/verify-fig-order.ts
import { harness } from "./lib/harness.mjs";
import * as ops from "../src/lib/ops";
import { planFigSave } from "../src/lib/project/figfiles";
import type { Figure, Project } from "../src/lib/types";

const h = harness("verify-fig-order");

function fig(id: string, canvasId = "c1", n = 1): Figure {
  return {
    id,
    name: `Figure ${n}`,
    family: "figure",
    number: n,
    canvasId,
    x: n * 10,
    y: n * 20,
    width: 400,
    height: 300,
    background: "#ffffff",
    elements: [],
  } as Figure;
}

function project(figs: Figure[]): Project {
  return {
    version: 2,
    name: "order",
    canvases: [
      { id: "c1", name: "Canvas 1" },
      { id: "c2", name: "Canvas 2" },
    ],
    figures: figs,
    assets: [],
    palette: [],
  } as unknown as Project;
}

const order = (p: Project, canvasId = "c1") =>
  p.figures.filter((f) => f.canvasId === canvasId).map((f) => f.id);

const four = () => project([fig("a", "c1", 1), fig("b", "c1", 2), fig("c", "c1", 3), fig("d", "c1", 4)]);

// --- single-figure moves ------------------------------------------------------
h.section("one figure");
{
  const p = four();
  ops.reorderFigures(p, ["c"], 1);
  h.eq(order(p), ["a", "c", "b", "d"], "fig 3 lands above fig 2 (the ask)");
}
{
  const p = four();
  ops.reorderFigures(p, ["a"], 3);
  h.eq(order(p), ["b", "c", "d", "a"], "move to the end");
}
{
  const p = four();
  ops.reorderFigures(p, ["d"], 0);
  h.eq(order(p), ["d", "a", "b", "c"], "move to the front");
}
{
  const p = four();
  ops.reorderFigures(p, ["b"], 99);
  h.eq(order(p), ["a", "c", "d", "b"], "an out-of-range target clamps to the end");
  ops.reorderFigures(p, ["b"], -5);
  h.eq(order(p), ["b", "a", "c", "d"], "a negative target clamps to the front");
}
{
  const p = four();
  ops.reorderFigures(p, ["b"], 1);
  h.eq(order(p), ["a", "b", "c", "d"], "moving a figure onto itself is a no-op");
  ops.reorderFigures(p, ["ghost"], 0);
  h.eq(order(p), ["a", "b", "c", "d"], "an unknown id changes nothing");
  ops.reorderFigures(p, [], 0);
  h.eq(order(p), ["a", "b", "c", "d"], "an empty pick changes nothing");
}

// --- multi-figure picks -------------------------------------------------------
h.section("several figures at once");
{
  const p = four();
  ops.reorderFigures(p, ["c", "d"], 0);
  h.eq(order(p), ["c", "d", "a", "b"], "a contiguous pair moves as one block");
}
{
  const p = four();
  ops.reorderFigures(p, ["d", "c"], 0);
  h.eq(order(p), ["c", "d", "a", "b"], "the pick's own order is irrelevant — list order is kept");
}
{
  const p = four();
  ops.reorderFigures(p, ["a", "c"], 2);
  h.eq(order(p), ["b", "d", "a", "c"], "a non-adjacent pick lands contiguous, relative order kept");
}
{
  const p = four();
  ops.reorderFigures(p, ["a", "b", "c", "d"], 0);
  h.eq(order(p), ["a", "b", "c", "d"], "picking everything is a no-op");
}

// --- what must NOT change -----------------------------------------------------
h.section("order only");
{
  const p = four();
  const before = p.figures.map((f) => ({ id: f.id, x: f.x, y: f.y, family: f.family, number: f.number, name: f.name }));
  ops.reorderFigures(p, ["a", "c"], 2);
  const after = new Map(p.figures.map((f) => [f.id, f]));
  h.ok(
    before.every((b) => after.get(b.id)!.x === b.x && after.get(b.id)!.y === b.y),
    "geometry is untouched — the figure stays where it sits on the canvas",
  );
  h.ok(
    before.every(
      (b) =>
        after.get(b.id)!.family === b.family &&
        after.get(b.id)!.number === b.number &&
        after.get(b.id)!.name === b.name,
    ),
    "family / number / name are untouched — renumbering stays the namer's job",
  );
}

// --- canvas isolation ---------------------------------------------------------
h.section("canvases");
{
  const p = project([
    fig("a", "c1", 1),
    fig("x", "c2", 1),
    fig("b", "c1", 2),
    fig("y", "c2", 2),
    fig("c", "c1", 3),
  ]);
  ops.reorderFigures(p, ["c"], 0);
  h.eq(order(p, "c1"), ["c", "a", "b"], "reordering canvas 1 reorders canvas 1");
  h.eq(order(p, "c2"), ["x", "y"], "…and leaves canvas 2's order alone");
  h.eq(
    p.figures.map((f) => f.canvasId),
    ["c1", "c2", "c1", "c2", "c1"],
    "other canvases keep their exact slots in the shared array (interleaving preserved)",
  );
}
{
  const p = project([fig("a", "c1", 1), fig("b", "c1", 2), fig("x", "c2", 1)]);
  ops.reorderFigures(p, ["b", "x"], 0);
  h.eq(order(p, "c1"), ["b", "a"], "a foreign-canvas id in the pick is ignored, not moved");
  h.eq(order(p, "c2"), ["x"], "…and its own canvas is untouched");
}

// --- it persists --------------------------------------------------------------
h.section("round trip through the fig/ writer");
{
  const p = four();
  ops.reorderFigures(p, ["d"], 0);
  const plan = planFigSave(p, null);
  const index = JSON.parse(plan.index.text) as { figures: { id: string; order: number }[] };
  h.eq(
    index.figures.map((f) => f.id),
    ["d", "a", "b", "c"],
    "index.json lists the figures in the new order",
  );
  h.eq(
    index.figures.map((f) => f.order),
    [1, 2, 3, 4],
    "…with `order` renumbered 1..N from it",
  );
  const canvas = JSON.parse(plan.canvases[0].text) as { figures: { id: string }[] };
  h.eq(
    canvas.figures.map((f) => f.id),
    ["d", "a", "b", "c"],
    "the canvas file (what the loader reads back) carries the same order",
  );
}

await h.done();
