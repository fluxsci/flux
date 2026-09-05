// Accepted source bundles, frozen copies and animation-only dependencies in
// the actual Node export path. Writes one disposable project, no FluxConfig.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDeck } from "../src/lib/slide/ops";
import { gatherDeckPayload, saveDeck } from "../flux-core/slides";
import { planFigSave, executeFigSave } from "../src/lib/project/figfiles";
import type { Project, SemanticPlotElement } from "../src/lib/types";
import { reconcileDeckExternalAssetSizes } from "../src/lib/slide/sourceSync";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-deck-source-"));
const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-deck-external-"));
const write = async (p: string, text: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, text); };
const svg = (version: string, width = 200) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100" data-version="${version}"><rect width="${width}" height="100" fill="blue"/></svg>`;
const manifest = (version: number) => JSON.stringify({ spec: "fluxplot", schemaVersion: "0.2.0", axes: [], series: [], version });
let checks = 0;
function eq(a: unknown, b: unknown, label: string) { assert.deepEqual(a, b, label); checks++; console.log("  ok:", label); }
try {
  await write(`${root}/project.json`, JSON.stringify({ schemaVersion: "0.1.0", title: "Deck source gate", figures: [], slides: [], manuscript: { path: "manuscript/main.qmd" }, supplementary: [] }));
  const placed = (id: string, assetId = id, frozen = false): SemanticPlotElement => ({ id: `el-${id}`, type: "plot", assetId, x: 25, y: 30, width: 100, height: 50, rotation: 15, source: { svgPath: `plots/${assetId}.svg`, ...(frozen ? { frozen: true } : {}) }, overrides: { figure: { opacity: .7 } } });
  const project: Project = { version: 2, name: "Sources", canvases: [{ id: "c", name: "Canvas" }], figures: [{ id: "f", name: "Figure 1", referenceKey: "fig-stable", canvasId: "c", x: 0, y: 0, width: 300, height: 150, background: "#fff", elements: [placed("shared", "shared", true)] }], assets: [{ id: "shared", name: "shared.svg", kind: "svg", path: "assets/shared.svg", naturalWidth: 200, naturalHeight: 100 }], palette: [] };
  await write(`${root}/fig/assets/shared.svg`, svg("accepted-shared"));
  await write(`${root}/fig/assets/shared.fluxplot.json`, manifest(1));
  await executeFigSave(planFigSave(project, null), { read: async (rel) => fs.readFile(`${root}/${rel}`, "utf8").catch(() => null), write: (rel, text) => write(`${root}/${rel}`, text) });
  const deck = createDeck({ id: "talk", withTitleSlide: false });
  deck.slides = [{ id: "slide", name: "Editable", camera: { x: 140, y: 120, zoom: 1.4 }, elements: [placed("local"), placed("frozen", "frozen", true), placed("shared")], beats: [{ id: "base", tracks: [] }, { id: "change", tracks: [{ id: "target", target: "el-local", preset: "transform", to: { assetId: "target", svgPath: "plots/target.svg", state: { x: 450, width: 333 } } }] }, { id: "frozen-change", tracks: [{ id: "frozen-target", target: "el-local", preset: "transform", to: { assetId: "target-frozen", svgPath: "plots/target-frozen.svg", frozen: true } }] }] }];
  deck.slides[0].elements.push({ ...placed("raw"), source: { svgPath: `${externalRoot}/plots/raw.svg`, manifestPath: `${externalRoot}/custom.json`, external: true } });
  await write(`${externalRoot}/plots/raw.svg`, svg("explicit-external"));
  await write(`${externalRoot}/custom.json`, manifest(77));
  await write(`${root}/plots/raw.svg`, svg("wrong-project-collision"));
  for (const id of ["local", "frozen", "target", "target-frozen"]) {
    deck.assets.push({ id, name: `${id}.svg`, kind: "svg", path: `assets/${id}.svg`, naturalWidth: 200, naturalHeight: 100 });
    await write(`${root}/slides/talk/assets/${id}.svg`, svg(`accepted-${id}`));
    await write(`${root}/slides/talk/assets/${id}.fluxplot.json`, manifest(1));
    await write(`${root}/plots/${id}.svg`, svg(`source-${id}`, 400));
    await write(`${root}/plots/${id}.fluxplot.json`, manifest(2));
  }
  await write(`${root}/plots/shared.svg`, svg("raw-shared-must-not-win", 600));
  await write(`${root}/plots/shared.fluxplot.json`, manifest(9));
  await saveDeck(root, deck);
  const first = await gatherDeckPayload(root, "talk");
  eq(first.warnings, [], "complete linked and frozen deck exports without gaps");
  eq(first.payload.plots?.local.svg.includes('data-version="source-local"'), true, "Node export accepts linked local source before gathering");
  eq(first.payload.plots?.target.svg.includes('data-version="source-target"'), true, "animation-only target source participates in catch-up");
  eq(first.payload.plots?.frozen.svg.includes('data-version="accepted-frozen"'), true, "frozen deck copy retains accepted bytes despite changed source");
  eq(first.payload.plots?.["target-frozen"].svg.includes('data-version="accepted-target-frozen"'), true, "animation-only frozen target retains accepted SVG despite changed source");
  eq((first.payload.plots?.["target-frozen"].manifest as { version?: number }).version, 1, "animation-only frozen target retains its matching semantic sidecar");
  eq(first.payload.deck.assets.find((a) => a.id === "target-frozen")?.naturalWidth, 200, "animation-only frozen target retains its accepted intrinsic size");
  eq(first.payload.plots?.shared.svg.includes('data-version="accepted-shared"'), true, "registered Figure snapshot wins over raw source");
  eq((first.payload.plots?.shared.manifest as { version?: number }).version, 1, "Figure snapshot retains its matching accepted semantic sidecar");
  eq(first.payload.plots?.raw.svg.includes('data-version="explicit-external"'), true, "explicit external source wins over an in-project basename collision");
  eq((first.payload.plots?.raw.manifest as { version?: number }).version, 77, "unregistered external source honors its explicit semantic path");
  eq(first.payload.deck.slides[0].elements.find((e) => e.id === "el-local")?.width, 200, "local source resize preserves deliberate half scale");
  eq(first.payload.deck.stage, deck.stage, "source sizing never enlarges the fixed stage");
  eq(first.payload.deck.slides[0].camera, deck.slides[0].camera, "source refresh preserves authored camera");
  eq(first.payload.deck.slides[0].beats, deck.slides[0].beats, "source refresh preserves animation endpoint patches");
  const deckPath = `${root}/slides/talk/deck.json`, before = await fs.readFile(deckPath, "utf8");
  await gatherDeckPayload(root, "talk");
  eq(await fs.readFile(deckPath, "utf8"), before, "no-change export does not rewrite the deck");
  await write(`${root}/plots/target.fluxplot.json`, manifest(3));
  const semantic = await gatherDeckPayload(root, "talk");
  eq((semantic.payload.plots?.target.manifest as { version?: number }).version, 3, "manifest-only target update reaches offline payload");
  eq(JSON.parse(await fs.readFile(`${root}/slides/talk/assets/target.fluxplot.json`, "utf8")).version, 3, "manifest-only update is durable before export");
  await write(`${root}/plots/local.svg`, "<svg><rect");
  const broken = await gatherDeckPayload(root, "talk");
  eq(broken.payload.plots?.local.svg.includes('data-version="source-local"'), true, "partially written source retains last-good exported bundle");
  eq(broken.warnings.some((w) => /malformed/.test(w)), true, "source rejection explains why the previous revision remains");
  await fs.rm(`${root}/plots/target.fluxplot.json`);
  const removed = await gatherDeckPayload(root, "talk");
  eq((removed.payload.plots?.target.manifest as { version?: number }).version, undefined, "removed source sidecar does not survive in the export");
  eq(await fs.readFile(`${root}/slides/talk/assets/target.fluxplot.json`, "utf8").catch(() => null), null, "removed source sidecar is removed durably");
  // Same authored physical scale, one deck observing each source revision
  // and one remaining closed through both. Saved intrinsic baselines make
  // reopening/export independent of that observation history.
  for (const id of ["continuous", "closed"]) {
    const linked = createDeck({ id, withTitleSlide: false });
    linked.slides = [{ id: "s", elements: [placed("shared")], beats: [{ id: "base", tracks: [] }] }];
    await saveDeck(root, linked);
    eq(linked.externalAssetSizes?.shared, { width: 200, height: 100 }, "new external reference seeds intrinsic baseline at save");
  }
  const setShared = async (width: number) => {
    const index = JSON.parse(await fs.readFile(`${root}/fig/index.json`, "utf8"));
    index.assets.find((a: {id: string}) => a.id === "shared").naturalWidth = width;
    await write(`${root}/fig/index.json`, JSON.stringify(index));
    await write(`${root}/fig/assets/shared.svg`, svg(`shared-${width}`, width));
  };
  await setShared(400);
  eq((await gatherDeckPayload(root, "continuous")).payload.deck.slides[0].elements[0].width, 200, "first observed external revision preserves half scale");
  await setShared(600);
  const continuous = (await gatherDeckPayload(root, "continuous")).payload.deck;
  const closed = (await gatherDeckPayload(root, "closed")).payload.deck;
  eq([continuous.slides[0].elements[0].width, closed.slides[0].elements[0].width], [300, 300], "closed and continuously refreshed deck exports converge on the same physical scale");
  eq(JSON.parse(await fs.readFile(`${root}/slides/closed/deck.json`, "utf8")).externalAssetSizes.shared, { width: 600, height: 100 }, "closed-deck catch-up persists its new accepted intrinsic baseline");
  const legacy = structuredClone(closed); delete legacy.externalAssetSizes;
  reconcileDeckExternalAssetSizes(legacy, [{ id: "shared", naturalWidth: 800, naturalHeight: 100 }]);
  eq([legacy.slides[0].elements[0].width, legacy.externalAssetSizes?.shared.width], [300, 800], "legacy missing baseline adopts current dimensions once without inventing past scale");
  const unavailableIndex = JSON.parse(await fs.readFile(`${root}/fig/index.json`, "utf8"));
  unavailableIndex.assets.find((a: {id: string}) => a.id === "shared").naturalWidth = 800;
  await write(`${root}/fig/index.json`, JSON.stringify(unavailableIndex));
  await fs.rm(`${root}/fig/assets/shared.svg`);
  const unavailable = await gatherDeckPayload(root, "closed");
  eq([unavailable.payload.deck.slides[0].elements[0].width, unavailable.payload.deck.externalAssetSizes?.shared.width], [300, 600], "missing accepted bytes cannot advance baseline or resize a retained placement");
} finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(externalRoot, { recursive: true, force: true }); }
console.log(`SLIDE SOURCE SYNC: PASS (${checks} assertions)`);
