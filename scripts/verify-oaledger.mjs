// End-to-end verification of the OA-miss ledger through the REAL pdfFetchJob (the bulk
// "Get PDFs" engine), running in the browser against the dev server with an in-memory
// window.fig bridge (virtual FluxLib + scripted network):
//   run 1: paper A has no OA copy → miss recorded in .fluxlib/oa-misses.json; paper B's
//          PDF lands in items/B/paper.pdf and source.json is written.
//   run 2: A is SKIPPED (oaSkipped=1) with ZERO network calls — the user's "loop through
//          every unfetched paper" is gone.
//   run 3: A's enrichment gains an OA URL → signature changes → A is re-checked and fetched.
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
    prefsGet: async () => ({ fluxLibPath: "/vlib" }),
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
  // A: no OA anywhere. B: OA on a repository host (arXiv) → bulk may fetch it directly.
  // P: OA exists but ONLY on the publisher's site (cell.com) → bulk must NOT touch it.
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
  window.__netPdf[pubUrlP] = true; // would "succeed" if (wrongly) requested — the test is that it never is
  const gate = { proxyConfigured: false, proxySignedIn: false };

  const runs = [];
  const netCalls = () => window.__netLog.length;
  const ledgerNow = () => window.__vfs.get("/vlib/.fluxlib/oa-misses.json") ?? "";

  let n0 = netCalls();
  const s1 = await pdfFetchJob.start(entries, enrich, gate);
  runs.push({ run: 1, sum: s1, net: netCalls() - n0, ledger: ledgerNow() });

  n0 = netCalls();
  const s2 = await pdfFetchJob.start(entries, enrich, gate);
  runs.push({ run: 2, sum: s2, net: netCalls() - n0, ledger: ledgerNow() });

  // Enrichment finds a repository OA URL for A → signature changes → re-checked + fetched.
  const oaUrlA = "https://europepmc.org/articles/PMC77/pdf";
  window.__netPdf[oaUrlA] = true;
  const enrich3 = { ...enrich, cellA: { openAccess: { url: oaUrlA, isOa: true } } };
  n0 = netCalls();
  const s3 = await pdfFetchJob.start(entries, enrich3, gate);
  runs.push({ run: 3, sum: s3, net: netCalls() - n0, ledger: ledgerNow() });

  const havePdfB = window.__vfs.has("/vlib/items/natB/paper.pdf");
  const havePdfA = window.__vfs.has("/vlib/items/cellA/paper.pdf");
  const havePdfP = window.__vfs.has("/vlib/items/cellP/paper.pdf");
  const haveSourceB = window.__vfs.has("/vlib/items/natB/source.json");
  const publisherHits = window.__netLog.filter((u) => /cell\.com|sciencedirect|doi\.org/.test(u));

  // --- Phase B interplay: proxy results must not corrupt the OA ledger -------------
  // C: no OA, proxy genuinely fails → OA miss stays UNREFRESHED (TTL keeps aging) and a
  //    Part C fetch-failure.json is written (both routes exhausted).
  // E: no OA, proxy succeeds → OA miss cleared, PDF filed with source "proxy".
  const entries4 = [
    { key: "cellC", type: "article", title: "C", doi: "10.1016/j.cell.2" },
    { key: "natE", type: "article", title: "E", doi: "10.1038/s2" },
  ];
  const s4a = await pdfFetchJob.start(entries4, {}, gate); // OA-only run records both misses
  const missCBefore = JSON.parse(ledgerNow()).misses?.cellC;
  window.fig.fetchViaProxy = async (target) =>
    target.includes("10.1038")
      ? { bytesB64: btoa("%PDF-1.4 proxy\n%%EOF"), contentType: "application/pdf", finalUrl: target, via: "grab" }
      : { error: "no pdf", reason: "not-a-pdf", diag: { host: "cell.com" } };
  const s4b = await pdfFetchJob.start(entries4, {}, { proxyConfigured: true, proxySignedIn: true });
  const ledger4 = JSON.parse(ledgerNow());
  const proxyLeg = {
    s4a,
    s4b,
    missCBefore,
    missCAfter: ledger4.misses?.cellC,
    missEAfter: ledger4.misses?.natE,
    havePdfE: window.__vfs.has("/vlib/items/natE/paper.pdf"),
    failureC: window.__vfs.get("/vlib/items/cellC/fetch-failure.json") ?? null,
    failureE: window.__vfs.get("/vlib/items/natE/fetch-failure.json") ?? null,
  };
  return { runs, havePdfA, havePdfB, havePdfP, haveSourceB, publisherHits, proxyLeg };
});

const [r1, r2, r3] = summary.runs;
assert(r1.sum.oaGot === 1 && r1.sum.oaSkipped === 0, `run 1 fetched B via OA (got=${r1.sum.oaGot})`);
assert(summary.havePdfB && summary.haveSourceB, "run 1 filed items/natB/paper.pdf + source.json");
assert(r1.net > 0, `run 1 hit the network (${r1.net} calls)`);
assert(
  summary.publisherHits.length === 0 && !summary.havePdfP,
  "REPOSITORY-ONLY: zero requests to publisher hosts across ALL runs" +
    (summary.publisherHits.length ? ` — hit ${summary.publisherHits[0]}` : ""),
);
assert(r1.sum.publisherOnly === 1, `run 1 flagged cellP publisher-hosted-only (got ${r1.sum.publisherOnly})`);
const ledger1 = JSON.parse(r1.ledger || "{}");
assert(ledger1.misses?.cellA?.attempts === 1, "run 1 recorded cellA's OA miss in .fluxlib/oa-misses.json");
assert(ledger1.misses?.cellP?.attempts === 1, "publisher-only paper also recorded (skips OA next run; proxy still tries)");
assert(!ledger1.misses?.natB, "no miss recorded for the fetched paper");
assert(ledger1.misses.cellA.sig.startsWith("10.1016/j.cell.1|"), "miss stores the identifier signature");

assert(r2.sum.oaSkipped === 2, `run 2 skipped cellA + cellP via the ledger (oaSkipped=${r2.sum.oaSkipped})`);
assert(r2.net === 0, `run 2 made ZERO network calls (got ${r2.net})`);
assert(r2.sum.oaGot === 0, "run 2 fetched nothing (nothing to do)");

assert(r3.sum.oaSkipped === 1 && r3.sum.oaGot === 1, "run 3: changed enrichment invalidated A's miss → A fetched");
assert(summary.havePdfA, "run 3 filed items/cellA/paper.pdf");
const ledger3 = JSON.parse(r3.ledger || "{}");
assert(!ledger3.misses?.cellA, "run 3's success cleared cellA's miss from the ledger");

const p = summary.proxyLeg;
assert(p.s4a.oaSkipped === 0 && p.missCBefore?.attempts === 1, "phase-B leg: OA misses recorded for C and E");
assert(p.s4b.oaSkipped === 2, "phase-B leg: both papers skipped OA re-check on the proxy run");
assert(p.s4b.proxyGot === 1 && p.havePdfE, "proxy success fetched E's PDF");
assert(!p.missEAfter, "proxy success cleared E's OA miss");
assert(
  p.missCAfter?.attempts === 1 && p.missCAfter?.at === p.missCBefore?.at,
  "proxy FAILURE left C's OA miss unrefreshed (TTL keeps aging)",
);
assert(!!p.failureC && !p.failureE, "both-routes failure wrote fetch-failure.json for C only");

const errs = realErrors(page);
assert(errs.length === 0, "no real page errors" + (errs.length ? ` — ${errs[0]}` : ""));

await browser.close();
console.log("\nOA LEDGER VERIFY: PASS");
