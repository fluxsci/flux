#!/usr/bin/env -S npx tsx
// W7 authoring correctness — REWRITTEN for slides-are-figures (slide_migration,
// owner decision plan §0.3): layout starters scaffold a slide with FIGURE
// `text` elements sized on the shared 96 px/in ruler (A16).
//
// The old A18 half (textBox block-id reconciliation across edits) is
// SUPERSEDED: the textBox element type was deleted with the migration — slide
// text is the figure text element, whose editing semantics are covered by the
// figure text gates (verify-text-wrap, verify-text-parity). Per-line animation
// targeting returns only if rich text does (deferred, plan §8).
// Run: npx tsx scripts/verify-slide-w7.ts
import { parseHTML, DOMParser } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const ops = await import("../src/lib/slide/ops");
function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

// --- A16: layout starters scaffold the slide -----------------------------------
{
  const deck = ops.createDeck({ id: "d2", title: "d2", withTitleSlide: false });
  const titleSlide = ops.addSlide(deck, { layout: "title", starters: true });
  assert(titleSlide.elements.length === 2 && titleSlide.elements.every((e) => e.type === "text"),
    "title layout seeds a title + subtitle as figure TEXT elements (A16)");
  const t0 = titleSlide.elements[0] as { fontSize: number; fontWeight: number; x: number; width: number };
  assert(t0.fontWeight === 700 && t0.fontSize > 20 && t0.fontSize < 60,
    `title starter is bold at a figure-ruler size (640×360 stage) — got ${t0.fontSize}px`);
  assert(t0.x + t0.width <= deck.stage.width, "starter text sits inside the stage frame");

  const cf = ops.addSlide(deck, { layout: "content-figure", starters: true });
  assert(cf.elements.length === 2, "content-figure seeds a title + a bullets text");
  const bullets = cf.elements.find((e) => e.type === "text" && (e as { text: string }).text.includes("\n")) as
    | { text: string }
    | undefined;
  assert(!!bullets && bullets.text.split("\n").length === 3 && bullets.text.split("\n").every((l) => l.startsWith("• ")),
    "content-figure's body seeds 3 bulleted starter lines");

  const two = ops.addSlide(deck, { layout: "two-column", starters: true });
  assert(two.elements.length === 3, "two-column seeds a title + two body columns");

  const section = ops.addSlide(deck, { layout: "section", starters: true });
  assert(section.elements.length === 1 && section.elements[0].type === "text", "section seeds one heading");

  const blank = ops.addSlide(deck, { layout: "blank", starters: true });
  assert(blank.elements.length === 0, "blank stays empty even with starters");
  const fullBleed = ops.addSlide(deck, { layout: "full-bleed", starters: true });
  assert(fullBleed.elements.length === 0, "full-bleed stays empty even with starters");
  const noStarters = ops.addSlide(deck, { layout: "title" }); // no starters flag
  assert(noStarters.elements.length === 0, "programmatic addSlide without starters stays empty (back-compat)");
}

// --- addSlideText is the figure text constructor --------------------------------
{
  const deck = ops.createDeck({ id: "d3", title: "d3", withTitleSlide: false });
  const sid = ops.addSlide(deck, { layout: "blank" }).id;
  const id = ops.addSlideText(deck, sid, { text: "hello", x: 10, y: 12, fontSize: 20 })!;
  const el = ops.findElement(deck, id)!.el;
  assert(el.type === "text" && (el as { text: string }).text === "hello", "addSlideText creates a figure text element");
  assert((el as { sizing: string }).sizing === "auto", "figure text defaults apply (sizing auto — headless-safe, no wrap cache)");
}

console.log("\nSLIDE W7 (A16 layout starters over figure text) PASSED");
