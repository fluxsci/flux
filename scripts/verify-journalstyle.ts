#!/usr/bin/env -S npx tsx
// Journal-style core (src/lib/style/**).
//   • THE IDENTITY LEG: the house style resolves to behaviour byte-identical to
//     no style at all — "pick nothing" must never change an export
//   • sparse merge, `extends`, unknown/absent id fallthrough (never throws)
//   • styledFamilyDef overrides only what a style names, and leaves the
//     figfamily builtin-shadowing invariant alone
//   • formatPanelSpec: case, wrap, list separator, range collapse threshold
//   Run: npx tsx scripts/verify-journalstyle.ts
import {
  DEFAULT_JOURNAL_STYLE,
  formatPanelSpec,
  resolveJournalStyle,
  styledFamilyById,
  styledFamilyDef,
  type JournalStyle,
} from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";
import { BUILTIN_FAMILIES, familyById, formatFamilyRef } from "../src/lib/figfamily";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const B = BUILTIN_JOURNAL_STYLES;

// --- 1. the identity leg -----------------------------------------------------
// If this ever fails, selecting "no style" has started changing exports.
{
  const none = resolveJournalStyle(null, B);
  assert(none === DEFAULT_JOURNAL_STYLE, "a null style id resolves to the house style object itself");
  assert(resolveJournalStyle(undefined, B) === DEFAULT_JOURNAL_STYLE, "an absent id resolves to the house style");
  assert(resolveJournalStyle("flux", B) === DEFAULT_JOURNAL_STYLE, "the house id resolves to the house style");
  assert(resolveJournalStyle("no-such-journal", B) === DEFAULT_JOURNAL_STYLE,
    "an UNKNOWN id degrades to the house style rather than throwing");

  // Panel rendering under the house style must equal today's hard-coded rule
  // (join with ",", en-dash ranges, collapse runs of 3+).
  const p = none.figures.panels;
  for (const [spec, want] of [
    ["a", "a"],
    ["a,b", "a,b"],
    ["a-c", "a–c"],
    ["a-c,e", "a–c,e"],
    ["b-f,i", "b–f,i"],
  ] as const) {
    assert(formatPanelSpec(spec, p) === want, `house panel spec ${spec} → ${want}`);
  }
  // And family templates are untouched by the house style.
  for (const f of BUILTIN_FAMILIES) {
    assert(styledFamilyDef(none, f) === f, `house style leaves the ${f.id} family object identical`);
  }
}

// --- 2. sparse merge + extends ----------------------------------------------
{
  const nature = resolveJournalStyle("nature", B);
  assert(nature.figures.panels.listSeparator === ",", "nature overrides the panel separator");
  assert(nature.figures.panels.rangeSeparator === "–", "nature inherits the en-dash range from the base");
  assert(nature.citations.numeric.presentation === "superscript", "nature sets superscript citations");
  assert(nature.referenceList.layout === "nature", "nature selects its own reference layout");

  const nc = resolveJournalStyle("nature-communications", B);
  assert(nc.figures.panels.listSeparator === ", ",
    "nature-communications overrides ONLY the separator (the 2022 switch it did not follow)");
  assert(nc.citations.numeric.presentation === "superscript",
    "…and inherits superscript citations through `extends`");
  assert(nc.referenceList.authorMax === 5, "…and inherits the author threshold through `extends`");
  assert(nc.structure.referenceListSplit === "single",
    "…while overriding the reference-list split it genuinely differs on");

  // A cycle must not hang the resolver.
  const cyc: JournalStyle[] = [
    { id: "a", name: "A", extends: "b" },
    { id: "b", name: "B", extends: "a" },
  ];
  const r = resolveJournalStyle("a", cyc);
  assert(r.id === "a", "a mutually-extending pair still resolves (no infinite recursion)");
}

// --- 3. family overrides -----------------------------------------------------
{
  const nature = resolveJournalStyle("nature", B);
  const [FIG, SUP, ED] = BUILTIN_FAMILIES;

  const sup = styledFamilyDef(nature, SUP);
  assert(formatFamilyRef(sup, 1) === "Supplementary Fig. 1",
    "nature renders the supplementary family as 'Supplementary Fig. 1'");
  assert(formatFamilyRef(SUP, 1) === "Fig. S1",
    "…while the UNSTYLED house form stays 'Fig. S1' (the writer never restyles)");
  assert(sup.id === SUP.id, "an override cannot change a family's id");
  assert(formatFamilyRef(styledFamilyDef(nature, FIG), 2, "a,b") === "Fig. 2a,b",
    "main-family refs carry the styled panel spec");
  assert(formatFamilyRef(styledFamilyDef(nature, ED), 4, "a") === "Extended Data Fig. 4a",
    "extended-data family renders Nature's form");

  // A family the style says nothing about passes through untouched.
  const MOVIE = { id: "movie", displayName: "Movie", refTemplate: "Mov. {num}{panel}", captionTemplate: "Movie {num} | " };
  assert(styledFamilyDef(nature, MOVIE) === MOVIE, "a custom family the style does not name is untouched");

  // styledFamilyById composes resolution + override in one step.
  assert(formatFamilyRef(styledFamilyById(nature, "supplementary"), 3) === "Supplementary Fig. 3",
    "styledFamilyById resolves and overrides together");
  assert(styledFamilyById(nature, "supplementary").captionTemplate === "Supplementary Fig. 3 | ".replace("3 ", "{num} "),
    "the caption template is overridden too");
}

// --- 4. panel formatting under a style --------------------------------------
{
  const nature = resolveJournalStyle("nature", B).figures.panels;
  const nc = resolveJournalStyle("nature-communications", B).figures.panels;

  assert(formatPanelSpec("a,b", nature) === "a,b", "Nature prints 'a,b' with no space");
  assert(formatPanelSpec("a,b", nc) === "a, b", "Nature Communications prints 'a, b' with a space");
  assert(formatPanelSpec("a-c", nature) === "a–c", "runs print as an en-dash range");
  // An author who spells a run out still gets the venue's collapsed form.
  assert(formatPanelSpec("a,b,c", nature) === "a–c", "an author-written run collapses to a range");
  assert(formatPanelSpec("a,b", nature) !== "a–b", "a PAIR stays listed (threshold is 3)");
  assert(formatPanelSpec("b-f,i", nature) === "b–f,i", "mixed range + single");

  const upper = { ...nature, letterCase: "upper" as const };
  assert(formatPanelSpec("a,b", upper) === "A,B", "letterCase upper (Science-style venues)");
  const parens = { ...nature, wrap: "parens" as const };
  assert(formatPanelSpec("a-c", parens) === "(a–c)", "parenthesised wrap");

  assert(formatPanelSpec("", nature) === "", "an empty spec stays empty");
  assert(formatPanelSpec("not-a-spec", nature) === "not-a-spec", "an unparseable spec passes through untouched");
  assert(formatPanelSpec("c-a", nature) === "c-a", "a reversed range is left alone rather than guessed at");
}

console.log("\nJOURNAL-STYLE VERIFY: PASS");
