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
//   * drawOn -> drawOff -> drawOn rest states, reverse seeks, supersession; zero page errors.
// Run: npx tsx scripts/verify-slide-draw-browser.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as slides from "../flux-core/slides";
import * as core from "../flux-core/index";
import * as slideOps from "../src/lib/slide/ops";
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
    const disc = document.querySelector('[data-el-id="e_disc"] ellipse') as SVGGeometryElement;
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
    const e = document.querySelector('[data-el-id="e_cyc"] ellipse') as SVGElement;
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
