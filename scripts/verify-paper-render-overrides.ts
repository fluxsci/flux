#!/usr/bin/env -S npx tsx
// The 2026-08-12 report: every paper-mode figure surface (embeds, hover cards,
// pickers, in-app preview/PDF, app-side materializeRenders) rendered plots
// WITHOUT per-part overrides — scholar/figures.ts passed no plotMarkup to
// figureToSvg, so a title the user hid in the figure editor came back beside
// its remade replacement (the double-title), crops were lost, and one figure
// whose render threw took down the whole FigurePicker on both entry paths.
// This gate pins the fix:
//   1. PARITY (Twin-Engine §2): the paper layer's renderFigureSvg output is
//      byte-identical to flux-core's override-aware renderFigureSvg for the
//      same on-disk figure (both run the shared plot/inlineMarkup pipeline;
//      under linkedom the serializers match exactly).
//   2. Overrides: a `hidden` part override stays hidden; the remade title
//      text element renders.
//   3. Crop: a cropped plot serializes with the crop viewBox, not a stretch.
//   4. Hardening: a figure whose serialization throws yields undefined (and
//      caches the failure) instead of propagating — one broken figure must
//      never kill a surface again.
//   Run: npx tsx scripts/verify-paper-render-overrides.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-paper-render-overrides");

// --- hermetic env: HOME + XDG into a scratch dir BEFORE flux-core loads ------
// (verify-f1-core.ts idiom — nothing here may touch the real ~/FluxConfig).
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), "flux-paperrender-"));
const HOME = path.join(SCRATCH, "home");
await fs.mkdir(path.join(HOME, ".config"), { recursive: true });
process.env.HOME = HOME;
process.env.XDG_CONFIG_HOME = path.join(HOME, ".config");
process.env.FLUX_NO_MIGRATE = "1";

const core = await import("../flux-core/index");
const { ensureDom } = await import("../flux-core/render");
await ensureDom(); // linkedom DOMParser — the paper module needs it headless too
const { __seedFigures, renderFigureSvg, renderFigureSvgForDisk } = await import(
  "../src/shell/modes/paper/scholar/figures"
);
import type { Figure } from "../src/lib/types";

const PLOT =
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">` +
  `<g id="figure.title" data-role="title" data-kind="text"><text x="100" y="16">BAKED TITLE</text></g>` +
  `<rect id="bar1" x="20" y="40" width="30" height="60" fill="#336699"/></svg>`;

const ref = (id: string) => ({
  id, label: `fig-${id}`, name: id, family: "figure", number: 1, display: "Fig. 1",
  captionLabel: "Figure 1 | ", order: 1, canvas: "c1", caption: "", panels: [],
});

