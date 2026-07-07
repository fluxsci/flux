// 2.2 gate — the ONE reference formatter (references/format.ts) + parser parity for
// the new RefEntry fields (volume/issue/pages/authorsFull) across BOTH parsers.
// Run: npx tsx scripts/verify-refformat.ts
import { parseBib, splitBibEntries, lightEntry } from "../src/lib/references/bibtex";
import { formatReference, formatReferenceLine, inTextAuthorYear } from "../src/lib/references/format";
import type { RefEntry } from "../src/lib/references/types";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const BIB = `@article{watson1953molecular,
  title = {Molecular Structure of Nucleic Acids},
  author = {Watson, James Dewey and Crick, Francis Harry Compton},
  journal = {Nature},
  volume = {171},
  number = {4356},
  pages = {737--738},
  year = {1953},
  doi = {10.1038/171737a0},
}

@article{marder1996principles,
  title = {Principles of rhythmic motor pattern generation},
  author = {Eve Marder and Ronald L. Calabrese},
  journal = {Physiological Reviews},
  volume = {76},
  pages = {687--717},
  year = {1996},
}`;

// --- parser parity ---------------------------------------------------------------------
{
  const viaCsl = await parseBib(BIB);
  const viaLight = splitBibEntries(BIB).map(lightEntry);
  const w1 = viaCsl.find((e) => e.key === "watson1953molecular")!;
  const w2 = viaLight.find((e) => e.key === "watson1953molecular")!;
  for (const [name, e] of [
    ["parseBib", w1],
    ["lightEntry", w2],
  ] as const) {
    ok(e.volume === "171" && e.issue === "4356", `${name}: volume/issue extracted`, JSON.stringify([e.volume, e.issue]));
    ok(/737/.test(e.pages ?? ""), `${name}: pages extracted (${e.pages})`);
    ok(e.authorsFull?.[0]?.family === "Watson" && /James/.test(e.authorsFull?.[0]?.given ?? ""), `${name}: full author names`, JSON.stringify(e.authorsFull?.[0]));
  }
  const m2 = viaLight.find((e) => e.key === "marder1996principles")!;
  ok(m2.authorsFull?.[0]?.family === "Marder" && m2.authorsFull?.[0]?.given === "Eve", "lightEntry: 'Given Family' order splits correctly", JSON.stringify(m2.authorsFull));
}

// --- formatter snapshots ------------------------------------------------------------------
const entry = (over: Partial<RefEntry>): RefEntry => ({
  key: "k",
  title: "A study of things",
  authors: ["Watson", "Crick"],
  year: "1953",
  container: "Nature",
  ...over,
});
{
  const e = entry({
    authorsFull: [
      { family: "Watson", given: "James Dewey" },
      { family: "Crick", given: "Francis Harry Compton" },
    ],
    volume: "171",
    issue: "4356",
    pages: "737--738",
    doi: "10.1038/171737a0",
  });
  const ay = formatReferenceLine(e, "author-year");
  ok(
    ay === "Watson, J. D., & Crick, F. H. C. (1953). A study of things. Nature, 171(4356), 737–738. https://doi.org/10.1038/171737a0",
    "author-year line (initials + volume(issue) + en-dash pages)",
    ay,
  );
  const num = formatReferenceLine(e, "numeric");
  ok(num === "Watson JD, Crick FHC. A study of things. Nature. 1953;171(4356):737–738. doi:10.1038/171737a0", "numeric line (Vancouver shape)", num);
}
{
  const many = entry({
    authorsFull: Array.from({ length: 8 }, (_, i) => ({ family: `Fam${i}`, given: "Ann" })),
  });
  ok(/et al\./.test(formatReference(many, "numeric").authors), "numeric: >6 authors → et al.");
  const one = entry({ authorsFull: [{ family: "Solo", given: "Han" }] });
  ok(formatReference(one, "author-year").authors === "Solo, H.", "single author, initialed");
  const hyph = entry({ authorsFull: [{ family: "Curie", given: "Marie-Anne" }] });
  ok(formatReference(hyph, "author-year").authors === "Curie, M.-A.", "hyphenated given → M.-A.");
  const bare = entry({ authorsFull: undefined });
  ok(formatReference(bare, "author-year").authors.includes("Watson"), "family-only entries degrade gracefully");
  const noloc = entry({ volume: undefined, pages: undefined });
  ok(formatReference(noloc, "author-year").locator === "", "missing volume/pages → empty locator");
}

// --- in-text byte-lock: the chip rule is unchanged ------------------------------------------
{
  const one = entry({ authors: ["Smith"] });
  const two = entry({ authors: ["Smith", "Jones"] });
  const three = entry({ authors: ["Smith", "Jones", "Lee"] });
  ok(inTextAuthorYear(one) === "Smith, 1953", "in-text: single");
  ok(inTextAuthorYear(two) === "Smith & Jones, 1953", "in-text: pair");
  ok(inTextAuthorYear(three) === "Smith et al., 1953", "in-text: 3+ → et al.");
  ok(inTextAuthorYear(entry({ authors: [], year: "" })) === "k", "in-text: empty → key");
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
