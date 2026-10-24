#!/usr/bin/env -S npx tsx
// X-ray row CONTEXT (2026-10-23, owner: "I can't tell if a 'Tick marks' result is for the
// x or y ticks — or which PLOT"). Pure checks of xray/rowContext.ts + buildXrayTree's
// context fields, the ONE hidden rule (plot/tree hiddenLeaves) the drawing and the eyes
// share, the family helper behind Shift+Alt+R / ←, and the rebuild cost:
//   (a) paths: every part row says where it sits ("X axis", "Y axis", "Panel twin",
//       "Colorbar: color"); scaffolding (figure, plot area, a lone panel) says nothing
//   (b) previews: tick texts / axis titles / series names from the MANIFEST (the same
//       with or without the drawing loaded), mathtext rendered ("10⁻²"), drawn text only
//       where the manifest has none; common rows say "varies" when the plots differ
//   (c) members are rows; a member's family is its group, an axis title's its axis
//   (d) plot identity side by side: the shared prefix splits off, suffixes stay,
//       copies of one plot get ordinals
//   (e) search: "x tick" finds the x axis's tick rows only, "y lab" the y tick labels,
//       a plot name narrows to that plot, a value finds its tick label
//   (f) hidden: the rows mirror the drawing's rule (keys in order, the later wins) in
//       either key order; the eye toggle normalises its subtree and reorders a key only
//       when an exception must follow the ancestor it overrules
//   (g) restyled state marks the row and its ancestors
//   (h) cost: a 5-plot root with 2,000-point series rebuilds well inside a frame
//   Run: npx tsx scripts/verify-xray-context.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { buildXrayTree, commonPartRows, nestCommonRows } = await import("../src/lib/xray/buildXrayTree");
const ctx = await import("../src/lib/xray/rowContext");
const { hiddenLeaves, resolveTargets } = await import("../src/lib/plot/tree");
const { parsePlotSvg, prefixIds, applyOverrides, partDomId } = await import("../src/lib/plot/parse");
import type { XRow } from "../src/lib/xray/buildXrayTree";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Figure, Project, SemanticPlotElement } from "../src/lib/types";

let checks = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  checks++;
  console.log("  ok:", msg);
}
const here = import.meta.dirname;

