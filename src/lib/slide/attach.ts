// ---------------------------------------------------------------------------
// Flux Slide / Figure — ATTACHMENTS (T9 final). A connector's endpoints and a label's position are a
// PURE FUNCTION of the frame's resolved driver boxes: no time, no dt, no history. Evaluated after every
// driver's box is final for the frame (transform + arc + spring overshoot), in dependency order.
// DOM-free: compile.sample, the player, the editors, export and flux-core all call these functions.
//
// One field, `ElementBase.attach`, two shapes discriminated by the element's own type:
//   line      -> LineAttach { start?, end? }            (each end follows a driver)
//   any other -> BoxAttach  { to, side, gap?, align? }  (sit beside a driver: labels, captions)
// ---------------------------------------------------------------------------
import type { Element, LineElement } from "../types";
import { elementBBox, rotatedAABB } from "../geometry";

export type Anchor = "auto" | "center" | "n" | "e" | "s" | "w" | { fx: number; fy: number };
export interface AttachEnd { to: string; anchor?: Anchor; gap?: number }
export interface LineAttach { start?: AttachEnd; end?: AttachEnd }
export interface BoxAttach { to: string; side: "n" | "e" | "s" | "w"; gap?: number; align?: "center" | "start" | "end" }
export type Attach = LineAttach | BoxAttach;

interface Pt { x: number; y: number }
type Boxy = Element & { attach?: Attach };

export const isLineAttach = (a: Attach | undefined): a is LineAttach => !!a && !("to" in a) && ("start" in a || "end" in a);
export const isBoxAttach = (a: Attach | undefined): a is BoxAttach => !!a && typeof (a as BoxAttach).to === "string";
const fin = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
/** The gap (stage px) a connector end released on a shape keeps from its outline (owner decision Q7). */
export const CONNECTOR_GAP = 4;
const ANCHORS = new Set(["auto", "center", "n", "e", "s", "w"]);
const SIDES = new Set(["n", "e", "s", "w"]);
const ALIGNS = new Set(["center", "start", "end"]);

/** Every driver id an element's attachment names (valid or not). */
export function attachRefs(e: Element): string[] {
  const a = (e as Boxy).attach;
  if (!a) return [];
  if (isBoxAttach(a)) return [a.to];
  return [a.start?.to, a.end?.to].filter((x): x is string => typeof x === "string");
}
export const hasAttach = (e: Element): boolean => !!(e as Boxy).attach;

const rot = (p: Pt, deg: number): Pt => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; };

/** Geometry of a driver for anchoring: centre, half extents, rotation, ellipse or rectangle. */
export function shapeOf(el: Element) {
  const b = elementBBox({ ...el, rotation: 0 });
  return { c: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, hw: b.w / 2, hh: b.h / 2, deg: fin(el.rotation, 0), ellipse: el.type === "ellipse", flipX: !!el.flipX, flipY: !!el.flipY };
}

/** Point on the driver's outline along the ray from its centre toward `toward`, pushed `gap` outward. */
export function boundaryToward(el: Element, toward: Pt, gap: number): Pt {
  const s = shapeOf(el);
  let d = { x: toward.x - s.c.x, y: toward.y - s.c.y };
  const len = Math.hypot(d.x, d.y);
  if (!(len > 1e-9)) d = { x: 1, y: 0 }; else d = { x: d.x / len, y: d.y / len };
  const l = rot(d, -s.deg); // direction in the element's own frame
  const eps = 1e-9;
  const t = s.ellipse
    ? 1 / Math.sqrt((l.x / Math.max(s.hw, eps)) ** 2 + (l.y / Math.max(s.hh, eps)) ** 2)
    : Math.min(Math.abs(l.x) < eps ? Infinity : s.hw / Math.abs(l.x), Math.abs(l.y) < eps ? Infinity : s.hh / Math.abs(l.y));
  return { x: s.c.x + d.x * (t + gap), y: s.c.y + d.y * (t + gap) };
}

