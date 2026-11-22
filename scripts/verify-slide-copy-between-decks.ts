#!/usr/bin/env -S npx tsx
// Slides moved or copied to ANOTHER deck of the project (the filmstrip's right-click "Move to deck… / Copy to deck…",
// owner 2026-11-22). Two halves:
//   1. the pure op `copySlidesInto`: duplicateSlide's remap discipline across decks (fresh ids, tracks retargeted), and
//      everything a slide needs from its own deck comes with it (deck-owned assets under the same id, linked animation
//      and text styles, accepted sizes of project assets, its background) while the source deck is left as it was;
//   2. the native media copier's `intoSavedDeck`: movies and models are added to a SAVED deck, never over a file, and the
//      default (a deck being duplicated: not published yet) keeps refusing a saved destination.
// Run: npx tsx scripts/verify-slide-copy-between-decks.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as ops from "../src/lib/slide/ops";
import type { Deck, Slide } from "../src/lib/slide/types";
import type { Element } from "../src/lib/types";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-slide-copy-between-decks");

// --- a source deck: three slides, the middle one grouped, animated, styled, asset-bearing --------------------------
const source = ops.createDeck({ id: "src", title: "Source", theme: "flux-dark" });
source.slides = [];
const plain = ops.addSlide(source, { name: "Intro" });
const rich = ops.addSlide(source, { name: "Results" });
const tail = ops.addSlide(source, { name: "End" });
rich.elements = [
  { type: "rect", id: "r1", x: 10, y: 10, width: 100, height: 60, rotation: 0, fill: "#4385be", groupId: "g1" },
  { type: "text", id: "t1", x: 10, y: 80, width: 100, height: 20, rotation: 0, text: "hello", fontSize: 12, groupId: "g1", styleId: "ts-body" },
  { type: "image", id: "i1", x: 200, y: 10, width: 120, height: 90, rotation: 0, assetId: "asset-photo" },
  { type: "video", id: "v1", x: 0, y: 0, width: 160, height: 90, rotation: 0, assetId: "asset-clip", posterAssetId: "asset-poster" },
  { type: "plot", id: "p1", x: 300, y: 200, width: 200, height: 120, rotation: 0, assetId: "plot-project", source: { path: "plots/a.svg" } },
] as unknown as Element[];
rich.groups = { g1: { id: "g1", name: "badge" } } as never;
rich.notes = "say this";
rich.beats.push({
  id: "b1", label: "build",
  tracks: [
    { id: "trk1", target: "r1", preset: "fade", styleId: "st-soft" },
    { id: "trk2", target: "i1", preset: "popIn" },
  ],
} as never);
source.assets = [
  { id: "asset-photo", name: "photo.png", kind: "png", path: "assets/asset-photo.png", naturalWidth: 120, naturalHeight: 90 },
  { id: "asset-clip", name: "clip.mp4", kind: "mp4", path: "assets/asset-clip.mp4", naturalWidth: 160, naturalHeight: 90 },
  { id: "asset-poster", name: "clip poster", kind: "png", path: "assets/asset-poster.png", naturalWidth: 160, naturalHeight: 90 },
  { id: "asset-unused", name: "other.png", kind: "png", path: "assets/asset-unused.png", naturalWidth: 10, naturalHeight: 10 },
];
source.externalAssetSizes = { "plot-project": { width: 200, height: 120 } };
source.textStyles = [{ id: "ts-body", name: "Body", fontFamily: "Inter", fontSize: 12, fontWeight: 400, fontStyle: "normal" }];
source.animStyles = [
  { id: "st-soft", name: "Soft", family: "appearance", track: { preset: "fade", duration: 600 } },
  { id: "st-other", name: "Unused", family: "appearance", track: { preset: "fade", duration: 100 } },
] as never;
const sourceBefore = JSON.stringify(source);

const target = ops.createDeck({ id: "tgt", title: "Target", theme: "flux-light" });
target.slides = [];
ops.addSlide(target, { name: "First" });
ops.addSlide(target, { name: "Results" });   // the same name as the slide that arrives
target.animStyles = [{ id: "st-here", name: "Soft", family: "appearance", track: { preset: "fade", duration: 900 } }] as never;

