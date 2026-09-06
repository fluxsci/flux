#!/usr/bin/env -S npx tsx
// Arrowheads and shafts must share one geometry through chained Changes.
// Chromium pixel-space checks catch stale constant attributes that DOM snapshots miss.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { Slide } from "../src/lib/slide/types";
import type { LineElement } from "../src/lib/types";
const { launch } = await import("./lib/driver.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-arrow-browser-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
let checks = 0;
const check = (v: unknown, label: string) => { assert.ok(v, label); checks++; console.log("  ok:", label); };
try {
  const source: LineElement = { id: "source", type: "line", x: 60, y: 180, width: 111, height: 0, x1: 0, y1: 0, x2: 111, y2: 0, rotation: 180, stroke: "#25897D", strokeWidth: 2.4, cap: "round", arrowEnd: true, arrowStyle: "vee", arrowSize: 5 };
  const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none";
  for (const ghost of [true, false]) for (const rotation of [-27, 0, 27]) {
    const result = { ...source, id: "result" };
    const slide: Slide = { id: `${ghost ? "ghost" : "ordinary"}-${rotation}`, elements: ghost ? [source, result] : [result], beats: [
      { id: "base", tracks: [] },
      { id: "move", tracks: [{ id: "move", target: "result", ...(ghost ? { ghostFrom: "source" } : {}), preset: "transform", duration: 400, easing: "linear", to: { state: { x: 378, y: 130, rotation } } }] },
      { id: "restyle", tracks: [{ id: "restyle", target: "result", preset: "transform", duration: 300, easing: "linear", to: { state: { stroke: "#B87935", strokeWidth: 3.5 } } }] },
    ] };
    deck.slides.push(slide);
  }
  const file = path.join(tmp, "arrows.html"); await fs.writeFile(file, (await exportDeckHtml({ deck })).html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const inspect = () => page.evaluate(`(() => {
    const wrap = document.querySelector('[data-el-id="result"]');
    const line = wrap.querySelector("line"), head = wrap.querySelector("polyline");
    const stage = wrap.closest(".sl-camera").getBoundingClientRect(), scale = stage.width / 640;
    const screen = (el, x, y) => { const p = new DOMPoint(x, y).matrixTransform(el.getScreenCTM()); return { x: (p.x-stage.x)/scale, y: (p.y-stage.y)/scale }; };
    const start = screen(line, line.x1.baseVal.value, line.y1.baseVal.value), end = screen(line, line.x2.baseVal.value, line.y2.baseVal.value);
    const tip = head.points.getItem(1), headEnd = screen(head, tip.x, tip.y);
    const rect = line.getBoundingClientRect(), box = wrap.getBoundingClientRect();
    return { start, end, headEnd, gap: Math.hypot(end.x-headEnd.x,end.y-headEnd.y), length: Math.hypot(end.x-start.x,end.y-start.y), bounds: { x: (rect.x-box.x)/scale, y: (rect.y-box.y)/scale, right: (rect.right-box.right)/scale, bottom: (rect.bottom-box.bottom)/scale }, visibility: getComputedStyle(wrap).visibility };
  })()`);
  for (let si=0;si<deck.slides.length;si++) {
    const label = deck.slides[si].id;
    for (const [beat,time] of [[1,400],[2,300],[1,200],[0,0],[1,0],[2,150],[1,400]] as const) {
      await page.evaluate((s,b,t) => (window as any).fluxDeck.seek(s,b,t), si,beat,time);
      const frame = await inspect();
      check(frame.gap<.01 && Math.abs(frame.length-111)<.01, `${label} step${beat} ${time}ms keeps shaft attached to arrowhead at the correct length`);
      check(frame.bounds.x>-.6 && frame.bounds.y>-.6 && frame.bounds.right<.6 && frame.bounds.bottom<.6, `${label} step${beat} ${time}ms shaft remains inside its rotated placement bounds`);
    }
  }
  await page.evaluate("window.fluxDeck.play({slide:0,fromBeat:1,toBeat:1})");
  await page.waitForFunction("window.fluxDeck.state().playing && window.fluxDeck.state().time>100");
  const live = await inspect();
  check(live.gap<.01 && Math.abs(live.length-111)<.01, "actual clock playback keeps the rotating zero-height arrow intact");
  await page.waitForFunction("!window.fluxDeck.state().playing");
  check((await inspect()).gap<.01, "actual playback reaches the negative-rotation endpoint without a stray shaft");
  check(errors.length===0, `arrow runtime console clean: ${errors.join("; ")}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
console.log(`ARROW BROWSER: PASS (${checks} assertions)`);
