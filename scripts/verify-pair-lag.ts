#!/usr/bin/env -S npx tsx
// WP 4.3 (manim study, W2): Track.pairLag, manim's lag_ratio across the PIECES of a set hand-off Become, total duration unchanged.
// Pure: stagger.lagWindow + correspondence.lagRanks / pairProgress / sampleCorrespondence(timing.ts), the authoring default (D4) and the
// op's refusals. The player half (a lagged hand-off in the exported deck) is the last section.
// Run: npx tsx scripts/verify-pair-lag.ts
import { parseHTML } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>"); (globalThis as any).document = document;
import { harness } from "./lib/harness.mjs";
const h = harness("verify-pair-lag");
const { lagWindow, LAG_MIN_WINDOW } = await import("../src/lib/slide/stagger");
const { lagRanks, pairProgress, sampleCorrespondence } = await import("../src/lib/slide/correspondence");
const { smoothstep } = await import("../src/lib/motion/tokens");
const ops = await import("../src/lib/slide/ops");
const { compileSlide } = await import("../src/lib/slide/compile");
const { planHandoff } = await import("../src/lib/slide/handoffPlan");

h.section("lagWindow (pure)");
for (const n of [2, 3, 5, 12, 100, 400]) for (const lag of [0.05, 0.15, 0.35, 0.7, 1]) {
  let ok = true, mono = true;
  for (let r = 0; r < n; r++) {
    ok &&= lagWindow(0, r, n, lag) === 0 && lagWindow(1, r, n, lag) === 1;          // exact ends, no 0.9999999999999999
    let prev = -1; for (let k = 0; k <= 200; k++) { const v = lagWindow(k / 200, r, n, lag); mono &&= v >= prev && v >= 0 && v <= 1; prev = v; }
  }
  h.ok(ok && mono, `n=${n} lag=${lag}: exact 0/1 at the ends, monotone in raw, inside [0,1]`);
}
h.eq([lagWindow(0.4, 0, 1, 0.5), lagWindow(0.4, 3, 9, 0), lagWindow(0.4, 3, 9, -1)], [0.4, 0.4, 0.4], "n<=1, lag<=0 and garbage lag are the identity (unison)");
const spanOf = (n: number, lag: number) => { // raw interval where the first child is strictly inside (0,1)
  let a = -1, b = -1; for (let k = 0; k <= 4000; k++) { const v = lagWindow(k / 4000, 0, n, lag); if (v > 0 && a < 0) a = k / 4000; if (v >= 1 && b < 0) b = k / 4000; } return b - a;
};
for (const n of [3, 12, 100, 400]) h.ok(spanOf(n, 0.15) >= LAG_MIN_WINDOW - 1e-3, `n=${n}, lag .15: child window ${spanOf(n, 0.15).toFixed(3)} >= LAG_MIN_WINDOW ${LAG_MIN_WINDOW} (manim's raw window would be ${(1 / (1 + (n - 1) * 0.15)).toFixed(3)})`);
h.ok(Math.abs(spanOf(5, 0.15) - 0.625) < 2e-3 && Math.abs(spanOf(5, 0.35) - 1 / 2.4) < 2e-3, "n=5: windows 0.625 (375 ms of 600) and 0.4167 (250 ms) = manim 1/(1+(n-1)L)");
h.ok(Math.abs(lagWindow(0.0, 4, 5, 0.15)) === 0 && lagWindow(1 - 0.625 + 1e-9, 4, 5, 0.15) > 0 && lagWindow(0.375, 4, 5, 0.15) === 0, "last of 5 starts at 1-w = 0.375 and ends at 1");

