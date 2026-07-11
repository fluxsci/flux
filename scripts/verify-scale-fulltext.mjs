// WS-8.4 gate — the persistent full-text index at library scale. Seeds 5,000
// items/<key>/fulltext.txt files (multi-page, form-feed joined), then asserts:
//   • first indexed query BUILDS .fluxlib/fulltext-index.json;
//   • a WARM indexed query answers < 300ms;
//   • indexed results EXACTLY match the linear-scan oracle (same seam,
//     forceScan) across term/multi-term/phrase/punctuation/keys-restricted
//     queries — phrase + punctuation queries fall back to the scan by design;
//   • staleness delta: touching ONE doc re-tokenizes without a full rebuild
//     and changed content becomes searchable.
// Node-only (no browser).  Run: node --import tsx scripts/verify-scale-fulltext.mjs
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { searchFulltext } = await import("../flux-core/fulltextSearch.ts");

const N = 5000;
const WARM_BUDGET_MS = 300;
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const fail = (m) => {
  console.error("  ✗ " + m);
  failures++;
};
const assert = (c, m) => (c ? ok(m) : fail(m));

const WORDS = ["cortex", "sleep", "dynamics", "synapse", "oscillation", "memory", "plasticity", "circuit", "dendrite", "attention"];
const lib = await fs.mkdtemp(path.join(os.tmpdir(), "flux-ftscale-"));
const items = path.join(lib, "items");
await fs.mkdir(path.join(lib, ".fluxlib"), { recursive: true });

console.log(`seeding ${N} fulltext docs…`);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const key = `paper${i}`;
  const w1 = WORDS[i % WORDS.length];
  const w2 = WORDS[(i * 3 + 1) % WORDS.length];
  const pages = [
    `Title page of ${key}. This study concerns ${w1} and its role.`,
    `Methods: we probed ${w1} under condition ${i % 12}. The ${w2} pathway was recorded.`,
    `Results: robust ${w1}-${w2} coupling. NEEDLE${i % 500} appears here.`,
  ];
  await fs.mkdir(path.join(items, key), { recursive: true });
  await fs.writeFile(path.join(items, key, "fulltext.txt"), pages.join("\f"));
}
console.log(`  seeded in ${Date.now() - t0}ms`);

// Canonical form: the SCAN's tie order is nondeterministic (8 concurrent
// workers push in completion order), so equal-count hits are key-sorted before
// comparing — per-hit content (count + snippets) stays exact.
const norm = (r) =>
  JSON.stringify({
    hits: r.hits.slice().sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)),
    missingText: r.missingText.slice().sort(),
  });

// ---- 1. build on first query, then WARM speed ---------------------------------
const b0 = Date.now();
await searchFulltext("cortex", { libPath: lib, limit: 20 });
console.log(`  first query (index build) took ${Date.now() - b0}ms`);
assert(
  await fs.stat(path.join(lib, ".fluxlib", "fulltext-index.json")).then(() => true, () => false),
  "first query built .fluxlib/fulltext-index.json",
);
const w0 = Date.now();
const warm = await searchFulltext("cortex sleep", { libPath: lib, limit: 20 }); // co-occurring pair (i≡0 mod 10)
const warmMs = Date.now() - w0;
assert(warm.hits.length > 0, `warm query found ${warm.hits.length} hits`);
assert(warmMs < WARM_BUDGET_MS, `warm indexed query ${warmMs}ms < ${WARM_BUDGET_MS}ms at ${N} docs`);

// ---- 2. oracle equality across query shapes ------------------------------------
const QUERIES = [
  ["single term", "plasticity", {}],
  ["multi-term AND", "cortex sleep", {}],
  ["multi-term AND (disjoint → empty)", "cortex memory", {}],
  ["substring-of-token", "scillat", {}], // the scan is substring matching — the index must be too
  ["rare exact", "needle42", {}],
  ["phrase (scan fallback)", '"robust cortex-sleep coupling"', {}],
  ["punctuation (scan fallback)", "cortex-sleep", {}],
  ["keys-restricted", "cortex", { keys: ["paper0", "paper10", "paper20", "paper999"] }],
  ["no matches", "zzzzunfindable", {}],
];
for (const [label, q, extra] of QUERIES) {
  const viaIndex = await searchFulltext(q, { libPath: lib, limit: 4000, ...extra });
  const oracle = await searchFulltext(q, { libPath: lib, limit: 4000, forceScan: true, ...extra });
  assert(norm(viaIndex) === norm(oracle), `${label}: indexed ≡ linear-scan oracle (${viaIndex.hits.length} hits)`);
}
// Truncation case: limits agree even when both paths cap.
{
  const a = await searchFulltext("cortex", { libPath: lib, limit: 25 });
  const b = await searchFulltext("cortex", { libPath: lib, limit: 25, forceScan: true });
  assert(a.hits.length === 25 && b.hits.length === 25 && a.truncated && b.truncated,
    "truncation: both paths cap at the limit and flag truncated");
}

// ---- 3. staleness delta: one changed doc, no full rebuild -----------------------
{
  const idxPath = path.join(lib, ".fluxlib", "fulltext-index.json");
  const before = JSON.parse(await fs.readFile(idxPath, "utf8"));
  await new Promise((r) => setTimeout(r, 15));
  await fs.writeFile(path.join(items, "paper7", "fulltext.txt"), "A fresh take on GLIMMERWORT only.\fSecond page.");
  const d0 = Date.now();
  const r = await searchFulltext("glimmerwort", { libPath: lib, limit: 10 });
  const deltaMs = Date.now() - d0;
  assert(r.hits.length === 1 && r.hits[0].key === "paper7", "changed doc becomes searchable (delta re-tokenize)");
  assert(deltaMs < WARM_BUDGET_MS, `delta refresh + query ${deltaMs}ms < ${WARM_BUDGET_MS}ms (no full rebuild)`);
  const after = JSON.parse(await fs.readFile(idxPath, "utf8"));
  assert(after.docs.paper7.mtimeMs !== before.docs.paper7.mtimeMs, "index recorded the new mtime");
  const oracle = await searchFulltext("glimmerwort", { libPath: lib, limit: 10, forceScan: true });
  assert(norm(r) === norm(oracle), "post-delta indexed ≡ oracle");
}

// ---- 4. missing-text parity (pdf without text) -----------------------------------
{
  await fs.mkdir(path.join(items, "pdfonly"), { recursive: true });
  await fs.writeFile(path.join(items, "pdfonly", "paper.pdf"), "%PDF-1.4 stub\n%%EOF");
  const a = await searchFulltext("cortex", { libPath: lib, limit: 5 });
  assert(a.missingText.includes("pdfonly"), "pdf-without-text lands in missingText via the index path");
}

await fs.rm(lib, { recursive: true, force: true });
console.log(failures ? `\nSCALE-FULLTEXT: FAIL (${failures})` : "\nSCALE-FULLTEXT: PASS");
process.exit(failures ? 1 : 0);
