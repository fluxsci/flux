// verify-fluximg-import (pure, hermetic): from "a bundle exists under plots/" to "a placed element", and keeping a
// placed image in step with its source bundle.
//
//   A. The index rules (electron/plotThumbRules.mjs): a `*.fluximg` FOLDER is one item; nothing inside it is ever
//      listed; nested folders and reserved folders keep their rules; a folder merely NAMED `.fluximg` without a
//      manifest is listed as broken (not hidden); a FILE named `x.fluximg` is not a bundle.
//   B. Both engines: the thumbnail worker's walk (plotThumbEngine.list, real files) and the in-memory dev bridge
//      (memBridge.plotsList) give the same entries; an incremental re-list of a folder INSIDE a bundle lists nothing.
//      Timing: listing 200 bundles (stats only, no manifest opened).
//   C. Placement against the memory bridge (fluximg/import.ts through io.ts): the element records the bundle path
//      and content id; the same content twice is ONE asset (the fresh copy is discarded); a failure leaves nothing
//      in fig/assets and says the file side's words; a Slide deck refuses before anything is copied.
//   D. Update from source: view / crop carried or clamped (importCore.carryFluximgView), the plan and its one-commit
//      application, the watcher-driven hot swap (quiet window, one undo step), frozen elements stay, source states.
//   E. Timing: the native import of the largest fixture (electron/fluximgFiles.cjs).
//
//   node --import tsx scripts/verify-fluximg-import.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { get } from "svelte/store";
import { DOMParser } from "linkedom";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures";
import * as R from "../electron/plotThumbRules.mjs";
import { createMemBridge } from "../src/lib/project/memBridge";
import type { PlotIndexEntry } from "../src/lib/project/types";
import type { Project, Figure, Asset } from "../src/lib/types";
import type { FluximgElement } from "../src/lib/fluximg/element";
import type { FluximgManifest } from "../src/lib/fluximg/types";

const h = harness("verify-fluximg-import");
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-fluximg-import-"));
const fixDir = path.join(scratch, "fixtures");
const enc = new TextEncoder();

async function rejects(p: Promise<unknown>, re: RegExp, msg: string): Promise<string> {
  try { await p; h.fail(`${msg} — expected a refusal matching ${re}, got success`); return ""; }
  catch (e) { const m = e instanceof Error ? e.message : String(e); h.ok(re.test(m), re.test(m) ? msg : `${msg} — expected ${re}, got: ${m}`); return m; }
}
/** Every file of a directory as posix rel → bytes. */
async function filesOf(dir: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const ent of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!ent.isFile()) continue;
    const abs = path.join(ent.parentPath, ent.name);
    out[path.relative(dir, abs).split(path.sep).join("/")] = new Uint8Array(await fs.readFile(abs));
  }
  return out;
}
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 20)); } // condition poll, bounded
  return true;
};
// A tiny 8-bit PNG (1 x 1) for preview.png: the index only stats it, the rail reads its header.
const PNG_1x1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64"));

