// Replay ONE slide of a real project in the exported player the way Present plays it: play({fromBeat,
// toBeat}) under a fake clock, so every step begins through finish() → begin() exactly as the auto chain
// does (a seek-per-step probe cannot show state that leaks between steps), and at chosen times count the
// path content drawn in a y band of the stage (where something is "stranded"). Use a scratch copy.
//   ROOT=<project> DECK=<deckId> SLIDE=<index> TS=ms,ms,… BAND=y0,y1 node --import tsx scripts/perf/slide-play-probe.mts
import * as fs from "node:fs/promises"; import * as os from "node:os"; import * as path from "node:path"; import { pathToFileURL } from "node:url";
const { gatherDeckPayload } = await import("../../flux-core/slides"); const { exportDeckHtml } = await import("../../src/lib/slide/export/exportDeck"); const { launch } = await import("../lib/driver.mjs");
const root = process.env.ROOT!, deckId = process.env.DECK!, slide = Number(process.env.SLIDE), ts = (process.env.TS ?? "1200,5800").split(",").map(Number), [y0, y1] = (process.env.BAND ?? "268,296").split(",").map(Number);
const { payload } = await gatherDeckPayload(root, deckId, undefined, { refreshSources: false });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-play-")); const file = path.join(tmp, "deck.html"); await fs.writeFile(file, (await exportDeckHtml(payload)).html);
const { browser, page } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.play");
  const out = await page.evaluate(`(async () => {
    let clock = 0, callback = null;
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    window.requestAnimationFrame = cb => { callback = cb; return 1; }; window.cancelAnimationFrame = () => { callback = null; };
    const fd = window.fluxDeck, stageW = ${payload.deck.stage.width};
    fd.goTo(${slide}, 0); await new Promise(r => setTimeout(r, 50));
    fd.play({ slide: ${slide}, fromBeat: 1, toBeat: ${payload.deck.slides[slide].beats.length - 1} });
    const samples = [], targets = ${JSON.stringify(ts)}.sort((a, b) => a - b);
    for (let i = 0; i < targets.length; i++) {
      while (clock < targets[i]) { clock = Math.min(targets[i], clock + 40); if (callback) { const cb = callback; callback = null; cb(clock); } }
      const cam = document.querySelector(".sl-camera").parentElement.getBoundingClientRect(), k = cam.width / stageW;
      const hits = [];
      for (const n of document.querySelectorAll("[data-el-id] path")) { const r = n.getBoundingClientRect(); const y = (r.y - cam.y) / k, h = r.height / k, x = (r.x - cam.x) / k;
        if (y > ${y0} && y < ${y1} && h > 8 && h < 40 && getComputedStyle(n).visibility !== "hidden") hits.push({ x: +x.toFixed(0), y: +y.toFixed(0), h: +h.toFixed(0), id: n.closest("[data-el-id]").getAttribute("data-el-id") }); }
      samples.push({ t: clock, playing: !!callback, hits: hits.length, sample: hits.slice(0, 4) });
    }
    return samples;
  })()`);
  const names = new Map(payload.deck.slides[slide].elements.map((e: any) => [e.id, e.name]));
  for (const s of out as any[]) console.log(JSON.stringify({ ...s, sample: s.sample.map((h: any) => ({ ...h, id: names.get(h.id) })) }));
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
