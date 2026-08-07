// Pure gate for the Dissect feature's shared rules (electron/dissectRules.js) and the
// tolerant CSV/TSV reader (src/lib/dissect/csv.ts).
//
// The two properties that matter most:
//   1. CONTAINMENT — plots/_dissections/ must be invisible to the Plot Importer and must
//      never wake the plots re-sync sweep, while everything the user already has under
//      plots/ (pasted/, paper_snips/, their own subfolders, even lookalike names) keeps
//      behaving exactly as before.
//   2. KEY STABILITY — every shape source.svgPath takes in real projects (absolute from GUI
//      import, project-relative from headless, bare filename from drag-drop, plain asset
//      basenames for pasted PNGs) must resolve to the same dissection folder.
//
// This imports the SHIPPED rules through the renderer wrapper (src/lib/dissect/rules), so it
// asserts what the app runs, not a copy — and source-shape checks pin that main.cjs and the
// Plot Importer actually route through the shared module rather than a private regex.
//
// Run: npx tsx scripts/verify-dissections.ts
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { harness } from "./lib/harness.mjs";
import {
  DISSECT_DIRNAME,
  DISSECT_REL,
  isDissectDirName,
  isDissectionProjectRel,
  isDissectionPlotsRel,
  plotKeyFor,
  dissectionRootRelFor,
  classifyDissectionFile,
} from "../src/lib/dissect/rules";
import { parseDelimited, sniffDelimiter, numericColumns, isNumericCell } from "../src/lib/dissect/csv";

const h = harness("verify-dissections");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

h.section("containment: what is (and is not) dissection material");
h.eq(DISSECT_REL, `plots/${DISSECT_DIRNAME}`, "the project-relative root derives from the one dirname constant");
for (const rel of [
  "plots/_dissections/growth/subj01.png",
  "plots/_dissections/growth/_stats/anova.csv",
  "plots/_dissections/sub/charlie/alt.svg",
  "plots/_dissections",
])
  h.ok(isDissectionProjectRel(rel), `dissection material: ${rel}`);
for (const rel of [
  "plots/growth.svg",
  "plots/pasted/shot.png",
  "plots/paper_snips/fig2.png",
  "plots/sub/charlie.svg",
  "plots/_dissectionsX/y.svg", // name-prefix lookalike
  "plots/foo_dissections/y.svg", // name-suffix lookalike
  "plots/my_dissections.svg", // a FILE the user named that way
  "fig/assets/abc.svg",
  "manuscript/main.qmd",
])
  h.ok(!isDissectionProjectRel(rel), `NOT dissection material: ${rel}`);
h.ok(isDissectionPlotsRel("_dissections/growth/a.png"), "plots-relative form matches");
h.ok(isDissectionPlotsRel("sub/_dissections/x.png"), "hand-nested _dissections still counts (defensive)");
h.ok(!isDissectionPlotsRel("pasted/shot.png"), "plots-relative negative");
h.ok(isDissectDirName("_dissections") && !isDissectDirName("_dissectionsX") && !isDissectDirName("dissections"), "the importer's skip rule is name-exact");

h.section("key stability: every source.svgPath shape → one folder");
const ROOT = "/home/user/my-paper";
h.eq(plotKeyFor(`${ROOT}/plots/growth.svg`, ROOT), "growth", "absolute (GUI import)");
h.eq(plotKeyFor("plots/growth.svg", ROOT), "growth", "project-relative (headless import)");
h.eq(plotKeyFor("growth.svg", ROOT), "growth", "bare filename (drag-drop)");
h.eq(plotKeyFor("growth.png", ROOT), "growth", "pasted/snip PNG basename (no source at all)");
h.eq(plotKeyFor(`${ROOT}/plots/sub/charlie.svg`, ROOT), "sub/charlie", "subfolder plots key by their full relative path");
h.eq(plotKeyFor("plots\\sub\\charlie.svg", ROOT), "sub/charlie", "windows separators normalize");
h.eq(plotKeyFor("/somewhere/else/out/final.svg", ROOT), "final", "external import keys by basename");
h.eq(plotKeyFor(`${ROOT}/plots/pasted/shot.png`, ROOT), "pasted/shot", "pasted archive keys under pasted/");
h.eq(plotKeyFor(`${ROOT}/plots/_dissections/growth/subj01.png`, ROOT), "", "dissection material has no key of its own");
h.eq(plotKeyFor("", ROOT), "", "empty source → no key");
h.eq(plotKeyFor("plots/../../etc/passwd", ROOT), "", "traversal → no key");
h.eq(dissectionRootRelFor("sub/charlie"), "_dissections/sub/charlie", "key → plots/-relative dissection root");

