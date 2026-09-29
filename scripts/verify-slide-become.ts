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
  const { appearFromTransform, becomeTransform, handoffTargetsOverlap, swapBecome } = await import("../flux-core/index");
  ok(appearFromTransform === ops.appearFrom && becomeTransform === ops.becomeTransform && swapBecome === ops.swapBecome && typeof handoffTargetsOverlap === "function", "flux-core exposes the same pure authoring functions and resolver helpers");
  console.log(`##VERIFY## ${JSON.stringify({ script: "verify-slide-become", ok: true, checks })}`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
