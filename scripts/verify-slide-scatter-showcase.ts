#!/usr/bin/env -S npx tsx
// anim 3.2 — the SCATTER SHOWCASE acceptance. The user's north-star scenario, end
// to end on the REAL KDFLUX1 06_scatter_regression, with the whole pipeline wired:
// cache the real plot → applyAutoAnimation → render the slide through the ONE
// renderer → computeSlideAnims → applyStatic at each beat, and assert the plot
// reveals progressively: empty at Start, axis spine DRAWN ON at the Axes beat,
// scatter points HIDDEN until the Data beat then SHOWN. Run:
//   npx tsx scripts/verify-slide-scatter-showcase.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

// imports AFTER the DOM globals are in place (modules read `document` on load)
const { cachePlot } = await import("../src/lib/plot/store");
const slideOps = await import("../src/lib/slide/ops");
const { applyAutoAnimation } = await import("../src/lib/slide/autobuild");
const { renderSlide } = await import("../src/lib/slide/player/render");
const { computeSlideAnims, applyStatic } = await import("../src/lib/slide/player/player");
const { FLUX_DARK } = await import("../src/lib/slide/theme");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const style = (el: Element | null, prop: string): string =>
  el ? ((el as unknown as { style: Record<string, string> }).style?.[prop] ?? "") : "<no-node>";

// Fixture vendored in-repo (was read from the author's now-deleted ~/KDFLUX1).
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pre-regen", "06_scatter_regression");
const svg = await fs.readFile(base + ".svg", "utf8");
const manifest = JSON.parse(await fs.readFile(base + ".fluxplot.json", "utf8"));

// 1. cache the REAL plot (parses the SVG + registers its manifest)
const cached = cachePlot("scatter", svg, manifest);
assert(cached, "the real scatter plot SVG parses + caches");

// 2. build a deck with the plot, then ONE-CLICK auto-animate it
const deck = slideOps.createDeck({ id: "showcase", title: "Scatter showcase" });
const sid = slideOps.addSlide(deck, { name: "Scatter", layout: "blank" }).id;
const elId = slideOps.addPlotToSlide(deck, sid, { assetId: "scatter", x: 0, y: 0, width: 1280, height: 720 })!;
const added = applyAutoAnimation(deck, sid, elId, manifest);
assert(added === 4, "auto-animate builds the 4-phase sequence (Axes/Gridlines/Data/Legend)");
const slide = slideOps.slideById(deck, sid)!;

// 3. render the slide through the ONE renderer, then flatten its beats → specs
const host = document.createElement("div") as unknown as HTMLElement;
const opts = { theme: FLUX_DARK, plotManifest: (id: string) => (id === "scatter" ? manifest : undefined) } as const;
const rendered = renderSlide(host, slide, deck.stage, opts);
assert(rendered.elements.get(elId), "the plot element renders into the stage");
const specs = computeSlideAnims(slide, rendered, host, deck.stage, opts);
assert(specs.length > 100, `pipeline produced specs for the whole scene (${specs.length})`);

// the rendered, id-prefixed parts we assert the progressive reveal on. NB: the
// renderer prefixes part ids with the SLIDE ELEMENT id (elId), not the asset id.
// the strokable <path> lives inside the part's <g> wrapper — query it directly
// (drawOn dashes the path, not the group; the group comes first in doc order).
const spinePath = () => host.querySelector(`[id="${elId}__axis.x.spine"] path`);
const aPoint = () => host.querySelector(`[id="${elId}__setosa.point.0"]`);
const fitLine = () => host.querySelector(`[id="${elId}__fit.line"] path`);

// 4. the acceptance: scrub each beat, assert the resting state -----------------
applyStatic(specs, 0); // Start — everything hidden
assert(style(spinePath(), "strokeDashoffset") !== "0" && style(spinePath(), "strokeDashoffset") !== "", "Start: the x-axis spine rests UNDRAWN");
assert(style(aPoint(), "opacity") === "0", "Start: the scatter points are hidden");
assert(style(fitLine(), "strokeDashoffset") !== "0", "Start: the fit line rests undrawn");

applyStatic(specs, 1); // Axes — spines/ticks draw on
assert(style(spinePath(), "strokeDashoffset") === "0", "Axes beat: the x-axis spine is DRAWN ON");
assert(style(aPoint(), "opacity") === "0", "Axes beat: the points are still hidden (their beat is later)");

applyStatic(specs, 3); // Data — points stagger in, line draws on
assert(style(aPoint(), "opacity") === "1", "Data beat: the scatter points are SHOWN");
assert(style(fitLine(), "strokeDashoffset") === "0", "Data beat: the fit line is DRAWN ON");

// 5. reversibility (the scrubber/export substrate) ----------------------------
applyStatic(specs, 0);
assert(style(aPoint(), "opacity") === "0", "scrub back to Start re-hides the points (deterministic)");

console.log("\nSCATTER SHOWCASE (anim 3.2) ACCEPTANCE PASSED — the north-star scenario works end to end.");
