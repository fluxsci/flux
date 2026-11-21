// verify-fluximg-slide-authoring (pure, hermetic): authoring image animation on slides (fluximg stage 2, W5+W6).
//
// What is pinned:
//   A. THE PACE RULE in slideOps.writeStepState (the one op the app's capture and set-image-view --beat call): a Change that
//      walks planes is written linear, duration = the walk at the data's own pace / speed, params.pace = speed -- when the
//      capture made it, while it is paced (re-timed as the walk changes), while its timing is still the authored Change
//      timing; never after a hand re-time (setTrack duration, a curve, a nudge); without a manifest at 12 planes a second;
//      several dimensions: the longest walk; a Change that walks nothing keeps the ordinary timing; a paced track whose walk
//      is gone returns to it.
//   B. addImageWalk (Play through): defaults (time, else depth; the last plane, or the first from the last), validation,
//      replacement (joins this step's Change, keeps its other changes), the previous step's end as its start, blend.
//   C. setVideoTrack / setImagePlayback on images and their refusals; the compiler's media rules.
//   D. The media clock: sampleImagePlayback on hand cases (loop, bounce, once; Start / Pause / Stop) and on seeded random
//      event lists (deterministic, in range, the same fold as the video clock).
//   E. viewTween.withIndex (sharing) and dropViewChange (every kind of change).
//   F. The element schema: `playback` round-trips; bad ones are refused.
//   G. Headless: set-image-view --speed / --blend / --playback and set-video-track on an image, through the registry and the CLI.
//   H. A deck WITHOUT images: compile output and the media clock are byte-identical to the base (digests recorded on
//      fluximg-s2 @ 48451b7a before this work, scripts/lib/noImageDeckDigest.ts).
//
// Run: node --import tsx scripts/verify-fluximg-slide-authoring.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";

const h = harness("verify-fluximg-slide-authoring");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fluximg-slide-authoring-"));
Object.assign(process.env, isolatedEnv(path.join(scratch, "machine")), { FLUX_NO_MIGRATE: "1" });

const { VERBS } = await import("../flux-core/registry");
const core = await import("../flux-core/index");
const slidesCore = await import("../flux-core/slides");
const { fixtures, writeFixture } = await import("./lib/fluximgFixtures");
const slideOps = await import("../src/lib/slide/ops");
const { transformPreState, transformEndState } = await import("../src/lib/slide/tween");
const { compileSlide } = await import("../src/lib/slide/compile");
const media = await import("../src/lib/slide/mediaTimeline");
const vt = await import("../src/lib/fluximg/viewTween");
const pb = await import("../src/lib/fluximg/playback");
const { resolveView } = await import("../src/lib/fluximg/viewOps");
const { validateDeckFile } = await import("../src/lib/project/validate");
const { deckSchemaFor } = await import("../src/lib/slide/schemaStamp");
const { authoredFields } = await import("../src/lib/slide/presetCatalog");
const { decksWithoutImages, deckDigest } = await import("./lib/noImageDeckDigest");
type Deck = import("../src/lib/slide/types").Deck;
type Track = import("../src/lib/slide/types").Track;
type FluximgElement = import("../src/lib/fluximg/element").FluximgElement;
type FluximgManifest = import("../src/lib/fluximg/types").FluximgManifest;
type Element = import("../src/lib/types").Element;

const root = path.join(scratch, "project");
const verb = (name: string) => VERBS.find((v) => v.name === name)!;
async function call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const v = verb(name);
  return (await v.handler({ root, transport: "mcp" }, z.object(v.params).parse(args) as Record<string, unknown>)) as T;
}
async function refuses(name: string, args: Record<string, unknown>, pattern: RegExp, label: string): Promise<void> {
  try { await call(name, args); h.fail(`${label}: accepted`); }
  catch (e) { const m = e instanceof Error ? e.message : String(e); h.ok(pattern.test(m), `${label}: "${m.split("\n")[0]}"`); }
}
function throwsLike(fn: () => unknown, pattern: RegExp, label: string): void {
  try { fn(); h.fail(`${label}: no error`); } catch (e) { const m = e instanceof Error ? e.message : String(e); h.ok(pattern.test(m), `${label}: "${m}"`); }
}

