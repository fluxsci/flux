#!/usr/bin/env -S npx tsx
// WS-8.3 (fortify plan) — enrich payload slimming: the ~12MB enrich.json used
// to be parsed wholesale on the renderer main thread for DISPLAY reads. Both
// write funnels (flux-core writeEnrich + the renderer's locked hydrate/remove)
// now emit a GRID projection (.fluxlib/enrich-grid.json, display fields only,
// compact JSON) after the full file, and the renderer's mtime-keyed cache
// reads whichever is fresher — grid preferred, full as fallback.
//   npx tsx scripts/verify-enrich-grid.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { projectEnrichForGrid, GRID_ENRICH_FIELDS } = await import("../src/lib/references/enrich");
const { writeEnrich, loadEnrich, ensureFluxLib } = await import("../flux-core/fluxlib");

// ---- 1. the projection itself --------------------------------------------------
const fat = {
  paper1: {
    key: "paper1",
    doi: "10.1/x",
    openalexId: "W123",
    abstract: "An abstract.",
    primaryTopic: { name: "Neuroscience" },
    topics: [{ name: "Neuroscience" }, { name: "Vision" }],
    keywords: ["cortex"],
    citedByCount: 42,
    openAccess: { isOa: true, url: "https://arxiv.org/pdf/1" },
    authors: [{ name: "Doe, J." }],
    ids: { pmcid: "PMC1", pmid: "1" },
    fetchedAt: "2026-01-01T00:00:00Z",
    sources: ["openalex"],
    // the bulk that must NOT reach the grid:
    referencedWorks: Array.from({ length: 300 }, (_, i) => `W${i}`),
    relatedWorks: Array.from({ length: 50 }, (_, i) => `R${i}`),
    countsByYear: Array.from({ length: 30 }, (_, i) => ({ year: 1996 + i, cited: i })),
    mesh: ["D001", "D002"],
    embedding: Array.from({ length: 256 }, () => 0.5),
  },
} as never;
{
  const grid = projectEnrichForGrid(fat) as Record<string, Record<string, unknown>>;
  const g = grid.paper1;
  for (const f of GRID_ENRICH_FIELDS) {
    if ((fat as Record<string, Record<string, unknown>>).paper1[f] !== undefined && g[f] === undefined)
      fail(`projection LOST display field "${f}"`);
  }
  ok("projection keeps every display field (grid/hover/query/OA-gating read set)");
  for (const heavy of ["referencedWorks", "relatedWorks", "countsByYear", "mesh", "embedding"]) {
    if (g[heavy] !== undefined) fail(`projection leaked heavy field "${heavy}"`);
  }
  ok("projection drops the graph/edge bulk (referencedWorks/relatedWorks/countsByYear/mesh/embedding)");
  const fatBytes = JSON.stringify(fat).length;
  const gridBytes = JSON.stringify(grid).length;
  assert(gridBytes < fatBytes / 3, `projection is a fraction of the full entry (${gridBytes}B vs ${fatBytes}B)`);
}

// ---- 2. the flux-core funnel emits both files with grid.mtime ≥ full.mtime ------
const lib = await fs.mkdtemp(path.join(os.tmpdir(), "flux-egrid-"));
try {
  await ensureFluxLib(lib);
  await writeEnrich(fat, lib);
  const fullP = path.join(lib, ".fluxlib", "enrich.json");
  const gridP = path.join(lib, ".fluxlib", "enrich-grid.json");
  const [fullSt, gridSt] = await Promise.all([fs.stat(fullP), fs.stat(gridP)]);
  assert(gridSt.mtimeMs >= fullSt.mtimeMs, "grid written AFTER the full file (the freshness rule holds)");
  const gridOnDisk = JSON.parse(await fs.readFile(gridP, "utf8"));
  assert(gridOnDisk.paper1?.abstract === "An abstract." && gridOnDisk.paper1?.referencedWorks === undefined,
    "on-disk grid = the projection");
  const full = await loadEnrich(lib);
  assert(Array.isArray((full.paper1 as { referencedWorks?: string[] }).referencedWorks),
    "the FULL sidecar (locked writers' source of truth) still carries the bulk");

  // ---- 3. staleness: an external write to the full file outdates the grid ------
  await sleep(20);
  await fs.writeFile(fullP, JSON.stringify({ ...fat, paper2: { key: "paper2", fetchedAt: "x", sources: [] } }, null, 2));
  const [fullSt2, gridSt2] = await Promise.all([fs.stat(fullP), fs.stat(gridP)]);
  assert(fullSt2.mtimeMs > gridSt2.mtimeMs, "an external full-file write leaves the grid STALE (renderer falls back to full)");
} finally {
  await fs.rm(lib, { recursive: true, force: true });
}

console.log(failures ? `\nENRICH GRID: FAIL (${failures})` : "\nENRICH GRID: PASS");
process.exit(failures ? 1 : 0);
