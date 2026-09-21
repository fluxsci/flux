import { stageFigureRegistration } from "../src/lib/project/figureGeneration";
import { commitTextGeneration, recoverTextGeneration } from "../src/lib/project/textGeneration";
import { exportRecoveryIO } from "./recovery";
import { storedAssetPath } from "../src/lib/project/assetPath";
import { updateManifest } from "./manifest";
import { decodeManifest } from "../src/lib/project/manifestTransaction";
// flux-core/model.ts — the Flux project/figure model over Node fs (split out
// of index.ts; WS-6.2): fs helpers + project-root path safety, project.json
// and fig/ index/canvas-file IO, and the W3 load→mutate→save chokepoint
// (mutateFigModel) every mutating fig verb goes through.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { panelLetters, composeCaption } from "../src/lib/captions";
import { withLock, assertLockOwned, type LockLease } from "./locks";
import { CLIENT, j, stamp, journal } from "./journal";
import { atomicWrite, fsyncDir } from "./fsx";
import type { Figure, Project, Asset, Canvas } from "../src/lib/types";
import { familyHintsFrom, migrateFigureFamilies, migrateProject } from "../src/lib/migrate";
import { kindForFamily } from "../src/lib/figfamily";
import { ensureFigureReferenceKeys } from "../src/lib/project/figureIdentity";
import { reconcileCaptionFiles, captionConflictMessage, type CaptionBaseline } from "../src/lib/project/captionReconcile";
import { readFigureSnapshot, requireCompleteFigureSnapshot, type FigureSnapshotIO } from "../src/lib/project/figureSnapshot";
import { validateModel, sanitizeProjectGeometry } from "../src/lib/project/validate";
import { confinedReferenceSyncIO, prepareFigureReferenceUpdate, commitFigureReferenceUpdate, recoverFigureReferenceUpdate, releaseFigureReferenceUpdate } from "../src/lib/project/figureReferenceSync";
import type { ProjectManifest, FigureEntry } from "../src/lib/project/types";
import { isNewerSchema, newerSchemaMessage, FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION } from "../src/lib/project/types";
import {
  planFigSave,
  executeFigSave,
  sortedCanvasMeta,
  normalizeIndexAssets,
  type FigIndexFile,
  type CanvasFile,
} from "../src/lib/project/figfiles";
export type { FigIndexFile };

// --------------------------------------------------------------------------
// fs helpers + project-root path safety (M9: never escape the project root)
// --------------------------------------------------------------------------

/** Resolve `rel` under `root`, throwing if it would escape the project root. */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return abs;
}

/** Existing project-owned input: lexical AND realpath confinement. */
export async function projectAssetPath(root: string, rel: string): Promise<string> {
  const filename = safeJoin(root, storedAssetPath(rel));
  const [base, real] = await Promise.all([fs.realpath(root), fs.realpath(filename)]);
  const relative = path.relative(base,real);
  if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error(`Asset symlink escapes project root: ${rel}`);
  return real;
}

/** AGT-5: validate an id that becomes a path segment (figure/canvas ids from CLI/MCP
 *  flags like `--id` / `--canvas`). Rejects path separators, null bytes, and a leading
 *  dot so a crafted `--id ../../x` can't write outside the project tree — with a clear
 *  message, before safeJoin's generic "escapes root" backstop would fire. */
export function safeId(kind: string, id: string): string {
  if (!id || /[\\/\x00]/.test(id) || id.startsWith(".")) {
    throw new Error(`unsafe ${kind} id ${JSON.stringify(id)}: no path separators or leading dot`);
  }
  return id;
}

export async function readJSON<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
export async function writeText(p: string, t: string): Promise<void> {
  await atomicWrite(p, t); // W2: durable tmp+fsync+rename for every canonical write
}
const referenceFileIO = {
  readText: (p: string) => fs.readFile(p, "utf8"), exists, writeText,
  remove: (p: string) => fs.rm(p, { force: true }),
  readdir: async (p: string) => (await fs.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() })),
};

export function referenceSyncIO(root: string) {
  return confinedReferenceSyncIO(root, referenceFileIO, rel => generationIO(root).validatePath(rel),
    work => withLock(root, 'manuscript', CLIENT, lease => work(() => assertLockOwned(lease))),
    work => withLock(root, 'figure-references', CLIENT, lease => work(() => assertLockOwned(lease))));
}

