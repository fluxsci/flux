// WP 2.3 (T8 D1) — tick hand-off during a plot VIEW Change (pure; linkedom). The pooled ticks ride the blended fit; ticks
// with the same DATA value are ONE tick that walks start -> end; start-only ticks leave over t .10-.45 and end-only ticks
// arrive over .45-.80 (the two sets never coexist); a re-formatted label hard-swaps once at t = .5 (never glyph-morphs);
// the end frame EQUALS the static re-tick string for string and position for position; every other path is untouched.
import { readFileSync } from "node:fs";
import { DOMParser, parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { PlotView } from "../src/lib/types";
import { viewFits, matchTickSets, tickFlightLaw, guideData, projectWith, axisFit, type TickSpec } from "../src/lib/plot/project";
import { applyPlotView, restoreProjection, preparePlotView, type PlotViewOptions } from "../src/lib/plot/projectDom";
import { preparePlot } from "../src/lib/plot/parse";
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, DOMParser });
const h = harness("verify-plot-tick-handoff");
const load = (path: string) => {
  const base = new URL(`./fixtures/${path}`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(`${base}.fluxplot.json`), "utf8")) as FluxPlotManifest;
  const svg = readFileSync(new URL(`${base}.svg`), "utf8");
  return { manifest, root: () => preparePlot(svg, manifest).root! };
};
const sine = load("plots/mpl_sine_waves_FLUXPLOT"), bars = load("plots/mpl_bars_FLUXPLOT"), log = load("plots/log_line_FLUXPLOT"), features = load("fluxplot03/features");
type Fx = ReturnType<typeof load>;
const optsFor = (m: FluxPlotManifest, from: PlotView | undefined, to: PlotView | undefined, extra: Partial<PlotViewOptions> = {}): PlotViewOptions =>
  ({ t: 0, from: viewFits(m, from) ?? undefined, to: viewFits(m, to) ?? undefined, fromView: from, geometryInterpolated: true, assetChange: false, tickHandoff: true, ...extra });
// effective opacity, 0 when display none (linkedom: inline style only)
const eff = (n: Element) => {
  let op = 1; for (let e: Element | null = n; e && e.tagName?.toLowerCase() !== "svg"; e = e.parentElement) {
    const st = (e as SVGElement).style; if (st?.display === "none") return 0; const o = st?.opacity; if (o) op *= Number(o);
  } return op;
};
const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
const squash = (s: string | null) => (s ?? "").replace(/\s+/g, "");
const labelsOf = (root: Element, axis: string) => Array.from(root.querySelectorAll(`[id*="axis.${axis}.ticklabel."]`)).filter(n => eff(n) > 0.02).map(n => squash(n.textContent));
const marksOf = (root: Element, axis: string) => Array.from(root.querySelectorAll(`[id*="axis.${axis}.tick."]:not([id*=".minor."])`)).filter(n => eff(n) > 0.02);
const shift = (n: Element, axis: string) => translates(n.getAttribute("transform"), axis);
/** The along-axis sum of every `translate(x y)` in a transform string. */
function translates(t: string | null, axis: string): number {
  let sum = 0; for (const m of (t ?? "").matchAll(/translate\(([-\d.e+]+)[ ,]+([-\d.e+]+)\)/g)) sum += Number(m[axis.startsWith("x") ? 1 : 2]);
  return sum;
}
/** Where a guide RESTS along its axis, whatever markup it has: every translate down its first-child chain plus the text anchor
 *  (`x` / `y` of the `<text>` or its first `<tspan>`). A generated label sits at its own place, a pooled or re-ticked clone at
 *  the template's plus a translate: only this absolute position is comparable between them. A label keeps a constant offset from
 *  its tick (a y label's baseline sits ~0.36 em below it, a log label's left edge half its width before it), so positions, not
 *  translates, are what must agree. */
