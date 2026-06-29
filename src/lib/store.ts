import { writable, get } from "svelte/store";
import type { Canvas, Element, Figure, Project, Viewport, Id } from "./types";
import { FLEXOKI } from "./flexoki";
import { settings } from "./settings";

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------
let idCounter = 0;
export function newId(prefix = "el"): Id {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export type Tool =
  | "select"
  | "hand"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen";

export const activeTool = writable<Tool>("select");

// Current drawing style applied to newly created shapes/text. Edited via the
// inspector / palette; reused so consecutive shapes stay consistent.
export interface DrawStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  textColor: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
}
export const drawStyle = writable<DrawStyle>({
  fill: "#d95f02",
  stroke: "#222222",
  strokeWidth: 2,
  textColor: "#222222",
  fontFamily: "Arial",
  fontSize: 24,
  fontWeight: 400,
});

// ---------------------------------------------------------------------------
// Project + editor state
// ---------------------------------------------------------------------------
// A fresh, blank figure on the given canvas.
export function blankFigure(canvasId: Id, name = "Figure 1"): Figure {
  return {
    id: newId("fig"),
    name,
    canvasId,
    x: 0,
    y: 0,
    width: 816,
    height: 1056,
    background: "#ffffff",
    elements: [],
  };
}

function blankProject(): Project {
  const canvasId = newId("canvas");
  const canvases: Canvas[] = [{ id: canvasId, name: "Canvas 1" }];
  return {
    version: 1,
    name: "Untitled",
    canvases,
    figures: [blankFigure(canvasId)],
    assets: [],
    palette: [],
    colorGroups: get(settings).flexokiDefault ? structuredClone(FLEXOKI) : [],
  };
}

// Bring older / partial projects up to the current shape: guarantee at least one
// canvas exists and every figure is assigned to one. Mutates and returns `p`.
export function normalizeProject(p: Project): Project {
  if (!p.canvases || p.canvases.length === 0) {
    const cid = newId("canvas");
    p.canvases = [{ id: cid, name: "Canvas 1" }];
    for (const f of p.figures) f.canvasId = cid;
  } else {
    const known = new Set(p.canvases.map((c) => c.id));
    const fallback = p.canvases[0].id;
    for (const f of p.figures) if (!f.canvasId || !known.has(f.canvasId)) f.canvasId = fallback;
  }
  return p;
}

export const project = writable<Project>(blankProject());
export const viewport = writable<Viewport>({ panX: 140, panY: 80, zoom: 0.6 });
export const selection = writable<Set<Id>>(new Set());

// A part selected WITHIN a semantic plot, addressed by its stable semantic id
// (e.g. "control.point.3"). Parallel to `selection` (whole elements); set by
// drilling into an already-selected plot. Restyles target this part.
export interface PartSelection {
  elementId: Id;
  partId: string;
}
export const partSelection = writable<PartSelection | null>(null);

// Plot X-Ray viewer (Alt+P): a floating cockpit listing every part of the
// selected semantic plot, with per-part/group hide-show + property editing.
export const xrayOpen = writable<boolean>(false);

// Plot Importer (Alt+I): a quick-open window to search/browse the project's
// plots/ dir and import a FluxPlot plot.
export const importerOpen = writable<boolean>(false);

export const activeFigureId = writable<Id | null>(get(project).figures[0]?.id ?? null);
// The canvas (page) currently shown in the editor.
export const activeCanvasId = writable<Id | null>(get(project).canvases[0]?.id ?? null);

// Caption editor (Alt+C): when open, a caption page is shown beside the active
// figure and the rest of the canvas is read-only (pan/zoom still allowed).
export const captionOpen = writable<boolean>(false);

// The element currently under the cursor (select tool), for the Figma-style
// hover outline. Null when nothing is hovered / during a drag.
export const hoverId = writable<Id | null>(null);

// Keyboard-driven grid arrangement ("Arrange mode", Alt+G). While `active`, the
// selection is being live-reflowed into a grid; `rows`/`cols` are the current
// shape and `n` the number of layout cells (a group counts once). The HUD reads
// this; `null` when the mode is off. `lastArrangeRows` drives the Inspector's
// rows stepper (and remembers the last applied shape between one-shot arranges).
export interface ArrangeState {
  active: boolean;
  n: number;
  rows: number;
  cols: number;
}
export const arrange = writable<ArrangeState | null>(null);
export const lastArrangeRows = writable<number>(2);

// The x/y delta used by the next Ctrl+D duplicate. Seeded by alt-drag-copy so
// repeated duplicates step by the same offset (Figma-style). Defaults to a
// small nudge for a plain Ctrl+D with no prior alt-drag.
export const lastDupOffset = writable<{ dx: number; dy: number }>({ dx: 16, dy: 16 });

// The current path to the project directory on disk (null = unsaved).
export const projectDir = writable<string | null>(null);
export const dirty = writable<boolean>(false);

// When the figure editor runs embedded in a Flux project, this is that
// project's root dir. Persistence is then routed to its `fig/` subsystem (see
// io.ts / project/figbridge.ts), and the editor's own Open/Save are hidden.
export const embeddedProjectRoot = writable<string | null>(null);

// ---------------------------------------------------------------------------
// Undo / redo
//
// Snapshot-based history. Call `beginGesture()` once before a mutating
// interaction (drag, resize, typing burst, discrete edit); it captures the
// pre-state. `commit(fn)` is a convenience for one-shot edits.
// ---------------------------------------------------------------------------
const past: Project[] = [];
const future: Project[] = [];
const MAX_HISTORY = 200;