h.section("copySlidesInto: what arrives");
// asked for out of order: they arrive in the SOURCE's order
const res = ops.copySlidesInto(target, source, [tail.id, rich.id]);
h.eq(JSON.stringify(source), sourceBefore, "the source deck is not changed");
h.eq(res.slideIds.length, 2, "two slides copied");
h.eq(target.slides.map((s) => s.name).join(" | "), "First | Results | Results_a | End", "appended in the source's order; a name the target already uses gets the next suffix");
const copy = ops.slideById(target, res.slideIds[0])! as Slide;
h.ok(copy.id !== rich.id && !source.slides.some((s) => s.id === copy.id), "the slide's id is fresh");
h.eq(copy.elements.length, 5, "every element arrives");
h.ok(copy.elements.every((e) => !["r1", "t1", "i1", "v1", "p1"].includes(e.id)), "element ids are fresh");
const gids = new Set(copy.elements.flatMap((e) => (e.groupId ? [e.groupId] : [])));
h.ok(gids.size === 1 && !gids.has("g1") && !!copy.groups && Object.keys(copy.groups).every((g) => gids.has(g)), "the group travels under a fresh id, its two members still together");
h.eq(copy.notes, "say this", "speaker notes travel");
const build = copy.beats[1];
h.ok(build.id !== "b1" && build.tracks.every((t) => t.id !== "trk1" && t.id !== "trk2"), "step and effect ids are fresh");
const idOf = (type: string) => copy.elements.find((e) => e.type === type)!.id;
h.eq(build.tracks[0].target, idOf("rect"), "the first effect targets the copied rectangle");
h.eq(build.tracks[1].target, idOf("image"), "the second effect targets the copied picture");

h.section("copySlidesInto: what a slide needs from its deck");
h.eq(res.assets.map((a) => a.id).sort().join(","), "asset-clip,asset-photo,asset-poster", "the deck-owned assets the slides show are returned for their files to be copied (the unused one is not)");
h.ok(res.assets.every((a) => target.assets.some((t) => t.id === a.id && t.path === a.path)), "they joined the target under the SAME id and path");
h.ok(!target.assets.some((a) => a.id === "plot-project"), "a project-owned plot is not made a deck asset");
const plot = copy.elements.find((e) => e.type === "plot") as unknown as { assetId: string; source?: { path: string } };
h.ok(plot.assetId === "plot-project" && plot.source?.path === "plots/a.svg", "the plot keeps its asset and its link to the project file");
h.eq(JSON.stringify(target.externalAssetSizes), JSON.stringify({ "plot-project": { width: 200, height: 120 } }), "the plot's accepted size comes along");
h.eq(build.tracks[0].styleId, "st-here", "a linked animation style is matched to the target's style of the same name and family");
h.eq(target.animStyles!.length, 1, "so no second copy of it is added, and an unused style does not travel");
h.ok(!!target.textStyles?.some((t) => t.id === "ts-body" && t.name === "Body"), "the text style the slide's text links comes along, under its id");
h.eq((copy.elements.find((e) => e.type === "text") as unknown as { styleId: string }).styleId, "ts-body", "and the text still links it");
h.ok(typeof copy.background === "string" && copy.background !== ops.createDeck({ theme: "flux-light" }).background, "a slide that followed its deck's background keeps that look in a deck whose default differs");

h.section("copySlidesInto: again, and elsewhere");
const again = ops.copySlidesInto(target, source, [rich.id], { at: 0 });
h.eq(again.assets.length, 0, "a second copy brings no asset the target already holds");
h.eq(target.slides[0].id, again.slideIds[0], "`at` places the copy");
h.eq(target.slides[0].name, "Results_b", "and the name series continues");
h.eq(target.animStyles!.length, 1, "the style is still matched, not added again");
const sameLook = ops.createDeck({ id: "same", title: "Same look", theme: "flux-dark" });
const kept = ops.copySlidesInto(sameLook, source, [plain.id]);
h.eq(ops.slideById(sameLook, kept.slideIds[0])!.background, undefined, "where the target's default background is the same, the slide keeps following its deck");
h.eq(ops.slideById(sameLook, kept.slideIds[0])!.name, "Intro", "a free name is kept as it is");
const fresh = ops.createDeck({ id: "fresh", title: "No styles" });
ops.copySlidesInto(fresh, source, [rich.id]);
const added = fresh.animStyles ?? [];
h.ok(added.length === 1 && added[0].name === "Soft" && added[0].id !== "st-soft", "a deck without the style gets it, under a fresh id");
h.eq(ops.slideById(fresh, fresh.slides.at(-1)!.id)!.beats[1].tracks[0].styleId, added[0]?.id, "and the copied effect links that one");
h.eq(ops.copySlidesInto(fresh, source, ["no-such-slide"]).slideIds.length, 0, "an id that is not in the source copies nothing");

