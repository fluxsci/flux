// fluximg stage 2, W7: a deck holding N-dimensional images LEAVES the editor (pure tier).
//
// An exported or captured document cannot run the image decoder (its CSP has no workers, WASM or fetch), so a deck
// carries, per image, a trimmed manifest + the layer texts and tables its overlay draws + the still of every evaluated
// step state, and per Change that moves pixels one MP4 clip baked in Node (flux-core/fluximgClip.ts) from the plan
// `fluximg/clipPlan.ts` defines. This gate pins, over a synthetic project (scripts/lib/fluximgSlideExportFixture.ts):
//   A. the payload: what it carries and what it never does (bundle bytes, absolute paths, private fields, statistics);
//   B. the stills: each step's still equals `renderStill` of that step's evaluated state; the static poster shows it;
//   C. the clip planner: the rate rule, every plane for its share, repeats, even sizes, seek times;
//   D. the baked clips (needs the encoder): decoded frames against the reference frames within the measured bound,
//      the RIGHT plane at every frame, first / last frame against the pre / end stills, repeats never re-rendered;
//   E. the cache: a second export bakes nothing, any change of what the key names misses;
//   F. cancel leaves no partial file;  G. no encoder: stills and ONE warning, never a failed export;
//   H. a deck without images gathers and exports nothing new;  I. the exported runtimes' import graph and sizes;
//   J. PDF (steps) and PowerPoint: the page of step k carries the still of step k, and the note;
//   K. Paper: ordinary image warnings never trip the portable refusal, a missing bundle does;
//   L. headless: export-deck executes over an image deck; the contact sheet renders it;
//   M. running movies (plan D7): one clip per look a movie runs with (a single pass; bounce there-and-back; looped
//      natively), its frames the planes the pure clock shows; a pixel Change under a running movie warns naming its
//      step and bakes no clip of its own; static documents note the movie and show the state's own plane.
// The clip checks report themselves BLOCKED (native-encoder) when the pinned encoder is not installed; the no-encoder
// fallback is tested by pointing FLUX_VIDEO_ENCODER at nothing.
//
// Run: npx tsx scripts/verify-fluximg-slide-export.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { unzipSync, strFromU8 } from "fflate";
import { Resvg } from "@resvg/resvg-js";
import { harness } from "./lib/harness.mjs";
import { makeProject, standardDeck, movieDeck, MOVIE, V0, V1, V2 } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-slide-export");
execFileSync(process.execPath, ["scripts/gen-slide-embed-assets.mjs"], { stdio: "pipe" });
const P = await makeProject();
const { ensureDom } = await import("../flux-core/index");
await ensureDom();
const { bakeImageClip, imageClipEncoder, IMAGE_CLIP_SETTINGS } = await import("../flux-core/fluximgClip");
const { fluximgReader, fluximgRenderSession, resolveFluximgLut, nodeSlideImageIO } = await import("../flux-core/fluximgRender");
const { decodePng } = await import("../flux-core/fluximgPng");
const { renderStill } = await import("../src/lib/fluximg/still");
const { resolveView } = await import("../src/lib/fluximg/viewOps");
const { planViewTween } = await import("../src/lib/fluximg/viewTween");
const { furnitureSvg } = await import("../src/lib/fluximg/furniture");
const CP = await import("../src/lib/fluximg/clipPlan");
const { fluximgStillRequest } = await import("../src/lib/fluximg/exportStatic");
const { fluximgResolvedAsset } = await import("../src/lib/fluximg/place");
const { ensureColormapLuts } = await import("../src/lib/color/colormapLuts");
const { compileSlide } = await import("../src/lib/slide/compile");
const { imageStillRef, IMAGE_NO_ENCODER_NOTE, IMAGE_STILL_NOTE, slideImageChanges } = await import("../src/lib/slide/imageExport");
const { renderSlidePosterSvg } = await import("../src/lib/slide/embedRender");
const { exportDeckHtml, computeExportAssets } = await import("../src/lib/slide/export/exportDeck");
const { deckPdfDocument } = await import("../src/lib/slide/export/deckPdf");
const { deckPptxBytes } = await import("../src/lib/slide/export/deckPptx");
const { gatherSlidePayload } = await import("../src/lib/slide/payload");
const { createSlideRepository } = await import("../src/lib/slide/embedRepository");
await ensureColormapLuts();

