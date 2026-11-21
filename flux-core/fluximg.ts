/**
 * Figure-side fluximg agent API: place a bundle, edit how it is shown, describe it. The edits go through the same
 * cores as the app (`ops.addFluximg`, `ops.setFluximgView`, `ops.setCrop`, `viewOps`); the copy into `fig/assets`
 * is the app's own import module (`electron/fluximgFiles.cjs`), so a bundle placed by an agent is byte-for-byte the
 * asset the app would have made, with the same content id.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { importBundle, discardBundle } from "../electron/fluximgFiles.cjs";
import { compareCodePoints, fluximgContentIdText, isFluximgJunkName } from "../electron/fluximgRules.js";
import * as ops from "../src/lib/ops";
import type { Asset, CropRect, Figure, Project } from "../src/lib/types";
import type { FluximgElement } from "../src/lib/fluximg/element";
import type { FluximgManifest, FluximgTable } from "../src/lib/fluximg/types";
import { columnSummaries, describeStyleBy } from "../src/lib/fluximg/objectStyle";
import { layerTablePath } from "../src/lib/fluximg/static";
import type { FluximgView, ResolvedView } from "../src/lib/fluximg/view";
import { describeFluximg, fluximgAsset, fluximgAssetId, fluximgDisplayName, fluximgInfo } from "../src/lib/fluximg/place";
import { describePosition, describeProjection, patchView, positionDims, resolveView } from "../src/lib/fluximg/viewOps";
import { checkMergedView, checkViewPatch } from "../src/lib/fluximg/viewCheck";
import { clampCrop } from "../src/lib/fluximg/still";
import { fluximgStillRequest, fluximgSurfaceScale } from "../src/lib/fluximg/exportStatic";
import { FLUXIMG_NOT_IN_SLIDES } from "../src/lib/fluximg/policy";
import { DECK_CANVAS_ID } from "../src/lib/slide/deckProject";
import { colormapLut, ensureColormapLuts } from "../src/lib/color/colormapLuts";
import { loadFigModel, mutateFigModel, requireProject } from "./model";
import { fluximgReader } from "./fluximgRender";
import { listDecks, loadDeck } from "./slides";
import { NotFoundError, ValidationError } from "./errors";

const isInside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

async function knownLut(): Promise<(name: string) => boolean> {
  await ensureColormapLuts();
  return (name) => colormapLut(name) !== null;
}

/**
 * The tables of the layers a view patch styles by a column (only those: a table is read when it is needed), so the
 * check can name a column the table does not have. A table that cannot be read is left out (the columns go unchecked).
 */
async function tablesForPatch(root: string, asset: Asset, manifest: FluximgManifest, view: unknown): Promise<Record<string, FluximgTable | null>> {
  const layers = view && typeof view === "object" ? (view as { layers?: unknown }).layers : null;
  if (!layers || typeof layers !== "object") return {};
  const out: Record<string, FluximgTable | null> = {};
  for (const [id, lv] of Object.entries(layers as Record<string, unknown>)) {
    if (!lv || typeof lv !== "object" || (lv as { styleBy?: unknown }).styleBy == null) continue;
    const path = layerTablePath(manifest.layers.find((l) => l.id === id));
    if (path) out[id] = await (await fluximgReader(root, asset)).readTable(path).catch(() => null);
  }
  return out;
}

/** Refuse a view patch that does not fit this image, naming every problem at once. */
async function checkedPatch(manifest: FluximgManifest, view: unknown, tables: Record<string, FluximgTable | null> = {}): Promise<{ patch: FluximgView; warnings: string[] }> {
  const check = checkViewPatch(manifest, view, { knownLut: await knownLut(), tables });
  if (check.problems.length) throw new ValidationError(`The view does not fit image "${manifest.name}":\n  ${check.problems.join("\n  ")}`);
  return { patch: view as FluximgView, warnings: check.warnings };
}

function checkedCrop(manifest: FluximgManifest, crop: unknown): CropRect {
  const c = crop as Partial<CropRect> | null;
  const s = manifest.pixels.shape, W = s[s.length - 1], H = s[s.length - 2];
  const ok = !!c && [c.x, c.y, c.width, c.height].every((v) => typeof v === "number" && Number.isFinite(v));
  if (!ok || !(c!.width! > 0 && c!.height! > 0)) throw new ValidationError(`crop: {x, y, width, height} in image pixels with width and height above 0, got ${JSON.stringify(crop)}`);
  if (c!.x! < 0 || c!.y! < 0 || c!.x! + c!.width! > W || c!.y! + c!.height! > H) throw new ValidationError(`crop: must lie inside the image (${W} x ${H} pixels), got ${JSON.stringify(crop)}`);
  return { x: c!.x!, y: c!.y!, width: c!.width!, height: c!.height! };
}

