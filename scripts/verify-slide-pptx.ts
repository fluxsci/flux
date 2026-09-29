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
//   • an uncropped plot's picture grows to its painted extent, so an axis
//     label outside the plot frame is not cut (a crop still clips);
//   • a raster image keeps its crop; hidden (own flag or a group eye) and not-yet-born elements are out;
//   • the "final" export writes the build's last step;
//   • the "animated" export (pptxBuilds.ts, 2026-09-27 owner request: builds
//     and transitions carried, "maybe with the morph") writes the resting
//     state plus a page per click, entered by Morph (p159, fallback fade) with
//     the effect's duration, objects named "!!…" so Morph pairs them; a later,
//     disjoint effect in the same click is an auto-advancing page after the
//     gap; an automatic step advances after its delay; a with-previous chain
//     is one click; rise / pop entrances and pop exits get an invisible twin
//     at the start / end pose; the camera is a Morph of the whole view; the
//     slide transition (fade / slide -> Cover / push) enters each slide; media
//     shown on several pages is stored once.
// Morph playback itself (tweened position, size, colour, transparency, the
// camera, the auto-advance timing, picture cross-fades) was checked in
// PowerPoint by rendering a probe deck to video.
// Native checks (PowerPoint opens it without repair, shape kinds, render) were
// run against the owner's deck through PowerPoint's COM interface.
//   Run: node --import tsx scripts/verify-slide-pptx.ts
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser as XmlParser } from "@xmldom/xmldom";
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import { deckPptxBytes, pptxColor, transitionXml } from "../src/lib/slide/export/deckPptx";
import { pptxPages } from "../src/lib/slide/export/pptxBuilds";
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
    { ...base, id: "eyed", type: "rect", name: "Eyed", x: 0, y: 20, width: 10, height: 10, fill: "#000000", stroke: "none", strokeWidth: 0, cornerRadius: 0, groupId: "g-eye" },
    { ...base, id: "late", type: "rect", name: "Late", x: 500, y: 20, width: 40, height: 40, fill: "#24837B", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
  ],
  // A group whose Layers eye is closed: its member is visible by its own flag.
  groups: { "g-eye": { id: "g-eye", name: "Eyed group", hidden: true } },
}] as typeof deck.slides;
deck.background = "#FFFCF0";
const payload = { deck, plots: { "plot-asset": { svg: PLOT_SVG, manifest: PLOT_MANIFEST } }, assets: { "png-asset": PNG }, assetSizes: { "png-asset": { width: 40, height: 20 } } };

const result = await deckPptxBytes(deck.title, [{ payload }], rasterize, undefined, "final");
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
h.ok(!slide.includes('name="Eyed"'), "a member of a group hidden by its Layers eye is left out, as in the PDF and HTML");
h.ok(slide.includes('name="Late"'), "the element born at the last step is in (the final state is written)");

// ---- a plot's ink past its frame (2026-09-27, owner report: an axis label that
// sits outside the plot frame was cut in the .pptx only) ----------------------
// The measurer stands in for layout: the 200x150 plot paints from x -30 (a y
// label left of the frame) down to y 175 (an x label below it).
const measured: string[] = [];
// "Inside" (ids prefixed inside__) paints exactly its frame.
const measure = async (svg: string) => { measured.push(svg); return svg.includes('"inside__') ? { x: 0, y: 0, width: 200, height: 150 } : { x: -30, y: -5, width: 250, height: 180 }; };
const inkDeck = createDeck({ id: "ink-deck", title: "Ink", withTitleSlide: false });
inkDeck.stage = { width: 640, height: 360 };
const plotAt = (id: string, name: string, extra: object) => ({ ...base, id, type: "plot", name, x: 400, y: 180, width: 200, height: 150, assetId: "plot-asset", overrides: {}, ...extra });
inkDeck.slides = [{ id: "s1", name: "One", beats: [{ id: "b0", tracks: [] }], groups: {},
  elements: [plotAt("free", "Free", {}), plotAt("cropped", "Cropped", { crop: { x: 10, y: 10, width: 100, height: 80 } }), plotAt("turned", "Turned", { rotation: 30 }), plotAt("inside", "Inside", {})] }] as typeof inkDeck.slides;
