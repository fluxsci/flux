#!/usr/bin/env -S npx tsx
// Regression: every Track carries a stable id (editor selection / timeline keying
// / reorder depend on it). Assigned at every creation point (setAnimation,
// autobuild), preserved across a replace, and backfilled for legacy decks.
//   npx tsx scripts/verify-slide-trackid.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML, DOMParser } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const slideOps = await import("../src/lib/slide/ops");
const { ensureTrackIds } = slideOps;
const { applyAutoAnimation } = await import("../src/lib/slide/autobuild");
const { cachePlot } = await import("../src/lib/plot/store");

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }
const allTracks = (d: { slides: { beats: { tracks: { id?: string }[] }[] }[] }) =>
  d.slides.flatMap((s) => s.beats).flatMap((b) => b.tracks);

// 1. setAnimation assigns an id to a new track
const deck = slideOps.createDeck({ id: "d", title: "d" });
const sid = slideOps.addSlide(deck, { name: "s", layout: "blank" }).id;
const el = slideOps.addTextBox(deck, sid, { x: 0, y: 0, width: 100, height: 40, blocks: [slideOps.makeBlock("hi")] })!;
const beat = slideOps.addBeat(deck, sid, { label: "b1", advance: "click" })!;
slideOps.setAnimation(deck, sid, beat.id, { target: el, preset: "fade", duration: 300 });
const t1 = slideOps.slideById(deck, sid)!.beats.find((b) => b.id === beat.id)!.tracks[0];
assert(typeof t1.id === "string" && t1.id.length > 0, "setAnimation assigns a stable id to a new track");

// 2. replacing the SAME track (matched by target/part) preserves its id
const origId = t1.id;
slideOps.setAnimation(deck, sid, beat.id, { target: el, preset: "drawOn", duration: 800 });
const t1b = slideOps.slideById(deck, sid)!.beats.find((b) => b.id === beat.id)!.tracks[0];
assert(t1b.id === origId && t1b.preset === "drawOn", "replacing a matched track preserves its id (selection survives edits)");

// 3. autoAnimatePlot tracks all have ids (planToTrack path, bypasses setAnimation)
// Fixture vendored in-repo (was read from the author's now-deleted ~/KDFLUX1).
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pre-regen", "06_scatter_regression");
cachePlot("scatter", await fs.readFile(base + ".svg", "utf8"), JSON.parse(await fs.readFile(base + ".fluxplot.json", "utf8")));
const manifest = JSON.parse(await fs.readFile(base + ".fluxplot.json", "utf8"));
const pid = slideOps.addPlotToSlide(deck, sid, { assetId: "scatter", x: 0, y: 0, width: 800, height: 500 })!;
applyAutoAnimation(deck, sid, pid, manifest);
const auto = allTracks(deck);
assert(auto.length > 5 && auto.every((t) => !!t.id), `every auto-built track has an id (${auto.length} tracks)`);

// 4. ids are unique across the whole deck
const ids = allTracks(deck).map((t) => t.id);
assert(new Set(ids).size === ids.length, "all track ids are unique within the deck");

// 5. ensureTrackIds backfills a legacy deck (tracks authored before Track.id) + idempotent
const legacy = { slides: [{ beats: [{ tracks: [{ target: "x" }, { target: "y" }] }, { tracks: [{ target: "z" }] }] }] };
ensureTrackIds(legacy as never);
const lt = allTracks(legacy as never);
assert(lt.every((t) => !!t.id) && new Set(lt.map((t) => t.id)).size === 3, "ensureTrackIds backfills legacy tracks with unique ids");
const before = lt.map((t) => t.id).join(",");
ensureTrackIds(legacy as never);
assert(allTracks(legacy as never).map((t) => t.id).join(",") === before, "ensureTrackIds is idempotent");

console.log("\nSLIDE TRACK.ID REGRESSION PASSED");
