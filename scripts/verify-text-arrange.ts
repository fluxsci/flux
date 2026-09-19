#!/usr/bin/env -S node --import tsx
// Text ARRANGEMENT inside the box (2026-09-18) — the pure contract of
// `src/lib/text.ts blockLayout` and the SVG it feeds through `export.ts`:
//
//   • paragraph derivation: the flat `lines` wrap cache maps back onto the
//     text's hard lines, so a wrapped paragraph's last line is known WITHOUT
//     storing anything new; a mismatched cache degrades to "no justification",
//     never to a wrong stretch;
//   • vertical alignment: top / middle / bottom drop the block inside the box,
//     and "top" is byte-identical to pre-arrangement Flux;
//   • line height + paragraph spacing compose into the per-line dy and into
//     the hugged box height;
//   • justification emits textLength + lengthAdjust="spacing" on exactly the
//     lines that are not a paragraph's last, and never on a single glyph;
//   • letter spacing is a WRAP METRIC (wrapping measures with it) and rides
//     the `letter-spacing` attribute;
//   • the style patch surface stores each property's DEFAULT as ABSENCE, so a
//     reset leaves the file exactly as it was before the property existed;
//   • named text styles carry the arrangement and detach like color/align.
//
//   Run: node --import tsx scripts/verify-text-arrange.ts

import {
  blockLayout,
  visualLineInfo,
  wrapText,
  applyTextLayout,
  letterSpacing,
  paragraphGap,
  lineH,
} from "../src/lib/text";
import { textSvgLayout, elementToSvg } from "../src/lib/export";
import { createTextElement } from "../src/lib/editing";
import * as ops from "../src/lib/ops";
import type { Project, TextElement } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const text = (extra: Partial<TextElement> = {}): TextElement =>
  ({
    id: "t1",
    type: "text",
    x: 10,
    y: 20,
    width: 100,
    height: 200,
    rotation: 0,
    text: "hello world",
    fontFamily: "Arial",
    fontSize: 10,
    fontWeight: 400,
    fontStyle: "normal",
    align: "left",
    color: "#000000",
    sizing: "fixed",
    ...extra,
  }) as TextElement;

const proj = (els: TextElement[]): Project =>
  ({
    version: 2,
    name: "t",
    canvases: [{ id: "c1", name: "C1" }],
    figures: [{ id: "fig1", canvasId: "c1", name: "Fig 1", x: 0, y: 0, width: 300, height: 300, elements: els }],
    assets: [],
    palette: [],
  }) as unknown as Project;

// --- 1. paragraph derivation -------------------------------------------------
console.log("\n1. paragraph boundaries (derived, never stored)");
{
  // One hard line wrapped in three: only the LAST closes the paragraph.
  const e = text({ text: "aa bb cc", lines: ["aa", "bb", "cc"] });
  assert(eq(visualLineInfo(e).map((l) => l.paragraphEnd), [false, false, true]), "a wrapped paragraph ends once, on its last visual line");

  const two = text({ text: "aa bb\ncc dd", lines: ["aa", "bb", "cc", "dd"] });
  assert(eq(visualLineInfo(two).map((l) => l.paragraphEnd), [false, true, false, true]), "two hard lines → two paragraph ends");

  const blank = text({ text: "a\n\nb", lines: ["a", "", "b"] });
  assert(eq(visualLineInfo(blank).map((l) => l.paragraphEnd), [true, true, true]), "blank hard lines are their own paragraphs");

  // No cache (headless edit / hug sizing): every hard line is a paragraph.
  const bare = text({ text: "a\nb\nc" });
  assert(eq(visualLineInfo(bare).map((l) => l.paragraphEnd), [true, true, true]), "without a wrap cache every line ends a paragraph");

  // Break-point whitespace hangs (wrapLine trims it) — the ink still matches.
  const hung = text({ text: "hello   world", lines: ["hello", "world"] });
  assert(eq(visualLineInfo(hung).map((l) => l.paragraphEnd), [false, true]), "whitespace dropped at a break does not break the mapping");

  // A SINGLE-paragraph text needs no ink matching at all (the hot path): with
  // one hard line, only the last visual line can close the paragraph — that is
  // true of every valid wrap, so a stale cache cannot make it wrong.
  const onePara = text({ text: "completely different", lines: ["xx", "yy", "zz"] });
  assert(eq(visualLineInfo(onePara).map((l) => l.paragraphEnd), [false, false, true]), "one hard line: only the last visual line closes it, whatever the cache holds");

  // Where a mis-assignment WOULD be possible — several paragraphs — a cache
  // that cannot belong to this text degrades to "nothing justifies".
  const stale = text({ text: "aa bb\ncc dd", lines: ["xx", "yy", "zz"] });
  assert(visualLineInfo(stale).every((l) => l.paragraphEnd), "a mismatched multi-paragraph cache degrades to no justification");
  const short = text({ text: "aa bb\ncc dd", lines: ["aa", "bb"] });
  assert(visualLineInfo(short).every((l) => l.paragraphEnd), "a cache with too FEW lines degrades too");
  const long = text({ text: "aa\nbb", lines: ["aa", "bb", "leftover"] });
  assert(visualLineInfo(long).every((l) => l.paragraphEnd), "a cache with leftover lines degrades too");

  // Property: the mapping survives real wrapping at many widths.
  const m10 = (s: string) => s.length * 10;
  const body = "the quick brown fox\njumps over\nthe very lazy dog indeed";
  for (const w of [40, 70, 110, 500]) {
    const lines = wrapText(body, w, m10);
    const info = visualLineInfo(text({ text: body, lines }));
    const ends = info.filter((l) => l.paragraphEnd).length;
    assert(ends === 3, `wrapped at ${w}px: exactly 3 paragraph ends (got ${ends})`);
    assert(info[info.length - 1].paragraphEnd, `wrapped at ${w}px: the final line always ends a paragraph`);
  }
}

