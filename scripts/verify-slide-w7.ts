#!/usr/bin/env -S npx tsx
// W7 authoring correctness: block-id reconciliation across text edits (A18 — a
// per-block animation target must survive an insert/delete/edit), and layout
// starters actually scaffolding a slide (A16). Pure ops, no DOM.
// Run: npx tsx scripts/verify-slide-w7.ts
import { parseHTML, DOMParser } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const ops = await import("../src/lib/slide/ops");
function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

// --- A18: block identity survives edits ----------------------------------------
{
  const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false });
  const sid = ops.addSlide(deck, { name: "s", layout: "blank" }).id;
  const tb = ops.addTextBox(deck, sid, { x: 0, y: 0, width: 400, height: 200, blocks: [
    ops.makeBlock("Alpha"), ops.makeBlock("Beta"), ops.makeBlock("Gamma")] })!;
  const ids0 = () => (ops.findElement(deck, tb)!.el as { blocks: { id: string; text: string }[] }).blocks;
  const [idA, idB, idC] = ids0().map((b) => b.id);

  // insert a line between Alpha and Beta
  ops.setTextBoxText(deck, tb, "Alpha\nNEW\nBeta\nGamma");
  let b = ids0();
  assert(b[0].id === idA && b[2].id === idB && b[3].id === idC, "insert: unchanged lines keep their block ids (A18)");
  assert(b[1].id !== idA && b[1].id !== idB && b[1].id !== idC, "insert: the NEW line gets a fresh id (no reuse)");

  // reset to 3, then edit the middle line in place
  ops.setTextBoxText(deck, tb, "Alpha\nBeta\nGamma");
  const [ia, ib, ic] = ids0().map((x) => x.id);
  ops.setTextBoxText(deck, tb, "Alpha\nBeta EDITED\nGamma");
  b = ids0();
  assert(b[0].id === ia && b[2].id === ic, "edit: the untouched lines keep their ids");
  assert(b[1].id === ib && b[1].text === "Beta EDITED", "edit-in-place: the edited line KEEPS its id (A18)");

  // delete the middle line
  ops.setTextBoxText(deck, tb, "Alpha\nGamma");
  b = ids0();
  assert(b.length === 2 && b[0].id === ia && b[1].id === ic, "delete: survivors keep their ids, the removed one is dropped");

  // marker/emphasis are preserved for an unchanged line
  ops.setTextBoxText(deck, tb, "Alpha\nGamma");
  (ids0()[0] as { marker?: string }).marker = "number"; // tag Alpha directly
  ops.setTextBoxText(deck, tb, "Zero\nAlpha\nGamma"); // insert above
  const alpha = ids0().find((x) => x.text === "Alpha")!;
  assert((alpha as { marker?: string }).marker === "number", "an unchanged line keeps its marker across an insert above it");
}

// --- A16: layout starters scaffold the slide -----------------------------------
{
  const deck = ops.createDeck({ id: "d2", title: "d2", withTitleSlide: false });
  const titleSlide = ops.addSlide(deck, { layout: "title", starters: true });
  assert(titleSlide.elements.length === 2 && titleSlide.elements.every((e) => e.type === "textBox"),
    "title layout seeds a title + subtitle text box (A16)");
  const cf = ops.addSlide(deck, { layout: "content-figure", starters: true });
  assert(cf.elements.length === 2, "content-figure seeds a title + a bullets box");
  const bullets = cf.elements.find((e) => e.type === "textBox" && (e as { blocks: unknown[] }).blocks.length === 3) as { blocks: { marker?: string }[] } | undefined;
  assert(!!bullets && bullets.blocks.every((b) => b.marker === "bullet"), "content-figure's body has 3 bulleted starter lines");
  const two = ops.addSlide(deck, { layout: "two-column", starters: true });
  assert(two.elements.length === 3, "two-column seeds a title + two body columns");
  const blank = ops.addSlide(deck, { layout: "blank", starters: true });
  assert(blank.elements.length === 0, "blank stays empty even with starters");
  const noStarters = ops.addSlide(deck, { layout: "title" }); // no starters flag
  assert(noStarters.elements.length === 0, "programmatic addSlide without starters stays empty (back-compat)");
}

console.log("\nSLIDE W7 (A18 block-id reconciliation + A16 layout starters) PASSED");
