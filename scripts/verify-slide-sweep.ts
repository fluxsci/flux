#!/usr/bin/env -S npx tsx
// WP 3.1 (manim study, T8 D2-D4): the x-CLOCK SWEEP. A data line draws at a constant x rate (manim's Create on a plotted graph), its
// band and other marks are wiped open by the same front and its markers grow in as the front reaches each one.
//   * pure geometry (slide/sweep.ts): the polyline parse (one or several M/L subpaths), the x clock, decimation, the pen's accuracy
//     against the real polyline (<= 0.25 px at 20 000 vertices), shared frames, marker spacing, the panel duration;
//   * the draw plan through the real preset (linkedom): the visible dash IS the share of the line left of the front, pathLength
//     honoured (X12), the exit is the enter backwards, a trim window or a closed shape keeps the length clock, two lines of one
//     target share one front; the lead dot (display none at rest, one per line per plan, removed with the plan, never geometry);
//   * writeOn tight; Stagger.spacing "true" (fractional ranks on the PIXEL coordinate, oriented like the data, a log axis right,
//     player == compiler); the curve refusal; the schema enum;
//   * the auto-build (V2 only; classic keeps its bytes), `drawAlongX` and the `draw-along-x` verb.
// Run: npx tsx scripts/verify-slide-sweep.ts
import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML, DOMParser } from "linkedom";
import { harness } from "./lib/harness.mjs";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Track, Deck } from "../src/lib/slide/types";
import { preparePlot } from "../src/lib/plot/parse";
import { parsePolyline, sweepSamples, decimateSweep, sweepKeys, sweepAt, sweepDuration, sweepSpacingNeeded, unionFrame, darken, SWEEP_MAX_VERTICAL, type XY } from "../src/lib/slide/sweep";
import { PRESETS, WIPE_BOX_AT } from "../src/lib/slide/player/presets";
import { disposeSlideAnims } from "../src/lib/slide/player/player";
import { drawReach } from "../src/lib/slide/player/trim";
import { SWEEP_PEN_ATTR, drawGeometry } from "../src/lib/slide/strokeGeometry";
import { staggerRanks, staggerDelay, patchStagger } from "../src/lib/slide/stagger";
import { manifestCoordinates } from "../src/lib/slide/staggerData";
import * as slideOps from "../src/lib/slide/ops";
import { applyAutoAnimation, drawAlongX, sweepable, sweepSeries, planSweeps, SWEEP_CURVE, SWEEP_MARKER_CURVE, V2_PACE, CLASSIC_PACE, AUTO_PACES } from "../src/lib/slide/autobuild";
import { plotMeasures, geometryLength } from "../src/lib/slide/partLength";
import { compileSlide } from "../src/lib/slide/compile";
import { resolveCurve } from "../src/lib/slide/curves";
import { paramDiagnostics, PRESET_PARAMS } from "../src/lib/slide/presetCatalog";
import { validateDeckFile } from "../src/lib/project/validate";
import { FLUX_DARK } from "../src/lib/slide/theme";
import { scaffold } from "../flux-core/index";
import { saveDeck, loadDeck, drawAlongXVerb } from "../flux-core/slides";

const h = harness("verify-slide-sweep");
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const fixture = (name: string) => {
  const base = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "plots", `${name}_FLUXPLOT`);
  return { manifest: JSON.parse(readFileSync(`${base}.fluxplot.json`, "utf8")) as FluxPlotManifest, svg: readFileSync(`${base}.svg`, "utf8") };
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const { document } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, DOMParser });
const SVG = "http://www.w3.org/2000/svg";
// a browser's getTotalLength on linkedom's SVG nodes (the shared pure measure), so dash lengths are in user units as in Chrome
const measurable = (el: Element) => {
  const proto = Object.getPrototypeOf(el);
  if (!("getTotalLength" in proto)) Object.defineProperty(proto, "getTotalLength", { value(this: Element) { return geometryLength(this); }, configurable: true });
};
for (const tag of ["path", "line", "polyline", "polygon"]) measurable(document.createElementNS(SVG, tag) as unknown as Element);
/** A plot parsed by preparePlot (an XML document: its own element classes), measurable like the stage's nodes. */
const plotRoot = (svg: string, manifest: FluxPlotManifest) => { const { root } = preparePlot(svg, manifest); for (const g of Array.from(root!.querySelectorAll("path,line,polyline,polygon"))) measurable(g as unknown as Element); return root!; };
const mk = (attrs: Record<string, string>, tag = "path", parent?: Element) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); parent?.appendChild(n); return n as unknown as SVGElement; };
const ctx = { theme: FLUX_DARK, stage: { width: 640, height: 360 } };
const IDENT = (x: number) => x;
/** The visible length of a single-window dash frame (the first dash; offset 0), 0 for the hidden frame. */
const shown = (f: unknown): number => { const d = f as { strokeDasharray: string; strokeDashoffset: number | string }; return Number(d.strokeDashoffset) === 0 ? parseFloat(d.strokeDasharray) : 0; };

