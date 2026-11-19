// P5 — Library: the bulk-fetch summary survives a mode switch (LR-7) and the multiselect
// add-to-project persists (LR-U2), asserted against source.
//
// This gate used to pin LR-7's per-row fetch-outcome pills (no DOI / no OA / failed), read from
// items/<key>/fetch-failure.json records that the bulk run wrote when the open-access route AND
// the library sign-in route both failed. The sign-in route was removed (owner decision
// 2026-11-18); with one route those records are no longer written or read, so the pill contract
// is superseded. What must hold instead is that none of it comes back half-wired.
//   Run: npx tsx scripts/verify-p5-library.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as items from "../src/lib/references/items.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  } else {
    console.log("  ok:", msg);
  }
}

console.log("LR-7 — the outcome pill and its failure records are gone:");
const lib = readFileSync(join(root, "src/shell/modes/library/LibraryMode.svelte"), "utf8");
const itemsBridge = readFileSync(join(root, "src/lib/references/itemsBridge.ts"), "utf8");
assert(!("fetchOutcome" in items) && !("failurePath" in items), "items.ts no longer exports the failure categorizer or path");
assert(!/fetch-failure\.json/.test(readFileSync(join(root, "src/lib/references/items.ts"), "utf8")), "items.ts no longer names the failure file");
assert(!/\b(writeFetchFailure|readFetchFailure|clearFetchFailure|listFailedKeys|listFailures)\b/.test(itemsBridge), "itemsBridge has no failure-record reader or writer");
assert(!/\boutcomePill\b|\bOUTCOME_PILL\b|class="fpill/.test(lib), "no per-row outcome pill in the Library");
assert(!/\.fpill\b|\.failbanner\b/.test(lib), "no orphaned pill / banner CSS");
assert(!/\bfailures\b\s*=\s*\$state/.test(lib), "no eager failure map state");

console.log("\nLR-7 — bulk-fetch summary survives a mode switch (source):");
const job = readFileSync(join(root, "src/lib/references/pdfFetchJob.svelte.ts"), "utf8");
assert(/runSeq\s*=\s*\$state\(0\)/.test(job), "job exposes a runSeq (bumped per finished run)");
assert(/lastSummary\s*=\s*\$state<GuiFetchSummaryLite \| null>/.test(job), "job retains lastSummary after completion");
assert(/this\.lastSummary\s*=\s*summary/.test(job) && /this\.runSeq\+\+/.test(job), "#finish records lastSummary + bumps runSeq");
assert(/#reset\(\)[\s\S]{0,400}/.test(job) && !/#reset\(\)\s*\{[^}]*lastSummary/.test(job), "#reset does NOT clear lastSummary (it persists between runs)");
// The Library surfaces it from the singleton, once per run, across remounts.
assert(/<script module lang="ts">/.test(lib), "LibraryMode has a module script (cross-remount state)");
assert(/let\s+shownFetchSeq\s*=\s*0/.test(lib), "shownFetchSeq marks the last surfaced run (module-scoped)");
assert(
  /if\s*\(!sum \|\| seq <= shownFetchSeq\) return;[\s\S]{0,120}shownFetchSeq = seq;[\s\S]{0,80}showFetchSummary\(sum\)/.test(lib),
  "completion $effect shows each unseen finished run exactly once",
);
assert(/function showFetchSummary\(sum: GuiFetchSummaryLite\)/.test(lib), "showFetchSummary renders the summary pill");
assert(!/const sum = await pdfFetchJob\.start/.test(lib), "getAllPdfs no longer depends on its own awaited summary (lost on unmount)");

console.log("\nLR-U2 — multiselect bulk add-to-project (source — the persist path the UI test skips):");
assert(/import\s*\{[^}]*\bmaterializeIntoProject\b/.test(lib), "imports materializeIntoProject (the idempotent project-bib append)");
assert(/import\s*\{\s*currentProject\s*\}\s*from\s*"\.\.\/\.\.\/shellStore"/.test(lib), "imports the open-project store");
assert(/async function addSelectedToProject\(\)/.test(lib), "addSelectedToProject handler present");
assert(
  /const \{ added \} = await materializeIntoProject\(root, keys\)/.test(lib),
  "addSelectedToProject materializes the selected keys into the open project",
);
assert(/const projectRoot = \$derived\(\$currentProject\?\.path/.test(lib), "add is gated on an open project root (disabled otherwise)");

if (failures) {
  console.error(`\nP5 LIBRARY VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nP5 LIBRARY VERIFY: PASS");
