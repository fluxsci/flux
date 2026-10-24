#!/usr/bin/env -S npx tsx
// WP 4.1 (manim study, W1): animated Back in the REAL exported player (headless Chrome, natives, compositor layers, hand-off flight
// layers, the camera raster keeper). The law: a rewind frame at beat time T is the static sample at T. The page's clock is a fake
// (performance.now + rAF driven one 60 Hz frame at a time), so each rewind frame and each forward frame can be screenshotted and
// compared with a static seek to the same time. Forward play has its own small play-vs-static residual (WAAPI natives vs inline
// styles); a rewind must be no less faithful than forward play on the same beat. It must also land on exactly the jump's pixels and
// show its first visible change within 100 ms (Nielsen).
// Run: npx tsx scripts/verify-slide-rewind-browser.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, setTransform, becomeTransform, setAnimation } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-slide-rewind-browser");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-rewind-browser-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
const FRAME = 1000 / 60;
try {
  const deck = createDeck({ id: "rw", title: "rewind", withTitleSlide: false } as never); deck.defaults.transition = "none";
    // stage 640 x 360 (the deck default), shown at 1.5x
  const R = (id: string, x: number, y: number, fill: string, extra = {}) => ({ id, type: "rect", x, y, width: 90, height: 56, rotation: 0, fill, stroke: "none", strokeWidth: 0, cornerRadius: 6, ...extra });
  // slide 0: a glide on an arc, a text glide (the flight-mark path), a draw on a line, a fade (a WAAPI native)
  const s0 = addSlide(deck, { id: "moves", layout: "blank" } as never);
  addElement(deck, s0.id, R("A", 40, 60, "#4385be") as never);
  addElement(deck, s0.id, { id: "T", type: "text", x: 40, y: 180, width: 220, height: 32, rotation: 0, text: "Rewinding text", fontFamily: "Arial", fontSize: 22, fontWeight: 400, fontStyle: "normal", align: "left", fill: "#100f0f", sizing: "fixed" } as never);
  addElement(deck, s0.id, { id: "L", type: "line", x: 330, y: 330, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 260, y2: -110, stroke: "#100f0f", strokeWidth: 4, arrowEnd: true } as never);
  addElement(deck, s0.id, { id: "E", type: "ellipse", x: 500, y: 40, width: 90, height: 90, rotation: 0, fill: "#d14d41", stroke: "none", strokeWidth: 0 } as never);
  const b0 = addBeat(deck, s0.id, { id: "go" } as never)!;
  setTransform(deck, s0.id, b0.id, "A", { state: { x: 330, y: 90 }, duration: 900, easing: "smooth", arc: 0.6 } as never);
  setTransform(deck, s0.id, b0.id, "T", { state: { x: 180, y: 290 }, duration: 900, easing: "smooth" } as never);
  setAnimation(deck, s0.id, b0.id, { target: "L", preset: "drawOn", start: 0, duration: 900, easing: "smooth" } as never);
  setAnimation(deck, s0.id, b0.id, { target: "E", preset: "fade", start: 100, duration: 700, easing: "smooth" } as never);
  // slide 1: a hand-off Become on an arc (flight layer, claims)
  const s1 = addSlide(deck, { id: "become", layout: "blank" } as never);
  addElement(deck, s1.id, R("B", 60, 200, "#4385be") as never);
  addElement(deck, s1.id, { id: "C", type: "ellipse", x: 450, y: 90, width: 110, height: 110, rotation: 0, fill: "#d14d41", stroke: "none", strokeWidth: 0 } as never);
  const b1 = addBeat(deck, s1.id, { id: "become" } as never)!;
  h.ok(!!becomeTransform(deck, s1.id, b1.id, "B", "C", { mode: "handoff" } as never), "a hand-off Become");
  const bt = deck.slides[1].beats[1].tracks.find(t => t.target === "B")!; bt.arc = 0.6; bt.duration = 900;
  // slide 2: a camera zoom
  const s2 = addSlide(deck, { id: "camera", layout: "blank" } as never);
  addElement(deck, s2.id, R("Z", 275, 140, "#879a39") as never);
  addElement(deck, s2.id, { id: "ZT", type: "text", x: 240, y: 205, width: 160, height: 26, rotation: 0, text: "zoom target", fontFamily: "Arial", fontSize: 16, fontWeight: 400, fontStyle: "normal", align: "center", fill: "#100f0f", sizing: "fixed" } as never);
  deck.slides[2].beats.push({ id: "zoom", tracks: [{ id: "cam", target: "@camera", preset: "camera", to: { x: 320, y: 180, zoom: 2.2 }, duration: 900, easing: "smooth" } as never] } as never);

  const file = path.join(tmp, "rewind.html"); await fs.writeFile(file, (await exportDeckHtml({ deck } as never)).html);
  const launched = await launch({ width: 960, height: 540 }); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(String(err)));
  // the fake clock, installed before the runtime boots
  await page.evaluateOnNewDocument(`(() => { let now = 1000, id = 0; const q = new Map();
    performance.now = () => now;
    window.requestAnimationFrame = (cb) => { q.set(++id, cb); return id; };
    window.cancelAnimationFrame = (i) => { q.delete(i); };
    window.__frame = (ms) => { now += ms; const cbs = [...q.values()]; q.clear(); cbs.forEach(cb => cb(now)); };
    window.__idle = (ms) => { now += ms; };
    window.__diff = async (a, b) => { const load = async (d) => { const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const k = c.getContext('2d'); k.drawImage(img, 0, 0); return k.getImageData(0, 0, c.width, c.height).data; };
      const x = await load(a), y = await load(b); let n = 0; for (let i = 0; i < x.length; i += 4) if (Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])) >= 16) n++; return n; };
  })()`);
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.prev");
  const shot = async () => (await page.screenshot({ encoding: "base64", type: "png" })) as string;
  const diff = (a: string, b: string) => page.evaluate(`window.__diff(${JSON.stringify(a)}, ${JSON.stringify(b)})`) as Promise<number>;
  const st = () => page.evaluate("window.fluxDeck.state()") as Promise<{ beat: number; time: number; playing: boolean; reversing: boolean }>;
  const frame = () => page.evaluate(`window.__frame(${FRAME})`);
  const seek = (s: number, b: number, t: number | "Infinity") => page.evaluate(`window.fluxDeck.seek(${s}, ${b}, ${t})`);
  /** worst (over frames) count of visibly differing pixels between each captured frame and the static seek at its time */
  async function residual(s: number, frames: { t: number; png: string }[]): Promise<number> {
    let worst = 0;
    for (const f of frames) { await seek(s, 1, f.t); worst = Math.max(worst, await diff(f.png, await shot())); }
    return worst;
  }
  for (const [s, name] of [[0, "glide + text + draw + fade"], [1, "hand-off Become on an arc"], [2, "camera zoom"]] as const) {
    h.section(name);
    // forward play: every frame against the static sample at its time
    await seek(s, 0, "Infinity"); await page.evaluate("window.__idle(1000)"); await page.evaluate("window.fluxDeck.next()");
    const fwd: { t: number; png: string }[] = [];
    for (let k = 0; k < 120; k++) { await frame(); const q = await st(); if (!q.playing) break; if (q.time > 0) fwd.push({ t: q.time, png: await shot() }); }
    const fwdWorst = await residual(s, fwd);
    // the rewind
    await seek(s, 1, "Infinity"); const rest = await shot();
    await page.evaluate("window.__idle(1000)"); await page.evaluate("window.fluxDeck.prev()");
    h.ok((await st()).reversing, "Back starts a rewind in the exported deck");
    const rev: { t: number; png: string }[] = [];
    let firstVisible = -1;
    for (let k = 0; k < 120; k++) {
      await frame(); const q = await st(); if (!q.reversing) break;
      const png = await shot(); rev.push({ t: q.time, png });
      if (firstVisible < 0 && await diff(png, rest) >= 100) firstVisible = (k + 1) * FRAME;
    }
    const landed = await shot(), q = await st();
    await seek(s, 0, "Infinity"); const jumped = await shot();
    h.ok(q.beat === 0 && !q.reversing && !q.playing, `the rewind lands on beat 0 after ${rev.length} frames`);
    h.eq(await diff(landed, jumped), 0, "the landing frame is pixel-identical to a jump");
    h.ok(rev.length >= 10 && firstVisible > 0 && firstVisible <= 100, `the first visible change comes ${firstVisible.toFixed(0)} ms after Back (<= 100)`);
    const revWorst = await residual(s, rev);
    h.ok(revWorst <= Math.max(fwdWorst, 4), `every rewind frame is the static sample at its time, as faithfully as forward play: worst ${revWorst} px (forward ${fwdWorst} px over ${fwd.length} frames)`);
  }
  h.eq(errors, [], "no page errors");
} catch (err) { h.fail(String((err as Error).stack ?? err)); }
finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
await h.done();