h.section("the polyline parse and the x clock (pure)");
h.eq(parsePolyline("M0 0 L10 5 L20 1")?.length, 3, "one absolute M/L subpath parses");
h.eq(parsePolyline("M 0 0 10 5 20 1")?.length, 3, "pairs after an M are implicit line-tos");
h.eq(parsePolyline("M0 0 L1 1 M5 5 L6 6")?.map(p => !!p.move), [false, false, true, false], "a NaN gap's second subpath parses, its first vertex marked as a pen lift");
h.eq([parsePolyline("M0 0 C1 1 2 2 3 3"), parsePolyline("m0 0 l1 1"), parsePolyline("M0 0 L1 1 Z"), parsePolyline("L1 1"), parsePolyline("")], [null, null, null, null, null], "curves, relative commands, a close, no leading M, empty: no polyline (the sampler falls back)");
h.ok(sweepSamples([{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 3, y: 2 }, { x: 10, y: 0 }]) === null, "a line running backwards by more than 0.3 % of its span has no x clock");
h.ok(sweepSamples([{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 4.99, y: 2 }, { x: 10, y: 0 }]) !== null, "backwards jitter within tolerance is clamped (a running max)");
h.ok(sweepSamples([{ x: 3, y: 0 }, { x: 3, y: 9 }]) === null, "a vertical line has no x extent");
{
  const gap = sweepSamples(parsePolyline("M0 0 L3 4 M10 0 L13 4")!)!;
  h.eq(gap.map(p => p.s), [0, 5, 5, 10], "a pen lift lays no length: the dash runs on the drawn length only");
  const keys = sweepKeys(gap);
  h.ok(near(sweepAt(keys, 0.5).s, 5) && near(sweepAt(keys, 0.45).s, 5), "the front crossing the gap draws nothing more");
}
{
  // vertical runs (review: a step's riser drew before the click and the pen cut the step's corner): an ARRIVAL and a DEPARTURE key
  const step = sweepSamples([{ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 50, y: 2 }, { x: 50, y: 4 }, { x: 100, y: 4 }])!;
  const keys = sweepKeys(step);
  h.ok(keys.every((k, i) => i === 0 || k.offset > keys[i - 1].offset) && keys[0].offset === 0 && keys[keys.length - 1].offset === 1, "offsets stay strictly increasing through vertical runs, 0..1");
  const sAt = [0, 0.01, 0.4999, 0.5001].map(c => sweepAt(keys, c).s);
  h.ok([0, 3, 51.99, 54.01].every((v, i) => near(sAt[i], v, 1e-3)), `a riser at the start is not drawn before the line starts, and the pen climbs a riser exactly AT its x (${sAt.map(v => v.toFixed(2))})`);
  h.ok(near(sweepAt(keys, 0.25).y, 2, 1e-9) && near(sweepAt(keys, 0.75).y, 4, 1e-9), "the pen follows the step's flats (it never cuts across a step)");
  const ecdf = sweepSamples(Array.from({ length: 40 }, (_, i) => ({ x: Math.floor(i / 2) * 5, y: Math.ceil(i / 2) * 3 })));
  h.eq(ecdf, null, `a line that is mostly vertical runs (a step / ECDF line: ${SWEEP_MAX_VERTICAL * 100} % or more of its length) has no x clock: it draws by length`);
}
h.ok(sweepSamples([{ x: 10, y: 0 }, { x: 5, y: 1 }, { x: 0, y: 0 }]) !== null, "a line written right to left has a clock too (its own direction)");

h.section("the pen is ON the line: accuracy and cost at scale");
const walk = (n: number, width = 600, seed = 7): XY[] => {
  let s = seed >>> 0; const r = () => ((s = Math.imul(s ^ s >>> 15, 2246822519) >>> 0) / 4294967296); let y = 100;
  return Array.from({ length: n }, (_, i) => ({ x: width * i / (n - 1), y: (y += (r() - 0.5) * 6) }));
};
const distToPolyline = (pts: XY[], p: XY): number => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, u = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y));
  }
  return best;
};
for (const n of [200, 5000, 20000]) {
  const pts = walk(n), t0 = performance.now();
  const smp = sweepSamples(pts)!, dec = decimateSweep(smp), keys = sweepKeys(dec), ms = performance.now() - t0;
  const span = pts[n - 1].x - pts[0].x;
  let worst = 0, worstX = 0;
  for (let i = 0; i < 400; i++) {
    const at = (i * 0.61803398875) % 1, k = sweepAt(keys, at);
    worstX = Math.max(worstX, Math.abs(k.x - (pts[0].x + at * span)));
    const lo = Math.max(0, Math.floor((at - .01) * (n - 1)) - 2), hi = Math.min(n - 1, Math.ceil((at + .01) * (n - 1)) + 2);
    worst = Math.max(worst, distToPolyline(pts.slice(lo, hi + 1), k));
  }
  h.ok(keys.length <= 4000, `${n} vertices -> ${keys.length} keys (<= 4000)`);
  h.ok(worstX < 1e-6 * span + 1e-9, `${n}: the pen's x IS the clock (max error ${worstX.toExponential(1)} px)`);
  h.ok(worst <= 0.25, `${n}: the pen within 0.25 px of the line (max ${worst.toFixed(3)} px)`);
  h.ok(ms < (n > 5000 ? 80 : 30), `${n}: plan cost ${ms.toFixed(1)} ms (parse excluded) is bounded`);
  h.ok(keys.every((k, i) => i === 0 || k.offset > keys[i - 1].offset) && keys.every((k, i) => i === 0 || k.s >= keys[i - 1].s), `${n}: offsets strictly increase, length never shrinks`);
}
{
  const a = sweepSamples([{ x: 0, y: 0 }, { x: 50, y: 0 }])!, b = sweepSamples([{ x: 50, y: 5 }, { x: 100, y: 5 }])!;
  const frame = unionFrame([a, b])!;
  h.eq(frame, { x0: 0, span: 100 }, "two lines running the same way share the union of their x ranges");
  const kb = sweepKeys(b, frame);
  h.ok(kb[0].offset === 0.5 && kb[kb.length - 1].offset === 1 && sweepAt(kb, 0.25).s === 0 && near(sweepAt(kb, 0.75).s, 25), "in the shared frame a later line is untouched until the front reaches it, then follows it");
  h.eq(unionFrame([a, sweepSamples([{ x: 100, y: 0 }, { x: 0, y: 0 }])!]), null, "lines running opposite ways share no frame");
  h.eq(unionFrame([sweepSamples([{ x: 100, y: 0 }, { x: 60, y: 0 }])!, sweepSamples([{ x: 50, y: 0 }, { x: 0, y: 0 }])!]), { x0: 100, span: -100 }, "a right-to-left union starts at the right");
}
h.eq([sweepSpacingNeeded([0, 10, 20, 30]), sweepSpacingNeeded([0, 10, 20.2, 30]), sweepSpacingNeeded([0, 10, 21, 30]), sweepSpacingNeeded([30, 0, 20, 10]), sweepSpacingNeeded([0, 5])], [false, false, true, false, false], "markers need true spacing only past 3 % of the mean step (order-free; two points are always even)");
h.eq([sweepDuration(560), sweepDuration(200), sweepDuration(1000), sweepDuration(NaN), sweepDuration(300, 1400)], [1600, 1000, 2000, 1600, 1400], "the panel clock: 2.8 ms per stage unit of x extent, 1000..2000 ms, unknown 1600, the pace floor wins");
h.eq([darken("#1f77b4"), darken("#4169e1cc"), darken("rgba(65, 105, 225, 0.8)"), darken("currentColor")], ["rgb(20,77,117)", "rgb(42,68,146)", "rgb(42,68,146)", "currentColor"], "the lead dot is the series colour darkened 35 % (alpha dropped; anything unparseable passes through)");

