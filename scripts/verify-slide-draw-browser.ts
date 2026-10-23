#!/usr/bin/env -S npx tsx
// T3 DRAW (WP 1.4) — the real-player contract of drawOn / drawOff / writeOn in headless Chrome (exported runtime,
// fluxDeck.seek = the video-capture path). Every number below is measured on a frame the player paints:
//   * a filled+stroked shape TRACES its outline first and fills after (it used to show nothing for 20+ frames, then
//     fade): first ink within 2 frames, fill 0 until 45 % of the clock, ramp to the end;
//   * a filled arrowhead GROWS from the shaft's end exactly when the pen arrives (scale origin = the head's base
//     midpoint), a dashed line draws dash by dash with the authored pattern;
//   * a path with pathLength="1000" draws to the same fraction as one without (X12: dash math in pathLength units);
//   * the rest state carries NO temporary style (the authored attributes are the rest state);
//   * writeOn: the hard clip is ink-fitted (no dead lead, no dead tail, descender margin kept); a PLOT never takes a mask;
//   * X13: an old-style tick track (one drawOn, no stagger) plays with its ticks FOLLOWING the pen, same cue length;
//     `{ perMs: 0 }` restores the old simultaneous look;
//   * (WP 2.4) params.edge "soft" feathers a TEXT writeOn with a gradient mask (feather 0.9 x font size, the edge travelling
//     -F -> 100 %, none at rest); "hard" and an absent edge keep the clip; a plot, or a mixed target, never takes a mask;
//   * (WP 2.4, X4) params.order "sequence" draws the strokes of one multi-path drawing one after another at ONE pen speed
//     (true pen length as weight, pathLength never), an exit retreats the last stroke first, and absent = together;
//   * drawOn -> drawOff -> drawOn rest states, reverse seeks, supersession; zero page errors.
// Run: npx tsx scripts/verify-slide-draw-browser.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as slides from "../flux-core/slides";
import * as core from "../flux-core/index";
import * as slideOps from "../src/lib/slide/ops";
import { DRAW_REACH_EPS } from "../src/lib/slide/player/trim";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-slide-draw-browser");
function assert(cond: unknown, msg: string) {
  if (!h.ok(cond, msg)) throw new Error("FAIL: " + msg);
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-draw-browser-"));
let browser: { close(): Promise<void> } | null = null;
try {
  await core.scaffold(root, { title: "Draw" });
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  for (const ext of ["svg", "fluxplot.json"]) await fs.copyFile(path.join(import.meta.dirname, `fixtures/fluxplot03/panels-a.${ext}`), path.join(root, "plots", `panels-a.${ext}`));
  for (const ext of ["svg", "fluxplot.json"]) await fs.copyFile(path.join(import.meta.dirname, `fixtures/plots/mpl_scatter_FLUXPLOT.${ext}`), path.join(root, "plots", `mpl_scatter.${ext}`));

  // one slide, one element per behaviour; every track is 1000 ms LINEAR so progress = time / 1000
  const build = (id: string) => {
    const deck = slideOps.createDeck({ id, title: id, withTitleSlide: false });
    const sid = slideOps.addSlide(deck, { name: "S", layout: "blank" }).id;
    slideOps.addElement(deck, sid, { type: "ellipse", id: "e_disc", x: 40, y: 40, width: 60, height: 60, rotation: 0, fill: "#d14d41", stroke: "#222222", strokeWidth: 4 } as never);
    slideOps.addElement(deck, sid, { type: "line", id: "l_arrow", x: 40, y: 150, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 120, y2: 0, stroke: "#222222", strokeWidth: 2, arrowStart: false, arrowEnd: true } as never);
    slideOps.addElement(deck, sid, { type: "line", id: "l_dash", x: 40, y: 200, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 200, y2: 0, stroke: "#222222", strokeWidth: 2, arrowStart: false, arrowEnd: false, dash: [6, 4] } as never);
    slideOps.addSlideText(deck, sid, { text: "Write me on", x: 300, y: 60, width: 300, height: 40, fontSize: 24 });
    const tid = slideOps.slideById(deck, sid)!.elements.at(-1)!.id;
    const plotId = slideOps.addElement(deck, sid, { id: "pl", type: "plot", assetId: "panels-a", source: { svgPath: "plots/panels-a.svg", manifestPath: "plots/panels-a.fluxplot.json" }, x: 300, y: 120, width: 320, height: 200, rotation: 0 } as never)!;
    const b = slideOps.addBeat(deck, sid, { label: "draw" })!;
    const add = (target: string, preset: string, params?: Record<string, unknown>) => slideOps.setAnimation(deck, sid, b.id, { target, preset, duration: 1000, easing: "linear", ...(params ? { params } : {}) } as never);
    add("e_disc", "drawOn"); add("l_arrow", "drawOn"); add("l_dash", "drawOn");
    add(tid, "writeOn"); add(plotId, "writeOn");
    return { deck, tid };
  };
  const classic = build("classic");
  // drawOn -> drawOff -> drawOn on one filled+stroked shape (rest states, reverse seeks, supersession)
  const cyc = slideOps.createDeck({ id: "cycle", title: "cycle", withTitleSlide: false });
  const cs = slideOps.addSlide(cyc, { name: "C", layout: "blank" }).id;
  slideOps.addElement(cyc, cs, { type: "ellipse", id: "e_cyc", x: 40, y: 40, width: 60, height: 60, rotation: 0, fill: "#d14d41", stroke: "#222222", strokeWidth: 4 } as never);
  for (const preset of ["drawOn", "drawOff", "drawOn"]) { const bb = slideOps.addBeat(cyc, cs, { label: preset })!; slideOps.setAnimation(cyc, cs, bb.id, { target: "e_cyc", preset, duration: 400, easing: "linear" } as never); }
  await slides.saveDeck(root, cyc);
  await slides.saveDeck(root, classic.deck);
  // X12: a plot whose x spine carries pathLength="1000" (a 148-unit stroke) next to a y spine without it, both drawn over
  // 1000 ms linear: they must draw to the same FRACTION (the dash math runs in pathLength units)
  {
    const svg = (await fs.readFile(path.join(import.meta.dirname, "fixtures/plots/mpl_scatter_FLUXPLOT.svg"), "utf8"))
      .replace(/(id="axis\.x\.spine"[^>]*>\s*<path )/, '$1pathLength="1000" ');
    if (!svg.includes('pathLength="1000"')) throw new Error("fixture patch missed the x spine");
    await fs.writeFile(path.join(root, "plots", "pathlen.svg"), svg);
    await fs.copyFile(path.join(import.meta.dirname, "fixtures/plots/mpl_scatter_FLUXPLOT.fluxplot.json"), path.join(root, "plots", "pathlen.fluxplot.json"));
  }
  const pdk = slideOps.createDeck({ id: "pathlen", title: "pathlen", withTitleSlide: false });
  const pls = slideOps.addSlide(pdk, { name: "P", layout: "blank" }).id;
  slideOps.addElement(pdk, pls, { id: "pp", type: "plot", assetId: "pathlen", source: { svgPath: "plots/pathlen.svg", manifestPath: "plots/pathlen.fluxplot.json" }, x: 40, y: 20, width: 360, height: 180, rotation: 0 } as never);
  { const bb = slideOps.addBeat(pdk, pls, { label: "draw" })!; for (const part of ["axis.x.spine", "axis.y.spine"]) slideOps.setAnimation(pdk, pls, bb.id, { target: "pp", part, preset: "drawOn", duration: 1000, easing: "linear" } as never); }
  await slides.saveDeck(root, pdk);
  // X13: three plots of the same scatter; beat 1 = x ticks of A, beat 2 = y ticks of A (both OLD-style: one drawOn, no stagger),
  // beat 3 = x ticks of B with { perMs: 0 } (the opt-out), beat 4 = x ticks of C with an explicit Each stagger
  const tk = slideOps.createDeck({ id: "ticks", title: "ticks", withTitleSlide: false });
  const tks = slideOps.addSlide(tk, { name: "T", layout: "blank" }).id;
  const plotEl = (id: string, y: number) => slideOps.addElement(tk, tks, { id, type: "plot", assetId: "mpl_scatter", source: { svgPath: "plots/mpl_scatter.svg", manifestPath: "plots/mpl_scatter.fluxplot.json" }, x: 40, y, width: 360, height: 180, rotation: 0 } as never)!;
  const [pa, pb, pc2] = [plotEl("pa", 20), plotEl("pb", 220), plotEl("pc", 420)];
  const tickBeat = (target: string, part: string, extra: Record<string, unknown> = {}) => { const bb = slideOps.addBeat(tk, tks, { label: part })!; slideOps.setAnimation(tk, tks, bb.id, { target, part, preset: "drawOn", duration: 800, easing: "linear", ...extra } as never); };
  tickBeat(pa, "axis.x.ticks"); tickBeat(pa, "axis.y.ticks"); tickBeat(pb, "axis.x.ticks", { stagger: { perMs: 0 } }); tickBeat(pc2, "axis.x.ticks", { stagger: { perMs: 40, by: "x", from: "start" } });
  await slides.saveDeck(root, tk);

  // WP 2.4: a multi-path drawing (a house, its roof and a sun: 3 strokes, the roof declares pathLength 1000 on a 170-unit stroke) drawn in
  // ORDER, and four writeOns that differ only in params.edge
  await fs.writeFile(path.join(root, "plots", "house.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200"><path id="house.walls" d="M 20 180 H 120 V 100 H 20 Z" fill="none" stroke="#222" stroke-width="3"/><path id="house.roof" d="M 10 100 L 70 40 L 130 100" fill="none" stroke="#222" stroke-width="3" pathLength="1000"/><circle id="house.sun" cx="220" cy="60" r="20" fill="none" stroke="#d0a215" stroke-width="3"/></svg>`);
  const ord = slideOps.createDeck({ id: "order", title: "order", withTitleSlide: false });
  const os2 = slideOps.addSlide(ord, { name: "O", layout: "blank" }).id;
  slideOps.addElement(ord, os2, { id: "house", type: "plot", assetId: "house", source: { svgPath: "plots/house.svg" }, x: 40, y: 20, width: 300, height: 200, rotation: 0 } as never);
  for (const [i, params] of [{ order: "sequence", lag: 1 }, undefined, { order: "sequence", lag: 1 }, { order: "sequence" }].entries()) {
    const bb = slideOps.addBeat(ord, os2, { label: `b${i}` })!;
    slideOps.setAnimation(ord, os2, bb.id, { target: "house", preset: i === 2 ? "drawOff" : "drawOn", duration: 1000, easing: "linear", ...(params ? { params } : {}) } as never);
  }
  await slides.saveDeck(root, ord);
  const soft = slideOps.createDeck({ id: "soft", title: "soft", withTitleSlide: false });
  const ss = slideOps.addSlide(soft, { name: "S", layout: "blank" }).id;
  const textIds: string[] = [];
  for (const [i, edge] of ["soft", "hard", undefined, "soft"].entries()) {
    slideOps.addSlideText(soft, ss, { text: "Write me on", x: 40, y: 20 + i * 60, width: 300, height: 40, fontSize: i === 3 ? 40 : 24 });
    textIds.push(slideOps.slideById(soft, ss)!.elements.at(-1)!.id);
    void edge;
  }
  slideOps.addElement(soft, ss, { id: "spl", type: "plot", assetId: "panels-a", source: { svgPath: "plots/panels-a.svg", manifestPath: "plots/panels-a.fluxplot.json" }, x: 360, y: 20, width: 260, height: 200, rotation: 0 } as never);
  slideOps.addElement(soft, ss, { id: "srot", type: "rect", x: 40, y: 280, width: 120, height: 40, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  { const bb = slideOps.addBeat(soft, ss, { label: "write" })!;
    ["soft", "hard", undefined, "soft"].forEach((edge, i) => slideOps.setAnimation(soft, ss, bb.id, { target: textIds[i], preset: i === 3 ? "wipeOut" : "writeOn", duration: 1000, easing: "linear", ...(edge ? { params: { edge } } : {}) } as never));
    slideOps.setAnimation(soft, ss, bb.id, { target: "spl", preset: "writeOn", duration: 1000, easing: "linear", params: { edge: "soft" } } as never); }
  await slides.saveDeck(root, soft);

  const { launch } = await import("./lib/driver.mjs");
  const launched = await launch();
  browser = launched.browser;
  const pageErrors: string[] = [];
  const open = async (id: string) => {
    const res = await slides.exportDeck(root, id);
    const page = await (browser as unknown as { newPage(): Promise<typeof launched.page> }).newPage();
    page.on("pageerror", (e: Error) => pageErrors.push(String(e)));
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await page.goto(pathToFileURL(res.path).href, { waitUntil: "load" });
    await page.waitForFunction("!!window.fluxDeck?.seek");
    await page.evaluate("globalThis.__name = (f) => f"); // tsx keepNames helper does not exist in the page
    return page;
  };
  const sample = (page: Awaited<ReturnType<typeof open>>, ms: number, tid: string) => page.evaluate(([ms, tid]) => {
    (window as unknown as { fluxDeck: { seek(s: number, b: number, ms: number): void } }).fluxDeck.seek(0, 1, ms as number);
    const num = (v: string) => (v === "" ? NaN : parseFloat(v));
    const disc = document.querySelector('[data-el-id="e_disc"] [data-shape=ellipse]') as SVGGeometryElement;
    const poly = document.querySelector('[data-el-id="l_arrow"] polygon') as SVGElement;
    const arrowLine = document.querySelector('[data-el-id="l_arrow"] line') as SVGElement;
    const dashed = document.querySelector('[data-el-id="l_dash"] line') as SVGElement;
    const wt = document.querySelector(`[data-el-id="${tid}"]`) as HTMLElement;
    const text = wt.querySelector("text") as SVGElement;
    const eff = (wt.querySelector(".sl-effects") as HTMLElement) ?? wt;
    const plot = document.querySelector('[data-el-id="pl"]') as HTMLElement;
    const pEff = (plot.querySelector(".sl-effects") as HTMLElement) ?? plot;
    const pts = (poly.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
    const firstEntry = (el: SVGElement) => num(el.style.strokeDasharray.split(/[\s,]+/)[0] ?? "");
    return {
      perimeter: disc.getTotalLength(),
      discDash: disc.style.strokeDasharray, discFirst: firstEntry(disc as unknown as SVGElement), discFill: disc.style.fillOpacity, discStroke: disc.style.stroke, discWidth: disc.style.strokeWidth,
      headScale: poly.style.transform === "" ? 1 : new DOMMatrix(getComputedStyle(poly).transform).a, headTransform: poly.style.transform, headOrigin: poly.style.transformOrigin, headPts: pts,
      shaftLen: (arrowLine as unknown as SVGGeometryElement).getTotalLength(), shaftFirst: firstEntry(arrowLine), shaftDash: arrowLine.style.strokeDasharray,
      dashList: dashed.style.strokeDasharray.split(/[\s,]+/).map(Number), dashRest: dashed.style.strokeDasharray,
      wrapLeft: eff.getBoundingClientRect().left, wrapWidth: eff.getBoundingClientRect().width, textLeft: text.getBoundingClientRect().left, textRight: text.getBoundingClientRect().right,
      clip: eff.style.clipPath, textMask: text.style.maskImage || (text.style as unknown as Record<string, string>)["-webkit-mask-image"] || "",
      plotClip: pEff.style.clipPath, plotMasks: [...plot.querySelectorAll("*")].filter((n) => ((n as SVGElement).style?.maskImage ?? "") !== "").length,
      plotText: [...plot.querySelectorAll("text")].length,
    };
  }, [ms, tid] as [number, string]);

  // ---------------------------------------------------------------- draw + wipe
  const pc = await open("classic");
  const S = (ms: number) => sample(pc, ms, classic.tid);
  const hidden = await (async () => { await pc.evaluate(() => (window as never as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck.goTo(0, 0)); return S(-1); })();
  assert(!hidden.discDash.includes(",") && parseFloat(hidden.discDash) > hidden.perimeter && hidden.discFill === "0", `pre-beat: the disc rests hidden (1-entry gap ${parseFloat(hidden.discDash).toFixed(1)} > perimeter ${hidden.perimeter.toFixed(1)}, fill-opacity 0)`);
  const P = hidden.perimeter;
  const s33 = await S(33);
  assert(s33.discFirst > 3, `FIRST INK within 2 frames: the disc outline is ${s33.discFirst.toFixed(1)} units long at 33 ms (it showed nothing for 333 ms before T3: Present budget)`);
  const s300 = await S(300);
  assert(near(s300.discFirst / P, 0.5, 0.012) && parseFloat(s300.discFill) === 0, `outline traces over the first 60 %: 50 % of the perimeter at 300 ms (${(100 * s300.discFirst / P).toFixed(1)} %), fill still 0`);
  const s600 = await S(600);
  assert(s600.discFirst / P >= 0.998 && parseFloat(s600.discFill) < 0.35, `outline COMPLETE at 600 ms (${(100 * s600.discFirst / P).toFixed(1)} %) while the fill is only ${parseFloat(s600.discFill).toFixed(2)}`);
  const s725 = await S(725);
  assert(near(parseFloat(s725.discFill), 0.5, 0.03), `fill ramp is half done at 725 ms (${parseFloat(s725.discFill).toFixed(3)}; ramp = [45 %, 100 %])`);
  let prev = -1, mono = true, completeAt = -1, fillAt = -1;
  for (let ms = 0; ms <= 1000; ms += 20) { const r = await S(ms); const f = r.discFill === "" ? 1 : parseFloat(r.discFill); if (f < prev - 1e-9) mono = false; prev = f; if (completeAt < 0 && r.discDash.includes(",") && r.discFirst / P >= 0.998) completeAt = ms; if (fillAt < 0 && f >= 0.9) fillAt = ms; }
  assert(mono && fillAt - completeAt >= 250, `fill-opacity is monotone and reaches 0.9 ${fillAt - completeAt} ms AFTER the outline completes (>= 250)`);
  const rest = await S(1000);
  assert(rest.discDash === "" && rest.discFill === "" && rest.discStroke === "" && rest.discWidth === "", "REST: no temporary dash / fill-opacity / stroke / width left on the disc (authored attributes are the rest state)");

  // arrowhead
  const [tipX, tipY, b1x, b1y, b2x, b2y] = hidden.headPts, baseMid: [number, number] = [(b1x + b2x) / 2, (b1y + b2y) / 2];
  const headLen = Math.hypot(tipX - baseMid[0], tipY - baseMid[1]), shaft = hidden.shaftLen, frac = shaft / (shaft + headLen);
  assert(hidden.headScale > 0 && hidden.headScale <= 1e-3, `pre-beat: the filled head is scaled to ${hidden.headScale} (hidden, nothing paints)`);
  const [ox, oy] = hidden.headOrigin.split(/\s+/).map(parseFloat);
  assert(near(ox, baseMid[0], 0.5) && near(oy, baseMid[1], 0.5), `the head's scale origin is its BASE midpoint (${ox}, ${oy}) = where the shaft arrives (${baseMid[0].toFixed(1)}, ${baseMid[1].toFixed(1)})`);
  const early = await S(Math.round(1000 * frac * 0.6));
  assert(early.headScale <= 1e-3 && early.shaftFirst > 0, `while the pen is still on the shaft (${(100 * frac * 0.6).toFixed(0)} % of the clock) the head is still ${early.headScale} — it no longer pops ahead of the pen`);
  const midHead = await S(Math.round(1000 * (frac + 1) / 2));
  assert(near(midHead.headScale, 0.5, 0.04), `mid-head the scale is ${midHead.headScale.toFixed(3)} (0.5): one pen clock sliced by length (shaft ${shaft.toFixed(0)} + head ${headLen.toFixed(1)})`);
  const done = await S(1000);
  assert(done.headTransform === "" && done.shaftDash === "", "REST: the head carries no temporary transform, the shaft no dash");

  // dashed line: dash by dash
  const half = await S(500);
  const lst = half.dashList;
  assert(lst.length >= 17 && lst[0] === 6 && lst[1] === 4 && lst[2] === 6 && lst[3] === 4, `a dashed line draws dash by dash: at 500 ms the list is ${lst.slice(0, 6).join(" ")}… (${lst.length} entries, authored 6 4 intact)`);
  assert(lst.every((v) => v > 0), "…with no zero-length entry (no cap dot)");
  assert(done.dashRest === "", "REST: the dashed line is back to its authored pattern (no inline dash)");

  // writeOn: hard ink-fitted clip
  const w0 = await S(0), w33 = await S(33), w950 = await S(950), w1000 = await S(1000);
  assert(w0.textMask === "" && w33.textMask === "" && w950.textMask === "", "no mask on the text: the wipe is a hard ink-fitted clip (the soft edge is WP 2.4)");
  const rightInset = (c: string) => parseFloat((/inset\(\s*(?:-?[\d.]+%\s+)([-\d.]+)%/.exec(c) ?? [])[1] ?? "NaN");
  assert(w33.clip.startsWith("inset(") && rightInset(w33.clip) > 0 && rightInset(w33.clip) < 100, `the clip edge starts AT THE INK (right inset ${rightInset(w33.clip).toFixed(1)} %, not the 100 % box edge: no dead lead)`);
  const edgeX = (r: typeof w950) => r.wrapLeft + r.wrapWidth * (1 - rightInset(r.clip) / 100);
  const w500 = await S(500);
  assert(edgeX(w950) >= w950.textRight - 0.5 && edgeX(w500) < w500.textRight - 2, `the clip edge covers the whole ink by 95 % of the clock (edge ${edgeX(w950).toFixed(1)} >= ink end ${w950.textRight.toFixed(1)}) and is still mid-text at 50 % (${edgeX(w500).toFixed(1)}) — no dead tail (the old clip had revealed everything by 55 % of a standard curve)`);
  assert(edgeX(w33) - w33.textLeft <= 0.1 * (w33.textRight - w33.textLeft), `the edge starts at the first ink (${(edgeX(w33) - w33.textLeft).toFixed(1)} px into a ${(w33.textRight - w33.textLeft).toFixed(0)} px word after 2 frames), not at the box edge`);
  assert(w1000.clip.includes("-20%"), `the resting clip keeps the -20 % overflow margin (descenders survive: ${w1000.clip})`);
  // writeOn on a PLOT: clip, never a mask
  const pl = await S(100);
  assert(pl.plotText > 0 && pl.plotMasks === 0 && pl.plotClip.startsWith("inset("), `writeOn on a plot (${pl.plotText} <text>s + geometry): clip-path ${pl.plotClip}, ${pl.plotMasks} masked nodes — a text-only mask would leave every line and marker visible`);
  await pc.close();

  // ---------------------------------------------------------------- WP 2.4: the soft wipe edge (text only; everything else keeps the clip)
  {
    const psoft = await open("soft");
    const state = (ms: number) => psoft.evaluate(([ms, ids]) => {
      const fd = (window as unknown as { fluxDeck: { goTo(s: number, b: number): void; seek(s: number, b: number, ms: number): void } }).fluxDeck;
      if ((ms as number) < 0) fd.goTo(0, 0); else fd.seek(0, 1, ms as number);
      const one = (id: string) => { const w = document.querySelector(`[data-el-id="${id}"]`) as HTMLElement, t = w.querySelector("text") as SVGElement, eff = (w.querySelector(".sl-effects") as HTMLElement) ?? w; return { mask: t.style.maskImage, clip: eff.style.clipPath, size: parseFloat(getComputedStyle(t).fontSize), width: (t as unknown as SVGGraphicsElement).getBBox().width }; };
      const plot = document.querySelector('[data-el-id="spl"]') as HTMLElement, pEff = (plot.querySelector(".sl-effects") as HTMLElement) ?? plot;
      return { texts: (ids as string[]).map(one), plotClip: pEff.style.clipPath, plotMasks: [...plot.querySelectorAll("*")].filter((n) => ((n as SVGElement).style?.maskImage ?? "") !== "").length };
    }, [ms, textIds] as [number, string[]]);
    const edgeOf = (mask: string) => { const m = /black\s+(-?[\d.]+)%,\s*transparent\s+(-?[\d.]+)%/.exec(mask); return m ? { at: parseFloat(m[1]), end: parseFloat(m[2]) } : null; };
    const pre = await state(-1), a500 = await state(500), a1000 = await state(1000), a33 = await state(33);
    assert(pre.texts[0].mask.includes("linear-gradient") && edgeOf(pre.texts[0].mask)!.end <= 0.01, `soft edge, pre-beat: the text is fully masked away (${pre.texts[0].mask})`);
    const feather = edgeOf(a500.texts[0].mask)!.end - edgeOf(a500.texts[0].mask)!.at;
    assert(a500.texts[0].clip === "" || !a500.texts[0].clip.startsWith("inset(-20% "), "soft edge: the text is NOT clipped while its mask plays");
    assert(near(edgeOf(a500.texts[0].mask)!.at, -feather + (100 + feather) * 0.5, 0.05), `soft edge: at half the clock the edge sits at ${edgeOf(a500.texts[0].mask)!.at}% = -F + (100 + F) x 0.5 (F = ${feather.toFixed(1)}%)`);
    assert(a1000.texts[0].mask === "" && a1000.texts[1].mask === "", "soft edge: REST carries no mask (the ink is complete at progress 1, the mask is transient)");
    assert(a33.texts[0].mask.includes("black") && a33.texts[0].mask.includes("transparent") && !a33.texts[0].mask.includes("#"), "the mask names `black` / `transparent` (never #000: the numeric interpolator would rewrite it)");
    // the feather is 0.9 x the font size, as a percentage of the text's own extent along the sweep, clamped to 3-60 %
    const law = (i: number) => Math.min(60, Math.max(3, (0.9 * a500.texts[i].size / a500.texts[i].width) * 100));
    assert(near(feather, law(0), 0.06) && feather > 3 && feather < 60, `the feather is 0.9 x the font size: F = ${feather.toFixed(2)} % for a ${a500.texts[0].size.toFixed(0)} px text ${a500.texts[0].width.toFixed(0)} units wide (law ${law(0).toFixed(2)} %)`);
    assert(a500.texts[1].mask === "" && a500.texts[1].clip.startsWith("inset("), `params.edge "hard": the ink-fitted clip, no mask (${a500.texts[1].clip})`);
    assert(a500.texts[2].mask === "" && a500.texts[2].clip.startsWith("inset("), `an ABSENT edge keeps today's hard clip (old decks play as made): ${a500.texts[2].clip}`);
    assert(a500.plotMasks === 0 && a500.plotClip.startsWith("inset("), `params.edge "soft" on a plot is inert: the clip (${a500.plotClip}), ${a500.plotMasks} masked nodes`);
    // wipeOut mirrors it: the edge travels 100 -> -F, resting fully masked away
    assert(a500.texts[3].mask.includes("linear-gradient") && near(edgeOf(a500.texts[3].mask)!.at, 100 - (100 + (edgeOf(a500.texts[3].mask)!.end - edgeOf(a500.texts[3].mask)!.at)) * 0.5, 0.05), `soft wipeOut: the edge retreats (${edgeOf(a500.texts[3].mask)?.at}% at half the clock)`);
    assert(a1000.texts[3].mask !== "" && edgeOf(a1000.texts[3].mask)!.end <= 0.01, "soft wipeOut rests fully masked away");
    // seek purity: forward == reverse == shuffled seeks
    const times = [0, 1, 40, 250, 500, 750, 999, 1000]; const key = async (t: number) => JSON.stringify((await state(t)).texts.map((x) => x.mask));
    const fwd = new Map<number, string>(); for (const t of times) fwd.set(t, await key(t));
    const rev = new Map<number, string>(); for (const t of [...times].reverse()) rev.set(t, await key(t));
    assert(times.every((t) => fwd.get(t) === rev.get(t)), "the soft mask is identical for forward / reverse seeks");
    await psoft.close();
  }

  // ---------------------------------------------------------------- WP 2.4 (X4): stroke ORDER on a multi-path drawing
  {
    const pord = await open("order");
    const strokes = (beat: number, ms: number) => pord.evaluate(([beat, ms]) => {
      (window as unknown as { fluxDeck: { seek(s: number, b: number, ms: number): void } }).fluxDeck.seek(0, beat as number, ms as number);
      return ["house.walls", "house.roof", "house.sun"].map((id) => {
        const g = document.querySelector(`[id="house__${id}"]`)!, p = (g.tagName.toLowerCase() === "path" || g.tagName.toLowerCase() === "circle" ? g : g.querySelector("path,circle")) as SVGGeometryElement;
        const list = p.style.strokeDasharray.trim().split(/[\s,]+/).filter(Boolean).map(Number), pl = Number(p.getAttribute("pathLength")) || p.getTotalLength();
        return { drawn: list.length >= 2 ? list[0] : list.length === 1 && p.style.strokeDasharray !== "" ? 0 : 1, units: pl, dash: p.style.strokeDasharray, len: p.getTotalLength() };
      });
    }, [beat, ms] as [number, number]);
    const reachOf = (units: number, tag = "path") => units * (1 + (tag === "circle" ? DRAW_REACH_EPS.round : DRAW_REACH_EPS.other)) + 0.05;
    const share = (r: { drawn: number; units: number; dash: string; len: number }) => (r.dash === "" ? 1 : r.drawn / reachOf(r.units));
    // the TRUE pen lengths, measured by the browser: walls 360, roof 169.7 (it declares pathLength 1000: NOT its weight), sun ~125
    const lens = (await strokes(1, 0)).map((r) => r.len);
    assert(near(lens[0], 360, 0.01) && near(lens[1], 2 * Math.hypot(60, 60), 0.01) && lens[2] > 124 && lens[2] < 126, `the drawing's true lengths: ${lens.map((l) => l.toFixed(1)).join(" / ")} (the roof's pathLength is 1000)`);
    const total = lens.reduce((a, b) => a + b, 0), slots = (() => { let acc = 0; return lens.map((l) => { const a = acc / total; acc += l; return [a, acc / total]; }); })();
    const expectAt = (t: number) => slots.map(([a, b]) => Math.min(1, Math.max(0, (t - a) / (b - a))));
    let worst = 0;
    for (const t of [0.1, 0.3, 0.5, 0.6, 0.8, 0.95]) { const got = (await strokes(1, t * 1000)).map(share); expectAt(t).forEach((e, i) => { worst = Math.max(worst, Math.abs(got[i] - e)); }); }
    assert(worst <= 0.02, `params.order "sequence" lag 1: walls, then roof, then sun, each over its own slice of the clock sized by its TRUE pen length (${lens.map((l) => l.toFixed(0)).join(" / ")}; the roof's pathLength="1000" is not its weight): worst share error ${worst.toFixed(3)}`);
    const at300 = (await strokes(1, 300)).map(share);
    assert(at300[0] > 0 && at300[0] < 1 && at300[1] === 0 && at300[2] === 0, `at 300 ms only the walls are drawing (${at300.map((v) => v.toFixed(2)).join(" / ")})`);
    const tog = (await strokes(2, 500)).map(share);
    assert(tog.every((v) => near(v, 0.5, 0.03)), `an ABSENT order draws every stroke together (${tog.map((v) => v.toFixed(2)).join(" / ")} at half the clock): old decks play as made`);
    // an exit retreats the LAST stroke first
    const off = [0.1, 0.3, 0.5, 0.8].map(async (t) => (await strokes(3, t * 1000)).map(share));
    const offA = await off[0], offB = await off[1], offE = await off[3];
    assert(offA[2] < 0.995 && offA[0] > 0.995 && offA[1] > 0.995 && offB[2] < 0.005 && offE[1] < 0.005 && offE[2] < 0.005 && offE[0] > 0.1, `drawOff, sequence: the sun retreats first (${offA.map((v) => v.toFixed(2)).join(" / ")} at 10 %), the walls last (${offE.map((v) => v.toFixed(2)).join(" / ")} at 80 %)`);
    const lag3 = (await strokes(4, 400)).map(share);
    assert(lag3[0] > 0.3 && lag3[1] > 0 && lag3[2] >= 0, `the carrier default lag (0.3) overlaps the strokes (${lag3.map((v) => v.toFixed(2)).join(" / ")} at 400 ms)`);
    // seek purity
    const times = [0, 1, 80, 333, 500, 750, 999, 1000]; const key = async (t: number) => JSON.stringify((await strokes(1, t)).map((x) => x.dash));
    const fwd = new Map<number, string>(); for (const t of times) fwd.set(t, await key(t));
    const rev = new Map<number, string>(); for (const t of [...times].reverse()) rev.set(t, await key(t));
    assert(times.every((t) => fwd.get(t) === rev.get(t)), "the stroke order is identical for forward / reverse seeks");
    assert((await strokes(1, 1000)).every((r) => r.dash === ""), "REST: no stroke keeps a temporary dash");
    await pord.close();
  }

  // ---------------------------------------------------------------- X4 authoring: only a Draw on a MULTI-PATH drawing is written in order
  {
    await fs.writeFile(path.join(root, "plots", "one.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><path id="one.line" d="M 5 25 H 95" fill="none" stroke="#222" stroke-width="3"/></svg>`);
    const vd = slideOps.createDeck({ id: "verb", title: "verb", withTitleSlide: false });
    const vs = slideOps.addSlide(vd, { name: "V", layout: "blank" }).id;
    slideOps.addElement(vd, vs, { id: "vhouse", type: "plot", assetId: "house", source: { svgPath: "plots/house.svg" }, x: 20, y: 20, width: 300, height: 200, rotation: 0 } as never);
    slideOps.addElement(vd, vs, { id: "vone", type: "plot", assetId: "one", source: { svgPath: "plots/one.svg" }, x: 340, y: 20, width: 200, height: 100, rotation: 0 } as never);
    slideOps.addElement(vd, vs, { id: "vchart", type: "plot", assetId: "mpl_scatter", source: { svgPath: "plots/mpl_scatter.svg", manifestPath: "plots/mpl_scatter.fluxplot.json" }, x: 340, y: 140, width: 260, height: 160, rotation: 0 } as never);
    await slides.saveDeck(root, vd);
    const track = async (r: { beatIndex: number; trackId: string }) => (await slides.loadDeck(root, "verb")).slides[0].beats[r.beatIndex].tracks.find((t: { id?: string }) => t.id === r.trackId) as { preset?: string; params?: Record<string, unknown> };
    const draw = await track(await slides.animateElementVerb(root, "verb", vs, "vhouse", { preset: "drawOn" }));
    assert(draw.preset === "drawOn" && draw.params?.order === "sequence", `animate-element drawOn on a 3-stroke drawing writes params.order = sequence (${JSON.stringify(draw.params)})`);
    const off = await track(await slides.animateElementVerb(root, "verb", vs, "vhouse", { preset: "drawOff" }));
    assert(off.preset === "drawOff" && off.params?.order === "sequence", "...and so does the exit");
    const lone = await track(await slides.animateElementVerb(root, "verb", vs, "vone", { preset: "drawOn" }));
    assert(lone.preset === "drawOn" && lone.params === undefined, "a drawing with ONE stroke has nothing to order: no params");
    const chart = await track(await slides.animateElementVerb(root, "verb", vs, "vchart", { preset: "drawOn" }));
    assert(chart.preset === "drawOn" && chart.params?.order === undefined, `a fluxplot (it has a manifest, several strokes) is a chart, not a drawing: Draw on writes no order (${JSON.stringify(chart.params)})`);
    const rise = await track(await slides.animateElementVerb(root, "verb", vs, "vhouse", {}));
    assert(rise.preset === "fadeRise" && rise.params?.order === undefined, "the default Appear of a plot (fadeRise) never carries an order");
    const part = await track(await slides.animateElementVerb(root, "verb", vs, "vhouse", { preset: "drawOn", part: "house.walls" }));
    assert(part.params?.order === undefined, "a part-bound track is never ordered (its strokes are separate targets)");
  }

  // ---------------------------------------------------------------- writeOn on rotated / flipped text (review F1)
  // The ink measure reads screen rects, the clip lives in the element's local frame: under rotation the fractions are
  // wrong and the text showed before its beat. Rotated targets sweep the whole box (the pre-T3 behaviour).
  {
    const rot = slideOps.createDeck({ id: "rotwrite", title: "rotwrite", withTitleSlide: false });
    const rs = slideOps.addSlide(rot, { name: "R", layout: "blank" }).id;
    const rids: string[] = [];
    for (const [i, deg] of [0, 90, 30, 180].entries()) {
      slideOps.addSlideText(rot, rs, { text: "Write me on please", x: 100 + (i % 2) * 400, y: 80 + Math.floor(i / 2) * 250, width: 300, height: 40, fontSize: 24 });
      const el = slideOps.slideById(rot, rs)!.elements.at(-1)! as unknown as { id: string; rotation: number };
      el.rotation = deg; rids.push(el.id);
    }
    const rb = slideOps.addBeat(rot, rs, { label: "w" })!;
    for (const id of rids) slideOps.setAnimation(rot, rs, rb.id, { target: id, preset: "writeOn", duration: 1000, easing: "linear" } as never);
    await slides.saveDeck(root, rot);
    const prot = await open("rotwrite");
    const clips = await prot.evaluate(([ids]) => {
      const fd = (window as unknown as { fluxDeck: { goTo(s: number, b: number): void; seek(s: number, b: number, ms: number): void } }).fluxDeck;
      const at = (ms: number) => { if (ms < 0) fd.goTo(0, 0); else fd.seek(0, 1, ms); return (ids as string[]).map((id) => { const w = document.querySelector(`[data-el-id="${id}"]`) as HTMLElement; return ((w.querySelector(".sl-effects") as HTMLElement) ?? w).style.clipPath; }); };
      return { pre: at(-1), mid: at(500), end: at(1000) };
    }, [rids] as [string[]]);
    assert(clips.pre.every((c) => /^inset\(-20% 100% -20% -20%\)$/.test(c)), `rotated writeOn (0/90/30/180 deg): every target is fully hidden before its beat (${clips.pre.join(" | ")})`);
    const rIn = (c: string) => parseFloat((/inset\(\s*-?[\d.]+%\s+([-\d.]+)%/.exec(c) ?? [])[1] ?? "NaN");
    assert([1, 2, 3].every((i) => near(rIn(clips.mid[i]), 100 * (1 - 0.5 / 0.95), 0.2)), `rotated writeOn sweeps the whole box: right inset ${clips.mid.slice(1).map((c) => rIn(c).toFixed(1)).join(" / ")} % at half clock (90 / 30 / 180 deg; the whole-box edge sits at 50 % / WIPE_BOX_AT of the box)`);
    assert(clips.end.every((c) => c.includes("-20%") && !c.includes("100%")), "rotated writeOn rests fully revealed");
    await prot.close();
  }

  // ---------------------------------------------------------------- X12: pathLength honoured by the dash math
  const ppl = await open("pathlen");
  const penState = (ms: number) => ppl.evaluate((ms) => {
    (window as unknown as { fluxDeck: { seek(s: number, b: number, ms: number): void } }).fluxDeck.seek(0, 1, ms as number);
    const get = (id: string) => { const p = document.querySelector(`[id="pp__${id}"] path`) as SVGGeometryElement; const first = parseFloat(p.style.strokeDasharray.split(/[\s,]+/)[0] || "NaN"); return { first, total: p.getTotalLength(), pathLength: p.getAttribute("pathLength"), dash: p.style.strokeDasharray }; };
    return { len: get("axis.x.spine"), plain: get("axis.y.spine") };
  }, ms);
  const reach = (n: number) => n * 1.002 + 0.05;
  const pd = await penState(500);
  assert(near(pd.plain.first / reach(pd.plain.total), 0.5, 0.01), `no pathLength: half the clock draws ${(100 * pd.plain.first / reach(pd.plain.total)).toFixed(1)} % of the stroke`);
  assert(pd.len.pathLength === "1000" && pd.len.total < 400 && near(pd.len.first / reach(1000), 0.5, 0.01), `pathLength="1000" on a ${pd.len.total.toFixed(0)}-unit stroke: half the clock draws ${(100 * pd.len.first / reach(1000)).toFixed(1)} % (dash math in pathLength units: the same fraction as the plain stroke, X12)`);
  const pdEnd = await penState(1000);
  assert(pdEnd.plain.dash === "" && pdEnd.len.dash === "", "both rest undashed once drawn");
  await ppl.close();

  // ---------------------------------------------------------------- X13: ticks FOLLOW the pen (old-style tick tracks)
  const ptk = await open("ticks");
  const tickInk = (plot: string, axis: "x" | "y", beat: number, ms: number) => ptk.evaluate(([plot, axis, beat, ms]) => {
    (window as unknown as { fluxDeck: { seek(s: number, b: number, ms: number): void } }).fluxDeck.seek(0, beat as number, ms as number);
    const out: { has: boolean; rest: boolean }[] = [];
    for (let i = 1; ; i++) {
      const g = document.querySelector(`[id="${plot}__axis.${axis}.tick.${i}"]`); if (!g) break;
      const p = g.querySelector("path") as SVGElement; const d = p.style.strokeDasharray;
      out.push({ has: d !== "" && /[\s,]/.test(d.trim()), rest: d === "" });
    }
    return out;
  }, [plot, axis, beat, ms] as [string, string, number, number]);
  const firstInk = async (plot: string, axis: "x" | "y", beat: number) => {
    const n = (await tickInk(plot, axis, beat, 0)).length, at = new Array<number>(n).fill(-1);
    for (let ms = 0; ms <= 800; ms += 10) (await tickInk(plot, axis, beat, ms)).forEach((t, i) => { if (at[i] < 0 && (t.has || t.rest)) at[i] = ms; });
    return at;
  };
  const xs = await firstInk("pa", "x", 1);
  assert(xs.length === 6 && xs.every((v) => v >= 0), `X13: all 6 x ticks get ink (first ink at ${xs.join("/")} ms)`);
  assert(xs[0] <= 10 && xs.every((v, i) => !i || v > xs[i - 1]) && near(xs[5], 480, 25), `X13: the x ticks start one after another, left to right, spread 480 ms (${xs.join("/")}); they FOLLOW the pen instead of all starting at once`);
  const ys = await firstInk("pa", "y", 2);
  assert(ys.length === 6 && ys.every((v) => v >= 0) && Math.max(...ys) - Math.min(...ys) >= 400, `X13: the y ticks spread over 480 ms too (${ys.join("/")} for ticks 1..6, tick 1 = the BOTTOM tick)`);
  assert(ys.every((v, i) => !i || v > ys[i - 1]), `X13: the y ticks run BOTTOM to TOP with the y spine's pen (tick 1, the bottom one, first: ${ys.join("/")}); the ruling's from:"end" ran them TOP to BOTTOM, against the pen`);
  const endX = await tickInk("pa", "x", 1, 800), midX = await tickInk("pa", "x", 1, 400);
  assert(endX.every((t) => t.rest), "X13: the cue ends at 800 ms: every tick is back to its authored (undashed) style");
  assert(midX.some((t) => t.has) && midX.some((t) => !t.has && !t.rest), "X13: at 400 ms some ticks are drawing and some have not started");
  const opt = await firstInk("pb", "x", 3);
  assert(opt.every((v) => v <= 10), `X13 opt-out { perMs: 0 }: every tick starts at once (${opt.join("/")}), the old look`);
  const exp = await firstInk("pc", "x", 4);
  assert(near(exp[5], 5 * 40, 25) && exp.every((v, i) => !i || v > exp[i - 1]), `an explicit Each stagger is honoured unchanged (${exp.join("/")})`);
  await ptk.close();

  // ---------------------------------------------------------------- drawOn -> drawOff -> drawOn
  const pcy = await open("cycle");
  const cycleState = (beat: number, ms?: number) => pcy.evaluate(([beat, ms]) => {
    const fd = (window as never as { fluxDeck: { goTo(s: number, b: number): void; seek(s: number, b: number, ms: number): void } }).fluxDeck;
    if (ms == null) fd.goTo(0, beat as number); else fd.seek(0, beat as number, ms as number);
    const e = document.querySelector('[data-el-id="e_cyc"] [data-shape=ellipse]') as SVGElement;
    return { dash: e.style.strokeDasharray, fill: e.style.fillOpacity, first: parseFloat(e.style.strokeDasharray.split(/[\s,]+/)[0] || "NaN"), width: e.style.strokeWidth };
  }, [beat, ms] as [number, number | undefined]);
  const c1 = await cycleState(1), c2 = await cycleState(2), c3 = await cycleState(3), c1b = await cycleState(1), c2b = await cycleState(2);
  assert(c1.dash === "" && c1.fill === "" && c3.dash === "" && c3.fill === "", "cycle: drawn (beat 1) and re-drawn (beat 3) rest states carry no temporary style");
  assert(!c2.dash.includes(",") && c2.fill === "0" && c2.dash === c2b.dash && c1b.dash === "", "cycle: drawOff rests HIDDEN (1-entry gap, fill-opacity 0), identical when reached backwards; stepping back to beat 1 restores the drawn rest");
  const o100 = await cycleState(2, 100), o300 = await cycleState(2, 300), back = await cycleState(3, 200);
  assert(o300.first < o100.first && o100.dash.includes(",") && back.dash.includes(","), `cycle: drawOff retreats (window ${o100.first.toFixed(0)} -> ${o300.first.toFixed(0)} units) and the next drawOn supersedes it (window ${back.first.toFixed(0)} at beat 3 + 200 ms)`);
  await pcy.close();
  assert(pageErrors.length === 0, `zero page errors (${pageErrors.join("; ") || "clean"})`);
} finally {
  await browser?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
await h.done();
