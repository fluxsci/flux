#!/usr/bin/env -S npx tsx
// WS7 — build the LIVING SHOWCASE deck in the real fluxv1 project, exercising
// every capability of the slides overhaul on the real regenerated plots:
//   S1 title + a countUp stat            S2 the north-star scatter auto-build
//   S3 bullets in → shapes in → EXITS    S4 the ecdf medians (the old bug, now parts)
//   S5 the data-space morph (bare-assetId target via the plots/ convention)
// Then exports it to exports/showcase.html. Idempotent: re-running rebuilds the
// deck in place. Run: npx tsx scripts/build-showcase-deck.ts [root]
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as slides from "../flux-core/slides";
import * as ops from "../src/lib/slide/ops";
import { applyAutoAnimation, animateElement, suggestElementTrack } from "../src/lib/slide/autobuild";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { TextBoxElement } from "../src/lib/slide/types";

const ROOT = process.argv[2] ?? "/home/driessen2/fluxv1";
const DECK_ID = "showcase";
const plotSrc = (name: string) => ({
  assetId: `example_plots/${name}`,
  source: {
    svgPath: `plots/example_plots/${name}.svg`,
    manifestPath: `plots/example_plots/${name}.fluxplot.json`,
  },
});
const manifestOf = async (name: string): Promise<FluxPlotManifest> =>
  JSON.parse(await fs.readFile(path.join(ROOT, `plots/example_plots/${name}.fluxplot.json`), "utf8")) as FluxPlotManifest;

// fresh build every run
try { await fs.rm(path.join(ROOT, "slides", DECK_ID), { recursive: true }); } catch { /* first run */ }
const { deckId } = await slides.createDeck(ROOT, { id: DECK_ID, title: "Flux Slides — the showcase", theme: "flux-light" });
const deck = await slides.loadDeck(ROOT, deckId);
deck.slides = []; // drop the scaffold slide; we author every slide below

// --- S1 · title + countUp stat ------------------------------------------------
{
  const sid = ops.addSlide(deck, { name: "Title", layout: "blank" }).id;
  ops.addTextBox(deck, sid, { text: "Data in Motion", x: 140, y: 200, width: 1000, height: 120, fontSize: 72, align: "center" });
  ops.addTextBox(deck, sid, { text: "every element on this deck is animated from the Flux animator", x: 140, y: 330, width: 1000, height: 60, fontSize: 26, align: "center", color: "#6f6e69" });
  const stat = ops.addTextBox(deck, sid, { text: "n = 1,247 trials", x: 140, y: 430, width: 1000, height: 70, fontSize: 40, align: "center", color: "#4385be" })!;
  const els = ops.slideById(deck, sid)!.elements.map((e) => e.id);
  const b1 = ops.addBeat(deck, sid, { label: "reveal" })!;
  ops.setAnimation(deck, sid, b1.id, { target: els[0], preset: "fadeRise", duration: 500 });
  ops.setAnimation(deck, sid, b1.id, { target: els[1], preset: "fade", start: 250, duration: 400 });
  const b2 = ops.addBeat(deck, sid, { label: "the stat", advance: "with-prev" })!;
  ops.setAnimation(deck, sid, b2.id, { target: stat, preset: "countUp", start: 500, duration: 900 });
}

// --- S2 · the north-star scatter build (one ✨ press, as tracks) ---------------
{
  const sid = ops.addSlide(deck, { name: "Scatter build", layout: "blank" }).id;
  const pid = ops.addPlotToSlide(deck, sid, { ...plotSrc("06_scatter_regression"), x: 190, y: 40, width: 900, height: 620 })!;
  const n = applyAutoAnimation(deck, sid, pid, await manifestOf("06_scatter_regression"));
  if (!n) throw new Error("auto-animation produced no beats — manifest missing?");
}

