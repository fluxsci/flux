import { writable, get } from "svelte/store";
import type { Canvas, Element, Figure, Project, Viewport, Id } from "./types";
import { FLEXOKI } from "./flexoki";
import { settings } from "./settings";
import { newId } from "./ids";
import { migrateProject, DEFAULT_TEXT_STYLES } from "./migrate";
import { membersDeep, unitOf } from "./groups";
import * as ops from "./ops";

// ---------------------------------------------------------------------------
// Ids — the generator now lives in the dependency-free ./ids leaf so the pure
// ops core and flux-core (Node) share it. Re-exported here for the many
// existing `import { newId } from "./store"` call sites.
// ---------------------------------------------------------------------------
export { newId };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export type Tool =
  | "select"
  | "scale"
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
  // 7 pt — the standard journal figure text size — in stored canvas px (pt × 4/3).
  // The UI edits font sizes in pt (Inspector "Size (pt)"); storage stays px.
  fontSize: 28 / 3,
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
    width: ops.BLANK_FIGURE.width,
    height: ops.BLANK_FIGURE.height,
    background: ops.BLANK_FIGURE.background,
    elements: [],
  };
}

function blankProject(): Project {
  const canvasId = newId("canvas");
  const canvases: Canvas[] = [{ id: canvasId, name: "Canvas 1" }];
  return {
    version: 2,
    name: "Untitled",
    canvases,
    figures: [blankFigure(canvasId)],
    assets: [],
    palette: [],
    colorGroups: get(settings).flexokiDefault ? structuredClone(FLEXOKI) : [],
    textStyles: structuredClone(DEFAULT_TEXT_STYLES),
  };
}

