// Boundary-pop SWEEP over every step of a deck in the portable player: for each
// step, paint change (px², whole stage) across the first 2 ms, the next 2 ms, 2 ms
// mid-flight, the last 2 ms and the 2 ms after the end. A smooth step changes
// about as much in its first/last 2 ms as in the 2 ms beside them (≈0 for an
// ease-in/out); a start twitch or an end snap stands out as a spike at the
// boundary with nothing beside it. ROOT=<project> DECK=<deckId> [SLIDES=0,1,2]
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
const { payload } = await gatherDeckPayload(root, deckId, undefined, { refreshSources: false });
const slides = process.env.SLIDES ? process.env.SLIDES.split(",").map(Number) : payload.deck.slides.map((_, i) => i);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-sweep-"));
const file = path.join(tmp, "deck.html");
await fs.writeFile(file, (await exportDeckHtml(payload)).html);
const { browser, page } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const stage = payload.deck.stage;
  const cam = await page.evaluate(() => { const r = (document.querySelector(".sl-camera") as HTMLElement).parentElement!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const k = cam.w / stage.width, clip = { x: cam.x, y: cam.y, width: cam.w, height: cam.h };
  const grab = async (s: number, b: number, t: number) => {
    await page.evaluate(({ s, b, t }) => (window as unknown as { fluxDeck: { seek(s: number, b: number, t: number): void } }).fluxDeck.seek(s, b, Math.max(0, t)), { s, b, t });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const img = await loadImage(await page.screenshot({ clip, type: "png" }) as Buffer);
    const c = createCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0);
    return c.getImageData(0, 0, img.width, img.height).data;
  };
  const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / 765 / (k * k); };
  console.log("slide beat  dur(ms)  tracks   Δ0→2   Δ2→4   Δmid   Δend-2  Δend   Δend+2   verdict");
  for (const s of slides) {
    const slide = payload.deck.slides[s];
    for (let b = 0; b < slide.beats.length; b++) {
      const beat = slide.beats[b];
      if (!beat.tracks.length) continue;
      const dur = Math.max(...beat.tracks.map((t: { start?: number; duration?: number }) => (t.start ?? 0) + (t.duration ?? 600)), 1);
      const kinds = [...new Set(beat.tracks.map((t: { preset?: string; to?: { become?: unknown } }) => t.to?.become ? "handoff" : t.preset ?? "?"))].join("+");
      const f = { m2: await grab(s, b, -2), p0: await grab(s, b, 0), p2: await grab(s, b, 2), p4: await grab(s, b, 4), mid: await grab(s, b, dur / 2), mid2: await grab(s, b, dur / 2 + 2), e4: await grab(s, b, dur - 4), e2: await grab(s, b, dur - 2), e0: await grab(s, b, dur), ep2: await grab(s, b, dur + 2) };
      const d02 = diff(f.p0, f.p2), d24 = diff(f.p2, f.p4), dmid = diff(f.mid, f.mid2), dem2 = diff(f.e4, f.e2), de = diff(f.e2, f.e0), dep = diff(f.e0, f.ep2), dpre = diff(f.m2, f.p0);
      const startPop = d02 > 25 && d02 > 4 * Math.max(d24, 1), endPop = de > 25 && de > 4 * Math.max(dem2, 1);
      const verdict = [dpre > 1 ? "PRE-ROLL CHANGE" : "", startPop ? "START POP" : "", endPop ? "END SNAP" : "", dep > 1 ? "POST CHANGE" : ""].filter(Boolean).join(", ") || "ok";
      console.log(`${String(s).padStart(5)} ${String(b).padStart(4)}  ${String(Math.round(dur)).padStart(7)}  ${kinds.slice(0, 7).padEnd(7)} ${d02.toFixed(1).padStart(6)} ${d24.toFixed(1).padStart(6)} ${dmid.toFixed(1).padStart(6)} ${dem2.toFixed(1).padStart(7)} ${de.toFixed(1).padStart(6)} ${dep.toFixed(1).padStart(7)}   ${verdict}`);
    }
  }
} finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
