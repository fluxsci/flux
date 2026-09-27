#!/usr/bin/env -S npx tsx
// Assign-inbox outcomes and DOI resolution.
//
// Regressions pinned here:
//  • flux-core resolveDoiMeta THREW on every successful Crossref reply (`.catch` on the parsed
//    object, 2026-09-21 → 09-26), which identify() read as "network error" — every DOI lookup
//    in the CLI/MCP twin "failed as network" while the network was fine. The hardening gate
//    injects deps, so it never ran the real resolver; this one does, over a fake fetch.
//  • A failure that is NOT transient (a refused library write, a lost lock) must be an
//    "error" the summary names — never a silent "deferred (network)".
//   Run: npx tsx scripts/verify-assign-outcome.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "flux-assign-outcome-cfg-"));
process.env.XDG_CONFIG_HOME = cfg;
process.env.FLUX_NO_MIGRATE = "1";

const { failureAction, isTransientFailure } = await import("../src/lib/references/assignOutcome");
const { resolveDoiMeta } = await import("../flux-core/assign");

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

fs.rmSync(cfg, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nverify-assign-outcome: all passed");