h.section("the draw plan on the x clock (the real preset, linkedom)");
const sine = fixture("mpl_sine_waves");
{
  const root = plotRoot(sine.svg, sine.manifest);
  const node = root.querySelector('[id="2hz.line"]')!, geo = node.querySelector("path")! as unknown as SVGElement;
  const keys = sweepKeys(decimateSweep(sweepSamples(parsePolyline(geo.getAttribute("d"))!)!)), total = keys[keys.length - 1].s;
  const track = { id: "t1", target: "p", preset: "drawOn", duration: 1200, params: { clock: "x" } } as Track;
  const anims = PRESETS.drawOn([node as never], track, ctx);
  h.eq(anims.length, 1, "a line target is one swept stroke");
  const [line] = anims, len = geometryLength(geo);
  let worst = 0;
  for (const c of [0.1, 0.25, 0.5, 0.75, 0.9]) worst = Math.max(worst, Math.abs(shown(line.sample!(c, IDENT)) - sweepAt(keys, c).s / total * len));
  h.ok(worst < 0.01, `the visible dash ends ON the front: the share of the line left of it (max error ${worst.toExponential(1)} user units)`);
  h.ok(near(shown(line.keyframes[1]), drawReach(len, "path"), 0.01), "the full frame sweeps the draw's reach (X12)");
  const length = PRESETS.drawOn([node as never], { ...track, params: undefined }, ctx)[0];
  h.ok(Math.abs(shown(length.sample!(0.5, IDENT)) - shown(line.sample!(0.5, IDENT))) > 1, "...which is NOT the length clock's half (a sine's arc length is not its x)");
  h.ok([0, 0.2, 0.4, 0.6, 0.8, 0.99].every((c, i, a) => i === 0 || shown(line.sample!(c, IDENT)) >= shown(line.sample!(a[i - 1], IDENT))), "the line only ever grows");
  h.ok(shown(line.keyframes[0]) === 0 && line.transient?.includes("strokeDasharray"), "hidden before its beat; the dash is transient (the authored stroke is the rest state)");
  const off = PRESETS.drawOff([node as never], { ...track, preset: "drawOff" } as Track, ctx)[0];
  const ease = (x: number) => x * x;
  h.ok([0.2, 0.5, 0.8].every(r => near(shown(off.sample!(r, ease)), shown(line.sample!(1 - r, (v) => 1 - ease(1 - v))), 1e-6)), "a drawOff on the x clock is the draw-on backwards (the retreat runs back along x)");
  const trimmed = PRESETS.drawOn([node as never], { ...track, params: { clock: "x", mode: "both-ends" } } as Track, ctx)[0];
  h.ok(Math.abs(shown(trimmed.sample!(0.5, IDENT)) - shown(line.sample!(0.5, IDENT))) > 1, "a trim window keeps the length clock (the two do not compose)");
}
{
  const svg = mk({}, "svg"), geo = mk({ d: "M 0 0 L 30 40 L 60 0", stroke: "#000", fill: "none" }, "path", svg as unknown as Element);
  const pl = mk({ d: "M 0 0 L 30 40 L 60 0", stroke: "#000", fill: "none", pathLength: "1000" }, "path", svg as unknown as Element);
  const t = { id: "t", target: "p", preset: "drawOn", params: { clock: "x" } } as Track;
  const a = PRESETS.drawOn([geo as never], t, ctx)[0].sample!(0.25, IDENT), b = PRESETS.drawOn([pl as never], t, ctx)[0].sample!(0.25, IDENT);
  h.ok(near(shown(a) / drawReach(100, "path"), shown(b) / drawReach(1000, "path"), 1e-3) && near(shown(a), 25, 0.05), `pathLength="1000" draws to the same share as none (X12): a quarter of x = ${shown(a).toFixed(2)} of 100 user units`);
  const ring = mk({ d: "M 0 0 L 60 0 L 60 40 Z", stroke: "#000", fill: "none" }, "path", svg as unknown as Element);
  h.ok(near(shown(PRESETS.drawOn([ring as never], t, ctx)[0].sample!(0.5, IDENT)), 0.5 * drawReach(100 + Math.hypot(60, 40), "path"), 0.01), "a closed shape has no x clock: it draws by length");
  const loop = mk({ d: "M 0 0 L 60 0 L 30 40 L 10 0", stroke: "#000", fill: "none" }, "path", svg as unknown as Element);
  h.ok(near(shown(PRESETS.drawOn([loop as never], t, ctx)[0].sample!(0.5, IDENT)), 0.5 * drawReach(60 + 50 + Math.hypot(20, 40), "path"), 0.05), "a line whose x runs back draws by length (the planner never emits it: same rule)");
}
{
  const g = mk({}, "g"), a = mk({ d: "M 0 0 L 50 0", stroke: "#000", fill: "none" }, "path", g as unknown as Element), b = mk({ d: "M 50 10 L 100 10", stroke: "#000", fill: "none" }, "path", g as unknown as Element);
  const anims = PRESETS.drawOn([g as never], { id: "t", target: "p", preset: "drawOn", params: { clock: "x" } } as Track, ctx);
  const at = (c: number) => anims.map(x => shown(x.sample!(c, IDENT)));
  h.ok(near(at(0.25)[0], 25, 0.05) && at(0.25)[1] === 0 && near(at(0.75)[0], drawReach(50, "path"), 0.05) && near(at(0.75)[1], 25, 0.05), `two lines of one target ride ONE front: at a quarter [${at(0.25).map(v => v.toFixed(1))}], three quarters [${at(0.75).map(v => v.toFixed(1))}]`);
  void a; void b;
  const seq = PRESETS.drawOn([g as never], { id: "t", target: "p", preset: "drawOn", params: { clock: "x", order: "sequence", lag: 1 } } as Track, ctx);
  h.ok(seq.every(x => near(shown(x.sample!(0.5, IDENT)), 0, 1e-6) || near(shown(x.sample!(0.5, IDENT)), drawReach(50, "path"), 0.05)), "in sequence each line takes its own slot and its own frame");
}

