// fluximg in-app export ≡ flux-core: the same figure through both engines gives the same markup (same ids, same
// structure) and the same still pixels (PNG bytes differ: the window encodes with the browser's canvas, Node with
// node:zlib, so each still is DECODED and compared as pixels).
//
// In the app: synthetic bundles are seeded into the in-memory demo project, placed through ops.addFluximg on a new
// figure, and exported by the REAL Inspector export function (io.exportFigureSvg → captureFigureExport, which asks
// the window's decode workers for each still), read back from the demo bridge's file. In Node: the same bundles
// (the reference writer is deterministic, so they are byte-identical) in a scratch project, and the same figure JSON
// through flux-core's renderFigureSvgFromModel with fluximgRender's context. A PNG export is checked too: the
// browser draws the SVG into a canvas, and over an unrotated image every output pixel is a still pixel.
//
// ui tier: needs a dev server (FLUX_URL; `?fixture=demo`). Hermetic otherwise (scratch HOME/XDG, synthetic data).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";
import { launch, gotoApp, clickMode, realErrors } from "./lib/driver.mjs";

const h = harness("verify-fluximg-export-gui");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fluximg-export-gui-"));
Object.assign(process.env, isolatedEnv(path.join(scratch, "machine")), { FLUX_NO_MIGRATE: "1" });
const { fixtures, writeFixture } = await import("./lib/fluximgFixtures");
const core = await import("../flux-core/index");
const { renderFigureSvgFromModel } = await import("../flux-core/render");
const { resolveFluximgContext } = await import("../flux-core/fluximgRender");
const { decodePng, dataUrlPngBytes } = await import("../flux-core/fluximgPng");
type Figure = import("../src/lib/types").Figure;
type Asset = import("../src/lib/types").Asset;

const NAMES = ["stack_u16", "mean_f64_layers", "masked_i16"];
const bundles = path.join(scratch, "bundles");
const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
for (const n of NAMES) await writeFixture(bundles, fx[n]);
async function filesOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else out[path.relative(dir, p).split(path.sep).join("/")] = (await fs.readFile(p)).toString("base64");
    }
  };
  await walk(dir);
  return out;
}

/** Every still replaced by a digest of its decoded pixels: what must agree across engines. */
function normalized(svg: string): { text: string; stills: number } {
  let stills = 0;
  const text = svg.replace(/href="(data:image\/png;base64,[^"]+)"/g, (_m, url: string) => {
    const png = decodePng(dataUrlPngBytes(url)); stills++;
    // Raw straight-alpha bytes, alpha-0 pixels included: the reference renderer writes no colour under no data, so
    // the browser canvas's premultiplied round trip loses nothing (measured: identical, not merely close).
    return `href="pixels:${png.width}x${png.height}:${createHash("sha256").update(png.rgba).digest("hex").slice(0, 16)}"`;
  });
  return { text, stills };
}

const { browser, page } = await launch({ width: 1400, height: 900 });
try {
  await gotoApp(page, { url: `${process.env.FLUX_URL ?? "http://127.0.0.1:1420/"}?fixture=demo`, settle: 1200 });
  await clickMode(page, "Figure").catch(() => {});
  const seeded: Record<string, Record<string, string>> = {};
  for (const n of NAMES) seeded[n] = await filesOf(path.join(bundles, `${n}.fluximg`));

  const placed = await page.evaluate(async (seeded: Record<string, Record<string, string>>) => {
    const w = window as unknown as Record<string, any>;
    const F = w.__flux, root = F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir);
    const place = await import("/src/lib/fluximg/place.ts" as string);
    const ops = await import("/src/lib/ops.ts" as string);
    const assets: Record<string, unknown> = {};
    for (const [name, files] of Object.entries(seeded)) {
      w.__fluxSeedFluximg(`plots/${name}.fluximg`, files);
      const assetId = place.fluximgAssetId(name, "gate0000");
      const result = await w.fig.importFluximg({ root, sourcePath: `plots/${name}.fluximg`, assetId });
      assets[name] = place.fluximgAsset(assetId, result, `plots/${name}.fluximg`);
    }
    let figureId = "", ids: string[] = [];
    F.fig.commit((p: any) => {
      const canvasId = p.figures[0].canvasId;
      const fig = ops.createFigure(p, { canvasId, name: "Images export", width: 760, height: 420 });
      figureId = fig.id;
      ids = [
        ops.addFluximg(p, { figureId, asset: assets.stack_u16, x: 10, y: 10, width: 256, view: { index: { z: 4 }, channels: [{ lut: "magma", range: [100, 2500] }], furniture: { scalebar: {}, stamp: {}, channelLabels: {} } } }),
        ops.addFluximg(p, { figureId, asset: assets.mean_f64_layers, x: 280, y: 10, width: 300, view: { layers: { prox_lines: { visible: true }, discs: { visible: true }, footprints: { styleBy: { color: { column: "dendrite" }, opacity: { column: "pixels" } } } }, furniture: { names: {}, key: {} } } }),
        ops.addFluximg(p, { figureId, asset: assets.stack_u16, x: 10, y: 230, width: 160, crop: { x: 8, y: 8, width: 40, height: 30 }, view: { projection: { dim: "z", mode: "max", from: 0, to: 7 } } }),
        ops.addFluximg(p, { figureId, asset: assets.masked_i16, x: 600, y: 10, width: 150, view: { background: "transparent" } }),
      ];
      const f = p.figures.find((x: any) => x.id === figureId);
      const third = f.elements.find((e: any) => e.id === ids[2]); third.flipY = true; third.rotation = 15; third.opacity = 0.8;
    });
    return { figureId, ids };
  }, seeded);
  h.ok(placed.figureId && placed.ids.length === 4, `four images placed in the app on figure ${placed.figureId}`);

  // The real export: Inspector's SVG button calls io.exportFigureSvg; the demo bridge's save dialog answers /demo/<name>.svg.
  const exported = await page.evaluate(async (figureId: string) => {
    const w = window as unknown as Record<string, any>;
    const F = w.__flux;
    const io = await import("/src/lib/io.ts" as string);
    const fig = F.get(F.fig.project).figures.find((f: any) => f.id === figureId);
    const t0 = performance.now();
    await io.exportFigureSvg(fig);
    const ms = performance.now() - t0;
    const svg = await w.fig.readText(`/demo/${fig.name}.svg`);
    const png = await (async () => { await io.exportFigurePng(fig, 2); return Array.from(new Uint8Array(await w.fig.readFile(`/demo/${fig.name}.png`))); })();
    return { svg, ms, png, figure: JSON.parse(JSON.stringify(fig)), assets: JSON.parse(JSON.stringify(F.get(F.fig.project).assets.filter((a: any) => a.kind === "fluximg"))) };
  }, placed.figureId) as { svg: string; ms: number; png: number[]; figure: Figure; assets: Asset[] };
  h.ok(typeof exported.svg === "string" && exported.svg.startsWith("<svg"), `the in-app SVG export wrote ${exported.svg.length.toLocaleString("en-US")} bytes (${exported.ms.toFixed(0)} ms)`);
  h.ok(!/data-fluximg-placeholder/.test(exported.svg), "no element fell back to the stand-in in the app");
  h.ok(/data-key="s1"[^>]*stroke="#4385be"[^>]*opacity="0.6222"/.test(exported.svg) && /data-part="key"/.test(exported.svg), "objects styled by a column (styleBy) and the key reach the in-app export (so the parity below covers them)");

  // Node: the same bundles in a disk project, the same figure JSON.
  const root = path.join(scratch, "project");
  await core.scaffold(root, { title: "parity" });
  for (const a of exported.assets) {
    const name = NAMES.find((n) => a.id.startsWith(`img-${n}-`))!;
    await fs.cp(path.join(bundles, `${name}.fluximg`), path.join(root, "fig", a.path), { recursive: true });
  }
  const warnings: string[] = [];
  const fluximg = await resolveFluximgContext(root, [exported.figure], exported.assets, { surface: "svg", warnings });
  const nodeSvg = await renderFigureSvgFromModel(exported.figure, { assets: exported.assets, readAsset: () => undefined, readManifest: () => undefined, fluximg, warnings });
  h.eq(warnings, [], "flux-core renders the app's figure without warnings");
  const app = normalized(exported.svg), node = normalized(nodeSvg);
  h.ok(app.stills === 4 && node.stills === 4, `four stills on each side (app ${app.stills}, flux-core ${node.stills})`);
  if (app.text !== node.text) {
    let i = 0; while (i < app.text.length && app.text[i] === node.text[i]) i++;
    console.log(`  first difference at ${i}:\n  app : …${app.text.slice(Math.max(0, i - 120), i + 160)}\n  node: …${node.text.slice(Math.max(0, i - 120), i + 160)}`);
  }
  h.ok(app.text === node.text, "the in-app export and flux-core emit the same markup and the same still pixels for the same figure");
  for (const id of placed.ids) h.ok(exported.svg.includes(`id="fx-${id}-still"`), `element ${id}: the editor's ids in the export`);

  // Paper: the figure saved, read back from disk by Paper's own loader, rendered the way fig/renders/ is written
  // (un-namespaced, 300 dpi) and the way the editor shows it (the display render, namespaced).
  const paper = await page.evaluate(async (figureId: string) => {
    const w = window as unknown as Record<string, any>;
    const F = w.__flux, root = F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir);
    await (await import("/src/lib/io.ts" as string)).saveProject();
    const figures = await import("/src/shell/modes/paper/scholar/figures.ts" as string);
    await figures.loadFigures(root);
    return { disk: await figures.renderFigureSvgForDisk(figureId), display: await figures.renderFigureSvg(figureId) };
  }, placed.figureId) as { disk?: string; display?: string };
  h.ok(!!paper.disk && normalized(paper.disk).text === node.text, "Paper's disk render (fig/renders) is the same markup and pixels as flux-core's");
  h.ok(!!paper.display && normalized(paper.display).stills === 4 && placed.ids.every((id) => paper.display!.includes(`id="fx-pap__${id}-still"`)) && !/data-fluximg-placeholder/.test(paper.display),
    "Paper's display render draws every image, its ids in the pap namespace");

  // The PNG export: Chromium rasterizes the SVG; the first image (unrotated, opaque) shows its still 1:1 at 2x.
  const png = decodePng(new Uint8Array(exported.png));
  h.eq([png.width, png.height], [1520, 840], "the in-app PNG export at 2x");
  let worst = 255, total = 0, n = 0;
  // Sample the PNG over the first image, away from its furniture (stamp top-left, channel names top-right, scale bar
  // bottom-right: the bottom-left quarter), against the window's still at the PNG's own 192 dpi.
  const raster = await page.evaluate(async (figureId: string) => {
    const w = window as unknown as Record<string, any>;
    const F = w.__flux, ew = await import("/src/lib/fluximg/exportWindow.ts" as string);
    const fig = F.get(F.fig.project).figures.find((f: any) => f.id === figureId);
    const ctx = await ew.prepareWindowFluximg([fig], F.get(F.fig.project).assets, { kind: "raster", dpi: 192 });
    const el = fig.elements[0], es = await import("/src/lib/fluximg/exportStatic.ts" as string);
    const asset = ctx.assetOf(el.assetId), m = ctx.manifestOf(el.assetId);
    const req = es.fluximgStillRequest(el, asset, m, ctx.scale);
    return { href: ctx.stillOf(req.key), w: req.outWidth, h: req.outHeight };
  }, placed.figureId) as { href: string; w: number; h: number };
  const s2 = decodePng(dataUrlPngBytes(raster.href));
  h.eq([s2.width, s2.height], [512, 384], "the window's 192 dpi still of the first image is 512 x 384");
  for (let y = 200; y < 380; y += 3) for (let x = 4; x < 250; x += 3) {
    const i = ((20 + y) * png.width + (20 + x)) * 4, j = (y * s2.width + x) * 4;
    for (let c = 0; c < 3; c++) { const d = Math.abs(png.rgba[i + c] - s2.rgba[j + c]); worst = Math.min(worst, 255 - d); total += d; n++; }
  }
  h.ok(255 - worst <= 1, `the in-app PNG shows the still's own pixels over the image (largest channel difference ${255 - worst}, mean ${(total / n).toFixed(3)})`);
  h.eq(realErrors(page), [], "a clean console");
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await browser.close();
}
await h.done(() => fs.rm(scratch, { recursive: true, force: true }));