export function sidePoint(el: Element, anchor: Exclude<Anchor, "auto">, gap: number): Pt {
  const s = shapeOf(el);
  let fx = 0.5, fy = 0.5, nx = 0, ny = 0;
  if (anchor === "n") { fy = 0; ny = -1; } else if (anchor === "s") { fy = 1; ny = 1; }
  else if (anchor === "w") { fx = 0; nx = -1; } else if (anchor === "e") { fx = 1; nx = 1; }
  else if (typeof anchor === "object") { fx = fin(anchor.fx, 0.5); fy = fin(anchor.fy, 0.5); if (s.flipX) fx = 1 - fx; if (s.flipY) fy = 1 - fy; }
  const local = { x: (fx - 0.5) * 2 * s.hw + nx * gap, y: (fy - 0.5) * 2 * s.hh + ny * gap };
  const r = rot(local, s.deg);
  return { x: s.c.x + r.x, y: s.c.y + r.y };
}

/** Driver-before-dependent order. A cycle is cut at the node that closes it and reported (never throws). */
export function attachOrder(elements: Element[]): { order: string[]; cycles: string[] } {
  const byId = new Map(elements.map((e) => [e.id, e as Boxy]));
  const deps = (e: Boxy) => attachRefs(e).filter((id) => byId.has(id) && id !== e.id);
  const order: string[] = [], state = new Map<string, 1 | 2>(), cycles: string[] = [];
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { cycles.push(id); return; }
    state.set(id, 1);
    for (const d of deps(byId.get(id)!)) visit(d);
    state.set(id, 2);
    if (hasAttach(byId.get(id)!)) order.push(id);
  };
  for (const e of elements) visit(e.id);
  return { order, cycles };
}

/** Re-solve every dependent of `elements` (mutates the frame's own clones). Drivers are read as they
 *  stand: the caller has already applied transforms, arcs and overshoot to them. Malformed attachments
 *  are skipped, never thrown on. */
export function resolveAttachments(elements: Element[]): void {
  // Work on the involved subset only (dependents + their drivers): O(n) scan, O(k) solve.
  let any = false;
  const need = new Set<string>();
  for (const e of elements) if (hasAttach(e)) { any = true; need.add(e.id); for (const r of attachRefs(e)) need.add(r); }
  if (!any) return;
  const sub = elements.filter((e) => need.has(e.id));
  const byId = new Map(sub.map((e) => [e.id, e as Boxy]));
  const { order, cycles } = attachOrder(sub);
  const cut = new Set(cycles);
  for (const id of order) {
    if (cut.has(id)) continue;
    const e = byId.get(id)!;
    if (e.type === "line" && isLineAttach(e.attach)) solveLine(e as LineElement & { attach: LineAttach }, byId);
    else if (e.type !== "line" && isBoxAttach(e.attach)) solveBox(e, e.attach, byId);
  }
}