// --- 2. vertical alignment ---------------------------------------------------
console.log("\n2. vertical alignment");
{
  // fontSize 10, lineHeight 1.2 → 12px per line; 2 lines = 24px in a 200px box.
  const base = { text: "a\nb", height: 200 };
  const top = blockLayout(text(base));
  assert(top.height === 24 && top.offsetY === 0, "top: block 24px, no drop");
  assert(top.baselineY === 20 + 10, "top: first baseline is y + fontSize (unchanged from before the feature)");
  const mid = blockLayout(text({ ...base, valign: "middle" }));
  assert(mid.offsetY === (200 - 24) / 2 && mid.baselineY === 20 + 88 + 10, "middle: block centred in the box");
  const bot = blockLayout(text({ ...base, valign: "bottom" }));
  assert(bot.offsetY === 200 - 24 && bot.baselineY === 20 + 176 + 10, "bottom: block sits on the box floor");
  // Overflow is centred symmetrically, exactly like CSS centring (never clamped).
  const over = blockLayout(text({ text: "a\nb\nc\nd", height: 10, valign: "middle" }));
  assert(over.offsetY < 0, "a block taller than the box overflows both ways when centred");
}

// --- 3. line height + paragraph spacing --------------------------------------
console.log("\n3. interline and paragraph spacing");
{
  const e = text({ text: "a\nb", lineHeight: 2, paragraphSpacing: 6 });
  assert(lineH(e) === 20 && paragraphGap(e) === 6, "lineH = fontSize × lineHeight; paragraphGap reads the property");
  const L = blockLayout(e);
  assert(eq(L.lines.map((l) => l.dy), [0, 26]), "dy = line advance + the paragraph gap after a paragraph end");
  assert(L.height === 2 * 20 + 6, "block height counts one gap per paragraph BREAK");

  // Inside ONE wrapped paragraph there is no gap.
  const wrapped = blockLayout(text({ text: "aa bb", lines: ["aa", "bb"], paragraphSpacing: 6 }));
  assert(eq(wrapped.lines.map((l) => l.dy), [0, 12]), "no gap between the lines of one paragraph");
  assert(wrapped.height === 24, "one paragraph has no gaps in its height");

  // Absent paragraph spacing changes nothing.
  const plain = blockLayout(text({ text: "a\nb" }));
  assert(eq(plain.lines.map((l) => l.dy), [0, 12]) && plain.height === 24, "no paragraph spacing = the historical block");
}

