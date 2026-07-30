// Pure gate (hermetic): the Zotero sync engine — one-way, idempotent re-import of a
// Better-BibTeX "Keep updated" auto-export into FluxLib (2026-07-29). Covers: settings
// parsing + --save persistence, add/dedupe through the shared planner, BBT-style
// re-keying on collision, copy-mode attach, the merged-entry PDF BACKFILL (a PDF that
// arrives in Zotero after the entry did), link-mode pointers + their read resolution
// and missing-file degradation, and ONE execution of the real CLI verb (parse-level
// parity never invokes handlers — the cascade-tracks lesson).
//   Run: npx tsx scripts/verify-zotero-sync.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fails = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
  if (!cond) fails++;
};

// --- hermetic env: HOME + XDG into a scratch dir BEFORE flux-core loads ------------------
const repoRoot = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-zotero-gate-"));
const home = path.join(scratch, "home");
fs.mkdirSync(path.join(home, ".config"), { recursive: true });
const realEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FLUX_NO_MIGRATE: process.env.FLUX_NO_MIGRATE };
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.FLUX_NO_MIGRATE = "1";

// --- the fake Zotero: storage/ + a BBT auto-export ---------------------------------------
const zdir = path.join(scratch, "Zotero");
const store1 = path.join(zdir, "storage", "ABKEY1");
const store2 = path.join(zdir, "storage", "ABKEY2");
const store3 = path.join(zdir, "storage", "ABKEY3");
const store4 = path.join(zdir, "storage", "ABKEY4");
for (const d of [store1, store2, store3, store4]) fs.mkdirSync(d, { recursive: true });
const samplePdf = fs.readFileSync(path.join(repoRoot, "scripts", "fixtures", "reader-sample.pdf"));
fs.writeFileSync(path.join(store1, "Smith2021.pdf"), samplePdf);
fs.writeFileSync(path.join(store2, "Jones2022.pdf"), samplePdf);
fs.writeFileSync(path.join(store3, "Brown2023.pdf"), samplePdf);
fs.writeFileSync(path.join(store4, "Green2024.pdf"), samplePdf);
const bibPath = path.join(zdir, "fluxsync.bib");

const SMITH = `@article{smithNeuralBasis2021,
  title = {Neural basis of X},
  author = {Smith, Jane},
  year = {2021},
  doi = {10.1/a},
  file = {Full Text PDF:storage/ABKEY1/Smith2021.pdf:application/pdf}
}`;
const JONES_NO_PDF = `@article{jonesOtherThings2022,
  title = {Other things entirely},
  author = {Jones, Kim},
  year = {2022},
  doi = {10.2/b}
}`;
const JONES_WITH_PDF = JONES_NO_PDF.replace(
  "doi = {10.2/b}",
  "doi = {10.2/b},\n  file = {Full Text PDF:storage/ABKEY2/Jones2022.pdf:application/pdf}",
);
// Key collision with SMITH's key but a DIFFERENT paper → must re-key BBT-style.
const SMITH_CLASH = `@article{smithNeuralBasis2021,
  title = {Different paper on Y},
  author = {Smith, Alex},
  year = {2021},
  doi = {10.4/d}
}`;
const BROWN = `@article{brownDeepThings2023,
  title = {Deep things considered},
  author = {Brown, Pat},
  year = {2023},
  doi = {10.3/c},
  file = {Full Text PDF:storage/ABKEY3/Brown2023.pdf:application/pdf}
}`;
const GREEN = `@article{greenLazyMatters2024,
  title = {Lazy matters},
  author = {Green, Sam},
  year = {2024},
  doi = {10.5/e},
  file = {Full Text PDF:storage/ABKEY4/Green2024.pdf:application/pdf}
}`;

