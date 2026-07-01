import { get } from "svelte/store";
import {
  project,
  selection,
  activeFigureId,
  activeTool,
  undo,
  redo,
  commit,
  beginGesture,
  mutate,
  clearSelection,
  selectOnly,
  selectedFrameId,
  duplicateFigure,
  blankFigure,
  newId,
  lastDupOffset,
  captionOpen,
  nodeEditId,
  expandGroups,
  getActiveFigure,
  arrange,
  lastArrangeRows,
  rollbackGesture,
  xrayOpen,
  importerOpen,
  embeddedProjectRoot,
  projectDir,
  type Tool,
} from "./store";
import type { Element } from "./types";
import {
  alignElements,
  distributeElements,
  flipElements,
  arrangeGrid,
  gridItemCount,
  validRowCounts,
  balancedRows,
  type AlignKind,
} from "./geometry";
import { saveProject, saveProjectAs, openProject, importAssets } from "./io";
import { fluxFigMenuOpen, settingsOpen } from "./settings";
import * as ops from "./ops";

let clipboard: Element[] = [];

function activeFig() {
  const p = get(project);
  return p.figures.find((f) => f.id === get(activeFigureId)) ?? null;
}

// Alt+C: open the caption editor (needs an active figure with a selection —
// i.e. the user is "in" a figure), or close it if already open.
function toggleCaption() {
  if (get(captionOpen)) {
    captionOpen.set(false);
    return;
  }
  if (activeFig() && get(selection).size > 0) captionOpen.set(true);
}

// Alt+L: toggle the selected text element(s) as figure panel labels (each marked
// label becomes a caption block). If all selected texts are already labels, this
// unmarks them; otherwise it marks them all.
function togglePanelLabel() {
  const sel = get(selection);
  const fig = activeFig();
  if (!fig || sel.size === 0) return;
  const texts = fig.elements.filter((e) => sel.has(e.id) && e.type === "text");
  if (texts.length === 0) return;
  const allOn = texts.every((e) => e.type === "text" && e.panelLabel);
  commit((p) => {
    const f = p.figures.find((ff) => ff.id === fig.id)!;
    for (const e of f.elements) {
      if (sel.has(e.id) && e.type === "text") e.panelLabel = !allOn;
    }
  });
}

function withSelected(fn: (els: Element[], figId: string) => void) {
  const sel = get(selection);
  const fig = activeFig();
  if (!fig || sel.size === 0) return;
  commit((p) => {
    const f = p.figures.find((ff) => ff.id === fig.id)!;
    const els = f.elements.filter((e) => sel.has(e.id));
    fn(els, f.id);
  });
}

function doAlign(kind: AlignKind) {
  withSelected((els) => alignElements(els, kind));
}
function doDistribute(axis: "h" | "v", gap?: number) {
  withSelected((els) => distributeElements(els, axis, gap));
}

// ---------------------------------------------------------------------------
// Arrange mode (Alt+G): live-reflow the selection into a grid via the home row.
// The whole session is one undo entry (beginGesture on enter, mutate per
// tweak); Esc rolls it back. Each preview re-arranges from the baseline
// geometry captured at entry, so the anchor and reading order stay stable.
// ---------------------------------------------------------------------------
let arrangeBase: Map<string, { x: number; y: number }> | null = null;

function applyArrange(rows: number) {
  const st = get(arrange);
  if (!st || !arrangeBase) return;
  const cols = Math.ceil(st.n / rows);
  const sel = get(selection);
  mutate((p) => {
    const fig = getActiveFigure(p);
    if (!fig) return;
    const els = fig.elements.filter((e) => sel.has(e.id));
    for (const e of els) {
      const b = arrangeBase!.get(e.id);
      if (b) {
        e.x = b.x;
        e.y = b.y;
      }
    }
    arrangeGrid(els, cols);
  });
  arrange.set({ ...st, rows, cols });
  lastArrangeRows.set(rows);
}

export function enterArrange() {
  const fig = activeFig();
  const sel = get(selection);
  if (!fig || sel.size < 2) return;
  const els = fig.elements.filter((e) => sel.has(e.id));
  const n = gridItemCount(els);
  if (n < 2) return;
  beginGesture(); // single pre-state captured for the whole mode session
  arrangeBase = new Map(els.map((e) => [e.id, { x: e.x, y: e.y }]));
  const rows = balancedRows(n);
  arrange.set({ active: true, n, rows, cols: Math.ceil(n / rows) });
  applyArrange(rows);
}

