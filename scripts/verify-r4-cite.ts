// R4 — pure tests for the citation-preview core (src/lib/pdf/citePreview.ts):
// line grouping, bibliography-entry extraction at a link dest (against the REAL
// committed fixture PDF via pdf.js text extraction), brief matching, outline
// flattening. Run: npx tsx scripts/verify-r4-cite.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  groupLines,
  extractBibEntryAt,
  matchRefToBriefs,
  flattenOutline,
  type TextItemLike,
} from "../src/lib/pdf/citePreview";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  } else {
    console.log("  ok:", msg);
  }
}

console.log("R4 — groupLines (pure):");
{
  const lines = groupLines([
    { str: "world", x: 60, y: 700 },
    { str: "hello", x: 20, y: 701 }, // same baseline within tolerance, earlier x
    { str: "below", x: 20, y: 680 },
    { str: "   ", x: 0, y: 650 }, // whitespace-only ignored
  ]);
  assert(lines.length === 2, `two visual lines (got ${lines.length})`);
  assert(lines[0].text === "hello world", `x-ordered join ("${lines[0].text}")`);
  assert(lines[0].y > lines[1].y, "top of page first (bottom-origin y desc)");
}

console.log("\nR4 — extractBibEntryAt against the real fixture:");
const data = new Uint8Array(readFileSync(join(root, "scripts/fixtures/reader-sample.pdf")));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
const p1 = await doc.getPage(1);
const [link] = await p1.getAnnotations();
assert(Array.isArray(link.dest) && link.dest[1]?.name === "XYZ", "fixture link dest is an explicit XYZ array");
const destY = link.dest[3] as number;
const pageIndex = await doc.getPageIndex(link.dest[0]);
assert(pageIndex === 2, `dest resolves to page 3 (index ${pageIndex})`);
const p3 = await doc.getPage(pageIndex + 1);
const tc = await p3.getTextContent();
const items: TextItemLike[] = tc.items
  .filter((i): i is { str: string; transform: number[] } => "str" in i)
  .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] }));
const entry = extractBibEntryAt(items, destY);
assert(/^\[1\] Ward/.test(entry), `entry starts at [1] Ward ("${entry.slice(0, 40)}…")`);
assert(/overflow lost its richness/.test(entry), "continuation line accumulated");
assert(!/Block/.test(entry), "stops before the next entry marker ([2] Block)");

console.log("\nR4 — matchRefToBriefs:");
{
  const briefs = [
    { openalexId: "W1", title: "Downgraded phenomenology: how conscious overflow lost its richness", authors: ["Emily J. Ward"], year: 2018 },
    { openalexId: "W2", title: "Perceptual consciousness overflows cognitive access", authors: ["Ned Block"], year: 2011 },
    { openalexId: "W3", title: "Ensemble perception of size in juvenile pigeons", authors: ["A. Nother"], year: 1999 },
  ];
  const m = matchRefToBriefs(entry, briefs);
  assert(m?.brief.openalexId === "W1", `fixture entry matches the Ward brief (got ${m?.brief.openalexId ?? "null"}, score ${m?.score.toFixed(2) ?? "-"})`);
  const m2 = matchRefToBriefs("[7] Someone, Q. (1901). On the entirely unrelated migratory patterns of alpine snails.", briefs);
  assert(m2 === null, "unrelated entry matches nothing (threshold holds)");
  const m3 = matchRefToBriefs("see https://doi.org/10.1098/rstb.2017.0355 for details", [
    { openalexId: "W9", title: "Totally different words here", authors: [], year: 2000, doi: "https://doi.org/10.1098/rstb.2017.0355" },
  ]);
  assert(m3?.brief.openalexId === "W9" && m3.score === 1, "verbatim DOI short-circuits to a full match");
}

console.log("\nR4 — flattenOutline (against the fixture's real outline):");
{
  const flat = flattenOutline(await doc.getOutline());
  assert(
    flat.length === 2 && flat[0].title === "Introduction" && flat[1].title === "References",
    `fixture outline flattens to 2 items (${flat.map((f) => f.title).join(", ")})`,
  );
  const nested = flattenOutline([{ title: "A", items: [{ title: "A.1" }, { title: "A.2", items: [{ title: "A.2.a" }] }] }]);
  assert(
    nested.map((n) => n.depth).join(",") === "0,1,1,2",
    `nested depths (${nested.map((n) => n.depth).join(",")})`,
  );
}

if (failures) {
  console.error(`\nR4 CITE-CORE VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nR4 CITE-CORE VERIFY: PASS");
