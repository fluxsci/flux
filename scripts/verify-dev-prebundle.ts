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
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-dev-prebundle");
// fileURLToPath, never URL.pathname: on Windows that is "/D:/…" and resolves to "D:\D:\…" (§9).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- 1: what the workers import ---------------------------------------------------------------
// Worker ENTRIES are whatever the app hands to the browser as a worker: the target of every
// `new Worker(new URL("./x", import.meta.url))` and every `import X from "./x?worker"`, resolved
// from the importing file. (A `*.worker.ts` naming convention alone missed the pdf.js worker
// entry, `pdfjsWorker.ts`, on 2026-09-26.) Their imports — `from "pkg"`, `import("pkg")` and
// the side-effect form `import "pkg"` — are the bare specifiers the start-up crawl cannot see.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|svelte)$/.test(entry)) out.push(p);
  }
  return out;
}
const sources = walk(path.join(repo, "src"));
const resolveEntry = (from: string, rel: string) => {
  const base = path.resolve(path.dirname(from), rel);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`]) if (sources.includes(candidate)) return candidate;
  throw new Error(`${path.relative(repo, from)}: worker entry "${rel}" does not resolve to a source file`);
};
const entries = new Set<string>();
for (const file of sources) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) entries.add(resolveEntry(file, m[1]));
  for (const m of src.matchAll(/from\s+["']([^"']+)\?(?:shared)?worker(?:&[^"']*)?["']/g)) entries.add(resolveEntry(file, m[1]));
}
h.ok(entries.size >= 4, `worker entries found from the source: ${[...entries].map((w) => path.relative(repo, w)).sort().join(", ")}`);
const bare = new Set<string>();
for (const file of entries) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bfrom\s+["']([^"'./][^"']*)["']|\bimport\(\s*["']([^"'./][^"']*)["']\s*\)|^\s*import\s+["']([^"'./][^"']*)["']/gm)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec && !spec.startsWith("node:")) bare.add(spec);
  }
}
h.ok(bare.has("harper.js") && bare.has("harper.js/slimBinary"), "the spell-check worker imports harper.js and harper.js/slimBinary");
h.ok(bare.has("pdfjs-dist/legacy/build/pdf.worker.min.mjs"), `the pdf.js worker entry imports the pdf.js worker module (all worker-only imports: ${[...bare].sort().join(", ")})`);

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
// Only the imports the main graph never touches need naming: a package the app also imports
// from ordinary code (katex, from the math worker AND the editor) is found by the crawl.
const mainImports = new Set<string>();
for (const file of sources) {
  if (entries.has(file)) continue;
  for (const m of readFileSync(file, "utf8").matchAll(/\bfrom\s+["']([^"'./][^"']*)["']|\bimport\(\s*["']([^"'./][^"']*)["']\s*\)|^\s*import\s+["']([^"'./][^"']*)["']/gm)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) mainImports.add(spec);
  }
}
const workerOnly = [...bare].filter((spec) => !mainImports.has(spec)).sort();
h.ok(workerOnly.length >= 3, `imports reachable ONLY through a worker entry: ${workerOnly.join(", ")}`);
const include = /optimizeDeps:\s*\{[^}]*include:\s*\[([^\]]*)\]/.exec(cfg)?.[1] ?? "";
for (const spec of workerOnly) h.ok(include.includes(`"${spec}"`), `vite.config.ts names "${spec}" in optimizeDeps.include`);

await h.done();