function resting(n: Element, axis: string): number {
  const attr = axis.startsWith("x") ? "x" : "y"; let total = 0;
  for (let cur: Element | undefined = n; cur; cur = cur.children[0] as Element | undefined) {
    total += translates(cur.getAttribute("transform"), axis);
    if (cur.tagName.toLowerCase() === "text") { total += Number(cur.getAttribute(attr) ?? (cur.children[0] as Element | undefined)?.getAttribute(attr) ?? 0); break; }
  }
  return total;
}
const labelPositions = (root: Element, axis: string) => Object.fromEntries(Array.from(root.querySelectorAll(`[id*="axis.${axis}.ticklabel."]`)).filter(n => eff(n) > 0.02).map(n => [squash(n.textContent), resting(n, axis)]));
const markPositions = (root: Element, axis: string) => sorted(marksOf(root, axis).map(n => resting(n, axis)));
const sameNumbers = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

h.section("matchTickSets: same data value = one tick, even from a recovered (generated) set");
const spec = (vs: number[]): TickSpec[] => vs.map(value => ({ value, html: String(value) }));
const nice = spec([0, 0.5, 1, 1.5, 2, 2.5]);
const recovered = spec([-0.00327655, 0.99734742, 1.99797141, 2.99859539, 3.99921936, 4.99984336]); // measured on mpl_sine_waves (T8 code critic)
let pairs = matchTickSets(recovered, nice);
h.eq(pairs.filter(p => p.a && p.b).length, 3, "recovered 0/1/2 match nice 0/1/2 (toPrecision(9) keys matched none)");
h.eq(pairs.length, 6 + 3 + 0, "union size = 3 matched + 3 A-only (3,4,5) + 3 B-only (0.5,1.5,2.5)");
pairs = matchTickSets(nice, nice); h.ok(pairs.length === 6 && pairs.every(p => p.a && p.b), "identical sets all match");
pairs = matchTickSets(spec([1, 10, 100]), spec([1, 10, 100, 1000]), true); h.eq(pairs.filter(p => p.a && p.b).length, 3, "log axis matches decades");
h.eq(matchTickSets([], nice).length, 6, "empty start set: all end-only");
h.eq(matchTickSets(spec([5]), spec([5])).filter(p => p.a && p.b).length, 1, "single equal ticks match (abs tolerance when no step exists)");
h.eq(matchTickSets(spec([0, 1, NaN, 2]), spec([0, 1, 2])).length, 3, "non-finite values are dropped");

h.section("tickFlightLaw: the two one-sided sets never coexist; the label swaps once");
const L = (t: number) => tickFlightLaw(t);
h.eq([L(0).aOnly, L(0).bOnly, L(1).aOnly, L(1).bOnly], [1, 0, 0, 1], "t=0 start set only, t=1 end set only");
h.ok(L(.45).aOnly < 0.001 && L(.45).bOnly < 0.001, `at t=.45 both one-sided sets are ~0 (${L(.45).aOnly.toFixed(4)}, ${L(.45).bOnly.toFixed(4)})`);
let maxBoth = 0; for (let i = 0; i <= 600; i++) { const l = L(i / 600); maxBoth = Math.max(maxBoth, Math.min(l.aOnly, l.bOnly)); }
h.ok(maxBoth < 0.02, `min(aOnly,bOnly) never exceeds 0.02 (${maxBoth.toFixed(4)}): no bunching of the two sets`);
h.ok(!L(.499).swapToB && L(.5).swapToB, "label text swaps once at t = .5");

/** One view Change on one axis: the start frame equals the static render of the start state, the end frame equals the static
 *  render of the end state (label strings and mark positions), and in between nothing pops, doubles or leaves the axis. */
