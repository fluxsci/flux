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
  GroupDef,
  Id,
  CropRect,
  ImageElement,
  TextElement,
  TextStyle,
  SemanticPlotElement,
  PathElement,
  VectorNode,
  PartOverride,
} from "./types";
import { newId } from "./ids";
import {
  ancestorsOf,
  chainOf,
  cloneGroupsFor,
  gcGroups,
  groupDefs,
  membersDeep,
  nextGroupName,
  topGroupOf,
  unitKeyOf,
  unitOf,
} from "./groups";
import { refitPath, pathToNodes } from "./path";
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
import { scaleRemap } from "./editing";
import { figurePanels } from "./captions";

// Default frame size — a full-page journal figure, 180 × 225 mm (the Nature-family
// maximum figure size), expressed in the canvas's 96 dpi design px: 180/25.4×96 ≈ 680,
// 225/25.4×96 ≈ 850 (exactly 4:5). The physical size binds at export — "180 mm @
// 300 dpi" rasterizes to 2126 px wide via journalSizing.planExport. The single source
// for a blank figure (store.ts `blankFigure` and scaffoldTree reuse these so the GUI,
// CLI, and agents agree).
export const BLANK_FIGURE = { width: 680, height: 850, background: "#ffffff" } as const;

// ---------------------------------------------------------------------------
// Lookups / helpers
// ---------------------------------------------------------------------------
export function figById(p: Project, figId: Id): Figure | null {
  return p.figures.find((f) => f.id === figId) ?? null;
}

/** An asset's true physical size in canvas px (96/inch). SVG naturalWidth is already
 *  CSS px (physical); a PNG with a declared dpi (pHYs) is converted; a bare raster
 *  falls back to 1 image px = 1 canvas px. Placement/reset must use THIS, never a
 *  fit-to-frame rescale — physical size is the contract (WYSIWYG at export). */
export function assetDisplaySize(p: Project, assetId: Id): { width: number; height: number } | null {
  const a = p.assets.find((x) => x.id === assetId);
  if (!a || !(a.naturalWidth > 0) || !(a.naturalHeight > 0)) return null;
  const k = a.kind === "png" && a.dpi && a.dpi > 0 ? 96 / a.dpi : 1;
  return { width: a.naturalWidth * k, height: a.naturalHeight * k };
}

/** Resolve a target element set within a figure (defaults to all), then expand
 *  to whole groups (mirrors the GUI, which group-expands before arrange/align).
 *  Group-aware (P7): a member id pulls in its TOP-level group's members deep;
 *  elements sharing a dangling groupId (no registry def) still co-expand. */
function targetEls(fig: Figure, ids?: Id[]): Element[] {
  const base = ids && ids.length ? fig.elements.filter((e) => ids.includes(e.id)) : fig.elements;
  const defs = groupDefs(fig);
  const tops = new Set<Id>();
  const dangling = new Set<Id>();
  for (const e of base) {
    if (!e.groupId) continue;
    const top = topGroupOf(fig, e.groupId);
    if (top) tops.add(top);
    else if (!defs[e.groupId]) dangling.add(e.groupId);
  }
  if (!tops.size && !dangling.size) return base;
  const out = new Set(base);
  for (const e of fig.elements) {
    if (!e.groupId) continue;
    if (dangling.has(e.groupId)) out.add(e);
    else if (ancestorsOf(fig, e.groupId).some((g) => tops.has(g))) out.add(e);
  }
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
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  background?: string;
}

