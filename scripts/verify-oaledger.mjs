// End-to-end verification of the OA-miss ledger through the REAL pdfFetchJob (the bulk
// "Get PDFs" engine), running in the browser against the dev server with an in-memory
// window.fig bridge (virtual FluxLib + scripted network):
//   run 1: paper A has no OA copy → miss recorded in .fluxlib/oa-misses.json; paper B's
//          PDF lands in items/B/paper.pdf and source.json is written.
//   run 2: A is SKIPPED (oaSkipped=1) with ZERO network calls — the user's "loop through
//          every unfetched paper" is gone.
//   run 3: A's enrichment gains an OA URL → signature changes → A is re-checked and fetched.
//   run 4: a miss is a ledger entry and nothing else — no per-paper failure record is
//          written, a legacy one is left untouched, and explicitly picked papers
//          (recheckMisses) bypass the ledger.
// Run (dev server on :1420 must be up): node scripts/verify-oaledger.mjs
import { launch, gotoApp, sleep, realErrors } from "./lib/driver.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const { browser, page } = await launch();

// Install the virtual bridge BEFORE any app script runs.
await page.evaluateOnNewDocument(() => {
  const vfs = new Map(); // path → string | Uint8Array
  const dirs = new Set(["/vlib", "/vlib/items", "/vlib/.fluxlib"]);
  const norm = (p) => String(p).replace(/\/{2,}/g, "/").replace(/\/$/, "");
  window.__vfs = vfs;
  window.__netLog = [];
  window.__netPdf = {}; // url → true ⇒ serve a fake PDF
  const b64 = (s) => btoa(s);
  window.fig = {
    // fluxLibResolved is the live pointer (the FluxConfig refactor DERIVES
    // FluxLib and main persists the resolved path; the old fluxLibPath key is
    // dead — this stub broke silently when the refactor merged).
    prefsGet: async () => ({ fluxLibResolved: "/vlib" }),
    prefsSet: async () => {},
    keysGet: async () => ({ mailto: "test@flux" }),
    paths: async () => ({ home: "/vhome", userData: "/vdata" }),
    mkdir: async (p) => void dirs.add(norm(p)),
    exists: async (p) => vfs.has(norm(p)) || dirs.has(norm(p)),
    readText: async (p) => {
      const v = vfs.get(norm(p));
      if (typeof v !== "string") throw new Error("ENOENT " + p);
      return v;
    },
    writeText: async (p, t) => void vfs.set(norm(p), t),
    writeFile: async (p, bytes) => void vfs.set(norm(p), bytes),
    readFile: async (p) => vfs.get(norm(p)),
    remove: async (p) => void vfs.delete(norm(p)),
    readdir: async (p) => {
      const base = norm(p) + "/";
      const names = new Set();
      for (const k of [...vfs.keys(), ...dirs]) {
        if (k.startsWith(base)) names.add(k.slice(base.length).split("/")[0]);
      }
      return [...names].map((name) => ({ name, dir: true }));
    },
    netGet: async (url, mode) => {
      window.__netLog.push(url);
      if (mode === "bytes" && window.__netPdf[url]) {
        return { bytesB64: b64("%PDF-1.4 fake\n%%EOF"), contentType: "application/pdf", finalUrl: url };
      }
      if (mode === "json") return { json: null };
      if (mode === "text") return { text: "" };
      return { error: "HTTP 404", status: 404 };
    },
  };
});

await gotoApp(page, { settle: 1500 });