h.section("file classification");
h.eq(classifyDissectionFile("subj01.png"), "image", "png → image");
h.eq(classifyDissectionFile("alt-model.svg"), "image", "svg → image");
h.eq(classifyDissectionFile("photo.JPG"), "image", "jpg (case-blind) → image");
h.eq(classifyDissectionFile("anova.csv"), "table", "csv → table");
h.eq(classifyDissectionFile("means.tsv"), "table", "tsv → table");
h.eq(classifyDissectionFile("alt-model.fluxplot.json"), "sidecar", "fluxplot manifest → sidecar");
h.eq(classifyDissectionFile("alt-model.recipe.json"), "sidecar", "recipe → sidecar");
h.eq(classifyDissectionFile("notes.md"), "other", "md → other (listed, no viewer yet)");
h.eq(classifyDissectionFile("stats.json"), "other", "plain json is NOT a sidecar");

h.section("the tolerant CSV/TSV reader (a viewer, not a validator)");
{
  const t = parseDelimited('name,score,note\nalice,12,"said ""hi"", left"\nbob,3,\n', { name: "x.csv" });
  h.eq(t.header, ["name", "score", "note"], "header = the first row");
  h.eq(t.rows[0], ["alice", "12", 'said "hi", left'], "RFC4180 quotes: embedded delimiter + doubled quotes");
  h.eq(t.rows.length, 2, "trailing newline never yields a phantom row");
  const ragged = parseDelimited("a,b,c\n1,2\n1,2,3,4\n");
  h.eq(ragged.cols, 4, "ragged rows are KEPT (cols = widest row) — strict parseCsv would reject this file");
  h.eq(ragged.rows[0], ["1", "2"], "short rows survive un-padded (render pads)");
  const nl = parseDelimited('a,b\n"line\nbreak",2\n');
  h.eq(nl.rows[0][0], "line\nbreak", "quoted newlines stay inside the field");
  h.eq(nl.rows.length, 1, "…and don't split the row");
  const crlf = parseDelimited("a,b\r\n1,2\r\n");
  h.eq(crlf.rows[0], ["1", "2"], "CRLF line endings");
  h.eq(sniffDelimiter("a\tb\tc\n", ""), "\t", "tab-dominant first line sniffs as TSV");
  h.eq(sniffDelimiter("a,b,c\n", "means.tsv"), "\t", ".tsv extension wins over the sniff");
  h.eq(parseDelimited("a\tb\n1\t2\n").rows[0], ["1", "2"], "TSV parses on the sniffed delimiter");
  const capped = parseDelimited("h\n" + Array.from({ length: 20 }, (_, i) => String(i)).join("\n"), { maxRows: 10 });
  h.ok(capped.truncated && capped.rows.length === 10 && capped.totalRows === 20, "the row cap truncates honestly (truncated + totalRows)");
  h.ok(isNumericCell("-1,234.5e2") && isNumericCell("0.42") && !isNumericCell("v1.2.3") && !isNumericCell("-"), "numeric-cell detection");
  const num = numericColumns(parseDelimited("term,estimate,p\nintake,0.42,0.003\nage,-0.11,0.2\n"));
  h.eq(num, [false, true, true], "numeric columns detected for right-alignment");
}

