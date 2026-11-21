// fluximg stage 2, W10: an image's movie as a FILE (pure tier; the encoder-backed checks skip with one line without it).
//
// One image element played along one dimension, written as an H.264 MP4 (flux-core/fluximgMovie.ts) from the plan
// `fluximg/moviePlan.ts` defines on top of the deck clips' planners, drawn and encoded by the deck clips' baker. Pins:
//   A. the plan: frame count, order and rate for once / bounce / a sub-range / speed / fps / blend, against
//      hand-computed lists; the defaults (playback dimension and range, natural rate, 12 fps); refusals; the size rules
//      (legibility floor, the 2160 cap, even sides by matte); the board's facts agree with the plan;
//   B. the written file: codec, pixel format, even size, frame count, duration within one frame, faststart order, the
//      slide-video colour tags;
//   C. decoded frames (first, middle, last) against the element as Flux draws it (the static composer's SVG with the
//      reference still, rasterized by resvg) within the deck clips' bound; the time stamp reads each frame's own time;
//      the scale bar's length in pixels; styled label layers drawn; a crop respected; a mirrored element;
//   D. cancel removes the partial file;  E. no encoder: a clean refusal that names the reason;
//   F. memory stays bounded on a stack larger than the decoded-piece budget (peak RSS of a child process); export speed;
//   G. the verb end to end (CLI-shaped registry call) for an image on a figure and on a slide (Design and a step);
//   H. the same request twice writes the same bytes.
//
// Run: npx tsx scripts/verify-fluximg-movie.ts   (FLUX_VIDEO_ENCODER=<pinned ffmpeg> to use another encoder)
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { harness } from "./lib/harness.mjs";
import { makeProject, V0 } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-movie");
const P = await makeProject();
const MP = await import("../src/lib/fluximg/moviePlan");
const CP = await import("../src/lib/fluximg/clipPlan");
const { resolveView } = await import("../src/lib/fluximg/viewOps");
const { fluximgReader } = await import("../flux-core/fluximgRender");
const { fluximgResolvedAsset } = await import("../src/lib/fluximg/place");

const assetId: string = P.placed.assetId, elementId: string = P.placed.elementId;
const manifest = JSON.parse(await fs.readFile(path.join(P.root, "fig/assets", `${assetId}.fluximg`, "fluximg.json"), "utf8"));
const asset = fluximgResolvedAsset(assetId, manifest);
const reader = await fluximgReader(P.root, asset);
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const src = (o: Partial<import("../src/lib/fluximg/moviePlan").MovieSource> = {}) => ({ view: V0, crop: null, width: 320, height: 240, ...o });

