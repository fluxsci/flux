// P5 — Library fetch-outcome pills (LR-7). The failure categorizer `fetchOutcome` is pure, so it
// gets a real unit test; the LibraryMode wiring (one eager `failures` map → derived failedKeys →
// per-row pill) is asserted against source, since the pill UI needs a FluxLib populated with
// fetch-failure records that the headless harness can't stage.
//   Run: npx tsx scripts/verify-p5-library.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchOutcome, type FetchFailure } from "../src/lib/references/items.ts";

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

const mk = (over: Partial<FetchFailure>): FetchFailure => ({
  key: "k",
  target: "10.1/x",
  attemptedAt: "2026-01-01T00:00:00Z",
  attempts: 1,
  ...over,
});

console.log("LR-7 — fetchOutcome categorizer (pure):");
assert(fetchOutcome(mk({ oa: "no-id" })) === "no-id", "oa:'no-id' → no-id (no DOI to even try)");
assert(fetchOutcome(mk({ oa: "no-oa" })) === "no-oa", "oa:'no-oa' → no-oa (no OA copy, proxy route also failed)");
assert(fetchOutcome(mk({ oa: "some upstream error" })) === "failed", "an OA error string → failed");
assert(
  fetchOutcome(mk({ proxy: { reason: "no-affordances", landedUrl: "https://publisher" } })) === "failed",
  "a proxy-only failure (no oa field) → failed",
);
assert(fetchOutcome(mk({})) === "failed", "a bare record with neither field → failed (a route erred)");

console.log("\nLR-7 — LibraryMode wiring (source):");
const lib = readFileSync(join(root, "src/shell/modes/library/LibraryMode.svelte"), "utf8");

// The single eager source of truth + derived set (replacing the old lazy failedKeys/failureInfo pair).
assert(/import\s*\{[^}]*\blistFailures\b/.test(lib), "imports listFailures (eager failure map)");
assert(/import\s*\{[^}]*\bfetchOutcome\b/.test(lib), "imports fetchOutcome (the categorizer)");
assert(/let\s+failures\s*=\s*\$state\.raw<Record<string, FetchFailure>>/.test(lib), "failures is the eager $state.raw map");
assert(/const\s+failedKeys\s*=\s*\$derived\(new Set\(Object\.keys\(failures\)\)\)/.test(lib), "failedKeys derives from failures");
assert(!/\blistFailedKeys\b/.test(lib), "old listFailedKeys import/usage is gone");
assert(!/\bfailureInfo\b/.test(lib), "old lazy failureInfo map is gone");
assert(!/\breadFetchFailure\b/.test(lib), "old per-row lazy readFetchFailure load is gone");

// The pill itself: categorized label + tone class, wired to expand for the detail banner.
assert(/const\s+outcomePill\s*=/.test(lib), "outcomePill(key) helper present");
assert(/OUTCOME_PILL\b/.test(lib) && /"no DOI"/.test(lib) && /"no OA"/.test(lib), "pill labels cover no-DOI / no-OA / failed");
assert(/class="fpill t-\{pill\.tone\}"/.test(lib), "row renders the categorized .fpill with a tone class");
assert(/\.fpill\.t-danger/.test(lib) && /\.fpill\.t-muted/.test(lib), "both pill tones are styled");
assert(/failures\[nfc\(r\.key\)\]/.test(lib), "expand banner reads the eager failures map (NFC-keyed)");

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

if (failures) {
  console.error(`\nP5 LIBRARY VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nP5 LIBRARY VERIFY: PASS");
