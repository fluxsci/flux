// Behavioral verification of the bulk-fetch protections, driven through the REAL
// pdfFinderBridge loops with a stubbed window.fig bridge (no Electron, no network):
//   1. Phase B circuit breaker — 3 consecutive genuine failures for one publisher stop
//      that publisher for the run, report reason "publisher-blocked" (an ENV reason —
//      never written to fetch-failure.json), and leave other publishers untouched.
//   2. Phase B rate limiting — captures spend CAPTURE_COST per publisher window.
//   3. flux-core OA-miss ledger round-trip — save/load/corrupt-tolerance on a temp lib.
// Run: npx tsx scripts/verify-fetchflow.ts
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- stub the Electron bridge BEFORE importing the bridge module -----------------
const proxyCalls: string[] = [];
(globalThis as any).window = {
  fig: {
    // every proxy capture "finds the article but no PDF" — a genuine (loggable) failure
    fetchViaProxy: async (target: string) => {
      proxyCalls.push(target);
      return { error: "no pdf", reason: "not-a-pdf", diag: { host: "x" } };
    },
    netGet: async () => ({ error: "offline" }),
    keysGet: async () => ({}),
  },
};

const { fetchViaProxyForEntries, fetchPdfForEntry, ENV_REASONS } = await import("../src/lib/references/pdfFinderBridge");
const { sharedLimiter, CAPTURE_COST } = await import("../src/lib/references/hostLimiter");
const { safeKey } = await import("../src/lib/references/items");
void safeKey;

// --- 1+2: circuit breaker + limiter spend over the real Phase B loop -------------
{
  // 5 Elsevier papers + 2 Springer papers, interleaved by the loop itself.
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => ({ key: `cell${i}`, doi: `10.1016/j.cell.${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ key: `nat${i}`, doi: `10.1038/s${i}` })),
  ];
  const t0 = Date.now();
  const sum = await fetchViaProxyForEntries(
    entries.map((entry) => ({ entry: entry as any })),
    { delayMs: 1 }, // keep politeness delays out of the test's runtime
  );
  const byKey = new Map(sum.results.map((r) => [r.key, r]));
  const blocked = sum.results.filter((r) => r.reason === "publisher-blocked");
  ok(sum.blockedGroups?.join(",") === "elsevier", "elsevier breaker tripped", JSON.stringify(sum.blockedGroups));
  ok(blocked.length === 2 && blocked.every((r) => r.key.startsWith("cell")), "remaining elsevier papers skipped");
  ok(proxyCalls.length === 5, "exactly 3 elsevier + 2 springer captures attempted", `calls=${proxyCalls.length}`);
  ok(
    entries.filter((e) => e.key.startsWith("nat")).every((e) => byKey.get(e.key)?.reason === "not-a-pdf"),
    "springer papers unaffected by elsevier's breaker",
  );
  ok(ENV_REASONS.has("publisher-blocked"), "publisher-blocked classified as environment (never skip-listed)");
  ok(sum.results.every((r) => r.key.startsWith("cell") === (r.group === "elsevier")), "results carry their group");
  const spent = sharedLimiter.spent("elsevier");
  ok(spent === 3 * CAPTURE_COST, "limiter charged CAPTURE_COST per attempted capture", `spent=${spent}`);
  ok(Date.now() - t0 < 10_000, "breaker-skipped papers consume no time/delay");
}

// --- 2b: Phase A — a TRANSIENT netGet failure must NOT be recorded as a no-OA miss ---
// The OA-miss ledger only records a firm "no-OA" when the fetch was DEFINITIVE (the server
// answered `HTTP <status>`). A timeout / network / offline error is TRANSIENT — the paper's
// OA-ness is simply unknown this run, so `fetchPdfForEntry` must flag `transient` so the bulk
// job (pdfFetchJob) skips the miss record and retries next run, rather than suppressing the
// paper for the ledger's 30-day TTL. This is the fix for false misses poisoning the sweep.
{
  const fig = (globalThis as any).window.fig;
  const entry = { key: "transientPaper", doi: "10.1234/transient.test" }; // unknown prefix → no rate-limit interaction

  // Every candidate GET fails at the transport level ("offline" doesn't match `HTTP …`).
  fig.netGet = async () => ({ error: "offline" });
  const rt = await fetchPdfForEntry(entry as any, undefined, { refresh: true, email: "t@t" });
  ok(rt.status === "no-oa" && rt.transient === true, "transient netGet failure → no-oa flagged transient (not recorded)", JSON.stringify(rt));

  // A definitive server answer (an HTTP status) IS a real no-OA and must be recorded.
  fig.netGet = async () => ({ error: "HTTP 404" });
  const rd = await fetchPdfForEntry(entry as any, undefined, { refresh: true, email: "t@t" });
  ok(rd.status === "no-oa" && !rd.transient, "definitive HTTP failure → no-oa NOT transient (recorded)", JSON.stringify(rd));
}

// --- 3: flux-core ledger round-trip on a temp FluxLib ----------------------------
{
  const lib = await fs.mkdtemp(path.join(os.tmpdir(), "flux-oamiss-"));
  const { loadOaMisses, saveOaMisses } = await import("../flux-core/items");
  ok(Object.keys(await loadOaMisses(lib)).length === 0, "missing ledger file → empty map");
  const misses = { paperA: { at: new Date().toISOString(), attempts: 2, sig: "10.1/x||" } };
  await saveOaMisses(misses, lib);
  const back = await loadOaMisses(lib);
  ok(JSON.stringify(back) === JSON.stringify(misses), "ledger round-trips");
  await fs.writeFile(path.join(lib, ".fluxlib", "oa-misses.json"), "{corrupt", "utf8");
  ok(Object.keys(await loadOaMisses(lib)).length === 0, "corrupt ledger → empty map (self-heals)");
  await fs.rm(lib, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