function scenario(name: string, fx: Fx, axis: string, from: PlotView | undefined, to: PlotView | undefined, panelId?: string, expectGeneratedStart = false) {
  h.section(name);
  const staticOf = (view: PlotView | undefined) => { const r = fx.root(); if (view) applyPlotView(r, fx.manifest, view, ""); return r; };
  const s0 = staticOf(from), s1 = staticOf(to);
  const root = fx.root(), o = optsFor(fx.manifest, from, to);
  preparePlotView(root, fx.manifest, to, "", o);
  const pool = root.querySelectorAll("[data-projection-flight]").length;
  h.ok(pool > 0 && pool <= 60, `the pool is built once at bind (${pool} nodes)`);
  const frame = (t: number) => { o.t = t; applyPlotView(root, fx.manifest, to, "", o); }; // the host mutates ONE opts object per frame (plans cache by identity)
  const generated = labelsOf(fx.root(), axis);
  frame(0);
  h.eq(labelsOf(root, axis), labelsOf(s0, axis), `t=0 label set equals the ${from ? "static start view" : "generated"} (${labelsOf(s0, axis).join(" ")})`);
  if (expectGeneratedStart) h.eq(labelsOf(root, axis), generated, "and, with no start view, it is exactly the generated ticks");
  h.ok(sameNumbers(markPositions(root, axis), markPositions(s0, axis)), "t=0 tick marks sit at the start positions");
  // the first frame AFTER t = 0 (the pool takes over from the generated nodes there): no pop, labels included
  frame(1e-6);
  const p0 = labelPositions(root, axis), q0 = labelPositions(s0, axis);
  h.ok(Object.keys(q0).length > 0 && Object.keys(q0).every(k => k in p0 && Math.abs(p0[k] - q0[k]) < 1e-3), `t=0+ every label rests where the start render has it, baseline offset included (max ${Math.max(...Object.keys(q0).map(k => Math.abs((p0[k] ?? Infinity) - q0[k]))).toFixed(5)})`);
  h.ok(sameNumbers(markPositions(root, axis), markPositions(s0, axis), 1e-3), "t=0+ every tick mark still sits where it did (the pool takes over without a jump)");
  h.eq(labelsOf(root, axis), labelsOf(s0, axis), "t=0+ and the label set is the same");
  frame(1);
  h.eq(labelsOf(root, axis), labelsOf(s1, axis), `t=1 label set equals the static retick, string for string (${labelsOf(s1, axis).join(" ")})`);
  h.ok(sameNumbers(markPositions(root, axis), markPositions(s1, axis)), "t=1 tick marks sit at the static positions (<1e-4)");
  const p1 = labelPositions(root, axis), q1 = labelPositions(s1, axis);
  h.ok(Object.keys(q1).length > 0 && Object.keys(q1).every(k => k in p1 && Math.abs(p1[k] - q1[k]) < 1e-3), "t=1 every label rests where the static render has it");
  h.eq(Array.from(root.querySelectorAll(`[id*="axis.${axis}.gridline."]`)).filter(n => eff(n) > 0.02).length,
    Array.from(s1.querySelectorAll(`[id*="axis.${axis}.gridline."]`)).filter(n => eff(n) > 0.02).length, "t=1 gridline count equals the static render");

  // geometry for the range check: the template's raw pixel + the pooled node's translate
  const raw = fx.root(), fit = viewFits(fx.manifest, undefined, panelId)![axis as "x"]!;
  const record = (fx.manifest.axes.find(a => a.panelId === panelId) ?? fx.manifest.axes[0]) as unknown as Record<string, { domain: [number, number] } & Parameters<typeof axisFit>[0]>;
  const bounds = [projectWith(fit, record[axis].domain[0]), projectWith(fit, record[axis].domain[1])], lo = Math.min(...bounds), hi = Math.max(...bounds), slack = (hi - lo) * 0.04 + 1e-6;
  const origin = new Map<string, number>();
  for (const [leaf, g] of guideData(fx.manifest, raw)) if (g.axis === axis) origin.set(leaf, projectWith(fit, g.value));
  const templateOrigin = [...origin].find(([leaf]) => /\.tick\.\d+$/.test(leaf) && !/\.minor\./.test(leaf))?.[1] ?? 0;
  let minSolid = 99, worstGap = Infinity, minVisible = 99, maxJump = 0, prevN = -1, outside = 0;
  for (let i = 1; i < 60; i++) {
    const t = i / 60; frame(t);
    const marks = marksOf(root, axis), xs = sorted(marks.map(n => shift(n, axis)));
    for (let k = 1; k < xs.length; k++) worstGap = Math.min(worstGap, xs[k] - xs[k - 1]);
    minSolid = Math.min(minSolid, marks.filter(n => eff(n) > 0.999).length);
    const labels = labelsOf(root, axis); minVisible = Math.min(minVisible, labels.length);
    if (prevN >= 0) maxJump = Math.max(maxJump, Math.abs(labels.length - prevN)); prevN = labels.length;
    for (const n of root.querySelectorAll("[data-projection-flight]")) if (eff(n) > 0.02 && n.getAttribute("id")!.includes(`axis.${axis}.tick.`)) {
      const px = templateOrigin + shift(n, axis); if (px < lo - slack || px > hi + slack) outside++;
    }
  }
  h.ok(minSolid >= 1, `a solid (opacity 1) tick mark in EVERY frame: the axis never goes sparse (min ${minSolid})`);
  h.ok(worstGap > 1, `no two visible tick marks closer than 1 unit (worst ${worstGap.toFixed(2)}): no pixel-pair cross-fade`);
  h.ok(minVisible >= 1, `a visible label in every frame (min ${minVisible})`);
  h.ok(maxJump <= 6, `the label count steps by <= 6 per 1/60 (max ${maxJump})`);
  h.eq(outside, 0, "every visible pooled tick lies inside the axis pixel range (+4 % soft edge)");
  frame(.37); const s37 = root.toString(); frame(.9); frame(.37);
  h.ok(root.toString() === s37, "re-seeking the same t is byte-identical (seek purity: forward == back)");
  h.eq(root.querySelectorAll("[data-projection-flight]").length, pool, "the pool size is constant across frames (no clone after bind)");
  restoreProjection(root);
  h.ok(Array.from(root.querySelectorAll("[data-projection-flight]")).every(n => (n as SVGElement).style.display === "none"), "restore returns the pool to hidden");
  h.eq(labelsOf(root, axis), generated, "and shows the generated ticks again");
  h.ok(root.querySelectorAll("[data-projection-residue]").length >= pool, "pooled ticks are residue to the slide binder (never keyed, never faded)");
  return { root, o, frame, pool };
}

