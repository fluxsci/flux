/** Which cached 3D posters are live: one definition shared by the app's idle
 * prune and `render-model-posters --prune`, so both keep the same stills.
 * Figure placements use their stored Figure still; every registered deck keeps
 * its Design stills and every build step's still (slideModelStills, the same
 * enumeration payload gathering uses). Pure apart from the injected read-only IO. */
import type { Asset, Figure, Project } from '../types';
import { DECK_SCHEMA_VERSION, type Deck } from '../slide/types';
import type { CompileOptions } from '../slide/compile';
import type { FluxPlotManifest } from '../plot/types';
import type { Model3dAsset, Model3dElement, Scene3dManifest } from './types';
import type { ModelPartStates } from './appearance';
import type { PosterSurface } from './poster';
import { collectModelPosters, model3dSvgContext } from './static';
import { readScene3dSidecars, type Scene3dSidecarIO } from './persistence';
import { collectModel3dSourceBindings, model3dBindingsFromReceipts } from './sourceBinding';
import { slideModelStills } from '../slide/staticModels';
import { deckToProject } from '../slide/deckProject';
import { deckModel3dBindings } from '../slide/model3dBindings';
import { resolveTrack } from '../slide/resolve';
import { normalizeDeck } from '../slide/ops';
import { isNewerSchema } from '../project/types';

/** The poster keys a set of placements names (hidden placements excluded). */
export function modelPosterKeys(figures: readonly Figure[], assets: readonly Asset[], manifests: Readonly<Record<string, Scene3dManifest | undefined>>,
  surface: PosterSurface, partStatesOf?: (element: Model3dElement) => ModelPartStates | undefined): string[] {
  const accepted: Record<string, Scene3dManifest> = {};
  for (const [id, manifest] of Object.entries(manifests)) if (manifest) accepted[id] = manifest;
  const context = model3dSvgContext(assets, accepted, surface, undefined, partStatesOf);
  return [...new Set(collectModelPosters(figures, context, surface, { onIssue: () => {} }).map(request => request.key))];
}

export interface DeckModelDocument { project: Project; manifests: Record<string, Scene3dManifest | undefined>; warnings: string[] }
/** A saved deck as a model document: deck-local and Figure-owned assets with
 * project-relative paths, and each used GLB's accepted scene manifest bound to
 * every original-source receipt. `io` reads project-relative paths. */
export async function deckModelDocumentFrom(deck: Deck, figure: Pick<Project, 'figures' | 'assets'>, io: Scene3dSidecarIO): Promise<DeckModelDocument> {
  const local = new Set(deck.assets.map(a => a.id));
  // POSIX join semantics (the stored layout), without a Node dependency.
  const join = (...parts: string[]) => { const out: string[] = []; for (const seg of parts.join('/').split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); } return out.join('/'); };
  const assets = [...deck.assets.map(a => ({ ...a, path: join('slides', deck.id, a.path) })), ...figure.assets.filter(a => !local.has(a.id)).map(a => ({ ...a, path: join('fig', a.path) }))];
  const project = deckToProject(deck, assets), bindings = deckModel3dBindings(deck);
  const figureBindings = collectModel3dSourceBindings(figure.figures.flatMap(f => f.elements));
  const manifests: Record<string, Scene3dManifest | undefined> = {}, warnings: string[] = [];
  const used = new Set(project.figures.flatMap(f => f.elements).filter(e => e.type === 'model3d').map(e => e.assetId));
  for (const slide of deck.slides) for (const beat of slide.beats) for (const raw of beat.tracks) {
    const track = resolveTrack(raw, deck); if (track.to?.assetId) used.add(track.to.assetId);
  }
  for (const asset of assets) if (asset.kind === 'glb' && used.has(asset.id)) {
    const candidates = local.has(asset.id) ? [bindings.get(asset.id)] : [bindings.get(asset.id), figureBindings.get(asset.id)];
    const binding = model3dBindingsFromReceipts(candidates.flatMap(b => b ? (b.kind === 'known' ? [b.sha256] : b.sha256s).map(sha256 => ({ assetId: asset.id, sha256 })) : [])).get(asset.id);
    const metadata = await readScene3dSidecars(io, local.has(asset.id) ? `slides/${deck.id}/assets` : 'fig/assets', asset.id, { binding });
    manifests[asset.id] = metadata.manifest; warnings.push(...metadata.issues ?? []);
  }
  return { project, manifests, warnings };
}