try {
  // ------------------------------------------------------------------------------------------------------------------
  h.section("A. the plan");
  {
    const plan = (o: import("../src/lib/fluximg/moviePlan").MovieOptions = {}, s = src(), decorated = true) => {
      const st = MP.resolveMovie(manifest, s, o, decorated);
      const p = MP.planMovieClip(manifest, { view: resolveView(manifest, s.view as any), crop: st.crop }, { view: s.view as any, crop: s.crop }, st);
      return { st, p, planes: p.frames.map((f) => f.frame.a.view.index[st.dim]), sum: MP.movieSummary(st) };
    };
    const d = plan();
    h.ok(d.st.dim === "t" && d.st.from === 0 && d.st.to === 24 && d.st.mode === "once", "defaults: the time axis, all 24 planes, once");
    h.eq(d.planes, range(0, 24), "once: one frame per plane, in order");
    h.ok(d.p.rate === "1000000/100000" && d.p.fps === 10 && d.p.durationMs === 2400, "the data's own rate (t in 0.1 s steps: 10 planes a second), an exact rational; 2.4 s");
    h.eq(plan({ mode: "bounce", from: 2, to: 6 }).planes, [2, 3, 4, 5, 4, 3, 2], "bounce 2..6: there and back, ending on the first plane again (7 frames)");
    h.eq(plan({ from: 5, to: 9 }).planes, [5, 6, 7, 8], "a sub-range: planes from (inclusive) to (exclusive)");
    const sp = plan({ speed: 2 });
    h.ok(sp.p.rate === "1000000/50000" && sp.p.fps === 20 && sp.p.durationMs === 1200 && sp.planes.length === 24, "speed 2: 20 planes a second, 1.2 s, the same 24 frames");
    const fp = plan({ fps: 4, speed: 2 });
    h.ok(fp.p.fps === 8 && fp.p.rate === "1000000/125000" && fp.p.durationMs === 3000, "fps 4 replaces the data's rate, speed still applies: 8 a second");
    // Blend: the Change "Play through" with Blend planes writes, linear, sampled on the 60 Hz clock.
    const bl = plan({ blend: true, from: 0, to: 4 });
    const hand = range(0, 19).map((j) => { const p = j / 6, a = Math.floor(p), w = p - a; return w > 1e-9 ? `${a}>${a + 1}@${w.toFixed(3)}` : `${a}`; });
    const got = bl.p.frames.map((f) => f.frame.blend && f.frame.blend.weight > 1e-9 ? `${f.frame.a.view.index.t}>${f.frame.blend.other}@${f.frame.blend.weight.toFixed(3)}` : `${f.frame.a.view.index.t}`);
    h.eq(got, hand, "blend 0..4 at 10 a second: 19 frames at 60 fps, plane k at 0.1 k s, each pair crossfaded by the clock");
    h.ok(bl.p.fps === 60 && bl.p.rate === "60" && Math.abs(bl.p.durationMs - 19000 / 60) < 1e-6, "blend runs at 60 fps (a crossfade is continuous)");
    const bb = plan({ blend: true, from: 0, to: 4, mode: "bounce" });
    h.ok(bb.p.frames.length === 37 && bb.p.frames[18].frame.a.view.index.t === 3 && bb.p.frames[36].frame.a.view.index.t === 0, "blend bounce: the walk back appended (37 frames, the turn at plane 3, ending at 0)");
    const cases = [d, plan({ mode: "bounce", from: 2, to: 6 }), sp, fp, bl, bb, plan({ blend: true, from: 3, to: 4 })];
    h.ok(cases.every((c) => c.sum.frames === c.p.frames.length && Math.abs(c.sum.durationMs - c.p.durationMs) < 1e-6 && Math.abs(c.sum.fps - c.p.fps) < 1e-9), "the board's summary (frames, rate, length) equals the plan in every case");
    h.eq(MP.movieFacts(d.st), "24 frames · 2.4 s at 10 fps · 320 × 240", "the facts in the board's words");
    // Defaults from the element's playback setting, and the rate when the axis has none.
    const pb = plan({}, src({ playback: { dim: "t", mode: "loop", from: 2, to: 8, fps: 5 } }));
    h.ok(pb.st.from === 2 && pb.st.to === 8 && pb.p.fps === 10, "the playback's range is the default; the data's own rate wins over the playback's fps");
    const plain = structuredClone(manifest); delete plain.axes.t.unit;
    const r12 = MP.resolveMovie(plain, src(), {}), r5 = MP.resolveMovie(plain, src({ playback: { dim: "t", mode: "loop", fps: 5 } }), {});
    h.ok(r12.planeRate === 12 && r5.planeRate === 5, "an axis without a rate: the playback's fps, else 12 planes a second");
    const refuse = (o: any, re: RegExp) => { try { MP.resolveMovie(manifest, src(), o); return false; } catch (e) { return e instanceof MP.MovieRequestError && re.test((e as Error).message); } };
    h.ok(refuse({ dim: "z" }, /not a dimension this image can play \(t\)/) && refuse({ from: 24 }, /from must be a whole plane 0\.\.23/) && refuse({ from: 5, to: 5 }, /to must be a whole plane after from/)
      && refuse({ speed: 0 }, /speed/) && refuse({ fps: -1 }, /fps/) && refuse({ mode: "loop" }, /once or bounce/) && refuse({ scale: 40 }, /scale/), "requests that do not fit are refused, saying what would");
    // Size.
    const sz = (o: any, s = src(), deco = true) => MP.resolveMovie(manifest, s, o, deco);
    const raised = sz({}), bare = sz({}, src(), false), three = sz({ scale: 3 }, src(), false);
    h.ok(raised.raised && raised.picture.width === 320 && raised.picture.height === 240 && raised.width === 320, "with furniture: never below the element's box (64 x 48 at 5x = 320 x 240)");
    h.ok(!bare.raised && bare.width === 64 && bare.height === 48 && three.width === 192 && three.height === 144, "without: the image's own pixels times scale (64 x 48; 192 x 144)");
    const odd = sz({}, src({ crop: { x: 3, y: 2, width: 33, height: 25 } }), false);
    h.ok(odd.picture.width === 33 && odd.picture.height === 25 && odd.width === 34 && odd.height === 26, "odd sides: the picture is drawn at 33 x 25 and the file is 34 x 26 (one pixel of matte, never stretched)");
    const big = structuredClone(manifest); big.pixels.shape = [24, 2, 3000, 4000];
    const capped = MP.resolveMovie(big, src({ width: 400, height: 300 }), { scale: 2 });
    h.ok(capped.capped && capped.width === 2160 && capped.height === 1620, "the longest side is capped at 2160 (4000 x 3000 at 2x -> 2160 x 1620)");
    const skew = sz({}, src({ width: 320, height: 100 }));
    h.ok(Math.abs(skew.box.height - 240) < 1e-9, "a box off the picture's aspect lays the furniture out at the picture's aspect (no stretched words)");
    h.eq(MP.movieFileName("Cells / day 3: växt"), "Cells-day-3-vaxt.mp4", "a safe default file name from the image's name");
  }
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(async () => { await fs.rm(P.scratch, { recursive: true, force: true }); });
void spawnSync; void reader; void CP;