function solveLine(line: LineElement & { attach: LineAttach }, byId: Map<string, Boxy>): void {
  const fixed = (which: "start" | "end"): Pt => which === "start" ? { x: line.x + line.x1, y: line.y + line.y1 } : { x: line.x + line.x2, y: line.y + line.y2 };
  const drv = (end?: AttachEnd) => end && typeof end.to === "string" ? byId.get(end.to) : undefined;
  const { start, end } = line.attach, sA = drv(start), eA = drv(end);
  const anchorOf = (e: AttachEnd) => e.anchor !== undefined && (ANCHORS.has(e.anchor as string) || typeof e.anchor === "object") ? e.anchor : "auto";
  const isAuto = (e: AttachEnd | undefined, el: Element | undefined): el is Element => !!e && !!el && anchorOf(e) === "auto";
  /** an end's point when it does not depend on the other end: free (its stored point) or anchored to a side / the centre / a point */
  const placed = (e: AttachEnd | undefined, el: Element | undefined, which: "start" | "end"): Pt | null =>
    !e || !el ? fixed(which) : anchorOf(e) === "auto" ? null : sidePoint(el, anchorOf(e) as Exclude<Anchor, "auto">, fin(e.gap, 0));
  const q1 = placed(start, sA, "start"), q2 = placed(end, eA, "end");
  // an AUTO end leaves its driver's outline on the line toward the other end: the other end's point when it has one, else its driver's centre
  const ref1 = q1 ?? shapeOf(sA!).c, ref2 = q2 ?? shapeOf(eA!).c;
  let p1 = q1 ?? boundaryToward(sA!, ref2, fin(start!.gap, 0)), p2 = q2 ?? boundaryToward(eA!, ref1, fin(end!.gap, 0));
  if (![p1.x, p1.y, p2.x, p2.y].every(Number.isFinite)) return;
  // NEVER BACKWARDS. With an auto end, both ends lie on the line between the references (ref1 → ref2). Overlapping drivers (or a placed end
  // inside the auto end's driver) would push them past each other and the arrow would point back at its source; instead the ends meet
  // and the connector shrinks away (lineRender thins it to nothing). Continuous: they meet exactly where the order flips. A placed end
  // never moves (it is the author's point), so the auto end comes to it; two placed ends are explicit and kept as they are.
  if ((isAuto(start, sA) || isAuto(end, eA)) && (p2.x - p1.x) * (ref2.x - ref1.x) + (p2.y - p1.y) * (ref2.y - ref1.y) <= 0) {
    const m = q1 ?? q2 ?? { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    p1 = m; p2 = m;
  }
  line.x = p1.x; line.y = p1.y; line.x1 = 0; line.y1 = 0; line.x2 = p2.x - p1.x; line.y2 = p2.y - p1.y;
  line.rotation = 0;
}

function solveBox(el: Boxy, n: BoxAttach, byId: Map<string, Boxy>): void {
  const d = byId.get(n.to);
  if (!d || d === el || !SIDES.has(n.side)) return;
  // both boxes as they are SEEN (a rotated driver or label: its axis-aligned box), so a turned y-label sits `gap` beside its axis
  const b = rotatedAABB(d), own = rotatedAABB(el), g = fin(n.gap, 0), w = own.w, h = own.h, al = ALIGNS.has(n.align as string) ? n.align! : "center";
  const along = (start: number, size: number, own: number) => al === "start" ? start : al === "end" ? start + size - own : start + (size - own) / 2;
  let x: number, y: number;
  if (n.side === "n") { x = along(b.x, b.w, w); y = b.y - g - h; }
  else if (n.side === "s") { x = along(b.x, b.w, w); y = b.y + b.h + g; }
  else if (n.side === "w") { x = b.x - g - w; y = along(b.y, b.h, h); }
  else { x = b.x + b.w + g; y = along(b.y, b.h, h); }
  // (x, y) places the seen box; the element turns about its centre, so its own box shares that centre
  if (Number.isFinite(x) && Number.isFinite(y)) { el.x = x + (w - el.width) / 2; el.y = y + (h - el.height) / 2; }
}

// --- authoring ---------------------------------------------------------------------------------------------

/** Why `attach` cannot be set on element `id` among `elements` (its shape for the element's type, every driver present and not itself, no
 *  cycle), or null. The ONE check behind `setAttach` (Slide), the Figure twin and the Inspector. */
export function attachProblem(elements: Element[], id: string, attach: Attach): string | null {
  const el = elements.find((e) => e.id === id);
  if (!el) return `element not found: ${id}`;
  const trial = elements.map((e) => e.id === id ? ({ ...e, attach } as Element) : e);
  const issues = attachIssues(trial).filter((i) => i.id === id || i.code === "cycle");
  const first = issues[0];
  if (!first) return attachRefs({ ...el, attach } as Element).length ? null : "an attachment needs at least one end";
  return first.code === "dangling" ? `nothing to attach to: ${first.detail.replace(/^.*→ /, "")} is not here`
    : first.code === "cycle" ? "these attachments would form a cycle" : first.code === "self" ? "an element cannot attach to itself"
    : first.code === "wrong-shape" ? (el.type === "line" ? "a line attaches its ends: { start?, end? }" : "a non-line sits beside one element: { to, side, gap?, align? }")
    : `attach ${first.detail} is not valid`;
}

/** A connector end written as text (`slide-attach --start box1:e:4`): `<id>[:<anchor>[:<gap>]]`, the anchor auto | center | n | e | s | w | fx,fy
 *  (a fraction of the box). Null when it does not parse. */
export function parseAttachEnd(spec: string): AttachEnd | null {
  const [to, anchor, gap, ...rest] = spec.split(":");
  if (!to || rest.length) return null;
  const fxy = anchor ? /^(-?\d*\.?\d+),(-?\d*\.?\d+)$/.exec(anchor) : null;
  const a: Anchor | undefined | null = !anchor ? undefined : ANCHORS.has(anchor) ? anchor as Anchor : fxy ? { fx: Number(fxy[1]), fy: Number(fxy[2]) } : null;
  const g = gap === undefined || gap === "" ? undefined : Number(gap);
  if (a === null || g !== undefined && !Number.isFinite(g)) return null;
  return { to, ...(a !== undefined ? { anchor: a } : {}), ...(g !== undefined ? { gap: g } : {}) };
}

/** The arguments of `slide-attach` / `figure-attach` (WP 3.2). */
export interface AttachArgs { start?: string; end?: string; to?: string; side?: string; gap?: number; align?: string; detach?: boolean }
/** The attachment those arguments describe for `el` (null = detach): a line takes its ends (`--start` / `--end`, `<id>[:anchor[:gap]]`),
 *  anything else sits beside one element (`--to`, `--side`, `--gap`, `--align`). Throws a usage error otherwise. */
export function attachFromArgs(el: { type: string }, a: AttachArgs): Attach | null {
  if (a.detach) return null;
  if (el.type === "line") {
    if (a.to !== undefined || a.side !== undefined || a.align !== undefined) throw new Error("a line attaches its ends: use --start / --end (<id>[:anchor[:gap]])");
    const end = (spec: string | undefined, which: string) => { if (spec === undefined) return undefined; const e = parseAttachEnd(spec); if (!e) throw new Error(`--${which} must be <id>[:anchor[:gap]] (anchor auto | center | n | e | s | w | fx,fy)`); return e; };
    const start = end(a.start, "start"), finish = end(a.end, "end");
    if (!start && !finish) throw new Error("give --start and/or --end (or --detach)");
    return { ...(start ? { start } : {}), ...(finish ? { end: finish } : {}) };
  }
  if (a.start !== undefined || a.end !== undefined) throw new Error("only a line attaches its ends; anything else sits beside an element: --to <id> --side n|e|s|w");
  if (!a.to || !a.side) throw new Error("give --to <id> and --side n|e|s|w (or --detach)");
  return { to: a.to, side: a.side as BoxAttach["side"], ...(a.gap !== undefined ? { gap: a.gap } : {}), ...(a.align !== undefined ? { align: a.align as BoxAttach["align"] } : {}) };
}

// --- load-time hygiene, identity seams, scaling -------------------------------------------------------

export interface AttachIssue { id: string; code: "dangling" | "cycle" | "malformed" | "self" | "wrong-shape"; detail: string }

/** Validate every attachment of `elements` WITHOUT mutating (editor Inspector, validate_project, normalizeDeck). */
export function attachIssues(elements: Element[]): AttachIssue[] {
  const ids = new Set(elements.map((e) => e.id)), out: AttachIssue[] = [];
  for (const e of elements) {
    const a = (e as Boxy).attach;
    if (!a) continue;
    const bad = (code: AttachIssue["code"], detail: string) => out.push({ id: e.id, code, detail });
    if (typeof a !== "object") { bad("malformed", "attach is not an object"); continue; }
    if (e.type === "line") {
      if (!isLineAttach(a)) { bad("wrong-shape", "a line takes { start?, end? }"); continue; }
      for (const [k, end] of [["start", a.start], ["end", a.end]] as const) {
        if (!end) continue;
        if (typeof end.to !== "string") { bad("malformed", `${k}.to must be an element id`); continue; }
        if (end.to === e.id) bad("self", `${k} attaches to itself`);
        else if (!ids.has(end.to)) bad("dangling", `${k} → ${end.to}`);
        if (end.anchor !== undefined && !ANCHORS.has(end.anchor as string) && !(typeof end.anchor === "object" && Number.isFinite(end.anchor.fx) && Number.isFinite(end.anchor.fy))) bad("malformed", `${k}.anchor`);
        if (end.gap !== undefined && !Number.isFinite(end.gap)) bad("malformed", `${k}.gap`);
      }
    } else {
      if (!isBoxAttach(a)) { bad("wrong-shape", "a non-line takes { to, side, gap?, align? }"); continue; }
      if (a.to === e.id) bad("self", "attaches to itself");
      else if (!ids.has(a.to)) bad("dangling", `→ ${a.to}`);
      if (!SIDES.has(a.side)) bad("malformed", "side");
      if (a.gap !== undefined && !Number.isFinite(a.gap)) bad("malformed", "gap");
      if (a.align !== undefined && !ALIGNS.has(a.align)) bad("malformed", "align");
    }
  }
  for (const id of attachOrder(elements).cycles) out.push({ id, code: "cycle", detail: "attachment cycle (cut at this element)" });
  return out;
}

/** Remap driver ids through a clone's old→new id map (duplicate / paste / slide duplicate / import).
 *  A driver outside the copied set keeps its original id (the copy still follows it). Pure, in place. */
export function remapAttachIds(elements: Element[], idMap: ReadonlyMap<string, string>): void {
  for (const e of elements) {
    const a = (e as Boxy).attach;
    if (!a) continue;
    if (isBoxAttach(a)) a.to = idMap.get(a.to) ?? a.to;
    else for (const end of [a.start, a.end]) if (end && typeof end.to === "string") end.to = idMap.get(end.to) ?? end.to;
  }
}
/** Drop every attachment whose driver is not in `keep` (moveElementsToFigure, group extraction). */
export function detachMissing(elements: Element[], keep: ReadonlySet<string>): number {
  let n = 0;
  for (const e of elements) {
    const a = (e as Boxy).attach;
    if (!a) continue;
    if (isBoxAttach(a)) { if (!keep.has(a.to)) { delete (e as Boxy).attach; n++; } continue; }
    for (const k of ["start", "end"] as const) if (a[k] && !keep.has(a[k]!.to)) { delete a[k]; n++; }
    if (!a.start && !a.end) delete (e as Boxy).attach;
  }
  return n;
}
/** Uniform content scale (placeContentOnStage / scaleElements): `gap` is in stage px, so it scales with the content. */
export function scaleAttach(el: Element, k: number): void {
  const a = (el as Boxy).attach;
  if (!a || !(k > 0) || !Number.isFinite(k)) return;
  if (isBoxAttach(a)) { if (a.gap !== undefined) a.gap *= k; return; }
  for (const end of [a.start, a.end]) if (end && end.gap !== undefined) end.gap *= k;
}

/** The ONE call every id-regenerating clone site makes (duplicate / paste / alt-drag / preset insert / slide duplicate /
 *  snapshot insert / figure → slide import / duplicateFigure): drivers inside the copied set are followed to their
 *  clones; an attachment whose driver was not copied is dropped (the copy becomes free geometry, never a ghost of the
 *  original's link). Pure, in place. */
export function reattachClones(copies: Element[], idMap: ReadonlyMap<string, string>): void {
  remapAttachIds(copies, idMap);
  detachMissing(copies, new Set(copies.map((c) => c.id)));
}

/** Free one end of a connector (the other keeps its attachment); the attachment goes when neither end is left. */
export function detachEnd(line: Element, which: "start" | "end"): void {
  const a = (line as Boxy).attach;
  if (!isLineAttach(a)) return;
  delete a[which];
  if (!a.start && !a.end) delete (line as Boxy).attach;
}

/** What an edit may have moved, captured before it (`snapshotAttachments`): per involved element its geometry key, per dependent its
 *  attachment as it stood. */
export interface AttachSnapshot { geometry: Map<string, string>; attach: Map<string, string> }
const ends = (l: LineElement) => [{ x: l.x + l.x1, y: l.y + l.y1 }, { x: l.x + l.x2, y: l.y + l.y2 }];
const geometryKey = (e: Element): string => {
  if (e.type === "line") return JSON.stringify([...ends(e as LineElement).flatMap((p) => [p.x, p.y]), e.rotation]);
  return JSON.stringify([e.x, e.y, e.width, e.height, e.rotation]);
};
/** Before an edit of `elements`: what the hand-move rule compares against; null when nothing is attached (the whole cost is a scan). */
export function snapshotAttachments(elements: readonly Element[]): AttachSnapshot | null {
  if (!elements.some(hasAttach)) return null;
  const geometry = new Map<string, string>(), attach = new Map<string, string>();
  for (const e of elements) if (hasAttach(e)) { attach.set(e.id, JSON.stringify((e as Boxy).attach)); geometry.set(e.id, geometryKey(e)); for (const r of attachRefs(e)) geometry.set(r, ""); }
  for (const e of elements) if (geometry.has(e.id)) geometry.set(e.id, geometryKey(e));
  return { geometry, attach };
}
/** THE hand-move rule: an attached element the user MOVED while what it hangs on stayed put is detached (the move is the user's word), so a
 *  dragged, nudged or typed-in position sticks instead of snapping back. A label is moved only when its position changed and its size did
 *  not: typing in it, bolding it, a new font size or width (its box re-measured, whatever corner the editor kept) and a rotation keep it
 *  stuck, and the re-solve places it again. A connector is judged end by end (a dragged end frees itself, the other keeps following). An
 *  edit that changed the attachment itself (an attach / detach, a line end released on a shape) is left to it. Run after the edit, before
 *  the re-solve. */
export function detachHandMoved(elements: Element[], before: AttachSnapshot | null): void {
  if (!before) return;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const moved = (id: string): boolean => { const e = byId.get(id); return !!e && before.geometry.has(id) && before.geometry.get(id) !== geometryKey(e); };
  for (const e of elements) {
    const a = (e as Boxy).attach, was = before.attach.get(e.id);
    if (!a || was === undefined || was !== JSON.stringify(a) || !moved(e.id)) continue;
    if (isBoxAttach(a)) {
      const [x, y, w, h] = JSON.parse(before.geometry.get(e.id)!) as number[];
      if (!moved(a.to) && w === e.width && h === e.height && (x !== e.x || y !== e.y)) delete (e as Boxy).attach;
      continue;
    }
    if (e.type !== "line") continue;
    const old = JSON.parse(before.geometry.get(e.id)!) as number[], now = ends(e as LineElement);
    const endMoved = (i: number) => Math.hypot(now[i].x - old[2 * i], now[i].y - old[2 * i + 1]) > 1e-6;
    for (const [i, k] of [[0, "start"], [1, "end"]] as const) { const end = a[k]; if (end && endMoved(i) && !moved(end.to)) detachEnd(e, k); }
  }
}

/** STORED geometry == the solve of the stored drivers (the Design-state invariant that every non-solving reader —
 *  Figure export, CLI JSON, tools — depends on). Re-solves in place; returns whether anything was attached.
 *  The editor hook (store.applyEditorMutation, after every mutate/commit/mutateFigure) and the flux-core save paths
 *  call this; `elements.some(hasAttach)` is the whole cost when nothing is attached (measured < 20 us / 5000 elements). */
export function settleAttachments(elements: Element[]): boolean {
  if (!elements.some(hasAttach)) return false;
  // a deleted driver frees what hung on it (the dependent keeps its last solved place; undo restores both)
  detachMissing(elements, new Set(elements.map((e) => e.id)));
  resolveAttachments(elements);
  return elements.some(hasAttach);
}

/** Keys a dependent's solve owns. The endpoint-edit capture (slide/store.registerSlideEditAdapter.after) must never turn the
 *  display-solved values of a dependent into a Change track: it strips these from the diff of any element that has `attach`. */
export const DEPENDENT_GEOMETRY = Object.freeze(["x", "y", "width", "height", "rotation", "x1", "y1", "x2", "y2"]);
export function userDiff(diff: Record<string, unknown> | null, el: Element): Record<string, unknown> | null {
  if (!diff || !hasAttach(el)) return diff;
  const rest = { ...diff };
  for (const k of DEPENDENT_GEOMETRY) delete rest[k];
  return Object.keys(rest).length ? rest : null;
}

/** Editor snap: the element a dragged connector end was released over (its bbox grown by `tol` stage px), smallest
 *  area first so a label inside a card wins over the card. Lines and the connector itself are never targets. */
export function attachTargetAt(elements: Element[], p: Pt, opts: { exclude?: string; tol?: number } = {}): string | null {
  const tol = opts.tol ?? 6;
  let best: { id: string; area: number } | null = null;
  for (const e of elements) {
    if (e.type === "line" || e.id === opts.exclude || e.hidden || e.locked) continue;
    const b = elementBBox({ ...e, rotation: 0 }), c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }, d = rot({ x: p.x - c.x, y: p.y - c.y }, -fin(e.rotation, 0));
    if (Math.abs(d.x) <= b.w / 2 + tol && Math.abs(d.y) <= b.h / 2 + tol && (!best || b.w * b.h < best.area)) best = { id: e.id, area: b.w * b.h };
  }
  return best?.id ?? null;
}

