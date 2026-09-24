#!/usr/bin/env -S node --import tsx
// Slide decks export to PowerPoint (2026-09-24, owner request: "export slides
// in pptx too; vector images remain vector, so you can edit the single
// elements") — the pure half of deckPptx.ts.
//
// Writes a deck through the real writer (a stub rasterizer stands in for the
// canvas PNG fallback), unzips it and checks the package:
//   • every XML part is well-formed, and [Content_Types].xml covers every part
//     and media type in the zip;
//   • the slide is 13.333 in wide at the deck's aspect ratio;
//   • text is a NATIVE text box whose runs carry bold / italic / underline /
//     colour / superscript / subscript, with exact line spacing;
//   • rect, rounded rect, ellipse, line (with its arrowheads and dash) and path
//     (custom geometry) are native shapes;
//   • a plot is a VECTOR picture: the SVG part plus the PNG fallback
//     (asvg:svgBlip), and the SVG is the plot's own markup, not a raster;
//   • a raster image keeps its crop; hidden and not-yet-born elements are out;
//   • the build's final step is what is written.
// Native checks (PowerPoint opens it without repair, shape kinds, render) were
// run against the owner's deck through PowerPoint's COM interface.
//   Run: node --import tsx scripts/verify-slide-pptx.ts
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser as XmlParser } from "@xmldom/xmldom";
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import { deckPptxBytes, pptxColor } from "../src/lib/slide/export/deckPptx";
import { createDeck } from "../src/lib/slide/ops";

const h = harness("verify-slide-pptx");
const { document, DOMParser, XMLSerializer } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, DOMParser, XMLSerializer });

const PLOT_SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const PLOT_MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const STUB_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let rasterCalls = 0;
const rasterize = async () => { rasterCalls++; return STUB_PNG; };

const deck = createDeck({ id: "pptx-deck", title: "PPTX & acceptance", withTitleSlide: false });
deck.stage = { width: 640, height: 360 };
const base = { rotation: 0 };
const text = { ...base, id: "t", type: "text", name: "Title text", x: 40, y: 30, width: 400, height: 40,
  text: "E = mc2 and H2O\nsecond line", fontFamily: "Arial", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "center",
  color: "#111111", sizing: "fixed", lineHeight: 1.25,
  runs: [{ from: 0, to: 1, bold: true }, { from: 4, to: 6, italic: true, color: "#AF3029" }, { from: 6, to: 7, script: "super" }, { from: 13, to: 14, script: "sub" }, { from: 16, to: 22, underline: true }] };
deck.slides = [{
  id: "s1", name: "One", beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id: "in", target: "late", preset: "fade", duration: 200, easing: "linear" }] }],
  elements: [
    text,
    { ...base, id: "r", type: "rect", name: "Box", x: 40, y: 100, width: 120, height: 60, fill: "#205EA6", stroke: "#000000", strokeWidth: 2, cornerRadius: 0, dash: [6, 3] },
    { ...base, id: "rr", type: "rect", name: "Rounded", x: 180, y: 100, width: 120, height: 60, fill: "#66800B", stroke: "none", strokeWidth: 0, cornerRadius: 12, opacity: 0.5 },
    { ...base, id: "e", type: "ellipse", name: "Oval", x: 320, y: 100, width: 80, height: 60, fill: "none", stroke: "#5E409D", strokeWidth: 3 },
    { ...base, id: "l", type: "line", name: "Arrow", x: 40, y: 200, width: 200, height: 0, x1: 200, y1: 0, x2: 0, y2: 0, stroke: "#111111", strokeWidth: 2, arrowStart: false, arrowEnd: true, arrowStyle: "vee" },
    { ...base, id: "p", type: "path", name: "Curve", x: 260, y: 200, width: 100, height: 60, d: "", fill: "none", stroke: "#AD8301", strokeWidth: 2, closed: false,
      nodes: [{ x: 0, y: 60, type: "smooth", hOut: { dx: 30, dy: -60 } }, { x: 100, y: 0, type: "smooth", hIn: { dx: -30, dy: 60 } }] },
    { ...base, id: "plot", type: "plot", name: "Scatter", x: 400, y: 180, width: 200, height: 150, assetId: "plot-asset", overrides: {} },
    { ...base, id: "img", type: "image", name: "Photo", x: 20, y: 280, width: 80, height: 40, assetId: "png-asset", crop: { x: 10, y: 5, width: 20, height: 10 } },
    { ...base, id: "hid", type: "rect", name: "Hidden", x: 0, y: 0, width: 10, height: 10, fill: "#000000", stroke: "none", strokeWidth: 0, cornerRadius: 0, hidden: true },
    { ...base, id: "late", type: "rect", name: "Late", x: 500, y: 20, width: 40, height: 40, fill: "#24837B", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
  ],
}] as typeof deck.slides;
deck.background = "#FFFCF0";
const payload = { deck, plots: { "plot-asset": { svg: PLOT_SVG, manifest: PLOT_MANIFEST } }, assets: { "png-asset": PNG }, assetSizes: { "png-asset": { width: 40, height: 20 } } };

const result = await deckPptxBytes(deck.title, [{ payload }], rasterize);
const zip = unzipSync(result.bytes);
const names = Object.keys(zip);
h.ok(result.slides === 1 && result.warnings.length === 0, `one slide, no warnings (${JSON.stringify(result.warnings)})`);
h.ok(names[0] === "[Content_Types].xml", "[Content_Types].xml is the first part, as Office writes it");