// Bring older / partial projects up to the current shape: model migration
// (migrate.ts — text autoWidth → sizing, seed default text styles), then
// guarantee at least one canvas exists and every figure is assigned to one.
// Mutates and returns `p`.
export function normalizeProject(p: Project): Project {
  migrateProject(p);
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

// The group the user has ENTERED (figure-v1 P7; the double-click UX lands with
// the Canvas wave). While set, clicks select child units OF this group
// (expandGroups' `scope`), Figma-style. Null = top level. Cleared with the
// selection; pruned when the group disappears (undo/delete/ungroup).
export const enteredGroupId = writable<Id | null>(null);

// Plot X-Ray viewer (Alt+P): a floating cockpit listing every part of the
// selected semantic plot, with per-part/group hide-show + property editing.
export const xrayOpen = writable<boolean>(false);

// Plot Importer (Alt+I): a quick-open window to search/browse the project's
// plots/ dir and import a FluxPlot plot.
export const importerOpen = writable<boolean>(false);

export const activeFigureId = writable<Id | null>(get(project).figures[0]?.id ?? null);
// The figure (frame) selected as a whole object — distinct from element selection
// — so a frame can be moved/duplicated/nudged on the canvas (F8). Set by clicking
// a figure's title label; cleared when elements are (re)selected.
export const selectedFrameId = writable<Id | null>(null);
// The canvas (page) currently shown in the editor.
export const activeCanvasId = writable<Id | null>(get(project).canvases[0]?.id ?? null);

// Caption editor (Alt+C): when open, a caption page is shown beside the active
// figure and the rest of the canvas is read-only (pan/zoom still allowed).
export const captionOpen = writable<boolean>(false);

// The element currently under the cursor (select tool), for the Figma-style
// hover outline. Null when nothing is hovered / during a drag.
export const hoverId = writable<Id | null>(null);

// The id of the path element being NODE-edited (Feature 1 pen/vector). While set,
// the canvas shows that path's vector nodes + handles instead of the normal
// selection box, and node-edit owns the keyboard (Enter/Esc/Delete/etc.) — so
// the global shortcut handler yields, like it does for the caption editor.
export const nodeEditId = writable<Id | null>(null);

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

// FIG-5: `colorGroups` is the bundled Flexoki palette — hundreds of static
// swatches that are NOT document content and barely change. The old whole-project
// clone deep-copied it into every one of the ≤200 history entries, the dominant
// undo memory + per-gesture CPU cost. Snapshot everything else; re-attach the
// LIVE colorGroups on restore (palette state is simply outside undo, which is
// fine — you don't Ctrl+Z a swatch).
function snapshot(p: Project): Project {
  const { colorGroups: _omit, ...rest } = p;
  void _omit;
  return structuredClone(rest) as Project;
}
function restore(snap: Project) {
  snap.colorGroups = get(project).colorGroups;
  project.set(snap);
}

// W4: monotonic edit counter. A save snapshots `editGen.n` before its async
// writes and clears `dirty` only if no edit landed meanwhile — otherwise a
// mid-save edit's dirty flag was silently clobbered and never persisted.
export const editGen = { n: 0 };

function markEdited() {
  editGen.n++;
  dirty.set(true);
}

export function beginGesture() {
  past.push(snapshot(get(project)));
  if (past.length > MAX_HISTORY) past.shift();
  future.length = 0;
  markEdited();
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
  markEdited();
}

export function undo() {
  if (!past.length) return;
  future.push(snapshot(get(project)));
  restore(past.pop()!);
  pruneSelection();
  markEdited();
}

export function redo() {
  if (!future.length) return;
  past.push(snapshot(get(project)));
  restore(future.pop()!);
  pruneSelection();
  markEdited();
}

// FIG-12: the mounted Canvas registers its in-flight-gesture abort here so the
// global Esc (keyboard.ts) can cancel a live drag/resize/rotate FIRST — returns
// true when a gesture was aborted (Esc then stops there instead of clearing the
// selection). A hook (not an import) because keyboard.ts is module-global while
// the gesture state lives inside the Canvas component.
export const gestureCancelHook: { fn: (() => boolean) | null } = { fn: null };

// Discard the most recent gesture: restore its captured pre-state and leave no
// redo. Used to cancel a live, in-progress gesture (e.g. Esc out of Arrange
// mode) whose pre-state was captured with beginGesture().
export function rollbackGesture() {
  if (!past.length) return;
  restore(past.pop()!);
  future.length = 0;
  pruneSelection();
  markEdited();
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
  selectedFrameId.set(null);
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
  selectedFrameId.set(null);
  enteredGroupId.set(null);
}

// Frame-as-object selection (F8): select a whole figure for move/duplicate/nudge.
export function selectFrame(id: Id) {
  selectedFrameId.set(id);
  selection.set(new Set());
  partSelection.set(null);
}

// Duplicate a figure (frame) with all its elements — remapping element/group ids
// and re-keying captions — placed directly below it on the same canvas (F8). The
// model work lives in the shared pure core (ops.duplicateFigure); the store just
// commits it (for undo) and updates the active/frame selection.
export function duplicateFigure(id: Id) {
  let newFigId: Id | null = null;
  commit((p) => {
    newFigId = ops.duplicateFigure(p, id);
  });
  if (newFigId) {
    activeFigureId.set(newFigId);
    selectedFrameId.set(newFigId);
  }
}

// F7: assign panel letters (a, b, c…) to a figure's panel-label text elements by
// reading order (top-to-bottom, then left-to-right) so @fig-x-a refs stay valid
// and follow arrangement. Call after laying panels out. (Shared via ops.)
export function autoLetterPanels(figId: Id) {
  commit((p) => ops.autoLetterPanels(p, figId));
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
  // FIG-13: a frame (figure) selection can also dangle after undo removes its figure —
  // clear it so the frame HUD / resize handles don't render against a gone figure.
  selectedFrameId.update((id) => (id && p.figures.some((f) => f.id === id) ? id : null));
  // P7: an entered-group scope dangles the same way when its registry def goes
  // (undo / delete / ungroup) — drop back to top level.
  enteredGroupId.update((id) => (id && p.figures.some((f) => f.groups?.[id]) ? id : null));
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

// Expand a set of element ids to whole selection UNITS (figure-v1 P7): without
// `scope`, an id inside any registered group pulls in its TOP-level group's
// members DEEP (nested groups select as one — identical to the old flat
// behavior on flat docs); with `scope` (an entered group id — the Canvas wave
// passes it), expansion stops at the child unit directly below that scope.
// Elements sharing a DANGLING groupId (no registry def — e.g. alt-drag copies
// until the Canvas wave adopts cloneGroupsFor) still co-expand by raw id.
export function expandGroups(p: Project, ids: Set<Id>, scope?: Id | null): Set<Id> {
  const out = new Set(ids);
  for (const f of p.figures) {
    if (!f.elements.some((e) => ids.has(e.id))) continue;
    const defs = f.groups ?? {};
    const units = new Set<Id>();
    let dangling: Set<Id> | null = null;
    for (const e of f.elements) {
      if (!ids.has(e.id)) continue;
      const u = unitOf(f, e, scope ?? null);
      if (u.groupId) units.add(u.groupId);
      else if (e.groupId && !defs[e.groupId]) (dangling ??= new Set()).add(e.groupId);
    }
    for (const gid of units) for (const m of membersDeep(f, gid)) out.add(m.id);
    if (dangling) for (const e of f.elements) if (e.groupId && dangling.has(e.groupId)) out.add(e.id);
  }
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
