// Assign-inbox hardening gate (V1 readiness 0.3) — Node-level tests of flux-core/assign.ts
// against a TEMP FluxLib with injected network deps. Proves the data-safety contract:
//   • transient (network) failures leave files IN the inbox ("deferred"), never quarantine;
//   • the offline breaker stops a scan after 3 consecutive transients;
//   • definitive non-identification still quarantines to _unresolved/ with a sidecar note;
//   • attach files the PDF + fulltext and clears the inbox file;
//   • a duplicate for an entry that already has a PDF is KEPT in items/<key>/supplements/
//     (byte-identical copies are dropped — nothing is ever silently deleted otherwise);
//   • add-then-attach writes the new entry into the SAME lib as the PDF (libPath threading);
//   • a fresh foreign "assign" lock defers the scan; withHeartbeatLockAt restamps + releases;
//   • ensureFluxLib creates the pdfs_to_assign/ inbox.
// Hermetic: no network (deps injected), temp FluxLib, XDG_CONFIG_HOME isolated.
//   Run: npx tsx scripts/verify-assign-hardening.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolate preferences BEFORE flux-core loads (userDataDir honors XDG_CONFIG_HOME on Linux;
// ensureFluxLib persists fluxLibPath into prefs — must not touch the real config).
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "flux-assignh-cfg-"));
process.env.XDG_CONFIG_HOME = cfg;

const { assignPdfs } = await import("../flux-core/assign");
const { ensureFluxLib } = await import("../flux-core/fluxlib");
const { withHeartbeatLockAt, fluxlibLockDir } = await import("../flux-core/locks");
const { readSource } = await import("../flux-core/items");
import type { PaperMeta, SearchHit } from "../src/lib/references/pdfIdentify";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- synthetic 1-page PDFs with controlled text (same technique as gen-reader-sample) ----
const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
function makePdf(lines: string[]): Buffer {
  const parts = [`BT`, `/F1 12 Tf`, `16 TL`, `72 720 Td`];
  lines.forEach((l, i) => parts.push(`${i ? "T* " : ""}(${esc(l)}) Tj`));
  parts.push(`ET`);
  const stream = parts.join("\n");
  const objs: string[] = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const DOI_A = "10.5555/flux.test.alpha";
const TITLE_A = "Synthetic Alpha Paper on Cortical Test Fixtures";
const DOI_B = "10.48550/arxiv.9999.00001";
const TITLE_B = "Synthetic Beta Preprint on Datacite Resolution";
const pdfA = makePdf([TITLE_A, "A. Author, B. Author. 2024.", `doi:${DOI_A}`, "Body text about fixtures."]);
const pdfA2 = makePdf([TITLE_A, "A. Author, B. Author. 2024.", `doi:${DOI_A}`, "Body text about fixtures.", "v2 with an extra line."]);
const pdfB = makePdf([TITLE_B, "C. Author. 2025.", `doi:${DOI_B}`, "Preprint body."]);

const META: Record<string, PaperMeta> = {
  [DOI_A]: { doi: DOI_A, title: TITLE_A, authors: ["A. Author", "B. Author"], year: "2024" },
  [DOI_B]: { doi: DOI_B, title: TITLE_B, authors: ["C. Author"], year: "2025" },
};
const okDeps = {
  resolveDoi: async (d: string) => META[d] ?? null,
  searchTitle: async (): Promise<SearchHit[]> => [],
  fetchBibtex: async (d: string) =>
    `@article{tempkey,\n  title = {${d === DOI_A ? TITLE_A : TITLE_B}},\n  author = {Author, A. and Author, B.},\n  year = {${d === DOI_A ? "2024" : "2025"}},\n  doi = {${d}},\n}\n`,
};
const throwDeps = {
  resolveDoi: async (): Promise<PaperMeta | null> => {
    throw new Error("fetch failed (offline)");
  },
  searchTitle: async (): Promise<SearchHit[]> => {
    throw new Error("fetch failed (offline)");
  },
};

function mkLib(): { lib: string; inbox: string } {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "flux-assignh-lib-"));
  fs.mkdirSync(path.join(lib, ".fluxlib"), { recursive: true });
  const inbox = path.join(lib, "pdfs_to_assign");
  fs.mkdirSync(inbox, { recursive: true });
  // Seed one library entry carrying DOI_A (no PDF yet).
  fs.writeFileSync(
    path.join(lib, "library.bib"),
    `% FluxLib test\n\n@article{author2024synthetic,\n  title = {${TITLE_A}},\n  author = {Author, A. and Author, B.},\n  year = {2024},\n  doi = {${DOI_A}},\n}\n`,
  );
  return { lib, inbox };
}
const inboxNames = (inbox: string) => fs.readdirSync(inbox).filter((n) => n.toLowerCase().endsWith(".pdf"));

