/**
 * The decisions of getting a bundle onto a figure and keeping it in step with its source, as pure functions (no DOM,
 * no Svelte, no IO): both the window (import.ts, sourceUpdate.ts) and the gates call these.
 *
 *  - where a placed image says it came from (`fluximgSourceRecord`);
 *  - which existing asset already holds the same content (`findFluximgAsset`: the content id is the dedupe key);
 *  - the element a placement adds (`makeFluximgElement`: through ops.addFluximg, so sizing rules live in one place);
 *  - what happens to an element's view and crop when its source changes shape (`carryFluximgView`);
 *  - which elements move to new content when a source bundle changes, and the move itself
 *    (`planFluximgSourceUpdate` / `applyFluximgSourceUpdate`), applied in ONE commit by the caller.
 */
import type { Asset, CropRect, Figure, Project } from "../types";
import { addFluximg } from "../ops";
import type { FluximgElement, FluximgInfo } from "./element";
import type { FluximgManifest } from "./types";
import type { FluximgView } from "./view";
import { positionDims, resolveView } from "./viewOps";

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
const isAbs = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** A bundle path as an element stores it: project-relative (`plots/…`) when inside the project, else absolute. */
export function fluximgBundleRef(root: string | null | undefined, sourcePath: string): { bundlePath: string; external: boolean } {
  const s = norm(sourcePath), r = root ? norm(root) : "";
  if (!isAbs(s)) return { bundlePath: s.replace(/^\.\//, ""), external: false };
  if (r && s.startsWith(`${r}/`)) return { bundlePath: s.slice(r.length + 1), external: false };
  return { bundlePath: s, external: true };
}

/** The `source` a placed image records: where its bundle is, and the content id of what was imported. */
export function fluximgSourceRecord(root: string | null | undefined, sourcePath: string, sha256: string, recipePath?: string | null): NonNullable<FluximgElement["source"]> {
  const ref = fluximgBundleRef(root, sourcePath);
  const recipe = recipePath ? fluximgBundleRef(root, recipePath).bundlePath : null;
  return { bundlePath: ref.bundlePath, sha256, ...(recipe ? { recipePath: recipe } : {}), ...(ref.external ? { external: true } : {}) };
}

/** `<stem>.recipe.json` beside a bundle (SPEC §1): the path to look for. */
export function fluximgRecipeBeside(bundlePath: string): string {
  return norm(bundlePath).replace(/\.fluximg$/i, ".recipe.json");
}

/** The project's fluximg asset holding exactly this content, if any (same content id = the same pixels). */
export function findFluximgAsset(assets: readonly Asset[], sha256: string): Asset | undefined {
  return sha256 ? assets.find((a) => a.kind === "fluximg" && a.sha256 === sha256) : undefined;
}

/** The element `addFluximg` would add to `figure` for `asset` (built on a scratch project: nothing is committed). */
export function makeFluximgElement(figure: Pick<Figure, "id" | "width" | "height"> & { canvasId?: string }, asset: Asset, source?: FluximgElement["source"]): FluximgElement {
  const scratch = { assets: [] as Asset[], figures: [{ ...figure, elements: [] }] } as unknown as Project;
  addFluximg(scratch, { figureId: figure.id, asset, ...(source ? { source } : {}) });
  return scratch.figures[0].elements[0] as FluximgElement;
}

// ---------------------------------------------------------------------------------------------------------------
// Carrying a view and crop across a source change
// ---------------------------------------------------------------------------------------------------------------

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** True when a new manifest has the same pixel grid as the old digest: same dimensions, sizes and channels. */
export function sameFluximgShape(old: Pick<FluximgInfo, "dims" | "shape" | "channels">, manifest: FluximgManifest): boolean {
  return sameList(old.dims, manifest.pixels.dims) && sameList(old.shape, manifest.pixels.shape) && sameList(old.channels, manifest.channels.map((c) => c.name));
}

export interface CarriedView {
  view: FluximgView | undefined;
  crop: CropRect | undefined;
  /** What could not be kept, in plain words ("the z position", "the crop"); empty when everything carried over. */
  changed: string[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * An element's sparse view and crop on a NEW manifest. Same grid: both unchanged. Otherwise every field is kept
 * where it still means something, with the semantics of `viewOps.resolveView` (positions clamp into range,
 * a projection that no longer fits is clamped or dropped, overrides of channels / layers that are gone are dropped),
 * and the crop is clamped to the new image (dropped when nothing of it is left).
 */
export function carryFluximgView(old: Pick<FluximgInfo, "dims" | "shape" | "channels"> | undefined, manifest: FluximgManifest, view: FluximgView | undefined, crop: CropRect | undefined): CarriedView {
  if (old && sameFluximgShape(old, manifest)) return { view, crop, changed: [] };
  const changed: string[] = [];
  const dims = manifest.pixels.dims, shape = manifest.pixels.shape;
  const sizeOf = (d: string): number => { const i = dims.indexOf(d); return i >= 0 ? shape[i] : 0; };
  let out: FluximgView | undefined;
  if (view) {
    const v: FluximgView = structuredClone(view);
    const rv = resolveView(manifest, v);
    if (v.index) {
      const next: Record<string, number> = {};
      for (const [d, i] of Object.entries(v.index)) {
        if (!positionDims(manifest).includes(d)) { changed.push(`the ${d} position`); continue; }
        if (!finite(i)) continue;
        next[d] = rv.index[d];
        if (next[d] !== i) changed.push(`the ${d} position`);
      }
      if (Object.keys(next).length) v.index = next; else delete v.index;
    }
    if (v.projection) {
      const p = rv.projection;
      if (!p) { changed.push("the projection"); delete v.projection; }
      else if (p.from !== v.projection.from || p.to !== v.projection.to) { changed.push("the projection"); v.projection = p; }
    }
    const nC = manifest.channels.length;
    if (Array.isArray(v.channels) && v.channels.length > nC) {
      if (v.channels.slice(nC).some((c) => c && Object.keys(c).length)) changed.push("settings of channels that are gone");
      v.channels = v.channels.slice(0, nC);
      while (v.channels.length && !v.channels[v.channels.length - 1]) v.channels.pop();
      if (!v.channels.length) delete v.channels;
    }
    if (finite(v.solo) && v.solo !== rv.solo) { changed.push("the solo channel"); v.solo = rv.solo; }
    const layerIds = new Set(manifest.layers.map((l) => l.id));
    if (v.layers) {
      const kept = Object.fromEntries(Object.entries(v.layers).filter(([id]) => layerIds.has(id)));
      if (Object.keys(kept).length !== Object.keys(v.layers).length) changed.push("settings of layers that are gone");
      if (Object.keys(kept).length) v.layers = kept; else delete v.layers;
    }
    if (v.layerOrder) {
      const kept = v.layerOrder.filter((id) => layerIds.has(id));
      if (kept.length) v.layerOrder = kept; else delete v.layerOrder;
    }
    out = Object.keys(v).length ? v : undefined;
  }
  let outCrop: CropRect | undefined;
  if (crop) {
    const W = sizeOf("x"), H = sizeOf("y");
    const x = Math.min(Math.max(0, crop.x), W), y = Math.min(Math.max(0, crop.y), H);
    const w = Math.min(crop.width, W - x), h = Math.min(crop.height, H - y);
    if (w > 0 && h > 0) {
      outCrop = { x, y, width: w, height: h };
      if (x !== crop.x || y !== crop.y || w !== crop.width || h !== crop.height) changed.push("the crop");
    } else changed.push("the crop");
  }
  return { view: out, crop: outCrop, changed: [...new Set(changed)] };
}

// ---------------------------------------------------------------------------------------------------------------
// Moving placed images to new source content
// ---------------------------------------------------------------------------------------------------------------

/** Does this element follow the bundle at `bundlePath` (the same reference form `fluximgBundleRef` makes)? */
export function followsBundle(el: FluximgElement, bundlePath: string): boolean {
  const s = el.source;
  return !!s && !s.frozen && norm(s.bundlePath) === norm(bundlePath);
}

export interface FluximgSourceMove {
  figureId: string;
  elementId: string;
  fromAssetId: string;
  view: FluximgView | undefined;
  crop: CropRect | undefined;
  /** The box height that keeps the element's width on the new content's aspect (only when the aspect changed). */
  height: number | undefined;
  changed: string[];
}

export interface FluximgSourcePlan {
  moves: FluximgSourceMove[];
  /** Assets the moved elements used before (their caches can be dropped; unused ones are collected as usual). */
  oldAssetIds: string[];
}

/**
 * Which elements move to `next` (a new asset of the bundle's new content) and how: every element whose source is
 * `bundlePath`, not frozen, and not already showing that content.
 */
export function planFluximgSourceUpdate(p: Project, bundlePath: string, next: Asset, manifest: FluximgManifest): FluximgSourcePlan {
  const moves: FluximgSourceMove[] = [];
  const old = new Set<string>();
  const W = next.naturalWidth, H = next.naturalHeight;
  for (const f of p.figures) for (const e of f.elements) {
    if (e.type !== "fluximg" || !followsBundle(e, bundlePath)) continue;
    const from = p.assets.find((a) => a.id === e.assetId);
    if (e.assetId === next.id || (from?.sha256 && from.sha256 === next.sha256)) continue;
    const carried = carryFluximgView(from?.fluximg, manifest, e.view, e.crop);
    const cw = carried.crop ? carried.crop.width : W, ch = carried.crop ? carried.crop.height : H;
    const was = e.crop ? e.crop.width / e.crop.height : from ? from.naturalWidth / from.naturalHeight : cw / ch;
    const aspect = cw / ch;
    const height = Math.abs(aspect - was) > 1e-9 * Math.max(1, aspect) ? e.width / aspect : undefined;
    moves.push({ figureId: f.id, elementId: e.id, fromAssetId: e.assetId, view: carried.view, crop: carried.crop, height, changed: carried.changed });
    old.add(e.assetId);
  }
  return { moves, oldAssetIds: [...old] };
}

/** Apply a plan inside the caller's commit: register `next`, repoint each element, carry its view and crop. */
export function applyFluximgSourceUpdate(p: Project, plan: FluximgSourcePlan, next: Asset): number {
  // The element may have changed since the plan was made: move it only if it still shows the old content.
  const live = plan.moves.map((m) => {
    const e = p.figures.find((x) => x.id === m.figureId)?.elements.find((x) => x.id === m.elementId);
    return e && e.type === "fluximg" && e.assetId === m.fromAssetId ? { m, e } : null;
  }).filter((x): x is { m: FluximgSourceMove; e: FluximgElement } => !!x);
  if (!live.length) return 0;
  if (!p.assets.some((a) => a.id === next.id)) p.assets.push(structuredClone(next));
  let n = 0;
  for (const { m, e } of live) {
    e.assetId = next.id;
    e.source = { ...(e.source ?? { bundlePath: "" }), sha256: next.sha256 };
    if (m.view) e.view = structuredClone(m.view); else delete e.view;
    if (m.crop) e.crop = { ...m.crop }; else delete e.crop;
    if (m.height !== undefined && Number.isFinite(m.height) && m.height > 0) e.height = m.height;
    n++;
  }
  return n;
}
