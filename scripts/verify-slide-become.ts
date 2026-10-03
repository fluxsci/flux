// Transforms, way three — BECOME as a deck mutation (ops.becomeTransform) and
// through the real CLI verb (`flux become`). The record it writes is the one
// transform track a Change would have written; the target is consumed in the
// same mutation; chains, ghosts, plots and refusals behave; the legacy
// data-space `morph` preset normalizes to a transform at load.
// Run: node --import tsx scripts/verify-slide-become.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import { loadDeck, saveDeck, compileDeckSlide, become as becomeHeadless } from "../flux-core/slides";
import { ensureDom } from "../flux-core/index";
import { preparePlot } from "../src/lib/plot/parse";
import * as ops from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { familyOf } from "../src/lib/slide/family";
import { validateDeckFile } from "../src/lib/project/validate";
import type { Element, LineElement, EllipseElement, RectElement, PathElement, SemanticPlotElement } from "../src/lib/types";
import type { Deck, TargetRef } from "../src/lib/slide/types";

let checks = 0;
const ok = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; console.log("  ok:", message); };

const line = (id: string, o: Partial<LineElement> = {}): LineElement => ({ type: "line", id, name: "Arrow", x: 60, y: 200, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 200, y2: -40, stroke: "#4385be", strokeWidth: 4, arrowStart: false, arrowEnd: true, ...o });
const ellipse = (id: string, o: Partial<EllipseElement> = {}): EllipseElement => ({ type: "ellipse", id, name: "Blob", x: 360, y: 80, width: 180, height: 120, rotation: 0, fill: "#d14d41", stroke: "#100f0f", strokeWidth: 3, ...o });
const rect = (id: string, o: Partial<RectElement> = {}): RectElement => ({ type: "rect", id, x: 20, y: 20, width: 100, height: 60, rotation: 0, fill: "#879a39", stroke: "none", strokeWidth: 0, cornerRadius: 6, ...o });

function deckWith(elements: Element[]): { deck: Deck; slideId: string; beats: string[] } {
  const deck = ops.createDeck({ id: "become", withTitleSlide: false });
  const slide = ops.addSlide(deck, { id: "s1", layout: "blank" });
  for (const el of elements) ops.addElement(deck, slide.id, structuredClone(el));
  const b1 = ops.addBeat(deck, slide.id, { id: "b1" })!, b2 = ops.addBeat(deck, slide.id, { id: "b2" })!;
  return { deck, slideId: slide.id, beats: [slide.beats[0].id, b1.id, b2.id] };
}

console.log("── the op ──");
{
  const { deck, slideId, beats } = deckWith([line("src"), ellipse("tgt", { groupId: "g" })]);
  const before = JSON.stringify(deck);
  const r = ops.becomeTransform(deck, slideId, beats[1], "src", "tgt")!;
  const slide = deck.slides[0];
  ok(!!r && r.targetId === "tgt" && !slide.elements.some((e) => e.id === "tgt"), "the target is consumed");
  const track = slide.beats[1].tracks.find((t) => t.id === r.trackId)!;
  ok(track.preset === "transform" && familyOf(track) === "transform" && track.target === "src" && track.duration === 600 && track.easing === "smooth", "the record is THE transform track of the source (transform family defaults)");
  const st = track.to!.state as Record<string, unknown>;
  ok(st.type === "ellipse" && st.fill === "#d14d41" && st.width === 180 && st.x === 360 && !("groupId" in st) && !("name" in st), "the endpoint carries the target's kind + properties, never its identity");
  ok(slide.beats[1].tracks.length === 1 && !("assetId" in (track.to ?? {})), "one track; a shape endpoint has no content half");
  const compiled = compileSlide(slide);
  const end = compiled.sample(1).elements.find((e) => e.id === "src")!;
  ok(end.type === "ellipse" && end.name === "Arrow" && (end as EllipseElement).fill === "#d14d41" && !("x1" in end), "at the end of the step the source IS the ellipse, wearing its own name");
  const start = compiled.sample(1, 0).elements.find((e) => e.id === "src")!;
  ok(start.type === "line", "before the step it is still the line");
  const mid = compiled.sample(1, 300).elements.find((e) => e.id === "src")!;
  ok(mid.type === "path" && (mid as PathElement).nodes!.length > 8, "mid-flight the compiler samples the outline morph");
  ok(JSON.stringify(deck) !== before && slide.elements.length === 1, "one mutation: the deck holds exactly the surviving source");
  ok(validateDeckFile(structuredClone(deck)).length === 0, "the deck validates (a `type` in the patch is an ordinary state key)");
}

console.log("── chaining · replacing · ghosts ──");
{
  const { deck, slideId, beats } = deckWith([line("src"), ellipse("tgt"), rect("box")]);
  ops.setTransform(deck, slideId, beats[1], "src", { state: { x: 100 }, duration: 900 });
  const r1 = ops.becomeTransform(deck, slideId, beats[1], "src", "tgt")!;
  const t1 = deck.slides[0].beats[1].tracks.find((t) => t.id === r1.trackId)!;
  ok(deck.slides[0].beats[1].tracks.filter((t) => t.target === "src").length === 1 && t1.duration === 900, "a Become at a step with an existing Change replaces its endpoint and keeps its timing");
  const r2 = ops.becomeTransform(deck, slideId, beats[2], "src", "box")!;
  const c = compileSlide(deck.slides[0]);
  const afterOne = c.sample(1).elements.find((e) => e.id === "src")!, afterTwo = c.sample(2).elements.find((e) => e.id === "src")!;
  ok(afterOne.type === "ellipse" && afterTwo.type === "rect" && (afterTwo as RectElement).cornerRadius === 6, "chained Becomes fold: ellipse after step 1, rect after step 2");
  ok(c.preState("src", 2)!.type === "ellipse", "the second Become's pre-state is the first's endpoint");
  ok(deck.slides[0].elements.length === 1 && r2.targetId === "box", "both targets consumed");
}
{
  const { deck, slideId, beats } = deckWith([line("src"), ellipse("tgt")]);
  assert.throws(() => ops.becomeTransform(deck, slideId, beats[2], "src", "src-never"), /missing/i); checks++;
  assert.throws(() => ops.becomeTransform(deck, slideId, beats[2], "src", "src"), /different object/i); checks++;
  assert.throws(() => ops.becomeTransform(deck, slideId, beats[0], "src", "tgt"), /after Design/i); checks++;
  ok(deck.slides[0].elements.length === 2 && deck.slides[0].beats.every((b) => !b.tracks.length), "refusals mutate nothing");
  ops.addElement(deck, slideId, { type: "video", id: "vid", assetId: "v", posterAssetId: "p", durationMs: 1000, x: 0, y: 0, width: 10, height: 10, rotation: 0 } as unknown as Element);
  assert.throws(() => ops.becomeTransform(deck, slideId, beats[1], "src", "vid"), /Video/); checks++;
  const ghosts = ops.addGhostTransform(deck, slideId, beats[1], "src", { count: 1 })!;
  assert.throws(() => ops.becomeTransform(deck, slideId, beats[2], "tgt", ghosts.elementIds[0]), /ghost copy/i); checks++;
  // a ghost copy CAN become something at (or after) its birth
  const r = ops.becomeTransform(deck, slideId, beats[1], ghosts.elementIds[0], "tgt")!;
  const birth = deck.slides[0].beats[1].tracks.find((t) => t.id === r.trackId)!;
  ok(birth.ghostFrom === "src" && (birth.to!.state as { type?: string }).type === "ellipse", "a ghost copy's birth destination can be a Become (birth identity preserved)");
  const c = compileSlide(deck.slides[0]);
  const g = c.sample(1).elements.find((e) => e.id === ghosts.elementIds[0])!;
  ok(g.type === "ellipse" && c.sample(1, 0).elements.find((e) => e.id === ghosts.elementIds[0])!.type === "line", "the copy starts as the line and ends as the ellipse");
}