// --- fixtures: a band-power plot like the owner's (categorical x, a y title, many series) --
const CATS = ["Quiet\nwake", "Active\nwake", "SWS", "Sigma\nsleep", "REM"];
function bandpower(yTitle: string, yTicks: string[], points = 23): FluxPlotManifest {
  const pointIds = Array.from({ length: points }, (_, i) => `quiet-wake-acquisitions.point.${i}`);
  return {
    spec: "fluxplot", schemaVersion: "0.3.0", plotType: "line", svg: "", size: { width: 100, height: 80, unit: "px" },
    axes: [{
      x: { scale: "category", label: "", domain: [0, 4], anchors: [], ticks: CATS.map((label, value) => ({ value, label })) },
      y: { scale: "linear", label: yTitle, domain: [0, 1], anchors: [], ticks: yTicks.map((label, value) => ({ value, label })) },
    }],
    series: [
      { id: "acq-1-soma1", name: "acq_1__soma1", svg: { line: "acq-1-soma1.line" } },
      { id: "quiet-wake-acquisitions", kind: "scatter", svg: { points: "quiet-wake-acquisitions.points" }, points: pointIds.map((svgId, index) => ({ index, svgId, x: 0, y: index })), color: { hex: "#879a39" } },
    ],
    build: { order: [] },
    parts: {
      id: "figure", role: "figure", kind: "container", children: [{ ref: "figure.title", role: "title", kind: "text" }, {
        id: "plot-area", role: "plot-area", kind: "container", children: [
          { id: "axis.x", role: "axis", axis: "x", kind: "container", children: [
            { ref: "axis.x.spine", kind: "line" },
            { id: "axis.x.ticks", role: "group", groupRole: "tick", kind: "line", members: CATS.map((_, i) => `axis.x.tick.${i}`) },
            { id: "axis.x.tick-labels", role: "group", groupRole: "tick-label", kind: "text", members: CATS.map((_, i) => `axis.x.ticklabel.${i}`) },
          ] },
          { id: "axis.y", role: "axis", axis: "y", kind: "container", children: [
            { ref: "axis.y.spine", kind: "line" },
            { id: "axis.y.ticks", role: "group", groupRole: "tick", kind: "line", members: yTicks.map((_, i) => `axis.y.tick.${i}`) },
            { id: "axis.y.tick-labels", role: "group", groupRole: "tick-label", kind: "text", members: yTicks.map((_, i) => `axis.y.ticklabel.${i}`) },
            { ref: "axis.y.title", kind: "text" },
          ] },
          { id: "acq-1-soma1", role: "series", kind: "container", children: [{ ref: "acq-1-soma1.line", kind: "line" }] },
          { id: "quiet-wake-acquisitions", role: "series", kind: "container", children: [
            { id: "quiet-wake-acquisitions.points", role: "group", groupRole: "point", kind: "shape", members: pointIds },
          ] },
        ],
      }],
    },
  } as unknown as FluxPlotManifest;
}
const DELTA = bandpower("Delta power (µV²)", ["0", "1000", "2000", "3000"]);
const SIGMA = bandpower("Sigma power (µV²)", ["0", "800", "1600", "2400"]);
const LOG = bandpower("Power (dB)", ["$\\mathdefault{10^{-2}}$", "$\\mathdefault{10^{0}}$", "$\\mathdefault{10^{2}}$"]);
// The drawing of DELTA: tick labels as matplotlib writes them (a category as two lines),
// a title the manifest does not carry.
const DELTA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g id="figure"><text id="figure.title">Delta</text>
${CATS.map((c, i) => `<g id="axis.x.ticklabel.${i}">${c.split("\n").map((l) => `<text>${l}</text>`).join("")}</g><path id="axis.x.tick.${i}" d="M0 0"/>`).join("")}
${["0", "1000", "2000", "3000"].map((t, i) => `<g id="axis.y.ticklabel.${i}"><text>${t}</text></g><path id="axis.y.tick.${i}" d="M0 0"/>`).join("")}
<text id="axis.y.title">Delta power (µV²)</text><path id="axis.x.spine" d="M0 0"/><path id="axis.y.spine" d="M0 0"/><path id="acq-1-soma1.line" d="M0 0"/>
<g id="quiet-wake-acquisitions.points">${Array.from({ length: 23 }, (_, i) => `<circle id="quiet-wake-acquisitions.point.${i}" r="1"/>`).join("")}</g></g></svg>`;
const deltaDom = parsePlotSvg(DELTA_SVG)!;

const plotEl = (id: string, assetId: string, svgName: string, overrides: Record<string, Record<string, unknown>> = {}): SemanticPlotElement =>
  ({ type: "plot", id, x: 0, y: 0, width: 400, height: 300, rotation: 0, assetId, source: { svgPath: `plots/hc/${svgName}.svg` }, overrides }) as SemanticPlotElement;
const proj = (fig: Figure): Project => ({ version: 2, name: "t", canvases: [{ id: "c1", name: "Canvas 1" }], figures: [fig], assets: [], palette: [] }) as Project;
const find = (t: XRow | null, pred: (r: XRow) => boolean): XRow | undefined => {
  if (!t) return undefined;
  if (pred(t)) return t;
  for (const c of t.children) { const f = find(c, pred); if (f) return f; }
  return undefined;
};
const byPart = (t: XRow | null, el: string, part: string) => find(t, (r) => r.elementId === el && r.partId === part);

// ---------------------------------------------------------------------------
console.log("(a) paths");
{
  assert(JSON.stringify(ctx.partContext(DELTA, "axis.x.ticks").path) === '["X axis"]', "x tick marks sit under \"X axis\"");
  assert(JSON.stringify(ctx.partContext(DELTA, "axis.y.tick-labels").path) === '["Y axis"]', "y tick labels sit under \"Y axis\"");
  assert(ctx.partContext(DELTA, "axis.x").path.length === 0, "an axis itself has no path (figure + plot area are scaffolding)");
  assert(JSON.stringify(ctx.partContext(DELTA, "axis.x.ticklabel.2").path) === '["X axis","Tick labels"]', "a member's path ends at its group");
  assert(ctx.partContext(DELTA, "axis.y.tick-labels").axis === "y", "…and rows know their axis");
  const FEATURES = JSON.parse(await fs.readFile(path.join(here, "fixtures", "fluxplot03", "features.fluxplot.json"), "utf8")) as FluxPlotManifest;
  assert(JSON.stringify(ctx.partContext(FEATURES, "panel.twin.axis.y2.tick-labels").path) === '["Panel twin","Y2 axis"]', "multi-panel: the panel AND the twin axis are named");
  assert(ctx.partContext(FEATURES, "panel.twin.axis.y2.tick-labels").axis === "y2", "…twin axes keep their own axis id");
  const cbTicks = [...ctx.manifestIndex(FEATURES).entries.values()].find((e) => e.role === "tick-label" && /colorbar/.test(e.id));
  assert(!cbTicks || ctx.partContext(FEATURES, cbTicks.id).path.some((p) => p.startsWith("Colorbar")), "a colorbar's tick labels say Colorbar, not an axis");
}

console.log("(b) previews");
{
  assert(ctx.partContext(DELTA, "axis.x.tick-labels").preview === "Quiet wake · Active wake · SWS · Sigma sleep · REM", "tick labels preview their texts (newlines collapsed)");
  assert(ctx.partContext(DELTA, "axis.y.tick-labels").preview === "0 · 1000 · 2000 · 3000", "…the y ones theirs");
  assert(ctx.partContext(DELTA, "axis.y.ticks").preview === "0 … 3000", "tick marks preview their range");
  assert(ctx.partContext(DELTA, "axis.y").preview === "Delta power (µV²)", "an axis previews its title");
  assert(ctx.partContext(DELTA, "axis.x.ticklabel.3").preview === "Sigma sleep", "a tick-label member previews its own text");
  assert(ctx.partContext(LOG, "axis.y.tick-labels").preview === "10⁻² · 10⁰ · 10²", "mathtext ticks read as drawn (10⁻²), not as TeX");
  for (const id of ["axis.x.tick-labels", "axis.y.tick-labels", "axis.y", "axis.x.ticklabel.3", "axis.y.title"])
    assert(ctx.partContext(DELTA, id, deltaDom).preview === ctx.partContext(DELTA, id, null).preview, `${id}: the same preview with or without the drawing (manifest first)`);
  assert(ctx.plotHint(DELTA, deltaDom) === "Delta", "a plot's identity hint: its drawn title when it has one…");
  assert(ctx.plotHint(SIGMA, null) === "Sigma power (µV²)", "…else its y-axis title");
  assert(ctx.partContext(DELTA, "quiet-wake-acquisitions").swatch === "#879a39" && /scatter · 23 pts/.test(ctx.partContext(DELTA, "quiet-wake-acquisitions").preview ?? ""), "a series previews kind + size and carries its colour");
  assert(!/acq_1/.test(ctx.partContext(DELTA, "acq-1-soma1").preview ?? ""), "…but not a display name that only restates its id");
  for (const [tex, plain] of [["$\\mathdefault{2\\times10^{-1}}$", "2×10⁻¹"], ["$\\mu$m", "µm"], ["$x_{1}$", "x₁"], ["$\\mathdefault{10^{-1.5}}$", "10^(-1.5)"], ["50%", "50%"], ["$\\mathregular{10^{3}}$", "10³"], ["$\\frac{1}{2}$", "1/2"], ["$\\left(x\\right)$", "(x)"], ["$\\unknowncmd x$", "x"]])
    assert(ctx.plainTickLabel(tex) === plain, `mathtext ${JSON.stringify(tex)} → ${plain}`);
}

console.log("(c) members + family");
{
  const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [plotEl("p1", "a-delta", "bandpower-delta")] };
  const t = buildXrayTree(proj(fig), { kind: "element", figId: "f1", elementId: "p1" }, { "a-delta": DELTA });
  const tl = byPart(t, "p1", "axis.x.tick-labels")!;
  assert(tl.children.length === 5 && tl.children.every((m) => m.member && m.kind === "part"), "a group's members are rows of its own");
  assert(tl.children[2].label === "Tick label 2" && tl.children[2].preview === "SWS", "…labelled canonically, previewing their value");
  assert(tl.path?.join() === "X axis" && tl.preview?.startsWith("Quiet wake"), "the group row carries path + preview");
  assert(ctx.partFamily(DELTA, "axis.x.ticklabel.2") === "axis.x.tick-labels", "family of one tick label = its tick labels");
  assert(ctx.partFamily(DELTA, "axis.y.title") === "axis.y", "family of an axis title = its axis");
  assert(ctx.partFamily(DELTA, "quiet-wake-acquisitions.point.4") === "quiet-wake-acquisitions.points", "family of one point = the series' points");
  assert(ctx.partFamily(DELTA, "axis.x") === null, "an axis has no family below the plot (scaffolding skipped)");
}

console.log("(d) plot identity side by side");
{
  const d = ctx.distinctiveParts(["sd-early-hypno-bandpower-sigma", "sd-early-hypno-bandpower-high-gamma", "sd-early-hypno-bandpower-low-gamma"]);
  assert(d.every((x) => x.prefix === "sd-early-hypno-bandpower-") && d.map((x) => x.key).join() === "sigma,high-gamma,low-gamma", "the shared prefix splits off at a word boundary");
  const g = ctx.distinctiveParts(["bp-low-gamma", "bp-high-gamma"]);
  assert(g.map((x) => x.key).join() === "low-gamma,high-gamma", "a shared SUFFIX stays part of the name (low-gamma, not low)");
  const same = ctx.distinctiveParts(["scatter", "scatter", "ecdf"]);
  assert(same[0].ordinal === 1 && same[1].ordinal === 2 && same[2].ordinal === null, "copies of one plot get ordinals; unique labels none");
  const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [plotEl("p1", "a-delta", "bandpower-delta"), plotEl("p2", "a-sigma", "bandpower-sigma"), plotEl("p3", "a-sigma", "bandpower-sigma")] };
  const t = buildXrayTree(proj(fig), { kind: "elements", figId: "f1", elementIds: ["p1", "p2", "p3"] }, { "a-delta": DELTA, "a-sigma": SIGMA });
  const keys = t!.children.map((c) => `${c.keyParts?.key}#${c.keyParts?.ordinal ?? ""}`);
  assert(keys.join() === "sigma#1,sigma#2,delta#", `element rows carry their keys (${keys.join(", ")})`);
  assert(t!.children.every((c) => c.label.startsWith("bandpower-")), "…while the label stays the canonical name");
}

