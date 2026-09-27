// Flux shell state: which view we're in (Home vs Workspace), the active
// mode, the current project, and the recent-projects list.

import { writable, get } from "svelte/store";
import {
  basename,
  fileBridge,
  type LoadedProject,
} from "../lib/project/types";
import { NotAProjectError } from "../lib/project/loadErrors";
// Validation and starter-deck assembly are needed only for an actual open/new
// operation. Keep those scientific-format engines out of the interactive Home.
const loadProject = async (root: string): Promise<LoadedProject> => (await import("../lib/project/load")).loadProject(root);
const scaffoldProject = async (root: string, opts: import("../lib/project/scaffold").ScaffoldOptions) => (await import("../lib/project/scaffold")).scaffoldProject(root, opts);
import { ensureProjectContext } from "../lib/project/contextHeal";
import { startProjectWatch, stopProjectWatch } from "../lib/project/projectWatch";
import { conflicts, conflictsOnProjectOpen, conflictsOpen } from "../lib/project/conflicts";
import { flushAll } from "./lifecycle";
import { reconcileProject } from "../lib/references/fluxlibBridge";
import { bumpBibRevision } from "./scholar/revisions";
import { serializeTransition, transitionProjectIntent, isCurrentProjectIntent } from "./transitions";
import { pushToast } from "../lib/toast";
import { decodeRecents } from "./storageValidation";
import { openDocRequest, openSlideRequest } from "./command/commandBus";
import { resetPanes } from "./paneStore";

export type ModeId = "figure" | "paper" | "slide" | "library" | "reader";
export type View = "home" | "workspace";

export interface RecentProject {
  name: string;
  path: string | null;
  openedAt: number;
}
export interface CurrentProject {
  name: string;
  path: string | null;
}

export const view = writable<View>("home");
export const currentProject = writable<CurrentProject | null>(null);
/** The fully-loaded project (root + manifest); null on the web fallback. */
export const projectModel = writable<LoadedProject | null>(null);
/** Transient error surfaced on the Home screen. */
export const projectError = writable<string | null>(null);

// --- recents (persisted to localStorage) ------------------------------------
const RECENTS_KEY = "flux.recents";

