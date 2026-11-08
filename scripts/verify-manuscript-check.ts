// Manuscript Check — the pure gate (pure tier, hermetic).
//
//   A. The ONE citation scanner (lib/manuscript/citations.ts): masks front
//      matter, fenced/inline code and math; buildCitationOrdinals reads it; and
//      flux-core carries no private citation regex any more (source census).
//   B. Rule corpus, pack by pack: fixtures with KNOWN defects → the EXACT
//      findings (rule, line, excerpt), with named negatives (a @sec- that
//      resolves, a cite in code or math, "(n = 5)", "(SLAP2)" after an
//      unrelated phrase, a TODO in a fence, a shouted line…).
//   C. Fixes: every offered fix applies, and the re-check no longer reports
//      it; a fix whose text moved on is refused (the `expect` guard).
//   D. Scale: the whole run on the 20k-line paper scale fixture is recorded
//      (the GUI runs it in a worker; verify-manuscript-check-gui pins that).
//   E. Twin-engine parity: the REAL `flux check --json` CLI, flux-core's
//      checkManuscriptDoc, the MCP render and the pure call over
//      independently projected inputs produce identical findings.
//
//   Run: node scripts/run-verifies.mjs --tier pure --only manuscript-check
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import { scaleDoc } from "./lib/manuscriptCheckFixture.mjs";
import { tsxRun } from "./lib/tsxRun.mjs";
import {
  checkManuscript,
  applyCheckFix,
  checkBibEntries,
  commentInputs,
  formatCheckReport,
  type CheckFigure,
  type CheckInput,
  type CheckResult,
} from "../src/lib/manuscript/checks/index";
import { scanCitations, citedKeysIn, buildCitationOrdinals } from "../src/lib/manuscript/citations";

