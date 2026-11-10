// Dense film of a WINDOW of one step in the real portable player, from a real project: the frames a
// defect lives in (a blink at the start of a hand-off is one or two frames wide and invisible on the
// evenly spaced strip of slide-handoff-strip-probe). Each frame is seeked, screenshotted and compared
// with its predecessor; the JSON lists per-frame changed pixels so a blink shows as a spike that
// reverts. Frames are written as individual PNGs plus one contact sheet.
//   ROOT=<project> DECK=<deckId> SLIDE=<index> BEAT=<index> [FROM=0] [TO=200] [STEP=8.33]
//   [CLIP=x,y,w,h in stage px] [OUT=dir] [COLS=8]
//   node --import tsx scripts/perf/slide-start-film-probe.mts
// Use only scratch copies of projects (the gather may refresh plot sources). The page runs at devicePixelRatio 1 on purpose: puppeteer's
// EMULATED device scale reports devicePixelRatio 2 while Blink still snaps layout boxes to whole CSS px, so every box the player put on the
// half-pixel grid is painted half a pixel off its matrix (a 0.5 px 'step' between a resting plot and its flight copy that no display shows).
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
const from = Number(process.env.FROM ?? 0), to = Number(process.env.TO ?? 200), step = Number(process.env.STEP ?? 1000 / 120);
const out = path.resolve(process.env.OUT ?? "test-results/start-film");
const { payload, warnings } = await gatherDeckPayload(root, deckId, undefined, { refreshSources: false });
if (warnings.length) console.error("gather warnings:", warnings.join("; "));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-film-"));
const file = path.join(tmp, "deck.html");
await fs.writeFile(file, (await exportDeckHtml(payload)).html);
const { browser, page } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const stage = payload.deck.stage;
  const cam = await page.evaluate(`(() => { const r = document.querySelector(".sl-camera").parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) as { x: number; y: number; w: number; h: number };
  const k = cam.w / stage.width;
  const [cx, cy, cw, ch] = (process.env.CLIP ?? `0,0,${stage.width},${stage.height}`).split(",").map(Number);
  const clip = { x: cam.x + cx * k, y: cam.y + cy * k, width: cw * k, height: ch * k };
  const times: number[] = [];
  for (let t = from; t <= to + 1e-6; t += step) times.push(t);
  const shots: Buffer[] = [];
  // The rest BEFORE the step (the end of the previous beat) is frame -1: what the audience sees
  // when the click lands.
  const seekExpr = (b: number, t: number | string) => `window.fluxDeck.seek(${slide}, ${b}, ${t})`;
  const twoFrames = `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`;
  await page.evaluate(seekExpr(Math.max(0, beat - 1), "1e9")); await page.evaluate(twoFrames);
  shots.push(await page.screenshot({ clip, type: "png" }) as Buffer);
  for (const t of times) {
    await page.evaluate(seekExpr(beat, t)); await page.evaluate(twoFrames);
    shots.push(await page.screenshot({ clip, type: "png" }) as Buffer);
  }
  const labels = ["rest", ...times.map(t => `${t.toFixed(1)} ms`)];
  const imgs = await Promise.all(shots.map(b => loadImage(b)));
  await fs.mkdir(out, { recursive: true });
  const w = imgs[0].width, h = imgs[0].height;
  const px = imgs.map(img => { const c = createCanvas(w, h).getContext("2d"); c.drawImage(img, 0, 0); return c.getImageData(0, 0, w, h).data; });
  // Per-frame: pixels that differ from the predecessor (a channel difference ≥ 10 levels), and the
  // net ink (sum of darkening against the rest) so a blink reads as ink that leaves and returns.
  const rows = px.map((d, i) => {
    let changed = 0, ink = 0;
    const p = px[Math.max(0, i - 1)], r0 = px[0];
    for (let j = 0; j < d.length; j += 4) {
      if (Math.abs(d[j] - p[j]) >= 10 || Math.abs(d[j + 1] - p[j + 1]) >= 10 || Math.abs(d[j + 2] - p[j + 2]) >= 10) changed++;
      ink += (r0[j] - d[j]) + (r0[j + 1] - d[j + 1]) + (r0[j + 2] - d[j + 2]);
    }
    return { frame: labels[i], changedPx: changed, inkVsRest: Math.round(ink / 765) };
  });
  for (let i = 0; i < shots.length; i++) await fs.writeFile(path.join(out, `f${String(i).padStart(3, "0")}.png`), shots[i]);
  const cols = Math.min(imgs.length, Number(process.env.COLS ?? 8)), rowsN = Math.ceil(imgs.length / cols), gap = 6, label = 18;
  const canvas = createCanvas(cols * (w + gap) - gap, rowsN * (h + label + gap) - gap), c = canvas.getContext("2d");
  c.fillStyle = "#202020"; c.fillRect(0, 0, canvas.width, canvas.height);
  imgs.forEach((img, i) => {
    const x = (i % cols) * (w + gap), y = Math.floor(i / cols) * (h + label + gap);
    c.drawImage(img, x, y + label);
    c.fillStyle = "#d0d0d0"; c.font = "12px monospace"; c.fillText(labels[i], x + 4, y + 13);
  });
  await fs.writeFile(path.join(out, "sheet.png"), canvas.toBuffer("image/png"));
  console.log(JSON.stringify({ out, clip: { x: cx, y: cy, w: cw, h: ch }, rows }, null, 1));
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
