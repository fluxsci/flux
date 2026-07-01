// ---------------------------------------------------------------------------
// Flux ops — the one pure mutation core.
//
// Every structural edit to a project (create/duplicate/delete a figure, add a
// panel, arrange/align/distribute, group, z-order, restyle a part, auto-letter
// panels, …) lives here as a PURE function `(p: Project, args) => result` that
// mutates the plain `types.ts` model in place. No Svelte stores, no DOM.
//
// Three callers share this one core so that "no capability is GUI-only":
//   • the GUI:        store.ts `commit((p) => ops.xxx(p, args))`  (undo-aware)
//   • flux-core:      reads the on-disk model, calls `ops.xxx`, writes it back
//   • the live bridge: maps a command → `commit((p) => ops.xxx(p, args))`
//
// Keep this module dependency-light: it may import only other pure leaves
// (types, ids, geometry, captions, layout). Importing store.ts/colors.ts/svelte
// here would re-introduce the GUI coupling this module exists to remove.
// ---------------------------------------------------------------------------

import type {
  Project,
  Figure,
  Element,
  Id,
  ImageElement,
  SvgElement,
  TextElement,
  SemanticPlotElement,
  PartOverride,
} from "./types";
import { newId } from "./ids";
import {
  arrangeGrid,
  alignElements,
  distributeElements,
  rotateAbout,
  selectionBBox,
  gridItemCount,
  validRowCounts,
  balancedRows,
  type AlignKind,
} from "./geometry";
import { figurePanels } from "./captions";

// Default frame size (US Letter @ 96dpi) — the single source for a blank figure
// (store.ts `blankFigure` reuses these so the GUI and agents agree).
export const BLANK_FIGURE = { width: 816, height: 1056, background: "#ffffff" } as const;

// ---------------------------------------------------------------------------
// Lookups / helpers
// ---------------------------------------------------------------------------
export function figById(p: Project, figId: Id): Figure | null {
  return p.figures.find((f) => f.id === figId) ?? null;
}

/** Resolve a target element set within a figure (defaults to all), then expand
 *  to whole groups (mirrors the GUI, which group-expands before arrange/align). */
function targetEls(fig: Figure, ids?: Id[]): Element[] {
  const base = ids && ids.length ? fig.elements.filter((e) => ids.includes(e.id)) : fig.elements;
  const groups = new Set<Id>();
  for (const e of base) if (e.groupId) groups.add(e.groupId);
  if (!groups.size) return base;
  const out = new Set(base);
  for (const e of fig.elements) if (e.groupId && groups.has(e.groupId)) out.add(e);
  return [...out];
}

// ---------------------------------------------------------------------------
// Figure (frame) lifecycle
// ---------------------------------------------------------------------------
export interface CreateFigureOpts {
  canvasId: Id;
  /** Explicit figure id (a clean slug → stable `@fig-<id>`); else auto-generated. */
  id?: Id;
  name?: string;
  /** Stack the new figure directly below this one (same x, under its bottom). */
  belowFigureId?: Id;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  background?: string;
}

export function createFigure(p: Project, opts: CreateFigureOpts): Figure {
  const onCanvas = p.figures.filter((f) => f.canvasId === opts.canvasId);
  let x = opts.x ?? 0;
  let y = opts.y ?? 0;
  if (opts.belowFigureId) {
    const ref = figById(p, opts.belowFigureId);
    const maxBottom = onCanvas.reduce((m, f) => Math.max(m, f.y + f.height), 0);
    x = opts.x ?? ref?.x ?? 0;
    y = opts.y ?? maxBottom + 80;
  }
  const fig: Figure = {
    id: opts.id ?? newId("fig"),
    name: opts.name ?? `Figure ${onCanvas.length + 1}`,
    canvasId: opts.canvasId,
    x,
    y,
    width: opts.width ?? BLANK_FIGURE.width,
    height: opts.height ?? BLANK_FIGURE.height,
    background: opts.background ?? BLANK_FIGURE.background,
    elements: [],
  };
  p.figures.push(fig);
  return fig;
}

/** Delete a figure; never leaves a canvas with zero figures (mirrors the GUI's
 *  frame delete). Returns the figure that should become active next. */
export function deleteFigure(p: Project, figId: Id): { nextActiveId: Id | null } {
  const victim = figById(p, figId);
  const cid = victim?.canvasId ?? null;
  p.figures = p.figures.filter((f) => f.id !== figId);
  const remaining = cid ? p.figures.filter((f) => f.canvasId === cid) : [];
  let nextActiveId: Id | null;
  if (cid && remaining.length === 0) {
    const blank = createFigure(p, { canvasId: cid });
    nextActiveId = blank.id;
  } else {
    nextActiveId = remaining[0]?.id ?? p.figures[0]?.id ?? null;
  }
  return { nextActiveId };
}

