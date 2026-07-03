// R1 — pure unit tests for the highlight geometry core (src/lib/pdf/highlightGeometry.ts):
// merged one-box-per-line painting + %-of-page hit-testing. Run: npx tsx scripts/verify-r1-hlgeom.ts
import { mergeRectsIntoLines, hitTest, type HitEntry } from "../src/lib/pdf/highlightGeometry";

let fails = 0;
function ok(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
}
const approx = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

const PAGE = { left: 100, top: 200, width: 800, height: 1000 };

// 1) Two overlapping same-line fragments + their containing parent rect → ONE line box.
{
  const boxes = mergeRectsIntoLines(
    [
      { left: 150, top: 300, width: 300, height: 14 }, // parent inline box (contains both)
      { left: 150, top: 300, width: 160, height: 14 },
      { left: 300, top: 300, width: 150, height: 14 }, // overlaps the first fragment
    ],
    PAGE,
  );
  ok("same-line fragments merge to one box", boxes.length === 1, `got ${boxes.length}`);
  const b = boxes[0];
  ok(
    "merged box spans the full extent in %",
    approx(b.x, ((150 - 100) / 800) * 100) && approx(b.w, (300 / 800) * 100) && approx(b.y, ((300 - 200) / 1000) * 100),
    JSON.stringify(b),
  );
}

// 2) Nested rect (fully contained) is dropped; duplicates keep one.
{
  const boxes = mergeRectsIntoLines(
    [
      { left: 150, top: 300, width: 300, height: 14 },
      { left: 200, top: 302, width: 50, height: 10 }, // nested
      { left: 150, top: 300, width: 300, height: 14 }, // exact duplicate
    ],
    PAGE,
  );
  ok("nested + duplicate rects collapse", boxes.length === 1, `got ${boxes.length}`);
}

// 3) Two distinct lines stay two boxes; sub/superscript fragment joins its line.
{
  const boxes = mergeRectsIntoLines(
    [
      { left: 150, top: 300, width: 300, height: 14 },
      { left: 452, top: 297, width: 20, height: 10 }, // superscript on line 1 (≥50% overlap)
      { left: 150, top: 320, width: 250, height: 14 }, // line 2
    ],
    PAGE,
  );
  ok("two lines → two boxes (superscript merged)", boxes.length === 2, `got ${boxes.length}`);
  ok("line 1 extended to include superscript", approx(boxes[0].w, ((472 - 150) / 800) * 100), JSON.stringify(boxes[0]));
}

// 4) Degenerate rects ignored; zero-size page → [].
{
  ok("degenerate rects ignored", mergeRectsIntoLines([{ left: 0, top: 0, width: 0.2, height: 14 }], PAGE).length === 0);
  ok("zero page → []", mergeRectsIntoLines([{ left: 0, top: 0, width: 10, height: 10 }], { ...PAGE, width: 0 }).length === 0);
}

// 5) bleedY expands boxes vertically.
{
  const [plain] = mergeRectsIntoLines([{ left: 150, top: 300, width: 100, height: 10 }], PAGE);
  const [bled] = mergeRectsIntoLines([{ left: 150, top: 300, width: 100, height: 10 }], PAGE, { bleedY: 2 });
  ok("bleedY expands height", bled.h > plain.h && bled.y < plain.y);
}

// 6) hitTest: inside → id, outside → null, overlapping entries → LAST wins (drawn on top).
{
  const entries: HitEntry[] = [
    { id: "a", boxes: [{ x: 10, y: 10, w: 20, h: 5 }] },
    { id: "b", boxes: [{ x: 25, y: 10, w: 20, h: 5 }] }, // overlaps a on x ∈ [25,30]
  ];
  ok("hit inside a", hitTest(12, 12, entries) === "a");
  ok("hit inside b", hitTest(40, 12, entries) === "b");
  ok("overlap → later entry wins", hitTest(27, 12, entries) === "b");
  ok("miss → null", hitTest(90, 90, entries) === null);
  ok("empty entries → null", hitTest(12, 12, []) === null);
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
