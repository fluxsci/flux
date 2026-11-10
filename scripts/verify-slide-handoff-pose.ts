// A hand-off's copies of its ends are cut in the look of ITS OWN moments (player `posedAt`), never the moment its plan happens to be built in.
//
// The flight's copies of the real renders (the hand-over's two end layers, glyph clones, crossfade clones) are cut from the LIVE nodes whenever
// the plan is first needed: in the idle moment after the slide is built, while it rests at its first step. The player keeps animation state on
// those same nodes (an entrance still to come is `opacity: 0`, a lift is a `transform`, a hand-off's sides a leased `visibility`), so a copy cut
// then carried that state into a flight that plays many steps later. The owner's deck (2026-11-10): a ring plot's sectors fade in, then each
// Becomes a raincloud row; every sector vanished at the first frame of its flight and faded back in with the flight's weight: a blink.
//
// The same gate pins the glyph flight's landing (handoff.ts `landing`): what a cloud of markers lands on fades in under them instead of
// appearing whole on the landing frame.
//
// Every case here plays in the exported player, lets the idle warm run at step 0 (asserted: the plan exists before the flight is ever seeked),
// and compares the frame the audience rests on with the first frame of the flight (and the last frame with the landed rest).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDeck, addSlide, addElement, addBeat, setTransform } from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { Track, TargetRef, BecomeSpec, Slide } from "../src/lib/slide/types";
import type { SemanticPlotElement } from "../src/lib/types";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-slide-handoff-pose");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-handoff-pose-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const plots: Record<string, { svg: string; manifest: unknown }> = {};
  for (const [id, name] of [["box", "mpl_boxplot"], ["scatter", "mpl_scatter"], ["sine", "mpl_sine_waves"]]) plots[id] = {
    svg: await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.svg`, import.meta.url), "utf8"),
    manifest: JSON.parse(await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.fluxplot.json`, import.meta.url), "utf8")),
  };
  // 420 markers: over GLYPH_FLIGHT_THRESHOLD, so the markers THEMSELVES fly (clones of the live nodes)
  const n = 420, points = Array.from({ length: n }, (_, i) => ({ index: i, svgId: `samples.point.${i}`, x: i / (n / 5), y: 20 + 12 * Math.sin(i) }));
  plots.markers = {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><g id="samples.points" fill="#4169e1">${points.map(p => `<g id="${p.svgId}" data-flux-glyph="1" transform="translate(${p.x * 36} ${p.y})"><circle r="2"/></g>`).join("")}</g></svg>`,
    manifest: { spec: "fluxplot", schemaVersion: "0.2.0", size: { width: 200, height: 100, unit: "px" }, axes: [{ x: { scale: "linear", domain: [0, 5], anchors: [{ data: 0, svg: 0 }, { data: 5, svg: 180 }] }, y: { scale: "linear", domain: [0, 100], anchors: [{ data: 0, svg: 0 }, { data: 100, svg: 100 }] } }], series: [{ id: "samples", roles: ["point"], svg: { points: "samples.points" }, points }] },
  };
  const deck = createDeck({ withTitleSlide: false }); deck.stage = { width: 960, height: 540 }; deck.defaults.transition = "none";
  deck.background = "#ffffff";   // the fixtures' own white figure patch is no part of a flight: on paper its hand-over is not a change
  const plot = (id: string, assetId: string, x = 480, extra: Partial<SemanticPlotElement> = {}): SemanticPlotElement => ({ id, type: "plot", assetId, x, y: 100, width: 360, height: 216, rotation: 0, ...extra });
  const add = (name: string) => addSlide(deck, { id: name, layout: "blank" });
  /** An appearance in a step of its own (the slide's step 1). */
  const enter = (slide: Slide, track: Partial<Track> & { target: string }) => { const beat = addBeat(deck, slide.id, { id: `${slide.id}-enter-${slide.beats.length}` })!; beat.tracks.push({ id: `${slide.id}-enter-${beat.tracks.length}`, preset: "fade", duration: 400, start: 0, ...track } as Track); return beat; };
  const DUR = 1000;
  function handoff(slide: Slide, source: string, ref: TargetRef, spec: Partial<BecomeSpec> = {}, parts?: string[]) {
    const beat = addBeat(deck, slide.id, { id: `${slide.id}-flight-${slide.beats.length}` })!;
    setTransform(deck, slide.id, beat.id, source, { state: {}, duration: DUR, easing: "smooth", ...(parts ? { ref: { element: source, parts } } : {}) });
    const track = beat.tracks.find(t => t.target === source)!;
    track.to!.become = { mode: "handoff", ref, ...spec };
    return track;
  }
  // (the sine fixture paints 2hz.line, then 1hz.line: a flight is drawn above the plots, so the part under its sibling would differ where they cross)
  const TOP = "1hz.line";
  const lines = { element: "dest", parts: ["2hz.line", TOP] };

  // (1) the owner's case: a PART fades in, then Becomes parts of another plot (one into two: the flight hands over to copies of its ends)
  const s1 = add("entered-part"); addElement(deck, s1.id, plot("source", "sine", 30, { height: 108 })); addElement(deck, s1.id, plot("dest", "sine", 520, { height: 108 }));
  enter(s1, { target: "source", part: TOP, preset: "fade" }); handoff(s1, "source", lines, {}, [TOP]);
  // (2) the source's WRAPPER rises in (a transform on an ancestor of the part: a copy is placed by the live matrix)
  const s2 = add("risen-source"); addElement(deck, s2.id, plot("source", "sine", 30, { height: 108 })); addElement(deck, s2.id, plot("dest", "sine", 520, { height: 108 }));
  enter(s2, { target: "source", preset: "fadeRise", params: { y: 40 } }); handoff(s2, "source", lines, {}, [TOP]);
  // (3) the DESTINATION's wrapper rises in before the landing: its copy is the destination as it rests when the flight lands
  const s3 = add("risen-destination"); addElement(deck, s3.id, plot("source", "sine", 30, { height: 108 })); addElement(deck, s3.id, plot("dest", "sine", 520, { height: 108 }));
  enter(s3, { target: "dest", preset: "fadeRise", params: { y: 40 } }); handoff(s3, "source", lines, {}, [TOP]);
  // (4) markers that popped in one by one, then fly as themselves (the glyph driver clones each live marker). Its landing is pinned too: the
  // markers fade over the last 15 % and the line they land on fades in under them (it used to appear whole on the landing frame)
  const s4 = add("entered-glyphs"); addElement(deck, s4.id, plot("source", "markers", 30, { width: 200, height: 100 })); addElement(deck, s4.id, plot("dest", "sine", 520, { height: 108 }));
  enter(s4, { target: "source", part: "samples.points", preset: "stagger", duration: 200, stagger: { by: "index", from: "start", totalMs: 400 }, params: { child: "scaleIn" } } as Partial<Track> & { target: string });
  handoff(s4, "source", { element: "dest", parts: [TOP] }, { pair: "data" }, ["samples.points"]);
  // (5) leases: a shape lands on a PART of a plot, then the WHOLE plot Becomes another plot: the first plot's copy holds the part that landed
  const s5 = add("leased-part");
  addElement(deck, s5.id, { id: "shape", type: "rect", x: 40, y: 60, width: 160, height: 60, rotation: 0, fill: "none", stroke: "#4169e1", strokeWidth: 4, cornerRadius: 0 });
  addElement(deck, s5.id, plot("dest", "sine", 300, { height: 108 }));
  addElement(deck, s5.id, plot("after", "sine", 520, { y: 330, height: 108 }));
  handoff(s5, "shape", { element: "dest", parts: [TOP] }); handoff(s5, "dest", { element: "after" });
  // (6) a text that faded in, then Becomes a part (a crossfade clone of the live text)
  const s6 = add("entered-text");
  addElement(deck, s6.id, { id: "source", type: "text", x: 60, y: 60, width: 180, height: 40, rotation: 0, text: "Result", fontFamily: "Arial", fontSize: 30, fontWeight: 700, fontStyle: "normal", align: "left", color: "#4169e1", sizing: "fixed" } as never);
  addElement(deck, s6.id, plot("dest", "sine", 520, { height: 108 }));
  enter(s6, { target: "source", preset: "fade" }); handoff(s6, "source", { element: "dest", parts: [TOP] });

  for (const slide of deck.slides) {
    const issues = compileSlide(slide, deck.stage, { plotManifest: id => (plots[id]?.manifest as never) }).issues;
    h.ok(!issues.length, `${slide.id}: compiles without issues${issues.length ? ` (${issues.map(i => i.reason).join("; ")})` : ""}`);
  }

  const file = path.join(tmp, "pose.html"); await fs.writeFile(file, (await exportDeckHtml({ deck, plots } as never)).html);
  const launched = await launch({ width: 1280, height: 720 }); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const frame = `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`;
  const stageClip = await page.evaluate(`(() => { const r = document.querySelector(".sl-camera").parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`) as { x: number; y: number; width: number; height: number };
  const shot = async (slide: number, beat: number, time: number | string) => {
    await page.evaluate(`window.fluxDeck.seek(${slide}, ${beat}, ${time})`); await page.evaluate(frame);
    const img = await loadImage(await page.screenshot({ clip: stageClip, type: "png" }) as Buffer);
    const c = createCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0);
    return c.getImageData(0, 0, img.width, img.height);
  };
  type Img = Awaited<ReturnType<typeof shot>>;
  /** Pixels that differ visibly (a channel by 24 levels or more), and the ink (darkening against white paper) of each frame. */
  const changed = (a: Img, b: Img) => { let nPx = 0; for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) >= 24 || Math.abs(a.data[i + 1] - b.data[i + 1]) >= 24 || Math.abs(a.data[i + 2] - b.data[i + 2]) >= 24) nPx++; return nPx; };
  const ink = (a: Img) => { let s = 0; for (let i = 0; i < a.data.length; i += 4) s += 765 - a.data[i] - a.data[i + 1] - a.data[i + 2]; return s / 765; };
  /** The styles of every live node of the slide (the flight layers excluded): posing must leave none behind. */
  const liveStyles = `JSON.stringify([...document.querySelectorAll(".sl-camera *")].filter(n => !n.closest(".sl-flight, .sl-flight-text, .sl-handoff-veil")).map(n => n.getAttribute("style")))`;
  const index = (id: string) => deck.slides.findIndex(s => s.id === id);

  /** Rest at step 0 with the plan built there (the idle warm), then the flight's two ends. `flight` is the step of the hand-off. */
  async function ends(id: string, flight: number): Promise<{ start: number; landing: number; restInk: number; firstInk: number; pure: boolean; warmed: boolean }> {
    const slide = index(id);
    // (the seek and the read share one task: the idle warm has not run yet)
    const before = await page.evaluate(`(() => { window.fluxDeck.seek(${slide}, 0, 0); return ${liveStyles}; })()`);
    await page.evaluate(`new Promise(r => requestIdleCallback(() => r(), { timeout: 3000 }))`); await page.evaluate(frame);
    const warmed = await page.evaluate(`document.querySelectorAll(".sl-handoff[data-driver]").length`) as number;
    const after = await page.evaluate(liveStyles);
    const rest = await shot(slide, flight, 0), first = await shot(slide, flight, 1);
    const last = await shot(slide, flight, DUR - 1), landed = await shot(slide, flight, DUR);
    if (process.env.DUMP) for (const [name, img] of [["rest", rest], ["first", first], ["last", last], ["landed", landed]] as const) { const c = createCanvas(img.width, img.height); c.getContext("2d").putImageData(img as never, 0, 0); await fs.mkdir(process.env.DUMP, { recursive: true }); await fs.writeFile(path.join(process.env.DUMP, `${id}-${name}.png`), c.toBuffer("image/png")); }
    return { start: changed(rest, first), landing: changed(last, landed), restInk: ink(rest), firstInk: ink(first), pure: before === after, warmed: warmed > 0 };
  }
  // A frame that pops moves hundreds to thousands of pixels; 1 ms into (or before the end of) an eased second moves none. The floor leaves room
  // for anti-aliasing at the hand-over (measured: 0 to 6).
  const FLOOR = 40;
  for (const [id, flight, what] of [
    ["entered-part", 2, "a part that faded in"], ["risen-source", 2, "a part of a plot that rose in"], ["risen-destination", 2, "a flight onto a plot that rose in"],
    ["entered-glyphs", 2, "markers that popped in"], ["leased-part", 2, "a plot holding a part that landed"], ["entered-text", 2, "a text that faded in"],
  ] as const) {
    const r = await ends(id, flight);
    h.ok(r.warmed, `${id}: the plan was built while the slide rested at step 0 (the idle warm), before the flight was ever seeked`);
    h.ok(r.pure, `${id}: building the plan leaves every live node's style as it was`);
    h.ok(r.start <= FLOOR, `${id}: ${what} does not blink when its flight begins (${r.start} px differ between the rest and the first flight frame, floor ${FLOOR})`);
    h.ok(Math.abs(r.firstInk - r.restInk) <= Math.max(30, r.restInk * 0.02), `${id}: the first flight frame carries the rest's ink (${Math.round(r.restInk)} → ${Math.round(r.firstInk)})`);
    h.ok(r.landing <= FLOOR, `${id}: the last flight frame is the landed rest (${r.landing} px differ, floor ${FLOOR})`);
  }
  // A glyph flight's landing copies: absent before the fade window, half in at its middle, and the layer hidden once landed.
  const glyphAt = async (time: number) => page.evaluate(`(() => { window.fluxDeck.seek(${index("entered-glyphs")}, 2, ${time}); const layer = document.querySelector(".sl-handoff[data-driver=glyph]"), g = layer?.querySelector(".sl-handoff-landing"); return { driver: !!layer, copies: g ? g.querySelectorAll(".sl-handoff-landing-copy").length : 0, shown: !!g && g.getAttribute("display") !== "none", opacity: g ? Number(g.getAttribute("opacity")) : NaN, layer: layer?.getAttribute("visibility") }; })()`) as Promise<{ driver: boolean; copies: number; shown: boolean; opacity: number; layer: string }>;
  const g0 = await glyphAt(800), g1 = await glyphAt(925), g2 = await glyphAt(DUR);
  h.ok(g0.driver && g0.copies === 1 && !g0.shown, "a glyph flight holds one copy of the line its markers land on, not drawn before the fade window");
  h.ok(g1.shown && Math.abs(g1.opacity - 0.5) < 1e-6, `the copy is half in at the middle of the window (opacity ${g1.opacity})`);
  h.eq(g2.layer, "hidden", "the landed flight layer is hidden: the real destination stands");
  // The DOM of the owner's case: the source's copy is opaque (it was `opacity: 0`, the entrance's first keyframe, copied at step 0).
  const copy = await page.evaluate(`(() => { window.fluxDeck.seek(${index("entered-part")}, 2, 1); const c = document.querySelector(".sl-handover-a .sl-handover-copy > g > *"); return c ? getComputedStyle(c).opacity : null; })()`);
  h.eq(copy, "1", "the hand-over's copy of a source that entered earlier is opaque");
  h.ok(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
h.done();
