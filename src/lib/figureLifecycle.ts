// The figure (frame) lifecycle — the light leaf of the ops core: create, delete, duplicate a
// figure, delete a canvas, and the blank-figure defaults. Moved out of ops.ts (2026-10-23) so the
// app shell's store can use them without statically reaching the whole editor core (ops pulls
// text layout, plot parsing and css-tree, 3D scenes, arrangement…) — the eager-shell budget
// (verify-startup). ops.ts re-exports every name; callers keep using `ops.*`.

import type { Element, Figure, Id, Project } from "./types";
import { newId } from "./ids";
import { ensureFigureReferenceKeys, mintFigureReferenceKey } from "./project/figureIdentity";
import { DEFAULT_FAMILY, assignFamilyNumber, derivedFigureName, familyById, parseLegacyName } from "./figfamily";
import { cloneGroupsFor } from "./groups";
import { reattachClones } from "./slide/attach";

// Default frame size — a full-page journal figure, 180 × 225 mm (the Nature-family
// maximum figure size), expressed in the canvas's 96 dpi design px: 180/25.4×96 ≈ 680,
// 225/25.4×96 ≈ 850 (exactly 4:5). The physical size binds at export — "180 mm @
// 300 dpi" rasterizes to 2126 px wide via journalSizing.planExport. The single source
// for a blank figure (store.ts `blankFigure` and scaffoldTree reuse these so the GUI,
// CLI, and agents agree).
export const BLANK_FIGURE = { width: 680, height: 850, background: "#ffffff" } as const;

/** The space New figure keeps between frames: a small side gap, and the
 *  default stacking gap vertically, where a frame's title sits above it. */
export const FIGURE_GAP = { x: 24, y: 80 } as const;

/** Closest upper-left point whose frame clears every existing frame. The
 * forbidden positions are open rectangles (Minkowski sums); a nearest free
 * point lies at the requested x or a rectangle's vertical boundary. For each
 * such x, merge its forbidden y intervals and project to the closest endpoint.
 * O(n² log n), once per placement; no grid quantization or unbounded spiral. */
