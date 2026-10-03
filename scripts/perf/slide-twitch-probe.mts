// Twitch / snap detector for ONE track of a REAL project in the portable player:
// seek in 1–2 ms steps across the START and the END of a step, capture a clip,
// and report per-step painted change (sum of |Δ| over the clip's pixels) plus
// the ink centroid. Smooth motion = a steady change per ms; a "twitch" at the
// start or a "snap" at the end shows as a spike (and a jump in the centroid)
// between neighbouring steps, including the frames just before/after the
// endpoints (the rest render vs the first/last flight frame).
//   ROOT=<project> DECK=<deckId> SLIDE=<index> BEAT=<index> CLIP=x,y,w,h [WINDOW=40] [STEP=2]
//   [OUT=dir] [INJECT_CSS='.sl-camera{…}'] node --import tsx scripts/perf/slide-twitch-probe.mts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
const { gatherDeckPayload } = await import("../../flux-core/slides");
const { exportDeckHtml } = await import("../../src/lib/slide/export/exportDeck");
const { launch } = await import("../lib/driver.mjs");

const root = process.env.ROOT, deckId = process.env.DECK;
if (!root || !deckId) throw new Error("ROOT=<project> DECK=<deckId> are required");
const slide = Number(process.env.SLIDE ?? 0), beat = Number(process.env.BEAT ?? 1);
const win = Number(process.env.WINDOW ?? 40), step = Number(process.env.STEP ?? 2);
const outDir = process.env.OUT ? path.resolve(process.env.OUT) : null;
const { payload } = await gatherDeckPayload(root, deckId, undefined, { refreshSources: false });
const b = payload.deck.slides[slide]?.beats[beat];
if (!b) throw new Error(`no slide ${slide} beat ${beat}`);
const duration = Math.max(...b.tracks.map(t => (t.start ?? 0) + (t.duration ?? 600)), 1);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-twitch-"));
const file = path.join(tmp, "deck.html");
await fs.writeFile(file, (await exportDeckHtml(payload)).html);
const { browser, page } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  if (process.env.INJECT_CSS) await page.addStyleTag({ content: process.env.INJECT_CSS }); // experiments: e.g. force the stage onto one compositor layer
  const stage = payload.deck.stage;
  const cam = await page.evaluate(() => { const r = (document.querySelector(".sl-camera") as HTMLElement).parentElement!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const k = cam.w / stage.width;
  const [cx, cy, cw, ch] = (process.env.CLIP ?? `0,0,${stage.width},${stage.height}`).split(",").map(Number);
  const clip = { x: cam.x + cx * k, y: cam.y + cy * k, width: cw * k, height: ch * k };
  const times: number[] = [];
  for (let t = -step; t <= win; t += step) times.push(t);
  for (let t = duration - win; t <= duration + 3 * step; t += step) times.push(t);
  const seek = async (t: number) => {
    await page.evaluate(({ s, b, t }) => (window as unknown as { fluxDeck: { seek(s: number, b: number, t: number): void } }).fluxDeck.seek(s, b, Math.max(0, t)), { s: slide, b: beat, t });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    return loadImage(await page.screenshot({ clip, type: "png" }) as Buffer);
  };
  const stats = (img: Awaited<ReturnType<typeof loadImage>>) => {
    const c = createCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, img.width, img.height).data; let sx = 0, sy = 0, m = 0;
    for (let i = 0; i < d.length; i += 4) { const ink = 255 - (d[i] + d[i + 1] + d[i + 2]) / 3; if (ink > 24) { const p = i / 4; sx += (p % img.width) * ink; sy += Math.floor(p / img.width) * ink; m += ink; } }
    return { d, cx: m ? sx / m / k : 0, cy: m ? sy / m / k : 0, ink: m / 255 / (k * k) };
  };
  let prev: ReturnType<typeof stats> | null = null, prevT = NaN;
  if (outDir) await fs.mkdir(outDir, { recursive: true });
  console.log(`step ${beat} of slide ${slide}: duration ${duration} ms · clip ${cx},${cy} ${cw}×${ch} · ${times.length} seeks`);
  console.log("  t(ms)   Δpaint(px²)   centroid x,y (stage px)   Δcentroid/ms   ink(px²)");
  for (const t of times) {
    const img = await seek(t), s = stats(img);
    let diff = 0;
    if (prev) { for (let i = 0; i < s.d.length; i += 4) diff += Math.abs(s.d[i] - prev.d[i]) + Math.abs(s.d[i + 1] - prev.d[i + 1]) + Math.abs(s.d[i + 2] - prev.d[i + 2]); diff = diff / 765 / (k * k); }
    const dt = Number.isFinite(prevT) ? Math.max(1, t - prevT) : 1;
    const dc = prev ? Math.hypot(s.cx - prev.cx, s.cy - prev.cy) / dt : 0;
    console.log(`${String(t).padStart(7)}  ${diff.toFixed(1).padStart(12)}   ${s.cx.toFixed(2).padStart(8)}, ${s.cy.toFixed(2).padStart(8)}   ${dc.toFixed(3).padStart(10)}   ${s.ink.toFixed(0).padStart(7)}${prev && t - prevT > step * 2 ? "   (gap)" : ""}`);
    if (outDir) await fs.writeFile(path.join(outDir, `t${String(Math.round(t)).padStart(5, "0")}.png`), await page.screenshot({ clip, type: "png" }) as Buffer);
    prev = s; prevT = t;
  }
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
