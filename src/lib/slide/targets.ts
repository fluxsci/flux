// ---------------------------------------------------------------------------
// Flux Slide — the TARGET vocabulary (animation v2, deck 0.6). One way to name
// a thing that animates — an element, a set of a plot's parts, a role/series
// filter over a plot, or a figure group — and ONE identity for it that every
// family law, compiler, player and verb compares.
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
import { buildPartIndex } from "../plot/parse";
import { resolveTargets } from "../plot/tree";
import { membersDeep } from "../groups";
import type { Slide, TargetRef, Track, TrackSelector } from "./types";

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
 *  whatever order a pick listed the parts in. Whole-element ⇒ `"<id>|||"`. */
export function targetKey(ref: TargetRef): string {
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

/** Whether a ref names the WHOLE element (no parts, no selector, no group). */
export function isWholeElementRef(ref: TargetRef): boolean {
  return !ref.parts?.length && !(ref.selector && selectorIsSet(ref.selector)) && !ref.group;
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
  manifest: FluxPlotManifest | undefined,
): string[] {
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
): ResolvedTarget[] {
  const byId = new Map(slide.elements.map((e) => [e.id, e] as const));
  if (ref.group) {
    const fig = { elements: slide.elements, groups: slide.groups } as unknown as Figure;
    return membersDeep(fig, ref.group).filter((e) => byId.has(e.id)).map((e) => ({ elementId: e.id, partIds: null }));
  }
  const el = byId.get(ref.element);
  if (!el) return [];
  if (isWholeElementRef(ref)) return [{ elementId: el.id, partIds: null }];
  const manifest = el.type === "plot" ? manifestFor((el as Element & { assetId: string }).assetId) : undefined;
  const partIds = targetPartIds({ parts: ref.parts, selector: ref.selector }, manifest);
  return [{ elementId: el.id, partIds }];
}