export function nearestFigurePosition(
  figures: readonly Pick<Figure, "x" | "y" | "width" | "height">[],
  at: { x: number; y: number },
  size: { width: number; height: number } = BLANK_FIGURE,
  gap: number | { x: number; y: number } = FIGURE_GAP,
): { x: number; y: number } {
  const gx = typeof gap === "number" ? gap : gap.x, gy = typeof gap === "number" ? gap : gap.y;
  if (![at.x, at.y, size.width, size.height, gx, gy].every(Number.isFinite) || size.width <= 0 || size.height <= 0 || gx < 0 || gy < 0)
    throw new Error("Invalid figure placement");
  const boxes = figures.map(f => ({ left: f.x - size.width - gx, right: f.x + f.width + gx, top: f.y - size.height - gy, bottom: f.y + f.height + gy }));
  const xs = [...new Set([at.x, ...boxes.flatMap(b => [b.left, b.right])])].sort((a,b) => Math.abs(a-at.x)-Math.abs(b-at.x) || a-b);
  let best = { ...at }, distance = Infinity;
  for (const x of xs) {
    const dx2 = (x-at.x)**2;
    if (dx2 > distance) break;
    const intervals = boxes.filter(b => x > b.left && x < b.right).sort((a,b) => a.top-b.top);
    let y = at.y;
    for (let i = 0; i < intervals.length; i++) {
      const top = intervals[i].top;
      let bottom = intervals[i].bottom;
      while (i + 1 < intervals.length && intervals[i+1].top < bottom) bottom = Math.max(bottom, intervals[++i].bottom);
      if (y > top && y < bottom) { y = y-top <= bottom-y ? top : bottom; break; }
    }
    const d = dx2 + (y-at.y)**2;
    if (d < distance) { distance = d; best = { x, y }; }
    if (!distance) break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Figure (frame) lifecycle
// ---------------------------------------------------------------------------
export interface CreateFigureOpts {
  canvasId: Id;
  /** Explicit figure id (a clean slug → stable `@fig-<id>`); else auto-generated. */
  id?: Id;
  /** Legacy seam: a designation-style name ("Figure 3", "Figure S2") maps to
   *  family identity; anything else becomes the nickname. Prefer
   *  family/number/nickname directly. */
  name?: string;
  family?: string;
  number?: number;
  nickname?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  background?: string;
}

export function createFigure(p: Project, opts: CreateFigureOpts): Figure {
  if (opts.id && p.figures.some(f => f.id === opts.id)) throw new Error(`Figure id already exists: ${opts.id}`);
  if (!p.canvases.some(c => c.id === opts.canvasId)) throw new Error(`Canvas not found: ${opts.canvasId}`);
  const onCanvas = p.figures.filter((f) => f.canvasId === opts.canvasId);
  // Default placement stacks vertically: directly below the lowest figure on
  // the canvas, left-aligned with the first one. Headless composes used to
  // default to (0,0) and pile every figure on top of the previous.
  const maxBottom = onCanvas.reduce((m, f) => Math.max(m, f.y + f.height), 0);
  const x = opts.x ?? (onCanvas.length ? onCanvas[0].x : 0);
  const y = opts.y ?? (onCanvas.length ? maxBottom + 80 : 0);
  const fig: Figure = {
    id: opts.id ?? newId("fig"),
    name: opts.name ?? "",
    canvasId: opts.canvasId,
    x,
    y,
    width: opts.width ?? BLANK_FIGURE.width,
    height: opts.height ?? BLANK_FIGURE.height,
    background: opts.background ?? BLANK_FIGURE.background,
    elements: [],
  };
  p.figures.push(fig);
  // Structured identity (figfamily.ts): explicit family/number win; a
  // designation-style legacy `name` maps to identity; a descriptive one
  // survives as the nickname. Default = append to the main figure family —
  // the old `Figure ${count+1}` default duplicated names after a delete.
  const parsed = opts.name != null && opts.family == null ? parseLegacyName(opts.name) : null;
  const nickname = opts.nickname ?? (opts.name && !parsed ? opts.name : undefined);
  if (nickname) fig.nickname = nickname;
  assignFamilyNumber(
    p.figures,
    fig.id,
    opts.family ?? parsed?.family ?? DEFAULT_FAMILY,
    opts.number ?? parsed?.number,
    p.figureFamilies,
  );
  fig.referenceKey = mintFigureReferenceKey(fig.id, p.figures);
  ensureFigureReferenceKeys(p);
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
  // Auto-compact the victim's family (numbers stay contiguous 1..N).
  // Surgical on purpose: only figures already carrying a family are touched,
  // so a deck-projected slide store (figures never carry `family`) can route
  // a delete through here without being stamped.
  if (victim?.family && victim.number != null) {
    for (const f of p.figures) {
      if (f.family === victim.family && f.number != null && f.number > victim.number) {
        f.number = f.number - 1;
        f.name = derivedFigureName(familyById(f.family, p.figureFamilies), f.number);
      }
    }
  }
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

/** Remove a canvas through the same figure lifecycle as individual deletion.
 *  Publication designations compact immediately in the live model, independent
 *  of canvas arrangement or manuscript use. Asset cleanup is project-wide and
 *  belongs to persistence, where surviving deck dependencies are available. */
export function deleteCanvas(p: Project, canvasId: Id): void {
  if (p.canvases.length <= 1 || !p.canvases.some((c) => c.id === canvasId)) return;
  const ids = p.figures.filter((f) => f.canvasId === canvasId).map((f) => f.id);
  for (const id of ids) deleteFigure(p, id, { allowEmpty: true });
  p.canvases = p.canvases.filter((c) => c.id !== canvasId);
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
  reattachClones(elements, idRemap);
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
    ...(src.guides ? { guides: structuredClone(src.guides) } : {}),
    ...(Object.keys(clonedGroups).length ? { groups: clonedGroups } : {}),
  };
  p.figures.push(copy);
  // Family-managed models: the copy slots in right after its source (insert-
  // and-shift; name re-derives). A family-less source (deck-projected slide
  // store) keeps the plain `"<name> copy"` behavior untouched.
  if (src.family && src.number != null) {
    if (src.nickname) copy.nickname = `${src.nickname} copy`;
    assignFamilyNumber(p.figures, copy.id, src.family, src.number + 1, p.figureFamilies);
    copy.referenceKey = mintFigureReferenceKey(copy.id, p.figures);
    ensureFigureReferenceKeys(p);
  }
  return copy.id;
}


export function figById(p: Project, figId: Id): Figure | null {
  return p.figures.find((f) => f.id === figId) ?? null;
}
