// FigName — pure checks for the figure-designation + panel-spec text helpers
// (scholar/figText.ts). Flux-figure is the source of truth for a figure's
// designation: a name that IS one ("Figure 3", "Figure RENAMED", "Fig S2")
// supplies the display token; descriptive names fall back to the ordinal.
//   Run: npx tsx scripts/verify-figname.ts
import { readFileSync, existsSync } from "node:fs";
import {
  designationFromName,
  nameIsDesignation,
  panelSpec,
  figRefText,
} from "../src/shell/modes/paper/scholar/figText";

let fail = 0;
function eq<T>(what: string, got: T, want: T) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    fail++;
  } else {
    console.log(`ok   ${what}`);
  }
}

// --- designationFromName ---------------------------------------------------
eq("Figure 3", designationFromName("Figure 3"), "3");
eq("figure 12", designationFromName("figure 12"), "12");
eq("Fig 4", designationFromName("Fig 4"), "4");
eq("Fig. 4", designationFromName("Fig. 4"), "4");
eq("Figure S2", designationFromName("Figure S2"), "S2");
eq("Figure RENAMED", designationFromName("Figure RENAMED"), "RENAMED");
eq("padded", designationFromName("  Figure 7  "), "7");
eq("descriptive", designationFromName("Growth curves"), null);
eq("bare word", designationFromName("Figure"), null);
eq("plural", designationFromName("Figures 3"), null);
eq("prefix-word", designationFromName("Figurine 3"), null);
eq("empty", designationFromName(""), null);
eq("isDesignation yes", nameIsDesignation("Figure 3"), true);
eq("isDesignation no", nameIsDesignation("Growth"), false);

// --- panelSpec / figRefText --------------------------------------------------
const F = { label: "fig-x", panels: ["a", "b", "c", "d", "e"] };
eq("none = whole", figRefText(F, []), "@fig-x");
eq("single", figRefText(F, ["b"]), "@fig-x-b");
eq("pair stays comma", figRefText(F, ["a", "b"]), "@fig-x-a,b");
eq("run of 3 collapses", figRefText(F, ["a", "b", "c"]), "@fig-x-a-c");
eq("run + extra", figRefText(F, ["a", "b", "c", "e"]), "@fig-x-a-c,e");
eq("order-independent", figRefText(F, ["e", "c", "a", "b"]), "@fig-x-a-c,e");
eq("all five", figRefText(F, ["a", "b", "c", "d", "e"]), "@fig-x-a-e");
eq("unknown letters ignored", figRefText(F, ["z"]), "@fig-x");

// --- optional real-project index regression (the originally-reported bug) ---
// Point FLUX_FIGNAME_IDX at a real fig/index.json to exercise it; the gate is
// hermetic and simply skips this leg when the env var is unset (no personal path
// baked into a committed gate).
const IDX = process.env.FLUX_FIGNAME_IDX;
if (IDX && existsSync(IDX)) {
  const idx = JSON.parse(readFileSync(IDX, "utf8")) as {
    figures: { name: string; order: number }[];
  };
  const nums = [...idx.figures]
    .sort((a, b) => a.order - b.order)
    .map((f, i) => designationFromName(f.name) ?? String(i + 1));
  console.log(`fluxv1 designations: ${JSON.stringify(nums)}`);
  const renamedFollows = nums.some((n) => n === "RENAMED") || !idx.figures.some((f) => /RENAMED/.test(f.name));
  eq("fluxv1 rename propagates", renamedFollows, true);
} else {
  console.log("FLUX_FIGNAME_IDX not set — skipping optional project regression");
}

if (fail) {
  console.error(`\nFIGNAME VERIFY: FAIL (${fail})`);
  process.exit(1);
}
console.log("\nFIGNAME VERIFY: PASS");
