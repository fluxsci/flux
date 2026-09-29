/** Figure-side 3D agent API. Geometry and edits use the same cores as the app. */
import * as fs from 'node:fs/promises';
import { mutateDeckModel, deckModelDocument } from './model3dDeckCommands';
import { listDecks, loadDeck, deckModelStills } from './slides';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { boundedModelFile, publishModelFile } from './model3dFile';
import { confinedRecoveryPath } from './recovery';
import { loadFigModel, mutateFigModel, safeJoin, stageFigureWrites, exists } from './model';
import { journal } from './journal';
import { FluxError, NotFoundError, ValidationError } from './errors';
import { resolveModelPosters, validModelPosterPng, pruneMachineModelPosters } from './model3dPosterCache';
import { inspectGlb, GLB_LIMITS } from '../src/lib/model3d/glbCore.mjs';
import { prepareModel3dImport, parseModel3dImportMetadata, makeImportedModel3dElement } from '../src/lib/model3d/importData';
import { readScene3dSidecars } from '../src/lib/model3d/persistence';
import { collectModel3dSourceBindings } from '../src/lib/model3d/sourceBinding';
import { applyModelViewCommand, applyModelFieldCommand, commandModels, type ModelViewCommand, type ModelFieldCommand } from '../src/lib/model3d/commandOps';
import { buildModel3dTree } from '../src/lib/model3d/tree';
import { scene3dFields } from '../src/lib/model3d/scene3d';
import { morphCompatible, morphFixHint } from '../src/lib/model3d/morphPair';
import { posterPath, isModelPosterPrunable } from '../src/lib/model3d/poster';
import type { Figure, Project } from '../src/lib/types';
import type { Deck } from '../src/lib/slide/types';
import type { Model3dElement, Model3dAsset, Scene3dManifest } from '../src/lib/model3d/types';

export interface ModelTarget { target: string; figureId?: string; deckId?: string; slideId?: string; noPoster?: boolean }
function figureOnly(target: { deckId?: string; slideId?: string }) {
  if (target.deckId !== undefined || target.slideId !== undefined) throw new Error('A slide selector requires deckId; do not mix Figure and Slides selectors');
}
function targetModel(project: Project, target: ModelTarget): Model3dElement {
  figureOnly(target);
  const element = commandModels(project, [target.target])[0];
  if (target.figureId !== undefined && !project.figures.some(figure => figure.id === target.figureId && figure.elements.includes(element))) throw new Error(`3D target ${target.target} is not in figure ${target.figureId}`);
  return element;
}

/** Shared metadata-only reader: all placements bind accepted metadata to original bytes. */
export async function readModel3dMetadata(root: string, project: Project, assetId: string) {
  const bindings = collectModel3dSourceBindings(project.figures.flatMap(figure => figure.elements));
  return readScene3dSidecars({
    exists: async rel => { const file = safeJoin(root, rel); await confinedRecoveryPath(root, file); return exists(file); },
    readText: async rel => (await boundedModelFile(safeJoin(root, rel), 4 * 1024 * 1024, root)).toString('utf8'),
  }, 'fig/assets', assetId, { binding: bindings.get(assetId) });
}

const contained = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
/** Same boundary as the native import (electron/model3dImport.cjs): an
 * in-project source may not resolve outside the project, and implicit sidecars
 * must resolve inside the real GLB's own directory. */