const root = path.join(SCRATCH, "proj");
try {
  await core.scaffold(root, { title: "PaperRenderOverrides" });
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  const plotPath = path.join(root, "plots", "titled.svg");
  await fs.writeFile(plotPath, PLOT);
  const comp = await core.composeFigure(root, [plotPath], { id: "titlefig", captionStub: false });

  // The reporting user's exact edit: hide the baked title via a per-part
  // override, remake it as a plain text element.
  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  const canvasId: string = idx.figures.find((f: { id: string }) => f.id === comp.figureId).canvas;
  const cpath = path.join(root, "fig", "canvases", `${canvasId}.json`);
  const cf = JSON.parse(await fs.readFile(cpath, "utf8"));
  const fig = cf.figures.find((f: { id: string }) => f.id === comp.figureId) as Figure;
  const plotEl = fig.elements.find((e) => e.type === "plot") as {
    assetId: string;
    overrides?: Record<string, unknown>;
    crop?: { x: number; y: number; width: number; height: number };
  };
  plotEl.overrides = { "figure.title": { hidden: true } };
  fig.elements.push({
    type: "text", id: "text_remade_title", x: 10, y: 2, width: 180, height: 14,
    rotation: 0, text: "REMADE TITLE", fontSize: 10, color: "#111",
    fontFamily: "Arial", fontWeight: 400, align: "center", sizing: "auto-h",
  } as never);
  await fs.writeFile(cpath, JSON.stringify(cf, null, 2));

  // Seed the paper layer with the same on-disk state readFigSource would load.
  const assetBytes = await fs.readFile(path.join(root, "fig", "assets", `${plotEl.assetId}.svg`));
  const assetData = {
    [plotEl.assetId]: `data:image/svg+xml;base64,${assetBytes.toString("base64")}`,
  };
  const seed = () => __seedFigures([ref(fig.id)], { [fig.id]: fig }, assetData, [], {}, []);

  h.section("parity + overrides");
  const coreSvg = await core.renderFigureSvg(root, comp.figureId);
  seed();
  // DISK path (materializeRenders → fig/renders/): byte parity with flux-core.
  const diskSvg = renderFigureSvgForDisk(fig.id);
  h.ok(!!diskSvg, "paper disk render produces output");
  h.ok(diskSvg === coreSvg, "disk render is byte-identical to flux-core's override-aware render");
  // DISPLAY path: same render, plot-internal ids under the paper namespace so a
  // DOM-mounted copy can never duplicate the figure editor's element-prefixed
  // ids (the 2026-08-13 blank-plots clip collision — verify-clip-collision).
  const paperSvg = renderFigureSvg(fig.id);
  h.ok(!!paperSvg, "paper display render produces output");
  const plotElId = (fig.elements.find((e) => e.type === "plot") as { id: string }).id;
  h.ok(!!paperSvg && paperSvg.includes(`id="pap__${plotElId}__`), "display plot ids carry the paper namespace");
  h.ok(!!paperSvg && !paperSvg.includes(`id="${plotElId}__`), "no display id matches the figure editor's element prefix");
  h.ok(
    !!paperSvg && paperSvg.split(`pap__${plotElId}`).join(plotElId) === coreSvg,
    "display render equals the disk render modulo the namespace",
  );
  h.ok(!!paperSvg && !paperSvg.includes("<image"), "plot is inlined as vector parts, not an <image> raster");
  h.ok(!!paperSvg && paperSvg.includes("REMADE TITLE"), "remade title text element renders");
  const ti = paperSvg?.indexOf("BAKED TITLE") ?? -1;
  h.ok(
    ti < 0 || (paperSvg?.slice(Math.max(0, ti - 400), ti).includes("display:") ?? false),
    "hidden override applies — the baked title does not draw",
  );
  h.ok(renderFigureSvg(fig.id) === paperSvg, "render cache returns the same output");

  h.section("crop");
  plotEl.crop = { x: 0, y: 0, width: 100, height: 60 };
  seed(); // reseed clears the render cache
  const cropped = renderFigureSvg(fig.id);
  h.ok(!!cropped && /viewBox="0 0 100 60"/.test(cropped), "crop serializes as the crop viewBox window");
  h.ok(!!cropped && cropped.includes('overflow="hidden"'), "cropped plot clips its overflow");

  h.section("hardening — one broken figure never kills a surface");
  const bad = {
    id: "badfig", name: "Bad", width: 200, height: 120,
    // fontFamily deliberately missing → TypeError inside elementToSvg's esc()
    elements: [{ type: "text", id: "t1", x: 10, y: 10, width: 100, height: 20, rotation: 0,
      text: "poisoned", fontSize: 10, color: "#111", fontWeight: 400, align: "left", sizing: "auto-h" }],
  } as unknown as Figure;
  __seedFigures([ref(fig.id), ref("badfig")], { [fig.id]: fig, badfig: bad }, assetData, [], {}, []);
  let threw = false;
  let badSvg: string | undefined = "unset";
  try {
    badSvg = renderFigureSvg("badfig");
  } catch {
    threw = true;
  }
  h.ok(!threw, "a throwing figure render does not propagate (the dead-picker bug)");
  h.ok(badSvg === undefined, "broken figure renders as undefined (surfaces show 'no preview')");
  h.ok(renderFigureSvg("badfig") === undefined, "failure is cached — repeat renders stay quiet");
  h.ok(!!renderFigureSvg(fig.id), "healthy figures still render alongside the broken one");
} finally {
  await fs.rm(SCRATCH, { recursive: true, force: true });
}

await h.done();
