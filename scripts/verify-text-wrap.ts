#!/usr/bin/env -S npx tsx
// figure-v1 Phase 3 (pure) — the text wrap core (src/lib/text.ts wrapText):
// greedy word wrap with an injected measure fn. Pins the contract:
//   • words wrap greedily at maxW (+0.5px tolerance — a hugged box never
//     spuriously wraps its own content)
//   • trailing whitespace NEVER forces a break (CSS hanging-space rule) and
//     the break-point whitespace hangs (trimmed from the wrapped line's end)
//   • a word longer than the whole line char-breaks (binary search, ≥1 char
//     per line so the loop always advances)
//   • blank lines are preserved verbatim
//   • headless applyTextLayout never crashes and drops the stale cache
//
//  Run: npx tsx scripts/verify-text-wrap.ts
import { wrapText, wrapLine, applyTextLayout, visualLines, lineH, LINE_HEIGHT, WRAP_TOLERANCE } from "../src/lib/text";
import type { TextElement } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Fake measure: every char is 10px wide. maxW 100 → 10 chars per line.
const m10 = (s: string) => s.length * 10;

// --- basic greedy word wrap -------------------------------------------------
assert(eq(wrapText("hello world", 200, m10), ["hello world"]), "line that fits stays one line");
assert(eq(wrapText("hello world", 100, m10), ["hello", "world"]), "greedy wrap at the word boundary");
assert(
  eq(wrapText("aa bb cc dd", 50, m10), ["aa bb", "cc dd"]),
  `greedy packs as many words as fit (${JSON.stringify(wrapText("aa bb cc dd", 50, m10))})`,
);
// The whole first token run stays if it fits with its following space hanging.
assert(eq(wrapText("abcde fghij", 100, m10), ["abcde", "fghij"]), "exact-fit words split cleanly (space hangs)");

// --- +0.5px tolerance --------------------------------------------------------
const mFrac = (s: string) => s.length * 10 + 0.4; // every string measures 0.4 over
assert(eq(wrapText("abcdefghij", 100, mFrac), ["abcdefghij"]), "+0.5px tolerance absorbs float noise (100.4 ≤ 100.5)");
const mOver = (s: string) => s.length * 10 + 0.6;
assert(eq(wrapLine("abcdefghij", 100, mOver), ["abcdefghi", "j"]), "0.6px over the tolerance wraps (char-break)");
assert(WRAP_TOLERANCE === 0.5, "tolerance constant is 0.5px");

// --- trailing whitespace never breaks ----------------------------------------
assert(eq(wrapText("abcdefgh   ", 100, m10), ["abcdefgh   "]), "trailing spaces overflow without wrapping (hang)");
assert(eq(wrapText("aa bb    ", 50, m10), ["aa bb    "]), "trailing run after a full line hangs too");
// the whitespace AT a break point hangs (trimmed from the wrapped line)
assert(eq(wrapText("hello   world", 60, m10), ["hello", "world"]), "break-point whitespace hangs (trimmed)");
// but INNER whitespace that fits is preserved verbatim
assert(eq(wrapText("a  b", 100, m10), ["a  b"]), "inner whitespace preserved when the line fits");
// leading indentation is preserved on the first line
assert(eq(wrapText("  abc def", 60, m10), ["  abc", "def"]), "leading indent stays on the first line");

// --- long words char-break via binary search ----------------------------------
assert(eq(wrapText("aaaaaaaaaaaaaaaaaaaaaaaaa", 100, m10), ["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]), "25-char word → 10/10/5 char-break");
assert(eq(wrapText("hi aaaaaaaaaaaa", 100, m10), ["hi", "aaaaaaaaaa", "aa"]), "long word after a short one wraps then char-breaks");
// progress guarantee: even when ONE char doesn't fit, take one per line
assert(eq(wrapText("abc", 5, m10), ["a", "b", "c"]), "≥1 char per line even when nothing fits (no infinite loop)");
// indent + long word: indent applies to the first broken line only
assert(eq(wrapText("  aaaaaaaaaaaa", 100, m10), ["  aaaaaaaa", "aaaa"]), "indented long word: indent on first line only");

// --- blank lines preserved -----------------------------------------------------
assert(eq(wrapText("a\n\nb", 100, m10), ["a", "", "b"]), "blank hard lines preserved");
assert(eq(wrapText("\n", 100, m10), ["", ""]), "lone newline → two empty lines");
assert(eq(wrapText("", 100, m10), [""]), "empty text → one empty line");
assert(
  eq(wrapText("hello world\n\nagain here", 60, m10), ["hello", "world", "", "again", "here"]),
  "wraps within hard lines; the blank line survives between them",
);

// --- reconstruction property: no NON-SPACE characters lost or reordered
// (break points hang/drop whitespace, so compare the ink itself) ----------------
{
  const texts = ["the quick brown fox jumps over the lazy dog", "a bb ccc dddd eeeee ffffff ggggggg", "word " + "x".repeat(40) + " tail"];
  for (const t of texts) {
    for (const w of [30, 55, 70, 100]) {
      const lines = wrapText(t, w, m10);
      const ink = lines.join("").replace(/\s+/g, "");
      assert(ink === t.replace(/\s+/g, ""), `no ink lost at maxW=${w} ("${t.slice(0, 18)}…")`);
      assert(lines.every((ln) => m10(ln.replace(/\s+$/, "")) <= w + 0.5), `every line fits (modulo hung spaces) at maxW=${w}`);
    }
  }
}

// --- headless applyTextLayout: never crashes, drops the stale cache -------------
{
  const el: TextElement = {
    type: "text", id: "t1", x: 0, y: 0, width: 100, height: 24, rotation: 0,
    text: "hello world", fontFamily: "Arial", fontSize: 12, fontWeight: 400,
    fontStyle: "normal", align: "left", color: "#000", sizing: "auto-h",
    lines: ["stale", "cache"],
  };
  assert(typeof document === "undefined", "running headless (no document)");
  applyTextLayout(el); // must not throw
  assert(el.lines === undefined, "headless applyTextLayout DELETES the stale wrap cache");
  assert(eq(visualLines(el), ["hello world"]), "visualLines falls back to the hard lines");
  el.lines = ["a", "b"];
  assert(eq(visualLines(el), ["a", "b"]), "visualLines prefers the cache when present");
}

// --- line height helpers ---------------------------------------------------------
{
  const el = { type: "text", fontSize: 10, text: "x" } as TextElement;
  assert(lineH(el) === 10 * LINE_HEIGHT && LINE_HEIGHT === 1.2, "default line height = fontSize × 1.2");
  el.lineHeight = 1.5;
  assert(lineH(el) === 15, "el.lineHeight overrides the default (10 × 1.5 = 15)");
}

console.log(fails === 0 ? "\nTEXT WRAP: ALL PASS" : `\nTEXT WRAP: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
