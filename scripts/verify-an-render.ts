#!/usr/bin/env -S npx tsx
// WS3: faithful headless render — a semantic plot's per-part override must bake
// into the exported SVG, and a real PNG must rasterize. Saves the PNG to OUT for
// a visual check. Run: npx tsx scripts/verify-an-render.ts [outPng]
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const OUT = process.argv[2] ?? path.join(os.tmpdir(), "flux-render-sig.png");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-render-"));
try {
  await core.scaffold(root, { title: "Render Test" });
  const plots = path.join(root, "plots");
  await fs.mkdir(plots, { recursive: true });

  // A small semantic plot: white bg, axes, a black "control" line + a point.
  await fs.writeFile(
    path.join(plots, "sig.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180">` +
      `<rect width="240" height="180" fill="#ffffff"/>` +
      `<line x1="30" y1="150" x2="220" y2="150" stroke="#333" stroke-width="1"/>` +
      `<line x1="30" y1="20" x2="30" y2="150" stroke="#333" stroke-width="1"/>` +
      `<path id="control.line" d="M30 150 L220 30" stroke="#111111" stroke-width="2" fill="none"/>` +
      `<circle id="control.point.0" cx="220" cy="30" r="4" fill="#111111"/>` +
      `</svg>`,
  );
  await fs.writeFile(
    path.join(plots, "sig.fluxplot.json"),
    JSON.stringify({ specVersion: "0.2.0", series: [{ id: "control", svg: { line: "control.line" } }] }, null, 2),
  );

  // Compose a 1-panel figure → the plot imports as a SEMANTIC panel.
  const c = await core.composeFigure(root, [path.join(plots, "sig.svg")], { id: "sig", captionStub: false });
  assert(c.figureId === "sig", "composed semantic figure");

  // Baseline render: the plot is INLINE (addressable), not a flattened <image>.
  const before = await core.renderFigureSvg(root, "sig");
  assert(before.includes("control.line"), "render inlines the semantic plot (control.line present)");
  assert(!before.includes("#e00000"), "no override colour before restyle");

  // Restyle the control line red (per-part override) → bakes into the SVG.
  await core.setPartOverride(root, "sig", "control.line", { stroke: "#e00000", strokeWidth: 4 });
  const after = await core.renderFigureSvg(root, "sig");
  assert(after.includes("#e00000"), "override colour baked into rendered SVG");
  assert(/stroke-width:\s*4/.test(after), "override stroke-width baked in");

  // Rasterize to PNG (resvg) — a real PNG with the override applied.
  const png = await core.renderFigurePng(root, "sig", 3);
  const isPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  assert(isPng && png.length > 500, `PNG rasterized (${png.length} bytes, valid signature=${isPng})`);
  await fs.writeFile(OUT, png);
  console.log("  → wrote PNG for visual check:", OUT);

  console.log("\nALL RENDER (WS3) TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