export function commitArrange() {
  if (!get(arrange)) return;
  arrange.set(null);
  arrangeBase = null; // history already holds the single pre-state
}

export function cancelArrange() {
  if (!get(arrange)) return;
  rollbackGesture(); // restore original positions, leave no undo entry
  arrange.set(null);
  arrangeBase = null;
}

function arrangeStep(dir: 1 | -1) {
  const st = get(arrange);
  if (!st) return;
  const v = validRowCounts(st.n);
  let i = v.indexOf(st.rows);
  if (i < 0) i = 0;
  applyArrange(v[Math.max(0, Math.min(v.length - 1, i + dir))]);
}

function arrangeToggleRowCol() {
  const st = get(arrange);
  if (st) applyArrange(st.rows === 1 ? st.n : 1); // single row(1) <-> column(n)
}

function arrangeGridMode() {
  const st = get(arrange);
  if (st) applyArrange(balancedRows(st.n));
}

// One-shot grid arrange for the Inspector buttons (each = one undo entry).
export function arrangeToRows(rows: number) {
  const fig = activeFig();
  const sel = get(selection);
  if (!fig || sel.size < 2) return;
  const n = gridItemCount(fig.elements.filter((e) => sel.has(e.id)));
  if (n < 2) return;
  const v = validRowCounts(n);
  const r = v.reduce((b, x) => (Math.abs(x - rows) < Math.abs(b - rows) ? x : b));
  withSelected((els) => arrangeGrid(els, Math.ceil(n / r)));
  lastArrangeRows.set(r);
}

function nudge(dx: number, dy: number) {
  withSelected((els) => {
    for (const e of els) {
      e.x += dx;
      e.y += dy;
    }
  });
}

function deleteSelected() {
  const sel = get(selection);
  if (sel.size === 0) return;
  commit((p) => {
    for (const f of p.figures) f.elements = f.elements.filter((e) => !sel.has(e.id));
  });
  clearSelection();
}

function duplicateSelected() {
  const sel = get(selection);
  const fig = activeFig();
  if (!fig || sel.size === 0) return;
  // Step by the last move / alt-drag-copy offset (Figma-style repeat), or a small
  // default nudge if there was no prior transform.
  const off = get(lastDupOffset);
  let newIds: string[] = [];
  commit((p) => {
    newIds = ops.duplicateElements(p, fig.id, [...sel], { dx: off.dx, dy: off.dy });
  });
  // Re-select the copies so repeated Ctrl+D keeps stepping by the same offset.
  if (newIds.length) selection.set(new Set(newIds));
}

function flipSelected(axis: "h" | "v") {
  withSelected((els) => flipElements(els, axis));
}

// Cmd/Ctrl+Shift+L: toggle the lock flag across the selection (F6). Locks if any
// is unlocked, else unlocks — one undo entry.
function toggleLockSelected() {
  const sel = get(selection);
  if (sel.size === 0) return;
  const p0 = get(project);
  let allLocked = true;
  for (const f of p0.figures)
    for (const e of f.elements) if (sel.has(e.id) && !e.locked) allLocked = false;
  commit((p) => {
    for (const f of p.figures)
      for (const e of f.elements) if (sel.has(e.id)) e.locked = !allLocked;
  });
}

// --- Frame-as-object keyboard ops (F8): when a figure frame is selected as a
// whole (and no elements are), arrows nudge it, Ctrl+D duplicates it, Delete
// removes it (keeping at least one figure per canvas). ---
function frameSelected(): string | null {
  const fid = get(selectedFrameId);
  return fid && get(selection).size === 0 ? fid : null;
}

function nudgeFrame(dx: number, dy: number) {
  const fid = frameSelected();
  if (!fid) return;
  commit((p) => {
    const f = p.figures.find((ff) => ff.id === fid);
    if (f) {
      f.x += dx;
      f.y += dy;
    }
  });
}

