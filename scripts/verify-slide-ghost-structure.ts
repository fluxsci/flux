// Ghost births own ordinary result objects: structural edits and persistence
// must preserve that ownership without introducing hidden asset dependencies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ops from "../src/lib/slide/ops";
import * as figureOps from "../src/lib/ops";
import { deckToProject, projectIntoDeck, slideAssetIds } from "../src/lib/slide/deckProject";
import { compileSlide } from "../src/lib/slide/compile";
import { deckSourceProject, reconcileDeckExternalAssetSizes } from "../src/lib/slide/sourceSync";
import { applyAutoAnimation } from "../src/lib/slide/autobuild";
import { makeAnimPreset } from "../src/lib/slide/animTemplates";
import { readProjectDependencies } from "../src/lib/project/dependencies";
import { figureSourceOwners } from "../src/lib/project/figureSourceOwners";
import { DECK_SCHEMA_VERSION, type Deck, type Slide } from "../src/lib/slide/types";
import type { Asset, Element, Project } from "../src/lib/types";

let checks = 0;
const eq = (a: unknown, b: unknown, label: string) => { assert.deepEqual(a, b, label); checks++; console.log("  ok:", label); };
const fixture = () => {
  const d = ops.createDeck({ id: "ghost-structure", withTitleSlide: false });
  const s = ops.addSlide(d, { layout: "blank", name: "Ghosts" });
  s.elements = [{ id: "source", name: "Source", type: "rect", x: 20, y: 30, width: 50, height: 40, rotation: 10,
    fill: "#ff0000", stroke: "none", strokeWidth: 0, cornerRadius: 3, groupId: "source-group", locked: true }];
  s.groups = { "source-group": { id: "source-group", name: "Original group" } };
  const before = ops.addBeat(d, s.id, { label: "Before" })!;
  const birth = ops.addBeat(d, s.id, { label: "Copies" })!;
  const later = ops.addBeat(d, s.id, { label: "Later" })!;
  ops.setTransform(d, s.id, before.id, "source", { state: { x: 80, fill: "#00ff00" } });
  return { d, s, before, birth, later };
};

{
  const { d, s, birth } = fixture(), original = structuredClone(s.elements[0]);
  const r = ops.addGhostTransform(d, s.id, birth.id, "source", { states: [{ x: 120 }, { y: 180 }, { rotation: 90 }] })!;
  eq([r.elementIds.length, r.trackIds.length, new Set([...r.elementIds, ...r.trackIds]).size], [3, 3, 6], "creation returns three independent persistent objects and births");
  eq(s.elements[0], original, "creation never changes source Design content");
  eq(s.elements.slice(1).map(e => [e.x, (e as any).fill, e.groupId, e.locked]), [[80, "#00ff00", undefined, undefined], [80, "#00ff00", undefined, undefined], [80, "#00ff00", undefined, undefined]], "fallback captures prior-step appearance with independent selection metadata");
  eq(birth.groups?.find(g => g.id === r.groupId)?.label, "Ghosts of Source", "birth group explains its source");
  eq(s.elements.slice(1).map(e => e.name), ["Ghost 1", "Ghost 2", "Ghost 3"], "copies start with short distinct names inside their source group");
  eq(birth.tracks.map(t => [t.target, t.ghostFrom]), r.elementIds.map(id => [id, "source"]), "each birth owns exactly one result");
  const persisted = projectIntoDeck(deckToProject(d, d.assets), d);
  eq(persisted.slides, JSON.parse(JSON.stringify(d)).slides, "projection and JSON reopen preserve birth bindings and sparse endpoints");
  for (const bad of [0, 1.5, 33, NaN]) {
    const before = JSON.stringify(d);
    assert.throws(() => ops.addGhostTransform(d, s.id, birth.id, "source", { count: bad }), /1 to 32/);
    eq(JSON.stringify(d), before, `invalid count ${bad} leaves the complete deck unchanged`);
  }
  const project = deckToProject(d, []), copyId = figureOps.duplicateElements(project, s.id, [r.elementIds[0]])[0];
  const detached = projectIntoDeck(project, d).slides[0];
  eq(detached.elements.some(e => e.id === copyId) && !detached.beats.some(b => b.tracks.some(t => t.target === copyId)), true, "ordinary object duplication is a static snapshot without birth ownership");
  eq(compileSlide(detached).sample(0).presentation.unbornElementIds?.includes(copyId) ?? false, false, "ordinary copied result is available from Design");
}

