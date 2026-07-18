#!/usr/bin/env -S npx tsx
// Slide presets (machine-global, <FluxConfig>/presets/slides) — the pure half:
// `insertSlideSnapshot` must obey duplicateSlide's remap discipline (fresh
// element/group/beat/track ids, tracks retargeted at the clones), remap
// embedded-asset ids that would collide-or-dangle while REUSING ids the deck
// already owns, and honor the insertion index. Plus the 2026-07-18 theme
// contract: flux-light is PURE WHITE, flux-paper carries the Flexoki-paper
// look, and the flux-core theme enum stays in lockstep with BUILTIN_THEMES
// (twin-engine consistency).
// Run: npx tsx scripts/verify-slide-presets.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/lib/slide/ops";
import type { SlidePresetSnapshot } from "../src/lib/slide/ops";
import { BUILTIN_THEMES } from "../src/lib/slide/theme";
import type { RectElement, TextElement } from "../src/lib/types";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-slide-presets");

// flux-core's theme enum, read from SOURCE (importing flux-core/verbs here
// trips its registry's import cycle under tsx — this is a shape check anyway).
const verbsSrc = readFileSync(join(import.meta.dirname, "..", "flux-core", "verbs.ts"), "utf8");
const SLIDE_THEMES: string[] = JSON.parse(
  (verbsSrc.match(/export const SLIDE_THEMES = (\[[^\]]*\])/)?.[1] ?? "[]").replace(/'/g, '"').replace(/,\s*\]/, "]"),
);

// --- themes: the lockstep + the owner's 2026-07-18 palette decision -----------
h.section("themes");
h.eq(BUILTIN_THEMES["flux-light"]?.background, "#ffffff", "flux-light background is pure white");
h.eq(BUILTIN_THEMES["flux-paper"]?.background, "#fffcf0", "flux-paper background is Flexoki paper");
h.eq(BUILTIN_THEMES["flux-paper"]?.surface, "#f2f0e5", "flux-paper surface is Flexoki base-50");
h.eq([...SLIDE_THEMES].sort().join(","), Object.keys(BUILTIN_THEMES).sort().join(","),
  "flux-core SLIDE_THEMES enum matches the renderer's BUILTIN_THEMES (twin-engine lockstep)");

// --- a donor deck with a grouped, animated, asset-bearing slide ---------------
h.section("insertSlideSnapshot");
const donor = ops.createDeck({ id: "donor", title: "Donor" });
const donorSid = ops.addSlide(donor, { name: "Fancy" }).id;
const donorSlide = ops.slideById(donor, donorSid)!;
const rect: RectElement = {
  type: "rect", id: "r1", x: 10, y: 10, width: 100, height: 60, rotation: 0,
  fill: "#4385be", groupId: "g1",
} as RectElement;
const label: TextElement = {
  type: "text", id: "t1", x: 10, y: 80, width: 100, height: 20, rotation: 0,
  text: "hello", fontSize: 12, groupId: "g1",
} as TextElement;
const pic = {
  type: "image", id: "i1", x: 200, y: 10, width: 120, height: 90, rotation: 0,
  assetId: "asset-emb",
} as unknown as RectElement; // image shape, loosely typed for the fixture
donorSlide.elements = [rect, label, pic];
donorSlide.groups = { g1: { id: "g1", name: "badge" } } as never;
donorSlide.background = "#123456";
donorSlide.beats.push({
  id: "b1", label: "build",
  tracks: [
    { id: "trk1", target: "r1", preset: "fade" },
    { id: "trk2", target: "i1", preset: "popIn" },
  ],
} as never);

const snap: SlidePresetSnapshot = {
  fluxPreset: 1, kind: "slide", name: "badge-slide", savedAt: "2026-07-18T00:00:00Z",
  stage: { width: 640, height: 360 },
  thumbBackground: "#123456",
  slide: structuredClone(donorSlide),
  assets: [
    { asset: { id: "asset-emb", name: "p.png", kind: "png", path: "assets/asset-emb.png", naturalWidth: 120, naturalHeight: 90 }, data: "data:image/png;base64,AAAA" },
  ],
};

