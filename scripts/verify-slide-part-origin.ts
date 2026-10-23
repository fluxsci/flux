#!/usr/bin/env -S npx tsx
// Transform effects act on the PART the viewer sees, in Chromium pixel space (the exported HTML player: the same
// player the app and the video capture run). Release 1 / WP 1.2 (origins are data). Pins:
//  1. growBaseline: every bar keeps its value-axis baseline edge within 0.5 stage units at progress .25/.5/.75, vertical
//     and horizontal, positive and negative; its extent along the value axis tracks the progress (+-1.5);
//  2. popIn on a plot part scales about the part's own fill-box centre (a bar's centre never moves);
//  3. appear THEN emphasize on one node: the appear beat is unchanged by a later transform effect on the same bars
//     (the origin is one writer per node per frame, never last-writer-wins);
//  4. leaf SVG markers that carry a `transform` attribute (scatter points) keep their centre (+-0.5) through popIn,
//     fadeRise, stagger+popIn and popOut, and rest where they were (the CSS transform composes, never replaces);
//  5. rest state: after its beat an animated SVG part carries NO inline origin / box / transform;
//  6. the GEOMETRY is identical for forward / reverse / shuffled seeks;
//  7. a data-morph Change between two different scatter assets matches the unwrapped Change over wrapped markers (the binder sees through `data-sl-fx`).
//  8. (WP 2.2) the fade-free vocabulary acts on what the viewer sees: scaleIn keeps a rect's `s` edge, an arrow's tail and a card's label+box
//     (from "group") pinned or proportional; stagger+scaleIn and pulse keep every marker's centre; appear THEN pulse leaves the appear beat
//     untouched; encircle exists only inside its beat, contains the rotated target and hugs the text INK; the legacy `scale` / `rotate`
//     emphasis pivots about a part's own centre in flight AND at rest (it used to turn about the view-box corner);
//  9. forward / reverse / shuffled seeks give the same geometry for every new effect.
//   Run: npx tsx scripts/verify-slide-part-origin.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { harness } from "./lib/harness.mjs";
import { createDeck } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { authoredFields } from "../src/lib/slide/presetCatalog";
const { launch } = await import("./lib/driver.mjs");

const h = harness("verify-slide-part-origin");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-part-origin-"));
const fx = (n: string) => path.join("scripts/fixtures/plots", n);
const plot = async (id: string, stem: string) => ({ id, svg: await fs.readFile(fx(`${stem}_FLUXPLOT.svg`), "utf8"), manifest: JSON.parse(await fs.readFile(fx(`${stem}_FLUXPLOT.fluxplot.json`), "utf8")) });
const PLOTS = await Promise.all([plot("bars", "bars_mixed"), plot("barh", "barh_mixed"), plot("scat", "mpl_scatter")]);
{
  // Two data variants of the scatter for the data-morph cases: `scatB` drops points 50.. and shifts the rest; `scatC` has a hole (points 10-14
  // missing) so a swap back to `scat` installs destination-only points in the MIDDLE of the group (z-order next to wrapped markers).
  const scat = PLOTS[2], variant = (id: string, keep: (i: number) => boolean, dx: number, dy: number) => ({
    id, manifest: scat.manifest,
    svg: scat.svg.replace(/(<use [^>]*?) x="([\d.]+)" y="([\d.]+)"([^>]*id="samples\.point\.(\d+)")/g, (_m, a, x, y, b, i) => keep(Number(i)) ? `${a} x="${Number(x) + dx}" y="${Number(y) + dy}"${b}` : ""),
  });
  PLOTS.push(variant("scatB", (i) => i < 50, 40, 25), variant("scatC", (i) => i < 10 || i > 14, 0, 0));
}

