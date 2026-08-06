// Repair for the "Science paper is actually the supplement" bug: find every item whose
// stored paper.pdf is really supplementary material, move it where it belongs, and clear the
// stale provenance so the next fetch gets the actual article.
//
// Detection uses the SHARED rules (electron/supplementRules.js) — the same ones the capture
// engine and the write-time check use — at BOTH layers: the recorded URL and the document's
// own first page. The URL layer alone is what let this recur: the first repair pass shipped
// with a copy of a regex that didn't match `/doi/suppl/…/devivo-sm.pdf`.
//
// DRY-RUN by default (prints the plan). Pass --write to perform the moves. Nothing is
// deleted — the supplement is relocated, and any annotations made on it travel with it.
// Run: npx tsx scripts/repair-supplements.ts [--write] [--key K]
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { safeSupplementName, parseSupplementManifest, type SupplementRecord } from "../src/lib/references/items";
import { extractPdfSignals } from "../flux-core/fulltext";

import { resolveFluxLibPathSync } from "../electron/fluxPaths.cjs";
import { supplementDocSignal, supplementNameFromUrl } from "../electron/supplementRules.js";

const LIB = resolveFluxLibPathSync(); // derived from FluxConfig (legacy fallbacks pre-migration)
const ITEMS = path.join(LIB, "items");
const WRITE = process.argv.includes("--write");
const ONLY_KEY = (() => {
  const i = process.argv.indexOf("--key");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

const withPdf = (n: string) => (/\.pdf$/i.test(n) ? n : n + ".pdf");

/** Best supplement filename: the publisher's own `file=`/last path segment, else key-derived. */
function suppNameFrom(finalUrl: string, key: string): string {
  const fromUrl = supplementNameFromUrl(finalUrl);
  if (fromUrl) return withPdf(safeSupplementName(fromUrl));
  return `${safeSupplementName(key)}-supplement.pdf`;
}

interface Row {
  key: string;
  finalUrl: string;
  suppName: string;
  bytes: number;
  signal: string;
  /** A byte-identical copy is already filed under supplements/ — drop the duplicate rather
   *  than storing the same file twice (the 2026-07 repair already moved several of these). */
  duplicateOf?: string;
  hasAnnotations: boolean;
}

async function scan(): Promise<Row[]> {
  const rows: Row[] = [];
  const keys = ONLY_KEY ? [ONLY_KEY] : fs.existsSync(ITEMS) ? fs.readdirSync(ITEMS) : [];
  for (const key of keys) {
    const dir = path.join(ITEMS, key);
    const sp = path.join(dir, "source.json");
    const pp = path.join(dir, "paper.pdf");
    if (!fs.existsSync(pp)) continue;
    let src: { finalUrl?: string; url?: string; source?: string } = {};
    try {
      src = JSON.parse(fs.readFileSync(sp, "utf8"));
    } catch {
      /* no provenance — still worth checking the document itself */
    }
    const fu = String(src.finalUrl || src.url || "");
    const buf = fs.readFileSync(pp);
    // Layer 1 (URL) then layer 2 (content) — content is what catches an innocent-looking URL.
    let signal: string | null = supplementDocSignal({ finalUrl: fu });
    if (!signal) {
      try {
        const s = await extractPdfSignals(new Uint8Array(buf));
        signal = supplementDocSignal({ title: s.xmpTitle ?? s.infoTitle, page1Text: s.page1Text });
      } catch {
        /* unreadable PDF — leave it alone rather than guess */
      }
    }
    if (!signal) continue;

    const suppName = suppNameFrom(fu, key);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    let duplicateOf: string | undefined;
    const suppDir = path.join(dir, "supplements");
    if (fs.existsSync(suppDir)) {
      for (const f of fs.readdirSync(suppDir)) {
        const fp = path.join(suppDir, f);
        if (!fs.statSync(fp).isFile() || f === "manifest.json") continue;
        if (fs.statSync(fp).size !== buf.length) continue; // cheap pre-filter
        if (crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex") === sha) {
          duplicateOf = f;
          break;
        }
      }
    }
    const annPath = path.join(dir, "annotations.json");
    let hasAnnotations = false;
    try {
      hasAnnotations = (JSON.parse(fs.readFileSync(annPath, "utf8"))?.annotations ?? []).length > 0;
    } catch {
      /* none */
    }
    rows.push({ key, finalUrl: fu, suppName, bytes: buf.length, signal, duplicateOf, hasAnnotations });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

const rows = await scan();
console.log(`mis-stored supplements found: ${rows.length}`);
for (const r of rows) {
  const dest = r.duplicateOf ? `already filed as supplements/${r.duplicateOf} (drop duplicate)` : `supplements/${r.suppName}`;
  console.log(`  ${r.key.padEnd(34)} ${(r.bytes / 1024 / 1024).toFixed(2)} MB  [${r.signal}]  ->  ${dest}`);
  if (r.hasAnnotations) console.log(`  ${" ".repeat(34)} ↳ annotations were made ON THIS FILE — they'll be preserved beside it`);
}

if (!rows.length) process.exit(0);
if (!WRITE) {
  console.log("\nDRY RUN — nothing moved. Re-run with --write to relocate + queue re-fetch.");
  process.exit(0);
}

let moved = 0;
for (const r of rows) {
  const dir = path.join(ITEMS, r.key);
  const suppDir = path.join(dir, "supplements");
  fs.mkdirSync(suppDir, { recursive: true });

  let stored: string;
  if (r.duplicateOf) {
    fs.rmSync(path.join(dir, "paper.pdf")); // identical bytes already preserved under supplements/
    stored = r.duplicateOf;
  } else {
    let dst = path.join(suppDir, r.suppName);
    for (let i = 2; fs.existsSync(dst); i++) dst = path.join(suppDir, r.suppName.replace(/\.pdf$/i, `-${i}.pdf`));
    fs.renameSync(path.join(dir, "paper.pdf"), dst);
    stored = path.basename(dst);
  }

  // Annotations were anchored into the SUPPLEMENT's text; they cannot resolve against the
  // main article and would silently vanish when it is re-fetched. Park them beside the file
  // they actually belong to rather than deleting them.
  const annPath = path.join(dir, "annotations.json");
  if (r.hasAnnotations && fs.existsSync(annPath)) fs.renameSync(annPath, path.join(suppDir, `${stored}.annotations.json`));

  // Index the relocated file so the reader can label it.
  try {
    const mp = path.join(suppDir, "manifest.json");
    const m = parseSupplementManifest(fs.existsSync(mp) ? fs.readFileSync(mp, "utf8") : null);
    if (!m.items.some((x) => x.name === stored)) {
      // Record the hash: it is what stops a later re-fetch of the same supplement laying
      // down a duplicate -2 copy beside this one.
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(suppDir, stored))).digest("hex");
      const rec: SupplementRecord = { name: stored, url: r.finalUrl || undefined, source: "repair", bytes: r.bytes, sha256: sha, fetchedAt: new Date().toISOString() };
      m.items.push(rec);
      m.items.sort((a, b) => a.name.localeCompare(b.name));
      fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
    }
  } catch {
    /* advisory index */
  }

  // Drop provenance + derived text that describe the WRONG PDF, so the paper (now lacking
  // paper.pdf) is re-attempted by the next fetch and its fulltext is rebuilt from the article.
  for (const f of ["source.json", "fulltext.txt"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  moved++;
}
console.log(`\nrepaired ${moved} item(s): supplement preserved under supplements/, paper.pdf + source.json + fulltext.txt cleared.`);
console.log("These papers now have NO main PDF and will be re-fetched (main text) on the next Get PDFs / fetch-pdfs run.");
