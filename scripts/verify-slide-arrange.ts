#!/usr/bin/env -S npx tsx
// Regression: the multi-select editor ops (W2 parity with the figure editor) —
// duplicate, copy/paste, group/ungroup, z-order, align, distribute. All are pure
// (deck,args)=>result so they're driven headlessly here with no DOM.
//   npx tsx scripts/verify-slide-arrange.ts
import { parseHTML, DOMParser } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const slideOps = await import("../src/lib/slide/ops");

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }
const box = (x: number, y: number, w = 100, h = 40) => ({ x, y, width: w, height: h });

// --- fixture: a slide with three text boxes at known positions -----------------
const deck = slideOps.createDeck({ id: "d", title: "d" });
const sid = slideOps.addSlide(deck, { name: "s", layout: "blank" }).id;
const slide = () => slideOps.slideById(deck, sid)!;
const A = slideOps.addTextBox(deck, sid, { ...box(0, 0), blocks: [slideOps.makeBlock("A")] })!;
const B = slideOps.addTextBox(deck, sid, { ...box(200, 100), blocks: [slideOps.makeBlock("B")] })!;
const C = slideOps.addTextBox(deck, sid, { ...box(400, 300), blocks: [slideOps.makeBlock("C")] })!;
assert(slide().elements.length === 3, "fixture has 3 elements");

// --- duplicate: clones with fresh ids, offset, distinct block ids --------------
const dup = slideOps.duplicateElements(deck, sid, [A]);
assert(dup.length === 1 && dup[0] !== A, "duplicate returns a fresh id");
assert(slide().elements.length === 4, "duplicate appends the clone");
const dupEl = slideOps.findElement(deck, dup[0])!.el as { x: number; y: number; type: string; blocks: { id: string }[] };
const origEl = slideOps.findElement(deck, A)!.el as { x: number; y: number; blocks: { id: string }[] };
assert(dupEl.x === origEl.x + 24 && dupEl.y === origEl.y + 24, "duplicate is offset by (24,24)");
assert(dupEl.type === "textBox" && dupEl.blocks[0].id !== origEl.blocks[0].id, "duplicate re-keys text blocks (no shared block id)");
// clean up the dup so later index-based assertions are on the original three
slideOps.deleteElements(deck, dup);
assert(slide().elements.length === 3, "cleanup: back to 3 elements");

// --- copy/paste parity: pasteElements clones external elements -----------------
const clip = slide().elements.filter((e) => e.id === B).map((e) => structuredClone(e));
const pasted = slideOps.pasteElements(deck, sid, clip);
assert(pasted.length === 1 && slide().elements.length === 4, "paste appends a clone from an external element");
assert(slideOps.findElement(deck, pasted[0])!.el.x === 224, "pasted element is offset");
slideOps.deleteElements(deck, pasted);

// --- group / ungroup -----------------------------------------------------------
const g = slideOps.groupElements(deck, sid, [A, B]);
assert(typeof g === "string", "groupElements returns a group id for >=2");
const gid = (id: string) => slideOps.findElement(deck, id)!.el.groupId;
assert(gid(A) === g && gid(B) === g && gid(C) === undefined, "group shares one groupId across the members only");
assert(slideOps.groupElements(deck, sid, [A]) === null, "group needs >=2 elements (single returns null)");
slideOps.ungroupElements(deck, sid, [A, B]);
assert(gid(A) === undefined && gid(B) === undefined, "ungroup clears the groupId");

// duplicate keeps a group together under a fresh shared id
slideOps.groupElements(deck, sid, [A, B]);
const gdup = slideOps.duplicateElements(deck, sid, [A, B]);
const gd0 = gid(gdup[0]); const gd1 = gid(gdup[1]);
assert(gd0 && gd0 === gd1 && gd0 !== gid(A), "duplicating a group re-keys to ONE fresh shared groupId");
slideOps.deleteElements(deck, gdup);
slideOps.ungroupElements(deck, sid, [A, B]);