// --------------------------------------------------------------------------
// on-disk shapes + writer plan: the ONE persistence core shared with the GUI
// (src/lib/project/figfiles.ts, WS-5.6) — this engine keeps only its own
// concerns: Node fs, locks, journal, manifest reindex.
// --------------------------------------------------------------------------

/** Fail fast with a DIAGNOSIS when root isn't a Flux project. Verbs used to
 *  fail on whatever file they touched first ("figure not found", raw ENOENT on
 *  project.json) — all true, none pointing at the actual mistake (wrong dir,
 *  usually a stale $FLUX_PROJECT). Suggests the nearest real project root. */
export async function requireProject(root: string): Promise<void> {
  if (await exists(j(root, "project.json"))) return;
  const near = await findProjectRoot(root);
  throw new Error(
    `${root} is not a Flux project (no project.json)` +
      (near ? ` — did you mean ${near}?` : " — check --root / $FLUX_PROJECT / cwd"),
  );
}

export async function loadManifest(root: string): Promise<ProjectManifest> {
  await requireProject(root);
  await recoverFigureReferenceUpdate(root, referenceSyncIO(root));
  return decodeManifest(await fs.readFile(j(root, "project.json"), "utf8"));
}
/** Whole-object manifest replacement is deliberately unavailable: callers must
 * express intent through updateManifest so unrelated registrations survive. */
