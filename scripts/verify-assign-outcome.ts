#!/usr/bin/env -S npx tsx
// Assign-inbox outcomes + the library.bib sync-conflict merge (2026-09-26).
//
// Regressions pinned here:
//  • flux-core resolveDoiMeta THREW on every successful Crossref reply (`.catch` on the parsed
//    object, 2026-09-21 → 09-26), which identify() read as "network error" — every DOI lookup
//    in the CLI/MCP twin "failed as network" while the network was fine. The hardening gate
//    injects deps, so it never ran the real resolver; this one does, over a fake fetch.
//  • A failure that is NOT transient (a refused library write, a lost lock) must be an
//    "error" the summary names — never a silent "deferred (network)".
//  • A `library.sync-conflict-*.bib` beside library.bib merges itself (union of entries,
//    the copy's citekeys + dateadded kept, DOI/signature dedupe), the copy is ARCHIVED under
//    .fluxlib/sync-conflicts/ (never deleted), and a library write with a copy present
//    succeeds instead of refusing.
//   Run: npx tsx scripts/verify-assign-outcome.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "flux-assign-outcome-cfg-"));
process.env.XDG_CONFIG_HOME = cfg;
process.env.FLUX_NO_MIGRATE = "1";

const { failureAction, isTransientFailure, isLibraryConflictFailure } = await import("../src/lib/references/assignOutcome");
const { planBibConflictMerge, archivedConflictName } = await import("../src/lib/references/bibConflict");
const { resolveDoiMeta } = await import("../flux-core/assign");
const { addToFluxLib, mergeLibraryConflictCopies, loadLibrary } = await import("../flux-core/fluxlib");
const { isConflictPath, isMergeableConflict } = await import("../electron/conflictRules.js");

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  if (cond) console.log("  ok:", name);
  else {
    console.error("  FAIL:", name, detail);
    failures++;
  }
}

// ---------------------------------------------------------------------------
console.log("failure classification:");
// ---------------------------------------------------------------------------
ok(failureAction("fetch failed") === "deferred", "fetch failed → deferred");
ok(failureAction("crossref HTTP 503") === "deferred", "5xx → deferred");
ok(failureAction("HTTP 429") === "deferred", "429 → deferred");
ok(failureAction("connect ETIMEDOUT 1.2.3.4:443") === "deferred", "ETIMEDOUT → deferred");
ok(failureAction("Unresolved canonical sync conflict at /x/library.bib: library.sync-conflict-20260925-204624-GGKHM53.bib. Both revisions were preserved") === "error", "sync conflict → error");
ok(isLibraryConflictFailure("couldn't create library entry: Unresolved canonical sync conflict at /x/library.bib"), "conflict failure recognised by name");
ok(failureAction('"library" is busy — another Flux operation is still finishing. Try again in a moment.') === "error", "lost/busy lock → error");
ok(failureAction("HTTP 404") === "error" && failureAction("DOI fetch 404") === "error", "404 is definitive, not transient");
ok(!isTransientFailure("PDF quarantine did not complete"), "fs failure → not transient");

// ---------------------------------------------------------------------------
console.log("resolveDoiMeta over a fake fetch (the .catch regression):");
// ---------------------------------------------------------------------------
const crossref = { message: { title: ["Sleep-like slow waves"], author: [{ given: "P.", family: "Champetier" }], issued: { "date-parts": [[2026]] }, "container-title": ["Alzheimer's & Dementia"] } };
const fakeFetch = (routes: Record<string, () => Response>) => (async (input: string | URL | Request) => {
  const u = String(input);
  for (const [k, r] of Object.entries(routes)) if (u.startsWith(k)) return r();
  throw new Error(`fetch failed: ${u}`);
}) as unknown as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
{
  const meta = await resolveDoiMeta("10.1002/alz.71514", undefined, fakeFetch({ "https://api.crossref.org/": () => json(crossref) })).catch((e) => ({ threw: String(e?.message ?? e) }));
  ok(!!meta && !("threw" in meta) && meta.title === "Sleep-like slow waves" && meta.year === "2026" && meta.authors[0] === "P. Champetier", "a good Crossref reply resolves (does not throw)", JSON.stringify(meta));
}
{
  const meta = await resolveDoiMeta("10.5281/zenodo.1", undefined, fakeFetch({
    "https://api.crossref.org/": () => json({ status: "error" }, 404),
    "https://doi.org/": () => new Response("@misc{z1, title={A dataset}, author={Doe, Jane}, year={2020}}", { status: 200 }),
  })).catch((e) => ({ threw: String(e?.message ?? e) }));
  ok(!!meta && !("threw" in meta) && meta.title === "A dataset", "Crossref 404 falls back to doi.org BibTeX", JSON.stringify(meta));
}
{
  const meta = await resolveDoiMeta("10.1/none", undefined, fakeFetch({ "https://api.crossref.org/": () => json({}, 404), "https://doi.org/": () => new Response("", { status: 404 }) })).catch((e) => ({ threw: String(e?.message ?? e) }));
  ok(meta === null, "404 at both → null (definitive), not a throw", JSON.stringify(meta));
}
{
  const r = await resolveDoiMeta("10.1/five", undefined, fakeFetch({ "https://api.crossref.org/": () => json({}, 503) })).then(() => "resolved", (e) => String(e.message));
  ok(/crossref HTTP 503/.test(r), "503 throws (transient → identify defers)", r);
}
{
  const r = await resolveDoiMeta("10.1/junk", undefined, fakeFetch({ "https://api.crossref.org/": () => new Response("not json", { status: 200 }), "https://doi.org/": () => new Response("", { status: 404 }) })).then((m) => (m === null ? "null" : "meta"), (e) => "threw " + e.message);
  ok(r === "null", "malformed 200 body is not a network failure (falls through, then definitive null)", r);
}