function deleteFrame(): boolean {
  const fid = frameSelected();
  if (!fid) return false;
  let nextActive: string | null = null;
  commit((p) => {
    const victim = p.figures.find((f) => f.id === fid);
    const cid = victim?.canvasId ?? null;
    p.figures = p.figures.filter((f) => f.id !== fid);
    const remaining = cid ? p.figures.filter((f) => f.canvasId === cid) : [];
    if (cid && remaining.length === 0) {
      const blank = blankFigure(cid);
      p.figures.push(blank);
      nextActive = blank.id;
    } else {
      nextActive = remaining[0]?.id ?? p.figures[0]?.id ?? null;
    }
  });
  selectedFrameId.set(null);
  activeFigureId.set(nextActive);
  return true;
}

function copySelected() {
  const sel = get(selection);
  const fig = activeFig();
  if (!fig) return;
  clipboard = fig.elements.filter((e) => sel.has(e.id)).map((e) => structuredClone(e));
}

function paste() {
  if (!clipboard.length) return;
  const fig = activeFig();
  if (!fig) return;
  const newIds: string[] = [];
  commit((p) => {
    const f = p.figures.find((ff) => ff.id === fig.id)!;
    for (const e of clipboard) {
      const c = structuredClone(e);
      c.id = newId(c.type);
      c.x += 20;
      c.y += 20;
      newIds.push(c.id);
      f.elements.push(c);
    }
  });
  selection.set(new Set(newIds));
}

function groupSelected() {
  const sel = get(selection);
  if (sel.size < 2) return;
  const gid = newId("grp");
  commit((p) => {
    for (const f of p.figures)
      for (const e of f.elements) if (sel.has(e.id)) e.groupId = gid;
  });
}

function ungroupSelected() {
  const sel = get(selection);
  if (sel.size === 0) return;
  commit((p) => {
    for (const f of p.figures)
      for (const e of f.elements) if (sel.has(e.id)) delete e.groupId;
  });
}

function selectAll() {
  const fig = activeFig();
  if (!fig) return;
  selection.set(new Set(fig.elements.map((e) => e.id)));
}

// Select-all-with-same (Feature 9): from the single selected element, select every
// element sharing its `by` facet, in the active figure (or whole project).
function selectMatching(by: ops.MatchBy, scope: "figure" | "project" = "figure") {
  const sel = get(selection);
  if (sel.size !== 1) return;
  const p = get(project);
  const matched = ops.matchElements(p, [...sel][0], by, scope);
  if (matched.length) selection.set(expandGroups(p, new Set(matched)));
}

// Copy/paste properties (Feature 10). A style snapshot (no geometry / text content)
// captured from one element, applied to any selection (setElementStyle keeps only
// each element's valid props, so cross-type pastes are safe).
let styleClipboard: ops.ElementStylePatch | null = null;
function copyStyle() {
  const sel = get(selection);
  if (sel.size !== 1) return;
  const p = get(project);
  let el: Element | null = null;
  for (const f of p.figures) for (const e of f.elements) if (e.id === [...sel][0]) el = e;
  if (!el) return;
  const s: ops.ElementStylePatch = { opacity: el.opacity };
  if (el.type === "text") {
    s.color = el.color; s.fontFamily = el.fontFamily; s.fontSize = el.fontSize;
    s.fontWeight = el.fontWeight; s.fontStyle = el.fontStyle; s.align = el.align;
  }
  if (el.type === "rect" || el.type === "ellipse" || el.type === "path") { s.fill = el.fill; s.stroke = el.stroke; s.strokeWidth = el.strokeWidth; }
  if (el.type === "line") { s.stroke = el.stroke; s.strokeWidth = el.strokeWidth; }
  if (el.type === "rect") s.cornerRadius = el.cornerRadius;
  styleClipboard = s;
}
function pasteStyle() {
  if (!styleClipboard) return;
  const list = [...get(selection)];
  if (!list.length) return;
  const patch = styleClipboard;
  commit((p) => ops.setElementStyle(p, list, patch));
}

function raise(toEnd: boolean) {
  // Move selected elements to the front (toEnd) or back of the z-order.
  const sel = get(selection);
  const fig = activeFig();
  if (!fig || sel.size === 0) return;
  commit((p) => {
    const f = p.figures.find((ff) => ff.id === fig.id)!;
    const picked = f.elements.filter((e) => sel.has(e.id));
    const rest = f.elements.filter((e) => !sel.has(e.id));
    f.elements = toEnd ? [...rest, ...picked] : [...picked, ...rest];
  });
}