const assetId: string = P.placed.assetId;
const bundleDir = path.join(P.root, "fig/assets", `${assetId}.fluximg`);
const fullManifest = JSON.parse(await fs.readFile(path.join(bundleDir, "fluximg.json"), "utf8"));
const asset = fluximgResolvedAsset(assetId, fullManifest);
const session = fluximgRenderSession();
const reader = await fluximgReader(P.root, asset, session);
const encoder = await imageClipEncoder();
const blocked = (what: string) => console.log(`BLOCKED (native-encoder: pinned encoder not installed; npm run fetch:video-encoder): ${what}`);
const cacheDir = path.join(P.root, "fig/renders/fluximg");
const listCache = async () => (await fs.readdir(cacheDir).catch(() => [] as string[])).sort();
const draw = async (p: { view: any; crop: any }, w: number, h2: number) => (await renderStill(reader, { view: CP.tweenPictureView(p.view), crop: p.crop, outWidth: w, outHeight: h2 }, { resolveLut: resolveFluximgLut })).rgba;
/** The CPU reference of a clip frame (the same law the GL surface and W2's gate use), over the matte. */
async function reference(f: any, w: number, h2: number, matte: string): Promise<Uint8ClampedArray> {
  const L = CP.frameLayers(f);
  const one = async (a: any, b: any) => (b ? CP.mixRgba(await draw(a, w, h2), await draw(b, w, h2), L.mix) : await draw(a, w, h2));
  let rgba = await one(L.a, L.b);
  if (L.there) rgba = CP.mixRgba(rgba, await one(L.there.a, L.there.b), L.weight);
  return CP.matteRgba(rgba.slice(), matte);
}
function diff(rgb: Uint8Array, rgba: Uint8ClampedArray): { max: number; mean: number } {
  let max = 0, sum = 0;
  for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) for (let k = 0; k < 3; k++) { const e = Math.abs(rgb[p + k] - rgba[q + k]); if (e > max) max = e; sum += e; }
  return { max, mean: sum / rgb.length };
}
function decodeClip(file: string, w: number, h2: number): Uint8Array[] {
  const out = spawnSync(encoder!.path, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(out.stderr.toString());
  const fb = w * h2 * 3, frames: Uint8Array[] = [];
  for (let i = 0; i + fb <= out.stdout.length; i += fb) frames.push(out.stdout.subarray(i, i + fb));
  return frames;
}
/** Decoded clips against the reference: the bound measured for the chosen settings (CRF 15, 4:2:0, BT.709 limited).
 *  The max is 4:2:0 chroma at one-pixel colour edges of this deliberately harsh synthetic image. */
const BOUND = { mean: 2.0, max: 128 };

try {
  const deck = await standardDeck(P);
  const slide = deck.slides[0];
  const el = slide.elements.find((e: any) => e.type === "fluximg") as any;

  // ------------------------------------------------------------------------------------------------------------------
  h.section("A. the payload carries what the exported player reads, and nothing private");
  const t0 = performance.now();
  const { payload, warnings } = await P.slidesCore.gatherDeckPayload(P.root, "talk", undefined, { refreshSources: false });
  const coldMs = performance.now() - t0;
  h.eq(warnings.filter((w: string) => !/encoder/.test(w)), [], "an image deck gathers without warnings");
  const image = payload.images?.[assetId];
  h.ok(!!image && Object.keys(payload.images!).length === 1, "payload.images holds the one image, by asset id");
  const m = image!.manifest;
  h.ok(m.channels.every((c: any) => c.stats.hist.counts.length === 0) && !("provenance" in m) && !("profiles" in m) && !("world" in m) && m.regions.length === 0, "the manifest is trimmed: no histograms, provenance, profiles, world matrix or regions");
  h.ok(m.channels.every((c: any, i: number) => JSON.stringify(c.stats.percentiles) === JSON.stringify(fullManifest.channels[i].stats.percentiles) && c.stats.min === fullManifest.channels[i].stats.min), "it keeps the statistics' scalars (default windows)");
  const views = [V0, V1, V2, slideImageChanges(compileSlide(slide, deck.stage, {})).at(-1)!.end.view];
  h.ok(views.every((v) => JSON.stringify(resolveView(m, v as any)) === JSON.stringify(resolveView(fullManifest, v as any))), "every step's view resolves identically on the trimmed manifest");
  const crop = { x: 0, y: 0, width: 64, height: 48 };
  h.ok(views.every((v) => furnitureSvg(m, resolveView(m, v as any), crop, { width: 320, height: 240 }, "p-") === furnitureSvg(fullManifest, resolveView(fullManifest, v as any), crop, { width: 320, height: 240 }, "p-")), "the furniture draws identically from it");
  const cellsLayer = fullManifest.layers.find((l: any) => l.id === "cells"), marksLayer = fullManifest.layers.find((l: any) => l.id === "marks");
  h.ok(!!image!.texts?.[cellsLayer.outlines] && !!image!.texts?.[marksLayer.path], "the shown layers' SVG texts ride along (outlines, vectors)");
  h.ok(!!image!.tables?.[cellsLayer.table] && !image!.tables?.[marksLayer.table ?? "-"], "the table a styled layer needs rides along, and no other");
  const json = JSON.stringify(payload);
  h.ok(!json.includes(P.root) && !json.includes(P.scratch) && !json.includes("plots/movie.fluximg") && !json.includes("bundlePath") && !json.includes("sourcePath"), "no absolute path, no bundle path, no source record after portablePayload");
  h.ok(Object.entries(payload.assets ?? {}).every(([k, v]) => k.startsWith("fluximg:") && (v as string).startsWith("data:image/png;base64,")), "the only assets are image stills (PNG data URLs under fluximg: keys)");
  h.ok(!json.includes("zarr.json") && !/"c\/0/.test(json), "no bundle file is read as bytes (no zarr metadata, no chunk paths)");
  h.ok(Object.values(payload.imageClips ?? {}).every((c: any) => c.url.startsWith("data:video/mp4;base64,")), "portable clips are inline MP4 data URLs");

  // ------------------------------------------------------------------------------------------------------------------
  h.section("B. a still per evaluated step state, equal to renderStill of that state");
  const compiled = compileSlide(slide, deck.stage, {});
  const stillOfStep: string[] = [];
  let exact = 0;
  for (let step = 0; step < slide.beats.length; step++) {
    const e = compiled.sample(step).elements.find((x: any) => x.id === el.id) as any;
    const request = fluximgStillRequest(e, asset, fullManifest, 2);
    const href = payload.assets?.[imageStillRef(assetId, request.key)];
    stillOfStep.push(href ?? "");
    if (!href) continue;
    const png = decodePng(Buffer.from(href.slice(href.indexOf(",") + 1), "base64"));
    const ref = await renderStill(reader, { view: request.view, crop: request.crop, outWidth: request.outWidth, outHeight: request.outHeight }, { resolveLut: resolveFluximgLut });
    if (png.width === ref.width && png.height === ref.height && Buffer.compare(Buffer.from(png.rgba), Buffer.from(ref.rgba)) === 0) exact++;
  }
  h.eq(exact, slide.beats.length, `each of the ${slide.beats.length} steps has its still, byte-equal to renderStill of the step's evaluated state`);
  h.ok(stillOfStep[4] === stillOfStep[3] && Object.keys(payload.assets ?? {}).length === new Set(stillOfStep).size, `identical pictures are one still (dedupe by pixel key and size): ${new Set(stillOfStep).size} stills for ${slide.beats.length} steps`);
  for (const step of [0, 1, 2, 3]) {
    const svg = renderSlidePosterSvg(payload, step);
    h.ok(svg.includes(stillOfStep[step]) && /data-layer="cells"/.test(svg), `the static poster of step ${step} shows step ${step}'s still with the vector layer as vectors`);
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("C. the clip planner");
  const plan = (pre: any, end: any, blend = false) => planViewTween(m, pre, end, { blend });
  const lin = (r: number) => r;
  {
    const p = CP.planImageClip(m, plan({ view: V0 }, { view: V1 }), lin, 1000, 640, 480);
    h.ok(p.fps === 20 && p.frames.length === 21 && p.distinct === 21 && p.frames.every((f, i) => f.frame.a.view.index.t === i), "a linear walk of 20 planes in 1 s bakes at 20 fps: 21 frames, frame k = plane k");
    const p2 = CP.planImageClip(m, plan({ view: V0 }, { view: V1 }), lin, 2000, 640, 480);
    h.ok(p2.fps === 10 && p2.frames.length === 21, "the same walk in 2 s: 10 fps, 21 frames (never 120)");
    const p3 = CP.planImageClip(m, plan({ view: V0 }, { view: { ...V0, index: { t: 4 } } }), lin, 1000, 640, 480);
    h.ok(p3.fps === 4 && p3.frames.length === 5, "4 planes in 1 s: 4 fps, 5 frames");
    const eased = CP.planImageClip(m, plan({ view: V0 }, { view: { ...V0, index: { t: 4 } } }), (r) => r * r, 1000, 640, 480);
    h.ok(eased.fps === 60 && eased.frames.length === 61 && eased.distinct === 5, "an eased walk needs 60 fps (its planes do not fall on a coarser grid); 5 distinct pictures");
    const glide = CP.planImageClip(m, plan({ view: V1 }, { view: V2 }), lin, 1000, 640, 480);
    h.ok(glide.fps === 60 && glide.frames.length === 61 && glide.distinct === 61, "a contrast glide: 60 fps, every frame new");
    const odd = CP.planImageClip(m, plan({ view: V0 }, { view: V1 }), lin, 1050, 640, 480);
    h.ok(odd.frames.at(-1)!.raw === 1 && odd.frames.at(-1)!.frame.a.view.index.t === 20, "an odd duration still ends on the end picture");
    // every plane for its full share: at every 1/60 s tick, the clip shows what the plan shows there
    let shares = true;
    for (const [pp, dur] of [[p, 1000], [p2, 2000], [p3, 1000], [eased, 1000], [odd, 1050]] as const) {
      const step = 60 / pp.fps, n = CP.clipTicks(dur);
      for (let j = 0; j <= n; j++) {
        const raw = Math.min(1, j / 60 / (dur / 1000));
        const k = Math.min(pp.frames.length - 1, Math.floor(j / step));
        const want = pp === eased ? CP.clipFrameKey(m, plan({ view: V0 }, { view: { ...V0, index: { t: 4 } } }).frame(raw * raw, raw), 640, 480) : null;
        if (want && pp.frames[k].key !== want) shares = false;
      }
    }
    h.ok(shares, "every 1/60 s tick of an eased walk shows exactly the plan's plane (each plane for its full share)");
    h.eq([CP.evenClipSize(641, 481), CP.evenClipSize(640, 480)], [{ width: 642, height: 482 }, { width: 640, height: 480 }], "odd sides are drawn one pixel larger (scaled, not padded)");
    h.ok(Math.abs(CP.clipSeekTime(0.5, 1000, 20, 21) - 10.5 / 20) < 1e-9 && CP.clipSeekTime(1, 1000, 20, 21) === 20.5 / 20, "a decoder seek lands mid-frame (never on the frame before)");
    try {
      const { pictureView } = await import("../src/lib/fluximg/slideSurfaces");
      h.ok(views.every((v) => JSON.stringify(pictureView(resolveView(m, v as any))) === JSON.stringify(CP.tweenPictureView(resolveView(m, v as any)))), "the baker's picture view is the GL host's (slideSurfaces.pictureView)");
    } catch (e) { h.ok(false, `slideSurfaces.pictureView importable for the parity check (${e})`); }
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("D. the baked clips against the reference");
  const clips = Object.values(payload.imageClips ?? {}) as any[];
  if (!encoder) blocked("D. decoded clip frames, first / last frame, bake counters");
  else {
    h.eq(clips.length, 4, "four clips: the walk, the contrast glide, the zoom and the blended walk back (the overlay-only fade has none)");
    const changes = slideImageChanges(compiled);
    const expect = changes.map((c) => ({ c, plan: planViewTween(m, { view: c.pre.view, crop: c.pre.crop }, { view: c.end.view, crop: c.end.crop }, { blend: c.blend }) }));
    h.eq(expect.map((e) => e.plan.pixels), [true, true, true, false, true], "walk, contrast, zoom and the blended walk move pixels; the layer fade does not");
    for (const { c, plan: pl } of expect) {
      if (!pl.pixels) continue;
      const key = CP.clipLookupKey(m, assetId, pl, { track: c.trackId, durationMs: c.durationMs, curve: c.ease.key, blend: c.blend });
      const clip = payload.imageClips?.[key];
      if (!h.ok(!!clip, `the ${c.trackId} Change has its clip under the key the exported player computes`)) continue;
      const file = path.join(P.scratch, `${c.trackId}.mp4`);
      await fs.writeFile(file, Buffer.from(clip.url.slice(clip.url.indexOf(",") + 1), "base64"));
      const frames = decodeClip(file, clip.width, clip.height);
      const cp = CP.planImageClip(m, pl, c.ease.fn, c.durationMs, clip.width, clip.height);
      h.ok(frames.length === clip.frames && clip.frames === cp.frames.length && clip.fps === cp.fps && clip.width % 2 === 0 && clip.height % 2 === 0, `${c.trackId}: ${clip.frames} frames at ${clip.fps} fps, ${clip.width}x${clip.height} (even)`);
      let worstMax = 0, worstMean = 0, rightPlane = true;
      const refs = new Map<string, Uint8ClampedArray>();
      for (let i = 0; i < frames.length; i++) {
        const f = cp.frames[i];
        let r = refs.get(f.key); if (!r) { r = await reference(f.frame, clip.width, clip.height, "#000000"); refs.set(f.key, r); }
        const d = diff(frames[i], r);
        worstMax = Math.max(worstMax, d.max); worstMean = Math.max(worstMean, d.mean);
        // the RIGHT plane: much closer to its own reference than to the neighbouring plane's
        if (c.trackId === "walk" && i > 0 && i < frames.length - 1) {
          const t = f.frame.a.view.index.t as number;
          const other = await reference({ ...f.frame, a: { ...f.frame.a, view: { ...f.frame.a.view, index: { ...f.frame.a.view.index, t: t + 1 } } } }, clip.width, clip.height, "#000000");
          if (!(diff(frames[i], other).mean > 3 * d.mean)) rightPlane = false;
        }
      }
      h.ok(worstMax <= BOUND.max && worstMean <= BOUND.mean, `${c.trackId}: every decoded frame within the bound of its reference (worst max ${worstMax}/255, worst mean ${worstMean.toFixed(3)}/255; bound ${BOUND.max}, ${BOUND.mean})`);
      if (c.trackId === "walk") h.ok(rightPlane, "walk: every decoded frame is its own plane (3x closer to it than to the next plane)");
      const [pre, end] = [c.pre, c.end].map((x) => fluximgStillRequest(x, asset, fullManifest, 2));
      const preRef = CP.matteRgba((await renderStill(reader, { view: pre.view, crop: pre.crop, outWidth: clip.width, outHeight: clip.height }, { resolveLut: resolveFluximgLut })).rgba.slice(), "#000000");
      const endRef = CP.matteRgba((await renderStill(reader, { view: end.view, crop: end.crop, outWidth: clip.width, outHeight: clip.height }, { resolveLut: resolveFluximgLut })).rgba.slice(), "#000000");
      const first = diff(frames[0], preRef), last = diff(frames.at(-1)!, endRef);
      h.ok(first.mean <= BOUND.mean && last.mean <= BOUND.mean && pre.outWidth === clip.width, `${c.trackId}: the first frame is the pre still, the last the end still (mean ${first.mean.toFixed(3)}, ${last.mean.toFixed(3)})`);
    }
    // repeats are never re-rendered: an eased walk of 5 planes = 61 frames, 5 pictures drawn
    const req = (over: Partial<import("../src/lib/fluximg/clipPlan").ImageClipRequest> = {}) => ({ kind: "change" as const, assetId, contentId: asset.sha256 ?? assetId, pre: { view: V0 }, end: { view: { ...V0, index: { t: 4 } } }, blend: false, curve: "quad", durationMs: 1000, width: 640, height: 480, matte: "#000000", lookup: "x", ...over });
    const repeatDir = path.join(P.scratch, "repeat-cache");
    const repeated = await bakeImageClip(P.root, asset, req(), (r) => r * r, { encoder, cacheDir: repeatDir });
    h.ok(repeated.stats!.frames === 61 && repeated.stats!.distinct === 5 && repeated.stats!.pictures === 5, `repeats are encoded again, never drawn again (${repeated.stats!.frames} frames, ${repeated.stats!.pictures} pictures drawn)`);

    // ----------------------------------------------------------------------------------------------------------------
    h.section("E. the render cache");
    const before = await listCache();
    // A hit refreshes a clip's use time (the cache's LRU prune, review C3): "untouched" is its inode and size (a bake
    // writes a new file and renames it over), not its mtime.
    const identity = async (n: string) => { const st = await fs.stat(path.join(cacheDir, n)); return `${st.ino}:${st.size}`; };
    const stamp = await Promise.all(before.map(identity));
    const t1 = performance.now();
    const again = await P.slidesCore.gatherDeckPayload(P.root, "talk", undefined, { refreshSources: false });
    const warmMs = performance.now() - t1;
    const after = await listCache();
    h.ok(before.length === clips.length && before.every((n) => CP && /^fxc-[\da-f]{16}\.mp4$/.test(n)), `the clips are cached in fig/renders/fluximg by content (${before.length} files)`);
    h.ok(JSON.stringify(after) === JSON.stringify(before) && (await Promise.all(after.map(identity))).every((t, i) => t === stamp[i]), "a second export bakes nothing (same files, never rewritten)");
    h.ok(JSON.stringify(again.payload.imageClips) === JSON.stringify(payload.imageClips), `and carries the same clips (cold gather ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms)`);
    const hit = await bakeImageClip(P.root, asset, req(), (r) => r * r, { encoder, cacheDir: repeatDir });
    h.ok(hit.cached && hit.file === repeated.file, "the same request is a cache hit");
    const misses = await Promise.all([req({ durationMs: 1200 }), req({ curve: "cubic" }), req({ matte: "#ffffff" }), req({ width: 642 }), req({ end: { view: { ...V0, index: { t: 5 } } } }), req({ blend: true }), req({ contentId: "other" })]
      .map(async (r) => CP.imageClipCacheKey(r as any, 60, 61, encoder.identity, "s")));
    h.ok(new Set([CP.imageClipCacheKey(req() as any, 60, 61, encoder.identity, "s"), ...misses]).size === 8 && CP.imageClipCacheKey(req() as any, 60, 61, "other-encoder", "s") !== CP.imageClipCacheKey(req() as any, 60, 61, encoder.identity, "s"), "duration, curve, matte, size, an end, blend, content id and the encoder each change the key");

    // ----------------------------------------------------------------------------------------------------------------
    h.section("F. cancel leaves no partial file");
    const cancelDir = path.join(P.scratch, "cancel-cache");
    const ac = new AbortController();
    let err: unknown;
    try { await bakeImageClip(P.root, asset, req({ durationMs: 3000, curve: "cancel" }), (r) => r * r, { encoder, cacheDir: cancelDir, signal: ac.signal, onProgress: (p) => { if (p.frame >= 2) ac.abort(); } }); } catch (e) { err = e; }
    h.ok((err as Error)?.name === "AbortError", "an aborted bake rejects with AbortError");
    h.eq(await fs.readdir(cancelDir), [], "and leaves no file, partial or final, in its cache");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("G. no encoder: stills and one warning, never a failed export");
  {
    const saved = process.env.FLUX_VIDEO_ENCODER;
    process.env.FLUX_VIDEO_ENCODER = path.join(P.scratch, "no-such-encoder", "ffmpeg");
    try {
      const r = await P.slidesCore.gatherDeckPayload(P.root, "talk", undefined, { refreshSources: false });
      h.eq(r.warnings.filter((w: string) => w === IMAGE_NO_ENCODER_NOTE).length, 1, `exactly one warning for the deck: "${IMAGE_NO_ENCODER_NOTE}"`);
      h.ok(!r.payload.imageClips && Object.keys(r.payload.assets ?? {}).length === Object.keys(payload.assets ?? {}).length, "no clips; every still is still there");
      const out = await P.slidesCore.exportDeck(P.root, "talk", { refreshSources: false, out: path.join(P.scratch, "no-encoder.html") });
      h.ok(out.bytes > 0 && out.warnings.includes(IMAGE_NO_ENCODER_NOTE), "export-deck succeeds and says so");
    } finally { if (saved === undefined) delete process.env.FLUX_VIDEO_ENCODER; else process.env.FLUX_VIDEO_ENCODER = saved; }
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("H. a deck without images: nothing new is gathered or shipped");
  {
    await P.core.createDeck(P.root, { id: "plain", title: "Plain" });
    await P.slidesCore.mutateDeck(P.root, "plain", "t", (d: any) => { d.slides[0].elements.push({ id: "r", type: "rect", x: 10, y: 10, width: 100, height: 50, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 }); });
    const r = await P.slidesCore.gatherDeckPayload(P.root, "plain", undefined, { refreshSources: false });
    h.ok(!("images" in r.payload) && !("imageClips" in r.payload), "no images / imageClips keys in its payload");
    const { html } = await exportDeckHtml(r.payload);
    const scripts = (x: string) => (x.match(/\n<script>/g) ?? []).length;
    h.ok(!html.includes("slideFluximgClip") && scripts(html) === 2, `its HTML carries no image runtime (the runtime and the boot script only: ${scripts(html)})`);
    const img = await exportDeckHtml(payload);
    h.ok(img.html.includes("slideFluximgClip") && scripts(img.html) === 3, "an image deck's HTML adds the conditional image runtime");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("I. the exported runtimes' import graph and sizes");
  {
    const { build } = await import("esbuild");
    const graph = async (entry: string) => Object.keys((await build({ entryPoints: [entry], bundle: true, format: "iife", platform: "browser", write: false, metafile: true, external: ["*/colormapLuts.gen"], define: { "import.meta.env.DEV": "false" }, minify: true, logLevel: "silent" })).metafile!.inputs);
    const forbidden = /fluximg\/(reader|zarr|still|render|service|store|fluximg\.worker|live\/driver|gl\/)|zstd|ZSTDDecoder/;
    for (const entry of ["src/lib/slide/export/runtime.ts", "src/lib/slide/export/videoRuntime.ts", "src/lib/slide/export/fluximgRuntime.ts", "src/lib/slide/embedDocumentRuntime.ts"]) {
      const bad = (await graph(entry)).filter((p) => forbidden.test(p));
      h.eq(bad, [], `${entry}: no reader, codec, still renderer, GL or service module in its graph`);
    }
    const assets = await computeExportAssets();
    const kb = (s?: string) => ((s ?? "").length / 1024).toFixed(1);
    console.log(`  sizes: runtime ${kb(assets.runtime)} KB, video ${kb(assets.videoRuntime)} KB, image (conditional) ${kb(assets.fluximgRuntime)} KB, embed ${kb(assets.embed?.runtime)} KB`);
    h.ok(!!assets.fluximgRuntime && !assets.runtime.includes("slideFluximgClip") && assets.fluximgRuntime.includes("slideFluximgClip"), "the clip surface lives only in the conditional image runtime");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("J. PDF and PowerPoint: the page of step k carries the still of step k");
  {
    const io = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p), ...nodeSlideImageIO(P.root, session) };
    const pdf = await deckPdfDocument(P.root, "talk", io as any, "steps");
    const pages = pdf.html.split('<div class="page">').slice(1);
    h.ok(pages.length === slide.beats.length && pages.every((pg, k) => pg.includes(stillOfStep[k])), `PDF steps: ${pages.length} pages, page k shows step k's still`);
    h.ok(pdf.warnings.includes(IMAGE_STILL_NOTE), `PDF notes "${IMAGE_STILL_NOTE}"`);
    const { payload: sp } = await gatherSlidePayload(P.root, deck, slide.id, io as any);
    const rasters: string[] = [];
    const animated = await deckPptxBytes("Talk", [{ payload: sp }], async (svg) => { rasters.push(svg); return new Resvg(svg).render().asPng(); }, undefined, "animated");
    const imageSvgs = rasters.filter((s) => s.includes("data-fluximg"));
    h.ok(imageSvgs.length >= 4 && [0, 1, 2, 3].every((k) => imageSvgs.some((s) => s.includes(stillOfStep[k]))), `PPTX animated: each build state's picture is that step's still (${imageSvgs.length} image pictures)`);
    const zip = unzipSync(animated.bytes);
    h.ok(Object.keys(zip).some((p) => /^ppt\/media\/.*\.png$/.test(p)) && animated.warnings.includes(IMAGE_STILL_NOTE), "the pictures are PNG media parts, and the note is given");
    const final = await deckPptxBytes("Talk", [{ payload: sp }], async (svg) => { rasters.push(svg); return new Resvg(svg).render().asPng(); }, undefined, "final");
    const slideXml = Object.entries(unzipSync(final.bytes)).filter(([p]) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).map(([, v]) => strFromU8(v));
    h.ok(slideXml.length === 1 && rasters.at(-1)!.includes(stillOfStep.at(-1)!), "PPTX final: one page, the last step's still");
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Review (parts leftover 7d): a slide where a layer's objects appear one by one, through the real writers. Each step's
  // page draws the objects born by then and leaves the unborn out.
  h.section("J2. PDF and PowerPoint: objects that appear one by one");
  {
    await P.slidesCore.mutateDeck(P.root, "talk", "fixture", (d: any) => {
      const s = d.slides[0], e = s.elements.find((x: any) => x.type === "fluximg");
      s.beats = [s.beats[0],
        { id: "o1", tracks: [{ id: "o1t", target: e.id, parts: ["cells/1", "cells/2"], preset: "fade", start: 0, duration: 400 }] },
        { id: "o2", tracks: [{ id: "o2t", target: e.id, part: "layer:cells", preset: "fade", start: 0, duration: 400, stagger: { perMs: 100 } }] }];
    });
    const odeck = await P.slidesCore.loadDeck(P.root, "talk"), oslide = odeck.slides[0];
    const keysIn = (svg: string) => { const g = /data-layer="cells"[^]*?<\/g>/.exec(svg)?.[0] ?? ""; return [...g.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]).sort(); };
    const io = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p), ...nodeSlideImageIO(P.root, session) };
    const pdf = await deckPdfDocument(P.root, "talk", io as any, "steps");
    const pages = pdf.html.split('<div class="page">').slice(1);
    h.eq(pages.map(keysIn), [[], ["1", "2"], ["1", "2", "3", "4"]], "PDF steps: page k draws the objects born by step k (Design none, then 1 and 2, then all)");
    const { payload: op } = await gatherSlidePayload(P.root, odeck, oslide.id, io as any);
    const rasters: string[] = [];
    await deckPptxBytes("Talk", [{ payload: op }], async (svg) => { rasters.push(svg); return new Resvg(svg).render().asPng(); }, undefined, "animated");
    // (a step with no object born yet draws no group for the layer: its picture is found by the image's own mark)
    const states = [...new Set(rasters.filter((x) => x.includes("data-fluximg")).map((x) => keysIn(x).join(",")))];
    h.ok(["", "1,2", "1,2,3,4"].every((k) => states.includes(k)), `PPTX animated: its build pictures draw the born objects only (states: ${states.map((k) => `[${k}]`).join(" ")})`);
    rasters.length = 0;
    await deckPptxBytes("Talk", [{ payload: op }], async (svg) => { rasters.push(svg); return new Resvg(svg).render().asPng(); }, undefined, "final");
    h.eq(keysIn(rasters.filter((x) => x.includes("data-fluximg")).at(-1) ?? ""), ["1", "2", "3", "4"], "PPTX final: the last step, every object");
    await standardDeck(P);
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("K. Paper: an image deck embeds; a missing bundle refuses the portable export");
  {
    const io = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p), ...nodeSlideImageIO(P.root, session) };
    const repo = createSlideRepository(P.root, io as any);
    const snap = await repo.materialize({ deck: "talk", slide: slide.id }, { portable: true });
    h.ok(snap.poster.includes(stillOfStep[0]) && !!snap.payload.images?.[assetId], "the portable Paper snapshot carries the image and its poster shows step 0's still");
    const refusal = /its element will show a placeholder|missing from the export|no parts tree/;
    h.ok(![IMAGE_STILL_NOTE, IMAGE_NO_ENCODER_NOTE].some((w) => refusal.test(w)), "the ordinary image notes never match Paper's refusal pattern");
    await fs.rename(bundleDir, `${bundleDir}.away`);
    // A fresh render session: the readers of the one above still hold the bundle open.
    const coldIO = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p), ...nodeSlideImageIO(P.root) };
    const cold = createSlideRepository(P.root, coldIO as any);
    try {
      let refused = "";
      try { await cold.materialize({ deck: "talk", slide: slide.id }, { portable: true }); } catch (e) { refused = String(e); }
      h.ok(refusal.test(refused), "a missing bundle is a placeholder warning, and Paper's exported HTML refuses it");
      const r = await gatherSlidePayload(P.root, deck, slide.id, coldIO as any);
      h.ok(r.warnings.some((w: string) => /missing or unreadable/.test(w)) && !r.payload.images, "the deck export itself goes on with the stand-in and a warning");
    } finally { await fs.rename(`${bundleDir}.away`, bundleDir); repo.dispose(); cold.dispose(); }
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("L. headless: export-deck and the contact sheet");
  {
    const out = await P.call("export_deck", { deckId: "talk", out: path.join(P.scratch, "verb.html") });
    const html = await fs.readFile(out.path, "utf8");
    h.ok(html.includes("FluxImageRuntime") && html.includes(`"images":{"${assetId}"`) && (!encoder || html.includes("imageClips")), "the export-deck verb exports the image deck (runtime, images, clips) with no new verb");
    const { deckSheetSvg } = await import("../flux-core/connect/images");
    const sheet = await deckSheetSvg(P.root, deck, 0, 1);
    h.ok(sheet.includes("data:image/png") && !sheet.includes("could not render"), "the contact sheet renders the image slide");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("M. running movies: one clip per look, the pure clock's planes");
  {
    const { playbackPlane } = await import("../src/lib/slide/mediaTimeline");
    let same = true;
    for (const mode of ["loop", "bounce", "once"] as const) {
      const p = { dim: "t", mode, from: 2, to: 8, periodMs: 100 }, planes = CP.playbackPlanes(p);
      for (let pos = 0; pos < 3000; pos += 7) {
        const k = Math.floor(CP.playbackClipTime(pos, p) * 1000 / p.periodMs);
        if (planes[k] !== p.from + playbackPlane(pos, 600, mode, 6).plane) same = false;
      }
    }
    h.ok(same, "a movie clip's frame at any clock position is the plane mediaTimeline.playbackPlane gives (loop, bounce, once)");
    h.eq(CP.playbackPlanes({ dim: "t", mode: "bounce", from: 2, to: 6, periodMs: 100 }), [2, 3, 4, 5, 4, 3], "bounce is baked there and back, the end planes once (a native loop is the bounce)");
    const mdeck = await movieDeck(P);
    const r = await P.slidesCore.gatherDeckPayload(P.root, "talk", undefined, { refreshSources: false });
    const movieClips = Object.entries(r.payload.imageClips ?? {}).filter(([k]) => k.startsWith("fxp-")) as Array<[string, any]>;
    h.ok(r.warnings.some((w: string) => /movie runs through the Change at step 2/.test(w)), "a pixel Change under a running movie warns, naming its step");
    h.ok(!Object.keys(r.payload.imageClips ?? {}).some((k) => k.startsWith("fxc-")), "and bakes no Change clip of its own (the movie's clip is what shows)");
    if (!encoder) blocked("M. movie clips");
    else {
      h.ok(movieClips.length === 2 && movieClips.every(([, c]) => c.loop === true && c.frames === 10 && c.fps === 10 && c.durationMs === 1000), `two movie clips (the look before and after the Change), each one bounce of 6 planes = 10 frames at 10 fps, looped natively`);
      const melement = mdeck.slides[0].elements.find((e: any) => e.type === "fluximg") as any;
      const state = { view: resolveView(m, mdeck.slides[0].elements.find((e: any) => e.id === melement.id)!.view as any), crop: { x: 0, y: 0, width: 64, height: 48 } };
      const pb = { dim: MOVIE.dim, mode: MOVIE.mode, from: MOVIE.from, to: MOVIE.to, periodMs: 100 };
      const key = CP.playbackLookupKey(m, assetId, state, pb);
      const clip = r.payload.imageClips?.[key];
      if (h.ok(!!clip, "the step-1 look's clip is under the key the exported player computes from the frame it shows")) {
        const file = path.join(P.scratch, "movie.mp4");
        await fs.writeFile(file, Buffer.from(clip.url.slice(clip.url.indexOf(",") + 1), "base64"));
        const frames = decodeClip(file, clip.width, clip.height);
        const planes = CP.playbackPlanes(pb);
        let ok = true, worst = 0;
        for (let k = 0; k < frames.length; k++) {
          const pic = { view: { ...state.view, index: { ...state.view.index, t: planes[k] } }, crop: state.crop };
          const d = diff(frames[k], await reference({ a: pic, b: null, mix: 0, blend: null, overlay: pic, furnitureOpacity: {} }, clip.width, clip.height, "#000000"));
          worst = Math.max(worst, d.mean); if (d.mean > BOUND.mean || d.max > BOUND.max) ok = false;
        }
        h.ok(frames.length === 10 && ok, `every movie frame is its plane (${planes.join(" ")}), worst mean ${worst.toFixed(3)}/255`);
      }
    }
    const io = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p), ...nodeSlideImageIO(P.root, session) };
    const pdf = await deckPdfDocument(P.root, "talk", io as any, "steps");
    const pages = pdf.html.split('<div class="page">').slice(1);
    h.ok(pdf.warnings.includes(IMAGE_STILL_NOTE) && pages[1].includes(stillOfStep[0]), "PDF: the movie's step shows the state's own plane (the Design still), with the note");
    h.ok(pages.every((pg) => /data-part="inset"/.test(pg)) && /data-part="inset"/.test(renderSlidePosterSvg(r.payload, 1)), "a blow-out's frame is outlined on the image in every PDF page and poster (insets in static writers)");
  }
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(async () => { await fs.rm(P.scratch, { recursive: true, force: true }); });