/** Duplicate a figure with all its elements — remapping element/group ids and
 *  re-keying captions — placed directly below it on the same canvas. Returns the
 *  new figure id. (Extracted from store.ts so flux-core/bridge share it.) */
export function duplicateFigure(p: Project, figId: Id): Id | null {
  const src = figById(p, figId);
  if (!src) return null;
  const onCanvas = p.figures.filter((f) => f.canvasId === src.canvasId);
  const maxBottom = onCanvas.reduce((m, f) => Math.max(m, f.y + f.height), 0);
  const idRemap = new Map<Id, Id>();
  const grpRemap = new Map<Id, Id>();
  const elements: Element[] = structuredClone(src.elements).map((el) => {
    const nid = newId(el.type);
    idRemap.set(el.id, nid);
    el.id = nid;
    if (el.groupId) {
      if (!grpRemap.has(el.groupId)) grpRemap.set(el.groupId, newId("grp"));
      el.groupId = grpRemap.get(el.groupId)!;
    }
    return el;
  });
  let captions: Record<Id, string> | undefined;
  if (src.captions) {
    captions = {};
    for (const [k, v] of Object.entries(src.captions)) captions[idRemap.get(k) ?? k] = v;
  }
  const copy: Figure = {
    id: newId("fig"),
    name: `${src.name} copy`,
    canvasId: src.canvasId,
    x: src.x,
    y: maxBottom + 80,
    width: src.width,
    height: src.height,
    background: src.background,
    elements,
    captions,
  };
  p.figures.push(copy);
  return copy.id;
}

export function setFigureLayout(
  p: Project,
  figId: Id,
  patch: { x?: number; y?: number; width?: number; height?: number; background?: string; name?: string },
): void {
  const f = figById(p, figId);
  if (!f) return;
  if (patch.x != null) f.x = patch.x;
  if (patch.y != null) f.y = patch.y;
  if (patch.width != null) f.width = patch.width;
  if (patch.height != null) f.height = patch.height;
  if (patch.background != null) f.background = patch.background;
  if (patch.name != null) f.name = patch.name;
}

// ---------------------------------------------------------------------------
// Element constructors (pure) + add
// ---------------------------------------------------------------------------
export interface Box {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

const box = (b: Box, dw: number, dh: number) => ({
  x: b.x ?? 20,
  y: b.y ?? 20,
  width: b.width ?? dw,
  height: b.height ?? dh,
});

export function makeImagePanel(assetId: Id, kind: "image" | "svg", b: Box = {}): ImageElement | SvgElement {
  const g = box(b, 240, 180);
  return { type: kind, id: newId(kind === "svg" ? "svg" : "img"), assetId, ...g, rotation: 0 };
}

export function makePlotPanel(
  assetId: Id,
  b: Box = {},
  source?: SemanticPlotElement["source"],
  manifestRef?: SemanticPlotElement["manifestRef"],
): SemanticPlotElement {
  const g = box(b, 240, 180);
  const el: SemanticPlotElement = { type: "plot", id: newId("plot"), assetId, ...g, rotation: 0 };
  if (source) el.source = source;
  if (manifestRef) el.manifestRef = manifestRef;
  return el;
}

export interface TextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  align?: "left" | "center" | "right";
  color?: string;
  autoWidth?: boolean;
}

export function makeText(text: string, b: Box, style: TextStyle = {}, panelLabel = false): TextElement {
  const g = box(b, 120, 32);
  return {
    type: "text",
    id: newId("text"),
    text,
    ...g,
    rotation: 0,
    fontFamily: style.fontFamily ?? "Arial",
    fontSize: style.fontSize ?? 24,
    fontWeight: style.fontWeight ?? (panelLabel ? 700 : 400),
    fontStyle: style.fontStyle ?? "normal",
    align: style.align ?? "left",
    color: style.color ?? "#222222",
    autoWidth: style.autoWidth ?? true,
    ...(panelLabel ? { panelLabel: true } : {}),
  };
}

/** Append a fully-formed element to a figure; returns its id (or null). */
export function addElement(p: Project, figId: Id, el: Element): Id | null {
  const f = figById(p, figId);
  if (!f) return null;
  f.elements.push(el);
  return el.id;
}

export function addImagePanel(
  p: Project,
  figId: Id,
  opts: { assetId: Id; kind?: "image" | "svg" } & Box,
): Id | null {
  return addElement(p, figId, makeImagePanel(opts.assetId, opts.kind ?? "image", opts));
}

