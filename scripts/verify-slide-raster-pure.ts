// WP 1.8 (T7) pure gate: raster-keeper decision logic and constants, headless inertness (linkedom has no rAF/window),
// corner-join policy, camera-zoom detection (slideZoomsCamera), exact camera sampling in CAPTURE at 10x. The browser/Electron
// halves (real re-bakes, energy against a fresh render, colour) live in verify-slide-raster-electron.cjs.
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import type { Camera, Slide, Track } from "../src/lib/slide/types";
const h = harness("verify-slide-raster-pure");
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document });
const { needsBake, bakeKey, shouldBake, MAX_BAKE_NODES, withinBakeTolerance } = await import("../src/lib/slide/player/rasterKeeper");
const { cornerJoinOf, morphJoin, pairJoin } = await import("../src/lib/strokeStyle");
const { elementStageOutlines } = await import("../src/lib/slide/targetGeometry");
const { slideZoomsCamera, sampleCamera } = await import("../src/lib/slide/camera");
const { createPlayer } = await import("../src/lib/slide/player/player");
const { createDeck } = await import("../src/lib/slide/ops");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
const stage = { width: 640, height: 360 }, opts = { theme: FLUX_DARK, reducedMotion: true };

h.section("keeper decisions (pure)");
h.ok(!needsBake(null, "a"), "first look never bakes");
h.ok(!needsBake("a", "a") && needsBake("a", "b"), "bake iff the key changed");
const k0 = bakeKey("translate(0px, 0px) scale(1)", 2, 1);
h.ok(k0 !== bakeKey("translate(1px, 0px) scale(1)", 2, 1) && k0 !== bakeKey("translate(0px, 0px) scale(1)", 2.0001, 1) && k0 !== bakeKey("translate(0px, 0px) scale(1)", 2, 2), "key covers pose, host scale (1e-4) and dpr");
h.ok(MAX_BAKE_NODES === 30000, "live node ceiling pinned");
{
  const k = (pose: string, host = 2, dpr = 1) => bakeKey(pose, host, dpr);
  h.ok(withinBakeTolerance(k("translate(-910px, -345px) scale(3)"), k("translate(-910.8px, -345.9px) scale(2.99)")), "a raster baked within 1 % zoom and 1.5 px of the pose is the same raster (the early bake of a flight 99.5 % home)");
  h.ok(!withinBakeTolerance(k("translate(-910px, -345px) scale(3)"), k("translate(-880px, -345px) scale(3)")), "a 30 px camera offset is a different raster");
  h.ok(!withinBakeTolerance(k("translate(0px, 0px) scale(3)"), k("translate(0px, 0px) scale(2.5)")), "a 17 % zoom is a different raster");
  h.ok(!withinBakeTolerance(k("translate(0px, 0px) scale(3)", 2), k("translate(0px, 0px) scale(3)", 2.5)) && !withinBakeTolerance(k("translate(0px, 0px) scale(3)", 2, 1), k("translate(0px, 0px) scale(3)", 2, 2)), "host scale and dpr changes always re-bake");
  h.ok(!needsBake(k("translate(-910px, -345px) scale(3)"), k("translate(-910.4px, -345.2px) scale(3.001)"), true) && needsBake(k("translate(-910px, -345px) scale(3)"), k("translate(-900px, -345px) scale(3)"), true), "needsBake honours the tolerance when asked (live)");
  h.ok(needsBake(k("translate(-910px, -345px) scale(3)"), k("translate(-910.4px, -345.2px) scale(3.001)")) && shouldBake(k("translate(-910px, -345px) scale(3)"), k("translate(-910.4px, -345.2px) scale(3.001)"), 10, true), "capture is exact: any pose change re-bakes");
}
h.ok(shouldBake("a", "b", 30000, false) && !shouldBake("a", "b", 30001, false), "live re-bake refused above 30 000 nodes");
h.ok(shouldBake("a", "b", 1e6, true) && !shouldBake("a", "a", 0, true), "capture ignores the ceiling, still needs a changed key");

h.section("headless players: the keeper is inert (linkedom has no rAF/window)");
{
  const deck = createDeck({ stage, withTitleSlide: false });
  deck.slides = [{ id: "s", camera: { x: 320, y: 180, zoom: 2 }, elements: [], beats: [{ id: "b0", tracks: [] }] } as unknown as Slide];
  const host = document.createElement("div") as unknown as HTMLElement;
  const player = createPlayer(host, deck, opts);
  await new Promise((r) => setTimeout(r, 200));
  h.eq(player.rasterBakes(), 0, "no bake, no throw 200 ms after a paint under linkedom");
  await player.settleRaster();
  player.destroy();
}