function clone<T>(v: T): T {
  return structuredClone(v);
}

export function beginGesture() {
  past.push(clone(get(project)));
  if (past.length > MAX_HISTORY) past.shift();
  future.length = 0;
  dirty.set(true);
}

export function commit(fn: (p: Project) => void) {
  beginGesture();
  project.update((p) => {
    fn(p);
    return p;
  });
}

// Mutate without creating a new history entry (used during an in-progress
// gesture whose pre-state was already captured by beginGesture()).
export function mutate(fn: (p: Project) => void) {
  project.update((p) => {
    fn(p);
    return p;
  });
  dirty.set(true);
}

export function undo() {
  if (!past.length) return;
  future.push(clone(get(project)));
  project.set(past.pop()!);
  pruneSelection();
  dirty.set(true);
}

export function redo() {
  if (!future.length) return;
  past.push(clone(get(project)));
  project.set(future.pop()!);
  pruneSelection();
  dirty.set(true);
}

// Discard the most recent gesture: restore its captured pre-state and leave no
// redo. Used to cancel a live, in-progress gesture (e.g. Esc out of Arrange
// mode) whose pre-state was captured with beginGesture().
export function rollbackGesture() {
  if (!past.length) return;
  project.set(past.pop()!);
  future.length = 0;
  pruneSelection();
  dirty.set(true);
}

export function resetHistory() {
  past.length = 0;
  future.length = 0;
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------
export function selectOnly(id: Id) {
  selection.set(new Set([id]));
  partSelection.set(null);
}
export function addToSelection(id: Id) {
  selection.update((s) => {
    const n = new Set(s);
    n.add(id);
    return n;
  });
}
export function toggleSelection(id: Id) {
  selection.update((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
}
export function clearSelection() {
  selection.set(new Set());
  partSelection.set(null);
}

// Drop ids that no longer exist (after undo/redo/delete).
function pruneSelection() {
  const p = get(project);
  const live = new Set<Id>();
  for (const f of p.figures) for (const e of f.elements) live.add(e.id);
  selection.update((s) => {
    const n = new Set<Id>();
    for (const id of s) if (live.has(id)) n.add(id);
    return n;
  });
  partSelection.update((ps) => (ps && live.has(ps.elementId) ? ps : null));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
export function getActiveFigure(p: Project): Figure | null {
  const id = get(activeFigureId);
  return p.figures.find((f) => f.id === id) ?? null;
}

export function findElement(
  p: Project,
  id: Id,
): { figure: Figure; element: Element } | null {
  for (const f of p.figures) {
    const e = f.elements.find((el) => el.id === id);
    if (e) return { figure: f, element: e };
  }
  return null;
}

// Expand a set of element ids to include all members of any group they touch.
export function expandGroups(p: Project, ids: Set<Id>): Set<Id> {
  const groups = new Set<Id>();
  for (const f of p.figures)
    for (const e of f.elements)
      if (ids.has(e.id) && e.groupId) groups.add(e.groupId);
  if (groups.size === 0) return new Set(ids);
  const out = new Set(ids);
  for (const f of p.figures)
    for (const e of f.elements)
      if (e.groupId && groups.has(e.groupId)) out.add(e.id);
  return out;
}

export function selectedElements(p: Project, sel: Set<Id>): Element[] {
  const out: Element[] = [];
  for (const f of p.figures)
    for (const e of f.elements) if (sel.has(e.id)) out.push(e);
  return out;
}

export function loadProject(p: Project, dir: string | null) {
  normalizeProject(p);
  resetHistory();
  project.set(p);
  projectDir.set(dir);
  const firstCanvas = p.canvases[0]?.id ?? null;
  activeCanvasId.set(firstCanvas);
  const firstFig = p.figures.find((f) => f.canvasId === firstCanvas) ?? p.figures[0] ?? null;
  activeFigureId.set(firstFig?.id ?? null);
  clearSelection();
  captionOpen.set(false);
  hoverId.set(null);
  dirty.set(false);
}

// ---------------------------------------------------------------------------
// Canvases (pages)
// ---------------------------------------------------------------------------
export function figuresOnCanvas(p: Project, canvasId: Id | null): Figure[] {
  return p.figures.filter((f) => f.canvasId === canvasId);
}

// Switch the active canvas and focus its first figure.
export function setActiveCanvas(id: Id) {
  activeCanvasId.set(id);
  const fig = figuresOnCanvas(get(project), id)[0] ?? null;
  activeFigureId.set(fig?.id ?? null);
  clearSelection();
  captionOpen.set(false);
}

// Add a new canvas (with one blank figure) and switch to it.
export function addCanvas() {
  const cid = newId("canvas");
  commit((p) => {
    p.canvases.push({ id: cid, name: `Canvas ${p.canvases.length + 1}` });
    p.figures.push(blankFigure(cid));
  });
  setActiveCanvas(cid);
}

export function renameCanvas(id: Id, name: string) {
  commit((p) => {
    const c = p.canvases.find((c) => c.id === id);
    if (c) c.name = name;
  });
}

// Delete a canvas (and all its figures). Refuses to remove the last canvas.
export function deleteCanvas(id: Id) {
  if (get(project).canvases.length <= 1) return;
  const wasActive = get(activeCanvasId) === id;
  commit((p) => {
    p.canvases = p.canvases.filter((c) => c.id !== id);
    p.figures = p.figures.filter((f) => f.canvasId !== id);
  });
  if (wasActive) {
    const first = get(project).canvases[0]?.id;
    if (first) setActiveCanvas(first);
  }
}
