// Painted trajectory of moving TEXT vs a moving RECT at 1 ms steps (linear
// easing, ~0.3 stage px/ms): uniform centroid deltas mean sub-pixel motion;
// steps of ~1 px mean the paint is quantized to the pixel grid.
//   MODE=transform (default) — a Change moves both
//   MODE=camera             — a camera pan moves the stage under both
//   MODE=rise               — fadeRise lifts both in (opacity + translateY)
//   MODE=move               — the legacy `move` emphasis preset
//   node --import tsx scripts/perf/slide-motion-probe.mts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDeck, addSlide, addElement, addBeat, setTransform, setAnimation } from "../../src/lib/slide/ops";
import { exportDeckHtml } from "../../src/lib/slide/export/exportDeck";
const { launch } = await import("../lib/driver.mjs");
const MODE = process.env.MODE ?? "transform";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-motion-"));
const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none"; deck.background = "#000000";
const slide = addSlide(deck, { id: "s", layout: "blank" });
addElement(deck, slide.id, { type: "text", id: "t", x: 100, y: 60, width: 200, height: 40, rotation: 0, text: "Mycelial growth", fontFamily: "Georgia", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#ff0000", sizing: "auto" });
addElement(deck, slide.id, { type: "rect", id: "r", x: 100, y: 200, width: 60, height: 40, rotation: 0, fill: "#00ff00", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
const b1 = addBeat(deck, slide.id, { id: "b1" })!;
if (MODE === "transform") {
  setTransform(deck, slide.id, b1.id, "t", { state: { x: 400, y: 120 }, duration: 1000, easing: "linear" });
  setTransform(deck, slide.id, b1.id, "r", { state: { x: 400, y: 260 }, duration: 1000, easing: "linear" });
} else if (MODE === "camera") {
  // pan the stage centre by (-300, -60) stage px → content moves +300, +60
  setAnimation(deck, slide.id, b1.id, { id: "cam", target: "@camera", preset: "camera", duration: 1000, easing: "linear", to: { x: 320 - 300, y: 180 - 60, zoom: 1 } });
} else if (MODE === "rise") {
  setAnimation(deck, slide.id, b1.id, { id: "rt", target: "t", preset: "fadeRise", duration: 1000, easing: "linear" });
  setAnimation(deck, slide.id, b1.id, { id: "rr", target: "r", preset: "fadeRise", duration: 1000, easing: "linear" });
} else if (MODE === "move") {
  setAnimation(deck, slide.id, b1.id, { id: "mt", target: "t", preset: "move", duration: 1000, easing: "linear", to: { x: 300, y: 60 } });
  setAnimation(deck, slide.id, b1.id, { id: "mr", target: "r", preset: "move", duration: 1000, easing: "linear", to: { x: 300, y: 60 } });
}
const file = path.join(tmp, "motion.html"); await fs.writeFile(file, (await exportDeckHtml({ deck })).html);
const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const box = await page.evaluate(() => { const r = document.querySelector(".sl-camera")!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const scale = box.w / 640;
  const stageBox = MODE === "camera" ? await page.evaluate(() => { const r = (document.querySelector(".sl-camera") as HTMLElement).parentElement!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }) : box;
  // Capture fast (a small clip, decode later) so flight layers stay alive
  // between steps — the player demotes a node parked mid-flight after
  // LAYER_COOL_MS, and a full-stage PNG round trip is slower.
  const capture = async (ms: number) => {
    await page.evaluate((t) => (window as unknown as { fluxDeck: { seek: (s: number, b: number, ms: number) => void } }).fluxDeck.seek(0, 1, t), ms);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return await page.screenshot({ clip: { x: stageBox.x, y: stageBox.y, width: stageBox.w, height: stageBox.h * 0.85 }, type: "png" }) as Buffer;
  };
  const measure = async (buf: Buffer, chan: "r" | "g") => {
    const img = await loadImage(buf); const cv = createCanvas(img.width, img.height); const c = cv.getContext("2d"); c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, img.width, img.height).data;
    let sum = 0, sx = 0, sy = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const i = (y * img.width + x) * 4; const v = chan === "r" ? d[i] - Math.max(d[i + 1], d[i + 2]) : d[i + 1] - Math.max(d[i], d[i + 2]); if (v > 8) { sum += v; sx += v * x; sy += v * y; } }
    return { cx: sx / sum / scale, cy: sy / sum / scale, mass: sum / 255 / (scale * scale) };
  };
  const t0 = performance.now();
  const shots: Buffer[] = [];
  for (let ms = 500; ms <= 530; ms++) shots.push(await capture(ms));
  console.log(`MODE=${MODE} capture: ${((performance.now() - t0) / shots.length).toFixed(0)} ms per step`);
  const promoted = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".sl-camera, .sl-el, .sl-effects")].filter((e) => e.style.willChange).map((e) => e.className).join(","));
  console.log(`promoted mid-flight: ${promoted || "nothing"}`);
  for (const [label, chan] of [["text", "r"], ["rect", "g"]] as const) {
    const xs: number[] = [], ys: number[] = [], ms: number[] = [];
    for (const buf of shots) { const m = await measure(buf, chan); xs.push(m.cx); ys.push(m.cy); ms.push(m.mass); }
    const dx = xs.slice(1).map((v, i) => v - xs[i]), dy = ys.slice(1).map((v, i) => v - ys[i]);
    const stat = (a: number[]) => ({ mean: (a.reduce((p, q) => p + q, 0) / a.length).toFixed(3), min: Math.min(...a).toFixed(3), max: Math.max(...a).toFixed(3), sd: Math.sqrt(a.reduce((p, q) => p + (q - a.reduce((r, s) => r + s, 0) / a.length) ** 2, 0) / a.length).toFixed(3) });
    console.log(`${label}: Δx per ms`, JSON.stringify(stat(dx)), "Δy per ms", JSON.stringify(stat(dy)), `mass ${Math.min(...ms).toFixed(1)}–${Math.max(...ms).toFixed(1)}`);
  }
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