export { updateManifest } from './manifest';
export async function readFigIndex(root: string): Promise<FigIndexFile | null> {
  const p = j(root, "fig", "index.json");
  const idx = (await exists(p)) ? await readJSON<FigIndexFile>(p) : null;
  // WS-5.2 forward-version guard: never migrate a NEWER fig format down.
  if (idx && isNewerSchema(idx.schemaVersion, FIG_INDEX_SCHEMA_VERSION))
    throw new Error(newerSchemaMessage("fig/index.json", idx.schemaVersion, FIG_INDEX_SCHEMA_VERSION));
  return idx;
}
function figureSnapshotIO(root: string): FigureSnapshotIO {
  const io = exportRecoveryIO(root);
  return {
    readText: rel => io.readText(safeJoin(root, rel)),
    listDirectory: async rel => {
      const absolute = safeJoin(root, rel);
      await io.validatePath!(absolute);
      try { return (await fs.readdir(absolute, { withFileTypes: true })).map(entry => ({ name: entry.name, dir: entry.isDirectory() })); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
  };
}
export async function readCanvasFiles(
  root: string,
  idx: FigIndexFile,
): Promise<{ byId: Record<string, Figure>; canvasOf: Record<string, string> }> {
  const snapshot = requireCompleteFigureSnapshot(await readFigureSnapshot(figureSnapshotIO(root)));
  const byId: Record<string, Figure> = Object.create(null);
  const canvasOf: Record<string, string> = Object.create(null);
  for (const figure of snapshot.project.figures) { byId[figure.id] = figure; canvasOf[figure.id] = figure.canvasId; }
  return { byId, canvasOf };
}

// --------------------------------------------------------------------------
// the figure model as a Project (so flux-core mutates via the shared pure ops
// core, exactly like the GUI). loadFigModel reads index + canvas files into a
// Project; saveFigModel writes the canvas files + index rollup + reindexes.
// --------------------------------------------------------------------------
const emptyIndex = (): FigIndexFile => ({
  schemaVersion: "0.1.0",
  canvases: [],
  figures: [],
  assets: [],
  palette: [],
  colorGroups: [],
});
const stagedFigureWrites = new WeakMap<Project, Map<string,string|null>>();
export function stageFigureWrites(project: Project, writes: Map<string,string|null>) { stagedFigureWrites.set(project,writes); }
function generationIO(root: string) {
  const io=exportRecoveryIO(root);
  return {validatePath:(rel:string)=>io.validatePath!(safeJoin(root,rel)),read:(rel:string)=>io.readText(safeJoin(root,rel)),write:(rel:string,text:string)=>io.writeText(safeJoin(root,rel),text),remove:(rel:string)=>io.removeFile(safeJoin(root,rel)),fsyncDir: (rel: string) => fsyncDir(safeJoin(root, rel)),readBytes:async(rel:string)=>{await io.validatePath?.(safeJoin(root,rel));try{return await fs.readFile(safeJoin(root,rel))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}},writeBytes:async(rel:string,bytes:Uint8Array)=>{await io.validatePath?.(safeJoin(root,rel));await atomicWrite(safeJoin(root,rel),bytes)}};
}
const acceptedFiles = new WeakMap<Project, Map<string,string|null>>();
const acceptedCaptions = new WeakMap<Project, Map<string, CaptionBaseline>>();

export async function loadFigModel(root: string): Promise<{ project: Project; index: FigIndexFile }> {
  // A missing fig/index.json is writable only after an empty inventory — a missing
  // project.json means this isn't a Flux project at all: without the guard a
  // mutate verb sees an empty model and reports "figure not found" instead.
  await requireProject(root);
  await recoverFigureReferenceUpdate(root, referenceSyncIO(root));
  const snapshot = requireCompleteFigureSnapshot(await readFigureSnapshot(figureSnapshotIO(root)));
  const project = snapshot.project, index = snapshot.index ?? emptyIndex();
  acceptedCaptions.set(project, snapshot.captionBaselines);
  acceptedFiles.set(project, snapshot.baselines);
  return { project, index };
}

export async function saveFigModel(
  root: string,
  project: Project,
  index: FigIndexFile,
  action = "save_fig",
): Promise<void> {
  // WS6: an agent file-write defers (throws) rather than clobbering an in-flight
  // human edit (the GUI holds the "project" lock while actively editing). Then journal.
  await withLock(root, "project", CLIENT, async lease => { await withLock(root,"slides",CLIENT,slidesLease=>withLock(root,"manifest",CLIENT,manifestLease=>recoverTextGeneration(generationIO(root),async()=>{await assertLockOwned(lease);await assertLockOwned(slidesLease);await assertLockOwned(manifestLease)}))); await saveFigModelUnlocked(root, project, index, lease); });
  await journal(root, { action, figures: project.figures.map((f) => f.id) });
}

/** W3: run a read→mutate→write cycle atomically under the "project" lock, so two
 *  agents (or an agent racing the GUI's save) can never interleave a lost update —
 *  the load happens INSIDE the lock. All mutating fig verbs go through this. */
export async function mutateFigModel<T>(
  root: string,
  action: string,
  fn: (m: { project: Project; index: FigIndexFile }) => T | Promise<T>,
  opts: { changed?: (result: T) => boolean } = {},
): Promise<T> {
  let out!: T;
  let figIds: string[] = [];
  let changed = true;
  await withLock(root, "project", CLIENT, async lease => {
    await withLock(root,"slides",CLIENT,slidesLease=>withLock(root,"manifest",CLIENT,manifestLease=>recoverTextGeneration(generationIO(root),async()=>{await assertLockOwned(lease);await assertLockOwned(slidesLease);await assertLockOwned(manifestLease)})));
    const m = await loadFigModel(root);
    out = await fn(m);
    changed = opts.changed?.(out) ?? true;
    figIds = m.project.figures.map((f) => f.id);
    if (changed) await saveFigModelUnlocked(root, m.project, m.index, lease);
  });
  if (changed) await journal(root, { action, figures: figIds });
  return out;
}

async function saveFigModelUnlocked(
  root: string,
  project: Project,
  index: FigIndexFile,
  lease: LockLease,
): Promise<void> {
  for (const [rel,before] of acceptedFiles.get(project) ?? []) {
    if (rel === "project.json" || rel.startsWith("fig/captions/")) continue; // separately reconciled as authored text
    const current=await generationIO(root).read(rel);
    if (current!==before) throw new Error(`Figures changed outside this operation: ${rel}. Reload before saving.`);
  }
  const captions = await reconcileCaptionFiles(project, index, async rel =>
    fs.readFile(safeJoin(root, rel), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }), acceptedCaptions.get(project));
  if (captions.conflicts.length) throw new Error(captionConflictMessage(captions.conflicts));
  const errors = validateModel(project);
  if (errors.length) throw new Error(`Figure compositions could not be saved: ${errors.slice(0, 5).join("; ")}`);
  // WS-5.6: the write set (canvases + captions + index) comes from the ONE
  // persistence core shared with the GUI. `index` (the loaded, possibly
  // verb-mutated rollup) is the prev: labels/kinds persist through it. The
  // executor owns the WS-5.3 ordering (canvases → dir fsync → captions →
  // index LAST + .bak → dir fsync) and skips byte-identical rewrites.
  const plan = planFigSave(project, index, acceptedFiles.get(project));
  const before = await readCanvasFiles(root, index);
  const referenceUpdate = await prepareFigureReferenceUpdate(root, Object.values(before.byId), project.figures, referenceSyncIO(root), {
    index, figureFiles: [...plan.canvases, plan.index],
  });
  try {
    const io = generationIO(root), writes = stagedFigureWrites.get(project) ?? new Map<string,string|null>();
    await executeFigSave(plan,{read:io.read,write:async(rel,text)=>{writes.set(rel,text)}});
    await withLock(root,"manifest",CLIENT,async manifestLease => {
      await stageFigureRegistration(io, JSON.parse(plan.index.text), writes);
      await commitTextGeneration(io,writes,async()=>{await assertLockOwned(lease);await assertLockOwned(manifestLease)});
    });
    stagedFigureWrites.delete(project);
    const baselines=acceptedFiles.get(project) ?? new Map<string,string|null>();
    for(const [rel,text] of writes) baselines.set(rel,text);
    acceptedFiles.set(project,baselines);
  } catch (e) { await releaseFigureReferenceUpdate(root, referenceUpdate); throw e; }
  await commitFigureReferenceUpdate(root, referenceUpdate, referenceSyncIO(root));
  acceptedCaptions.set(project, new Map(project.figures.map(f => [f.id, { model: composeCaption(f).trim(), sidecar: composeCaption(f) + "\n" }])));
}

// --------------------------------------------------------------------------
// verbs
// --------------------------------------------------------------------------

/** reindex: rebuild project.json.figures[] from fig/index.json (spec §7). */
export async function reindex(root: string): Promise<{ figures: number }> {
  const manifest = await loadManifest(root);
  const index = await readFigIndex(root);
  const figures: FigureEntry[] = (index?.figures ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    label: f.label,
    order: f.order,
    kind: f.family ? kindForFamily(f.family) : f.kind === "supplementary" ? "supplementary" : "main",
    ...(f.family ? { family: f.family } : {}),
    ...(f.number != null ? { number: f.number } : {}),
    ...(f.nickname ? { nickname: f.nickname } : {}),
    canvas: f.canvas,
    caption: `fig/captions/${f.id}.md`,
  }));
  manifest.figures = figures;
  manifest.figureFamilies = index?.families ?? [];
  await updateManifest(root, fresh => {
    fresh.figures = manifest.figures;
    if (manifest.figureFamilies !== undefined) fresh.figureFamilies = manifest.figureFamilies;
  });
  return { figures: figures.length };
}

