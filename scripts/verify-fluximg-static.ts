// fluximg at rest, the vector half: the layer-SVG sanitizer, layer placement, the object index, object names,
// the scale bar / stamp / channel names, and the element's static SVG. Twin-engine: the same strings are the
// element on the canvas (Chromium) and the export (resvg), so a few pixels are checked through resvg too.
//
// Pure tier. Hermetic: synthetic bundles from scripts/lib/fluximgFixtures.ts, written into a scratch directory.
// Run: node --import tsx scripts/verify-fluximg-static.ts
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { harness } from "./lib/harness.mjs";
import { perfBudget } from "./lib/perfBudget.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures";
import { cropTransform, imageStrokeWidth, layerMarkup, namesMarkup, objectIndex, sanitizeLayerSvg, MAX_NAMES } from "../src/lib/fluximg/layers";
import { furnitureInset, furnitureSvg, niceLength, positionText, scalebarGeometry, stampLines } from "../src/lib/fluximg/furniture";
import { fluximgStaticSvg, insetRectMarkup } from "../src/lib/fluximg/static";
import type { FluximgLayer, FluximgManifest } from "../src/lib/fluximg/types";
import type { PixelRect, ResolvedFurniture, ResolvedLayer, ResolvedView } from "../src/lib/fluximg/view";

const h = harness("verify-fluximg-static");
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "fluximg-static-"));
const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
const bundle = async (name: string): Promise<{ manifest: FluximgManifest; dir: string }> => {
  await writeFixture(tmp, fx[name]);
  const dir = path.join(tmp, `${name}.fluximg`);
  return { manifest: JSON.parse(await fsp.readFile(path.join(dir, "fluximg.json"), "utf8")), dir };
};
const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// A hand-resolved view (viewOps.resolveView is another track's): every default spelled out.
const FURN_OFF: ResolvedFurniture = { scalebar: false, stamp: false, channelLabels: false, names: false };
function layerView(l: FluximgLayer, over: Partial<ResolvedLayer> = {}): ResolvedLayer {
  return { id: l.id, kind: l.kind, name: l.name, visible: true, opacity: 1, color: null, lut: null, strokeWidth: 1, fillOpacity: 0.12, range: null, opacityFromValue: false, ...over };
}
function view(m: FluximgManifest, over: Partial<ResolvedView> = {}): ResolvedView {
  return {
    index: { ...(m.defaults?.index ?? {}) }, projection: null,
    channels: m.channels.map((c, i) => ({ index: i, name: c.name, visible: true, color: c.color ?? null, lut: c.lut ?? null, range: c.range, norm: "linear", gamma: 1, invert: false })),
    composite: "blend", solo: 0, smooth: false, background: "#000000",
    layers: m.layers.map((l) => layerView(l, { visible: l.visible !== false })), furniture: FURN_OFF, insetOf: null, ...over,
  };
}
const SB: Exclude<ResolvedFurniture["scalebar"], false> = { corner: "bottom-right", color: "#ffffff", label: true, thickness: 3, fontSize: 7, length: null };
const matrixOf = (svg: string): number[] => { const m = /transform="matrix\(([^)]*)\)"/.exec(svg); return m ? m[1].split(" ").map(Number) : []; };
const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const L = await bundle("mean_f64_layers");
const M = L.manifest;
const svgOf = async (id: string): Promise<string> => fsp.readFile(path.join(L.dir, `layers/${id}.svg`), "utf8");
const footprintsSvg = await svgOf("footprints"), proxSvg = await svgOf("prox_lines"), discsSvg = await svgOf("discs");
const layer = (id: string): FluximgLayer => M.layers.find((l) => l.id === id)!;

