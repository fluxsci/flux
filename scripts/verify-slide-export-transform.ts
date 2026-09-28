#!/usr/bin/env -S npx tsx
// Animation rework §9/§12 — the EXPORTED runtime plays transforms + trims.
// Author a deck through the pure ops (a trim drawOn beat + a chained transform
// beat), export via flux-core, then boot the self-contained .html in headless
// Chrome with prefers-reduced-motion explicitly 'no-preference' (headless
// defaults to 'reduce', which snaps every animation to its end — the trap
// that makes broken motion look finished). Assert:
//   • static frame-stepping (fluxDeck.goTo) lands the composed states,
//   • REAL keypress playback produces mid-flight frames ≠ both endpoints
//     (box position for the transform; a growing dash window for the trim),
//   • the end state matches the authored t2 exactly (box + fill),
//   • chained rest states never leak a future transform.
// Run: npx tsx scripts/verify-slide-export-transform.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../flux-core/index";
import * as slides from "../flux-core/slides";
import * as slideOps from "../src/lib/slide/ops";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-export-transform-"));
let browser: { close(): Promise<void> } | null = null;
try {
  await core.scaffold(root, { title: "Transform Export" });

  // --- author: one slide, a stroke-only rect + a title ------------------------
  const deck = slideOps.createDeck({ id: "talk", title: "Transforms", withTitleSlide: false });
  const sid = slideOps.addSlide(deck, { name: "S1", layout: "blank" }).id;
  slideOps.addSlideText(deck, sid, { text: "Trim + Transform", x: 40, y: 20, width: 400, height: 40, fontSize: 24 });
  const rectId = slideOps.addElement(deck, sid, {
    type: "rect", id: "r_hero", x: 60, y: 120, width: 160, height: 90, rotation: 0,
    fill: "none", stroke: "#4385be", strokeWidth: 3, cornerRadius: 0,
  })!;
  // beat 1: trim drawOn — both ends meet in the middle
  const b1 = slideOps.addBeat(deck, sid, { label: "draw" })!;
  slideOps.setAnimation(deck, sid, b1.id, {
    target: rectId, preset: "drawOn", duration: 700,
    params: { mode: "both-ends" },
  });
  // beat 2: transform — move + grow + recolor the stroke
  const b2 = slideOps.addBeat(deck, sid, { label: "become" })!;
  slideOps.setTransform(deck, sid, b2.id, rectId, {
    state: { x: 360, y: 180, width: 220, stroke: "#d14d41" },
    duration: 600,
  });
  // beat 3: a second (chained) transform — shrink back width
  const b3 = slideOps.addBeat(deck, sid, { label: "again" })!;
  slideOps.setTransform(deck, sid, b3.id, rectId, { state: { width: 80 }, duration: 400 });
  await slides.saveDeck(root, deck);

  const res = await slides.exportDeck(root, "talk");
  const html = await fs.readFile(res.path, "utf8");
  assert(html.includes("FluxSlideRuntime.boot("), "export emitted a bootable document");

  // --- boot headless -----------------------------------------------------------
  const { launch } = await import("./lib/driver.mjs");
  const launched = await launch();
  browser = launched.browser;
  const page = launched.page;
  // headless Chrome reports prefers-reduced-motion: reduce — force it OFF so
  // motion actually animates (the export forces motion on regardless, but the
  // gate must not depend on that quirk).
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(String(e)));
  await page.goto(pathToFileURL(res.path).href, { waitUntil: "load" });
  await page.waitForFunction("!!window.fluxDeck");

  const SEL = `[data-el-id="${rectId}"]`;
  const boxOf = () =>
    page.evaluate((sel: string) => {
      const w = document.querySelector(sel) as HTMLElement | null;
      if (!w) return null;
      const rect = w.querySelector("rect");
      return { left: w.style.left, width: w.style.width, stroke: rect?.getAttribute("stroke") ?? "" };
    }, SEL);

  // --- static frame-stepping (fluxDeck.goTo is animation-off by design) --------
  await page.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 0));
  let b = (await boxOf())!;
  assert(b.left === "60px" && b.width === "160px", `beat 0 rests at the base box (got ${b.left}/${b.width})`);
  await page.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 2));
  b = (await boxOf())!;
  assert(b.left === "360px" && b.width === "220px" && b.stroke === "#d14d41", "beat 2 rests at the composed t2 (box + stroke color)");
  await page.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 1));
  b = (await boxOf())!;
  assert(b.left === "60px" && b.stroke === "#4385be", "stepping BACK to beat 1 restores the pre state — the future transform leaks nothing");
  await page.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 3));
  b = (await boxOf())!;
  assert(b.width === "80px" && b.left === "360px", "beat 3 composes the CHAIN (second transform over the first)");

  // --- real playback: the trim beat draws through a growing window -------------
  await page.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 0));
  // string-evaluated: a nested function declaration would drag in tsx's
  // __name helper, which doesn't exist in the page.
  await page.evaluate(`(() => {
    window.__dash = [];
    var rect = document.querySelector('${SEL}').querySelector('rect');
    var collect = function () {
      window.__dash.push(getComputedStyle(rect).strokeDasharray);
      if (window.__dash.length < 90) requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
  })()`);
  await page.keyboard.press("ArrowRight"); // play beat 1 (the trim draw)
  await page.waitForFunction("window.__dash && window.__dash.length >= 60", { timeout: 5000 });
  const dashes = (await page.evaluate(() => (window as never as { __dash: string[] }).__dash)) as string[];
  const distinct = [...new Set(dashes.filter((d) => d && d !== "none"))];
  assert(distinct.length > 5, `the trim dash window actually ANIMATES (${distinct.length} distinct mid-flight values)`);
  // a rect is a CLOSED loop → symmetric growth about the anchor takes the
  // 2-entry [k, L−k] pattern form, k growing monotonically to the perimeter
  const grows = distinct
    .map((d) => parseFloat(d))
    .filter((v) => Number.isFinite(v));
  assert(
    distinct.every((d) => d.split(",").length === 2) && Math.max(...grows) > Math.min(...grows) + 50,
    `…in the closed 2-entry [k, L−k] form with a growing window (k ${Math.min(...grows).toFixed(0)}→${Math.max(...grows).toFixed(0)})`,
  );

  // --- real playback: the transform beat moves through intermediate frames -----
  // Mid-flight the wrapper's LAYOUT stays frozen at the t1 box and motion
  // rides a compositor transform (the glide fix — layout-property animation
  // pixel-snaps to whole stage px under the fit-scale). Effective x = frozen
  // left + the transform's translate-x. Endpoints still write classic layout.
  await page.evaluate(`(() => {
    window.__lefts = [];
    var w = document.querySelector('${SEL}');
    var collect = function () {
      var m = /translate\\(([-0-9.]+)px/.exec(w.style.transform || "");
      window.__lefts.push({ left: w.style.left, eff: (parseFloat(w.style.left) || 0) + (m ? parseFloat(m[1]) : 0), composite: !!m });
      if (window.__lefts.length < 90) requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
  })()`);
  await page.keyboard.press("ArrowRight"); // play beat 2 (the transform)
  await page.waitForFunction("window.__lefts && window.__lefts.length >= 60", { timeout: 5000 });
  const lefts = (await page.evaluate(() => (window as never as { __lefts: { left: string; eff: number; composite: boolean }[] }).__lefts)) as { left: string; eff: number; composite: boolean }[];
  const mid = lefts.filter((v) => Number.isFinite(v.eff) && v.eff > 70 && v.eff < 350);
  assert(mid.length >= 5, `transform playback produced real mid-flight frames (${mid.length} samples strictly between the endpoints)`);
  assert(mid.every((v) => v.composite && v.left === "60px"), "mid-flight frames are COMPOSITE: layout frozen at the t1 box, motion on the transform (the glide fix)");
  const settled = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement;
    return { left: el.style.left, transform: el.style.transform, origin: el.style.transformOrigin };
  }, SEL);
  assert(parseFloat(settled.left) === 360, `…and settles exactly at t2 (left ${settled.left})`);
  assert(!/translate/.test(settled.transform) && settled.origin !== "0px 0px", "…with the classic layout box restored at rest (no composite residue)");
  const strokeMid = await page.evaluate((sel: string) => document.querySelector(sel)!.querySelector("rect")!.getAttribute("stroke"), SEL);
  assert(strokeMid === "#d14d41", "the stroke color landed at the t2 OKLab endpoint");

  assert(pageErrors.length === 0, `zero page errors while booting + playing (${pageErrors.join("; ") || "clean"})`);

  // ── the anim_test regression pins (owner report 2026-07-18) ────────────────
  // A second deck: an ellipse drawOn (browser getTotalLength UNDERSHOOTS the
  // painted perimeter ~0.6% → the old compile leaked a pre-beat sliver + a
  // resting seam notch), an arrow line drawOn (filled head polygon — dash
  // hides strokes only), a writeOn text (clip-path clips box overflow), and a
  // plot-free check of svg display (inline svgs sat on the host's text
  // BASELINE — a 1px-tall line's content rendered ~12px low, host-dependent).
  const deck2 = slideOps.createDeck({ id: "pins", title: "Pins", withTitleSlide: false });
  const s2 = slideOps.addSlide(deck2, { name: "P", layout: "blank" }).id;
  slideOps.addElement(deck2, s2, {
    type: "ellipse", id: "e_ring", x: 80, y: 150, width: 30, height: 30, rotation: 0,
    fill: "none", stroke: "#222222", strokeWidth: 6,
  })!;
  slideOps.addElement(deck2, s2, {
    type: "line", id: "l_arrow", x: 40, y: 320, width: 0, height: 0, rotation: 0,
    x1: 0, y1: 0, x2: 86, y2: -0.2, stroke: "#222222", strokeWidth: 2, arrowStart: false, arrowEnd: true,
  } as never)!;
  slideOps.addSlideText(deck2, s2, { text: "Write me on", x: 200, y: 120, fontSize: 9.5 });
  const wtId = slideOps.slideById(deck2, s2)!.elements.at(-1)!.id;
  const pb = slideOps.addBeat(deck2, s2, { label: "draw" })!;
  slideOps.setAnimation(deck2, s2, pb.id, { target: "e_ring", preset: "drawOn", duration: 400 });
  slideOps.setAnimation(deck2, s2, pb.id, { target: "l_arrow", preset: "drawOn", duration: 400 });
  slideOps.setAnimation(deck2, s2, pb.id, { target: wtId, preset: "writeOn", duration: 300 });
  await slides.saveDeck(root, deck2);
  const res2 = await slides.exportDeck(root, "pins");
  const page2 = await (browser as unknown as { newPage(): Promise<typeof page> }).newPage();
  await page2.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page2.goto(pathToFileURL(res2.path).href, { waitUntil: "load" });
  await page2.waitForFunction("!!window.fluxDeck");
  await page2.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 0));
  const pre = await page2.evaluate(() => {
    const ell = document.querySelector('[data-el-id="e_ring"] ellipse') as SVGGeometryElement;
    const poly = document.querySelector('[data-el-id="l_arrow"] polygon') as SVGElement;
    const line = document.querySelector('[data-el-id="l_arrow"] line') as SVGElement;
    const svgs = [...document.querySelectorAll('[data-el-id] svg')] as SVGElement[];
    return {
      dash: parseFloat(ell.style.strokeDasharray || "0"),
      measured: ell.getTotalLength(),
      truePerimeter: 2 * Math.PI * 15,
      polyOpacity: getComputedStyle(poly).opacity,
      lineHidden: line.style.strokeDashoffset !== "" && line.style.strokeDashoffset !== "0",
      displays: [...new Set(svgs.map((s) => getComputedStyle(s).display))],
    };
  });
  assert(pre.dash > pre.truePerimeter, `the draw dasharray OVERSHOOTS the true perimeter (${pre.dash.toFixed(2)} > ${pre.truePerimeter.toFixed(2)}; measured was ${pre.measured.toFixed(2)})`);
  assert(pre.polyOpacity === "0", "the filled arrowhead is HIDDEN before the draw (opacity, not dash)");
  assert(pre.lineHidden, "the arrow line rests undrawn (offset form — no zero-dash cap dots)");
  assert(pre.displays.length === 1 && pre.displays[0] === "block", "content svgs are display:block (no host-baseline offset — the 12px-low arrow bug)");
  await page2.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 1));
  const post = await page2.evaluate(() => {
    const ell = document.querySelector('[data-el-id="e_ring"] ellipse') as SVGGeometryElement;
    const poly = document.querySelector('[data-el-id="l_arrow"] polygon') as SVGElement;
    const wt = [...document.querySelectorAll("[data-el-id]")].find((w) => w.querySelector("text")?.textContent?.includes("Write me on")) as HTMLElement;
    return {
      offset: ell.style.strokeDashoffset,
      dash: parseFloat(ell.style.strokeDasharray || "0"),
      polyOpacity: getComputedStyle(poly).opacity,
      clip: (wt?.querySelector(".sl-effects") as HTMLElement ?? wt)?.style.clipPath ?? "",
    };
  });
  assert(post.offset === "" && post.dash === 0, "the drawn rest state restores the authored solid stroke without a temporary dash seam");
  assert(post.polyOpacity === "1", "the arrowhead pops in with the draw");
  assert(post.clip.includes("-20%"), `writeOn's resting clip keeps the overflow margin (descenders survive: ${post.clip})`);
  // The portable runtime must carry M2 as well. This deck stays in memory until
  // M3 adds curve validation; exportDeckHtml accepts the compiled payload directly.
  const { exportDeckHtml } = await import("../src/lib/slide/export/exportDeck");
  const springDeck = slideOps.createDeck({ withTitleSlide: false }); springDeck.defaults.transition = "none";
  const springSlide = slideOps.addSlide(springDeck, { layout: "blank" });
  slideOps.addElement(springDeck, springSlide.id, { type: "rect", id: "spring", x: 400, y: 100, width: 40, height: 40, rotation: 0, fill: "#ffffff", stroke: "none", strokeWidth: 0 });
  const springBeat = slideOps.addBeat(springDeck, springSlide.id)!;
  springBeat.tracks = [{ target: "spring", preset: "transform", duration: 1000, curve: { kind: "spring", bounce: .5 }, to: { state: { x: 600 } } }];
  const springFile = path.join(root, "spring.html"); await fs.writeFile(springFile, (await exportDeckHtml({ deck: springDeck })).html);
  await page2.goto(pathToFileURL(springFile).href); await page2.waitForFunction("!!window.fluxDeck?.seek");
  const seekPeak = await page2.evaluate(() => {
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      (window as any).fluxDeck.seek(0, 1, 1000 * i / 59);
      const box = document.querySelector('[data-el-id="spring"]') as HTMLElement;
      const m = /translate\(([-\d.]+)px/.exec(box.style.transform);
      peak = Math.max(peak, parseFloat(box.style.left) + Number(m?.[1] ?? 0));
    }
    return peak;
  });
  assert(seekPeak >= 605, `exported HTML seek overshoots 600px (peak ${seekPeak.toFixed(3)})`);
  await page2.evaluate(`(() => {
    window.__springX = [];
    const collect = () => {
      const box = document.querySelector('[data-el-id="spring"]');
      const m = /translate\\(([-\\d.]+)px/.exec(box.style.transform);
      window.__springX.push(parseFloat(box.style.left) + Number(m?.[1] ?? 0));
      if (window.fluxDeck.state().playing) requestAnimationFrame(collect);
    };
    window.fluxDeck.play({slide:0,fromBeat:1,toBeat:1}); requestAnimationFrame(collect);
  })()`);
  await page2.waitForFunction("window.__springX.length > 2 && !window.fluxDeck.state().playing");
  const playback = await page2.evaluate("({ peak: Math.max(...window.__springX), end: document.querySelector('[data-el-id=\"spring\"]').style.left })") as { peak: number; end: string };
  assert(playback.peak >= 605 && playback.end === "600px", `exported HTML rAF overshoots and settles exactly (peak ${playback.peak.toFixed(3)})`);
  // Regenerated plots keep shared series live despite changed tick topology.
  const plots = slideOps.createDeck({ id: "partial", title: "Partial binding", withTitleSlide: false });
  const ps = slideOps.addSlide(plots, { name: "Plots", layout: "blank" }).id;
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  for (const name of ["panels-a", "panels-b"]) {
    for (const ext of ["svg", "fluxplot.json"]) await fs.copyFile(path.join(import.meta.dirname, `fixtures/fluxplot03/${name}.${ext}`), path.join(root, "plots", `${name}.${ext}`));
  }
  const plotId = slideOps.addElement(plots, ps, { id: "partial-plot", type: "plot", assetId: "panels-a", source: { svgPath: "plots/panels-a.svg", manifestPath: "plots/panels-a.fluxplot.json" }, x: 40, y: 40, width: 760, height: 400, rotation: 0 })!;
  const change = slideOps.addBeat(plots, ps, { label: "Fewer ticks" })!;
  slideOps.setTransform(plots, ps, change.id, plotId, { toAssetId: "panels-b", svgPath: "plots/panels-b.svg", manifestPath: "plots/panels-b.fluxplot.json", duration: 1000, easing: "linear" });
  const back = slideOps.addBeat(plots, ps, { label: "More ticks" })!;
  slideOps.setTransform(plots, ps, back.id, plotId, { toAssetId: "panels-a", svgPath: "plots/panels-a.svg", manifestPath: "plots/panels-a.fluxplot.json", duration: 1000, easing: "linear" });
  await slides.saveDeck(root, plots);
  const partial = await slides.exportDeck(root, "partial");
  const page3 = await (browser as unknown as { newPage(): Promise<typeof page> }).newPage();
  page3.on("pageerror", (e: Error) => pageErrors.push(String(e)));
  await page3.goto(pathToFileURL(partial.path).href, { waitUntil: "load" });
  await page3.waitForFunction("!!window.fluxDeck");
  const samplePlot = async (beat: number, ms: number) => page3.evaluate(([beat, ms]) => {
    (window as unknown as { fluxDeck: { seek(s: number, b: number, ms: number): void } }).fluxDeck.seek(0, beat, ms);
    const root = document.querySelector('[data-el-id="partial-plot"]')!;
    const ticks = [4, 5].map(i => { const node = root.querySelector(`[id="partial-plot__panel.small.axis.y.tick.${i}"]`)!; return { present: !!node, opacity: Number(getComputedStyle(node).opacity) }; });
    return { ticks, count: root.querySelectorAll("svg").length, d: root.querySelector('[id="partial-plot__panel.small.control.line"] path')!.getAttribute("d") };
  }, [beat, ms]);
  const plotStart = await samplePlot(1, 0), plotMiddle = await samplePlot(1, 500), plotEnd = await samplePlot(1, 1000);
  assert(plotMiddle.count === 1, "exported plot has one SVG, not complete crossfade layers");
  assert(plotMiddle.d !== plotStart.d && plotMiddle.d !== plotEnd.d, "exported shared line tweens through different tick counts");
  assert(plotMiddle.ticks.every(t => t.present && t.opacity === 0), "outgoing ticks remain bound but are hidden by the midpoint");
  assert(plotEnd.ticks.every(t => t.opacity === 0), "only destination ticks paint at t=1");
  const returnLate = await samplePlot(2, 800);
  assert(returnLate.ticks.every(t => Math.abs(t.opacity - .5) < 1e-6), "chained incoming ticks fade over the final 40 percent");
  const returnStart = await samplePlot(2, 0);
  assert(returnStart.ticks.every(t => t.opacity === 0), "reverse seek hides incoming tick clones");
  assert(pageErrors.length === 0, "exported partial plot player has no console errors");
  await page3.close();
  await page2.close();
} finally {
  await browser?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

console.log("\nSLIDE EXPORT TRANSFORM (offline runtime plays trims + transform chains + draw/clip pins): PASS");