try {
  for (const f of fixtures()) if (["gray2d_u8", "stack_u16", "rgb_u8", "big_tiled_u16", "mid_tiled_u16", "mean_f64_layers"].includes(f.name)) await writeFixture(fixDir, f);
  const fx = (name: string) => path.join(fixDir, `${name}.fluximg`);

  // ------------------------------------------------------------------------------------------------------------
  h.section("A. the index rules");
  h.ok(R.isFluximgBundleName("cells.fluximg") && R.isFluximgBundleName("A.FLUXIMG") && !R.isFluximgBundleName(".fluximg") && !R.isFluximgBundleName("cells.fluximg.json") && !R.isFluximgBundleName("cells.svg"), "a bundle name ends in .fluximg (case-insensitive); a bare .fluximg is not one");
  h.eq(R.fluximgBundleOf("/p/plots/a/cells.fluximg/pixels/0/c/0/0"), "/p/plots/a/cells.fluximg", "a path inside a bundle belongs to the bundle");
  h.eq(R.fluximgBundleOf("C:\\p\\plots\\x.fluximg\\fluximg.json"), "C:\\p\\plots\\x.fluximg", "…in Windows separators too");
  h.eq(R.fluximgBundleOf("/p/plots/cells.fluximg"), "/p/plots/cells.fluximg", "the bundle itself is its own bundle");
  h.eq(R.fluximgBundleOf("/p/plots/a/b.svg"), null, "an ordinary path is in no bundle");
  h.eq(R.fileAcceptExts("svg,png,glb,fluximg"), ["svg", "png", "glb"], "the bundle token is not a file extension");
  h.ok(R.acceptsFluximg("svg,fluximg") && !R.acceptsFluximg("svg,png,glb"), "an accept list asks for bundles only by naming them");
  h.eq(R.fluximgIndexEntry({ rel: "a/x.fluximg", abs: "/b/a/x.fluximg", manifest: { size: 10, mtimeMs: 5 }, preview: null }),
    { rel: "a/x.fluximg", abs: "/b/a/x.fluximg", size: 10, mtimeMs: 5, semantic: false, snip: false, fluximg: { preview: false } }, "an entry is versioned by its manifest's stat");
  h.ok(R.fluximgIndexEntry({ rel: "x.fluximg", abs: "/x.fluximg", manifest: null, preview: null, dirMtimeMs: 7 }).broken === R.FLUXIMG_BROKEN, "no manifest: broken, with a plain reason");

  // ------------------------------------------------------------------------------------------------------------
  h.section("B. both engines list a tree the same way");
  const project = path.join(scratch, "project"), plots = path.join(project, "plots");
  const tree: Record<string, Uint8Array> = {};
  const put = (rel: string, bytes: Uint8Array) => { tree[rel] = bytes; };
  const svg = enc.encode('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30"/></svg>');
  put("plain.svg", svg);
  for (const [rel, bytes] of Object.entries(await filesOf(fx("gray2d_u8")))) put(`gray.fluximg/${rel}`, bytes);
  put("gray.fluximg/preview.png", PNG_1x1);
  put("gray.fluximg/layers/extra.svg", svg); // a layer SVG: part of the image, never a plot
  for (const [rel, bytes] of Object.entries(await filesOf(fx("mean_f64_layers")))) put(`deep/er/cells.fluximg/${rel}`, bytes);
  put("deep/er/beside.png", PNG_1x1);
  put("unfinished.fluximg/pixels/zarr.json", enc.encode("{}")); // a write in progress: no manifest yet
  put("_dissections/k/hidden.fluximg/fluximg.json", enc.encode("{}")); // reserved folders keep their rule
  put("a.fluximg.svg", svg); // just a plot with an odd name
  put("file.fluximg", enc.encode("not a folder"));
  for (const [rel, bytes] of Object.entries(tree)) { await fs.mkdir(path.dirname(path.join(plots, rel)), { recursive: true }); await fs.writeFile(path.join(plots, rel), bytes); }
  await fs.mkdir(path.join(plots, "empty.fluximg"), { recursive: true }); // an empty folder named like a bundle
  await fs.writeFile(path.join(project, "project.json"), "{}");

  const { createThumbEngine } = await import(pathToFileURL(path.join(repo, "electron", "plotThumbEngine.mjs")).href);
  const engine = createThumbEngine({ cacheDir: path.join(scratch, "cache"), resvgFrom: pathToFileURL(path.join(repo, "package.json")).href });
  const acceptFn = (spec: string) => { const exts = R.fileAcceptExts(spec); const re = new RegExp(`\\.(${exts.join("|")})$`, "i"); return (n: string) => exts.length > 0 && re.test(n); };
  const nativeList = (spec: string, dirs: string[] | null = null) => engine.list(plots, { skipDir: (n: string) => n === "_dissections", accept: acceptFn(spec), fluximg: R.acceptsFluximg(spec), indexRoot: plots, dirs }) as Promise<{ entries: PlotIndexEntry[]; missing: string[] }>;
  const strip = (es: PlotIndexEntry[]) => es.map((e) => ({ rel: e.rel, fluximg: e.fluximg ?? null, broken: !!e.broken })).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const native = await nativeList("svg,png,glb,fluximg");
  const rels = native.entries.map((e) => e.rel).sort();
  h.eq(rels, ["a.fluximg.svg", "deep/er/beside.png", "deep/er/cells.fluximg", "empty.fluximg", "gray.fluximg", "plain.svg", "unfinished.fluximg"], "native walk: each bundle is ONE entry, nested ones too; reserved folders and a FILE named .fluximg are not listed");
  h.ok(!native.entries.some((e) => /\.fluximg\//.test(e.rel)), "nothing inside a bundle is listed (no preview.png, no layer SVG)");
  const g = native.entries.find((e) => e.rel === "gray.fluximg")!;
  const gm = await fs.stat(path.join(plots, "gray.fluximg", "fluximg.json"));
  h.ok(g.fluximg?.preview === true && g.size === gm.size && g.mtimeMs === gm.mtimeMs && !g.broken, "a bundle's version is its manifest's size and mtime; its preview is noticed");
  h.ok(native.entries.find((e) => e.rel === "deep/er/cells.fluximg")?.fluximg?.preview === false, "a bundle without preview.png says so");
  h.ok(native.entries.filter((e) => e.broken).map((e) => e.rel).sort().join() === "empty.fluximg,unfinished.fluximg", "folders named .fluximg without a manifest are listed as broken, not hidden");
  const noBundles = await nativeList("svg,png,glb");
  h.eq(noBundles.entries.map((e) => e.rel).sort(), ["a.fluximg.svg", "deep/er/beside.png", "plain.svg"], "a listing that does not ask for bundles still never walks into one");
  const inside = await nativeList("svg,png,fluximg", [path.join(plots, "gray.fluximg"), path.join(plots, "gray.fluximg", "layers")]);
  h.eq(inside.entries.length, 0, "an incremental re-list of folders inside a bundle lists nothing");
  const parent = await nativeList("svg,png,fluximg", [path.join(plots, "deep", "er")]);
  h.eq(parent.entries.map((e) => e.rel).sort(), ["deep/er/beside.png", "deep/er/cells.fluximg"], "re-listing the folder that holds a bundle refreshes the bundle with its neighbours");

  const mem = createMemBridge(), mroot = "/memproject";
  mem._files.set(`${mroot}/project.json`, enc.encode(JSON.stringify({ schemaVersion: "0.7.0" })));
  mem._files.set(`${mroot}/fig/index.json`, enc.encode(JSON.stringify({ assets: [] })));
  await mem.watchRoot!(mroot);
  for (const [rel, bytes] of Object.entries(tree)) mem._files.set(`${mroot}/plots/${rel}`, bytes);
  mem._dirs.add(`${mroot}/plots/empty.fluximg`);
  const memList = await mem.plotsList!({ scope: "project", accept: "svg,png,glb,fluximg" });
  h.eq(strip(memList.entries), strip(native.entries), "memory bridge: the same entries, kinds and broken flags as the native walk");
  const memNo = await mem.plotsList!({ scope: "project", accept: "svg,png,glb" });
  h.eq(memNo.entries.map((e) => e.rel).sort(), noBundles.entries.map((e) => e.rel).sort(), "…and the same listing without bundles");
  const memInside = await mem.plotsList!({ scope: "project", accept: "svg,png,fluximg", dirs: [`${mroot}/plots/gray.fluximg/layers`] });
  h.eq(memInside.entries.length, 0, "…and nothing for a folder inside a bundle");
  const memParent = await mem.plotsList!({ scope: "project", accept: "svg,png,fluximg", dirs: [`${mroot}/plots/deep/er`] });
  h.eq(memParent.entries.map((e) => e.rel).sort(), ["deep/er/beside.png", "deep/er/cells.fluximg"], "…and the bundle beside its neighbours when its folder is re-listed");

  // 200 bundles: the walk stats each bundle's manifest and preview; it opens none of them.
  const many = path.join(scratch, "many", "plots");
  const grayFiles = await filesOf(fx("gray2d_u8"));
  for (let i = 0; i < 200; i++) for (const [rel, bytes] of Object.entries(grayFiles)) {
    const p = path.join(many, `set${i % 10}`, `img${i}.fluximg`, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, bytes);
  }
  const fsp = require("node:fs").promises as typeof fs;
  const origOpen = fsp.open, origRead = fsp.readFile;
  let opened = 0;
  fsp.open = (async (...a: Parameters<typeof fs.open>) => { if (String(a[0]).endsWith("fluximg.json")) opened++; return origOpen(...a); }) as typeof fs.open;
  fsp.readFile = (async (...a: Parameters<typeof fs.readFile>) => { if (String(a[0]).endsWith("fluximg.json")) opened++; return origRead(...(a as [string])); }) as typeof fs.readFile;
  const t0 = performance.now();
  const big = await engine.list(many, { accept: acceptFn("svg,png,fluximg"), fluximg: true, indexRoot: many });
  const ms = performance.now() - t0;
  fsp.open = origOpen; fsp.readFile = origRead;
  h.ok(big.entries.length === 200 && big.entries.every((e: PlotIndexEntry) => e.fluximg && !e.broken), `200 bundles index as 200 entries in ${ms.toFixed(1)} ms (stats only)`);
  h.eq(opened, 0, "listing 200 bundles opens no manifest");

  // ------------------------------------------------------------------------------------------------------------
  h.section("C. placement through the memory bridge");
  (globalThis as unknown as { window: unknown }).window = { fig: mem };
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;
  const store = await import("../src/lib/store");
  const tenancy = await import("../src/lib/tenancy");
  const io = await import("../src/lib/io");
  const fimport = await import("../src/lib/fluximg/import");
  const core = await import("../src/lib/fluximg/importCore");
  const policy = await import("../src/lib/fluximg/policy");
  const { toasts } = await import("../src/lib/toast");
  const seed = async (rel: string, name: string, extra: Record<string, Uint8Array> = {}) => mem._seedFluximg(mroot, rel, { ...(await filesOf(fx(name))), ...extra });
  await seed("plots/stack.fluximg", "stack_u16");
  await seed("plots/sub/copy.fluximg", "stack_u16"); // the same content under another name
  await seed("plots/gray.fluximg", "gray2d_u8");
  mem._seedFluximg(mroot, "plots/wrongspec.fluximg", { "fluximg.json": enc.encode(JSON.stringify({ spec: "fluximg/2" })) });
  const figure: Figure = { id: "fig1", name: "Figure 1", width: 600, height: 400, background: "#ffffff", elements: [] } as unknown as Figure;
  const blank = get(store.project);
  store.project.set({ ...blank, figures: [figure], assets: [] } as Project);
  store.activeFigureId.set("fig1");
  store.embeddedProjectRoot.set(mroot);
  tenancy.setStoreTenant("figure");
  const assetDirs = () => [...new Set([...mem._files.keys()].filter((k) => k.startsWith(`${mroot}/fig/assets/`)).map((k) => k.slice(`${mroot}/fig/assets/`.length).split("/")[0]))].sort();
  const fluximgEls = () => get(store.project).figures.flatMap((f) => f.elements).filter((e): e is FluximgElement => e.type === "fluximg");
  let importCalls = 0;
  const realImport = mem.importFluximg!;
  mem.importFluximg = (r) => { importCalls++; return realImport(r); };

  const n1 = await io.importPlotsFromPaths([`${mroot}/plots/stack.fluximg`]);
  h.eq(n1, 1, "the rail's insert path places one image");
  const [e1] = fluximgEls();
  const a1 = get(store.project).assets.find((a) => a.id === e1?.assetId);
  h.ok(!!e1 && !!a1 && a1.kind === "fluximg" && a1.path === `assets/${a1.id}.fluximg`, "the element points at a fluximg asset under fig/assets");
  h.eq(e1.source, { bundlePath: "plots/stack.fluximg", sha256: a1!.sha256 }, "the source is the project-relative bundle path and the import's content id");
  h.ok(e1.width === 64 && e1.height === 48 && e1.x === (600 - 64) / 2, "placed at 1 image px = 1 canvas px, centred (ops.addFluximg's sizing)");
  h.eq(assetDirs(), [a1!.id + ".fluximg"], "one asset folder");
  h.ok(!!get((await import("../src/lib/fluximg/store")).fluximgManifests)[a1!.id], "the import's manifest is primed: the canvas need not ask a worker for it");

  const n2 = await io.importPlotsFromPaths([`${mroot}/plots/stack.fluximg`]);
  const n3 = await io.importPlotsFromPaths([`${mroot}/plots/sub/copy.fluximg`]);
  h.ok(n2 === 1 && n3 === 1 && fluximgEls().length === 3, "placing the same bundle again, and a copy of it, adds elements");
  h.eq(new Set(fluximgEls().map((e) => e.assetId)).size, 1, "…all on ONE asset (same content id)");
  h.eq(get(store.project).assets.filter((a) => a.kind === "fluximg").length, 1, "…registered once");
  h.eq(assetDirs(), [a1!.id + ".fluximg"], "…and the fresh copies were discarded");
  h.eq(fluximgEls()[2].source?.bundlePath, "plots/sub/copy.fluximg", "each element still records where it came from");
  const nb = await io.importPlotsFromPaths([`${mroot}/plots/gray.fluximg`, `${mroot}/plots/gray.fluximg`]);
  h.ok(nb === 2 && get(store.project).assets.filter((a) => a.kind === "fluximg").length === 2 && assetDirs().length === 2, "one batch naming a bundle twice shares one copy");

  toasts.set([]);
  const before = assetDirs(), beforeEls = fluximgEls().length;
  const nw = await io.importPlotsFromPaths([`${mroot}/plots/wrongspec.fluximg`]);
  const t = get(toasts).find((x) => x.level === "error");
  h.ok(nw === 0 && fluximgEls().length === beforeEls, "a bundle the file side refuses places nothing");
  h.eq(assetDirs(), before, "…and leaves nothing in fig/assets");
  h.ok(!!t && /fluximg\/2/.test(t.detail ?? "") && t.detail!.startsWith("wrongspec.fluximg: "), `…and says the file side's words: ${t?.detail}`);
  await rejects(fimport.readIncomingFluximg(`${mroot}/plots/missing.fluximg`), /./, "a missing bundle is refused");
  h.eq(assetDirs(), before, "…leaving nothing behind");
  // A destination change during the copy: the copy is discarded.
  mem.importFluximg = async (r) => { const res = await realImport(r); store.activeFigureId.set("elsewhere"); return res; };
  await rejects(fimport.readIncomingFluximg("plots/gray.fluximg"), /destination changed/, "the destination changing during the copy refuses the placement");
  h.eq(assetDirs(), before, "…and discards the copy");
  mem.importFluximg = (r) => { importCalls++; return realImport(r); };
  store.activeFigureId.set("fig1");

  importCalls = 0;
  tenancy.setStoreTenant("slide");
  await rejects(io.importPlotsFromPaths([`${mroot}/plots/stack.fluximg`]), new RegExp(policy.FLUXIMG_NOT_IN_SLIDES.replace(/[().]/g, "\\$&")), "a Slide deck refuses with FLUXIMG_NOT_IN_SLIDES");
  await rejects(fimport.readIncomingFluximg("plots/stack.fluximg"), /cannot be placed on slides/, "…on every route");
  h.eq(importCalls, 0, "…before anything is copied");
  tenancy.setStoreTenant("figure");

  // Outside a Flux project (a legacy standalone or unsaved figure) a bundle has no fig/assets to live in.
  importCalls = 0;
  store.embeddedProjectRoot.set(null); store.projectDir.set(null);
  await rejects(io.importPlotsFromPaths([`${mroot}/plots/stack.fluximg`]), /inside a Flux project/, "an unsaved figure outside a project refuses in plain words");
  store.projectDir.set("/legacy/standalone.flux");
  await rejects(fimport.readIncomingFluximg(`${mroot}/plots/stack.fluximg`), /inside a Flux project/, "…and so does a legacy standalone project (its save looks in assets/, not fig/assets/)");
  h.eq(importCalls, 0, "…before anything is copied");
  store.projectDir.set(null); store.embeddedProjectRoot.set(mroot);
  // Progress for slow copies: nothing within the delay, "Importing image…" after it, gone when the copy ends.
  {
    const { trackFluximgImport } = await import("../src/lib/fluximg/importProgress");
    toasts.set([]);
    const end = trackFluximgImport("big.fluximg", () => true, [], 30);
    h.ok(!get(toasts).some((x) => /Importing image/.test(x.msg)), "no progress toast before the delay (the 0.1–1 s band needs none)");
    await new Promise((r) => setTimeout(r, 60)); // past the (shortened) delay
    h.ok(get(toasts).some((x) => x.msg === "Importing image…" && x.detail === "big.fluximg"), "a slow copy shows Importing image… naming the bundle");
    end();
    h.ok(!get(toasts).some((x) => /Importing image/.test(x.msg)), "…and it goes when the copy ends");
  }

  // The Import dialog offers a bundle's own manifest: picking it means the bundle.
  h.eq(io.pickedBundlePath("/x/plots/cells.fluximg/fluximg.json"), "/x/plots/cells.fluximg", "a picked fluximg.json stands for its bundle");
  h.eq(io.pickedBundlePath("/x/plots/notes/fluximg.json"), "/x/plots/notes/fluximg.json", "…only inside a .fluximg folder");
  h.ok(io.isFluximgPath("/x/a.fluximg") && io.isFluximgPath("a.fluximg/") && !io.isFluximgPath("/x/a.fluximg.svg"), "isFluximgPath names bundle folders");
  // An OS drop: a File named x.fluximg (the memory bridge names its path by the File's name).
  const nd = await io.importDroppedFiles([new File([], "plots/stack.fluximg")], "fig1").then(() => fluximgEls().length);
  h.ok(nd === beforeEls + 1 && fluximgEls().at(-1)!.source?.bundlePath === "plots/stack.fluximg" && fluximgEls().at(-1)!.assetId === a1!.id, "a dropped bundle folder places through the drop route, deduped too");
  // An external bundle: absolute path outside the project, recorded as external.
  const ext = core.fluximgSourceRecord("/proj", "/elsewhere/data/x.fluximg", "abc");
  h.eq(ext, { bundlePath: "/elsewhere/data/x.fluximg", sha256: "abc", external: true }, "a bundle outside the project records its absolute path and external");
  h.eq(core.fluximgSourceRecord("/proj", "/proj/plots/x.fluximg", "abc", "/proj/plots/x.recipe.json"), { bundlePath: "plots/x.fluximg", sha256: "abc", recipePath: "plots/x.recipe.json" }, "…one inside it is project-relative, with its recipe beside");

  // ------------------------------------------------------------------------------------------------------------
  h.section("D. carrying a view and crop across a source change");
  const manifestOf = async (name: string) => JSON.parse(await fs.readFile(path.join(fx(name), "fluximg.json"), "utf8")) as FluximgManifest;
  const stackM = await manifestOf("stack_u16"), grayM = await manifestOf("gray2d_u8"), layersM = await manifestOf("mean_f64_layers");
  const { fluximgInfo } = await import("../src/lib/fluximg/place");
  const stackInfo = fluximgInfo(stackM);
  const view = { index: { z: 5 }, channels: [{ range: [1, 2] as [number, number] }, { visible: false }], projection: { dim: "z", mode: "max" as const, from: 1, to: 6 }, solo: 1, layers: { gone: { visible: true } } };
  const same = core.carryFluximgView(stackInfo, stackM, view, { x: 10, y: 5, width: 20, height: 10 });
  h.ok(same.view === view && same.crop?.x === 10 && same.changed.length === 0, "same grid: view and crop carry over untouched");
  const shrunk = structuredClone(stackM);
  shrunk.pixels.shape = [2, 4, 30, 50]; shrunk.pixels.levels[0].shape = [2, 4, 30, 50];
  const c1 = core.carryFluximgView(stackInfo, shrunk, view, { x: 40, y: 5, width: 20, height: 10 });
  h.eq(c1.view?.index, { z: 3 }, "a position past the new end is clamped (resolveView semantics)");
  h.eq(c1.view?.projection, { dim: "z", mode: "max", from: 1, to: 4 }, "a projection is clamped to the new length");
  h.eq(c1.crop, { x: 40, y: 5, width: 10, height: 10 }, "the crop is clamped to the new image");
  h.ok(c1.changed.includes("the z position") && c1.changed.includes("the projection") && c1.changed.includes("the crop"), `…and each change is named: ${c1.changed.join(", ")}`);
  const c2 = core.carryFluximgView(stackInfo, grayM, view, { x: 100, y: 100, width: 5, height: 5 });
  h.ok(!c2.view?.index && !c2.view?.projection && c2.crop === undefined, "a dimension that is gone takes its position and projection with it; a crop outside the image is dropped");
  h.ok((c2.view?.channels?.length ?? 0) <= 1 && c2.view?.solo === 0, "channels past the new count are dropped; solo is clamped");
  h.ok(!c2.view?.layers && c2.changed.includes("settings of layers that are gone"), "layer settings for layers that are gone are dropped");
  const c3 = core.carryFluximgView(fluximgInfo(layersM), layersM, { layers: { footprints: { visible: false }, nope: { visible: true } }, layerOrder: ["nope", "discs"] }, undefined);
  h.ok(c3.changed.length === 0 && !!c3.view?.layers?.nope, "same grid: nothing is pruned, even unknown keys (the renderer ignores them)");

  h.section("D. moving placed images to new content (pure plan + one commit)");
  const asset = (id: string, sha: string, m: FluximgManifest): Asset => ({ id, name: id, kind: "fluximg", path: `assets/${id}.fluximg`, naturalWidth: m.pixels.shape.at(-1)!, naturalHeight: m.pixels.shape.at(-2)!, sha256: sha, fluximg: fluximgInfo(m) } as Asset);
  const oldA = asset("old", "s1", stackM), nextA = asset("new", "s2", shrunk);
  const el = (id: string, extra: Partial<FluximgElement> = {}): FluximgElement => ({ type: "fluximg", id, assetId: "old", x: 0, y: 0, width: 128, height: 96, rotation: 0, source: { bundlePath: "plots/s.fluximg", sha256: "s1" }, ...extra } as FluximgElement);
  const model = { figures: [{ id: "f", elements: [el("a", { view: { index: { z: 6 } } }), el("b", { source: { bundlePath: "plots/s.fluximg", sha256: "s1", frozen: true } }), el("c", { source: { bundlePath: "plots/other.fluximg" } }), el("d", { crop: { x: 0, y: 0, width: 32, height: 24 } })] }], assets: [oldA] } as unknown as Project;
  const plan = core.planFluximgSourceUpdate(model, "plots/s.fluximg", nextA, shrunk);
  h.eq(plan.moves.map((m) => m.elementId), ["a", "d"], "followers of the bundle move; frozen ones and other bundles' stay");
  h.eq(plan.oldAssetIds, ["old"], "the plan names the assets left behind");
  h.ok(plan.moves[0].height !== undefined && Math.abs(plan.moves[0].height - 128 * 30 / 50) < 1e-9, "the box keeps its width and takes the new aspect when the aspect changed");
  h.ok(plan.moves[1].height === undefined, "…and keeps its height when it did not (the crop kept the aspect)");
  const moved = core.applyFluximgSourceUpdate(model, plan, nextA);
  const els = model.figures[0].elements as FluximgElement[];
  h.ok(moved === 2 && els[0].assetId === "new" && els[0].source?.sha256 === "s2" && els[0].view?.index?.z === 3 && els[1].assetId === "old", "apply repoints the followers, records the new content id, carries the clamped view");
  h.ok(model.assets.some((a) => a.id === "new") && model.assets.some((a) => a.id === "old"), "the new asset is registered and the old one kept (Undo, then GC as usual)");
  h.eq(core.applyFluximgSourceUpdate(model, plan, nextA), 0, "a plan applied twice moves nothing the second time");
  h.eq(core.planFluximgSourceUpdate(model, "plots/s.fluximg", { ...nextA, id: "again" }, shrunk).moves.length, 0, "an element already showing that content (same content id) does not move");

  h.section("D. the watcher-driven hot swap (memory bridge)");
  const su = await import("../src/lib/fluximg/sourceUpdate");
  // Fresh model: two followers of plots/live.fluximg (one with a view), one frozen.
  await seed("plots/live.fluximg", "stack_u16");
  store.project.set({ ...blank, figures: [{ ...figure, elements: [] }], assets: [] } as Project);
  await io.importPlotsFromPaths([`${mroot}/plots/live.fluximg`, `${mroot}/plots/live.fluximg`, `${mroot}/plots/live.fluximg`]);
  const live0 = fluximgEls();
  store.commit((p) => {
    const es = p.figures[0].elements as FluximgElement[];
    es[0].view = { index: { z: 6 } };
    es[0].crop = { x: 4, y: 4, width: 40, height: 30 };
    es[2].source = { ...es[2].source!, frozen: true };
  });
  const startAsset = live0[0].assetId, startSha = live0[0].source?.sha256;
  h.eq(await su.fluximgSourceState(fluximgEls()[0]), "current", "a freshly placed image is current with its source");
  h.eq(await su.fluximgSourceState({ assetId: "x", source: { bundlePath: "/far/away.fluximg", external: true } }), "external", "an external source is external");
  h.eq(await su.fluximgSourceState({ assetId: "x" }), "external", "no source at all counts as external (nothing to follow)");
  h.eq(await su.fluximgSourceState({ assetId: startAsset, source: { bundlePath: "plots/nothere.fluximg" } }), "missing", "a source that is gone is missing");
  su.ensureFluximgSourceWatch();
  // The writer rewrites the bundle: a different image (fewer z planes). _seedFluximg emits the plots batch.
  const writes: string[] = [];
  const shrunkStack = await filesOf(fx("stack_u16"));
  const sm = JSON.parse(new TextDecoder().decode(shrunkStack["fluximg.json"])) as FluximgManifest;
  sm.name = "live rewritten"; // a different manifest = different content
  shrunkStack["fluximg.json"] = enc.encode(JSON.stringify(sm));
  // First an unfinished write (no manifest yet): nothing must happen.
  const { ["fluximg.json"]: manifestBytes, ...withoutManifest } = shrunkStack;
  mem._seedFluximg(mroot, "plots/live.fluximg", withoutManifest);
  writes.push("partial");
  h.eq(su.fluximgSourceActivity().waiting, ["plots/live.fluximg"], "a change inside a followed bundle waits for a quiet spell");
  await new Promise((r) => setTimeout(r, su.QUIET_MS + 150)); // let the quiet window pass with no manifest present
  h.ok(fluximgEls().every((e) => e.assetId === startAsset), "an unfinished write (no fluximg.json) moves nothing");
  h.eq(await su.fluximgSourceState(fluximgEls()[0]), "missing", "…and the source reads as missing meanwhile");
  mem._seedFluximg(mroot, "plots/live.fluximg", { ...withoutManifest, "fluximg.json": manifestBytes });
  h.ok(await until(() => fluximgEls()[0].assetId !== startAsset), "once the manifest lands and the bundle is quiet, the followers move to the new content");
  const after = fluximgEls();
  const newAsset = get(store.project).assets.find((a) => a.id === after[0].assetId)!;
  h.ok(after[1].assetId === after[0].assetId && after[2].assetId === startAsset, "both followers moved; the frozen one stayed");
  h.ok(after[0].source?.sha256 === newAsset.sha256 && newAsset.sha256 !== get(store.project).assets.find((a) => a.id === startAsset)!.sha256, "the element records the new content id");
  h.eq(after[0].view, { index: { z: 6 } }, "the same grid keeps the view");
  h.eq(after[0].crop, { x: 4, y: 4, width: 40, height: 30 }, "…and the crop");
  h.eq(await su.fluximgSourceState(after[0]), "current", "after the swap the source is current");
  h.eq(await su.fluximgSourceState(after[2]), "changed", "the frozen element's source reads as changed");
  store.undo();
  h.ok(fluximgEls().slice(0, 2).every((e) => e.assetId === startAsset) && fluximgEls()[0].source?.sha256 === startSha, "ONE undo restores every moved element to the old content");
  store.redo();
  h.ok(fluximgEls()[0].assetId === newAsset.id, "redo moves them again");
  // A change of shape: a 2-D gray image replaces the stack; the toast names what had to change.
  toasts.set([]);
  mem._seedFluximg(mroot, "plots/live.fluximg", await filesOf(fx("gray2d_u8")));
  h.ok(await until(() => fluximgEls()[0].assetId !== newAsset.id), "a rewrite with another shape is brought in too");
  h.ok(!fluximgEls()[0].view?.index && fluximgEls()[0].crop?.width === 40, "the z position is dropped (no z any more) and the crop still fits");
  const shapeToast = get(toasts).find((x) => /changed shape/.test(x.msg));
  h.ok(!!shapeToast && /z position/.test(shapeToast.msg), `…and a toast says so: ${shapeToast?.msg}`);
  // The explicit action brings in a frozen element when asked.
  const frozenId = fluximgEls()[2].id;
  const n = await su.updateFluximgFromSource(frozenId);
  h.ok(n >= 1 && fluximgEls()[2].assetId === fluximgEls()[0].assetId, "updateFluximgFromSource moves even a frozen element when asked explicitly");
  h.eq(await su.updateFluximgFromSource(frozenId), 0, "…and does nothing when it is already current");
  h.eq(get(store.project).assets.filter((a) => a.kind === "fluximg" && a.sha256 === fluximgEls()[0].source?.sha256).length, 1, "one asset per content id across the swaps");
  su.stopFluximgSourceWatch();

  // ------------------------------------------------------------------------------------------------------------
  h.section("C2. the native drop channel (electron/ipc/fluximg.cjs)");
  {
    const { EventEmitter } = await import("node:events");
    const { createFluximgCore } = require("../electron/ipc/fluximg.cjs");
    const { createFileCore } = require("../electron/ipc/files.cjs");
    const { CHANNELS } = require("../electron/ipc/contract.cjs");
    const droot = path.join(scratch, "dproj"), outside = path.join(scratch, "outside", "dropped.fluximg");
    await fs.mkdir(path.join(droot, "plots"), { recursive: true });
    await fs.writeFile(path.join(droot, "project.json"), "{}");
    await fs.cp(fx("gray2d_u8"), outside, { recursive: true });
    const handlers = new Map<string, (...args: unknown[]) => Promise<{ sha256: string; path: string }>>();
    const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false });
    let currentRoot = droot;
    const fileCore = createFileCore({ app: { getPath: (kind: string) => path.join(scratch, `app-${kind}`) }, dialog: {}, shell: {}, roots: () => [droot], windowFor: () => null });
    createFluximgCore({ rootFor: () => currentRoot, generationFor: () => 1, fsReadGuard: fileCore.fsReadGuard }).registerHandlers({ handle: (n: string, fn: (...args: unknown[]) => Promise<{ sha256: string; path: string }>) => handlers.set(n, fn) });
    h.ok(CHANNELS.some((c: { channel: string; kind: string }) => c.channel === "fluximg:importDropped" && c.kind === "invoke"), "fluximg:importDropped is a declared invoke channel");
    const preload = await fs.readFile(path.join(repo, "electron", "preload.cjs"), "utf8");
    h.ok(/importDroppedFluximg:[\s\S]{0,600}webUtils\.getPathForFile\(file\)[\s\S]{0,400}"fluximg:importDropped"/.test(preload), "the preload takes a dropped bundle's path from the File itself (webUtils), never from the page");
    await rejects(handlers.get("fluximg:import")!({ sender }, { root: droot, sourcePath: outside, assetId: "fx_out" }), /refused|outside/, "a renderer-named path outside the project still needs the window's read capability");
    const dropped = await handlers.get("fluximg:importDropped")!({ sender }, { root: droot, sourcePath: outside, assetId: "fx_drop" });
    h.ok(dropped.path === "assets/fx_drop.fluximg" && dropped.sha256.length === 64, "a dropped bundle folder imports through its own channel (the drop is the capability)");
    currentRoot = path.join(scratch, "other");
    await rejects(handlers.get("fluximg:importDropped")!({ sender }, { root: droot, sourcePath: outside, assetId: "fx_drop2" }), /project changed/, "…bound to the window's open project like every fluximg call");
  }

  // ------------------------------------------------------------------------------------------------------------
  h.section("E. timing: the native import of the largest fixture");
  const filesSide = require("../electron/fluximgFiles.cjs");
  const nproj = path.join(scratch, "nproj");
  await fs.mkdir(path.join(nproj, "plots"), { recursive: true });
  await fs.writeFile(path.join(nproj, "project.json"), "{}");
  let largest = { name: "", bytes: 0 };
  for (const name of ["big_tiled_u16", "mid_tiled_u16", "mean_f64_layers", "stack_u16"]) {
    const b = Object.values(await filesOf(fx(name))).reduce((s, x) => s + x.byteLength, 0);
    if (b > largest.bytes) largest = { name, bytes: b };
  }
  await fs.cp(fx(largest.name), path.join(nproj, "plots", `${largest.name}.fluximg`), { recursive: true });
  const ti = performance.now();
  const r = await filesSide.importBundle({ root: nproj, sourcePath: `plots/${largest.name}.fluximg`, assetId: "timing" });
  const tms = performance.now() - ti;
  h.ok(r.files > 0, `native import of ${largest.name} (${r.files} files, ${(r.bytes / 1024).toFixed(0)} KiB) by ${r.method}: ${tms.toFixed(1)} ms incl. hashing`);
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(async () => { await fs.rm(scratch, { recursive: true, force: true }); });