const h = harness("verify-manuscript-check");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Hermetic machine state BEFORE flux-core loads (scaffold ensures FluxLib).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-mcheck-"));
const home = path.join(scratch, "home");
fs.mkdirSync(path.join(home, ".config"), { recursive: true });
fs.mkdirSync(path.join(home, "AppData", "Roaming"), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.APPDATA = path.join(home, "AppData", "Roaming");
process.env.FLUX_NO_MIGRATE = "1";

type Row = [ruleId: string, line: number, excerpt: string];
const rows = (r: CheckResult, pack?: string): Row[] =>
  r.findings.filter((f) => !pack || f.pack === pack).map((f) => [f.ruleId, f.line ?? 0, f.excerpt ?? ""]);
const run = (text: string, extra: Partial<CheckInput> = {}) =>
  checkManuscript({ doc: "paper/main.qmd", text, figures: [], bib: [], ...extra });

// =============================================================================
h.section("A. one citation scanner");
{
  const doc = [
    "---",
    "note: '@yaml2020 in front matter'",
    "---",
    "Body cites @smith2020. and [@lee2021; @kim2019, p. 3].",
    "Code `@code2020` and math $@math2020$ and $$@display2020$$ are not citations.",
    "```",
    "@fence2020",
    "```",
    "Cross-refs @fig-a, @tbl-b, @eq-c, @sec-d are not citations; mail a@b.org is not one.",
  ].join("\n");
  h.eq(citedKeysIn(doc), ["smith2020", "lee2021", "kim2019"], "scanCitations masks front matter, code, math, fences and cross-refs");
  const occ = scanCitations(doc);
  h.ok(occ.every((o) => doc.slice(o.from, o.to).includes("@" + o.key)), "every occurrence range holds its @key");
  const ord = buildCitationOrdinals(doc, (k) => k !== "lee2021");
  h.eq([...ord.map], [["smith2020", 1], ["kim2019", 2]], "buildCitationOrdinals numbers through the shared scan (unknown keys unnumbered)");
  h.eq(ord.ranges.length, occ.length, "ordinal ranges are exactly the scanner's occurrences");
  const src = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");
  h.ok(!/function citationKeysIn|CITE_RE\s*=/.test(src("flux-core/manuscript.ts") + src("flux-core/fluxlib.ts")),
    "flux-core carries no private citation regex (compile summary + reconcile use the shared scanner)");
  h.ok(/citedKeysIn/.test(src("flux-core/manuscript.ts")) && /citedKeysIn/.test(src("flux-core/fluxlib.ts")),
    "flux-core compile summary and FluxLib reconcile import citedKeysIn");
  h.ok(/citedKeysIn\(latestIdle\)/.test(src("src/shell/modes/paper/PaperMode.svelte")),
    "Paper's cited-keys set (References red dots) reads the shared scanner");
}

// =============================================================================
h.section("B1. references & citations");
const figGrowth: CheckFigure = { label: "fig-growth", family: "figure", number: 1, display: "Fig. 1", caption: "Growth.", panels: ["a", "b"] };
const figExtra: CheckFigure = { label: "fig-extra", family: "figure", number: 2, display: "Fig. 2", caption: "Extra.", panels: [] };
const bib = checkBibEntries([
  { key: "smith2020", title: "Hyphal growth under nutrient stress in soil fungi", authors: ["Smith"], year: "2020", container: "Nature", doi: "10.1000/ABC", raw: "@article{smith2020," },
  { key: "jones2019", title: "A model of branching", authors: ["Jones"], year: "", container: "Cell", raw: "@article{jones2019," },
  { key: "smith2020a", title: "Hyphal growth under nutrient stress (preprint)", authors: ["Smith"], year: "2019", container: "bioRxiv", doi: "https://doi.org/10.1000/abc", raw: "@article{smith2020a," },
  { key: "book2001", title: "Fungi", authors: ["Webster"], year: "2001", raw: "@book{book2001," },
]);
const refDoc = [
  "---", // 1
  'title: "R"', // 2
  "---", // 3
  "", // 4
  "# Introduction {#sec-intro}", // 5
  "", // 6
  "As shown in @fig-growth and @fig-growth-b, growth rises (@fig-growth-c). See @fig-grwth.", // 7
  "Table @tbl-counts summarises counts; @tbl-nope does not exist. Equation @eq-rate holds.", // 8
  "Back to @sec-intro and on to @sec-missing. Also @fig-extra.", // 9
  "Prior work [@smith2020; @jones2019] and @ghost2021, @smith2020a and @book2001.", // 10
  "Inline code `@nocode2020 @fig-nocode` and math $@math2020 + @fig-math$ are ignored.", // 11
  "", // 12
  "```", // 13
  "@fence2020 @fig-fenced {#tbl-fenced}", // 14
  "```", // 15
  "", // 16
  "| A | B |", // 17
  "|---|---|", // 18
  "| 1 | 2 |", // 19
  "", // 20
  ": Counts {#tbl-counts}", // 21
  "", // 22
  "$$", // 23
  "r = k t", // 24
  "$$ {#eq-rate}", // 25
  "", // 26
  "$$ s = 1 $$ {#eq-unused}", // 27
  "", // 28
  "![](../fig/renders/growth.svg){#fig-growth}", // 29
  "", // 30
  "![](../fig/renders/ghost.svg){#fig-ghost}", // 31
  "", // 32
  "# Methods {#sec-intro}", // 33
].join("\n");
const refRes = run(refDoc, { figures: [figGrowth, figExtra], bib });
h.eq(rows(refRes, "references"), [
  ["ref.missing-panel", 7, "@fig-growth-c"],
  ["ref.undefined-crossref", 7, "@fig-grwth"],
  ["ref.undefined-crossref", 8, "@tbl-nope"],
  ["ref.undefined-crossref", 9, "@sec-missing"],
  ["cite.incomplete-entry", 10, "@jones2019"],
  ["cite.missing-key", 10, "@ghost2021"],
  ["cite.duplicate-reference", 10, "@smith2020a"],
  ["ref.unreferenced-equation", 27, "eq-unused"],
  ["ref.unknown-embed", 31, "fig-ghost"],
  ["ref.duplicate-label", 33, "{#sec-intro}"],
], "references pack: exactly the seeded defects, in document order");
const byRule = (r: CheckResult, id: string, excerpt?: string) => r.findings.find((f) => f.ruleId === id && (!excerpt || f.excerpt === excerpt));
h.eq(byRule(refRes, "ref.undefined-crossref", "@fig-grwth")?.fix?.edits.map((e) => e.insert), ["@fig-growth"],
  "a one-edit-away label offers its exact correction");
h.ok(!byRule(refRes, "ref.undefined-crossref", "@tbl-nope")?.fix, "no near label → no guessed fix");
h.eq(byRule(refRes, "ref.missing-panel")?.message, "Fig. 1 has no panel c (it has panels a and b).", "missing panel names the figure's real panels");
h.ok(byRule(refRes, "cite.duplicate-reference")?.message.includes("10.1000/abc") ?? false, "duplicate DOIs match across case and doi.org prefixes");
h.ok(!refRes.findings.some((f) => /book2001/.test(f.excerpt ?? "")), "a @book without a journal is complete (journal is an article field)");
h.ok(!refRes.findings.some((f) => /nocode|math|fence|fig-nocode|fig-math|fig-fenced|tbl-fenced/.test(f.excerpt ?? "")),
  "negatives: citations / cross-refs / labels in code, math and fences are never read");
h.ok(!refRes.findings.some((f) => f.excerpt === "@sec-intro" || f.excerpt === "@eq-rate" || f.excerpt === "@tbl-counts"),
  "negatives: @sec-intro, @eq-rate and @tbl-counts resolve");
h.eq(refRes.findings.find((f) => f.ruleId === "ref.missing-panel")?.severity, "error", "broken references are errors");

// =============================================================================
h.section("B2. figures & tables (display items)");
const figs: CheckFigure[] = [
  { label: "fig-a", family: "figure", number: 1, display: "Fig. 1", caption: "A.", panels: ["a", "b", "c"] },
  { label: "fig-b", family: "figure", number: 2, display: "Fig. 2", caption: "B.", panels: [] },
  { label: "fig-c", family: "figure", number: 3, display: "Fig. 3", caption: "  ", panels: [] },
  { label: "fig-p", family: "figure", number: 4, display: "Fig. 4", caption: "P.", panels: ["a", "b", "c"] },
  { label: "fig-s1", family: "supplementary", number: 1, display: "Supplementary Fig. 1", caption: "S1.", panels: [] },
  { label: "fig-s2", family: "supplementary", number: 2, display: "Supplementary Fig. 2", caption: "S2.", panels: [] },
];
const dispDoc = [
  "# Results", // 1
  "", // 2
  "First @fig-b, then @fig-a-a and @fig-a. Later @fig-p-a,c only.", // 3
  "Supplementary @fig-s2 comes before @fig-s1. Gao Figure 2D is another paper's figure.", // 4
  "Tables: @tbl-two before @tbl-one, and @tbl-empty.", // 5
  "", // 6
  "| x | y |", // 7
  "|---|---|", // 8
  "| 1 | 2 |", // 9
  "", // 10
  ": One {#tbl-one}", // 11
  "", // 12
  "| x | y |", // 13
  "|---|---|", // 14
  "| 3 | 4 |", // 15
  "", // 16
  ": Two {#tbl-two}", // 17
  "", // 18
  "| x | y |", // 19
  "|---|---|", // 20
  "| 5 | 6 |", // 21
  "", // 22
  ": {#tbl-empty}", // 23
  "", // 24
  "| u | v |", // 25
  "|---|---|", // 26
  "| 7 | 8 |", // 27
  "", // 28
  ": Never cited {#tbl-lonely}", // 29
  "", // 30
  "![](../fig/renders/a.svg){#fig-a}", // 31
  "", // 32
  "![](../fig/renders/c.svg){#fig-c}", // 33
  "", // 34
  "![](../fig/renders/p.svg){#fig-p}", // 35
].join("\n");
const dispRes = run(dispDoc, { figures: figs });
h.eq(rows(dispRes, "display"), [
  ["display.out-of-order", 3, "Fig. 2"],
  ["display.uncited-panels", 3, "Fig. 4"],
  ["display.out-of-order", 4, "Supplementary Fig. 2"],
  ["display.out-of-order", 5, "Table 2"],
  ["display.empty-caption", 19, "Table 3"],
  ["display.uncited", 25, "Table 4"],
  ["display.empty-caption", 33, "Fig. 3"],
  ["display.uncited", 33, "Fig. 3"],
], "display pack: order per family, uncited items, unnamed panels, empty captions");
h.eq(byRule(dispRes, "display.uncited-panels")?.message, "Fig. 4: panel b is never cited.", "uncited panels are named");
h.ok(!dispRes.findings.some((f) => f.pack === "display" && f.excerpt === "Fig. 1"),
  "negative: a figure cited whole and by panel raises nothing; panel citation order inside it is not an order error");
h.ok(dispRes.findings.every((f) => f.pack !== "display" || f.severity !== "error"), "display findings are advice (warn/info), never errors");
h.ok(dispRes.findings.every((f) => !f.fix || f.pack !== "display"), "display findings flag only (renumbering is the author's call)");

// =============================================================================
h.section("B3. placeholders");
const phDoc = [
  "Results TODO and FIXME: later. XXX here. Values TBD.", // 1
  "Missing [citation needed] and [ref] and [??] and Fig. ?? and n = XX mice.", // 2
  "Lorem ipsum dolor. {{< placeholder 300 200 >}}", // 3
  "Repeated [??] [??] markers.", // 4
  "Negatives: `TODO in code`, $TODO$, todo, Todo list, What?? and the XX century.", // 5
  "<!-- TODO: hidden note -->", // 6
  "<!-- a plain comment -->", // 7
  "```", // 8
  "TODO in a fence <!-- TODO fenced -->", // 9
  "```", // 10
].join("\n");
const phRes = run(phDoc, { packs: ["placeholders"] });
h.eq(rows(phRes), [
  ["placeholder.marker", 1, "TODO"],
  ["placeholder.marker", 1, "FIXME:"],
  ["placeholder.marker", 1, "XXX"],
  ["placeholder.marker", 1, "TBD"],
  ["placeholder.marker", 2, "[citation needed]"],
  ["placeholder.marker", 2, "[ref]"],
  ["placeholder.marker", 2, "[??]"],
  ["placeholder.marker", 2, "??"],
  ["placeholder.marker", 2, "= XX"],
  ["placeholder.marker", 3, "Lorem ipsum"],
  ["placeholder.marker", 3, "{{< placeholder 300 200 >}}"],
  ["placeholder.marker", 4, "[??]"],
  ["placeholder.marker", 4, "[??]"],
  ["placeholder.comment-note", 6, "<!-- TODO: hidden note -->"],
], "placeholders pack: every marker, nothing from code / math / prose look-alikes / fences");
const repeat = phRes.findings.filter((f) => f.fix);
h.eq(repeat.map((f) => [f.line, f.fix!.label]), [[4, "Remove the repeat"]], "only the repeated placeholder carries a fix");

// =============================================================================
h.section("B4. abbreviations");
const abDoc = [
  "# Introduction", // 1
  "", // 2
  "LTP is common. Long-term potentiation (LTP) shapes memory; LTP-dependent changes and LTPs follow.", // 3
  "We recorded excitatory postsynaptic currents (EPSCs) once.", // 4
  "The mean was 3 (n = 5), see (Fig. 2), and the (SLAP2) sensor (SD) was bright.", // 5
  "Again, long-term potentiation (LTP) is defined twice.", // 6
  "fMRI (functional magnetic resonance imaging) maps activity, and fMRI is used.", // 7
  "The BDNF level rose; DNA and PCR are common. RESULTS ARE SHOUTED HERE NOW XIV.", // 8
  "Code `ABCD` and math $WXYZ$ are ignored; so is chapter XIV.", // 9
].join("\n");
const abRes = run(abDoc, { packs: ["abbreviations"] });
h.eq(rows(abRes), [
  ["abbr.used-before-definition", 3, "LTP"],
  ["abbr.defined-unused", 4, "excitatory postsynaptic currents (EPSCs)"],
  ["abbr.defined-twice", 6, "long-term potentiation (LTP)"],
  ["abbr.undefined", 8, "BDNF"],
], "abbreviations pack: before-definition, unused, repeated, undefined — and nothing else");
h.ok(!abRes.findings.some((f) => /SLAP2|SD\b|ABCD|WXYZ|XIV|fMRI|RESULTS|DNA|PCR/.test(f.excerpt ?? "")),
  "negatives: (n = 5), (Fig. 2), (SLAP2)/(SD) after unrelated words, code, math, Roman numerals, shouting, DNA/PCR, a used abbr-first definition");
const firstUse = byRule(abRes, "abbr.used-before-definition")!;
h.eq(applyCheckFix(abDoc, firstUse.fix!.edits)?.split("\n")[2],
  "Long-term potentiation (LTP) is common. LTP shapes memory; LTP-dependent changes and LTPs follow.",
  "define-at-first-use moves the definition up (sentence-initial capital kept)");

// =============================================================================
h.section("B5. comments");
const cDoc = "Alpha beta gamma.\nDelta epsilon.\n";
const threads = [
  { id: "t1", resolved: false, anchor: { start: 99, end: 104, quote: "Delta" } }, // stale offsets → quote search
  { id: "t2", resolved: true, anchor: { start: 0, end: 5, quote: "Alpha" } },
  { id: "t3", resolved: false, anchor: { start: 6, end: 10, quote: "beta" } },
];
const cRes = run(cDoc, { comments: commentInputs(threads, cDoc) });
h.eq(rows(cRes), [["comments.open", 1, "beta"]], "one finding counts the open threads and jumps to the first");
h.eq(cRes.findings[0]?.message, "2 comment threads are still open.", "resolved threads are not counted");
h.eq(commentInputs(threads, cDoc)[0], { id: "t1", resolved: false, quote: "Delta", from: 18, to: 23 }, "stale offsets fall back to the quote's place");
h.eq(run(cDoc, { comments: commentInputs(threads.map((t) => ({ ...t, resolved: true })), cDoc) }).findings, [],
  "every thread resolved → the finding clears (a count that can reach zero)");

// =============================================================================
h.section("C. fixes apply exactly once, guarded");
for (const [name, text, input] of [
  ["references", refDoc, { figures: [figGrowth, figExtra], bib }],
  ["placeholders", phDoc, {}],
  ["abbreviations", abDoc, {}],
] as [string, string, Partial<CheckInput>][]) {
  const before = run(text, input);
  for (const f of before.findings.filter((x) => x.fix)) {
    const after = applyCheckFix(text, f.fix!.edits);
    h.ok(after != null, `${name}: "${f.fix!.label}" applies (${f.ruleId} ${f.excerpt})`);
    if (after == null) continue;
    const again = run(after, input);
    const same = again.findings.filter((x) => x.ruleId === f.ruleId && x.excerpt === f.excerpt);
    const was = before.findings.filter((x) => x.ruleId === f.ruleId && x.excerpt === f.excerpt);
    h.ok(same.length === was.length - 1, `${name}: after the fix the re-check reports one fewer ${f.ruleId} "${f.excerpt}"`);
    const e = f.fix!.edits[0];
    const moved = text.slice(0, e.from) + "X" + text.slice(e.from);
    h.eq(applyCheckFix(moved, f.fix!.edits), null, `${name}: a fix whose text moved on is refused (${f.ruleId})`);
  }
}
const fixAll = run(abDoc, { packs: ["abbreviations"] }).findings.find((f) => f.ruleId === "abbr.defined-twice")!;
h.eq(applyCheckFix(abDoc, fixAll.fix!.edits)?.split("\n")[5], "Again, LTP is defined twice.", "a repeated definition collapses to the bare abbreviation");

// =============================================================================
h.section("D. scale (20k-line paper scale fixture)");
{
  const text = scaleDoc(20000);
  const figures = Array.from({ length: 20 }, (_, i) => ({ label: `fig-scale${i}`, family: "figure", number: i + 1, display: `Fig. ${i + 1}`, caption: "c", panels: [] }));
  const sbib = Array.from({ length: 40 }, (_, i) => ({ key: `smith${i}2020`, type: "article", title: `Title ${i}`, authors: ["S"], year: "2020", container: "J" }));
  const times: number[] = [];
  let res: CheckResult | null = null;
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    res = checkManuscript({ doc: "scale.qmd", text, figures, bib: sbib });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  console.log(`  20k lines (${(text.length / 1e6).toFixed(2)} MB): median ${median.toFixed(1)} ms, min ${times[0].toFixed(1)} ms, ${res!.findings.length} findings`);
  fs.mkdirSync(path.join(repoRoot, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "test-results", "manuscript-check-scale.json"),
    JSON.stringify({ lines: 20000, chars: text.length, medianMs: median, minMs: times[0], findings: res!.findings.length }, null, 2));
  h.ok(res!.findings.length > 0 && res!.counts.error > 0, "the scale fixture's dangling @lee2021 / @fig-scale cites are found");
  // Hang guard only (the run is linear; machines vary). The GUI never pays
  // this on the main thread: it runs in a worker (verify-manuscript-check-gui).
  h.ok(median < 1500, `a whole-document run is linear and bounded (median ${median.toFixed(1)} ms < 1500 ms hang guard)`);
}

// =============================================================================
h.section("E. twin-engine parity: CLI == flux-core == MCP == pure call");
const { VERBS } = await import("../flux-core/registry");
const core = await import("../flux-core/index");
const { familyById, formatFamilyRef } = await import("../src/lib/figfamily");
const { composeCaption, panelLetters } = await import("../src/lib/captions");
const { lightBibEntries } = await import("../src/lib/references/bibtex");
const root = path.join(scratch, "proj");
try {
  await core.scaffold(root, { title: "Check parity" });
  fs.mkdirSync(path.join(root, "plots"), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect x="10" y="10" width="40" height="30" fill="#456"/></svg>`;
  fs.writeFileSync(path.join(root, "plots", "p1.svg"), svg);
  fs.writeFileSync(path.join(root, "plots", "p2.svg"), svg);
  await core.composeFigure(root, [path.join(root, "plots", "p1.svg"), path.join(root, "plots", "p2.svg")], { id: "growth", captionStub: false });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8"));
  const docRel: string = manifest.manuscript.path;
  const text = [
    "# Results",
    "",
    "Growth rose (@fig-growth-c), see @fig-nothing and [@smith2020; @ghost2021]. TODO [??]",
    "We used long-term potentiation (LTP) and later LTP, plus BDNF.",
    "",
    "![](../fig/renders/growth.svg){#fig-growth}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(root, docRel), text);
  fs.mkdirSync(path.join(root, "references"), { recursive: true });
  const bibText = "@article{smith2020,\n  title = {Hyphal growth},\n  author = {Smith, A.},\n  year = {2020}\n}\n";
  fs.writeFileSync(path.join(root, "references", "library.bib"), bibText);
  const { commentsSidecarRel, commentsMainPath } = await import("../src/lib/project/docOrder");
  const sidecar = path.join(root, commentsSidecarRel(commentsMainPath(manifest), docRel));
  const threads = [{ id: "c1", resolved: false, anchor: { start: 0, end: 9, quote: "# Results", prefix: "", suffix: "" }, messages: [{ author: "K", body: "Retitle?", createdAt: "2026-11-08T00:00:00Z" }] }];
  fs.writeFileSync(sidecar, JSON.stringify({ version: 1, threads }, null, 2));

  // Inputs projected the way the Paper editor projects them (scholar/figures.ts
  // loadFigures + bibLoad + the comments sidecar), independently of flux-core/check.ts.
  const { project, index } = await core.loadFigModel(root);
  const figures: CheckFigure[] = (index.figures ?? []).map((entry) => {
    const fig = project.figures.find((f) => f.id === entry.id)!;
    return {
      label: fig.referenceKey ?? entry.label,
      family: fig.family ?? "figure",
      number: fig.number ?? entry.order,
      display: formatFamilyRef(familyById(fig.family, project.figureFamilies), fig.number ?? entry.order),
      caption: composeCaption(fig),
      panels: panelLetters(fig),
    };
  });
  const listed = await core.listComments(root, docRel);
  const pure = checkManuscript({
    doc: docRel,
    text,
    figures,
    bib: checkBibEntries(lightBibEntries(bibText)),
    comments: commentInputs(listed, text),
  });
  h.ok(pure.findings.some((f) => f.ruleId === "ref.missing-panel") && pure.findings.some((f) => f.ruleId === "comments.open"),
    "the parity fixture exercises references, comments and the figure model");
  const viaCore = await core.checkManuscriptDoc(root);
  h.eq(viaCore, pure, "flux-core checkManuscriptDoc == the pure call");

  const [node, args] = tsxRun(path.join(repoRoot, "flux-cli.ts"), ["check", "--json", "--root", root]);
  const cli = spawnSync(node, args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env } });
  h.ok(cli.status === 0, `CLI \`flux check --json\` exits 0 (${cli.status})${cli.status ? " " + cli.stderr.slice(0, 300) : ""}`);
  let cliJson: unknown = null;
  try {
    cliJson = JSON.parse(cli.stdout);
  } catch {
    /* reported below */
  }
  h.eq(cliJson, JSON.parse(JSON.stringify(pure)), "the REAL CLI's JSON == the pure call (byte-for-byte after a JSON round trip)");

  const human = spawnSync(node, [args[0], args[1], "check", "--root", root], { cwd: repoRoot, encoding: "utf8", env: { ...process.env } });
  h.eq(human.stdout.trimEnd(), formatCheckReport(pure), "the CLI's human report is formatCheckReport of the same result");
  const packed = spawnSync(node, [args[0], args[1], "check", "--json", "--pack", "placeholders,comments", "--root", root], { cwd: repoRoot, encoding: "utf8", env: { ...process.env } });
  h.eq(JSON.parse(packed.stdout).findings.map((f: { pack: string }) => f.pack).filter((p: string, i: number, a: string[]) => a.indexOf(p) === i),
    ["placeholders", "comments"], "--pack selects packs");

  const verb = VERBS.find((v) => v.name === "check_manuscript")!;
  h.ok(!!verb && verb.readOnly === true && !verb.core, "check_manuscript is registered, read-only, and not in the compact core toolset");
  const mcp = verb.render!.mcp!(await verb.handler({ root }, {}), {});
  h.eq(JSON.parse((mcp.content[0] as { text: string }).text), JSON.parse(JSON.stringify(pure)), "the MCP result == the pure call");
  let bad = "";
  try {
    await core.checkManuscriptDoc(root, { packs: "references,nonsense" });
  } catch (e) {
    bad = (e as Error).message;
  }
  h.ok(/Unknown check pack nonsense/.test(bad), "an unknown pack is a clear validation error");
} catch (e) {
  h.fail(`parity fixture crashed: ${(e as Error).stack ?? e}`);
}

await h.done(() => fs.promises.rm(scratch, { recursive: true, force: true }));
