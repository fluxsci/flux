// One-off repair for the "Science paper is actually the supplement" bug (fixed in
// electron/proxyFetch.cjs). The old proxy capture gate accepted a downloadSupplement / _sm.pdf
// file AS paper.pdf. This script finds every item whose stored paper.pdf is really a supplement
// (source.json finalUrl matches the supplement pattern), and:
//   1. MOVES paper.pdf → items/<key>/supplements/<publisher-filename>  (the file IS a real
//      supplement — preserve it; the new "Switch PDF" reader control will list it), and
//   2. removes the now-stale paper.pdf / source.json / fulltext.txt so the next bulk "Get PDFs"
//      re-fetches the MAIN text with the fixed engine (a paper with no paper.pdf is re-attempted).
//
// DRY-RUN by default (prints the plan). Pass --write to perform the moves. Nothing is deleted —
// the supplement is relocated, not lost. Run: npx tsx scripts/repair-supplements.ts [--write]
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { safeSupplementName } from "../src/lib/references/items";

import { resolveFluxLibPathSync } from "../electron/fluxPaths.cjs";
const LIB = resolveFluxLibPathSync(); // derived from FluxConfig (legacy fallbacks pre-migration)
const ITEMS = path.join(LIB, "items");
const WRITE = process.argv.includes("--write");

// Same signal the fixed engine uses to keep supplements out of the main-PDF slot.
const rxSupp = /downloadsupplement|supplement|supporting[-_ ]?info|\/esm\/|(^|[-_/])mmc\d+\b|_sm\.pdf|_si\.pdf/i;

/** Best supplement filename: prefer the publisher's own `file=` param, else the URL's last
 *  path segment, else a key-derived fallback. Always a safe basename ending in .pdf. */
function suppNameFrom(finalUrl: string, key: string): string {
  try {
    const f = new URL(finalUrl).searchParams.get("file");
    if (f) return withPdf(safeSupplementName(decodeURIComponent(f)));
  } catch {
    /* not a parseable URL */
  }
  const seg = decodeURIComponent(finalUrl.split(/[?#]/)[0].split("/").pop() || "");
  if (/\.pdf$/i.test(seg)) return withPdf(safeSupplementName(seg));
  return `${safeSupplementName(key)}-supplement.pdf`;
}
const withPdf = (n: string) => (/\.pdf$/i.test(n) ? n : n + ".pdf");

interface Row {
  key: string;
  finalUrl: string;
  suppName: string;
  bytes: number;
}

const rows: Row[] = [];
for (const key of fs.existsSync(ITEMS) ? fs.readdirSync(ITEMS) : []) {
  const dir = path.join(ITEMS, key);
  const sp = path.join(dir, "source.json");
  const pp = path.join(dir, "paper.pdf");
  if (!fs.existsSync(sp) || !fs.existsSync(pp)) continue;
  let src: { finalUrl?: string; url?: string; source?: string };
  try {
    src = JSON.parse(fs.readFileSync(sp, "utf8"));
  } catch {
    continue;
  }
  const fu = String(src.finalUrl || src.url || "");
  if (!rxSupp.test(fu)) continue;
  rows.push({ key, finalUrl: fu, suppName: suppNameFrom(fu, key), bytes: fs.statSync(pp).size });
}

rows.sort((a, b) => a.key.localeCompare(b.key));
console.log(`mis-stored supplements found: ${rows.length}`);
for (const r of rows) console.log(`  ${r.key.padEnd(34)} ${(r.bytes / 1024 / 1024).toFixed(2)} MB  ->  supplements/${r.suppName}`);

if (!WRITE) {
  console.log("\nDRY RUN — nothing moved. Re-run with --write to relocate + queue re-fetch.");
  process.exit(0);
}

let moved = 0;
for (const r of rows) {
  const dir = path.join(ITEMS, r.key);
  const suppDir = path.join(dir, "supplements");
  fs.mkdirSync(suppDir, { recursive: true });
  // Never overwrite an existing supplement of the same name.
  let dst = path.join(suppDir, r.suppName);
  for (let i = 2; fs.existsSync(dst); i++) dst = path.join(suppDir, r.suppName.replace(/\.pdf$/i, `-${i}.pdf`));
  fs.renameSync(path.join(dir, "paper.pdf"), dst);
  // Drop provenance + derived text that describe the WRONG PDF, so the re-fetch is clean and the
  // paper (now lacking paper.pdf) is re-attempted by the next bulk run.
  for (const f of ["source.json", "fulltext.txt"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  moved++;
}
console.log(`\nmoved ${moved} supplement(s) into supplements/; cleared paper.pdf + source.json + fulltext.txt.`);
console.log("These papers now have NO main PDF and will be re-fetched (main text) on the next Get PDFs run.");
