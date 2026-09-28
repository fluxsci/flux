// Geometric camera paths through the public compiler and the real player.
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import type { Camera, Slide, Track } from "../src/lib/slide/types";
const h = harness("verify-slide-camera");
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document });
const { createPlayer, computeSlideAnims, disposeSlideAnims } = await import("../src/lib/slide/player/player");
const { renderSlide } = await import("../src/lib/slide/player/render");
const { compileSlide } = await import("../src/lib/slide/compile");
const { createDeck } = await import("../src/lib/slide/ops");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
const stage = { width: 640, height: 360 }, opts = { theme: FLUX_DARK, reducedMotion: true };
const a = { x: 320, y: 180, zoom: 1 }, b = { x: 400, y: 230, zoom: 2 };
const project = (c: Camera, x: number, y: number) => [stage.width / 2 + (x - c.x) * c.zoom, stage.height / 2 + (y - c.y) * c.zoom];
function livePose(host: HTMLElement): Camera {
  const value = (host.querySelector(".sl-camera") as HTMLElement).style.transform;
  const n = value.match(/-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [0, 0, 1];
  return { x: (stage.width / 2 - n[0]) / n[2], y: (stage.height / 2 - n[1]) / n[2], zoom: n[2] };
}
function fixture(from = a, to: Track["to"] = b): Slide {
  return { id: "camera", camera: from, elements: [], beats: [{ id: "base", tracks: [] },
    { id: "zoom", tracks: [{ id: "cam", target: "@camera", preset: "camera", to, duration: 1000, easing: "linear" }] }] };
}
function mounted(slide: Slide, reducedMotion = true) {
  const host = document.createElement("div") as unknown as HTMLElement;
  const deck = createDeck({ stage, withTitleSlide: false }); deck.slides = [slide];
  return { host, player: createPlayer(host, deck, { ...opts, reducedMotion }) };
}
function error(a: Camera, b: Camera): number {
  return Math.max(...[[0, 0], [640, 360], [320, 180]].map(([x, y]) => {
    const p = project(a, x, y), q = project(b, x, y);
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  }));
}

h.section("T7: compiler and player (old code disagrees by 23.58 px at 500 ms)");
const slide = fixture(), compiled = compileSlide(slide, stage), { host, player } = mounted(slide);
for (let i = 1; i <= 20; i++) {
  const ms = i * 1000 / 21;
  player.seek(0, 1, ms);
  const delta = error(compiled.sample(1, ms).camera!, livePose(host));
  h.ok(delta < .5, `real sample()/createPlayer at ${ms.toFixed(2)} ms: ${delta.toFixed(6)} px < 0.5`);
}
player.seek(0, 1, 500);
h.ok(error(compiled.sample(1, 500).camera!, livePose(host)) < .5, "pinned T7 midpoint parity fixture");
player.destroy();

let camera: typeof import("../src/lib/slide/camera") | undefined;
try { camera = await import("../src/lib/slide/camera"); } catch { h.fail("shared camera sampler exists"); }
if (!camera) await h.done();
const { sampleCamera, flyDuration } = camera!;
const core = await import("../flux-core/index");
h.ok(core.sampleCamera === sampleCamera && core.flyDuration === flyDuration, "flux-core exports the one sampler and duration function");

h.section("pole, log zoom, exact endpoints and output reuse");
// A world point whose image is unchanged by the endpoint similarity.
const pole = { x: (b.x * b.zoom - a.x * a.zoom) / (b.zoom - a.zoom), y: (b.y * b.zoom - a.y * a.zoom) / (b.zoom - a.zoom) };
const fixed = project(a, pole.x, pole.y), out = { ...a };
for (let i = 0; i <= 10; i++) {
  const u = i / 10, pose = sampleCamera(a, b, u, stage, "pole", out), point = project(pose, pole.x, pole.y);
  h.ok(pose === out, `u=${u}: caller's output is reused`);
  h.ok(Math.hypot(point[0] - fixed[0], point[1] - fixed[1]) < 1e-6, `u=${u}: pole fixed within 1e-6 px`);
  h.ok(Math.abs(Math.log(pose.zoom) - (Math.log(a.zoom) + u * Math.log(b.zoom / a.zoom))) < 1e-12, `u=${u}: log zoom linear`);
}
for (const path of ["pole", "fly"] as const) {
  h.eq(sampleCamera(a, b, 0, stage, path), a, `${path}: exact initial pose`);
  h.eq(sampleCamera(a, b, 1, stage, path), b, `${path}: exact final pose`);
  for (const u of [-.1, 1.1]) h.ok(sampleCamera(a, b, u, stage, path).zoom > 0, `${path}: overshoot u=${u} stays positive`);
}
const panA = { x: 120, y: 90, zoom: 2 }, panB = { x: 360, y: 210, zoom: 2 };
for (const [u, x, y] of [[0, 120, 90], [.25, 180, 120], [.5, 240, 150], [.75, 300, 180], [1, 360, 210]]) {
  h.eq(sampleCamera(panA, panB, u, stage), { x, y, zoom: 2 }, `pure pan u=${u}: pinned pre-M5 numbers`);
}
const tiny = { ...b, zoom: a.zoom * Math.exp(.00001) };
h.eq(sampleCamera(a, tiny, .5, stage).x, 360, "near-unit zoom ratio takes the linear-pan branch");
const far = { ...a, x: a.x + 4000 };
const flyMid = sampleCamera(a, far, .5, stage, "fly");
h.ok(flyMid.zoom < sampleCamera(a, far, .25, stage, "fly").zoom && flyMid.zoom < a.zoom, "long Fly's width peaks at mid-flight");
h.ok(Math.abs(flyMid.x - (a.x + far.x) / 2) < 1e-8, "symmetric Fly passes through centre");
const zoomOnly = { ...a, zoom: 4 };
h.ok(Math.abs(sampleCamera(a, zoomOnly, .5, stage, "fly").zoom - 2) < 1e-12, "Fly's zero-distance branch zooms geometrically");
h.ok(Math.abs(flyDuration(a, zoomOnly, stage) - Math.log(4) / Math.SQRT2) < 1e-12, "Fly duration is positive natural S in seconds, including zoom-in");
h.eq(flyDuration(a, a, stage), 0, "stationary Fly has zero natural duration");
h.ok(Math.abs(flyDuration(a, far, stage) - flyDuration(far, a, stage)) < 1e-12, "Fly duration is symmetric");

h.section("24 keyframes, Fly and chained/random seeks");
const renderHost = document.createElement("div") as unknown as HTMLElement;
const rendered = renderSlide(renderHost, slide, stage, opts);
const specs = computeSlideAnims(slide, rendered, renderHost, stage, opts);
h.eq(specs[0].keyframes.length, 24, "real camera preset emits 24 transform keyframes");
h.ok(specs[0].keyframes.every((frame, i) => frame.offset === i / 23 && "transform" in frame && !frame.easing), "uniform geometric samples, time easing stays on track");
disposeSlideAnims(specs);
for (const path of ["pole", "fly"] as const) {
  const chain = fixture(a, { ...b, path });
  chain.beats.push({ id: "return", tracks: [{ id: "back", target: "@camera", preset: "camera", to: { ...a, path }, duration: 1000, easing: "smooth" }] });
  const plan = compileSlide(chain, stage), { host, player } = mounted(chain);
  for (const beat of [2, 1, 2]) for (let i = 0; i <= 20; i++) {
    const ms = i * 50;
    player.seek(0, beat, ms);
    h.ok(error(plan.sample(beat, ms).camera!, livePose(host)) < .5, `${path} chained seek ${beat}:${ms} compiler/player < 0.5 px`);
  }
  player.destroy();
}

h.section("FROM is read from the live layer at play time");
const callbacks = new Map<number, FrameRequestCallback>(); let serial = 0;
Object.assign(globalThis, { requestAnimationFrame: (fn: FrameRequestCallback) => { callbacks.set(++serial, fn); return serial; }, cancelAnimationFrame: (id: number) => callbacks.delete(id) });
const live = mounted(fixture(), false), changed = { x: 290, y: 160, zoom: 1.2 };
(live.host.querySelector(".sl-camera") as HTMLElement).style.transform = `translate(${320 - changed.x * changed.zoom}px, ${180 - changed.y * changed.zoom}px) scale(${changed.zoom})`;
live.player.goTo(0, 1, { animate: true });
h.ok(error(changed, livePose(live.host)) < 1e-8, "play's frame zero preserves the live pose");
const queued = [...callbacks.values()][0]; callbacks.clear();
queued(performance.now() + 500);
const progress = live.player.state().time / 1000;
h.ok(error(sampleCamera(changed, b, progress, stage), livePose(live.host)) < .5, "intermediate keyframes rebuilt from live FROM");
live.player.seek(0, 1, 500);
h.ok(error(compiled.sample(1, 500).camera!, livePose(live.host)) < .5, "random seek restores canonical camera path after a live play");
live.player.destroy();
h.eq(callbacks.size, 0, "no animation callbacks after teardown");

h.section("a camera rebase at play start keeps hand-off controllers alive");
// Integration seam (M5 over C2): rebasing camera frames drops cached samplers
// and native bindings only. A hand-off controller disposed here removes its
// flight layer and visibility claims for the rest of the slide.
{
  const { addSlide, addElement, addBeat, setTransform } = await import("../src/lib/slide/ops");
  const deck = createDeck({ stage, withTitleSlide: false });
  const withFlight = addSlide(deck, { id: "flight", layout: "blank" });
  const pathEl = (id: string, x: number) => ({ id, type: "path" as const, x, y: 60, width: 180, height: 120, rotation: 0, d: "M0 120 L90 0 L180 120", closed: false, fill: "none", stroke: "#4169e1", strokeWidth: 4, nodes: [{ x: 0, y: 120, type: "corner" as const }, { x: 90, y: 0, type: "corner" as const }, { x: 180, y: 120, type: "corner" as const }] });
  addElement(deck, withFlight.id, pathEl("source", 40)); addElement(deck, withFlight.id, pathEl("dest", 400));
  const beat = addBeat(deck, withFlight.id, { id: "flight-beat" })!;
  setTransform(deck, withFlight.id, beat.id, "source", { state: {}, duration: 1000, easing: "linear" });
  beat.tracks.find(t => t.target === "source")!.to!.become = { mode: "handoff", ref: { element: "dest" } };
  beat.tracks.push({ id: "flight-cam", target: "@camera", preset: "camera", to: b, duration: 1000, easing: "linear" });
  h.eq(compileSlide(withFlight, stage).handoffs.length, 1, "fixture: the compiler accepts the hand-off beside the camera move");
  const host = document.createElement("div") as unknown as HTMLElement;
  deck.slides = [withFlight];
  const player = createPlayer(host, deck, { ...opts, reducedMotion: false });
  const dest = () => (host.querySelector('[data-el-id="dest"]') as HTMLElement).style.visibility;
  h.eq([host.querySelectorAll(".sl-flight .sl-handoff").length, dest()], [1, "hidden"], "before play: one hand-off layer, destination hidden");
  (host.querySelector(".sl-camera") as HTMLElement).style.transform = `translate(${320 - changed.x * changed.zoom}px, ${180 - changed.y * changed.zoom}px) scale(${changed.zoom})`;
  player.goTo(0, 1, { animate: true });
  h.ok(error(changed, livePose(host)) < 1e-8, "the camera rebased from the live pose (the seam's trigger)");
  h.eq(host.querySelectorAll(".sl-flight .sl-handoff").length, 1, "the hand-off's flight layer survives the camera rebase");
  h.eq(dest(), "hidden", "the destination stays hidden at the hand-off's start (its visibility claim survives)");
  callbacks.clear();
  player.seek(0, 1, 0);
  h.ok(error(compileSlide(withFlight, stage).sample(1, 0).camera!, livePose(host)) < 1e-8, "a random seek after the live play restores the compiled FROM (second trigger)");
  h.eq([host.querySelectorAll(".sl-flight .sl-handoff").length, dest()], [1, "hidden"], "the restoring seek keeps the hand-off layer and its hidden destination");
  player.destroy();
}
await h.done();
