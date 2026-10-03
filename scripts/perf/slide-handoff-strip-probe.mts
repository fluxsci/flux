// Film strip of ONE hand-off in the real portable player, from a real project:
// the deck is gathered + exported headlessly (flux-core, exactly the CLI's
// `export` path), then the step is seeked to evenly spaced raw times and each
// frame's stage clip is composited left→right into one PNG — so the feel of a
// Become (how the pieces split, travel and land) can be judged by eye, frame by
// frame, and two hand-offs compared side by side.
//   ROOT=<project> DECK=<deckId> SLIDE=<index> BEAT=<index> [FRAMES=9] [OUT=strip.png]
//   [CLIP=x,y,w,h in stage px] node --import tsx scripts/perf/slide-handoff-strip-probe.mts
// Use only scratch copies of projects (the gather may refresh plot sources).
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
const slide = Number(process.env.SLIDE ?? 0), beat = Number(process.env.BEAT ?? 1), frames = Math.max(2, Number(process.env.FRAMES ?? 9));
const out = path.resolve(process.env.OUT ?? "test-results/handoff-strip.png");
const { payload, warnings } = await gatherDeckPayload(root, deckId, undefined, { refreshSources: false });
if (warnings.length) console.error("gather warnings:", warnings.join("; "));
const duration = (() => {
  const b = payload.deck.slides[slide]?.beats[beat];
  if (!b) throw new Error(`no slide ${slide} beat ${beat}`);
  return Math.max(...b.tracks.map(t => (t.start ?? 0) + (t.duration ?? 600)), 1);
})();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-strip-"));
const file = path.join(tmp, "deck.html");
await fs.writeFile(file, (await exportDeckHtml(payload)).html);
const { browser, page } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const stage = payload.deck.stage;
  const cam = await page.evaluate(() => { const r = (document.querySelector(".sl-camera") as HTMLElement).parentElement!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const k = cam.w / stage.width;
  const [cx, cy, cw, ch] = (process.env.CLIP ?? `0,0,${stage.width},${stage.height}`).split(",").map(Number);
  const clip = { x: cam.x + cx * k, y: cam.y + cy * k, width: cw * k, height: ch * k };
  const shots: Buffer[] = [], times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = duration * i / (frames - 1);
    await page.evaluate(({ s, b, t }) => (window as unknown as { fluxDeck: { seek(s: number, b: number, t: number): void } }).fluxDeck.seek(s, b, t), { s: slide, b: beat, t });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    shots.push(await page.screenshot({ clip, type: "png" }) as Buffer); times.push(t);
  }
  const imgs = await Promise.all(shots.map(b => loadImage(b)));
  const gap = 6, label = 18, w = imgs[0].width, h = imgs[0].height;
  const canvas = createCanvas(imgs.length * (w + gap) - gap, h + label), c = canvas.getContext("2d");
  c.fillStyle = "#202020"; c.fillRect(0, 0, canvas.width, canvas.height);
  imgs.forEach((img, i) => {
    c.drawImage(img, i * (w + gap), label);
    c.fillStyle = "#d0d0d0"; c.font = "12px monospace"; c.fillText(`${Math.round(times[i])} ms`, i * (w + gap) + 4, 13);
  });
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, canvas.toBuffer("image/png"));
  console.log(JSON.stringify({ out, frames, duration, clip: { x: cx, y: cy, w: cw, h: ch } }));
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
