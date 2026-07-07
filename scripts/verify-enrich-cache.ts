// V1-readiness 1.1 gate — the enrich.json parse cache (B1, the dominant scale wall:
// a ~12MB JSON.parse ran on Library mount + every revision bump + PER LOOKUP).
// Pure factory tests with injected stat/load counters, plus the flux-core twin
// against a real temp file. Run: npx tsx scripts/verify-enrich-cache.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEnrichCache } from "../src/lib/references/enrichStore";
import type { EnrichMap } from "../src/lib/references/enrich";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- factory: one parse per file identity ------------------------------------------
{
  let statN = 0;
  let loadN = 0;
  let ident = { mtimeMs: 1, size: 100 };
  const cache = createEnrichCache({
    path: async () => "/lib/.fluxlib/enrich.json",
    stat: async () => {
      statN++;
      return ident;
    },
    load: async () => {
      loadN++;
      return { k1: { key: "k1" } } as unknown as EnrichMap;
    },
  });
  for (let i = 0; i < 12; i++) await cache.get();
  ok(loadN === 1, `12 sequential get() → 1 parse (made ${loadN})`);
  ok(statN === 12, "every get() stats (cheap identity check)");
  await cache.getKey("k1");
  ok(loadN === 1, "getKey() rides the same cache");

  ident = { mtimeMs: 2, size: 120 }; // the file changed on disk
  await cache.get();
  ok(loadN === 2, "stat change → exactly one re-parse");

  cache.invalidate();
  await cache.get();
  ok(loadN === 3, "invalidate() → re-parse even with an unchanged stat");
}

// --- concurrent callers share ONE in-flight parse ------------------------------------
{
  let loadN = 0;
  let release: (m: EnrichMap) => void = () => {};
  const gate = new Promise<EnrichMap>((r) => (release = r));
  const cache = createEnrichCache({
    path: async () => "/x",
    stat: async () => ({ mtimeMs: 1, size: 1 }),
    load: () => {
      loadN++;
      return gate;
    },
  });
  const a = cache.get();
  const b = cache.get();
  const c = cache.get();
  release({} as EnrichMap);
  await Promise.all([a, b, c]);
  ok(loadN === 1, `3 concurrent get() share one in-flight parse (made ${loadN})`);
}

// --- degraded environments ------------------------------------------------------------
{
  let loadN = 0;
  const noLib = createEnrichCache({
    path: async () => null,
    stat: async () => null,
    load: async () => {
      loadN++;
      return {} as EnrichMap;
    },
  });
  const m = await noLib.get();
  ok(Object.keys(m).length === 0 && loadN === 0, "no FluxLib → {} without a load");

  let freshN = 0;
  const noStat = createEnrichCache({
    path: async () => "/x",
    stat: async () => null, // bridge without stat (fixture/old preload)
    load: async () => {
      freshN++;
      return {} as EnrichMap;
    },
  });
  await noStat.get();
  await noStat.get();
  ok(freshN === 2, "no stat capability → stays fresh (never serves a stale map)");
}

// --- flux-core twin: real file, real mtime keying ---------------------------------------
{
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "flux-enrichcache-"));
  fs.mkdirSync(path.join(lib, ".fluxlib"), { recursive: true });
  const p = path.join(lib, ".fluxlib", "enrich.json");
  fs.writeFileSync(p, JSON.stringify({ a: { key: "a" } }));
  const { loadEnrich } = await import("../flux-core/fluxlib");
  const m1 = await loadEnrich(lib);
  const m2 = await loadEnrich(lib);
  ok(m1 === m2, "flux-core: unchanged file → same cached object (no re-parse)");
  await new Promise((r) => setTimeout(r, 15)); // ensure a distinct mtime
  fs.writeFileSync(p, JSON.stringify({ a: { key: "a" }, b: { key: "b" } }));
  const m3 = await loadEnrich(lib);
  ok(m3 !== m2 && "b" in m3, "flux-core: rewritten file → re-parsed with the new content");
  fs.rmSync(lib, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