{
  const { d, s, birth } = fixture();
  const change = ops.setTransform(d, s.id, birth.id, "source", { state: { x: 300 }, duration: 987 })!;
  birth.tracks.push({ id: "emphasis", target: "source", preset: "highlight" }, { id: "part", target: "source", part: "edge", preset: "fadeOut" });
  const before = JSON.stringify(d);
  assert.throws(() => ops.addGhostTransform(d, s.id, birth.id, "source"), /already has/);
  eq(JSON.stringify(d), before, "Stay refuses an existing source Change without mutating unrelated work");
  const r = ops.addGhostTransform(d, s.id, birth.id, "source", { count: 1, original: "transform" })!;
  eq([r.originalTrackId, change.to?.state, change.duration], [change.id, { x: 300 }, 987], "Transform reuses the original's existing Change and endpoint");
  eq(birth.tracks.filter(t => t.id === "emphasis" || t.id === "part").length, 2, "original choice preserves emphasis and part-level exit effects");
  const ownBirth = birth.tracks.find(t => t.id === r.trackIds[0])!;
  ownBirth.to!.state = { x: 410 };
  const preset = makeAnimPreset("Slow", ownBirth);
  eq("ghostFrom" in preset.track, false, "reusable animation presets never capture a source binding");
  ops.setAnimation(d, s.id, birth.id, { target: ownBirth.target, ...preset.track, duration: 1111 });
  const applied = birth.tracks.find(t => t.target === ownBirth.target)!;
  eq([applied.ghostFrom, applied.to?.state, applied.duration], ["source", { x: 410 }, 1111], "a timing preset preserves the existing birth and destination");
}
{
  const { d, s, birth } = fixture();
  birth.tracks.push({ id: "exit", target: "source", preset: "wipeOut", duration: 750 });
  const r = ops.addGhostTransform(d, s.id, birth.id, "source", { count: 1, original: "disappear" })!;
  eq([r.originalTrackId, birth.tracks.filter(t => t.target === "source").length], ["exit", 1], "Disappear reuses the existing whole-object exit");
}

{
  const { d, s, birth, later } = fixture();
  const r = ops.addGhostTransform(d, s.id, birth.id, "source", { count: 2, states: [{ x: 120 }, { x: 220 }] })!;
  ops.setTransform(d, s.id, later.id, r.elementIds[0], { state: { y: 270 } });
  const siblingTrackId = ops.duplicateTrack(d, s.id, r.trackIds[0])!, sibling = ops.findTrack(d, siblingTrackId)!.track;
  eq([sibling.target !== r.elementIds[0], sibling.ghostFrom, sibling.to?.state, sibling.groupId], [true, "source", { x: 120 }, r.groupId], "duplicating a birth appends an independent sibling with matching timing and destination");
  eq(later.tracks.some(t => t.target === sibling.target), false, "adding a sibling does not copy or retarget the original child's later animation");
  eq(s.elements.find(e => e.id === sibling.target)?.name, "Ghost 3", "appending a sibling chooses the next free source copy name");
  birth.tracks.push({ id: "child-emphasis", target: r.elementIds[0], preset: "highlight" });
  const duplicate = ops.duplicateBeat(d, s.id, birth.id)!;
  const oldTargets = new Set(birth.tracks.filter(t => t.ghostFrom).map(t => t.target));
  eq(duplicate.tracks.filter(t => t.ghostFrom).every(t => !oldTargets.has(t.target) && t.ghostFrom === "source"), true, "duplicating a step gives each cloned birth a new result");
  eq(duplicate.tracks.some(t => t.preset === "highlight" && t.target === duplicate.tracks.find(t => t.ghostFrom)?.target), true, "duplicated step effects follow their newly cloned result");
  const copiedId = ops.duplicateSlide(d, s.id)!, copied = ops.slideById(d, copiedId)!;
  const copiedElements = new Set(copied.elements.map(e => e.id));
  eq(copied.beats.flatMap(b => b.tracks).filter(t => t.ghostFrom).every(t => copiedElements.has(t.target) && copiedElements.has(t.ghostFrom!)), true, "duplicating a whole slide remaps both ends of every birth relationship");
  const descendant = ops.addGhostTransform(d, s.id, later.id, r.elementIds[0], { count: 1, original: "transform" })!;
  const fallback = structuredClone(s.elements.find(e => e.id === descendant.elementIds[0]));
  ops.removeTracks(d, s.id, [r.trackIds[0]]);
  eq(s.elements.some(e => e.id === r.elementIds[0]) || s.beats.some(b => b.tracks.some(t => t.target === r.elementIds[0])), false, "deleting a birth removes its result and all effects on that result");
  eq(s.elements.find(e => e.id === descendant.elementIds[0]), fallback, "dependent copies retain their own durable fallback after their source is deleted");
  eq(compileSlide(s).issues.some(i => i.target === descendant.elementIds[0] && i.reason.includes("source")), true, "dependent source deletion becomes a visible diagnostic");
  const copiedBirthTargets = duplicate.tracks.filter(t => t.ghostFrom).map(t => t.target);
  ops.deleteBeat(d, s.id, duplicate.id);
  eq(s.elements.some(e => copiedBirthTargets.includes(e.id)), false, "deleting a duplicated step cleans up its owned results");
  const still = JSON.stringify(s.beats);
  const project = deckToProject(d, []); figureOps.deleteElements(project, [sibling.target]);
  const deleted = projectIntoDeck(project, d).slides[0];
  eq(JSON.stringify(deleted.beats), still, "canvas deletion retains the normal dangling-track history contract");
  eq(compileSlide(deleted).sample(3).elements.some(e => e.id === sibling.target), false, "dangling birth never resurrects a deleted canvas object");
}

