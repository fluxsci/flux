// The Become picker's pure model (2026-10-02, owner ask "A better 'Become' UI").
//
// A pick is an ORDERED list of units — the finest meaningful things the author
// pointed at: a plot's semantic leaf part, a loose or grouped element, or a
// whole group (Alt+click). Order is the picking order (the numbered badges).
// The commit converts units to the ONE target vocabulary (`TargetRef[]`, one
// ref per element with its parts unioned — exactly `refsForTargets`) and then
// to one destination (`composeDestination`). Everything here is DOM-free so
// `verify-become-picker.ts` pins it in the pure tier; the DOM half (hit walk,
// rects) lives in `stageHit.ts`, the state machine in `pickState.svelte.ts`.

import type { TargetRef } from "../../../../lib/slide/types";
import type { FluxPlotManifest } from "../../../../lib/plot/types";
import { buildPartTree, type XrayNode } from "../../../../lib/plot/tree";
import { isScaffoldPart } from "../../../../lib/plot/partStyle";
import { rowParents, widenToSiblings } from "../../../../lib/xray/buildXrayTree";
import { rectInside, isDataRole, boxFrom, preferData, type Box } from "../../../../lib/plot/partMarquee";

export interface PickUnit {
  element: string;
  /** A semantic plot/model part of `element`. */
  part?: string;
  /** A whole group (Alt+click on a member). `element` is its first member, the
   *  same convention as the X-ray's group row target. */
  group?: string;
}

export interface UnitContext {
  /** The deep element members of a group id. */
  membersOf?: (groupId: string) => readonly string[];
}

export const unitKey = (u: PickUnit): string => (u.group ? `g:${u.group}` : u.part ? `p:${u.element}\u0000${u.part}` : `e:${u.element}`);
export const sameUnit = (a: PickUnit, b: PickUnit): boolean => unitKey(a) === unitKey(b);

/** Elements a unit covers (a group covers its members). */
function covers(u: PickUnit, ctx: UnitContext): string[] {
  return u.group ? [...(ctx.membersOf?.(u.group) ?? [u.element])] : [u.element];
}

/** Two units that cannot both be picked: a whole object and one of its own
 *  parts, or a group and one of its members (either granularity — the last
 *  pick wins, so clicking a part of a picked plot refines the pick). */
export function conflicts(a: PickUnit, b: PickUnit, ctx: UnitContext = {}): boolean {
  if (sameUnit(a, b)) return false;
  if (a.group || b.group) {
    const ea = covers(a, ctx), eb = covers(b, ctx);
    return ea.some((id) => eb.includes(id));
  }
  if (a.element !== b.element) return false;
  return !a.part !== !b.part; // whole vs part of the same element
}

/** Is this unit (part of) the waiting source itself? The source never picks itself. */
export function isSourceUnit(u: PickUnit, source: TargetRef | null | undefined, ctx: UnitContext = {}): boolean {
  if (!source) return false;
  // A set source (Appear from… armed on several objects): any member is the source.
  if (source.members) return source.members.some((m) => isSourceUnit(u, m, ctx));
  if (source.group) return covers(u, ctx).some((id) => (ctx.membersOf?.(source.group!) ?? [source.element]).includes(id));
  if (u.group) return covers(u, ctx).includes(source.element);
  if (u.element !== source.element) return false;
  if (!source.parts?.length) return true; // the whole source object, any part of it
  return !u.part || source.parts.includes(u.part);
}

/** Append units not already picked (conflicting picks give way); the source is skipped. */
export function addUnits(units: readonly PickUnit[], add: readonly PickUnit[], source?: TargetRef | null, ctx: UnitContext = {}): PickUnit[] {
  let out = [...units];
  for (const u of add) {
    if (isSourceUnit(u, source, ctx) || out.some((o) => sameUnit(o, u))) continue;
    out = out.filter((o) => !conflicts(o, u, ctx));
    out.push(u);
  }
  return out;
}

export function removeUnits(units: readonly PickUnit[], remove: readonly PickUnit[]): PickUnit[] {
  const gone = new Set(remove.map(unitKey));
  return units.filter((u) => !gone.has(unitKey(u)));
}

/** Plain click: toggle. Returns the next units and whether the unit is now picked. */
export function toggleUnit(units: readonly PickUnit[], u: PickUnit, source?: TargetRef | null, ctx: UnitContext = {}): { units: PickUnit[]; picked: boolean } {
  if (units.some((o) => sameUnit(o, u))) return { units: removeUnits(units, [u]), picked: false };
  if (isSourceUnit(u, source, ctx)) return { units: [...units], picked: false };
  return { units: addUnits(units, [u], source, ctx), picked: true };
}

