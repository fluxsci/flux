// ---------------------------------------------------------------------------
// Flux Slide — the TARGET vocabulary (animation v2, deck 0.6). One way to name
// a thing that animates — an element, a set of a plot's parts, a role/series
// filter over a plot, a figure group, or (Become destinations only) an ad-hoc
// SET of element/part refs picked together — and ONE identity for it that
// every family law, compiler, player and verb compares.
//
// A track's own binding stays on disk as `target` + `part` / `parts` /
// `selector` (nothing to migrate); `trackRef` derives the ref. A Become's
// destination is stored in this form directly (`to.become.ref`).
//
// Pure and DOM-free by contract: flux-core, the GUI and the export runtime
// all load this module.
// ---------------------------------------------------------------------------

import type { Element, Figure, Id } from "../types";
import type { FluxPlotManifest } from "../plot/types";
import type { Scene3dManifest } from "../model3d/types";
import { modelPartTargets } from "./model3dTargets";
import { buildPartIndex } from "../plot/parse";
import { resolveTargets } from "../plot/tree";
import { membersDeep } from "../groups";
import type { Slide, TargetRef, Track, TrackSelector, BecomeSpec } from "./types";

/** How a Become pairs source and destination outlines, in menu order, with the
 *  label every surface shows — the ONE list (the verbs' zod enums, the Animation
 *  inspector's Pair ▾ and the pick bar's Pair select derive from it; the
 *  verify-preset-catalog census refuses a literal copy). `PairPolicy`
 *  (types.ts) is derived from these ids. */
export const PAIR_POLICIES = [
  { id: "auto", label: "auto" },
  { id: "spatial", label: "by position" },
  { id: "order", label: "by order" },
  { id: "data", label: "by data" },
  { id: "tile", label: "tile" },
] as const;
/** The ids alone, as the non-empty tuple `z.enum` takes. */
export const PAIR_POLICY_IDS = PAIR_POLICIES.map(p => p.id) as [(typeof PAIR_POLICIES)[number]["id"], ...(typeof PAIR_POLICIES)[number]["id"][]];
/** Transform methods (owner, 2026-10-03): what a filled shape's interior does while
 *  its outline splits into pieces, or pieces merge into it (a shape becoming letters
 *  pours its area into them as strips under every method). One catalogue for the
 *  GUI select, the CLI flag and the deck schema; the first entry is the DEFAULT — a
 *  spec without a `method` key means it (dissolve since 2026-10-08, shatter before:
 *  owner, "make dissolve the default wherever it applies"). */
export const TRANSFORM_METHODS = [
  { id: "dissolve", label: "dissolve", hint: "The interior fades away in place as the outline leaves (default)" },
  { id: "shatter", label: "shatter", hint: "The interior splits into wedges that fly with the pieces" },
  { id: "collapse", label: "collapse", hint: "The interior shrinks into the shape's centre as the outline leaves" },
  { id: "drain", label: "drain", hint: "The interior empties toward where the pieces are going" },
] as const;
export const TRANSFORM_METHOD_IDS = TRANSFORM_METHODS.map(m => m.id) as [(typeof TRANSFORM_METHODS)[number]["id"], ...(typeof TRANSFORM_METHODS)[number]["id"][]];
/** The method an absent `BecomeSpec.method` means — THE one place that knows it. */
export const DEFAULT_TRANSFORM_METHOD: (typeof TRANSFORM_METHODS)[number]["id"] = TRANSFORM_METHODS[0].id;

/** Structural endpoint test; callers own preset and enabled eligibility. */
export function isHandoff<T extends Pick<Track, "to">>(track: T | null | undefined): track is T & { to: { become: BecomeSpec } } {
  return track?.to?.become?.mode === "handoff";
}

/** The ref a track's OWN target denotes. Whole-element tracks (and the virtual
 *  `@camera`/`@stage`) come back as `{ element }` alone. */
export function trackRef(track: Pick<Track, "target" | "part" | "parts" | "selector">): TargetRef {
  const ref: TargetRef = { element: track.target };
  const parts = trackParts(track);
  if (parts.length) ref.parts = parts;
  if (track.selector && selectorIsSet(track.selector)) ref.selector = track.selector;
  return ref;
}