{
  const { d, s, birth, before, later } = fixture();
  const asset = (id: string): Asset => ({ id, name: `${id}.svg`, kind: "svg", path: `assets/${id}.svg`, naturalWidth: 200, naturalHeight: 100 });
  d.assets = [asset("a"), asset("b"), asset("c")];
  s.elements = [{ id: "source", name: "Plot", type: "plot", assetId: "a", source: { svgPath: "plots/a.svg" }, x: 10, y: 20, width: 100, height: 50, rotation: 0, panelLabel: { text: "a" } } as Element];
  before.tracks = [{ id: "morph-before", target: "source", preset: "transform", to: { assetId: "b", svgPath: "plots/b.svg", manifestPath: "plots/b.fluxplot.json" } }];
  const r = ops.addGhostTransform(d, s.id, birth.id, "source", { count: 1 })!;
  const result = s.elements.find(e => e.id === r.elementIds[0])!;
  eq([result.type === "plot" && result.assetId, result.type === "plot" && result.source?.svgPath, result.type === "plot" && result.panelLabel], ["b", "plots/b.svg", undefined], "copy fallback preserves matching effective plot bytes/provenance and drops publication panel identity");
  ops.setTransform(d, s.id, later.id, result.id, { toAssetId: "c", svgPath: "plots/c.svg", state: { x: 200 } });
  eq([...slideAssetIds(s)].sort(), ["a", "b", "c"], "preset dependency collection includes a copy's animation-only destination");
  const snapshot: ops.SlidePresetSnapshot = { fluxPreset: 1, kind: "slide", name: "Portable", savedAt: "fixed", stage: d.stage, slide: structuredClone(s), assets: d.assets.map(a => ({ asset: a, data: `data:image/svg+xml,${a.id}` })) };
  const target = ops.createDeck({ withTitleSlide: false }), inserted = ops.insertSlideSnapshot(target, snapshot), copy = target.slides[0];
  const mapped = inserted.assetRemap;
  eq([...slideAssetIds(copy)].sort(), [...mapped.values()].sort(), "preset insert remaps placed and animation-only asset identities");
  eq(copy.elements.filter(e => e.type === "plot").every(e => !e.source) && copy.beats.flatMap(b => b.tracks).every(t => !t.to?.svgPath), true, "self-contained preset insertion detaches old project source paths");
  const copies = new Set(copy.elements.map(e => e.id));
  eq(copy.beats.flatMap(b => b.tracks).filter(t => t.ghostFrom).every(t => copies.has(t.target) && copies.has(t.ghostFrom!)), true, "portable preset remaps source and result object identities");
  const autoManifest = JSON.parse(readFileSync(new URL("fixtures/pre-regen/06_scatter_regression.fluxplot.json", import.meta.url), "utf8"));
  eq(applyAutoAnimation(d, s.id, result.id, autoManifest) > 0, true, "auto-build fixture actually replaces an existing plot animation");
  eq(s.beats.flatMap(b => b.tracks).some(t => t.id === r.trackIds[0] && t.ghostFrom === "source"), true, "rebuilding plot appearance animation preserves its birth");
  eq(s.beats.every((b, bi) => !b.tracks.some(t => t.target === result.id && !t.ghostFrom) || bi > s.beats.findIndex(b => b.id === birth.id)), true, "generated part entrances start after their result is born");
  s.elements = s.elements.filter(e => e.id !== "source");
  const sources = deckSourceProject(d).figures.flatMap(f => f.elements).filter(e => e.type === "plot");
  eq(sources.some(e => e.assetId === "b" && e.source?.svgPath === "plots/b.svg"), true, "source discovery sees a retained copy after originating object deletion");
  d.assets = [];
  d.externalAssetSizes = { b: { width: 200, height: 100 } };
  reconcileDeckExternalAssetSizes(d, [{ id: "b", naturalWidth: 400, naturalHeight: 100 }]);
  eq(s.elements.find(e => e.id === result.id)?.width, 200, "source refresh rebases an orphan copy's canonical physical size");
  const files = new Map<string, string>([["/fixture/project.json", JSON.stringify({ slides: [{ id: d.id, path: "slides/talk/deck.json" }] })], ["/fixture/fig/index.json", JSON.stringify({ assets: [asset("b")], figures: [], canvases: [] })], ["/fixture/slides/talk/deck.json", JSON.stringify(d)]]);
  const io = { readText: async (p: string) => { const text = files.get(p); if (text == null) throw new Error(p); return text; } };
  const dependencies = await readProjectDependencies("/fixture", io);
  eq(dependencies.complete && dependencies.byAsset.b.some(u => u.kind === "slide"), true, "project asset GC retains a copy's ordinary saved asset dependency");
  const empty: Project = { version: 2, name: "Empty", canvases: [], figures: [], assets: [asset("b")], palette: [] };
  const owners = await figureSourceOwners("/fixture", empty, io);
  eq([...owners.deckAssetIds], ["b"], "retained fig bundle finds its copy as a live source owner");
}

