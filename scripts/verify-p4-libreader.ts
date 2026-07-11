#!/usr/bin/env -S npx tsx
// Phase 4 — Library / Reader / shell bug sweep. The dedup fix (LR-9) is tested for real against
// flux-core's addToFluxLib on a temp FluxLib; the rest (renderer bridge twin, reader DOM, proxy
// network path, main-process handlers) are asserted present + covered by svelte-check / build.
//
//  LR-9  (tested): adding a paper WITHOUT a DOI then the SAME paper WITH a DOI used to fork into
//        two citekeys (splitting its PDF + annotations). A shared title+year+author signature
//        (dupeSignature) now collapses them; distinct papers are untouched. Applied in BOTH
//        engines (flux-core/fluxlib.ts + references/fluxlibBridge.ts) from one shared helper.
//  LR-13 (presence): the reader caches each annotation's located range (was a fuzzy full-page
//        locateQuote per annotation on every redraw) and reports quotes that no longer locate as
//        orphaned to the annotations panel (a detached highlight is no longer silently invisible).
//  LR-14 (presence): the proxy PDF grab also accepts a full 200 whose byte length == Content-Length
//        (rescues valid PDFs whose %%EOF sits beyond the last-8KB window).
//  SHL-18(presence): pty:create returns the shell PATH (not the electron `shell` module); fs:exists
//        distinguishes ENOENT (absent) from EACCES (exists-but-blocked).
//  LR-10 (presence): an all-batches-failed enrich run throws instead of reporting "Enriched 0".
//  LR-8  (presence): GUI-fetched PDFs stay searchable via getPaperText's extract-on-demand.
//   Run: npx tsx scripts/verify-p4-libreader.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dupeSignature } from "../src/lib/references/citekey";
import { addToFluxLib, ensureFluxLib, loadLibrary } from "../flux-core/fluxlib";

function assert(c: unknown, m: string) {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ok:", m);
}

// --- LR-9 (pure): the dedupe signature -----------------------------------------------------
console.log("LR-9 — dedupe signature:");
const sig = (title: string, authors: string[], year: string) => dupeSignature({ title, authors, year });
assert(
  sig("Deep Learning for Genomics", ["Smith"], "2020") === sig("deep  learning, for genomics.", ["smith"], "2020"),
  "same paper (case/punct/space-insensitive) → same signature",
);
assert(sig("Deep Learning for Genomics", ["Smith"], "2020") !== sig("A Different Paper Entirely", ["Smith"], "2020"), "different title → different signature");
assert(dupeSignature({ title: "short", authors: ["Smith"], year: "2020" }) === null, "too-short title → null (won't dedupe)");
assert(dupeSignature({ title: "A perfectly long title here", authors: [], year: "" }) === null, "no author AND no year → null");

// --- LR-9 (integration): add-without-DOI then add-same-with-DOI collapses to one entry ------
console.log("LR-9 — flux-core addToFluxLib collapses a no-DOI + with-DOI duplicate:");
const lib = await fs.mkdtemp(path.join(os.tmpdir(), "flux-p4-lib-"));
await ensureFluxLib(lib);
const noDoi = `@article{smith2020, title={Deep Learning for Genomics}, author={Smith, Jane}, year={2020}}`;
const withDoi = `@article{zzz, title={Deep Learning for Genomics}, author={Smith, Jane}, year={2020}, doi={10.1000/xyz}}`;
const other = `@article{jones2019, title={Totally Unrelated Work on Something Else}, author={Jones, Bob}, year={2019}}`;

const r1 = await addToFluxLib(noDoi, { source: "bibtex", libPath: lib });
assert(r1.added.length === 1, "first add (no DOI) → 1 added");
const r2 = await addToFluxLib(withDoi, { source: "doi", libPath: lib });
assert(r2.added.length === 0 && r2.deduped.length === 1, "re-add same paper WITH a DOI → deduped, not a second entry");
assert(r2.keys[0] === r1.keys[0], "the dedupe maps to the SAME citekey (PDF/annotations stay unified)");
const r3 = await addToFluxLib(other, { source: "bibtex", libPath: lib });
assert(r3.added.length === 1, "a genuinely different paper is NOT deduped");
const all = await loadLibrary(lib);
assert(all.length === 2, `library holds exactly 2 entries (had 3 adds, 1 was a dup) — got ${all.length}`);
await fs.rm(lib, { recursive: true, force: true });

// --- presence of the bridge-twin / DOM / network / main-process fixes ----------------------
console.log("presence of the bridge/DOM/network/main-process fixes:");
const read = (p: string) => fs.readFile(path.join(import.meta.dirname, "..", p), "utf8");
const [bridge, core, addPlan, pdfView, reader, proxy, mainCjs, enrichBridge, fulltext] = await Promise.all([
  read("src/lib/references/fluxlibBridge.ts"),
  read("flux-core/fluxlib.ts"),
  read("src/lib/references/addPlan.ts"),
  read("src/shell/modes/reader/PdfView.svelte"),
  read("src/shell/modes/reader/ReaderMode.svelte"),
  read("electron/proxyFetch.cjs"),
  read("electron/main.cjs"),
  read("src/lib/references/enrichBridge.ts"),
  read("flux-core/fulltext.ts"),
]);
// LR-9 / 2.4: the dedupe+rekey decision now lives in ONE shared pure planner (addPlan.ts)
// that BOTH engines call — stronger than the old byte-identical copies (preview == outcome).
assert(/planAdds/.test(bridge) && /planAdds/.test(core), "LR-9: both engines add via the SHARED planner — no engine drift");
assert(/sigToKey/.test(addPlan) && /dupeSignature/.test(addPlan), "LR-9: the shared planner applies the title+year+author signature dedup");
assert(/const locCache = new Map/.test(pdfView) && /onOrphans\?\.\(/.test(pdfView), "LR-13: PdfView caches located ranges + reports orphans");
assert(/onOrphans=\{/.test(reader) && /class:orphan=/.test(reader), "LR-13: ReaderMode surfaces orphaned highlights in the panel");
assert(/g\.len === g\.contentLength/.test(proxy) && /const whole =/.test(proxy), "LR-14: the proxy grab accepts a whole (length==Content-Length) download");
assert(/shell: command/.test(mainCjs), "SHL-18: pty:create returns the shell PATH, not the electron shell module");
// WS-9.4b: fs:exists lives in the FILES family module now.
const filesCjs = await fs.readFile(new URL("../electron/ipc/files.cjs", import.meta.url), "utf8");
assert(/err\.code !== "ENOENT"/.test(filesCjs), "SHL-18: fs:exists distinguishes ENOENT from EACCES");
assert(/failedBatches === urls\.length/.test(enrichBridge), "LR-10: an all-batches-failed enrich run throws (not 'Enriched 0')");
assert(/extract-on-demand|extract on demand|extractFulltext\(new Uint8Array/.test(fulltext), "LR-8: getPaperText extracts on demand so GUI-fetched PDFs stay searchable");

console.log("\nP4 LIBRARY/READER/SHELL VERIFY: PASS");