console.log("(e) search");
{
  const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [plotEl("p1", "a-delta", "bandpower-delta"), plotEl("p2", "a-sigma", "bandpower-sigma")] };
  const ms = { "a-delta": DELTA, "a-sigma": SIGMA };
  const t = buildXrayTree(proj(fig), { kind: "elements", figId: "f1", elementIds: ["p1", "p2"] }, ms)!;
  const hits = (q: string) => {
    const out: string[] = [], tokens = ctx.queryTokens(q);
    const walk = (n: XRow, plot: XRow | null) => {
      const here = n.kind === "element" ? n : plot;
      if (n.kind !== "set" && ctx.matchesQuery(ctx.rowSearchFields(n, here && here !== n ? here.label : undefined), tokens)) out.push(`${here?.label ?? ""}:${n.partId ?? n.label}`);
      for (const c of n.children) walk(c, here);
    };
    walk(t, null);
    return out;
  };
  const xt = hits("x tick");
  assert(xt.length === 4 && xt.every((h) => /axis\.x\.(ticks|tick-labels)$/.test(h)), `"x tick" → the x tick marks + labels of both plots only (${xt.length})`);
  const yl = hits("y lab");
  assert(yl.length === 2 && yl.every((h) => h.endsWith("axis.y.tick-labels")), `"y lab" → the y tick labels (${yl.join(", ")})`);
  const del = hits("delta tick");
  assert(del.length === 4 && del.every((h) => h.startsWith("bandpower-delta:")), "a plot name narrows the hits to that plot");
  // (a VALUE counts too: "sigma tick" also finds Delta's x tick labels — one reads "Sigma sleep")
  assert(hits("sigma tick").some((h) => h === "bandpower-delta:axis.x.tick-labels"), "…and a value matches as well as a name");
  assert(hits("sws").some((h) => h.endsWith("axis.x.ticklabel.2")), "a value finds the member that shows it");
  assert(!hits("tick").some((h) => /ticklabel\.\d+$/.test(h)), "…but a word never floods with every tick label member");
  assert(hits("legend").length === 0 && hits("plot area").every((h) => h.endsWith("plot-area")), "context alone never matches: a token must hit the row's own text");
  assert(JSON.stringify(ctx.highlightRanges("X axis › Tick labels", ["x", "tick"])) === "[[0,1],[9,13]]", "highlight ranges mark word starts only");
  const common = commonPartRows([fig.elements[0], fig.elements[1]] as SemanticPlotElement[], ms);
  const cy = common.find((r) => r.partId === "axis.y.tick-labels")!;
  const cx = common.find((r) => r.partId === "axis.x.tick-labels")!;
  assert(cy.path?.join() === "Y axis" && cy.preview === "varies" && cx.preview?.startsWith("Quiet wake"), "common rows carry the path; 'varies' when the plots differ, the value when they agree");
  const nested = nestCommonRows(common, DELTA);
  const cxAxis = nested.find((r) => r.partId === "axis.x");
  assert(cxAxis && cxAxis.children.map((c) => c.partId).join() === "axis.x.spine,axis.x.ticks,axis.x.tick-labels", "common rows nest as the first plot nests them (X axis › Spine / Tick marks / Tick labels)");
  assert(nested.some((r) => r.partId === "plot-area" && r.children.length === 0), "scaffolding stays a row of its own but holds nothing");
  assert(common.length === nested.reduce(function count(n: number, r: XRow): number { return r.children.reduce(count, n + 1); }, 0), "nesting keeps every common row exactly once");
}

