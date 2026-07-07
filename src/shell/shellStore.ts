// Flux shell state: which view we're in (Home vs Workspace), the active
// mode, the current project, and the recent-projects list.

import { writable } from "svelte/store";
import {
  basename,
  fileBridge,
  type LoadedProject,
} from "../lib/project/types";
import { scaffoldProject } from "../lib/project/scaffold";
import { loadProject, NotAProjectError } from "../lib/project/load";
import { startProjectWatch, stopProjectWatch } from "../lib/project/projectWatch";
import { flushAll } from "./lifecycle";
import { reconcileProject } from "../lib/references/fluxlibBridge";
import { bumpBibRevision } from "./scholar/revisions";
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
    return raw ? (JSON.parse(raw) as RecentProject[]) : [];
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
function enterLoaded(loaded: LoadedProject) {
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
  // FluxLib: reconcile this project's cited-subset library.bib against the global
  // library (materialize cited entries, promote project-local-only ones up). Non-
  // blocking; refresh the bib store if anything changed. Failures are non-fatal.
  void reconcileProject(loaded.root)
    .then((r) => {
      if (r.materialized.length || r.promoted.length) bumpBibRevision();
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
}

export async function goHome() {
  // W5: leaving the project is a flush point — the destroy-time flushes this
  // used to rely on were fire-and-forget (unawaited async in onDestroy).
  await flushAll();
  stopProjectWatch();
  view.set("home");
}

export async function newProject() {
  const fig = fileBridge();
  if (!fig?.save) {
    enterInMemory("Untitled Project");
    return;
  }
  try {
    const target = await fig.save("Untitled Project", []);
    if (!target) return;
    const name = basename(target);
    await scaffoldProject(target, { title: name });
    enterLoaded(await loadProject(target));
  } catch (e) {
    projectError.set(`Couldn't create project: ${(e as Error).message}`);
  }
}

export async function openProject() {
  const fig = fileBridge();
  if (!fig?.openDirectory) {
    enterInMemory("Demo Project");
    return;
  }
  try {
    const dir = await fig.openDirectory("Open Flux Project");
    if (!dir) return;
    enterLoaded(await loadProject(dir));
  } catch (e) {
    projectError.set(
      e instanceof NotAProjectError
        ? "That folder isn't a Flux project (no project.json)."
        : `Couldn't open project: ${(e as Error).message}`,
    );
  }
}

/** Load and enter a project at an explicit path (used by the dev fixture and, later, F1/F4). */
export async function openProjectAt(path: string): Promise<void> {
  enterLoaded(await loadProject(path));
}

export async function openRecent(r: RecentProject) {
  if (!r.path) {
    enterInMemory(r.name);
    return;
  }
  try {
    enterLoaded(await loadProject(r.path));
  } catch (e) {
    removeRecent(r.path);
    projectError.set(
      e instanceof NotAProjectError
        ? `"${r.name}" is no longer a Flux project.`
        : `Couldn't open "${r.name}": ${(e as Error).message}`,
    );
  }
}
