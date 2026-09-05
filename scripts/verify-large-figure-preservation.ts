// A legacy project copy with 1,200 figures, 40 canvases, 3 publication families,
// 2,400 panel references and shared sources. Migration may add canonical keys;
// it may not alter the figure/reference/content ledger or any source bytes.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { planFigSave, executeFigSave } from "../src/lib/project/figfiles";
import { makeText } from "../src/lib/ops";
import { loadFigModel } from "../flux-core/model";
import { snapshotFigureReferences, planFigureReferenceEdits } from "../src/lib/project/figureReferenceEdits";
import { transformQmdForExport } from "../src/lib/exportQmd";
import { BUILTIN_FAMILIES, derivedFigureName } from "../src/lib/figfamily";
import type { Project, Figure } from "../src/lib/types";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-large-preservation-"));
const write = async (rel: string, text: string) => { const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8").catch(() => null);
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const families = BUILTIN_FAMILIES.slice(0, 3);
const project: Project = {
  version: 2, name: "Large legacy copy", palette: ["#ff0000", "#0000ff"],
  canvases: Array.from({ length: 40 }, (_, i) => ({ id: `canvas-${i}`, name: `Experiment ${i}` })),
  assets: Array.from({ length: 20 }, (_, i) => ({ id: `asset-${i}`, kind: "svg" as const, name: `source-${i}.svg`, path: `assets/asset-${i}.svg`, naturalWidth: 200, naturalHeight: 100 })),
  figures: [],
};
for (let i = 0; i < 1200; i++) {
  const family = families[i % families.length], number = Math.floor(i / families.length) + 1;
  const f: Figure = {
    id: `legacy-${i}`, name: derivedFigureName(family, number), nickname: `Measured experiment ${i}`,
    family: family.id, number, canvasId: `canvas-${Math.floor(i / 30)}`, x: (i % 5) * 650, y: Math.floor(i / 5) * 360,
    width: 600, height: 300, background: "#ffffff",
    elements: [
      { id: `plot-${i}`, type: "plot", x: 20, y: 30, width: 400, height: 200, rotation: i % 5, assetId: `asset-${i % 20}`, source: { svgPath: `plots/source-${i % 20}.svg` }, overrides: { line: { stroke: i % 2 ? "#ff0000" : "#0000ff" } } },
      ...["a", "b"].map((label, n) => ({ ...makeText(label, { x: n * 200, y: 0, width: 20, height: 20 }, { fontSize: 14 }, true), id: `panel-${i}-${n}` })),
    ],
    captions: { __figure__: `Experiment ${i}.`, [`panel-${i}-0`]: "Control.", [`panel-${i}-1`]: "Treatment." },
  };
  project.figures.push(f);
}
const ledger = (p: Project) => p.figures.map((f) => { const { referenceKey, ...rest } = f; return rest; }).sort((a, b) => a.id.localeCompare(b.id));
try {
  const seed = planFigSave(project, null);
  const legacyIndex = JSON.parse(seed.index.text);
  for (const entry of legacyIndex.figures) entry.label = `fig-published-${entry.id}`;
  for (const file of seed.canvases) {
    const canvas = JSON.parse(file.text);
    for (const f of canvas.figures) delete f.referenceKey;
    await write(file.path, JSON.stringify(canvas, null, 2) + "\n");
  }
  for (const file of seed.captions) await write(file.path, file.text);
  await write("fig/index.json", JSON.stringify(legacyIndex, null, 2) + "\n");
  await write("project.json", JSON.stringify({ schemaVersion: "0.1.0", title: project.name, manuscript: { path: "manuscript/main.qmd" }, supplementary: [], figures: [], slides: [] }));
  const manuscript = legacyIndex.figures.map((f: { label: string }) => `See @${f.label}-a,b and @${f.label}.`).join("\n");
  await write("manuscript/main.qmd", manuscript);
  for (const asset of project.assets) await write(`fig/${asset.path}`, `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path id="line" d="M0 0L200 100"/></svg>`);
  const before = digest(ledger(project));
  const started = performance.now();
  const loaded = await loadFigModel(root);
  assert.equal(digest(ledger(loaded.project)), before, "legacy compositions, geometry, families, panels, captions and overrides preserved");
  assert.deepEqual(loaded.project.figures.map((f) => f.referenceKey), legacyIndex.figures.map((f: { label: string }) => f.label), "all 1,200 legacy published keys preserved");
  const sourcesBefore = await Promise.all(project.assets.map((a) => read(`fig/${a.path}`)));
  await executeFigSave(planFigSave(loaded.project, loaded.index), { read, write });
  const reopened = await loadFigModel(root);
  assert.equal(digest(ledger(reopened.project)), before, "save and reopen preserve all canonical content");
  assert.deepEqual(reopened.project.figures.map((f) => f.referenceKey), loaded.project.figures.map((f) => f.referenceKey), "reopen keeps canonical reference identity");
  assert.deepEqual(await Promise.all(project.assets.map((a) => read(`fig/${a.path}`))), sourcesBefore, "source bytes remain exact");
  assert.equal(await read("manuscript/main.qmd"), manuscript, "migration never rewrites manuscript text");
  const refs = snapshotFigureReferences(reopened.project.figures, reopened.index);
  assert.deepEqual(planFigureReferenceEdits(manuscript, refs, refs), { changes: [], conflicts: [] }, "all panel references retain meaning");
  const ctx = { captions: new Map<string, string>(), figures: new Map(reopened.project.figures.map((f) => [f.referenceKey!, { family: families.find((x) => x.id === f.family)!, number: f.number!, panels: ["a", "b"] }])) };
  const exported = transformQmdForExport(manuscript, ctx);
  assert(!exported.includes("@fig-"), "all 3,600 references resolve in export");
  assert.equal(transformQmdForExport(manuscript.split("\n").reverse().join("\n"), ctx), exported.split("\n").reverse().join("\n"), "reversing the entire manuscript changes no figure number");
  console.log(`LARGE FIGURE PRESERVATION: PASS (1200 figures, 40 canvases, 3600 refs, ${(performance.now() - started).toFixed(0)}ms migration/save/reopen)`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
