#!/usr/bin/env -S npx tsx
// fluximg stage 1 (W3): the new asset + element kind in Flux's DATA MODEL. Pure, hermetic (scratch directories,
// synthetic bundles from scripts/lib/fluximgFixtures.ts).
//   1. a project holding a fluximg asset + element round-trips through the GUI save plan (figbridge) and through
//      flux-core with BYTE-IDENTICAL fig/ trees, and the bundle directory is never rewritten;
//   2. the asset kind survives normalization; stamps rise only with the content; an older build refuses;
//   3. elementAssetRefs puts it in `stacks` and nowhere else; NO code path asks for the bundle's bytes (fs is armed to
//      throw on any read under assets/*.fluximg while the engines run);
//   4. GC keeps the directory while referenced and releases it on deletion like any other asset;
//      a missing bundle is a non-blocking asset issue;
//   5. ops: addFluximg defaults and fit-to-figure, setFluximgView merge laws, crop;
//   6. a deck receives the element (fluximg stage 2 supersedes the stage-1 refusal pinned here): Send to deck,
//      add_slide_figure, addFluximg on a slide, the fold, the deck schema; the deck never owns the bundle.
//   node --import tsx scripts/verify-fluximg-model.ts
import "./lib/cssStub.mjs";
import fsSync, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { Ajv } from "ajv";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures";

const h = harness("verify-fluximg-model");

// ---- the byte guard: any read of a bundle's contents while ARMED throws and is recorded ------------------------
const BUNDLE = /[\\/]assets[\\/][^\\/]+\.fluximg(?:[\\/]|$)/i;
const asked: string[] = [], walked: string[] = [];
let armed = false;
const orig = {
  readFile: fs.readFile, open: fs.open, readdir: fs.readdir,
  readFileSync: fsSync.readFileSync, createReadStream: fsSync.createReadStream, openSync: fsSync.openSync,
};
// A renderer of fluximg elements reads a bundle the way its own reader does: the manifest and layer files as text,
// pixels in ranged pieces through an open handle. What stays forbidden for everyone is treating the bundle as an
// ordinary asset: reading the directory itself, or a pixel shard WHOLE.
let rendererMayRead = false;
const WHOLE_PIXELS = /\.fluximg[\\/]pixels[\\/].*[\\/]c[\\/]/i, BUNDLE_ITSELF = /\.fluximg[\\/]?$/i;
const guard = (how: string, p: unknown) => {
  const s = typeof p === "string" ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : "";
  if (!armed || !BUNDLE.test(s)) return;
  if (rendererMayRead && !BUNDLE_ITSELF.test(s) && !(WHOLE_PIXELS.test(s) && (how === "readFile" || how === "readFileSync" || how === "createReadStream"))) return;
  asked.push(`${how} ${s}`); throw new Error(`fluximg guard: ${how} ${s}`);
};
type AnyFn = (...args: unknown[]) => unknown;
const wrap = <F extends AnyFn>(how: string, fn: F): F => ((...args: unknown[]) => { guard(how, args[0]); return fn(...args); }) as F;
(fs as unknown as Record<string, unknown>).readFile = wrap("readFile", orig.readFile as AnyFn);
(fs as unknown as Record<string, unknown>).open = wrap("open", orig.open as AnyFn);
(fs as unknown as Record<string, unknown>).readdir = ((...args: unknown[]) => {
  if (armed && typeof args[0] === "string" && BUNDLE.test(args[0])) walked.push(args[0]);
  return (orig.readdir as AnyFn)(...args);
}) as typeof fs.readdir;
(fsSync as unknown as Record<string, unknown>).readFileSync = wrap("readFileSync", orig.readFileSync as AnyFn);
(fsSync as unknown as Record<string, unknown>).createReadStream = wrap("createReadStream", orig.createReadStream as AnyFn);
(fsSync as unknown as Record<string, unknown>).openSync = wrap("openSync", orig.openSync as AnyFn);
syncBuiltinESMExports();
async function armedRun<T>(label: string, fn: () => Promise<T> | T, renderer = false): Promise<T> {
  const before = asked.length;
  armed = true; rendererMayRead = renderer;
  const what = renderer ? "reads the bundle only as its reader does (never the directory, never a shard whole)" : "never asks for a bundle's bytes";
  try { return await fn(); }
  finally { armed = false; rendererMayRead = false; h.ok(asked.length === before, `${label}: ${what}${asked.length > before ? ` (asked: ${asked.slice(before).join(", ")})` : ""}`); }
}