h.section("the headless half (flux-core/dissect — the list-dissections verb's engine)");
{
  const { listDissections } = await import("../flux-core/dissect");
  const tmp = mkdtempSync(join(tmpdir(), "flux-dissect-"));
  try {
    mkdirSync(join(tmp, "plots", "_dissections", "growth", "by_subject"), { recursive: true });
    mkdirSync(join(tmp, "plots", "_dissections", "sub", "charlie", "_stats"), { recursive: true });
    mkdirSync(join(tmp, "plots", "sub"), { recursive: true });
    writeFileSync(join(tmp, "plots", "growth.svg"), "<svg/>");
    writeFileSync(join(tmp, "plots", "sub", "charlie.svg"), "<svg/>");
    writeFileSync(join(tmp, "plots", "_dissections", "growth", "overview.svg"), "<svg/>");
    writeFileSync(join(tmp, "plots", "_dissections", "growth", "by_subject", "s1.svg"), "<svg/>");
    writeFileSync(join(tmp, "plots", "_dissections", "growth", "by_subject", "s1.fluxplot.json"), "{}");
    writeFileSync(join(tmp, "plots", "_dissections", "sub", "charlie", "_stats", "anova.csv"), "a,b\n1,2\n");
    const all = listDissections(tmp) as { plot: string; files: number; groups: string[] }[];
    h.eq(
      all.map((d) => d.plot),
      ["growth", "sub/charlie"],
      "no-arg summary finds every plot WITH a dissection folder (nested keys included)",
    );
    const g = listDissections(tmp, "growth") as { groups: { group: string; files: { name: string }[] }[]; files: number };
    h.eq(g.groups.map((x) => x.group), ["", "by_subject"], "detail: loose files = the default group, subfolders named");
    h.ok(
      !g.groups.some((x) => x.files.some((f) => f.name.endsWith(".fluxplot.json"))),
      "sidecars are never listed by the verb either",
    );
    // Every plot-argument shape resolves to the same folder — incl. the slash-bearing
    // nested form that once fell into the CLI's root-positional trap (cliRoot: "flags").
    for (const arg of ["sub/charlie", "sub/charlie.svg", "plots/sub/charlie.svg", join(tmp, "plots", "sub", "charlie.svg")]) {
      const d = listDissections(tmp, arg) as { plot: string; files: number };
      h.ok(d.plot === "sub/charlie" && d.files === 1, `plot argument shape resolves: ${arg.startsWith(tmp) ? "<abs>" : arg}`);
    }
    const missing = listDissections(tmp, "nope") as { exists: boolean; files: number };
    h.ok(missing.exists === false && missing.files === 0, "a plot without dissections reports exists:false, never throws");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const verbs = readFileSync(join(repo, "flux-core", "verbs.ts"), "utf8");
  const def = verbs.slice(verbs.indexOf('name: "list_dissections"'), verbs.indexOf('name: "rerun_plot"'));
  h.ok(/cliRoot:\s*"flags"/.test(def), 'list_dissections declares cliRoot: "flags" — a slash-bearing plot positional must never be eaten as the root');
}

h.section("the shipped consumers route through the shared rule (no private regexes)");
{
  const main = readFileSync(join(repo, "electron", "main.cjs"), "utf8");
  h.ok(/dissectRules/.test(main), "main.cjs loads the shared dissect rules");
  h.ok(
    /isDissectionProjectRel/.test(main),
    "main.cjs routes the watcher's dissections subsystem via isDissectionProjectRel",
  );
  h.ok(!/_dissections/.test(main.replace(/\/\/[^\n]*/g, "")), "main.cjs carries NO private copy of the folder name (comments aside)");
  const importer = readFileSync(join(repo, "src", "lib", "PlotImporter.svelte"), "utf8");
  h.ok(/isDissectDirName/.test(importer), "PlotImporter skips via the shared isDissectDirName rule");
  h.ok(!/"_dissections"|'_dissections'/.test(importer), "PlotImporter carries no private copy of the folder name");
}

await h.done();
