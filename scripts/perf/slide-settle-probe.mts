// The PAINTED trajectory of transforming objects across the END of a Change in
// the exported player: seek in 1 ms steps, capture, and compute each object's
// intensity-weighted centroid + extent. A settle "jump" shows as a
// discontinuity between the last mid-flight frame and the endpoint frame.
//   rect    — moves AND grows (paints exactly per frame; never on a layer)
//   ellipse — pure move (rides a flight layer, demoted at rest)
//   text    — pure move (the same; glyph baselines round at rest)
// Rest positions are deliberately FRACTIONAL: the old layout-box law snapped
// them a whole stage px at t=1. The three flights never cross (a channel
// measure under another element's colour is garbage).
//   EASE=linear START=100.3 node --import tsx scripts/perf/slide-settle-probe.mts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDeck, addSlide, addElement, addBeat, setTransform } from "../../src/lib/slide/ops";
import { exportDeckHtml } from "../../src/lib/slide/export/exportDeck";
const { launch } = await import("../lib/driver.mjs");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-settle-"));
const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none"; deck.background = "#000000";
const slide = addSlide(deck, { id: "s", layout: "blank" });
const ease = (process.env.EASE as "linear" | undefined) ?? "smooth";
addElement(deck, slide.id, { type: "rect", id: "r", x: Number(process.env.START ?? 100), y: 150.55, width: 60, height: 40, rotation: 0, fill: "#ff0000", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
addElement(deck, slide.id, { type: "ellipse", id: "e", x: 100, y: 250, width: 40, height: 40, rotation: 0, fill: "#00ff00", stroke: "none", strokeWidth: 0 });
addElement(deck, slide.id, { type: "text", id: "t", x: 100, y: 4, width: 200, height: 40, rotation: 0, text: "Mycelial growth", fontFamily: "Georgia", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#4040ff", sizing: "auto" });
const b1 = addBeat(deck, slide.id, { id: "b1" })!;
setTransform(deck, slide.id, b1.id, "r", { state: { x: 400.37, y: 60.61, width: 90, height: 55 }, duration: 1000, easing: ease });
setTransform(deck, slide.id, b1.id, "e", { state: { x: 420.2, y: 240.4 }, duration: 1000, easing: ease });
setTransform(deck, slide.id, b1.id, "t", { state: { x: 400.45, y: 8.35 }, duration: 1000, easing: ease });
const file = path.join(tmp, "settle.html"); await fs.writeFile(file, (await exportDeckHtml({ deck })).html);
const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const box = await page.evaluate(() => { const r = document.querySelector(".sl-camera")!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const scale = box.w / 640;
  console.log("stage scale", scale.toFixed(4), "easing", ease);
  // capture fast (small clip, decode later) so flight layers stay alive between steps
  const WAIT = Number(process.env.WAIT ?? "0");
  const capture = async (ms: number) => {
    await page.evaluate((t) => (window as unknown as { fluxDeck: { seek: (s: number, b: number, ms: number) => void } }).fluxDeck.seek(0, 1, t), ms);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    if (WAIT) await new Promise((r) => setTimeout(r, WAIT));
    return await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h * 0.85 }, type: "png" }) as Buffer;
  };
  const measure = async (buf: Buffer, chan: "r" | "g" | "b") => {
    const img = await loadImage(buf); const cv = createCanvas(img.width, img.height); const cx2 = cv.getContext("2d"); cx2.drawImage(img, 0, 0);
    const png = { width: img.width, height: img.height, data: cx2.getImageData(0, 0, img.width, img.height).data };
    let sum = 0, sx = 0, sy = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const d = png.data;
      const v = chan === "r" ? d[i] - Math.max(d[i + 1], d[i + 2]) : chan === "g" ? d[i + 1] - Math.max(d[i], d[i + 2]) : d[i + 2] - Math.max(d[i], d[i + 1]);
      if (v > 8) { sum += v; sx += v * x; sy += v * y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    return { cx: sx / sum / scale, cy: sy / sum / scale, left: minX / scale, right: (maxX + 1) / scale, top: minY / scale, bottom: (maxY + 1) / scale, mass: sum / 255 / (scale * scale) };
  };
  const steps = process.env.STEPS ? process.env.STEPS.split(",").map(Number) : [0, 1, 2, 500, 988, 989, 990, 991, 992, 993, 994, 995, 996, 997, 998, 999, 1000];
  const shots = new Map<number, Buffer>();
  for (const ms of steps) shots.set(ms, await capture(ms));
  const style = await page.evaluate(() => { const el = document.querySelector('[data-el-id="t"]') as HTMLElement; return { left: el.style.left, top: el.style.top, transform: el.style.transform, willChange: el.style.willChange }; });
  console.log("text wrapper at rest", JSON.stringify(style));
  for (const [chan, label] of [["r", "rect (moves + grows, paints in place)"], ["g", "ellipse (pure move, flight layer)"], ["b", "text (pure move, flight layer)"]] as const) {
    console.log(`\n=== ${label} — last 12 ms, then endpoint ===`);
    let prev: Awaited<ReturnType<typeof measure>> | null = null;
    for (const ms of steps) {
      const m = await measure(shots.get(ms)!, chan);
      const d = prev ? ` Δcx=${(m.cx - prev.cx).toFixed(3)} Δcy=${(m.cy - prev.cy).toFixed(3)} Δw=${((m.right - m.left) - (prev.right - prev.left)).toFixed(3)}` : "";
      console.log(`t=${String(ms).padStart(4)}  cx=${m.cx.toFixed(3)} cy=${m.cy.toFixed(3)} w=${(m.right - m.left).toFixed(3)} h=${(m.bottom - m.top).toFixed(3)} mass=${m.mass.toFixed(1)}${ms > 500 ? d : ""}`);
      prev = m;
    }
  }
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