// ---------------------------------------------------------------------------
console.log("planBibConflictMerge:");
// ---------------------------------------------------------------------------
const mine = `% FluxLib\n@article{suTopo2026,\n  dateadded = {2026-09-18T00:00:00.000Z},\n  title = {Topographic structure},\n  author = {Su, A.},\n  year = {2026},\n  doi = {10.1038/s41586-026-1},\n}\n@article{shared2020,\n  dateadded = {2026-01-01T00:00:00.000Z},\n  title = {Shared paper},\n  author = {Lee, B.},\n  year = {2020},\n  doi = {10.1000/shared},\n}\n`;
const theirs = `% FluxLib\n@article{shared2020,\n  dateadded = {2026-01-01T00:00:00.000Z},\n  title = {Shared paper},\n  author = {Lee, B.},\n  year = {2020},\n  doi = {10.1000/shared},\n}\n@article{leeLearningParts1999,\n  dateadded = {2026-09-06T05:03:46.244Z},\n  title = {Learning the parts of objects},\n  author = {Lee, Daniel D. and Seung, H. Sebastian},\n  year = {1999},\n  doi = {10.1038/44565},\n}\n@article{sharedRekeyed,\n  title = {Shared paper},\n  author = {Lee, B.},\n  year = {2020},\n  doi = {10.1000/SHARED},\n}\n@article{suTopo2026,\n  title = {A different paper that took the same key},\n  author = {Other, C.},\n  year = {2026},\n  doi = {10.9999/other},\n}\n`;
{
  const plan = planBibConflictMerge(mine, theirs, "2026-09-26T00:00:00.000Z");
  ok(plan.added.includes("leeLearningParts1999"), "an entry only in the copy is appended under its own citekey", JSON.stringify(plan.added));
  ok(plan.alreadyPresent === 3, "entries present here (by key, by DOI under another key, and by key with drifted content) are not duplicated", String(plan.alreadyPresent));
  ok(plan.added.length === 1, "a citekey that exists here is the SAME record — never re-minted into a duplicate", JSON.stringify(plan.added));
  const titleOnly = `@article{titleOnly-1a2,\n  title = {A title-only record},\n}\n`;
  ok(planBibConflictMerge(mine, titleOnly).added.length === 1 && planBibConflictMerge(mine + titleOnly, titleOnly).nothingToMerge, "a title-only record (no DOI, no author) merges once and never duplicates (the owner's 3 anon records)");
  ok(/leeLearningParts1999,\n  dateadded = \{2026-09-06T05:03:46\.244Z\}/.test(plan.text), "the copy's dateadded stamp is kept (a merge is not a new arrival)");
  ok(plan.text.startsWith(mine), "canonical text is untouched — entries are only appended");
  ok(!plan.nothingToMerge, "something to merge");
  ok(planBibConflictMerge(mine, mine).nothingToMerge, "an identical copy has nothing to merge");
  ok(planBibConflictMerge(mine, `@article{shared2020,\n  title = {Shared paper},\n  author = {Lee, B.},\n  year = {2020},\n  doi = {10.1000/shared},\n}\n`).nothingToMerge, "a subset copy has nothing to merge");
}
ok(archivedConflictName("library.sync-conflict-20260925-204624-GGKHM53.bib") === "library.other-machine-20260925-204624-GGKHM53.bib", "archived name keeps stamp + device");
ok(!isConflictPath(archivedConflictName("library.sync-conflict-20260925-204624-GGKHM53.bib")), "archived name is no longer a conflict copy to the scan");
ok(isMergeableConflict("library.sync-conflict-20260925-204624-GGKHM53.bib"), ".bib conflict copies are mergeable");

// ---------------------------------------------------------------------------
console.log("Node twin: a conflict copy beside library.bib merges itself, and a write succeeds:");
// ---------------------------------------------------------------------------
{
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "flux-assign-outcome-lib-"));
  fs.mkdirSync(path.join(lib, ".fluxlib"), { recursive: true });
  fs.writeFileSync(path.join(lib, "library.bib"), mine);
  const copy = "library.sync-conflict-20260925-204624-GGKHM53.bib";
  fs.writeFileSync(path.join(lib, copy), theirs);
  const r = await addToFluxLib("@article{newOne2026,\n  title = {Brand new},\n  author = {New, D.},\n  year = {2026},\n  doi = {10.1234/new},\n}\n", { source: "bibtex", libPath: lib });
  ok(r.keys[0] === "newOne2026", "addToFluxLib succeeds with a conflict copy present (no refusal)", JSON.stringify(r.keys));
  const text = fs.readFileSync(path.join(lib, "library.bib"), "utf8");
  ok(text.includes("@article{leeLearningParts1999,") && text.includes("@article{newOne2026,"), "merged the copy's entries AND the new add");
  ok(!fs.existsSync(path.join(lib, copy)), "the conflict copy is gone from beside library.bib");
  const archived = path.join(lib, ".fluxlib", "sync-conflicts", "library.other-machine-20260925-204624-GGKHM53.bib");
  ok(fs.existsSync(archived) && fs.readFileSync(archived, "utf8") === theirs, "…archived byte-identical under .fluxlib/sync-conflicts/");
  const entries = await loadLibrary(lib);
  ok(entries.length === 4, "library loads with 4 entries (2 mine + 1 merged + 1 added)", String(entries.length));
  ok((await mergeLibraryConflictCopies(lib)).length === 0, "a second merge pass finds nothing");
  fs.rmSync(lib, { recursive: true, force: true });
}

fs.rmSync(cfg, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nverify-assign-outcome: all passed");