try {
  await core.scaffold(root, { title: "image animation" });
  const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
  for (const name of ["stack_u16", "movie_f32", "gray2d_u8"]) await writeFixture(path.join(root, "plots"), fx[name]);
  const read = async (n: string) => JSON.parse(await fs.readFile(path.join(root, `plots/${n}.fluximg/fluximg.json`), "utf8")) as FluximgManifest;
  const STACK = await read("stack_u16"), MOVIE = await read("movie_f32"), FLAT = await read("gray2d_u8");
  // A synthetic image that walks two dimensions (time 10 x depth 5): the longest walk sets the pace.
  const TZ: FluximgManifest = structuredClone(STACK);
  TZ.pixels = { ...TZ.pixels, dims: ["t", "z", "y", "x"], shape: [10, 5, 48, 64] };
  TZ.axes = { t: { unit: "s", scale: 0.1 }, z: { unit: "µm", scale: 1 }, y: STACK.axes.y, x: STACK.axes.x };
  TZ.channels = TZ.channels.slice(0, 1); delete TZ.profiles; TZ.defaults = {};
  const manifests: Record<string, FluximgManifest> = { stack: STACK, movie: MOVIE, flat: FLAT, tz: TZ };
  const lookup = (id: string) => manifests[id];
  const nz = STACK.pixels.shape[STACK.pixels.dims.indexOf("z")], nt = MOVIE.pixels.shape[MOVIE.pixels.dims.indexOf("t")];

  const img = (id: string, assetId: string, extra: Partial<FluximgElement> = {}): FluximgElement => ({ type: "fluximg", id, assetId, x: 10, y: 10, width: 64, height: 48, rotation: 0, ...extra } as FluximgElement);
  function deck(...els: Element[]): Deck {
    const d = slideOps.createDeck({ id: "d", title: "D" });
    d.slides[0].id = "s"; d.slides[0].elements = els; d.slides[0].beats[0].id = "b0";
    d.slides[0].beats.push({ id: "b1", tracks: [] }, { id: "b2", tracks: [] });
    return d;
  }
  const slideOf = (d: Deck) => d.slides[0];
  const change = (d: Deck, bi: number, id: string) => slideOf(d).beats[bi].tracks.find((t) => t.preset === "transform" && t.target === id) as Track | undefined;
  /** "Edit after step bi" exactly as the capture adapter does it: the end is the element at the step with `edit` applied. */
  function capture(d: Deck, bi: number, id: string, edit: (el: FluximgElement) => void, opts: Parameters<typeof slideOps.writeStepState>[5] = { fluximgManifest: lookup }) {
    const s = slideOf(d);
    const pre = transformPreState(s, id, bi)!;
    const cur = change(d, bi, id);
    const end = structuredClone(cur ? transformEndState(pre, cur) : pre) as FluximgElement;
    edit(end);
    return slideOps.writeStepState(d, s.id, s.beats[bi].id, end, pre, opts)!;
  }
  const at = (el: FluximgElement, index: Record<string, number>) => { el.view = { ...(el.view ?? {}), index: { ...(el.view?.index ?? {}), ...index } }; };
  const authored = authoredFields("transform");

  // ----------------------------------------------------------------------------------------------------------------
  h.section("A. the pace rule (writeStepState)");
  {
    const d = deck(img("a", "stack", { view: { index: { z: 0 } } }));
    let t = capture(d, 1, "a", (e) => at(e, { z: 6 }));
    h.eq([t.duration, t.easing, t.curve ?? null, t.params?.pace], [Math.round(6 / 12 * 1000), "linear", null, 1], "a capture that walks depth 0 → 6: linear, 6 planes at 12 a second, pace 1");
    h.eq(slideOps.walkPace(t), 1, "walkPace reads it through the table");
    t = capture(d, 1, "a", (e) => at(e, { z: 3 }));
    h.eq([t.duration, t.params?.pace], [250, 1], "scrubbing the end at the same step re-times a paced track (0 → 3: 250 ms)");
    slideOps.setTrack(d, "s", t.id!, { duration: 900 });
    h.ok(t.duration === 900 && t.params?.pace === undefined, "a duration typed or dragged (setTrack) drops the pace");
    t = capture(d, 1, "a", (e) => at(e, { z: 6 }));
    h.ok(t.duration === 900 && t.params?.pace === undefined && t.easing === "linear", "…and the walk is never re-timed again (still 900 ms)");
    const d2 = deck(img("a", "stack"));
    const t2 = capture(d2, 1, "a", (e) => at(e, { z: 6 }));
    slideOps.setTrackCurve(d2, "s", t2.id!, "smooth");
    h.ok(t2.params?.pace === undefined, "choosing a curve drops the pace");
    const d3 = deck(img("a", "stack", { view: { index: { z: 0 } } }));
    const t3 = capture(d3, 1, "a", (e) => at(e, { z: 6 }));
    slideOps.cascadeTracks; // (the cascade's duration branch calls dropWalkPace: pinned by grep below)
    slideOps.dropWalkPace(t3);
    h.ok(t3.params === undefined, "dropWalkPace removes only `pace` (and an emptied params)");
  }
  {
    const d = deck(img("m", "movie", { view: { index: { t: 0 } } }));
    const t = capture(d, 1, "m", (e) => at(e, { t: 20 }));
    h.eq(t.duration, Math.round(vt.naturalDurationMs(MOVIE, "t", 0, 20, 1)), `a time walk plays in real time (20 frames × 12.5 ms = ${Math.round(vt.naturalDurationMs(MOVIE, "t", 0, 20, 1))} ms)`);
    const d2 = deck(img("m", "movie", { view: { index: { t: 0 } } }));
    const t2 = capture(d2, 1, "m", (e) => at(e, { t: 20 }), {});
    h.eq([t2.duration, t2.params?.pace], [Math.round(20 / 12 * 1000), 1], "no manifest known: the fallback rate of 12 planes a second");
    const d3 = deck(img("m", "movie", { view: { index: { t: 0 } } }));
    const t3 = capture(d3, 1, "m", (e) => at(e, { t: 20 }), { fluximgManifest: lookup, speed: 2 });
    h.eq([t3.duration, t3.params?.pace], [Math.round(vt.naturalDurationMs(MOVIE, "t", 0, 20, 2)), 2], "speed 2: half the time, pace 2");
  }
  {
    const d = deck(img("q", "tz", { view: { index: { t: 0, z: 0 } } }));
    const t = capture(d, 1, "q", (e) => at(e, { t: 9, z: 4 }));
    h.eq(t.duration, 900, "two dimensions walk: the longest (time, 9 planes × 100 ms) sets the pace");
    const d2 = deck(img("q", "tz", { view: { index: { t: 0, z: 0 } } }));
    const t2 = capture(d2, 1, "q", (e) => { at(e, { z: 4 }); e.view!.channels = [{ range: [10, 900] }]; });
    h.eq([t2.duration, t2.params?.pace], [Math.round(4 / 12 * 1000), 1], "a mixed Change (depth walk + contrast) is still paced by its walk");
    const t3 = capture(d2, 1, "q", (e) => at(e, { z: 0 }));
    h.eq([t3.duration, t3.easing, t3.params?.pace], [authored.duration, authored.easing, undefined], "the walk taken away again: back to the ordinary Change timing");
  }
  {
    const d = deck(img("a", "stack"));
    const t = capture(d, 1, "a", (e) => { e.view = { channels: [{ range: [100, 2000] }] }; });
    h.eq([t.duration, t.easing, t.params?.pace], [authored.duration, authored.easing, undefined], "a Change that walks nothing keeps the ordinary transform timing (authoredFields)");
    const t2 = capture(d, 1, "a", (e) => at(e, { z: 6 }));
    h.eq([t2.duration, t2.params?.pace], [Math.round(3 / 12 * 1000), 1], "…a walk added later to that still-default Change paces it (the default z is 3: 3 → 6)");
  }
  {
    const src = await fs.readFile("src/lib/slide/ops.ts", "utf8"), ta = await fs.readFile("src/shell/modes/slide/animator/trackActions.ts", "utf8");
    h.ok(/case "duration":[\s\S]{0,160}dropWalkPace\(t\)/.test(src), "the cascade's duration branch drops the pace");
    h.ok(/t\.duration = Math\.max\(50[^\n]*dropWalkPace\(t\)/.test(ta), "the timeline's Alt+Shift nudge drops the pace");
    const rect = { id: "r", type: "rect", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as unknown as Element;
    const d = deck(rect);
    const t = slideOps.writeStepState(d, "s", "b1", { ...rect, x: 50 } as Element, rect)!;
    h.eq([t.duration, t.easing, t.params], [authored.duration, authored.easing, undefined], "every other kind: writeStepState is exactly the old op");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("B. addImageWalk (Play through)");
  {
    const d = deck(img("a", "stack"), img("m", "movie"), img("f", "flat"));
    const w = (o: Partial<Parameters<typeof slideOps.addImageWalk>[1]>) => slideOps.addImageWalk(d, { slideId: "s", beatId: "b1", target: "a", fluximgManifest: lookup, ...o });
    let t = w({})!;
    h.eq([(t.to!.state!.view as { index: Record<string, number> }).index.z, t.duration, t.easing, t.params?.pace, t.start], [nz - 1, Math.round((nz - 1 - 3) / 12 * 1000), "linear", 1, 0], "default: depth, to the last plane, from where it stands (z 3), paced, start 0");
    const tm = slideOps.addImageWalk(d, { slideId: "s", beatId: "b1", target: "m", fluximgManifest: lookup })!;
    h.eq((tm.to!.state!.view as { index: Record<string, number> }).index.t, nt - 1, "an image with a time axis walks time");
    t = w({ to: 1, speed: 0.5, blend: true })!;
    h.ok(slideOf(d).beats[1].tracks.filter((x) => x.target === "a" && x.preset === "transform").length === 1, "a second Play through replaces the step's walk (one transform per target per step)");
    h.eq([(t.to!.state!.view as { index: Record<string, number> }).index.z, t.duration, t.params?.pace, t.params?.blend], [1, Math.round(2 / 12 * 1000 / 0.5), 0.5, true], "explicit end, half speed, blend");
    h.eq(slideOps.walkBlends(t), true, "walkBlends reads it");
    // The previous step's end is the start; from the last plane it walks back to the first.
    const d2 = deck(img("a", "stack"));
    slideOps.addImageWalk(d2, { slideId: "s", beatId: "b1", target: "a", fluximgManifest: lookup });
    const back = slideOps.addImageWalk(d2, { slideId: "s", beatId: "b2", target: "a", fluximgManifest: lookup })!;
    h.eq([(back.to!.state!.view as { index: Record<string, number> }).index.z, back.duration], [0, Math.round((nz - 1) / 12 * 1000)], "from the last plane (the previous step's end) it walks back to the first");
    // Joins the step's Change: its other changes are kept.
    const d3 = deck(img("a", "stack"));
    capture(d3, 1, "a", (e) => { e.view = { channels: [{ range: [100, 2000] }] }; e.x = 30; });
    const joined = slideOps.addImageWalk(d3, { slideId: "s", beatId: "b1", target: "a", fluximgManifest: lookup })!;
    const st = joined.to!.state as { view: { channels: unknown[]; index: Record<string, number> }; x: number };
    h.ok(st.x === 30 && JSON.stringify(st.view.channels) === JSON.stringify([{ range: [100, 2000] }]) && st.view.index.z === nz - 1, "it joins the step's Change: the contrast and the move are kept");
    h.eq(slideOps.addImageWalk(d, { slideId: "s", beatId: "b0", target: "a", fluximgManifest: lookup }), null, "Design: null (as Turntable)");
    throwsLike(() => w({ speed: 0 }), /positive speed/, "speed 0 refused");
    throwsLike(() => w({ start: -1 }), /nonnegative start/, "a negative start refused");
    throwsLike(() => w({ blend: "yes" as unknown as boolean }), /blend/, "blend must be a boolean");
    throwsLike(() => w({ dim: "t" }), /not a dimension/, "a dimension the image lacks refused");
    throwsLike(() => w({ to: nz }), /whole plane/, "an end outside the dimension refused");
    throwsLike(() => slideOps.addImageWalk(d, { slideId: "s", beatId: "b1", target: "f", fluximgManifest: lookup }), /no time, depth/, "a flat image has nothing to play through");
    throwsLike(() => slideOps.addImageWalk(d, { slideId: "s", beatId: "b1", target: "a" }), /not loaded/, "without its manifest it refuses (it cannot know the far end)");
    const d4 = deck(img("a", "stack", { view: { index: { z: 4 } } }));
    throwsLike(() => slideOps.addImageWalk(d4, { slideId: "s", beatId: "b1", target: "a", fluximgManifest: lookup, to: 4 }), /already stands/, "an end equal to where it stands refused");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("C. movie commands and playback settings");
  {
    const rect = { id: "r", type: "rect", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as unknown as Element;
    const d = deck(img("a", "stack"), img("f", "flat"), rect);
    h.ok(slideOps.setVideoTrack(d, "s", "b1", "a", "start", { fluximgManifest: lookup }), "Start on an image with a depth axis");
    h.eq(slideOf(d).beats[1].tracks.find((t) => t.target === "a")?.preset, "videoStart", "…writes the persisted videoStart preset (duration 0)");
    h.ok(slideOps.setVideoTrack(d, "s", "b2", "a", "pause", { fluximgManifest: lookup }) && slideOps.setVideoTrack(d, "s", "b2", "a", "stop", { fluximgManifest: lookup }), "Pause, then Stop at the same step (replaces: one media command per clip per step)");
    h.eq(slideOf(d).beats[2].tracks.filter((t) => t.target === "a").map((t) => t.preset), ["videoStop"], "one media command per target per step");
    h.ok(!slideOps.setVideoTrack(d, "s", "b1", "f", "start", { fluximgManifest: lookup }), "a flat image refuses (nothing to play)");
    h.ok(!slideOps.setVideoTrack(d, "s", "b0", "a", "start", { fluximgManifest: lookup }), "Design refuses");
    h.ok(!slideOps.setVideoTrack(d, "s", "b1", "r", "start"), "a rectangle refuses");
    h.ok(slideOps.setImagePlayback(d, "s", "a", { mode: "bounce", speed: 2 }, { fluximgManifest: lookup }), "setImagePlayback on an image");
    h.eq((slideOf(d).elements[0] as FluximgElement).playback, { dim: "z", mode: "bounce", speed: 2 }, "…starts from the default dimension and merges the patch");
    slideOps.setImagePlayback(d, "s", "a", { from: 2, to: 5, speed: null }, { fluximgManifest: lookup });
    h.eq((slideOf(d).elements[0] as FluximgElement).playback, { dim: "z", mode: "bounce", from: 2, to: 5 }, "a null field clears it (speed back to ×1)");
    throwsLike(() => slideOps.setImagePlayback(d, "s", "a", { to: nz + 1 }, { fluximgManifest: lookup }), /playback\.to/, "a range past the dimension refused");
    throwsLike(() => slideOps.setImagePlayback(d, "s", "a", { dim: "t" }, { fluximgManifest: lookup }), /not a dimension this image can play/, "a dimension the image lacks refused");
    throwsLike(() => slideOps.setImagePlayback(d, "s", "a", { speed: -1 }, { fluximgManifest: lookup }), /speed/, "a negative speed refused");
    throwsLike(() => slideOps.setImagePlayback(d, "s", "a", { fps: 0 }, { fluximgManifest: lookup }), /fps/, "fps 0 refused");
    h.eq((slideOf(d).elements[0] as FluximgElement).playback, { dim: "z", mode: "bounce", from: 2, to: 5 }, "a refused patch changes nothing");
    h.ok(!slideOps.setImagePlayback(d, "s", "r", { mode: "loop" }), "a rectangle has no playback");
    slideOps.setImagePlayback(d, "s", "a", null);
    h.ok((slideOf(d).elements[0] as FluximgElement).playback === undefined, "null clears the setting (the defaults again)");
    // The compiler's media rules
    const issues = (dd: Deck, opts = {}) => compileSlide(slideOf(dd), dd.stage, opts).issues.map((i) => `${i.target}:${i.reason}`);
    h.ok(!issues(d, { fluximgManifest: lookup }).some((i) => i.startsWith("a:")), "a movie command on an image with a dimension compiles clean");
    slideOf(d).beats[1].tracks.push({ id: "bad", target: "f", preset: "videoStart", duration: 0 }, { id: "bad2", target: "r", preset: "videoStart", duration: 0 });
    const got = issues(d, { fluximgManifest: lookup });
    h.ok(got.includes("f:Movie commands need an image with a time, depth or other dimension to play."), "a flat image: the movie reason");
    h.ok(got.includes("r:Video commands require a video clip target."), "a rectangle: the video reason, word for word as before");
    h.ok(!issues(d).some((i) => i.startsWith("f:")), "no manifest known: an image is let through (checked once it loads)");
    slideOf(d).beats[1].tracks.push({ id: "part", target: "a", part: "x", preset: "videoPause", duration: 0 });
    h.ok(issues(d, { fluximgManifest: lookup }).some((i) => i.startsWith("a:") && /whole clip/.test(i)), "every other rule holds (whole element)");
    // resolvePlayback / walkableDims
    h.eq(pb.walkableDims(TZ), ["t", "z"], "walkable: time first, then depth");
    h.eq(pb.walkableDims(FLAT), [], "a flat image walks nothing");
    const rp = pb.resolvePlayback(MOVIE, undefined)!;
    h.eq([rp.dim, rp.mode, rp.speed, rp.from, rp.to, rp.passMs], ["t", "loop", 1, 0, nt, nt * 12.5], "defaults: time, loop, ×1, the whole range, one pass in real time");
    h.eq(pb.resolvePlayback(MOVIE, { dim: "t", mode: "once", fps: 4, speed: 2, from: 2, to: 6 })!.passMs, 4 * 250 / 2, "fps sets the period; speed divides it");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("D. the media clock");
  {
    type Ev = import("../src/lib/slide/mediaTimeline").VideoEvent;
    const ev = (target: string, command: Ev["command"], at: number, order = 0): Ev => ({ target, command, at, order });
    const S = (events: Ev[], at: number, mode: "loop" | "bounce" | "once", planes = 5, pass = 500) => media.sampleImagePlayback(events, "a", at, pass, mode, planes);
    const start = [ev("a", "videoStart", 1000)];
    h.eq(S(start, 500, "loop"), { plane: 0, running: false, started: false }, "before Start: not started (the state's own plane)");
    h.eq([0, 99, 100, 250, 499, 500, 730].map((t) => S(start, 1000 + t, "loop").plane), [0, 0, 1, 2, 4, 0, 2], "loop: 100 ms a plane, wraps");
    h.eq([0, 100, 400, 500, 700, 800, 900].map((t) => S(start, 1000 + t, "bounce").plane), [0, 1, 4, 3, 1, 0, 1], "bounce: a triangle, the end planes not shown twice");
    h.eq([[0, true], [450, true], [499, true], [500, false], [2000, false]].map(([t]) => [S(start, 1000 + (t as number), "once").plane, S(start, 1000 + (t as number), "once").running]), [[0, true], [4, true], [4, true], [4, false], [4, false]], "once: clamps on the last plane and stops");
    const seq = [ev("a", "videoStart", 0), ev("a", "videoPause", 230, 1), ev("a", "videoStart", 1000, 2), ev("a", "videoStop", 1350, 3)];
    h.eq(S(seq, 600, "loop"), { plane: 2, running: false, started: true }, "Pause holds its plane");
    h.eq(S(seq, 1000, "loop"), { plane: 0, running: true, started: true }, "Start restarts at the range's first plane");
    h.eq(S(seq, 1349, "loop").plane, 3, "…and runs");
    h.eq(S(seq, 1400, "loop"), { plane: 0, running: false, started: false }, "Stop returns to the state's own plane");
    h.eq(S([ev("b", "videoStart", 0)], 300, "loop").started, false, "another target's events are not this image's");
    // Seeded random event lists
    let seed = 12345;
    const R = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000);
    let ok = true, same = true, fold = true;
    for (let n = 0; n < 400; n++) {
      const list: Ev[] = []; let t = 0;
      for (let k = 0; k < 6; k++) { t += Math.floor(R() * 900); list.push(ev(R() < 0.8 ? "a" : "b", (["videoStart", "videoPause", "videoStop"] as const)[Math.floor(R() * 3)], t, k)); }
      const planes = 2 + Math.floor(R() * 30), pass = 100 + Math.floor(R() * 3000), mode = (["loop", "bounce", "once"] as const)[Math.floor(R() * 3)];
      for (let q = 0; q < 12; q++) {
        const atMs = Math.floor(R() * (t + 3000));
        const a = media.sampleImagePlayback(list, "a", atMs, pass, mode, planes), b = media.sampleImagePlayback(list, "a", atMs, pass, mode, planes);
        if (JSON.stringify(a) !== JSON.stringify(b)) same = false;
        if (!(a.plane >= 0 && a.plane < planes && Number.isInteger(a.plane)) || (!a.started && a.plane !== 0)) ok = false;
        const v = media.sampleVideo(list, "a", atMs, 0, false);
        if (v.started !== a.started || (mode !== "once" && v.running !== a.running)) fold = false;
        if (a.started && mode === "loop" && a.plane !== Math.floor(v.timeMs / (pass / planes) + 1e-9) % planes) fold = false;
      }
    }
    h.ok(same, "deterministic: the same events and time give the same answer");
    h.ok(ok, "2,400 random samples: a whole plane inside the range; not started = plane 0");
    h.ok(fold, "the same fold as the video clock: started / running agree, a loop's plane is the video's position over the period");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("E. withIndex and dropViewChange");
  {
    const plan = vt.planViewTween(STACK, { view: { index: { z: 0 } } }, { view: { index: { z: 6 }, channels: [{ visible: false }] } });
    const f = plan.frame(0.5, 0.5);
    const g = vt.withIndex(f, "z", 2);
    h.ok(g !== f && g.a.view.index.z === 2 && g.a.view.channels === f.a.view.channels && g.a.crop === f.a.crop, "withIndex: a new frame, the plane replaced, everything else shared");
    h.ok(!!f.b && g.b!.view.index.z === 2 && (f.overlay === f.a ? g.overlay === g.a : g.overlay === g.b), "…in both pictures, and the overlay is still one of them");
    h.ok(f.a.view.index.z !== 2, "the shared frame is never mutated");
    h.ok(vt.withIndex(g, "z", 2) === g, "the same plane again: the frame itself");
    const bl = vt.planViewTween(STACK, { view: { index: { z: 0 } } }, { view: { index: { z: 6 } } }, { blend: true }).frame(0.3, 0.3);
    h.ok(!!bl.blend && vt.withIndex(bl, "z", 4).blend === null, "a crossfade along the movie's dimension is dropped");
    const pre = { view: { index: { z: 1 }, channels: [{ range: [10, 100] as [number, number] }] }, crop: { x: 0, y: 0, width: 32, height: 24 } };
    const end = { view: { index: { z: 5 }, channels: [{ range: [20, 300] as [number, number], color: "#00ffff", visible: false }, { visible: false }], projection: null, composite: "single" as const, solo: 1, background: "#202020", layers: {}, furniture: { scalebar: {} }, smooth: true, layerOrder: [] }, crop: { x: 8, y: 6, width: 16, height: 12 } };
    const all = vt.describeViewChange(STACK, pre, end);
    h.ok(all.length >= 7, `the end changes ${all.length} aspects: ${all.map((c) => c.label).join(" · ")}`);
    let every = true;
    for (const c of all) {
      const back = vt.dropViewChange(pre, end, c, STACK);
      const rest = vt.describeViewChange(STACK, pre, back).map((x) => x.label);
      const want = all.filter((x) => x !== c).map((x) => x.label);
      if (JSON.stringify(rest) !== JSON.stringify(want)) { every = false; h.fail(`dropping "${c.label}" left ${JSON.stringify(rest)}`); }
    }
    h.ok(every, `dropping each of the ${all.length} aspects puts back exactly that one (position, frame, channel, window, colour, background, furniture, other)`);
    const sparse = vt.describeViewChange(undefined, { view: { layers: { L: { visible: true, opacity: 0.4 } } } }, { view: { layers: { L: { visible: false, opacity: 0.9 } } } });
    const keepOne = vt.dropViewChange({ view: { layers: { L: { visible: true, opacity: 0.4 } } } }, { view: { layers: { L: { visible: false, opacity: 0.9 } } } }, sparse[0]);
    h.eq(keepOne.view, { layers: { L: { visible: true, opacity: 0.9 } } }, "a layer's switch and its style are separate aspects (no manifest)");
    h.eq(vt.dropViewChange(pre, end, { kind: "other", label: "nothing like it" }, STACK), end, "an entry that is not one of them changes nothing");
    h.eq(vt.longestWalk(STACK, pre, end), { dim: "z", from: 1, to: 5 }, "longestWalk");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("F. the schema: playback");
  {
    const d = deck(img("a", "stack", { playback: { dim: "z", mode: "bounce", speed: 2, from: 1, to: 6 } }));
    d.schemaVersion = deckSchemaFor(d);
    const json = JSON.parse(JSON.stringify(d));
    h.eq(validateDeckFile(json), [], "a deck whose image has playback validates");
    h.eq(json.slides[0].elements[0].playback, { dim: "z", mode: "bounce", speed: 2, from: 1, to: 6 }, "it round-trips");
    for (const [bad, what] of [[{ dim: "z", mode: "spin" }, "an unknown mode"], [{ mode: "loop" }, "no dim"], [{ dim: "z", mode: "loop", speed: 0 }, "speed 0"], [{ dim: "z", mode: "loop", fps: -2 }, "negative fps"], [{ dim: "z", mode: "loop", from: 1.5 }, "a fractional plane"], [{ dim: "z", mode: "loop", loop: true }, "an unknown key"]] as const) {
      const x = structuredClone(json); x.slides[0].elements[0].playback = bad;
      h.ok(validateDeckFile(x).length > 0, `refused: ${what}`);
    }
    h.eq(pb.playbackProblems(STACK, { dim: "z", mode: "loop", from: 3, to: 3 }).length, 1, "playbackProblems: an empty range");
    h.eq(pb.playbackProblems(STACK, { dim: "z", mode: "loop", from: 0, to: nz }), [], "…the whole range is fine");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("G. headless: set-image-view --speed / --blend / --playback, set-video-track on an image");
  {
    await core.createDeck(root, { id: "talk", title: "Talk" });
    const slideId = (await slidesCore.loadDeck(root, "talk")).slides[0].id;
    const b1 = (await slidesCore.addBeat(root, "talk", slideId, {})).beatId, b2 = (await slidesCore.addBeat(root, "talk", slideId, {})).beatId;
    const placed = await call("place_image", { figureId: `talk/${slideId}`, bundlePath: "plots/movie_f32.fluximg" });
    const flat = await call("place_image", { figureId: `talk/${slideId}`, bundlePath: "plots/gray2d_u8.fluximg", x: 200 });
    const readDeck = async (): Promise<Deck> => JSON.parse(await fs.readFile(path.join(root, "slides/talk/deck.json"), "utf8"));
    const where = `talk/${slideId}`;
    await call("set_image_view", { id: placed.elementId, view: { index: { t: 20 } }, slide: where, beatId: b1 });
    let t = (await readDeck()).slides[0].beats[1].tracks.find((x) => x.target === placed.elementId)!;
    h.eq([t.duration, t.easing, t.params?.pace], [250, "linear", 1], "set-image-view --beat walks in real time: the pace rule, from the one op");
    await call("set_image_view", { id: placed.elementId, slide: where, beatId: b1, speed: 0.5, blend: true });
    t = (await readDeck()).slides[0].beats[1].tracks.find((x) => x.target === placed.elementId)!;
    h.eq([t.duration, t.params?.pace, t.params?.blend], [500, 0.5, true], "--speed 0.5 --blend (no view): the step's walk re-timed and blended");
    await refuses("set_image_view", { id: placed.elementId, slide: where, speed: 2 }, /--speed and --blend time a step/, "--speed without --beat is refused");
    await refuses("set_image_view", { id: placed.elementId, slide: where, beatId: b2, blend: true }, /does not change the image/, "--blend on a step that does not change it is refused");
    await refuses("set_image_view", { id: placed.elementId, slide: where, beatId: b1, speed: 40 }, /at most 16/, "a speed past 16 is refused");
    await call("set_image_view", { id: placed.elementId, slide: where, playback: { dim: "t", mode: "bounce", speed: 2 } });
    h.eq(((await readDeck()).slides[0].elements.find((e) => e.id === placed.elementId) as FluximgElement).playback, { dim: "t", mode: "bounce", speed: 2 }, "--playback sets the Design-level setting");
    await refuses("set_image_view", { id: placed.elementId, slide: where, playback: { dim: "z", mode: "loop" } }, /does not fit/, "--playback on a dimension the image lacks is refused");
    await refuses("set_image_view", { id: placed.elementId, playback: { dim: "t", mode: "loop" } }, /on a slide/, "--playback on a figure is refused");
    await call("set_video_track", { deckId: "talk", slideId, beatId: b2, target: placed.elementId, action: "start" });
    h.eq((await readDeck()).slides[0].beats[2].tracks.find((x) => x.target === placed.elementId)?.preset, "videoStart", "set-video-track starts an image's movie");
    await refuses("set_video_track", { deckId: "talk", slideId, beatId: b2, target: flat.elementId, action: "start" }, /no time, depth/, "set-video-track on a flat image is refused");
    // The same through the CLI (the verb's own flags)
    const repo = process.cwd(), env = { ...process.env, FLUX_NO_MIGRATE: "1", HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, "xdg") };
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "flux-cli.ts", ...args, "--root", root], { cwd: repo, encoding: "utf8", env, timeout: 90000 });
    const c1 = run("set-image-view", placed.elementId, "--slide", where, "--beat", b1, "--speed", "2", "--blend", "false");
    t = (await readDeck()).slides[0].beats[1].tracks.find((x) => x.target === placed.elementId)!;
    h.ok(c1.status === 0 && t.duration === 125 && t.params?.pace === 2 && t.params?.blend === undefined, `CLI set-image-view --speed 2 --blend false (${(c1.stderr || "").trim().split("\n")[0]})`);
    const c2 = run("set-image-view", placed.elementId, "--slide", where, "--playback", JSON.stringify({ dim: "t", mode: "once", from: 2, to: 10 }));
    h.ok(c2.status === 0 && JSON.stringify(((await readDeck()).slides[0].elements.find((e) => e.id === placed.elementId) as FluximgElement).playback) === JSON.stringify({ dim: "t", mode: "once", speed: 2, from: 2, to: 10 }), "CLI --playback merges over the stored setting");
    const c3 = run("set-video-track", "talk", slideId, b2, placed.elementId, "pause");
    h.ok(c3.status === 0 && (await readDeck()).slides[0].beats[2].tracks.find((x) => x.target === placed.elementId)?.preset === "videoPause", "CLI set-video-track pause on an image");
    const c4 = run("set-video-track", "talk", slideId, b2, flat.elementId, "start");
    h.ok(c4.status !== 0 && /no time, depth/.test(c4.stderr), "CLI refuses a flat image with the reason");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("H. a deck without images: byte-identical compile output and media clock");
  {
    const BASE: Record<string, string> = {
      talk: "42073a9bfc367ba4c8040028d990ceb3ca72b09b40f59ce8a8d86ba3e20e3ffc",
      "ghost-disappear": "a1cca8d7b82d0a8d788ff4c21113e7687853cac8ce9a46a9904143908f079568",
      vid: "4daf2262755f079dc5c3b72e24f7f1278f54c92764dae99055511f4497741720",
    };
    for (const d of decksWithoutImages()) h.eq(deckDigest(d), BASE[d.id], `${d.id}: cues, issues, samples, video events, content end, audio and the clock as on the base`);
    const v = decksWithoutImages()[2];
    h.ok(!media.videoEvents(v.slides[0], (b) => b * 1000).some((e) => !["v", "w"].includes(e.target)), "the video deck's events name only its clips");
  }
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
await h.done();