/** Every regular file of a bundle (junk names skipped, links refused), sorted the way the content id sorts them. */
async function bundleFiles(dir: string): Promise<Array<{ rel: string; abs: string; size: number }>> {
  const out: Array<{ rel: string; abs: string; size: number }> = [];
  const visit = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await fs.readdir(abs)).sort(compareCodePoints)) {
      if (isFluximgJunkName(name)) continue;
      const a = path.join(abs, name), r = rel ? `${rel}/${name}` : name, st = await fs.lstat(a);
      if (st.isSymbolicLink()) throw new ValidationError(`The bundle holds a link (${r}); a bundle must hold only regular files`);
      if (st.isDirectory()) await visit(a, r);
      else if (st.isFile()) out.push({ rel: r, abs: a, size: st.size });
    }
  };
  await visit(dir, "");
  return out;
}

/** The content id the import would give this bundle (SHA-256 over sorted path / file-hash pairs). */
async function bundleContentId(files: Array<{ rel: string; abs: string }>): Promise<string> {
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const f of files) {
    const hash = createHash("sha256");
    for await (const chunk of (await fs.open(f.abs, "r")).createReadStream()) hash.update(chunk as Buffer);
    entries.push({ path: f.rel, sha256: hash.digest("hex") });
  }
  return createHash("sha256").update(fluximgContentIdText(entries), "utf8").digest("hex");
}

function findImage(project: Project, elementId: string): { figure: Figure; element: FluximgElement } {
  for (const figure of project.figures) for (const element of figure.elements) {
    if (element.id !== elementId) continue;
    if (element.type !== "fluximg") throw new ValidationError(`Element ${elementId} is a ${element.type}, not an image (fluximg)`);
    return { figure, element };
  }
  throw new NotFoundError(`Image element not found: ${elementId}`);
}

function imageAsset(project: Project, assetId: string): Asset {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset || asset.kind !== "fluximg") throw new NotFoundError(`Image asset not found: ${assetId}`);
  return asset;
}

/** Plane, projection and channels in words: what an agent (or a person) sees in this element right now. */
export function describeView(manifest: FluximgManifest, rv: ResolvedView): { position: string[]; channels: string[]; objects: string[] } {
  const position: string[] = [];
  if (rv.projection) position.push(describeProjection(manifest, rv.projection));
  for (const d of positionDims(manifest)) if (!(rv.projection && rv.projection.dim === d)) position.push(describePosition(manifest, d, rv.index[d] ?? 0));
  const shown = rv.composite === "single" ? rv.channels.filter((c) => c.index === rv.solo) : rv.channels.filter((c) => c.visible);
  const channels = shown.map((c) => `${c.name}: ${c.color ?? c.lut}${c.invert ? " inverted" : ""}, ${c.range[0]}–${c.range[1]}${c.norm !== "linear" ? ` (${c.norm}${c.norm === "gamma" ? ` ${c.gamma}` : ""})` : ""}`);
  // "footprints coloured by dendrite, opacity by distance": shown layers styled by their table.
  const objects = rv.layers.filter((l) => l.visible && l.styleBy).map((l) => describeStyleBy(l.name, l.styleBy)).filter(Boolean);
  return { position, channels, objects };
}

function elementSummary(figure: Figure, element: FluximgElement, manifest: FluximgManifest) {
  const rv = resolveView(manifest, element.view), crop = clampCrop(manifest, element.crop);
  const words = describeView(manifest, rv);
  const still = fluximgStillRequest(element, { id: element.assetId, path: "", sha256: undefined }, manifest, fluximgSurfaceScale("figure"), rv);
  return {
    elementId: element.id, figureId: figure.id, name: element.name ?? null,
    box: { x: element.x, y: element.y, width: element.width, height: element.height, rotation: element.rotation ?? 0, flipX: !!element.flipX, flipY: !!element.flipY },
    crop, view: element.view ?? {}, resolved: rv, position: words.position, showing: words.channels, ...(words.objects.length ? { objects: words.objects } : {}),
    exportPixels: { width: still.outWidth, height: still.outHeight, dpi: 300 },
  };
}

