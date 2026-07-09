#!/usr/bin/env -S npx tsx
// figure-v1 P8 — the unified X-ray tree (pure). buildXrayTree must produce ONE
// coherent tree for every root the panel can be pinned on:
//   (a) a fluxplot semantic plot (element target): part rows mirror
//       buildPartTree exactly, with the manifest ROOT folded into the element
//       row (the plot IS its own figure root — no "plot → Figure" double nest);
//   (b) a vanilla SVG's DERIVED manifest: the authored PartNode.label values
//       ("X tick 3", "Text …") are honored end-to-end;
//   (c) a figure with NESTED groups + a plot member (group target): child
//       groups appear by name, the plot expands in place under its own figure
//       root next to sibling shapes, order is top-z-first (Sidebar parity);
//       and every row carries the ids its ctrl-click RE-ROOT resolves through.
//   Run: npx tsx scripts/verify-xray-tree.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseHTML, DOMParser } from "linkedom";

// derive.ts touches DOM APIs — give it the linkedom globals before import.
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { buildXrayTree, targetLabel } = await import("../src/lib/xray/buildXrayTree");
const { buildPartTree } = await import("../src/lib/plot/tree");
const { parsePlotSvg } = await import("../src/lib/plot/parse");
const { normalizeSvgForParts, deriveManifestFromSvg } = await import("../src/lib/plot/derive");
import type { XRow } from "../src/lib/xray/buildXrayTree";
import type { XrayNode } from "../src/lib/plot/tree";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Figure, Project, RectElement, SemanticPlotElement } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const here = import.meta.dirname;
const MANIFEST = JSON.parse(
  await fs.readFile(path.join(here, "fixtures", "pre-regen", "06_scatter_regression.fluxplot.json"), "utf8"),
) as FluxPlotManifest;

const plot = (id: string, assetId: string, over: Record<string, { hidden?: boolean }> = {}): SemanticPlotElement =>
  ({
    type: "plot",
    id,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    rotation: 0,
    assetId,
    source: { svgPath: "plots/scatter.svg" },
    overrides: over,
  }) as SemanticPlotElement;

const rect = (id: string, groupId?: string): RectElement =>
  ({
    type: "rect",
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    fill: "#eee",
    stroke: "#000",
    strokeWidth: 1,
    cornerRadius: 0,
    ...(groupId ? { groupId } : {}),
  }) as RectElement;

const proj = (fig: Figure): Project => ({
  version: 2,
  name: "t",
  canvases: [{ id: "c1", name: "Canvas 1" }],
  figures: [fig],
  assets: [],
  palette: [],
});

// ---------------------------------------------------------------------------
// (a) fluxplot element target — rows mirror buildPartTree
// ---------------------------------------------------------------------------
console.log("(a) fluxplot element root:");
{
  // NOTE: individual ticklabels are group MEMBERS (no PartNode of their own) —
  // rows exist for tree NODES, so the override test targets the group node.
  const p1 = plot("p1", "a1", { "axis.x.tick-labels": { hidden: true } });
  const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [p1] };
  const manifests = { a1: MANIFEST };
  const root = buildXrayTree(proj(fig), { kind: "element", figId: "f1", elementId: "p1" }, manifests);
  const ref = buildPartTree(MANIFEST)!;

  assert(root !== null, "element target resolves");
  assert(root!.kind === "element" && root!.elementId === "p1", "root row is the ELEMENT row");
  assert(root!.role === "figure", "…playing the plot's own figure root");
  assert(root!.label === "scatter", "…labeled by the svg basename (no user name set)");
  assert(root!.children.length === ref.children.length, `part fan-out mirrors buildPartTree (${root!.children.length})`);

  // Deep structural mirror: id/label/role/order identical to buildPartTree.
  let mirrored = 0;
  const same = (a: XRow, b: XrayNode): boolean => {
    if (a.partId !== b.id || a.label !== b.label || a.role !== b.role) return false;
    if (a.children.length !== b.children.length) return false;
    mirrored++;
    return a.children.every((c, i) => same(c, b.children[i]));
  };
  assert(
    root!.children.every((c, i) => same(c, ref.children[i])),
    `every part row mirrors its XrayNode (id+label+role+order, ${mirrored} nodes)`,
  );
  const flat: XRow[] = [];
  const walk = (n: XRow) => (flat.push(n), n.children.forEach(walk));
  walk(root!);
  assert(
    flat.every((r) => r === root! || (r.kind === "part" && r.elementId === "p1" && r.id === `part:p1__${r.partId}`)),
    "part rows carry elementId + stable row ids",
  );
  const groupRow = flat.find((r) => r.partId === "axis.x.tick-labels");
  assert(groupRow?.hidden === true, "override.hidden surfaces on its part row");
  assert((groupRow?.count ?? 0) > 1, `manifest group rows keep their leaf count (${groupRow?.count})`);
  assert(targetLabel(proj(fig), { kind: "element", figId: "f1", elementId: "p1" }, manifests) === "scatter",
    "targetLabel matches the element row label");
}

