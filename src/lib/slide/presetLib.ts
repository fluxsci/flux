import { validatedModelBytes } from '../model3d/portableBytes';
import { model3dDeckScope } from '../model3d/editorScope';
import type { Model3dAsset } from '../model3d/types';
import { staticModelRequest, type Model3dSvgContext } from '../model3d/static';
import { parseScene3d } from '../model3d/scene3d';
import { scene3dSourceBindingIssue } from '../model3d/sourceBinding';
import { deckModel3dBindings } from "./model3dBindings";
import { pushToast, errMsg } from "../toast";
import { preparePresetModels } from "./model3dPresets";
import { readScene3dSidecars } from "../model3d/persistence";
import { cacheScene3dSidecars } from "../model3d/store";
// ---------------------------------------------------------------------------
// Slide presets — the user's machine-global library of reusable SLIDES,
// stored one JSON file per preset under <FluxConfig>/presets/slides/**
// (dev fixture: localStorage via memBridge; design presets' sibling).
//
// A preset is a whole-slide snapshot: elements + groups + beats (animation
// travels with the slide) + background/transition/notes/camera, PLUS the
// bytes of every asset the elements reference (data URLs) so the preset is
// self-contained across projects. Saving reads the PERSISTED slide (the
// composed deck — beat-faithful checkouts fold to base, like autosave);
// inserting goes through the pure `slideOps.insertSlideSnapshot` (fresh ids,
// retargeted tracks) via `commitDeckLive`, then registers the embedded bytes
// under the remapped asset ids. Thumbnails come from the SAME elementToSvg
// the canvas and export use, resolving hrefs from the embedded data.
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import type { Id } from "../types";
import { fileBridge } from "../project/types";
import { project, embeddedProjectRoot } from "../store";
import { getAssetData, setAssetData, markAssetDirty, dataUrlToBytes, bytesToDataUrl } from "../assets";
import { plotManifests, plotRecipes, cachePlot } from "../plot/store";
import { isDerivedManifest } from "../plot/derive";
import type { FluxPlotManifest } from "../plot/types";
import { elementToSvg } from "../export";
import { presetRel } from "../presets";
import * as slideOps from "./ops";
import type { SlidePresetSnapshot, SlidePresetAssetEntry } from "./ops";
import { commitDeckLive, currentDeck, selectSlide } from "./store";
import { slideAnimStyles } from "./resolve";
import { underRoot } from "./payload";
import { slideAssetIds, slideDefaultBackground } from "./deckProject";
import { deckSchemaFor, compareSchema } from "./schemaStamp";
import { DECK_ATTACH_SCHEMA_VERSION, DECK_SCHEMA_VERSION, type Deck } from "./types";
import { isNewerSchema, newerSchemaMessage, joinPath } from "../project/types";
import { fluximgResolvedAsset } from "../fluximg/place";
import type { FluximgManifest } from "../fluximg/types";
import type { Asset } from "../types";

export interface SlidePresetEntry {
  rel: string;
  preset: SlidePresetSnapshot;
  /** Set when this build cannot insert it (written by a newer Flux): the words to show; insert refuses with them. */
  refusal?: string;
}

/**
 * How a slide preset is stamped (C5): the content-derived minimum the deck stamps use (`deckSchemaFor` over the slide and
 * its styles). A slide a fluxPreset-1 reader holds whole (format up to 0.7.0, every build that ever read presets) stays
 * `fluxPreset: 1` with no stamp, byte for byte as before; one that needs more (an image: an older build's fold drops the
 * kind) is `fluxPreset: 2` with its `schemaVersion`, which those builds never list, so they can never insert it short.
 */
export function slidePresetStamp(slide: SlidePresetSnapshot["slide"], animStyles: SlidePresetSnapshot["animStyles"] = []): Pick<SlidePresetSnapshot, "fluxPreset" | "schemaVersion"> {
  const v = deckSchemaFor({ slides: [slide], animStyles, assets: [] } as unknown as Deck);
  return compareSchema(v, DECK_ATTACH_SCHEMA_VERSION) > 0 ? { fluxPreset: 2, schemaVersion: v } : { fluxPreset: 1 };
}

/** The presets of a library listing this build can show: version 1, version 2 whose format it reads, and (listed, but
 *  refused at insert with the "newer Flux" words) a later version or format. Anything else is skipped. */
