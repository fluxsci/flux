// Behavioral verification of the fetch protections, driven through the REAL
// pdfFinderBridge loops with a stubbed window.fig bridge (no Electron, no network):
//   1. The renderer bridge offers the open-access route and Europe PMC supplements only.
//      (Its publisher-capture phase, with the circuit breaker and capture budget this gate
//      used to pin, was removed with the library sign-in, owner decision 2026-11-18.)
//   2. The supplements sweep asks Europe PMC and nothing else.
//   3. A TRANSIENT netGet failure is never reported as a definitive no-OA.
//   4. flux-core OA-miss ledger round-trip — save/load/corrupt-tolerance on a temp lib.
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
const netGets: string[] = [];
(globalThis as any).window = {
  fig: {
    netGet: async (url: string) => {
      netGets.push(url);
      return { error: "HTTP 404" };
    },
    keysGet: async () => ({}),
  },
};

const bridge = await import("../src/lib/references/pdfFinderBridge");
const { fetchPdfForEntry, fetchSupplementsForEntries } = bridge;

// --- 1: the bridge's whole surface ------------------------------------------------
{
  const names = Object.keys(bridge).sort().join(",");
  ok(
    names === "fetchPdfForEntry,fetchPdfsForEntries,fetchSupplementsForEntries,fetchSupplementsForEntry",
    "pdfFinderBridge exports the open-access fetch and Europe PMC supplements, nothing else",
    names,
  );
}

// --- 2: supplements come from Europe PMC only -------------------------------------
{
  netGets.length = 0;
  const s = await fetchSupplementsForEntries([
    { entry: { key: "suppA", doi: "10.1016/j.cell.1" } as any, enrich: { ids: { pmcid: "PMC123" } } as any },
    { entry: { key: "suppB", doi: "10.1038/s1" } as any, enrich: { ids: { pmcid: "PMC456" } } as any },
  ]);
  const hosts = [...new Set(netGets.map((u) => new URL(u).hostname))];
  ok(s.total === 2 && s.files === 0, "a sweep with nothing in Europe PMC reports zero files", JSON.stringify(s));
  ok(netGets.length > 0 && hosts.every((h) => h === "www.ebi.ac.uk"), "every supplement request goes to Europe PMC (EBI)", hosts.join(","));
}

// --- 3: a TRANSIENT netGet failure must NOT be recorded as a no-OA miss ---
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

// --- 4: flux-core ledger round-trip on a temp FluxLib ----------------------------
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
