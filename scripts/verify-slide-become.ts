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
import { loadDeck, saveDeck } from "../flux-core/slides";
import * as ops from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { familyOf } from "../src/lib/slide/family";
import { validateDeckFile } from "../src/lib/project/validate";
import type { Element, LineElement, EllipseElement, RectElement, PathElement } from "../src/lib/types";
import type { Deck } from "../src/lib/slide/types";

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
  const r = ops.becomeTransform(deck, slideId, beats[1], pa, pb)!;
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
  const r2 = ops.becomeTransform(deck, slideId, beats[2], "box", pc)!;
  const t2 = deck.slides[0].beats[2].tracks.find((x) => x.id === r2.trackId)!;
  ok((t2.to!.state as { type?: string }).type === "plot" && t2.to!.assetId === "plotC" && t2.to!.svgPath === "plots/c.svg", "rect → plot: retype plus the content half");
  const boxEnd = compileSlide(deck.slides[0]).sample(2).elements.find((e) => e.id === "box")!;
  ok(boxEnd.type === "plot" && (boxEnd as { assetId: string }).assetId === "plotC" && boxEnd.x === 1, "the rect is plot C after step 2");
  ops.addElement(deck, slideId, ellipse("oval"));
  const r3 = ops.becomeTransform(deck, slideId, beats[2], pa, "oval")!;
  const t3 = deck.slides[0].beats[2].tracks.find((x) => x.id === r3.trackId)!;
  ok((t3.to!.state as { type?: string }).type === "ellipse" && !("assetId" in t3.to!) && !("svgPath" in t3.to!), "plot → ellipse: retype, and the content half is dropped");
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
  await saveDeck(root, deck);
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "flux-cli.ts", ...args, "--root", root], { cwd: repo, encoding: "utf8", env: { ...process.env, FLUX_NO_MIGRATE: "1" }, timeout: 30000 });
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
  console.log(`##VERIFY## ${JSON.stringify({ script: "verify-slide-become", ok: true, checks })}`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
