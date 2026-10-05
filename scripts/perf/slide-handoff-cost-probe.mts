// Frame cost of ONE hand-off step in the real portable player (headless Chrome): the deck is
// gathered + exported headlessly, the step is scrubbed frame by frame, and per frame the JS
// seek time and the rAF interval are reported together with the flight driver that ran
// (glyph or path) and its drawing count — the measurement behind correspondence.ts's
// RING_MORPH_THRESHOLD. Use a scratch copy of a project (see slide-handoff-strip-probe.mts).
//   ROOT=<project> DECK=<deckId> SLIDE=<index> BEAT=<index> [FRAMES=120] node --import tsx scripts/perf/slide-handoff-cost-probe.mts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const { gatherDeckPayload } = await import("../../flux-core/slides");
const { exportDeckHtml } = await import("../../src/lib/slide/export/exportDeck");
const { launch } = await import("../lib/driver.mjs");
const root = process.env.ROOT!, deckId = process.env.DECK!;
const slide = Number(process.env.SLIDE ?? 0), beat = Number(process.env.BEAT ?? 1), frames = Number(process.env.FRAMES ?? 120);
const { payload, warnings } = await gatherDeckPayload(root, deckId, undefined, { refreshSources: false });
if (warnings.length) console.error("gather warnings:", warnings.join("; "));
const b = payload.deck.slides[slide]?.beats[beat];
if (!b) throw new Error(`no slide ${slide} beat ${beat}`);
const duration = Math.max(...b.tracks.map(t => (t.start ?? 0) + (t.duration ?? 600)), 1);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-cost-"));
const file = path.join(tmp, "deck.html");
await fs.writeFile(file, (await exportDeckHtml(payload)).html);
const { browser, page } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const pct = (xs: number[], q: number) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  // A string body: tsx injects `__name` helpers into named inner functions, which do not exist in the page.
  const res = await page.evaluate(`(async () => {
    const s = ${slide}, b = ${beat}, duration = ${duration}, frames = ${frames};
    const fd = window.fluxDeck;
    const raf = () => new Promise(r => requestAnimationFrame(r));
    fd.seek(s, b, 0); await raf(); fd.seek(s, b, 1); await raf();
    await new Promise(r => setTimeout(r, 400));
    fd.seek(s, b, duration * 0.5); await raf(); await raf();
    const seekMs = [], rafMs = [];
    let last = await raf();
    for (let i = 0; i < frames; i++) {
      const t = duration * (0.05 + 0.9 * i / (frames - 1));
      const t0 = performance.now(); fd.seek(s, b, t); seekMs.push(performance.now() - t0);
      const ts = await raf(); rafMs.push(ts - last); last = ts;
    }
    const layer = document.querySelector(".sl-handoff");
    return { driver: layer && layer.getAttribute("data-driver"), paths: document.querySelectorAll(".sl-handoff-path").length, glyphs: document.querySelectorAll(".sl-handoff-glyph").length, seekMs, rafMs };
  })()`) as { driver: string | null; paths: number; glyphs: number; seekMs: number[]; rafMs: number[] };
  console.log(JSON.stringify({ slide, beat, duration, driver: res.driver, paths: res.paths, glyphs: res.glyphs,
    seekMs: { p50: +pct(res.seekMs, .5).toFixed(2), p95: +pct(res.seekMs, .95).toFixed(2), max: +Math.max(...res.seekMs).toFixed(2) },
    rafMs: { p50: +pct(res.rafMs, .5).toFixed(2), p95: +pct(res.rafMs, .95).toFixed(2), max: +Math.max(...res.rafMs).toFixed(2) } }));
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
