// Gradient paints gate (pure) — 2026-09-16, owner note: "if a map is selected for
// a fill/stroke color, it should be applied as a gradient along an axis, like x
// or y". Pins color/gradient.ts (stops, vectors, ids, the per-element paint
// resolution) and the export serializer's use of it: an element WITH a map
// exports <defs><linearGradient> + url(#…) paints; one WITHOUT is byte-identical
// to the pre-gradient output; an unknown map falls back to the solid colour.
//   Run: npx tsx scripts/verify-gradient-fill.ts
import {
  gradientId,
  gradientStops,
  gradientVector,
  gradientDef,
  gradientSvg,
  gradientCss,
  gradientLabel,
  elementPaints,
  paintDefsSvg,
  pathLocalBox,
} from "../src/lib/color/gradient";
import { makeGradientFill } from "../src/lib/color/collections";
import { figureToSvg } from "../src/lib/export";
import { readFileSync } from "node:fs";
import { setElementStyle } from "../src/lib/ops";
import type { Element, Figure, Project } from "../src/lib/types";

let fails = 0;
const ok = (c: boolean, name: string, extra = "") => {
  console.log(`${c ? "✓" : "✗"} ${name}${c || !extra ? "" : ` — ${extra}`}`);
  if (!c) fails++;
};

const G = (map: string, axis: "x" | "y" = "x") => makeGradientFill(map, axis)!;

