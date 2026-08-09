// Pure gate for the reserved folders under plots/ (electron/plotsFolders.js) — the rule that
// decides whether a path under plots/ is composable content or companion material Flux keeps
// out of the way.
//
// The properties that matter:
//   1. CONTAINMENT — plots/_lighttable/ (and plots/_dissections/) must be invisible to a plain
//      Plot Importer search, must never wake the plots re-sync sweep, and must not be walked
//      as candidate plots; everything else under plots/ (pasted/, paper_snips/, the user's own
//      folders, and every lookalike name) keeps behaving exactly as before.
//   2. REACHABILITY — reserved is hidden, not sealed: the rules expose the reserved names and
//      the scope rule the importer needs to let a user type "_", enter one, and search inside.
//
// This imports the SHIPPED rules through the renderer wrapper (src/lib/project/plotsFolders),
// so it asserts what the app runs, not a copy — and source-shape checks pin that main.cjs, the
// Plot Importer, and the dissections walker route through the shared module rather than a
// private regex or a hardcoded name.
//
// Run: npx tsx scripts/verify-plots-folders.ts
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { harness } from "./lib/harness.mjs";
import {
  LIGHTTABLE_DIRNAME,
  LIGHTTABLE_REL,
  RESERVED_PLOT_FOLDERS,
  RESERVED_PLOT_DIRNAMES,
  isReservedPlotDirName,
  isLighttableProjectRel,
  reservedRootOfPlotsRel,
} from "../src/lib/project/plotsFolders";
import { DISSECT_DIRNAME } from "../src/lib/dissect/rules";

const h = harness("verify-plots-folders");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

h.section("the reserved set");
h.eq(LIGHTTABLE_REL, `plots/${LIGHTTABLE_DIRNAME}`, "the project-relative root derives from the one dirname constant");
h.eq(RESERVED_PLOT_DIRNAMES, [DISSECT_DIRNAME, LIGHTTABLE_DIRNAME], "both reserved folders, dissections first");
h.ok(
  RESERVED_PLOT_FOLDERS.every((f) => typeof f.hint === "string" && f.hint.length > 0),
  "every reserved folder carries the one-line hint the importer shows beside its row",
);
h.ok(
  RESERVED_PLOT_DIRNAMES.every((n) => n.startsWith("_")),
  "reserved names are underscore-prefixed — that is what makes typing '_' the way in",
);

h.section("name-exactness: only the real folders are reserved");
for (const n of [DISSECT_DIRNAME, LIGHTTABLE_DIRNAME]) h.ok(isReservedPlotDirName(n), `reserved: ${n}`);
for (const n of ["_lighttableX", "lighttable", "_light_table", "_LIGHTTABLE", "my_lighttable", "", "_"])
  h.ok(!isReservedPlotDirName(n), `NOT reserved: ${JSON.stringify(n)}`);

h.section("containment: what is (and is not) lighttable material");
for (const rel of [
  "plots/_lighttable",
  "plots/_lighttable/sweep/cell_007.png",
  "plots/_lighttable/sweep/smoothing-0.1/cell_012.png",
  "plots\\_lighttable\\sweep\\cell_007.png", // windows separators normalize
])
  h.ok(isLighttableProjectRel(rel), `lighttable material: ${rel}`);
for (const rel of [
  "plots/growth.svg",
  "plots/pasted/shot.png",
  "plots/paper_snips/fig2.png",
  "plots/sub/charlie.svg",
  "plots/_dissections/growth/subj01.png", // the OTHER reserved folder is not this one
  "plots/_lighttableX/y.png", // name-prefix lookalike
  "plots/my_lighttable/y.png", // name-suffix lookalike
  "plots/_lighttable.png", // a FILE the user named that way
  "fig/assets/abc.svg",
  "manuscript/main.qmd",
])
  h.ok(!isLighttableProjectRel(rel), `NOT lighttable material: ${rel}`);