// --- 1. ensureFluxLib creates the inbox --------------------------------------------
{
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "flux-assignh-ensure-"));
  await ensureFluxLib(lib);
  ok(fs.existsSync(path.join(lib, "pdfs_to_assign")), "ensureFluxLib creates pdfs_to_assign/");
}

// --- 2. all-transient run: nothing quarantined, files stay --------------------------
{
  const { lib, inbox } = mkLib();
  fs.writeFileSync(path.join(inbox, "a.pdf"), pdfA);
  fs.writeFileSync(path.join(inbox, "b.pdf"), pdfB);
  const s = await assignPdfs({ libPath: lib, deps: throwDeps });
  ok(s.deferred === 2 && s.unresolved === 0, "offline scan → all deferred, none unresolved", JSON.stringify(s.results));
  ok(inboxNames(inbox).length === 2, "offline scan leaves both PDFs in the inbox");
  ok(!fs.existsSync(path.join(inbox, "_unresolved")), "offline scan creates no _unresolved/");
}

// --- 3. offline breaker aborts after 3 consecutive transients ------------------------
{
  const { lib, inbox } = mkLib();
  for (const n of ["a", "b", "c", "d", "e"]) fs.writeFileSync(path.join(inbox, `${n}.pdf`), pdfA);
  const s = await assignPdfs({ libPath: lib, deps: throwDeps });
  ok(s.abortedOffline === true && s.results.length === 3, `breaker trips after 3 (processed ${s.results.length}/5)`);
  ok(inboxNames(inbox).length === 5, "aborted scan leaves all 5 PDFs in place");
}

// --- 4. definitive non-identification still quarantines ------------------------------
{
  const { lib, inbox } = mkLib();
  // A PDF whose only DOI definitively doesn't resolve and whose title search returns nothing.
  fs.writeFileSync(path.join(inbox, "junk.pdf"), makePdf(["Untitled scan", "doi:10.9999/definitely.gone"]));
  const s = await assignPdfs({ libPath: lib, deps: { ...okDeps, resolveDoi: async () => null } });
  ok(s.unresolved === 1 && s.deferred === 0, "definitive miss → unresolved");
  const u = path.join(inbox, "_unresolved");
  ok(fs.existsSync(path.join(u, "junk.pdf")) && fs.existsSync(path.join(u, "junk.pdf.txt")), "quarantined with sidecar note");
}

// --- 5. attach: files PDF + fulltext, clears inbox -----------------------------------
const shared = mkLib();
{
  fs.writeFileSync(path.join(shared.inbox, "alpha.pdf"), pdfA);
  const s = await assignPdfs({ libPath: shared.lib, deps: okDeps });
  const key = s.results[0]?.key ?? "";
  ok(s.attached === 1 && !!key, "existing entry without PDF → attached", JSON.stringify(s.results[0]));
  ok(fs.existsSync(path.join(shared.lib, "items", key, "paper.pdf")), "paper.pdf filed");
  ok(fs.existsSync(path.join(shared.lib, "items", key, "fulltext.txt")), "fulltext extracted on attach");
  ok(inboxNames(shared.inbox).length === 0, "inbox cleared after attach");
  const src = await readSource(key, shared.lib);
  ok(!!src?.sha256, "source.json provenance carries sha256");
}

