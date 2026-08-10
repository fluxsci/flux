#!/usr/bin/env -S npx tsx
// Library PDF filter — the single "PDF state" axis in the FluxLib header.
//
// This replaced a standing "⚠ N failed" pill that sat in the toolbar permanently. That pill
// was wrong twice over: it counted a strict SUBSET of the "No PDF" chip beside it, and for
// true paywalls / the accepted anti-bot walls its count never reaches zero — a warning you
// can't clear is one you learn to ignore. "Failed" is now a step on the PDF filter's own
// cycle, and the retry lives on a plain button that appears only while that step is showing.
//
// What must hold (and what a careless edit would break):
//   1. The cycle visits every state and returns to "all" — no state is a dead end.
//   2. The "failed" step is SKIPPED when nothing has failed, so a clean library never
//      cycles through an empty view. (The old pill hid itself; the step must too.)
//   3. The filter can never STRAND the user on "failed" after the last failure is retried
//      or cleared — that would show an empty list with no way to read why.
//   4. "failed" narrows by the failure records, NOT by PDF presence — a failure record can
//      outlive the missing PDF (a hand-filed PDF via the inbox doesn't clear the record),
//      and folding it into hasPdf() would silently drop those rows from the view.
//   5. The retired affordances stay retired: no showFailedOnly state, and no double-click
//      gesture on the filter chip (it was the only way to reach "retry all" and nobody
//      found it).
//   Run: npx tsx scripts/verify-library-pdffilter.ts
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// --- the cycle, modelled exactly as LibraryMode.cyclePdfFilter() -------------------------
type PdfFilter = "all" | "missing" | "failed" | "have";
function cycle(cur: PdfFilter, failedCount: number): PdfFilter {
  if (cur === "all") return "missing";
  if (cur === "missing") return failedCount > 0 ? "failed" : "have";
  if (cur === "failed") return "have";
  return "all";
}

// (1) With failures present, the cycle is a closed 4-loop back to "all".
{
  const seen: PdfFilter[] = [];
  let s: PdfFilter = "all";
  for (let i = 0; i < 4; i++) {
    seen.push(s);
    s = cycle(s, 8);
  }
  assert(seen.join(" → ") === "all → missing → failed → have", `cycle with failures: ${seen.join(" → ")}`);
  assert(s === "all", "a 4th click returns to 'all' — the filter always clears in-cycle");
}

// (2) With nothing failed, "failed" is never entered — the loop is a 3-cycle.
{
  const seen: PdfFilter[] = [];
  let s: PdfFilter = "all";
  for (let i = 0; i < 3; i++) {
    seen.push(s);
    s = cycle(s, 0);
  }
  assert(seen.join(" → ") === "all → missing → have", `clean library cycle: ${seen.join(" → ")}`);
  assert(s === "all", "the clean-library cycle closes in 3 clicks");
  assert(!seen.includes("failed"), "a library with zero failures never lands on an empty 'failed' view");
}

// (3) The stranding guard: parked on "failed" when the last failure clears → fall back to "all".
{
  const guard = (cur: PdfFilter, failedCount: number): PdfFilter => (cur === "failed" && failedCount === 0 ? "all" : cur);
  assert(guard("failed", 0) === "all", "retrying/clearing the last failure un-parks the filter");
  assert(guard("failed", 1) === "failed", "the guard does NOT fire while a failure remains");
  assert(guard("missing", 0) === "missing", "the guard touches no other state");
  assert(guard("have", 0) === "have", "the guard touches no other state");
}

// (4) Narrowing semantics. "failed" reads the failure records; the other steps read disk.
{
  type Row = { key: string; pdf: boolean; failed: boolean };
  const rows: Row[] = [
    { key: "oa2020", pdf: true, failed: false }, // fetched fine
    { key: "wall2019", pdf: false, failed: true }, // paywall — the real "failed" case
    { key: "noid2018", pdf: false, failed: false }, // never attempted (no DOI)
    { key: "handfiled2021", pdf: true, failed: true }, // failed the fetch, PDF filed by hand later
  ];
  const narrow = (f: PdfFilter) =>
    f === "failed"
      ? rows.filter((r) => r.failed)
      : f === "all"
        ? rows
        : rows.filter((r) => r.pdf === (f === "have"));

  assert(narrow("all").length === 4, "'all' narrows nothing");
  assert(
    narrow("missing")
      .map((r) => r.key)
      .join(",") === "wall2019,noid2018",
    "'missing' is PDF-presence only — it includes the never-attempted row",
  );
  assert(
    narrow("have")
      .map((r) => r.key)
      .join(",") === "oa2020,handfiled2021",
    "'have' is PDF-presence only",
  );
  assert(
    narrow("failed")
      .map((r) => r.key)
      .join(",") === "wall2019,handfiled2021",
    "'failed' reads the failure records — the hand-filed row is NOT dropped for having a PDF",
  );
  // The subset relation that made the old standing pill redundant, stated as a fact:
  assert(
    narrow("failed").every((r) => rows.some((x) => x.key === r.key)) && narrow("failed").length < rows.length,
    "'failed' is a strict subset of the library — it never deserved its own permanent chip",
  );
}

// --- (5) the component still matches this model, and the retired bits stay retired -------
{
  const src = readFileSync(path.join(repoRoot, "src", "shell", "modes", "library", "LibraryMode.svelte"), "utf8");

  assert(!/\bshowFailedOnly\b/.test(src), "the separate showFailedOnly state is gone (one axis, not two)");
  assert(!/⚠\s*\{failedKeys\.size\}\s*failed/.test(src), "the standing '⚠ N failed' toolbar pill is gone");
  assert(!/ondblclick=\{\(\) => getAllPdfs\(true\)\}/.test(src), "the undiscoverable double-click retry gesture is gone");

  assert(
    /let pdfFilter = \$state<"all" \| "missing" \| "failed" \| "have">\("all"\)/.test(src),
    "pdfFilter carries all four states",
  );
  assert(/function cyclePdfFilter\(\)/.test(src) && /onclick=\{cyclePdfFilter\}/.test(src), "the chip cycles via cyclePdfFilter()");
  assert(
    /pdfFilter === "missing"\) pdfFilter = failedKeys\.size > 0 \? "failed" : "have"/.test(src),
    "the component skips the 'failed' step when failedKeys is empty (model rule 2)",
  );
  assert(
    /if \(pdfFilter === "failed" && failedKeys\.size === 0\) pdfFilter = "all"/.test(src),
    "the component carries the stranding guard (model rule 3)",
  );
  assert(
    /if \(pdfFilter === "failed"\) base = base\.filter\(\(r\) => isFailed\(r\.key\)\);/.test(src),
    "'failed' narrows by isFailed(), not by hasPdf() (model rule 4)",
  );
  // The retry action must exist, be bound to the skip-list-ignoring call, and be scoped to
  // the failed step — a retry-all button that showed on every step would be the old problem.
  assert(/\{#if pdfFilter === "failed"\}[\s\S]{0,400}?getAllPdfs\(true\)/.test(src), "'Retry all' renders only while the failed step is active");
  assert(
    /class="enrich retryfailed"[\s\S]{0,300}?disabled=\{fetchingAll/.test(src),
    "'Retry all' is disabled while a bulk fetch is already running",
  );
}

console.log("\nLIBRARY PDF FILTER VERIFY: PASS");