const inkZip = unzipSync((await deckPptxBytes(inkDeck.title, [{ payload: { ...payload, deck: inkDeck } }], rasterize, measure, "final")).bytes);
const inkSlide = strFromU8(inkZip["ppt/slides/slide1.xml"]);
const inkRels = strFromU8(inkZip["ppt/slides/_rels/slide1.xml.rels"]);
const E = 12192000 / 640; // EMU per stage px
const frameOf = (name: string) => inkSlide.match(new RegExp(`name="${name}"[^]*?<a:off x="(-?\\d+)" y="(-?\\d+)"/><a:ext cx="(\\d+)" cy="(\\d+)"/>`))?.slice(1).map(Number);
const svgOf = (name: string) => {
  const rel = inkSlide.match(new RegExp(`name="${name}"[^]*?<asvg:svgBlip [^>]*r:embed="(rId\\d+)"`))?.[1];
  const target = inkRels.match(new RegExp(`Id="${rel}"[^>]*Target="\\.\\./media/([^"]+)"`))?.[1];
  return target ? strFromU8(inkZip[`ppt/media/${target}`]) : "";
};
const px = (v: number) => Math.round(v * E);
// Ink -30..220 x -5..175, padded 2: the picture spans -32..222 x -7..177.
h.ok(JSON.stringify(frameOf("Free")) === JSON.stringify([px(368), px(173), px(254), px(184)]),
  `an uncropped plot's picture grows to its ink, label included (${frameOf("Free")})`);
const freeSvg = svgOf("Free");
h.ok(freeSvg.includes('viewBox="0 0 254 184"') && freeSvg.includes('transform="translate(32 7)"') && /<svg overflow="visible"/.test(freeSvg),
  "its SVG is shifted into the grown picture and lets the plot overflow its frame, as the canvas does");
h.ok(JSON.stringify(frameOf("Cropped")) === JSON.stringify([px(400), px(180), px(200), px(150)]) && !svgOf("Cropped").includes('overflow="visible"'),
  "a cropped plot still clips to its frame");
// Rotated: grown evenly (32 each side across, 27 each side down) so the
// picture turns about the plot's own centre.
h.ok(JSON.stringify(frameOf("Turned")) === JSON.stringify([px(368), px(153), px(264), px(204)]) && inkSlide.includes('rot="1800000"'),
  `a rotated plot grows symmetrically about its centre (${frameOf("Turned")})`);
h.ok(JSON.stringify(frameOf("Inside")) === JSON.stringify([px(400), px(180), px(200), px(150)]) && svgOf("Inside").includes('viewBox="0 0 200 150"'),
  `a plot whose ink stays inside keeps its frame exactly, no padding (${frameOf("Inside")})`);
h.ok(measured.length === 3, `only the uncropped plots are measured (${measured.length})`);