/** `part` ∪ `parts`, deduplicated, in authored order. */
export function trackParts(track: Pick<Track, "part" | "parts">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [track.part, ...(track.parts ?? [])]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function selectorIsSet(sel: TrackSelector | undefined): boolean {
  return !!sel && (sel.role != null || sel.series != null || sel.index != null || !!sel.except?.length);
}

/** Canonical identity of a ref: element, then the SORTED part ids, then the
 *  selector, then the group. Two refs with the same key name the same thing,
 *  whatever order a pick listed the parts in. Whole-element ⇒ `"<id>|||"`.
 *  A set ⇒ `"set:" + its (normalized) member keys, sorted, joined by ";"`, so
 *  the pick order of a set never changes its identity. */
export function targetKey(ref: TargetRef): string {
  if (ref.members) {
    const members = mergeMembers(ref.members, false);
    // A one-member set IS its member (normalizeRef collapses it).
    return members.length === 1 ? targetKey(members[0]) : "set:" + members.map(targetKey).sort().join(";");
  }
  const parts = ref.parts?.length ? [...new Set(ref.parts)].sort().join(",") : "";
  const sel = ref.selector && selectorIsSet(ref.selector) ? JSON.stringify(canonicalSelector(ref.selector)) : "";
  return `${ref.element}|${parts}|${sel}|${ref.group ?? ""}`;
}

function canonicalSelector(sel: TrackSelector): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (sel.role != null) out.role = sel.role;
  if (sel.series != null) out.series = sel.series;
  if (sel.index != null) out.index = Array.isArray(sel.index) ? [...sel.index].sort((a, b) => a - b) : sel.index;
  if (sel.except?.length) out.except = [...new Set(sel.except)].sort();
  return out;
}

/** The family-law identity of a TRACK — `targetKey(trackRef(track))`. */
export function trackKey(track: Pick<Track, "target" | "part" | "parts" | "selector">): string {
  return targetKey(trackRef(track));
}

export function sameRef(a: TargetRef, b: TargetRef): boolean {
  return targetKey(a) === targetKey(b);
}

/** Whether a ref names the WHOLE element (no parts, no selector, no group, not a set). */
export function isWholeElementRef(ref: TargetRef): boolean {
  return !ref.parts?.length && !(ref.selector && selectorIsSet(ref.selector)) && !ref.group && !ref.members;
}

// --- ad-hoc destination SETS (0.6, Oct-2) ------------------------------------
// A set is the destination form of "several things picked together": loose
// objects, parts of one or more plots, or a mix. One level only; members are
// plain element or part-set refs. The pick writes one when more than one thing
// is picked; every reader resolves it through `resolveTargetLeaves`.

/** Whether a ref is an ad-hoc set (`members`). */
export function isSetRef(ref: TargetRef | null | undefined): ref is TargetRef & { members: TargetRef[] } {
  return !!ref && Array.isArray(ref.members);
}

/** The refs a ref is made of: a set's members, else the ref itself. */
export function refMembers(ref: TargetRef): TargetRef[] {
  return ref.members ?? [ref];
}

/** The distinct element ids a ref names directly (members' elements for a
 *  set; a group's own element field is only its representative). */
export function refElementIds(ref: TargetRef): string[] {
  return [...new Set(refMembers(ref).map(m => m.element))];
}

/** One member, stripped to the keys a member may carry. */
function cleanMember(m: TargetRef): TargetRef {
  const out: TargetRef = { element: m.element };
  const parts = m.parts?.length ? [...new Set(m.parts)] : [];
  if (parts.length) out.parts = parts;
  if (m.selector && selectorIsSet(m.selector)) out.selector = structuredClone(m.selector);
  return out;
}

/** Dedupe by key, merge two parts-only members of one element (parts
 *  unioned; a whole member absorbs any part member of its element), in first-
 *  pick order. `strict` refuses what a set may not hold; otherwise those
 *  members are skipped (identity/label readers must never throw). */
function mergeMembers(members: readonly TargetRef[], strict: boolean): TargetRef[] {
  const out: TargetRef[] = [];
  for (const raw of members) {
    if (!raw || typeof raw.element !== "string" || !raw.element) { if (strict) throw new Error("A destination set member must name an object."); continue; }
    if (raw.members) { if (strict) throw new Error("A destination set cannot contain another set."); continue; }
    if (raw.group) { if (strict) throw new Error("A destination set holds objects and plot parts, not groups. Pick the group's objects instead."); continue; }
    const m = cleanMember(raw);
    const same = out.findIndex(o => o.element === m.element);
    if (same < 0) { out.push(m); continue; }
    const prev = out[same];
    if (isWholeElementRef(prev)) continue; // the whole object already covers every part
    if (isWholeElementRef(m)) { out[same] = m; continue; }
    if (!prev.selector && !m.selector) { out[same] = { element: m.element, parts: [...new Set([...(prev.parts ?? []), ...(m.parts ?? [])])] }; continue; }
    // Selectors do not union into one record; keep distinct filters side by side.
    if (!out.some(o => targetKey(o) === targetKey(m))) out.push(m);
  }
  return out;
}

/** The canonical form of a ref. A non-set ref comes back unchanged. A set is
 *  deduplicated (members of one element merged, parts unioned), collapses to
 *  its member when one remains, and carries `element = members[0].element`.
 *  Throws a user-facing reason for an empty set, a nested set or a group
 *  member. */