// --- z-order (array order = paint order, last = top) ---------------------------
const order = () => slide().elements.map((e) => e.id);
assert(JSON.stringify(order()) === JSON.stringify([A, B, C]), "initial paint order A,B,C");
slideOps.bringToFront(deck, sid, [A]);
assert(order()[order().length - 1] === A, "bringToFront moves A to the top (end)");
slideOps.sendToBack(deck, sid, [A]);
assert(order()[0] === A, "sendToBack moves A to the bottom (start)");
slideOps.raiseElements(deck, sid, [A]); // A,B,C -> B,A,C
assert(JSON.stringify(order()) === JSON.stringify([B, A, C]), "raiseElements moves A up one step");
slideOps.lowerElements(deck, sid, [A]); // B,A,C -> A,B,C
assert(JSON.stringify(order()) === JSON.stringify([A, B, C]), "lowerElements moves A down one step (back to start)");

// --- align (to the selection bbox). Reset the spread before each mode because
//     align collapses the bbox (e.g. after align-left, minX==maxX for equal widths).
const spread = () => {
  slideOps.setElementBox(deck, A, { x: 0, y: 0, width: 100, height: 40 });
  slideOps.setElementBox(deck, B, { x: 200, y: 100, width: 100, height: 40 });
  slideOps.setElementBox(deck, C, { x: 400, y: 300, width: 100, height: 40 });
};
// bbox of A(0,0) B(200,100) C(400,300), all 100x40: x 0..500, y 0..340
spread(); slideOps.alignElements(deck, sid, [A, B, C], "left");
assert([A, B, C].every((id) => slideOps.findElement(deck, id)!.el.x === 0), "align left → all x=minX(0)");
spread(); slideOps.alignElements(deck, sid, [A, B, C], "right");
assert([A, B, C].every((id) => slideOps.findElement(deck, id)!.el.x === 400), "align right → all x=maxX-width(400)");
spread(); slideOps.alignElements(deck, sid, [A, B, C], "top");
assert([A, B, C].every((id) => slideOps.findElement(deck, id)!.el.y === 0), "align top → all y=minY(0)");
spread(); slideOps.alignElements(deck, sid, [A, B, C], "bottom");
assert([A, B, C].every((id) => slideOps.findElement(deck, id)!.el.y === 300), "align bottom → all y=maxY-height(300)");
spread(); slideOps.alignElements(deck, sid, [A, B, C], "hcenter");
const cxExpect = (0 + 500) / 2; // center of the x-span
assert([A, B, C].every((id) => { const e = slideOps.findElement(deck, id)!.el; return e.x + e.width / 2 === cxExpect; }), "align hcenter → equal x-centers");
spread(); slideOps.alignElements(deck, sid, [A, B, C], "vcenter");
const cyExpect = (0 + 340) / 2; // center of the y-span
assert([A, B, C].every((id) => { const e = slideOps.findElement(deck, id)!.el; return e.y + e.height / 2 === cyExpect; }), "align vcenter → equal y-centers");
const beforeSingle = slide().elements.map((e) => ({ x: e.x, y: e.y }));
slideOps.alignElements(deck, sid, [A], "left");
assert(JSON.stringify(slide().elements.map((e) => ({ x: e.x, y: e.y }))) === JSON.stringify(beforeSingle), "align needs >=2 (single is a no-op)");

// --- distribute (even gaps along an axis) --------------------------------------
slideOps.setElementBox(deck, A, { x: 0, y: 0, width: 100, height: 40 });
slideOps.setElementBox(deck, B, { x: 150, y: 0, width: 100, height: 40 });
slideOps.setElementBox(deck, C, { x: 900, y: 0, width: 100, height: 40 });
// span 0..1000 = 1000, total width 300, gap = (1000-300)/2 = 350 → A@0 B@450 C@900
slideOps.distributeElements(deck, sid, [A, B, C], "h");
const xs = [A, B, C].map((id) => slideOps.findElement(deck, id)!.el.x);
assert(xs[0] === 0 && xs[2] === 900, "distribute keeps the extremes fixed");
assert(Math.abs(xs[1] - 450) < 1e-6, "distribute h yields an even gap (B centered at x=450)");
slideOps.setElementBox(deck, C, { x: 100, y: 100 });
assert(slide().elements.length === 3, "distribute needs >=3 — never mutates count");

console.log("\nSLIDE ARRANGE (W2 multi-select ops) REGRESSION PASSED");
