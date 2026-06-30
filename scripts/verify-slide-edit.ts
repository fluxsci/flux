#!/usr/bin/env -S npx tsx
// P1 — the editor's pure ops core (OPS-CORE-FIRST). Every element kind is
// constructed, placed, mutated (box), resized (the SAME resizeRemap the stage
// commits through), and deleted via pure functions — then the deck round-trips
// through flux-core save/load so the new element types persist. Guards the
// findElement-returns-{slide,el} resize bug that the GUI hit in P1.
// Run: npx tsx scripts/verify-slide-edit.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as slideOps from "../src/lib/slide/ops";
import { resizeRemap } from "../src/lib/editing";
import { selectionBBox, elementBBox } from "../src/lib/geometry";
import type { Element as FigElement } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-edit-"));
try {
  await core.scaffold(root, { title: "Slide Edit Test" });

  const deck = slideOps.createDeck({ id: "edit", title: "Editor Ops" });
  const sid = slideOps.addSlide(deck, { name: "Canvas", layout: "blank" }).id;

  // --- the element superset, all via pure constructors -----------------------
  const tb = slideOps.addTextBox(deck, sid, { text: "Title", x: 80, y: 60, width: 800, height: 120, fontSize: 64 })!;
  const math = slideOps.addMath(deck, sid, { tex: "e^{i\\pi}+1=0", x: 80, y: 220, width: 360, height: 100 })!;
  const rect = slideOps.addRect(deck, sid, { x: 100, y: 100, width: 200, height: 100 })!;
  const ell = slideOps.addEllipse(deck, sid, { x: 400, y: 300, width: 180, height: 180 })!;
  const line = slideOps.addLine(deck, sid, { x: 0, y: 0, width: 100, arrowEnd: true })!;
  const fig = slideOps.addEmbedFigure(deck, sid, { figureId: "growth", x: 360, y: 150, width: 600, height: 420, fit: "contain" })!;
  const slide = slideOps.slideById(deck, sid)!;
  assert(slide.elements.length === 6, "six elements added (textBox/math/rect/ellipse/line/embedFigure)");
  assert(
    JSON.stringify(slide.elements.map((e) => e.type)) === JSON.stringify(["textBox", "math", "rect", "ellipse", "line", "embedFigure"]),
    "element types + insertion order correct",
  );
  assert(slideOps.findElement(deck, fig)!.el.type === "embedFigure", "findElement returns the {slide, el} wrapper");

  // --- inline-edit write paths: setTextBoxText (line↔block reconcile) + setMathTex
  const origBlockId = (slideOps.findElement(deck, tb)!.el as { blocks: { id: string }[] }).blocks[0].id;
  slideOps.setTextBoxText(deck, tb, "Alpha\nBeta\nGamma");
  const tbBlocks = (slideOps.findElement(deck, tb)!.el as { blocks: { id: string; text: string }[] }).blocks;
  assert(tbBlocks.length === 3 && tbBlocks.map((b) => b.text).join(",") === "Alpha,Beta,Gamma", "setTextBoxText splits lines into blocks");
  assert(tbBlocks[0].id === origBlockId, "setTextBoxText preserves block 0's id (stable identity across edits)");
  slideOps.setTextBoxText(deck, tb, "Title"); // restore + prove never-empty on the way
  assert((slideOps.findElement(deck, tb)!.el as { blocks: unknown[] }).blocks.length === 1, "setTextBoxText reconciles back down to 1 block");
  slideOps.setMathTex(deck, math, "x^2 + y^2 = r^2");
  assert((slideOps.findElement(deck, math)!.el as { tex: string }).tex === "x^2 + y^2 = r^2", "setMathTex updates the TeX source");

  // --- setElementBox (the drag-commit path) ----------------------------------
  slideOps.setElementBox(deck, rect, { x: 250, y: 175 });
  const r1 = slideOps.findElement(deck, rect)!.el;
  assert(r1.x === 250 && r1.y === 175, "setElementBox moves the element");

  // --- resizeRemap on findElement().el (the resize-commit path; the P1 bug) ---
  const rOrig = structuredClone(r1);
  const ob = { x: r1.x, y: r1.y, w: r1.width, h: r1.height }; // 200×100
  const nb = { x: r1.x, y: r1.y, w: 400, h: 200 }; // 2×
  resizeRemap(r1 as unknown as FigElement, rOrig as unknown as FigElement, ob, nb);
  assert(r1.width === 400 && r1.height === 200, "resizeRemap scales rect 2× (mutates .el, not the wrapper)");

  // line endpoints remap (degenerate-height bbox, like the real stage) ---------
  const lEl = slideOps.findElement(deck, line)!.el as Extract<FigElement, { type: "line" }>;
  const lOrig = structuredClone(lEl);
  const lob = elementBBox(lOrig as unknown as FigElement); // endpoint-derived: w=100,h=0
  resizeRemap(lEl as unknown as FigElement, lOrig as unknown as FigElement, lob, { x: lob.x, y: lob.y, w: 200, h: lob.h });
  assert(Math.round(lEl.x2) === 200, "resizeRemap remaps line endpoint x2 (100→200)");

  // selectionBBox spans a multi-element selection -----------------------------
  const bb = selectionBBox([r1, slideOps.findElement(deck, ell)!.el] as unknown as FigElement[]);
  assert(!!bb && bb.w > 0 && bb.h > 0, "selectionBBox spans a multi-element selection");

  // --- deleteElements (the Delete-key / inspector path) ----------------------
  slideOps.deleteElements(deck, [math, line]);
  assert(slideOps.slideById(deck, sid)!.elements.length === 4, "deleteElements removes two elements");
  assert(!slideOps.findElement(deck, math), "deleted element no longer found");

  // --- persistence: the new element types survive save/load ------------------
  await core.saveDeck(root, deck);
  const reloaded = await core.loadDeck(root, "edit");
  const rslide = reloaded.slides.find((s) => s.id === sid)!;
  const kinds = rslide.elements.map((e) => e.type).sort();
  assert(JSON.stringify(kinds) === JSON.stringify(["ellipse", "embedFigure", "rect", "textBox"]), "shapes + embedFigure persist through save/load");
  const rr = rslide.elements.find((e) => e.type === "rect")!;
  assert(rr.width === 400 && rr.height === 200, "resized geometry persisted");

  // the project (incl. this deck) still validates clean -----------------------
  const dv = await core.validateDeck(root, "edit");
  assert(dv.ok, `edited deck validates clean (${dv.checked} checked)`);

  // --- 1.3 per-part visibility (mask / show / animate) -----------------------
  const vsid = slideOps.addSlide(deck, { name: "Viz", layout: "blank" }).id;
  const plot = slideOps.addPlotToSlide(deck, vsid, { assetId: "assetX", x: 0, y: 0, width: 400, height: 300 })!;
  const vslide = slideOps.slideById(deck, vsid)!;
  vslide.beats.push({ id: "vb1", label: "axes", tracks: [{ target: plot, part: "axis.x", preset: "drawOn", start: 0, duration: 400 }] });
  vslide.beats.push({ id: "vb2", label: "line", tracks: [{ target: plot, part: "series.line", preset: "drawOn", start: 0, duration: 400 }] });
  const povr = () => (slideOps.findElement(deck, plot)!.el as { overrides?: Record<string, { hidden?: boolean }> }).overrides;
  const hasTrack = (part: string) => slideOps.slideById(deck, vsid)!.beats.some((b) => b.tracks.some((t) => t.part === part));

  slideOps.setPartVisibility(deck, plot, "axis.x", "mask");
  assert(povr()?.["axis.x"]?.hidden === true, "1.3 mask: overrides[axis.x].hidden = true");
  assert(!hasTrack("axis.x"), "1.3 mask: the part's tracks are removed");

  slideOps.setPartVisibility(deck, plot, "series.line", "show");
  assert(!povr()?.["series.line"], "1.3 show: no hidden override for the part");
  assert(!hasTrack("series.line"), "1.3 show: the part's tracks are removed (visible from start)");

  slideOps.setPartVisibility(deck, plot, "axis.x", "animate");
  assert(!povr()?.["axis.x"], "1.3 animate: clears the prior mask (hidden override removed)");

  console.log("\nALL SLIDE-EDIT (P1) TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
