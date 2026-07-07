#!/usr/bin/env -S npx tsx
// Regression: two plots on ONE slide must keep INDEPENDENT animation timelines.
// The bug: applyAutoAnimation did `slide.beats = [base, ...auto]`, so auto-animating
// a 2nd plot wiped the 1st plot's tracks (and vice-versa). It now drops only the
// target element's own tracks and MERGES the new build into the shared phase beats,
// idempotently. Run: npx tsx scripts/verify-slide-multiplot.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as slideOps from "../src/lib/slide/ops";
import { applyAutoAnimation } from "../src/lib/slide/autobuild";
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const load = async (p: string) => JSON.parse(await fs.readFile(p, "utf8")) as FluxPlotManifest;
// Fixtures vendored in-repo (were read from the author's now-deleted ~/KDFLUX1).
// Plot B was 01_grouped_bars there; 08_ecdf (also vendored) serves equally — this
// test only needs two DISTINCT plots to prove their timelines stay independent.
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pre-regen");
const mA = await load(path.join(FIX, "06_scatter_regression.fluxplot.json"));
const mB = await load(path.join(FIX, "08_ecdf.fluxplot.json"));

const deck = slideOps.createDeck({ id: "mp", title: "Multiplot" });
const sid = slideOps.addSlide(deck, { name: "S", layout: "blank" }).id;
const elA = slideOps.addPlotToSlide(deck, sid, { assetId: "A", x: 0, y: 0, width: 560, height: 360 })!;
const elB = slideOps.addPlotToSlide(deck, sid, { assetId: "B", x: 600, y: 0, width: 560, height: 360 })!;
const s = () => slideOps.slideById(deck, sid)!;
const countFor = (id: string) => s().beats.reduce((n, b) => n + b.tracks.filter((t) => t.target === id).length, 0);

// 1. animate plot A
applyAutoAnimation(deck, sid, elA, mA);
const aAlone = countFor(elA);
assert(aAlone > 0, `plot A has ${aAlone} tracks after animating A`);
assert(countFor(elB) === 0, "plot B has no tracks yet");

// 2. animate plot B — plot A must be UNTOUCHED (the bug made this 0)
applyAutoAnimation(deck, sid, elB, mB);
assert(countFor(elA) === aAlone, `plot A's ${aAlone} tracks SURVIVE animating B (no clobber)`);
const bCount = countFor(elB);
assert(bCount > 0, `plot B has ${bCount} tracks after animating B`);

// 3. merged into shared phase beats (a layered build), not a wholesale replace
assert(s().beats[0].tracks.length === 0, "beat 0 stays the resting beat");
const shared = s().beats.find((b) => b.tracks.some((t) => t.target === elA) && b.tracks.some((t) => t.target === elB));
assert(!!shared, "a phase beat carries tracks from BOTH plots (merged, not clobbered)");

// 4. re-animating A is idempotent — no duplication, plot B untouched
applyAutoAnimation(deck, sid, elA, mA);
assert(countFor(elA) === aAlone, "re-animating A does not duplicate its tracks");
assert(countFor(elB) === bCount, "re-animating A leaves plot B's tracks intact");

// 5. no cross-wiring — every track targets exactly one of the two plots
assert(
  s().beats.every((b) => b.tracks.every((t) => t.target === elA || t.target === elB)),
  "every track targets one of the two plots (no cross-wiring)",
);

console.log("\nMULTI-PLOT INDEPENDENCE (no-clobber) TESTS PASSED");