console.log("(f) hidden: one rule for the drawing and the rows");
{
  // The rendering rule is unchanged — keys apply in order, the later wins — and the rows
  // mirror it exactly, in both key orders (saved documents draw as they always have).
  const cases: [string, Record<string, Record<string, unknown>>, boolean][] = [
    ["family hidden, then tick label 3 shown", { "axis.x.tick-labels": { hidden: true }, "axis.x.ticklabel.3": { hidden: false } }, true],
    ["tick label 3 shown, then the family hidden", { "axis.x.ticklabel.3": { hidden: false }, "axis.x.tick-labels": { hidden: true } }, false],
  ];
  for (const [name, ov, threeShown] of cases) {
    const h = hiddenLeaves(DELTA, ov as never);
    assert(h.get("axis.x.ticklabel.3") === !threeShown && h.get("axis.x.ticklabel.0") === true, `${name}: the later key wins`);
    const root = parsePlotSvg(DELTA_SVG)!;
    prefixIds(root, "p1");
    applyOverrides(root, ov as never, "p1", DELTA);
    const shown = (part: string) => (root.querySelector(`[id="${partDomId("p1", part)}"]`) as SVGElement).style.display !== "none";
    assert(shown("axis.x.ticklabel.3") === threeShown && !shown("axis.x.ticklabel.0"), `${name}: the drawing agrees with the rule`);
    const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [plotEl("p1", "a-delta", "bandpower-delta", ov)] };
    const t = buildXrayTree(proj(fig), { kind: "element", figId: "f1", elementId: "p1" }, { "a-delta": DELTA });
    const g = byPart(t, "p1", "axis.x.tick-labels")!;
    assert(threeShown ? !g.hidden && g.hiddenParts === 4 : g.hidden === true, `${name}: the group row reads as drawn (${threeShown ? "4 of 5 hidden" : "hidden"})`);
    assert(byPart(t, "p1", "axis.x.ticklabel.3")!.hidden === !threeShown, `${name}: the member row reads as drawn`);
  }
  // The reviewer's legacy case: a stale `false` under a LATER axis hide stays hidden.
  const legacy = hiddenLeaves(DELTA, { "axis.x.tick-labels": { hidden: false }, "axis.x": { hidden: true } } as never);
  assert(resolveTargets(DELTA, "axis.x").every((l) => legacy.get(l)), "a stale shown-flag never outlives a later axis hide (documents unchanged)");

  // The eye toggle (ops.setPartHidden — the X-ray's eyes and the canvas's x), through the real op.
  const ops = await import("../src/lib/ops");
  const doc = (ov: Record<string, Record<string, unknown>>) => proj({ id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [plotEl("p1", "a-delta", "bandpower-delta", structuredClone(ov))] });
  const el = (p: Project) => p.figures[0].elements[0] as SemanticPlotElement;
  const ovOf = (p: Project) => (el(p).overrides ?? {}) as Record<string, Record<string, unknown>>;
  const drawn = (p: Project, part: string) => ctx.partDrawnHidden(DELTA, ovOf(p) as never, part);
  const allHidden = (p: Project) => resolveTargets(DELTA, "axis.x.tick-labels").every((l) => hiddenLeaves(DELTA, ovOf(p) as never).get(l));
  const p = doc({});
  ops.setPartHidden(p, "p1", "axis.x.ticklabel.3", true, DELTA);
  ops.setPartHidden(p, "p1", "axis.x.ticklabel.3", false, DELTA);
  assert(!("axis.x.ticklabel.3" in ovOf(p)), "showing a part with nothing above hiding it CLEARS its flag (no stale false)");
  ops.setPartHidden(p, "p1", "axis.x.tick-labels", true, DELTA);
  assert(allHidden(p), "…so hiding the family afterwards hides all five");
  ops.setPartHidden(p, "p1", "axis.x.ticklabel.3", false, DELTA);
  assert(!drawn(p, "axis.x.ticklabel.3") && drawn(p, "axis.x.ticklabel.0") && ovOf(p)["axis.x.ticklabel.3"]?.hidden === false, "showing one member inside its hidden family draws exactly that member");
  ops.setPartHidden(p, "p1", "axis.x.tick-labels", true, DELTA);
  assert(allHidden(p) && !("axis.x.ticklabel.3" in ovOf(p)), "hiding the family again clears the exception: all hidden");
  ops.setPartHidden(p, "p1", "axis.x.tick-labels", false, DELTA);
  assert(Object.keys(ovOf(p)).length === 0, "showing the family clears every flag beneath it");
  // The exception written BEFORE the ancestor (a legacy key order) moves after it — and only then.
  const q = doc({ "axis.x.ticklabel.3": { fill: "#0000ff", hidden: true }, "axis.x.tick-labels": { hidden: true } });
  ops.setPartHidden(q, "p1", "axis.x.ticklabel.3", false, DELTA);
  assert(!drawn(q, "axis.x.ticklabel.3") && Object.keys(ovOf(q)).join() === "axis.x.tick-labels,axis.x.ticklabel.3" && ovOf(q)["axis.x.ticklabel.3"].fill === "#0000ff", "an exception written before its ancestor moves after it (other properties kept)");
  const r = doc({ "axis.x.tick-labels": { fill: "#ff0000" }, "axis.x.ticklabel.1": { fill: "#0000ff" }, "axis.x.ticklabel.2": { fill: "#00ff00" } });
  ops.setPartHidden(r, "p1", "axis.x.ticklabel.1", true, DELTA);
  ops.setPartHidden(r, "p1", "axis.x.ticklabel.1", false, DELTA);
  assert(Object.keys(ovOf(r)).join() === "axis.x.tick-labels,axis.x.ticklabel.1,axis.x.ticklabel.2", "a toggle that needs no exception never reorders keys (colour precedence untouched)");
  const s2 = doc({ "axis.x.tick-labels": { hidden: true, fill: "#ff0000" } });
  ops.setPartHidden(s2, "p1", "axis.x.ticklabel.1", false, DELTA);
  assert(ovOf(s2)["axis.x.tick-labels"]?.fill === "#ff0000", "a toggle never touches other properties");
}