h.section("a line of several subpaths, a clipped line, a changed line");
{
  const g = mk({}, "g"), gap = mk({ d: "M 0 0 L 50 0 M 60 0 L 100 0", stroke: "#000", fill: "none" }, "path", g as unknown as Element);
  const t = { id: "t", target: "p", preset: "drawOn", params: { clock: "x" } } as Track;
  const dashed = PRESETS.drawOn([gap as never], t, ctx)[0];
  h.ok("strokeDasharray" in (dashed.sample!(0.5, IDENT) as object), "an engine without CSS `d` keeps the dash window (graceful)");
  (globalThis as { CSS?: unknown }).CSS = { supports: (p: string) => p === "d" };
  try {
    const cut = PRESETS.drawOn([gap as never], t, ctx)[0], d = (c: number) => String((cut.sample!(c, IDENT) as { d: string }).d);
    h.eq([d(0.3), d(0.55), d(0.8)], ['path("M 0 0 L 30 0")', 'path("M 0 0 L 50 0")', 'path("M 0 0 L 50 0 M 60 0 L 80 0")'], "several subpaths (Chromium restarts a dash on each): the frames carry the line's own geometry cut at the front, each subpath in turn");
    h.ok(!("strokeDasharray" in (cut.sample!(0.5, IDENT) as object)) && cut.transient?.includes("d") && d(0) === 'path("M 0 0")' && d(1) === 'path("M 0 0 L 50 0 M 60 0 L 100 0")', "no dash at all (an authored pattern keeps its phase); nothing before the beat, the whole line at its end; `d` is transient (the attribute is the rest)");
    h.ok([0.1, 0.3, 0.55, 0.8, 0.3, 0.9].map(d).join() === [0.1, 0.3, 0.55, 0.8, 0.3, 0.9].map(c => PRESETS.drawOn([gap as never], t, ctx)[0].sample!(c, IDENT)).map(f => String((f as { d: string }).d)).join(), "the prefix cache is seek-pure (forward, back and fresh plans agree)");
  } finally { delete (globalThis as { CSS?: unknown }).CSS; }
  // a clipped line (matplotlib clips each line to its axes; a zoomed view leaves data outside): the front crosses the visible part only
  const svg = mk({}, "svg"), defs = mk({}, "defs", svg as unknown as Element), clip = mk({ id: "axclip" }, "clipPath", defs as unknown as Element);
  mk({ x: "20", y: "-10", width: "60", height: "40" }, "rect", clip as unknown as Element);
  (document.body as unknown as Element).appendChild(svg as unknown as Element);
  const clipped = mk({ d: "M 0 0 L 100 0", stroke: "#000", fill: "none", "clip-path": "url(#axclip)" }, "path", svg as unknown as Element);
  const at = PRESETS.drawOn([clipped as never], t, ctx)[0], f = (c: number) => shown(at.sample!(c, IDENT));
  h.ok(near(f(0.001), 20, 0.1) && near(f(0.5), 50, 0.01) && near(f(0.999), 80, 0.1), `a clipped line's front crosses the clip's x range only (no dead lead or tail): ${[0.001, 0.5, 0.999].map(f).map(v => v.toFixed(1))}`);
  const [, pen] = PRESETS.drawOn([clipped as never], { ...t, params: { clock: "x", pen: true } } as Track, ctx);
  h.eq(pen.created![0].getAttribute("clip-path"), "url(#axclip)", "its dot rides under the same clip");
  svg.remove();
  // a <line> whose geometry changes is re-parsed (the cache keys every tag's own geometry)
  const ln = mk({ x1: "0", y1: "0", x2: "100", y2: "0", stroke: "#000" }, "line");
  const lt = { id: "l", target: "p", preset: "drawOn", params: { clock: "x" } } as Track;
  const before = shown(PRESETS.drawOn([ln as never], lt, ctx)[0].sample!(0.5, IDENT));
  ln.setAttribute("x2", "200");
  const after = shown(PRESETS.drawOn([ln as never], lt, ctx)[0].sample!(0.5, IDENT));
  h.ok(near(before, 50, 0.01) && near(after, 100, 0.01), "a <line> whose end moved draws its new geometry (the parse is keyed by x1..y2, not by a `d` it lacks)");
}

