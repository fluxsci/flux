// One-off ledger surgery: drop ONLY the elsevier-group entries from the OA-miss ledger, so
// the re-unified bulk sweep re-attempts the Cell Press papers the old `bulkMode` filter had
// falsely recorded as "no-OA". Every non-elsevier miss (genuine PMC/closed/other) is kept —
// the sweep self-corrects those (false ones get fetched, real ones re-recorded).
//
// DRY-RUN by default (prints the classification only). Pass --write to back up the original
// (once) then rewrite the ledger. Uses the REAL doiGroup/hostGroup so the classification is
// identical to the fetch path. Run: npx tsx scripts/reset-elsevier-misses.ts [--write]
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { doiGroup, hostGroup } from "../src/lib/references/hostLimiter";

const LEDGER = path.join(os.homedir(), "FluxLib", ".fluxlib", "oa-misses.json");
const WRITE = process.argv.includes("--write");

type Miss = { at: string; attempts: number; sig: string };
type Ledger = { version: number; misses: Record<string, Miss> };

const raw = fs.readFileSync(LEDGER, "utf8");
const ledger = JSON.parse(raw) as Ledger;
const misses = ledger.misses ?? {};

// sig = `${doi}|${openAccessUrl}|${pmcid}` (oaSig). doi = first segment, pmcid = last, the URL
// is everything between (a URL can itself contain '|', so rejoin the middle segments).
function parseSig(sig: string): { doi: string; oaUrl: string; pmcid: string } {
  const parts = sig.split("|");
  return { doi: parts[0] ?? "", pmcid: parts[parts.length - 1] ?? "", oaUrl: parts.slice(1, -1).join("|") };
}
const isElsevier = (sig: string): boolean => {
  const { doi, oaUrl } = parseSig(sig);
  return doiGroup(doi) === "elsevier" || hostGroup(oaUrl) === "elsevier";
};

const keys = Object.keys(misses);
const drop = keys.filter((k) => isElsevier(misses[k].sig));
const keep = keys.filter((k) => !isElsevier(misses[k].sig));

console.log(`ledger: ${keys.length} misses`);
console.log(`  elsevier (to DROP): ${drop.length}`);
console.log(`  keep (genuine/other): ${keep.length}`);

const cellcom = drop.filter((k) => /cell\.com/.test(parseSig(misses[k].sig).oaUrl));
console.log(`  of the drops, ${cellcom.length} carry a direct cell.com OA URL (highest-confidence gets)`);

console.log("\nsample elsevier drops:");
for (const k of drop.slice(0, 8)) console.log(`  ${k}  sig=${misses[k].sig.slice(0, 72)}`);
console.log("\nsample keeps:");
for (const k of keep.slice(0, 8)) console.log(`  ${k}  sig=${misses[k].sig.slice(0, 72)}`);

if (!WRITE) {
  console.log("\nDRY RUN — nothing written. Re-run with --write to back up + rewrite.");
  process.exit(0);
}

const backup = LEDGER + ".bak-elsevier-reset";
if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw, "utf8"); // preserve the ORIGINAL, once
const kept: Record<string, Miss> = {};
for (const k of keep) kept[k] = misses[k];
const out: Ledger = { version: ledger.version ?? 1, misses: kept };
fs.writeFileSync(LEDGER, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`\nwrote ${keep.length} misses (dropped ${drop.length}); original backed up at ${backup}`);