export function normalizeRef(ref: TargetRef): TargetRef {
  if (!ref.members) return ref;
  const members = mergeMembers(ref.members, true);
  if (!members.length) throw new Error("Pick at least one object for the destination set.");
  if (members.length === 1) return members[0];
  return { element: members[0].element, members };
}

/** Compose the destination of a multi-pick: one pick stays itself (a group
 *  pick included); several picks become ONE normalized set. Group picks among
 *  several are expanded to their member objects, so a set never holds a
 *  group. `groupMembers` supplies a group's member element ids. */
export function composeDestination(picks: readonly TargetRef[], groupMembers: (groupId: string) => string[] = () => []): TargetRef | null {
  if (!picks.length) return null;
  if (picks.length === 1) return picks[0];
  const members = picks.flatMap(p => p.group ? groupMembers(p.group).map(element => ({ element })) : refMembers(p));
  return normalizeRef({ element: members[0]?.element ?? picks[0].element, members });
}

export function isScene3dManifest(manifest: FluxPlotManifest | Scene3dManifest | undefined): manifest is Scene3dManifest {
  return manifest?.spec === 'fluxplot/scene3d';
}

/** The plot LEAF ids a track's part binding resolves to under a manifest:
 *  every `part`/`parts` id expanded through the parts tree (a container or
 *  group id → its current leaves, a leaf → itself), plus every part-index
 *  entry the selector admits, minus the selector's `except` leaves. Order:
 *  parts in authored order, then selector hits by datum index. The ONE
 *  function the compiler (`semanticTargets`) and the player (`resolveNodes`)
 *  both call, so a track can never animate one set and be inspected as another. */
export function targetPartIds(
  binding: Pick<Track, "part" | "parts" | "selector">,
  manifest: FluxPlotManifest | Scene3dManifest | undefined,
): string[] {
  if (isScene3dManifest(manifest)) return modelPartTargets(manifest).resolve(binding);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
  for (const id of trackParts(binding)) for (const leaf of leavesOf(manifest, id)) push(leaf);
  const sel = binding.selector;
  if (sel && (sel.role != null || sel.series != null || sel.index != null)) {
    const indices = sel.index == null ? null : new Set(Array.isArray(sel.index) ? sel.index : [sel.index]);
    // Leaves only: the part index also lists a series' points GROUP under role
    // "point" (buildPartIndex writes `svg.points` that way), and a selector that
    // matched both the group and its members animated every point twice.
    const hits = Object.values(buildPartIndex(manifest))
      .filter((p) => (!sel.role || p.role === sel.role) && (!sel.series || p.series === sel.series) && (!indices || (p.index != null && indices.has(p.index))))
      .filter((p) => isLeafId(manifest, p.id))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const p of hits) push(p.id);
  }
  if (sel?.except?.length) {
    const drop = new Set(sel.except.flatMap((id) => leavesOf(manifest, id)));
    return out.filter((id) => !drop.has(id));
  }
  return out;
}

/** The concrete leaf ids one part id stands for: the parts tree's answer
 *  (`resolveTargets`: a container/group → its members, a leaf → itself), and
 *  for a series' points GROUP that the tree does not describe (legacy or
 *  derived manifests) the series table's own `points[].svgId` list. */
export function leavesOf(manifest: FluxPlotManifest | undefined, id: string): string[] {
  const viaTree = resolveTargets(manifest, id);
  if (viaTree.length !== 1 || viaTree[0] !== id) return viaTree;
  const series = manifest?.series?.find((s) => s.svg?.points === id);
  if (series?.points?.length) return series.points.map((p) => p.svgId);
  return [id];
}

function isLeafId(manifest: FluxPlotManifest | undefined, id: string): boolean {
  const leaves = leavesOf(manifest, id);
  return leaves.length === 1 && leaves[0] === id;
}

/** Whether a track's binding names plot parts at all (as opposed to the whole element). */
export function hasPartBinding(binding: Pick<Track, "part" | "parts" | "selector">): boolean {
  return trackParts(binding).length > 0 || selectorIsSet(binding.selector);
}

export interface ResolvedTarget {
  elementId: Id;
  /** Leaf part ids, or null for the whole element. */
  partIds: string[] | null;
}

/** Resolve a ref to concrete targets on a slide: a group → its member elements
 *  (deep; each whole), a plot ref → its element with the leaf ids, a plain
 *  element → itself. Elements the slide no longer has are dropped (a dangling
 *  ref resolves to []). */