/** A deck's poster placements: each slide's Design placements (the editor's
 * Design still) plus every build step's still. Step stills ride carrier
 * figures, one per slide and step, with no groups and nothing hidden: payload
 * gathering requests a still for every sampled placement. Part states are keyed
 * by the carrier element itself. */
export function deckPosterFigures(doc: DeckModelDocument, deck: Deck, optionsFor: (slideId: string) => CompileOptions, slideId?: string) {
  const design = slideId ? doc.project.figures.filter(figure => figure.id === slideId) : doc.project.figures;
  const carriers = new Map<string, Figure>(), states = new Map<Model3dElement, ModelPartStates>();
  for (const slide of deck.slides) {
    if (slideId && slide.id !== slideId) continue;
    const owner = doc.project.figures.find(figure => figure.id === slide.id);
    if (!owner) continue;
    const { groups: _groups, elements: _elements, ...frame } = owner;
    for (const still of slideModelStills(slide, deck.stage, optionsFor(slide.id))) {
      let carrier = carriers.get(`${slide.id}\0${still.step}`);
      if (!carrier) carriers.set(`${slide.id}\0${still.step}`, carrier = { ...frame, elements: [] });
      const element: Model3dElement = { ...still.element, hidden: false };
      carrier.elements.push(element);
      if (still.partStates) states.set(element, still.partStates);
    }
  }
  return { design, figures: [...design, ...carriers.values()], partStates: (element: Model3dElement) => states.get(element) };
}
/** Compile options for poster enumeration without per-slide disk reads (the
 * app's prune): the document's model metadata and any known plot manifests. */
export function deckPosterCompileOptions(doc: DeckModelDocument, deck: Deck, plotManifest?: (assetId: string) => FluxPlotManifest | undefined): CompileOptions {
  const models = new Map(doc.project.assets.filter((asset): asset is Model3dAsset => asset.kind === 'glb').map(asset => [asset.id, asset]));
  return { animStyles: deck.animStyles, plotManifest, modelAsset: id => models.get(id), modelManifest: id => doc.manifests[id] };
}
export function deckPosterKeys(doc: DeckModelDocument, deck: Deck, optionsFor: (slideId: string) => CompileOptions): string[] {
  const inputs = deckPosterFigures(doc, deck, optionsFor);
  return modelPosterKeys(inputs.figures, doc.project.assets, doc.manifests, 'slide', inputs.partStates);
}

/** Every registered deck, read as flux-core's loadDeck does. `null` when any
 * registered deck cannot be read: its live stills are unknown, so a prune
 * must keep the whole cache. */
export async function readProjectDecks(io: Pick<Scene3dSidecarIO, 'readText'>): Promise<Deck[] | null> {
  let entries: Array<{ id: string; path?: string }>;
  try { entries = JSON.parse(await io.readText('project.json')).slides ?? []; } catch { return null; }
  const decks: Deck[] = [];
  for (const entry of entries) {
    try {
      const raw = JSON.parse(await io.readText(entry.path ?? `slides/${entry.id}/deck.json`)) as Deck;
      if (isNewerSchema(raw.schemaVersion, DECK_SCHEMA_VERSION)) return null;
      decks.push(normalizeDeck(raw));
    } catch { return null; }
  }
  return decks;
}

/** The app prune's live set: the in-memory Figure model with its accepted
 * manifests, plus every saved deck's Design and step stills. `null` means some
 * document could not be read, so nothing may be pruned. */
export async function appLiveModelPosterKeys(figure: Pick<Project, 'figures' | 'assets'>, figureManifests: Readonly<Record<string, Scene3dManifest | undefined>>,
  io: Scene3dSidecarIO, plotManifest?: (assetId: string) => FluxPlotManifest | undefined): Promise<Set<string> | null> {
  const live = new Set(modelPosterKeys(figure.figures, figure.assets, figureManifests, 'figure'));
  const decks = await readProjectDecks(io);
  if (!decks) return null;
  for (const deck of decks) {
    const doc = await deckModelDocumentFrom(deck, figure, io), options = deckPosterCompileOptions(doc, deck, plotManifest);
    for (const key of deckPosterKeys(doc, deck, () => options)) live.add(key);
  }
  return live;
}