h.section("the lead dot");
{
  const root = plotRoot(sine.svg, sine.manifest);
  const node = root.querySelector('[id="2hz.line"]')!, parent = node.querySelector("path")!.parentNode as Element;
  const track = { id: "tp", target: "p", preset: "drawOn", params: { clock: "x", pen: true } } as Track;
  const anims = PRESETS.drawOn([node as never], track, ctx);
  const dot = anims.find(a => a.created?.length)!, host = dot?.created?.[0] as Element, linePath = node.querySelector("path")!;
  const hosts = () => Array.from(parent.children).filter(c => c.hasAttribute(SWEEP_PEN_ATTR));
  h.ok(anims.length === 2 && !!dot && host.getAttribute(SWEEP_PEN_ATTR) === "tp:0:0" && dot.node.getAttribute(SWEEP_PEN_ATTR) === "tp:0:0", "params.pen adds ONE dot per line, its host listed in NodeAnim.created and tagged with its track");
  h.ok(dot.node.getAttribute("display") === "none" && host.parentNode === parent && host.previousElementSibling === linePath && dot.node.getAttribute("pointer-events") === "none", "it is authored display=none right after its line (no box, measure or still ever sees it at rest)");
  h.ok(!!linePath.getAttribute("clip-path") && host !== dot.node && host.getAttribute("clip-path") === linePath.getAttribute("clip-path") && dot.node.parentNode === host, "it rides under its line's own clip (a host group carries the clip: on the moving circle the clip would travel with it)");
  const kf = dot.keyframes as { display?: string; opacity?: number }[];
  h.ok(kf.length === 2 && kf.every(k => k.display === "none" && k.opacity === 0) && !dot.transient?.length, "both declared endpoints hide it (before and after the draw); nothing of it is transient");
  const keys = sweepKeys(decimateSweep(sweepSamples(parsePolyline(node.querySelector("path")!.getAttribute("d"))!)!));
  const mid = dot.sample!(0.5, IDENT) as { display: string; opacity: number; transform: string }, k = sweepAt(keys, 0.5);
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(mid.transform)!;
  h.ok(mid.display === "inline" && mid.opacity === 1 && near(+m[1], k.x, 1e-3) && near(+m[2], k.y, 1e-3), `mid-draw it rides the front: (${m[1]}, ${m[2]}) == the line at half x`);
  h.ok(near((dot.sample!(0.015, IDENT) as { opacity: number }).opacity, 0.5, 0.02) && near((dot.sample!(0.985, IDENT) as { opacity: number }).opacity, 0.5, 0.02), "it fades in over the first and out over the last 3 % of its line (no pop)");
  h.eq(darken(node.querySelector("path")!.getAttribute("stroke") ?? (node.querySelector("path") as unknown as { style: CSSStyleDeclaration }).style?.stroke ?? ""), dot.node.getAttribute("fill"), "its fill is the line's stroke, darkened");
  PRESETS.drawOn([node as never], track, ctx);
  h.eq(hosts().length, 1, "a re-plan replaces the dot, never doubles it");
  h.ok(PRESETS.drawOn([node as never], { ...track, params: { clock: "x" } }, ctx).every(a => !a.created) && drawGeometry(node).strokes.length === 1, "no dot without params.pen; a dot in the DOM is never draw geometry");
  const custom = PRESETS.drawOn([node as never], { ...track, params: { clock: "x", pen: true, penRadius: 9, penColor: "#ff0000" } } as Track, ctx).find(a => a.created)!;
  h.ok(custom.node.getAttribute("r") === "9" && custom.node.getAttribute("fill") === "#ff0000", "penRadius / penColor override the size and colour");
  h.ok(hosts().length === 1 && hosts()[0] === custom.created![0] && !host.parentNode, "(the re-plan's dot replaced the first plan's)");
  {
    const g = mk({}, "g"), moved = mk({ d: "M 0 0 L 40 20 L 80 0", stroke: "#000", fill: "none", transform: "translate(10 5) scale(2)" }, "path", g as unknown as Element);
    const [, d2] = PRESETS.drawOn([g as never], { id: "tt", target: "p", preset: "drawOn", params: { clock: "x", pen: true } } as Track, ctx);
    const host = d2.created![0];
    h.ok(host !== d2.node && host.getAttribute("transform") === "translate(10 5) scale(2)" && d2.node.parentNode === host && host.parentNode === moved.parentNode, "a line with a transform of its own: the dot rides inside a group carrying it (its CSS transform would replace the attribute)");
  }
  const specs = [{ node: custom.node, created: custom.created, keyframes: [], beatIndex: 0, delay: 0, duration: 1, ease: resolveCurve({}), enter: true, key: "k" }];
  disposeSlideAnims(specs as never);
  h.ok(!custom.created![0].parentNode && hosts().length === 0, "disposing a plan removes the nodes it created");
}

h.section("writeOn tight");
{
  const el = document.createElement("div") as unknown as Element;
  const plain = PRESETS.writeOn([el as never], { id: "w", target: "x", preset: "writeOn" } as Track, ctx)[0].keyframes as { offset?: number; clipPath: string }[];
  const tight = PRESETS.writeOn([el as never], { id: "w", target: "x", preset: "writeOn", params: { tight: true } } as Track, ctx)[0].keyframes as { offset?: number; clipPath: string }[];
  h.ok(plain[1].offset === WIPE_BOX_AT && tight[1].offset === 1 && tight[1].clipPath === plain[1].clipPath && tight[2].clipPath === plain[2].clipPath, `tight: the ink edge runs the WHOLE eased clock (offset 1, not ${WIPE_BOX_AT}), same frames, same rest`);
  const rtl = PRESETS.writeOn([el as never], { id: "w", target: "x", preset: "writeOn", params: { tight: true, direction: "rtl" } } as Track, ctx)[0].keyframes as { offset?: number; clipPath: string }[];
  h.ok(rtl[0].clipPath === "inset(-20% -20% -20% 100%)" && rtl[1].offset === 1, "a right-to-left band wipes from the right, on the same whole clock");
}

h.section("stagger spacing \"true\"");
{
  h.eq(staggerRanks(4, "start", [0, 1, 2, 10], 0, true, "true").map(r => +r.toFixed(6)), [0, 0.3, 0.6, 3], "fractional ranks: the normalised coordinate x (count - 1), so the max rank and every footprint stay");
  h.eq(staggerRanks(4, "end", [0, 1, 2, 10], 0, true, "true").map(r => +r.toFixed(6)), [3, 2.7, 2.4, 0], "from end mirrors");
  h.eq(staggerRanks(4, "start", [0, 1, 2, 10], 0, true), staggerRanks(4, "start", [0, 1, 2, 10], 0, true, "even"), "absent = even, unchanged");
  h.eq(staggerRanks(3, "start", [null, null, null], 0, true, "true"), staggerRanks(3, "start", [null, null, null], 0, true), "no usable coordinates: the ordinal ranks");
  h.ok(near(staggerDelay({ target: "p", stagger: { totalMs: 1000, by: "x", spacing: "true" } } as Track, 0.3, 3), 100), "rank .3 of 3 over 1000 ms starts at 100 ms (the coordinate, not the ordinal)");
  let threw = 0;
  for (const p of [{ spacing: "true" as const, by: "index" as const }, { spacing: "true" as const, by: "x" as const, from: "center" as const }]) { try { patchStagger({ perMs: 40 }, p); } catch { threw++; } }
  h.eq(threw, 2, "asking for true spacing without by x|y, or from center / edges / random, is refused");
  h.eq([patchStagger({ perMs: 40 }, { spacing: "true", by: "x" }).spacing, patchStagger({ perMs: 40, by: "x", spacing: "true" }, { spacing: "even" }).spacing, patchStagger({ perMs: 40, by: "x", spacing: "true" }, { by: "index" }).spacing], ["true", undefined, undefined], "valid true kept; even stored as absent; changing the key of a true stagger returns it to even (no trap)");
  const sc = fixture("mpl_scatter"), m = clone(sc.manifest);
  const ax = m.axes[0] as unknown as { x: Record<string, unknown> };
  ax.x = { ...ax.x, scale: "log", domain: [1, 100], anchors: [{ data: 1, svg: 0 }, { data: 100, svg: 200 }] };
  const s0 = m.series[0] as unknown as { points: { index: number; svgId: string; x: number; y: number }[] };
  s0.points = [1, 10, 100].map((x, index) => ({ index, svgId: `s.point.${index}`, x, y: 0 }));
  const ids = s0.points.map(p => p.svgId), px = manifestCoordinates(m, ids, "x", "pixel"), dt = manifestCoordinates(m, ids, "x", "data");
  const frac = (v: (number | null)[]) => v.map(c => +(((c as number) - (v[0] as number)) / ((v[2] as number) - (v[0] as number))).toFixed(4));
  h.eq([frac(px), frac(dt)], [[0, 0.5, 1], [0, +(9 / 99).toFixed(4), 1]], "a log axis: decades are evenly spaced in pixels (the clock), not in data");
  const ys = manifestCoordinates(sc.manifest, sc.manifest.series[0].points!.slice(0, 5).map(p => p.svgId), "y", "pixel"), yd = sc.manifest.series[0].points!.slice(0, 5).map(p => p.y);
  h.ok(ys.every((v, i) => ys.every((w, j) => Math.sign((v as number) - (w as number)) === Math.sign(yd[i] - yd[j]))), "pixel y is oriented like the data (a screen y grows downwards): ascending still means ascending data");
}