console.log("── plots: whole-object and data-only ──");
{
  const { deck, slideId, beats } = deckWith([]);
  ops.addPlotToSlide(deck, slideId, { assetId: "plotA", x: 10, y: 10, width: 200, height: 150, source: { svgPath: "plots/a.svg", manifestPath: "plots/a.fluxplot.json" } });
  ops.addPlotToSlide(deck, slideId, { assetId: "plotB", x: 300, y: 40, width: 260, height: 180, source: { svgPath: "plots/b.svg", manifestPath: "plots/b.fluxplot.json", recipePath: "plots/b.recipe.json" } });
  const [pa, pb] = deck.slides[0].elements.map((e) => e.id);
  (deck.slides[0].elements[1] as { overrides?: unknown }).overrides = { "s.line": { stroke: "#ff0000" } };
  const r = ops.becomeTransform(deck, slideId, beats[1], pa, pb, { mode: "consume" })!;
  const t = deck.slides[0].beats[1].tracks.find((x) => x.id === r.trackId)!;
  ok(t.to!.assetId === "plotB" && t.to!.svgPath === "plots/b.svg" && t.to!.manifestPath === "plots/b.fluxplot.json" && t.to!.recipePath === "plots/b.recipe.json", "plot → plot: the content half names the target asset and carries its whole source bundle");
  const st = t.to!.state as Record<string, unknown>;
  ok(st.x === 300 && st.width === 260 && !("type" in st) && !("assetId" in st) && JSON.stringify(st.overrides) === JSON.stringify({ "s.line": { stroke: "#ff0000" } }), "…and the geometry/overrides half rides the ordinary state patch");
  const end = compileSlide(deck.slides[0]).sample(1).elements.find((e) => e.id === pa)!;
  ok(end.type === "plot" && (end as { assetId: string }).assetId === "plotB", "the source shows plot B's content at the end of the step");
  // a shape becoming a plot, and a plot becoming a shape
  ops.addElement(deck, slideId, rect("box"));
  ops.addPlotToSlide(deck, slideId, { assetId: "plotC", x: 1, y: 1, width: 50, height: 50, source: { svgPath: "plots/c.svg" } });
  const pc = deck.slides[0].elements.find((e) => e.type === "plot" && (e as { assetId: string }).assetId === "plotC")!.id;
  const r2 = ops.becomeTransform(deck, slideId, beats[2], "box", pc, { mode: "consume" })!;
  const t2 = deck.slides[0].beats[2].tracks.find((x) => x.id === r2.trackId)!;
  ok((t2.to!.state as { type?: string }).type === "plot" && t2.to!.assetId === "plotC" && t2.to!.svgPath === "plots/c.svg", "rect → plot: retype plus the content half");
  const boxEnd = compileSlide(deck.slides[0]).sample(2).elements.find((e) => e.id === "box")!;
  ok(boxEnd.type === "plot" && (boxEnd as { assetId: string }).assetId === "plotC" && boxEnd.x === 1, "the rect is plot C after step 2");
  ops.addElement(deck, slideId, ellipse("oval"));
  const r3 = ops.becomeTransform(deck, slideId, beats[2], pa, "oval")!;
  const t3 = deck.slides[0].beats[2].tracks.find((x) => x.id === r3.trackId)!;
  ok((t3.to!.state as { type?: string }).type === "ellipse" && !("assetId" in t3.to!) && !("svgPath" in t3.to!), "plot → ellipse: retype, and the content half is dropped");
}