// --- 6. duplicate with DIFFERENT bytes → kept in supplements/ -------------------------
{
  fs.writeFileSync(path.join(shared.inbox, "alpha-again.pdf"), pdfA2);
  const s = await assignPdfs({ libPath: shared.lib, deps: okDeps });
  const r = s.results[0];
  ok(s.discarded === 1 && !!r?.keptAs, "duplicate (different bytes) → discarded but KEPT", JSON.stringify(r));
  const supp = path.join(shared.lib, "items", r!.key!, "supplements");
  ok(fs.existsSync(path.join(supp, r!.keptAs!)), `kept file exists in supplements/ (${r?.keptAs})`);
  ok(inboxNames(shared.inbox).length === 0, "inbox cleared after keep");
}

// --- 7. byte-identical duplicate → dropped (no supplement litter) ---------------------
{
  fs.writeFileSync(path.join(shared.inbox, "alpha-copy.pdf"), pdfA);
  const s = await assignPdfs({ libPath: shared.lib, deps: okDeps });
  const r = s.results[0];
  const supp = path.join(shared.lib, "items", r!.key!, "supplements");
  const suppCount = fs.readdirSync(supp).filter((n) => n.endsWith(".pdf")).length;
  ok(s.discarded === 1 && !r?.keptAs, "byte-identical duplicate → dropped (keptAs unset)");
  ok(suppCount === 1, `supplements/ unchanged (still ${suppCount})`);
  ok(inboxNames(shared.inbox).length === 0, "inbox cleared");
}

// --- 8. add-then-attach lands the ENTRY in the same temp lib (libPath threading) ------
{
  fs.writeFileSync(path.join(shared.inbox, "beta.pdf"), pdfB);
  const s = await assignPdfs({ libPath: shared.lib, deps: okDeps });
  const r = s.results[0];
  ok(s.addedAttached === 1 && !!r?.key, "unknown paper → add+attach", JSON.stringify(r));
  const bib = fs.readFileSync(path.join(shared.lib, "library.bib"), "utf8");
  ok(bib.includes(DOI_B), "new entry written into the TEMP lib's library.bib (libPath threaded)");
  ok(fs.existsSync(path.join(shared.lib, "items", r!.key!, "paper.pdf")), "new paper.pdf filed");
}

// --- 9. a fresh foreign "assign" lock defers the scan --------------------------------
{
  const { lib, inbox } = mkLib();
  fs.writeFileSync(path.join(inbox, "a.pdf"), pdfA);
  const ldir = fluxlibLockDir(lib);
  fs.mkdirSync(ldir, { recursive: true });
  fs.writeFileSync(path.join(ldir, "assign.json"), JSON.stringify({ client: "human", pid: 99999, ts: new Date().toISOString() }));
  let deferred = false;
  try {
    await assignPdfs({ libPath: lib, deps: okDeps });
  } catch (e) {
    deferred = /deferred/.test(String((e as Error).message));
  }
  ok(deferred, "held foreign assign lock → scan defers with a clear message");
  ok(inboxNames(inbox).length === 1, "deferred scan touched nothing");
}

// --- 10. withHeartbeatLockAt restamps and releases ------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flux-assignh-hb-"));
  const lockFile = path.join(dir, "assign.json");
  let ts1 = "";
  await withHeartbeatLockAt(dir, "assign", "cli", async () => {
    ts1 = JSON.parse(fs.readFileSync(lockFile, "utf8")).ts;
    await new Promise((r) => setTimeout(r, 140));
  }, { heartbeatMs: 50 });
  ok(ts1 !== "", "heartbeat lock acquired");
  ok(!fs.existsSync(lockFile), "heartbeat lock released on exit");
  // Restamp proof: run again capturing mid-flight ts.
  let mid = "";
  await withHeartbeatLockAt(dir, "assign", "cli", async () => {
    const first = JSON.parse(fs.readFileSync(lockFile, "utf8")).ts;
    await new Promise((r) => setTimeout(r, 140));
    mid = JSON.parse(fs.readFileSync(lockFile, "utf8")).ts;
    ok(Date.parse(mid) > Date.parse(first), `heartbeat restamps the held lock (${first} → ${mid})`);
  }, { heartbeatMs: 50 });
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
