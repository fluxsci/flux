// Pure gate: the dev server's start-up crawl finds every dependency, so it never re-optimizes
// mid-run and reloads every open page.
//
// Vite discovers dependencies by crawling index.html's import graph. A package imported ONLY
// from a Web Worker entry is invisible to that crawl; the first time the worker asks for it,
// Vite optimizes it and broadcasts a FULL RELOAD to every client. Under the ui verify tier that
// reload lands on whatever gate is running — 2026-09-26 it reloaded the plot-gallery gate's
// opener, whose `pagehide` closed the pinned popup, and the next click hit a closed target.
// The fix is `optimizeDeps.include` in vite.config.ts; this gate keeps that list complete:
//
//   1. every bare package import in a worker entry (src/**/*.worker.ts) must be in the set the
//      COLD crawl produces (a real `optimizeDeps` run into a scratch cache — node_modules
//      only, no network, ~10 s);
//   2. the known worker-only imports are named explicitly, so a regression reads as itself.
//
//   npx tsx scripts/verify-dev-prebundle.ts
import { readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-dev-prebundle");
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// --- 1: what the workers import ---------------------------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.worker\.(ts|js|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}
const workers = walk(path.join(repo, "src"));
h.ok(workers.length > 0, `worker entries found: ${workers.map((w) => path.relative(repo, w)).join(", ")}`);
const bare = new Set<string>();
for (const file of workers) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bfrom\s+["']([^"'./][^"']*)["']|\bimport\(\s*["']([^"'./][^"']*)["']\s*\)/g)) {
    const spec = m[1] ?? m[2];
    if (spec && !spec.startsWith("node:")) bare.add(spec);
  }
}
h.ok(bare.has("harper.js") && bare.has("harper.js/slimBinary"), `the spell-check worker imports harper.js and harper.js/slimBinary (worker-only imports: ${[...bare].sort().join(", ")})`);

// --- 2: what the cold crawl finds -------------------------------------------------------------
const scratch = mkdtempSync(path.join(tmpdir(), "flux-prebundle-"));
let optimized = new Set<string>();
try {
  const vite = await import("vite");
  const config = await vite.resolveConfig({ configFile: path.join(repo, "vite.config.ts"), root: repo, cacheDir: scratch, logLevel: "silent" }, "serve", "development");
  // Vite's public optimizer entry point (it warns that servers call it themselves; a gate
  // asking what the crawl finds is exactly the manual use).
  await vite.optimizeDeps(config, true);
  const metadata = JSON.parse(readFileSync(path.join(scratch, "deps", "_metadata.json"), "utf8"));
  optimized = new Set(Object.keys(metadata.optimized ?? {}));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
h.ok(optimized.size > 30, `the cold crawl pre-bundles ${optimized.size} dependencies`);
for (const spec of [...bare].sort())
  h.ok(optimized.has(spec), `worker-only import "${spec}" is pre-bundled by the start-up crawl (else add it to optimizeDeps.include in vite.config.ts)`);

// --- 3: the config says so explicitly ---------------------------------------------------------
const cfg = readFileSync(path.join(repo, "vite.config.ts"), "utf8");
h.ok(/optimizeDeps:\s*\{[^}]*include:\s*\[[^\]]*"harper\.js"[^\]]*"harper\.js\/slimBinary"/.test(cfg), "vite.config.ts lists the spell-check worker's imports in optimizeDeps.include");

await h.done();