h.section("the auto-build: one gesture per series (V2), classic untouched");
const band = fixture("ts_band_line");
const build = (manifest: FluxPlotManifest, opts: Record<string, unknown> = {}, svg = band.svg) => {
  const deck = slideOps.createDeck({ id: "d", title: "sweep" }), sl = slideOps.addSlide(deck, { id: "s", layout: "blank" });
  const p = slideOps.addPlotToSlide(deck, sl.id, { assetId: "ts", x: 20, y: 20, width: 520, height: 300 })!;
  applyAutoAnimation(deck, sl.id, p, manifest, { ...plotMeasures(parseHTML(svg).document, manifest, 520), ...opts });
  const slide = deck.slides.find(s => s.id === sl.id)!;
  return { deck, slide, p, tracks: slide.beats.flatMap(b => b.tracks), by: (part: string) => slide.beats.flatMap(b => b.tracks).find(t => t.part === part)! };
};
{
  const v2 = build(band.manifest), line = v2.by("growth.line"), bnd = v2.by("growth.band"), pts = v2.by("growth.points");
  h.eq([line.preset, line.params?.clock, line.params?.pen, line.start, line.anchor, line.curve], ["drawOn", "x", undefined, 0, undefined, SWEEP_CURVE], "the line draws on the x clock with the Data click, on Gentle (no lead dot: its markers ride along)");
  const planned = planSweeps(band.manifest, V2_PACE, plotMeasures(parseHTML(band.svg).document, band.manifest, 520).stagePerUnit).get("growth.line")!;
  h.ok(line.duration === planned.durationMs && line.duration! >= 1000 && line.duration! <= 2000 && line.duration !== planSweeps(band.manifest, V2_PACE, 10).get("growth.line")!.durationMs, `its duration is the panel clock, from the placed width (${line.duration} ms; a 10x wider placement differs)`);
  h.eq([bnd.preset, bnd.params?.tight, bnd.params?.direction, bnd.duration, bnd.curve, bnd.anchor], ["writeOn", true, "ltr", line.duration, SWEEP_CURVE, { trackId: line.id, edge: "start", offsetMs: 0 }], "the band is wiped open by the same front (tight, same clock), riding the line's start");
  h.eq([pts.preset, pts.duration, pts.params?.child, pts.stagger, pts.anchor?.trackId], ["stagger", 120, "scaleIn", { totalMs: line.duration! - 60, by: "x", from: "start", curve: SWEEP_MARKER_CURVE }, line.id], "markers grow in at the front: 120 ms windows centred on it, on the inverse curve; evenly spaced x needs no spacing field");
  h.eq(SWEEP_MARKER_CURVE.kind === "bezier" && SWEEP_CURVE.kind === "bezier" ? [SWEEP_MARKER_CURVE.p[0], SWEEP_MARKER_CURVE.p[1], SWEEP_MARKER_CURVE.p[2], SWEEP_MARKER_CURVE.p[3]] : [], SWEEP_CURVE.kind === "bezier" ? [SWEEP_CURVE.p[1], SWEEP_CURVE.p[0], SWEEP_CURVE.p[3], SWEEP_CURVE.p[2]] : [0], "the markers' curve is the clock's exact inverse (its axes swapped)");
  const order = v2.slide.beats.find(b => b.tracks.includes(line))!.tracks.map(t => t.part);
  h.eq(order.filter(p => p?.startsWith("growth.")), ["growth.line", "growth.band", "growth.points"], "the series' tracks keep the plot's build order in their beat");
  const classic = build(band.manifest, { pace: CLASSIC_PACE });
  h.ok(classic.tracks.every(t => t.params?.clock === undefined && t.params?.tight === undefined && t.stagger?.spacing === undefined && t.curve === undefined), "the classic pace writes no sweep (pre-Release-1 bytes)");
  const irregular = clone(band.manifest), s = irregular.series[0] as unknown as { data: { x: number[] }; band: { x: number[] }; points: { x: number }[] };
  s.data.x.forEach((_, i) => { const x = i < 12 ? i * 0.25 : 3 + (i - 11) * 1.6; s.data.x[i] = x; s.band.x[i] = x; s.points[i].x = x; });
  h.eq(build(irregular).by("growth.points").stagger?.spacing, "true", "irregular x: the markers take spacing \"true\"");
  const backwards = clone(band.manifest), b = backwards.series[0] as unknown as { data: { x: number[] } };
  b.data.x[10] = b.data.x[10] - 5;
  h.ok(sweepable(band.manifest, band.manifest.series[0]) && !sweepable(backwards, backwards.series[0]), "sweepable is the runtime's rule on the manifest: a backwards step is not swept");
  h.ok(build(backwards).by("growth.line").params?.clock === undefined, "...and keeps the length-clock Data beat");
  const raster = clone(band.manifest); (raster.series[0] as { rasterized?: boolean }).rasterized = true;
  h.ok(!sweepable(raster, raster.series[0]), "a rasterized series has no vector line to sweep");
  const ecdf = JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "pre-regen", "08_ecdf.fluxplot.json"), "utf8")) as FluxPlotManifest;
  const stepped = clone(band.manifest); (stepped.series[0] as unknown as { kind: string }).kind = "step";
  h.ok(ecdf.series.every(s => !sweepable(ecdf, s)) && !sweepable(stepped, stepped.series[0]), "an ECDF (mostly vertical runs) and a step line (its risers are drawn, not in its data) draw by length");
  const zoomed = clone(band.manifest); (zoomed.axes[0] as unknown as { x: { domain: number[] } }).x.domain = [4, 19];
  h.ok(!sweepable(zoomed, zoomed.series[0]), "a line that runs outside its axes' x view is not swept (its clipped-off markers would hold the visible ones back)");
  const waves = build(sine.manifest, {}, sine.svg);
  h.ok(["2hz.line", "1hz.line"].every(id => waves.by(id).params?.clock === "x" && waves.by(id).params?.pen === true && waves.by(id).start === 0) && waves.by("2hz.line").duration === waves.by("1hz.line").duration, "bare lines get the lead dot; the series of one panel share ONE clock, together");
  const c = compileSlide(build(irregular).slide, { width: 640, height: 360 }, { plotManifest: () => irregular });
  const ct = c.cues.flatMap(q => q.tracks).find(t => t.track.part === "growth.points")!, n = ct.ranks.length;
  const xs = (irregular.series[0].points ?? []).map(p => p.x), f = (x: number) => (x - xs[0]) / (xs[n - 1] - xs[0]);
  h.ok(ct.ranks.every((r, i) => near(r / (n - 1), f(xs[i]), 1e-6)) && near(Math.max(...ct.ranks), n - 1), "the compiler ranks the markers by the same pixel clock (rank / max = the point's normalised x; max = count - 1)");
  const regression = JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "pre-regen", "06_scatter_regression.fluxplot.json"), "utf8")) as FluxPlotManifest;
  const fit = build(regression, {}, "<svg viewBox='0 0 400 300'></svg>").by("fit.line");
  h.ok(sweepable(regression, regression.series.find(s => s.id === "fit")!) && fit.params?.clock === undefined && !!fit.anchor, "a fit line beside a scatter of another series is NOT swept: it keeps drawing while those points arrive");
  const perPanel = build(band.manifest, { perPanel: true });
  h.eq(perPanel.by("growth.line").params?.clock, "x", "the per-panel build sweeps too");
}

