#!/usr/bin/env -S npx tsx
// anim 1.4 — autoAnimatePlot against the REAL scatter_regression plot. Proves the
// one-click build produces the user's north-star sequence straight from the
// plot's own build hints: axes draw on (labels fade, not draw), gridlines fade as
// their own step, the fit line draws itself as the points stagger in left→right,
// legend last. Run: npx tsx scripts/verify-slide-autobuild.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as slideOps from "../src/lib/slide/ops";
import { autoAnimatePlot, applyAutoAnimation, autoAnimateExcept } from "../src/lib/slide/autobuild";
import { resolveBeat, resolveStart } from "../src/lib/slide/resolve";
import { targetPartIds } from "../src/lib/slide/targets";
import { compileSlide } from "../src/lib/slide/compile";
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// The fixture is vendored in-repo (scripts/fixtures/pre-regen/) — the tests used to
// read it from the author's ~/KDFLUX1 plot library, which no longer exists.
const M = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pre-regen", "06_scatter_regression.fluxplot.json");
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
const expectedStart = Math.round(0.5 * targetPartIds(pts[0], manifest).length * (pts[0].stagger?.perMs ?? 40));
assert(line?.anchor?.trackId === pts[0].id && line.anchor.edge === "start", "Data: the line anchors to the points stagger start");
assert(resolveStart(line!, data, {}, () => manifest).start === expectedStart, `Data: resolved line start retains the exact old literal ${expectedStart}ms`);
const area = data.tracks.find((t) => t.part === "ci95.area");
assert(area?.preset === "fade" && resolveStart(area!, data, {}, () => manifest).start === expectedStart, "Data: the CI band fades in, offset");

const literalData = { ...data, tracks: data.tracks.map(t => { const copy = { ...t }; delete copy.anchor; if (t.preset !== "stagger") copy.start = expectedStart; return copy; }) };
const fixtureSlide = { id: "fixture", elements: [{ id: "plot1", type: "plot" as const, assetId: "fixture", x: 0, y: 0, width: 100, height: 100, rotation: 0 }], beats: [data] };
const cueTimes = (b: typeof data) => compileSlide({ ...fixtureSlide, beats: [b] }, undefined, { plotManifest: () => manifest }).cues.map(c => [c.duration, c.tracks.map(t => [t.track.id, t.start, t.duration, t.end])]);
assert(JSON.stringify(cueTimes(data)) === JSON.stringify(cueTimes(literalData)), "Data: every compiled cue time is byte-for-byte equal to the previous literal choreography");
pts[0].start = 75;
assert(resolveBeat(data, {}, () => manifest).tracks.find(t => t.id === line!.id)?.start === expectedStart + 75, "retiming the points moves the line through the anchor");
pts[0].start = 0;

// --- Legend: fade ------------------------------------------------------------
const legend = beats[3];
assert(legend.tracks.length > 0 && legend.tracks.every((t) => t.preset === "fade"), "Legend: fades in last");

// --- every track targets the placed element ----------------------------------
assert(beats.every((b) => b.tracks.every((t) => t.target === "plot1")), "every track targets the placed plot element id");

// --- applyAutoAnimation: the GUI's ✨ button path (deck mutation) -------------
const deck = slideOps.createDeck({ id: "ab", title: "Autobuild" });
const sid = slideOps.addSlide(deck, { name: "S", layout: "blank" }).id;
const plotId = slideOps.addPlotToSlide(deck, sid, { assetId: "scatterA", x: 0, y: 0, width: 800, height: 500 })!;
const added = applyAutoAnimation(deck, sid, plotId, manifest);
const s = slideOps.slideById(deck, sid)!;
assert(added === 4, "applyAutoAnimation reports 4 build beats added");
assert(s.beats.length === 5, "slide now has [resting + 4 phase] beats");
assert(s.beats[0].tracks.length === 0, "beat 0 is the resting (empty) beat");
assert(s.beats[1].label === "Axes" && s.beats[4].label === "Legend & annotations", "phase beats in order");
assert(s.beats.slice(1).every((b) => b.tracks.every((t) => t.target === plotId)), "every track targets the placed plot element id");
// a plot with no manifest → no-op (the GUI falls back / disables the button)
const added0 = applyAutoAnimation(deck, sid, plotId, undefined);
assert(added0 === 0, "applyAutoAnimation is a no-op when the plot has no manifest");

