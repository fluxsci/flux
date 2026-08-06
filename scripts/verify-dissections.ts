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
import { readFileSync } from "node:fs";
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