console.log("── live hand-offs and destination-side authoring ──");
const manifest = JSON.parse(await fs.readFile("scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.fluxplot.json", "utf8"));
const plot = (id = "plot"): SemanticPlotElement => ({ type: "plot", id, assetId: "boxplot", x: 250, y: 40, width: 240, height: 180, rotation: 0, source: { svgPath: "plots/boxplot.svg", manifestPath: "plots/boxplot.fluxplot.json" } });
const spines: TargetRef = { element: "plot", parts: ["axis.x.spine", "axis.y.spine"] };
const compiledFor = (deck: Deck) => compileSlide(deck.slides[0], deck.stage, { plotManifest: () => manifest });
{
  const { deck, slideId, beats } = deckWith([line("src"), plot(), rect("box")]);
  const t = ops.setTransform(deck, slideId, beats[1], "src", { state: { x: 17 }, toAssetId: "old", source: { svgPath: "plots/old.svg" }, duration: 750, start: 20, easing: "linear" })!;
  const inverse = structuredClone(deck), beforeElements = JSON.stringify(deck.slides[0].elements);
  const result = ops.becomeTransform(deck, slideId, beats[1], "src", spines, { compiled: compiledFor(deck) })!;
  ops.appearFrom(inverse, slideId, beats[1], spines, "src", { compiled: compiledFor(inverse) });
  ok(JSON.stringify(inverse) === JSON.stringify(deck), "appearFrom writes a byte-identical deck, including the existing track id");
  ok(result.trackId === t.id && JSON.stringify(result.ref) === JSON.stringify(spines) && result.targetId === undefined, "hand-off returns the source track and live destination ref");
  ok(JSON.stringify(t.to) === JSON.stringify({ become: { ref: spines, mode: "handoff", pair: "auto", reveal: "flip" }, state: {} }), "spine hand-off writes only to.become and empty state, clearing all content and old state");
  ok(t.duration === 750 && t.start === 20 && t.easing === "linear" && JSON.stringify(deck.slides[0].elements) === beforeElements, "existing timing and both canonical objects survive a hand-off");
  ok(JSON.stringify(compiledFor(deck).preState("src", 2)) === JSON.stringify(deck.slides[0].elements[0]), "hand-off never changes source model properties");
  const whole = ops.becomeTransform(deck, slideId, beats[2], "box", "plot", { compiled: compiledFor(deck) })!;
  const fresh = deck.slides[0].beats[2].tracks.find(t => t.id === whole.trackId)!;
  ok(whole.ref?.element === "plot" && fresh.duration === 600 && fresh.start === 0 && fresh.easing === "smooth", "whole plot defaults to hand-off with 600 ms / smooth / 0 timing");
  ok(validateDeckFile(structuredClone(deck)).length === 0, "hand-off records validate against the real deck schema");
  ops.clearTransformContent(t);
  ok(!t.to?.become && JSON.stringify(t.to?.state) === "{}", "clearing transform content also clears Become provenance");
}
{
  const { deck, slideId, beats } = deckWith([plot(), rect("box")]);
  ops.setTransform(deck, slideId, beats[1], "plot", { state: { x: 300 } });
  const result = ops.becomeTransform(deck, slideId, beats[1], { element: "plot", parts: ["peaches.box"] }, "box", { compiled: compiledFor(deck), pair: "order", reveal: "draw", duration: 900 })!;
  const tracks = deck.slides[0].beats[1].tracks, part = tracks.find(t => t.id === result.trackId)!;
  ok(tracks.length === 2 && part.part === "peaches.box" && part.to?.become?.mode === "handoff", "a part-set source coexists with a whole-plot Change in the same step");
  ok(part.to?.become?.pair === "order" && part.to.become.reveal === "draw" && part.duration === 900, "pair, reveal and explicit timing survive on the part transform");
  ok(compiledFor(deck).sample(1).elements[0].x === 300 && deck.slides[0].elements.length === 2, "part transform never resets the concurrent whole-plot Change");
  const same = ops.setTransform(deck, slideId, beats[1], "plot", { ref: { parts: ["peaches.box"] }, state: { opacity: .4 } })!;
  ok(same.id === part.id && tracks.length === 2, "a plain transform and hand-off on the same part-set share one track, distinct from the whole element");
  ops.becomeTransform(deck, slideId, beats[1], { element: "plot", parts: ["peaches.box"] }, "box", { compiled: compiledFor(deck) });
  ok(tracks.length === 2 && tracks.find(t => t.id === part.id)?.to?.become?.mode === "handoff", "re-authoring the part-set Become also reuses that transform track");
  const many = ops.setTransform(deck, slideId, beats[2], "plot", { ref: { parts: spines.parts }, state: {} })!;
  const manyResult = ops.becomeTransform(deck, slideId, beats[2], { element: "plot", parts: [...spines.parts!].reverse() }, "box", { compiled: compiledFor(deck) })!;
  ops.setTransform(deck, slideId, beats[2], "plot", { state: { x: 400 } });
  ok(manyResult.trackId === many.id && deck.slides[0].beats[2].tracks.length === 2, "multi-part set order is irrelevant to the family law; whole-element Change remains distinct");
}
{
  const { deck, slideId, beats } = deckWith([line("src"), rect("box"), plot(), plot("other")]);
  const refuse = (source: TargetRef | string, dest: TargetRef | string, pattern: RegExp, options: ops.BecomeOptions = {}) => {
    const before = JSON.stringify(deck);
    assert.throws(() => ops.becomeTransform(deck, slideId, beats[1], source, dest, { compiled: compiledFor(deck), ...options }), pattern);
    ok(JSON.stringify(deck) === before, `refusal is atomic: ${pattern}`);
  };
  refuse(spines, { element: "plot", parts: [...spines.parts!].reverse() }, /different object/);
  refuse("src", { element: "missing" }, /missing/);
  refuse("src", { element: "plot", parts: ["missing.part"] }, /Destination parts not found/);
  refuse({ element: "plot", parts: ["missing.part"] }, "box", /Source parts not found/);
  refuse("src", spines, /Consume requires whole/, { mode: "consume" });
  refuse(spines, "box", /Consume requires whole/, { mode: "consume" });
  refuse({ element: "plot", group: "source-group" }, "box", /Choose an object or plot parts as the Become source, rather than a group\./);
  ops.becomeTransform(deck, slideId, beats[1], "src", spines, { compiled: compiledFor(deck) });
  refuse("box", { element: "plot", parts: ["axis.x"] }, /already lands/);
  refuse("box", "plot", /already lands/);
  ops.becomeTransform(deck, slideId, beats[1], "box", { element: "plot", parts: ["peaches.box"] }, { compiled: compiledFor(deck) });
  ok(deck.slides[0].beats[1].tracks.length === 2, "disjoint destinations on the same plot remain legal");
  ops.becomeTransform(deck, slideId, beats[1], "src", spines, { compiled: compiledFor(deck), start: 30 });
  ok(deck.slides[0].beats[1].tracks.length === 2, "editing a hand-off does not conflict with itself");
  const birth = ops.addGhostTransform(deck, slideId, beats[2], "other")!;
  refuse("src", birth.elementIds[0], /destination is not yet born/, { mode: "handoff" });
  const accepted = ops.becomeTransform(deck, slideId, beats[2], "src", { element: birth.elementIds[0] }, { mode: "handoff", compiled: compiledFor(deck) });
  ok(!!accepted?.ref, "a ghost destination at its enabled birth step can receive a hand-off");
  const image = { type: "image", id: "image", assetId: "img", x: 0, y: 0, width: 20, height: 20, rotation: 0 } as Element;
  ops.addElement(deck, slideId, image);
  ok(!!ops.becomeTransform(deck, slideId, beats[2], "box", "image")?.ref, "image destinations default to hand-off");
  ops.addElement(deck, slideId, { ...image, id: "video", type: "video", durationMs: 100, posterAssetId: "poster" } as Element);
  refuse("src", "video", /Video/, { mode: "handoff" });
  refuse("video", "src", /Video/, { mode: "handoff" });
}
{
  const { deck, slideId, beats } = deckWith([line("src"), plot()]);
  deck.slides[0].groups = { outer: { id: "outer", name: "Outer" }, inner: { id: "inner", name: "Inner", parentId: "outer" } };
  deck.slides[0].elements[1].groupId = "inner";
  ops.becomeTransform(deck, slideId, beats[1], "src", { element: "plot", group: "outer" }, { compiled: compiledFor(deck) });
  const original = structuredClone(deck.slides[0]);
  const dupId = ops.duplicateSlide(deck, slideId)!;
  const dup = deck.slides.find(s => s.id === dupId)!;
  const ref = dup.beats[1].tracks[0].to!.become!.ref;
  const duplicatePlot = dup.elements.find(e => e.type === "plot")!;
  ok(ref.element === duplicatePlot.id && ref.group === dup.groups![duplicatePlot.groupId!].parentId && ref.group !== "outer", "duplicateSlide remaps both destination element and nested group ids");
  const ins = ops.insertSlideSnapshot(deck, { fluxPreset: 1, kind: "slide", name: "Snapshot", savedAt: "", stage: deck.stage, slide: original });
  const inserted = deck.slides.find(s => s.id === ins.slideId)!;
  const insertedRef = inserted.beats[1].tracks[0].to!.become!.ref;
  ok(insertedRef.element === inserted.elements.find(e => e.type === "plot")!.id && !!inserted.groups![insertedRef.group!], "insertSlideSnapshot remaps the element and group of a Become destination");
  const { namespaceEmbedDeck } = await import("../src/lib/slide/embedRender");
  const namespaced = namespaceEmbedDeck(deck, "embed").slides[0];
  const embeddedRef = namespaced.beats[1].tracks[0].to!.become!.ref;
  ok(embeddedRef.element === "embed-plot" && embeddedRef.group === "embed-outer" && compileSlide(namespaced, deck.stage, { plotManifest: () => manifest }).handoffs.length === 1, "embedded-slide namespaces remap destination refs without dangling identities");
  const birth = ops.addGhostTransform(deck, slideId, beats[2], "plot")!;
  deck.slides[0].groups!.ghostGroup = { id: "ghostGroup", name: "Ghost destination" };
  deck.slides[0].elements.find(e => e.id === birth.elementIds[0])!.groupId = "ghostGroup";
  ops.becomeTransform(deck, slideId, beats[2], "src", { element: birth.elementIds[0], group: "ghostGroup" }, { mode: "handoff", compiled: compiledFor(deck) });
  const duplicateBeat = ops.duplicateBeat(deck, slideId, beats[2])!;
  const clonedBirth = duplicateBeat.tracks.find(t => t.ghostFrom)!;
  ok(duplicateBeat.tracks.find(t => t.to?.become)?.to?.become?.ref.element === clonedBirth.target && clonedBirth.target !== birth.elementIds[0], "duplicateBeat remaps destinations to its newly cloned ghost results");
  ok(duplicateBeat.tracks.find(t => t.to?.become)!.to!.become!.ref.group === deck.slides[0].elements.find(e => e.id === clonedBirth.target)!.groupId && duplicateBeat.tracks.find(t => t.to?.become)!.to!.become!.ref.group !== "ghostGroup", "duplicateBeat remaps the group of cloned ghost destinations too");
  ops.removeTracks(deck, slideId, birth.trackIds);
  const dangling = deck.slides[0].beats[2].tracks.find(t => t.to?.become)!;
  ok(dangling.to?.become?.ref.element === birth.elementIds[0] && compiledFor(deck).issues.some(i => /Destination parts not found/.test(i.reason)), "deleting a ghost destination retains the dangling Become and reports it");
}
{
  const { deck, slideId, beats } = deckWith([line("src"), plot()]);
  const store = await import("../src/lib/slide/store");
  const fig = await import("../src/lib/store");
  const { setStoreTenant } = await import("../src/lib/tenancy");
  setStoreTenant("slide");
  const unregister = fig.registerHistoryCompanion(store.overlayHistoryCompanion());
  try {
    store.loadDeckModel(deck);
    const before = JSON.stringify(store.currentDeck()), count = fig.historyStats().past;
    store.commitDeckLive(d => ops.becomeTransform(d, slideId, beats[1], "src", spines, { compiled: compiledFor(d) }));
    ok(fig.historyStats().past === count + 1, "commitDeckLive adds exactly one undo entry for a hand-off");
    fig.undo();
    ok(JSON.stringify(store.currentDeck()) === before, "one live undo restores the exact pre-hand-off deck");
  } finally { unregister(); setStoreTenant(null); }
}