const deck = createDeck({ id: "origin", title: "origin", withTitleSlide: false }); deck.defaults.transition = "none";
deck.assets = PLOTS.map((p) => ({ id: p.id, name: p.id, kind: "svg", path: `assets/${p.id}.svg`, naturalWidth: 400, naturalHeight: 250 })) as never;
const P = (id: string, asset: string, x = 70, y = 30, w = 500, h = 300) => ({ type: "plot", id, assetId: asset, x, y, width: w, height: h, rotation: 0 });
const tr = (id: string, target: string, preset: string, extra: Record<string, unknown> = {}) => ({ id, target, preset, duration: 800, easing: "linear", ...extra });
const rect = (id: string, x: number, y: number, w: number, hh: number, rot = 0) => ({ type: "rect", id, x, y, width: w, height: hh, rotation: rot, fill: "#4385be", stroke: "#205ea6", strokeWidth: 3, cornerRadius: 10 });
const text = (id: string, x: number, y: number, w: number, hh: number, t: string, size: number, align = "center") => ({ type: "text", id, x, y, width: w, height: hh, rotation: 0, text: t, fontFamily: "Gelasio", fontSize: size, fontWeight: 400, fontStyle: "normal", align, color: "#100f0f", sizing: "fixed" });
const ARROW = { type: "line", id: "a", x: 120, y: 170, width: 400, height: 60, rotation: 0, x1: 0, y1: 50, x2: 400, y2: 10, stroke: "#100f0f", strokeWidth: 5, arrowEnd: true, arrowStart: false, cap: "round", arrowStyle: "filled" };
const slides: Record<string, { els: unknown[]; beats: unknown[][] }> = {
  rectGrow: { els: [rect("r", 220, 120, 200, 110)], beats: [[tr("a", "r", "growBaseline")]] },
  rectPop: { els: [rect("r", 220, 120, 200, 110)], beats: [[tr("a", "r", "popIn", { params: { from: 0.5 } })]] },
  barsGrow: { els: [P("p", "bars")], beats: [[tr("g", "p", "growBaseline", { selector: { role: "bar" } })]] },
  barsGrowScale: { els: [P("p", "bars")], beats: [[tr("g", "p", "growBaseline", { selector: { role: "bar" } })], [tr("u", "p", "scale", { selector: { role: "bar" }, to: { scale: 1.3 } })]] },
  barsPop: { els: [P("p", "bars")], beats: [[tr("g", "p", "popIn", { selector: { role: "bar" }, params: { from: 0.5 } })]] },
  barhGrow: { els: [P("p", "barh")], beats: [[tr("g", "p", "growBaseline", { selector: { role: "bar" } })]] },
  scatBase: { els: [P("p", "scat")], beats: [[]] },
  barsGrowPulse: { els: [P("p", "bars")], beats: [[tr("g", "p", "growBaseline", { selector: { role: "bar" } })], [tr("u", "p", "pulse", { selector: { role: "bar" } })]] },
  barsLegacyScale: { els: [P("p", "bars")], beats: [[tr("u", "p", "scale", { selector: { role: "bar" }, to: { scale: 1.3 } })]] },
  scatLegacyScale: { els: [P("p", "scat")], beats: [[tr("u", "p", "scale", { selector: { role: "point" }, to: { scale: 1.5 } })]] },
  scatLegacyRotate: { els: [P("p", "scat")], beats: [[tr("u", "p", "rotate", { selector: { role: "point" }, to: { rotation: 90 } })]] },
  scatScale: { els: [P("p", "scat")], beats: [[tr("a", "p", "stagger", { selector: { role: "point" }, params: { child: "scaleIn" }, stagger: { perMs: 5, by: "x", from: "start" } })]] },
  scatPulse: { els: [P("p", "scat")], beats: [[tr("a", "p", "pulse", { selector: { role: "point" } })]] },
  rectS: { els: [rect("r", 220, 120, 200, 110)], beats: [[tr("a", "r", "scaleIn", { params: { from: "s" } })]] },
  rectOut: { els: [rect("r", 220, 120, 200, 110)], beats: [[tr("a", "r", "scaleOut", { params: { to: "n" } })]] },
  arrow: { els: [ARROW], beats: [[tr("a", "a", "scaleIn")], [tr("b", "a", "pulse")]] },
  arrowOnly: { els: [ARROW], beats: [[tr("a", "a", "scaleIn")]] },
  arrowOut: { els: [ARROW], beats: [[tr("a", "a", "scaleOut")]] },
  card: { els: [rect("r1", 150, 90, 340, 180), text("t1", 166, 100, 200, 40, "Step 1: Load", 28, "left"), text("t2", 300, 220, 180, 40, "n = 120", 28, "right")], beats: [["r1", "t1", "t2"].map((e) => tr(e, e, "scaleIn", { params: { from: "group" } }))] },
  // the AUTHORED scaleIn (600 ms quick smooth, what the app writes) on a big box and a 14-unit dot: the onset is measured in painted ink
  onset: { els: [rect("big", 100, 120, 200, 110), { type: "ellipse", id: "dot", x: 400, y: 170, width: 14, height: 14, rotation: 0, fill: "#d14d41", stroke: "none", strokeWidth: 0 }],
    beats: [[{ id: "ob", target: "big", preset: "scaleIn", ...authoredFields("scaleIn"), start: 0 }, { id: "od", target: "dot", preset: "scaleIn", ...authoredFields("scaleIn"), start: 0 }]] },
  encRect: { els: [rect("r", 220, 120, 200, 110, 40)], beats: [[tr("e", "r", "encircle", { duration: 1000 })]] },
  encText: { els: [text("s", 70, 140, 500, 50, "Circle this sentence", 36)], beats: [[tr("e", "s", "encircle", { duration: 1000 })]] },
  scatPop: { els: [P("p", "scat")], beats: [[tr("a", "p", "popIn", { selector: { role: "point" } })]] },
  scatRise: { els: [P("p", "scat")], beats: [[tr("a", "p", "fadeRise", { selector: { role: "point" } })]] },
  scatStagger: { els: [P("p", "scat")], beats: [[tr("a", "p", "stagger", { selector: { role: "point" }, params: { child: "popIn" }, stagger: { perMs: 5, by: "x", from: "start" } })]] },
  scatOut: { els: [P("p", "scat")], beats: [[tr("a", "p", "popOut", { selector: { role: "point" } })]] },
  // data-morph Change between two different scatter assets, with and without wrapped markers (popIn before / after the swap)
  swapAB: { els: [P("p", "scat")], beats: [[tr("s", "p", "transform", { to: { assetId: "scatB", state: {} } })]] },
  popSwapAB: { els: [P("p", "scat")], beats: [[tr("a", "p", "popIn", { selector: { role: "point" } })], [tr("s", "p", "transform", { to: { assetId: "scatB", state: {} } })]] },
  swapPopAB: { els: [P("p", "scat")], beats: [[tr("s", "p", "transform", { to: { assetId: "scatB", state: {} } })], [tr("a", "p", "popIn", { selector: { role: "point" } })]] },
  swapCA: { els: [P("p", "scatC")], beats: [[tr("s", "p", "transform", { to: { assetId: "scat", state: {} } })]] },
  popSwapCA: { els: [P("p", "scatC")], beats: [[tr("a", "p", "popIn", { selector: { role: "point" } })], [tr("s", "p", "transform", { to: { assetId: "scat", state: {} } })]] },
};
for (const [id, s] of Object.entries(slides)) deck.slides.push({ id, name: id, groups: {}, elements: s.els, beats: [{ id: "b0", tracks: [] }, ...s.beats.map((tracks, i) => ({ id: `b${i + 1}`, tracks }))] } as never);
const index = (id: string) => deck.slides.findIndex((s) => s.id === id);
const file = path.join(tmp, "origin.html");
await fs.writeFile(file, (await exportDeckHtml({ deck, plots: Object.fromEntries(PLOTS.map((p) => [p.id, { svg: p.svg, manifest: p.manifest }])) } as never)).html);

