#!/usr/bin/env -S npx tsx
// Library PDF filter — the single "PDF state" axis in the FluxLib header.
//
// History: a standing "⚠ N failed" pill once sat in the toolbar permanently. It counted a
// strict subset of the "No PDF" chip beside it, and for papers with no open-access copy its
// count never reached zero — a warning you can't clear is one you learn to ignore. It became
// a "failed" step on this filter's cycle with a "Retry all" button. On 2026-11-18 (owner
// decision) the library sign-in that produced those "both routes failed" records was
// removed, so the step, the button and the records' reader went too: with one route, a paper
// without an open-access copy is simply missing. That superseded rules 2–4 of the previous
// version of this gate (skip the empty step, the stranding guard, narrowing by records).
//
// What must hold (and what a careless edit would break):
//   1. The cycle visits every state and returns to "all" — no state is a dead end.
//   2. Every step narrows by PDF presence on disk, nothing else.
//   3. Nothing left in the component counts or reads per-paper failure records, so no
//      count that can never reach zero can come back by accident.
//   4. The retired affordances stay retired: no showFailedOnly state, no standing failure
//      pill, no double-click gesture on the filter chip, no "failed" step, no Retry all.
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
type PdfFilter = "all" | "missing" | "have";
function cycle(cur: PdfFilter): PdfFilter {
  if (cur === "all") return "missing";
  if (cur === "missing") return "have";
  return "all";
}

// (1) A closed 3-loop back to "all".
{
  const seen: PdfFilter[] = [];
  let s: PdfFilter = "all";
  for (let i = 0; i < 3; i++) {
    seen.push(s);
    s = cycle(s);
  }
  assert(seen.join(" → ") === "all → missing → have", `cycle: ${seen.join(" → ")}`);
  assert(s === "all", "a 3rd click returns to 'all' — the filter always clears in-cycle");
}

// (2) Narrowing semantics: disk state only.
{
  type Row = { key: string; pdf: boolean };
  const rows: Row[] = [
    { key: "oa2020", pdf: true },
    { key: "noOa2019", pdf: false }, // no open-access copy — simply missing
    { key: "noid2018", pdf: false }, // never attempted (no DOI)
    { key: "handfiled2021", pdf: true }, // filed by hand / extension
  ];
  const narrow = (f: PdfFilter) => (f === "all" ? rows : rows.filter((r) => r.pdf === (f === "have")));
  assert(narrow("all").length === 4, "'all' narrows nothing");
  assert(narrow("missing").map((r) => r.key).join(",") === "noOa2019,noid2018", "'missing' is PDF-presence only");
  assert(narrow("have").map((r) => r.key).join(",") === "oa2020,handfiled2021", "'have' is PDF-presence only");
}

// --- (3)+(4) the component matches this model, and the retired bits stay retired ----------
{
  const src = readFileSync(path.join(repoRoot, "src", "shell", "modes", "library", "LibraryMode.svelte"), "utf8");

  assert(/let pdfFilter = \$state<"all" \| "missing" \| "have">\("all"\)/.test(src), "pdfFilter carries exactly three states");
  assert(/function cyclePdfFilter\(\)/.test(src) && /onclick=\{cyclePdfFilter\}/.test(src), "the chip cycles via cyclePdfFilter()");
  assert(
    /if \(pdfFilter === "all"\) pdfFilter = "missing";\s*else if \(pdfFilter === "missing"\) pdfFilter = "have";\s*else pdfFilter = "all";/.test(src),
    "the component's cycle is the modelled 3-loop (rule 1)",
  );
  assert(
    /if \(pdfFilter !== "all"\) base = base\.filter\(\(r\) => hasPdf\(r\.key\) === \(pdfFilter === "have"\)\);/.test(src),
    "every step narrows by hasPdf() (rule 2)",
  );

  assert(!/\bfailedKeys\b/.test(src) && !/\bisFailed\b/.test(src), "no failed-key set or predicate (rule 3)");
  assert(!/\blistFailures\b|\blistFailedKeys\b|\breadFetchFailure\b|\bclearFetchFailure\b/.test(src), "no failure-record reads or writes (rule 3)");
  assert(!/fetch-failure/.test(src), "no mention of the per-paper failure file (rule 3)");

  assert(!/\bshowFailedOnly\b/.test(src), "the separate showFailedOnly state is gone (one axis, not two)");
  assert(!/⚠\s*\{failedKeys\.size\}\s*failed/.test(src), "the standing '⚠ N failed' toolbar pill is gone");
  assert(!/ondblclick=\{\(\) => getAllPdfs\(/.test(src), "the undiscoverable double-click retry gesture is gone");
  assert(!/pdfFilter === "failed"/.test(src) && !/⊘ Failed/.test(src), "the 'failed' step and its ⊘ Failed label are gone");
  assert(!/\bretryfailed\b/.test(src) && !/Retry all/.test(src), "the 'Retry all' button and its CSS are gone");
}

console.log("\nLIBRARY PDF FILTER VERIFY: PASS");