export function resolveTargetLeaves(
  ref: TargetRef,
  slide: Pick<Slide, "elements" | "groups">,
  manifestFor: (assetId: string) => FluxPlotManifest | undefined,
  modelManifestFor?: (assetId: string) => Scene3dManifest | undefined,
): ResolvedTarget[] {
  // A set is the union of its members, each against ITS OWN element's
  // manifest; two members of one element merge (a whole member wins).
  if (ref.members) return mergeResolved(mergeMembers(ref.members, false).map(m => resolveTargetLeaves(m, slide, manifestFor, modelManifestFor)));
  const byId = new Map(slide.elements.map((e) => [e.id, e] as const));
  if (ref.group) {
    const fig = { elements: slide.elements, groups: slide.groups } as unknown as Figure;
    return membersDeep(fig, ref.group).filter((e) => byId.has(e.id)).map((e) => ({ elementId: e.id, partIds: null }));
  }
  const el = byId.get(ref.element);
  if (!el) return [];
  if (isWholeElementRef(ref)) return [{ elementId: el.id, partIds: null }];
  const manifest = el.type === "plot" ? manifestFor((el as Element & { assetId: string }).assetId)
    : el.type === 'model3d' ? modelManifestFor?.(el.assetId) : undefined;
  if (el.type === 'model3d' && !manifest) return [{ elementId: el.id, partIds: [] }];
  const partIds = targetPartIds({ parts: ref.parts, selector: ref.selector }, manifest);
  return [{ elementId: el.id, partIds }];
}

/** Union resolved targets by element, in first-seen order: a whole element
 *  (`partIds: null`) absorbs that element's part lists, part lists union. */
export function mergeResolved(lists: readonly ResolvedTarget[][]): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  const at = new Map<string, number>();
  for (const list of lists) for (const target of list) {
    const i = at.get(target.elementId);
    if (i === undefined) { at.set(target.elementId, out.length); out.push({ elementId: target.elementId, partIds: target.partIds && [...target.partIds] }); continue; }
    const prev = out[i];
    if (prev.partIds === null) continue;
    if (target.partIds === null) { prev.partIds = null; continue; }
    for (const id of target.partIds) if (!prev.partIds.includes(id)) prev.partIds.push(id);
  }
  return out;
}

/** The noun a whole object of each kind counts as in a set label. */
const KIND_NOUN: Record<string, string> = { model3d: "model", rect: "rect", ellipse: "ellipse", line: "line", path: "path", text: "text", image: "image", video: "video", plot: "plot" };
/** Part roles that read as nouns in a count ("6 points"); others count as "part". */
const ROLE_NOUN = new Set(["point", "line", "bar", "box", "spine", "tick", "label", "whisker", "median", "cap", "flier", "area", "patch", "cell", "hexagon", "marker", "title", "legend", "gridline", "band", "contour", "arrow"]);
const plural = (noun: string, n: number) => n === 1 ? noun : /(?:s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
const SET_LABEL_MAX = 40;

/** A destination SET names what it holds by count — "3 ellipses", "2 ellipses
 *  + 1 rect", "6 points + 1 ellipse" — in first-pick order, larger counts
 *  first; past 40 characters it falls back to a plain total. Pure: the
 *  animator lanes, pick bar, toast and the CLI verbs all say the same words. */
export function setLabel(members: readonly TargetRef[], elements: readonly Pick<Element, "id" | "type">[], manifestFor: (elementId: string) => FluxPlotManifest | Scene3dManifest | undefined = () => undefined): string {
  const counts = new Map<string, number>();
  let objects = 0, parts = 0;
  const add = (noun: string, n = 1) => counts.set(noun, (counts.get(noun) ?? 0) + n);
  for (const member of members) {
    const el = elements.find(e => e.id === member.element);
    if (!el) { add("missing object"); objects++; continue; }
    if (!member.parts?.length && !member.selector) { add(KIND_NOUN[el.type] ?? "object"); objects++; continue; }
    const manifest = manifestFor(el.id);
    const ids = targetPartIds({ parts: member.parts, selector: member.selector }, manifest);
    const index = manifest && !isScene3dManifest(manifest) ? buildPartIndex(manifest) : {};
    for (const id of ids.length ? ids : member.parts ?? []) { const role = index[id]?.role; add(role && ROLE_NOUN.has(role) ? role : "part"); parts++; }
  }
  const order = [...counts.keys()];
  const terms = [...counts].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0])).map(([noun, n]) => `${n} ${plural(noun, n)}`);
  const label = terms.join(" + ");
  if (label.length <= SET_LABEL_MAX) return label;
  const total = objects + parts;
  const coarse = !parts ? `${objects} objects` : !objects ? `${parts} parts` : `${parts} ${plural("part", parts)} + ${objects} ${plural("object", objects)}`;
  return coarse.length <= SET_LABEL_MAX ? coarse : `${total} targets`;
}