// --- the module contract: the serializer's paint layer imports no colormap table ----------
{
  const src = readFileSync("src/lib/color/gradient.ts", "utf8");
  ok(!/from "\.\/collections/.test(src) && !/collections\.gen/.test(src), "color/gradient.ts imports no collections module (the deck runtime bundles it; the table stays out)");
}

// --- makeGradientFill: resolved once, stored on the element ------------------------------
{
  const g = G("crameri.batlow", "y");
  ok(g.map === "crameri.batlow" && g.axis === "y" && g.stops.length === 32 && !g.discrete, `makeGradientFill resolves the qualified name and 32 stops (${g.stops.length})`);
  const r = G("crameri.batlow_r");
  ok(r.map === "crameri.batlow_r" && r.stops[0] === g.stops[31] && r.stops[31] === g.stops[0], "_r reverses the stops and keeps the _r name");
  ok(G("viridis").map === "mpl.viridis" && G("viridis").stops[0] === G("mpl.viridis").stops[0], "a bare name resolves to its qualified form");
  ok(G("mpl.Set1").discrete === true, "a qualitative map is flagged discrete");
  ok(makeGradientFill("nope.nothing", "x") === null && makeGradientFill("", "x") === null, "unknown / empty → null");
}

// --- stops → offsets ---------------------------------------------------------------------
{
  const s = gradientStops(G("crameri.batlow"))!;
  ok(!!s && s.length === 32 && s[0].offset === 0 && s[s.length - 1].offset === 1, `a continuous fill → 32 offsets spanning 0…1 (${s?.length})`);
  const d = gradientStops(G("mpl.Set1"))!;
  ok(!!d && d.length % 2 === 0 && d[0].offset === 0 && d[1].offset > 0 && d[0].color === d[1].color, `a discrete fill → hard bands, two stops per colour (${d?.length})`);
  ok(gradientStops({ map: "x", axis: "x", stops: [] }) === null && gradientStops(null) === null, "no stops / nothing → null");
}

// --- vectors, ids, defs, css -------------------------------------------------------------
{
  ok(JSON.stringify(gradientVector("x")) === JSON.stringify({ x1: 0, y1: 0, x2: 1, y2: 0 }), "x runs left→right over the unit box");
  ok(JSON.stringify(gradientVector("y")) === JSON.stringify({ x1: 0, y1: 1, x2: 0, y2: 0 }), "y runs bottom→top over the unit box");
  ok(JSON.stringify(gradientVector("y", { x: 10, y: 20, w: 30, h: 40 })) === JSON.stringify({ x1: 10, y1: 60, x2: 10, y2: 20 }), "…and over a user-space box");
  ok(gradientId("el 1/x", "fill") === "fxg-el_1_x-fill" && gradientId("a", "stroke", "heads") === "fxg-a-stroke-heads", "ids are attribute-safe and target-suffixed");
  const def = gradientDef("g1", G("mpl.viridis"))!;
  ok(def.units === "objectBoundingBox" && def.stops.length === 32, "gradientDef without a box → objectBoundingBox");
  const udef = gradientDef("g2", G("mpl.viridis", "y"), { x: 0, y: 0, w: 100, h: 50 })!;
  ok(udef.units === "userSpaceOnUse" && udef.y1 === 50 && udef.y2 === 0, "gradientDef with a box → userSpaceOnUse in that box");
  ok(gradientDef("g3", { map: "no.such", axis: "x", stops: [] }) === null, "a fill without stops → no def");
  const svg = gradientSvg(def);
  ok(svg.startsWith('<linearGradient id="g1" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">') && svg.endsWith("</linearGradient>") && (svg.match(/<stop /g) ?? []).length === 32, "gradientSvg serializes the def with every stop");
  const css = gradientCss(G("crameri.batlow", "y"))!;
  ok(css.startsWith("linear-gradient(to top, ") && gradientCss(G("crameri.batlow"))!.startsWith("linear-gradient(to right, "), "gradientCss: y → to top, x → to right");
  ok(/%, /.test(gradientCss(G("mpl.Set1"))!) && !/%/.test(css), "…hard-banded for a discrete fill, a plain blend otherwise");
  ok(gradientCss({ map: "nope", axis: "x", stops: [] }) === null && gradientCss(null) === null, "gradientCss without stops / nothing → null");
  ok(gradientLabel({ map: "tol.sunset", axis: "y" }) === "tol.sunset · along y", "gradientLabel names the map and the axis");
}

// --- per-element paints -------------------------------------------------------------------
const rect = (over: Partial<Element> = {}): Element =>
  ({ type: "rect", id: "r1", x: 10, y: 20, width: 100, height: 50, rotation: 0, fill: "#d95f02", stroke: "#222222", strokeWidth: 2, cornerRadius: 0, ...over }) as Element;
const line = (over: Partial<Element> = {}): Element =>
  ({ type: "line", id: "l1", x: 5, y: 5, width: 100, height: 40, rotation: 0, x1: 0, y1: 40, x2: 100, y2: 0, stroke: "#111111", strokeWidth: 3, arrowStart: false, arrowEnd: true, ...over }) as Element;
const text = (over: Partial<Element> = {}): Element =>
  ({ type: "text", id: "t1", x: 0, y: 0, width: 200, height: 40, rotation: 0, text: "Gradient", color: "#333333", fontFamily: "serif", fontSize: 24, fontWeight: 400, lineHeight: 1.2, align: "left", sizing: "auto", ...over }) as Element;
const path = (over: Partial<Element> = {}): Element =>
  ({ type: "path", id: "p1", x: 50, y: 60, width: 80, height: 30, rotation: 0, d: "M 0 0 L 80 30", fill: "none", stroke: "#444444", strokeWidth: 2, closed: false, nodes: [{ x: 0, y: 0, type: "corner" }, { x: 80, y: 30, type: "corner" }], arrowEnd: true, ...over }) as Element;
{
  const solid = elementPaints(rect());
  ok(solid.fill === "#d95f02" && solid.stroke === "#222222" && solid.defs.length === 0, "no map → the solid colours, no defs");
  const P = elementPaints(rect({ fillMap: G("crameri.batlow", "y") } as Partial<Element>));
  ok(P.fill === "url(#fxg-r1-fill)" && P.stroke === "#222222" && P.defs.length === 1 && P.defs[0].units === "objectBoundingBox" && P.defs[0].y1 === 1, "rect fillMap → url(#…) fill over its own box, y bottom→top");
  const Q = elementPaints(rect({ fillMap: { map: "no.such", axis: "x", stops: [] }, strokeMap: G("tol.sunset") } as Partial<Element>));
  ok(Q.fill === "#d95f02" && Q.stroke === "url(#fxg-r1-stroke)" && Q.defs.length === 1, "a fill map without stops falls back to the solid fill; the stroke map still paints");
  const L = elementPaints(line({ strokeMap: G("mpl.viridis") } as Partial<Element>));
  ok(L.stroke === "url(#fxg-l1-stroke)" && L.heads === L.stroke && L.defs[0].units === "userSpaceOnUse" && L.defs[0].x1 === 5 && L.defs[0].x2 === 105, "line strokeMap → one figure-space gradient shared by the line and its arrowheads");
  const T = elementPaints(text({ fillMap: G("mpl.plasma") } as Partial<Element>));
  ok(T.fill === "url(#fxg-t1-fill)" && T.defs.length === 1, "text fillMap paints the glyphs");
  const Pp = elementPaints(path({ strokeMap: G("mpl.viridis") } as Partial<Element>));
  ok(Pp.stroke === "url(#fxg-p1-stroke)" && Pp.heads === "url(#fxg-p1-stroke-heads)" && Pp.defs.length === 2 && Pp.defs[1].units === "userSpaceOnUse" && Pp.defs[1].x1 === 50 && Pp.defs[1].x2 === 130, "path strokeMap → its own bbox gradient + a figure-space twin for the arrowheads");
  const open = elementPaints(path({ fillMap: G("mpl.viridis") } as Partial<Element>));
  ok(open.fill === "none" && open.defs.length === 0, "an open path ignores its fill map (no fill to paint)");
  ok(JSON.stringify(pathLocalBox(path({ nodes: undefined } as Partial<Element>))) === JSON.stringify({ x: 0, y: 0, w: 80, h: 30 }), "pathLocalBox falls back to the numbers of d");
  ok(paintDefsSvg(solid) === "" && paintDefsSvg(P).startsWith("<defs><linearGradient"), "paintDefsSvg: nothing without maps, <defs> with");
}

// --- the export serializer ----------------------------------------------------------------
{
  const fig = (els: Element[]): Figure => ({ id: "figG", name: "G", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "transparent", elements: els }) as Figure;
  const before = figureToSvg(fig([rect(), line(), text(), path()]), () => undefined);
  ok(!before.includes("linearGradient") && before.includes('fill="#d95f02"'), "elements without maps export exactly as before (no defs, solid paints)");
  const after = figureToSvg(fig([rect({ fillMap: G("crameri.batlow", "y") } as Partial<Element>), line({ strokeMap: G("mpl.viridis") } as Partial<Element>)]), () => undefined);
  ok(after.includes('<defs><linearGradient id="fxg-r1-fill" x1="0" y1="1" x2="0" y2="0" gradientUnits="objectBoundingBox">') && after.includes('fill="url(#fxg-r1-fill)"'), "rect export carries the gradient def and paints with it");
  ok(after.includes('id="fxg-l1-stroke"') && after.includes('gradientUnits="userSpaceOnUse"') && after.includes('stroke="url(#fxg-l1-stroke)"') && after.includes('<polygon points="') && after.includes('fill="url(#fxg-l1-stroke)"'), "line export: the stroke and the arrowhead share the def");
  const idx = after.indexOf("<defs>"), useIdx = after.indexOf('fill="url(#fxg-r1-fill)"');
  ok(idx >= 0 && idx < useIdx, "defs precede their use");
}

// --- the style patch ----------------------------------------------------------------------
{
  const r = rect() as Element & { fill: string; fillMap?: unknown; strokeMap?: unknown };
  const proj = { figures: [{ id: "f", elements: [r] }] } as unknown as Project;
  setElementStyle(proj, ["r1"], { fillMap: G("mpl.viridis") });
  ok(JSON.stringify(r.fillMap) === JSON.stringify(G("mpl.viridis")), "setElementStyle sets a fill map (stops and all)");
  setElementStyle(proj, ["r1"], { fill: "#ff0000" });
  ok(r.fill === "#ff0000" && r.fillMap === undefined, "a solid fill patch clears the map");
  setElementStyle(proj, ["r1"], { strokeMap: G("tol.sunset", "y") });
  setElementStyle(proj, ["r1"], { strokeMap: null });
  ok(r.strokeMap === undefined, "strokeMap: null clears");
}

console.log(fails ? `\n${fails} FAILED` : "\nGRADIENT FILL ALL PASS");
process.exit(fails ? 1 : 0);