function loadRecents(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? decodeRecents(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export const recents = writable<RecentProject[]>(loadRecents());
recents.subscribe((list) => {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
});

function pushRecent(p: RecentProject) {
  recents.update((list) => {
    const deduped = list.filter((r) =>
      p.path ? r.path !== p.path : r.name !== p.name,
    );
    return [p, ...deduped].slice(0, 8);
  });
}

function removeRecent(path: string | null) {
  if (!path) return;
  recents.update((list) => list.filter((r) => r.path !== path));
}

/** Forget a single recent (by path, or by name for unsaved in-memory projects). */
export function forgetRecent(r: RecentProject) {
  recents.update((list) =>
    list.filter((x) => !(r.path ? x.path === r.path : x.path === null && x.name === r.name)),
  );
}

/** Clear the entire recents list. */
export function clearRecents() {
  recents.set([]);
}

// --- navigation -------------------------------------------------------------
/** A4.1 (multi-window): the same project must never be open in two windows —
 *  two live editors autosaving the same manuscript can genuinely lose writing.
 *  When another window already has `root`, main focuses it and we abort the
 *  open here. Absent bridge method (web fallback, older main) ⇒ proceed. */
async function focusedOtherWindow(root: string): Promise<boolean> {
  try {
    return (await fileBridge()?.projectOpenElsewhere?.(root)) === true;
  } catch {
    return false;
  }
}

function enterLoaded(loaded: LoadedProject) {
  stopProjectWatch();
  projectModel.set(loaded);
  currentProject.set({ name: loaded.manifest.title, path: loaded.root });
  pushRecent({
    name: loaded.manifest.title,
    path: loaded.root,
    openedAt: Date.now(),
  });
  projectError.set(null);
  resetPanes("paper");
  view.set("workspace");
  startProjectWatch(loaded.root); // F1: live-reload agent/script edits
  // Sync conflicts: most arrive while Flux is CLOSED (that is when the other machine
  // was being used), so the watcher alone would never see them. Scan on open and put
  // the banner up if anything is waiting.
  void conflictsOnProjectOpen(loaded.root);
  // Principal-agent scheme: pre-Context projects gain Context/ on first open
  // (additive, existence-guarded, best-effort — see contextHeal.ts).
  void ensureProjectContext(loaded);
  // FluxLib: reconcile this project's cited-subset library.bib against the global
  // library (materialize cited entries, promote project-local-only ones up). Non-
  // blocking; refresh the bib store if anything changed. Failures are non-fatal.
  void reconcileProject(loaded.root)
    .then((r) => {
      if (get(projectModel) === loaded && (r.materialized.length || r.promoted.length)) bumpBibRevision();
    })
    .catch(() => {});
}

/** Web-fallback (no Electron bridge): an in-memory project so the shell is demoable. */
function enterInMemory(name: string) {
  projectModel.set(null);
  currentProject.set({ name, path: null });
  pushRecent({ name, path: null, openedAt: Date.now() });
  projectError.set(null);
  resetPanes("paper");
  view.set("workspace");
  startProjectWatch(null);
  conflicts.set([]); // in-memory demo project has no filesystem to conflict on
  conflictsOpen.set(false);
}

async function checkedOutgoing(): Promise<boolean> {
  const result = await flushAll();
  if (result.ok) return true;
  const message = `Unsaved changes: ${result.failed.join(', ')}. Retry saving or resolve the conflict before leaving.`;
  projectError.set(message);
  pushToast('error', "Couldn't leave project", { detail: message });
  return false;
}

export function goHome(): Promise<boolean> {
  const intent = transitionProjectIntent('home');
  return serializeTransition('home', async () => {
    if (!isCurrentProjectIntent(intent) || !await checkedOutgoing() || !isCurrentProjectIntent(intent)) return false;
    stopProjectWatch();
    conflicts.set([]); conflictsOpen.set(false);
    projectModel.set(null); currentProject.set(null);
    openDocRequest.set(null); openSlideRequest.set(null);
    projectError.set(null); view.set('home');
    return true;
  });
}

function openIntent(key: string, prepare: () => Promise<LoadedProject | string | null>): Promise<boolean> {
  const intent = transitionProjectIntent(`open:${key}`);
  return serializeTransition(`open:${key}`, async () => {
    if (!isCurrentProjectIntent(intent) || !await checkedOutgoing() || !isCurrentProjectIntent(intent)) return false;
    let incoming: LoadedProject | string | null;
    try { incoming = await prepare(); } catch (error) { if (!isCurrentProjectIntent(intent)) return false; throw error; }
    if (!incoming || !isCurrentProjectIntent(intent)) return false;
    // A user may keep typing while a dialog/load is pending.
    if (!await checkedOutgoing() || !isCurrentProjectIntent(intent)) return false;
    if (typeof incoming === 'string') enterInMemory(incoming); else enterLoaded(incoming);
    return true;
  });
}

export async function newProject() {
  try {
    await openIntent('new', async () => {
      const fig = fileBridge();
      if (!fig?.save) return 'Untitled Project';
      const target = await fig.save('Untitled Project', []);
      if (!target) return null;
      await scaffoldProject(target, { title: basename(target) });
      return loadProject(target);
    });
  } catch (e) { projectError.set(`Couldn't create project: ${(e as Error).message}`); }
}

export async function openProject() {
  try {
    await openIntent('dialog', async () => {
      const fig = fileBridge();
      if (!fig?.openDirectory) return 'Demo Project';
      const dir = await fig.openDirectory('Open Flux Project');
      if (!dir || await focusedOtherWindow(dir)) return null;
      return loadProject(dir);
    });
  } catch (e) { projectError.set(e instanceof NotAProjectError ? "That folder isn't a Flux project (no project.json)." : `Couldn't open project: ${(e as Error).message}`); }
}

export async function openProjectAt(path: string): Promise<void> {
  await openIntent(path, async () => await focusedOtherWindow(path) ? null : loadProject(path));
}

export async function openRecent(r: RecentProject) {
  try {
    await openIntent(r.path ?? r.name, async () => !r.path ? r.name : await focusedOtherWindow(r.path) ? null : loadProject(r.path));
  } catch (e) {
    // An unavailable volume/permission failure is not proof a recent was deleted.
    if (e instanceof NotAProjectError) removeRecent(r.path);
    projectError.set(e instanceof NotAProjectError ? `"${r.name}" is no longer a Flux project.` : `Couldn't open "${r.name}": ${(e as Error).message}`);
  }
}
