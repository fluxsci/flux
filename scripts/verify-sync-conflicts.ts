#!/usr/bin/env -S npx tsx
// Sync conflicts — detection, classification, and the one automatic resolution.
//
// A sync tool never destroys the losing side of a simultaneous edit: it renames it to
// `<base>.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX<.ext>`. That is correct behaviour and a
// trap if left alone — the copy is a second version of your work that drifts from both
// sides, and before this it was INVISIBLE except as a bogus extra entry in the document
// list (listDocuments scans the directory, so `main.sync-conflict-….qmd` showed up as a
// document you could open and edit by mistake).
//
// This gates the shared rules module every surface loads — watcher routing, the scan,
// the resolver, and listDocuments — so those four can never drift apart.
//
//  Run: npx tsx scripts/verify-sync-conflicts.ts
import {
  conflictBaseFor,
  isConflictPath,
  isMergeableConflict,
  isSyncTempPath,
  mergeNdjson,
  parseConflictPath,
} from "../electron/conflictRules.js";

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log("  ok:", msg);
  else {
    console.error("  FAIL:", msg);
    failures++;
  }
}
const eq = (a: unknown, b: unknown, msg: string): void =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)})`);

const CONFLICT = "manuscript/main.sync-conflict-20260810-143022-JMSNC52.qmd";

// ---------------------------------------------------------------------------
console.log("detection:");
// ---------------------------------------------------------------------------
assert(isConflictPath(CONFLICT), "a Syncthing conflict copy is detected");
assert(isConflictPath("main.sync-conflict-20260810-143022-JMSNC52.qmd"), "…at the project root too");
assert(isConflictPath("deep/sub/dir/fig.sync-conflict-20260810-143022-ABCDEFG.svg"), "…at any depth");
assert(isConflictPath("notes.sync-conflict-20260810-143022-ABCDEFG"), "…with no extension at all");
assert(isConflictPath("a.sync-conflict-20260810-143022-ABCDEFG.tar.gz"), "…with a multi-part extension");

assert(!isConflictPath("manuscript/main.qmd"), "an ordinary document is NOT a conflict");
assert(!isConflictPath("notes/sync-conflict-resolution.md"), "a file merely NAMED about conflicts is not one");
assert(!isConflictPath("main.sync-conflict-2026-08-10-143022-JMSNC52.qmd"), "wrong date shape is not a match");
assert(!isConflictPath("main.sync-conflict-20260810-143022-lowercase.qmd"), "device id must be uppercase alnum");
assert(!isConflictPath("main.sync-conflict-20260810-143022-TOOLONGX.qmd"), "device id is exactly 7 chars");

// ---------------------------------------------------------------------------
console.log("temp files are noise, not conflicts:");
// ---------------------------------------------------------------------------
assert(isSyncTempPath("manuscript/.syncthing.main.qmd.tmp"), "in-flight transfer temp detected");
assert(!isConflictPath("manuscript/.syncthing.main.qmd.tmp"), "…and is NOT reported as a conflict");
assert(!isSyncTempPath(CONFLICT), "a conflict copy is not a temp file");
assert(!isSyncTempPath("manuscript/main.qmd"), "an ordinary document is not a temp file");

// ---------------------------------------------------------------------------
console.log("base recovery — which file did this conflict WITH:");
// ---------------------------------------------------------------------------
eq(conflictBaseFor(CONFLICT), "manuscript/main.qmd", "base path recovered, directory preserved");
eq(conflictBaseFor("notes.sync-conflict-20260810-143022-ABCDEFG"), "notes", "extension-less base");
eq(conflictBaseFor("a/b.sync-conflict-20260810-143022-ABCDEFG.tar.gz"), "a/b.tar.gz", "multi-part extension base");
eq(conflictBaseFor("manuscript/main.qmd"), "", "a non-conflict has no base");

{
  const p = parseConflictPath(CONFLICT);
  eq(p?.base, "manuscript/main.qmd", "parse: base");
  eq(p?.when, "2026-08-10 14:30:22", "parse: human timestamp");
  eq(p?.device, "JMSNC52", "parse: originating device");
  eq(parseConflictPath("manuscript/main.qmd"), null, "parse: null for a non-conflict");
}

// ---------------------------------------------------------------------------
console.log("mergeability — only append-only ledgers get an automatic answer:");
// ---------------------------------------------------------------------------
assert(isMergeableConflict(".meta/journal.sync-conflict-20260810-143022-ABCDEFG.ndjson"), "journal ledger merges");
assert(isMergeableConflict(".meta/feedback.sync-conflict-20260810-143022-ABCDEFG.ndjson"), "feedback ledger merges");
assert(!isMergeableConflict(CONFLICT), "a manuscript does NOT auto-merge — the user chooses");
assert(
  !isMergeableConflict("fig/canvases/c1.sync-conflict-20260810-143022-ABCDEFG.json"),
  "a canvas does NOT auto-merge",
);

// ---------------------------------------------------------------------------
console.log("ndjson union:");
// ---------------------------------------------------------------------------
{
  const mine = '{"a":1}\n{"b":2}\n';
  const theirs = '{"b":2}\n{"c":3}\n';
  eq(mergeNdjson(mine, theirs), '{"a":1}\n{"b":2}\n{"c":3}\n', "union keeps first-seen order, dedupes exact lines");
  eq(mergeNdjson(mine, mine), '{"a":1}\n{"b":2}\n', "identical sides collapse to one copy");
  eq(mergeNdjson("", theirs), '{"b":2}\n{"c":3}\n', "empty mine → theirs verbatim");
  eq(mergeNdjson(mine, ""), '{"a":1}\n{"b":2}\n', "empty theirs → mine verbatim");
  eq(mergeNdjson("", ""), "", "both empty → empty (not a stray newline)");
  eq(mergeNdjson("{\"a\":1}\n\n\n{\"b\":2}", theirs), '{"a":1}\n{"b":2}\n{"c":3}\n', "blank lines dropped");
  // Trailing-newline discipline: an appender must never glue onto a partial line.
  assert(mergeNdjson(mine, theirs).endsWith("\n"), "output always ends with a newline");
}

// ---------------------------------------------------------------------------
// The regression this whole feature exists to prevent.
// ---------------------------------------------------------------------------
console.log("listDocuments must never offer a conflict copy as a document:");
{
  const dirEntries = ["main.qmd", "sections", "main.sync-conflict-20260810-143022-JMSNC52.qmd", "notes.qmd"];
  const listed = dirEntries.filter((n) => n.endsWith(".qmd") && !isConflictPath(n));
  eq(listed, ["main.qmd", "notes.qmd"], "the conflict copy is filtered out, real documents survive");
}

console.log("watcher must never route a conflict copy into a normal subsystem:");
{
  // Mirrors electron/main.cjs subsystemFor: the conflict check runs FIRST.
  const subsystemFor = (rel: string): string | null => {
    if (isSyncTempPath(rel)) return null;
    if (isConflictPath(rel)) return "conflict";
    if (rel.startsWith("manuscript/")) return "manuscript";
    if (rel.startsWith("fig/")) return "fig";
    return null;
  };
  eq(subsystemFor("manuscript/main.qmd"), "manuscript", "a real edit still routes normally");
  eq(subsystemFor(CONFLICT), "conflict", "a conflict copy routes to its own subsystem");
  eq(subsystemFor("fig/canvases/c1.sync-conflict-20260810-143022-ABCDEFG.json"), "conflict", "…in fig/ too");
  eq(subsystemFor("manuscript/.syncthing.main.qmd.tmp"), null, "an in-flight transfer is silent");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall sync-conflict checks passed");
process.exit(failures ? 1 : 0);
