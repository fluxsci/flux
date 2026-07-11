#!/usr/bin/env -S npx tsx
// W9 acceptance: the agent→GUI semantic round-trip + caption durability.
//   • AGT-1: compose-figure copies a plot's manifest/recipe as ASSET-LOCAL sidecars
//     (fig/assets/<id>.fluxplot.json) — the exact path the GUI reattaches from — so
//     an agent-composed plot doesn't degrade to an opaque image on GUI open.
//   • AGT-11: headless render resolves the manifest even when the plot was imported
//     from OUTSIDE the project (source.manifestPath is out-of-root) — it prefers the
//     asset-local copy, so group overrides still expand.
//   • AGT-2: set-caption stores the caption in Figure.captions.__figure__ (the canvas
//     file), so the GUI's next save recomposes+reproduces it instead of clobbering.
// Run: npx tsx scripts/verify-w9-roundtrip.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import { composeCaption } from "../src/lib/captions";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const exists = (p: string) => fs.access(p).then(() => true, () => false);

// The plot lives OUTSIDE the project (AGT-11: source manifestPath will be `../…`).
const ext = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w9-ext-"));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w9-"));
try {
  await core.scaffold(root, { title: "W9" });

  // A semantic plot whose manifest has a GROUP part ("bars") over two leaf rects.
  const svg = path.join(ext, "bars.svg");
  await fs.writeFile(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">` +
      `<rect width="200" height="120" fill="#ffffff"/>` +
      `<rect id="bar1" x="20" y="40" width="30" height="60" fill="#888888"/>` +
      `<rect id="bar2" x="80" y="20" width="30" height="80" fill="#888888"/>` +
      `</svg>`,
  );
  const manifest = {
    specVersion: "0.2.0",
    parts: { id: "root", role: "container", children: [{ id: "bars", role: "group", members: ["bar1", "bar2"] }] },
    series: [],
  };
  await fs.writeFile(svg.replace(/\.svg$/, ".fluxplot.json"), JSON.stringify(manifest));
  await fs.writeFile(svg.replace(/\.svg$/, ".recipe.json"), JSON.stringify({ command: "echo", args: ["bars"] }));

  // Compose it into a figure (semantic panel; caption stub off — tested separately).
  const c = await core.composeFigure(root, [svg], { id: "barfig", captionStub: false });
  assert(c.figureId === "barfig", "composed a semantic figure from an out-of-root plot");

  // Locate the imported asset id from the saved canvas.
  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  const canvasId = idx.figures.find((f: any) => f.id === "barfig").canvas;
  const canvasPath = path.join(root, "fig", "canvases", `${canvasId}.json`);
  const cf = JSON.parse(await fs.readFile(canvasPath, "utf8"));
  const figure = cf.figures.find((f: any) => f.id === "barfig");
  const plotEl = figure.elements.find((e: any) => e.type === "plot");
  assert(plotEl?.assetId, "figure has a semantic plot element with an assetId");
  const assetId = plotEl.assetId;

  // AGT-1: asset-local sidecars written on import, byte-equal to the source.
  const localMan = path.join(root, "fig", "assets", `${assetId}.fluxplot.json`);
  const localRec = path.join(root, "fig", "assets", `${assetId}.recipe.json`);
  assert(await exists(localMan), "AGT-1: fig/assets/<id>.fluxplot.json written on agent import");
  assert(await exists(localRec), "AGT-1: fig/assets/<id>.recipe.json written on agent import");
  assert(
    JSON.stringify(JSON.parse(await fs.readFile(localMan, "utf8"))) === JSON.stringify(manifest),
    "asset-local manifest is byte-equal to the source manifest",
  );
  assert(/\.\./.test(plotEl.source?.manifestPath ?? ""), "source.manifestPath keeps the out-of-root provenance");

  // AGT-11: remove the EXTERNAL manifest, then render — resolution must fall to the
  // asset-local copy and the GROUP override must expand to BOTH bars.
  await fs.rm(svg.replace(/\.svg$/, ".fluxplot.json"));
  const before = await core.renderFigureSvg(root, "barfig");
  assert(!before.includes("#e00000"), "no override colour before restyle");
  await core.setPartOverride(root, "barfig", "bars", { fill: "#e00000" });
  const after = await core.renderFigureSvg(root, "barfig");
  const hits = (after.match(/#e00000/g) || []).length;
  assert(hits >= 2, `AGT-11: group override expanded to both bars via the asset-local manifest (${hits} hits)`);

  // AGT-2: set-caption writes into the canvas model, and a GUI-style recompose
  // reproduces it (does not clobber).
  await core.setCaption(root, "barfig", "Bar chart of widget counts.");
  const cf2 = JSON.parse(await fs.readFile(canvasPath, "utf8"));
  const fig2 = cf2.figures.find((f: any) => f.id === "barfig");
  assert(fig2.captions?.__figure__ === "Bar chart of widget counts.", "AGT-2: caption stored in Figure.captions.__figure__");
  const md = (await fs.readFile(path.join(root, "fig", "captions", "barfig.md"), "utf8")).trim();
  assert(md === "Bar chart of widget counts.", "fig/captions/barfig.md holds the caption");
  assert(composeCaption(fig2).trim() === md, "AGT-2: GUI composeCaption(figure) reproduces the .md — no clobber on next save");

  // A second set-caption updates the canvas source (not just the .md).
  await core.setCaption(root, "barfig", "Revised caption.");
  const fig3 = JSON.parse(await fs.readFile(canvasPath, "utf8")).figures.find((f: any) => f.id === "barfig");
  assert(fig3.captions?.__figure__ === "Revised caption.", "AGT-2: re-set caption updates the canvas model");

  // WS-6.1(3): the compose-figure LABEL edge, snapshotted so any future change
  // is deliberate. The fortify plan suspected a CLI/core divergence (the CLI
  // always passes label:true) — measuring shows there is NONE: core gates on
  // `panelIds.length > 1` regardless, so label:true is a NO-OP at 1 panel and
  // only label:false ever suppresses. Both surfaces agree; pinned here.
  {
    const one = path.join(ext, "solo.svg");
    await fs.writeFile(
      one,
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#eee"/></svg>`,
    );
    await core.composeFigure(root, [one], { id: "solo-core", captionStub: false });
    await core.composeFigure(root, [one], { id: "solo-cli", captionStub: false, label: true }); // the CLI's shape
    await core.composeFigure(root, [one, svg], { id: "duo", captionStub: false, label: true });
    await core.composeFigure(root, [one, svg], { id: "duo-off", captionStub: false, label: false });
    const idx3 = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
    const canvasOf = (fid: string) => idx3.figures.find((f: any) => f.id === fid).canvas;
    const labelsOf = async (fid: string) => {
      const cf3 = JSON.parse(await fs.readFile(path.join(root, "fig", "canvases", `${canvasOf(fid)}.json`), "utf8"));
      return cf3.figures.find((f: any) => f.id === fid).elements.filter((e: any) => e.type === "text" && e.panelLabel);
    };
    assert((await labelsOf("solo-core")).length === 0, "1-panel compose mints NO label (core default)");
    assert((await labelsOf("solo-cli")).length === 0, "1-panel compose mints NO label even with label:true (CLI shape) — surfaces AGREE");
    const duo = await labelsOf("duo");
    assert(duo.length === 2 && duo[0].text === "a", "2-panel compose mints a/b labels");
    assert((await labelsOf("duo-off")).length === 0, "label:false suppresses labels at 2 panels");
  }

  console.log("\nW9 VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(ext, { recursive: true, force: true });
}
