import { elementAssetRefs, elementSourceAssetIds } from "../model3d/refs";
import { storedAssetPath } from "./assetPath";
// IO-injected complete snapshot reader. No store/cache/baseline is published while
// reading. Preview callers may inspect partial data; mutation requires complete.
import type { Project, Figure } from '../types';
import { sortedCanvasMeta, normalizeIndexAssets, type FigIndexFile, type CanvasFile } from './figfiles';
import { FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION, isNewerSchema, newerSchemaMessage } from './types';
import { familyHintsFrom, migrateFigureFamilies, migrateProject } from '../migrate';
import { ensureFigureReferenceKeys } from './figureIdentity';
import { validateFigIndexFile, validateModel, validateFigureIdentities } from './validate';
import { reconcileCaptionFiles, type CaptionBaseline } from './captionReconcile';
export interface FigureSnapshotIO {
  readText(rel: string): Promise<string | null>;
  /** Metadata-only existence check; never loads binary model contents. */
  assetExists?(rel: string): Promise<boolean>;
  /** Missing directories return null; permission/IO failures must propagate.
   * Required only when the index is absent, to prove this is a fresh subsystem. */
  listDirectory?(rel: string): Promise<{ name: string; dir: boolean }[] | null>;
}
export interface FigureSnapshot {
  status: 'complete' | 'partial' | 'future-version' | 'failed';
  project: Project; index: FigIndexFile | null;
  missingIndexInventory?: 'empty' | 'existing' | 'unavailable';
  baselines: Map<string, string | null>; captionBaselines: Map<string, CaptionBaseline>;
  diagnostics: { path: string; message: string }[];
  /** Non-blocking asset problems (a referenced GLB file is missing). The model is
   * still complete: read paths show a placeholder, mutations (for example deleting
   * the broken element) remain possible. */
  assetIssues: FigureAssetIssue[];
}
export interface FigureAssetIssue { path: string; message: string; assetId: string; figureId: string; elementId: string }
/** One wording for every surface that reports a missing model file. */
export function missingModelFileMessage(file: string, element: { id: string; name?: string }, figure: { id: string; name?: string }): string {
  const label = element.name ? `"${element.name}" (${element.id})` : element.id;
  const owner = figure.name && figure.name !== figure.id ? `"${figure.name}" (${figure.id})` : figure.id;
  return `3D model file ${file} is missing for element ${label} in figure ${owner}: restore ${file} or delete the element`;
}
export async function readFigureSnapshot(io: FigureSnapshotIO): Promise<FigureSnapshot> {
  const project: Project = { version: 2, name: '', canvases: [], figures: [], assets: [], palette: [], colorGroups: [] };
  const result: FigureSnapshot = { status: 'complete', project, index: null, baselines: new Map(), captionBaselines: new Map(), diagnostics: [], assetIssues: [] };
  const problem = (file: string, message: string, status: FigureSnapshot['status'] = 'partial') => {
    result.diagnostics.push({ path: file, message });
    if (result.status !== 'future-version') result.status = status;
  };
  const read = async (file: string) => { const value = await io.readText(file); result.baselines.set(file, value); return value; };
  let index: FigIndexFile | null = null;
  try {
    const text = await read('fig/index.json');
    if (text !== null) {
      index = JSON.parse(text);
      if (index && isNewerSchema(index.schemaVersion, FIG_INDEX_SCHEMA_VERSION)) problem('fig/index.json', newerSchemaMessage("Figure index", index.schemaVersion, FIG_INDEX_SCHEMA_VERSION), 'future-version');
      const errors = validateFigIndexFile(index);
      if (errors.length) { problem('fig/index.json', errors.join('; '), 'failed'); return result; }
    }
  } catch (error) { problem('fig/index.json', String(error), 'failed'); return result; }
  result.index = index;
  if (!index) {
    result.missingIndexInventory = 'unavailable';
    // ENOENT for the index alone does not mean the authored subsystem is empty.
    // Never adopt a fresh writable model over orphaned canvases/assets/captions
    // or the previous generation's recoverable index.
    try {
      if (!io.listDirectory) throw new Error('Cannot establish an empty figure subsystem: directory inventory is unavailable');
      const entries = await io.listDirectory('fig');
      for (const entry of entries ?? []) if (/^index\.json(?:\.|$)/.test(entry.name)) {
        problem(`fig/${entry.name}`, 'Figure index is missing but an existing index or recovery copy remains');
      }
      for (const directory of ['canvases', 'assets', 'captions']) {
        const files = await io.listDirectory(`fig/${directory}`);
        if (files?.length) problem(`fig/${directory}`, 'Figure index is missing but existing figure data remains');
      }
      const manifestText = await read('project.json');
      if (manifestText !== null) {
        const manifest = JSON.parse(manifestText);
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || (manifest.figures !== undefined && !Array.isArray(manifest.figures))) throw new Error('Cannot establish an empty figure subsystem from invalid project.json');
        if (manifest.figures?.length) problem('project.json', 'Figure index is missing but figures remain registered in the project');
      }
      result.missingIndexInventory = result.status === 'complete' ? 'empty' : 'existing';
    } catch (error) { problem('fig/index.json', String(error), 'failed'); }
    if (result.status === 'complete') migrateProject(project);
    return result;
  }
  const metadata = sortedCanvasMeta(index);
  project.canvases = metadata.map(({ id, name }) => ({ id, name }));
  project.assets = normalizeIndexAssets(index);
  for (const asset of project.assets) if (asset.path) {
    try { storedAssetPath(asset.path); } catch (error) { problem('fig/index.json', `${asset.id}: ${String(error)}`); }
  }
  project.palette = index.palette ?? [];
  project.colorGroups = (index.colorGroups ?? []) as Project['colorGroups'];
  if (index.textStyles !== undefined) project.textStyles = index.textStyles;
  if (index.families !== undefined) project.figureFamilies = index.families;
  // Diagnose index identity before maps/migrations can collapse records.
  const unique = (items: {id?: string}[], prefix: string) => {
    const seen = new Map<string, number>();
    items.forEach((item, n) => {
      if (typeof item.id !== 'string' || !item.id || /[\\/\x00]/.test(item.id) || ['__proto__','constructor','prototype'].includes(item.id)) problem('fig/index.json', `${prefix}[${n}].id is unsafe`);
      else if (seen.has(item.id)) problem('fig/index.json', `${prefix}[${seen.get(item.id)}] and ${prefix}[${n}] duplicate id ${item.id}`);
      else seen.set(item.id, n);
    });
  };
  unique(index.canvases, 'canvases'); unique(index.figures, 'figures'); unique(index.assets ?? [], 'assets');
  if (result.status !== 'complete') return result;
  for (const cm of metadata) {
    const rel = `fig/canvases/${cm.id}.json`;
    try {
      const text = await read(rel);
      if (text === null) {
        // Legacy empty canvases may not have a file; referenced content may not.
        if (index.figures.some(f => f.canvas === cm.id)) problem(rel, 'Missing referenced canvas');
        continue;
      }
      const cf = JSON.parse(text) as CanvasFile;
      if (isNewerSchema(cf.schemaVersion, CANVAS_SCHEMA_VERSION)) { problem(rel, newerSchemaMessage("Canvas", cf.schemaVersion, CANVAS_SCHEMA_VERSION), 'future-version'); continue; }
      if (cf.id != null && cf.id !== cm.id) { problem(rel, `Canvas id ${cf.id} disagrees with index id ${cm.id}`); continue; }
      if (Array.isArray(cf.figures) && cf.figures.some(f=>f.canvasId != null && f.canvasId !== cm.id)) { problem(rel, `Figure owning canvas disagrees with ${cm.id}`); continue; }
      if (!Array.isArray(cf.figures)) { problem(rel, 'figures must be an array'); continue; }
      const probe = { ...project, canvases: [{ id: cm.id, name: cm.name }], figures: cf.figures.map(f => ({ ...f, canvasId: cm.id })) };
      const rawErrors = validateFigureIdentities(probe);
      if (rawErrors.length) { problem(rel, rawErrors.join('; ')); continue; }
      migrateProject(probe);
      const errors = validateModel(probe);
      if (errors.length) { problem(rel, errors.join('; ')); continue; }
      project.figures.push(...probe.figures);
    } catch (error) { problem(rel, String(error)); }
  }
  const rawErrors = validateFigureIdentities(project);
  if (rawErrors.length) { problem('fig/', rawErrors.join('; ')); return result; }
  migrateProject(project);
  migrateFigureFamilies(project, familyHintsFrom(index.figures));
  ensureFigureReferenceKeys(project, index);
  for (const message of validateModel(project)) problem('fig/', message);
  for (const entry of index.figures) {
    const found = project.figures.find(f => f.id === entry.id);
    if (!found || found.canvasId !== entry.canvas) problem('fig/index.json', `Figure ${entry.id} does not exist in owning canvas ${entry.canvas}`);
  }
  const assets = new Set(project.assets.map(a => a.id));
  for (const figure of project.figures) for (const element of figure.elements) {
    for (const id of elementSourceAssetIds(element)) if (!assets.has(id)) problem(`fig/canvases/${figure.canvasId}.json`, `Figure ${figure.id}, element ${element.id}: missing asset ${id}`);
  }
  // Only GLB files that a figure element places matter to this snapshot. A
  // missing one is an asset issue, not a partial model: every canvas and the
  // index were read completely, so saving cannot lose data and the user or an
  // agent must still be able to repair the figure (for example delete it).
  // Unsafe or unreadable locations remain blocking diagnostics.
  if (io.assetExists) {
    const placed = new Map<string, { figure: Figure; element: Figure['elements'][number] }>();
    for (const figure of project.figures) for (const element of figure.elements) {
      for (const id of elementAssetRefs(element).models) if (!placed.has(id)) placed.set(id, { figure, element });
    }
    for (const asset of project.assets) if (asset.kind === "glb" && asset.path && placed.has(asset.id)) {
      try {
        const file = `fig/${storedAssetPath(asset.path)}`;
        if (!await io.assetExists(file)) {
          const { figure, element } = placed.get(asset.id)!;
          result.assetIssues.push({ path: file, assetId: asset.id, figureId: figure.id, elementId: element.id, message: missingModelFileMessage(file, element, figure) });
        }
      } catch (error) { problem(asset.path, String(error)); }
    }
  }
  try {
    const captions = await reconcileCaptionFiles(project, index, read);
    result.captionBaselines = captions.baselines;
    for (const conflict of captions.conflicts) problem('fig/captions', JSON.stringify(conflict));
  } catch (error) { problem('fig/captions', String(error)); }
  return result;
}
export function requireCompleteFigureSnapshot(snapshot: FigureSnapshot, intent: 'modify' | 'read' = 'modify'): FigureSnapshot & {status: 'complete'} {
  if (snapshot.status !== 'complete') throw new Error(`Cannot ${intent} ${snapshot.status} figure snapshot: ${snapshot.diagnostics.map(d => `${d.path}: ${d.message}`).join('\n')}`);
  return snapshot as FigureSnapshot & {status: 'complete'};
}
