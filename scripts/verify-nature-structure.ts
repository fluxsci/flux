#!/usr/bin/env -S npx tsx
// Section roles + export-time reordering (src/lib/manuscript/sections.ts).
//
// The load-bearing property is CONSERVATISM: an unrecognised heading is `body`
// and stays put, a document already in order comes back byte-identical, and the
// SOURCE is never what gets reordered — only the exported text.
//   Run: npx tsx scripts/verify-nature-structure.ts
import {
  NATURE_ROLE_ALIASES,
  normalizeHeading,
  reorderForExport,
  scanSections,
  topLevelSections,
} from "../src/lib/manuscript/sections";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const A = NATURE_ROLE_ALIASES;

// A Nature-shaped manuscript: free-form result subheads (NOT "Results"), then
// the fixed back-matter vocabulary — in the WRONG order, as authors write it.
const DOC = `---
title: Test
---

A summary paragraph that cites things.

# Pupil dynamics reveal sleep microstructure

Prose about the first finding.

## A nested subsection

More prose.

# Small-pupil substates replay memory

Prose about the second finding.

# Discussion

What it means.

# Acknowledgements

Thanks.

# Methods

How it was done.

## Statistics

Details.

# Data availability

Where the data is.

# Competing interests

None.

# Author contributions

Who did what.
`;

// --- scanning ----------------------------------------------------------------
{
  const st = scanSections(DOC, A);
  const tops = topLevelSections(st);
  assert(st.preamble.words > 0 && st.preamble.from === 0,
    "the preamble (title block + summary paragraph) is captured before any heading");

  const byHeading = new Map(tops.map((s) => [s.heading, s.role]));
  assert(byHeading.get("Pupil dynamics reveal sleep microstructure") === "body",
    "an UNRECOGNISED heading is `body` — the normal case for Nature's descriptive subheads");
  assert(byHeading.get("Discussion") === "discussion", "Discussion is recognised");
  assert(byHeading.get("Methods") === "methods", "Methods is recognised");
  assert(byHeading.get("Data availability") === "data-availability", "Data availability is recognised");
  assert(byHeading.get("Competing interests") === "competing-interests", "Competing interests is recognised");
  assert(byHeading.get("Author contributions") === "author-contributions", "Author contributions is recognised");
  assert(byHeading.get("Acknowledgements") === "acknowledgements", "Acknowledgements is recognised");

  // H2s belong to their H1, they do not split it.
  assert(tops.length === 8, `only level-1 headings are top-level sections (got ${tops.length})`);
  const methods = tops.find((s) => s.heading === "Methods")!;
  assert(DOC.slice(methods.from, methods.to).includes("## Statistics"),
    "an H2 stays INSIDE its parent H1 section rather than splitting it");

  // Alias normalisation.
  assert(normalizeHeading("Acknowledgments:") === "acknowledgments", "trailing punctuation is trimmed");
  assert(normalizeHeading("Methods {#sec-methods}") === "methods", "Quarto heading attributes are stripped");
  assert(scanSections("# METHODS\n\nx", A).sections[0].role === "methods", "matching is case-insensitive");
}

// --- masking -----------------------------------------------------------------
{
  const fenced = `# Real

\`\`\`bash
# not a heading
echo hi
\`\`\`

# Discussion

x
`;
  const tops = topLevelSections(scanSections(fenced, A));
  assert(tops.length === 2, `a '#' inside a fenced block is not a heading (got ${tops.length})`);
  assert(tops[1].role === "discussion", "…and the real heading after the fence still resolves");

  const fm = scanSections("---\ntitle: x\n# not a heading\n---\n\n# Methods\n\ny", A);
  assert(topLevelSections(fm).length === 1, "front matter is masked");
}

// --- reordering --------------------------------------------------------------
{
  const order = [
    "abstract", "body", "discussion", "references", "figure-legends", "methods",
    "data-availability", "code-availability", "methods-references",
    "acknowledgements", "funding", "author-contributions", "competing-interests",
    "additional-information", "extended-data",
  ];
  const { text, moved } = reorderForExport(DOC, order, A);
  assert(text !== DOC, "a document in the wrong order IS reordered");
  assert(moved.length > 0, `the moved sections are reported (${moved.join(", ")})`);

  const pos = (h: string) => text.indexOf(`# ${h}`);
  assert(pos("Discussion") < pos("Methods"), "Discussion precedes Methods");
  assert(pos("Methods") < pos("Acknowledgements"),
    "Methods precedes Acknowledgements — the authored order had them the other way round");
  assert(pos("Data availability") > pos("Methods"), "availability statements follow Methods");
  assert(pos("Author contributions") < pos("Competing interests"),
    "back matter follows the venue's internal order");

  // The two free-form body sections keep their authored order, as a block.
  assert(pos("Pupil dynamics reveal sleep microstructure") < pos("Small-pupil substates replay memory"),
    "unrecognised body sections keep their AUTHORED relative order");
  assert(pos("Pupil dynamics reveal sleep microstructure") < pos("Discussion"),
    "…and sit where the venue puts `body`");

  // Nothing is lost or duplicated.
  for (const h of ["Discussion", "Methods", "Acknowledgements", "Data availability",
                   "Competing interests", "Author contributions"]) {
    assert(text.split(`# ${h}\n`).length === 2, `'${h}' appears exactly once after reordering`);
  }
  assert(text.includes("## Statistics"), "nested content travels with its parent section");
  assert(text.startsWith("---\ntitle: Test\n---\n\nA summary paragraph"),
    "the preamble stays at the top, untouched");
  assert(countWordsish(text) === countWordsish(DOC), "no prose is lost or duplicated overall");

  // A document ALREADY in order must come back byte-identical.
  const again = reorderForExport(text, order, A);
  assert(again.text === text, "reordering is idempotent — a correct document is returned unchanged");
  assert(again.moved.length === 0, "…and reports nothing moved");

  // No order = no change at all (the house style).
  assert(reorderForExport(DOC, [], A).text === DOC, "an empty order leaves the document untouched");
  // A document with no headings is safe.
  assert(reorderForExport("just prose", order, A).text === "just prose", "a heading-less document is untouched");
}

function countWordsish(s: string): number {
  return (s.match(/\S+/g) ?? []).length;
}

console.log("\nNATURE-STRUCTURE VERIFY: PASS");