// ---- animated: builds as Morph pages ------------------------------------------
{
  const anim = unzipSync((await deckPptxBytes(deck.title, [{ payload }], rasterize)).bytes);
  const pageNames = Object.keys(anim).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const [p1, p2] = pageNames.map((n) => strFromU8(anim[n]));
  h.ok(pageNames.length === 2, `the default export is animated: the resting state plus one page for the click (${pageNames.length})`);
  h.ok(!p1.includes('name="!!Late"') && p2.includes('name="!!Late"'), "the element born on the click is absent before it and present after");
  h.ok(/name="!!Title text"/.test(p1) && /name="!!Scatter"/.test(p2), "objects on a Morph chain carry the same !!name on every page");
  h.ok(/<mc:Choice [^>]*Requires="p159"><p:transition [^>]*p14:dur="200"[^>]*><p159:morph [^>]*option="byObject"\/><\/p:transition><\/mc:Choice><mc:Fallback><p:transition spd="fast"><p:fade\/><\/p:transition><\/mc:Fallback>/.test(p2),
    "the click's page is entered by Morph over the effect's 200 ms, with a fade for readers without Morph");
  const svgs = Object.keys(anim).filter((n) => n.startsWith("ppt/media/") && n.endsWith(".svg"));
  h.ok(svgs.length === 1, `the plot shown on both pages is stored once (${svgs.length} SVG parts)`);
  const bad2: string[] = [];
  for (const name of Object.keys(anim).filter((n) => /\.(xml|rels)$/.test(n))) {
    const errors: string[] = [];
    new XmlParser({ errorHandler: { error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m) } }).parseFromString(strFromU8(anim[name]), "application/xml");
    if (errors.length) bad2.push(`${name}: ${errors[0]}`);
  }
  h.ok(bad2.length === 0, `every part of the animated package is well-formed (${bad2.slice(0, 2).join(" | ")})`);
}
{
  // The planner on a slide with every build kind the export translates.
  const d = createDeck({ id: "builds", title: "Builds", withTitleSlide: false });
  d.stage = { width: 640, height: 360 };
  const box = (id: string, x: number, y: number) => ({ ...base, id, type: "rect", name: id, x, y, width: 100, height: 60, fill: "#205EA6", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  const tr = (target: string, preset: string, extra = {}) => ({ id: `${target}-${preset}`, target, preset, duration: 1000, easing: "linear", ...extra });
  d.slides = [{ id: "s", name: "Builds", transition: "slide", groups: {},
    elements: [box("rise", 0, 100), box("pop", 200, 100), box("mover", 0, 200), box("changer", 200, 200), box("leaver", 400, 0), box("with", 400, 200)],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [tr("rise", "fadeRise", { params: { y: 40 } }), tr("pop", "popIn", { params: { from: 0.5 } })] },
      { id: "b2", tracks: [tr("mover", "move", { to: { x: 200, y: 0 } }), tr("changer", "transform", { start: 1500, duration: 500, to: { state: { width: 180 } } })] },
      { id: "b3", advance: "auto", autoDelayMs: 800, tracks: [tr("leaver", "popOut", { params: { to: 0.5 } })] },
      { id: "b4", tracks: [tr("@camera", "camera", { duration: 1500, to: { x: 320, y: 180, zoom: 2 } })] },
      { id: "b5", advance: "with-prev", tracks: [tr("with", "fadeOut", { duration: 400 })] },
    ] }] as typeof d.slides;
  const pages = pptxPages({ deck: d, plots: {}, assets: {}, assetSizes: {} } as never, "animated");
  const el = (i: number, id: string) => pages[i].ev.elements.find((e) => e.id === id)!;
  h.ok(pages.length === 6, `resting + click 1 + two phases of click 2 + the automatic step + the camera click with its chained beat (${pages.length})`);
  h.ok(pages[0].enter.kind === "cover" && pages[0].enter.ms === 320, "the slide is entered by its transition (slide -> Cover, the player's 320 ms)");
  h.ok(pages[1].enter.kind === "morph" && pages[1].enter.ms === 1000 && pages[0].advanceAfterMs === undefined, "click 1 is a 1 s Morph, reached by a click");
  const twinRise = el(0, "rise"), twinPop = el(0, "pop");
  h.ok(!twinRise.hidden && twinRise.opacity === 0 && twinRise.y === 140 && el(1, "rise").y === 100 && (el(1, "rise").opacity ?? 1) === 1,
    "a rising entrance starts as an invisible twin 40 px lower on the page before");
  h.ok(!twinPop.hidden && twinPop.opacity === 0 && twinPop.width === 50 && twinPop.x === 225, "a popping entrance starts as an invisible twin at half size, centred");
  h.ok(el(2, "mover").x === 200 && el(2, "changer").width === 100 && el(3, "changer").width === 180,
    "click 2's move lands on its first page; the later, disjoint change waits for the second");
  h.ok(pages[2].enter.ms === 1000 && pages[2].advanceAfterMs === 500 && pages[3].enter.ms === 500,
    "the second phase follows by itself after the 500 ms gap, as a 500 ms Morph");
  h.ok(pages[3].advanceAfterMs === 800 && pages[4].enter.kind === "morph", "the automatic step advances 800 ms after the previous one ends");
  const leaver = el(4, "leaver");
  h.ok(!leaver.hidden && leaver.opacity === 0 && leaver.width === 50, "a popping exit ends as an invisible half-size twin");
  h.ok(pages[5].ev.camera?.zoom === 2 && pages[5].enter.ms === 1500 && el(5, "with").hidden === true,
    "the camera click and its with-previous fade-out land on one page, a Morph over the longest effect");
  h.ok(pages.every((p) => p.names.get("mover") === "!!mover"), "every page names objects alike for Morph");
  const finalOnly = pptxPages({ deck: d, plots: {}, assets: {}, assetSizes: {} } as never, "final");
  h.ok(finalOnly.length === 1 && finalOnly[0].ev.camera?.zoom === 2 && finalOnly[0].names.get("mover") === "mover", "the final export is one page at the last state, plain names");
  h.ok(transitionXml({ kind: "none", ms: 0 }, 800) === '<p:transition advTm="800"/>' && transitionXml({ kind: "none", ms: 0 }) === "",
    "a page without an entrance effect can still advance by itself");
}