export function slidePresetEntries(list: unknown): SlidePresetEntry[] {
  if (!Array.isArray(list)) return [];
  const out: SlidePresetEntry[] = [];
  for (const it of list) {
    const e = it as { rel?: unknown; payload?: unknown };
    if (!e || typeof e.rel !== "string") continue;
    const p = e.payload as SlidePresetSnapshot | undefined;
    if (!p || typeof p.fluxPreset !== "number" || p.fluxPreset < 1 || p.kind !== "slide" || typeof p.name !== "string") continue;
    if (!p.slide || !Array.isArray(p.slide.elements)) continue;
    const format = p.fluxPreset === 1 ? null : typeof p.schemaVersion === "string" ? p.schemaVersion : `preset ${p.fluxPreset}`;
    const newer = p.fluxPreset > 2 || (format !== null && isNewerSchema(format, DECK_SCHEMA_VERSION)) || (p.fluxPreset === 2 && typeof p.schemaVersion !== "string");
    out.push({ rel: e.rel, preset: p, ...(newer ? { refusal: newerSchemaMessage(`The slide preset "${p.name}"`, format, DECK_SCHEMA_VERSION) } : {}) });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
const sane = slidePresetEntries;

/** Read an image bundle's manifest from this project (`fig/assets/<id>.fluximg`), or null when it is not there. */
async function projectBundleManifest(root: string, assetId: string): Promise<FluximgManifest | null> {
  const fb = fileBridge();
  if (!root || !fb) return null;
  const bundle = `fig/assets/${assetId}.fluximg`;
  try {
    const text = fb.readFluximg
      ? new TextDecoder().decode(await fb.readFluximg({ root, bundle, path: "fluximg.json", offset: 0, length: -1 }))
      : await fb.readText(joinPath(root, bundle, "fluximg.json"));
    const m = JSON.parse(text) as FluximgManifest;
    return m?.spec === "fluximg/1" ? m : null;
  } catch { return null; }
}

/**
 * The images a preset's slide holds, resolved in THIS project: a bundle is project-level (never embedded), so an image
 * is insertable only where its bundle is. Registered already: nothing to do; in `fig/assets` but not loaded: its record,
 * to register with the insert; nowhere: a refusal naming the image (never a grey stand-in).
 */
export async function presetImagesHere(snap: SlidePresetSnapshot, root: string, registered: readonly Asset[]): Promise<{ add: Asset[]; missing: string[] }> {
  const add: Asset[] = [], missing: string[] = [], seen = new Set<string>();
  for (const el of snap.slide.elements) {
    if (el.type !== "fluximg" || seen.has(el.assetId)) continue;
    seen.add(el.assetId);
    if (registered.some((a) => a.id === el.assetId && a.kind === "fluximg")) continue;
    const m = await projectBundleManifest(root, el.assetId);
    if (m) add.push(fluximgResolvedAsset(el.assetId, m, el.source?.sha256));
    else missing.push(el.name || el.source?.bundlePath?.split("/").pop() || el.assetId);
  }
  return { add, missing };
}

export async function listSlidePresets(): Promise<SlidePresetEntry[]> {
  try {
    return sane(await fileBridge()?.readSlideLibrary?.());
  } catch {
    return [];
  }
}

export async function deleteSlidePreset(rel: string): Promise<boolean> {
  return (await fileBridge()?.deleteSlideLibrary?.(rel)) ?? false;
}

/** Save a slide of the live deck as a machine-global preset. Reads the
 *  PERSISTED slide from the composed deck (what deck.json would hold).
 *  Returns the rel + any asset ids whose bytes could not be embedded (the
 *  elements stay in the preset; they resolve only where those ids exist). */
export async function saveSlidePreset(
  name: string,
  slideId: Id,
): Promise<{ rel: string; missingAssets: Id[]; previewIssues: string[] } | null> {
  const rel = presetRel(name);
  const deck = currentDeck();
  const slide = deck?.slides.find((s) => s.id === slideId);
  if (!rel || !deck || !slide) return null;
  const metadata = structuredClone(get(project).assets);
  const root = get(embeddedProjectRoot), bridge = fileBridge();
  const referenced = slideAssetIds(slide);
  const bindings = deckModel3dBindings(deck);
  const resident = new Map([...referenced].map(id => [id, getAssetData(id)]));
  const manifests = get(plotManifests);
  const recipes = get(plotRecipes);
  const assets: SlidePresetAssetEntry[] = [];
  const missingAssets: Id[] = [];
  for (const aid of referenced) {
    const meta = metadata.find((a) => a.id === aid);
    // An image bundle (fluximg) is a project-level DIRECTORY that can be gigabytes: it is never embedded. The preset keeps the
    // element and refers to the bundle by id, so it shows wherever that id resolves (this project) and stands in elsewhere.
    if (meta?.kind === "fluximg") { missingAssets.push(aid); continue; }
    let data = resident.get(aid);
    // A native stream capability expires with its project/window. Portable
    // preset saves explicitly embed bytes; ordinary authoring never does.
    if (meta?.kind === "mp4" && data && !data.startsWith("data:video/")) {
      if (!root || !bridge || !meta.path) throw new Error("Open the source deck before saving a video slide preset");
      data = bytesToDataUrl(new Uint8Array(await bridge.readFile(underRoot(root, `slides/${deck.id}/${meta.path}`))), "video/mp4");
    }
    let modelSidecars: Awaited<ReturnType<typeof readScene3dSidecars>> | undefined;
    if (meta?.kind === "glb") {
      if (!root || !bridge || !meta.path) throw new Error("Open the source deck before saving a 3D slide preset");
      const prefix = deck.assets.some(a => a.id === aid) ? `slides/${deck.id}` : "";
      const file = underRoot(root, [prefix, meta.path].filter(Boolean).join("/"));
      const bytes = await (bridge.readModelFile ? bridge.readModelFile(file, root) : bridge.readFile(file));
      data = bytesToDataUrl(await validatedModelBytes(bytes, meta as Model3dAsset), "model/gltf-binary");
      const sidecarDirectory = prefix ? `${prefix}/assets` : "fig/assets";
      modelSidecars = await readScene3dSidecars(bridge, underRoot(root, sidecarDirectory), aid, { strict: true, binding: bindings.get(aid) });
    }
    if (!meta || !data) {
      missingAssets.push(aid);
      continue;
    }
    const entry: SlidePresetAssetEntry = { asset: structuredClone(meta), data };
    // Only a REAL fluxplot manifest rides along — derived ones re-derive at
    // insert (cachePlot), exactly like the import path.
    if (meta.kind === "svg" && manifests[aid] && !isDerivedManifest(manifests[aid])) {
      entry.manifest = manifests[aid];
      if (recipes[aid] !== undefined) entry.recipe = recipes[aid];
    }
    if (modelSidecars) {
      entry.modelMetadataActive = !!modelSidecars.manifest;
      // A portable preset's GLB is the prepared file, so its active sidecar
      // binds to those exact bytes. Inactive/newer raw metadata stays untouched.
      if (modelSidecars.manifest) entry.manifest = { ...modelSidecars.manifest, glbSha256: meta.sha256 };
      else if (modelSidecars.raw?.manifest !== undefined) entry.manifest = modelSidecars.raw.manifest;
      if (modelSidecars.recipe !== undefined) entry.recipe = modelSidecars.recipe;
      else if (modelSidecars.raw?.recipe !== undefined) entry.recipe = modelSidecars.raw.recipe;
    }
    assets.push(entry);
  }
  const modelPosters: Record<string, string> = {};
  // Reported once by the caller's save toast, never one toast per model.
  const previewIssues: string[] = [];
  for (const element of slide.elements) if (element.type === 'model3d' && !element.hidden) {
    const entry = assets.find(a => a.asset.id === element.assetId);
    if (!entry || entry.asset.kind !== 'glb') continue;
    const parsed = entry.manifest === undefined || entry.modelMetadataActive === false ? undefined : parseScene3d(typeof entry.manifest === 'string' ? entry.manifest : JSON.stringify(entry.manifest));
    const manifest = parsed && !('issue' in parsed) ? parsed : undefined;
    const request = staticModelRequest(element, entry.asset as Model3dAsset, manifest, 'slide');
    const prefix = deck.assets.some(a => a.id === entry.asset.id) ? `slides/${deck.id}` : '';
    const { modelPosterUrl } = await import('../model3d/posterStore');
    const source = { root: root!, prefix, bridge: bridge ?? null, scope: `slide-preset:${root}:${deck.id}`,
      isCurrent: () => get(embeddedProjectRoot) === root && currentDeck()?.id === deck.id };
    // A missing/failed thumbnail must not make a reusable model disappear.
    try { modelPosters[element.id] = await modelPosterUrl({ ...request, surface: 'slide' }, { source }); }
    catch (error) { const reason = errMsg(error); if (!previewIssues.includes(reason)) previewIssues.push(reason); }
  }
  const baseName = rel.replace(/\.json$/i, "").split("/").pop() || "slide";
  const styles = slideAnimStyles(slide, deck);
  const snap: SlidePresetSnapshot = {
    ...slidePresetStamp(slide, styles),
    kind: "slide",
    name: baseName,
    savedAt: new Date().toISOString(),
    stage: structuredClone(deck.stage),
    thumbBackground: slide.background ?? slideDefaultBackground(deck),
    ...(Object.keys(modelPosters).length ? { modelPosters } : {}),
    slide: structuredClone(slide),
    animStyles: styles,
    ...(assets.length ? { assets } : {}),
  };
  const ok = await fileBridge()?.writeSlideLibrary?.(rel, snap);
  return ok ? { rel, missingAssets, previewIssues } : null;
}

/** Insert a preset into the live deck after the given slide (or at the end),
 *  register the embedded asset bytes under their remapped ids, and select the
 *  new slide. Returns the new slide id (null = no deck loaded). */
export async function insertSlidePreset(entry: SlidePresetEntry, afterSlideId?: Id | null): Promise<Id | null> {
  if (entry.refusal) throw new Error(entry.refusal);
  let snap = entry.preset;
  const deckNow = currentDeck();
  if (!deckNow) return null;
  // Images: their bundles live in a project, never in the preset. Refuse, naming them, where they are not.
  const images = snap.slide.elements.some((e) => e.type === "fluximg")
    ? await presetImagesHere(snap, get(embeddedProjectRoot) ?? "", get(project).assets) : { add: [], missing: [] };
  if (images.missing.length) {
    const names = images.missing.map((n) => `"${n}"`).join(", ");
    throw new Error(`This preset shows ${images.missing.length === 1 ? "the image" : "the images"} ${names}, which ${images.missing.length === 1 ? "is" : "are"} not in this project: an image's data stays in the project it was placed in. Place ${images.missing.length === 1 ? "it" : "them"} here first, or insert the preset in that project.`);
  }
  const idx = afterSlideId ? deckNow.slides.findIndex((s) => s.id === afterSlideId) : -1;
  const at = idx >= 0 ? idx + 1 : undefined;
  const capturedRoot = get(embeddedProjectRoot), root = capturedRoot ?? "";
  const capturedScope = get(model3dDeckScope);
  const current = () => get(model3dDeckScope) === capturedScope && get(embeddedProjectRoot) === capturedRoot && currentDeck()?.id === deckNow.id;
  const prepared = await preparePresetModels(snap, root, deckNow.id, current);
  snap = prepared.snapshot;
  let res: ReturnType<typeof slideOps.insertSlideSnapshot>;
  try {
    if (!current()) throw new Error("The destination deck changed");
    res = commitDeckLive(d => {
      // an image bundle found in fig/assets is registered with the insert (the projected project holds a deck's images)
      d.assets.push(...prepared.assets, ...images.add);
      return slideOps.insertSlideSnapshot(d, snap, { at });
    });
  } catch (error) { await prepared.discard(); throw error; }
  for (const result of prepared.results) cacheScene3dSidecars(result.asset.id, result);
  // Register bytes for the assets the op added (assetData is reactive — the
  // projected elements pick the hrefs up in the same flush).
  for (const e of snap.assets ?? []) {
    const nid = res.assetRemap.get(e.asset.id);
    if (!nid) continue; // reused an existing deck asset — bytes already live
    setAssetData(nid, e.data);
    markAssetDirty(nid); // the deck save writes assets/<nid>.<kind>
    if (e.asset.kind === "svg") {
      try {
        const svgText = new TextDecoder().decode(dataUrlToBytes(e.data));
        cachePlot(nid, svgText, e.manifest as FluxPlotManifest | undefined, e.recipe);
      } catch {
        /* unparsable svg — the <image> fallback still renders from assetData */
      }
    }
  }
  // Publish installed bytes before yielding. Adoption must finish for every
  // receipt even when navigation replaces the destination during the await.
  try { await prepared.adopt(); } catch (error) {
    if (current()) pushToast("error", "Preset inserted, but its 3D files could not be finalized", { detail: errMsg(error) });
  }
  if (current()) selectSlide(res.slideId);
  return res.slideId;
}

/** SVG thumbnail data-URL for a preset card: the slide's background + its
 *  elements over the saved stage, hrefs resolved from the EMBEDDED bytes. */
export function slidePresetThumb(p: SlidePresetSnapshot): string {
  const dataById = new Map<Id, string>();
  for (const e of p.assets ?? []) dataById.set(e.asset.id, e.data);
  const models = new Map((p.assets ?? []).filter(e => e.asset.kind === 'glb').map(e => [e.asset.id, e]));
  const context: Model3dSvgContext = {
    assetOf: el => { const asset = models.get(el.assetId)?.asset; return asset?.kind === 'glb' ? asset as Model3dAsset : undefined; },
    manifestOf: el => { const entry = models.get(el.assetId), value = entry?.manifest; if (value === undefined || entry?.modelMetadataActive === false) return undefined;
      const parsed = parseScene3d(typeof value === 'string' ? value : JSON.stringify(value));
      return 'issue' in parsed || scene3dSourceBindingIssue(parsed, {kind:'known',sha256:entry!.asset.sha256!}) ? undefined : parsed; },
    posterIdOf: el => { const id = `preset-model:${el.id}`; const png = p.modelPosters?.[el.id];
      if (png?.startsWith('data:image/png;')) { dataById.set(id, png); return id; } return undefined; },
  };
  const bg = p.slide.background ?? p.thumbBackground ?? "#100f0f";
  const body = p.slide.elements
    .filter((el) => !el.hidden)
    .map((el) => elementToSvg(el, (id) => dataById.get(id), undefined, undefined, context))
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.stage.width} ${p.stage.height}">` +
    `<rect width="${p.stage.width}" height="${p.stage.height}" fill="${bg}"/>` +
    body +
    `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