h.section("plan on the real bar -> five dots set Become");
const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false });
const s = ops.addSlide(deck, { id: "split", layout: "blank" });
ops.addElement(deck, s.id, { type: "rect", id: "bar", x: 80, y: 60, width: 480, height: 56, rotation: 0, fill: "#4385be", stroke: "#205ea6", strokeWidth: 3, cornerRadius: 0 });
const xs = [100, 220, 340, 460, 580];
xs.forEach((x, i) => ops.addElement(deck, s.id, { type: "ellipse", id: `d${i}`, x: x - 36, y: 220, width: 72, height: 72, rotation: 0, fill: "#d14d41", stroke: "#100f0f", strokeWidth: 3 }));
const b = ops.addBeat(deck, s.id, { id: "b1" });
ops.becomeTransform(deck, s.id, b.id, "bar", { element: "d0", members: xs.map((_, i) => ({ element: `d${i}` })) }, { mode: "handoff" });
h.section("authoring (D4) and refusals");
const authored = deck.slides[0].beats[1].tracks[0];
h.eq(authored.pairLag, undefined, "a NEW set hand-off of 5 pieces flies in unison: no lag is authored unless asked for (owner, 2026-10-25)");
{ const d2 = ops.createDeck({ id: "e", title: "e", withTitleSlide: false }); const s2 = ops.addSlide(d2, { id: "two", layout: "blank" });
  ops.addElement(d2, s2.id, { type: "rect", id: "p", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  ops.addElement(d2, s2.id, { type: "ellipse", id: "q", x: 300, y: 0, width: 60, height: 60, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0 });
  ops.addElement(d2, s2.id, { type: "ellipse", id: "q2", x: 400, y: 0, width: 60, height: 60, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0 });
  const b2 = ops.addBeat(d2, s2.id, { id: "b" });
  ops.becomeTransform(d2, s2.id, b2.id, "p", { element: "q", members: [{ element: "q" }, { element: "q2" }] }, { mode: "handoff" });
  h.eq(d2.slides[0].beats[1].tracks[0].pairLag, undefined, "a 2-piece hand-off stays in unison (no field written)");
  ops.becomeTransform(d2, s2.id, b2.id, "p", { element: "q", members: [{ element: "q" }, { element: "q2" }] }, { mode: "handoff", pairLag: 0.4 });
  h.eq(d2.slides[0].beats[1].tracks[0].pairLag, 0.4, "an explicit pairLag always wins");
  const refuse = (fn: () => unknown) => { try { fn(); return ""; } catch (e) { return (e as Error).message; } };
  h.ok(/between 0 and 1/.test(refuse(() => ops.becomeTransform(d2, s2.id, b2.id, "p", "q", { mode: "handoff", pairLag: 1.5 }))), "become refuses a lag outside 0..1");
  const plain = ops.setTransform(d2, s2.id, b2.id, "q2", { state: { x: 10 } })!;
  h.ok(/hand-off Become/.test(refuse(() => ops.setTrackPairLag(plain, 0.2))) && plain.pairLag === undefined, "setTrackPairLag refuses a plain Change (a silently ignored field is a trap)");
  const r = ops.setTrack(d2, s2.id, d2.slides[0].beats[1].tracks[0].id!, { pairLag: 0.25 });
  h.ok(r.ok && d2.slides[0].beats[1].tracks[0].pairLag === 0.25, "set-track --pair-lag edits a hand-off's lag");
  ops.setTrackPairLag(d2.slides[0].beats[1].tracks[0], null); h.eq(d2.slides[0].beats[1].tracks[0].pairLag, undefined, "null clears it"); }
// R4 review: the default counts PIECES (a part set of one plot is as many pieces as parts), and leaves text-only sets alone (they fly as letters)
{ const d3 = ops.createDeck({ id: "f", title: "f", withTitleSlide: false }); const s3 = ops.addSlide(d3, { id: "parts", layout: "blank" });
  const { readFileSync } = await import("node:fs"), pth = await import("node:path");
  const base = pth.join(pth.dirname(new URL(import.meta.url).pathname), "fixtures", "plots", "mpl_bars_5_FLUXPLOT");
  const manifest = JSON.parse(readFileSync(`${base}.fluxplot.json`, "utf8")), bars: string[] = manifest.series[0].svg.bars;
  d3.plots = { bars: { svg: readFileSync(`${base}.svg`, "utf8"), manifest } } as never;
  const plotId = ops.addPlotToSlide(d3, s3.id, { assetId: "bars", x: 300, y: 40, width: 300, height: 220 } as never) as unknown as string;
  ops.addElement(d3, s3.id, { type: "rect", id: "src", x: 20, y: 20, width: 200, height: 60, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  const b3 = ops.addBeat(d3, s3.id, { id: "b" });
  ops.becomeTransform(d3, s3.id, b3.id, "src", { element: plotId, parts: bars }, { mode: "handoff", compiled: compileSlide(d3.slides[0], d3.stage, { plotManifest: () => manifest }) });
  h.eq(d3.slides[0].beats[1].tracks[0].pairLag, undefined, `a box splitting into the ${bars.length} bars of ONE plot is authored in unison too`);
  const s4 = ops.addSlide(d3, { id: "texts", layout: "blank" });
  const T = (id: string, x: number) => ops.addElement(d3, s4.id, { type: "text", id, x, y: 100, width: 80, height: 30, rotation: 0, text: id, fontFamily: "Arial", fontSize: 20, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000", sizing: "fixed" });
  T("word", 20); T("w1", 200); T("w2", 300); T("w3", 400);
  const b4 = ops.addBeat(d3, s4.id, { id: "b4" });
  ops.becomeTransform(d3, s4.id, b4.id, "word", { element: "w1", members: [{ element: "w1" }, { element: "w2" }, { element: "w3" }] }, { mode: "handoff" });
  h.eq(d3.slides.find((x) => x.id === "texts")!.beats[1].tracks[0].pairLag, undefined, "a text splitting into three texts is not given a lag (letters and rewrites fly by their own driver)"); }
const compiled = compileSlide(deck.slides[0], deck.stage, {});
const plan = planHandoff(compiled.cues[1].tracks[0].track, compiled.sample(1, 0), {} as any);
plan.prepare();
const kinds = plan.pairs.map((p: any) => p.interior ? "I" : p.a && p.b ? "ab" : p.a ? "a" : "b");
h.eq(kinds, ["I", "ab", "ab", "ab", "ab", "ab"], "6 pairs: one a-only INTERIOR + five pieces");
const { rank, count } = lagRanks(plan);
const cx = (i: number) => { const o = (plan.pairs[i].b ?? plan.pairs[i].a)!; return o.bbox.x + o.bbox.w / 2; };
const byRank = [1, 2, 3, 4, 5].sort((i, j) => rank[i] - rank[j]);
h.ok(count === 5 && rank[0] === -1 && byRank.every((v, k) => k === 0 || cx(byRank[k - 1]) < cx(v)), "interior is unranked; pieces ranked left to right by destination centre");
h.ok(lagRanks(plan) === lagRanks(plan), "ranks cached per plan");

h.section("pairProgress");
const ts: number[] = [], rs: number[] = [], L = 0.15, w = 1 / (1 + 4 * L);
const at = (raw: number) => { const share = pairProgress(plan, raw, L, smoothstep, ts, rs); return { share, ts: [...ts] }; };
let r0 = at(0), r1 = at(1);
h.ok(r0.ts.every(v => v === 0) && r1.ts.every(v => v === 1), "raw 0: every pair exactly 0; raw 1: every pair exactly 1");
h.ok(Math.abs(r0.share - (1 - w)) < 1e-12, "interior share = 1-w = 0.375");
const early = at(0.2).ts;
h.ok(byRank.every((v, k) => k === 0 || early[byRank[k - 1]] >= early[v]) && early[byRank[0]] > 0 && early[byRank[4]] === 0, "pieces peel in reading order (leftmost first, rightmost not started at raw .2)");

h.ok(at(1 - w).ts[0] === 1 && at(1 - w - 1e-3).ts[0] < 1, "leaving interior is fully gone exactly when the last piece starts (raw = 1-w)");
for (let i = 1; i < 6; i++) { let prev = -1, mono = true; for (let k = 0; k <= 100; k++) { const v = at(k / 100).ts[i]; mono &&= v >= prev; prev = v; } h.ok(mono, `pair ${i}: monotone in raw`); }
h.eq(at(0.375 + 0.2).ts.every(v => v >= 0 && v <= 1), true, "all pair progress inside [0,1]");
const spring = (p: number) => p >= 1 ? 1 : p <= 0 ? 0 : 1 + 0.2 * Math.sin(p * 9) * (1 - p) * 2;
h.ok((() => { let ok = true; for (let k = 0; k <= 100; k++) { pairProgress(plan, k / 100, 0.35, spring, ts, rs); ok &&= ts.every(v => v >= 0 && v <= 1); } return ok; })(), "an overshooting curve is clamped per pair (a ring never overshoots its landing)");

h.section("sampleCorrespondence with timing.ts");
const sig = (paths: any[]) => JSON.stringify(paths.map(p => ({ n: p.nodes.map((q: any) => [q.x, q.y, q.hIn, q.hOut]), c: p.closed, p: p.paint, o: p.opacity })));
const unison = sig(sampleCorrespondence(plan, 0.37, [], { raw: 0.5, durationMs: 600 }));
const sameT = sig(sampleCorrespondence(plan, 0.99, [], { raw: 0.5, durationMs: 600, ts: plan.pairs.map(() => 0.37), rs: plan.pairs.map(() => 0.5), interiorMs: 600 }));
h.ok(unison === sameT, "ts = constant t reproduces the unison sample exactly (per-pair clock is the only difference)");
const endUnison = sig(sampleCorrespondence(plan, 1, [], { raw: 1, durationMs: 600 }));
pairProgress(plan, 1, L, smoothstep, ts, rs);
h.ok(endUnison === sig(sampleCorrespondence(plan, 1, [], { raw: 1, durationMs: 600, ts, rs, interiorMs: 600 * (1 - w) })), "raw = 1 with lag lands on the authored chains (byte-identical to unison)");
pairProgress(plan, 0, L, smoothstep, ts, rs);
h.ok(sig(sampleCorrespondence(plan, 0, [], { raw: 0, durationMs: 600 })) === sig(sampleCorrespondence(plan, 0, [], { raw: 0, durationMs: 600, ts, rs, interiorMs: 225 })), "raw = 0 identical to unison");
h.section("the player (exported deck): lag 0 is unison byte for byte; 0.15 peels left to right and lands where unison lands");
{
  const fs = await import("node:fs/promises"), os = await import("node:os"), path = await import("node:path"), { pathToFileURL } = await import("node:url");
  const { exportDeckHtml } = await import("../src/lib/slide/export/exportDeck");
  const { launch } = await import("./lib/driver.mjs");
  const d = ops.createDeck({ id: "lagp", title: "lag", withTitleSlide: false }); d.defaults.transition = "none";
  for (const [id, lag] of [["none", undefined], ["zero", 0], ["lag", 0.15]] as const) {
    const sl = ops.addSlide(d, { id, layout: "blank" });
    ops.addElement(d, sl.id, { type: "rect", id: `${id}-bar`, x: 80, y: 60, width: 480, height: 56, rotation: 0, fill: "#4385be", stroke: "#205ea6", strokeWidth: 3, cornerRadius: 0 });
    xs.forEach((x, i) => ops.addElement(d, sl.id, { type: "ellipse", id: `${id}-d${i}`, x: x - 36, y: 220, width: 72, height: 72, rotation: 0, fill: "#d14d41", stroke: "#100f0f", strokeWidth: 3 }));
    const bb = ops.addBeat(d, sl.id, { id: `${id}-b` });
    ops.becomeTransform(d, sl.id, bb.id, `${id}-bar`, { element: `${id}-d0`, members: xs.map((_, i) => ({ element: `${id}-d${i}` })) }, { mode: "handoff", ...(lag === undefined ? {} : { pairLag: lag }), duration: 600 });
    if (lag === undefined) delete d.slides.at(-1)!.beats[1].tracks[0].pairLag;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-pairlag-")), file = path.join(tmp, "lag.html");
  await fs.writeFile(file, (await exportDeckHtml({ deck: d } as never)).html);
  const { browser, page } = await launch({ width: 960, height: 540 });
  try {
    await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
    const sigAt = (slide: number, ms: number) => page.evaluate(`(() => { window.fluxDeck.seek(${slide}, 1, ${ms}); return Array.from(document.querySelectorAll(".sl-handoff path")).map(p => (p.getAttribute("d") || "") + "|" + (p.getAttribute("opacity") || "")).join(" ; "); })()`) as Promise<string>;
    let same = 0; const times = [1, 60, 150, 240, 300, 360, 450, 540, 599];
    for (const ms of times) if ((await sigAt(0, ms)) === (await sigAt(1, ms))) same++;
    h.eq(same, times.length, "pairLag 0 draws exactly what no pairLag draws, every frame (byte-identical flight)");
    // at raw 0.25 (150 of 600 ms) the last pieces have not started yet (the last starts at 1-w = 0.375) while the first is well on its way
    const ds = (slide: number, ms: number) => page.evaluate(`(() => { window.fluxDeck.seek(${slide}, 1, ${ms}); return Array.from(document.querySelectorAll(".sl-handoff path.sl-handoff-path")).map(p => p.getAttribute("d") || ""); })()`) as Promise<string[]>;
    const still = async (slide: number) => { const a = await ds(slide, 1), b = await ds(slide, 150); return b.filter((d, k) => d === a[k]).length; };
    const [lagStill, uniStill] = [await still(2), await still(1)];
    // (the bar's interior keeps its outline while it dissolves: it is "still" in both)
    h.ok(lagStill >= uniStill + 2, `at 150 ms of a 600 ms split, ${lagStill - uniStill} more pieces still wait at their start than in unison (${lagStill} vs ${uniStill} paths unchanged): the pieces peel one after another`);
    const land = (slide: number) => page.evaluate(`(() => { window.fluxDeck.seek(${slide}, 1, Infinity); return Array.from(document.querySelectorAll('[data-el-id]')).map(w => w.getAttribute("data-el-id").replace(/^[a-z]+-/, "") + ":" + getComputedStyle(w).visibility + ":" + getComputedStyle(w).opacity).join(","); })()`) as Promise<string>;
    h.eq(await land(2), await land(1), "a lagged hand-off lands on exactly the resting state a unison one lands on");
  } finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
}
await h.done();