// Hand-off visibility goes through the exported build planner, including an
// earlier disjoint phase in the SAME step (destinations are phase owners too).
{
  const manifest = JSON.parse(readFileSync("scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.fluxplot.json", "utf8"));
  const svg = readFileSync("scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.svg", "utf8");
  const d = createDeck({ id: "handoff", withTitleSlide: false });
  const source = { ...base, id: "source", name: "Flight source", type: "rect" as const, fill: "#205EA6", stroke: "none", strokeWidth: 0, cornerRadius: 0 };
  const plot = { ...base, id: "plot", name: "Destination", type: "plot" as const, assetId: "boxplot" };
  d.slides = [{ id: "s", elements: [source, plot, { ...source, id: "earlier" }], beats: [
    { id: "b0", tracks: [] }, { id: "b1", tracks: [
      { id: "first", target: "earlier", preset: "fade", duration: 100 },
      { id: "flight", target: "source", preset: "transform", start: 200, duration: 600, to: { state: {}, become: { ref: { element: "plot", parts: ["axis.x.spine", "axis.y.spine"] }, mode: "handoff" } } },
    ] }, { id: "b2", tracks: [] },
  ] }];
  const payload = { deck: d, plots: { boxplot: { svg, manifest } }, assets: {}, assetSizes: {} };
  const pages = pptxPages(payload);
  const spinesHidden = (i: number) => {
    const markup = pages[i].ev.plotMarkup(pages[i].ev.elements.find(e => e.id === "plot")!)!;
    const root = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    return ["axis.x.spine", "axis.y.spine"].every(id => (root.querySelector(`[id="plot__${id}"]`) as unknown as SVGElement).style.visibility === "hidden");
  };
  h.ok(pages.length === 4 && spinesHidden(0) && spinesHidden(1) && !spinesHidden(2) && !spinesHidden(3), "PPTX shows destination leaves only from the landing phase, never the earlier phase of the same step");
  h.ok(!pages[0].ev.elements.find(e => e.id === "source")!.hidden && !pages[1].ev.elements.find(e => e.id === "source")!.hidden && pages[2].ev.elements.find(e => e.id === "source")!.hidden && pages[3].ev.elements.find(e => e.id === "source")!.hidden, "PPTX removes the source from the landing phase onward");
  const whole = structuredClone(d); whole.slides[0].beats[1].tracks[1].to!.become!.ref = { element: "plot" };
  const wholePages = pptxPages({ ...payload, deck: whole });
  h.ok(wholePages[0].ev.elements.find(e => e.id === "plot")!.hidden && wholePages[1].ev.elements.find(e => e.id === "plot")!.hidden && !wholePages[2].ev.elements.find(e => e.id === "plot")!.hidden, "whole-element hand-offs share the same PPTX phase visibility");
}

// ---- colour parsing ---------------------------------------------------------
h.ok(JSON.stringify(pptxColor("#abc")) === JSON.stringify({ rgb: "AABBCC", alpha: 1 }) && pptxColor("none") === null &&
  pptxColor("rgba(255, 0, 0, 0.5)")?.rgb === "FF0000" && pptxColor("rgba(255, 0, 0, 0.5)")?.alpha === 0.5,
  "colours parse from #rgb, rgba() and none");

await h.done();
