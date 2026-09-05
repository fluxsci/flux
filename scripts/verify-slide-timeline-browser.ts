#!/usr/bin/env -S npx tsx
// Real Chromium offline-runtime gate. No dev server or project/global state.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { Slide } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";
const { launch } = await import("./lib/driver.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-timeline-browser-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
let checks = 0;
function check(value: unknown, label: string) { assert.ok(value, label); checks++; console.log("  ok:", label); }
try {
  const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none";
  const slide: Slide = { id: "one", elements: [
    { type: "rect", id: "r", x: 30, y: 50, width: 80, height: 60, rotation: 35, opacity: .6, fill: "#4385be", stroke: "#222", strokeWidth: 1 },
    { type: "text", id: "t", x: 200, y: 60, width: 300, height: 40, rotation: 0, text: "Alpha", fontFamily: "Arial", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#fff", sizing: "fixed" },
  ], beats: [{ id: "base", tracks: [] }, { id: "reveal", tracks: [
    { id: "appearance", target: "r", preset: "fadeRise", duration: 400, easing: "linear" },
    { id: "movement", target: "r", preset: "transform", duration: 800, easing: "linear", to: { state: { x: 330, rotation: 60, opacity: .4 } } },
    { id: "beta", target: "t", preset: "transform", duration: 600, to: { state: { text: "Beta" } } },
  ] }, { id: "later", tracks: [{ id: "gamma", target: "t", preset: "transform", duration: 600, to: { state: { text: "Gamma" } } }] }] };
  const plots: Record<string, { svg: string; manifest: FluxPlotManifest }> = {};
  for (const [id, value, domain] of [["markerA", 2, 10], ["markerB", 8, 20]] as const) {
    const cy = 100 - value * 100 / domain;
    plots[id] = {
      manifest: { spec: "fluxplot", schemaVersion: "0.2.0", plotType: "scatter", svg: "", size: { width: 100, height: 100, unit: "px" }, axes: [{ x: { scale: "linear", domain: [0, 1], anchors: [{ data: 0, svg: 0 }, { data: 1, svg: 100 }] }, y: { scale: "linear", domain: [0, domain], anchors: [{ data: 0, svg: 100 }, { data: domain, svg: 0 }] } }], series: [{ id: "series", points: [{ index: 0, svgId: "p0", x: .5, y: value }] }] } as FluxPlotManifest,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect id="p0" x="48" y="${cy-2}" width="4" height="4" style="opacity:0.4"/><text id="tick" x="5" y="10">${domain}</text></svg>`,
    };
  }
  const data: Slide = { id: "data", elements: [{ id: "p", type: "plot", assetId: "markerA", x: 40, y: 40, width: 100, height: 100, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "show", tracks: [{ target: "p", part: "p0", preset: "fade", duration: 1000, easing: "linear" }] }, { id: "data", tracks: [{ target: "p", preset: "transform", duration: 1000, easing: "linear", to: { assetId: "markerB" } }] }] };
  const multiline: Slide = { id: "text-layout", elements: [{ ...slide.elements[1], text: "Count 10\nunits" } as Slide["elements"][number]], beats: [{ id: "base", tracks: [] }, { id: "value", tracks: [{ target: "t", preset: "transform", duration: 1000, easing: "linear", to: { state: { text: "Count 30\nunits", fontWeight: 600, fontSize: 30, width: 100 } } }] }] };
  const overlap: Slide = { id: "overlap", elements: [{ ...slide.elements[0], id: "overlap-box", opacity: 1 }], beats: [{ id: "base", tracks: [] }, { id: "show", tracks: [{ target: "overlap-box", preset: "fade", duration: 1000, easing: "linear" }, { target: "overlap-box", preset: "dim", start: 200, duration: 100, easing: "linear" }] }] };
  deck.slides = [slide, data, multiline, overlap];
  const out = await exportDeckHtml({ deck, plots }); const file = path.join(tmp, "talk.html"); await fs.writeFile(file, out.html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const inspect = () => page.evaluate(`(() => {
    const r=document.querySelector('[data-el-id="r"]'), effects=r.querySelector('.sl-effects');
    const visible=[...document.querySelectorAll('[data-el-id="t"] text')].filter(t=>{for(let p=t;p;p=p.parentElement)if(Number(getComputedStyle(p).opacity)===0)return false;return true;}).map(t=>t.textContent);
    return {left:r.style.left,rotation:r.style.transform,opacity:r.style.opacity,effectOpacity:getComputedStyle(effects).opacity,visible,state:window.fluxDeck.state()};
  })()`);
  await page.evaluate("window.fluxDeck.seek(0,1,200)"); const mid = await inspect();
  check(mid.rotation.includes("translate") && Number(mid.effectOpacity) === .5 && Number(mid.opacity) === .55, "precise offline seek composes entrance with geometry and authored opacity");
  await page.evaluate("window.fluxDeck.goTo(0,2)"); check((await inspect()).visible.includes("Gamma"), "fresh jump to final text paints Gamma");
  await page.evaluate("window.fluxDeck.goTo(0,1)"); const back = await inspect();
  check(back.visible.includes("Beta") && !back.visible.includes("Gamma"), "reverse seek paints Beta without future-layer residue");
  check(back.rotation === "rotate(60deg)" && Number(back.opacity) === .4 && back.left === "330px", "offline endpoint retains changed position, rotation, and opacity");
  await page.evaluate("window.fluxDeck.play({slide:0,fromBeat:1,toBeat:2})");
  await page.waitForFunction("window.fluxDeck.state().time > 60");
  await page.evaluate("window.fluxDeck.pause()"); const paused = (await inspect()).state;
  check(!paused.playing && paused.time > 0 && paused.time < 800, "pause keeps actual intermediate frame");
  await page.evaluate("window.fluxDeck.resume()"); await page.waitForFunction("window.fluxDeck.state().beat === 2 && !window.fluxDeck.state().playing");
  check((await inspect()).visible.includes("Gamma"), "resumed range playback reaches exact destination");
  await page.evaluate("window.fluxDeck.play({slide:0,fromBeat:1,toBeat:1,loop:true}); window.fluxDeck.stop()");
  await page.evaluate(`new Promise(resolve=>{let count=0;const check=()=>{if(++count===8)resolve();else requestAnimationFrame(check);};requestAnimationFrame(check);})`);
  check(!(await inspect()).state.playing && (await inspect()).state.time === 0, "stopped loop never resurrects through stale callbacks");
  const dataFrame = () => page.evaluate(`(() => {
    const marker=document.querySelector('[id="p__p0"]'), box=document.querySelector('[data-el-id="p"]').getBoundingClientRect(), rect=marker.getBoundingClientRect();
    return {cy:(rect.top+rect.height/2-box.top)/(box.height/100),opacity:getComputedStyle(marker).opacity,tick:document.querySelector('[id="p__tick"]').textContent};
  })()`);
  await page.evaluate("window.fluxDeck.seek(1,1,500)");
  check((await dataFrame()).opacity === "0.2", "offline part entrance factors authored opacity at midpoint");
  await page.evaluate("window.fluxDeck.seek(1,2,500)"); const dataMid = await dataFrame();
  check(Math.abs(dataMid.cy-62.5)<.05 && dataMid.opacity === "0.4", "offline noncircle marker has exact data-space position and preserves styled opacity after entrance");
  await page.evaluate("window.fluxDeck.goTo(1,2)"); const dataEnd = await dataFrame();
  check(Math.abs(dataEnd.cy-60)<.05 && dataEnd.tick === "20", "offline data and axis-label endpoint match complete destination");
  await page.evaluate("window.fluxDeck.goTo(1,0)"); const dataBack = await dataFrame();
  check(Math.abs(dataBack.cy-80)<.05 && dataBack.opacity === "0" && dataBack.tick === "10", "offline reverse restores source geometry, tick and hidden part");
  await page.evaluate("window.fluxDeck.seek(2,1,500)");
  const textFrame = () => page.evaluate(`(() => {const n=document.querySelector('[data-el-id="t"] text');return {lines:[...n.children].map(t=>t.textContent),weight:n.getAttribute('font-weight'),size:n.getAttribute('font-size')};})()`);
  const textMid = await textFrame();
  check(textMid.lines.join("|") === "Count 20|units" && textMid.weight === "500" && textMid.size === "27", "offline multiline digits, size and weight use the exact sampled text state");
  await page.evaluate("window.fluxDeck.goTo(2,1)");
  check((await textFrame()).lines.join("|") === "Count|30|units", "actual font measurement changes only the required wrapped lines");
  await page.evaluate("window.fluxDeck.goTo(2,0)");
  check((await textFrame()).lines.join("|") === "Count 10|units", "reverse text seek removes surplus wrapped lines");
  await page.evaluate("window.fluxDeck.play({slide:3,fromBeat:1,toBeat:1})");
  await page.waitForFunction("window.fluxDeck.state().time > 450");
  const overlapState = await page.evaluate(`({playing:window.fluxDeck.state().playing,opacity:getComputedStyle(document.querySelector('[data-el-id="overlap-box"] .sl-effects')).opacity})`);
  check(overlapState.playing && overlapState.opacity === "0.3", "a later completed dim owns opacity over an older still-active native fade");
  await page.evaluate("window.fluxDeck.stop()");
  check(errors.length === 0, `portable runtime console clean: ${errors.join("; ")}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
console.log(`\nSLIDE TIMELINE BROWSER: PASS (${checks} assertions)`);