// ---------------------------------------------------------------------------
// (b) derived-manifest vanilla svg — authored labels honored
// ---------------------------------------------------------------------------
console.log("(b) derived vanilla labels:");
{
  const svgText = await fs.readFile(path.join(here, "..", "fixtures", "plots", "vanilla-sine.svg"), "utf8");
  const dom = parsePlotSvg(svgText) as unknown as Element;
  normalizeSvgForParts(dom);
  const derived = deriveManifestFromSvg(dom);

  const v = plot("v1", "va");
  const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [v] };
  const root = buildXrayTree(proj(fig), { kind: "element", figId: "f1", elementId: "v1" }, { va: derived });
  assert(root !== null, "derived-manifest target resolves (same path as fluxplot)");
  const flat: XRow[] = [];
  const walk = (n: XRow) => (flat.push(n), n.children.forEach(walk));
  walk(root!);
  const xtick = flat.find((r) => /^xtick_\d+$/.test(r.partId ?? ""));
  assert(!!xtick && /^X tick \d+$/.test(xtick.label), `authored derived label honored ("${xtick?.label}")`);
  const text = flat.find((r) => /^text_\d+$/.test(r.partId ?? ""));
  assert(!!text && /^Text /.test(text.label), `text preview label honored ("${text?.label}")`);
  assert(
    flat.filter((r) => r.kind === "part").every((r) => r.label !== r.partId || !/^(xtick|ytick|text|line2d)_/.test(r.partId ?? "")),
    "no matplotlib raw id leaks where an authored label exists",
  );
}

// ---------------------------------------------------------------------------
// (c) nested groups + plot member (group target) + re-root resolution
// ---------------------------------------------------------------------------
console.log("(c) group root:");
{
  // z-order (bottom→top): rA, rB (inner group g1) · plot pX · rC — all in outer g2.
  const fig: Figure = {
    id: "f1",
    name: "f",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    elements: [rect("rA", "g1"), rect("rB", "g1"), { ...plot("pX", "a1"), groupId: "g2" } as SemanticPlotElement, rect("rC", "g2")],
    groups: {
      g1: { id: "g1", name: "Panel A", parentId: "g2" },
      g2: { id: "g2", name: "Both Panels" },
    },
  } as Figure;
  const p = proj(fig);
  const manifests = { a1: MANIFEST };

  const root = buildXrayTree(p, { kind: "group", figId: "f1", groupId: "g2" }, manifests);
  assert(root !== null && root!.kind === "group" && root!.groupId === "g2", "group target resolves");
  assert(root!.label === "Both Panels", "group root labeled by its NAME");
  assert(root!.count === 4, `member count deep (${root!.count})`);

  const kinds = root!.children.map((c) => `${c.kind}:${c.label}`);
  // top-z first: rC, plot, then the nested group (its first member is lowest).
  assert(
    kinds[0] === "element:rect 4" && kinds[1] === "element:scatter" && kinds[2] === "group:Panel A",
    `children are top-z-first with the child group BY NAME [${kinds.join(" · ")}]`,
  );
  const plotRow = root!.children[1];
  assert(plotRow.role === "figure" && plotRow.isGroup && plotRow.children.length > 0,
    "the plot member expands IN PLACE under its own figure root");
  assert(plotRow.children.some((c) => c.kind === "part" && c.label === "Plot area"),
    "…with its real part rows next to sibling shapes");
  const inner = root!.children[2];
  assert(inner.children.length === 2 && inner.children[0].label === "rect 2" && inner.children[1].label === "rect 1",
    "nested group members present, top-z-first");

  // hidden/locked states surface per row kind
  fig.groups!.g1.hidden = true;
  fig.elements[3].hidden = true; // rC
  const root2 = buildXrayTree(p, { kind: "group", figId: "f1", groupId: "g2" }, manifests)!;
  assert(root2.children[2].hidden === true, "GroupDef eye surfaces on the group row");
  assert(root2.children[0].hidden === true, "element hidden flag surfaces on its row");

  // --- re-root resolution: every row carries ids that resolve to a new root ---
  const partRow = plotRow.children.find((c) => c.kind === "part")!;
  const reFromPart = buildXrayTree(p, { kind: "element", figId: "f1", elementId: partRow.elementId! }, manifests);
  assert(reFromPart?.elementId === "pX" && reFromPart.children.length === plotRow.children.length,
    "part row re-roots to its OWNING PLOT (tree = the plot alone)");
  assert(reFromPart!.children.some((c) => c.id === partRow.id),
    "…and the part's row id is stable across the re-root (pre-select lands)");
  const reFromGroup = buildXrayTree(p, { kind: "group", figId: "f1", groupId: inner.groupId! }, manifests);
  assert(reFromGroup?.label === "Panel A" && reFromGroup.children.length === 2,
    "group row re-roots to that group alone");
  const reFromEl = buildXrayTree(p, { kind: "element", figId: "f1", elementId: "rC" }, manifests);
  assert(reFromEl?.kind === "element" && reFromEl.children.length === 0,
    "element row re-roots to a leaf element row");

  // dangling targets prune to null (store.pruneSelection contract)
  assert(buildXrayTree(p, { kind: "group", figId: "f1", groupId: "nope" }, manifests) === null, "unknown group → null");
  assert(buildXrayTree(p, { kind: "element", figId: "f1", elementId: "nope" }, manifests) === null, "unknown element → null");
  assert(buildXrayTree(p, { kind: "element", figId: "nope", elementId: "pX" }, manifests) === null, "unknown figure → null");
}

console.log("\nVERIFY-XRAY-TREE: PASS");
