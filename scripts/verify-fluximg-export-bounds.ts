#!/usr/bin/env -S npx tsx
// Review C3 (fluximg stage 2): what bounds an image deck's export.
//   A. the clip cache's prune plan (fluximgClip.planImageClipPrune): the sibling caches' rule, 14 days unused, then
//      least recently used down to the byte cap; the current export's clips never go;
//   B. an export that bakes prunes the project's clip cache by that rule; a hit refreshes a clip's use time;
//   C. ONE size warning per export, in plain words, with an image movie's own levers (never "shorter source clips").
// Run: FLUX_VIDEO_ENCODER=<build/video-encoder/linux-x64/ffmpeg> npx tsx scripts/verify-fluximg-export-bounds.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { harness } from "./lib/harness.mjs";
import { makeProject, standardDeck } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-export-bounds");
const { planImageClipPrune, IMAGE_CLIP_CACHE_LIMITS, imageClipEncoder } = await import("../flux-core/fluximgClip");
const { exportSizeWarning, exportDeckHtml } = await import("../src/lib/slide/export/exportDeck");
const DAY = 86400_000, NOW = 1_800_000_000_000;
const name = (i: number) => `fxc-${i.toString(16).padStart(16, "0")}.mp4`;

h.section("A. the prune plan");
{
  h.eq(IMAGE_CLIP_CACHE_LIMITS, { maxBytes: 1024 ** 3, olderThanDays: 14 }, "limits: 14 days unused, 1 GiB (the 3D poster caches' rule)");
  const entries = [
    { name: name(1), size: 10, mtimeMs: NOW - 20 * DAY },   // stale
    { name: name(2), size: 10, mtimeMs: NOW - 20 * DAY },   // stale but used by this export
    { name: name(3), size: 10, mtimeMs: NOW - 1 * DAY },
    { name: "fxc-not-a-clip.mp4", size: 10, mtimeMs: NOW - 99 * DAY },
    { name: "notes.txt", size: 10, mtimeMs: NOW - 99 * DAY },
  ];
  h.eq(planImageClipPrune(entries, new Set([name(2).slice(0, -4)]), NOW), [name(1)], "age: an unused stale clip goes; a used one and every other file stay");
  const lru = [0, 1, 2, 3, 4].map((i) => ({ name: name(10 + i), size: 100, mtimeMs: NOW - (5 - i) * 3600_000 }));
  h.eq(planImageClipPrune(lru, new Set([name(10).slice(0, -4)]), NOW, { maxBytes: 250, olderThanDays: 14 }), [name(11), name(12), name(13)], "cap: least recently used first down to the cap; the protected oldest stays");
  h.eq(planImageClipPrune(lru, new Set(), NOW, { maxBytes: 10_000, olderThanDays: 14 }), [], "under the cap and fresh: nothing goes");
}

const P = await makeProject();
const { ensureDom } = await import("../flux-core/index");
await ensureDom();
const encoder = await imageClipEncoder();
const cacheDir = path.join(P.root, "fig/renders/fluximg");
await standardDeck(P);
h.section("B. an export that bakes prunes the clip cache; a hit refreshes its clip");
if (!encoder) console.log("BLOCKED (native-encoder: pinned encoder not installed): B");
else {
  await fs.mkdir(cacheDir, { recursive: true });
  const stale = path.join(cacheDir, name(0xdead)), other = path.join(cacheDir, "keep-me.txt");
  await fs.writeFile(stale, "x"); await fs.writeFile(other, "x");
  const old = new Date(Date.now() - 30 * DAY);
  await fs.utimes(stale, old, old); await fs.utimes(other, old, old);
  const out = await P.slidesCore.exportDeck(P.root, "talk", { refreshSources: false, out: path.join(P.scratch, "a.html") });
  const clips = (await fs.readdir(cacheDir)).filter((f) => /^fxc-[\da-f]{16}\.mp4$/.test(f));
  h.ok(out.bytes > 0 && clips.length >= 1, `the export baked its clips (${clips.length})`);
  h.ok(!clips.includes(name(0xdead)), "a clip unused for 30 days was pruned by the export that baked");
  h.ok(await fs.stat(other).then(() => true, () => false), "a file that is not a clip is never touched");
  const one = path.join(cacheDir, clips[0]);
  await fs.utimes(one, old, old);
  await P.slidesCore.exportDeck(P.root, "talk", { refreshSources: false, out: path.join(P.scratch, "b.html") });
  const st = await fs.stat(one);
  h.ok(st.mtimeMs > Date.now() - DAY, "a cache hit refreshes the clip's use time (it is not pruned while in use)");
}

h.section("C. one size warning, with an image movie's own levers");
{
  const clip = (mb: number) => ({ url: `data:video/mp4;base64,${"A".repeat(Math.round((mb * 1048576 * 4) / 3))}`, fps: 60, frames: 60, durationMs: 1000, width: 64, height: 64 });
  const w = exportSizeWarning({ deck: {} as never, imageClips: { a: clip(30), b: clip(3) } } as never, 34 * 1048576, 25 * 1048576);
  h.ok(/image movies 33\.0 MB/.test(w) && /shorter range or at a higher speed/.test(w) && /smaller/.test(w) && /crop/.test(w), `image movies: their own levers ("${w}")`);
  h.ok(!/source clips/.test(w), "never \"shorter source clips\" for an image");
  const mixed = exportSizeWarning({ deck: {} as never, imageClips: { a: clip(4) }, videos: { v: clip(20).url } } as never, 30 * 1048576, 25 * 1048576);
  h.ok(mixed.indexOf("video clips") < mixed.indexOf("image movies") && /shorter clips/.test(mixed), "a deck with both: the bigger first, each with its levers, in ONE warning");
  h.eq(exportSizeWarning({ deck: {} as never } as never, 1000, 25 * 1048576), "", "under the threshold: no warning");
  const { payload } = await P.slidesCore.gatherDeckPayload(P.root, "talk", undefined, { refreshSources: false });
  const r = await exportDeckHtml(payload, { warnThreshold: 1 });
  const size = r.warnings.filter((x: string) => /exported file is/i.test(x));
  h.eq(size.length, 1, `the fixture over a 1-byte threshold: exactly one size warning ("${size[0] ?? ""}")`);
}

await fs.rm(P.scratch, { recursive: true, force: true });
await h.done();
