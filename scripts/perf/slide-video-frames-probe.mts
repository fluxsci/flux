// The video capture document (exportSlideVideoHtml) stepped frame by frame in
// headless Chrome, SLOWLY (a real encoder sits between frames): is a moving
// text run painted at sub-pixel positions from frame to frame? The capture
// runtime holds flight layers so every frame is one raster moved, not a fresh
// layer that bakes its fractional offset in.
//   node --import tsx scripts/perf/slide-video-frames-probe.mts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDeck, addSlide, addElement, addBeat, setTransform } from "../../src/lib/slide/ops";
import { exportSlideVideoHtml } from "../../src/lib/slide/export/exportDeck";
const { launch } = await import("../lib/driver.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-vframes-"));
const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none"; deck.background = "#000000";
const slide = addSlide(deck, { id: "s", layout: "blank" });
addElement(deck, slide.id, { type: "text", id: "t", x: 100, y: 60, width: 200, height: 40, rotation: 0, text: "Mycelial growth", fontFamily: "Georgia", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#ff0000", sizing: "auto" });
addElement(deck, slide.id, { type: "rect", id: "r", x: 100, y: 200, width: 60, height: 40, rotation: 0, fill: "#00ff00", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
const b1 = addBeat(deck, slide.id, { id: "b1" })!;
// 303 / 61 stage px over 60 frames at 2 device px per stage px: a fractional step per frame
setTransform(deck, slide.id, b1.id, "t", { state: { x: 403, y: 121, color: "#ff4000" }, duration: 1000, easing: "linear" });
setTransform(deck, slide.id, b1.id, "r", { state: { x: 403, y: 261 }, duration: 1000, easing: "linear" });
const html = await exportSlideVideoHtml({ deck }, { height: 720, fps: 60 });
const file = path.join(tmp, "video.html"); await fs.writeFile(file, html);
const { browser, page } = await launch({ width: 1280, height: 720 });
try {
  await page.goto(pathToFileURL(file).href);
  const info = await page.evaluate("window.fluxVideoReady") as { width: number; height: number; frames: number; fps: number };
  console.log("capture document:", JSON.stringify(info));
  const GAP = Number(process.env.GAP ?? "400");
  const scale = info.height / 360; // device px per stage px (DSF 1)
  const shots: Buffer[] = [];
  // the plan holds one second before the step: frames 75..90 are t = 250..500 ms of the flight
  for (let i = 75; i <= 90; i++) {
    await page.evaluate(`window.fluxVideo.frame(${i})`);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    shots.push(await page.screenshot({ clip: { x: 0, y: 0, width: info.width, height: info.height * 0.8 }, type: "png" }) as Buffer);
    await new Promise((r) => setTimeout(r, GAP)); // the encoder's turn
  }
  const centroid = async (buf: Buffer, chan: "r" | "g") => {
    const img = await loadImage(buf); const cv = createCanvas(img.width, img.height); const c = cv.getContext("2d"); c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, img.width, img.height).data;
    let sum = 0, sx = 0, sy = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const i = (y * img.width + x) * 4; const v = chan === "r" ? d[i] - Math.max(d[i + 1], d[i + 2]) : d[i + 1] - Math.max(d[i], d[i + 2]); if (v > 8) { sum += v; sx += v * x; sy += v * y; } }
    return { cx: sx / sum / scale, cy: sy / sum / scale };
  };
  const stat = (a: number[]) => { const mean = a.reduce((p, q) => p + q, 0) / a.length; return { mean: mean.toFixed(3), min: Math.min(...a).toFixed(3), max: Math.max(...a).toFixed(3), sd: Math.sqrt(a.reduce((p, q) => p + (q - mean) ** 2, 0) / a.length).toFixed(3) }; };
  for (const [label, chan] of [["text (moves + recolours)", "r"], ["rect", "g"]] as const) {
    const ys: number[] = [], xs: number[] = [];
    for (const b of shots) { const c = await centroid(b, chan); xs.push(c.cx); ys.push(c.cy); }
    const dx = xs.slice(1).map((v, i) => v - xs[i]), dy = ys.slice(1).map((v, i) => v - ys[i]);
    console.log(`${label}: Δx per frame ${JSON.stringify(stat(dx))} Δy per frame ${JSON.stringify(stat(dy))}  (ideal 5.050 / 1.017 stage px)`);
  }
  console.log("errors:", JSON.stringify((await import("../lib/driver.mjs")).errors(page)));
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