// fs-backed FileBridge for the renderer engine (the shim verify-figfiles-parity uses), reading through the guard.
const bridge = {
  exists: (p: string) => fs.access(p).then(() => true, () => false),
  readText: (p: string) => fs.readFile(p, "utf8"),
  writeText: (p: string, t: string) => fs.writeFile(p, t),
  readFile: async (p: string) => { const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  remove: (p: string) => fs.rm(p, { force: true }),
  writeFile: (p: string, b: Uint8Array) => fs.writeFile(p, b),
  mkdir: (p: string) => fs.mkdir(p, { recursive: true }).then(() => {}),
};
(globalThis as Record<string, unknown>).window = { fig: bridge };

const core = await import("../flux-core/index");
const { loadFigInto, saveFigFrom, readFigAssets } = await import("../src/lib/project/figbridge");
const { project: figProject } = await import("../src/lib/store");
const ops = await import("../src/lib/ops");
const { normalizeIndexAssets, planFigSave } = await import("../src/lib/project/figfiles");
const { readFigureSnapshot } = await import("../src/lib/project/figureSnapshot");
const { elementAssetRefs, elementSourceAssetIds } = await import("../src/lib/model3d/refs");
const { figureImageAssetIds } = await import("../src/lib/project/figureAssets");
const { ensureAssetBytes } = await import("../src/lib/assets");
const { readProjectDependencies } = await import("../src/lib/project/dependencies");
const { SCHEMAS } = await import("../src/lib/project/schemas");
const { validateModel, validateDeckFile } = await import("../src/lib/project/validate");
const { isNewerSchema, CANVAS_SCHEMA_VERSION, FIG_INDEX_SCHEMA_VERSION } = await import("../src/lib/project/types");
const { fluximgPlaceholderSvg } = await import("../src/lib/fluximg/placeholder");
const { deckToProject, projectIntoDeck } = await import("../src/lib/slide/deckProject");
const slideOps = await import("../src/lib/slide/ops");
const { migrateProject } = await import("../src/lib/migrate");
const { get } = await import("svelte/store");
type Project = import("../src/lib/types").Project;
type Asset = import("../src/lib/types").Asset;
type FluximgElement = import("../src/lib/types").FluximgElement;
type FluximgView = import("../src/lib/fluximg/view").FluximgView;

const ASSET_ID = "fx1";
const comparable = (p: Project) => JSON.stringify({ ...p, name: "" }, null, 1);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Every file under fig/ → sha256 of its bytes, plus each bundle file's mtime (never rewritten). Read UNARMED. */
async function figTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    for (const e of await orig.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r);
      else out.set(r, sha(await orig.readFile(path.join(root, r))));
    }
  };
  await walk("fig");
  return out;
}
async function bundleStamp(root: string): Promise<string> {
  const dir = path.join(root, "fig", "assets", `${ASSET_ID}.fluximg`), parts: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await orig.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else { const st = await fs.stat(path.join(dir, r)); parts.push(`${r}:${st.size}:${st.mtimeMs}:${st.ino}`); }
    }
  };
  await walk("");
  return parts.sort().join("\n");
}

// ---- a real synthetic bundle and its asset record ----------------------------------------------------------------
const work = await fs.mkdtemp(path.join(os.tmpdir(), "flux-fluximg-model-"));
const fixture = fixtures().find((f) => f.name === "gray2d_u8") ?? fixtures()[0];
const report = await writeFixture(path.join(work, "bundles"), fixture);
const m = report.manifest, nd = m.pixels.dims.length;
const W = m.pixels.shape[nd - 1], H = m.pixels.shape[nd - 2];
const asset: Asset = {
  id: ASSET_ID, name: `${fixture.name}.fluximg`, kind: "fluximg", path: `assets/${ASSET_ID}.fluximg`,
  naturalWidth: W, naturalHeight: H, sha256: "c".repeat(64), bytes: report.bytes,
  fluximg: {
    dims: m.pixels.dims, shape: m.pixels.shape, dtype: m.pixels.dtype, encoding: m.pixels.encoding.kind,
    channels: m.channels.map((c) => c.name), levels: m.pixels.levels.map((l) => l.downsample),
    layers: m.layers.map((l) => ({ id: l.id, kind: l.kind, name: l.name, ...("count" in l ? { count: l.count } : {}) })),
    regions: m.regions.length,
  },
};

