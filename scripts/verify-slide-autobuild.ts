#!/usr/bin/env -S npx tsx
// anim 1.4 — autoAnimatePlot against the REAL scatter_regression plot. Proves the
// one-click build produces the user's north-star sequence straight from the
// plot's own build hints: axes draw on (labels fade, not draw), gridlines fade as
// their own step, the fit line draws itself as the points stagger in left→right,
// legend last. Run: npx tsx scripts/verify-slide-autobuild.ts
import * as fs from "node:fs/promises";
import { autoAnimatePlot } from "../src/lib/slide/autobuild";
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const M = "/home/driessen2/KDFLUX1/plots/example_set/06_scatter_regression.fluxplot.json";
const manifest = JSON.parse(await fs.readFile(M, "utf8")) as FluxPlotManifest;
const beats = autoAnimatePlot(manifest, "plot1");

// --- phase structure ---------------------------------------------------------
assert(beats.length === 4, "4 phase beats produced");
assert(beats.map((b) => b.label).join(" | ") === "Axes | Gridlines | Data | Legend & annotations", "beats labelled by phase, in order");

// --- Axes: spines+ticks draw-on; labels+title fade; gridlines excluded -------
const axes = beats[0];
const drawParts = axes.tracks.filter((t) => t.preset === "drawOn").map((t) => t.part);
const fadeParts = axes.tracks.filter((t) => t.preset === "fade").map((t) => t.part);
assert(["axis.x.spine", "axis.x.ticks", "axis.y.spine", "axis.y.ticks"].every((p) => drawParts.includes(p)), "Axes: both spines + tick marks draw-on");
assert(["axis.x.tick-labels", "axis.x.title", "axis.y.tick-labels", "axis.y.title"].every((p) => fadeParts.includes(p)), "Axes: tick-labels + titles fade-in");
assert(!axes.tracks.some((t) => /tick-label|title/.test(t.part) && t.preset === "drawOn"), "Axes: NEVER draw-on a text label (the role-correctness rule)");
assert(!axes.tracks.some((t) => t.part.includes("gridline")), "Axes: gridlines are NOT in this beat (they are their own step)");

// --- Gridlines: both axes, fade ----------------------------------------------
const grid = beats[1];
assert(grid.tracks.length === 2 && grid.tracks.every((t) => t.preset === "fade"), "Gridlines: 2 fade tracks");
assert(grid.tracks.map((t) => t.part).sort().join(",") === "axis.x.gridlines,axis.y.gridlines", "Gridlines: both axes' gridline groups (resolved from the 'gridlines' role-ref)");

// --- Data: points stagger by x left→right; line draws on, offset to the end ---
const data = beats[2];
const pts = data.tracks.filter((t) => t.preset === "stagger");
assert(pts.length === 3, "Data: 3 point series stagger");
assert(pts.every((t) => t.stagger?.by === "x" && t.stagger?.from === "start"), "Data: points stagger by x, left→right");
assert(pts.every((t) => t.params?.child === "fade"), "Data: points fade-in (staggered), not rise");
const line = data.tracks.find((t) => t.part === "fit.line");
assert(line?.preset === "drawOn", "Data: the fit line draws itself on");
assert((line?.start ?? 0) > 0, `Data: the line is offset (start=${line?.start}ms) to resolve as the points finish`);
const area = data.tracks.find((t) => t.part === "ci95.area");
assert(area?.preset === "fade" && (area?.start ?? 0) > 0, "Data: the CI band fades in, offset");

// --- Legend: fade ------------------------------------------------------------
const legend = beats[3];
assert(legend.tracks.length > 0 && legend.tracks.every((t) => t.preset === "fade"), "Legend: fades in last");

// --- every track targets the placed element ----------------------------------
assert(beats.every((b) => b.tracks.every((t) => t.target === "plot1")), "every track targets the placed plot element id");

console.log("\nALL AUTOBUILD (anim 1.4) TESTS PASSED");
