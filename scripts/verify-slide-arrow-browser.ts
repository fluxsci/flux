#!/usr/bin/env -S npx tsx
// Arrowheads and shafts must share one geometry through chained Changes.
// Chromium pixel-space checks catch stale constant attributes that DOM snapshots miss.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, becomeTransform } from "../src/lib/slide/ops";
import { cornerJoinOf, morphJoin } from "../src/lib/strokeStyle";
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
  // WP 1.8 join law (src/lib/strokeStyle.ts): a stroked rect keeps its miter corners and a closed path its round ones, at rest AND in the
  // live Become layer, so the layer swap never pops. Kinds without corners (ellipse, line) carry no preference and inherit the other side.
  const joinFirst = deck.slides.length, joinCases = [["rect", "ellipse"], ["path", "ellipse"], ["rect", "path"]] as const;
  for (const [src, dst] of joinCases) {
    const shape = (type: string, id: string, x: number) => type === "rect" ? { id, type: "rect" as const, x, y: 110, width: 140, height: 140, rotation: 0, fill: "none", stroke: "#205ea6", strokeWidth: 12, cornerRadius: 0 }
      : type === "ellipse" ? { id, type: "ellipse" as const, x, y: 110, width: 140, height: 140, rotation: 0, fill: "none", stroke: "#af3029", strokeWidth: 12 }
      : { id, type: "path" as const, x, y: 110, width: 140, height: 140, rotation: 0, d: "M 0 0 L 140 0 L 140 140 L 0 140 Z", fill: "none", stroke: "#205ea6", strokeWidth: 12, closed: true };
    const slide: Slide = { id: `join-${src}-${dst}`, elements: [shape(src, "a", 120), shape(dst, "b", 380)], beats: [{ id: "base", tracks: [] }] };
    deck.slides.push(slide);
    const beat = { id: "become", tracks: [] }; slide.beats.push(beat);
    assert.ok(becomeTransform(deck, slide.id, beat.id, "a", "b"), `${slide.id}: Become authored`);
    for (const t of beat.tracks) { t.duration = 1000; t.easing = "linear"; }
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
  for (let si=0;si<joinFirst;si++) {
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
  for (const [k, [src, dst]] of joinCases.entries()) {
    const si = joinFirst + k, label = `${src} -> ${dst}`;
    await page.evaluate((s) => (window as any).fluxDeck.seek(s, 0, 0), si);
    const staticJoin = await page.evaluate(`(() => { const n = document.querySelector('[data-el-id="a"] ${src === "rect" ? "rect" : "path"}'); return n ? getComputedStyle(n).strokeLinejoin : null; })()`);
    check(staticJoin === cornerJoinOf({ type: src }), `${label}: the resting ${src} draws stroke-linejoin ${cornerJoinOf({ type: src })} (got ${staticJoin})`);
    for (const t of [0.2, 0.8]) {
      await page.evaluate((s, ms) => (window as any).fluxDeck.seek(s, 1, ms), si, t * 1000);
      const live = await page.evaluate(`(() => { const body = [...document.querySelector('[data-el-id="a"]').querySelectorAll("svg > path")].filter((p) => getComputedStyle(p).visibility !== "hidden"); return body.length === 1 ? getComputedStyle(body[0]).strokeLinejoin : "bodies:" + body.length; })()`);
      check(live === morphJoin({ type: src }, { type: dst }, t), `${label} at t=${t}: the morph body draws stroke-linejoin ${morphJoin({ type: src }, { type: dst }, t)} (got ${live})`);
    }
  }
  check(errors.length===0, `arrow runtime console clean: ${errors.join("; ")}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
console.log(`ARROW BROWSER: PASS (${checks} assertions)`);