// --- 4. justification --------------------------------------------------------
console.log("\n4. justification");
{
  const e = text({ align: "justify", text: "aa bb cc dd", lines: ["aa bb", "cc dd"], width: 100 });
  const L = blockLayout(e);
  assert(L.lines[0].justifyWidth === 100, "a non-final line is stretched to the box width");
  assert(L.lines[1].justifyWidth === undefined, "the paragraph's LAST line keeps its natural width");
  assert(L.anchor === "start" && L.x === 10, "justified text anchors at the box's left edge");

  const single = blockLayout(text({ align: "justify", text: "x\ny", lines: ["x", "y"] }));
  assert(single.lines.every((l) => l.justifyWidth === undefined), "a single-glyph line is never stretched");

  const notJustified = blockLayout(text({ align: "left", text: "aa bb", lines: ["aa", "bb"] }));
  assert(notJustified.lines.every((l) => l.justifyWidth === undefined), "only align=justify stretches anything");

  // …and it reaches the SVG both engines serialize.
  const svg = elementToSvg(e, () => undefined);
  assert(svg.includes('textLength="100" lengthAdjust="spacing"'), "the exported tspan carries textLength + lengthAdjust");
  assert(svg.split("textLength").length - 1 === 1, "…on exactly one of the two tspans");
  const plain = elementToSvg(text({ text: "hello" }), () => undefined);
  assert(!plain.includes("textLength") && !plain.includes("letter-spacing"), "an unarranged text serializes exactly as before");
}

// --- 5. letter spacing is a wrap metric --------------------------------------
console.log("\n5. letter spacing");
{
  const e = text({ letterSpacing: 3 });
  assert(letterSpacing(e) === 3 && letterSpacing(text()) === 0, "letterSpacing reads the property, 0 when absent");
  assert(textSvgLayout(e).attrs["letter-spacing"] === "3", "the <text> carries letter-spacing when set");
  assert(!("letter-spacing" in textSvgLayout(text()).attrs), "…and omits the attribute when unset");

  // The wrap measure must include the tracking: the same text at the same width
  // wraps differently once every glyph is 3px wider. (Injected measure — the
  // pure tier has no font metrics; this pins the ARITHMETIC contract that
  // text.ts browserMeasure implements with ctx.letterSpacing.)
  const tracked = (spacing: number) => (s: string) => s.length * (10 + spacing);
  assert(eq(wrapText("aa bb", 50, tracked(0)), ["aa bb"]), "untracked: both words fit in 50px");
  assert(eq(wrapText("aa bb", 50, tracked(3)), ["aa", "bb"]), "tracked: the same text wraps (the metric moved)");
}

// --- 6. the patch surface stores defaults as ABSENCE --------------------------
console.log("\n6. defaults are stored as absence");
{
  const p = proj([text({ id: "e1" })]);
  const el = () => p.figures[0].elements[0] as TextElement;
  ops.setElementStyle(p, ["e1"], { valign: "middle", letterSpacing: 2, paragraphSpacing: 4, align: "justify" });
  assert(el().valign === "middle" && el().letterSpacing === 2 && el().paragraphSpacing === 4, "the arrangement props are written");
  assert(el().align === "justify", "align accepts justify");
  ops.setElementStyle(p, ["e1"], { valign: "top", letterSpacing: 0, paragraphSpacing: 0 });
  assert(!("valign" in el()) && !("letterSpacing" in el()) && !("paragraphSpacing" in el()), "resetting to the default DELETES the property");

  // A metric patch invalidates the derived wrap cache (WS-12 flag included).
  const p2 = proj([text({ id: "e2", sizing: "auto-h", lines: ["aa", "bb"] })]);
  ops.setElementStyle(p2, ["e2"], { letterSpacing: 1 });
  const e2 = p2.figures[0].elements[0] as TextElement;
  assert(!e2.lines && e2.needsLayout === true, "letter spacing is a metric: the wrap cache drops and needsLayout is set");
  const p3 = proj([text({ id: "e3", sizing: "auto-h", lines: ["aa", "bb"] })]);
  ops.setElementStyle(p3, ["e3"], { valign: "bottom" });
  assert(eq((p3.figures[0].elements[0] as TextElement).lines, ["aa", "bb"]), "vertical align is NOT a metric — the cache survives");
}

// --- 7. named styles carry the arrangement ------------------------------------
console.log("\n7. named text styles");
{
  const p = proj([text({ id: "s1", valign: "bottom", letterSpacing: 2, paragraphSpacing: 5, align: "justify" })]);
  const st = ops.textStyleFromElement(p, "s1", "Block")!;
  assert(st.valign === "bottom" && st.letterSpacing === 2 && st.paragraphSpacing === 5 && st.align === "justify", "a style snapshots the whole arrangement");

  const target = text({ id: "s2" });
  p.figures[0].elements.push(target);
  ops.applyTextStyle(p, ["s2"], st.id);
  const t2 = p.figures[0].elements.find((e) => e.id === "s2") as TextElement;
  assert(t2.valign === "bottom" && t2.letterSpacing === 2 && t2.paragraphSpacing === 5, "applying the style writes the arrangement onto the element");

  // Detachment mirrors color/align: only when the style actually defines it.
  ops.detachOnManualEdit(p, t2, ["valign"]);
  assert(t2.styleId === undefined, "editing a property the style defines detaches the link");
  const bare = ops.createTextStyle(p, { name: "Bare", fontFamily: "Arial", fontSize: 12, fontWeight: 400, fontStyle: "normal" });
  const t3 = text({ id: "s3", styleId: bare.id });
  p.figures[0].elements.push(t3);
  ops.detachOnManualEdit(p, t3, ["valign"]);
  assert(t3.styleId === bare.id, "editing a property the style leaves undefined keeps the link");
}

