#!/usr/bin/env -S npx tsx
// figure-v1 Phase 4 — derived manifests: make ANY svg x-rayable.
//
// deriveManifestFromSvg synthesizes a fluxplot-shaped manifest from a plain
// SVG's own DOM (matplotlib id vocabulary → friendly roles/labels; generic
// tag fallback; deterministic across parses so override keys are stable).
// Fixture: fixtures/plots/vanilla-sine.svg — a REAL `plt.savefig()` output
// (mpl_sine_waves_VANILLA from the owner's test project).
//
//  Run: npx tsx scripts/figenh-17-derive.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { preparePlot, parsePlotSvg } = await import("../src/lib/plot/parse");
const { deriveManifestFromSvg, normalizeSvgForParts, isDerivedManifest, DERIVED_SPEC } = await import(
  "../src/lib/plot/derive"
);
const { buildPartTree, resolveTargets } = await import("../src/lib/plot/tree");
import type { PartNode } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const svgText = await fs.readFile(path.join(import.meta.dirname, "..", "fixtures", "plots", "vanilla-sine.svg"), "utf8");

// ---------------------------------------------------------------------------
// 1. Derive over the real matplotlib file
// ---------------------------------------------------------------------------
console.log("derive (real matplotlib vanilla):");
const root = parsePlotSvg(svgText) as unknown as Element;
normalizeSvgForParts(root);
const man = deriveManifestFromSvg(root);

assert(man.spec === DERIVED_SPEC && isDerivedManifest(man), "manifest carries the derived spec marker");
assert(man.size.width === 360 && man.size.unit === "pt", "size parsed from width/height attrs (360pt)");
assert(man.parts?.role === "figure", "matplotlib figure_1 promoted to the figure root");

const flat: PartNode[] = [];
const walk = (n: PartNode) => {
  flat.push(n);
  (n.children ?? []).forEach(walk);
};
walk(man.parts as PartNode);
const byId = new Map(flat.map((n) => [n.id ?? "", n]));

assert(byId.get("axes_1")?.role === "plot-area", "axes_1 → plot-area role");
const axes = flat.filter((n) => n.role === "axis");
assert(axes.length === 2, "both matplotlib.axis_N nodes classified as axes");
assert(
  axes.some((a) => a.axis === "x") && axes.some((a) => a.axis === "y"),
  "axis x/y inferred from tick ids beneath",
);
const xtick = flat.find((n) => /^xtick_\d+$/.test(n.id ?? ""));
assert(xtick?.role === "tick" && /^X tick \d+$/.test(xtick?.label ?? ""), "xtick_N → tick role + friendly label");
const label = flat.find((n) => /^text_\d+$/.test(n.id ?? ""));
assert(label?.role === "text" && (label?.label ?? "").startsWith("Text"), "text_N → text role + content-preview label");
assert(
  flat.some((n) => /^line2d_\d+$/.test(n.id ?? "") && n.role === "line"),
  "line2d_N → line role",
);

// The tree renders through the SAME buildPartTree as fluxplot manifests.
const tree = buildPartTree(man);
assert(tree !== null && tree.children.length > 0, "buildPartTree consumes the derived manifest unchanged");

// resolveTargets: a derived container id resolves to itself or leaves without throwing
const t = resolveTargets(man, "axes_1");
assert(Array.isArray(t) && t.length > 0, "resolveTargets works over derived parts");

// ---------------------------------------------------------------------------
// 2. Determinism across parses
// ---------------------------------------------------------------------------
console.log("determinism:");
const root2 = parsePlotSvg(svgText) as unknown as Element;
normalizeSvgForParts(root2);
const man2 = deriveManifestFromSvg(root2);
assert(JSON.stringify(man) === JSON.stringify(man2), "derive(parse(bytes)) is byte-deterministic across runs");

// preparePlot path: no manifest in → derived manifest comes out at cachePlot's seam
// (Phase 4 wires this; the seam contract is asserted here ahead of it.)
const prep = preparePlot(svgText);
assert(prep.root !== null, "preparePlot parses the vanilla svg");

// ---------------------------------------------------------------------------
// 3. Generic svg (no matplotlib ids, no ids at all) + caps
// ---------------------------------------------------------------------------
console.log("generic + caps:");
const GENERIC = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80">
  <g><g><text x="1" y="1">hello world</text></g><path d="M0 0 L9 9" stroke="#000"/></g>
  <rect x="0" y="0" width="5" height="5"/>
</svg>`;
const gRoot = parsePlotSvg(GENERIC) as unknown as Element;
normalizeSvgForParts(gRoot);
const gMan = deriveManifestFromSvg(gRoot);
assert(gMan.parts?.id === "svg" && gMan.parts?.role === "figure", "id-less svg gets a synthetic figure root");
const gFlat: PartNode[] = [];
walk2(gMan.parts as PartNode);
function walk2(n: PartNode) {
  gFlat.push(n);
  (n.children ?? []).forEach(walk2);
}
assert(
  gFlat.some((n) => n.role === "text" && (n.label ?? "").includes("hello world")),
  "generic text node classified by tag with content label",
);
assert(gFlat.length > 2, "stamped n<dfs> ids made the id-less structure addressable");
const gRootB = parsePlotSvg(GENERIC) as unknown as Element;
normalizeSvgForParts(gRootB);
assert(
  JSON.stringify(deriveManifestFromSvg(gRootB)) === JSON.stringify(gMan),
  "stamped ids + derived tree deterministic for generic svgs",
);

// caps: a deep chain stops descending at depth 8 — the deepest part becomes a
// leaf that addresses its whole subtree
let deep = `<text x="0" y="0">bottom</text>`;
for (let i = 14; i >= 1; i--) deep = `<g id="lvl${i}">${deep}</g>`;
const DEEP = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${deep}</svg>`;
const dRoot = parsePlotSvg(DEEP) as unknown as Element;
normalizeSvgForParts(dRoot);
const dMan = deriveManifestFromSvg(dRoot);
let depth = 0;
let cur: PartNode | undefined = dMan.parts as PartNode;
while (cur) {
  depth++;
  cur = cur.children?.[0];
}
assert(depth <= 9, `depth cap holds (tree depth ${depth} ≤ 9 incl. root)`);

console.log("\nfigenh-17-derive: ALL OK");