// ---- well-formed XML and complete content types ----------------------------
const bad: string[] = [];
for (const name of names.filter((n) => /\.(xml|rels)$/.test(n))) {
  const errors: string[] = [];
  new XmlParser({ errorHandler: { error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m) } }).parseFromString(strFromU8(zip[name]), "application/xml");
  if (errors.length) bad.push(`${name}: ${errors[0]}`);
}
h.ok(bad.length === 0, `every XML part is well-formed (${bad.slice(0, 2).join(" | ")})`);
const types = strFromU8(zip["[Content_Types].xml"]);
const missing = names.filter((n) => {
  if (n.endsWith("/") || n === "[Content_Types].xml") return false;
  const ext = n.split(".").pop()!;
  return !types.includes(`PartName="/${n}"`) && !types.includes(`Extension="${ext}"`);
});
h.ok(missing.length === 0, `content types cover every part (${missing.join(", ")})`);

// ---- presentation ----------------------------------------------------------
const pres = strFromU8(zip["ppt/presentation.xml"]);
h.ok(pres.includes('<p:sldSz cx="12192000" cy="6858000"/>'), "the slide is 13.333 in wide at the stage's 16:9");
h.ok(strFromU8(zip["docProps/core.xml"]).includes("<dc:title>PPTX &amp; acceptance</dc:title>"), "the deck title is escaped into the document properties");

// ---- the slide -------------------------------------------------------------
const slide = strFromU8(zip["ppt/slides/slide1.xml"]);
const slideRels = strFromU8(zip["ppt/slides/_rels/slide1.xml.rels"]);
h.ok(slide.includes('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFCF0"/>'), "the slide background is written");
h.ok(slide.includes('txBox="1"') && slide.includes('name="Title text"'), "text is a native, named text box");
const paras = slide.split("<a:p>").length - 1;
h.ok(paras >= 2 && slide.includes('algn="ctr"'), `hard line breaks are paragraphs, alignment kept (${paras})`);
h.ok(/b="1"[^>]*><a:solidFill><a:srgbClr val="111111"\/>[^]*?<a:t>E<\/a:t>/.test(slide), "a bold run keeps its bold");
h.ok(/i="1"[^>]*><a:solidFill><a:srgbClr val="AF3029"\/>[^]*?<a:t>mc<\/a:t>/.test(slide), "an italic, coloured run keeps both");
h.ok(/baseline="30000"[^>]*>[^]*?<a:t>2<\/a:t>/.test(slide) && /baseline="-25000"[^>]*>[^]*?<a:t>2<\/a:t>/.test(slide),
  "superscript and subscript runs are PowerPoint baseline offsets");
h.ok(/u="sng"[^>]*>[^]*?<a:t>second<\/a:t>/.test(slide), "an underlined run keeps its underline");
h.ok(slide.includes('<a:lnSpc><a:spcPts val="4500"/></a:lnSpc>'), "line height is exact spacing (24 px x 1.25 = 30 px, at 2x = 45 pt)");
h.ok(slide.includes('sz="3600"'), "font size maps px -> pt at the slide scale (24 px -> 36 pt)");
h.ok(slide.includes('name="Box"') && slide.includes('prst="rect"') && slide.includes("<a:custDash>"), "a dashed rectangle is a native rectangle");
h.ok(slide.includes('prst="roundRect"') && slide.includes('<a:alpha val="50000"/>'), "a rounded, half-transparent rectangle keeps both");
h.ok(slide.includes('prst="ellipse"') && /name="Oval"[^]*?<a:noFill\/><a:ln w="\d+"/.test(slide), "an unfilled ellipse is a native ellipse with its outline");
h.ok(/<p:cxnSp>[^]*?name="Arrow"[^]*?prst="line"[^]*?<a:tailEnd type="arrow"/.test(slide), "a line is a native connector with its arrowhead");
h.ok(/name="Arrow"[^]*?flipH="1"/.test(slide), "a line drawn right-to-left is flipped, not mirrored");
h.ok(/name="Curve"[^]*?<a:custGeom>[^]*?<a:cubicBezTo>/.test(slide), "a path is a native freeform with its curves");
h.ok(/name="Scatter"[^]*?<asvg:svgBlip [^>]*r:embed="(rId\d+)"/.test(slide), "a plot is a picture with an SVG blip");
const svgRel = slide.match(/name="Scatter"[^]*?<asvg:svgBlip [^>]*r:embed="(rId\d+)"/)![1];
const svgTarget = slideRels.match(new RegExp(`Id="${svgRel}"[^>]*Target="\\.\\./media/([^"]+)"`))?.[1];
const svgPart = svgTarget ? strFromU8(zip[`ppt/media/${svgTarget}`]) : "";
h.ok(svgTarget?.endsWith(".svg") && svgPart.startsWith("<svg") && svgPart.includes("<text") && !svgPart.includes("data:image/png"),
  `the plot's SVG part is vector markup with its text (${svgTarget})`);
h.ok(rasterCalls >= 1 && names.some((n) => n.startsWith("ppt/media/") && n.endsWith(".png")), "a PNG fallback rides along for readers without SVG");
h.ok(/name="Photo"[^]*?<a:srcRect l="25000" t="25000" r="25000" b="25000"\/>/.test(slide), "a cropped image keeps its crop");
h.ok(!slide.includes('name="Hidden"'), "a hidden element is left out");
h.ok(slide.includes('name="Late"'), "the element born at the last step is in (the final state is written)");

// ---- colour parsing ---------------------------------------------------------
h.ok(JSON.stringify(pptxColor("#abc")) === JSON.stringify({ rgb: "AABBCC", alpha: 1 }) && pptxColor("none") === null &&
  pptxColor("rgba(255, 0, 0, 0.5)")?.rgb === "FF0000" && pptxColor("rgba(255, 0, 0, 0.5)")?.alpha === 0.5,
  "colours parse from #rgb, rgba() and none");

await h.done();
