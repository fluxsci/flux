#!/usr/bin/env -S npx tsx
// readFigSource (Paper's read-only fig/ view) re-runs after EVERY figures
// autosave. Its asset bytes + .fluxplot.json sidecars are cached per path and
// validated by a fresh fs:stat (perf 2026-09-30: an unchanged ~190 MB re-read
// per save was 0.8-1 s of renderer main thread). This gate pins the cache:
//   1. a second read with nothing changed reads NO asset/sidecar bytes and
//      returns the same values;
//   2. an in-place rewrite (fs.writeFile) and an atomic tmp+rename replacement
//      (same size, same mtime forced) are both re-read;
//   3. a bridge without stat() never serves a cached value;
//   4. two concurrent cold reads share one read per file.
//   Run: npx tsx scripts/verify-fig-source-cache.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-fig-source-cache");
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), "flux-figsrccache-"));
const HOME = path.join(SCRATCH, "home");
await fs.mkdir(path.join(HOME, ".config"), { recursive: true });
process.env.HOME = HOME;
process.env.XDG_CONFIG_HOME = path.join(HOME, ".config");
process.env.FLUX_NO_MIGRATE = "1";

const core = await import("../flux-core/index");
const { ensureDom } = await import("../flux-core/render");
await ensureDom();

const reads: string[] = [];
let withStat = true;
const bridge = {
  exists: async (p: string) => fs.access(p).then(() => true, () => false),
  readText: async (p: string) => { reads.push(p); return fs.readFile(p, "utf8"); },
  readFile: async (p: string) => { reads.push(p); const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  get stat() {
    return withStat ? async (p: string) => { try { const st = await fs.stat(p); return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino }; } catch { return null; } } : undefined;
  },
};
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { fig: unknown }).fig = bridge;
const { readFigSource } = await import("../src/lib/project/figbridge");

const PLOT = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect id="bar1" x="20" y="40" width="30" height="60" fill="${fill}"/></svg>`;
const root = path.join(SCRATCH, "proj");
try {
  await core.scaffold(root, { title: "FigSourceCache" });
  await fs.mkdir(path.join(root, "plots"), { recursive: true });
  const plotPath = path.join(root, "plots", "p.svg");
  await fs.writeFile(plotPath, PLOT("#336699"));
  await core.composeFigure(root, [plotPath], { id: "cachefig", captionStub: false });
  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  const asset = (idx.assets as { id: string; path: string; kind: string }[]).find((a) => a.kind === "svg")!;
  const svgAbs = path.join(root, "fig", asset.path);
  const manAbs = path.join(root, "fig", "assets", `${asset.id}.fluxplot.json`);
  await fs.writeFile(manAbs, JSON.stringify({ version: 1, marker: "A" }));
  const assetReads = () => reads.filter((p) => p.endsWith(asset.path) || p.endsWith(".fluxplot.json")).length;

  h.section("hit");
  const a = await readFigSource(root);
  h.ok(!!a.assetData[asset.id] && (a.assetManifests[asset.id] as unknown as { marker: string })?.marker === "A", "cold read loads asset bytes + sidecar");
  reads.length = 0;
  const b = await readFigSource(root);
  h.ok(assetReads() === 0, `unchanged second read reads no asset/sidecar bytes (read ${assetReads()})`);
  h.ok(b.assetData[asset.id] === a.assetData[asset.id] && b.assetManifests[asset.id] === a.assetManifests[asset.id], "cached values are returned");

  h.section("invalidation");
  await fs.writeFile(svgAbs, PLOT("#993366")); // in place, same size
  reads.length = 0;
  const c = await readFigSource(root);
  h.ok(assetReads() === 1 && c.assetData[asset.id] !== a.assetData[asset.id], "in-place rewrite of the svg is re-read");
  const st = await fs.stat(manAbs);
  const tmp = manAbs + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ version: 1, marker: "B" })); // same length as "A"
  await fs.utimes(tmp, st.atime, st.mtime);
  await fs.rename(tmp, manAbs);
  reads.length = 0;
  const d = await readFigSource(root);
  h.ok((d.assetManifests[asset.id] as unknown as { marker: string })?.marker === "B", "atomic same-size same-mtime replacement of the sidecar is re-read (inode)");

  h.section("no stat");
  withStat = false;
  reads.length = 0;
  await readFigSource(root);
  h.ok(assetReads() === 2, `a bridge without stat() always reads (read ${assetReads()})`);
  withStat = true;

  h.section("concurrent cold reads");
  await fs.writeFile(svgAbs, PLOT("#669933"));
  await fs.writeFile(manAbs, JSON.stringify({ version: 1, marker: "C" }));
  reads.length = 0;
  const [e, f] = await Promise.all([readFigSource(root), readFigSource(root)]);
  h.ok(assetReads() === 2, `two overlapping reads share one read per file (read ${assetReads()})`);
  h.ok(e.assetData[asset.id] === f.assetData[asset.id] && (f.assetManifests[asset.id] as unknown as { marker: string })?.marker === "C", "both see the new content");
} finally {
  await fs.rm(SCRATCH, { recursive: true, force: true });
}
h.done();