async function main() {
  const refs = await import("../flux-core/references");
  const items = await import("../flux-core/items");
  const { getOrExtractFulltext } = await import("../flux-core/fulltext");
  const { parseZoteroSettings, isBigBib, estimateBibEntries, BIG_BIB_BYTES } = await import(
    "../src/lib/references/zoteroSettings"
  );
  const fluxlib = await import("../flux-core/fluxlib");
  const lib = await fluxlib.resolveFluxLibPath();

  // --- settings parsing ------------------------------------------------------------------
  ok(parseZoteroSettings(undefined) === null, "no settings -> null");
  ok(parseZoteroSettings({ bibPath: "" }) === null, "blank bibPath -> null");
  ok(parseZoteroSettings("garbage") === null, "malformed settings -> null (never throws)");
  const parsed = parseZoteroSettings({ bibPath: "/x/y.bib" });
  ok(parsed?.attach === "copy" && parsed?.auto === true && parsed?.deferFulltext === false, "defaults: attach=copy, auto=true, deferFulltext=false");
  ok(parseZoteroSettings({ bibPath: "/x/y.bib", deferFulltext: true })?.deferFulltext === true, "deferFulltext parses");

  // --- big-export suggestion helpers (the connect dialog's auto-suggest) ------------------
  ok(!isBigBib(BIG_BIB_BYTES - 1) && isBigBib(BIG_BIB_BYTES), "isBigBib threshold is exact");
  ok(estimateBibEntries(45_000_000) > 20_000, `45MB estimates a huge library (${estimateBibEntries(45_000_000)})`);

  // --- pass 1: two new entries, one PDF, --save ------------------------------------------
  fs.writeFileSync(bibPath, `${SMITH}\n\n${JONES_NO_PDF}\n`);
  const r1 = await refs.zoteroSync({ bib: bibPath, dataDir: zdir, attach: "copy", save: true });
  ok(r1.summary.added === 2 && r1.summary.attached === 1 && r1.summary.failed === 0, `pass 1: 2 added, 1 PDF copied (${r1.line})`);
  ok(r1.report.added.includes("smithNeuralBasis2021"), "well-formed BBT key from Zotero is KEPT");
  const prefs = JSON.parse(fs.readFileSync(path.join(home, ".config", "flux", "preferences.json"), "utf8"));
  ok(prefs?.zotero?.bibPath === bibPath && prefs?.zotero?.attach === "copy", "--save persisted the machine settings");
  const smithPdf = path.join(lib, "items", "smithNeuralBasis2021", "paper.pdf");
  ok(fs.existsSync(smithPdf) && fs.readFileSync(smithPdf).length === samplePdf.length, "paper.pdf copied byte-complete");

  // --- pass 2: same bib again — a no-op (idempotent) --------------------------------------
  const r2 = await refs.zoteroSync({}); // stored settings from --save
  ok(r2.summary.added === 0 && r2.summary.merged === 2 && r2.summary.attached === 0, `pass 2: re-sync is a no-op (${r2.line})`);

  // --- pass 3: Zotero gained a PDF for a known entry → BACKFILL; a clashing key re-keys ---
  fs.writeFileSync(bibPath, `${SMITH}\n\n${JONES_WITH_PDF}\n\n${SMITH_CLASH}\n`);
  const r3 = await refs.zoteroSync({});
  ok(r3.summary.merged === 2 && r3.summary.attached === 1, `pass 3: PDF-less known entry backfilled (${r3.line})`);
  ok(fs.existsSync(path.join(lib, "items", "jonesOtherThings2022", "paper.pdf")), "backfilled paper.pdf on disk");
  ok(r3.report.added.length === 1 && r3.report.added[0] === "smithDifferentPaperY2021", `key clash re-keys BBT-style (${r3.report.added[0]})`);
  // Smith's stored PDF was never displaced (mtime-free check: bytes still the fixture).
  ok(fs.readFileSync(smithPdf).length === samplePdf.length, "existing PDF never displaced");

  // --- pass 4: link mode — pointer written, resolvable, degrades when the file moves ------
  fs.appendFileSync(bibPath, `\n${BROWN}\n`);
  const r4 = await refs.zoteroSync({ attach: "link" });
  ok(r4.summary.added === 1 && r4.summary.linked === 1, `pass 4: new entry linked, not copied (${r4.line})`);
  const brownDir = path.join(lib, "items", "brownDeepThings2023");
  ok(fs.existsSync(path.join(brownDir, "paper.link.json")) && !fs.existsSync(path.join(brownDir, "paper.pdf")), "pointer on disk, no copied bytes");
  ok(await items.hasPdf("brownDeepThings2023"), "hasPdf counts a pointer");
  const viaLink = await items.readPdf("brownDeepThings2023");
  ok(!!viaLink && viaLink.length === samplePdf.length, "readPdf resolves through the pointer");
  fs.renameSync(path.join(store3, "Brown2023.pdf"), path.join(store3, "Brown2023.moved.pdf"));
  ok((await items.readPdf("brownDeepThings2023")) === null, "moved external file degrades to null, not an error");

  // --- pass 5: link + deferFulltext — pointer from a stat alone; text backfills lazily ----
  fs.appendFileSync(bibPath, `\n${GREEN}\n`);
  const r5 = await refs.zoteroSync({ attach: "link", deferFulltext: true });
  ok(r5.summary.added === 1 && r5.summary.linked === 1, `pass 5: deferred link attach (${r5.line})`);
  const greenDir = path.join(lib, "items", "greenLazyMatters2024");
  ok(fs.existsSync(path.join(greenDir, "paper.link.json")), "deferred pointer on disk");
  ok(!fs.existsSync(path.join(greenDir, "fulltext.txt")), "NO fulltext.txt written at sync time (deferred)");
  ok(!fs.existsSync(path.join(greenDir, "paper.pdf")), "no copied bytes either");
  // The lazy backfill: getOrExtractFulltext resolves the pointer, extracts, and caches.
  const lazy = await getOrExtractFulltext("greenLazyMatters2024");
  ok(!!lazy && lazy.includes("FluxReader Fixture"), "getOrExtractFulltext backfills through the pointer");
  ok(fs.existsSync(path.join(greenDir, "fulltext.txt")), "backfilled text is cached to fulltext.txt");

  // --- the real CLI executes the verb (stored settings; no flags) -------------------------
  const cli = spawnSync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoRoot, "flux-cli.ts"), "zotero-sync"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env } },
  );
  ok(cli.status === 0, `CLI zotero-sync exits 0 (${cli.status})`, cli.stderr?.slice(0, 300));
  ok(/✓ Zotero sync/.test(cli.stderr ?? ""), "CLI prints the sync summary", cli.stderr?.slice(0, 200));
}

main()
  .catch((e) => {
    console.error("✗ gate crashed:", e);
    fails++;
  })
  .finally(() => {
    process.env.HOME = realEnv.HOME;
    if (realEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = realEnv.XDG_CONFIG_HOME;
    if (realEnv.FLUX_NO_MIGRATE === undefined) delete process.env.FLUX_NO_MIGRATE;
    else process.env.FLUX_NO_MIGRATE = realEnv.FLUX_NO_MIGRATE;
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* scratch is in tmp either way */
    }
    console.log(`\n##VERIFY## ${JSON.stringify({ name: "zotero-sync", pass: fails === 0, fails })}`);
    process.exit(fails ? 1 : 0);
  });