console.log("── shared Swap direction ──");
await ensureDom();
const plotRoot = preparePlot(await fs.readFile("scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.svg", "utf8"), manifest).root;
const swapOptions = { plotManifest: () => manifest, plotRoot: () => plotRoot };
{
  const { deck, slideId, beats } = deckWith([line("src"), plot(), rect("box"), rect("follower-box")]);
  const result = ops.becomeTransform(deck, slideId, beats[1], "src", spines, { compiled: compiledFor(deck), pair: "order", reveal: "draw" })!;
  const beat = deck.slides[0].beats[1], original = beat.tracks[0];
  const style = ops.addAnimStyle(deck, { name: "Flight", family: "transform", track: { preset: "transform", duration: 750, easing: "linear", arc: .4 } });
  ops.linkTrackStyle(deck, slideId, result.trackId, style.id);
  original.curve = { kind: "spring", bounce: .25 }; original.groupId = "tg";
  beat.groups = [{ id: "tg", label: "Linked", collapsed: true }];
  ops.setAnimation(deck, slideId, beats[1], { id: "leader", target: "box", preset: "fade", duration: 100 });
  ops.setTrackAnchor(deck, slideId, result.trackId, { trackId: "leader", edge: "end", offsetMs: 30 });
  ops.setAnimation(deck, slideId, beats[1], { id: "follower", target: "follower-box", preset: "fadeOut", duration: 50, anchor: { trackId: result.trackId, edge: "end", offsetMs: 20 } });
  const how = ({ id, target, part, parts, selector, to, ...rest }: typeof original) => rest;
  const before = structuredClone(deck);
  const id = ops.swapBecome(deck, slideId, result.trackId, swapOptions);
  const swapped = deck.slides[0].beats[1].tracks.find(t => t.id === id)!;
  ok(swapped.target === "plot" && JSON.stringify(swapped.parts) === JSON.stringify(spines.parts) && swapped.to?.become?.ref.element === "src", "the exported swap op reverses complete source/destination refs");
  ok(JSON.stringify(how(swapped)) === JSON.stringify(how(original)) && swapped.to?.become?.pair === "order" && swapped.to.become.reveal === "draw", "swap preserves style, explicit curve, anchor, group, pairing and reveal without materializing inherited fields");
  ok(deck.slides[0].beats[1].tracks.find(t => t.id === "follower")?.anchor?.trackId === id && JSON.stringify(deck.slides[0].beats[1].groups) === JSON.stringify(beat.groups), "swap rebinds followers and retains track groups");
  ok(validateDeckFile(deck).length === 0 && compiledFor(deck).handoffs.length === 1, "swapped deck validates and compiles through the real shared compiler");
  const store = await import("../src/lib/slide/store"), fig = await import("../src/lib/store");
  const { setStoreTenant } = await import("../src/lib/tenancy");
  setStoreTenant("slide"); const unregister = fig.registerHistoryCompanion(store.overlayHistoryCompanion());
  try {
    store.loadDeckModel(before);
    const bytes = JSON.stringify(store.currentDeck()), count = fig.historyStats().past;
    store.commitDeckLive(d => ops.swapBecome(d, slideId, result.trackId, swapOptions));
    ok(fig.historyStats().past === count + 1, "Swap direction adds exactly one live undo entry");
    fig.undo(); ok(JSON.stringify(store.currentDeck()) === bytes, "one live undo restores the exact deck before Swap direction");
  } finally { unregister(); setStoreTenant(null); }
  for (const variant of ["group", "ghost", "occupied", "outline", "ordinary"] as const) {
    const candidate = structuredClone(before), t = candidate.slides[0].beats[1].tracks[0];
    if (variant === "group") t.to!.become!.ref.group = "g";
    if (variant === "ghost") t.ghostFrom = "box";
    if (variant === "occupied") ops.setTransform(candidate, slideId, beats[1], "plot", { ref: { parts: spines.parts }, state: {} });
    if (variant === "ordinary") delete t.to!.become;
    const bytes = JSON.stringify(candidate);
    assert.throws(() => ops.swapBecome(candidate, slideId, t.id!, variant === "outline" ? { ...swapOptions, plotRoot: () => preparePlot('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>', manifest).root } : swapOptions), /Groups cannot|creates a ghost|already has a transform|no outline|Choose a hand-off/);
    ok(JSON.stringify(candidate) === bytes, `${variant}: refused swap is atomic`);
  }
}

