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
//  6. the GEOMETRY is identical for forward / reverse / shuffled seeks.
//   Run: npx tsx scripts/verify-slide-part-origin.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { harness } from "./lib/harness.mjs";
import { createDeck } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
const { launch } = await import("./lib/driver.mjs");

const h = harness("verify-slide-part-origin");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-part-origin-"));
const fx = (n: string) => path.join("scripts/fixtures/plots", n);
const plot = async (id: string, stem: string) => ({ id, svg: await fs.readFile(fx(`${stem}_FLUXPLOT.svg`), "utf8"), manifest: JSON.parse(await fs.readFile(fx(`${stem}_FLUXPLOT.fluxplot.json`), "utf8")) });
const PLOTS = await Promise.all([plot("bars", "bars_mixed"), plot("barh", "barh_mixed"), plot("scat", "mpl_scatter")]);

const deck = createDeck({ id: "origin", title: "origin", withTitleSlide: false }); deck.defaults.transition = "none";
deck.assets = PLOTS.map((p) => ({ id: p.id, name: p.id, kind: "svg", path: `assets/${p.id}.svg`, naturalWidth: 400, naturalHeight: 250 })) as never;
const P = (id: string, asset: string, x = 70, y = 30, w = 500, h = 300) => ({ type: "plot", id, assetId: asset, x, y, width: w, height: h, rotation: 0 });
const tr = (id: string, target: string, preset: string, extra: Record<string, unknown> = {}) => ({ id, target, preset, duration: 800, easing: "linear", ...extra });
const rect = (id: string, x: number, y: number, w: number, hh: number) => ({ type: "rect", id, x, y, width: w, height: hh, rotation: 0, fill: "#4385be", stroke: "#205ea6", strokeWidth: 3, cornerRadius: 10 });
const slides: Record<string, { els: unknown[]; beats: unknown[][] }> = {
  rectGrow: { els: [rect("r", 220, 120, 200, 110)], beats: [[tr("a", "r", "growBaseline")]] },
  rectPop: { els: [rect("r", 220, 120, 200, 110)], beats: [[tr("a", "r", "popIn", { params: { from: 0.5 } })]] },
  barsGrow: { els: [P("p", "bars")], beats: [[tr("g", "p", "growBaseline", { selector: { role: "bar" } })]] },
  barsGrowScale: { els: [P("p", "bars")], beats: [[tr("g", "p", "growBaseline", { selector: { role: "bar" } })], [tr("u", "p", "scale", { selector: { role: "bar" }, to: { scale: 1.3 } })]] },
  barsPop: { els: [P("p", "bars")], beats: [[tr("g", "p", "popIn", { selector: { role: "bar" }, params: { from: 0.5 } })]] },
  barhGrow: { els: [P("p", "barh")], beats: [[tr("g", "p", "growBaseline", { selector: { role: "bar" } })]] },
  scatBase: { els: [P("p", "scat")], beats: [[]] },
  scatPop: { els: [P("p", "scat")], beats: [[tr("a", "p", "popIn", { selector: { role: "point" } })]] },
  scatRise: { els: [P("p", "scat")], beats: [[tr("a", "p", "fadeRise", { selector: { role: "point" } })]] },
  scatStagger: { els: [P("p", "scat")], beats: [[tr("a", "p", "stagger", { selector: { role: "point" }, params: { child: "popIn" }, stagger: { perMs: 5, by: "x", from: "start" } })]] },
  scatOut: { els: [P("p", "scat")], beats: [[tr("a", "p", "popOut", { selector: { role: "point" } })]] },
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
  for (const [slide, sel] of [["barsGrow", SEL_BAR], ["scatPop", '[data-sl-fx="1"]'], ["scatStagger", '[data-sl-fx="1"]'], ["scatRise", '[data-sl-fx="1"]']] as const) {
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

  // 6: seek-order independence of the GEOMETRY (pixel hashes also carry pre-existing text/marker anti-aliasing history; the rects below are exact)
  h.section("seek purity");
  for (const [slide, beat, sel] of [["barsGrow", 1, SEL_BAR], ["barsGrowScale", 2, SEL_BAR], ["barhGrow", 1, SEL_BAR], ["barsPop", 1, SEL_BAR], ["scatPop", 1, SEL_POINT], ["scatStagger", 1, SEL_POINT], ["scatRise", 1, SEL_POINT], ["scatOut", 1, SEL_POINT], ["rectGrow", 1, '[data-el-id="r"] rect'], ["rectPop", 1, '[data-el-id="r"] rect']] as const) {
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