async function sourceFiles(sourcePath: string, root?: string) {
  const file = path.resolve(sourcePath);
  // Caller mistakes are typed usage errors (non-zero exit / isError); only a
  // readable GLB that fails geometry rules is a model-info refusal (ok:false).
  if (!/\.glb$/i.test(file)) throw new ValidationError(`3D input must be a .glb file (got ${path.basename(file)}); export a triangle mesh as GLB`);
  const real = await fs.realpath(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(`GLB not found: ${file}`);
    throw error;
  });
  if (root && contained(path.resolve(root), file) && !contained(await fs.realpath(root), real)) throw new ValidationError(`Model source symlink escapes the project: ${sourcePath}`);
  const bytes = await boundedModelFile(real, GLB_LIMITS.maxBytes).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(`GLB not found: ${file}`);
    if (String(error).includes('must be a regular file')) throw new ValidationError(`3D input must be a regular .glb file: ${file}`);
    if (String(error).includes('exceeds')) throw new Error(`${(error as Error).message}; re-export a smaller mesh with max_faces or simplify it first`);
    throw error;
  });
  const stem = file.replace(/\.glb$/i, ''), warnings: string[] = [];
  const optional = async (suffix: string) => {
    const name = stem + suffix;
    try {
      const sidecar = await fs.realpath(name);
      if (!contained(path.dirname(real), sidecar)) throw new Error('Sidecar symlink escapes the model source directory');
      return { path: name, text: (await boundedModelFile(sidecar, 4 * 1024 * 1024)).toString('utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${path.basename(name)} could not be read: ${error instanceof Error ? error.message : String(error)}; importing the mesh without this metadata`);
      return undefined;
    }
  };
  const [manifest, recipe] = await Promise.all([optional('.fluxplot.json'), optional('.recipe.json')]);
  return { file, bytes, manifest, recipe, warnings };
}

export async function modelInfo(sourcePath: string, options: { morphWith?: string } = {}) {
  const inspect = async (file: string) => {
    const source = await sourceFiles(file), info = inspectGlb(source.bytes);
    const sha256 = createHash('sha256').update(source.bytes).digest('hex');
    const metadata = await parseModel3dImportMetadata({ info, sourceSha256: sha256, manifestText: source.manifest?.text, recipeText: source.recipe?.text });
    return { path: source.file, sha256, bytes: source.bytes.length, info, metadata, warnings: [...source.warnings, ...metadata.warnings] };
  };
  try {
    const source = await inspect(sourcePath);
    let morph;
    if (options.morphWith) {
      try { const other = await inspect(options.morphWith); morph = { path: other.path, ...morphCompatible(source.info, other.info), warnings: other.warnings }; }
      catch (error) {
        if (error instanceof FluxError) throw error;
        morph = { path: path.resolve(options.morphWith), ok: false, pairs: [], reason: String((error as Error).message ?? error) };
      }
    }
    return { ok: true, path: source.path, sha256: source.sha256, bytes: source.bytes, ...source.info,
      parts: buildModel3dTree(source.metadata.manifest, source.info), fields: scene3dFields(source.metadata.manifest),
      warnings: source.warnings, ...(morph ? { morph: { ...morph, ...(!morph.ok ? { hint: morphFixHint } : {}) } } : {}) };
  } catch (error) {
    if (error instanceof FluxError) throw error;
    return { ok: false, path: path.resolve(sourcePath), reason: String((error as Error).message ?? error) };
  }
}

export async function addModel(root: string, figureId: string, sourcePath: string, options: {
  box?: { x?: number; y?: number; width?: number; height?: number }; view?: ModelViewCommand; name?: string; noPoster?: boolean;
} = {}) {
  const source = await sourceFiles(sourcePath, root);
  const prepared = await prepareModel3dImport({ bytes: source.bytes, assetId: `model-${randomUUID()}`, name: path.basename(source.file), manifestText: source.manifest?.text, recipeText: source.recipe?.text });
  let publishedFile: string | undefined;
  const result = await mutateFigModel(root, 'add_model', async ({ project }) => {
    const figure = project.figures.find(figure => figure.id === figureId);
    if (!figure) throw new Error(`Figure not found: ${figureId}`);
    const data = prepared.data;
    const element = makeImportedModel3dElement({ ...data, source: { glbPath: source.file, ...(source.manifest ? { manifestPath: source.manifest.path } : {}), ...(source.recipe ? { recipePath: source.recipe.path } : {}) } }, { root, name: options.name, box: options.box, figureWidth: figure.width });
    project.assets.push(data.asset); figure.elements.push(element);
    const viewWarnings = options.view ? applyModelViewCommand(project, [element.id], options.view, data.manifest ? { [data.asset.id]: data.manifest } : {}) : [];
    // New immutable bytes publish before the JSON generation can reference them.
    // A later uncertain save failure retains safe unreferenced bytes, never a
    // destructive rollback of a possibly committed model reference.
    const file = safeJoin(root, `fig/${data.asset.path}`);
    await confinedRecoveryPath(root, file); await publishModelFile(root, file, prepared.bytes, true); publishedFile = file;
    const sidecars = new Map<string, string | null>();
    if (data.raw?.manifest !== undefined) sidecars.set(`fig/assets/${data.asset.id}.fluxplot.json`, data.raw.manifest);
    if (data.raw?.recipe !== undefined) sidecars.set(`fig/assets/${data.asset.id}.recipe.json`, data.raw.recipe);
    stageFigureWrites(project, sidecars);
    return { elementId: element.id, assetId: data.asset.id, parts: buildModel3dTree(data.manifest, data.asset.model), warnings: [...source.warnings, ...data.warnings, ...viewWarnings] };
  }).catch(error => {
    if (!publishedFile) throw error;
    throw new Error(`${String((error as Error).message ?? error)}. Stored GLB retained at ${publishedFile}. Reload the figure before retrying; remove this file only after confirming it is unreferenced.`, { cause: error });
  });
  const poster = options.noPoster ? { warnings: [], poster: null } : await ensureModelPoster(root, figureId, result.elementId);
  return { ...result, ...poster, warnings: [...new Set([...result.warnings, ...poster.warnings])] };
}

/** A committed mutation stays successful even when its derived poster fails. */
export async function ensureModelPoster(root: string, figureId: string, elementId: string) {
  try {
    const rendered = await renderModelPosters(root, { figureId });
    return { warnings: rendered.warnings, poster: rendered.posters.find(poster => poster.elementId === elementId) ?? null };
  } catch (error) { return { warnings: [`Model saved; poster could not be rendered: ${String(error)}`], poster: null }; }
}

export async function setModelViewCommand(root: string, target: ModelTarget, command: ModelViewCommand) {
  if(target.deckId) {
    const result=await mutateDeckModel(root,target,'view',command);
    try { const rendered=target.noPoster?undefined:await renderModelPosters(root,{deckId:target.deckId,slideId:result.slideId});return {...result,poster:rendered?.posters.find(p=>p.elementId===result.element.id)??null,warnings:[...result.warnings,...rendered?.warnings??[]]}; }
    catch(error) {return {...result,poster:null,warnings:[...result.warnings,`Model saved; poster could not be rendered: ${String(error)}`]};}
  }
  const result = await mutateFigModel(root, 'set_model_view', async ({ project }) => {
    const element = targetModel(project, target), metadata = await readModel3dMetadata(root, project, element.assetId);
    const viewWarnings = applyModelViewCommand(project, [element.id], command, metadata.manifest ? { [element.assetId]: metadata.manifest } : {});
    return { element: structuredClone(element), figureId: project.figures.find(figure => figure.elements.includes(element))!.id, warnings: [...metadata.issues ?? [], ...viewWarnings] };
  });
  const poster = target.noPoster ? { warnings: [], poster: null } : await ensureModelPoster(root, result.figureId, result.element.id);
  return { ...result, ...poster, warnings: [...new Set([...result.warnings, ...poster.warnings])] };
}
export async function setModelFieldCommand(root: string, target: ModelTarget, command: ModelFieldCommand) {
  if(target.deckId) {
    const result=await mutateDeckModel(root,target,'field',command);
    try { const rendered=target.noPoster?undefined:await renderModelPosters(root,{deckId:target.deckId,slideId:result.slideId});return {...result,poster:rendered?.posters.find(p=>p.elementId===result.element.id)??null,warnings:[...result.warnings,...rendered?.warnings??[]]}; }
    catch(error) {return {...result,poster:null,warnings:[...result.warnings,`Model saved; poster could not be rendered: ${String(error)}`]};}
  }
  const result = await mutateFigModel(root, 'set_model_field', async ({ project }) => {
    const element = targetModel(project, target), metadata = await readModel3dMetadata(root, project, element.assetId);
    applyModelFieldCommand(project, [element.id], command, metadata.manifest ? { [element.assetId]: metadata.manifest } : {});
    return { element: structuredClone(element), figureId: project.figures.find(figure => figure.elements.includes(element))!.id, warnings: metadata.issues ?? [] };
  });
  const poster = target.noPoster ? { warnings: [], poster: null } : await ensureModelPoster(root, result.figureId, result.element.id);
  return { ...result, ...poster, warnings: [...new Set([...result.warnings, ...poster.warnings])] };
}

/** A deck's poster inputs: each slide's Design placements (the editor's Design
 * still) plus every build step's still (deckModelStills, the enumeration payload
 * gathering uses). Step stills ride carrier figures, one per slide and step,
 * with no groups and nothing hidden: the payload gathers a still for every
 * sampled placement. Part states are keyed by the carrier element itself. */
async function deckPosterInputs(root: string, deck: Deck, slideId?: string) {
  const doc = await deckModelDocument(root, deck);
  const design = slideId ? doc.project.figures.filter(figure => figure.id === slideId) : doc.project.figures;
  const carriers = new Map<string, Figure>(), states = new Map<Model3dElement, Record<string, { opacity: number; visible: boolean }>>();
  for (const still of await deckModelStills(root, deck, doc.manifests, slideId)) {
    const owner = doc.project.figures.find(figure => figure.id === still.slideId);
    if (!owner) continue;
    let carrier = carriers.get(`${still.slideId}\0${still.step}`);
    if (!carrier) {
      const { groups: _groups, elements: _elements, ...frame } = owner;
      carriers.set(`${still.slideId}\0${still.step}`, carrier = { ...frame, elements: [] });
    }
    const element: Model3dElement = { ...still.element, hidden: false };
    carrier.elements.push(element);
    if (still.partStates) states.set(element, still.partStates);
  }
  return { doc, design, figures: [...design, ...carriers.values()], partStates: (element: Model3dElement) => states.get(element) };
}

export async function renderModelPosters(root: string, options: { figureId?: string; deckId?: string; slideId?: string; prune?: boolean; signal?: AbortSignal } = {}) {
  if(options.deckId && options.figureId || options.slideId && !options.deckId) throw new Error('Use deckId with optional slideId, or figureId');
  // Derived, content-addressed cache writes are intentionally outside document
  // leases (PLAN4.5). A GPU job must not hold a figure writer hostage.
  const result = await (async () => {
    // A deck renders its Design stills and every build step's still, so read-only
    // readers (Connect sheets, CLI Paper renders) find each step's own picture.
    const deck = options.deckId ? await deckPosterInputs(root, await loadDeck(root, options.deckId), options.slideId) : undefined;
    const project = deck ? deck.doc.project : (await loadFigModel(root)).project;
    const filter=options.deckId?options.slideId:options.figureId;
    const design=deck ? deck.design : filter?project.figures.filter(figure=>figure.id===filter):project.figures;
    if(filter && !design.length)throw new Error(`Model document page not found: ${filter}`);
    const rendered = await resolveModelPosters(root, deck ? deck.figures : design, project.assets, { policy: 'project', allFigures: project.figures, signal: options.signal, ...(deck?{assetPrefix:'',surface:'slide' as const,manifests:deck.doc.manifests,partStates:deck.partStates}:{}) });
    if(deck)rendered.warnings.push(...deck.doc.warnings);
    const posters = [], listed = new Set<string>();
    for (const request of rendered.requests) {
      options.signal?.throwIfAborted();
      // Steps that leave a placement unchanged share its still: report it once.
      if (listed.has(`${request.element.id}\0${request.key}`)) continue;
      listed.add(`${request.element.id}\0${request.key}`);
      const url = rendered.urls[request.ref], file = safeJoin(root, posterPath(request.key));
      const bytes = url?.startsWith('data:image/png;base64,') ? Buffer.from(url.slice('data:image/png;base64,'.length), 'base64') : undefined;
      const ready = !!bytes && validModelPosterPng(bytes, request);
      // A validated machine-cache hit also becomes a project cache on this
      // explicitly mutating verb. Ordinary Connect collection stays cold.
      if (ready) {
        await confinedRecoveryPath(root, file);
        const existing = await boundedModelFile(file, 300 * 1024 * 1024, root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' || error.message.includes('exceeds')) return undefined; throw error; });
        if (!existing?.equals(bytes!)) { await publishModelFile(root, file, bytes!); }
      }
      posters.push({ elementId: request.element.id, key: request.key, path: ready ? file : null, ready, width: request.w, height: request.h });
    }
    const removed: string[] = [], machineRemoved: string[] = [];
    if (options.prune) {
      // Rendering may outlive a save in another window/process. Protect the
      // current saved references, including views added during that render.
      const live = new Set<string>(), unreadable: string[] = [];
      const protect = async (label: string, collect: () => Promise<readonly { key: string }[]>) => {
        try { for (const request of await collect()) live.add(request.key); }
        catch (error) { options.signal?.throwIfAborted(); unreadable.push(`${label} (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`); }
      };
      await protect('Figures', async () => {
        const current = (await loadFigModel(root)).project;
        return (await resolveModelPosters(root, current.figures, current.assets, { policy: 'collect', allFigures: current.figures, signal: options.signal })).requests;
      });
      // The project cache is shared by Figures and every deck. Never prune a
      // live slide still just because this command filtered another document.
      const decks = await listDecks(root).catch(error => { unreadable.push(`the deck registry (${error instanceof Error ? error.message : String(error)})`); return []; });
      // Every build step's still of every deck is live, not only Design stills.
      for (const entry of decks) await protect(`deck ${entry.id}`, async () => {
        const inputs = await deckPosterInputs(root, await loadDeck(root, entry.id));
        return (await resolveModelPosters(root, inputs.figures, inputs.doc.project.assets, { policy: 'collect', assetPrefix: '', surface: 'slide', manifests: inputs.doc.manifests, partStates: inputs.partStates, signal: options.signal })).requests;
      });
      // A document that cannot be read (missing, newer or unparsable) has
      // unknown live posters, so the shared project cache is kept whole. The
      // posters above are rendered and journaled regardless.
      if (unreadable.length) rendered.warnings.push(`3D poster cache fig/renders/model3d was not pruned: could not read ${unreadable.join('; ')}`);
      else {
        const dir = safeJoin(root, 'fig/renders/model3d');
        await confinedRecoveryPath(root, dir);
        for (const name of await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
          const file = safeJoin(dir, name); await confinedRecoveryPath(root, file);
          const stat = await fs.lstat(file);
          if (!stat.isFile() || !isModelPosterPrunable(name, stat.mtimeMs, live)) continue;
          options.signal?.throwIfAborted(); await fs.rm(file); removed.push(name);
        }
      }
      // The shared machine cache (filled by read-only image requests) is bounded
      // by the same age rule plus a size cap; this project's live keys survive.
      machineRemoved.push(...await pruneMachineModelPosters({ protect: live }));
    }
    return { posters, warnings: rendered.warnings, removed, ...(options.prune ? { machineRemoved } : {}) };
  })();
  options.signal?.throwIfAborted();
  await journal(root, { action: 'render_model_posters', posters: result.posters.length, pruned: result.removed.length });
  return result;
}