console.log("── destination SETS (Oct-2: TargetRef.members) ──");
{
  const { normalizeRef, composeDestination, targetKey, isWholeElementRef, resolveTargetLeaves, setLabel, sameRef } = await import("../src/lib/slide/targets");
  const { planHandoff } = await import("../src/lib/slide/handoffPlan");
  const { remapBecomeTarget } = await import("../src/lib/slide/handoffTargets");
  const scatterManifest = JSON.parse(await fs.readFile("scripts/fixtures/plots/mpl_scatter_FLUXPLOT.fluxplot.json", "utf8"));
  const scatterRoot = preparePlot(await fs.readFile("scripts/fixtures/plots/mpl_scatter_FLUXPLOT.svg", "utf8"), scatterManifest).root;
  const manifests = (id: string) => id === "scatter" ? scatterManifest : id === "boxplot" ? manifest : undefined;
  const roots = (id: string) => id === "scatter" ? scatterRoot : id === "boxplot" ? plotRoot : undefined;
  const scatter: SemanticPlotElement = { type: "plot", id: "scatter", assetId: "scatter", x: 20, y: 200, width: 200, height: 140, rotation: 0 };
  const dots = [ellipse("e1", { x: 458, y: 71, width: 21, height: 21 }), ellipse("e2", { x: 458, y: 124, width: 21, height: 21 }), ellipse("e3", { x: 458, y: 176, width: 21, height: 21 })];
  const three: TargetRef = { element: "e1", members: [{ element: "e1" }, { element: "e2" }, { element: "e3" }] };
  const setCompile = (deck: Deck) => compileSlide(deck.slides[0], deck.stage, { plotManifest: manifests, plotRoot: roots });

  // normalizeRef / targetKey / composeDestination: the canonical form.
  const messy: TargetRef = { element: "zzz", members: [{ element: "plot", parts: ["peaches.box"] }, { element: "e1" }, { element: "plot", parts: ["oranges.box", "peaches.box"] }, { element: "e1" }] };
  const norm = normalizeRef(messy);
  ok(JSON.stringify(norm) === JSON.stringify({ element: "plot", members: [{ element: "plot", parts: ["peaches.box", "oranges.box"] }, { element: "e1" }] }), "normalizeRef dedupes members, merges one element's parts (unioned) and sets element = members[0].element");
  ok(JSON.stringify(normalizeRef({ element: "x", members: [{ element: "plot", parts: ["peaches.box"] }, { element: "plot" }] })) === JSON.stringify({ element: "plot" }), "a whole member absorbs that element's part members, and a 1-member set collapses to the member");
  ok(JSON.stringify(normalizeRef({ element: "e2", members: [{ element: "e2" }] })) === JSON.stringify({ element: "e2" }) && normalizeRef(spines) === spines, "a 1-member set IS its member; a non-set ref passes through untouched");
  assert.throws(() => normalizeRef({ element: "e1", members: [] }), /at least one/); checks++;
  assert.throws(() => normalizeRef({ element: "e1", members: [{ element: "e1", members: [{ element: "e2" }] }, { element: "e2" }] }), /another set/); checks++;
  assert.throws(() => normalizeRef({ element: "e1", members: [{ element: "e1", group: "g" }, { element: "e2" }] }), /not groups/); checks++;
  ok(true, "normalizeRef refuses an empty set, a nested set and a group member with user-facing reasons");
  const reordered: TargetRef = { element: "e3", members: [{ element: "e3" }, { element: "e1" }, { element: "e2" }] };
  ok(targetKey(three) === targetKey(reordered) && sameRef(three, reordered) && targetKey(three).startsWith("set:") && targetKey(three) !== targetKey({ element: "e1" }), "targetKey is canonical over member order and distinct from any member's key");
  ok(targetKey({ element: "e1", members: [{ element: "e1" }, { element: "e1" }] }) === targetKey({ element: "e1" }) && !isWholeElementRef(three), "a set that dedupes to one member keys as that member; a set is never a whole-element ref");
  ok(composeDestination([{ element: "e1" }]) !== null && JSON.stringify(composeDestination([{ element: "plot", group: "g" }])) === JSON.stringify({ element: "plot", group: "g" }), "one pick (a group pick included) composes to itself");
  ok(JSON.stringify(composeDestination([{ element: "e1" }, { element: "plot", group: "g" }], () => ["e2", "e3"])) === JSON.stringify(three), "several picks compose ONE set; a group pick among them expands to its objects");

  // Resolution: every member against ITS OWN element's manifest.
  const mixed = deckWith([rect("src"), plot(), scatter, ...dots]);
  const mixedRef: TargetRef = { element: "plot", members: [{ element: "plot", parts: ["peaches.box"] }, { element: "scatter", parts: ["samples.points"] }, { element: "e1" }] };
  const leaves = resolveTargetLeaves(mixedRef, mixed.deck.slides[0], manifests);
  ok(leaves.length === 3 && JSON.stringify(leaves[0]) === JSON.stringify({ elementId: "plot", partIds: ["peaches.box"] }) && leaves[1].elementId === "scatter" && leaves[1].partIds!.length === 60 && leaves[2].partIds === null, "resolveTargetLeaves: a box of one plot, the 60 points of ANOTHER plot (its own manifest's group) and a loose ellipse");
  const viaCompiler = setCompile(mixed.deck).resolveTarget(mixedRef, 1);
  ok(JSON.stringify(viaCompiler) === JSON.stringify(leaves), "the compiler's manifest-validating resolver gives each member its own element's part index");
  const outlines = (await import("../src/lib/slide/targetGeometry")).targetOutlines(mixedRef, setCompile(mixed.deck).sample(0), { manifest: manifests, plotRoot: roots, groups: undefined });
  const owners = new Set(outlines.map(o => o.owner.elementId));
  ok(owners.has("plot") && owners.has("scatter") && owners.has("e1") && outlines.filter(o => o.owner.elementId === "scatter").every(o => o.bbox.x >= 20 - 1 && o.bbox.x <= 220 + 1 && o.bbox.y >= 200 - 1 && o.bbox.y <= 340 + 1), "targetOutlines places each member in its own plot's stage frame (the scatter points land inside the scatter's box)");
  ok(setLabel(mixedRef.members!, mixed.deck.slides[0].elements, id => manifests(mixed.deck.slides[0].elements.find(e => e.id === id && e.type === "plot") ? (mixed.deck.slides[0].elements.find(e => e.id === id) as SemanticPlotElement).assetId : "")) === "60 points + 1 part + 1 ellipse", "a mixed set is labelled by counts, largest first (\"60 points + 1 part + 1 ellipse\")");
  ok(setLabel(three.members!, mixed.deck.slides[0].elements) === "3 ellipses" && setLabel([{ element: "e1" }, { element: "src" }, { element: "e2" }], mixed.deck.slides[0].elements) === "2 ellipses + 1 rect", "loose sets read \"3 ellipses\" and \"2 ellipses + 1 rect\"");

  // The op: one source, one hand-off into the whole set.
  const { deck, slideId, beats } = deckWith([rect("src", { x: 161, y: 111, width: 135, height: 45, fill: "#d95f02" }), ...dots, line("other")]);
  const result = ops.becomeTransform(deck, slideId, beats[1], "src", reordered, { compiled: setCompile(deck) })!;
  const track = deck.slides[0].beats[1].tracks.find(t => t.id === result.trackId)!;
  ok(JSON.stringify(track.to) === JSON.stringify({ become: { ref: { element: "e1", members: [{ element: "e1" }, { element: "e2" }, { element: "e3" }] }, mode: "handoff", pair: "auto", reveal: "flip" }, state: {} }) && deck.slides[0].elements.length === 5, "rect → three loose ellipses (picked e3, e1, e2) writes ONE hand-off with members in the slide's object order; nothing is consumed");
  ok(validateDeckFile(structuredClone(deck)).length === 0, "the set record validates against the real deck schema");
  const compiled = setCompile(deck);
  const inventory = compiled.handoffs.find(h => h.trackId === track.id)!;
  ok(!!inventory && JSON.stringify(inventory.destination.map(d => d.elementId).sort()) === '["e1","e2","e3"]' && inventory.destination.every(d => d.partIds === null) && !compiled.issues.length, "compile publishes every member leaf in the hand-off inventory, without issues");
  const visible = (frame: ReturnType<typeof compiled.sample>, id: string) => frame.presentation.elementStates[id]?.visible ?? true;
  const at0 = compiled.sample(1, 0), mid = compiled.sample(1, 300), end = compiled.sample(1);
  ok(visible(at0, "src") && ["e1", "e2", "e3"].every(id => !visible(at0, id)) && ["e1", "e2", "e3"].every(id => !visible(compiled.sample(0), id)), "before the flight the rect shows and every ellipse is hidden (Design included)");
  ok(!visible(mid, "src") && ["e1", "e2", "e3"].every(id => !visible(mid, id)), "mid-flight both sides hide for the flight layer");
  ok(!visible(end, "src") && ["e1", "e2", "e3"].every(id => visible(end, id)), "after landing the three ellipses show and the rect stays hidden");
  const plan = planHandoff(track, compiled.sample(1, 0), { manifest: manifests, plotRoot: roots, groups: undefined });
  plan.prepare();
  const flying = plan.pairs.filter(p => p.a && p.b && !p.fade);
  ok(plan.policy === "tile" && flying.length === 3 && flying.every(p => !p.a!.closed && p.b!.closed) && new Set(flying.map(p => p.b!.owner.elementId)).size === 3, "pair auto resolves to tile: the rect's ring splits by arc length into three pieces, one per ellipse");
  const underlay = plan.pairs[0];
  const cloud = { x: (458 + 479) / 2, y: (71 + 197) / 2 };
  ok(plan.pairs.length === 4 && underlay.fade === "out" && underlay.a!.closed && underlay.a!.paint.fill === "#d95f02" && underlay.a!.paint.stroke === "none" && Math.abs(underlay.b!.bbox.x + underlay.b!.bbox.w / 2 - cloud.x) < 1e-6 && Math.abs(underlay.b!.bbox.y + underlay.b!.bbox.h / 2 - cloud.y) < 1e-6, "the filled rect keeps a fill-only underlay, drawn first (beneath the pieces), travelling toward the ellipses' centre");
  const { sampleCorrespondence } = await import("../src/lib/slide/correspondence");
  const first = sampleCorrespondence(plan, 0)[0].opacity, fading = sampleCorrespondence(plan, .2)[0].opacity, gone = sampleCorrespondence(plan, .4)[0].opacity;
  ok(first === 1 && Math.abs(fading - .5) < 1e-9 && gone === 0, "the underlay is whole at frame 0 and dissolves over the first 40 % (no fill pop as the outline splits)");
  const last = sampleCorrespondence(plan, 1).filter((_, i) => !plan.pairs[i].fade);
  ok(last.length === 3 && last.every(p => { const b = flying.find(q => q.b!.owner.elementId === p.owner.b!.elementId)!.b!; return p.nodes.length === b.nodes.length && p.nodes.every((n, i) => Math.abs(n.x - b.nodes[i].x) < 1e-9 && Math.abs(n.y - b.nodes[i].y) < 1e-9); }), "the last flight frame IS each ellipse's own outline (the flip is pixel-invisible)");
  const lengths = flying.map(p => p.a!.nodes.length);
  ok(lengths.every(n => n >= 2), "every piece of the split rect is a real chain");

  // Refusals: a set is a destination only, never a source, and never holds the source.
  const refuseSet = (source: TargetRef | string, dest: TargetRef | string, pattern: RegExp, options: ops.BecomeOptions = {}) => {
    const before = JSON.stringify(deck);
    assert.throws(() => ops.becomeTransform(deck, slideId, beats[2], source, dest, { compiled: setCompile(deck), ...options }), pattern);
    ok(JSON.stringify(deck) === before, `set refusal is atomic: ${pattern}`);
  };
  refuseSet(three, "other", /rather than a set of objects/);
  assert.throws(() => ops.appearFrom(deck, slideId, beats[2], { element: "other" }, three, { compiled: setCompile(deck) }), /rather than a set of objects/); checks++;
  refuseSet("e1", three, /includes the source/);
  refuseSet("other", three, /Consume needs one whole destination/, { mode: "consume" });
  refuseSet("other", { element: "e1", members: [{ element: "e1" }, { element: "gone" }] }, /destination objects is missing/);
  refuseSet("other", { element: "e1", members: [{ element: "e1" }, { element: "e2", group: "g" }] }, /not groups/);
  refuseSet("other", { element: "e3", members: [{ element: "e3" }, { element: "other2" }] }, /missing/);
  // Overlap law over resolved leaves: a second set sharing a member is refused.
  ops.addElement(deck, slideId, rect("other2", { x: 300, y: 300 }));
  ops.becomeTransform(deck, slideId, beats[1], "other", { element: "other2" }, { mode: "handoff", compiled: setCompile(deck) });
  const overlapBefore = JSON.stringify(deck);
  assert.throws(() => ops.becomeTransform(deck, slideId, beats[1], "other2", { element: "e2", members: [{ element: "e2" }, { element: "src" }] }, { compiled: setCompile(deck) }), /already lands/); checks++;
  ok(JSON.stringify(deck) === overlapBefore, "a second hand-off whose set shares a landed member is refused (the overlap law runs over resolved leaves)");
  const forced = structuredClone(deck);
  forced.slides[0].beats[1].tracks.push({ id: "forced", target: "other2", preset: "transform", duration: 600, to: { become: { ref: { element: "e2", members: [{ element: "e2" }, { element: "line-x" }] }, mode: "handoff" }, state: {} } });
  ok(setCompile(forced).issues.some(i => i.trackId === "forced" && /already lands/.test(i.reason)), "the compiler diagnoses two hand-offs sharing a set member as overlapping");
  ok(typeof ops.swapBecome(structuredClone(deck), slideId, deck.slides[0].beats[1].tracks.find(t => t.target === "other")!.id!, swapOptions) === "string", "an ordinary hand-off beside a set still swaps");
  assert.throws(() => ops.swapBecome(structuredClone(deck), slideId, track.id!, { ...swapOptions, plotManifest: manifests, plotRoot: roots }), /A set destination cannot be reversed/); checks++;
  ok(true, "Swap direction refuses a set destination with its reason");

  // Dangling member: deleting one ellipse keeps the hand-off landing on the rest, diagnosed.
  const pruned = structuredClone(deck);
  pruned.slides[0].elements = pruned.slides[0].elements.filter(e => e.id !== "e2");
  const prunedCompiled = setCompile(pruned);
  ok(prunedCompiled.handoffs.find(h => h.trackId === track.id)?.destination.length === 2 && prunedCompiled.issues.some(i => i.trackId === track.id && /One destination object is missing/.test(i.reason)), "a deleted set member leaves a diagnosed hand-off that still lands on the remaining members");

  // Copies remap every member (duplicate slide, snapshot insert, embed namespace).
  const dupId = ops.duplicateSlide(deck, slideId)!;
  const dup = deck.slides.find(s => s.id === dupId)!;
  const dupRef = dup.beats[1].tracks.find(t => t.to?.become?.ref.members)!.to!.become!.ref;
  ok(dupRef.members!.every(m => dup.elements.some(e => e.id === m.element) && !["e1", "e2", "e3"].includes(m.element)) && dupRef.element === dupRef.members![0].element, "duplicateSlide remaps every set member (and the representative element) to the copy's objects");
  const { namespaceEmbedDeck } = await import("../src/lib/slide/embedRender");
  const embedded = namespaceEmbedDeck(deck, "emb").slides[0].beats[1].tracks.find(t => t.to?.become?.ref.members)!.to!.become!.ref;
  ok(embedded.members!.every(m => m.element.startsWith("emb-")), "embed namespacing remaps every set member");
  const remapped = structuredClone(track);
  remapBecomeTarget(remapped, new Map([["e1", "x1"], ["e3", "x3"]]));
  ok(remapped.to!.become!.ref.element === "x1", "the representative element follows its member");
  ok(JSON.stringify(remapped.to!.become!.ref) === JSON.stringify({ element: "x1", members: [{ element: "x1" }, { element: "e2" }, { element: "x3" }] }), "remapBecomeTarget maps each member's element and nothing else");
}