{
  const { d, s, before, birth, later } = fixture();
  const r = ops.addGhostTransform(d, s.id, birth.id, "source", { count: 1 })!;
  const fallback = structuredClone(s.elements.find(e => e.id === r.elementIds[0]));
  const beforeReorder = structuredClone(birth.tracks);
  ops.reorderBeats(d, s.id, [later.id, before.id, birth.id]);
  eq([birth.tracks, s.elements.find(e => e.id === r.elementIds[0])], [beforeReorder, fallback], "step reorder changes timeline order without rewriting birth identity or fallback");
  ops.moveTrackToBeat(d, s.id, r.trackIds[0], later.id);
  eq([ops.findTrack(d, r.trackIds[0])?.beat.id, s.elements.find(e => e.id === r.elementIds[0])], [later.id, fallback], "moving a birth carries its result without recreating it");
  const complete = JSON.stringify(d);
  assert.throws(() => ops.addGhostTransform(d, s.id, later.id, r.elementIds[0], { count: 1, original: "transform", sourceSnapshot: fallback }), /not available/);
  eq(JSON.stringify(d), complete, "an explicit snapshot cannot bypass same-step source availability");
  ops.removeAnimation(d, s.id, later.id, { target: r.elementIds[0] });
  eq(s.elements.some(e => e.id === r.elementIds[0]), false, "legacy remove-animation uses the same owned-result cleanup");
}

for (const version of ["0.2.0", "0.3.0"]) {
  const { d } = fixture(); d.schemaVersion = version;
  const before = structuredClone(d); before.schemaVersion = DECK_SCHEMA_VERSION;
  eq(ops.migrateDeck(d), before, `${version} migration changes only the version stamp`);
  const once = JSON.stringify(d); ops.normalizeDeck(d); ops.normalizeDeck(d);
  eq(JSON.stringify(d), once, `${version} normalization is idempotent with stable identities`);
}
console.log(`GHOST STRUCTURE: PASS (${checks} assertions)`);
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-slide-ghost-structure", ok: true, checks, failed: 0 })}`);
