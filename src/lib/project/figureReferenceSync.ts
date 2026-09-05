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
}
const host = globalThis as unknown as Record<symbol, SharedReferenceState>;
const shared = host[sharedKey] ??= { liveDocuments: new Set(), recoveryInFlight: new Map(), preparedInFlight: new Map(), commitInFlight: new Map() };
const { liveDocuments, recoveryInFlight, preparedInFlight, commitInFlight } = shared;
export function registerLiveFigureReferenceDocument(adapter: LiveFigureReferenceDocument): () => void {
  liveDocuments.add(adapter);
  return () => { liveDocuments.delete(adapter); };
}
export function readLiveFigureReferenceDocuments(root: string): { path: string; text: string }[] {
  return [...liveDocuments].filter((d) => d.root === root).map((d) => ({ path: d.path, text: d.getText() }));
}
export interface ReferenceSyncIO extends DependencyIO {
  exists(path: string): Promise<boolean>;
  writeText(path: string, text: string): Promise<void>;
  remove?(path: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
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
export function releaseFigureReferenceUpdate(root: string, plan: PreparedFigureReferenceUpdate | null) {
  if (plan && preparedInFlight.get(root) === plan) preparedInFlight.delete(root);
}
function abs(root: string, rel: string) {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").some((s) => s === ".." || s === ".")) throw new Error(`Unsafe document path: ${rel}`);
  return `${root}/${rel}`;
}
function liveFor(root: string, path: string): LiveFigureReferenceDocument | undefined {
  const matches = [...liveDocuments].filter((d) => d.root === root && d.path === path);
  if (matches.length > 1 && matches.some((d) => d.getText() !== matches[0].getText())) throw new Error(`${path}: open editors disagree; save or close one before relabeling panels`);
  return matches[0];
}
async function saveJournal(root: string, plan: PreparedFigureReferenceUpdate, io: ReferenceSyncIO) {
  await io.mkdir?.(`${root}/.meta`);
  await io.writeText(abs(root, JOURNAL), JSON.stringify(plan, null, 2) + "\n");
}
async function clearJournal(root: string, io: ReferenceSyncIO) {
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
  await recoverFigureReferenceUpdate(root, io);
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
  await saveJournal(root, plan, io);
  preparedInFlight.set(root, plan);
  return plan;
}

/** Apply only after the figure save's commit point. Re-read active editor text
 * so typing during figure IO is retained and transformed in one transaction. */
export function commitFigureReferenceUpdate(root: string, plan: PreparedFigureReferenceUpdate | null, io: ReferenceSyncIO, recovery = false): Promise<number> {
  const existing = commitInFlight.get(root);
  if (existing) return existing;
  const task = commit(root, plan, io, recovery).finally(() => {
    commitInFlight.delete(root); releaseFigureReferenceUpdate(root, plan);
  });
  commitInFlight.set(root, task);
  return task;
}
async function commit(root: string, plan: PreparedFigureReferenceUpdate | null, io: ReferenceSyncIO, recovery: boolean): Promise<number> {
  if (!plan) return 0;
  let changed = 0;
  for (const d of plan.documents) {
    if (d.done) continue;
    const disk = await io.readText(abs(root, d.path));
    const live = liveFor(root, d.path);
    if (disk === d.afterText && (!live || live.getText() === d.afterText)) {
      d.done = true; await saveJournal(root, plan, io); continue;
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
    d.beforeText = input;
    d.afterText = applyReferenceReplacements(input, edits.changes);
    await saveJournal(root, plan, io);
    if (live) {
      // No await between the latest read/replan and the CM transaction.
      const current = live.getText();
      if (current !== input) {
        const latest = planFigureReferenceEdits(current, plan.before, plan.after);
        if (latest.conflicts.length) throw new Error(`${d.path}: ${latest.conflicts.join("; ")}`);
        // Store this new baseline first; recursively retry if typing races IO
        // again, rather than applying offsets for an older text buffer.
        d.beforeText = current; d.afterText = applyReferenceReplacements(current, latest.changes);
        await saveJournal(root, plan, io);
        if (live.getText() !== current) throw new Error(`${d.path}: text changed while panel references were being saved; retry the figure save`);
        live.applyReplacements(latest.changes);
      } else live.applyReplacements(edits.changes);
      await live.flush();
    } else await io.writeText(abs(root, d.path), d.afterText);
    d.done = true; changed++;
    await saveJournal(root, plan, io);
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
  const task = recover(root, io).finally(() => recoveryInFlight.delete(root));
  recoveryInFlight.set(root, task);
  return task;
}
async function recover(root: string, io: ReferenceSyncIO): Promise<number> {
  if (!(await io.exists(abs(root, JOURNAL)))) return 0;
  const plan = JSON.parse(await io.readText(abs(root, JOURNAL))) as PreparedFigureReferenceUpdate | null;
  if (!plan) return 0;
  if (plan.version !== 1 || !Array.isArray(plan.figureFiles) || !Array.isArray(plan.documents)) throw new Error(`Unrecognized panel-reference recovery journal: ${JOURNAL}`);
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
