// Pure gate for text ↔ shape letter outlines (oct2 W3 §3.2): the font resolver
// (text/fontFiles.mjs — fontconfig, the scan index, collections, bundled faces),
// opentype parsing (text/glyphFont.ts), placement and counters
// (text/glyphOutlines.ts), the glyph-box fallback, the area slicing a filled
// shape uses to split into letters (correspondence.ts), the fonts:lookup IPC
// handler, and the export bake — both engines' bytes pinned identical.
// Uses this machine's msttcorefonts Arial/Georgia (the box the gate runs on).
import * as fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harness } from "./lib/harness.mjs";
import { parseFamilyStack, fontRequestKey } from "../src/lib/text/fontRequest.mjs";
import { resolveFontFile, lookupFont, fontIndex, readFontFaces, extractFace, fontFormat, pickFace, BUNDLED_FAMILIES } from "../src/lib/text/fontFiles.mjs";
import { parseGlyphFont, bakeGlyphs } from "../src/lib/text/glyphFont";
import { textGlyphOutlines, textGlyphNeeds, keyholeRings, bakedSource, glyphBoxNodes, type MeasuredGlyph } from "../src/lib/text/glyphOutlines";
import { sliceIntoLetters, planCorrespondence } from "../src/lib/slide/correspondence";
import { parameterize, pointAt } from "../src/lib/slide/outline";
import { pathToSubpaths } from "../src/lib/path";
import { elementStageOutlines } from "../src/lib/slide/targetGeometry";
import { glyphTextTracks } from "../src/lib/slide/glyphTexts";
import { compileSlide } from "../src/lib/slide/compile";
import { gatherPayload } from "../src/lib/slide/payload";
import * as slideOps from "../src/lib/slide/ops";
import type { TextElement, VectorNode } from "../src/lib/types";
import type { StageOutline } from "../src/lib/slide/stageOutline";