/** CONTENT a line points INTO (a plot, an image, a 3D model, a video): an end released on it keeps the exact spot. */
const POINTS_INTO = new Set(["plot", "image", "model3d", "video"]);
/** The point `p` as a fraction of `el`'s own (unrotated, unflipped) box: the `{ fx, fy }` anchor `sidePoint` maps back to `p`. */
export function pointAnchor(el: Element, p: Pt): { fx: number; fy: number } {
  const s = shapeOf(el), l = rot({ x: p.x - s.c.x, y: p.y - s.c.y }, -s.deg);
  let fx = 0.5 + l.x / (2 * Math.max(s.hw, 1e-9)), fy = 0.5 + l.y / (2 * Math.max(s.hh, 1e-9));
  if (s.flipX) fx = 1 - fx; if (s.flipY) fy = 1 - fy;
  return { fx, fy };
}
/** How an end released at `p` on `el` sticks (the canvas's line tool and end drags). On a SHAPE it connects: anchor auto, the end on the
 *  outline facing the other end, CONNECTOR_GAP off it. On CONTENT (plot, image, 3D, video) it keeps the spot it was released on, as it
 *  does anywhere with `exact` (Ctrl / ⌘ held): pointing into a figure panel is the daily case, and the drawn geometry is the author's. */
export function stickEnd(el: Element, p: Pt, exact = false): AttachEnd {
  if (!exact && !POINTS_INTO.has(el.type)) return { to: el.id, anchor: "auto", gap: CONNECTOR_GAP };
  return { to: el.id, anchor: pointAnchor(el, p), gap: 0 };
}
