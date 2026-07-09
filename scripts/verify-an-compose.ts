#!/usr/bin/env -S npx tsx
// WS5 acceptance: the flagship "N plots → one labeled multi-panel figure" flow,
// driven entirely through flux-core (the CLI/MCP path). Scaffolds a throwaway
// project, drops 10 plot SVGs (one with a FluxPlot sidecar), composes them into
// a 2×5 figure, and asserts the grid, panel letters, semantic panel, caption
// stub, render, and the reindexed manifest. Run: npx tsx scripts/verify-an-compose.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-compose-"));
try {
  await core.scaffold(root, { title: "Compose Test" });

  // 10 plot SVGs in plots/ (uniform 300×220 so the grid is exact).
  const plotsDir = path.join(root, "plots");
  await fs.mkdir(plotsDir, { recursive: true });
  const plotPaths: string[] = [];
  for (let i = 0; i < 10; i++) {
    const p = path.join(plotsDir, `p${i}.svg`);
    await fs.writeFile(
      p,
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="220" viewBox="0 0 300 220">` +
        `<rect width="300" height="220" fill="#eef"/><text x="12" y="30">plot ${i}</text></svg>`,
    );
    plotPaths.push(p);
  }
  // Give plot 0 a FluxPlot sidecar so it imports as a SEMANTIC panel.
  await fs.writeFile(
    path.join(plotsDir, "p0.fluxplot.json"),
    JSON.stringify({ specVersion: "0.2.0", parts: [], series: [{ id: "control" }] }, null, 2),
  );

  // Compose → 2 rows × 5 cols, labeled, with a caption stub.
  const r = await core.composeFigure(root, plotPaths, { id: "growth", name: "Growth panels", rows: 2 });
  assert(r.figureId === "growth", "figure created with the requested slug id");
  assert(JSON.stringify(r.panels) === JSON.stringify(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]),
    `panels auto-lettered a..j (got ${r.panels.join("")})`);

  // Inspect the saved model: 10 panels + 10 labels; grid = 5 cols × 2 rows.
  const { project } = await core.loadFigModel(root);
  const fig = project.figures.find((f) => f.id === "growth")!;
  const panels = fig.elements.filter((e) => e.type === "plot"); // P4: every svg IS a plot
  const labels = fig.elements.filter((e) => e.type === "text" && (e as { panelLabel?: boolean }).panelLabel);
  assert(panels.length === 10, `10 plot panels on the figure (got ${panels.length})`);
  assert(labels.length === 10, `10 panel labels (got ${labels.length})`);
  const xs = new Set(panels.map((e) => Math.round(e.x))).size;
  const ys = new Set(panels.map((e) => Math.round(e.y))).size;
  assert(xs === 5 && ys === 2, `grid is 5 cols × 2 rows (got ${xs}×${ys})`);

  // The sidecar'd plot carries its manifest source (for regenerate); the other
  // nine are vanilla plots — svgPath provenance only, no manifestPath (the
  // fluxplot/vanilla discriminator).
  const withManifest = panels.filter((e) => !!(e as { source?: { manifestPath?: string } }).source?.manifestPath);
  assert(
    withManifest.length === 1 && (withManifest[0] as { source?: { manifestPath?: string } }).source?.manifestPath?.endsWith("p0.fluxplot.json"),
    "exactly plot 0 imported as a FLUXPLOT panel (manifestPath source)",
  );
  assert(
    panels.every((e) => !!(e as { source?: { svgPath?: string } }).source?.svgPath),
    "every panel (vanilla included) records svgPath provenance",
  );

  // Figure sized to content (10 × 300-wide panels won't fit in a default page).
  assert(fig.width > 300 && fig.height > 220, `figure sized to content (${fig.width}×${fig.height})`);

  // Render faithfully: all 10 panels present in the standalone SVG — and ALL
  // inlined as nested <svg> with prefixed ids (figure-v1 P4: vanilla svgs are
  // semantic plots with derived manifests; ZERO <image> for svg content — real
  // text/vectors end-to-end).
  const svg = await core.renderFigureSvg(root, "growth");
  const imgs = (svg.match(/<image/g) || []).length;
  const inlined = (svg.match(/<svg/g) || []).length - 1; // minus the outer figure <svg>
  assert(
    imgs === 0 && inlined === 10,
    `render inlines all 10 panels as vectors (${imgs} <image> + ${inlined} inlined)`,
  );
  assert(/<text[^>]*>plot 0<\/text>/.test(svg) || svg.includes(">plot 0<"), "vanilla panel text stays REAL <text> in the render");

  // Caption stub written + reindexed manifest sees the figure with its panels.
  const cap = await core.captionFor(root, "growth");
  assert(typeof cap === "string", "caption stub readable");
  const list = await core.listProject(root);
  const entry = list.figures.find((f) => f.id === "growth");
  assert(entry?.label === "fig-growth", `manifest label is fig-growth (got ${entry?.label})`);
  assert(JSON.stringify(entry?.panels) === JSON.stringify(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]),
    "listProject reports panels a..j");

  // Another figure stacks below (createFigure placement) and reindex keeps order.
  // (The consolidated scaffold seeds "Figure 1", so the project holds seed + growth + summary.)
  const before = list.figures.length;
  await core.createFigure(root, { id: "summary", name: "Summary" });
  const list2 = await core.listProject(root);
  assert(
    list2.figures.length === before + 1 && list2.figures[list2.figures.length - 1].id === "summary",
    "new figure appended last + reindexed",
  );

  console.log("\nALL COMPOSE ACCEPTANCE TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
