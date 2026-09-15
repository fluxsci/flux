#!/usr/bin/env -S npx tsx
// 2026-09-15 — the MULTI-PLOT X-ray (pure). buildXrayTree's `elements` root:
//   (a) N plots x-ray as one synthetic "N plots" row whose children are the
//       plots' own element rows (each expanding in place), top-z first;
//   (b) commonPartRows lists the parts EVERY plot shares (id + role agree),
//       in the first plot's tree order, with the per-plot hidden count;
//   (c) a single surviving plot collapses to the ordinary element root and a
//       missing plot is skipped; targetLabel names the set.
//   Run: npx tsx scripts/verify-xray-multi.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { buildXrayTree, commonPartRows, commonPartIds, targetLabel } = await import("../src/lib/xray/buildXrayTree");
const { buildPartTree } = await import("../src/lib/plot/tree");
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Figure, Project, RectElement, SemanticPlotElement } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const here = import.meta.dirname;
const SCATTER = JSON.parse(await fs.readFile(path.join(here, "fixtures", "pre-regen", "06_scatter_regression.fluxplot.json"), "utf8")) as FluxPlotManifest;
const ECDF = JSON.parse(await fs.readFile(path.join(here, "fixtures", "pre-regen", "08_ecdf.fluxplot.json"), "utf8")) as FluxPlotManifest;

const plot = (id: string, assetId: string, over: Record<string, { hidden?: boolean }> = {}): SemanticPlotElement =>
  ({ type: "plot", id, x: 0, y: 0, width: 400, height: 300, rotation: 0, assetId, source: { svgPath: `plots/${id}.svg` }, overrides: over }) as SemanticPlotElement;
const rect = (id: string): RectElement =>
  ({ type: "rect", id, x: 0, y: 0, width: 100, height: 80, rotation: 0, fill: "#eee", stroke: "#000", strokeWidth: 1, cornerRadius: 0 }) as RectElement;
const proj = (fig: Figure): Project => ({ version: 2, name: "t", canvases: [{ id: "c1", name: "Canvas 1" }], figures: [fig], assets: [], palette: [] });
const fig = (elements: Figure["elements"]): Figure =>
  ({ id: "f1", canvasId: "c1", name: "Figure 1", x: 0, y: 0, width: 900, height: 600, background: "#fff", elements }) as Figure;

const manifests = { scatter: SCATTER, ecdf: ECDF };

// (a) three same-recipe plots + a rect → the set root, children top-z first
{
  const f = fig([plot("p1", "scatter"), rect("r1"), plot("p2", "scatter"), plot("p3", "scatter", { "axis.x": { hidden: true } })]);
  const p = proj(f);
  const target = { kind: "elements" as const, figId: "f1", elementIds: ["p1", "p2", "p3"] };
  const tree = buildXrayTree(p, target, manifests)!;
  assert(tree && tree.kind === "set" && tree.id === "set:f1" && tree.isGroup, "elements root builds a `set` row");
  assert(tree.label === "3 plots" && tree.count === 3, `set row labels the count (${tree.label})`);
  assert(tree.children.map((c) => c.elementId).join(",") === "p3,p2,p1", "children are the plots, top-z first");
  assert(tree.children.every((c) => c.kind === "element" && c.isGroup && c.children.length > 0), "each plot expands in place under its own root");
  assert(!tree.children.some((c) => c.elementId === "r1"), "the rect is not part of the plot set");
  assert(targetLabel(p, target, manifests) === "3 plots", "targetLabel names the set");

  // (b) common parts — every part of equal-recipe plots, first tree's order, hidden counts
  const plots = [f.elements[0], f.elements[2], f.elements[3]] as SemanticPlotElement[];
  const ids = commonPartIds(plots, manifests);
  const walk = (n: ReturnType<typeof buildPartTree> & object, out: string[]) => { for (const c of n.children) { out.push(c.id); walk(c, out); } return out; };
  const all = walk(buildPartTree(SCATTER)!, []);
  assert(ids.length === all.length && ids.every((c, i) => c.id === all[i]), `equal-recipe plots share every part in tree order (${ids.length})`);
  const rows = commonPartRows(plots, manifests);
  const xaxis = rows.find((r) => r.partId === "axis.x")!;
  assert(xaxis && xaxis.kind === "common" && xaxis.id === "common:axis.x" && xaxis.elementIds?.join(",") === "p1,p2,p3", "common row carries partId + every plot id");
  assert(xaxis.hiddenCount === 1 && xaxis.hidden === false && xaxis.count === 3, `hidden count reflects p3's override (${xaxis.hiddenCount}/3)`);
  const hiddenEverywhere = commonPartRows(
    [plot("a", "scatter", { "axis.x": { hidden: true } }), plot("b", "scatter", { "axis.x": { hidden: true } })],
    manifests,
  ).find((r) => r.partId === "axis.x")!;
  assert(hiddenEverywhere.hidden === true && hiddenEverywhere.hiddenCount === 2, "hidden everywhere → hidden:true");

  // mixed recipes intersect on id AND role; a lone plot has no common rows
  const mixed = commonPartIds([plots[0], plot("e", "ecdf")], manifests);
  const scatterIds = new Set(all);
  const ecdfIds = new Set(walk(buildPartTree(ECDF)!, []));
  assert(mixed.every((c) => scatterIds.has(c.id) && ecdfIds.has(c.id)), `mixed recipes: only parts present in both (${mixed.length})`);
  assert(mixed.length < all.length, "…which is fewer than a single recipe's parts");
  assert(commonPartIds([plots[0]], manifests).length === 0 && commonPartRows([], manifests).length === 0, "a lone plot has no common rows");
}

// (c) a missing plot is skipped; one survivor collapses to the element root; none → null
{
  const f = fig([plot("p1", "scatter"), plot("p2", "scatter")]);
  const p = proj(f);
  const t1 = buildXrayTree(p, { kind: "elements", figId: "f1", elementIds: ["p1", "gone", "p2"] }, manifests)!;
  assert(t1.kind === "set" && t1.children.length === 2, "a missing plot is skipped");
  const t2 = buildXrayTree(p, { kind: "elements", figId: "f1", elementIds: ["p2", "gone"] }, manifests)!;
  assert(t2.kind === "element" && t2.elementId === "p2", "one survivor collapses to the ordinary element root");
  assert(buildXrayTree(p, { kind: "elements", figId: "f1", elementIds: ["gone"] }, manifests) === null, "no survivor → null");
  assert(buildXrayTree(p, { kind: "elements", figId: "nope", elementIds: ["p1"] }, manifests) === null, "unknown figure → null");
}
console.log("VERIFY-XRAY-MULTI PASS");