h.section("A. the layer-SVG sanitizer");
{
  const s = sanitizeLayerSvg(footprintsSvg);
  h.eq([s.width, s.height], [90, 60], "the image size comes from the root viewBox");
  h.eq(s.shapes.map((x) => [x.tag, x.key, x.label]), [["path", "s1", "1"], ["path", "s2", "2"], ["path", "s3", "3"], ["path", "s7", "7"]], "the reference writer's label outlines survive whole: tag, data-key, data-label");
  h.eq(s.groupAttrs, { fill: "#ffd400", "fill-opacity": "0.12", "fill-rule": "evenodd", stroke: "#ffd400", "stroke-width": "1" }, "the layer group's presentation attributes are its defaults");
  const mixed = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- c --><title>t</title><g id="v" stroke="red" class="x" transform="scale(2)">` +
    `<path d="M1 1 L2 2" data-key="a" class="c" style="stroke:blue" filter="blur" stroke-width="2" fill="rgb(1, 2, 3)" stroke-dasharray="1 2" stroke-linecap="round" mask="m" data-foo="1"/>` +
    `<circle cx="5" cy="5" r="1" data-key="b" fill="#abc" stroke="not a colour!"><title>hover</title></circle>` +
    `<rect x="1" y="1" width="2" height="oops" data-key="c"/>` +
    `<text x="1" y="1" data-key="d">hi</text><defs><path d="M0 0" data-key="hidden"/></defs>` +
    `<ellipse cx="3" cy="3" rx="1" ry="2" data-key="e" opacity="2e-1"/>` +
    `<g fill="#00ff00"><polygon points="0,0 1,0 1,1" data-key="f"/></g>` +
    `<line x1="0" y1="0" x2="1" y2="1" data-key="a"/></g></svg>`;
  const t = sanitizeLayerSvg(mixed);
  h.eq(t.shapes.map((x) => x.key), ["a", "b", "e", "f", "a~2"], "only allowed shapes are kept (text, defs content and a shape with broken geometry are dropped); a repeated key is made unique");
  h.eq(t.shapes[0].attrs, { d: "M1 1 L2 2", fill: "rgb(1, 2, 3)", "stroke-width": "2", "stroke-dasharray": "1 2", "stroke-linecap": "round" }, "unknown attributes (class, style, filter, mask, data-*) are dropped; geometry and presentation are kept");
  h.eq(t.shapes[1].attrs, { cx: "5", cy: "5", r: "1", fill: "#abc" }, "a paint that is not a plain colour is dropped");
  h.eq(t.shapes[3].attrs.fill, "#00ff00", "a nested group's presentation is folded into its shapes");
  h.eq(t.groupAttrs, { stroke: "red" }, "the group keeps only presentation (no transform, no class)");
  const ok = '<svg viewBox="0 0 4 4"><g id="v">';
  const bad: Array<[string, string]> = [
    ["<script>alert(1)</script>", "script"], ["<style>*{}</style>", "style"], ['<image href="x.png"/>', "image"], ['<use href="#a"/>', "use"],
    ["<foreignObject><div/></foreignObject>", "foreignObject"], ['<path d="M0 0" data-key="a" onclick="x()"/>', "an event handler"],
    ['<path d="M0 0" data-key="a" onLoad="x()"/>', "an event handler in another case"], ['<a href="javascript:x()"><path d="M0 0" data-key="a"/></a>', "href"],
    ['<path d="M0 0" data-key="a" xlink:href="#x"/>', "xlink:href"], ['<path d="M0 0" data-key="a" fill="url(#g)"/>', "url()"],
    ['<path d="M0 0" data-key="a" fill="URL (#g)"/>', "url() spelt oddly"], ['<path d="M0 0" data-key="&xxe;"/>', "an entity reference"],
    ['<![CDATA[ <script> ]]>', "CDATA"], ["<defs><script/></defs>", "a script inside a dropped subtree"], ["<SCRIPT/>", "an upper-case script"],
    ['<svg:script xmlns:svg="http://www.w3.org/2000/svg"/>', "a prefixed script"],
  ];
  for (const [frag, what] of bad) {
    let threw = false;
    try { sanitizeLayerSvg(`${ok}${frag}</g></svg>`); } catch { threw = true; }
    h.ok(threw, `throws on ${what}`);
  }
  let dtype = "";
  try { sanitizeLayerSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"/>'); } catch (e) { dtype = String(e); }
  h.ok(/not allowed/.test(dtype), `throws on a DOCTYPE with entities, with a clear message (${dtype})`);
  let mal = "";
  try { sanitizeLayerSvg('<svg viewBox="0 0 1 1"><g><path d="M0 0" data-key="a"></g></svg>'); } catch (e) { mal = String(e); }
  h.ok(/does not close/.test(mal), "mis-nested markup is refused");
  const placed = layerMarkup({ ...layer("prox_lines"), id: "v" } as FluximgLayer, mixed, layerView(layer("prox_lines")), { x: 0, y: 0, width: 10, height: 10 }, { width: 10, height: 10 }, "p:");
  h.ok(!/class=|style=|filter=|mask=|transform="scale|<text|data-foo|hidden/.test(placed), "the placed markup is rebuilt from parsed data: nothing dropped comes back");
  h.ok(sanitizeLayerSvg('<svg viewBox="0 0 2 2"><g><path d="M0 0 L1 1" data-key="q&amp;&lt;1&#62;"/></g></svg>').shapes[0].key === "q&<1>", "predefined and numeric entities in values are decoded");
}

h.section("B. placement: image pixels land on the right box coordinates");
{
  const lv = layerView(layer("prox_lines"), { strokeWidth: 2 });
  const cases: Array<[string, PixelRect, { width: number; height: number }, [number, number], [number, number]]> = [
    ["full image, 5x", { x: 0, y: 0, width: 90, height: 60 }, { width: 450, height: 300 }, [14.5, 14.5], [72.5, 72.5]],
    ["a crop, 10x", { x: 10, y: 8, width: 30, height: 20 }, { width: 300, height: 200 }, [14.5, 14.5], [45, 65]],
    ["a non-square crop, 5x by 10x", { x: 20, y: 10, width: 40, height: 10 }, { width: 200, height: 100 }, [30.5, 22.5], [52.5, 125]],
    ["fractional scale", { x: 3, y: 7, width: 70, height: 33 }, { width: 211, height: 97 }, [44.5, 24.5], [(44.5 - 3) * 211 / 70, (24.5 - 7) * 97 / 33]],
  ];
  for (const [what, crop, box, p, want] of cases) {
    const svg = layerMarkup(layer("prox_lines"), proxSvg, lv, crop, box, "e1:");
    const got = apply(matrixOf(svg), p[0], p[1]);
    h.ok(close(got[0], want[0], 1e-6) && close(got[1], want[1], 1e-6), `${what}: image (${p}) → box (${got.map((v) => v.toFixed(4))}), expected (${want.map((v) => v.toFixed(4))})`);
    const t = cropTransform(crop, box), sw = Number(/<g [^>]*stroke-width="([^"]+)"/.exec(svg)![1]);
    h.ok(close(sw * Math.sqrt(t.sx * t.sy), 2, 1e-6), `${what}: stroke width ${sw} image units x scale = 2 screen px`);
  }
  h.ok(close(imageStrokeWidth(1.5, 4, 4) * 4, 1.5), "uniform scale: image-unit stroke x scale is exactly the screen width");
  const a = layerMarkup(layer("discs"), discsSvg, layerView(layer("discs")), { x: 0, y: 0, width: 90, height: 60 }, { width: 450, height: 300 }, "");
  h.ok(/<circle [^>]*cx="16.5" cy="15.5" r="2"/.test(a), "circles keep their true image-space size (r stays 2 image px; the transform scales it)");
  h.ok(!/vector-effect/.test(a), "no vector-effect anywhere");
  const red = layerMarkup(layer("footprints"), footprintsSvg, layerView(layer("footprints"), { color: "#ff0000", fillOpacity: 0.3, opacity: 0.5 }), { x: 0, y: 0, width: 90, height: 60 }, { width: 90, height: 60 }, "");
  h.ok(/stroke="#ff0000"/.test(red) && /fill="#ff0000"/.test(red) && !/#ffd400/.test(red), "a view colour replaces the stroke and tints the fill everywhere");
  h.ok(/fill-opacity="0.3"/.test(red) && /opacity="0.5"/.test(red), "fill opacity and overall opacity come from the view");
  const own = layerMarkup(layer("footprints"), footprintsSvg, layerView(layer("footprints")), { x: 0, y: 0, width: 90, height: 60 }, { width: 90, height: 60 }, "");
  h.ok(/stroke="#ffd400"/.test(own) && !/ opacity=/.test(own), "without a view colour the layer's own colours stay; opacity 1 adds no group opacity");
  h.eq(layerMarkup(layer("footprints"), footprintsSvg, layerView(layer("footprints"), { visible: false }), { x: 0, y: 0, width: 90, height: 60 }, { width: 90, height: 60 }, ""), "", "a hidden layer draws nothing");
  const crop = layerMarkup(layer("footprints"), footprintsSvg, layerView(layer("footprints")), { x: 45, y: 25, width: 20, height: 15 }, { width: 200, height: 150 }, "x:");
  h.eq([...crop.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]), ["s3"], "shapes wholly outside the crop are left out (resvg aborts on far-off layered nodes; it is cheaper too)");
  h.ok(/id="x:footprints\/s3"/.test(crop), "a shape's id is prefix + layer id / key");
}

h.section("C. the object index");
{
  const box = (o: { x: number; y: number; width: number; height: number; cx: number; cy: number }) => [o.x, o.y, o.width, o.height, o.cx, o.cy];
  const fp = Object.fromEntries(objectIndex(footprintsSvg).map((o) => [o.key, box(o)]));
  h.eq(fp.s1, [14, 12, 5, 4, 16.5, 14], "s1: a 5 x 4 block of pixels");
  h.eq(fp.s2, [30, 20, 6, 6, 33, 23], "s2: the square with a hole (two subpaths) is boxed by its outer loop");
  h.eq(fp.s3, [50, 30, 6, 6, 53, 33], "s3: two squares touching at a corner: one box over both loops, centre in the middle");
  h.eq(fp.s7, [20, 40, 3, 3, 21.5, 41.5], "s7: the thin bent shape");
  h.eq(objectIndex(proxSvg).map(box), [[14.5, 14.5, 30, 10, 29.5, 19.5], [50.5, 31.5, 6, 5, 53.5, 34]], "polylines");
  h.eq(objectIndex(discsSvg).map(box)[0], [14.5, 13.5, 4, 4, 16.5, 15.5], "circles");
  const misc = '<svg viewBox="0 0 100 100"><g>' +
    '<line x1="10" y1="40" x2="2" y2="8" data-key="line"/><ellipse cx="50" cy="50" rx="10" ry="4" data-key="ell"/><rect x="5" y="6" width="7" height="8" data-key="rect"/>' +
    '<polygon points="1,1 9,3 4,7" data-key="poly"/><path d="M10 10 h5 v3 H8 V20 l2 -1 z m30 30 l1 1" data-key="rel"/>' +
    '<path d="M0,0 C 10,0 10,10 0,10" data-key="curve"/></g></svg>';
  const mi = Object.fromEntries(objectIndex(misc).map((o) => [o.key, box(o)]));
  h.eq(mi.line, [2, 8, 8, 32, 6, 24], "line");
  h.eq(mi.ell, [40, 46, 20, 8, 50, 50], "ellipse");
  h.eq(mi.rect, [5, 6, 7, 8, 8.5, 10], "rect");
  h.eq(mi.poly, [1, 1, 8, 6, 5, 4], "polygon");
  h.eq(mi.rel, [8, 10, 33, 31, 24.5, 25.5], "path with H / V, relative h / v / l and a relative moveto after a close");
  h.eq(mi.curve, [0, 0, 10, 10, 5, 5], "a curve is boxed by its control points (a safe superset)");
}

h.section("D. object names");
{
  const idx = objectIndex(footprintsSvg), full = { x: 0, y: 0, width: 90, height: 60 }, bx = { width: 450, height: 300 };
  const names = namesMarkup(idx, null, full, bx, { layerId: "footprints", fontSize: 6, color: "#ffd400" }, "n:");
  h.eq([...names.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]), ["s1", "s2", "s3", "s7"], "every object in view is named by its key");
  const s1 = /<text id="n:name.footprints\/s1"[^>]* x="([\d.]+)" y="([\d.]+)" text-anchor="start"/.exec(names);
  h.ok(!!s1 && Number(s1[1]) > 19 * 5 && Number(s1[2]) < 12 * 5, "a name sits up-right of its object's box");
  const edge = namesMarkup([{ key: "edge", x: 88, y: 0, width: 2, height: 1, cx: 89, cy: 0.5 }], null, full, bx, { layerId: "v", fontSize: 6, color: "#fff" }, "");
  const e = /x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)"/.exec(edge)!;
  h.ok(Number(e[1]) <= 450 && e[3] === "end" && Number(e[2]) >= 6 * 4 / 3 * 0.72, "a name at the top-right corner is clamped inside the box (end-anchored, baseline below the top)");
  h.eq([...namesMarkup(idx, null, { x: 45, y: 25, width: 20, height: 15 }, bx, { layerId: "f", fontSize: 6, color: "#fff" }, "").matchAll(/data-key="(\w+)"/g)].map((m) => m[1]), ["s3"], "only objects whose centre is in the crop are named");
  const many = Array.from({ length: MAX_NAMES + 1 }, (_, i) => ({ key: `k${i}`, x: i % 90, y: 1, width: 1, height: 1, cx: (i % 90) + 0.5, cy: 1.5 }));
  h.eq(namesMarkup(many, null, full, bx, { layerId: "v", fontSize: 6, color: "#fff" }, ""), "", `more than ${MAX_NAMES} objects in view: no names at all`);
  h.ok(namesMarkup(many.slice(0, MAX_NAMES), null, full, bx, { layerId: "v", fontSize: 6, color: "#fff" }, "") !== "", `exactly ${MAX_NAMES} still get names`);
}

h.section("E. niceLength");
{
  const table: Array<[number, number]> = [[1, 1], [1.99, 1], [2, 2], [4.99, 2], [5, 5], [9.99, 5], [10, 10], [19, 10], [25, 20], [0.3, 0.2], [0.07, 0.05], [0.0101, 0.01], [5.625, 5], [123456, 100000], [750, 500], [0, 0], [-3, 0]];
  for (const [max, want] of table) h.eq(niceLength(max), want, `niceLength(${max}) = ${want}`);
}

h.section("F. the scale bar");
{
  const sbView = (over: Partial<typeof SB> = {}) => view(M, { furniture: { ...FURN_OFF, scalebar: { ...SB, ...over } } });
  const cases: Array<[PixelRect, { width: number; height: number }, number, number]> = [
    // crop, box, expected length (µm, pixel size 0.25 µm), expected bar px
    [{ x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 }, 5, 40],        // 22.5 µm wide → 25 % = 5.6 → 5 µm = 20 px x 2
    [{ x: 0, y: 0, width: 90, height: 60 }, { width: 900, height: 600 }, 5, 200],
    [{ x: 10, y: 10, width: 20, height: 20 }, { width: 300, height: 300 }, 1, 60],      // 5 µm wide → 1.25 → 1 µm = 4 px x 15
    [{ x: 0, y: 0, width: 37, height: 21 }, { width: 111, height: 63 }, 2, 24],          // 9.25 µm → 2.3 → 2 µm = 8 px x 3
  ];
  for (const [crop, box, len, px] of cases) {
    const g = scalebarGeometry(M, sbView(), crop, box)!;
    h.ok(g.length === len && close(g.width, px, 1e-9), `crop ${crop.width} px in a ${box.width} px box: ${g.length} µm = ${g.width} px (expected ${len} µm, ${px} px)`);
  }
  const fixed = scalebarGeometry(M, sbView({ length: 3 }), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 })!;
  h.ok(fixed.length === 3 && close(fixed.width, 24), "a set length is used as is: 3 µm = 12 px x 2 = 24 px");
  const g = scalebarGeometry(M, sbView(), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 })!;
  const inset = furnitureInset({ width: 180, height: 120 });
  h.ok(inset === 6 && close(g.x + g.width, 180 - 6) && close(g.y + g.height, 120 - 6) && close(g.height, 4), "bottom-right: inset 6 px (4 % of 120 = 4.8, clamped), 3 pt = 4 px thick");
  h.eq([furnitureInset({ width: 1000, height: 1000 }), furnitureInset({ width: 400, height: 300 })], [24, 12], "inset clamps at 24 px and is 4 % between");
  const tl = scalebarGeometry(M, sbView({ corner: "top-left" }), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 })!;
  h.ok(tl.x === 6 && tl.y === 6, "top-left corner");
  const svg = furnitureSvg(M, sbView(), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 }, "e:");
  h.ok(/<text id="e:scalebar.label" data-part="scalebar.label"[^>]*>5 µm<\/text>/.test(svg) && /id="e:scalebar" data-part="scalebar"/.test(svg), 'the bar and its "5 µm" label, with prefixed ids and data-part');
  const lab = /id="e:scalebar.label"[^>]* y="([\d.]+)"/.exec(svg)!;
  h.ok(Number(lab[1]) < g.y, "in a bottom corner the label sits above the bar");
  const lt = /id="e:scalebar.label"[^>]* y="([\d.]+)"/.exec(furnitureSvg(M, sbView({ corner: "top-left" }), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 }, "e:"))!;
  h.ok(Number(lt[1]) > tl.y + tl.height, "in a top corner it sits below");
  h.ok(!/scalebar.label/.test(furnitureSvg(M, sbView({ label: false }), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 }, "")), "label off: the bar alone");
  const noUnit: FluximgManifest = { ...M, axes: { ...M.axes, x: { ...M.axes.x, unit: null } } };
  h.eq(scalebarGeometry(noUnit, sbView(), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 }), null, "no unit on x: no scale bar");
  h.eq(furnitureSvg(noUnit, sbView(), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 }, ""), "", "...and nothing else switched on: no furniture at all");
  const noScale: FluximgManifest = { ...M, axes: { ...M.axes, x: { unit: "µm" } } };
  h.eq(scalebarGeometry(noScale, sbView(), { x: 0, y: 0, width: 90, height: 60 }, { width: 180, height: 120 }), null, "no pixel size on x: no scale bar");
}

h.section("G. stamps and channel names");
{
  const Z = (await bundle("stack_u16")).manifest, T = (await bundle("movie_f32")).manifest, TR = (await bundle("trials_f32")).manifest;
  const stamp = { corner: "top-left" as const, color: "#ffffff", fontSize: 7, dims: [] as string[] };
  const zv = view(Z, { furniture: { ...FURN_OFF, stamp } });
  h.eq(stampLines(Z, zv), ["z −58.5 µm"], "z-stack at its default plane: \"z −58.5 µm\" (true minus, the axis' own decimals)");
  h.eq(stampLines(Z, { ...zv, index: { z: 0 } }), ["z −61.5 µm"], "plane 0");
  const tv = view(T, { index: { t: 16 }, furniture: { ...FURN_OFF, stamp } });
  h.eq(stampLines(T, tv), ["t 0.20 s"], "movie frame 16 at 12.5 ms: \"t 0.20 s\"");
  h.eq(stampLines(Z, { ...zv, projection: { dim: "z", mode: "max", from: 2, to: 6 } }), ["max z 3–6"], "a projection: \"max z 3–6\" (planes 1-based, inclusive)");
  h.eq(stampLines(TR, view(TR, { index: { trial: 1, t: 2 }, furniture: { ...FURN_OFF, stamp } })), ["trial b", "t 0.2 s"], "an extra categorical dimension prints its label; one line per dimension");
  h.eq(stampLines(TR, view(TR, { index: { trial: 1, t: 2 }, furniture: { ...FURN_OFF, stamp: { ...stamp, dims: ["t"] } } })), ["t 0.2 s"], "chosen dims only");
  h.eq(positionText(undefined, 4, 9), "5/9", "no physical axis: the plane number");
  h.eq(stampLines(M, view(M, { furniture: { ...FURN_OFF, stamp } })), [], "a plain 2D image has nothing to stamp");
  const svg = furnitureSvg(T, { ...tv, furniture: { ...FURN_OFF, stamp, channelLabels: { corner: "top-right", fontSize: 7 } } }, { x: 0, y: 0, width: 60, height: 40 }, { width: 240, height: 160 }, "m:");
  h.ok(/<g id="m:stamp" data-part="stamp"><text id="m:stamp.0"[^>]*text-anchor="start"[^>]*>t 0.20 s<\/text><\/g>/.test(svg), "the stamp is drawn in its corner with id prefix + stamp");
  h.ok(/<text id="m:channel.0"[^>]*fill="#ff2bd6"[^>]*>channel 1<\/text>/.test(svg), "a coloured channel's name is in its colour");
  h.ok(/<text id="m:channel.1"[^>]*fill="#ffffff"[^>]*>iGluSnFR<\/text>/.test(svg), "a colour-mapped channel's name is white");
  h.ok(/font-family="Arial"[^>]*font-weight="400"/.test(svg) && !/dominant-baseline/.test(svg), "figure text font (Arial 400), explicit baselines, no dominant-baseline");
  const ys = [...svg.matchAll(/id="m:channel.\d"[^>]* y="([\d.]+)"/g)].map((m) => Number(m[1]));
  h.ok(ys.length === 2 && close(ys[1] - ys[0], 1.25 * 7 * 4 / 3, 1e-3), "channel names stack one line (1.25 em) apart");
  const solo = furnitureSvg(T, { ...tv, composite: "single", solo: 1, furniture: { ...FURN_OFF, channelLabels: { corner: "top-right", fontSize: 7 } } }, { x: 0, y: 0, width: 60, height: 40 }, { width: 240, height: 160 }, "m:");
  h.ok(!/m:channel.0/.test(solo) && /m:channel.1/.test(solo), "single composite: only the solo channel is named");
  const hidden = view(T, { furniture: { ...FURN_OFF, channelLabels: { corner: "top-right", fontSize: 7 } } });
  hidden.channels[0].visible = false;
  h.ok(!/m:channel.0/.test(furnitureSvg(T, hidden, { x: 0, y: 0, width: 60, height: 40 }, { width: 240, height: 160 }, "m:")), "a hidden channel is not named");
  // Shared corner: stamp stacks above the scale bar.
  const both = furnitureSvg(T, { ...tv, furniture: { ...FURN_OFF, scalebar: SB, stamp: { ...stamp, corner: "bottom-right" } } }, { x: 0, y: 0, width: 60, height: 40 }, { width: 240, height: 160 }, "");
  const labY = Number(/id="scalebar.label"[^>]* y="([\d.]+)"/.exec(both)![1]), stY = Number(/id="stamp.0"[^>]* y="([\d.]+)"/.exec(both)![1]);
  h.ok(stY < labY - 7 * 4 / 3, "items sharing a corner stack instead of overlapping (stamp above the scale-bar label)");
}

h.section("H. the element's static SVG");
const fullCrop = { x: 0, y: 0, width: 90, height: 60 }, box = { width: 180, height: 120 };
const composed = (over: Partial<ResolvedView> = {}, still: string | null = null, prefix = "el7:") => fluximgStaticSvg({
  manifest: M, crop: fullCrop, box, stillHref: still, idPrefix: prefix,
  layerSvg: { footprints: footprintsSvg, prox_lines: proxSvg, discs: discsSvg },
  view: view(M, {
    layers: M.layers.map((l) => layerView(l, l.id === "footprints" ? { color: "#ff0000", strokeWidth: 2, fillOpacity: 0 } : { visible: l.id === "discs" })),
    furniture: { scalebar: { ...SB, label: false }, stamp: false, channelLabels: { corner: "top-left", fontSize: 6 }, names: { layers: ["footprints"], fontSize: 6 } },
    ...over,
  }),
});
{
  const s = composed({}, "data:image/png;base64,AAAA");
  h.ok(s.startsWith('<svg x="0" y="0" width="180" height="120" viewBox="0 0 180 120" overflow="hidden">') && s.endsWith("</svg>"), "one nested svg the size of the box, overflow hidden: everything is clipped to the box in both engines");
  const order = ["el7:background", "el7:still", "el7:layer.footprints", "el7:layer.discs", "el7:names.footprints", "el7:furniture"].map((id) => s.indexOf(`id="${id}"`));
  h.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `in order: background, still, layers (view order), names, furniture (${order})`);
  h.ok(/<image id="el7:still" x="0" y="0" width="180" height="120" preserveAspectRatio="none" href="data:image\/png;base64,AAAA"\/>/.test(s), "the still covers the box exactly");
  h.ok(!/layer.activity|layer.prox_lines/.test(s), "intensity layers (pixels, not vectors) and hidden layers draw no markup");
  const reordered = composed({ layers: [...M.layers].reverse().map((l) => layerView(l, { visible: l.kind !== "intensity" })) });
  h.ok(reordered.indexOf("layer.discs") < reordered.indexOf("layer.footprints"), "layer order follows the resolved view");
  const ph = composed({ background: "transparent" });
  h.ok(!/el7:background/.test(ph) && /<rect id="el7:placeholder"[^>]*width="180" height="120"/.test(ph) && !/<image/.test(ph), "transparent background: no background rect; no still: a neutral placeholder");
  const missing = fluximgStaticSvg({ manifest: M, crop: fullCrop, box, stillHref: null, idPrefix: "", layerSvg: {}, view: view(M) });
  h.ok(!/layer\./.test(missing), "a layer without SVG text is skipped");
  h.eq(composed(), composed(), "deterministic: the same input gives the same string");
  const ids = [...s.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);
  h.ok(ids.length > 10 && new Set(ids).size === ids.length, `every id is unique (${ids.length} ids)`);
  h.ok(ids.every((id) => id.startsWith("el7:")), "every id carries the prefix");
  const inset = insetRectMarkup({ x: 30, y: 20, width: 15, height: 10 }, fullCrop, box, "el7:child3.");
  h.ok(/id="el7:child3.inset"[^>]* x="60" y="40" width="30" height="20" fill="none"[^>]*stroke-dasharray="4 3"/.test(inset), "an inset's crop as a dashed rectangle on its parent");
  h.eq(insetRectMarkup({ x: 300, y: 0, width: 5, height: 5 }, fullCrop, box, ""), "", "an inset wholly outside the parent's crop draws nothing");
}

h.section("H2. edge cases and cost");
{
  const one = '<svg viewBox="0 0 1 1"><g id="o" stroke="#fff"><rect x="0" y="0" width="1" height="1" data-key="px"/></g></svg>';
  const ov = layerView(layer("discs"), { id: "o" });
  h.ok(/id="o\/px"/.test(layerMarkup({ ...layer("discs"), id: "o" } as FluximgLayer, one, ov, { x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }, "")), "a 1 x 1 image: its one pixel's outline is placed");
  h.eq(layerMarkup(layer("discs"), discsSvg, layerView(layer("discs")), { x: 0, y: 0, width: 0, height: 10 }, box, ""), "", "an empty crop draws nothing (no division by zero)");
  h.eq(sanitizeLayerSvg('<svg viewBox="0 0 4 4"><g id="e"/></svg>').shapes, [], "a layer without shapes is fine");
  h.eq(furnitureSvg(M, view(M, { furniture: { ...FURN_OFF, scalebar: SB } }), fullCrop, { width: 0, height: 0 }, ""), "", "a zero-size box has no furniture");
  // A big label layer: 20 000 outlines (a whole-slide segmentation's worth in one view).
  const N = 20000, body: string[] = [];
  for (let i = 0; i < N; i++) { const x = (i % 200) * 5, y = Math.floor(i / 200) * 5; body.push(`<path id="b/k${i}" data-key="k${i}" data-label="${i + 1}" d="M${x},${y} L${x + 3},${y} L${x + 3},${y + 3} L${x},${y + 3} Z"/>`); }
  const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><g id="b" fill="#ffd400" stroke="#ffd400">${body.join("")}</g></svg>`;
  const bl = { ...layer("footprints"), id: "b" } as FluximgLayer, blv = layerView(bl, { id: "b" });
  let t0 = performance.now();
  layerMarkup(bl, bigSvg, blv, { x: 0, y: 0, width: 1000, height: 500 }, { width: 1000, height: 500 }, "");
  const cold = performance.now() - t0;
  t0 = performance.now();
  const zoomed = layerMarkup(bl, bigSvg, blv, { x: 100, y: 100, width: 50, height: 25 }, { width: 1000, height: 500 }, "");
  const warm = performance.now() - t0;
  // Host-scaled wall-clock pins (guide §7): 165 ms and 0.3 ms on the reference desk, where the hosted runner reads 4 to 11 times slower.
  const coldPin = perfBudget(1500), warmPin = perfBudget(100);
  h.ok(cold < coldPin.ms && warm < warmPin.ms, `20 000 outlines: first placement ${cold.toFixed(0)} ms (< ${coldPin.text}; parse + build), a re-crop ${warm.toFixed(1)} ms (< ${warmPin.text}; cached parse, culled to ${(zoomed.match(/<path /g) ?? []).length} shapes)`);
}