h.section("drawAlongX: one series on or off, on any deck");
{
  const base = build(band.manifest, { pace: CLASSIC_PACE });
  const deck = base.deck, line0 = clone(base.by("growth.line"));
  h.ok(!!line0.anchor, "(a classic build anchors the line on its markers)");
  const r = drawAlongX(deck, base.slide.id, base.p, band.manifest, "growth");
  const line = base.by("growth.line"), pts = base.by("growth.points"), bnd = base.by("growth.band");
  h.ok(r.line === line.id && r.tracks === 3 && line.params?.clock === "x" && line.params?.pen === undefined && pts.anchor?.trackId === line.id && bnd.params?.tight === true && !line.anchor, "on: the line sweeps, its marks ride it; the line's anchor on its own markers is resolved first (no cycle)");
  const startOf = (d: Deck) => compileSlide(d.slides.find(s => s.id === base.slide.id)!, { width: 640, height: 360 }, { plotManifest: () => band.manifest }).cues.flatMap(q => q.tracks).find(t => t.track.part === "growth.line")!.start;
  const before = build(band.manifest, { pace: CLASSIC_PACE });
  h.eq(startOf(deck), startOf(before.deck), "...the line keeps its start in the beat");
  h.eq(line.duration, line0.duration, "the sweep keeps the line's own duration unless one is given");
  const once = JSON.stringify(deck); drawAlongX(deck, base.slide.id, base.p, band.manifest, "growth");
  h.eq(JSON.stringify(deck), once, "applying it twice changes nothing");
  drawAlongX(deck, base.slide.id, base.p, band.manifest, "growth", { pen: true, durationMs: 1500 });
  h.ok(line.params?.pen === true && line.duration === 1500 && pts.stagger?.totalMs === 1440, "pen on / an explicit duration (the markers follow)");
  drawAlongX(deck, base.slide.id, base.p, band.manifest, "growth", { off: true });
  h.ok(line.params?.clock === undefined && line.params?.pen === undefined && bnd.params?.tight === undefined && pts.stagger?.spacing === undefined && line.duration === 1500, "off: back to the length clock, the timing kept");
  const err = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
  h.ok(/series not found/.test(err(() => drawAlongX(deck, base.slide.id, base.p, band.manifest, "nope"))), "an unknown series is refused");
  const backwards = clone(band.manifest); (backwards.series[0] as unknown as { data: { x: number[] } }).data.x[10] -= 5;
  h.ok(/cannot draw along x/.test(err(() => drawAlongX(deck, base.slide.id, base.p, backwards, "growth"))), "a series without an x clock is refused");
  {
    // review: the line anchored on another track that is anchored on the line's own markers (a chain, not a direct anchor)
    const chain = build(band.manifest, { pace: CLASSIC_PACE }), beat = chain.slide.beats.find(b => b.tracks.some(t => t.part === "growth.line"))!;
    const ln = chain.by("growth.line"), pts = chain.by("growth.points"), x: Track = { id: "x-chain", target: chain.p, preset: "fade", start: 0, duration: 300, anchor: { trackId: pts.id!, edge: "start", offsetMs: 100 } };
    beat.tracks.push(x); ln.anchor = { trackId: x.id!, edge: "start", offsetMs: 50 }; ln.start = 0;
    const startBefore = compileSlide(chain.slide, { width: 640, height: 360 }, { plotManifest: () => band.manifest }).cues.flatMap(q => q.tracks).find(t => t.track.part === "growth.line")!.start;
    drawAlongX(chain.deck, chain.slide.id, chain.p, band.manifest, "growth");
    const c = compileSlide(chain.slide, { width: 640, height: 360 }, { plotManifest: () => band.manifest });
    h.ok(!ln.anchor && !c.issues.some(i => /cycle/i.test(i.reason)) && c.cues.flatMap(q => q.tracks).find(t => t.track.part === "growth.line")!.start === startBefore, "a line whose anchor CHAIN reaches its own markers is resolved to its start first: no anchor cycle, same start");
  }
  const bare = build(band.manifest); for (const b of bare.slide.beats) b.tracks = b.tracks.filter(t => t.part !== "growth.line");
  h.ok(/no draw-on track/.test(err(() => drawAlongX(bare.deck, bare.slide.id, bare.p, band.manifest, "growth"))), "a series with no line draw on the slide is refused");
  h.ok(/positive/.test(err(() => drawAlongX(deck, base.slide.id, base.p, band.manifest, "growth", { durationMs: -1 }))), "a bad duration is refused");
}