export function addPlotPanel(
  p: Project,
  figId: Id,
  opts: { assetId: Id; source?: SemanticPlotElement["source"]; manifestRef?: SemanticPlotElement["manifestRef"] } & Box,
): Id | null {
  return addElement(p, figId, makePlotPanel(opts.assetId, opts, opts.source, opts.manifestRef));
}

export function addText(p: Project, figId: Id, opts: { text: string } & Box & TextStyle): Id | null {
  return addElement(p, figId, makeText(opts.text, opts, opts, false));
}

export function addPanelLabel(p: Project, figId: Id, opts: { text: string } & Box & TextStyle): Id | null {
  return addElement(p, figId, makeText(opts.text, opts, opts, true));
}

// ---------------------------------------------------------------------------
// Layout — arrange / align / distribute (wrap the pure geometry helpers)
// ---------------------------------------------------------------------------
export interface ArrangeOpts {
  cols?: number;
  rows?: number;
  gap?: number;
  ids?: Id[];
}

/** Reflow a figure's panels (or a subset) into a grid. `cols` wins; else `rows`
 *  is snapped to a valid count; else a balanced (near-square) grid. Mirrors the
 *  Inspector "Arrange to rows" path (geometry.arrangeGrid). */
export function arrangePanels(p: Project, figId: Id, opts: ArrangeOpts = {}): void {
  const f = figById(p, figId);
  if (!f) return;
  const els = targetEls(f, opts.ids);
  const n = gridItemCount(els);
  if (n < 2) return;
  let cols: number;
  if (opts.cols && opts.cols > 0) {
    cols = Math.min(opts.cols, n);
  } else if (opts.rows && opts.rows > 0) {
    const v = validRowCounts(n);
    const r = v.reduce((b, x) => (Math.abs(x - opts.rows!) < Math.abs(b - opts.rows!) ? x : b));
    cols = Math.ceil(n / r);
  } else {
    cols = Math.ceil(n / balancedRows(n));
  }
  arrangeGrid(els, cols, opts.gap != null ? { gap: opts.gap } : {});
}

/** Rotate elements by `deltaDeg` about a pivot (default = the group-expanded
 *  selection's bbox centre). Group-expands like the other layout ops so a whole
 *  group orbits rigidly. Backs the rotate handle + the `rotate` bridge/CLI verb;
 *  a single element about its own centre is equivalent to set_style{rotation}. */
export function rotateElements(
  p: Project,
  ids: Id[],
  deltaDeg: number,
  pivot?: { x: number; y: number },
): void {
  const set = new Set(ids);
  for (const f of p.figures) {
    if (!f.elements.some((e) => set.has(e.id))) continue;
    const targets = targetEls(f, ids);
    let piv = pivot;
    if (!piv) {
      const b = selectionBBox(targets);
      piv = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: 0, y: 0 };
    }
    rotateAbout(targets, piv, deltaDeg);
  }
}

export function alignPanels(p: Project, figId: Id, kind: AlignKind, ids?: Id[]): void {
  const f = figById(p, figId);
  if (!f) return;
  alignElements(targetEls(f, ids), kind);
}

export function distributePanels(p: Project, figId: Id, axis: "h" | "v", ids?: Id[]): void {
  const f = figById(p, figId);
  if (!f) return;
  distributeElements(targetEls(f, ids), axis);
}

// ---------------------------------------------------------------------------
// Grouping / z-order / delete (extracted from keyboard.ts so they're shared)
// ---------------------------------------------------------------------------
export function group(p: Project, ids: Id[]): Id | null {
  const set = new Set(ids);
  if (set.size < 2) return null;
  const gid = newId("grp");
  for (const f of p.figures) for (const e of f.elements) if (set.has(e.id)) e.groupId = gid;
  return gid;
}

export function ungroup(p: Project, ids: Id[]): void {
  const set = new Set(ids);
  for (const f of p.figures) for (const e of f.elements) if (set.has(e.id)) delete e.groupId;
}

export type ZOrder = "front" | "back" | "forward" | "backward";

/** Re-order elements within their figure. front/back move to the very ends;
 *  forward/backward bump one step (collision-aware, like the GUI's bump). */
export function setZOrder(p: Project, figId: Id, ids: Id[], where: ZOrder): void {
  const f = figById(p, figId);
  if (!f) return;
  const sel = new Set(ids);
  if (where === "front" || where === "back") {
    const picked = f.elements.filter((e) => sel.has(e.id));
    const rest = f.elements.filter((e) => !sel.has(e.id));
    f.elements = where === "front" ? [...rest, ...picked] : [...picked, ...rest];
    return;
  }
  const forward = where === "forward";
  const arr = f.elements;
  const order = forward ? [...arr.keys()].reverse() : [...arr.keys()];
  for (const i of order) {
    const jj = forward ? i + 1 : i - 1;
    if (jj < 0 || jj >= arr.length) continue;
    if (sel.has(arr[i].id) && !sel.has(arr[jj].id)) [arr[i], arr[jj]] = [arr[jj], arr[i]];
  }
}

