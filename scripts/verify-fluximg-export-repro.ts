#!/usr/bin/env -S npx tsx
// Review C2 (fluximg stage 2): an image deck's export is a function of the deck alone.
//   A. stills enter the payload in the order they are asked for, whatever order the renderer finishes them in (two
//      gathers whose stills land in opposite orders give the same payload bytes);
//   B. two exports of one deck are byte-identical HTML (clips from the render cache);
//   C. with the clip cache emptied in between, the encoder re-bakes the same bytes for the same input and settings on
//      this machine (with the pinned encoder; BLOCKED without it).
// Run: FLUX_VIDEO_ENCODER=<build/video-encoder/linux-x64/ffmpeg> npx tsx scripts/verify-fluximg-export-repro.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { harness } from "./lib/harness.mjs";
import { makeProject, standardDeck, movieDeck } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-export-repro");
const P = await makeProject();
const { ensureDom } = await import("../flux-core/index");
await ensureDom();
const { nodeSlideImageIO, fluximgRenderSession } = await import("../flux-core/fluximgRender");
const { imageClipEncoder } = await import("../flux-core/fluximgClip");
const { gatherImages } = await import("../src/lib/slide/payloadImages");
const { ensureColormapLuts } = await import("../src/lib/color/colormapLuts");
await ensureColormapLuts();
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex").slice(0, 16);

h.section("A. the payload's stills are in the order they were asked for");
{
  const deck = await standardDeck(P);
  const base = { readText: (p: string) => fs.readFile(p, "utf8"), ...nodeSlideImageIO(P.root, fluximgRenderSession()) };
  /** A renderer whose stills finish in an order of its own: `late(i)` ms after the i-th ask. */
  const gather = async (late: (i: number) => number) => {
    let asked = 0;
    const io = { ...base, imageStill: async (asset: any, request: any) => { const i = asked++; const url = await base.imageStill(asset, request); await new Promise((r) => setTimeout(r, late(i))); return url; } };
    const assets: Record<string, string> = {}, warnings: string[] = [];
    const out = await gatherImages({ root: P.root, deck, figAssets: [], io, assets, warnings, compileOptions: (m) => ({ animStyles: deck.animStyles, fluximgManifest: (id: string) => m.get(id) }) });
    return { keys: Object.keys(assets), bytes: JSON.stringify({ assets, ...out }), asked };
  };
  const first = await gather((i) => i * 15), second = await gather((i) => Math.max(0, 200 - i * 15));
  h.ok(first.asked >= 3, `the deck asks for several stills (${first.asked})`);
  h.eq(second.keys, first.keys, "stills finishing in opposite orders: the same order in the payload");
  h.ok(first.bytes === second.bytes, `the same gathered bytes (${sha(first.bytes)})`);
  // Any finishing order, not only those two: an image's own fields (`texts`, `tables`) used to come out in the order
  // their reads arrived, which only showed under load (the tier run in parallel). Seeded, so a failure reproduces.
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const odd: number[] = [];
  for (let n = 0; n < 16; n++) { const delays = Array.from({ length: 64 }, () => Math.floor(rnd() * 30)); if ((await gather((i) => delays[i % 64])).bytes !== first.bytes) odd.push(n); }
  h.eq(odd, [], "sixteen more finishing orders, drawn at random: the same bytes every time");
}

const encoder = await imageClipEncoder();
const cacheDir = path.join(P.root, "fig/renders/fluximg");
for (const [label, make] of [["standard deck (6 Changes)", standardDeck], ["movie deck (a running movie, a blow-out)", movieDeck]] as const) {
  h.section(`B. two exports of one deck are byte-identical: ${label}`);
  await make(P);
  await fs.rm(cacheDir, { recursive: true, force: true }); // this deck's clips only
  const exportOnce = async (name: string) => {
    const out = await P.slidesCore.exportDeck(P.root, "talk", { refreshSources: false, out: path.join(P.scratch, name) });
    return fs.readFile(out.path ?? path.join(P.scratch, name), "utf8");
  };
  const a = await exportOnce("a.html"), b = await exportOnce("b.html");
  h.ok(a.length > 0 && a === b, `export twice: identical (${(a.length / 1048576).toFixed(2)} MB, ${sha(a)})`);
  if (!encoder) { console.log("BLOCKED (native-encoder: pinned encoder not installed): C. a fresh bake re-encodes the same bytes"); continue; }
  h.ok(a.includes('"imageClips"'), "the export carries baked clips");
  h.section(`C. an emptied clip cache re-bakes the same bytes: ${label}`);
  const before = (await fs.readdir(cacheDir)).filter((f) => f.endsWith(".mp4")).length;
  await fs.rm(cacheDir, { recursive: true, force: true });
  const c = await exportOnce("c.html");
  const after = (await fs.readdir(cacheDir)).filter((f) => f.endsWith(".mp4")).length;
  h.ok(after > 0 && after === before, `the clips were baked again (${after})`);
  h.ok(c === a, `a fresh bake: the same HTML bytes (${sha(c)})`);
}

await fs.rm(P.scratch, { recursive: true, force: true });
await h.done();
