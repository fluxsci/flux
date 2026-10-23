// verify-slide-stroke-band-browser — the DOM half of the stroke band contract (R2 follow-up F1; headless Chrome via exportDeckHtml, no Electron):
//  - a stroked rect that becomes an ellipse draws its stroke as ONE evenodd band path (outer + inner contour) over a stroke-less fill body, in the
//    1-1 driver, and the band node carries an invisible stroke (its ink bounds must cover its anti-aliasing fringe);
//  - the hand-off driver draws `.sl-handoff-band` in flight and it is HIDDEN at rest on both sides of the flight (an explicit `visibility: visible`
//    on it showed a second copy of the ring at rest: a doubled edge, measured 0.75 coverage against 0.5);
//  - a pair with no corner (dot -> dot) draws no band at all, a line becoming a ring neither (a round cap is a round join);
//  - the stage draws an ELLIPSE as a `<path data-shape="ellipse">` (start at 3 o'clock, clockwise) and a rect still as a `<rect>`.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, becomeTransform, setTransform } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";
const h = harness("verify-slide-stroke-band-browser");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-strokeband-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const deck = createDeck({ withTitleSlide: false }); deck.stage = { width: 640, height: 360 }; deck.defaults.transition = "none";
  const R = (id: string, o: object = {}) => ({ type: "rect" as const, id, x: 200, y: 100, width: 200, height: 160, rotation: 0, fill: "#4385be", stroke: "#205ea6", strokeWidth: 8, cornerRadius: 0, ...o });
  const E = (id: string, o: object = {}) => ({ type: "ellipse" as const, id, x: 230, y: 80, width: 180, height: 180, rotation: 0, fill: "#d14d41", stroke: "#942822", strokeWidth: 8, ...o });
  const slide = (name: string) => addSlide(deck, { id: name, layout: "blank" });
  const one = slide("consume"); addElement(deck, one.id, R("a")); addElement(deck, one.id, E("b"));
  becomeTransform(deck, one.id, addBeat(deck, one.id, { id: "b1" })!.id, "a", "b", { mode: "consume" });
  const ho = slide("handoff"); addElement(deck, ho.id, R("a", { x: 60, y: 100, width: 120, height: 100 })); addElement(deck, ho.id, E("b", { x: 400, y: 80, width: 160, height: 160 }));
  becomeTransform(deck, ho.id, addBeat(deck, ho.id, { id: "b1" })!.id, "a", "b", { mode: "handoff" });
  const dots = slide("dots"); addElement(deck, dots.id, E("a", { x: 100, y: 100, width: 30, height: 30, strokeWidth: 2 })); addElement(deck, dots.id, E("b", { x: 400, y: 200, width: 30, height: 30, strokeWidth: 2 }));
  becomeTransform(deck, dots.id, addBeat(deck, dots.id, { id: "b1" })!.id, "a", "b", { mode: "handoff" });
  const arrow = slide("arrow"); addElement(deck, arrow.id, { type: "line", id: "a", x: 60, y: 180, width: 220, height: 10, rotation: 0, x1: 0, y1: 5, x2: 220, y2: 5, stroke: "#af3029", strokeWidth: 6, arrowStart: false, arrowEnd: true, cap: "round" } as never); addElement(deck, arrow.id, E("b", { x: 380, y: 100, width: 140, height: 140 }));
  becomeTransform(deck, arrow.id, addBeat(deck, arrow.id, { id: "b1" })!.id, "a", "b", { mode: "consume" });
  const draw = slide("draw"); addElement(deck, draw.id, E("a", { x: 100, y: 100, width: 100, height: 60, fill: "none" }));
  const db = addBeat(deck, draw.id, { id: "b1" })!; void setTransform;
  (await import("../src/lib/slide/ops")).setAnimation(deck, draw.id, db.id, { id: "t1", target: "a", preset: "drawOn", duration: 1000, easing: "linear", start: 0 } as never);
  for (const sl of deck.slides) for (const b of sl.beats) for (const t of b.tracks) if (sl.id !== "draw") { (t as any).duration = 1000; (t as any).easing = "linear"; }

  const file = path.join(tmp, "band.html"); await fs.writeFile(file, (await exportDeckHtml({ deck })).html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const seek = (slideIx: number, time: number) => page.evaluate(({ slideIx, time }) => (window as any).fluxDeck.seek(slideIx, 1, time), { slideIx, time });
  const settle = () => page.evaluate("new Promise(r => requestAnimationFrame(r))");

  h.section("stage markup: an ellipse is a path of its outline, a rect stays a rect");
  await seek(1, 0); await settle();
  const markup = await page.evaluate(() => {
    const wrap = document.querySelector('[data-el-id="a"]')!, bShape = document.querySelector('[data-el-id="b"] [data-shape="ellipse"]') as SVGPathElement | null;
    return { rect: wrap.querySelectorAll("rect").length, ellipses: document.querySelectorAll("ellipse").length, bShape: !!bShape, d: bShape?.getAttribute("d") ?? "", wrapType: document.querySelector('[data-el-id="b"]')?.getAttribute("data-el-type") };
  });
  h.ok(markup.rect === 1 && markup.ellipses === 0 && markup.bShape && markup.wrapType === "ellipse", `the rect is a <rect>; the ellipse is a <path data-shape="ellipse"> inside its unchanged wrapper (data-el-type ${markup.wrapType}), no <ellipse> anywhere`);
  const m = /^M ([\d.]+) ([\d.]+) C /.exec(markup.d);
  h.ok(!!m && Math.abs(Number(m[1]) - 160) < 1e-6 && Math.abs(Number(m[2]) - 80) < 1e-6, `it starts at 3 o'clock (${m?.[1]}, ${m?.[2]}) = (160, 80) of its 160x160 box, as an SVG ellipse does: dashes and draws start where they always did`);

  h.section("1-1 driver: the stroke is one evenodd band path, the body paints the fill only");
  await seek(0, 0); await seek(0, 450); await settle();
  const mid = await page.evaluate(() => {
    const L = [...document.querySelectorAll('[data-el-id="a"] > div')] as HTMLElement[];
    const live = L.find(l => getComputedStyle(l).visibility !== "hidden" && l.querySelector("path[fill-rule=evenodd]"));
    const band = live?.querySelector("path[fill-rule=evenodd]") as SVGPathElement | null, body = live?.querySelector("path:not([fill-rule])") as SVGPathElement | null;
    return { has: !!live, bandD: band?.getAttribute("d") ?? "", bandFill: band?.getAttribute("fill"), bandStroke: band?.getAttribute("stroke"), bandSW: band?.getAttribute("stroke-width"), bodyStroke: body?.getAttribute("stroke"), bodyFill: body?.getAttribute("fill") };
  });
  h.ok(mid.has && (mid.bandD.match(/M /g) ?? []).length === 2 && !/NaN|Infinity/.test(mid.bandD), "mid-flight: the band path is an outer plus an inner contour (two subpaths), finite");
  h.ok(mid.bodyStroke === "none" && /^#/.test(mid.bodyFill ?? "") && /^#/.test(mid.bandFill ?? ""), `the body paints the fill only (stroke ${mid.bodyStroke}); the band is filled with the lerped stroke colour (${mid.bandFill})`);
  h.ok(mid.bandStroke === "transparent" && Number(mid.bandSW) >= 4, `the band carries an invisible stroke (${mid.bandStroke} ${mid.bandSW}) so its ink bounds cover its anti-aliasing fringe`);
  await seek(0, 0); await settle();
  const start = await page.evaluate(() => [...document.querySelectorAll('[data-el-id="a"] > div')].map(l => getComputedStyle(l as HTMLElement).visibility));
  h.ok(start[0] !== "hidden" && start[1] === "hidden" && start[2] === "hidden", `t = 0: only layer A (the real rect) is shown (${start.join(", ")})`);
  await seek(0, 1000); await settle();
  const end = await page.evaluate(() => [...document.querySelectorAll('[data-el-id="a"] > div')].map(l => getComputedStyle(l as HTMLElement).visibility));
  h.ok(end[0] === "hidden" && end[1] === "hidden" && end[2] !== "hidden", `t = 1: only layer B (the real ellipse) is shown (${end.join(", ")})`);

  h.section("hand-off driver: the band is drawn in flight and is hidden at rest on both sides");
  const bandState = () => page.evaluate(() => {
    const bands = [...document.querySelectorAll(".sl-handoff-band")] as SVGPathElement[], main = [...document.querySelectorAll(".sl-handoff-path")] as SVGPathElement[];
    return { n: bands.length, visible: bands.filter(b => getComputedStyle(b).visibility !== "hidden").length, mainStroke: main.map(p => p.getAttribute("stroke")), d: bands[0]?.getAttribute("d") ?? "" };
  });
  await seek(1, 0); await settle(); const rest0 = await bandState();
  await seek(1, 500); await settle(); const flight = await bandState();
  await seek(1, 1000); await settle(); const rest1 = await bandState();
  await seek(1, 1e9); await settle(); const rest2 = await bandState();
  h.ok(flight.n === 1 && flight.visible === 1 && (flight.d.match(/M /g) ?? []).length === 2 && flight.mainStroke[0] === "none", "mid-flight: one band, visible, outer + inner contour; the flight's fill path has no stroke");
  h.ok(rest0.visible === 0 && rest1.visible === 0 && rest2.visible === 0, `before (${rest0.visible}), at the landing (${rest1.visible}) and after (${rest2.visible}) no band is visible: an explicit visibility on it would show a second ring at rest`);

  h.section("no corner, no band");
  await seek(2, 500); await settle();
  const dot = await bandState();
  h.ok(dot.n === 0, "dot -> dot hand-off: no band node (the stroke law: the stroker is the rasteriser the resting ellipse path uses)");
  await seek(3, 500); await settle();
  const arrowMid = await page.evaluate(() => [...document.querySelectorAll('[data-el-id="a"] path[fill-rule=evenodd]')].length);
  h.ok(arrowMid === 0, "round-capped arrow -> circle: no band either (a round cap is a round join; the body is trimmed inside the head instead)");

  h.section("draw presets still see an ellipse as an ellipse");
  await seek(4, 0); await settle();
  const dash = await page.evaluate(() => { const p = document.querySelector('[data-el-id="a"] [data-shape="ellipse"]') as SVGPathElement; return { off: p.style.strokeDashoffset, arr: p.style.strokeDasharray, len: p.getTotalLength() }; });
  h.ok(!!dash.arr && Number(dash.arr.split(/[ ,]+/)[0]) > dash.len, `a drawOn ellipse rests undrawn with a dash that overshoots its measured length (${dash.arr} > ${dash.len.toFixed(1)})`);
} finally {
  await browser?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
await h.done();