/** Units → refs: one ref per element (parts unioned in pick order), groups as
 *  `{element, group}`, refs in first-pick order — `SlideMode.refsForTargets`'s law. */
export function unitsToRefs(units: readonly PickUnit[]): TargetRef[] {
  const refs = new Map<string, TargetRef>();
  for (const u of units) {
    if (u.group) { refs.set(`g:${u.group}`, { element: u.element, group: u.group }); continue; }
    const key = `e:${u.element}`, prev = refs.get(key);
    if (!u.part) refs.set(key, { element: u.element });
    else if (!prev) refs.set(key, { element: u.element, parts: [u.part] });
    else if (prev.parts && !prev.parts.includes(u.part)) prev.parts.push(u.part);
  }
  return [...refs.values()];
}

export function refsToUnits(refs: readonly TargetRef[]): PickUnit[] {
  return refs.flatMap((r) => (r.group ? [{ element: r.element, group: r.group }] : r.parts?.length ? r.parts.map((part) => ({ element: r.element, part })) : [{ element: r.element }]));
}

/** The X-ray target form (animateHook) → units. */
export function targetsToUnits(targets: readonly { elementId: string; partId?: string; groupId?: string }[]): PickUnit[] {
  return targets.map((t) => (t.groupId ? { element: t.elementId, group: t.groupId } : t.partId ? { element: t.elementId, part: t.partId } : { element: t.elementId }));
}

/** The destination of a pick set, DOM-free: one ref passes through; several
 *  become the ad-hoc set form (`TargetRef.members`, slide/targets.ts), run
 *  through `normalize` when given. The live picker uses the shared
 *  `targets.composeDestination` (which also expands group picks); this form
 *  is the pure gate's and the fallback's. */
export function composeDestination(picks: readonly TargetRef[], normalize?: (ref: TargetRef) => TargetRef): TargetRef | null {
  if (!picks.length) return null;
  if (picks.length === 1) return picks[0];
  const set = { element: picks[0].element, members: [...picks] } as TargetRef; // W1's shape
  return normalize ? normalize(set) : set;
}

// --- chips -------------------------------------------------------------------------------------

export interface UnitDescription {
  /** Singular kind noun ("point", "ellipse", "rect", "tick label", "group"). */
  kind: string;
  /** Owner of the unit for grouping: the plot element id for parts, "" for loose objects. */
  owner: string;
  /** Context shared by a run ("W1" series, a plot's name) — shown when every unit agrees. */
  context?: string;
  /** The unit's own label, exactly as its lane names it (`refLabel`). */
  label: string;
  /** A lone unit's chip: the label without the owning plot's name ("Point #0 · W3"). */
  chip?: string;
}

export interface PickChip { key: string; label: string; units: PickUnit[] }

const IRREGULAR: Record<string, string> = { box: "boxes", whisker: "whiskers", axis: "axes", "axis-title": "axis titles" };
export function pluralKind(kind: string, n: number): string {
  if (n === 1) return kind;
  if (IRREGULAR[kind]) return IRREGULAR[kind];
  if (/(?:s|x|ch|sh)$/.test(kind)) return kind + "es";
  if (/[^aeiou]y$/.test(kind)) return kind.slice(0, -1) + "ies";
  return kind + "s";
}

/** Collapse a pick into chips: units of the same kind and owner form ONE chip
 *  ("6 points · W1", "2 ellipses"), a lone unit keeps its own label ("Rect 1").
 *  Chip order is first-pick order; `max` chips are returned, the rest counted. */
export function chipRuns(units: readonly PickUnit[], describe: (u: PickUnit) => UnitDescription, max = 6): { chips: PickChip[]; more: number } {
  const runs = new Map<string, { d: UnitDescription[]; units: PickUnit[] }>();
  for (const u of units) {
    const d = describe(u), key = `${d.owner}\u0000${d.kind}`;
    const run = runs.get(key) ?? { d: [], units: [] };
    run.d.push(d); run.units.push(u); runs.set(key, run);
  }
  const chips = [...runs.entries()].map(([key, run]) => {
    if (run.units.length === 1) return { key, label: run.d[0].chip ?? run.d[0].label, units: run.units };
    const ctx = run.d[0].context;
    const shared = ctx && run.d.every((d) => d.context === ctx) ? ` · ${ctx}` : "";
    return { key, label: `${run.units.length} ${pluralKind(run.d[0].kind, run.units.length)}${shared}`, units: run.units };
  });
  return { chips: chips.slice(0, max), more: Math.max(0, chips.length - max) };
}