h.section("join policy");
h.eq([cornerJoinOf({ type: "rect" }), cornerJoinOf({ type: "path" }), cornerJoinOf({ type: "ellipse" }), cornerJoinOf({ type: "line" }), cornerJoinOf({ type: "text" })], ["miter", "round", null, null, null], "only corner-bearing kinds carry a join");
h.eq([morphJoin({ type: "rect" }, { type: "ellipse" }, 0), morphJoin({ type: "rect" }, { type: "ellipse" }, 0.49), morphJoin({ type: "rect" }, { type: "ellipse" }, 0.5), morphJoin({ type: "rect" }, { type: "ellipse" }, 1)], ["miter", "miter", "miter", "miter"], "rect -> ellipse never switches (ellipse inherits)");
h.eq([morphJoin({ type: "rect" }, { type: "path" }, 0.49), morphJoin({ type: "rect" }, { type: "path" }, 0.5)], ["miter", "round"], "rect -> path switches once at the midpoint");
h.eq([morphJoin({ type: "ellipse" }, { type: "line" }, 0.2), morphJoin({ type: "text" }, { type: "ellipse" }, 0.9)], ["round", "round"], "no corners on either side falls back to round");
// Release-1 integration: the hand-off / glyph flights read the resting join from the outline paint (pairJoin, same law)
h.eq([pairJoin("miter", undefined, 0.2), pairJoin("miter", undefined, 0.8), pairJoin("miter", "round", 0.49), pairJoin("miter", "round", 0.5), pairJoin(undefined, undefined, 0.3)],
  ["miter", "miter", "miter", "round", "round"], "pairJoin: the side just left wins, a side without corners inherits, round if neither");
{
  const base = { x: 10, y: 10, width: 80, height: 40, rotation: 0, stroke: "#100f0f", strokeWidth: 4, fill: "none" };
  const join = (el: Record<string, unknown>) => elementStageOutlines(el as never)[0]?.paint.join;
  h.eq([join({ ...base, id: "r", type: "rect", cornerRadius: 0 }), join({ ...base, id: "e", type: "ellipse" }),
    join({ ...base, id: "p", type: "path", d: "M 0 0 L 80 40", closed: false })], ["miter", undefined, "round"],
    "stage outlines carry the resting join of corner kinds only (ellipse outlines stay byte-identical)");
}

h.section("camera zoom detection");
const cam = (to: Track["to"]): Slide => ({ id: "c", elements: [], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id: "t", target: "@camera", preset: "camera", to, duration: 900 } as Track] }] }) as Slide;
h.ok(!slideZoomsCamera(cam({ x: 400, y: 230, zoom: 1 })), "pure pan does not zoom");
h.ok(slideZoomsCamera(cam({ x: 320, y: 180, zoom: 2.5 })), "zoom detected");
h.ok(slideZoomsCamera(cam({ x: 600, y: 230, zoom: 1, path: "fly" })), "Fly zooms out and in");
h.ok(!slideZoomsCamera({ camera: { zoom: 2 }, ...cam({ x: 1, y: 1, zoom: 2 }) } as Slide), "same zoom as the base camera is a pan");
h.ok(!slideZoomsCamera({ elements: [], beats: [{ id: "b0", tracks: [] }] } as unknown as Slide), "no camera track");
h.ok(slideZoomsCamera({ id: "c", elements: [], beats: [{ id: "b0", tracks: [{ id: "t", target: "@stage", preset: "camera", to: { x: 320, y: 180, zoom: 2.5 }, duration: 900 } as Track] }] } as Slide), "@stage resolves to the camera layer, so its zoom counts too");

h.section("C1b: a pure pan never clears the camera's compositor hint (the keeper is inert here, so only applyAt could)");
{
  const deck = createDeck({ stage, withTitleSlide: false });
  deck.slides = [{ id: "s", camera: { x: 320, y: 180, zoom: 2 }, elements: [], beats: [{ id: "b0", tracks: [] },
    { id: "b1", tracks: [{ id: "t", target: "@camera", preset: "camera", to: { x: 400, y: 200, zoom: 2 }, duration: 1000, easing: "linear" }] }] } as unknown as Slide];
  const host = document.createElement("div") as unknown as HTMLElement, player = createPlayer(host, deck, opts);
  const camLayer = host.querySelector(".sl-camera") as HTMLElement, seen = [camLayer.style.willChange];
  for (const ms of [0, 300, 600, 999, 1000]) { player.seek(0, 1, ms); seen.push(camLayer.style.willChange); }
  h.eq([...new Set(seen)], ["transform"], "will-change stays transform before, during and after a pure camera pan");
  player.destroy();
}