const h = harness("verify-glyph-outlines");
const FONTS = "/usr/share/fonts/truetype/msttcorefonts";
const ARIAL = path.join(FONTS, "Arial.ttf"), GEORGIA = path.join(FONTS, "Georgia.ttf");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-glyphs-"));
const text = (value: string, extra: Partial<TextElement> = {}): TextElement => ({ id: "t", type: "text", x: 100, y: 50, width: 300, height: 60, rotation: 0, text: value, fontFamily: "Arial", fontSize: 100, fontWeight: 400, fontStyle: "normal", align: "left", color: "#1f3a93", sizing: "auto", ...extra });
/** Winding number at p of a ring, sampled along its true curves. */
const winding = (nodes: VectorNode[], p: { x: number; y: number }) => {
  const param = parameterize(nodes, true), pts = Array.from({ length: 800 }, (_, i) => pointAt(param, i / 800));
  let w = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a.y <= p.y) { if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++; }
    else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
  }
  return w;
};
try {
  h.ok(existsSync(ARIAL) && existsSync(GEORGIA), "this machine has Arial and Georgia (msttcorefonts)");

  // --- request identity ----------------------------------------------------------
  h.eq(JSON.stringify(parseFamilyStack('Georgia, "Gelasio", \'Times New Roman\', serif')), JSON.stringify(["Georgia", "Gelasio", "Times New Roman", "serif"]), "family stacks parse with quotes removed");
  h.eq(fontRequestKey({ family: ' Georgia,"Gelasio" ', weight: 650, style: "oblique" }), "Georgia, Gelasio|700|italic", "request keys normalize stack, weight grid and style");

  // --- resolution ------------------------------------------------------------------------
  h.eq((await resolveFontFile({ family: "Arial" }))?.file, ARIAL, "fontconfig resolves Arial to its file");
  h.eq((await resolveFontFile({ family: 'Georgia, "Gelasio", serif', weight: 700 }))?.file, path.join(FONTS, "Georgia_Bold.ttf"), "a stack takes its first installed family, at the requested weight");
  h.eq((await resolveFontFile({ family: "Arial", style: "italic" }))?.file, path.join(FONTS, "Arial_Italic.ttf"), "italic resolves to the italic face");
  const bundled = await resolveFontFile({ family: "Gelasio, serif" });
  h.ok(bundled?.bundled === "woff2" && !bundled.file && BUNDLED_FAMILIES.gelasio === "woff2", "a family the app serves itself (Gelasio) stops resolution — the browser would paint it, not the system serif");
  h.ok(!(await lookupFont({ family: "Gelasio" })).bytes, "…and yields no bytes (variable WOFF2 → glyph boxes)");
  const generic = await resolveFontFile({ family: "NoSuchFamily123, sans-serif" });
  h.ok(!!generic?.file, "an unknown family falls through to the generic family's system face");
  const cacheFile = path.join(tmp, "config", "fonts-index.json");
  const t0 = performance.now();
  const scanned = await resolveFontFile({ family: "Georgia", weight: 700 }, { dirs: [FONTS], cacheFile });
  const scanMs = performance.now() - t0;
  h.eq(scanned?.file, path.join(FONTS, "Georgia_Bold.ttf"), `the macOS/Windows scan path (name/OS-2 tables only) resolves the same face (${scanMs.toFixed(0)} ms cold)`);
  const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  h.ok(Object.keys(cached).length >= 10 && Object.values(cached).every((v: any) => typeof v.stamp === "string"), "the face index is cached as JSON keyed by path (mtime + size stamps)");
  const before = (await fs.stat(cacheFile)).mtimeMs;
  await fontIndex({ dirs: [FONTS], cacheFile });
  h.eq((await fs.stat(cacheFile)).mtimeMs, before, "an unchanged font folder reuses the cache without rewriting it");
  h.ok(!pickFace(cached, "Gelasio", 400, false), "the scan never invents a face");

  // --- sfnt reading, collections, WOFF2 ------------------------------------------------------
  const arialBytes = new Uint8Array(readFileSync(ARIAL)), georgiaBytes = new Uint8Array(readFileSync(GEORGIA));
  const faces = readFontFaces(arialBytes);
  h.ok(faces.length === 1 && faces[0].family === "Arial" && faces[0].weight === 400 && !faces[0].italic, "name/OS-2 reading: Arial, 400, upright");
  // A synthetic collection of two faces (absolute table offsets, as in a .ttc).
  const ttc = (() => {
    const parts = [arialBytes, georgiaBytes], header = 12 + 4 * parts.length;
    const out = new Uint8Array(header + parts.reduce((s, p) => s + p.length, 0));
    const w32 = (o: number, v: number) => { out[o] = v >>> 24; out[o + 1] = (v >>> 16) & 255; out[o + 2] = (v >>> 8) & 255; out[o + 3] = v & 255; };
    out.set([0x74, 0x74, 0x63, 0x66], 0); w32(4, 0x00010000); w32(8, parts.length);
    let at = header;
    parts.forEach((p, i) => {
      w32(12 + 4 * i, at); out.set(p, at);
      const n = (p[4] << 8) | p[5];
      for (let k = 0; k < n; k++) { const r = at + 12 + 16 * k + 8; const off = ((out[r] << 24) >>> 0) + (out[r + 1] << 16) + (out[r + 2] << 8) + out[r + 3]; w32(r, off + at); }
      at += p.length;
    });
    return out;
  })();
  h.eq(fontFormat(ttc), "ttc", "a collection is recognized");
  h.eq(readFontFaces(ttc).map((f) => f.family).join(","), "Arial,Georgia", "every face of a collection is indexed");
  const face1 = extractFace(ttc, 1)!;
  const fromTtc = parseGlyphFont(face1), georgia = parseGlyphFont(georgiaBytes)!;
  h.ok(!!fromTtc && fromTtc.glyph("g")!.d === georgia.glyph("g")!.d, "a collection face extracts into a standalone sfnt that parses to the same glyphs");
  const woff2 = path.resolve("src/styles/fonts/Gelasio.woff2");
  h.ok(fontFormat(new Uint8Array(readFileSync(woff2))) === "woff2" && parseGlyphFont(new Uint8Array(readFileSync(woff2))) === null, "WOFF2 is refused (→ glyph boxes)");

  // --- glyphs, counters, scaling -------------------------------------------------------
  const arial = parseGlyphFont(arialBytes)!;
  h.ok(arial.unitsPerEm === 2048, "Arial parses (2048 units per em)");
  h.ok(arial.glyph("o") === arial.glyph("o"), "glyph records are cached per character");
  h.eq(arial.glyph("\u{E000}"), null, "a character the font lacks is null (.notdef never draws)");
  const rings = (ch: string) => keyholeRings(pathToSubpaths(arial.glyph(ch)!.d).map((p) => p.nodes));
  h.eq(pathToSubpaths(arial.glyph("o")!.d).length, 2, "'o' has two contours (outline + counter)");
  h.eq(rings("o").length, 1, "…keyholed into ONE ring");
  h.eq(rings("B").length, 1, "'B' (outline + two counters) is one ring");
  h.eq(rings("i").length, 2, "'i' stays two parts (stem and dot)");
  h.eq(rings("%").length, 3, "'%' is three parts");
  const chars: MeasuredGlyph[] = [{ x: 100, y: 150, box: { x: 100, y: 59, w: 72, h: 115 } }];
  const o = textGlyphOutlines(text("o"), chars, () => arial);
  const ob = o.outlines[0].bbox;
  h.ok(o.outlines.length === 1 && !o.boxes && o.outlines[0].paint.fill === "#1f3a93" && o.outlines[0].owner.role === "glyph", "a measured 'o' becomes one filled glyph ring in the text colour");
  h.ok(winding(o.outlines[0].nodes, { x: ob.x + ob.w / 2, y: ob.y + ob.h / 2 }) === 0 && winding(o.outlines[0].nodes, { x: ob.x + ob.w * 0.06, y: ob.y + ob.h / 2 }) !== 0,
    "…its counter is EMPTY under nonzero fill and its stroke is filled (the keyhole is wound right)");
  const B = textGlyphOutlines(text("B"), chars, () => arial).outlines[0];
  h.ok(winding(B.nodes, { x: B.bbox.x + B.bbox.w * 0.45, y: B.bbox.y + B.bbox.h * 0.27 }) === 0 && winding(B.nodes, { x: B.bbox.x + B.bbox.w * 0.45, y: B.bbox.y + B.bbox.h * 0.75 }) === 0, "…both counters of 'B' are empty");
  const H = textGlyphOutlines(text("H"), chars, () => arial).outlines[0];
  h.ok(Math.abs(H.bbox.h - 1466 / 2048 * 100) < 0.6 && Math.abs(H.bbox.y + H.bbox.h - 150) < 0.6, `em scaling: 'H' at 100 px is cap-height ${(1466 / 2048 * 100).toFixed(1)} px tall and sits on the measured baseline (${H.bbox.h.toFixed(2)})`);

  // --- fallback boxes ---------------------------------------------------------------------
  const word = text("Mi o");
  const measured: (MeasuredGlyph | null)[] = [{ x: 0, y: 90, box: { x: 0, y: 0, w: 80, h: 115 } }, { x: 80, y: 90, box: { x: 80, y: 0, w: 22, h: 115 } }, null, { x: 130, y: 90, box: { x: 130, y: 0, w: 56, h: 115 } }];
  const boxes = textGlyphOutlines(word, measured, () => null);
  h.ok(boxes.boxes && boxes.outlines.length === 3 && boxes.outlines.every((x) => x.owner.role === "glyph-box"), "no font: one rounded box per drawn letter (spaces draw nothing)");
  h.ok(boxes.outlines.map((x) => x.owner.index).join() === "0,1,2", "…in reading order");
  const bn = glyphBoxNodes({ x: 0, y: 0, w: 80, h: 100 });
  h.ok(bn.length === 8 && Math.abs(bn[0].x - (80 * 0.08 + 72 * 0.25)) < 1e-9, "boxes are rounded rects with a radius of 25 % of their height");
  const mixed = textGlyphOutlines(word, measured, (s) => s.weight === 400 ? arial : null);
  h.ok(!mixed.boxes && mixed.outlines.every((x) => x.owner.role === "glyph"), "with the font, the same word flies real outlines");

  // --- runs + bake needs ----------------------------------------------------------------
  const runs = text("bold plain", { runs: [{ from: 0, to: 4, bold: true }] });
  const needs = textGlyphNeeds(runs);
  h.eq(JSON.stringify(needs.map((n) => [n.style.weight, n.chars.join("")])), JSON.stringify([[700, "bdlo"], [400, "ailnp"]]), "per-range bold needs its own font and exactly its characters");
  const baked = bakeGlyphs(arial, ["o", "B", "o"]);
  h.eq(Object.keys(baked.glyphs).join(), "B,o", "a bake carries each character once, sorted");
  h.ok(bakedSource(baked).glyph("o")!.d === arial.glyph("o")!.d && bakedSource(baked).glyph("x") === null, "baked records read back exactly; an unbaked character is null");

  // --- slicing a filled shape into letters ---------------------------------------------------
  const rect = elementStageOutlines({ id: "r", type: "rect", x: 0, y: 0, width: 200, height: 80, rotation: 0, fill: "#d95f0e", stroke: "#222222", strokeWidth: 2, cornerRadius: 6 } as never)[0];
  const letters = textGlyphOutlines(text("Bio"), [{ x: 300, y: 150, box: { x: 300, y: 59, w: 67, h: 115 } }, { x: 367, y: 150, box: { x: 367, y: 59, w: 22, h: 115 } }, { x: 389, y: 150, box: { x: 389, y: 59, w: 56, h: 115 } }], () => arial).outlines;
  const strips = sliceIntoLetters(rect, letters)!;
  const area = (o: StageOutline) => { let a = 0; const n = o.nodes; for (let i = 0, j = n.length - 1; i < n.length; j = i++) a += n[j].x * n[i].y - n[i].x * n[j].y; return Math.abs(a / 2); };
  h.ok(strips.length === letters.length && strips.every((s) => s.closed && s.paint.stroke === "none" && s.paint.fill === "#d95f0e"), "a filled shape splits into one closed, filled (strokeless) strip per letter part");
  h.ok(Math.abs(strips.reduce((s, x) => s + area(x), 0) - area({ ...rect, nodes: pathToSubpaths(`M0 0 H200 V80 H0 Z`)[0].nodes })) < 0.02 * 200 * 80, "…the strips tile the shape's area");
  h.ok(strips.every((s, i) => !i || s.bbox.x >= strips[i - 1].bbox.x - 1e-6), "…left to right in reading order");
  const plan = planCorrespondence([rect], letters);
  h.ok(plan.pairs.length === letters.length && plan.pairs.every((p) => p.a?.owner.role === "slice" && p.b?.owner.role === "glyph" && p.plan?.closed), "the planner pairs each strip with its letter, ring to ring");
  const reverse = planCorrespondence(letters, [rect]);
  h.ok(reverse.pairs.every((p) => p.b?.owner.role === "slice"), "…and letters fuse back into strips of the shape");
  const outline = planCorrespondence([{ ...rect, paint: { ...rect.paint, fill: "none" } }], letters);
  h.ok(outline.pairs.every((p) => p.a?.owner.role !== "slice"), "an unfilled outline still unrolls into the letters (no area to split)");

  // --- which texts fly as letters; the compile diagnostic --------------------------------------
  const deck = slideOps.createDeck({ id: "glyphs", title: "Glyphs", withTitleSlide: false });
  const sid = slideOps.addSlide(deck, { id: "s", layout: "blank" }).id;
  slideOps.addElement(deck, sid, { id: "r", type: "rect", x: 40, y: 40, width: 160, height: 60, rotation: 0, fill: "#d95f0e", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  slideOps.addElement(deck, sid, { ...text("Microscopy", { fontSize: 32 }), id: "t" } as never);
  slideOps.addElement(deck, sid, { ...text("same kind", { fontSize: 20 }), id: "u", y: 200 } as never);
  const b1 = slideOps.addBeat(deck, sid, { id: "b1" })!;
  slideOps.setTransform(deck, sid, b1.id, "r", { state: {}, duration: 1000 });
  b1.tracks[0].to!.become = { mode: "handoff", ref: { element: "t" } };
  slideOps.setTransform(deck, sid, b1.id, "u", { state: { text: "other words" }, duration: 1000 });
  const slide = deck.slides[0];
  h.eq(glyphTextTracks(slide).map((g) => g.text.id).join(), "t", "only the text ↔ shape track needs letters (text ↔ text is the text morph)");
  const issues = (status: "ready" | "missing" | "pending") => compileSlide(slide, deck.stage, { glyphStatus: () => status }).issues.filter((i) => /land as boxes/.test(i.reason));
  h.ok(issues("missing").length === 1 && issues("ready").length === 0 && issues("pending").length === 0, "a missing font is diagnosed as boxes (ready/pending are not)");

  // --- the fonts:lookup IPC handler and the bake parity ------------------------------------------
  const { createFontsFamily, cleanRequest } = await import("../electron/ipc/fonts.cjs");
  const handlers = new Map<string, (...a: unknown[]) => Promise<any>>();
  createFontsFamily({ configDir: () => path.join(tmp, "config") }).registerHandlers({ handle: (c: string, fn: any) => handlers.set(c, fn) });
  h.ok(handlers.has("fonts:lookup"), "the IPC family registers fonts:lookup");
  const ipc = await handlers.get("fonts:lookup")!({}, { family: "Arial", weight: 400 });
  h.ok(ipc.key === "Arial|400|normal" && ipc.format === "ttf" && ipc.bytes?.length === arialBytes.length, "fonts:lookup returns the font file's bytes under its request key");
  let refused = false; try { cleanRequest({ family: "" }); } catch { refused = true; }
  h.ok(refused, "fonts:lookup refuses an empty request");
  const io = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p) };
  const root = path.join(tmp, "project"); await fs.mkdir(root, { recursive: true });
  const node = await gatherPayload(root, deck, { ...io, glyphFont: async (style) => (await lookupFont(style)).bytes });
  const gui = await gatherPayload(root, deck, { ...io, fontLookup: (style) => handlers.get("fonts:lookup")!({}, style) });
  const keys = Object.keys(node.payload.glyphs ?? {});
  h.eq(keys.join(), "Arial|400|normal", "the bake names exactly the fonts the letters paint with");
  h.eq(Object.keys(node.payload.glyphs!["Arial|400|normal"].glyphs).join(""), "Mcioprsy", "…and exactly the characters of the morphing text (not the text ↔ text track's)");
  h.eq(JSON.stringify(gui.payload.glyphs), JSON.stringify(node.payload.glyphs), "the GUI bridge path (fonts:lookup) and the Node path bake identical bytes");
  const none = await gatherPayload(root, deck, io);
  h.ok(!none.payload.glyphs, "a host without a font source bakes nothing (the export lands as boxes)");
  // flux-core's own gather (export-deck, the GUI's HTML export) bakes the same.
  const core = await import("../flux-core/index");
  const slides = await import("../flux-core/slides");
  const proj = path.join(tmp, "core"); await core.scaffold(proj, { title: "Glyph bake" });
  await slides.saveDeck(proj, deck);
  const gathered = await slides.gatherDeckPayload(proj, "glyphs");
  h.eq(JSON.stringify(gathered.payload.glyphs), JSON.stringify(node.payload.glyphs), "flux-core gatherDeckPayload bakes byte-identical glyphs");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
await h.done();
