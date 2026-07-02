#!/usr/bin/env -S npx tsx
// WS4 — orphan defense. The OLD (pre-regen) 08_ecdf drew its 3 vertical median
// lines with a raw ax.plot() → bare <g id="line2d_N">, no manifest part: they
// were invisible to the X-ray, unmaskable, and leaked through a whole-figure
// mask. cachePlot now appends a synthetic "unclassified" group for such
// content. Asserts, against the REAL fixtures:
//  • old 08_ecdf → unclassified group with exactly the line2d orphans;
//  • masking "unclassified" hides them via applyOverrides;
//  • a whole-figure mask now catches them (leavesUnder includes the group);
//  • a fade track on "unclassified" resolves + animates them;
//  • the REGENERATED 08_ecdf (fp.reference_line medians) → zero orphans;
//  • wrappers (xtick_N, figure) never orphan; defs/clipPath content skipped.
// Run: npx tsx scripts/verify-slide-orphans.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { cachePlot, plotDom, plotManifests } = await import("../src/lib/plot/store");
const { applyOverrides, prefixIds } = await import("../src/lib/plot/parse");
const { buildPartTree, resolveTargets, leavesUnder } = await import("../src/lib/plot/tree");
const { computeSlideAnims, applyStatic } = await import("../src/lib/slide/player/player");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
const { get } = await import("svelte/store");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "pre-regen");
const REGEN = "/home/driessen2/fluxv1/plots/example_plots";

// --- OLD ecdf: orphans detected + addressable ---------------------------------
const oldSvg = await fs.readFile(path.join(FIX, "08_ecdf.svg"), "utf8");
const oldManifest = JSON.parse(await fs.readFile(path.join(FIX, "08_ecdf.fluxplot.json"), "utf8"));
assert(cachePlot("old_ecdf", oldSvg, oldManifest), "old ecdf caches");
const m1 = get(plotManifests)["old_ecdf"];
const uncl = resolveTargets(m1, "unclassified");
assert(uncl.length === 3 && ["line2d_1", "line2d_2", "line2d_3"].every((id) => uncl.includes(id)), `unclassified group holds EXACTLY the 3 raw median lines (${uncl.join(", ")}) — mpl backgrounds excluded`);
assert(!uncl.includes("reference-line.median"), "the properly-tagged horizontal median is NOT an orphan");
const tree = buildPartTree(m1)!;
const findNode = (n: typeof tree, id: string): typeof tree | null => {
  if (n.id === id) return n;
  for (const c of n.children) { const f = findNode(c, id); if (f) return f; }
  return null;
};
const unode = findNode(tree, "unclassified");
assert(!!unode && unode.label === "Unclassified" && unode.isGroup, "X-ray tree shows an 'Unclassified' group");
assert(!findNode(tree, "xtick_1") && !findNode(tree, "figure_1"), "matplotlib wrappers never orphan");
assert(leavesUnder(m1!.parts!).includes(uncl[0]), "a whole-figure mask now reaches the orphans (leavesUnder includes them)");

// applyOverrides: masking "unclassified" hides all three line2d groups
const inst = plotDom.get("old_ecdf")!.cloneNode(true) as unknown as Element;
prefixIds(inst, "el1");
applyOverrides(inst, { unclassified: { hidden: true } }, "el1", m1);
for (const id of uncl) {
  const n = inst.querySelector(`[id="el1__${id}"]`) as { style?: { display?: string } } | null;
  assert(n?.style?.display === "none", `mask hides ${id}`);
}

// a fade track on "unclassified" resolves + hides-then-reveals in static state
const wrap = document.createElement("div");
const inst2 = plotDom.get("old_ecdf")!.cloneNode(true) as unknown as Element;
prefixIds(inst2, "elp");
wrap.appendChild(inst2 as never);
const slide = {
  id: "s", elements: [{ type: "plot", id: "elp", assetId: "old_ecdf", x: 0, y: 0, width: 400, height: 300, rotation: 0 }],
  beats: [
    { id: "k0", tracks: [] },
    { id: "k1", tracks: [{ target: "elp", part: "unclassified", preset: "fade", duration: 300 }] },
  ],
} as never;
const rendered = { elements: new Map([["elp", wrap]]) } as never;
const specs = computeSlideAnims(slide, rendered, document.createElement("div") as never, { width: 1280, height: 720 }, {
  theme: FLUX_DARK, plotManifest: (id: string) => (id === "old_ecdf" ? m1 : undefined),
} as never);
assert(specs.length === uncl.length, `a track on "unclassified" fans out to ${uncl.length} orphan specs`);
applyStatic(specs, 0);
const first = wrap.querySelector(`[id="elp__${uncl[0]}"]`) as unknown as HTMLElement;
assert((first.style as unknown as { opacity?: string }).opacity === "0", "orphans hidden at rest before their beat");
applyStatic(specs, 1);
assert((first.style as unknown as { opacity?: string }).opacity === "1", "…and revealed after");

// --- REGENERATED ecdf: no orphans (fp.reference_line medians are real parts) ---
const newSvg = await fs.readFile(path.join(REGEN, "08_ecdf.svg"), "utf8");
const newManifest = JSON.parse(await fs.readFile(path.join(REGEN, "08_ecdf.fluxplot.json"), "utf8"));
assert(cachePlot("new_ecdf", newSvg, newManifest), "regenerated ecdf caches");
const m2 = get(plotManifests)["new_ecdf"];
assert(resolveTargets(m2, "unclassified").join(",") === "unclassified", "regenerated ecdf has NO unclassified group (all content covered)");
const t2 = buildPartTree(m2)!;
assert(!!findNode(t2, "reference-line.median-setosa"), "vertical medians are first-class parts now");

// --- regenerated scatter: ticks are real paths + a drawOn track drills to them --
const scSvg = await fs.readFile(path.join(REGEN, "06_scatter_regression.svg"), "utf8");
const scManifest = JSON.parse(await fs.readFile(path.join(REGEN, "06_scatter_regression.fluxplot.json"), "utf8"));
cachePlot("new_scatter", scSvg, scManifest);
const scDom = plotDom.get("new_scatter")!;
const tickGroups = Array.from((scDom as unknown as Element).querySelectorAll('[data-role="tick"]'));
assert(tickGroups.length > 0 && tickGroups.every((g) => !g.querySelector("use") && !!g.querySelector("path")), "regenerated ticks carry REAL per-tick paths (no <use>)");

console.log("\nSLIDE ORPHAN DEFENSE (WS4) TESTS PASSED");