// --- insert into a foreign deck: everything fresh, everything retargeted ------
const target = ops.createDeck({ id: "tgt", title: "Target" });
const s0 = ops.addSlide(target, { name: "First" }).id;
const s1 = ops.addSlide(target, { name: "Last" }).id;
const res = ops.insertSlideSnapshot(target, structuredClone(snap), { at: 1 });
const inserted = ops.slideById(target, res.slideId)!;

h.eq(target.slides.map((s) => s.id).indexOf(res.slideId), 1, "inserted at the requested index (between the two)");
h.eq(inserted.name, "badge-slide", "slide takes the preset's name");
h.eq(inserted.background, "#123456", "explicit background travels");
h.eq(inserted.elements.length, 3, "all elements inserted");
h.ok(inserted.elements.every((e) => !["r1", "t1", "i1"].includes(e.id)), "element ids are FRESH");
h.ok(inserted.id !== snap.slide.id, "slide id is fresh");
const gids = new Set(inserted.elements.flatMap((e) => (e.groupId ? [e.groupId] : [])));
h.eq(gids.size, 1, "grouped pair still shares ONE group");
h.ok(!gids.has("g1") && inserted.groups && Object.keys(inserted.groups).every((g) => g !== "g1"), "group identity remapped");
h.eq(inserted.beats.length, 2, "beats travel (resting + build)");
const build = inserted.beats[1];
h.ok(build.id !== "b1" && build.tracks.every((t) => t.id !== "trk1" && t.id !== "trk2"), "beat/track ids are fresh");
const byType = new Map(inserted.elements.map((e) => [e.type, e.id]));
h.eq(build.tracks[0].target, byType.get("rect"), "track 1 retargeted at the cloned rect");
h.eq(build.tracks[1].target, byType.get("image"), "track 2 retargeted at the cloned image");

// embedded asset: foreign deck → fresh id + deck.assets row + element remap
h.eq(res.assetRemap.size, 1, "one embedded asset needed a fresh id");
const newAid = res.assetRemap.get("asset-emb")!;
h.ok(!!newAid && newAid !== "asset-emb", "embedded asset id is fresh");
h.ok(target.assets.some((a) => a.id === newAid && a.path === `assets/${newAid}.png`), "fresh asset row joined deck.assets under its id-derived path");
const insertedPic = inserted.elements.find((e) => e.type === "image") as unknown as { assetId: string };
h.eq(insertedPic.assetId, newAid, "image element remapped to the fresh asset id");

// --- insert into a deck that ALREADY owns the asset id: reuse, no dup ---------
const home = ops.createDeck({ id: "home", title: "Home" });
ops.addSlide(home, { name: "S" });
home.assets.push({ id: "asset-emb", name: "p.png", kind: "png", path: "assets/asset-emb.png", naturalWidth: 120, naturalHeight: 90 });
const res2 = ops.insertSlideSnapshot(home, structuredClone(snap), {});
h.eq(res2.assetRemap.size, 0, "asset id already owned by the deck → reused, no remap");
h.eq(home.assets.length, 1, "no duplicate deck.assets row");
const homePic = ops.slideById(home, res2.slideId)!.elements.find((e) => e.type === "image") as unknown as { assetId: string };
h.eq(homePic.assetId, "asset-emb", "element keeps the reusable asset id");
h.eq(home.slides.map((s) => s.id).indexOf(res2.slideId), home.slides.length - 1, "no index → appended at the end");

// --- degenerate snapshot: no beats → a resting beat is synthesized ------------
const bare = structuredClone(snap);
bare.slide.beats = [];
const res3 = ops.insertSlideSnapshot(target, bare, {});
const bareSlide = ops.slideById(target, res3.slideId)!;
h.eq(bareSlide.beats.length, 1, "beat-less snapshot gets a synthesized resting beat");
h.eq(bareSlide.beats[0].tracks.length, 0, "synthesized resting beat is empty");

// the donor snapshot object was never mutated by inserts (defensive clones)
h.eq(snap.slide.elements[0].id, "r1", "snapshot input stays unmutated");

void s0; void s1;
await h.done();