/** The count the bar shows: every picked unit. */
export const pickCount = (units: readonly PickUnit[]): number => units.length;

// --- marquee -----------------------------------------------------------------------------------
// The leaf-level law (fully inside, data preferred) is the shared pure module
// `lib/plot/partMarquee.ts` — the Figure canvas's in-plot ctrl-drag uses the
// same one. This layer adds the object level: a whole element inside wins.

export type StageRect = Box;
export { rectInside, isDataRole, boxFrom };

export interface MarqueeCandidate {
  unit: PickUnit;
  rect: StageRect;
  /** "object" = a whole element (loose, a group member, or a whole plot); "leaf" = a plot leaf part. */
  level: "object" | "leaf";
  /** Leaf parts only: a DATA mark (point, bar, box, line, …) rather than guide furniture. */
  data?: boolean;
}

/** The marquee law: every unit whose stage box is FULLY inside. A whole object
 *  inside is picked whole (its leaves are not listed separately); for an object
 *  only partly inside, its leaves fully inside are picked — data marks preferred:
 *  when any data mark of that object is inside, guide furniture (ticks, labels,
 *  spines) is left out; furniture is picked only when no data mark is inside.
 *  Zero-area boxes never count. Candidates arrive in paint order. */
export function marqueeUnits(candidates: readonly MarqueeCandidate[], box: StageRect): PickUnit[] {
  const inside = candidates.filter((c) => (c.rect.w > 0 || c.rect.h > 0) && rectInside(c.rect, box));
  const wholeObjects = new Set(inside.filter((c) => c.level === "object").map((c) => c.unit.element));
  const leavesByElement = new Map<string, MarqueeCandidate[]>();
  for (const c of inside) {
    if (c.level !== "leaf" || wholeObjects.has(c.unit.element)) continue;
    const list = leavesByElement.get(c.unit.element);
    if (list) list.push(c); else leavesByElement.set(c.unit.element, [c]);
  }
  const out: PickUnit[] = inside.filter((c) => c.level === "object").map((c) => c.unit);
  for (const leaves of leavesByElement.values()) for (const c of preferData(leaves)) out.push(c.unit);
  return out;
}

// --- `a`: widening plot parts -------------------------------------------------------------------

/** Widen picked LEAF parts of one plot over its part tree: first the other
 *  members of the smallest group holding each leaf (one box plot's caps),
 *  then the X-ray's sibling rule over the nodes standing for the picked
 *  leaves. Returns the grown leaf set as units (scaffold leaves excluded). */
export function widenParts(manifest: FluxPlotManifest | undefined, elementId: string, leaves: readonly string[]): PickUnit[] {
  const tree = buildPartTree(manifest);
  if (!tree || !leaves.length) return [];
  const nodes: XrayNode[] = [], depth = new Map<XrayNode, number>();
  const walk = (n: XrayNode, d: number) => { nodes.push(n); depth.set(n, d); n.children.forEach((c) => walk(c, d + 1)); };
  walk(tree, 0);
  /** The node that stands for a leaf: its own node, else the DEEPEST node holding it
   *  (a series' points group, not the series that also holds only that point). */
  const home = (leaf: string): XrayNode | undefined => nodes.find((n) => n.id === leaf) ?? nodes.filter((n) => n.targets.includes(leaf)).sort((a, b) => depth.get(b)! - depth.get(a)!)[0];
  const have = new Set(leaves);
  const usable = (id: string) => !isScaffoldPart(manifest, id);
  const groupMates = new Set(have);
  for (const leaf of leaves) { const g = home(leaf); if (g && g.id !== leaf) for (const id of g.targets) if (usable(id)) groupMates.add(id); }
  let grown = groupMates;
  if (grown.size === have.size) {
    const picked = [...new Set(leaves.map(home).filter((n): n is XrayNode => !!n))];
    const next = widenToSiblings(tree, picked, rowParents(tree));
    grown = new Set(have);
    if (next) for (const id of next) for (const leaf of nodes.find((n) => n.id === id)?.targets ?? []) if (usable(leaf)) grown.add(leaf);
  }
  return [...grown].map((part) => ({ element: elementId, part }));
}