// The inspector and post-pick action use this same exported operation.
const core = await import("../flux-core/index");
assert(typeof autoAnimateExcept === "function" && core.autoAnimateExcept === autoAnimateExcept, "headless and GUI share autoAnimateExcept");
const restDeck = slideOps.createDeck({ id: "rest", title: "Hand-off rest" });
const restSlide = slideOps.addSlide(restDeck, { layout: "blank" });
const restPlot = slideOps.addPlotToSlide(restDeck, restSlide.id, { assetId: "scatterA", x: 0, y: 0, width: 800, height: 500 })!;
const otherPlot = slideOps.addPlotToSlide(restDeck, restSlide.id, { assetId: "scatterA", x: 0, y: 0, width: 800, height: 500 })!;
applyAutoAnimation(restDeck, restSlide.id, otherPlot, manifest);
const otherBefore = JSON.stringify(restSlide.beats.flatMap(b => b.tracks.filter(t => t.target === otherPlot)));
const sourceId = slideOps.addElement(restDeck, restSlide.id, { id: "rest-source", type: "rect", x: 20, y: 20, width: 80, height: 60, rotation: 0, fill: "#333", stroke: "none", strokeWidth: 0, cornerRadius: 0 })!;
const landing = slideOps.addBeat(restDeck, restSlide.id, { label: "Land" })!;
const handoff = slideOps.becomeTransform(restDeck, restSlide.id, landing.id, sourceId, { element: restPlot, parts: ["axis.x.spine", "axis.y.spine"] }, { mode: "handoff", compiled: compileSlide(restSlide, restDeck.stage, { plotManifest: () => manifest }) })!;
const manual = slideOps.appendAnimation(restDeck, restSlide.id, landing.id, { target: restPlot, part: "fit.line", preset: "dim", start: 33 })!;
const tickLeaves = targetPartIds({ part: "axis.x.ticks" }, manifest);
const excluded = ["axis.x.spine", "axis.y.spine", tickLeaves[0], ...targetPartIds({part:"setosa.points"},manifest)];
assert(autoAnimateExcept(restDeck, restSlide.id, restPlot, manifest, excluded) > 0, "auto-animate rest produces remaining phases");
const generatedTracks = () => restSlide.beats.flatMap(b => b.tracks.filter(t => t.target === restPlot && t.generatedBy === "auto-reveal"));
assert(generatedTracks().every(t => targetPartIds(t, manifest).every(id => !excluded.includes(id))), "generated tracks exclude every hand-off leaf, including a partial group");
assert(generatedTracks().some(t => t.parts?.includes(tickLeaves[1])), "unexcluded members of a partially excluded group still animate");
assert(restSlide.beats.flatMap(b => b.tracks).includes(manual) && restSlide.beats.flatMap(b => b.tracks).some(t => t.id === handoff.trackId), "manual appearance and source hand-off survive");
assert(JSON.stringify(restSlide.beats.flatMap(b => b.tracks.filter(t => t.target === otherPlot))) === otherBefore, "other plots' shared build tracks are unchanged");
assert(restSlide.beats.every((b,i) => !b.tracks.some(t => t.target === restPlot && t.generatedBy === "auto-reveal") || i > restSlide.beats.indexOf(landing)), "remaining plot phases follow the landing step");
assert(compileSlide(restSlide, restDeck.stage, { plotManifest: () => manifest }).issues.every(i => !/anchor/i.test(i.reason)), "excluded anchor owners leave no dangling timing anchors");
const count = generatedTracks().length;
autoAnimateExcept(restDeck, restSlide.id, restPlot, manifest, excluded);
assert(generatedTracks().length === count && new Set(restSlide.beats.map(b => b.id)).size === restSlide.beats.length, "repeating auto-animate rest replaces its phases without duplicate beats");