h.section("curves, params, schema");
{
  const v2 = build(band.manifest), line = v2.by("growth.line"), sid = v2.slide.id;
  h.ok(!slideOps.setTrackCurve(v2.deck, sid, line.id!, { kind: "spring", bounce: 0.3 }).ok && JSON.stringify(line.curve) === JSON.stringify(SWEEP_CURVE), "a spring on a sweep is refused and the curve stays");
  h.ok(!slideOps.setTrackCurve(v2.deck, sid, line.id!, { kind: "steps", n: 4 }).ok && !slideOps.setTrackCurve(v2.deck, sid, line.id!, { kind: "bezier", p: [0.34, 1.56, 0.64, 1] }).ok, "steps and an overshooting bezier are refused (the front may neither jump nor leave the line)");
  h.ok(!slideOps.setTrack(v2.deck, sid, line.id!, { curve: { kind: "spring", bounce: 0.2 } }).ok && JSON.stringify(line.curve) === JSON.stringify(SWEEP_CURVE), "setTrack refuses it too, restoring the track");
  h.ok(slideOps.setTrackCurve(v2.deck, sid, line.id!, "linear").ok && slideOps.setTrackCurve(v2.deck, sid, v2.by("axis.x.spine")?.id ?? v2.tracks[0].id!, { kind: "spring", bounce: 0.3 }).ok, "a linear sweep is fine; a spring on any other track still is");
  {
    // review: a style could hand a sweep the curve the track itself refuses
    const deck = v2.deck as Deck;
    deck.animStyles = [{ id: "plain", name: "plain", family: "appearance", track: { preset: "drawOn", curve: { kind: "bezier", p: [0.37, 0, 0.63, 1] } } } as never,
      { id: "springy", name: "springy", family: "appearance", track: { preset: "drawOn", curve: { kind: "spring", bounce: 0.4 }, params: { clock: "x" } } } as never,
      { id: "calm", name: "calm", family: "appearance", track: { preset: "drawOn", curve: { kind: "bezier", p: [0.37, 0, 0.63, 1] }, params: { clock: "x" } } } as never];
    const bytes = JSON.stringify(line);
    const plain = slideOps.linkTrackStyle(deck, sid, line.id!, "plain"), springy = slideOps.linkTrackStyle(deck, sid, line.id!, "springy");
    h.ok(!plain.ok && /Draw along x off/.test(plain.reason ?? "") && !springy.ok && /along x needs/.test(springy.reason ?? "") && JSON.stringify(line) === bytes,
      "a sweep refuses a style that would end it (its marks are timed by it) or give it a spring; the track is untouched");
    h.ok(slideOps.linkTrackStyle(deck, sid, line.id!, "calm").ok && line.styleId === "calm", "a style with a curve the front can follow links");
    let threw = ""; try { slideOps.setAnimStyle(deck, "calm", { track: { curve: { kind: "spring", bounce: 0.4 } } as never }); } catch (e) { threw = (e as Error).message; }
    h.ok(/along x/.test(threw) && JSON.stringify(deck.animStyles!.find(s => s.id === "calm")!.track.curve) === JSON.stringify({ kind: "bezier", p: [0.37, 0, 0.63, 1] }), "editing a linked style to a spring is refused too (the style is untouched)");
  }
  h.ok(PRESET_PARAMS.drawOn.clock.default === "length" && PRESET_PARAMS.drawOff.clock.default === "length" && PRESET_PARAMS.writeOn.tight.default === false && !("tight" in PRESET_PARAMS.wipeOut), "the params: clock / pen / penRadius / penColor on the draws, tight on Wipe in only");
  h.eq([paramDiagnostics({ preset: "drawOn", params: { clock: "x", pen: true } }).length, paramDiagnostics({ preset: "fade", params: { clock: "x" } }).length > 0], [0, true], "a sweep's params are clean on a draw; on any other preset they are reported");
  const deck = v2.deck;
  h.eq(validateDeckFile(deck).length, 0, "a swept deck passes the bundled validator");
  const bad = clone(deck); (bad.slides.find(s => s.id === sid)!.beats.flatMap(b => b.tracks).find(t => t.stagger)!.stagger as Record<string, unknown>).spacing = "sideways";
  h.ok(validateDeckFile(bad).length > 0, "an unknown spacing is refused by the deck schema");
  h.ok(sweepSeries(band.manifest, band.manifest.series[0])?.others.includes("growth.band") === true, "the band is one of the series' other marks");
  h.ok(AUTO_PACES.v2.sweep !== null && AUTO_PACES.classic.sweep === null, "only the V2 pace sweeps");
}

h.section("the draw-along-x verb (headless)");
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-sweep-verb-"));
  try {
    await scaffold(root, { title: "sweep" });
    await fs.mkdir(path.join(root, "plots"), { recursive: true });
    await fs.writeFile(path.join(root, "plots", "ts.svg"), band.svg);
    await fs.writeFile(path.join(root, "plots", "ts.fluxplot.json"), JSON.stringify(band.manifest));
    const base = build(band.manifest, { pace: CLASSIC_PACE });
    await saveDeck(root, base.deck);
    const r = await drawAlongXVerb(root, base.deck.id, base.slide.id, base.p, "growth", { pen: "on" });
    const tracks = (await loadDeck(root, base.deck.id)).slides.find(s => s.id === base.slide.id)!.beats.flatMap(b => b.tracks);
    const line = tracks.find(t => t.part === "growth.line")!;
    h.ok(r.tracks === 3 && line.params?.clock === "x" && line.params?.pen === true, "draw-along-x writes the deck through the same op (pen on)");
    let refused = ""; try { await drawAlongXVerb(root, base.deck.id, base.slide.id, base.p, "growth", { pen: "maybe" as never }); } catch (e) { refused = (e as Error).message; }
    h.ok(/--pen/.test(refused), "an unknown --pen value is refused");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

await h.done();
