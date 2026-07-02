// Citation numbering core — pure-logic checks (repo convention: tsx script,
// no test runner). Run: npx tsx scripts/verify-citenum.ts
import {
  buildCitationOrdinals,
  collapseOrdinals,
  formatNumericLabel,
  citationStyleOf,
  parseCitationStyle,
} from "../src/shell/modes/paper/scholar/citeNumbering";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}\n      got  ${g}\n      want ${w}`);
  }
}

// ---- collapseOrdinals ----------------------------------------------------
const texts = (n: number[]) => collapseOrdinals(n).map((s) => s.text);
check("single", texts([9]), ["9"]);
check("pair stays comma", texts([3, 5]), ["3", "5"]);
check("adjacent pair no-collapse", texts([3, 4]), ["3", "4"]);
check("run of 3+ collapses en-dash", texts([9, 10, 11, 12, 13, 14]), ["9–14"]);
check("mixed", texts([3, 5, 9, 10, 11]), ["3", "5", "9–11"]);
check("dupes dedupe", texts([4, 4, 5, 6]), ["4–6"]);
check("unsorted input", texts([14, 9, 11, 10, 13, 12]), ["9–14"]);
check(
  "segment ordinals kept",
  collapseOrdinals([2, 3, 4]).map((s) => s.ordinals),
  [[2, 3, 4]],
);

// ---- formatNumericLabel ----------------------------------------------------
const ord = (m: Record<string, number>) => (k: string) => m[k];
check(
  "label range",
  formatNumericLabel(["a", "b", "c"], ord({ a: 9, b: 10, c: 11 })),
  { text: "[9–11]", allResolved: true, anyResolved: true },
);
check(
  "label unresolved tail",
  formatNumericLabel(["a", "x"], ord({ a: 3 })),
  { text: "[3,?]", allResolved: false, anyResolved: true },
);
check(
  "label none resolved",
  formatNumericLabel(["x"], ord({})),
  { text: "[?]", allResolved: false, anyResolved: false },
);

// ---- buildCitationOrdinals --------------------------------------------------
const bib = new Set(["smith2020", "jones2019", "wu2021", "doi:10.1-x"]);
const isNum = (k: string) => bib.has(k);
const doc = [
  "---",
  "title: T",
  "citation-style: numeric",
  "---",
  "Intro cites [@smith2020] then @jones2019 too.",
  "```",
  "code with [@wu2021] must not count",
  "```",
  "Inline `[@wu2021]` code must not count either.",
  "A crossref @fig-one is not a citation.",
  "Repeat [@smith2020; @wu2021] keeps first numbers.",
  "Unknown [@ghost2024] gets no ordinal.",
  "And [@doi:10.1-x] works, and a bare cite ends a sentence @smith2020.",
].join("\n");
const scan = buildCitationOrdinals(doc, isNum);
check(
  "appearance order + masking",
  [...scan.map.entries()],
  [
    ["smith2020", 1],
    ["jones2019", 2],
    ["wu2021", 3],
    ["doi:10.1-x", 4],
  ],
);
check("contiguous despite unresolved", Math.max(...scan.map.values()), scan.map.size);
check(
  "front matter masked",
  buildCitationOrdinals("---\nx: '@fake2020'\n---\nBody @smith2020.", isNum).map.size,
  1,
);
check("ranges include unresolved tokens", scan.ranges.length >= 6, true);

// ---- style parsing -----------------------------------------------------------
check("style numeric", citationStyleOf(doc), "numeric");
check("style default", citationStyleOf("# No front matter\n@smith2020"), "author-year");
check("style unknown value", parseCitationStyle("vancouver-ish"), "author-year");
check(
  "style author-year explicit",
  citationStyleOf('---\ncitation-style: "author-year"\n---\n'),
  "author-year",
);

if (failures) {
  console.error(`\nCITENUM VERIFY: FAIL (${failures})`);
  process.exit(1);
}
console.log("\nCITENUM VERIFY: PASS");