let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  type R = { x: number; y: number; w: number; h: number; r: number; b: number };
  const rects = async (slide: string, beat: number, ms: number, sel: string): Promise<R[]> => {
    await page.evaluate((s: number, b: number, t: number) => (window as never as { fluxDeck: { seek(s: number, b: number, t: number): void } }).fluxDeck.seek(s, b, t), index(slide), beat, ms);
    return page.evaluate((q: string) => {
      const cam = document.querySelector(".sl-camera")!.getBoundingClientRect(), k = cam.width / 640;
      return [...document.querySelectorAll(q)].map((n) => { const r = n.getBoundingClientRect(); return { x: (r.x - cam.x) / k, y: (r.y - cam.y) / k, w: r.width / k, h: r.height / k, r: (r.right - cam.x) / k, b: (r.bottom - cam.y) / k }; });
    }, sel);
  };
  const SEL_BAR = '[data-role="bar"]', SEL_POINT = '[data-role="point"]';
  const centre = (r: R) => [r.x + r.w / 2, r.y + r.h / 2];

  // 1: bars grow from their own zero line (vertical + horizontal, positive + negative)
  h.section("growBaseline: each bar grows from its own zero line");
  for (const [slide, horizontal] of [["barsGrow", false], ["barhGrow", true]] as const) {
    const rest = await rects(slide, 1, 800, SEL_BAR);
    h.ok(rest.length >= 4, `${slide}: ${rest.length} bars found at rest`);
    for (const p of [0.25, 0.5, 0.75]) {
      const mid = await rects(slide, 1, 800 * p, SEL_BAR);
      let worst = 0, worstExt = 0;
      rest.forEach((r, i) => {
        const m = mid[i];
        // the baseline edge is the one that does not move: bottom for + vertical, top for - vertical, left for + horizontal, right for - horizontal.
        const edges = horizontal ? [Math.abs(m.x - r.x), Math.abs(m.r - r.r)] : [Math.abs(m.y - r.y), Math.abs(m.b - r.b)];
        worst = Math.max(worst, Math.min(...edges));
        const ext = horizontal ? m.w : m.h, full = horizontal ? r.w : r.h;
        worstExt = Math.max(worstExt, Math.abs(ext - full * p));
      });
      h.ok(worst <= 0.5, `${slide} p=${p}: every bar keeps one value-axis edge fixed (worst ${worst.toFixed(2)} <= 0.5)`);
      h.ok(worstExt <= 1.5, `${slide} p=${p}: extent along the value axis = p x rest (worst ${worstExt.toFixed(2)} <= 1.5)`);
    }
  }
  {
    // negative bars exist in the fixtures (mixed sign) and grow toward their zero line: the fixed edge differs by sign
    const rest = await rects("barsGrow", 1, 800, SEL_BAR), mid = await rects("barsGrow", 1, 400, SEL_BAR);
    const fixedBottom = rest.filter((r, i) => Math.abs(mid[i].b - r.b) <= 0.5 && Math.abs(mid[i].y - r.y) > 1).length;
    const fixedTop = rest.filter((r, i) => Math.abs(mid[i].y - r.y) <= 0.5 && Math.abs(mid[i].b - r.b) > 1).length;
    h.ok(fixedBottom >= 1 && fixedTop >= 1, `barsGrow p=.5: positive bars keep their bottom (${fixedBottom}), negative bars keep their top (${fixedTop})`);
    const hrest = await rects("barhGrow", 1, 800, SEL_BAR), hmid = await rects("barhGrow", 1, 400, SEL_BAR);
    const fixedLeft = hrest.filter((r, i) => Math.abs(hmid[i].x - r.x) <= 0.5 && Math.abs(hmid[i].r - r.r) > 1).length;
    const fixedRight = hrest.filter((r, i) => Math.abs(hmid[i].r - r.r) <= 0.5 && Math.abs(hmid[i].x - r.x) > 1).length;
    h.ok(fixedLeft >= 1 && fixedRight >= 1, `barhGrow p=.5: positive bars keep their left (${fixedLeft}), negative bars keep their right (${fixedRight})`);
  }

  // 2: popIn on parts scales about the part's own centre
  h.section("popIn on plot parts: about the fill-box centre");
  {
    const rest = await rects("barsPop", 1, 800, SEL_BAR);
    let worst = 0, shrunk = 0;
    for (const p of [0.25, 0.5, 0.75]) {
      const mid = await rects("barsPop", 1, 800 * p, SEL_BAR);
      rest.forEach((r, i) => { const [cx, cy] = centre(r), [mx, my] = centre(mid[i]); worst = Math.max(worst, Math.hypot(cx - mx, cy - my)); shrunk = Math.max(shrunk, r.w - mid[i].w); });
    }
    h.ok(rest.length >= 4 && worst <= 0.5 && shrunk > 0.5, `bars popIn (from 0.5): every bar centre stays within 0.5 of rest while it scales (worst ${worst.toFixed(2)}, shrink ${shrunk.toFixed(2)})`);
  }

  // 3: appear THEN another transform effect on the same node: the appear beat does not change
  h.section("appear then emphasize on one node");
  {
    let worst = 0;
    for (const ms of [100, 300, 500, 700, 800]) {
      const a = await rects("barsGrow", 1, ms, SEL_BAR), b = await rects("barsGrowScale", 1, ms, SEL_BAR);
      a.forEach((r, i) => { for (const k of ["x", "y", "w", "h"] as const) worst = Math.max(worst, Math.abs(r[k] - b[i][k])); });
    }
    h.ok(worst <= 0.01, `grow then scale on the same bars: the grow beat is unchanged by the later effect (worst ${worst.toExponential(1)})`);
    const end = await rects("barsGrowScale", 2, 800, SEL_BAR), rest = await rects("barsGrow", 1, 800, SEL_BAR);
    h.ok(end.length === rest.length && end.every((r, i) => r.w > rest[i].w + 0.5), "the later scale effect still acts (every bar is wider at its end)");
  }

  // whole elements keep their classic pivots (the HTML effects layer: bottom centre for a grow, the centre for a pop)
  h.section("whole elements keep their classic pivots");
  {
    const R = '[data-el-id="r"] rect';
    const rest = (await rects("rectGrow", 1, 800, R))[0];
    let worst = 0, minH = 1e9;
    for (const ms of [200, 400, 600]) { const m = (await rects("rectGrow", 1, ms, R))[0]; worst = Math.max(worst, Math.abs(m.b - rest.b)); minH = Math.min(minH, m.h); }
    h.ok(worst <= 0.5 && minH < rest.h, `growBaseline on a whole rect: its bottom edge stays put (worst ${worst.toFixed(2)}) while it grows`);
    const prest = (await rects("rectPop", 1, 800, R))[0];
    let pworst = 0, pmin = 1e9;
    for (const ms of [0, 200, 400, 600]) { const m = (await rects("rectPop", 1, ms, R))[0]; pworst = Math.max(pworst, Math.hypot(...centre(m).map((v, i) => v - centre(prest)[i]) as [number, number])); pmin = Math.min(pmin, m.w); }
    h.ok(pworst <= 0.5 && pmin < prest.w, `popIn on a whole rect: its centre stays put (worst ${pworst.toFixed(2)}) while it scales`);
  }


  // ---------------------------------------------------------------------------------------------------------------------
  // WP 2.2: the fade-free vocabulary. Every check measures what Chromium paints (the exported player), never a keyframe.
  // ---------------------------------------------------------------------------------------------------------------------
  h.section("scaleIn / scaleOut: the origin is a point that never moves");
  {
    const R = '[data-el-id="r"] rect';
    const rest = (await rects("rectS", 1, 800, R))[0];
    let worst = 0, minH = 1e9;
    for (const ms of [200, 400, 600]) { const m = (await rects("rectS", 1, ms, R))[0]; worst = Math.max(worst, Math.abs(m.b - rest.b)); minH = Math.min(minH, m.h); }
    h.ok(worst <= 0.5 && minH < rest.h, `scaleIn from "s": the bottom edge stays at the rest bottom (worst ${worst.toFixed(2)}) while the box grows`);
    const outRest = (await rects("rectOut", 0, 0, R))[0];
    let outWorst = 0, outMin = 1e9;
    for (const ms of [200, 400, 600]) { const m = (await rects("rectOut", 1, ms, R))[0]; outWorst = Math.max(outWorst, Math.abs(m.y - outRest.y)); outMin = Math.min(outMin, m.h); }
    h.ok(outWorst <= 0.5 && outMin < outRest.h, `scaleOut to "n": the top edge stays where it was (worst ${outWorst.toFixed(2)}) while the box shrinks`);
    const A = '[data-el-id="a"] line', arest = (await rects("arrowOnly", 1, 800, A))[0];
    let aworst = 0;
    for (const [slide, beat, ms] of [["arrowOnly", 1, 200], ["arrowOnly", 1, 500], ["arrow", 1, 200], ["arrow", 1, 300], ["arrow", 1, 500]] as const) {
      const m = (await rects(slide, beat, ms, A))[0]; aworst = Math.max(aworst, Math.hypot(m.x - arest.x, m.b - arest.b));
    }
    h.ok(aworst <= 0.6, `arrow scaleIn (auto = the tail), alone and with a pulse queued in the NEXT beat: the tail pixel never moves (worst ${aworst.toFixed(2)})`);
    const aout = (await rects("arrowOut", 0, 0, A))[0];
    let outTail = 0;
    for (const ms of [150, 300, 450]) { const m = (await rects("arrowOut", 1, ms, A))[0]; outTail = Math.max(outTail, Math.hypot(m.x - aout.x, m.b - aout.b)); }
    h.ok(outTail <= 0.6, `arrow scaleOut (auto = the tail): the arrow shrinks back INTO its tail (worst ${outTail.toFixed(2)})`);
    // a card: the label keeps its place inside the box through the whole scale-in, because both grow about ONE point (from: "group")
    const sel = (e: string) => `[data-el-id="${e}"]`;
    const restR = (await rects("card", 1, 800, sel("r1")))[0], restT = (await rects("card", 1, 800, sel("t1")))[0];
    let cworst = 0;
    for (const p of [0.25, 0.5, 0.75]) {
      const r = (await rects("card", 1, 800 * p, sel("r1")))[0], t = (await rects("card", 1, 800 * p, sel("t1")))[0];
      const k = r.w / restR.w, want = [(restT.x + restT.w / 2 - restR.x - restR.w / 2) * k, (restT.y + restT.h / 2 - restR.y - restR.h / 2) * k];
      cworst = Math.max(cworst, Math.hypot(t.x + t.w / 2 - r.x - r.w / 2 - want[0], t.y + t.h / 2 - r.y - r.h / 2 - want[1]));
    }
    h.ok(cworst <= 1, `from "group": a label keeps its place INSIDE the card through the whole scale-in (worst ${cworst.toFixed(2)})`);
  }
  h.section("scaleIn / pulse on plot parts, and the legacy scale / rotate: markers and bars keep their centres");
  {
    const control = await rects("scatBase", 1, 0, SEL_POINT);
    const barRest = await rects("barsGrow", 1, 800, SEL_BAR);
    for (const [slide, label, skip] of [["scatScale", "stagger+scaleIn", ["before"]], ["scatPulse", "pulse", []], ["scatLegacyScale", "legacy scale", []], ["scatLegacyRotate", "legacy rotate", []]] as const) {
      for (const [ms, name] of [[0, "before"], [400, "mid"], [5000, "after"]] as const) {
        if ((skip as readonly string[]).includes(name)) continue; // scale(0) is a singular matrix: no geometry to measure
        const got = await rects(slide, 1, ms, SEL_POINT);
        let worst = 0;
        control.forEach((c, i) => { const g = got[i]; if (!g) { worst = Infinity; return; } const [cx, cy] = centre(c), [gx, gy] = centre(g); worst = Math.max(worst, Math.hypot(cx - gx, cy - gy)); });
        h.ok(got.length === control.length && worst <= 0.5, `${label} ${name}: all ${control.length} marker centres within 0.5 of the no-effect plot (worst ${worst.toFixed(2)})`);
      }
    }
    for (const ms of [200, 400, 800, 5000]) {
      const got = await rects("barsLegacyScale", 1, ms, SEL_BAR);
      let worst = 0;
      barRest.forEach((r, i) => { const [cx, cy] = centre(r), [gx, gy] = centre(got[i]); worst = Math.max(worst, Math.hypot(cx - gx, cy - gy)); });
      h.ok(got.length === barRest.length && worst <= 0.5, `legacy scale on bars @${ms}: every bar scales about its OWN centre (worst centre shift ${worst.toFixed(2)}; it used to turn about the view-box corner)`);
    }
    {
      // a pulse swells each marker by ITS OWN size-aware peak: a small marker reaches the 1.3 ceiling (a whole-plot box would give 1.12)
      const peak = await rects("scatPulse", 1, 400, SEL_POINT);
      const ratios = peak.map((g, i) => g.w / control[i].w);
      const want = control.map((c) => Math.min(1.3, Math.max(1.12, 1 + 8 / Math.min(c.w, c.h))));
      h.ok(ratios.every((r, i) => Math.abs(r - want[i]) < 0.01) && Math.min(...ratios) > 1.2, `pulse on markers: every marker swells to its OWN size-aware peak 1 + 8/min(w,h) (${Math.min(...ratios).toFixed(3)}-${Math.max(...ratios).toFixed(3)}x, rest ${control[0].w.toFixed(1)} units wide), not the plot's 1.12`);
    }
    const grown = await rects("scatLegacyScale", 1, 5000, SEL_POINT);
    h.ok(grown.every((g, i) => g.w > control[i].w * 1.3), "legacy scale: the points ARE larger at rest (the effect still acts)");
    // the persistent origin: while the scale persists at rest, so does its pivot (identity-rest effects leave none)
    await rects("scatLegacyScale", 1, 5000, SEL_POINT);
    const rest = await page.evaluate(() => [...document.querySelectorAll<SVGElement>('[data-sl-fx="1"]')].map((n) => [n.style.transform, n.style.transformOrigin, n.style.transformBox]));
    h.ok(rest.length === control.length && rest.every(([t, o, b]) => t.startsWith("scale(") && o === "50% 50%" && b === "fill-box"), `legacy scale at rest: all ${rest.length} wrappers keep scale + origin 50% 50% + fill-box (the pivot persists with the transform)`);
  }
  h.section("onset: first VISIBLE ink, measured in painted pixels (not in eased progress)");
  {
    // `scale(0)` paints nothing, so the first visible ink is the first frame whose painted box is at least one device pixel at 1080p
    // (1/3 stage unit) wide. Quick smooth leaves rest almost at once (T6's numbers assumed a player lead-in that X2 deleted).
    const widthAt = async (sel: string, ms: number) => (await rects("onset", 1, ms, sel))[0]?.w ?? 0;
    const firstInk = async (sel: string) => { for (let ms = 0; ms <= 120; ms += 1) if ((await widthAt(sel, ms)) >= 1 / 3) return ms; return Infinity; };
    const BIG = '[data-el-id="big"] rect', DOT = '[data-el-id="dot"] [data-shape="ellipse"]';
    const inkBig = await firstInk(BIG), inkDot = await firstInk(DOT);
    h.ok(inkBig <= 12 && inkDot <= 45, `first visible ink: a 200-unit box at ${inkBig} ms, a 14-unit dot at ${inkDot} ms (the first ink of even a 14-unit dot lands inside 45 ms of a Present click; plain smooth needs 60-90)`);
    const restBig = await widthAt(BIG, 600), restDot = await widthAt(DOT, 600);
    const at = async (sel: string, rest: number, frac: number) => { for (let ms = 0; ms <= 600; ms += 1) if ((await widthAt(sel, ms)) >= frac * rest) return ms; return Infinity; };
    const t10 = await at(BIG, restBig, 0.1), t25 = await at(BIG, restBig, 0.25);
    h.ok(t10 <= 110 && t25 <= 190 && Math.abs(restDot - 14) < 0.01, `progress: 10 % at ${t10} ms, 25 % at ${t25} ms of the 600 ms scale-in (quick smooth; the dot rests at its true 14 units)`);
  }
  h.section("appear THEN pulse");
  {
    let worst = 0;
    for (const ms of [100, 300, 500, 700, 800]) {
      const a = await rects("barsGrow", 1, ms, SEL_BAR), b = await rects("barsGrowPulse", 1, ms, SEL_BAR);
      a.forEach((r, i) => { for (const k of ["x", "y", "w", "h"] as const) worst = Math.max(worst, Math.abs(r[k] - b[i][k])); });
    }
    h.ok(worst <= 0.01, `appear then emphasize on the same bars: the appear beat is unchanged by the later pulse (worst ${worst.toExponential(1)})`);
    const rest = await rects("barsGrowPulse", 1, 800, SEL_BAR), peak = await rects("barsGrowPulse", 2, 400, SEL_BAR), end = await rects("barsGrowPulse", 2, 800, SEL_BAR);
    h.ok(peak.every((p, i) => p.w > rest[i].w + 0.2) && end.every((e, i) => Math.abs(e.w - rest[i].w) < 0.01 && Math.abs(e.h - rest[i].h) < 0.01), "the pulse swells every bar at mid-beat and leaves nothing behind (rest geometry identical)");
  }
  h.section("encircle: a band that exists only inside its beat");
  {
    const overlay = async (slide: string, beat: number, ms: number) => (await rects(slide, beat, ms, ".sl-fx")).filter((r) => r.w > 0);
    for (const slide of ["encRect", "encText"]) {
      const before = await overlay(slide, 1, 0), after = await overlay(slide, 1, 5000);
      h.ok(before.length === 0 && after.length === 0, `${slide}: no band before or after its beat (seek 0 / end): nothing to bake into a still`);
    }
    const target = (await rects("encRect", 1, 500, '[data-el-id="r"]'))[0], band = (await overlay("encRect", 1, 500))[0];
    h.ok(!!band && band.x <= target.x + 1 && band.y <= target.y + 1 && band.r >= target.r - 1 && band.b >= target.b - 1, "encircle on a 40-degree rect: the band's box contains the rotated target");
    const ink = await page.evaluate((s: number) => {
      (window as never as { fluxDeck: { seek(s: number, b: number, t: number): void } }).fluxDeck.seek(s, 1, 0);
      const t = document.querySelector('[data-el-id="s"] text')!.firstChild!, rg = document.createRange(); rg.selectNodeContents(t);
      const cam = document.querySelector(".sl-camera")!.getBoundingClientRect(), k = cam.width / 640, r = rg.getBoundingClientRect();
      return { w: r.width / k };
    }, index("encText"));
    const tband = (await overlay("encText", 1, 600))[0];
    h.ok(!!tband && tband.w < 500 * 0.7 && Math.abs(tband.w - (ink.w + 2 * (6 + 3.5 / 2))) <= 4.5, `encircle on text hugs the INK: band ${tband?.w.toFixed(1)} wide for ink ${ink.w.toFixed(1)} (the box is 500)`);
  }

  // 4: scatter points keep their centre (control = the same plot with no effect)
  h.section("scatter markers (leaf SVG with a transform attribute)");
  const control = await rects("scatBase", 1, 0, SEL_POINT);
  h.ok(control.length >= 20, `scatter control: ${control.length} points`);
  for (const [slide, label] of [["scatPop", "popIn"], ["scatStagger", "stagger+popIn"], ["scatOut", "popOut"], ["scatRise", "fadeRise"]] as const) {
    // popIn / stagger / popOut scale about the centre: the centre never moves while they play. A rise moves them on purpose:
    // only its rest is a centre check. Hidden states carry no origin by design (the origin is the spec IN FLIGHT's): a
    // staggered node that has not started, and the end of an exit (opacity 0), are not measured.
    for (const [ms, name] of [[0, "start"], [400, "mid"], [5000, "after"]] as const) {
      if (label === "fadeRise" && name !== "after") continue;
      if (label === "stagger+popIn" && name === "start") continue;
      if (label === "popOut" && name === "after") continue;
      const got = await rects(slide, 1, ms, SEL_POINT);
      let worst = 0;
      control.forEach((c, i) => { const g = got[i]; if (!g) { worst = Infinity; return; } const [cx, cy] = centre(c), [gx, gy] = centre(g); worst = Math.max(worst, Math.hypot(cx - gx, cy - gy)); });
      h.ok(got.length === control.length && worst <= 0.5, `${label} ${name}: all ${control.length} point centres within 0.5 of the no-effect plot (worst ${worst.toFixed(2)})`);
    }
  }
  {
    // a rise: x never moves, and the points are displaced downward while it plays (proof the effect acts on the marker, not nowhere)
    const mid = await rects("scatRise", 1, 400, SEL_POINT);
    let worstX = 0, displaced = 0;
    control.forEach((c, i) => { const [cx, cy] = centre(c), [gx, gy] = centre(mid[i]); worstX = Math.max(worstX, Math.abs(cx - gx)); if (gy - cy > 0.5) displaced++; });
    h.ok(mid.length === control.length && worstX <= 0.5 && displaced === control.length, `fadeRise mid: x fixed (worst ${worstX.toFixed(2)}) and all points still below their rest (${displaced}/${control.length})`);
  }

  // 5: rest state. An animated SVG part carries NO inline origin / box / transform after its beat (the origin is written only while a transform is in flight)
  h.section("rest state");
  for (const [slide, sel] of [["barsGrow", SEL_BAR], ["scatPop", '[data-sl-fx="1"]'], ["scatStagger", '[data-sl-fx="1"]'], ["scatRise", '[data-sl-fx="1"]'], ["scatScale", '[data-sl-fx="1"]'], ["scatPulse", '[data-sl-fx="1"]']] as const) {
    await rects(slide, 1, 5000, sel);
    const dirty = await page.evaluate((q: string) => [...document.querySelectorAll<SVGElement>(q)].filter((n) => n.style.transformOrigin !== "" || n.style.transformBox !== "" || (n.style.transform !== "" && n.style.transform !== "none")).length, sel);
    const total = await page.evaluate((q: string) => document.querySelectorAll(q).length, sel);
    h.ok(total > 0 && dirty === 0, `${slide}: after the beat none of the ${total} animated parts keeps an inline transform-origin / transform-box / transform (${dirty} dirty)`);
  }
  {
    // the wrapper is created once and holds exactly the marker: idempotent across seeks and slide changes, one leaf per wrapper
    await rects("scatStagger", 1, 400, SEL_POINT); await rects("scatStagger", 1, 0, SEL_POINT); await rects("barsGrow", 1, 0, SEL_BAR); await rects("scatStagger", 1, 400, SEL_POINT);
    const shape = await page.evaluate(() => {
      const w = [...document.querySelectorAll('[data-sl-fx="1"]')];
      return { wrappers: w.length, oneChild: w.every((n) => n.childElementCount === 1 && n.firstElementChild!.getAttribute("data-role") === "point"), nested: w.some((n) => n.parentElement?.getAttribute("data-sl-fx") === "1") };
    });
    h.ok(shape.wrappers === control.length && shape.oneChild && !shape.nested, `exactly one wrapper per marker (${shape.wrappers}/${control.length}), each holding only its marker, none nested`);
  }

  // 7: the wrappers are invisible to the plot Change binder: a data-morph between two different scatter assets matches the same Change
  // on an unwrapped plot (positions, visibility, and DOM z-order of the markers), whether the markers were wrapped before or after it
  h.section("data-morph Change over wrapped markers");
  {
    type M = { id: string; x: number; y: number; o: number };
    const marks = async (slide: string, beat: number, ms: number): Promise<{ vis: M[]; order: string[] }> => {
      await page.evaluate((s: number, b: number, t: number) => (window as never as { fluxDeck: { seek(s: number, b: number, t: number): void } }).fluxDeck.seek(s, b, t), index(slide), beat, ms);
      return page.evaluate(() => {
        const cam = document.querySelector(".sl-camera")!.getBoundingClientRect(), k = cam.width / 640;
        const all = [...document.querySelectorAll('[data-role="point"]')].filter((n) => !n.closest("[data-plot-residue]"));
        const vis = all.map((n) => { const r = n.getBoundingClientRect(); let o = 1; for (let e: Element | null = n; e && e.tagName.toLowerCase() !== "svg"; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return { id: n.id, x: (r.x + r.width / 2 - cam.x) / k, y: (r.y + r.height / 2 - cam.y) / k, o }; }).filter((m) => m.o > 0.01);
        return { vis, order: all.map((n) => n.id) };
      });
    };
    const cases = [["popSwapAB", "swapAB", 2, 1, "popIn then swap scat -> scatB (fewer points)"], ["swapPopAB", "swapAB", 2, 1, "swap scat -> scatB then popIn"], ["popSwapCA", "swapCA", 2, 1, "popIn then swap scatC -> scat (destination-only points mid-group)"]] as const;
    for (const [slide, ref, beat, refBeat, label] of cases) {
      for (const ms of [0, 400, 800, 5000]) {
        // swapPop's pop plays in beat 2 while the swap is settled: its settled-swap reference is the reference deck's end state
        const want = await marks(ref, refBeat, slide === "swapPopAB" ? 5000 : ms), got = await marks(slide, beat, slide === "swapPopAB" ? 5000 : ms);
        if (slide === "swapPopAB" && ms !== 5000) continue;
        const byId = new Map(want.vis.map((m) => [m.id, m]));
        let worst = 0, missing = 0;
        for (const g of got.vis) { const m = byId.get(g.id); if (!m) { missing++; continue; } worst = Math.max(worst, Math.hypot(m.x - g.x, m.y - g.y), Math.abs(m.o - g.o) * 100); }
        h.ok(got.vis.length === want.vis.length && missing === 0 && worst <= 0.5, `${label} @${ms}: ${got.vis.length}/${want.vis.length} visible markers, ${missing} unmatched, worst delta ${worst.toFixed(2)}`);
      }
      const want = await marks(ref, refBeat, 5000), got = await marks(slide, beat, 5000);
      h.ok(JSON.stringify(got.order) === JSON.stringify(want.order), `${label}: marker DOM order equals the unwrapped Change's (${got.order.length} vs ${want.order.length} markers)`);
    }
  }

  // 6: seek-order independence of the GEOMETRY (pixel hashes also carry pre-existing text/marker anti-aliasing history; the rects below are exact)
  h.section("seek purity");
  for (const [slide, beat, sel] of [["barsGrow", 1, SEL_BAR], ["barsGrowScale", 2, SEL_BAR], ["barhGrow", 1, SEL_BAR], ["barsPop", 1, SEL_BAR], ["scatPop", 1, SEL_POINT], ["scatStagger", 1, SEL_POINT], ["scatRise", 1, SEL_POINT], ["scatOut", 1, SEL_POINT], ["rectGrow", 1, '[data-el-id="r"] rect'], ["rectPop", 1, '[data-el-id="r"] rect'],
  ["scatScale", 1, SEL_POINT], ["scatPulse", 1, SEL_POINT], ["scatLegacyScale", 1, SEL_POINT], ["barsLegacyScale", 1, SEL_BAR], ["barsGrowPulse", 1, SEL_BAR], ["barsGrowPulse", 2, SEL_BAR],
  ["rectS", 1, '[data-el-id="r"] rect'], ["rectOut", 1, '[data-el-id="r"] rect'], ["arrow", 2, '[data-el-id="a"] line'], ["arrowOut", 1, '[data-el-id="a"] line'], ["card", 1, "[data-el-id]"],
  ["encRect", 1, ".sl-fx rect"], ["encText", 1, ".sl-fx rect"]] as const) {
    const times = [0, 1, 40, 150, 333, 500, 650, 800, 999, 5000];
    const snap = async (ms: number) => JSON.stringify((await rects(slide, beat, ms, sel)).map((r) => [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 1e4) / 1e4)));
    const fwd = new Map<number, string>(); for (const t of times) fwd.set(t, await snap(t));
    const rev = new Map<number, string>(); for (const t of [...times].reverse()) rev.set(t, await snap(t));
    const order = [3, 8, 1, 6, 0, 9, 4, 2, 7, 5].map((i) => times[i]); const shuf = new Map<number, string>(); for (const t of order) shuf.set(t, await snap(t));
    const bad = times.filter((t) => fwd.get(t) !== rev.get(t) || fwd.get(t) !== shuf.get(t));
    h.ok(bad.length === 0, `${slide} beat ${beat}: geometry identical for forward / reverse / shuffled seeks (${bad.length} mismatching times${bad.length ? ": " + bad.join(",") : ""})`);
  }
  h.ok(errors.length === 0, `console clean: ${errors.join("; ")}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
await h.done();