h.section("exact camera sampling in capture at 10x (the 24-chord polyline was 5.5 stage px off)");
{
  const a: Camera = { x: 320, y: 180, zoom: 1 }, b: Camera = { x: 400, y: 230, zoom: 10 };
  const slide = { id: "z", camera: a, elements: [], beats: [{ id: "base", tracks: [] }, { id: "zoom", tracks: [{ id: "cam", target: "@camera", preset: "camera", to: b, duration: 1000, easing: "linear" }] }] } as Slide;
  const deck = createDeck({ stage, withTitleSlide: false }); deck.slides = [slide];
  const worstError = (captureMode: boolean): number => {
    const host = document.createElement("div") as unknown as HTMLElement;
    const player = createPlayer(host, deck, { ...opts, captureMode });
    let worst = 0;
    for (let i = 1; i <= 40; i++) {
      const ms = i * 1000 / 41; player.seek(0, 1, ms);
      const n = (host.querySelector(".sl-camera") as HTMLElement).style.transform.match(/-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
      const want = sampleCamera(a, b, ms / 1000, stage), z = want.zoom, tx = stage.width / 2 - want.x * z, ty = stage.height / 2 - want.y * z;
      worst = Math.max(worst, Math.hypot(n[0] - tx, n[1] - ty), Math.abs(n[2] - z) * 100);
    }
    player.destroy();
    return worst;
  };
  const capture = worstError(true), live = worstError(false);
  h.ok(capture < 1e-3, `captureMode camera transform == sampleCamera for 40 u values at 10x (worst ${capture.toExponential(2)} stage px)`);
  h.ok(live > 0.5, `the live player keeps its 24 chords (ruling; worst ${live.toFixed(2)} stage px), so captureMode is what makes the difference`);
  // seek purity: forward, reverse and shuffled seeks land on the same transform (the player seeks backwards and skips)
  const host = document.createElement("div") as unknown as HTMLElement, player = createPlayer(host, deck, { ...opts, captureMode: true });
  const at = (ms: number): string => { player.seek(0, 1, ms); return (host.querySelector(".sl-camera") as HTMLElement).style.transform; };
  const times = [0, 100, 250, 400, 650, 800, 990], forward = times.map(at), reverse = [...times].reverse().map(at).reverse(), shuffled = new Map<number, string>();
  for (const ms of [650, 100, 990, 0, 400, 800, 250]) shuffled.set(ms, at(ms));
  h.eq(reverse, forward, "capture camera sampling: reverse seeks == forward seeks");
  h.eq(times.map((ms) => shuffled.get(ms)), forward, "capture camera sampling: shuffled seeks == forward seeks");
  player.destroy();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The keeper's rAF / will-change protocol against a scripted frame clock and a fake layer (no browser): the sequence of hint writes,
// the debounce, the immediate end-of-flight bake, the node ceiling, cancel, dispose and the capture settle timeout.
h.section("raster keeper protocol (scripted frames)");
{
  const g = globalThis as unknown as Record<string, unknown>;
  const savedRaf = g.requestAnimationFrame, savedWindow = g.window;
  let stalled = false, queue: (() => void)[] = [];
  const drain = () => { const run = queue; queue = []; for (const cb of run) cb(); };
  g.requestAnimationFrame = (cb: () => void) => { queue.push(cb); if (!stalled) setTimeout(drain, 2); return queue.length; };
  g.window = { devicePixelRatio: 1 };
  const { createRasterKeeper, SETTLE_TIMEOUT_MS, BAKE_DEBOUNCE_MS } = await import("../src/lib/slide/player/rasterKeeper");
  h.eq([SETTLE_TIMEOUT_MS, BAKE_DEBOUNCE_MS], [1500, 80], "SETTLE_TIMEOUT_MS and BAKE_DEBOUNCE_MS pinned");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Condition-based wait for every POSITIVE outcome (the Windows pure job runs --jobs 2 on a loaded host); the sleeps that remain
  // are annotated: either a negative ("nothing happened yet / at all") or the first-look frame that has no observable.
  const until = async (pred: () => boolean, label: string, timeoutMs = 5000) => {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms: ${label}`); await sleep(5); }
  };
  function rig(opts2: { capture?: boolean; debounceMs?: number } = {}) {
    const hints: string[] = [];
    let hint = "transform", nodes = 10, width = 100;
    const cam = { style: { transform: "translate(0px, 0px) scale(1)", get willChange() { return hint; }, set willChange(v: string) { hint = v; hints.push(v); } }, getElementsByTagName: () => ({ length: nodes }) };
    const mount = { offsetWidth: 100, getBoundingClientRect: () => ({ width }) };
    const keeper = createRasterKeeper(cam as unknown as HTMLElement, mount as unknown as HTMLElement, opts2);
    return { keeper, hints, cam, set nodes(n: number) { nodes = n; }, set width(w: number) { width = w; }, get hint() { return hint; } };
  }
  // inert guards beyond the missing rAF: no `window`, or a mount that cannot measure itself (SSR / linkedom hosts that fake rAF)
  {
    const fakeCam = { style: { transform: "translate(0px, 0px) scale(1)", willChange: "transform" }, getElementsByTagName: () => ({ length: 1 }) } as unknown as HTMLElement;
    const noMeasure = createRasterKeeper(fakeCam, { offsetWidth: 100 } as unknown as HTMLElement, { capture: true });
    fakeCam.style.transform = "translate(-5px, 0px) scale(2)"; noMeasure.rest(); await noMeasure.settle();
    g.window = undefined;
    const noWindow = createRasterKeeper(fakeCam, { offsetWidth: 100, getBoundingClientRect: () => ({ width: 100 }) } as unknown as HTMLElement, { capture: true });
    noWindow.rest(); await noWindow.settle();
    g.window = { devicePixelRatio: 1 };
    h.eq([noMeasure.count(), noWindow.count(), fakeCam.style.willChange], [0, 0, "transform"], "a mount without getBoundingClientRect, or no window, is inert: no bake, no throw, hint untouched");
  }
  // capture
  {
    const r = rig({ capture: true });
    r.keeper.rest(); await r.keeper.settle();
    h.eq([r.keeper.count(), r.hints], [0, []], "capture: the first settle only records the first look (no bake, no hint write)");
    r.cam.style.transform = "translate(-10px, -4px) scale(2)"; r.keeper.rest(); await r.keeper.settle();
    h.eq([r.keeper.count(), r.hints, r.hint], [1, ["auto", "transform"], "transform"], "capture: a changed pose re-bakes once: hint auto, then transform");
    r.keeper.rest(); await r.keeper.settle();
    h.eq(r.keeper.count(), 1, "capture: an unchanged pose never re-bakes");
    r.width = 150; r.keeper.rest(); await r.keeper.settle();
    h.eq(r.keeper.count(), 2, "capture: a host-scale change alone re-bakes");
    r.nodes = 1_000_000; r.cam.style.transform = "translate(0px, 0px) scale(3)"; r.keeper.rest(); await r.keeper.settle();
    h.eq(r.keeper.count(), 3, "capture ignores the node ceiling");
    r.keeper.dispose();
  }
  // live (timer margins are wide: the gate runs in parallel on loaded CI hosts)
  {
    const r = rig({ debounceMs: 150 });
    await sleep(60);                                       // first-look frame (rAF fires at +2 ms): no observable to poll
    r.cam.style.transform = "translate(-10px, -4px) scale(2)";
    r.keeper.rest(false); await sleep(20);                 // negative: the 150 ms debounce has not expired
    h.eq(r.keeper.count(), 0, "live: nothing before the debounce expires");
    await until(() => r.keeper.count() === 1 && r.hints.length === 2, "the debounced re-bake");
    h.eq([r.keeper.count(), r.hints, r.hint], [1, ["auto", "transform"], "transform"], "live: one debounced re-bake after rest");
    r.cam.style.transform = "translate(-20px, -4px) scale(2)"; r.keeper.rest(false); r.keeper.flying(); await sleep(450);   // negative: outlasts the 150 ms debounce 3x
    h.eq(r.keeper.count(), 1, "live: flying() cancels a pending re-bake");
    r.keeper.rest(false); await until(() => r.keeper.count() === 2 && r.hints.length === 4, "the re-bake after flying()");
    h.eq(r.keeper.count(), 2, "live: the next rest bakes the pose that flying() left behind");
    const slow = rig({ debounceMs: 5000 }); await sleep(60);
    slow.cam.style.transform = "translate(-1px, 0px) scale(2)"; slow.keeper.rest(true); slow.keeper.rest(false);   // natural flight end, then finish()'s own paint
    await until(() => slow.keeper.count() === 1, "the immediate end-of-flight bake (debounce is 5000 ms)", 1500);
    h.eq(slow.keeper.count(), 1, "live: the end of a flight bakes immediately and the paint after it does not push it out");
    slow.keeper.dispose();
    const heavy = rig({ debounceMs: 5 }); await sleep(60);
    heavy.nodes = 30001; heavy.cam.style.transform = "translate(-1px, 0px) scale(2)"; heavy.keeper.rest(false); await sleep(300);   // negative: 60x the 5 ms debounce
    h.eq([heavy.keeper.count(), heavy.hints], [0, []], "live: skipped above 30 000 nodes, and the hint is untouched");
    heavy.keeper.dispose();
    const light = rig({ debounceMs: 5 }); await sleep(60);
    light.nodes = 30000; light.cam.style.transform = "translate(-1px, 0px) scale(2)"; light.keeper.rest(false); await until(() => light.keeper.count() === 1, "the 30 000-node re-bake");
    h.eq(light.keeper.count(), 1, "live: exactly 30 000 nodes still re-bakes");
    light.keeper.dispose(); r.keeper.dispose();
  }
  // early(): a camera flight that is nearly home bakes UNDER the motion that is left (lane J), once per flight, and flying() keeps it
  {
    const { EARLY_BAKE_AT } = await import("../src/lib/slide/player/rasterKeeper");
    h.ok(EARLY_BAKE_AT > 0.5 && EARLY_BAKE_AT < 1, "EARLY_BAKE_AT is inside the flight");
    const r = rig({ debounceMs: 5000 }); await sleep(60);
    r.cam.style.transform = "translate(-30px, -12px) scale(3)";
    r.keeper.flying(); r.keeper.early(); r.keeper.flying(); r.keeper.early();      // the flight's frames keep calling flying(); early() bakes once
    await until(() => r.keeper.count() === 1 && r.hints.length === 2, "the early bake");
    h.eq([r.keeper.count(), r.hints, r.hint], [1, ["auto", "transform"], "transform"], "early(): one bake mid-flight (hint auto, then transform), not cancelled by flying()");
    r.keeper.early(); await sleep(60);
    h.eq(r.keeper.count(), 1, "early(): once per flight");
    r.keeper.rest(true); await sleep(60);
    h.eq(r.keeper.count(), 1, "early(): the landing at the baked pose does not bake again");
    r.keeper.rest(false); r.keeper.flying(); r.keeper.rest(false);             // the next flight re-arms early()
    r.cam.style.transform = "translate(-60px, -12px) scale(3)"; r.keeper.flying(); r.keeper.early();
    await until(() => r.keeper.count() === 2, "the next flight's early bake");
    r.keeper.dispose();
    const heavy = rig({ debounceMs: 5 }); await sleep(60);
    heavy.nodes = 30001; heavy.cam.style.transform = "translate(-1px, 0px) scale(2)"; heavy.keeper.early(); await sleep(120);   // negative
    h.eq([heavy.keeper.count(), heavy.hints], [0, []], "early(): skipped above 30 000 nodes like every live bake");
    heavy.keeper.dispose();
    const cap = rig({ capture: true }); await sleep(60);
    cap.cam.style.transform = "translate(-1px, 0px) scale(2)"; cap.keeper.early(); await sleep(120);
    h.eq(cap.keeper.count(), 0, "early(): capture never bakes early (it settles after every sampled frame)");
    cap.keeper.dispose();
  }
  // dispose mid-bake and the settle timeout
  {
    const r = rig({ capture: true });
    r.keeper.rest(); await r.keeper.settle();
    r.cam.style.transform = "translate(-10px, 0px) scale(2)"; r.keeper.rest();
    const pending = r.keeper.settle(); await sleep(5); r.keeper.dispose(); await pending;
    h.eq(r.hint, "transform", "dispose in the middle of a bake leaves the hint ON");
    const s = rig({ capture: true });
    s.keeper.rest(); await s.keeper.settle();
    s.cam.style.transform = "translate(-10px, 0px) scale(2)"; s.keeper.rest();
    stalled = true;                                        // a throttled / occluded host: no frame ever arrives
    const t0 = Date.now(); await s.keeper.settle(); const waited = Date.now() - t0;
    h.ok(waited >= SETTLE_TIMEOUT_MS - 50 && waited < SETTLE_TIMEOUT_MS + 2000, `settle() gives up after SETTLE_TIMEOUT_MS instead of hanging (${waited} ms)`);
    stalled = false; drain(); await until(() => s.hint === "transform" && s.keeper.count() === 1, "the stalled bake completes once frames resume");
    h.eq([s.hint, s.keeper.count()], ["transform", 1], "frames resume: the stalled bake completes and the hint ends ON");
    s.keeper.dispose();
  }
  g.requestAnimationFrame = savedRaf; g.window = savedWindow;
  if (savedRaf === undefined) delete g.requestAnimationFrame; if (savedWindow === undefined) delete g.window;
}
await h.done();
