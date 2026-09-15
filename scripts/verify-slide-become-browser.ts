// Become in the actual exported HTML player (offline, real Chromium): the
// three-layer outline morph — the original nodes at t=0, one live path
// mid-flight, the real end markup at t=1 — with exact endpoints, finite
// geometry every frame, fading arrowheads, chained Becomes, a crossfade for
// kinds without an outline, reverse seeks, and a clean console.
// Run: node --import tsx scripts/verify-slide-become-browser.ts
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, becomeTransform } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { Element } from "../src/lib/types";
const { launch } = await import("./lib/driver.mjs");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-become-browser-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
let checks = 0;
const check = (v: unknown, label: string) => { assert.ok(v, label); checks++; console.log("  ok:", label); };
try {
  const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none";
  const slide = addSlide(deck, { id: "s", layout: "blank" });
  const els: Element[] = [
    { type: "line", id: "arrow", name: "Arrow", x: 60, y: 200, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 200, y2: -40, stroke: "#4385be", strokeWidth: 4, arrowStart: false, arrowEnd: true },
    { type: "ellipse", id: "blob", x: 360, y: 80, width: 180, height: 120, rotation: 0, fill: "#d14d41", stroke: "#100f0f", strokeWidth: 3 },
    { type: "rect", id: "box", x: 80, y: 60, width: 120, height: 80, rotation: 20, fill: "#879a39", stroke: "none", strokeWidth: 0, cornerRadius: 12 },
    { type: "path", id: "bracket", x: 400, y: 240, width: 60, height: 80, rotation: 0, d: "", fill: "none", stroke: "#d0a215", strokeWidth: 3, closed: false, nodes: [{ x: 60, y: 0, type: "corner" }, { x: 0, y: 0, type: "corner" }, { x: 0, y: 80, type: "corner" }, { x: 60, y: 80, type: "corner" }] },
    { type: "line", id: "pointer", x: 300, y: 300, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 150, y2: 0, stroke: "#ce5d97", strokeWidth: 3, arrowStart: false, arrowEnd: true, arrowStyle: "vee" },
    { type: "text", id: "label", x: 40, y: 20, width: 160, height: 30, rotation: 0, text: "Result", fontFamily: "Arial", fontSize: 20, fontWeight: 400, fontStyle: "normal", align: "left", color: "#ffffff", sizing: "auto" },
    { type: "rect", id: "card", x: 500, y: 20, width: 100, height: 40, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 4 },
  ];
  for (const el of els) addElement(deck, slide.id, el);
  (deck.slides[0].elements.find((e) => e.id === "bracket") as { d: string }).d = "M 60 0 L 0 0 L 0 80 L 60 80";
  const b1 = addBeat(deck, slide.id, { id: "b1" })!, b2 = addBeat(deck, slide.id, { id: "b2" })!;
  becomeTransform(deck, slide.id, b1.id, "arrow", "blob", { duration: 1000, easing: "linear" });     // inflate (filled ring)
  becomeTransform(deck, slide.id, b1.id, "bracket", "pointer", { duration: 1000, easing: "linear" }); // stroke → arrow (cut/open)
  becomeTransform(deck, slide.id, b1.id, "label", "card", { duration: 1000, easing: "linear" });      // text → rect: crossfade
  becomeTransform(deck, slide.id, b2.id, "arrow", "box", { duration: 1000, easing: "linear" });       // chained: ellipse → rotated rect
  const file = path.join(tmp, "become.html"); await fs.writeFile(file, (await exportDeckHtml({ deck })).html);
  check(deck.slides[0].elements.length === 3, "the export carries only the three surviving sources");
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const inspect = (id: string) => page.evaluate((target: string) => {
    const el = document.querySelector(`[data-el-id="${target}"]`) as HTMLElement;
    const stage = el.closest(".sl-camera")!.getBoundingClientRect(), rect = el.getBoundingClientRect();
    const scale = stage.width / 640;
    // chained transforms nest their three layers inside the previous end layer:
    // descend through the visible layer until a layer holds markup itself
    let host: HTMLElement = (el.querySelector(":scope > .sl-effects") as HTMLElement) ?? el;
    let layers = [...host.querySelectorAll(":scope > div")] as HTMLElement[];
    let visible = layers.filter((l) => getComputedStyle(l).visibility !== "hidden");
    const top = { layers: layers.length, visible: visible.length, opacity: layers.map((l) => l.style.opacity) };
    while (visible.length === 1 && visible[0].querySelector(":scope > div")) {
      host = visible[0];
      layers = [...host.querySelectorAll(":scope > div")] as HTMLElement[];
      visible = layers.filter((l) => getComputedStyle(l).visibility !== "hidden");
    }
    const shown = visible[0]?.querySelector("svg *:not(defs *)") as SVGElement | null;
    const body = visible[0]?.querySelector("path") as SVGPathElement | null;
    const heads = [...(visible[0]?.querySelectorAll("polygon, polyline") ?? [])].map((n) => ({ tag: n.tagName.toLowerCase(), opacity: n.getAttribute("opacity"), points: n.getAttribute("points") }));
    return {
      x: (rect.x - stage.x) / scale, y: (rect.y - stage.y) / scale, w: rect.width / scale, h: rect.height / scale,
      layers: top.layers, visible: top.visible, tag: shown?.tagName.toLowerCase() ?? null,
      d: body?.getAttribute("d") ?? null, fill: body?.getAttribute("fill") ?? null, dashes: body?.getAttribute("stroke-dasharray") ?? null,
      heads, transform: el.style.transform, layerOpacity: top.opacity,
    };
  }, id);
  // --- t = 0: the original markup, untouched -----------------------------------
  await page.evaluate("window.fluxDeck.seek(0,1,0)");
  const at0 = await inspect("arrow");
  check(at0.layers === 3 && at0.visible === 1 && at0.tag === "line", "t=0 shows the ORIGINAL <line> markup (layer A of three)");
  check(Math.abs(at0.x - 60) < 0.01 && Math.abs(at0.w - 200) < 0.01, "t=0 sits at the line's own box");
  // --- mid-flight: one live path, finite, between the boxes -----------------------
  await page.evaluate("window.fluxDeck.seek(0,1,500)");
  const mid = await inspect("arrow");
  check(mid.visible === 1 && mid.tag === "path" && !!mid.d && !/NaN|Infinity/.test(mid.d!), "t=.5 shows the live morph <path> only, finite geometry");
  check(Math.abs(mid.x - 210) < 0.6 && Math.abs(mid.w - 190) < 0.6 && Math.abs(mid.h - 80) < 0.6, `t=.5 box is the lerp of the endpoint boxes (got ${mid.x.toFixed(1)},${mid.w.toFixed(1)}×${mid.h.toFixed(1)})`);
  check(/^#[0-9a-f]{8}$/i.test(mid.fill!) && parseInt(mid.fill!.slice(7), 16) > 100 && parseInt(mid.fill!.slice(7), 16) < 160, `fill alpha ramps in mid-way (got ${mid.fill})`);
  check(mid.transform.includes("translate(") && mid.transform.includes("scale("), "mid-flight box rides a compositor transform, not layout");
  const head0 = (await (async () => { await page.evaluate("window.fluxDeck.seek(0,1,100)"); return inspect("arrow"); })()).heads;
  check(head0.length === 1 && head0[0].tag === "polygon" && Math.abs(Number(head0[0].opacity) - 0.75) < 0.01, "the arrowhead melts away as the stroke inflates (opacity .75 at t=.1)");
  await page.evaluate("window.fluxDeck.seek(0,1,500)");
  check(Number((await inspect("arrow")).heads[0].opacity) === 0, "…and is gone by t=.5");
  // --- t = 1: the real end markup --------------------------------------------------
  await page.evaluate("window.fluxDeck.seek(0,1,1000)");
  const at1 = await inspect("arrow");
  check(at1.visible === 1 && at1.tag === "ellipse" && Math.abs(at1.x - 360) < 0.01 && Math.abs(at1.w - 180) < 0.01, "t=1 shows the real <ellipse> markup at the target's box (layer B)");
  check(!at1.transform.includes("scale("), "the endpoint rests in classic layout (no composite residue)");
  // --- stroke → arrow: the ring never enters; the head fades IN on the open intermediate
  await page.evaluate("window.fluxDeck.seek(0,1,500)");
  const br = await inspect("bracket");
  check(br.tag === "path" && br.fill === "none" && br.heads.some((h) => h.tag === "polyline" && !!h.points && Math.abs(Number(h.opacity) - 0.5) < 0.01), "bracket → vee arrow: open path, no fill, the vee head fading in at .5");
  await page.evaluate("window.fluxDeck.seek(0,1,200)");
  const brEarly = await inspect("bracket");
  check(brEarly.heads.some((h) => h.tag === "polyline" && !!h.points && Math.abs(Number(h.opacity) - 0.2) < 0.01) && !brEarly.heads.some((h) => h.tag === "polygon" && !!h.points), "the head keeps the ARROW's own style (vee) for the whole fade — no filled/vee pop at .5");
  await page.evaluate("window.fluxDeck.seek(0,1,1000)");
  const brEnd = await inspect("bracket");
  check(brEnd.tag === "line" && Math.abs(brEnd.x - 300) < 0.01 && Math.abs(brEnd.w - 150) < 0.01, "…and IS the arrow at the end");
  // --- text → rect: a crossfade over the lerped box --------------------------------
  await page.evaluate("window.fluxDeck.seek(0,1,500)");
  const tx = await inspect("label");
  check(tx.layers === 2 && tx.layerOpacity[0] === "0.5" && tx.layerOpacity[1] === "0.5" && Math.abs(tx.x - 270) < 0.6, "text → rect crossfades two layers while the box tweens");
  // --- chained: ellipse → rotated rounded rect, from the first Become's end ---------
  await page.evaluate("window.fluxDeck.seek(0,2,0)");
  const c0 = await inspect("arrow");
  check(c0.tag === "ellipse", "the second Become starts from the first's endpoint (the ellipse)");
  await page.evaluate("window.fluxDeck.seek(0,2,500)");
  const c5 = await inspect("arrow");
  check(c5.tag === "path" && /rotate\(10deg\)/.test(c5.transform), "chained mid-flight morphs the ellipse and lerps rotation (0 → 20 = 10°)");
  await page.evaluate("window.fluxDeck.seek(0,2,1000)");
  const c1 = await inspect("arrow");
  check(c1.tag === "rect" && c1.transform === "rotate(20deg)" && Math.abs(c1.w - 140.12) < 0.1, "…and ends as the real <rect>, rotated 20° in classic layout");
  // --- reverse seek restores the original nodes ---------------------------------------
  await page.evaluate(`window.__origLine=document.querySelector('[data-el-id="arrow"] line')`);
  await page.evaluate("window.fluxDeck.seek(0,1,0)");
  const back = await inspect("arrow");
  check(back.tag === "line" && await page.evaluate(`window.__origLine===document.querySelector('[data-el-id="arrow"] line')`), "a reverse seek shows the SAME original <line> node (identity preserved, nothing re-rendered)");
  // --- real clock playback: every frame finite, monotone box ---------------------------
  await page.evaluate(`window.__frames=[];const sample=()=>{const el=document.querySelector('[data-el-id="arrow"]');const d=el.querySelector('path')?.getAttribute('d')??'';window.__frames.push({t:window.fluxDeck.state().time,bad:/NaN|Infinity/.test(d),vis:[...el.querySelectorAll(':scope > div')].filter(l=>getComputedStyle(l).visibility!=='hidden').length});if(window.fluxDeck.state().playing)requestAnimationFrame(sample);};window.fluxDeck.play({slide:0,fromBeat:1,toBeat:1});requestAnimationFrame(sample)`);
  await page.waitForFunction("!window.fluxDeck.state().playing && window.fluxDeck.state().time===1000", { timeout: 5000 });
  const frames = await page.evaluate("window.__frames") as { t: number; bad: boolean; vis: number }[];
  check(frames.length > 20 && frames.every((f) => !f.bad && f.vis === 1), `real playback: ${frames.length} frames, all finite, exactly one layer visible each frame`);
  check(errors.length === 0, `offline Become runtime has a clean console: ${errors.join("; ")}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
console.log(`BECOME BROWSER: PASS (${checks} assertions)`);