export function createFigure(p: Project, opts: CreateFigureOpts): Figure {
  const onCanvas = p.figures.filter((f) => f.canvasId === opts.canvasId);
  // Default placement stacks vertically: directly below the lowest figure on
  // the canvas, left-aligned with the first one. Headless composes used to
  // default to (0,0) and pile every figure on top of the previous.
  const maxBottom = onCanvas.reduce((m, f) => Math.max(m, f.y + f.height), 0);
  const x = opts.x ?? (onCanvas.length ? onCanvas[0].x : 0);
  const y = opts.y ?? (onCanvas.length ? maxBottom + 80 : 0);
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

/** Delete a figure. By default never leaves a canvas with zero figures
 *  (mirrors the GUI's frame delete, which always shows a frame). Headless
 *  callers pass `allowEmpty` — an auto-created blank silently takes order 1
 *  and shifts every real figure's number, which corrupts `@fig-…` refs.
 *  Returns the figure that should become active next. */
export function deleteFigure(
  p: Project,
  figId: Id,
  opts: { allowEmpty?: boolean } = {},
): { nextActiveId: Id | null } {
  const victim = figById(p, figId);
  const cid = victim?.canvasId ?? null;
  p.figures = p.figures.filter((f) => f.id !== figId);
  const remaining = cid ? p.figures.filter((f) => f.canvasId === cid) : [];
  let nextActiveId: Id | null;
  if (cid && remaining.length === 0 && !opts.allowEmpty) {
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
  // Shared group-clone core: fresh group ids with names/nesting/state preserved.
  const grpRemap = new Map<Id, Id>();
  const clonedGroups = cloneGroupsFor(src.groups, src.elements, grpRemap);
  const elements: Element[] = structuredClone(src.elements).map((el) => {
    const nid = newId(el.type);
    idRemap.set(el.id, nid);
    el.id = nid;
    if (el.groupId) el.groupId = grpRemap.get(el.groupId) ?? el.groupId;
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
    ...(Object.keys(clonedGroups).length ? { groups: clonedGroups } : {}),
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

// PNG-only (figure-v1 P4): every SVG is a semantic plot — use makePlotPanel.
export function makeImagePanel(assetId: Id, b: Box = {}): ImageElement {
  const g = box(b, 240, 180);
  return { type: "image", id: newId("img"), assetId, ...g, rotation: 0 };
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

// Optional text properties for the constructors below. (Renamed from the old
// `TextStyle` interface — that name now means a NAMED, reusable style in
// types.ts; this is just a bag of per-call options.)
export interface TextOpts {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  underline?: boolean;
  lineHeight?: number;
  align?: "left" | "center" | "right";
  color?: string;
  sizing?: "auto" | "auto-h" | "fixed";
  styleId?: Id;
}

export function makeText(text: string, b: Box, style: TextOpts = {}, panelLabel = false): TextElement {
  const g = box(b, 120, 32);
  return {
    type: "text",
    id: newId("text"),
    text,
    ...g,
    rotation: 0,
    fontFamily: style.fontFamily ?? "Arial",
    // Defaults are journal-spec: 7 pt body text, 8 pt bold panel letters — stored in
    // canvas px (pt × 4/3; the UI edits in pt). Callers passing fontSize pass px.
    fontSize: style.fontSize ?? (panelLabel ? 32 / 3 : 28 / 3),
    fontWeight: style.fontWeight ?? (panelLabel ? 700 : 400),
    fontStyle: style.fontStyle ?? "normal",
    ...(style.underline != null ? { underline: style.underline } : {}),
    ...(style.lineHeight != null ? { lineHeight: style.lineHeight } : {}),
    align: style.align ?? "left",
    color: style.color ?? "#222222",
    sizing: style.sizing ?? "auto",
    ...(style.styleId ? { styleId: style.styleId } : {}),
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

export function addImagePanel(p: Project, figId: Id, opts: { assetId: Id } & Box): Id | null {
  return addElement(p, figId, makeImagePanel(opts.assetId, opts));
}

export function addPlotPanel(
  p: Project,
  figId: Id,
  opts: { assetId: Id; source?: SemanticPlotElement["source"]; manifestRef?: SemanticPlotElement["manifestRef"] } & Box,
): Id | null {
  return addElement(p, figId, makePlotPanel(opts.assetId, opts, opts.source, opts.manifestRef));
}

export function addText(p: Project, figId: Id, opts: { text: string } & Box & TextOpts): Id | null {
  return addElement(p, figId, makeText(opts.text, opts, opts, false));
}

// ---------------------------------------------------------------------------
// Vector paths (Feature 1) — authored from a node list. `nodes` is authoritative;
// `d`/width/height are derived (refitPath). Backs the pen tool, node editing, and
// the add_path / edit_path bridge + `add-path` CLI verb.
// ---------------------------------------------------------------------------
export interface AddPathOpts {
  nodes: VectorNode[];
  closed?: boolean;
  x?: number;
  y?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export function addPath(p: Project, figId: Id, opts: AddPathOpts): Id | null {
  const f = figById(p, figId);
  if (!f || !opts.nodes?.length) return null;
  const el: PathElement = {
    type: "path",
    id: newId("path"),
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: 1,
    height: 1,
    rotation: 0,
    d: "",
    fill: opts.fill ?? "#cccccc",
    stroke: opts.stroke ?? "#222222",
    strokeWidth: opts.strokeWidth ?? 2,
    closed: !!opts.closed,
    nodes: structuredClone(opts.nodes),
  };
  refitPath(el); // normalize nodes, set width/height + d
  f.elements.push(el);
  return el.id;
}

/** Replace a path's nodes and/or closed flag, regenerating d + bbox. Adopts a
 *  legacy d-only path's geometry into nodes first, so any path stays editable. */
export function updatePath(
  p: Project,
  id: Id,
  patch: { nodes?: VectorNode[]; closed?: boolean },
): void {
  for (const f of p.figures)
    for (const e of f.elements) {
      if (e.id !== id || e.type !== "path") continue;
      if (!e.nodes) e.nodes = pathToNodes(e.d);
      if (patch.nodes) e.nodes = structuredClone(patch.nodes);
      if (patch.closed != null) e.closed = patch.closed;
      refitPath(e);
    }
}

export function addPanelLabel(p: Project, figId: Id, opts: { text: string } & Box & TextOpts): Id | null {
  const el = makeText(opts.text, opts, opts, true);
  // Link the seeded "Panel Label" named style when the project has it (and the
  // caller didn't override fonts): new labels then follow style edits live.
  const st = p.textStyles?.find((s) => s.id === "ts-panel-label");
  if (st && opts.fontFamily == null && opts.fontSize == null && opts.fontWeight == null && !opts.styleId) {
    assignTextStyle(el, st);
  }
  return addElement(p, figId, el);
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

export function distributePanels(p: Project, figId: Id, axis: "h" | "v", ids?: Id[], gap?: number): void {
  const f = figById(p, figId);
  if (!f) return;
  distributeElements(targetEls(f, ids), axis, gap);
}

// --- ruler guides (Feature 11) — figure-local guide lines elements snap to ---
const roundGuides = (a?: number[]): number[] =>
  a ? [...new Set(a.map((v) => Math.round(v * 100) / 100))].sort((m, n) => m - n) : [];

/** Replace a figure's guides wholesale (either axis optional → cleared). */
export function setGuides(p: Project, figId: Id, guides: { x?: number[]; y?: number[] }): void {
  const f = figById(p, figId);
  if (!f) return;
  f.guides = { x: roundGuides(guides.x), y: roundGuides(guides.y) };
}

/** Add one guide on an axis (idempotent — dedupes to ~0.01 units). */
export function addGuide(p: Project, figId: Id, axis: "x" | "y", pos: number): void {
  const f = figById(p, figId);
  if (!f) return;
  const g = f.guides ?? {};
  f.guides = { x: roundGuides(g.x), y: roundGuides(g.y) };
  f.guides[axis] = roundGuides([...(f.guides[axis] ?? []), pos]);
}

/** Remove the guide on `axis` nearest `pos` within `tol` (world units). */
export function removeGuide(p: Project, figId: Id, axis: "x" | "y", pos: number, tol = 6): void {
  const f = figById(p, figId);
  if (!f?.guides?.[axis]) return;
  const arr = f.guides[axis]!;
  let bi = -1;
  let bd = tol;
  arr.forEach((v, i) => {
    const d = Math.abs(v - pos);
    if (d <= bd) {
      bd = d;
      bi = i;
    }
  });
  if (bi >= 0) f.guides[axis] = arr.filter((_, i) => i !== bi);
}

// ---------------------------------------------------------------------------
// Grouping / z-order / delete — registry-backed named nestable groups (P7).
// The pure tree/ancestry helpers live in groups.ts; the ops here are the only
// writers of Figure.groups + the z-contiguity invariant.
// ---------------------------------------------------------------------------

/** Splice the given members into ONE contiguous z-run anchored at the TOPMOST
 *  member's index (Figma: a new group assumes its topmost member's z), with
 *  relative order preserved. Under the invariant the insertion point is always
 *  a run boundary of any other group (a foreign run can't straddle a member). */
function spliceContiguous(f: Figure, memberIds: Set<Id>): void {
  const idx: number[] = [];
  f.elements.forEach((e, i) => {
    if (memberIds.has(e.id)) idx.push(i);
  });
  if (idx.length < 2) return;
  const top = idx[idx.length - 1];
  const block = f.elements.filter((e) => memberIds.has(e.id));
  const rest = f.elements.filter((e) => !memberIds.has(e.id));
  rest.splice(top - (idx.length - 1), 0, ...block);
  f.elements = rest;
}

export interface GroupOpts {
  /** Group name; defaults to "Group N" (N unique among the figure's defaults). */
  name?: string;
  /** Create the group nested under this existing group, and resolve the
   *  selection's units within that scope (grouping inside an entered group —
   *  the Canvas wave's caller). Ignored when unregistered. */
  parentId?: Id;
}

/** Group ≥2 top-level units — loose elements and/or WHOLE top groups — of one
 *  figure into a new named registry group. Figma ⌘G semantics: selected top
 *  groups NEST (their def gains parentId = the new gid) instead of dissolving;
 *  a partial member selection pulls in its whole group. Members are spliced
 *  into one contiguous z-run at the topmost member's index. Returns the new
 *  group id, or null when there is nothing to group. */
export function group(p: Project, ids: Id[], opts: GroupOpts = {}): Id | null {
  const idSet = new Set(ids);
  const f = p.figures.find((ff) => ff.elements.some((e) => idSet.has(e.id)));
  if (!f) return null;
  const scope = opts.parentId && groupDefs(f)[opts.parentId] ? opts.parentId : undefined;
  // Resolve the selection to distinct units at the scope level.
  const unitGroups: Id[] = [];
  const unitEls: Element[] = [];
  const seenG = new Set<Id>();
  for (const e of f.elements) {
    if (!idSet.has(e.id)) continue;
    // With a scope, only members of that scope participate.
    if (scope && !ancestorsOf(f, e.groupId).includes(scope)) continue;
    const u = unitOf(f, e, scope ?? null);
    if (u.groupId) {
      if (!seenG.has(u.groupId)) {
        seenG.add(u.groupId);
        unitGroups.push(u.groupId);
      }
    } else {
      unitEls.push(e);
    }
  }
  if (unitGroups.length + unitEls.length < 2) return null;
  const gid = newId("grp");
  const def: GroupDef = { id: gid, name: opts.name?.trim() || nextGroupName(f) };
  if (scope) def.parentId = scope;
  f.groups = f.groups ?? {};
  f.groups[gid] = def;
  for (const cg of unitGroups) f.groups[cg].parentId = gid; // nest whole child groups
  for (const e of unitEls) e.groupId = gid; // loose elements join directly
  spliceContiguous(f, new Set(membersDeep(f, gid).map((e) => e.id)));
  return gid;
}

/** Rename a registry group. Returns false when the id is unknown. */
export function renameGroup(p: Project, groupId: Id, name: string): boolean {
  const nm = name.trim();
  if (!nm) return false;
  for (const f of p.figures) {
    const g = f.groups?.[groupId];
    if (g) {
      g.name = nm;
      return true;
    }
  }
  return false;
}

/** Set a group's own hidden/locked flags (the Layers panel group eye/padlock).
 *  Members keep their individual flags; renderers combine via groups.ts
 *  effectiveHidden/effectiveLocked. Returns false when the id is unknown. */
export function setGroupState(p: Project, groupId: Id, patch: { hidden?: boolean; locked?: boolean }): boolean {
  for (const f of p.figures) {
    const g = f.groups?.[groupId];
    if (!g) continue;
    if (patch.hidden != null) {
      if (patch.hidden) g.hidden = true;
      else delete g.hidden;
    }
    if (patch.locked != null) {
      if (patch.locked) g.locked = true;
      else delete g.locked;
    }
    return true;
  }
  return false;
}

// Select-all-with-same (Feature 9). The comparable value of an element for a given
// facet — fill / stroke / font / type — or null when the facet doesn't apply.
export type MatchBy = "fill" | "stroke" | "font" | "type";
export function elementMatchValue(e: Element, by: MatchBy): string | null {
  if (by === "type") return e.type;
  if (by === "font") return e.type === "text" ? e.fontFamily : null;
  if (by === "fill") return "fill" in e ? (e as { fill: string }).fill : e.type === "text" ? e.color : null;
  return "stroke" in e ? (e as { stroke: string }).stroke : null; // stroke
}

/** Ids of every element matching `refId`'s fill/stroke/font/type, within the
 *  reference's figure (scope "figure") or the whole project (scope "project").
 *  Includes the reference. Backs the GUI "select same" + bridge select_matching. */
export function matchElements(p: Project, refId: Id, by: MatchBy, scope: "figure" | "project" = "figure"): Id[] {
  let ref: Element | null = null;
  let refFig: Figure | null = null;
  for (const f of p.figures) for (const e of f.elements) if (e.id === refId) { ref = e; refFig = f; }
  if (!ref) return [];
  const val = elementMatchValue(ref, by);
  if (val == null) return [refId];
  const figs = scope === "project" ? p.figures : refFig ? [refFig] : [];
  const out: Id[] = [];
  for (const f of figs) for (const e of f.elements) if (elementMatchValue(e, by) === val) out.push(e.id);
  return out;
}

/** Ids of every element whose `by` facet equals `value` (bridge path — no ref). */
export function matchByValue(p: Project, by: MatchBy, value: string, scope: "figure" | "project", figId?: Id): Id[] {
  const figs = scope === "project" ? p.figures : p.figures.filter((f) => f.id === figId);
  const out: Id[] = [];
  for (const f of figs) for (const e of f.elements) if (elementMatchValue(e, by) === value) out.push(e.id);
  return out;
}

// Proportional scale (Feature 5): scale `ids` about a pivot (default = their
// bbox centre) by `factor`, multiplying geometry AND stroke/corner/font weights so
// the whole mark shrinks/grows uniformly. Shares editing.scaleRemap with the GUI
// Scale tool. No-op for factor ≤ 0.
export function scaleElements(p: Project, ids: Id[], factor: number, pivot?: { x: number; y: number }): void {
  if (!(factor > 0)) return;
  const set = new Set(ids);
  for (const f of p.figures) {
    const targets = f.elements.filter((e) => set.has(e.id));
    if (!targets.length) continue;
    const ob = selectionBBox(targets);
    if (!ob) continue;
    const cx = pivot?.x ?? ob.x + ob.w / 2;
    const cy = pivot?.y ?? ob.y + ob.h / 2;
    // new bbox: same centre-relative layout, scaled about the pivot
    const nb = { x: cx + (ob.x - cx) * factor, y: cy + (ob.y - cy) * factor, w: ob.w * factor, h: ob.h * factor };
    for (const e of targets) {
      const orig = structuredClone(e);
      scaleRemap(e, orig, ob, nb);
    }
  }
}

// Smart duplicate (Feature 4): clone `ids` in their figure `count` times, each
// stamp offset by k·(dx,dy) and given fresh element + group ids (so every stamp is
// independent and regroup-safe). Returns the new ids of the LAST stamp so a
// repeat run (Ctrl+D) keeps stepping. `count` defaults to 1.
export function duplicateElements(
  p: Project,
  figId: Id,
  ids: Id[],
  opts: { dx?: number; dy?: number; count?: number } = {},
): Id[] {
  const f = figById(p, figId);
  if (!f) return [];
  const set = new Set(ids);
  const originals = f.elements.filter((e) => set.has(e.id));
  if (!originals.length) return [];
  const dx = opts.dx ?? 0;
  const dy = opts.dy ?? 0;
  const count = Math.max(1, Math.floor(opts.count ?? 1));
  let lastStamp: Id[] = [];
  for (let k = 1; k <= count; k++) {
    // Fresh remap per stamp: each stamp gets its own cloned group defs (names/
    // nesting preserved, independent identity) via the shared cloneGroupsFor.
    const grpRemap = new Map<Id, Id>();
    const cloned = cloneGroupsFor(f.groups, originals, grpRemap);
    if (Object.keys(cloned).length) {
      f.groups = f.groups ?? {};
      Object.assign(f.groups, cloned);
    }
    const stamp: Id[] = [];
    const copies = originals.map((e) => {
      const c = structuredClone(e);
      c.id = newId(c.type);
      if (c.groupId) c.groupId = grpRemap.get(c.groupId) ?? c.groupId;
      c.x += dx * k;
      c.y += dy * k;
      stamp.push(c.id);
      return c;
    });
    f.elements.push(...copies);
    lastStamp = stamp;
  }
  return lastStamp;
}

/** Dissolve groups, one level per call (Figma ⌘⇧G). Each id may be an ELEMENT
 *  id — its TOP-level group dissolves — or a GROUP id — that exact group
 *  dissolves. Dissolving moves the group's immediate element members to its
 *  parent group (or loose at top level) and reparents its child groups the
 *  same way; nested memberships inside surviving child groups are untouched.
 *  Elements with a dangling flat groupId (no registry def) simply drop it.
 *  Ends with a registry GC. */
export function ungroup(p: Project, ids: Id[]): void {
  const set = new Set(ids);
  for (const f of p.figures) {
    const defs = f.groups ?? {};
    const dissolve = new Set<Id>();
    for (const id of set) if (defs[id]) dissolve.add(id);
    let touched = dissolve.size > 0;
    for (const e of f.elements) {
      if (!set.has(e.id) || !e.groupId) continue;
      const top = topGroupOf(f, e.groupId);
      if (top) {
        dissolve.add(top);
        touched = true;
      } else {
        delete e.groupId; // dangling flat id — legacy behavior
        touched = true;
      }
    }
    if (!touched) continue;
    for (const gid of dissolve) {
      const pid = defs[gid]?.parentId;
      const parent = pid && defs[pid] ? pid : undefined;
      for (const e of f.elements)
        if (e.groupId === gid) {
          if (parent) e.groupId = parent;
          else delete e.groupId;
        }
      for (const g of Object.values(defs))
        if (g.parentId === gid) {
          if (parent) g.parentId = parent;
          else delete g.parentId;
        }
      delete defs[gid];
    }
    gcGroups(f);
  }
}

export type ZOrder = "front" | "back" | "forward" | "backward";

// The moving/sibling structure setZOrder operates on: the selection resolved
// to whole UNITS among their siblings at one nesting level (see resolveZScope).
interface ZUnit {
  key: string;
  els: Element[];
  selected: boolean;
}

/** Resolve a selection to the nesting level it moves at: `scope` = the group
 *  whose children the selected units are (null = top level), plus the unit
 *  keys that count as selected. A selection covering ALL of one group moves
 *  that GROUP among its own siblings; a partial selection inside one group
 *  moves the touched child units within it; anything else moves top units. */
function resolveZScope(f: Figure, sel: Set<Id>): { scope: Id | null; selKeys: Set<string> } {
  const targets = f.elements.filter((e) => sel.has(e.id));
  let common: Id[] | null = null;
  for (const e of targets) {
    const chain = chainOf(f, e);
    if (common === null) common = chain;
    else {
      let k = 0;
      while (k < common.length && k < chain.length && common[k] === chain[k]) k++;
      common = common.slice(0, k);
    }
    if (!common.length) break;
  }
  let scope: Id | null = common && common.length ? common[common.length - 1] : null;
  const selKeys = new Set<string>();
  if (scope && membersDeep(f, scope).every((e) => sel.has(e.id))) {
    // the whole deepest common group is selected — IT is the moving unit
    const pid = groupDefs(f)[scope].parentId;
    selKeys.add("g:" + scope);
    scope = pid && groupDefs(f)[pid] ? pid : null;
  } else {
    for (const e of targets) selKeys.add(unitKeyOf(f, e, scope));
  }
  return { scope, selKeys };
}

/** The contiguous slice of `f.elements` the scope's children occupy (whole
 *  array at top level), partitioned into sibling unit blocks in z-order. */
function zUnitsIn(f: Figure, scope: Id | null): { start: number; units: ZUnit[] } {
  let start = 0;
  let range = f.elements;
  if (scope) {
    const idx: number[] = [];
    f.elements.forEach((e, i) => {
      if (ancestorsOf(f, e.groupId).includes(scope)) idx.push(i);
    });
    if (!idx.length) return { start: 0, units: [] };
    start = idx[0];
    range = f.elements.slice(idx[0], idx[idx.length - 1] + 1);
  }
  const units: ZUnit[] = [];
  let last: ZUnit | null = null;
  for (const e of range) {
    const key = unitKeyOf(f, e, scope);
    if (last && last.key === key) {
      last.els.push(e);
      continue;
    }
    last = { key, els: [e], selected: false };
    units.push(last);
  }
  return { start, units };
}

/** Re-order elements within their figure, group-aware (P7): the selection
 *  resolves to whole UNITS (top-level groups + loose elements — or one group's
 *  child units when the ids all live inside it) and units move as intact
 *  blocks among their siblings, so no group's contiguous run ever fragments.
 *  front/back move to the ends of the sibling range; forward/backward bump one
 *  sibling step (collision-aware, like the GUI's bump). */
export function setZOrder(p: Project, figId: Id, ids: Id[], where: ZOrder): void {
  const f = figById(p, figId);
  if (!f) return;
  const sel = new Set(ids);
  if (!f.elements.some((e) => sel.has(e.id))) return;
  const { scope, selKeys } = resolveZScope(f, sel);
  const { start, units } = zUnitsIn(f, scope);
  if (!units.length) return;
  for (const u of units) u.selected = selKeys.has(u.key);
  let ordered: ZUnit[];
  if (where === "front" || where === "back") {
    const picked = units.filter((u) => u.selected);
    const rest = units.filter((u) => !u.selected);
    ordered = where === "front" ? [...rest, ...picked] : [...picked, ...rest];
  } else {
    ordered = [...units];
    const forward = where === "forward";
    const order = forward ? [...ordered.keys()].reverse() : [...ordered.keys()];
    for (const i of order) {
      const jj = forward ? i + 1 : i - 1;
      if (jj < 0 || jj >= ordered.length) continue;
      if (ordered[i].selected && !ordered[jj].selected) [ordered[i], ordered[jj]] = [ordered[jj], ordered[i]];
    }
  }
  const flat = ordered.flatMap((u) => u.els);
  f.elements.splice(start, flat.length, ...flat);
}

export function deleteElements(p: Project, ids: Id[]): void {
  const set = new Set(ids);
  for (const f of p.figures) {
    const before = f.elements.length;
    f.elements = f.elements.filter((e) => !set.has(e.id));
    if (f.elements.length !== before) gcGroups(f); // drop now-empty group defs
  }
}

/** Move one element — or a whole GROUP (pass its registry id) — to an absolute
 *  z-index within its figure (0 = bottom; post-removal slot, as before). Backs
 *  the Layers panel drag-reorder + the `reorder` bridge/CLI verb. Group-aware
 *  (P7): a group id moves its entire contiguous run as one block; an element
 *  stays inside its own group's run; and the requested index SNAPS to the
 *  nearest slot that keeps every group's run contiguous — a foreign element
 *  can never land inside another group's run. */
export function reorderElement(p: Project, figId: Id, id: Id, toIndex: number): void {
  const f = figById(p, figId);
  if (!f) return;
  const defs = groupDefs(f);
  let block: Element[];
  let containerId: Id | undefined; // the moving unit's immediate parent group
  if (defs[id]) {
    block = membersDeep(f, id);
    const pid = defs[id].parentId;
    containerId = pid && defs[pid] ? pid : undefined;
  } else {
    const el = f.elements.find((e) => e.id === id);
    if (!el) return;
    block = [el];
    containerId = el.groupId && defs[el.groupId] ? el.groupId : undefined;
  }
  if (!block.length) return;
  const moving = new Set(block.map((e) => e.id));
  const rest = f.elements.filter((e) => !moving.has(e.id));
  // groups the insertion slot MUST stay inside (the moving unit's ancestors)
  const need = new Set(ancestorsOf(f, containerId));
  // every registered group's remaining deep-member span within `rest`
  const spans = new Map<Id, { a: number; b: number }>();
  rest.forEach((e, i) => {
    for (const gid of ancestorsOf(f, e.groupId)) {
      const s = spans.get(gid);
      if (!s) spans.set(gid, { a: i, b: i });
      else s.b = i;
    }
  });
  const valid = (s: number): boolean => {
    for (const [gid, r] of spans) {
      if (need.has(gid)) {
        if (s < r.a || s > r.b + 1) return false; // must stay inside own container
      } else if (s > r.a && s <= r.b) {
        return false; // would split a foreign run
      }
    }
    return true;
  };
  const want = Math.max(0, Math.min(rest.length, Math.round(toIndex)));
  let slot = -1;
  for (let d = 0; d <= rest.length && slot < 0; d++) {
    for (const cand of d === 0 ? [want] : [want - d, want + d]) {
      if (cand < 0 || cand > rest.length) continue;
      if (valid(cand)) {
        slot = cand;
        break;
      }
    }
  }
  if (slot < 0) return; // no legal slot (degenerate registry) — leave as-is
  rest.splice(slot, 0, ...block);
  f.elements = rest;
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
  underline?: boolean;
  lineHeight?: number;
  sizing?: "auto" | "auto-h" | "fixed";
  align?: "left" | "center" | "right";
  cornerRadius?: number;
  // line/arrow (figure-v1: Figma-parity stroke controls)
  cap?: "butt" | "round" | "square";
  arrowStart?: boolean;
  arrowEnd?: boolean;
  arrowStyle?: "filled" | "vee";
  arrowSize?: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  locked?: boolean;
  hidden?: boolean;
  lockAspect?: boolean;
  name?: string;
}

// Patch keys that change text layout/metrics — a patch touching any of them
// invalidates the derived wrap cache (`lines`); the GUI seams then reflow
// (text.ts reflowTexts) while headless callers stay correct via the fallback.
const TEXT_LAYOUT_KEYS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "sizing"] as const;
// Font-identity keys: manually editing one DETACHES a linked named style
// (color/align detach only when the style actually defines them).
const FONT_KEYS = new Set(["fontFamily", "fontSize", "fontWeight", "fontStyle", "underline", "lineHeight"]);

/** Drop a stale derived wrap cache (pure cache invalidation, DOM-free). */
function invalidateTextLayout(e: Element): void {
  if (e.type === "text") delete e.lines;
}

/** Detach a linked named style when a manual edit overrides it: any font-prop
 *  key always detaches; color/align only if the linked style defines them. */
export function detachOnManualEdit(p: Project, e: TextElement, keys: Iterable<string>): void {
  if (!e.styleId) return;
  const st = p.textStyles?.find((s) => s.id === e.styleId);
  for (const k of keys) {
    if (FONT_KEYS.has(k) || (k === "color" && st?.color != null) || (k === "align" && st?.align != null)) {
      delete e.styleId;
      return;
    }
  }
}

/** Apply a style patch to a set of elements, assigning only the props valid for
 *  each element type (mirrors applyColor/setOpacity/setStrokeWidth in colors.ts). */
export function setElementStyle(p: Project, ids: Id[], patch: ElementStylePatch): void {
  const set = new Set(ids);
  const layoutTouched = TEXT_LAYOUT_KEYS.some((k) => patch[k] != null);
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
        if (patch.underline != null) e.underline = patch.underline;
        if (patch.lineHeight != null) e.lineHeight = patch.lineHeight;
        if (patch.sizing != null) e.sizing = patch.sizing;
        if (patch.align != null) e.align = patch.align;
        if (layoutTouched) invalidateTextLayout(e);
        detachOnManualEdit(p, e, Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] != null));
      } else if (e.type === "line") {
        if (patch.stroke != null) e.stroke = patch.stroke;
        if (patch.strokeWidth != null) e.strokeWidth = patch.strokeWidth;
        if (patch.cap != null) e.cap = patch.cap;
        if (patch.arrowStart != null) e.arrowStart = patch.arrowStart;
        if (patch.arrowEnd != null) e.arrowEnd = patch.arrowEnd;
        if (patch.arrowStyle != null) e.arrowStyle = patch.arrowStyle;
        if (patch.arrowSize != null) e.arrowSize = Math.max(0.5, patch.arrowSize);
      } else if (e.type === "rect" || e.type === "ellipse" || e.type === "path") {
        if (patch.fill != null) e.fill = patch.fill;
        if (patch.stroke != null) e.stroke = patch.stroke;
        if (patch.strokeWidth != null) e.strokeWidth = patch.strokeWidth;
        if (e.type === "rect" && patch.cornerRadius != null) e.cornerRadius = patch.cornerRadius;
      }
    }
}

/** Set or clear an element's crop window (image/plot), Figma-style: the
 *  content→canvas mapping is PRESERVED (content stays pinned on the canvas) —
 *  the element box follows the window. `crop` is in intrinsic content px
 *  (assetDisplaySize units: SVG CSS px, PNG natural×96/dpi); it is clamped
 *  inside the content, floored at 1 px, and NORMALIZED (a full-content window
 *  is stored as "no crop"). `null` resets: the box returns to the full content
 *  at the current content scale (x=Ox, width=dispW·kx — the gesture's inverse).
 *  Backs the ctrl-drag gesture commit, the Inspector/FluxFigMenu Reset crop,
 *  and the set_crop bridge/CLI/MCP verbs. Returns true when a target was found. */
export function setCrop(p: Project, id: Id, crop: CropRect | null): boolean {
  for (const f of p.figures)
    for (const e of f.elements) {
      if (e.id !== id || (e.type !== "image" && e.type !== "plot")) continue;
      const disp = assetDisplaySize(p, e.assetId);
      if (!disp) {
        // Unsized/missing asset: no mapping to preserve — raw write (degraded).
        if (crop) e.crop = { ...crop };
        else delete e.crop;
        return true;
      }
      const crop0: CropRect = e.crop ?? { x: 0, y: 0, width: disp.width, height: disp.height };
      const kx = crop0.width > 0 ? e.width / crop0.width : 1;
      const ky = crop0.height > 0 ? e.height / crop0.height : 1;
      // Content position on canvas, per axis (flip mirrors the mapping about
      // the box — editing.ts cropRemap doc): unflipped screenX(u) = ox + u·kx;
      // flipX screenX(u) = sx − u·kx. Window [x, x+w] ⇒ box left edge:
      const ox = e.x - crop0.x * kx;
      const oy = e.y - crop0.y * ky;
      const sx = e.x + e.width + crop0.x * kx;
      const sy = e.y + e.height + crop0.y * ky;
      const leftFor = (x: number, w: number) => (e.flipX ? sx - (x + w) * kx : ox + x * kx);
      const topFor = (y: number, h: number) => (e.flipY ? sy - (y + h) * ky : oy + y * ky);
      if (crop) {
        const w = Math.min(Math.max(crop.width, 1), disp.width);
        const h = Math.min(Math.max(crop.height, 1), disp.height);
        const x = Math.min(Math.max(crop.x, 0), disp.width - w);
        const y = Math.min(Math.max(crop.y, 0), disp.height - h);
        const EPS = 1e-6;
        const full = x <= EPS && y <= EPS && w >= disp.width - EPS && h >= disp.height - EPS;
        e.x = leftFor(x, w);
        e.y = topFor(y, h);
        e.width = w * kx;
        e.height = h * ky;
        if (full) delete e.crop;
        else e.crop = { x, y, width: w, height: h };
      } else {
        if (!e.crop) return true; // already showing the full content
        e.x = leftFor(0, disp.width);
        e.y = topFor(0, disp.height);
        e.width = disp.width * kx;
        e.height = disp.height * ky;
        delete e.crop;
      }
      return true;
    }
  return false;
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
// Text styling — B/I/U toggles + named text styles (Project.textStyles)
// ---------------------------------------------------------------------------
export type TextToggle = "bold" | "italic" | "underline";

/** Toggle bold/italic/underline across the selected TEXT elements: if every
 *  text already has it, turn it off everywhere; else turn it on everywhere
 *  (Figma/Docs semantics). Detaches linked named styles (manual font edit).
 *  DOM-free — GUI callers reflow after (text.ts reflowTexts). */
export function toggleTextStyle(p: Project, ids: Id[], which: TextToggle): void {
  const set = new Set(ids);
  const texts: TextElement[] = [];
  for (const f of p.figures)
    for (const e of f.elements) if (set.has(e.id) && e.type === "text") texts.push(e);
  if (!texts.length) return;
  const isOn = (e: TextElement) =>
    which === "bold" ? e.fontWeight >= 600 : which === "italic" ? e.fontStyle === "italic" : !!e.underline;
  const allOn = texts.every(isOn);
  for (const e of texts) {
    if (which === "bold") e.fontWeight = allOn ? 400 : 700;
    else if (which === "italic") e.fontStyle = allOn ? "normal" : "italic";
    else e.underline = !allOn;
    if (which !== "underline") delete e.lines; // bold/italic change metrics
    detachOnManualEdit(p, e, [which === "bold" ? "fontWeight" : which === "italic" ? "fontStyle" : "underline"]);
  }
}

const textById = (p: Project, id: Id): TextElement | null => {
  for (const f of p.figures)
    for (const e of f.elements) if (e.id === id && e.type === "text") return e;
  return null;
};

export function textStyleById(p: Project, styleId: Id): TextStyle | null {
  return p.textStyles?.find((s) => s.id === styleId) ?? null;
}

/** Write a named style's props onto a text element + link it. Optional props
 *  (underline/lineHeight/color/align) apply only when the style defines them. */
function assignTextStyle(e: TextElement, st: TextStyle): void {
  e.fontFamily = st.fontFamily;
  e.fontSize = st.fontSize;
  e.fontWeight = st.fontWeight;
  e.fontStyle = st.fontStyle;
  if (st.underline != null) e.underline = st.underline;
  if (st.lineHeight != null) e.lineHeight = st.lineHeight;
  if (st.color != null) e.color = st.color;
  if (st.align != null) e.align = st.align;
  e.styleId = st.id;
  delete e.lines; // metrics changed — GUI reflows, headless falls back
}

/** Create a named text style (id auto-generated unless supplied; a supplied id
 *  that already exists gets its definition REPLACED — copy-on-apply from the
 *  global library uses this to stay idempotent). Returns the style. */
export function createTextStyle(p: Project, def: Omit<TextStyle, "id"> & { id?: Id }): TextStyle {
  const st: TextStyle = { ...def, id: def.id ?? newId("ts") };
  p.textStyles = p.textStyles ?? [];
  const i = p.textStyles.findIndex((s) => s.id === st.id);
  if (i >= 0) p.textStyles[i] = st;
  else p.textStyles.push(st);
  return st;
}

/** Snapshot an element's text properties as a new named style and link the
 *  element to it ("New style from selection"). Captures color + align too —
 *  a from-selection style is a complete look. */
export function textStyleFromElement(p: Project, elementId: Id, name: string): TextStyle | null {
  const e = textById(p, elementId);
  if (!e) return null;
  const st = createTextStyle(p, {
    name,
    fontFamily: e.fontFamily,
    fontSize: e.fontSize,
    fontWeight: e.fontWeight,
    fontStyle: e.fontStyle,
    ...(e.underline != null ? { underline: e.underline } : {}),
    ...(e.lineHeight != null ? { lineHeight: e.lineHeight } : {}),
    color: e.color,
    align: e.align,
  });
  e.styleId = st.id;
  return st;
}

/** Patch a named style and RE-APPLY it to every linked element (live link). */
export function updateTextStyle(p: Project, styleId: Id, patch: Partial<Omit<TextStyle, "id">>): void {
  const st = textStyleById(p, styleId);
  if (!st) return;
  Object.assign(st, patch);
  for (const f of p.figures)
    for (const e of f.elements)
      if (e.type === "text" && e.styleId === styleId) assignTextStyle(e, st);
}

export function renameTextStyle(p: Project, styleId: Id, name: string): void {
  const st = textStyleById(p, styleId);
  if (st) st.name = name;
}

/** Delete a named style. Linked elements KEEP their current properties and
 *  simply drop the link. */
export function deleteTextStyle(p: Project, styleId: Id): void {
  if (!p.textStyles) return;
  p.textStyles = p.textStyles.filter((s) => s.id !== styleId);
  for (const f of p.figures)
    for (const e of f.elements)
      if (e.type === "text" && e.styleId === styleId) delete e.styleId;
}

/** Apply a named style to the given elements (text elements only): sets the
 *  style's defined props + links styleId. DOM-free — GUI reflows after. */
export function applyTextStyle(p: Project, ids: Id[], styleId: Id): number {
  const st = textStyleById(p, styleId);
  if (!st) return 0;
  const set = new Set(ids);
  let n = 0;
  for (const f of p.figures)
    for (const e of f.elements)
      if (set.has(e.id) && e.type === "text") {
        assignTextStyle(e, st);
        n++;
      }
  return n;
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
    if (e.type === "text") {
      e.text = String.fromCharCode(97 + (i % 26));
      delete e.lines; // text changed → wrap cache stale (GUI reflows on next layout)
    }
  });
}

// Re-export so callers needing the panel inventory don't reach past ops.
export { figurePanels };
