// A stored plot manifest is an immutable value (plot/store.ts).
//
// Async exports used to snapshot the manifest store with structuredClone. On the owner's scratch
// project (122 manifests, 208 MB, 25k-point series) that deep copy cost 370 ms on EVERY figure export
// and on every live metadata preview (2026-11-09). The snapshot is now the record itself, which is
// only sound while nothing edits a manifest in place. This gate holds both halves:
//   A. census — no deep clone of the manifest store anywhere in src/ or flux-core/;
//   B. behaviour — the shared render pipeline (preparation, overrides, crop, views, elastic
//      relayout, part index, contract check) runs on DEEP-FROZEN manifests and produces the same
//      bytes as on mutable ones (a write to a frozen object throws in module code).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-manifest-immutable");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

h.section("A. no deep clone of the manifest store");
{
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(file); continue; }
      if (!/\.(ts|svelte|mjs|cjs)$/.test(entry.name)) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/structuredClone\(\s*(get\(plotManifests\)|\$plotManifests|source\?\.assetManifests|assetManifests\b)/.test(line)) offenders.push(`${path.relative(repo, file)}:${i + 1}`);
      });
    }
  };
  walk(path.join(repo, "src")); walk(path.join(repo, "flux-core"));
  h.eq(offenders, [], "no structuredClone of plotManifests / assetManifests");
  // The census must be able to fail: the retired shape matches.
  h.ok(/structuredClone\(\s*(get\(plotManifests\)|\$plotManifests|source\?\.assetManifests|assetManifests\b)/.test("manifests: structuredClone(get(plotManifests)),"), "the census pattern matches the retired snapshot");
}

h.section("B. the render pipeline never writes to a manifest");
const { ensureDom } = await import("../flux-core/render");
await ensureDom();
const { buildPlotMarkup } = await import("../src/lib/plot/inlineMarkup");
const { buildPartIndex } = await import("../src/lib/plot/parse");
const { plotContractErrors, modernPlot } = await import("../src/lib/plot/contract") as { plotContractErrors: (svg: string, m: unknown, modern: boolean) => string[]; modernPlot: (m: unknown) => boolean };

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]); }
  return value;
};
// The plain fixtures plus elastic ones (layout.supported): the relayout solver reads the most of a manifest.
const fixtures: [string, string][] = [];
for (const sub of ["plots", "relayout/fluxbox"]) {
  const dir = path.join(repo, "scripts", "fixtures", sub);
  for (const n of fs.readdirSync(dir).filter(n => n.endsWith(".fluxplot.json")).slice(0, 12)) {
    const base = n.replace(/\.fluxplot\.json$/, "");
    if (fs.existsSync(path.join(dir, base + ".svg"))) fixtures.push([dir, base]);
  }
}
const names = fixtures.map(f => f[1]);
h.ok(names.length >= 5, `${names.length} fixture plots with manifests`);
let rendered = 0, elastic = 0;
for (const [dir, name] of fixtures) {
  const svg = fs.readFileSync(path.join(dir, name + ".svg"), "utf8"), text = fs.readFileSync(path.join(dir, name + ".fluxplot.json"), "utf8");
  const mutable = JSON.parse(text), frozen = deepFreeze(JSON.parse(text));
  const parts = Object.keys(buildPartIndex(mutable));
  const overrides = parts.length ? { [parts[0]]: { hidden: true }, [parts[parts.length - 1]]: { opacity: 0.5 } } : undefined;
  const size = mutable.size?.unit === "pt" ? { w: mutable.size.width * 96 / 72, h: mutable.size.height * 96 / 72 } : { w: 300, h: 200 };
  // Plain, cropped, and resized (the elastic relayout runs when the manifest supports it).
  const frames = [
    { id: "p1", x: 10, y: 20, width: size.w, height: size.h },
    { id: "p2", x: 0, y: 0, width: size.w, height: size.h, crop: { x: 5, y: 5, width: size.w / 2, height: size.h / 2 } },
    { id: "p3", x: 0, y: 0, width: size.w * 1.4, height: size.h * 0.8 },
    { id: "p4", x: 0, y: 0, width: size.w * 1.4, height: size.h * 0.8, layoutMode: "stretch" as const },
  ];
  if (mutable.layout?.supported === true) elastic++;
  let same = true, threw = "";
  for (const frame of frames) {
    try {
      const a = buildPlotMarkup(svg, frame, overrides, mutable), b = buildPlotMarkup(svg, frame, overrides, frozen);
      if (a !== b || a === null) same = false; else rendered++;
    } catch (error) { threw = String((error as Error)?.message ?? error); }
  }
  try { if (JSON.stringify(buildPartIndex(frozen)) !== JSON.stringify(buildPartIndex(mutable))) same = false; plotContractErrors(svg, frozen, modernPlot(frozen)); }
  catch (error) { threw = String((error as Error)?.message ?? error); }
  h.ok(!threw && same, `${name}: frozen manifest renders the same bytes${threw ? " — threw: " + threw : ""}`);
  h.ok(JSON.stringify(mutable) === text.trim() || JSON.stringify(mutable) === JSON.stringify(JSON.parse(text)), `${name}: the mutable manifest is unchanged by rendering`);
}
h.ok(rendered >= names.length * 3, `${rendered} placements rendered`);
h.ok(elastic >= 1, `${elastic} fixture(s) exercised the elastic relayout`);
// The freeze must be able to fail: a writer throws.
{
  const frozen = deepFreeze({ series: [{ data: { x: [1, 2, 3] } }] });
  let threw = false;
  try { (frozen.series[0].data.x as number[]).push(4); } catch { threw = true; }
  h.ok(threw, "a write to a deep-frozen manifest throws (the proof can fail)");
}
await h.done();
