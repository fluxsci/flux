// Disposable fixture for the native watcher gate. Uses the production file
// builders; no renderer dev handles or mocked bridges are involved.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildScaffoldTree } from "../../src/lib/project/scaffoldTree";
import { createDeck } from "../../src/lib/slide/ops";
import { reconcileDeckExternalAssetSizes } from "../../src/lib/slide/sourceSync";
import { executeFigSave, planFigSave } from "../../src/lib/project/figfiles";
import type { Project, SemanticPlotElement } from "../../src/lib/types";

const [root, external] = process.argv.slice(2);
if (!root || !external) throw new Error("Native source fixture requires project and external scratch paths");
const write = async (p: string, text: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, text); };
const svg = (source: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120" data-probe-source="${source}" data-source-version="1"><rect x="0" y="0" width="200" height="120" fill="#4385be"/><text x="15" y="65" font-size="24" fill="white">${source} v1</text></svg>`;
const manifest = JSON.stringify({ spec: "fluxplot", schemaVersion: "0.2.0", axes: [], series: [], probeVersion: 1 });
const asset = (id: string) => ({ id, name: `${id}.svg`, kind: "svg" as const, path: `assets/${id}.svg`, naturalWidth: 200, naturalHeight: 120 });
const plot = (id: string, assetId: string, sourcePath: string, x: number, frozen = false): SemanticPlotElement => ({
  id, type: "plot", assetId, x, y: 70, width: 100, height: 60, rotation: 0,
  source: { svgPath: sourcePath, ...(path.isAbsolute(sourcePath) ? { external: true } : {}), ...(frozen ? { frozen: true } : {}) }, overrides: {},
});
const externalFigure = path.join(external, "external-figure.svg"), externalDeck = path.join(external, "external-deck.svg");
await write(path.join(external, "unlinked-neighbor.txt"), "This neighboring file is not a linked source.\n");
const deck = createDeck({ id: "watcher-talk", title: "Native source watcher", withTitleSlide: false });
deck.stage = { width: 1280, height: 720 };
deck.slides = [{ id: "watcher-slide", name: "Source watcher", elements: [
  plot("slide-shared", "shared", "plots/shared.svg", 40),
  plot("slide-local", "local", "plots/local.svg", 370),
  plot("slide-frozen", "deck-frozen", "plots/frozen.svg", 700, true),
  plot("slide-external", "deck-external", externalDeck, 840),
], beats: [{ id: "base", tracks: [] }, { id: "change", label: "Result", tracks: [
  { id: "change-local", target: "slide-local", preset: "transform", duration: 800, to: { assetId: "target", svgPath: "plots/target.svg", state: { x: 350, width: 180 } } },
] }] }];
deck.assets = ["local", "deck-frozen", "deck-external", "target"].map(asset);
// Same intrinsic baseline that a newly authored Figure link records. This
// must survive source regeneration before this deck is ever opened.
reconcileDeckExternalAssetSizes(deck, [asset("shared")]);
const tree = buildScaffoldTree({ title: "Native source watcher" }, deck);
for (const d of tree.dirs) await fs.mkdir(path.join(root, d), { recursive: true });
for (const [rel, text] of tree.files) await write(path.join(root, rel), text);
const model: Project = { version: 2, name: "Native sources", canvases: [{ id: "source-canvas", name: "Source checks" }], figures: [{
  id: "source-figure", referenceKey: "fig-native-source", name: "Figure 1", family: "figure", number: 1, canvasId: "source-canvas", x: 0, y: 0, width: 660, height: 200, background: "#ffffff", captions: { "": "A linked source and independent frozen copy." }, elements: [
    plot("figure-live", "shared", "plots/shared.svg", 20),
    plot("figure-frozen", "figure-frozen", "plots/frozen.svg", 240, true),
    plot("figure-external", "figure-external", externalFigure, 460),
  ],
}], assets: ["shared", "figure-frozen", "figure-external"].map(asset), palette: [] };
await executeFigSave(planFigSave(model, null), { read: async rel => fs.readFile(path.join(root, rel), "utf8").catch(() => null), write: (rel, text) => write(path.join(root, rel), text) });
for (const [rel, source] of [
  ["plots/shared.svg", "shared"], ["plots/frozen.svg", "frozen"], ["plots/local.svg", "local"], ["plots/target.svg", "target"],
  ["fig/assets/shared.svg", "shared"], ["fig/assets/figure-frozen.svg", "frozen"], ["fig/assets/figure-external.svg", "external-figure"],
  ["slides/watcher-talk/assets/local.svg", "local"], ["slides/watcher-talk/assets/deck-frozen.svg", "frozen"],
  ["slides/watcher-talk/assets/deck-external.svg", "external-deck"], ["slides/watcher-talk/assets/target.svg", "target"],
]) { await write(path.join(root, rel), svg(source)); await write(path.join(root, rel.replace(/\.svg$/, ".fluxplot.json")), manifest); }
for (const [p, source] of [[externalFigure, "external-figure"], [externalDeck, "external-deck"]]) {
  await write(p, svg(source)); await write(p.replace(/\.svg$/, ".fluxplot.json"), manifest);
}
await write(path.join(root, "manuscript/main.qmd"), "---\ntitle: Native source watcher\n---\n\n# Results\n\nSee @fig-native-source.\n\n![](../fig/renders/source-figure.svg){#fig-native-source}\n\nThe source updates while this document remains open.\n");
console.log("Native source fixture prepared");