/** list_project: a compact overview of documents, figures, references.
 *  `elements` makes empty/placeholder figures visible at a glance — a 0-element
 *  figure sitting at order 1 silently shifts every other figure's number. */
export async function listProject(root: string): Promise<{
  title: string;
  documents: string[];
  figures: {
    id: string;
    label: string;
    name: string;
    order: number;
    family?: string;
    number?: number;
    nickname?: string;
    panels: string[];
    elements: number;
  }[];
  references: string | null;
}> {
  const manifest = await loadManifest(root);
  const index = await readFigIndex(root);
  const { byId } = index ? await readCanvasFiles(root, index) : { byId: {} as Record<string, Figure> };
  return {
    title: manifest.title,
    documents: [
      manifest.manuscript.path,
      ...(manifest.supplementary ?? []).map((s) => s.path),
    ].filter(Boolean),
    figures: (index?.figures ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      name: f.name,
      order: f.order,
      ...(f.family ? { family: f.family } : {}),
      ...(f.number != null ? { number: f.number } : {}),
      ...(f.nickname ? { nickname: f.nickname } : {}),
      panels: byId[f.id] ? panelLetters(byId[f.id]) : [],
      elements: byId[f.id]?.elements.length ?? 0,
    })),
    references: manifest.references?.library ?? null,
  };
}

export async function findProjectRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (await exists(path.join(dir, "project.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