h.section("H2. objects styled by a column: the static composition");
{
  const T = JSON.parse(await fsp.readFile(path.join(L.dir, "layers/footprints.table.json"), "utf8"));
  const styled = (over: Partial<ResolvedView> = {}) => view(M, { layers: M.layers.map((l) => layerView(l, { visible: l.id === "footprints", styleBy: l.id === "footprints" ? { color: { column: "dendrite" } } : null })), ...over });
  const withTable = fluximgStaticSvg({ manifest: M, view: styled(), crop: fullCrop, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "s:", tables: { footprints: T } });
  const without = fluximgStaticSvg({ manifest: M, view: styled(), crop: fullCrop, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "s:" });
  h.ok(/id="s:footprints\/s1"[^>]*stroke="#4385be"/.test(withTable) && /id="s:footprints\/s3"[^>]*stroke="#da702c"/.test(withTable), "with its table, a styled layer's outlines carry their categories' colours");
  h.ok(!/footprints\/s1"[^>]*stroke=/.test(without), "without it, the layer is drawn as it always was");
  const keyed = fluximgStaticSvg({ manifest: M, view: styled({ furniture: { ...FURN_OFF, key: { layer: null, corner: "top-left", color: "#ffffff", fontSize: 6 } } as ResolvedFurniture }), crop: fullCrop, box, stillHref: null, layerSvg: { footprints: footprintsSvg }, idPrefix: "s:", tables: { footprints: T } });
  h.ok(/data-part="key"/.test(keyed) && !/data-part="key"/.test(withTable), "the key is furniture: drawn when it is on, inside the un-mirrored words group");
}

h.section("I. rasterised by resvg");
{
  const s = composed({ background: "#000000", furniture: { scalebar: { ...SB, label: false }, stamp: false, channelLabels: false, names: false } });
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120" viewBox="0 0 180 120">${s}</svg>`;
  const img = new Resvg(doc, { font: { loadSystemFonts: false } }).render(), px = img.pixels;
  const at = (x: number, y: number): [number, number, number] => { const i = (y * img.width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const white = (p: number[]) => p.every((v) => v > 240), redish = (p: number[]) => p[0] > 200 && p[1] < 60 && p[2] < 60;
  h.eq([img.width, img.height], [180, 120], "resvg renders the composed element at the box size");
  // 5 µm bar = 40 px, right edge at 174, bottom at 114, 4 px thick.
  h.ok(white(at(154, 112)) && white(at(135, 111)) && white(at(173, 113)), "the scale bar is white where it should be (x 134..174, y 110..114)");
  h.ok(!white(at(132, 112)) && !white(at(154, 108)) && !white(at(176, 112)), "...and nowhere else around it");
  // s1 covers image x 14..19, y 12..16 → box x 28..38, y 24..32; a 2 px stroke centred on the edge.
  h.ok(redish(at(28, 28)) && redish(at(27, 28)) && redish(at(37, 28)) && redish(at(33, 24)), "the label outline (2 px, red) covers its pixel edges");
  h.ok(!redish(at(33, 28)) && !redish(at(25, 28)), "inside (fill opacity 0) and outside the outline stay unpainted");
  const clipped = fluximgStaticSvg({ manifest: M, crop: { x: 15, y: 10, width: 10, height: 10 }, box: { width: 100, height: 100 }, stillHref: null, idPrefix: "", layerSvg: { footprints: footprintsSvg }, view: view(M, { background: "#000000", layers: M.layers.map((l) => layerView(l, { visible: l.id === "footprints", color: "#ff0000", strokeWidth: 3, opacity: 0.9 })) }) });
  const big = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="-20 -20 140 140"><rect x="-20" y="-20" width="140" height="140" fill="#0000ff"/>${clipped}</svg>`).render();
  const bp = (x: number, y: number) => { const i = ((y + 20) * big.width + (x + 20)) * 4; return [big.pixels[i], big.pixels[i + 1], big.pixels[i + 2]]; };
  // s1's top edge (image y 12, x 14..19) runs from box x −10 to 40 at y 20: it must stop at the box edge.
  h.ok(redish(bp(20, 20)) && redish(bp(1, 20)) && bp(-5, 20)[2] > 200 && bp(-5, 20)[0] < 30, "a zoomed crop is clipped at the box edge in resvg (outline inside, nothing drawn outside)");
}

await h.done(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });
