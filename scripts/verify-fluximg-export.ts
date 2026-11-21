// fluximg in every output that is not the editor's canvas: flux-core's SVG / PNG renders, the agent verbs, and the
// pure composer the in-app export and Paper share (src/lib/fluximg/exportStatic.ts).
//
// What is pinned:
//   A. place-image: a real import into fig/assets, the element, the resolved view; the same content placed again is
//      reused, never copied twice; a deck, a non-bundle and a view or crop that does not fit are refused before
//      anything is copied; the source CLI maps its flags onto the same verb.
//   B. set-image-view and image-info round-trip, refuse bad input with messages naming every problem, and answer
//      with the resolved view and positions in words.
//   C. The embedded still of each element decodes to EXACTLY `still.renderStill`'s pixels at the stated size (the
//      size an export asks for: stillSize(crop, box, dpi/96, magnify)) for a plane, a projection, contrast and a
//      colour map, a crop, a flip, transparency, an unknown colour map (falls back to gray), and a tiled image read
//      at an overview level.
//   D. Vector layers are vectors with the crop's transform; ids are the editor's; rotation, flip and opacity wrap the
//      element like every other kind.
//   E. resvg draws a scale bar and a label outline exactly where the geometry says.
//   F. A missing bundle degrades to the stand-in with a warning; the figure still renders.
//   G. Timings (printed, not pinned): a 2048 x 2048 three-channel uint16 figure to PNG at 300 dpi; big_tiled_u16.
//
// Pure tier, hermetic: scratch HOME/XDG before flux-core loads, synthetic bundles from scripts/lib/fluximgFixtures.ts.
// Run: node --import tsx scripts/verify-fluximg-export.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { Resvg } from "@resvg/resvg-js";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";

const h = harness("verify-fluximg-export");
const repo = path.resolve(import.meta.dirname, "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fluximg-export-"));
Object.assign(process.env, isolatedEnv(path.join(scratch, "machine")), { FLUX_NO_MIGRATE: "1" });

const { VERBS } = await import("../flux-core/registry");
const core = await import("../flux-core/index");
const { loadFigModel, mutateFigModel } = await import("../flux-core/model");
const { decodePng, dataUrlPngBytes, encodePng } = await import("../flux-core/fluximgPng");
const { nodeBundleReader, nodeZstd } = await import("../flux-core/fluximgIo");
const { resolveFluximgLut } = await import("../flux-core/fluximgRender");
const { fixtures, writeFixture } = await import("./lib/fluximgFixtures");
const { openFluximg } = await import("../src/lib/fluximg/reader");
const { renderStill, clampCrop, stillSize } = await import("../src/lib/fluximg/still");
const { resolveView } = await import("../src/lib/fluximg/viewOps");
const { cropTransform } = await import("../src/lib/fluximg/layers");
const { scalebarGeometry } = await import("../src/lib/fluximg/furniture");
const { fluximgIdPrefix } = await import("../src/lib/fluximg/static");
const { fluximgSurfaceScale, fluximgElementMarkup, prepareFluximgContext, FLUXIMG_EXPORT_MAX_PIXELS } = await import("../src/lib/fluximg/exportStatic");
const { ensureColormapLuts } = await import("../src/lib/color/colormapLuts");
const { arraySource, writeFluximg } = await import("../src/lib/fluximg/writer");
const { nodeBundleWriter } = await import("../flux-core/fluximgIo");
type FluximgElement = import("../src/lib/fluximg/element").FluximgElement;
type Asset = import("../src/lib/types").Asset;

const root = path.join(scratch, "project"), outside = path.join(scratch, "outside");
await core.scaffold(root, { title: "fluximg export" });
const { figureId } = await core.createFigure(root, { id: "fig-a", name: "Images", width: 900, height: 700 });
const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
for (const name of ["stack_u16", "mean_f64_layers", "big_tiled_u16", "gray2d_u8", "masked_i16"]) await writeFixture(path.join(root, "plots"), fx[name]);
await writeFixture(outside, fx.rgb_u8);

const verb = (name: string) => VERBS.find((v) => v.name === name)!;
/** A verb as MCP runs it: arguments through its zod schema, then its handler. */
async function call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const v = verb(name);
  return (await v.handler({ root, transport: "mcp" }, z.object(v.params).parse(args) as Record<string, unknown>)) as T;
}
async function refuses(name: string, args: Record<string, unknown>, pattern: RegExp, label: string): Promise<string> {
  try { await call(name, args); h.fail(`${label}: accepted`); return ""; }
  catch (e) { const m = e instanceof Error ? e.message : String(e); h.ok(pattern.test(m), `${label}: "${m.split("\n").slice(0, 3).join(" / ")}"`); return m; }
}
const assetDirs = async (): Promise<string[]> => (await fs.readdir(path.join(root, "fig/assets")).catch(() => [])).filter((n) => n.endsWith(".fluximg")).sort();
const cli = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(repo, "flux-cli.ts"), ...args, "--root", root], { cwd: repo, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", (b) => (out += b)); child.stderr.on("data", (b) => (err += b));
  child.once("error", reject); child.once("close", (code) => resolve({ code: code ?? -1, out, err }));
});
async function element(id: string): Promise<{ el: FluximgElement; asset: Asset }> {
  const { project } = await loadFigModel(root);
  const el = project.figures.flatMap((f) => f.elements).find((e) => e.id === id) as FluximgElement;
  return { el, asset: project.assets.find((a) => a.id === el.assetId)! };
}
/** Hand-written view (bypassing the verb's checks): what an older build or a hand edit could leave on disk. */
const rawView = (id: string, view: Record<string, unknown>) => mutateFigModel(root, "test_raw_view", ({ project }) => {
  const el = project.figures.flatMap((f) => f.elements).find((e) => e.id === id) as FluximgElement; el.view = view as never;
});

try {
  // ------------------------------------------------------------------------------------------------------------------
  h.section("A. place-image");
  const before = await assetDirs();
  const a = await call("place_image", { figureId, bundlePath: path.join(root, "plots/stack_u16.fluximg"), x: 20, y: 20, width: 256, view: { index: { z: 2 }, furniture: { scalebar: {}, stamp: {} } } });
  h.ok(a.elementId && a.assetId && !a.reused && (await assetDirs()).length === before.length + 1, `imports the bundle into fig/assets once (${a.assetId}, ${a.copy})`);
  h.eq([a.box.width, a.box.height, a.crop.width, a.crop.height], [256, 192, 64, 48], "the box follows the image's aspect, the crop is the whole image");
  h.eq(a.resolved.index, { z: 2 }, "answers with the RESOLVED view (index z 2)");
  h.eq(a.position, ["z 3/7 · −59.5 µm"], "and the position in words");
  h.eq(a.exportPixels, { width: 800, height: 600, dpi: 300 }, "and the still size a 300 dpi export draws");
  const { el: placed, asset: stackAsset } = await element(a.elementId);
  h.ok(stackAsset.kind === "fluximg" && stackAsset.path === `assets/${a.assetId}.fluximg` && /^[0-9a-f]{64}$/.test(stackAsset.sha256 ?? "") && stackAsset.fluximg?.dims.join() === "c,z,y,x", "the asset record: kind, directory, content id and manifest digest");
  h.ok(placed.source?.bundlePath === "plots/stack_u16.fluximg" && placed.source.sha256 === stackAsset.sha256 && !placed.source.external, "the element records its project-relative source and content id");
  await fs.access(path.join(root, "fig/assets", `${a.assetId}.fluximg`, "fluximg.json"));

  const dirsBefore = await assetDirs();
  const again = await call("place_image", { figureId, bundlePath: "plots/stack_u16.fluximg", x: 20, y: 300, width: 128, crop: { x: 16, y: 8, width: 32, height: 24 } });
  h.ok(again.reused && again.assetId === a.assetId && (await assetDirs()).join() === dirsBefore.join(), "the same content placed again reuses its asset: nothing is copied twice");
  const copy = path.join(scratch, "copy-of-stack.fluximg");
  await fs.cp(path.join(root, "plots/stack_u16.fluximg"), copy, { recursive: true });
  await fs.writeFile(path.join(copy, ".DS_Store"), "junk");
  const third = await call("place_image", { figureId, bundlePath: copy, x: 600, y: 600, width: 40 });
  h.ok(third.reused && third.assetId === a.assetId && (await assetDirs()).join() === dirsBefore.join(), "a copy elsewhere (plus OS litter) has the same content id and is reused too");
  const ext = await call("place_image", { figureId, bundlePath: path.join(outside, "rgb_u8.fluximg"), x: 700, y: 20, width: 112 });
  const { el: extEl } = await element(ext.elementId);
  h.ok(!ext.reused && extEl.source?.external === true && path.isAbsolute(extEl.source.bundlePath), "a bundle outside the project is copied in and its source marked external");

  await core.createDeck(root, { id: "talk" });
  const deck = await core.addSlide(root, "talk");
  // fluximg stage 2 supersedes the stage-1 slide refusal pinned here: a slide takes the image (the deck refers to the bundle by id)
  const onSlide = await call("place_image", { figureId: deck.slideId, bundlePath: "plots/gray2d_u8.fluximg" });
  h.ok(onSlide.deckId === "talk" && onSlide.slideId === deck.slideId, `a slide (by its id) takes the image (${onSlide.elementId})`);
  await refuses("place_image", { figureId: "talk", bundlePath: "plots/gray2d_u8.fluximg" }, /is a deck: name one of its slides/, "a deck id is refused: a slide must be named");
  await refuses("place_image", { figureId: "nope", bundlePath: "plots/gray2d_u8.fluximg" }, /Figure or slide not found: nope/, "an unknown figure is refused");
  await refuses("place_image", { figureId, bundlePath: "plots/missing.fluximg" }, /Image bundle not found/, "a missing bundle is refused");
  await fs.mkdir(path.join(root, "plots/empty.fluximg"), { recursive: true });
  await refuses("place_image", { figureId, bundlePath: "plots/empty.fluximg" }, /is not a fluximg bundle/, "a folder without fluximg.json is refused");
  const dirsNow = await assetDirs();
  await refuses("place_image", { figureId, bundlePath: "plots/gray2d_u8.fluximg", view: { index: { z: 1 } } }, /no "z" dimension/, "a view naming a dimension the image lacks is refused");
  await refuses("place_image", { figureId, bundlePath: "plots/gray2d_u8.fluximg", crop: { x: 0, y: 0, width: 999, height: 10 } }, /must lie inside the image \(64 x 48/, "a crop outside the image is refused");
  h.eq(await assetDirs(), dirsNow, "a refused placement leaves no copy behind");

  const viaCli = await cli(["place-image", figureId, path.join(root, "plots/mean_f64_layers.fluximg"), "--x", "300", "--y", "20", "--width", "360",
    "--view", JSON.stringify({ layers: { prox_lines: { visible: true }, discs: { visible: true, color: "#00e0ff" } }, furniture: { names: {} } })]);
  h.ok(viaCli.code === 0, `the CLI place-image runs (exit ${viaCli.code}${viaCli.code ? `: ${viaCli.err.slice(0, 200)}` : ""})`);
  const layered = JSON.parse(viaCli.out || "{}");
  h.ok(/placed image/.test(viaCli.err) && layered.resolved?.layers?.find((l: { id: string }) => l.id === "discs")?.color === "#00e0ff", "its flags reach the same verb: --x/--y/--width and --view JSON");

  // ------------------------------------------------------------------------------------------------------------------
  h.section("B. set-image-view and image-info");
  const p1 = await call("set_image_view", { id: again.elementId, view: { projection: { dim: "z", mode: "max", from: 1, to: 5 }, channels: [{ lut: "magma", range: [100, 2000] }, { visible: false }] } });
  h.eq(p1.position, ["max z 2–5 · −60.5 to −57.5 µm"], "a projection, answered in words");
  h.eq(p1.showing, ["structure: magma, 100–2000"], "the channels shown, with their colour map and window");
  h.eq([p1.resolved.channels[0].lut, p1.resolved.channels[0].color, p1.resolved.channels[1].visible], ["magma", null, false], "setting a colour map clears the channel's colour; the other channel is hidden");
  const p2 = await call("set_image_view", { id: again.elementId, view: { channels: [{ range: null }] } });
  const stackManifest = JSON.parse(await fs.readFile(path.join(root, "fig/assets", `${a.assetId}.fluximg`, "fluximg.json"), "utf8"));
  h.eq(p2.resolved.channels[0].range, stackManifest.channels[0].range, "null clears a setting: back to the manifest's default window");
  await call("set_image_view", { id: again.elementId, view: { channels: [{ range: [100, 2000] }] } });
  const bad = await refuses("set_image_view", { id: again.elementId, view: { index: { z: 9 }, projection: { dim: "t", mode: "median", from: 3, to: 2 }, layers: { nope: {} }, wobble: 1 } }, /does not fit image "stack_u16"/, "a bad patch is refused before anything is written");
  h.ok(["index.z: a plane number from 0 to 6", "projection.dim", "projection.mode", "\"to\" is exclusive", "layers.nope: no such layer", "unknown setting \"wobble\""].every((s) => bad.includes(s)), "and the message names every problem");
  await refuses("set_image_view", { id: "fig-a", view: {} }, /Image element not found: fig-a/, "an id that is not an image element is refused");
  await refuses("set_image_view", { id: again.elementId, view: { insetOf: ext.elementId } }, /not another placement of the same image/, "insetOf must name another placement of the same image");
  const inset = await call("set_image_view", { id: again.elementId, view: { insetOf: a.elementId } });
  h.eq(inset.resolved.insetOf, a.elementId, "insetOf another placement of the same image is accepted");
  const cropped = await call("set_image_view", { id: a.elementId, crop: { x: 8, y: 4, width: 48, height: 36 } });
  h.eq([cropped.crop.width, cropped.crop.height], [48, 36], "a crop through set-image-view (ops.setCrop: the content stays pinned)");
  const viaCliReset = await cli(["set-image-view", a.elementId, "--reset-crop"]);
  h.ok(viaCliReset.code === 0 && JSON.parse(viaCliReset.out).crop.width === 64, "the CLI's --reset-crop restores the whole image");
  const scaleMsg = await call("set_image_view", { id: ext.elementId, view: { furniture: { scalebar: {} } } });
  h.ok(scaleMsg.warnings.some((w: string) => /no scale bar is drawn/.test(w)), "a valid setting that cannot show is accepted with a warning (no pixel size: no scale bar)");

  const info = await call("image_info", { target: a.elementId });
  h.ok(info.summary === "2 channels · 7 z · 64 × 48 · uint16" && info.dims.find((d: { name: string }) => d.name === "z").from === "z 1/7 · −61.5 µm", "image-info: the one-line summary and positions in words");
  h.ok(info.channels.length === 2 && typeof info.channels[0].percentiles["99.8"] === "number" && info.channels[0].min <= info.channels[0].max, "channels with ranges, min/max and percentiles");
  h.ok(info.placements.length === 3 && info.element.elementId === a.elementId && info.element.resolved.index.z === 2, "every placement, and the element's resolved view");
  const linfo = await call("image_info", { target: layered.assetId });
  h.ok(linfo.layers.find((l: { id: string }) => l.id === "footprints").objects === 4 && linfo.regions.length === 1 && linfo.encoding.kind === "linear16" && !linfo.element, "by asset id: layers with object counts, regions, the encoding");
  await refuses("image_info", { target: "nothing" }, /No image element or image asset "nothing"/, "an unknown target is refused");

  // ------------------------------------------------------------------------------------------------------------------
  h.section("C. the embedded still is renderStill's pixels at the stated size");
  // Elements for the remaining cases.
  const big = await call("place_image", { figureId, bundlePath: "plots/big_tiled_u16.fluximg", x: 300, y: 300, width: 300 });
  const gray = await call("place_image", { figureId, bundlePath: "plots/gray2d_u8.fluximg", x: 620, y: 300, width: 128, view: { background: "transparent" } });
  const masked = await call("place_image", { figureId, bundlePath: "plots/masked_i16.fluximg", x: 620, y: 420, width: 120, view: { background: "transparent" } });
  await mutateFigModel(root, "test_flip", ({ project }) => {
    const f = project.figures.find((x) => x.id === figureId)!;
    const e = f.elements.find((x) => x.id === again.elementId)!; e.flipX = true; e.rotation = 30; e.opacity = 0.5;
  });
  await rawView(gray.elementId, { background: "transparent", channels: [{ lut: "no-such-map" }] });

  await ensureColormapLuts();
  const readers = new Map<string, Promise<Awaited<ReturnType<typeof openFluximg>>>>();
  const reader = (asset: Asset) => {
    if (!readers.has(asset.id)) readers.set(asset.id, nodeZstd().then((z) => openFluximg(nodeBundleReader(path.join(root, "fig", asset.path)), z)));
    return readers.get(asset.id)!;
  };
  const stillOf = (svg: string, elementId: string): { width: number; height: number; rgba: Uint8Array; box: { w: number; h: number } } | null => {
    const id = `${fluximgIdPrefix(elementId)}still`;
    const m = new RegExp(`<image id="${id}" x="0" y="0" width="([0-9.]+)" height="([0-9.]+)" preserveAspectRatio="none" href="(data:image/png;base64,[^"]+)"/>`).exec(svg);
    if (!m) return null;
    return { ...decodePng(dataUrlPngBytes(m[3])), box: { w: Number(m[1]), h: Number(m[2]) } };
  };
  async function expectedStill(id: string, dpi: number, override?: { view?: unknown }) {
    const { el, asset } = await element(id);
    const r = await reader(asset), crop = clampCrop(r.manifest, el.crop);
    const size = stillSize(crop, { width: el.width, height: el.height }, dpi / 96, { magnify: true, maxPixels: FLUXIMG_EXPORT_MAX_PIXELS });
    const s = await renderStill(r, { view: (override?.view ?? el.view) as never, crop, outWidth: size.width, outHeight: size.height }, { resolveLut: resolveFluximgLut });
    return { size, rgba: s.rgba, level: s.level, el, asset, manifest: r.manifest, crop };
  }
  const same = (a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const warnings: string[] = [];
  const svg = await core.renderFigureSvg(root, figureId, { posterSurface: "svg", warnings });
  h.eq(warnings, [], "the SVG render has no warnings");
  const cases: Array<[string, string]> = [
    [a.elementId, "a plane (z 3) with furniture"],
    [again.elementId, "a max projection, a colour map and window, one channel hidden, a crop, flipped and rotated"],
    [layered.assetId ? layered.elementId : "", "a float image with every kind of layer"],
    [ext.elementId, "an RGB photograph"],
    [big.elementId, "a tiled image"],
    [gray.elementId, "an unknown colour map on a transparent background"],
    [masked.elementId, "no-data pixels on a transparent background (RGBA)"],
  ];
  for (const [id, what] of cases) {
    const got = stillOf(svg, id), want = await expectedStill(id, 300);
    h.ok(!!got && got.width === want.size.width && got.height === want.size.height && Math.abs(got.box.w - want.el.width) < 1e-4 && Math.abs(got.box.h - want.el.height) < 1e-4,
      `${what}: the still is ${want.size.width} x ${want.size.height} (stillSize at 300 dpi) over the ${want.el.width} x ${want.el.height} box`);
    h.ok(!!got && same(got.rgba, want.rgba), `${what}: decodes to exactly renderStill's pixels`);
  }
  const grayRef = await expectedStill(gray.elementId, 300, { view: { background: "transparent", channels: [{ lut: "gray" }] } });
  h.ok(same(stillOf(svg, gray.elementId)!.rgba, grayRef.rgba), "an unknown colour map is drawn exactly as the gray ramp (lut.channelTable's documented fallback)");
  const maskedStill = stillOf(svg, masked.elementId)!;
  h.ok(maskedStill.rgba.some((v, i) => i % 4 === 3 && v === 0) && maskedStill.rgba.some((v, i) => i % 4 === 3 && v === 255), "transparency survives: no-data pixels have alpha 0, data pixels alpha 255");

  const png2 = await core.renderFigureSvg(root, figureId, { posterSurface: { kind: "raster", dpi: 192 } });
  const bigAt2 = stillOf(png2, big.elementId)!, bigWant2 = await expectedStill(big.elementId, 192);
  h.ok(bigAt2.width === 600 && bigAt2.height === Math.round(300 * 2300 / 2600 * 2) && same(bigAt2.rgba, bigWant2.rgba), `a PNG at 192 dpi (render-figure --scale 2) draws 2 still pixels per canvas px: ${bigAt2.width} x ${bigAt2.height}`);
  const small = await core.renderFigureSvg(root, figureId, { posterSurface: { kind: "raster", dpi: 24 } });
  const bigSmall = stillOf(small, big.elementId)!, bigWantSmall = await expectedStill(big.elementId, 24);
  h.ok(bigWantSmall.level > 0 && same(bigSmall.rgba, bigWantSmall.rgba), `at 24 dpi the tiled image is read from an overview level (level ${bigWantSmall.level}) and still matches`);
  h.eq([fluximgSurfaceScale("svg"), fluximgSurfaceScale("pdf"), fluximgSurfaceScale("figure"), fluximgSurfaceScale({ kind: "raster", dpi: 600 })], [3.125, 3.125, 3.125, 6.25], "surfaces: SVG, PDF and Paper renders at 300 dpi, a raster at its own dpi");

  // ------------------------------------------------------------------------------------------------------------------
  h.section("D. vectors, ids and the element wrapper");
  {
    const want = await expectedStill(layered.elementId, 300);
    const t = cropTransform(want.crop, { width: want.el.width, height: want.el.height });
    const prefix = fluximgIdPrefix(layered.elementId);
    const g = new RegExp(`<g id="${prefix}layer\\.footprints" data-layer="footprints" transform="matrix\\(([^)]*)\\)"`).exec(svg);
    h.ok(!!g && g[1].split(" ").map(Number).every((v, i) => Math.abs(v - [t.sx, 0, 0, t.sy, t.tx, t.ty][i]) < 1e-9), `label outlines are a vector group with the crop's transform (${g?.[1]})`);
    h.eq((svg.match(new RegExp(`<path id="${prefix}footprints/`, "g")) ?? []).length, 4, "four outline paths, one per object");
    h.ok(new RegExp(`<polyline id="${prefix}prox_lines/d1"`).test(svg) && new RegExp(`<circle id="${prefix}discs/a"[^>]*`).test(svg), "vector layers stay vectors (polyline, circles)");
    h.ok(new RegExp(`<g id="${prefix}layer\\.discs"[^>]*stroke="#00e0ff"`).test(svg), "a layer colour from the view recolours its strokes");
    h.ok(new RegExp(`<g id="${prefix}names\\.footprints"`).test(svg), "object names are drawn as text");
    h.ok(new RegExp(`<g id="fig-a__el:${again.elementId}"><g transform="rotate\\(30 [0-9.]+ [0-9.]+\\) translate\\([0-9.]+ [0-9.]+\\) scale\\(-1 1\\)[^"]*"><g opacity="0.5"><g data-fluximg="${a.assetId}" transform="translate\\(20 300\\)"><svg x="0" y="0" width="128" height="96"`).test(svg),
      "rotation, flip and opacity wrap the element exactly as for any kind; the static markup sits at its x/y");
    const unflip = new RegExp(`fx-${again.elementId}-`).test(svg);
    h.ok(unflip, "ids are the editor's (fx-<element id>-…), so an exported figure stays addressable");
    const { project: now } = await loadFigModel(root);
    const ns = await prepareFluximgContext(now.figures.filter((f) => f.id === figureId), now.assets, {
      manifest: async (asset) => (await reader(asset)).manifest,
      still: async () => `data:image/png;base64,${encodePng(new Uint8Array([0, 0, 0, 255]), 1, 1).toString("base64")}`,
      text: async (asset, p) => (await reader(asset)).readText(p),
    }, { surface: "figure", namespace: "pap", onIssue: (_e, m) => h.fail(`unexpected issue: ${m}`) });
    const markup = fluximgElementMarkup(want.el, ns);
    h.ok(markup.includes(`id="${fluximgIdPrefix("pap__" + layered.elementId)}still"`) && !markup.includes(`id="${prefix}`), "Paper's display namespace prefixes every id (no collision with the live canvas)");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("E. resvg draws furniture and outlines where the geometry says");
  {
    // A dark window so the white bar stands out; a figure-sized raster at 2 device px per canvas px.
    await call("set_image_view", { id: a.elementId, view: { channels: [{ range: [60000, 65000] }, { range: [60000, 65000] }], furniture: { stamp: null } } });
    const scene = await core.renderFigureSvg(root, figureId, { posterSurface: { kind: "raster", dpi: 192 } });
    const Z = 2, img = new Resvg(scene, { fitTo: { mode: "zoom", value: Z }, font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } }).render();
    const W = img.width, px = img.pixels;
    const at = (x: number, y: number): [number, number, number] => { const i = (Math.round(y) * W + Math.round(x)) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const { el, manifest, crop } = await expectedStill(a.elementId, 192);
    const geo = scalebarGeometry(manifest, resolveView(manifest, el.view), crop, { width: el.width, height: el.height })!;
    const cx = (el.x + geo.x + geo.width / 2) * Z, cy = (el.y + geo.y + geo.height / 2) * Z;
    const mid = at(cx, cy), above = at(cx, (el.y + geo.y) * Z - 3), leftOf = at((el.x + geo.x) * Z - 3, cy);
    h.ok(mid.every((v) => v > 240) && above.every((v) => v < 60) && leftOf.every((v) => v < 60), `the scale bar (${geo.text}, ${geo.width.toFixed(1)} px) is white at its centre and dark just outside it: ${mid} / ${above} / ${leftOf}`);
    const right = at((el.x + geo.x + geo.width) * Z - 2, cy), past = at((el.x + geo.x + geo.width) * Z + 3, cy);
    h.ok(right.every((v) => v > 200) && past.every((v) => v < 60), "its right end lies where the geometry puts it");

    // Footprint s1 covers image pixels x 14–18, y 12–15 of the 90 x 60 image: its left edge at x = 14.
    const L = await expectedStill(layered.elementId, 192);
    const k = L.el.width / L.crop.width, ex = (L.el.x + 14 * k) * Z, ey = (L.el.y + 14 * k) * Z;
    let best = 0;
    for (let dx = -2; dx <= 2; dx++) { const [r, g, b] = at(ex + dx, ey); best = Math.max(best, r > 180 && g > 140 && b < 90 ? r + g : 0); }
    h.ok(best > 0, "the yellow label outline is drawn on the object's left edge");
    const inside = at(ex + 2 * k * Z, ey);
    h.ok(!(inside[0] > 180 && inside[1] > 140 && inside[2] < 90 && inside[0] - inside[2] > 150), `and not across its interior (${inside})`);
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("F. a missing bundle degrades to the stand-in, reported");
  {
    const dir = path.join(root, "fig/assets", `${ext.assetId}.fluximg`), aside = `${dir}.aside`;
    await fs.rename(dir, aside);
    const warns: string[] = [];
    const s = await core.renderFigureSvg(root, figureId, { posterSurface: "svg", warnings: warns });
    h.ok(new RegExp(`<g data-fluximg-placeholder="${ext.assetId}">`).test(s) && !stillOf(s, ext.elementId), "the element draws the stand-in");
    h.ok(warns.some((w) => w.includes(ext.elementId) && /bundle fig\/assets\/.*\.fluximg is missing/.test(w)), `and the render says why: "${warns[0]}"`);
    h.ok(!!stillOf(s, a.elementId), "the figure's other images still render");
    const pngWarns: string[] = [];
    const png = await core.renderFigurePng(root, figureId, 1, { warnings: pngWarns });
    h.ok(png.subarray(1, 4).toString() === "PNG" && pngWarns.length > 0, "the PNG render does not fail either");
    const gone = await call("image_info", { target: ext.elementId });
    h.ok(/cannot be read/.test(gone.issue) && gone.digest?.dims, "image-info reports the problem with what the project still knows");
    await fs.rename(aside, dir);
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("F2. pictures of figures (the raster engine behind the canvas's cached figure pictures) draw images too");
  {
    const { project } = await (await import("../flux-core/model")).loadFigModel(root);
    const figure = project.figures.find((f: { id: string }) => f.id === figureId);
    const index = { assets: project.assets };
    if (!figure?.elements) h.ok(false, "the gate could not read the figure model from fig/ (layout changed?)");
    else {
      const engine = await import("../electron/figureRasterEngine.mjs");
      const composed: string = await engine.buildFigureSvg({ rid: "fluximg-route-c", root, figure, assets: index.assets ?? [], scale: 1, width: 200, height: 200 });
      h.ok(!!stillOf(composed, a.elementId), "the composed picture carries the image's still (not the stand-in)");
      h.ok(!composed.includes("data-fluximg-placeholder"), "no stand-in in a figure whose bundles are all present");
      const again: string = await engine.buildFigureSvg({ rid: "fluximg-route-c-2", root, figure, assets: index.assets ?? [], scale: 2, width: 400, height: 400 });
      h.ok(again === composed, "the composition is reused across raster scales (its stills do not depend on the scale)");
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("G. timings (printed, not pinned)");
  {
    const N = 2048, data = new Uint16Array(3 * N * N);
    for (let c = 0; c < 3; c++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) data[(c * N + y) * N + x] = 300 + ((x * (c + 1) + y * 3) % 4000) + (((x * 7919) ^ (y * 104729)) & 31);
    const dir = path.join(root, "plots/big3_u16.fluximg");
    await writeFluximg(nodeBundleWriter(dir), await nodeZstd(), { name: "big3_u16", source: arraySource(data, ["c", "y", "x"], [3, N, N], "uint16"), channels: [{ color: "#ff0000" }, { color: "#00ff00" }, { color: "#0000ff" }] });
    const { figureId: f2 } = await core.createFigure(root, { id: "fig-big", width: 700, height: 700 });
    // 170 mm wide at 300 dpi: a full-width journal figure.
    const t0 = performance.now();
    await call("place_image", { figureId: f2, bundlePath: "plots/big3_u16.fluximg", x: 10, y: 10, width: 640 });
    const tPlace = performance.now() - t0;
    let t = performance.now();
    const png = await core.renderFigurePng(root, f2, 300 / 96);
    const tPng = performance.now() - t;
    t = performance.now();
    const svgBig = await core.renderFigureSvg(root, f2, { posterSurface: { kind: "raster", dpi: 300 } });
    const tSvg = performance.now() - t;
    const st = stillOf(svgBig, (await loadFigModel(root)).project.figures.find((f) => f.id === f2)!.elements[0].id)!;
    console.log(`  2048 x 2048 x 3 uint16 (box 640 px): place ${tPlace.toFixed(0)} ms; figure → PNG at 300 dpi ${tPng.toFixed(0)} ms (${(png.length / 1e6).toFixed(1)} MB); compose only ${tSvg.toFixed(0)} ms, still ${st.width} x ${st.height}`);
    t = performance.now();
    await core.renderFigureSvg(root, figureId, { posterSurface: { kind: "raster", dpi: 300 } });
    console.log(`  fig-a (7 images incl. big_tiled_u16 2600 x 2300) composed at 300 dpi: ${(performance.now() - t).toFixed(0)} ms`);
    const bigReq = await expectedStill(big.elementId, 300);
    t = performance.now();
    const bigStill = await renderStill(await reader(bigReq.asset), { view: null, crop: null, outWidth: bigReq.size.width, outHeight: bigReq.size.height }, { resolveLut: resolveFluximgLut });
    const tStill = performance.now() - t;
    t = performance.now();
    encodePng(bigStill.rgba, bigStill.width, bigStill.height);
    console.log(`  big_tiled_u16 still ${bigStill.width} x ${bigStill.height}: render ${tStill.toFixed(0)} ms, PNG encode ${(performance.now() - t).toFixed(0)} ms`);
    h.ok(st.width === 2000 && st.height === 2000, "the 300 dpi still of a 640 px box is 2000 x 2000 (every output pixel over the image is a still pixel)");
  }
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(() => fs.rm(scratch, { recursive: true, force: true }));
