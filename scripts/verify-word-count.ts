#!/usr/bin/env -S npx tsx
// Word counts the way journals count them — THE shared counter
// (src/lib/manuscript/wordCount.ts + wordBudget.ts) and the agreement of every
// surface that used to count on its own.
//
//   (A) the counting law, construct by construct: citations 0, cross-refs 2
//       (what they print), code / math / comments / tags / attributes /
//       shortcodes / embeds / table markup are not words;
//   (B) a Nature-shaped manuscript (fixtures/word-count/nature.qmd) → exact
//       per-kind, per-section and per-venue counts, hand-counted;
//   (C) selection ranges: partial words, cross-refs, headings, multi-line;
//   (D) the former counters now agree — sections.ts (scanSections), Journal
//       Check (checkCompliance's messages), the journal export (the
//       assembler's report, all four venues) and its summary text;
//   (E) twin-engine parity: flux-core's flux-connect document list
//       (collectFacts, hermetic scratch machine) reports the same main-text
//       words as the shared core, and both engines import the one module;
//   (F) census: no other `\S+` word counter survives in Paper, the manuscript
//       and journal cores, or flux-core/connect.
//   node scripts/run-verifies.mjs --tier pure --only verify-word-count

import { readFileSync, readdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";

const h = harness("verify-word-count");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Hermetic machine BEFORE flux-core loads (collectFacts reads FluxConfig).
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "verify-word-count-")));
const env = isolatedEnv(path.join(scratch, "machine"));
for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
Object.assign(process.env, env);

const { analyzeWords, countRange, proseWords, WORD_PROSE, WORD_LEGEND, WORD_TABLE, WORD_HEADING } = await import("../src/lib/manuscript/wordCount");
const { wordBudget, countRulesFor, mainTextWords, HOUSE_COUNT_RULES } = await import("../src/lib/manuscript/wordBudget");
const { scanSections, JOURNAL_ROLE_ALIASES } = await import("../src/lib/manuscript/sections");
const { checkCompliance } = await import("../src/lib/manuscript/compliance");
const { resolveJournalStyle, styledFamilyById } = await import("../src/lib/style/journalStyle");
const { BUILTIN_JOURNAL_STYLES } = await import("../src/lib/style/journalPresets");
const { transformQmdForExport } = await import("../src/lib/exportQmd");
const { assembleJournalManuscript } = await import("../src/lib/style/journalManuscript");
const { buildExportSummary, summaryMarkdown } = await import("../src/lib/style/journalSummary");

const FIXTURE = readFileSync(path.join(ROOT, "fixtures/word-count/nature.qmd"), "utf8");
const CAPTIONS: Record<string, string> = {
  "fig-tau": "Tau falls in sleep. **a**, Design. **b**, Western blots.",
  "fig-dose": "Dose response across three cohorts.",
  "fig-ed1": "Extended tau blots, all cohorts.",
};
const legendFor = (label: string) => CAPTIONS[label];