console.log("── MERGE: many sources → one destination (Oct-2 stretch) ──");
{
  const { planHandoff } = await import("../src/lib/slide/handoffPlan");
  const { sampleCorrespondence } = await import("../src/lib/slide/correspondence");
  const dots = [ellipse("e1", { x: 458, y: 71, width: 21, height: 21, fill: "#d95f02", stroke: "none", strokeWidth: 0 }), ellipse("e2", { x: 458, y: 124, width: 21, height: 21, fill: "#d95f02", stroke: "none", strokeWidth: 0 }), ellipse("e3", { x: 458, y: 176, width: 21, height: 21, fill: "#d95f02", stroke: "none", strokeWidth: 0 })];
  const { deck, slideId, beats } = deckWith([rect("dest", { x: 161, y: 111, width: 135, height: 45, fill: "#d95f02", cornerRadius: 0 }), ...dots, rect("other", { x: 20, y: 300 })]);
  const before = structuredClone(deck);
  const ids = ["e1", "e2", "e3"].map((id, i) => ops.appearFrom(deck, slideId, beats[1], { element: "dest" }, id, { compiled: compileSlide(deck.slides[0]), start: i * 100 })!.trackId);
  const tracks = deck.slides[0].beats[1].tracks;
  ok(ids.length === 3 && new Set(ids).size === 3 && tracks.every(t => t.to?.become?.mode === "handoff" && t.to.become.ref.element === "dest" && !t.to.become.ref.members) && deck.slides[0].elements.length === 5, "Appear from… ×3 writes three hand-offs into the SAME rect; the old 'already lands' refusal no longer applies to an identical destination");
  ok(validateDeckFile(structuredClone(deck)).length === 0, "the merge validates against the real deck schema");
  const compiled = compileSlide(deck.slides[0]);
  ok(compiled.handoffs.length === 3 && compiled.handoffs.every(h => JSON.stringify(h.merge) === JSON.stringify({ trackIds: ids, landAt: 800 })) && !compiled.issues.length, "compile groups the three as one merge in story order, landing at the group's latest end (800 ms)");
  const vis = (frame: ReturnType<typeof compiled.sample>, id: string) => frame.presentation.elementStates[id]?.visible ?? true;
  const at = (t: number) => compiled.sample(1, t);
  ok(!vis(compiled.sample(0), "dest") && !vis(at(0), "dest") && ["e1", "e2", "e3"].every(id => vis(at(0), id)), "before the merge: three ellipses show, the rect waits hidden (Design included)");
  ok(!vis(at(150), "e1") && !vis(at(150), "e2") && vis(at(150), "e3") && !vis(at(150), "dest"), "each source hides as its own flight starts (staggered starts)");
  ok(!vis(at(650), "dest") && !vis(at(799), "dest"), "the rect stays hidden after the FIRST landing (600 ms) until the LAST (800 ms)");
  ok(vis(at(800), "dest") && ["e1", "e2", "e3"].every(id => !vis(at(800), id)) && vis(compiled.sample(1), "dest"), "at the last landing the rect reveals and every ellipse stays hidden");
  ok(!vis(at(0), "dest") && vis(at(0), "e1"), "reverse seek restores the sources and hides the rect again");
  // Each lander keeps its own share of ONE shared tiling of the rect.
  const frame = compiled.sample(1, 0), ctx = { manifest: () => undefined, plotRoot: () => undefined, groups: undefined };
  const plans = tracks.map(t => planHandoff(t, frame, ctx, tracks));
  plans.forEach(p => p.prepare());
  const flying = plans.map(p => p.pairs.filter(q => q.a && q.b && !q.fade));
  ok(flying.every((f, i) => f.length === 1 && f[0].a!.owner.elementId === ["e1", "e2", "e3"][i] && f[0].b!.owner.elementId === "dest" && !f[0].b!.closed), "each lander flies its own ellipse into its own piece of the rect");
  const perimeter = 2 * (135 + 45), lengthOf = (nodes: { x: number; y: number }[]) => nodes.slice(1).reduce((sum, n, i) => sum + Math.hypot(n.x - nodes[i].x, n.y - nodes[i].y), 0);
  ok(Math.abs(flying.reduce((sum, f) => sum + lengthOf(f[0].b!.nodes), 0) - perimeter) < 1e-6, "the three pieces tile the rect's whole perimeter exactly once (the time-reverse of the set split)");
  ok(plans[0].pairs.every(q => !q.fade) && plans[1].pairs.every(q => !q.fade) && plans[2].pairs.some(q => q.fade === "in" && q.b!.closed && q.b!.paint.stroke === "none"), "only the last lander carries the rect's fill underlay, which resolves over the last 40 %");
  const landed = plans.map(p => sampleCorrespondence(p, 1).filter((_, i) => !p.pairs[i].fade)[0]);
  ok(landed.every((path, i) => path.nodes.length === flying[i][0].b!.nodes.length && path.nodes.every((n, j) => Math.abs(n.x - flying[i][0].b!.nodes[j].x) < 1e-9 && Math.abs(n.y - flying[i][0].b!.nodes[j].y) < 1e-9)), "every lander's last frame is exactly its piece of the rect's own outline");
  // The overlap law still refuses a PARTIAL overlap of the merged destination.
  const mergedBytes = JSON.stringify(deck);
  assert.throws(() => ops.becomeTransform(deck, slideId, beats[1], "other", { element: "dest", members: [{ element: "dest" }, { element: "e1" }] }, { compiled: compileSlide(deck.slides[0]) }), /already lands|includes the source/); checks++;
  ok(JSON.stringify(deck) === mergedBytes, "a different ref that overlaps the merged destination is still refused, atomically");
  ops.removeTracks(deck, slideId, ids);
  ok(JSON.stringify(deck.slides[0].beats) === JSON.stringify(before.slides[0].beats), "removing the three lanes restores the slide's steps");
}

console.log("── legacy morph normalizes ──");
{
  const raw = { schemaVersion: "0.4.0", id: "old", title: "Old", created: "", modified: "", stage: { width: 640, height: 360 }, theme: "flux-dark", defaults: { transition: "none", buildEasing: "smooth", advance: "click" }, assets: [],
    slides: [{ id: "s", elements: [{ type: "plot", id: "p", assetId: "a", x: 0, y: 0, width: 10, height: 10, rotation: 0 }], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id: "t", target: "p", preset: "morph", to: { assetId: "b", svgPath: "plots/b.svg" } }] }] }] } as unknown as Deck;
  const norm = ops.normalizeDeck(raw);
  const t = norm.slides[0].beats[1].tracks[0];
  ok(t.preset === "transform" && t.duration === 1200 && t.to!.assetId === "b" && JSON.stringify(t.to!.state) === "{}", "preset \"morph\" → transform with its 1200 ms default and an empty patch");
  ok(compileSlide(norm.slides[0]).sample(1).elements[0] && (compileSlide(norm.slides[0]).sample(1).elements[0] as { assetId: string }).assetId === "b", "…and plays as the data Become it always was");
}