console.log("(g) restyled state");
{
  const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: [plotEl("p1", "a-delta", "bandpower-delta", { "axis.y.ticklabel.2": { fill: "#ff0000" } })] };
  const t = buildXrayTree(proj(fig), { kind: "element", figId: "f1", elementId: "p1" }, { "a-delta": DELTA });
  assert(byPart(t, "p1", "axis.y.ticklabel.2")!.styled === true, "a restyled member is marked");
  assert(byPart(t, "p1", "axis.y.tick-labels")!.styledBeneath && byPart(t, "p1", "axis.y")!.styledBeneath && !byPart(t, "p1", "axis.x")!.styledBeneath, "…and so are its ancestors, nothing else");
  assert(t!.styledBeneath === true, "…up to the plot row");
}

console.log("(h) rebuild cost");
{
  const big = bandpower("Power", ["0", "1", "2"], 2000);
  const els = ["a", "b", "c", "d", "e"].map((k) => plotEl("p" + k, "big", "bandpower-" + k, { "axis.x.tick-labels": { hidden: true }, "quiet-wake-acquisitions.point.7": { fill: "#ff0000" } }));
  const fig: Figure = { id: "f1", name: "f", x: 0, y: 0, width: 800, height: 600, elements: els };
  const target = { kind: "elements" as const, figId: "f1", elementIds: els.map((e) => e.id) };
  const p = proj(fig);
  for (let i = 0; i < 5; i++) buildXrayTree(p, target, { big });
  const N = 20, t0 = performance.now();
  for (let i = 0; i < N; i++) { buildXrayTree(p, target, { big }); commonPartRows(els, { big }); }
  const ms = (performance.now() - t0) / N;
  const tree = buildXrayTree(p, target, { big })!;
  const memberRows = tree.children.reduce((n, c) => n + (byPart(c, c.elementId!, "quiet-wake-acquisitions.points")?.children.length ?? 0), 0);
  assert(memberRows === 10000, `5 plots × 2,000 points = ${memberRows} member rows built`);
  assert(ms < 40, `a full rebuild (tree + common rows) of 5 × 2,000-point plots takes ${ms.toFixed(1)} ms (< 40, headless)`);
  console.log(`    (rebuild ${ms.toFixed(1)} ms)`);
}

console.log(`VERIFY-XRAY-CONTEXT: PASS (${checks} checks)`);