try {
  // ---------------------------------------------------------------- (A)
  const law: [string, number, string][] = [
    ["Plain words, three here.", 4, "plain prose: whitespace runs with a letter or digit"],
    ["state-of-the-art 3.5 p < 0.05 — done", 5, "hyphenated = 1, numbers count, lone symbols do not"],
    ["Known [@smith2020; @lee2021] effects.", 2, "a bracketed citation group is zero words (Nature numbers them)"],
    ["As @smith2020 showed.", 2, "a bare citation key is zero words"],
    ["See [-@smith2020, p. 4] here.", 2, "prefix/locator inside a citation bracket are not running words"],
    ["Shown in @fig-growth here.", 5, "a cross-reference counts the two words it prints (\"Fig. 2\")"],
    ["Panels (@fig-growth-b,c) here.", 4, "a panel cross-reference prints \"Fig. 2b,c\": two words"],
    ["Both [@fig-a; @fig-b] here.", 6, "each cross-reference in a bracket prints its two words"],
    ["See @tbl-x and @eq-y and @sec-z.", 9, "tables, equations and sections print two words each"],
    ["Mail a@b.org now.", 3, "an e-mail address is one word, not a citation"],
    ["Run `numpy.mean(x)` fast.", 2, "inline code is not words"],
    ["Let $x^2 + y$ and $$z$$ hold.", 3, "inline and single-line display math are not words"],
    ["Keep <!-- hidden note --> this.", 2, "an inline HTML comment is not words"],
    ["A <span class=\"x\">tagged</span> word.", 3, "raw HTML tags are not words (their text is)"],
    ["Visit <https://doi.org/10.1/x> today.", 3, "an autolink is one word"],
    ["Read [the docs](https://x.org/a_b) now.", 4, "a link counts its text, never its target"],
    ["An ![inline](i.png) image.", 2, "an inline image is not words"],
    ["Marked [important]{.mark} text {#id}.", 3, "attribute blocks are not words"],
    ["A {{< pagebreak >}} break.", 2, "a Quarto shortcode is not words"],
    ["Raised^1,2^ claims.", 2, "literal superscript citations are not words"],
    ["Footnoted[^a] claim.", 2, "a footnote reference is not words"],
    ["- bullet one\n1. ordered two\n> quoted three", 6, "list and quote markers are not words"],
    ["**Bold** and _italic_ words.", 4, "emphasis markers are not words"],
    ["```r\nx <- 1\n```\nAfter.", 1, "a fenced (executable) chunk is not words"],
    ["$$\na = b\n$$ {#eq-a}\nAfter.", 1, "display math (with its label) is not words"],
    ["\\newpage\nAfter.", 1, "a raw LaTeX command line is not words"],
    ["<!--\nmulti\nline\n-->\nAfter.", 1, "a multi-line HTML comment is not words"],
    ["::: {.callout-note}\nInside the callout.\n:::", 3, "a div fence is not words; its prose is"],
  ];
  for (const [src, want, label] of law) h.eq(proseWords(src), want, `law: ${label}`);

  {
    const a = analyzeWords("---\ntitle: Not counted at all\nabstract: Three words here.\n---\nBody.\n");
    h.eq(a.n, 1, "front matter is not body words");
    h.eq(a.fmAbstract, 3, "a front-matter abstract is counted on its own");
  }
  {
    const a = analyzeWords("| A b | C |\n|---|:-:|\n| one | two three |\n\n: Caption here {#tbl-x}\n\nProse.\n");
    const kinds = Array.from(a.kinds.subarray(0, a.n));
    h.eq(kinds.filter((k) => k === WORD_TABLE).length, 6, "table cells count as TABLE words (pipes and delimiter row are not words)");
    h.eq(kinds.filter((k) => k === WORD_LEGEND).length, 2, "a table caption counts as LEGEND words");
    h.eq(kinds.filter((k) => k === WORD_PROSE).length, 1, "prose after the table is prose again");
  }
  {
    const a = analyzeWords("![A short caption.](f.svg){#fig-a}\n\n![](g.svg){#fig-b}\n", { legendFor: (l) => (l === "fig-b" ? "Model caption of five." : undefined) });
    h.eq(Array.from(a.kinds.subarray(0, a.n)).filter((k) => k === WORD_LEGEND).length, 3, "an embed's alt text is LEGEND words, the line is not main text");
    h.eq(a.external.map((e) => [e.label, e.words]), [["fig-b", 4]], "an empty-alt embed takes the figure model's caption as legend words");
    h.eq(a.legendItems.map((e) => [e.label, e.words]), [["fig-a", 3], ["fig-b", 4]], "every legend is itemised for per-legend limits");
  }

  // ---------------------------------------------------------------- (B)
  const a = analyzeWords(FIXTURE, { legendFor });
  const kinds = Array.from(a.kinds.subarray(0, a.n));
  const byKind = (k: number) => kinds.filter((x) => x === k).length;
  h.eq([byKind(WORD_PROSE), byKind(WORD_LEGEND), byKind(WORD_TABLE), byKind(WORD_HEADING)], [68, 22, 10, 17], "fixture: prose / in-text legend / table / heading words");
  const b = wordBudget(a, HOUSE_COUNT_RULES);
  h.eq(
    { abstract: b.abstract, from: b.abstractFrom, main: b.main, methods: b.methods, legends: b.legends, mainLegends: b.mainLegends, tables: b.tables, other: b.other, total: b.total },
    { abstract: 11, from: "preamble", main: 50, methods: 8, legends: 27, mainLegends: 14, tables: 10, other: 10, total: 105 },
    "fixture budget (house = Nature): summary paragraph 11, main 50 incl. it, Methods 8, legends 27",
  );
  h.eq(b.longestLegend, { label: "fig-tau", words: 9 }, "the longest figure legend is itemised");
  h.eq(
    b.sections.map((s) => [s.heading, s.role, s.top, s.words, s.own, s.legends, s.tables]),
    [
      ["Synaptic tau falls during sleep {#sec-results}", "body", true, 29, 10, 22, 10],
      ["Dose matters", "body", false, 19, 19, 8, 10],
      ["Discussion", "discussion", true, 10, 10, 0, 0],
      ["Methods", "methods", true, 8, 0, 0, 0],
      ["Animals", "methods", false, 4, 4, 0, 0],
      ["Statistics", "methods", false, 4, 4, 0, 0],
      ["Data availability", "data-availability", true, 6, 6, 0, 0],
      ["Acknowledgements", "acknowledgements", true, 4, 4, 0, 0],
      ["References", "references", true, 0, 0, 0, 0],
      ["Extended Data", "extended-data", true, 0, 0, 5, 0],
    ],
    "fixture per-section counts (prose incl. subsections, own prose, legends, tables)",
  );
  h.eq(b.preamble.words + b.sections.filter((s) => s.top).reduce((n, s) => n + s.words, 0), byKind(WORD_PROSE), "top-level sections + preamble partition the prose exactly");
  const venueMain = (id: string) => wordBudget(a, countRulesFor(resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES))).main;
  h.eq(
    Object.fromEntries(["flux", "nature", "nature-communications", "science", "cell", "biorxiv"].map((id) => [id, venueMain(id)])),
    { flux: 50, nature: 50, "nature-communications": 50, science: 39, cell: 53, biorxiv: 39 },
    "main text per venue: Nature adds the summary paragraph, Cell the main figure legends",
  );
  h.eq(mainTextWords(FIXTURE), 50, "mainTextWords (the status bar's default, flux-connect's number)");
  {
    const fm = analyzeWords("---\ntitle: T\nabstract: |\n  An abstract of six words here.\n---\n\nLead prose.\n\n# Results\n\nFour body words here.\n");
    const fb = wordBudget(fm);
    h.eq([fb.abstract, fb.abstractFrom, fb.main, fb.other], [6, "front-matter", 10, 2], "a front-matter abstract wins; the lead is then neither abstract nor main");
    const sec = wordBudget(analyzeWords("# Abstract\n\nThree abstract words.\n\n# Introduction\n\nTwo words.\n"));
    h.eq([sec.abstract, sec.abstractFrom, sec.main], [3, "section", 5], "an Abstract section is the abstract");
    const h2 = wordBudget(analyzeWords("Lead words.\n\n## Results\n\nFive words of results text.\n\n## Methods\n\nThree method words.\n"));
    h.eq([h2.abstract, h2.main, h2.methods], [2, 7, 3], "no H1: the shallowest heading level is the top level");
  }

  // ---------------------------------------------------------------- (C)
  {
    const lineStart = FIXTURE.indexOf("Tau fell by half");
    const lineEnd = FIXTURE.indexOf("\n", lineStart);
    h.eq(countRange(a, lineStart, lineEnd), 10, "a selected sentence: cross-ref 2, math and code 0");
    const fell = FIXTURE.indexOf("fell", lineStart);
    h.eq(countRange(a, fell + 1, fell + 6), 2, "a partly selected word counts once (\"ell b\" → fell, by)");
    h.eq(countRange(a, fell, fell), 0, "an empty range counts nothing");
    const head = FIXTURE.indexOf("# Discussion");
    h.eq(countRange(a, head, FIXTURE.indexOf("\n# Methods")), 11, "a selected heading counts its words (1 + 10)");
    h.eq(countRange(a, 0, FIXTURE.length), a.n, "select-all counts every word of every kind");
    const tbl = FIXTURE.indexOf("| Cohort");
    h.eq(countRange(a, tbl, FIXTURE.indexOf(": Tau change")), 10, "a selected table counts its cells");
  }

  // ---------------------------------------------------------------- (D)
  {
    const st = scanSections(FIXTURE, JOURNAL_ROLE_ALIASES);
    h.eq(st.sections.filter((s) => s.level === 1).map((s) => s.words), b.sections.filter((s) => s.top).map((s) => s.words), "sections.ts (scanSections) section words == the budget's");
    h.eq(st.preamble.words, b.preamble.words, "sections.ts preamble words == the budget's");

    // Journal Check: force every limit to 1 so each count is in a message.
    for (const id of ["nature", "science", "cell"]) {
      const base = resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES);
      const style = { ...base, limits: { ...base.limits, abstractWords: 1, abstractWordsHard: 1, mainTextWords: 1, methodsWords: 1 } };
      const f = checkCompliance({ doc: FIXTURE, style, aliases: JOURNAL_ROLE_ALIASES, legendFor });
      const num = (rule: string) => Number(/~(\d+) words/.exec(f.find((x) => x.ruleId === rule)?.message ?? "")?.[1]);
      const want = wordBudget(a, countRulesFor(base));
      h.eq([num("abstract.too-long"), num("maintext.too-long"), num("methods.too-long")], [want.abstract, want.main, want.methods], `Journal Check (${id}) reports the shared counter's abstract / main / Methods`);
    }

    // Journal export: the assembler (both engines run it inside prepareExport).
    for (const id of ["nature", "science", "cell", "biorxiv"]) {
      const style = resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES);
      const ctx = {
        captions: new Map(Object.entries(CAPTIONS)),
        figures: new Map([
          ["fig-tau", { family: styledFamilyById(style, "figure"), number: 1, panels: ["a", "b"] }],
          ["fig-dose", { family: styledFamilyById(style, "figure"), number: 2, panels: ["a", "b"] }],
          ["fig-ed1", { family: styledFamilyById(style, "extended-data") ?? styledFamilyById(style, "supplementary"), number: 1, panels: [] }],
        ]),
        panels: style.figures.panels,
      };
      const pre = transformQmdForExport(FIXTURE, { ...ctx, legends: "external" } as never);
      const r = await assembleJournalManuscript(pre, { style, stage: "initial", records: {}, ctx: ctx as never, supplementaryFigures: 0, docDir: "paper" });
      const want = wordBudget(a, countRulesFor(style));
      h.eq(
        [r.report.meta.abstractWords, r.report.counts.mainTextWords, r.report.counts.methodsWords],
        [want.abstract, want.main, want.methods],
        `journal export (${id}): assembled abstract / main / Methods == the editor's count of the source`,
      );
      h.eq(r.report.counts.legendWords.filter((l) => !l.extended).map((l) => l.words), [9, 5], `journal export (${id}): legend words count the caption, not the "Figure 1" lead`);
      if (id === "nature") {
        const md = summaryMarkdown(buildExportSummary({ style, stage: "initial", format: "docx", report: r.report }));
        h.ok(md.includes(`~${want.main}/${style.limits.mainTextWords} words`), `export summary prints the same main-text count (~${want.main}/${style.limits.mainTextWords})`);
      }
    }
  }

  // ---------------------------------------------------------------- (E)
  {
    const core = await import("../flux-core/index");
    const { collectFacts } = await import("../flux-core/connect/collect");
    const { detectAgentIdentity } = await import("../flux-core/agentIdentity");
    const root = path.join(scratch, "project");
    await core.scaffold(root, { title: "Word count parity" });
    const realRoot = await fs.realpath(root);
    const manifest = JSON.parse(await fs.readFile(path.join(realRoot, "project.json"), "utf8"));
    const docRel: string = manifest.manuscript.path;
    await fs.writeFile(path.join(realRoot, docRel), FIXTURE);
    const { facts } = await collectFacts({ root: realRoot, depth: "core", packId: "wc", createdAt: "", identity: detectAgentIdentity({}), sessionName: null, live: false });
    const doc = facts.project?.docs.find((d) => d.path === docRel);
    h.ok(!!doc, `flux-core collectFacts lists ${docRel}`);
    h.eq(doc?.words, mainTextWords(FIXTURE), "twin-engine parity: flux-core's document words == the GUI core's main-text count");
    const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
    h.ok(/from "\.\.\/\.\.\/src\/lib\/manuscript\/wordBudget"/.test(src("flux-core/connect/collect.ts")), "flux-core imports the one shared module (no copy)");
    h.ok(/lib\/manuscript\/wordCount"/.test(src("src/shell/modes/paper/wordCounts.svelte.ts")) && /lib\/manuscript\/wordBudget"/.test(src("src/shell/modes/paper/wordCounts.svelte.ts")), "the GUI's word counts import the same module");
    h.ok(/proseWords/.test(src("src/lib/style/journalManuscript.ts")) && /wordBudget/.test(src("src/lib/manuscript/compliance.ts")) && /proseWords/.test(src("src/lib/manuscript/sections.ts")), "journal assembly, Journal Check and sections.ts count through the shared core");
  }

  // ---------------------------------------------------------------- (F)
  {
    const roots = ["src/shell/modes/paper", "src/lib/manuscript", "src/lib/style", "flux-core/connect"];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(path.join(ROOT, d))) {
        const rel = `${d}/${n}`;
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|svelte)$/.test(n)) files.push(rel);
      }
    };
    roots.forEach(walk);
    const offenders = files.filter((f) => /\.match\(\/(?:\[\^\\s\]|\\S)\+\/g\)[^;\n]*\.length/.test(readFileSync(path.join(ROOT, f), "utf8")));
    h.eq(offenders, [], "census: no private `\\S+` word counter left beside the shared core");
  }
} catch (e) {
  h.fail(`run threw: ${String((e as Error)?.stack ?? e)}`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}

await h.done();