scenario("sine x [-0.25,5.25] -> [0,2.5]: no start view (generated) -> static retick", sine, "x", undefined, { x: { domain: [0, 2.5] } }, undefined, true);
scenario("sine x [0,2.5] -> [1,2]: a view -> view Change starts on the static retick of the first view", sine, "x", { x: { domain: [0, 2.5] } }, { x: { domain: [1, 2] } });
scenario("sine x [0,2.5] -> no view: back to the generated ticks", sine, "x", { x: { domain: [0, 2.5] } }, undefined);
scenario("sine y zoom: the y axis hands off the same way", sine, "y", undefined, { y: { domain: [-0.5, 0.5] } });
scenario("log x [1,1000] -> [10,100]: decades match, labels are 10^k", log, "x", undefined, { x: { domain: [10, 100] } });
{
  // a label whose resting offset from its tick differs from the template's (a log label is left-anchored, so its offset is half
  // its own width): each generated label keeps ITS offset at the start, and every label lands on the template's at the end
  const svg = readFileSync(new URL("./fixtures/plots/log_line_FLUXPLOT.svg", import.meta.url), "utf8")
    .replace(/(id="axis\.x\.ticklabel\.3"[^>]*>\s*<g transform="translate\()([-\d.]+)/, (_, head, x) => `${head}${Number(x) + 5}`);
  h.ok(svg !== readFileSync(new URL("./fixtures/plots/log_line_FLUXPLOT.svg", import.meta.url), "utf8"), "the variant fixture displaces one label by 5 units");
  scenario("log x with one label resting 5 units off its tick: no pop at the start, the template's offset at the end",
    { manifest: log.manifest, root: () => preparePlot(svg, log.manifest).root! }, "x", undefined, { x: { domain: [10, 100] } });
}
{
  const twin = features.manifest.axes.find(a => a.panelId === "panel.twin") as unknown as { y2: { domain: [number, number] } };
  const [lo, hi] = twin.y2.domain;
  scenario("twin y2 [24.6,35.5] -> its lower half: the twin axis is its own key", features, "y2", undefined, { y2: { domain: [lo, lo + (hi - lo) / 2] } }, "panel.twin");
}

h.section("the pool is one tick per data value: a matched tick walks, it is not a cross-fade of two");
{
  const view: PlotView = { x: { domain: [0, 2.5] } };
  const r = sine.root(), o = optsFor(sine.manifest, undefined, view); preparePlotView(r, sine.manifest, view, "", o);
  const ids = Array.from(r.querySelectorAll('[data-projection-flight][id*="axis.x.tick."]')).map(n => n.getAttribute("id")!);
  h.eq(ids.length, new Set(ids).size, "pooled ids are unique");
  h.eq(ids.length, matchTickSets(spec([-0.00327655, 0.99734742, 1.99797141, 2.99859539, 3.99921936, 4.99984336]), nice).length, "one pooled tick per paired data value (9)");
}

h.section("a re-formatted matched label swaps ONCE at t = .5, at full opacity (never '1' over '1.0')");
{
  const view: PlotView = { x: { domain: [0, 2.5] } };
  const r = sine.root(), o = optsFor(sine.manifest, undefined, view); preparePlotView(r, sine.manifest, view, "", o);
  const seen: string[] = [];
  for (let i = 0; i <= 100; i++) {
    o.t = i / 100; applyPlotView(r, sine.manifest, view, "", o);
    const ones = Array.from(r.querySelectorAll('[data-projection-flight][id*="axis.x.ticklabel."]')).filter(n => eff(n) > 0.02 && /^1(\.0)?$/.test(squash(n.textContent)));
    h.ok(ones.length <= 1, `t=${o.t.toFixed(2)}: at most ONE of "1" / "1.0" is visible`);
    if (ones.length) { seen.push(squash(ones[0].textContent)); if (i > 40 && i < 60) h.ok(eff(ones[0]) > 0.99, `t=${o.t.toFixed(2)}: the swapped label is at full opacity`); }
  }
  const swaps = seen.filter((s, i) => i && s !== seen[i - 1]).length;
  h.eq(swaps, 1, `the label text changes exactly once (${seen[0]} -> ${seen[seen.length - 1]})`);
}

h.section("a chain: two plans on one root pool their own ticks, and each frame shows only the plan in flight");
{
  const r = sine.root(), v1: PlotView = { x: { domain: [0, 2.5] } }, v2: PlotView = { x: { domain: [1, 2] } };
  const o1 = optsFor(sine.manifest, undefined, v1), o2 = optsFor(sine.manifest, v1, v2);
  preparePlotView(r, sine.manifest, v1, "", o1); const n1 = r.querySelectorAll("[data-projection-flight]").length;
  preparePlotView(r, sine.manifest, v2, "", o2); const n2 = r.querySelectorAll("[data-projection-flight]").length;
  h.ok(n1 > 0 && n2 > n1, `two plans on one root each pool their own ticks (${n1} then ${n2})`);
  const ids = Array.from(r.querySelectorAll("[data-projection-flight]")).map(n => n.getAttribute("id")!);
  h.eq(ids.length, new Set(ids).size, "ids stay unique across a chain");
  // the player restores, then applies the plan of the transform that owns the frame: the other plan's pool must stay hidden
  const frameOf = (o: PlotViewOptions, view: PlotView, t: number) => { restoreProjection(r); o.t = t; applyPlotView(r, sine.manifest, view, "", o); };
  const shown = () => Array.from(r.querySelectorAll("[data-projection-flight]")).filter(n => eff(n) > 0.02).length;
  frameOf(o2, v2, 0.6); const mid = shown(); h.ok(mid > 0, `mid-Change of the second plan shows pooled ticks (${mid})`);
  frameOf(o2, v2, 1);
  h.eq(labelsOf(r, "x").length, labelsOf((() => { const s = sine.root(); applyPlotView(s, sine.manifest, v2, ""); return s; })(), "x").length, "t = 1 of the second plan shows the static label count of its end view");
  restoreProjection(r);
  h.ok(Array.from(r.querySelectorAll("[data-projection-flight]")).every(n => (n as SVGElement).style.display === "none"), "restore hides both pools");
}

h.section("a still: renderStaticAt after a view Change keeps the projected line, the re-ticked axis and the pool");
{
  const { createDeck, addSlide, addPlotToSlide, addBeat, setTransform } = await import("../src/lib/slide/ops");
  const { renderStaticAt } = await import("../src/lib/slide/player/player");
  const { FLUX_DARK } = await import("../src/lib/slide/theme");
  const { cachePlot } = await import("../src/lib/plot/store");
  const read = (name: string, ext: string) => readFileSync(new URL(`./fixtures/plots/${name}${ext}`, import.meta.url), "utf8");
  cachePlot("still-sine", read("mpl_sine_waves_FLUXPLOT", ".svg"), sine.manifest);
  const deck = createDeck({ withTitleSlide: false }), slide = addSlide(deck, { layout: "blank" });
  const src = addPlotToSlide(deck, slide.id, { assetId: "still-sine", x: 20, y: 30, width: 480, height: 144 })!;
  const beat = addBeat(deck, slide.id)!;
  setTransform(deck, slide.id, beat.id, src, { duration: 1000, easing: "linear", state: { view: { x: { domain: [1, 3] } } } });
  const stage = { width: 960, height: 540 }, host = document.createElement("div") as unknown as HTMLElement;
  const snapshot = (index: number) => {
    host.replaceChildren();
    renderStaticAt(host, deck.slides[0], stage, index, { theme: FLUX_DARK, reducedMotion: true, plotManifest: () => sine.manifest });
    const line = host.querySelector('[id*="2hz.line"] path, [id*="2hz.line"]')!;
    const labels = Array.from(host.querySelectorAll('[id*="axis.x.ticklabel"]')).filter(n => eff(n) > 0.02).map(n => squash(n.textContent));
    return { d: line.getAttribute("d") ?? line.querySelector("path")?.getAttribute("d") ?? "", labels, pooled: host.querySelectorAll("[data-projection-flight]").length };
  };
  const before = snapshot(0), after = snapshot(1);
  h.ok(before.d && after.d && before.d !== after.d, "the post-Change still carries the PROJECTED line (not beat 0's unviewed path)");
  h.ok(after.labels.join(" ") !== before.labels.join(" "), `and the end view's labels (${after.labels.join(" ")}), not the generated ones (${before.labels.join(" ")})`);
  h.ok(after.pooled > 0, `and its hand-off pool (${after.pooled} pooled nodes) shows the end ticks`);
}

h.section("a leaf override / ghost factor on the template reaches the pool");
{
  const view: PlotView = { x: { domain: [0, 2.5] } };
  const r = sine.root(), oo = optsFor(sine.manifest, undefined, view); preparePlotView(r, sine.manifest, view, "", oo);
  const tpl = Array.from(r.querySelectorAll('[id*="axis.x.ticklabel."]')).find(n => !n.hasAttribute("data-projection-flight") && (n as SVGElement).style.display !== "none") as SVGElement;
  tpl.style.opacity = "0.5";
  applyPlotView(r, sine.manifest, view, "", { ...oo, t: 1 });
  const vis = Array.from(r.querySelectorAll('[id*="axis.x.ticklabel."][data-projection-flight]')).filter(n => (n as SVGElement).style.display !== "none");
  h.ok(vis.length > 0 && vis.every(n => Math.abs(Number((n as SVGElement).style.opacity) - 0.5) < 1e-6), "pool labels carry the template's opacity factor (0.5)");
}

h.section("scope: flag unset, category axis, asset change");
{
  const view: PlotView = { x: { domain: [0, 2.5] } };
  const r = sine.root(), oo = optsFor(sine.manifest, undefined, view, { tickHandoff: false }); preparePlotView(r, sine.manifest, view, "", oo);
  h.eq(r.querySelectorAll("[data-projection-flight]").length, 0, "tickHandoff unset: no pool (a bare applyPlotView keeps the generated ticks moving and fading)");
  const bv: PlotView = { y: { domain: [0, 5] } };
  const rb = bars.root(), ob = optsFor(bars.manifest, undefined, bv); preparePlotView(rb, bars.manifest, bv, "", ob);
  h.eq(rb.querySelectorAll('[data-projection-flight][id*="axis.x."]').length, 0, "a category x axis is never pooled");
  h.ok(rb.querySelectorAll('[data-projection-flight][id*="axis.y."]').length > 0, "while the numeric y axis of the same plot is");
  const ra = sine.root(), oa = optsFor(sine.manifest, undefined, view, { assetChange: true }); preparePlotView(ra, sine.manifest, view, "", oa);
  h.eq(ra.querySelectorAll("[data-projection-flight]").length, 0, "assetChange keeps the guide pairing (no pool)");
}
await h.done();