async function writeProjectFixture(root: string) {
  await fs.mkdir(path.join(root, "fig", "canvases"), { recursive: true });
  await fs.mkdir(path.join(root, "fig", "captions"), { recursive: true });
  await fs.mkdir(path.join(root, "fig", "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "paper"), { recursive: true });
  await fs.writeFile(path.join(root, "paper", "notes.qmd"), "# Notes\n"); // a readable manuscript: dependency inspection is complete
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify({ schemaVersion: "0.1.0", id: "fx", title: "Fx", manuscript: { path: "paper/notes.qmd" }, references: { library: "bib/library.bib" }, figures: [] }, null, 2) + "\n");
  await fs.cp(path.join(work, "bundles", `${fixture.name}.fluximg`), path.join(root, "fig", "assets", `${ASSET_ID}.fluximg`), { recursive: true });
  const { Resvg } = await import("@resvg/resvg-js");
  await fs.writeFile(path.join(root, "fig", "assets", "png1.png"), new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30"/></svg>').render().asPng());
  await fs.writeFile(path.join(root, "fig", "index.json"), JSON.stringify({
    schemaVersion: "0.1.0",
    canvases: [{ id: "c1", name: "One", order: 1 }, { id: "c2", name: "Two", order: 2 }],
    figures: [
      { id: "figA", name: "Figure 1", label: "fig-a", order: 1, kind: "main", canvas: "c1", caption: "" },
      { id: "figB", name: "Figure 2", label: "fig-b", order: 2, kind: "main", canvas: "c2", caption: "" },
    ],
    assets: [{ id: "png1", kind: "png", path: "assets/png1.png", name: "shot", naturalWidth: 40, naturalHeight: 30 }],
    palette: [], colorGroups: [], textStyles: [],
  }, null, 2) + "\n");
  const figure = (id: string, canvasId: string, elements: unknown[]) => ({ id, canvasId, name: id, x: 0, y: 0, width: 200, height: 150, elements });
  await fs.writeFile(path.join(root, "fig", "canvases", "c1.json"), JSON.stringify({ schemaVersion: "0.1.0", id: "c1", name: "One", figures: [figure("figA", "c1", [])] }, null, 2) + "\n");
  await fs.writeFile(path.join(root, "fig", "canvases", "c2.json"), JSON.stringify({ schemaVersion: "0.1.0", id: "c2", name: "Two", figures: [figure("figB", "c2", [
    { type: "image", id: "img1", assetId: "png1", x: 5, y: 5, width: 40, height: 30, rotation: 0 },
  ])] }, null, 2) + "\n");
  await fs.writeFile(path.join(root, "fig", "captions", "figA.md"), "");
  await fs.writeFile(path.join(root, "fig", "captions", "figB.md"), "");
}

// The one mutation both engines apply (fixed ids so both trees can match byte for byte).
const VIEW: FluximgView = { index: { z: 0 }, channels: [{ range: [10, 200], lut: "gray" }], furniture: { scalebar: { corner: "bottom-left" } } };
const mutate = (p: Project) => {
  const id = ops.addFluximg(p, { figureId: "figA", asset, view: VIEW, source: { bundlePath: "plots/cells.fluximg", sha256: "d".repeat(64) } });
  const el = p.figures[0].elements.find((e) => e.id === id)!;
  el.id = "fxel";
  ops.setCrop(p, "fxel", { x: 4, y: 2, width: 32, height: 24 });
  ops.setFluximgView(p, "fxel", { smooth: true });
};

try {
  h.section("1. both engines: byte-identical trees, the bundle never rewritten");
  const rootA = path.join(work, "a"), rootB = path.join(work, "b");
  await writeProjectFixture(rootA);
  await fs.cp(rootA, rootB, { recursive: true });
  const stampA0 = await bundleStamp(rootA), stampB0 = await bundleStamp(rootB);
  await armedRun("flux-core load + save", async () => {
    const mm = await core.loadFigModel(rootA);
    mutate(mm.project);
    await core.saveFigModel(rootA, mm.project, mm.index);
  });
  await armedRun("GUI load + save (figbridge)", async () => {
    await loadFigInto(rootB, "");
    figProject.update((p) => { mutate(p); return p; });
    await saveFigFrom(rootB);
  });
  const treeA = await figTree(rootA), treeB = await figTree(rootB);
  h.eq([...treeA.keys()].sort(), [...treeB.keys()].sort(), "both trees contain the same files");
  h.ok([...treeA].every(([k, v]) => treeB.get(k) === v), "every fig/ file is BYTE-IDENTICAL across the two engines (index, .bak, canvases, captions, the bundle)");
  h.ok(await bundleStamp(rootA) === stampA0 && await bundleStamp(rootB) === stampB0, "the bundle directory is untouched by either save (same files, sizes, mtimes, inodes)");
  const index = JSON.parse(await orig.readFile(path.join(rootA, "fig/index.json"), "utf8"));
  const c1 = JSON.parse(await orig.readFile(path.join(rootA, "fig/canvases/c1.json"), "utf8"));
  const c2 = JSON.parse(await orig.readFile(path.join(rootA, "fig/canvases/c2.json"), "utf8"));
  const saved = index.assets.find((a: { id: string }) => a.id === ASSET_ID);
  h.ok(saved?.kind === "fluximg" && saved.sha256 === asset.sha256 && saved.bytes === asset.bytes && JSON.stringify(saved.fluximg) === JSON.stringify(asset.fluximg) && saved.path === asset.path,
    "the index keeps kind, content id, size, digest and the directory path");
  h.ok(index.schemaVersion === "0.3.0" && c1.schemaVersion === "0.4.0" && c2.schemaVersion === "0.1.0", `stamps rise only where the content is: index 0.3.0, the fluximg canvas 0.4.0, the other canvas stays 0.1.0 (${index.schemaVersion}/${c1.schemaVersion}/${c2.schemaVersion})`);
  const el = c1.figures[0].elements[0] as FluximgElement;
  h.ok(el.type === "fluximg" && el.crop?.width === 32 && el.view?.smooth === true && el.view?.index?.z === 0 && el.source?.bundlePath === "plots/cells.fluximg", "the element keeps crop, view and source on disk");

  h.section("reopen: identical models, no-edit save byte-stable");
  const reopened = await armedRun("flux-core reopen", () => core.loadFigModel(rootA));
  await armedRun("GUI reopen", () => loadFigInto(rootB, ""));
  h.ok(comparable(reopened.project) === comparable(get(figProject) as Project), "both engines reopen to the identical model");
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v;
  h.eq(sorted(reopened.project.assets.find((a) => a.id === ASSET_ID)), sorted(asset), "the asset round-trips with every field (normalizeIndexAssets)");
  await armedRun("no-edit saves", async () => { await core.saveFigModel(rootA, reopened.project, reopened.index); await saveFigFrom(rootB); });
  const stableA = await figTree(rootA), stableB = await figTree(rootB);
  h.ok([...treeA].filter(([k]) => !k.endsWith(".bak")).every(([k, v]) => stableA.get(k) === v && stableB.get(k) === v), "a no-edit reopen + save is byte-stable in both engines");

  h.section("2. normalization, stamps and an older reader");
  const norm = normalizeIndexAssets({ schemaVersion: "0.3.0", canvases: [], figures: [], assets: [{ ...saved }, { id: "odd", kind: "weird" as never, path: "assets/odd.svg" }] });
  h.ok(norm[0].kind === "fluximg" && norm[0].fluximg?.dtype === asset.fluximg!.dtype && norm[0].sha256 === asset.sha256, "normalizeIndexAssets keeps a fluximg as fluximg with its fields");
  h.ok(norm[1].kind === "svg" && !("fluximg" in norm[1]), "an unknown kind still reads as svg (legacy behaviour unchanged)");
  const withoutFx = planFigSave({ ...reopened.project, assets: reopened.project.assets.filter((a) => a.id !== ASSET_ID), figures: reopened.project.figures.map((f) => ({ ...f, elements: f.elements.filter((e) => e.type !== "fluximg") })) }, reopened.index);
  h.ok(JSON.parse(withoutFx.index.text).schemaVersion === "0.1.0" && JSON.parse(withoutFx.canvases[0].text).schemaVersion === "0.1.0", "removing the content lowers both stamps again (an exact derivation)");
  h.ok(CANVAS_SCHEMA_VERSION === "0.4.0" && FIG_INDEX_SCHEMA_VERSION === "0.3.0", "this build reads canvas 0.4.0 and index 0.3.0");
  h.ok(isNewerSchema(c1.schemaVersion, "0.3.0") && isNewerSchema(index.schemaVersion, "0.2.0"), "a build before fluximg (canvas 0.3.0, index 0.2.0) refuses both files by version");
  {
    // ...and its validator would refuse the element too (the canvas schema without the fluximg branch).
    const old = structuredClone(SCHEMAS.canvas) as { definitions: { element: { oneOf: Array<{ properties: { type: { const: string } } }> } } };
    old.definitions.element.oneOf = old.definitions.element.oneOf.filter((b) => b.properties.type.const !== "fluximg");
    const validateOld = new Ajv({ strict: false }).compile(old);
    h.ok(!validateOld(c1) && validateOld(c2), "the pre-fluximg canvas validator rejects the new canvas and accepts the untouched one");
  }

  h.section("3. refs: stacks only; no reader asks for bytes");
  {
    // The guard itself: every way a reader could reach a bundle file is armed (promises object, named ESM bindings,
    // the GUI bridge), so a quiet pass above means nothing asked.
    const file = path.join(rootA, "fig/assets", `${ASSET_ID}.fluximg`, (await orig.readdir(path.join(rootA, "fig/assets", `${ASSET_ID}.fluximg`), { withFileTypes: true })).find((e) => e.isFile())!.name);
    const { readFile: namedReadFile } = await import("node:fs/promises");
    const caught: boolean[] = [];
    armed = true;
    const attempts: Array<() => Promise<unknown>> = [() => fs.readFile(file), () => namedReadFile(file), () => bridge.readFile(file), async () => fsSync.readFileSync(file)];
    for (const attempt of attempts) caught.push(await Promise.resolve().then(attempt).then(() => false, () => true));
    armed = false;
    asked.length = 0;
    h.ok(caught.every(Boolean), `the byte guard catches fs.promises, the named ESM binding, the GUI bridge and readFileSync (${caught.join(",")})`);
  }
  const fx = reopened.project.figures.find((f) => f.id === "figA")!.elements[0];
  h.eq(elementAssetRefs(fx), { images: [], models: [], media: [], stacks: [ASSET_ID], manifests: [], posterRefs: [] }, "elementAssetRefs puts a fluximg in `stacks` and nowhere else");
  h.eq(elementSourceAssetIds(fx), [ASSET_ID], "elementSourceAssetIds counts it (GC and dependencies keep it)");
  h.ok(!figureImageAssetIds(reopened.project.figures.find((f) => f.id === "figA")!).has(ASSET_ID), "figureImageAssetIds (export, Paper, Route C) never names it");
  await armedRun("readFigureSnapshot", () => readFigureSnapshot({ readText: (rel) => fs.readFile(path.join(rootA, rel), "utf8").catch(() => null), assetExists: (rel) => fs.access(path.join(rootA, rel)).then(() => true, () => false) }));
  await armedRun("readFigAssets (cold structure read)", async () => { const r = await readFigAssets(rootB, [ASSET_ID, "png1"]); h.ok(!(ASSET_ID in r.assetData) && !!r.assetData.png1 && !r.issues?.length, "cold read: the PNG becomes a data URL, the bundle does not and raises no issue"); });
  await armedRun("ensureAssetBytes", () => ensureAssetBytes([ASSET_ID]));
  await armedRun("readProjectDependencies", async () => {
    const deps = await readProjectDependencies(rootA, { readText: (p: string) => fs.readFile(p, "utf8"), readdir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() })) });
    h.ok(deps.byAsset[ASSET_ID]?.some((u) => u.kind === "figure"), "dependencies list the figure that places the bundle");
  });
  const svg = await armedRun("flux-core renderFigureSvg", () => core.renderFigureSvg(rootA, "figA"), true);
  // This project's bundle is a stand-in directory (the model gate needs no pixels): the renderer must still produce
  // the figure, drawing the image from the bundle when it can and the named stand-in when it cannot.
  h.ok(svg.includes(`data-fluximg="${ASSET_ID}"`) || svg.includes(`data-fluximg-placeholder="${ASSET_ID}"`), "flux-core render draws the image, or its stand-in when the bundle cannot be read");
  h.ok(walked.length === 0, `no engine walked a bundle's chunk files (${walked.length})`);

  h.section("4. GC, deletion and a missing bundle");
  {
    const root = path.join(work, "gc");
    await fs.cp(rootA, root, { recursive: true });
    await armedRun("deleteFigure of an unrelated figure", () => core.deleteFigure(root, "figB"));
    let idx = JSON.parse(await orig.readFile(path.join(root, "fig/index.json"), "utf8"));
    h.ok(idx.assets.some((a: { id: string }) => a.id === ASSET_ID) && !idx.assets.some((a: { id: string }) => a.id === "png1"), "deleting another figure prunes its PNG and KEEPS the referenced bundle");
    await armedRun("deleteFigure of the placing figure", () => core.deleteFigure(root, "figA"));
    idx = JSON.parse(await orig.readFile(path.join(root, "fig/index.json"), "utf8"));
    h.ok(!idx.assets.some((a: { id: string }) => a.id === ASSET_ID) && idx.schemaVersion === "0.1.0", "deleting its last placement releases the bundle under the same rule as the PNG (and the index stamp falls back)");
    h.ok(fsSync.existsSync(path.join(root, "fig/assets", `${ASSET_ID}.fluximg`)), "the directory itself is left alone, as asset files are (a recompose can reuse it)");
  }
  {
    const root = path.join(work, "missing");
    await fs.cp(rootA, root, { recursive: true });
    await fs.rm(path.join(root, "fig/assets", `${ASSET_ID}.fluximg`), { recursive: true });
    const snap = await readFigureSnapshot({ readText: (rel) => fs.readFile(path.join(root, rel), "utf8").catch(() => null), assetExists: (rel) => fs.access(path.join(root, rel)).then(() => true, () => false) });
    h.ok(snap.status === "complete" && snap.assetIssues.length === 1 && snap.assetIssues[0].assetId === ASSET_ID && /Image bundle .*missing/.test(snap.assetIssues[0].message), "a missing bundle is a non-blocking asset issue, never a failed load");
    const loaded = await core.loadFigModel(root).then(() => true, () => false);
    h.ok(loaded, "flux-core still loads the project");
    await loadFigInto(root, "");
    h.ok(get(figProject).figures.some((f) => f.elements.some((e) => e.type === "fluximg")), "the GUI loads it complete (placeholder + toast), so the element can be deleted");
    const refused = await saveFigFrom(root).then(() => "", (e: Error) => String(e?.message ?? e));
    h.ok(/Image bundle .*missing/.test(refused), `the GUI save waits while the element still uses it (${refused.slice(0, 80)})`);
    figProject.update((p) => { ops.deleteElements(p, ["fxel"]); return p; });
    const after = await saveFigFrom(root).then(() => "ok", (e: Error) => String(e?.message ?? e));
    h.ok(after === "ok", `deleting the element lets the save through (${after.slice(0, 80)})`);
  }

  h.section("5. ops");
  const proj = (width = 200): Project => ({ version: 2, name: "", canvases: [{ id: "c", name: "C" }], palette: [], assets: [], figures: [{ id: "f", canvasId: "c", name: "f", x: 0, y: 0, width, height: 150, background: "#ffffff", elements: [] }] });
  {
    const p = proj();
    const id = ops.addFluximg(p, { figureId: "f", asset });
    const e = p.figures[0].elements[0] as FluximgElement;
    h.ok(e.id === id && e.type === "fluximg" && e.width === W && e.height === H && e.lockAspect === true && e.x === 20 && e.y === 20 && !("view" in e) && !("crop" in e), `default size is 1 image px = 1 canvas px (${e.width}×${e.height}), aspect locked, no view stored`);
    h.ok(p.assets.length === 1 && p.assets[0] !== asset && JSON.stringify(p.assets[0]) === JSON.stringify(asset), "the asset is registered (a copy)");
    ops.addFluximg(p, { figureId: "f", asset });
    h.ok(p.assets.length === 1 && p.figures[0].elements.length === 2, "placing the same asset again registers it once");
    h.ok(validateModel(JSON.parse(JSON.stringify(p))).length === 0, "the result passes the load gate");
    h.eq(ops.assetDisplaySize(p, ASSET_ID), { width: W, height: H }, "assetDisplaySize is the image's pixel size");
  }
  {
    const wide: Asset = { ...asset, id: "wide", naturalWidth: 1000, naturalHeight: 500 };
    const p = proj(200);
    ops.addFluximg(p, { figureId: "f", asset: wide });
    const e = p.figures[0].elements[0];
    h.ok(e.width === 180 && e.height === 90 && e.x === 10 && e.y === 10, `wider than the figure: fit to its width less a margin, aspect kept (${e.x},${e.y} ${e.width}×${e.height})`);
    ops.addFluximg(p, { figureId: "f", asset: wide, width: 300, x: 1, y: 2 });
    const e2 = p.figures[0].elements[1];
    h.ok(e2.width === 300 && e2.height === 150 && e2.x === 1 && e2.y === 2, "an explicit width is honoured and the height follows the aspect");
    ops.addFluximg(p, { figureId: "f", asset: wide, crop: { x: 0, y: 0, width: 100, height: 25 } });
    const e3 = p.figures[0].elements[2] as FluximgElement;
    h.ok(e3.width === 100 && e3.height === 25 && e3.crop?.width === 100, "with a crop, the box takes the crop's size and aspect");
    const refuse = (fn: () => unknown) => { try { fn(); return ""; } catch (err) { return String((err as Error).message); } };
    h.ok(/figure not found/.test(refuse(() => ops.addFluximg(p, { figureId: "nope", asset }))), "an unknown figure is refused");
    h.ok(/needs a fluximg asset/.test(refuse(() => ops.addFluximg(p, { figureId: "f", asset: { ...asset, id: "p", kind: "png" } }))), "a non-fluximg asset is refused");
    h.ok(/no pixel size/.test(refuse(() => ops.addFluximg(p, { figureId: "f", asset: { ...asset, id: "z", naturalWidth: 0 } }))), "an unsized asset is refused");
  }
  h.section("setFluximgView: the merge laws");
  {
    const p = proj();
    const id = ops.addFluximg(p, { figureId: "f", asset });
    const view = () => (p.figures[0].elements[0] as FluximgElement).view;
    const patch: FluximgView = { index: { z: 3, t: 1 }, composite: "single", solo: 1, channels: [{ range: [0, 9] }, undefined as never, { color: "#ff0000" }] };
    ops.setFluximgView(p, id, patch);
    const once = JSON.stringify(view());
    ops.setFluximgView(p, id, patch);
    h.ok(JSON.stringify(view()) === once, "applying the same patch twice equals applying it once");
    h.ok(view()?.index?.z === 3 && view()?.composite === "single" && view()?.channels?.[1] === null && view()?.channels?.[2]?.color === "#ff0000", "keys are set; a hole in channels stays empty");
    ops.setFluximgView(p, id, { index: { t: 5 } });
    h.eq(view()?.index, { z: 3, t: 5 }, "plain objects merge key by key (absent keys unchanged)");
    ops.setFluximgView(p, id, { channels: [undefined as never, undefined as never, { lut: "viridis" }] });
    h.eq(view()?.channels, [{ range: [0, 9] }, null, { lut: "viridis" }], "channels are positional: entry i merges into channel i, holes leave others alone; a colour map replaces a colour");
    ops.setFluximgView(p, id, { channels: [null as never] });
    h.eq(view()?.channels, [{ range: [0, 9] }, null, { lut: "viridis" }], "a null channel entry leaves that channel alone (JSON has no holes)");
    ops.setFluximgView(p, id, { channels: [{ range: null as never }] });
    h.eq(view()?.channels, [null, null, { lut: "viridis" }], "a null field clears that override; an emptied entry becomes null");
    ops.setFluximgView(p, id, { projection: { dim: "z", mode: "max", from: 0, to: 4 } });
    ops.setFluximgView(p, id, { projection: { dim: "t", mode: "mean", from: 1, to: 2 } });
    h.eq(view()?.projection, { dim: "t", mode: "mean", from: 1, to: 2 }, "a complete projection replaces the old one");
    ops.setFluximgView(p, id, { projection: { from: 0 } as never });
    h.eq(view()?.projection, { dim: "t", mode: "mean", from: 0, to: 2 }, "a partial projection patch moves one end of the run");
    ops.setFluximgView(p, id, { projection: null, composite: undefined, solo: undefined });
    h.ok(!("projection" in view()!) && view()?.composite === "single", "null clears a key back to its default; undefined leaves it alone");
    ops.setFluximgView(p, id, { composite: null as never });
    h.ok(!("composite" in view()!), "null clears composite");
    ops.setFluximgView(p, id, { furniture: { scalebar: false } });
    ops.setFluximgView(p, id, { furniture: { scalebar: { corner: "top-left" } } });
    h.eq(view()?.furniture, { scalebar: { corner: "top-left" } }, "`false` switches an item off (its default), and an object switches it on");
    ops.setFluximgView(p, id, { furniture: { scalebar: false } });
    h.ok(!("furniture" in view()!), "switching the last furniture item off leaves no furniture key");
    ops.setFluximgView(p, id, { furniture: { stamp: {} } });
    h.eq(view()?.furniture, { stamp: {} }, "an empty object means on, with defaults");
    const range: [number, number] = [1, 2];
    const input: FluximgView = { channels: [{ range }] };
    ops.setFluximgView(p, id, input);
    range[0] = 99;
    h.ok(view()?.channels?.[0]?.range?.[0] === 1, "the stored view shares nothing with the patch");
    ops.setFluximgView(p, id, { index: null as never, solo: null as never, channels: null as never, furniture: null as never });
    h.ok(view() === undefined && !("view" in p.figures[0].elements[0]), "clearing every override leaves no `view` at all (absent = default)");
    h.ok(validateModel(JSON.parse(JSON.stringify(p))).length === 0, "the merged model passes the load gate");
    let threw = false; try { ops.setFluximgView(p, "nope", {}); } catch { threw = true; }
    h.ok(threw, "an unknown element id is refused");
  }
  h.section("linked panels move together");
  {
    const p = proj();
    const a = ops.addFluximg(p, { figureId: "f", asset, view: { link: "L", channels: [{ color: "#00ff00" }] } });
    const b = ops.addFluximg(p, { figureId: "f", asset, view: { link: "L", composite: "single", solo: 1 } });
    const c = ops.addFluximg(p, { figureId: "f", asset });
    const el = (id: string) => p.figures[0].elements.find((e) => e.id === id) as FluximgElement;
    ops.setFluximgView(p, a, { index: { z: 4 }, channels: [{ range: [10, 90], color: "#ff00ff" }], smooth: true });
    h.ok(el(b).view?.index?.z === 4, "a linked panel follows the position");
    h.eq(el(b).view?.channels, [{ range: [10, 90] }], "…and each channel's window, but not its colour");
    h.ok(el(b).view?.smooth === undefined && el(b).view?.composite === "single" && el(b).view?.solo === 1, "what a panel shows stays its own");
    h.ok(el(c).view === undefined, "an element without the link is untouched");
    ops.setFluximgView(p, b, { projection: { dim: "z", mode: "max", from: 0, to: 3 } });
    h.eq(el(a).view?.projection, { dim: "z", mode: "max", from: 0, to: 3 }, "the link works in both directions");
    ops.setFluximgView(p, a, { projection: null, channels: [{ range: null as never }] });
    h.ok(el(b).view?.projection === undefined && el(b).view?.channels === undefined, "clearing a shared value clears it on every linked panel");
    ops.setFluximgView(p, a, { link: null as never });
    ops.setFluximgView(p, a, { index: { z: 1 } });
    h.ok(el(b).view?.index?.z === 4, "an element that left the link no longer drives it");
    h.ok(validateModel(JSON.parse(JSON.stringify(p))).length === 0, "linked views pass the load gate");
    // Objects styled by a column (styleBy) and the key: stored, loaded, and what one panel shows (never linked).
    ops.setFluximgView(p, b, { link: "L" });
    ops.setFluximgView(p, a, { link: "L" });
    ops.setFluximgView(p, a, { layers: { cells: { styleBy: { color: { column: "kind", palette: ["#ff0000"], range: null }, opacity: { column: "area", range: [1, 9], to: [0.2, 1] }, missing: "hide" } } }, furniture: { key: { corner: "bottom-left", fontSize: 7 } } });
    h.ok(validateModel(JSON.parse(JSON.stringify(p))).length === 0 && !!el(a).view?.layers?.cells?.styleBy && !!el(a).view?.furniture?.key, "a view styled by columns, with its key, passes the load gate");
    h.ok(!el(b).view?.layers?.cells?.styleBy && !el(b).view?.furniture?.key, "…and styling is one panel's own (linked panels share position and windows only)");
  }
  h.section("crop");
  {
    const p = proj();
    const id = ops.addFluximg(p, { figureId: "f", asset, x: 0, y: 0 });
    const e = p.figures[0].elements[0] as FluximgElement;
    h.ok(ops.setCrop(p, id, { x: 8, y: 4, width: 16, height: 12 }), "ops.setCrop accepts a fluximg");
    h.ok(e.x === 8 && e.y === 4 && e.width === 16 && e.height === 12 && e.crop?.width === 16, `cropping pins the content: the box follows the window (${e.x},${e.y} ${e.width}×${e.height})`);
    ops.setCrop(p, id, { x: 0, y: 0, width: W, height: H });
    h.ok(!e.crop && e.width === W, "a full-image window is stored as no crop");
    ops.setCrop(p, id, { x: 2, y: 2, width: 10, height: 10 });
    ops.setCrop(p, id, null);
    h.ok(!e.crop && e.x === 0 && e.y === 0 && e.width === W && e.height === H, "Reset crop returns to the whole image at the same scale");
  }
  h.section("lenient load");
  {
    const p = proj();
    p.figures[0].elements.push({ type: "fluximg", id: "x", assetId: ASSET_ID, x: 0, y: 0, width: 1, height: 1, rotation: 0, view: [] as never, crop: { x: 0, y: 0, width: 0, height: 1 }, source: { bundlePath: "" } } as FluximgElement);
    p.assets.push(asset);
    migrateProject(p);
    const e = p.figures[0].elements[0];
    h.ok(!("view" in e) && !("crop" in e) && !("source" in e) && validateModel(JSON.parse(JSON.stringify(p))).length === 0, "garbage containers (view array, zero-area crop, source without a path) drop to their defaults and the model loads");
    const good = { ...e, view: { index: { z: 1 } }, crop: { x: 0, y: 0, width: 2, height: 2 } };
    p.figures[0].elements[0] = structuredClone(good) as FluximgElement;
    migrateProject(p);
    h.ok(JSON.stringify(p.figures[0].elements[0]) === JSON.stringify(good), "a well-formed element is never rewritten by migration");
  }
  h.section("placeholder");
  {
    const markup = fluximgPlaceholderSvg({ x: 1, y: 2, width: 100, height: 50, assetId: "a<b", name: "n" }, { name: "Cells & nuclei" });
    h.ok(markup.includes('data-fluximg-placeholder="a&lt;b"') && markup.includes("Cells &amp; nuclei") && markup.includes('width="100" height="50"'), "the placeholder covers the box, labels with the asset name, escapes text");
    h.ok(fluximgPlaceholderSvg({ x: 0, y: 0, width: 100, height: 50, assetId: "a" }, null).includes(">Image<"), "without an asset it labels generically");
  }

  h.section("6. a deck receives the element (stage 2), and never owns the bundle");
  {
    const deck = slideOps.createDeck({ id: "d", title: "D" });
    const figure = { elements: [{ type: "fluximg", id: "x", assetId: ASSET_ID, x: 0, y: 0, width: 10, height: 10, rotation: 0 } as FluximgElement] };
    const ids = slideOps.addFigureContentToSlide(deck, deck.slides[0].id, figure);
    const copied = deck.slides[0].elements.find((e) => e.id === ids[0]);
    h.ok(ids.length === 1 && copied?.type === "fluximg" && copied.assetId === ASSET_ID && copied.id !== "x" && !deck.assets.length, "addFigureContentToSlide (Send to deck, add_slide_figure) copies the image by id with a fresh element id; the deck owns no asset");
    const projected = deckToProject(deck, [asset]);
    const id = ops.addFluximg(projected, { figureId: projected.figures[0].id, asset });
    const placedEl = projected.figures[0].elements.find((e) => e.id === id)!;
    h.ok(placedEl.type === "fluximg" && placedEl.width <= deck.stage.width && placedEl.height <= deck.stage.height, `addFluximg on a deck slide places the image inside the stage (${placedEl.width}×${placedEl.height})`);
    const back = projectIntoDeck(projected, deck);
    h.ok(back.slides[0].elements.filter((e) => e.type === "fluximg").length === 2 && !back.assets.some((a) => a.kind === "fluximg"), "the fold keeps every image element and never writes the bundle into deck.assets");
    h.eq(validateDeckFile(JSON.parse(JSON.stringify({ ...back, schemaVersion: "0.8.0" }))), [], "the deck schema accepts a deck holding images (0.8.0)");
    const root = path.join(work, "deck");
    await fs.cp(rootA, root, { recursive: true });
    await core.saveDeck(root, slideOps.createDeck({ id: "talk", title: "Talk" }));
    const talk = await core.loadDeck(root, "talk");
    const cli = await armedRun("flux-core add_slide_figure", () => core.addFigureToSlide(root, "talk", talk.slides[0].id, "figA").then((r) => r.elementIds, (e: Error) => String(e?.message ?? e)));
    const saved = JSON.parse(await orig.readFile(path.join(root, "slides/talk/deck.json"), "utf8"));
    h.ok(Array.isArray(cli) && saved.schemaVersion === "0.8.0" && saved.slides[0].elements.some((e: { type: string }) => e.type === "fluximg") && !saved.assets.some((a: { kind: string }) => a.kind === "fluximg"),
      `flux-core add_slide_figure copies the image (deck written as 0.8.0, no deck-owned bundle) without reading the bundle (${JSON.stringify(cli).slice(0, 60)})`);
  }
} finally {
  armed = false;
  await fs.rm(work, { recursive: true, force: true });
}
await h.done();