const summary = await page.evaluate(async () => {
  const { pdfFetchJob } = await import("/src/lib/references/pdfFetchJob.svelte.ts");
  // A: no OA anywhere. B: OA on a repository host (arXiv) → fetched directly.
  // P: OA hosted on the publisher's site (cell.com) → ALSO fetched: the old
  // repository-only bulk rule was retired 2026-07-06 (it starved ~180 Cell
  // Press OA papers); ban-safety lives in the cookie-jar netGet + per-publisher
  // GET caps, and bulk/single-row share ONE candidate set.
  const entries = [
    { key: "cellA", type: "article", title: "A", doi: "10.1016/j.cell.1" },
    { key: "natB", type: "article", title: "B", doi: "10.1038/s1" },
    { key: "cellP", type: "article", title: "P", doi: "10.1016/j.cell.9" },
  ];
  const oaUrlB = "https://arxiv.org/pdf/2401.00001v2";
  const pubUrlP = "https://www.cell.com/article/S0092/pdf";
  const enrich = {
    natB: { openAccess: { url: oaUrlB, isOa: true } },
    cellP: { openAccess: { url: pubUrlP, isOa: true } },
  };
  window.__netPdf[oaUrlB] = true;
  window.__netPdf[pubUrlP] = true; // publisher-hosted OA is a legitimate bulk fetch now

  const runs = [];
  const netCalls = () => window.__netLog.length;
  const ledgerNow = () => window.__vfs.get("/vlib/.fluxlib/oa-misses.json") ?? "";

  let n0 = netCalls();
  const s1 = await pdfFetchJob.start(entries, enrich);
  runs.push({ run: 1, sum: s1, net: netCalls() - n0, ledger: ledgerNow() });

  n0 = netCalls();
  const s2 = await pdfFetchJob.start(entries, enrich);
  runs.push({ run: 2, sum: s2, net: netCalls() - n0, ledger: ledgerNow() });

  // Enrichment finds a repository OA URL for A → signature changes → re-checked + fetched.
  const oaUrlA = "https://europepmc.org/articles/PMC77/pdf";
  window.__netPdf[oaUrlA] = true;
  const enrich3 = { ...enrich, cellA: { openAccess: { url: oaUrlA, isOa: true } } };
  n0 = netCalls();
  const s3 = await pdfFetchJob.start(entries, enrich3);
  runs.push({ run: 3, sum: s3, net: netCalls() - n0, ledger: ledgerNow() });

  const havePdfB = window.__vfs.has("/vlib/items/natB/paper.pdf");
  const havePdfA = window.__vfs.has("/vlib/items/cellA/paper.pdf");
  const havePdfP = window.__vfs.has("/vlib/items/cellP/paper.pdf");
  const haveSourceB = window.__vfs.has("/vlib/items/natB/source.json");
  const publisherHits = window.__netLog.filter((u) => /cell\.com|sciencedirect|doi\.org/.test(u));

  // --- run 4: one route — a miss is a ledger entry and nothing else ---------------
  // C: no OA → its miss is recorded and NO items/cellC/fetch-failure.json appears (the
  //    "both routes failed" record went with the library sign-in, 2026-11-18).
  // D: has OA and an old fetch-failure.json from an earlier version → still fetched; the
  //    old record stays on disk byte-for-byte (left alone, never read).
  // Then the same papers again with recheckMisses (what checking boxes does): C is
  // re-checked despite its fresh miss, and the miss's attempt count grows.
  const legacy = '{"key":"natD","attempts":3}\n';
  window.__vfs.set("/vlib/items/natD/fetch-failure.json", legacy);
  const oaUrlD = "https://arxiv.org/pdf/2402.00002v1";
  window.__netPdf[oaUrlD] = true;
  const entries4 = [
    { key: "cellC", type: "article", title: "C", doi: "10.1016/j.cell.2" },
    { key: "natD", type: "article", title: "D", doi: "10.1038/s2" },
  ];
  const enrich4 = { natD: { openAccess: { url: oaUrlD, isOa: true } } };
  const s4a = await pdfFetchJob.start(entries4, enrich4);
  const missCBefore = JSON.parse(ledgerNow()).misses?.cellC;
  const s4b = await pdfFetchJob.start(entries4, enrich4, { recheckMisses: true });
  const oneRoute = {
    s4a,
    s4b,
    missCBefore,
    missCAfter: JSON.parse(ledgerNow()).misses?.cellC,
    havePdfD: window.__vfs.has("/vlib/items/natD/paper.pdf"),
    failureC: window.__vfs.get("/vlib/items/cellC/fetch-failure.json") ?? null,
    legacyD: window.__vfs.get("/vlib/items/natD/fetch-failure.json") ?? null,
    legacy,
    anyFailureRecord: [...window.__vfs.keys()].filter((k) => k.endsWith("/fetch-failure.json") && !k.includes("/natD/")),
  };
  return { runs, havePdfA, havePdfB, havePdfP, haveSourceB, publisherHits, oneRoute };
});

const [r1, r2, r3] = summary.runs;
assert(r1.sum.got === 2 && r1.sum.oaSkipped === 0, `run 1 fetched B (arXiv) + P (publisher OA) (got=${r1.sum.got})`);
assert(summary.havePdfB && summary.haveSourceB, "run 1 filed items/natB/paper.pdf + source.json");
assert(summary.havePdfP, "run 1 filed P's publisher-hosted OA copy (bulk = single-row candidate set)");
assert(r1.net > 0, `run 1 hit the network (${r1.net} calls)`);
assert(summary.publisherHits.length > 0, "the publisher host WAS requested (repository-only rule retired 2026-07-06)");
const ledger1 = JSON.parse(r1.ledger || "{}");
assert(ledger1.misses?.cellA?.attempts === 1, "run 1 recorded cellA's OA miss in .fluxlib/oa-misses.json");
assert(!ledger1.misses?.cellP, "no miss for P — its publisher OA copy fetched fine");
assert(!ledger1.misses?.natB, "no miss recorded for the fetched paper");
assert(ledger1.misses.cellA.sig.startsWith("10.1016/j.cell.1|"), "miss stores the identifier signature");

assert(r2.sum.oaSkipped === 1, `run 2 skipped cellA via the ledger (oaSkipped=${r2.sum.oaSkipped})`);
assert(r2.net === 0, `run 2 made ZERO network calls (got ${r2.net})`);
assert(r2.sum.got === 0, "run 2 fetched nothing (nothing to do)");

assert(r3.sum.oaSkipped === 0 && r3.sum.got === 1, "run 3: changed enrichment invalidated A's miss → A fetched");
assert(summary.havePdfA, "run 3 filed items/cellA/paper.pdf");
const ledger3 = JSON.parse(r3.ledger || "{}");
assert(!ledger3.misses?.cellA, "run 3's success cleared cellA's miss from the ledger");

const o = summary.oneRoute;
assert(o.s4a.got === 1 && o.havePdfD, "run 4: D fetched normally despite an old failure record beside it");
assert(o.missCBefore?.attempts === 1, "run 4: C's OA miss recorded");
assert(o.failureC === null && o.anyFailureRecord.length === 0, "run 4: no fetch-failure.json written for any paper");
assert(o.legacyD === o.legacy, "run 4: the legacy fetch-failure.json is left untouched");
assert(o.s4b.oaSkipped === 0 && o.missCAfter?.attempts === 2, "run 4: recheckMisses re-checks a fresh miss (attempts 1 → 2)");

const errs = realErrors(page);
assert(errs.length === 0, "no real page errors" + (errs.length ? ` — ${errs[0]}` : ""));

await browser.close();
console.log("\nOA LEDGER VERIFY: PASS");
