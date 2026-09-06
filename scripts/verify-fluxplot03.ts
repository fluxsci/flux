// Shared generator fixtures: precision, gaps, panel ownership, fields and safe
// transitions. No Python environment or user's scientific project is required.
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { validatePlot } from "../flux-core/validate";
import { validateIncomingPlot, plotContractErrors } from "../src/lib/plot/contract";
import { morphCompatible, createMorph, seriesAxes, morphSeriesPixels } from "../src/lib/slide/player/morph";
import { buildPartIndex } from "../src/lib/plot/parse";
import { resolveTargets } from "../src/lib/plot/tree";
import { autoAnimatePlot } from "../src/lib/slide/autobuild";
import { recipeInvocation, completedRecipe } from "../src/lib/plot/recipeContract.mjs";
import { runRecipe } from "../flux-core/recipe";
import type { FluxPlotManifest } from "../src/lib/plot/types";

const dir = new URL("./fixtures/fluxplot03/", import.meta.url);
const load = async (name: string) => ({ svg: await readFile(new URL(`${name}.svg`, dir), "utf8"),
  manifest: JSON.parse(await readFile(new URL(`${name}.fluxplot.json`, dir), "utf8")) as FluxPlotManifest });
for (const name of ["panels-a", "panels-b", "fields"]) {
  const { svg, manifest } = await load(name);
  const result = await validatePlot(new URL(`${name}.svg`, dir).pathname);
  assert.equal(result.ok, true, result.errors.join("\n"));
  await validateIncomingPlot(svg, JSON.stringify(manifest));
  const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const id of Object.keys(buildPartIndex(manifest))) for (const leaf of resolveTargets(manifest, id)) assert(ids.has(leaf), leaf);
  const beats = autoAnimatePlot(manifest, "plot");
  assert(beats.length >= 2, "generator build hints produce slide beats");
  for (const series of manifest.series) for (const component of series.components ?? []) assert(manifest.build!.order.includes(component.svgId));
}
const A = await load("panels-a"), B = await load("panels-b");
assert.equal(A.manifest.series[0].data!.y[0], 1e-6);
assert.equal(A.manifest.series[0].data!.y[2], null);
assert(morphCompatible(A.manifest, B.manifest));
const reordered = structuredClone(B.manifest); reordered.axes.reverse();
assert(morphCompatible(A.manifest, reordered), "ownership follows panel IDs, not array position");
const { document } = parseHTML("<html><body></body></html>");
const wrap = document.createElement("div");
wrap.innerHTML = A.svg.replace(/\bid="([^"]+)"/g, 'id="plot__$1"');
const controller = createMorph(wrap as unknown as ParentNode, "plot", A.manifest, reordered);
controller.seek(.5);
for (const series of A.manifest.series) {
  const path = wrap.querySelector(`[id="plot__${series.svg.line}"] path`)!.getAttribute("d")!;
  assert.equal((path.match(/M/g) ?? []).length, 2, "line gap remains a separate subpath");
  assert.equal((path.match(/[ML]/g) ?? []).length, 4, "subsampled markers do not remove line vertices");
  assert(!/NaN|Infinity/.test(path));
  const sb = B.manifest.series.find((s) => s.id === series.id)!;
  const projected = morphSeriesPixels(series, sb, seriesAxes(A.manifest, series)!, seriesAxes(B.manifest, sb)!, .5);
  const last = projected.at(-1)!;
  assert(path.endsWith(`${last.x.toFixed(6)} ${last.y.toFixed(6)}`));
}
for (const mutate of [
  (m: FluxPlotManifest) => { m.axes[0].projection = "polar"; },
  (m: FluxPlotManifest) => { m.axes[0].x.anchors = []; },
  (m: FluxPlotManifest) => { delete (m.axes[0].x as Partial<typeof m.axes[0]["x"]>).anchors; },
  (m: FluxPlotManifest) => { m.axes[0].x.anchors[1].data = m.axes[0].x.anchors[0].data; },
  (m: FluxPlotManifest) => { m.series[0].capabilities = { dataMorph: false }; },
  (m: FluxPlotManifest) => { m.series[0].rasterized = true; },
  (m: FluxPlotManifest) => { m.series[0].data!.y[1] = null; },
]) { const changed = structuredClone(B.manifest); mutate(changed); assert(!morphCompatible(A.manifest, changed)); }
const field = await load("fields");
assert(!morphCompatible(field.manifest, field.manifest), "field changes use complete transitions");
assert.equal(field.manifest.guides!.filter((g) => g.role === "colorbar").length, 2);
assert(plotContractErrors(A.svg.replace('id="figure"', 'id="axis.x"') + '<g id="axis.x"/>', A.manifest).some((e) => e.includes("Duplicate")));
await assert.rejects(validateIncomingPlot(A.svg + "\n", JSON.stringify(A.manifest)), /checksum/);
const stale = structuredClone(A.manifest); stale.series[0].points![0].y = 100;
assert(plotContractErrors(A.svg, stale).some((e) => e.includes("disagree")));
assert.equal(createHash("sha256").update(A.svg).digest("hex"), A.manifest.artifact!.svgSha256);

const invocation = recipeInvocation({ args: ["plot.py"], params: { dose: 1e-7 } }, { __fluxplot__: { field: { cmap: "plasma" } } });
assert.deepEqual(invocation.args, ["plot.py", "--dose", "1e-7"]);
assert.equal((invocation.params.__fluxplot__ as any).field.cmap, "plasma");
assert.throws(() => recipeInvocation({}, { dose: NaN }), /finite/);
assert.equal(completedRecipe({ inputs: ["new"], params: { generated: 2 } }, { old: 1 }, { dose: 3 }, "now").inputs[0], "new");
// Execute an actual regeneration that replaces its own provenance sidecar.
const scratch = await mkdtemp(join(tmpdir(), "fluxplot03-recipe-"));
try {
  const script = join(scratch, "make.mjs"), recipe = join(scratch, "plot.recipe.json");
  await writeFile(script, `import { writeFileSync } from 'node:fs';
const params = JSON.parse(process.env.FLUX_PARAMS);
writeFileSync('out.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
writeFileSync('plot.recipe.json', JSON.stringify({command: process.execPath, args: ['make.mjs'], output: 'out.svg', inputs: ['fresh'], params}));`);
  await writeFile(recipe, JSON.stringify({ command: process.execPath, args: [script], output: "out.svg", params: { dose: 1e-7 } }));
  const result = await runRecipe(recipe, { __fluxplot__: { field: { cmap: "plasma" } } });
  assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(await readFile(recipe, "utf8"));
  assert.deepEqual(saved.inputs, ["fresh"]);
  assert.equal(saved.params.__fluxplot__.field.cmap, "plasma");
} finally { await rm(scratch, { recursive: true, force: true }); }
console.log("Fluxplot 0.3: shared fixtures, panels, gap morphs, fields, checksums and regeneration passed");