export function deleteElements(p: Project, ids: Id[]): void {
  const set = new Set(ids);
  for (const f of p.figures) f.elements = f.elements.filter((e) => !set.has(e.id));
}

/** Move one element to an absolute z-index within its figure's `elements` array
 *  (0 = bottom). Backs the Layers panel drag-reorder + the `reorder` bridge/CLI
 *  verb; standard remove-then-insert semantics (toIndex is a post-removal slot). */
export function reorderElement(p: Project, figId: Id, id: Id, toIndex: number): void {
  const f = figById(p, figId);
  if (!f) return;
  const from = f.elements.findIndex((e) => e.id === id);
  if (from < 0) return;
  const [el] = f.elements.splice(from, 1);
  const idx = Math.max(0, Math.min(f.elements.length, Math.round(toIndex)));
  f.elements.splice(idx, 0, el);
}

// ---------------------------------------------------------------------------
// Styling — element-level + semantic-plot per-part overrides
// ---------------------------------------------------------------------------
export interface ElementStylePatch {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  align?: "left" | "center" | "right";
  cornerRadius?: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  locked?: boolean;
  hidden?: boolean;
  lockAspect?: boolean;
  name?: string;
}

/** Apply a style patch to a set of elements, assigning only the props valid for
 *  each element type (mirrors applyColor/setOpacity/setStrokeWidth in colors.ts). */
export function setElementStyle(p: Project, ids: Id[], patch: ElementStylePatch): void {
  const set = new Set(ids);
  for (const f of p.figures)
    for (const e of f.elements) {
      if (!set.has(e.id)) continue;
      if (patch.opacity != null) e.opacity = patch.opacity;
      if (patch.rotation != null) e.rotation = patch.rotation;
      if (patch.flipX != null) e.flipX = patch.flipX;
      if (patch.flipY != null) e.flipY = patch.flipY;
      if (patch.locked != null) e.locked = patch.locked;
      if (patch.hidden != null) e.hidden = patch.hidden;
      if (patch.lockAspect != null) e.lockAspect = patch.lockAspect;
      if (patch.name != null) e.name = patch.name;
      if (e.type === "text") {
        if (patch.color != null) e.color = patch.color;
        if (patch.fontFamily != null) e.fontFamily = patch.fontFamily;
        if (patch.fontSize != null) e.fontSize = patch.fontSize;
        if (patch.fontWeight != null) e.fontWeight = patch.fontWeight;
        if (patch.fontStyle != null) e.fontStyle = patch.fontStyle;
        if (patch.align != null) e.align = patch.align;
      } else if (e.type === "line") {
        if (patch.stroke != null) e.stroke = patch.stroke;
        if (patch.strokeWidth != null) e.strokeWidth = patch.strokeWidth;
      } else if (e.type === "rect" || e.type === "ellipse" || e.type === "path") {
        if (patch.fill != null) e.fill = patch.fill;
        if (patch.stroke != null) e.stroke = patch.stroke;
        if (patch.strokeWidth != null) e.strokeWidth = patch.strokeWidth;
        if (e.type === "rect" && patch.cornerRadius != null) e.cornerRadius = patch.cornerRadius;
      }
    }
}

/** Write a per-part override onto a semantic plot, keyed by stable semantic id
 *  (e.g. "control.line"). Survives regeneration (ids are deterministic).
 *  Extracted from colors.ts `applyPartStyleTo`. */
export function setPartOverride(p: Project, elementId: Id, partId: string, patch: PartOverride): void {
  for (const f of p.figures)
    for (const e of f.elements) {
      if (e.id !== elementId || e.type !== "plot") continue;
      e.overrides = { ...(e.overrides ?? {}) };
      e.overrides[partId] = { ...(e.overrides[partId] ?? {}), ...patch };
    }
}

// ---------------------------------------------------------------------------
// Panel labels — auto-letter (a, b, c …) by reading order (extracted from store)
// ---------------------------------------------------------------------------
export function autoLetterPanels(p: Project, figId: Id): void {
  const TOL = 24; // world-unit row tolerance for grouping labels into rows
  const f = figById(p, figId);
  if (!f) return;
  const labels = f.elements.filter((e) => e.type === "text" && e.panelLabel);
  labels.sort((a, b) => Math.round(a.y / TOL) - Math.round(b.y / TOL) || a.x - b.x);
  labels.forEach((e, i) => {
    if (e.type === "text") e.text = String.fromCharCode(97 + (i % 26));
  });
}

// Re-export so callers needing the panel inventory don't reach past ops.
export { figurePanels };