function bump(forward: boolean) {
  const sel = get(selection);
  const fig = activeFig();
  if (!fig || sel.size === 0) return;
  commit((p) => {
    const f = p.figures.find((ff) => ff.id === fig.id)!;
    const arr = f.elements;
    const order = forward ? [...arr.keys()].reverse() : [...arr.keys()];
    for (const i of order) {
      const j = forward ? i + 1 : i - 1;
      if (j < 0 || j >= arr.length) continue;
      if (sel.has(arr[i].id) && !sel.has(arr[j].id)) {
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }
  });
}

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  k: "scale",
  h: "hand",
  t: "text",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  p: "pen",
};

// Open the Plot X-Ray for a single selected semantic plot.
function openXray() {
  const sel = get(selection);
  if (sel.size !== 1) return;
  const p = get(project);
  for (const f of p.figures)
    for (const el of f.elements)
      if (sel.has(el.id) && el.type === "plot") {
        xrayOpen.set(true);
        return;
      }
}

export function handleKey(e: KeyboardEvent) {
  // the FluxFig Menu / Settings / X-Ray / Importer own all keys while open.
  if (get(fluxFigMenuOpen) || get(settingsOpen) || get(xrayOpen) || get(importerOpen)) return;

  // Node-edit mode (Feature 1) owns the keyboard: Canvas.svelte handles
  // Enter/Esc/Delete/Tab on the vector nodes. Yield everything so Delete doesn't
  // nuke the whole path and Esc doesn't just clear the selection.
  if (get(nodeEditId)) return;

  const mod = e.metaKey || e.ctrlKey;

  // Arrange mode (Alt+G) owns the keyboard while active: home-row tweaks, Enter
  // to apply, Esc to cancel; everything else is swallowed.
  if (get(arrange)?.active) {
    if (e.key === "Escape") return e.preventDefault(), cancelArrange();
    if (e.key === "Enter") return e.preventDefault(), commitArrange();
    if (!e.altKey && !mod) {
      const k = e.key.toLowerCase();
      if (k === "a") return e.preventDefault(), arrangeToggleRowCol();
      if (k === "g") return e.preventDefault(), arrangeGridMode();
      if (k === "d") return e.preventDefault(), arrangeStep(1);
      if (k === "f") return e.preventDefault(), arrangeStep(-1);
    }
    e.preventDefault();
    return;
  }

  // Caption editor: Alt+C toggles it open/closed; Esc closes it. While open the
  // canvas is read-only, so every other shortcut is swallowed here. (We don't
  // preventDefault on the swallowed keys, so typing in a caption textarea still
  // works — the global shortcuts simply don't fire.)
  if (e.altKey && !mod && e.code === "KeyC") {
    e.preventDefault();
    toggleCaption();
    return;
  }
  if (get(captionOpen)) {
    if (e.key === "Escape") {
      e.preventDefault();
      captionOpen.set(false);
    }
    return;
  }

  const t = e.target as HTMLElement;
  const typing =
    t &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

  // Shortcuts that work even while typing: save/open.
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    e.shiftKey ? saveProjectAs() : saveProject();
    return;
  }
  if (typing) return;

  // Alt+L: toggle selected text as panel label(s) for captions.
  if (e.altKey && !mod && e.code === "KeyL") {
    e.preventDefault();
    togglePanelLabel();
    return;
  }

  // Alt+G: enter Arrange mode (snap the selection into a grid).
  if (e.altKey && !mod && e.code === "KeyG") {
    e.preventDefault();
    enterArrange();
    return;
  }

  // Alt+P: open the Plot X-Ray cockpit for the selected semantic plot.
  if (e.altKey && !mod && e.code === "KeyP") {
    e.preventDefault();
    openXray();
    return;
  }

  // Alt+I: open the Plot Importer (search/browse the project's plots/ dir).
  if (e.altKey && !mod && e.code === "KeyI") {
    e.preventDefault();
    if (get(embeddedProjectRoot) || get(projectDir)) importerOpen.set(true);
    return;
  }

  // Alignment: Alt + A/W/S/D (+ centre on H/V).
  if (e.altKey && !mod) {
    const k = e.key.toLowerCase();
    const map: Record<string, AlignKind | undefined> = {
      a: "left",
      d: "right",
      w: "top",
      s: "bottom",
      h: "centerH",
      v: "centerV",
    };
    if (map[k]) {
      e.preventDefault();
      doAlign(map[k]!);
      return;
    }
  }

  // Flip: Shift+H (horizontal), Shift+V (vertical). Must come before the plain
  // tool-key mapping below (which would otherwise treat v/h as tool switches).
  if (e.shiftKey && !mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "h") {
      e.preventDefault();
      flipSelected("h");
      return;
    }
    if (k === "v") {
      e.preventDefault();
      flipSelected("v");
      return;
    }
  }

  if (mod) {
    const k = e.key.toLowerCase();
    // Alt-modified: F9 select-same-fill (Shift = whole project), F10 copy/paste style.
    if (e.altKey) {
      if (k === "a") { e.preventDefault(); selectMatching("fill", e.shiftKey ? "project" : "figure"); return; }
      if (k === "c") { e.preventDefault(); copyStyle(); return; }
      if (k === "v") { e.preventDefault(); pasteStyle(); return; }
    }
    if (k === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (k === "y") {
      e.preventDefault();
      redo();
    } else if (k === "o") {
      e.preventDefault();
      openProject();
    } else if (k === "i") {
      e.preventDefault();
      importAssets();
    } else if (k === "d") {
      e.preventDefault();
      const fid = frameSelected();
      if (fid) duplicateFigure(fid);
      else duplicateSelected();
    } else if (k === "c") {
      copySelected();
    } else if (k === "v") {
      paste();
    } else if (k === "a") {
      e.preventDefault();
      selectAll();
    } else if (k === "g") {
      e.preventDefault();
      e.shiftKey ? ungroupSelected() : groupSelected();
    } else if (k === "l" && e.shiftKey) {
      e.preventDefault();
      toggleLockSelected();
    } else if (e.key === "]") {
      e.preventDefault();
      e.shiftKey ? raise(true) : bump(true);
    } else if (e.key === "[") {
      e.preventDefault();
      e.shiftKey ? raise(false) : bump(false);
    }
    return;
  }

  // Plain keys
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    if (!deleteFrame()) deleteSelected();
    return;
  }
  if (e.key === "Escape") {
    clearSelection();
    activeTool.set("select");
    return;
  }
  const step = e.shiftKey ? 10 : 1;
  if (frameSelected()) {
    if (e.key === "ArrowLeft") return e.preventDefault(), nudgeFrame(-step, 0);
    if (e.key === "ArrowRight") return e.preventDefault(), nudgeFrame(step, 0);
    if (e.key === "ArrowUp") return e.preventDefault(), nudgeFrame(0, -step);
    if (e.key === "ArrowDown") return e.preventDefault(), nudgeFrame(0, step);
  }
  if (e.key === "ArrowLeft") return e.preventDefault(), nudge(-step, 0);
  if (e.key === "ArrowRight") return e.preventDefault(), nudge(step, 0);
  if (e.key === "ArrowUp") return e.preventDefault(), nudge(0, -step);
  if (e.key === "ArrowDown") return e.preventDefault(), nudge(0, step);

  // Z-order via plain brackets: [ = send to back, ] = bring to front.
  if (e.key === "]") return e.preventDefault(), raise(true);
  if (e.key === "[") return e.preventDefault(), raise(false);

  // F opens the FluxFig Menu (property cockpit) when something is selected.
  const lk = e.key.toLowerCase();
  if (lk === "f") {
    e.preventDefault();
    if (get(selection).size > 0) fluxFigMenuOpen.set(true);
    return;
  }

  // Tool shortcuts are unmodified single keys (Shift+R is the ruler toggle, etc.).
  if (!e.shiftKey) {
    const tool = TOOL_KEYS[lk];
    if (tool) activeTool.set(tool);
  }
}

export { doAlign, doDistribute, duplicateSelected, deleteSelected, selectMatching, copyStyle, pasteStyle };
