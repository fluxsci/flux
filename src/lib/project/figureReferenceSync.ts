// IO-injected two-phase reference reconciliation. A pending journal retains
// every original document until figure persistence and manuscript rewrites
// have both finished. Recovery only writes an exactly matching baseline.
import type { Figure } from "../types";
import type { DependencyIO } from "./dependencies";
import {
  applyReferenceReplacements, changedReferenceFigures, planFigureReferenceEdits,
  snapshotFigureReferences, type FigureReferenceSnapshot, type ReferenceReplacement,
} from "./figureReferenceEdits";
export type { ReferenceReplacement } from "./figureReferenceEdits";

export interface LiveFigureReferenceDocument {
  root: string;
  path: string;
  getText(): string;
  applyReplacements(changes: readonly ReferenceReplacement[]): void;
  flush(): Promise<void>;
}
// Keep the coordinator a process singleton even when the dev server loads
// timestamped module URLs during HMR. Otherwise an editor can register with
// one module instance while a save sees an empty registry in another.
const sharedKey = Symbol.for("flux.figureReferenceSync");
interface SharedReferenceState {
  liveDocuments: Set<LiveFigureReferenceDocument>;
  recoveryInFlight: Map<string, Promise<number>>;
  preparedInFlight: Map<string, PreparedFigureReferenceUpdate>;
  commitInFlight: Map<string, Promise<number>>;
  leases?: WeakMap<PreparedFigureReferenceUpdate, ReferenceLease>;
}
const host = globalThis as unknown as Record<symbol, SharedReferenceState>;
const shared = host[sharedKey] ??= { liveDocuments: new Set(), recoveryInFlight: new Map(), preparedInFlight: new Map(), commitInFlight: new Map() };
const { liveDocuments, recoveryInFlight, preparedInFlight, commitInFlight } = shared;
interface ReferenceLease { assertOwned(): Promise<void>; release(): Promise<void> }
const referenceLeases = shared.leases ??= new WeakMap<PreparedFigureReferenceUpdate, ReferenceLease>();
export function registerLiveFigureReferenceDocument(adapter: LiveFigureReferenceDocument): () => void {
  liveDocuments.add(adapter);
  return () => { liveDocuments.delete(adapter); };
}
export function readLiveFigureReferenceDocuments(root: string): { path: string; text: string }[] {
  return [...liveDocuments].filter((d) => d.root === root).map((d) => ({ path: d.path, text: d.getText() }));
}
/** Export only flushes buffers in its transitive include tree. */
export async function flushLiveReferenceDocuments(root: string, paths: readonly string[]): Promise<void> {
  const targets = new Set(paths.map(path => path.startsWith(root + "/") ? path.slice(root.length + 1) : path));
  for (const doc of liveDocuments) if (doc.root === root && targets.has(doc.path)) await doc.flush();
}
export interface ReferenceSyncIO extends DependencyIO {
  exists(path: string): Promise<boolean>;
  writeText(path: string, text: string): Promise<void>;
  remove?(path: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
  validatePath?(path: string): Promise<void>;
  assertReferenceOwned?(): Promise<void>;
  withReferenceLease?<T>(work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T>;
  withDocumentLease?<T>(work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T>;
}
interface DocumentEdit { path: string; beforeDisk: string; beforeText: string; afterText: string; done?: boolean }
export interface PreparedFigureReferenceUpdate {
  version: 1;
  before: FigureReferenceSnapshot[];
  after: FigureReferenceSnapshot[];
  documents: DocumentEdit[];
  figureFiles: { path: string; beforeText: string | null; afterText: string }[];
}
const JOURNAL = ".meta/figure-reference-update.json";
/** Release a preflight when figure persistence throws. Keep its on-disk
 * journal for conservative recovery of any completed canonical writes. */
export async function releaseFigureReferenceUpdate(root: string, plan: PreparedFigureReferenceUpdate | null) {
  if (plan && preparedInFlight.get(root) === plan) preparedInFlight.delete(root);
  if (plan) { const lease = referenceLeases.get(plan); referenceLeases.delete(plan); await lease?.release(); }
}
/** Keep the ordinary token/heartbeat lock alive across the figure commit gap.
 * Recovery in another engine must acquire this same resource before inspecting
 * or retiring a prepared journal. */
async function holdReferenceLease(io: ReferenceSyncIO): Promise<ReferenceLease> {
  if (!io.withReferenceLease) return { assertOwned: async () => {}, release: async () => {} };
  let entered!: (assertOwned: () => Promise<void>) => void, rejected!: (error: unknown) => void, finish!: () => void;
  const ready = new Promise<() => Promise<void>>((resolve,reject) => { entered=resolve; rejected=reject; });
  const done = new Promise<void>(resolve => { finish=resolve; });
  const running = io.withReferenceLease(async assertOwned => { entered(assertOwned); await done; });
  // Handle acquisition failure immediately; the returned release still observes
  // post-acquisition ownership errors without an unhandled rejection.
  void running.catch(rejected);
  const assertOwned = await ready;
  return { assertOwned, release: async () => { finish(); await running; } };
}
function abs(root: string, rel: string) {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || /^[a-z]:/i.test(rel) || /[\\\x00]/.test(rel) || rel.split("/").some((s) => !s || s === ".." || s === ".")) throw new Error(`Unsafe document path: ${rel}`);
  return `${root}/${rel}`;
}
/** Constrain every read/write to this project, including parent directory
 * symlinks. The native capability union can include other open projects. */
export function confinedReferenceSyncIO(root: string, io: ReferenceSyncIO,
  validate: (relative: string) => Promise<void>,
  withDocumentLease: NonNullable<ReferenceSyncIO['withDocumentLease']>,
  withReferenceLease?: ReferenceSyncIO['withReferenceLease'],
): ReferenceSyncIO {
  const prefix = root.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  const check = async (path: string) => {
    const normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith(prefix)) throw new Error('Reference path escapes project root');
    const rel = normalized.slice(prefix.length); abs(root, rel); await validate(rel);
  };
  return {
    validatePath: check, withDocumentLease, withReferenceLease,
    exists: async p => { await check(p); return io.exists(p); },
    readText: async p => { await check(p); return io.readText(p); },
    writeText: async (p,t) => { await check(p); await io.writeText(p,t); },
    ...(io.remove ? { remove: async (p: string) => { await check(p); await io.remove!(p); } } : {}),
    ...(io.mkdir ? { mkdir: async (p: string) => { await check(p); await io.mkdir!(p); } } : {}),
    ...(io.readdir ? { readdir: async (p: string) => { await check(p); return io.readdir!(p); } } : {}),
  };
}
async function validatePlan(root: string, plan: PreparedFigureReferenceUpdate, io: ReferenceSyncIO) {
  if (plan.version !== 1 || !Array.isArray(plan.figureFiles) || !plan.figureFiles.length || !Array.isArray(plan.documents)
    || !Array.isArray(plan.before) || !Array.isArray(plan.after)) throw new Error(`Unrecognized panel-reference recovery journal: ${JOURNAL}`);
  for (const snapshots of [plan.before, plan.after]) {
    const ids = new Set<string>();
    for (const f of snapshots) {
      if (!f || typeof f.id !== 'string' || !f.id || ids.has(f.id) || typeof f.label !== 'string' || !/^fig-[A-Za-z0-9_-]+$/.test(f.label)
        || !Array.isArray(f.panels) || !Array.isArray(f.panelIds) || f.panels.length !== f.panelIds.length
        || f.panels.some(p => typeof p !== 'string') || f.panelIds.some(p => typeof p !== 'string' || !p)
        || new Set(f.panelIds).size !== f.panelIds.length) throw new Error('Invalid figure reference snapshot');
      ids.add(f.id);
    }
  }
  if (!changedReferenceFigures(plan.before, plan.after).length) throw new Error('Reference recovery lacks changed figure evidence');
  const seen = new Set<string>();
  for (const f of plan.figureFiles) {
    if (!f || !(f.beforeText === null || typeof f.beforeText === 'string') || typeof f.afterText !== 'string'
      || !/^fig\/(?:index\.json|canvases\/[^/]+\.json)$/.test(f.path)) throw new Error('Invalid canonical figure recovery file');
    const path = abs(root, f.path); if (seen.has(path)) throw new Error('Duplicate reference recovery path'); seen.add(path);
    await io.validatePath?.(path);
  }
  for (const d of plan.documents) {
    if (!d || typeof d.beforeDisk !== 'string' || typeof d.beforeText !== 'string' || typeof d.afterText !== 'string'
      || (d.done !== undefined && typeof d.done !== 'boolean') || !/\.(qmd|md)$/i.test(d.path)) throw new Error('Invalid reference recovery document');
    const edits = planFigureReferenceEdits(d.beforeText,plan.before,plan.after);
    if (edits.conflicts.length || applyReferenceReplacements(d.beforeText,edits.changes) !== d.afterText) throw new Error('Reference recovery text does not match its figure mapping');
    const path = abs(root,d.path); if (seen.has(path)) throw new Error('Duplicate reference recovery path'); seen.add(path);
    await io.validatePath?.(path);
  }
  await io.validatePath?.(abs(root,JOURNAL));
}
function liveFor(root: string, path: string): LiveFigureReferenceDocument | undefined {
  const matches = [...liveDocuments].filter((d) => d.root === root && d.path === path);
  if (matches.length > 1 && matches.some((d) => d.getText() !== matches[0].getText())) throw new Error(`${path}: open editors disagree; save or close one before relabeling panels`);
  return matches[0];
}
async function saveJournal(root: string, plan: PreparedFigureReferenceUpdate, io: ReferenceSyncIO) {
  await io.mkdir?.(`${root}/.meta`);
  await io.assertReferenceOwned?.();
  await io.writeText(abs(root, JOURNAL), JSON.stringify(plan, null, 2) + "\n");
}
async function clearJournal(root: string, io: ReferenceSyncIO) {
  await io.assertReferenceOwned?.();
  if (io.remove) await io.remove(abs(root, JOURNAL));
  else await io.writeText(abs(root, JOURNAL), "null\n");
}

async function documentPaths(root: string, io: ReferenceSyncIO): Promise<string[]> {
  const m = JSON.parse(await io.readText(abs(root, "project.json")));
  const paths = new Set<string>([m.manuscript?.path, ...(m.supplementary ?? []).map((d: { path: string }) => d.path)].filter(Boolean));
  for (const d of liveDocuments) if (d.root === root) paths.add(d.path);
  const walk = async (rel: string, depth = 0) => {
    if (!io.readdir || !(await io.exists(abs(root, rel)))) return;
    if (depth > 20) throw new Error(`Cannot inspect deeply nested documents in ${rel}`);
    for (const e of await io.readdir(abs(root, rel))) {
      if (e.name.startsWith(".") || e.name.includes(".sync-conflict-")) continue;
      if (rel === "Context" && ["Transcripts", "Dispatches"].includes(e.name)) continue;
      const child = `${rel}/${e.name}`;
      if (e.dir) await walk(child, depth + 1);
      else if (/\.(qmd|md)$/i.test(e.name)) paths.add(child);
    }
  };
  await Promise.all([walk("manuscript"), walk("supplementary"), walk("Context")]);
  return [...paths];
}

/** Preflight and journal BEFORE writing figures. No document is touched yet.
 * Caller passes the exact canvas/index write set for crash recovery. */
export async function prepareFigureReferenceUpdate(
  root: string, beforeFigures: readonly Figure[], afterFigures: readonly Figure[], io: ReferenceSyncIO,
  opts: { index?: { figures: { id: string; label: string }[] } | null; figureFiles: { path: string; text: string }[] },
): Promise<PreparedFigureReferenceUpdate | null> {
  const lease = await holdReferenceLease(io);
  let retained = false;
  try {
  io = { ...io, assertReferenceOwned: lease.assertOwned };
  await recover(root, io);
  const before = snapshotFigureReferences(beforeFigures, opts.index), after = snapshotFigureReferences(afterFigures, opts.index);
  if (!changedReferenceFigures(before, after).length) return null;
  const plan: PreparedFigureReferenceUpdate = { version: 1, before, after, documents: [], figureFiles: [] };
  for (const path of await documentPaths(root, io)) {
    const beforeDisk = await io.readText(abs(root, path));
    const beforeText = liveFor(root, path)?.getText() ?? beforeDisk;
    const edits = planFigureReferenceEdits(beforeText, before, after);
    if (edits.conflicts.length) throw new Error(`${path}: ${edits.conflicts.join("; ")}`);
    if (edits.changes.length) plan.documents.push({ path, beforeDisk, beforeText, afterText: applyReferenceReplacements(beforeText, edits.changes) });
  }
  if (!plan.documents.length) return null;
  for (const f of opts.figureFiles) {
    const beforeText = await io.exists(abs(root, f.path)) ? await io.readText(abs(root, f.path)) : null;
    if (beforeText !== f.text) plan.figureFiles.push({ path: f.path, beforeText, afterText: f.text });
  }
  // A change of stable-panel meaning always changes a canonical canvas, even
  // if the index's alphabetically sorted panel list remains byte-identical.
  if (!plan.figureFiles.length) throw new Error("Panel reference update has no changed canonical figure file");
  // Cold files must still match after the full project scan, before commit.
  for (const d of plan.documents) if (await io.readText(abs(root, d.path)) !== d.beforeDisk) throw new Error(`${d.path} changed while panel references were being prepared; retry after reloading it`);
  await validatePlan(root, plan, io);
  await saveJournal(root, plan, io);
  preparedInFlight.set(root, plan); referenceLeases.set(plan, lease); retained = true;
  return plan;
  } finally { if (!retained) await lease.release(); }
}

/** Apply only after the figure save's commit point. Re-read active editor text
 * so typing during figure IO is retained and transformed in one transaction. */
export function commitFigureReferenceUpdate(root: string, plan: PreparedFigureReferenceUpdate | null, io: ReferenceSyncIO, recovery = false): Promise<number> {
  const existing = commitInFlight.get(root);
  if (existing) return existing;
  const lease = plan ? referenceLeases.get(plan) : undefined;
  const task = commit(root, plan, lease ? {...io, assertReferenceOwned: lease.assertOwned} : io, recovery).finally(async () => {
    commitInFlight.delete(root); await releaseFigureReferenceUpdate(root, plan);
  });
  commitInFlight.set(root, task);
  return task;
}
async function commit(root: string, plan: PreparedFigureReferenceUpdate | null, io: ReferenceSyncIO, recovery: boolean): Promise<number> {
  if (!plan) return 0;
  await validatePlan(root, plan, io);
  let changed = 0;
  for (const d of plan.documents) {
    if (d.done) continue;
    const update = async (assertOwned: () => Promise<void>) => {
    const disk = await io.readText(abs(root, d.path));
    const live = liveFor(root, d.path);
    if (disk === d.afterText && (!live || live.getText() === d.afterText)) {
      d.done = true; await saveJournal(root, plan, io); return;
    }
    if (disk !== d.beforeDisk) {
      // The live editor can autosave its old-label text during figure IO.
      // Accept only a buffer version we actually observed; an unrelated
      // disk edit still conflicts and is never silently treated as ours.
      if (live && (disk === d.beforeText || disk === live.getText())) d.beforeDisk = disk;
      else throw new Error(`${d.path}: pending panel reference update conflicts with newer file edits; the original and proposed text are retained in ${JOURNAL}`);
    }
    const input = live?.getText() ?? d.beforeText;
    // Recovery cannot guess whether a different live buffer already uses the
    // new labels. The ordinary in-flight path knows its editor still has the
    // pre-save figure revision and may safely re-plan its latest text.
    if (recovery && live && input !== d.beforeText && input !== d.afterText) throw new Error(`${d.path}: save or reconcile the open document before recovering its panel references`);
    const edits = input === d.afterText ? { changes: [], conflicts: [] } : planFigureReferenceEdits(input, plan.before, plan.after);
    if (edits.conflicts.length) throw new Error(`${d.path}: ${edits.conflicts.join("; ")}`);
    if (input !== d.afterText) { d.beforeText = input; d.afterText = applyReferenceReplacements(input, edits.changes); }
    await saveJournal(root, plan, io);
    if (live) {
      await io.assertReferenceOwned?.();
      // No await between the latest read/replan and the CM transaction.
      const current = live.getText();
      if (current !== input) {
        const latest = planFigureReferenceEdits(current, plan.before, plan.after);
        if (latest.conflicts.length) throw new Error(`${d.path}: ${latest.conflicts.join("; ")}`);
        // Store this new baseline first; recursively retry if typing races IO
        // again, rather than applying offsets for an older text buffer.
        d.beforeText = current; d.afterText = applyReferenceReplacements(current, latest.changes);
        await saveJournal(root, plan, io);
        await io.assertReferenceOwned?.();
        if (live.getText() !== current) throw new Error(`${d.path}: text changed while panel references were being saved; retry the figure save`);
        live.applyReplacements(latest.changes);
      } else live.applyReplacements(edits.changes);
      await live.flush();
    } else {
      // The manuscript lease spans baseline read, journal durability and write.
      // A noncooperating external editor still gets a final baseline check.
      await assertOwned();
      if (await io.readText(abs(root, d.path)) !== d.beforeDisk) throw new Error(`${d.path}: pending panel reference update conflicts with newer file edits; retained in ${JOURNAL}`);
      await assertOwned(); await io.assertReferenceOwned?.();
      await io.writeText(abs(root, d.path), d.afterText);
    }
    d.done = true; changed++;
    await saveJournal(root, plan, io);
    };
    // A live Paper owner flushes through its own manuscript lease. Holding an
    // outer lease would deadlock that flush; cold writers own the lease here.
    if (!liveFor(root, d.path) && io.withDocumentLease) await io.withDocumentLease(update);
    else await update(async () => {});
  }
  await clearJournal(root, io);
  return changed;
}

/** An interrupted save may have stopped before or after the figure commit.
 * Every canonical file must match one complete side; mixed/newer writes stop
 * recovery and retain the journal instead of guessing reference meanings. */
export function recoverFigureReferenceUpdate(root: string, io: ReferenceSyncIO): Promise<number> {
  const committing = commitInFlight.get(root);
  if (committing) return committing;
  // A file watcher can observe the prepared journal before the figure save
  // reaches its commit point. It must not mistake that live save for a crash
  // and delete the journal out from underneath it.
  if (preparedInFlight.has(root)) return Promise.resolve(0);
  const existing = recoveryInFlight.get(root);
  if (existing) return existing;
  const work = async () => {
    // A project without a journal needs no new lock or filesystem mutation.
    if (!await io.exists(abs(root,JOURNAL))) return 0;
    return io.withReferenceLease
      ? io.withReferenceLease(assertReferenceOwned => recover(root,{...io,assertReferenceOwned}))
      : recover(root,io);
  };
  const task = work().finally(() => recoveryInFlight.delete(root));
  recoveryInFlight.set(root, task);
  return task;
}
async function recover(root: string, io: ReferenceSyncIO): Promise<number> {
  if (!(await io.exists(abs(root, JOURNAL)))) return 0;
  const plan = JSON.parse(await io.readText(abs(root, JOURNAL))) as PreparedFigureReferenceUpdate | null;
  if (!plan) return 0;
  await validatePlan(root, plan, io);
  let allBefore = true, allAfter = true;
  for (const f of plan.figureFiles) {
    const actual = await io.exists(abs(root, f.path)) ? await io.readText(abs(root, f.path)) : null;
    allBefore &&= actual === f.beforeText;
    allAfter &&= actual === f.afterText;
  }
  if (allAfter) return commitFigureReferenceUpdate(root, plan, io, true);
  if (allBefore) { await clearJournal(root, io); return 0; }
  throw new Error(`An interrupted panel relabel has conflicting figure files; recovery details are retained in ${JOURNAL}`);
}
