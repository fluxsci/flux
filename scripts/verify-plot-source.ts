#!/usr/bin/env -S npx tsx
// Plot source paths — portability across project roots.
//
// `SemanticPlotElement.source` is documented project-relative but three import
// routes wrote three shapes (absolute picker path from the GUI, project-relative
// from headless, bare filename from drag-drop). Nothing looked broken because
// renders read fig/assets/ — the failure is silent: plots/ hot-swap, the slide
// bridge, Regenerate and X-ray all stop finding the source the moment the
// project root changes (synced to another machine, folder renamed, restored
// elsewhere).
//
// This gates the two halves of the fix in src/lib/plot/source.ts:
//   WRITE  toProjectRelativeSource + healPlotSources make a canvas portable
//   READ   plotSourceCandidates resolves a canvas that already travelled
//
//  Run: npx tsx scripts/verify-plot-source.ts
import {
  healPlotSources,
  isUnderRoot,
  plotSourceCandidates,
  toProjectRelativeSource,
} from "../src/lib/plot/source";
import type { Project, SemanticPlotElement } from "../src/lib/types";

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log("  ok:", msg);
  else {
    console.error("  FAIL:", msg);
    failures++;
  }
}
const eq = (a: unknown, b: unknown, msg: string): void =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)})`);

// The two roots the same project has on the owner's two machines.
const LINUX = "/home/driessen2/FluxProjects/moma";
const MAC = "/Users/kdriessen/FluxProjects/moma";

// ---------------------------------------------------------------------------
console.log("toProjectRelativeSource:");
// ---------------------------------------------------------------------------
eq(toProjectRelativeSource(LINUX, `${LINUX}/plots/fig1.svg`), "plots/fig1.svg", "under root → relative");
eq(toProjectRelativeSource(LINUX, `${LINUX}/plots/sub/fig1.svg`), "plots/sub/fig1.svg", "nested under root → relative");
eq(toProjectRelativeSource(LINUX, "plots/fig1.svg"), "plots/fig1.svg", "already relative → unchanged");
eq(toProjectRelativeSource(LINUX, "/elsewhere/shared/fig1.svg"), "/elsewhere/shared/fig1.svg", "external import keeps its absolute path");
eq(toProjectRelativeSource(null, `${LINUX}/plots/fig1.svg`), `${LINUX}/plots/fig1.svg`, "no root → untouched");
// A sibling directory must not be mistaken for the root (prefix, not segment).
eq(
  toProjectRelativeSource(LINUX, `${LINUX}-old/plots/fig1.svg`),
  `${LINUX}-old/plots/fig1.svg`,
  "sibling dir sharing a name prefix is NOT under root",
);
eq(toProjectRelativeSource(LINUX, `${LINUX}/plots/fig1.svg`.replace(/\//g, "\\")), "plots/fig1.svg", "backslash separators normalize");

// ---------------------------------------------------------------------------
console.log("isUnderRoot:");
// ---------------------------------------------------------------------------
assert(isUnderRoot(LINUX, `${LINUX}/plots/a.svg`), "child is under root");
assert(!isUnderRoot(LINUX, `${LINUX}-old/plots/a.svg`), "prefix-sharing sibling is not");
assert(!isUnderRoot(LINUX, "/etc/passwd"), "unrelated absolute path is not");

// ---------------------------------------------------------------------------
console.log("plotSourceCandidates — the canonical relative shape:");
// ---------------------------------------------------------------------------
{
  const c = plotSourceCandidates(MAC, "plots/sub/fig1.svg");
  eq(c[0], `${MAC}/plots/sub/fig1.svg`, "relative resolves against the CURRENT root first");
}

// ---------------------------------------------------------------------------
console.log("plotSourceCandidates — the cross-machine rescue (the actual bug):");
// ---------------------------------------------------------------------------
{
  // A canvas imported on the Linux box, opened on the Mac.
  const c = plotSourceCandidates(MAC, `${LINUX}/plots/sub/fig1.svg`);
  assert(c[0] === `${LINUX}/plots/sub/fig1.svg`, "stored path is still tried first (same machine keeps working)");
  assert(
    c.includes(`${MAC}/plots/sub/fig1.svg`),
    "foreign absolute path re-anchors at THIS project's plots/, preserving subdirs",
  );
  assert(c.every((p) => p.startsWith("/")), "every candidate is absolute");
  eq(new Set(c).size, c.length, "no duplicate candidates");
}
{
  // Same project, same machine, folder renamed.
  const moved = "/home/driessen2/FluxProjects/moma-final";
  assert(
    plotSourceCandidates(moved, `${LINUX}/plots/fig1.svg`).includes(`${moved}/plots/fig1.svg`),
    "a renamed project folder re-anchors too",
  );
}
{
  // Deepest plots/ wins: a project that itself lives under a directory called plots/.
  const nested = "/data/plots/moma";
  assert(
    plotSourceCandidates(nested, "/old/plots/a.svg").includes(`${nested}/plots/a.svg`),
    "re-anchor uses the LAST plots/ segment, not the first",
  );
}

// ---------------------------------------------------------------------------
console.log("plotSourceCandidates — the bare drag-drop name (never resolved before):");
// ---------------------------------------------------------------------------
{
  const c = plotSourceCandidates(MAC, "fig1.svg");
  assert(c.includes(`${MAC}/plots/fig1.svg`), "bare filename falls back to <root>/plots/<name>");
}

// ---------------------------------------------------------------------------
console.log("plotSourceCandidates — degenerate input:");
// ---------------------------------------------------------------------------
eq(plotSourceCandidates(MAC, ""), [], "empty stored path yields no candidates");
eq(plotSourceCandidates("", ""), [], "empty root AND path yields no candidates");
assert(plotSourceCandidates(null, "/abs/plots/a.svg").length === 1, "no root → only the stored path");

// ---------------------------------------------------------------------------
console.log("healPlotSources:");
// ---------------------------------------------------------------------------
function fixture(): Project {
  const plot = (id: string, source: SemanticPlotElement["source"]): SemanticPlotElement => ({
    type: "plot",
    id,
    assetId: `asset-${id}`,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    source,
    overrides: {},
  });
  return {
    version: 2,
    name: "moma",
    canvases: [{ id: "c1", name: "Canvas 1" }],
    figures: [
      {
        id: "f1",
        canvasId: "c1",
        name: "Figure 1",
        x: 0,
        y: 0,
        width: 500,
        height: 400,
        elements: [
          plot("p1", {
            svgPath: `${LINUX}/plots/fig1.svg`,
            manifestPath: `${LINUX}/plots/fig1.fluxplot.json`,
            recipePath: `${LINUX}/plots/fig1.recipe.json`,
          }),
          plot("p2", { svgPath: "plots/already-relative.svg" }),
          plot("p3", { svgPath: "/elsewhere/shared/external.svg" }),
          { type: "text", id: "t1", x: 0, y: 0, width: 10, height: 10, rotation: 0, text: "hi" },
        ],
      },
    ],
    assets: [],
    palette: [],
  } as unknown as Project;
}

{
  const p = fixture();
  const n = healPlotSources(p, LINUX);
  const els = p.figures[0].elements as unknown as SemanticPlotElement[];
  eq(n, 3, "three under-root fields rewritten");
  eq(els[0].source?.svgPath, "plots/fig1.svg", "svgPath relativized");
  eq(els[0].source?.manifestPath, "plots/fig1.fluxplot.json", "manifestPath relativized");
  eq(els[0].source?.recipePath, "plots/fig1.recipe.json", "recipePath relativized");
  eq(els[1].source?.svgPath, "plots/already-relative.svg", "already-relative left alone");
  eq(els[2].source?.svgPath, "/elsewhere/shared/external.svg", "external import NOT clobbered");

  // Idempotent — a second pass must be a no-op (it runs on every load).
  eq(healPlotSources(p, LINUX), 0, "second pass changes nothing");

  // Non-plot elements survive untouched.
  assert((p.figures[0].elements[3] as { type: string }).type === "text", "non-plot elements untouched");
}
{
  // Healing on the WRONG machine must not mangle anything — the paths simply
  // aren't under this root, so they are left for the read-time rescue.
  const p = fixture();
  eq(healPlotSources(p, MAC), 0, "foreign absolute paths are left intact on the other machine");
  const els = p.figures[0].elements as unknown as SemanticPlotElement[];
  eq(els[0].source?.svgPath, `${LINUX}/plots/fig1.svg`, "…and are still resolvable by candidates");
  assert(
    plotSourceCandidates(MAC, els[0].source!.svgPath).includes(`${MAC}/plots/fig1.svg`),
    "read-time rescue still applies after a no-op heal",
  );
}
{
  const p = fixture();
  eq(healPlotSources(p, null), 0, "no root → no change");
  eq(healPlotSources({ figures: [] } as unknown as Project, LINUX), 0, "empty project → no change");
}

// ---------------------------------------------------------------------------
// The round trip that is the whole point: import on one machine, open on the
// other, and the source still resolves.
// ---------------------------------------------------------------------------
console.log("round trip (import on Linux → heal → open on Mac):");
{
  const p = fixture();
  healPlotSources(p, LINUX); // the importing machine makes it portable
  const stored = (p.figures[0].elements as unknown as SemanticPlotElement[])[0].source!.svgPath;
  eq(plotSourceCandidates(MAC, stored)[0], `${MAC}/plots/fig1.svg`, "resolves FIRST TRY on the other machine");
  eq(plotSourceCandidates(LINUX, stored)[0], `${LINUX}/plots/fig1.svg`, "and still resolves on the original");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall plot-source checks passed");
process.exit(failures ? 1 : 0);
