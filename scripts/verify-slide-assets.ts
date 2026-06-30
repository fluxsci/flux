#!/usr/bin/env -S npx tsx
// Regression: loadDeckAssets must make a plot ANIMATABLE (load its manifest into
// the plot cache) even when the deck element carries only `svgPath` and no
// `manifestPath` — decks authored before manifestPath was persisted. The manifest
// is found via the `.fluxplot.json` SIBLING of the SVG. Reproduces the user's
// KDFLUX1 bug ("no build manifest" on a plot whose sidecar sits right next to it).
// Self-contained: a temp project with one synthetic semantic plot + one bare SVG.
//   npx tsx scripts/verify-slide-assets.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
const ROOT = await fs.mkdtemp(`${os.tmpdir()}/flux-assets-`);
// minimal Electron FileBridge over node fs, rooted nowhere (absolute paths)
const fig = {
  async exists(p: string) { try { await fs.access(p); return true; } catch { return false; } },
  async readText(p: string) { return fs.readFile(p, "utf8"); },
  async readdir(p: string) { const es = await fs.readdir(p, { withFileTypes: true }); return es.map((e) => ({ name: e.name, dir: e.isDirectory() })); },
};
(globalThis as { window?: unknown }).window = { fig };
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { plotManifests, plotDom, cachePlot, clearPlots } = await import("../src/lib/plot/store");
const slideOps = await import("../src/lib/slide/ops");
const { loadDeckAssets } = await import("../src/lib/project/slideBridge");
const { get } = await import("svelte/store");

function assert(cond: unknown, msg: string) { if (!cond) throw new Error("FAIL: " + msg); console.log("  ok:", msg); }

// --- fixture: plots/semantic.svg (+ sidecar) and plots/bare.svg (no sidecar) ---
await fs.mkdir(`${ROOT}/plots`, { recursive: true });
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="axis.x"><path d="M0 0H10"/></g></svg>`;
const MANIFEST = { spec: "fluxplot", schemaVersion: "0.2.0", parts: { id: "figure", role: "figure", children: [] }, build: { order: ["axis.x"], presets: { axis: { animation: "draw-on", durationMs: 400 } } } };
await fs.writeFile(`${ROOT}/plots/semantic.svg`, SVG);
await fs.writeFile(`${ROOT}/plots/semantic.fluxplot.json`, JSON.stringify(MANIFEST));
await fs.writeFile(`${ROOT}/plots/bare.svg`, SVG); // no sidecar → non-semantic

// a deck whose plot elements carry ONLY svgPath (the pre-manifestPath shape)
const deck = slideOps.createDeck({ id: "d", title: "d" });
const sid = slideOps.addSlide(deck, { name: "s", layout: "blank" }).id;
const semId = slideOps.addPlotToSlide(deck, sid, { assetId: "semantic", x: 0, y: 0, width: 8, height: 5, source: { svgPath: "plots/semantic.svg" } })!;
slideOps.addPlotToSlide(deck, sid, { assetId: "bare", x: 0, y: 0, width: 8, height: 5, source: { svgPath: "plots/bare.svg" } })!;
const semEl = deck.slides.flatMap((s) => s.elements).find((e) => e.id === semId) as { source?: { svgPath?: string; manifestPath?: string } } | undefined;
assert(semEl?.source?.svgPath && !semEl.source.manifestPath, "fixture element has svgPath but NO manifestPath (the bug condition)");

// 1. fresh open: the sibling manifest is found despite the missing manifestPath
clearPlots();
await loadDeckAssets(ROOT, deck);
assert(plotDom.has("semantic"), "semantic plot's SVG is cached (it renders)");
assert(!!get(plotManifests)["semantic"], "its manifest is loaded via the .fluxplot.json SIBLING → Auto-animate ENABLED");
assert((get(plotManifests)["semantic"] as typeof MANIFEST)?.build?.order?.length === 1, "the loaded manifest carries the build hints");
assert(plotDom.has("bare"), "the non-semantic plot still renders");
assert(!get(plotManifests)["bare"], "the non-semantic plot has no manifest (correctly — no sidecar)");

// 2. heal: a plot whose dom was cached WITHOUT a manifest (a live broken session)
//    gets its manifest backfilled on the next loadDeckAssets — no restart needed.
clearPlots();
cachePlot("semantic", SVG, undefined as never); // dom present, manifest missing — the reported state
assert(plotDom.has("semantic") && !get(plotManifests)["semantic"], "broken state reproduced: dom cached, manifest missing");
await loadDeckAssets(ROOT, deck);
assert(!!get(plotManifests)["semantic"], "in-app reload BACKFILLS the missing manifest (heals without re-parsing the SVG)");

// 3. idempotent
const before = get(plotManifests)["semantic"];
await loadDeckAssets(ROOT, deck);
assert(get(plotManifests)["semantic"] === before, "a second pass is a no-op (fully-cached plots are skipped)");

await fs.rm(ROOT, { recursive: true, force: true });
console.log("\nSLIDE-ASSETS (manifest sibling-derivation) REGRESSION PASSED");