h.section("the scope rule: which reserved folder a plots/-relative path sits under");
h.eq(reservedRootOfPlotsRel("_lighttable/sweep/cell_007.png"), LIGHTTABLE_DIRNAME, "inside lighttable");
h.eq(reservedRootOfPlotsRel("_lighttable"), LIGHTTABLE_DIRNAME, "the folder itself");
h.eq(reservedRootOfPlotsRel("_dissections/growth"), DISSECT_DIRNAME, "inside dissections");
h.eq(reservedRootOfPlotsRel(""), "", "the plots/ root is not scoped");
h.eq(reservedRootOfPlotsRel("sub/charlie.svg"), "", "an ordinary subfolder is not scoped");
h.eq(reservedRootOfPlotsRel("sub/_lighttable/x.png"), "", "the scope rule reads the FIRST segment only — a nested lookalike does not scope");

h.section("the headless walker skips reserved folders (flux-core/dissect)");
{
  const { listDissections } = await import("../flux-core/dissect");
  const tmp = mkdtempSync(join(tmpdir(), "flux-plotsfolders-"));
  try {
    mkdirSync(join(tmp, "plots", "_dissections", "growth"), { recursive: true });
    mkdirSync(join(tmp, "plots", "_lighttable", "sweep", "smoothing-0.1"), { recursive: true });
    writeFileSync(join(tmp, "plots", "growth.svg"), "<svg/>");
    writeFileSync(join(tmp, "plots", "_dissections", "growth", "overview.svg"), "<svg/>");
    writeFileSync(join(tmp, "plots", "_lighttable", "sweep", "smoothing-0.1", "cell_007.png"), "x");
    // A lighttable image that would otherwise key a dissection folder of its own.
    mkdirSync(join(tmp, "plots", "_dissections", "_lighttable", "sweep", "smoothing-0.1", "cell_007"), {
      recursive: true,
    });
    writeFileSync(
      join(tmp, "plots", "_dissections", "_lighttable", "sweep", "smoothing-0.1", "cell_007", "zoom.png"),
      "x",
    );
    const all = listDissections(tmp) as { plot: string }[];
    h.eq(all.map((d) => d.plot), ["growth"], "only real plots are enumerated — lighttable images are never candidate plots");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

h.section("the shipped consumers route through the shared rule (no private copies)");
{
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const main = readFileSync(join(repo, "electron", "main.cjs"), "utf8");
  h.ok(/plotsFolders\.js/.test(main), "main.cjs loads the shared reserved-folder rules");
  h.ok(
    /isLighttableProjectRel/.test(main),
    "main.cjs classifies lighttable paths via isLighttableProjectRel",
  );
  h.ok(
    /ignored:\s*\(p\)\s*=>[^\n]*isPrunedWatchPath/.test(main),
    "the project watcher PRUNES the lighttable subtree rather than watching it to discard events",
  );
  h.ok(!/_lighttable/.test(strip(main)), "main.cjs carries NO private copy of the folder name (comments aside)");

  const importer = readFileSync(join(repo, "src", "lib", "PlotImporter.svelte"), "utf8");
  h.ok(/isReservedPlotDirName/.test(importer), "PlotImporter hides reserved folders via the shared rule");
  h.ok(/reservedRootOfPlotsRel/.test(importer), "…and scopes its search cache via the shared scope rule");
  h.ok(/RESERVED_PLOT_FOLDERS/.test(importer), "…and offers the reserved rows from the shared list");
  h.ok(
    !/"_lighttable"|'_lighttable'|"_dissections"|'_dissections'/.test(importer),
    "PlotImporter carries no private copy of either folder name",
  );

  const core = readFileSync(join(repo, "flux-core", "dissect.ts"), "utf8");
  h.ok(
    /isReservedPlotDirName/.test(core) && !/isDissectDirName/.test(strip(core)),
    "the dissections walker skips the whole reserved set, not just _dissections",
  );
}

await h.done();
