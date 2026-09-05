// Permanent figure identity, caption three-way reconciliation, and one source
// bundle policy across both engines. Only a disposable project is written.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { Figure, Project } from "../src/lib/types";
import { ensureFigureReferenceKeys } from "../src/lib/project/figureIdentity";
import { reconcileFigureCaption } from "../src/lib/project/captionReconcile";
import { planFigSave, executeFigSave } from "../src/lib/project/figfiles";
import { planSourceUpdates, applySourceUpdates, writeSourceUpdates } from "../src/lib/plot/sourceSync";
import { plotSourceCandidates, plotSidecarCandidates } from "../src/lib/plot/source";
import { syncFigureAssets, deleteFigure } from "../flux-core/figures";
import { loadFigModel } from "../flux-core/model";
import { readProjectDependencies } from "../src/lib/project/dependencies";

let checks = 0;
function eq(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-source-gate-"));
const write = async (p: string, s: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
const io = {
  readText: (p: string) => fs.readFile(p, "utf8"),
  exists: async (p: string) => { try { await fs.access(p); return true; } catch { return false; } },
  writeText: write,
  remove: (p: string) => fs.rm(p, { force: true }),
  readdir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() })),
};
const svg = (color: string, w = 200) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="100"><rect width="${w}" height="100" fill="${color}"/></svg>`;
const manifest = (version: number) => JSON.stringify({ schemaVersion: "0.1.0", axes: [], series: [], version });
const fig = (id: string, n: number): Figure => ({ id, name: `Figure ${n}`, family: "figure", number: n, canvasId: "c", x: 0, y: 0, width: 300, height: 160, background: "#fff", elements: [{ id: `plot-${id}`, type: "plot", assetId: "a", x: 10, y: 10, width: 100, height: 50, rotation: 0, source: { svgPath: "plots/source.svg" }, overrides: { line: { stroke: "purple" } } }], captions: { __figure__: "Original caption" } });
const p: Project = { version: 2, name: "Source gate", canvases: [{ id: "c", name: "Canvas" }], figures: [fig("f1", 1), fig("f2", 2)], assets: [{ id: "a", name: "source.svg", kind: "svg", path: "assets/a.svg", naturalWidth: 200, naturalHeight: 100 }], palette: [] };
try {
  ensureFigureReferenceKeys(p, { figures: [{ id: "f1", label: "fig-old-key" }, { id: "f2", label: "fig-also-stable" }] });
  p.figures[0].nickname = "Retitled"; p.figures[0].number = 2;
  ensureFigureReferenceKeys(p);
  eq(p.figures[0].referenceKey, "fig-old-key", "title and publication number preserve migrated key");
  eq(ensureFigureReferenceKeys(p), [], "identity migration is idempotent");
  const planned = planFigSave(p, null);
  eq(JSON.parse(planned.index.text).figures[0].label, "fig-old-key", "canonical key survives rebuilding index");
  eq(JSON.parse(planned.canvases[0].text).figures[0].referenceKey, "fig-old-key", "canonical key persists with composition");

  const cap = fig("caption", 1);
  eq(reconcileFigureCaption(cap, "External caption", "Original caption"), "imported", "unambiguous sidecar edit imports");
  eq(cap.captions?.__figure__, "External caption", "sidecar content preserved");
  cap.captions = { __figure__: "Local edit" };
  eq(reconcileFigureCaption(cap, "Original caption", "Original caption"), "model", "only local edit uses canonical caption");
  eq(reconcileFigureCaption(cap, "External edit", "Original caption"), "conflict", "two meaningful edits never silently overwrite");
  eq(cap.captions.__figure__, "Local edit", "conflict leaves canonical untouched");
  const moved = plotSourceCandidates(root, "/old/project/plots/source.svg");
  eq(moved[0], `${root}/plots/source.svg`, "moved project's source wins over still-existing original");
  eq(plotSourceCandidates(root, "/old/project/plots/source.svg", { external: true })[0], "/old/project/plots/source.svg", "explicit external link retains origin");
  eq(plotSourceCandidates(root, "plots/nested/missing.svg").includes(`${root}/plots/missing.svg`), false, "explicit nested path cannot silently bind same-basename plot");
  eq(plotSidecarCandidates(root, { svgPath: "/old/project/plots/source.svg", manifestPath: "/old/project/metadata/custom.fluxplot.json" }, `${root}/plots/source.svg`, "manifest"), [`${root}/metadata/custom.fluxplot.json`], "authored metadata relocates with legacy SVG across directories");
  eq(plotSidecarCandidates(root, { svgPath: "/external/source.svg", manifestPath: "/external/custom.fluxplot.json", external: true }, "/external/source.svg", "manifest"), ["/external/custom.fluxplot.json"], "explicit external authored metadata keeps its origin");

  await write(`${root}/project.json`, JSON.stringify({ schemaVersion: "0.1.0", title: "Gate", figures: [], slides: [], manuscript: { path: "manuscript/main.qmd" }, supplementary: [] }));
  await write(`${root}/manuscript/main.qmd`, "See @fig-old-key.\n");
  await write(`${root}/plots/source.svg`, svg("red"));
  await write(`${root}/fig/assets/a.svg`, svg("red"));
  await write(`${root}/plots/source.fluxplot.json`, manifest(1));
  await write(`${root}/fig/assets/a.fluxplot.json`, manifest(1));
  await executeFigSave(planFigSave(p, null), { read: async (rel) => io.readText(`${root}/${rel}`).catch(() => null), write: (rel, s) => write(`${root}/${rel}`, s) });
  eq((await planSourceUpdates(root, p, io)).updates.length, 0, "identical semantic bundle is a no-op");
  const firstSource = (p.figures[0].elements[0] as any).source;
  firstSource.frozen = false;
  eq((await planSourceUpdates(root, p, io)).statuses[0].status, "current", "legacy absent frozen flag and explicit false are equivalent shared links");
  firstSource.external = false;
  eq((await planSourceUpdates(root, p, io)).statuses[0].status, "current", "legacy absent external flag and explicit false are equivalent shared links");
  await write(`${root}/plots/source.fluxplot.json`, manifest(2));
  let update = await planSourceUpdates(root, p, io);
  eq(update.updates.length, 1, "manifest-only source change detected once for shared asset");
  await writeSourceUpdates(root, update.updates, io, p);
  eq(JSON.parse(await io.readText(`${root}/fig/assets/a.fluxplot.json`)).version, 2, "manifest-only update persisted");
  await write(`${root}/plots/source.recipe.json`, JSON.stringify({ params: { n: 8 } }));
  update = await planSourceUpdates(root, p, io);
  eq(update.updates.length, 1, "recipe-only change detected");
  await writeSourceUpdates(root, update.updates, io, p);
  await fs.unlink(`${root}/plots/source.fluxplot.json`); await fs.unlink(`${root}/plots/source.recipe.json`);
  update = await planSourceUpdates(root, p, io);
  await writeSourceUpdates(root, update.updates, io, p);
  eq(await io.exists(`${root}/fig/assets/a.fluxplot.json`), false, "removed manifest is not resurrected");
  eq(await io.exists(`${root}/fig/assets/a.recipe.json`), false, "removed recipe is not resurrected");

  await write(`${root}/plots/source.svg`, svg("blue", 400));
  update = await planSourceUpdates(root, p, io);
  const geometry = applySourceUpdates(p, update.updates);
  eq(geometry.resized[0].elementIds.length, 2, "all shared asset placements resize together");
  eq(p.figures.map((f) => f.elements[0].width), [200, 200], "deliberate half-scale preserved");
  eq(p.figures[0].elements[0].id, "plot-f1", "placement identity preserved");
  eq(p.figures[0].captions?.__figure__, "Original caption", "caption survives source refresh");
  eq((p.figures[0].elements[0] as any).overrides.line.stroke, "purple", "semantic overrides survive");
  await writeSourceUpdates(root, update.updates, io, p);
  await write(`${root}/plots/source.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><rect');
  update = await planSourceUpdates(root, p, io);
  eq(update.updates.length, 0, "partial source SVG never accepted");
  eq(update.statuses[0].status, "error", "partial source reports actionable error");
  eq(await io.readText(`${root}/fig/assets/a.svg`), svg("blue", 400), "last-good saved bytes retained");
  await write(`${root}/plots/source.svg`, svg("green", 600));
  for (const f of p.figures) (f.elements[0] as any).source.frozen = true;
  eq((await planSourceUpdates(root, p, io)).updates.length, 0, "frozen source stays pinned");
  for (const f of p.figures) delete (f.elements[0] as any).source.frozen;

  // Exercise the real headless adapter, not a duplicated test implementation.
  await write(`${root}/plots/source.fluxplot.json`, manifest(3));
  const synced = await syncFigureAssets(root);
  eq(synced.refreshed.length, 1, "headless uses same shared-asset update plan");
  const loaded = await loadFigModel(root);
  eq(loaded.project.assets[0].naturalWidth, 600, "headless persists new intrinsic dimensions");
  eq(loaded.project.figures[0].referenceKey, "fig-old-key", "headless sync preserves keys");
  eq((await syncFigureAssets(root)).refreshed.length, 0, "headless no-change sync is idempotent");

  const custom = structuredClone(loaded.project);
  custom.figures = custom.figures.slice(0, 1);
  const customPlot = custom.figures[0].elements[0] as any;
  customPlot.source.manifestPath = "metadata/custom.fluxplot.json";
  customPlot.source.recipePath = "metadata/custom.recipe.json";
  await write(`${root}/metadata/custom.fluxplot.json`, manifest(9));
  await write(`${root}/metadata/custom.recipe.json`, '{"params":{"n":19}}');
  let registered = false, watched: any[] = [];
  const nativeLike = { ...io, watchSourceFiles: async (r: string, scope: string, sources: any[]) => { eq([r, scope], [root, "fig"], "native registrations use owning project and subsystem scope"); registered = true; watched = sources; }, exists: async (p: string) => { assert.ok(registered, "read capability registered before first existence probe"); return io.exists(p); } };
  const authored = await planSourceUpdates(root, custom, nativeLike);
  eq(JSON.parse(authored.updates[0].bundle.manifestText!).version, 9, "authored semantic metadata takes priority over an adjacent file");
  eq(JSON.parse(authored.updates[0].bundle.recipeText!).params.n, 19, "authored recipe is part of the same stable source bundle");
  eq(watched.some((s) => s.manifestPath === `${root}/metadata/custom.fluxplot.json` && s.recipePath === `${root}/metadata/custom.recipe.json`), true, "exact authored paths reach native watch registration");
  await writeSourceUpdates(root, authored.updates, io, custom);
  await fs.unlink(`${root}/metadata/custom.fluxplot.json`);
  const removedAuthored = await planSourceUpdates(root, custom, io);
  eq(removedAuthored.updates[0].bundle.manifestText, null, "removed authored metadata cannot resurrect a stale adjacent sidecar");
  const denied = await planSourceUpdates(root, custom, { ...io, watchSourceFiles: async () => { throw new Error("denied"); } });
  eq([denied.updates.length, denied.statuses[0].status, denied.statuses[0].detail?.includes("registration failed")], [0, "error", true], "native read/watch denial cannot be presented as a healthy saved source");

  // A deck-only PNG use has no plot source fallback. Removing the last owning
  // figure must keep its registry entry for the still-live deck.
  await write(`${root}/slides/d/deck.json`, JSON.stringify({ id: "d", title: "Deck", slides: [{ id: "s", elements: [{ type: "image", id: "i", assetId: "a" }], beats: [{ tracks: [{ id: "t", target: "i", to: { assetId: "animation-only" } }] }] }] }));
  const deps = await readProjectDependencies(root, io);
  eq(deps.byFigure.f1.some((u) => u.kind === "manuscript"), true, "manuscript use discovered by key");
  eq(deps.byAsset.a.some((u) => u.kind === "slide"), true, "unregistered disk deck use discovered");
  eq(deps.byAsset["animation-only"][0].trackId, "t", "animation-only dependency discovered");
  await deleteFigure(root, "f1"); await deleteFigure(root, "f2");
  eq((await loadFigModel(root)).project.assets.some((a) => a.id === "a"), true, "deleting final figure keeps deck-shared asset");
  console.log(`FIGURE SOURCES: PASS (${checks} meaningful assertions)`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
