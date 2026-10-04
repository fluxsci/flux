#!/usr/bin/env -S npx tsx
// 2026-10-04 — the in-plot marquee law (src/lib/plot/partMarquee.ts), the ONE
// pure module behind the Figure canvas's ctrl-drag inside a plot AND the Become
// picker's leaf level (pickModel.marqueeUnits builds on it; verify-become-picker
// pins that layer). Hermetic: fixture manifests only.
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-part-marquee
import * as fs from "node:fs";
import * as path from "node:path";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import { boxFrom, isDataRole, leafPartIds, partIndexOf, partsInside, preferData, rectInside, type PartBoxCandidate } from "../src/lib/plot/partMarquee";
import { isScaffoldPart } from "../src/lib/plot/partStyle";
import { buildPartTree } from "../src/lib/plot/tree";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const J = (v: unknown) => JSON.stringify(v);
const here = import.meta.dirname;
const SCATTER = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pre-regen", "06_scatter_regression.fluxplot.json"), "utf8")) as FluxPlotManifest;

// (1) rectInside: fully inside with a half-pixel tolerance; touching edges count, overlap doesn't.
{
  const box = { x: 10, y: 10, w: 100, h: 50 };
  assert(rectInside({ x: 20, y: 20, w: 10, h: 10 }, box), "a rect well inside is inside");
  assert(rectInside({ x: 10, y: 10, w: 100, h: 50 }, box), "the box itself is inside");
  assert(rectInside({ x: 9.6, y: 10, w: 100.4, h: 50 }, box), "half a pixel over an edge still counts (anti-aliased edges)");
  assert(!rectInside({ x: 5, y: 20, w: 10, h: 10 }, box), "a rect straddling the left edge is out");
  assert(!rectInside({ x: 100, y: 20, w: 20, h: 10 }, box), "a rect straddling the right edge is out");
  assert(J(boxFrom({ x: 50, y: 60 }, { x: 10, y: 20 })) === J({ x: 10, y: 20, w: 40, h: 40 }), "boxFrom normalizes any corner order");
}

// (2) partsInside: fully-inside leaves, data preferred, zero-area never, paint order kept.
{
  const cands: PartBoxCandidate[] = [
    { partId: "axis.x.tick.1", rect: { x: 12, y: 12, w: 2, h: 6 }, data: false },
    { partId: "s0.point.0", rect: { x: 60, y: 20, w: 6, h: 6 }, data: true },
    { partId: "axis.x.ticklabel.1", rect: { x: 12, y: 30, w: 14, h: 8 }, data: false },
    { partId: "s0.point.1", rect: { x: 40, y: 20, w: 6, h: 6 }, data: true },
    { partId: "s0.point.2", rect: { x: 95, y: 20, w: 10, h: 6 }, data: true }, // straddles the right edge
    { partId: "axis.x.gridline.1", rect: { x: 30, y: 0, w: 0, h: 0 }, data: false }, // zero area
  ];
  const box = { x: 10, y: 10, w: 90, h: 40 };
  assert(J(partsInside(cands, box)) === J(["s0.point.0", "s0.point.1"]), "data marks inside win; furniture inside is left out; a straddling mark and a zero-area box never count");
  const furnitureOnly = { x: 10, y: 10, w: 20, h: 40 };
  assert(J(partsInside(cands, furnitureOnly)) === J(["axis.x.tick.1", "axis.x.ticklabel.1"]), "with no data mark inside, the furniture inside is picked, in paint order");
  assert(J(partsInside(cands, { x: 200, y: 200, w: 10, h: 10 })) === J([]), "an empty box picks nothing");
  assert(J(preferData([{ data: false }, { data: false }])) === J([{ data: false }, { data: false }]), "preferData keeps a furniture-only set whole");
  assert(J(preferData([{ data: false, id: 1 }, { data: true, id: 2 }])) === J([{ data: true, id: 2 }]), "preferData drops furniture once a data mark is present");
}

// (3) roles: the furniture list is the picker's; everything else is data.
{
  assert(!isDataRole("tick") && !isDataRole("tick-label") && !isDataRole("gridline") && !isDataRole("legend-entry"), "guide furniture roles are not data");
  assert(isDataRole("point") && isDataRole("bar") && isDataRole("line") && isDataRole("hexagon"), "marks are data");
  assert(!isDataRole(undefined) && !isDataRole(""), "an unknown part is not a data mark");
}

// (4) leafPartIds over a real manifest: every concrete leaf, no scaffold, tree order, memoized.
{
  const leaves = leafPartIds(SCATTER);
  const all = [...new Set(buildPartTree(SCATTER)?.targets ?? [])];
  assert(leaves.length > 20 && leaves.length <= all.length, `the scatter fixture has ${leaves.length} marquee-able leaves (of ${all.length} tree leaves)`);
  assert(leaves.every((pid) => !isScaffoldPart(SCATTER, pid)), "no scaffold part is a marquee candidate");
  assert(J(leaves) === J(all.filter((pid) => !isScaffoldPart(SCATTER, pid))), "leaves are the tree's leaves in tree order minus scaffold");
  assert(leaves.includes("axis.x.ticklabel.2") && leaves.includes("axis.y.tick.3"), "tick labels and ticks are leaves");
  assert(leafPartIds(SCATTER) === leaves, "memoized per manifest identity");
  assert(J(leafPartIds(undefined)) === J([]), "no manifest → no leaves");
  const idx = partIndexOf(SCATTER);
  assert(idx["axis.x.ticklabel.2"]?.role === "tick-label" && !isDataRole(idx["axis.x.ticklabel.2"]?.role), "the index names a tick label's role as furniture");
  assert(partIndexOf(SCATTER) === idx && J(partIndexOf(undefined)) === J({}), "the part index is memoized; no manifest → empty index");
  const dataLeaves = leaves.filter((pid) => isDataRole(idx[pid]?.role));
  assert(dataLeaves.length > 0, `the fixture has ${dataLeaves.length} data-mark leaves (series marks) among its candidates`);
}

console.log("verify-part-marquee: all checks passed");
