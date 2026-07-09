#!/usr/bin/env -S npx tsx
// Regression: loadDeckAssets must make a plot ANIMATABLE (load its manifest into
// the plot cache) even when the deck element carries only `svgPath` and no
// `manifestPath` — decks authored before manifestPath was persisted. The manifest
// is found via the `.fluxplot.json` SIBLING of the SVG. Reproduces the user's
// KDFLUX1 bug ("no build manifest" on a plot whose sidecar sits right next to it).
// figure-v1 P4 update: a sidecar-less svg is no longer manifest-less — cachePlot
// DERIVES one (spec "fluxplot-derived/1", isDerivedManifest) — so the invariants
// are: bare svg ⇒ derived manifest; real sidecar ⇒ real manifest, and it must
// backfill OVER a derived one (a derived manifest never blocks the heal).
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
const { isDerivedManifest } = await import("../src/lib/plot/derive");
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
await fs.writeFile(`${ROOT}/plots/bare.svg`, SVG); // no sidecar → derived manifest (P4)

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
assert(!isDerivedManifest(get(plotManifests)["semantic"]), "…and it is the REAL sidecar, not a derived stand-in");
assert(plotDom.has("bare"), "the non-semantic plot still renders");
// figure-v1 P4: EVERY svg is a semantic plot — a sidecar-less file gets a
// DERIVED manifest at cachePlot (spec marker), so it is x-rayable/animatable.
assert(!!get(plotManifests)["bare"], "the sidecar-less plot has a manifest too (derived at cachePlot)");
assert(isDerivedManifest(get(plotManifests)["bare"]), "…carrying the derived spec marker (fluxplot-derived/1) — never a fake fluxplot");
assert(!!(get(plotManifests)["bare"] as { parts?: { id?: string } }).parts, "…with a parts tree synthesized from the DOM");

// 2. heal: a plot whose dom was cached WITHOUT its sidecar (a live broken
//    session) now carries a DERIVED manifest — the next loadDeckAssets must
//    still find the real sibling and backfill it over the derived one.
clearPlots();
cachePlot("semantic", SVG); // dom cached sidecar-less — manifest is DERIVED, not the real one
assert(plotDom.has("semantic") && isDerivedManifest(get(plotManifests)["semantic"]), "broken state reproduced: dom cached, only a derived manifest");
await loadDeckAssets(ROOT, deck);
assert(!!get(plotManifests)["semantic"] && !isDerivedManifest(get(plotManifests)["semantic"]), "in-app reload BACKFILLS the real manifest over the derived one (heals without re-parsing the SVG)");
assert((get(plotManifests)["semantic"] as typeof MANIFEST)?.build?.order?.length === 1, "…and the healed manifest carries the build hints");

// 3. idempotent
const before = get(plotManifests)["semantic"];
await loadDeckAssets(ROOT, deck);
assert(get(plotManifests)["semantic"] === before, "a second pass is a no-op (fully-cached plots are skipped)");

await fs.rm(ROOT, { recursive: true, force: true });
console.log("\nSLIDE-ASSETS (manifest sibling-derivation) REGRESSION PASSED");