// duplicateSlide shares the clone: its contract is unchanged
h.section("duplicateSlide (same clone)");
const dupDeck: Deck = structuredClone(source);
const dupId = ops.duplicateSlide(dupDeck, rich.id)!;
const dup = ops.slideById(dupDeck, dupId)!;
h.eq(dupDeck.slides.map((s) => s.name).join(" | "), "Intro | Results | Results_a | End", "the duplicate sits after its source, named with the next suffix");
h.ok(dup.elements.every((e) => !["r1", "t1", "i1", "v1", "p1"].includes(e.id)) && dup.beats[1].tracks[0].target === dup.elements.find((e) => e.type === "rect")!.id, "fresh ids, effects retargeted");
h.eq(dup.beats[1].tracks[0].styleId, "st-soft", "inside one deck the style link is the same style");
h.eq(dup.background, undefined, "and nothing is written onto the slide");

// --- the native copier: adding media to a saved deck -------------------------------------------------------------
h.section("native media copy into a saved deck");
const require = createRequire(import.meta.url);
const copyVideoAssets: (request: Record<string, unknown>) => Promise<void> = require("../electron/videoMedia.cjs").copyVideoAssets;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-copy-"));
try {
  const dir = (deck: string) => path.join(root, "slides", deck, "assets");
  for (const deck of ["from", "saved", "unsaved"]) await fs.mkdir(dir(deck), { recursive: true });
  await fs.writeFile(path.join(dir("from"), "clip.mp4"), "movie bytes");
  await fs.writeFile(path.join(dir("from"), "poster.png"), "poster bytes");
  await fs.writeFile(path.join(root, "slides", "saved", "deck.json"), "{}");
  await fs.writeFile(path.join(dir("saved"), "poster.png"), "the saved deck's own poster");
  const request = { root, sourceDeckId: "from", paths: ["assets/clip.mp4", "assets/poster.png"] };
  const refusal = async (run: () => Promise<void>) => run().then(() => "", (e: Error) => e.message);

  h.ok(/already a saved deck/.test(await refusal(() => copyVideoAssets({ ...request, deckId: "saved" }))), "without the option a saved deck is refused, as before (a duplicate fills an unpublished deck)");
  h.ok(/not a saved deck/.test(await refusal(() => copyVideoAssets({ ...request, deckId: "unsaved", intoSavedDeck: true }))), "with the option an unpublished deck is refused");
  await copyVideoAssets({ ...request, deckId: "saved", intoSavedDeck: true });
  h.eq(await fs.readFile(path.join(dir("saved"), "clip.mp4"), "utf8"), "movie bytes", "with the option the movie is added to the saved deck");
  h.eq(await fs.readFile(path.join(dir("saved"), "poster.png"), "utf8"), "the saved deck's own poster", "a file the deck already holds is left as it is");
  h.eq((await fs.readdir(dir("saved"))).sort().join(","), "clip.mp4,poster.png", "and no scratch file is left behind");
  await copyVideoAssets({ ...request, deckId: "saved", intoSavedDeck: true });
  h.eq(await fs.readFile(path.join(dir("saved"), "clip.mp4"), "utf8"), "movie bytes", "copying the same slides again is harmless");
  h.ok(/Invalid/.test(await refusal(() => copyVideoAssets({ ...request, deckId: "saved", intoSavedDeck: true, paths: ["assets/../../outside.mp4"] }))), "a path outside the deck's assets is refused either way");
  await copyVideoAssets({ ...request, deckId: "unsaved" });
  h.eq((await fs.readdir(dir("unsaved"))).sort().join(","), "clip.mp4,poster.png", "the duplicate path still fills an unpublished deck");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

await h.done();