// The public helper is shared with headless hosts and operates on the real
// generated build, including containers that only partly overlap a landing.
assert(core.autoAnimateExcept === autoAnimateExcept, "autoAnimateExcept is the same function through flux-core");
const handoffDeck = slideOps.createDeck({id: "handoff-build", title: "Hand-off"});
const hs = slideOps.addSlide(handoffDeck, {name: "Landing", layout: "blank"});
const hp = slideOps.addPlotToSlide(handoffDeck, hs.id, {assetId: "scatterA", x: 200, y: 0, width: 300, height: 200})!;
hs.elements.push({id: "source", type: "rect", x: 0, y: 0, width: 50, height: 50, rotation: 0, fill: "#222", stroke: "none", strokeWidth: 0, cornerRadius: 0});
const hb = slideOps.addBeat(handoffDeck, hs.id, {label: "Hand-off", advance: "click"})!;
slideOps.becomeTransform(handoffDeck, hs.id, hb.id, "source", {element: hp, parts: ["axis.x.spine", "axis.y.spine"]}, {compiled: compileSlide(hs, handoffDeck.stage, {plotManifest: () => manifest})});
const handManual = {id: "manual", target: hp, part: "fit.line", preset: "dim" as const, duration: 300, start: 0};
hb.tracks.push(handManual);
const beforeManual = JSON.stringify(handManual), beforeLanding = JSON.stringify(hb.tracks[0]);
const pointLeaf = targetPartIds(pts[0], manifest)[0];
const exclude = ["axis.x.spine", "axis.y.spine", pointLeaf];
const contributed = autoAnimateExcept(handoffDeck, hs.id, hp, manifest, exclude);
const generated = hs.beats.flatMap(b => b.tracks.filter(t => t.generatedBy === "auto-reveal"));
assert(contributed === 4 && generated.length > 0, "autoAnimateExcept retains the rest of the real four-phase build");
assert(generated.every(t => targetPartIds(t, manifest).every(id => !exclude.includes(id))), "no generated track resolves to a landed leaf, including partial point containers");
const narrowed = generated.find(t => t.parts?.length);
assert(narrowed && targetPartIds(narrowed, manifest).length === targetPartIds(pts[0], manifest).length - 1, "partially excluded point groups retain every other point");
assert(hs.beats.findIndex(b => b.id === hb.id) === 1 && hs.beats.slice(2).every(b => b.generatedBy === "auto-reveal"), "remaining reveals follow the hand-off, never precede it");
assert(JSON.stringify(hb.tracks[0]) === beforeLanding && JSON.stringify(hb.tracks.find(t => t.id === "manual")) === beforeManual, "hand-off and manual appearance bytes are preserved");
const firstCount = generated.length;
autoAnimateExcept(handoffDeck, hs.id, hp, manifest, exclude);
assert(hs.beats.flatMap(b => b.tracks).filter(t => t.generatedBy === "auto-reveal").length === firstCount && hs.beats.length === 6, "repeating Auto-animate the rest replaces only its generated sequence");
const after = compileSlide(hs, handoffDeck.stage, {plotManifest: () => manifest}).sample(1);
assert(after.presentation.partStates?.[hp]?.["axis.x.spine"]?.visible === true && after.presentation.partStates?.[hp]?.["ci95.area"]?.visible === false, "compiled landing shows its spines and hides the later reveal geometry");
const allPoints = targetPartIds(pts[0], manifest);
autoAnimateExcept(handoffDeck, hs.id, hp, manifest, allPoints);
const rebuilt = compileSlide(hs, handoffDeck.stage, {plotManifest: () => manifest});
assert(!rebuilt.issues.some(issue => /anchor/i.test(issue.reason)), "excluding an anchor target retains effective starts without dangling anchors");
const priorPhase = hs.beats.find(b => b.generatedBy === "auto-reveal")!;
priorPhase.tracks.push({id: "authored-anchor", target: hp, part: "fit.line", preset: "dim", duration: 100, anchor: {trackId: priorPhase.tracks[0].id!, edge: "end", offsetMs: 25}});
const authoredStart = resolveBeat(priorPhase, handoffDeck, () => manifest).tracks.find(t => t.id === "authored-anchor")!.start;
autoAnimateExcept(handoffDeck, hs.id, hp, manifest, exclude);
const authored = hs.beats.find(b => b.id === priorPhase.id)!.tracks.find(t => t.id === "authored-anchor")!;
assert(!authored.anchor && authored.start === authoredStart, "rebuilding keeps an authored effect in its old beat and preserves its anchored start");
assert(new Set(hs.beats.map(b => b.id)).size === hs.beats.length, "retained authored phase beats never collide with new generated beat ids");
console.log("\nALL AUTOBUILD (anim 1.4) TESTS PASSED");