console.log("── the real CLI ──");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-become-"));
const repo = path.resolve(import.meta.dirname, "..");
try {
  const tree = buildScaffoldTree({ title: "Become verification" }, ops.createDeck());
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, contents] of tree.files) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), contents);
  }
  const { deck, slideId, beats } = deckWith([line("src"), ellipse("tgt")]);
  // F1/C1 seam: compileBecomeSlide must carry deck.animStyles into the
  // real file handler's birth validation, not just compile the raw tracks.
  const styled = deckWith([line("src"), rect("seed")]);
  const birth = ops.addGhostTransform(styled.deck, styled.slideId, styled.beats[1], "seed")!;
  const birthTrack = styled.deck.slides[0].beats[1].tracks.find(t => t.id === birth.trackIds[0])!;
  const style = ops.addAnimStyle(styled.deck, { name: "Delayed birth", family: "transform", track: { preset: "transform", start: 5000 } });
  ok(ops.linkTrackStyle(styled.deck, styled.slideId, birthTrack.id!, style.id).ok && !Object.hasOwn(birthTrack, "start"), "destination birth inherits its 5000 ms start only from the linked style");
  await saveDeck(root, styled.deck);
  const styledPath = path.join(root, "slides", styled.deck.id, "deck.json");
  const styledBytes = await fs.readFile(styledPath, "utf8");
  await assert.rejects(() => becomeHeadless(root, styled.deck.id, styled.slideId, styled.beats[1], "src", { targetId: birth.elementIds[0], mode: "handoff", start: 0 }), /destination is not yet born/);
  ok(await fs.readFile(styledPath, "utf8") === styledBytes, "real flux-core Become refuses a linked-style late birth atomically");
  const sourceTrack = ops.setTransform(styled.deck, styled.slideId, styled.beats[1], "src", { state: {} })!;
  ops.linkTrackStyle(styled.deck, styled.slideId, sourceTrack.id!, style.id);
  for (const variant of ["style", "anchor", "disabled"] as const) {
    delete sourceTrack.anchor; delete sourceTrack.disabled;
    if (variant === "anchor") sourceTrack.anchor = { trackId: birthTrack.id!, edge: "end" };
    if (variant === "disabled") sourceTrack.disabled = true;
    const candidate = await loadDeck(root, styled.deck.id);
    candidate.slides = structuredClone(styled.deck.slides);
    await saveDeck(root, candidate);
    const result = await becomeHeadless(root, styled.deck.id, styled.slideId, styled.beats[1], "src", { targetId: birth.elementIds[0], mode: "handoff" });
    const saved = await loadDeck(root, styled.deck.id), authored = saved.slides[0].beats[1].tracks.find(t => t.id === sourceTrack.id)!;
    const compiled = compileSlide(saved.slides[0], saved.stage, saved);
    const resolved = compiled.cues[1].tracks.find(t => t.track.id === result.trackId)!;
    ok(result.trackId === sourceTrack.id && !Object.hasOwn(authored, "start") && authored.styleId === style.id && !authored.disabled && resolved.start >= 5000 && compiled.handoffs.some(h => h.trackId === result.trackId), `real flux-core Become validates an existing ${variant} source at its resolved start and retains inherited timing`);
  }
  await saveDeck(root, deck);
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "flux-cli.ts", ...args, "--root", root], { cwd: repo, encoding: "utf8", env: { ...process.env, FLUX_NO_MIGRATE: "1" }, timeout: 30000 });
  // Only the deck-local manifest exists: both headless compile paths must find it.
  const localPlot = { ...plot(), assetId: "deck-only", source: undefined };
  const local = deckWith([line("src"), localPlot]);
  local.deck.id = "local-become";
  local.deck.assets.push({ id: "deck-only", name: "Deck-only plot", kind: "svg", path: "assets/deck-only.svg", naturalWidth: 640, naturalHeight: 480 });
  const localDir = path.join(root, "slides", local.deck.id, "assets");
  await fs.mkdir(localDir, { recursive: true });
  for (const suffix of ["svg", "fluxplot.json"]) await fs.copyFile(`scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.${suffix}`, path.join(localDir, `deck-only.${suffix}`));
  await saveDeck(root, local.deck);
  const localPath = path.join(root, "slides", local.deck.id, "deck.json"), localBytes = await fs.readFile(localPath, "utf8");
  await assert.rejects(() => becomeHeadless(root, local.deck.id, local.slideId, local.beats[1], "src", { targetId: "plot", parts: ["missing.part"] }), /Destination parts not found/);
  ok(await fs.readFile(localPath, "utf8") === localBytes, "deck-local manifest is used by real Become validation before any mutation");
  const localResult = await becomeHeadless(root, local.deck.id, local.slideId, local.beats[1], "src", { targetId: "plot", parts: spines.parts });
  const localCompiled = await compileDeckSlide(root, await loadDeck(root, local.deck.id), local.slideId);
  ok(localCompiled.handoffs.length === 1 && !localCompiled.issues.length, "the shared headless compile helper resolves valid deck-local plot parts");
  const localSwap = run("swap-become", local.deck.id, local.slideId, localResult.trackId);
  ok(localSwap.status === 0 && (await loadDeck(root, local.deck.id)).slides[0].beats[1].tracks[0].target === "plot", `real swap reads deck-local SVG geometry: ${localSwap.stderr}`);
  await saveDeck(root, deck);
  const cli = run("become", deck.id, slideId, beats[1], "src", "--target", "tgt", "--duration", "800");
  ok(cli.status === 0, `CLI succeeds: ${cli.stderr}`);
  const trackId = cli.stdout.trim();
  const loaded = await loadDeck(root, deck.id);
  const track = loaded.slides[0].beats[1].tracks.find((t) => t.id === trackId)!;
  ok(!!track && track.preset === "transform" && (track.to!.state as { type?: string }).type === "ellipse" && track.duration === 800 && !loaded.slides[0].elements.some((e) => e.id === "tgt"), "CLI writes the same record and consumes the target");
  ok(validateDeckFile(loaded).length === 0, "the saved deck validates");
  const bytes = await fs.readFile(path.join(root, "slides", deck.id, "deck.json"), "utf8");
  const bad = run("become", deck.id, slideId, beats[1], "src", "--target", "nope");
  ok(bad.status !== 0 && /missing/i.test(bad.stderr) && await fs.readFile(path.join(root, "slides", deck.id, "deck.json"), "utf8") === bytes, "a refused Become leaves the file untouched and says why");
  const neither = run("become", deck.id, slideId, beats[1], "src");
  ok(neither.status !== 0 && /exactly one of/.test(neither.stderr), "exactly one of --target / --asset is required");
  const gone = run("set-morph", deck.id, slideId, beats[1], "src", "x");
  ok(gone.status !== 0, "set-morph is gone (its data-only form is `become --asset`)");
  const live = deckWith([line("src"), plot(), rect("box")]);
  // A shared existing id makes exact byte parity observable across processes;
  // neither test is allowed to normalize away a differing mutation record.
  ops.setTransform(live.deck, live.slideId, live.beats[1], "src", { state: {} });
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  for (const suffix of ["svg", "fluxplot.json"]) await fs.copyFile(`scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.${suffix}`, path.join(root, `plots/boxplot.${suffix}`));
  await saveDeck(root, live.deck);
  const flags = ["--part", spines.parts!.join(","), "--pair", "tile", "--reveal", "draw", "--start", "25", "--duration", "700", "--easing", "linear"];
  const direct = run("become", live.deck.id, live.slideId, live.beats[1], "src", "--target", "plot", ...flags);
  ok(direct.status === 0, `CLI become --part succeeds with a real manifest: ${direct.stderr}`);
  const directDeck = await loadDeck(root, live.deck.id);
  const reset = await loadDeck(root, live.deck.id);
  reset.slides = structuredClone(live.deck.slides);
  await saveDeck(root, reset);
  const inverse = run("appear-from", live.deck.id, live.slideId, live.beats[1], "--dest", "plot", "--from", "src", ...flags);
  ok(inverse.status === 0, `CLI appear-from succeeds: ${inverse.stderr}`);
  const inverseDeck = await loadDeck(root, live.deck.id);
  // Persistence stamps wall time independently of the mutation. Compare exact
  // deck bytes with only that documented writer timestamp held equal.
  inverseDeck.modified = directDeck.modified;
  ok(JSON.stringify(directDeck) === JSON.stringify(inverseDeck), "real become --part and appear-from produce byte-identical decks apart from the writer timestamp");
  const expected = structuredClone(live.deck);
  ops.becomeTransform(expected, live.slideId, live.beats[1], "src", spines, { compiled: compiledFor(expected), pair: "tile", reveal: "draw", start: 25, duration: 700, easing: "linear" });
  expected.modified = directDeck.modified;
  ok(JSON.stringify(expected) === JSON.stringify(directDeck), "GUI pure op and real CLI mutation are byte-identical");
  for (const args of [
    ["become", live.deck.id, live.slideId, live.beats[2], "plot", "--target", "plot", "--part", "axis.x.spine", "--source-part", "axis.x.spine"],
    ["appear-from", live.deck.id, live.slideId, live.beats[2], "--dest", "plot", "--from", "plot", "--part", "axis.x.spine", "--source-part", "axis.x.spine"],
  ]) {
    const before = await fs.readFile(path.join(root, "slides", live.deck.id, "deck.json"), "utf8");
    const refusal = run(...args);
    ok(refusal.status !== 0 && /Choose a different object for the source to become\./.test(refusal.stderr) && await fs.readFile(path.join(root, "slides", live.deck.id, "deck.json"), "utf8") === before, `real ${args[0]} surfaces a user-readable refusal without writing`);
  }
  const sourcePart = run("become", live.deck.id, live.slideId, live.beats[2], "plot", "--source-part", "peaches.box", "--target", "box");
  ok(sourcePart.status === 0 && (await loadDeck(root, live.deck.id)).slides[0].beats[2].tracks[0].part === "peaches.box", "real --source-part writes a part-level hand-off");
  const partDeck = await loadDeck(root, live.deck.id);
  const sourcePartTwin = run("appear-from", live.deck.id, live.slideId, live.beats[2], "--dest", "box", "--from", "plot", "--source-part", "peaches.box");
  ok(sourcePartTwin.status === 0, `real appear-from --source-part succeeds: ${sourcePartTwin.stderr}`);
  const twinDeck = await loadDeck(root, live.deck.id); twinDeck.modified = partDeck.modified;
  ok(JSON.stringify(twinDeck) === JSON.stringify(partDeck), "destination-side part-source authoring retains exactly the existing hand-off bytes");
  // Real CLI swap uses the same op and preserves the HOW bytes of the source.
  const swapInput = await loadDeck(root, live.deck.id);
  const swapSource = swapInput.slides[0].beats[1].tracks.find(t => t.target === "src")!;
  const expectedSwap = structuredClone(swapInput);
  const expectedId = ops.swapBecome(expectedSwap, live.slideId, swapSource.id!, swapOptions);
  const swapCli = run("swap-become", live.deck.id, live.slideId, swapSource.id!);
  ok(swapCli.status === 0, `real CLI swap-become succeeds: ${swapCli.stderr}`);
  const swappedDeck = await loadDeck(root, live.deck.id), actualId = swapCli.stdout.trim();
  const actualSwap = swappedDeck.slides[0].beats[1].tracks.find(t => t.id === actualId)!;
  actualSwap.id = expectedId; swappedDeck.modified = expectedSwap.modified;
  ok(JSON.stringify(swappedDeck) === JSON.stringify(expectedSwap), "real CLI swap and exported GUI op write identical decks apart from generated ID and writer time");
  const swapPath = path.join(root, "slides", live.deck.id, "deck.json"), swapBytes = await fs.readFile(swapPath, "utf8");
  const missingSwap = run("swap-become", live.deck.id, live.slideId, "missing");
  ok(missingSwap.status !== 0 && /Choose a hand-off/.test(missingSwap.stderr) && await fs.readFile(swapPath, "utf8") === swapBytes, "real CLI swap refusal reports the reason and leaves persisted bytes untouched");
  const forced = run("become", live.deck.id, live.slideId, live.beats[2], "box", "--target", "plot", "--mode", "consume");
  ok(forced.status === 0 && !(await loadDeck(root, live.deck.id)).slides[0].elements.some(e => e.id === "plot"), "real --mode consume retains the whole-plot consume route");
  // Oct-2 destination sets through the REAL CLI: --to (repeatable), --members, appear-from --members.
  {
    const dots = ["e1", "e2", "e3"].map((id, i) => ellipse(id, { x: 458, y: 71 + 53 * i, width: 21, height: 21 }));
    const sets = deckWith([rect("src"), ...dots, rect("spare")]);
    sets.deck.id = "set-become";
    await saveDeck(root, sets.deck);
    const setPath = path.join(root, "slides", sets.deck.id, "deck.json"), originalBytes = await fs.readFile(setPath, "utf8");
    const expected = structuredClone(await loadDeck(root, sets.deck.id));
    const want = ops.becomeTransform(expected, sets.slideId, sets.beats[1], "src", { element: "e1", members: [{ element: "e1" }, { element: "e2" }, { element: "e3" }] })!;
    const viaTo = run("become", sets.deck.id, sets.slideId, sets.beats[1], "src", "--to", "e1", "--to", "e2", "--to", "e3");
    ok(viaTo.status === 0 && /src hands off to 3 ellipses/.test(viaTo.stderr), `real CLI become --to ×3 succeeds and names the set: ${viaTo.stderr.trim()}`);
    const toDeck = await loadDeck(root, sets.deck.id), toTrack = toDeck.slides[0].beats[1].tracks[0];
    expected.slides[0].beats[1].tracks.find(t => t.id === want.trackId)!.id = toTrack.id; expected.modified = toDeck.modified;
    ok(JSON.stringify(toDeck) === JSON.stringify(expected) && toTrack.to?.become?.ref.members?.length === 3, "CLI --to writes exactly the pure op's set record (GUI/CLI byte parity)");
    const toBytes = await fs.readFile(setPath, "utf8");
    // The same set through --members and from the destination side.
    await fs.writeFile(setPath, originalBytes);
    const viaMembers = run("become", sets.deck.id, sets.slideId, sets.beats[1], "src", "--members", JSON.stringify([{ element: "e1" }, { element: "e2" }, { element: "e3" }]));
    const membersDeck = await loadDeck(root, sets.deck.id);
    ok(viaMembers.status === 0 && JSON.stringify(membersDeck.slides[0].beats[1].tracks[0].to) === JSON.stringify(toTrack.to), "become --members writes the same destination set as --to");
    await fs.writeFile(setPath, originalBytes);
    const twin = run("appear-from", sets.deck.id, sets.slideId, sets.beats[1], "--members", JSON.stringify([{ element: "e3" }, { element: "e1" }, { element: "e2" }]), "--from", "src");
    const twinDeck = await loadDeck(root, sets.deck.id);
    ok(twin.status === 0 && /3 ellipses appear from src/.test(twin.stderr) && JSON.stringify(twinDeck.slides[0].beats[1].tracks[0].to.become.ref.members.map((m: TargetRef) => m.element).sort()) === '["e1","e2","e3"]', `appear-from --members authors the set from the destination side: ${twin.stderr.trim()}`);
    await fs.writeFile(setPath, toBytes);
    for (const [label, args, pattern] of [
      ["--to with --target", ["--to", "e1", "--target", "e2"], /exactly one of --target/],
      ["--part with --to", ["--to", "e1", "--to", "e2", "--part", "x"], /each set member its own parts/],
      ["a set holding the source", ["--to", "spare", "--to", "e1"], /includes the source/],
      ["consume of a set", ["--to", "e1", "--to", "e2", "--mode", "consume"], /Consume needs one whole destination/],
    ] as const) {
      const refused = run("become", sets.deck.id, sets.slideId, sets.beats[2], "spare", ...args);
      ok(refused.status !== 0 && pattern.test(refused.stderr) && await fs.readFile(setPath, "utf8") === toBytes, `real CLI refuses ${label} with its reason and writes nothing`);
    }
  }
  const { appearFromTransform, becomeTransform, handoffTargetsOverlap, swapBecome } = await import("../flux-core/index");
  ok(appearFromTransform === ops.appearFrom && becomeTransform === ops.becomeTransform && swapBecome === ops.swapBecome && typeof handoffTargetsOverlap === "function", "flux-core exposes the same pure authoring functions and resolver helpers");
  console.log(`##VERIFY## ${JSON.stringify({ script: "verify-slide-become", ok: true, checks })}`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