// --- S3 · bullets + shapes: enters AND exits -----------------------------------
{
  const sid = ops.addSlide(deck, { name: "Enters & exits", layout: "blank" }).id;
  const txt = ops.addTextBox(deck, sid, { text: "Three points", x: 120, y: 120, width: 520, height: 300, fontSize: 34 })!;
  const el = ops.findElement(deck, txt)!.el as TextBoxElement;
  el.blocks = [
    { id: "p1", text: "Everything is animatable", marker: "bullet" },
    { id: "p2", text: "Enters, exits, re-enters", marker: "bullet" },
    { id: "p3", text: "Timing you can SEE", marker: "bullet" },
  ];
  const rect = ops.addRect(deck, sid, { x: 760, y: 150, width: 300, height: 170, fill: "#4385be" })!;
  const line = ops.addLine(deck, sid, { x: 720, y: 420, width: 380, strokeWidth: 4 })!;
  // beat 1: bullets stagger in (the classic reveal)
  animateElement(deck, sid, txt, { beatIndex: undefined });
  // beat 2: shapes in
  const b2 = ops.addBeat(deck, sid, { label: "shapes" })!;
  ops.setAnimation(deck, sid, b2.id, suggestElementTrack(ops.findElement(deck, rect)!.el));
  ops.setAnimation(deck, sid, b2.id, { ...suggestElementTrack(ops.findElement(deck, line)!.el), start: 200 });
  // beat 3: EXITS — bullets fade out, rect pops out
  const b3 = ops.addBeat(deck, sid, { label: "exits" })!;
  ops.setAnimation(deck, sid, b3.id, { ...suggestElementTrack(el, { exit: true }), duration: 350 });
  ops.setAnimation(deck, sid, b3.id, { ...suggestElementTrack(ops.findElement(deck, rect)!.el, { exit: true }), start: 150 });
}

// --- S4 · the ecdf medians (unaddressable before the overhaul) ------------------
{
  const sid = ops.addSlide(deck, { name: "ECDF medians", layout: "blank" }).id;
  const pid = ops.addPlotToSlide(deck, sid, { ...plotSrc("08_ecdf"), x: 190, y: 40, width: 900, height: 620 })!;
  const m = await manifestOf("08_ecdf");
  const n = applyAutoAnimation(deck, sid, pid, m);
  if (!n) throw new Error("ecdf auto-animation failed");
  // the medians deserve their own beat — the exact elements that used to leak
  const bm = ops.addBeat(deck, sid, { label: "medians" })!;
  for (const [i, name] of ["setosa", "versicolor", "virginica"].entries()) {
    ops.setAnimation(deck, sid, bm.id, {
      target: pid, part: `reference-line.median-${name}`, preset: "drawOn", start: i * 220, duration: 420,
    });
  }
  // drop the medians from the shared auto Data beat so they only enter here
  for (const b of ops.slideById(deck, sid)!.beats) {
    if (b.id !== bm.id) b.tracks = b.tracks.filter((t) => !(t.part ?? "").startsWith("reference-line.median-"));
  }
}

// --- S5 · the data-space morph (target NOT on the slide — bare assetId) ---------
{
  const sid = ops.addSlide(deck, { name: "Morph", layout: "blank" }).id;
  const pid = ops.addPlotToSlide(deck, sid, { ...plotSrc("19_morph_scatter_a"), x: 190, y: 40, width: 900, height: 620 })!;
  ops.addTextBox(deck, sid, { text: "the same data, remeasured — a data-space morph", x: 190, y: 665, width: 900, height: 40, fontSize: 20, align: "center", color: "#6f6e69" });
  const b1 = ops.addBeat(deck, sid, { label: "morph" })!;
  ops.setMorphTrack(deck, sid, b1.id, pid, "example_plots/20_morph_scatter_b", { duration: 1400 });
}

ops.ensureTrackIds(deck);
await slides.saveDeck(ROOT, deck);
console.log(`✓ showcase deck saved (${deck.slides.length} slides)`);

const res = await slides.exportDeck(ROOT, DECK_ID);
console.log(`✓ exported → ${res.path} (${(res.bytes / 1024).toFixed(0)} KB)`);
for (const w of res.warnings) console.log("  ⚠", w);
if (res.warnings.length) process.exit(2);