// --- 8. the headless hug accounts for the arrangement -------------------------
console.log("\n8. headless applyTextLayout stays safe");
{
  const e = text({ sizing: "auto-h", lines: ["aa", "bb"], paragraphSpacing: 6 });
  applyTextLayout(e); // headless: no font metrics
  assert(e.lines === undefined && e.needsLayout === true, "headless applyTextLayout still drops the cache and flags it");
  // The arrangement of what remains is still well-formed.
  const L = blockLayout(e);
  assert(L.lines.length === 1 && L.lines[0].paragraphEnd, "the fallback hard line is a complete paragraph");
}

// --- 9. justification needs a wrap width — asking for it authors one -----------
// The 2026-09-18 "justify does not work" report: a hugging box (`auto`) has no
// wrap width, so nothing ever wraps and Justify was a silent no-op. The shared
// op now flips such a box to `auto-h` at its current width (the same flip a
// manual W applies), and the T tool's DRAG authors a wrapping box up front.
console.log("\n9. justification authors a wrap width");
{
  const p = proj([text({ id: "j1", sizing: "auto", width: 300, height: 12, lines: undefined })]);
  const el = () => p.figures[0].elements[0] as TextElement;
  ops.setElementStyle(p, ["j1"], { align: "justify" });
  assert(el().align === "justify" && el().sizing === "auto-h", "Justify on a hugging box makes it auto-h (its width becomes the wrap width)");
  assert(el().width === 300 && el().height === 12, "…without moving or resizing the box");
  assert(el().needsLayout === true, "…and the layout is re-derived (headless: flagged for the GUI to wrap)");

  const p2 = proj([text({ id: "j2", sizing: "fixed" })]);
  ops.setElementStyle(p2, ["j2"], { align: "justify" });
  assert((p2.figures[0].elements[0] as TextElement).sizing === "fixed", "a box that already has a width keeps its sizing");

  const p3 = proj([text({ id: "j3", sizing: "auto" })]);
  ops.setElementStyle(p3, ["j3"], { align: "justify", sizing: "fixed" });
  assert((p3.figures[0].elements[0] as TextElement).sizing === "fixed", "an explicit sizing in the same patch wins");

  const p4 = proj([text({ id: "j4", sizing: "auto" })]);
  ops.setElementStyle(p4, ["j4"], { align: "center" });
  assert((p4.figures[0].elements[0] as TextElement).sizing === "auto", "the other alignments leave a hugging box hugging");

  // The constructors agree: an agent asking for justify gets a wrapping box.
  const made = ops.makeText("hello", { x: 0, y: 0, width: 200, height: 20 }, { align: "justify" });
  assert(made.sizing === "auto-h", "makeText with align justify defaults to auto-h");
  assert(ops.makeText("hello", { x: 0, y: 0, width: 200, height: 20 }, {}).sizing === "auto", "…and to auto otherwise (unchanged)");

  // The T tool: click = hugging label, drag = paragraph box at the dragged width.
  const style = { fontFamily: "Arial", fontSize: 12, fontWeight: 400, textColor: "#000", fill: "#fff", stroke: "#000", strokeWidth: 1 } as Parameters<typeof createTextElement>[1];
  const clicked = createTextElement({ x: 10, y: 20 }, style) as TextElement;
  assert(clicked.sizing === "auto" && clicked.width === 240, "a click makes the hugging label it always did");
  const dragged = createTextElement({ x: 10, y: 20 }, style, { width: 180, height: 4 }) as TextElement;
  assert(dragged.sizing === "auto-h" && dragged.width === 180, "a drag makes an auto-h box at the dragged width");
  assert(dragged.height >= 12 * 1.4, "…never shorter than one line, however shallow the drag");
}

console.log(fails === 0 ? "\nTEXT ARRANGE: ALL PASS" : `\nTEXT ARRANGE: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