// --- place-image ---------------------------------------------------------------------------------------------------

export interface PlaceImageOptions { x?: number; y?: number; width?: number; view?: unknown; crop?: unknown; name?: string }

/**
 * Import a `.fluximg` bundle into `fig/assets/` and place it on a figure. A bundle whose content is already an asset of
 * this project is not copied again: the new element shows the existing asset.
 */
export async function placeImage(root: string, figureId: string, bundlePath: string, options: PlaceImageOptions = {}) {
  await requireProject(root);
  const realRoot = await fs.realpath(path.resolve(root));
  const source = path.resolve(root, bundlePath);
  const st = await fs.stat(source).catch(() => null);
  if (!st) throw new NotFoundError(`Image bundle not found: ${bundlePath}`);
  if (!st.isDirectory() || !(await fs.stat(path.join(source, "fluximg.json")).catch(() => null))?.isFile())
    throw new ValidationError(`${bundlePath} is not a fluximg bundle (a folder holding fluximg.json); write one with fluxplot first (fp.imsave)`);
  for (const [k, v] of Object.entries({ x: options.x, y: options.y, width: options.width })) {
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v))) throw new ValidationError(`${k} must be a finite number`);
  }
  if (options.width !== undefined && !(options.width > 0)) throw new ValidationError("width must be above 0 (canvas px)");

  // Refuse what the placement would refuse BEFORE copying anything (a big bundle is a long copy).
  const { project: before } = await loadFigModel(root);
  const figure = before.figures.find((f) => f.id === figureId);
  if (!figure) {
    // A slide id (or a deck id) is a Slides target: say why it cannot take an image rather than "not found".
    for (const d of await listDecks(root).catch(() => [])) {
      if (d.id === figureId) throw new ValidationError(FLUXIMG_NOT_IN_SLIDES);
      const deck = await loadDeck(root, d.id).catch(() => null);
      if (deck?.slides.some((s) => s.id === figureId)) throw new ValidationError(FLUXIMG_NOT_IN_SLIDES);
    }
    throw new NotFoundError(`Figure not found: ${figureId}`);
  }
  if (figure.canvasId === DECK_CANVAS_ID) throw new ValidationError(FLUXIMG_NOT_IN_SLIDES);

  // The same content already in the project: reuse its asset. Hashing is a full read of the source, so only bundles
  // whose size matches an existing asset are hashed; the import then confirms (it computes the same content id).
  const files = await bundleFiles(source);
  const total = files.reduce((n, f) => n + f.size, 0);
  let reuse: Asset | undefined;
  const sameSize = before.assets.filter((a) => a.kind === "fluximg" && a.bytes === total && a.sha256);
  if (sameSize.length) {
    const id = await bundleContentId(files);
    reuse = sameSize.find((a) => a.sha256 === id);
  }

  let asset: Asset, imported: { assetId: string; method: string } | null = null;
  let manifest: FluximgManifest;
  const external = !isInside(realRoot, await fs.realpath(source));
  const sourcePath = external ? source : path.relative(path.resolve(root), source).split(path.sep).join("/");
  if (reuse) {
    asset = reuse;
    manifest = (await fluximgReader(root, asset)).manifest;
  } else {
    const assetId = fluximgAssetId(fluximgDisplayName(JSON.parse(await fs.readFile(path.join(source, "fluximg.json"), "utf8")), source), randomUUID());
    const result = await importBundle({ root: path.resolve(root), sourcePath: source, assetId });
    imported = { assetId, method: result.method };
    asset = fluximgAsset(assetId, result, source);
    manifest = result.manifest;
    // Same content under another id (another session placed it meanwhile): keep the first, drop this copy.
    const twin = before.assets.find((a) => a.kind === "fluximg" && a.sha256 === result.sha256);
    if (twin) { await discardBundle({ root: path.resolve(root), assetId }).catch(() => {}); imported = null; asset = twin; }
  }
  const discard = async (): Promise<void> => { if (imported) await discardBundle({ root: path.resolve(root), assetId: imported.assetId }).catch(() => {}); };

  try {
    const warnings: string[] = [];
    const view = options.view === undefined ? undefined : await checkedPatch(manifest, options.view, await tablesForPatch(root, asset, manifest, options.view)).then((r) => { warnings.push(...r.warnings); return r.patch; });
    const crop = options.crop === undefined || options.crop === null ? undefined : checkedCrop(manifest, options.crop);
    const recipe = source.replace(/\.fluximg[\\/]*$/i, "") + ".recipe.json";
    const hasRecipe = !!(await fs.stat(recipe).catch(() => null))?.isFile();
    const placed = await mutateFigModel(root, "place_image", ({ project }) => {
      const registered = project.assets.find((a) => a.id === asset.id);
      const elementId = ops.addFluximg(project, {
        figureId, asset: registered ?? asset, x: options.x, y: options.y, width: options.width, crop,
        view: view ? patchView(undefined, view) : undefined,
        source: { bundlePath: sourcePath, sha256: asset.sha256, ...(external ? { external: true } : {}), ...(hasRecipe ? { recipePath: external ? recipe : path.relative(path.resolve(root), recipe).split(path.sep).join("/") } : {}) },
      });
      if (options.name !== undefined) {
        const el = project.figures.find((f) => f.id === figureId)!.elements.find((e) => e.id === elementId)!;
        el.name = options.name;
      }
      return { elementId, figure: structuredClone(project.figures.find((f) => f.id === figureId)!) };
    });
    const element = placed.figure.elements.find((e) => e.id === placed.elementId) as FluximgElement;
    return {
      assetId: asset.id, reused: !imported,
      ...(imported ? { copy: imported.method } : {}),
      image: describeFluximg(asset.fluximg ?? fluximgInfo(manifest)),
      ...elementSummary(placed.figure, element, manifest),
      warnings,
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

// --- set-image-view ------------------------------------------------------------------------------------------------

/** Patch an image element's view (sparse: null clears a setting back to its default) and optionally its crop. */
export async function setImageView(root: string, elementId: string, patch: unknown, options: { crop?: unknown } = {}) {
  if (patch === undefined && options.crop === undefined) throw new ValidationError("Nothing to change: pass a view patch and/or a crop");
  const { project: before } = await loadFigModel(root);
  const { element } = findImage(before, elementId);
  const asset = imageAsset(before, element.assetId);
  const manifest = (await fluximgReader(root, asset).catch((error) => {
    throw new ValidationError(`Image "${element.name ?? element.id}" cannot be edited: ${error instanceof Error ? error.message : String(error)}`);
  })).manifest;
  const warnings: string[] = [];
  const view = patch === undefined ? undefined : await checkedPatch(manifest, patch, await tablesForPatch(root, asset, manifest, patch)).then((r) => { warnings.push(...r.warnings); return r.patch; });
  const crop = options.crop === undefined ? undefined : options.crop === null ? null : checkedCrop(manifest, options.crop);
  const after = await mutateFigModel(root, "set_image_view", ({ project }) => {
    const { figure, element: el } = findImage(project, elementId);
    if (view) {
      ops.setFluximgView(project, elementId, view);
      const merged = (figure.elements.find((e) => e.id === elementId) as FluximgElement).view;
      const problems = checkMergedView(manifest, merged);
      if (view.insetOf != null && !figure.elements.some((e) => e.id === view.insetOf && e.type === "fluximg" && e.assetId === el.assetId && e.id !== el.id))
        problems.push(`insetOf: ${JSON.stringify(view.insetOf)} is not another placement of the same image in figure ${figure.id}`);
      if (problems.length) throw new ValidationError(`The view does not fit image "${manifest.name}":\n  ${problems.join("\n  ")}`);
    }
    if (crop !== undefined) ops.setCrop(project, elementId, crop);
    const now = findImage(project, elementId);
    return { figure: structuredClone(now.figure), element: structuredClone(now.element) };
  });
  return { ...elementSummary(after.figure, after.element, manifest), warnings };
}

// --- image-info ----------------------------------------------------------------------------------------------------

/** What an image is and how an element shows it, without rendering: an agent's way to plan a view. */
export async function imageInfo(root: string, target: string) {
  const { project } = await loadFigModel(root);
  let asset: Asset | undefined, placed: { figure: Figure; element: FluximgElement } | undefined;
  const el = project.figures.flatMap((f) => f.elements.map((e) => ({ figure: f, element: e }))).find((x) => x.element.id === target);
  if (el) { placed = findImage(project, target); asset = imageAsset(project, placed.element.assetId); }
  else asset = project.assets.find((a) => a.id === target && a.kind === "fluximg");
  if (!asset) throw new NotFoundError(`No image element or image asset "${target}" (image-info takes an element id or a fluximg asset id)`);
  const placements = project.figures.flatMap((f) => f.elements.filter((e) => e.type === "fluximg" && e.assetId === asset!.id).map((e) => ({ elementId: e.id, figureId: f.id, name: e.name ?? null })));
  const head = { assetId: asset.id, name: asset.name, path: `fig/${asset.path}`, contentId: asset.sha256 ?? null, bytes: asset.bytes ?? null, placements };
  let manifest: FluximgManifest;
  let reader: Awaited<ReturnType<typeof fluximgReader>>;
  try { reader = await fluximgReader(root, asset); manifest = reader.manifest; }
  catch (error) {
    // The bundle is gone or broken: say so, with what the project still knows about it.
    return { ...head, issue: `The bundle cannot be read: ${error instanceof Error ? error.message : String(error)}`, digest: asset.fluximg ?? null, ...(asset.fluximg ? { summary: describeFluximg(asset.fluximg) } : {}) };
  }
  const p = manifest.pixels, nd = p.dims.length;
  const dims = p.dims.map((d, i) => {
    const a = manifest.axes?.[d];
    const out: Record<string, unknown> = { name: d, size: p.shape[i] };
    if (d === "c") { out.channels = manifest.channels.map((c) => c.name); return out; }
    if (a) {
      out.unit = a.unit ?? null;
      if (Array.isArray(a.coords)) { out.coords = a.coords.length > 12 ? { first: a.coords[0], last: a.coords[a.coords.length - 1], count: a.coords.length } : a.coords; }
      else { out.scale = a.scale ?? 1; out.offset = a.offset ?? 0; }
      if (Array.isArray(a.labels)) out.labels = a.labels;
    }
    if (d !== "y" && d !== "x") out.from = describePosition(manifest, d, 0), out.to = describePosition(manifest, d, p.shape[i] - 1);
    return out;
  });
  const enc = p.encoding;
  return {
    ...head,
    summary: describeFluximg(fluximgInfo(manifest)),
    width: p.shape[nd - 1], height: p.shape[nd - 2], shape: p.shape, dimsOrder: p.dims, dims,
    dtype: p.dtype,
    encoding: enc.kind === "linear16" ? { kind: "linear16", note: "16-bit compact copy of float data: value = offset + scale * (code - 1)", channels: enc.channels } : { kind: "exact", ...(p.nodata != null ? { nodata: p.nodata } : {}) },
    levels: p.levels.map((l) => l.downsample),
    ...(manifest.photometric ? { photometric: manifest.photometric } : {}),
    pixelSize: manifest.axes?.x && typeof manifest.axes.x.scale === "number" ? `${manifest.axes.x.scale} ${manifest.axes.x.unit ?? "(no unit)"}` : null,
    channels: manifest.channels.map((c, i) => ({
      index: i, name: c.name, ...(c.color ? { color: c.color } : { lut: c.lut }), range: c.range,
      ...(c.stats ? { min: c.stats.min, max: c.stats.max, percentiles: c.stats.percentiles, count: c.stats.count } : {}),
    })),
    // A layer with a table lists its columns: what its objects can be styled by (styleBy) and how.
    layers: await Promise.all(manifest.layers.map(async (l) => {
      const tablePath = layerTablePath(l);
      const table = tablePath ? await reader.readTable(tablePath).catch(() => null) : null;
      return {
        id: l.id, kind: l.kind, name: l.name, visibleByDefault: l.visible ?? false,
        ...(l.kind !== "intensity" ? { objects: typeof l.count === "number" ? l.count : null, ...(l.kind === "labels" || l.table ? { key: l.key ?? null } : {}) } : { range: l.range, opacity: l.opacity }),
        ...(table ? { columns: columnSummaries(table).map((c) => ({ name: c.name, kind: c.kind, distinct: c.distinct, ...(c.range ? { range: c.range } : {}), ...(c.missing ? { missing: c.missing } : {}) })) } : {}),
      };
    })),
    regions: manifest.regions.map((r) => ({ id: r.id, name: r.name, rect: r.rect })),
    ...(manifest.defaults ? { defaults: manifest.defaults } : {}),
    ...(placed ? { element: elementSummary(placed.figure, placed.element, manifest) } : {}),
  };
}
