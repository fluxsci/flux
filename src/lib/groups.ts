// ---------------------------------------------------------------------------
// Flux groups — pure helpers over the group REGISTRY (figure-v1 P7).
//
// The model stays a flat z-ordered `Figure.elements[]`; grouping is a derived
// overlay: each element's `groupId` names its IMMEDIATE group and
// `Figure.groups` maps group id → GroupDef {name, parentId?, hidden?, locked?}.
// Nesting lives on the defs (parentId), never on elements.
//
// INVARIANT: a group's members (deep) occupy one CONTIGUOUS run of the
// elements array — ops.group splices it that way, the group-aware
// reorderElement/setZOrder preserve it, and migrate.ts heals legacy docs once
// on load (enforceZContiguity below).
//
// TOLERANCE: an element whose groupId has NO GroupDef (legacy docs before
// migration; Canvas alt-drag duplicates until the Canvas wave adopts
// cloneGroupsFor) is treated as LOOSE by every tree/ancestor helper here —
// never a crash. Selection expansion (store.expandGroups) still co-selects
// elements sharing such a raw dangling id, preserving the old flat behavior.
//
// Keep this module dependency-light and DOM-free (types + ids only): ops.ts,
// store.ts, migrate.ts, export.ts and flux-core all import it.
// ---------------------------------------------------------------------------

import type { Element, Figure, GroupDef, Id } from "./types";
import { newId } from "./ids";

/** The figure's registry, never null. */
export const groupDefs = (fig: Figure): Record<Id, GroupDef> => fig.groups ?? {};

// ---------------------------------------------------------------------------
// Ancestry
// ---------------------------------------------------------------------------

/** Registered ancestor chain for a group id: [gid, parent, …, root].
 *  Cycle-safe; an unregistered (dangling) gid → []. */
export function ancestorsOf(fig: Figure, gid: Id | undefined): Id[] {
  const defs = groupDefs(fig);
  const out: Id[] = [];
  let cur = gid;
  while (cur && defs[cur] && !out.includes(cur)) {
    out.push(cur);
    cur = defs[cur].parentId;
  }
  return out;
}

/** An element's registered group chain, ROOT-FIRST: [top, …, immediate].
 *  Loose / dangling-groupId elements → []. */
export function chainOf(fig: Figure, el: Element): Id[] {
  return ancestorsOf(fig, el.groupId).reverse();
}

/** Outermost registered group containing `gid` (a group id, or an element's
 *  groupId). Null when loose / unregistered. */
export function topGroupOf(fig: Figure, gid: Id | undefined): Id | null {
  const chain = ancestorsOf(fig, gid);
  return chain.length ? chain[chain.length - 1] : null;
}

/** The selection UNIT an element belongs to, optionally bounded by an entered
 *  group `scope`: without scope, the element's TOP-level group (or the element
 *  itself when loose); with scope and the element inside it, the child unit
 *  directly below the scope (a nested group, or the element itself when it is
 *  a direct member of scope). With scope set but the element OUTSIDE it, falls
 *  back to the top-level unit. `groupId: null` ⇒ the element is its own unit. */
export function unitOf(fig: Figure, el: Element, scope?: Id | null): { groupId: Id | null; el: Element } {
  const chain = chainOf(fig, el); // [top .. immediate]
  if (!chain.length) return { groupId: null, el };
  if (scope) {
    const i = chain.indexOf(scope);
    if (i >= 0) return i + 1 < chain.length ? { groupId: chain[i + 1], el } : { groupId: null, el };
  }
  return { groupId: chain[0], el };
}

/** Stable key of an element's selection/z-order unit at a scope level:
 *  "g:<gid>" (registered unit group), "d:<gid>" (elements sharing a DANGLING
 *  groupId form one anonymous flat unit — alt-dup tolerance), "e:<elId>". */
export function unitKeyOf(fig: Figure, el: Element, scope?: Id | null): string {
  const u = unitOf(fig, el, scope);
  if (u.groupId) return "g:" + u.groupId;
  if (el.groupId && !groupDefs(fig)[el.groupId]) return "d:" + el.groupId;
  return "e:" + el.id;
}

// ---------------------------------------------------------------------------
// Membership / effective state
// ---------------------------------------------------------------------------

export interface GroupIndex {
  defs: Record<Id, GroupDef>;
  /** immediate ELEMENT members per registered group (z-order) */
  members: Map<Id, Element[]>;
  /** immediate child GROUPS per registered group (registry order) */
  children: Map<Id, Id[]>;
  /** registered groups with no (registered) parent (registry order) */
  roots: Id[];
}

/** One-pass index of the registry: immediate members / child groups / roots. */
export function groupIndex(fig: Figure): GroupIndex {
  const defs = groupDefs(fig);
  const members = new Map<Id, Element[]>();
  const children = new Map<Id, Id[]>();
  const roots: Id[] = [];
  for (const gid of Object.keys(defs)) {
    members.set(gid, []);
    children.set(gid, []);
  }
  for (const g of Object.values(defs)) {
    if (g.parentId && defs[g.parentId] && g.parentId !== g.id) children.get(g.parentId)!.push(g.id);
    else roots.push(g.id);
  }
  for (const e of fig.elements) if (e.groupId && defs[e.groupId]) members.get(e.groupId)!.push(e);
  return { defs, members, children, roots };
}

/** All elements inside `gid` at ANY depth, in z-order. [] for unknown ids. */
export function membersDeep(fig: Figure, gid: Id): Element[] {
  if (!groupDefs(fig)[gid]) return [];
  return fig.elements.filter((e) => ancestorsOf(fig, e.groupId).includes(gid));
}

/** Hidden for render/export purposes: own flag OR any ancestor group's eye. */
export function effectiveHidden(fig: Figure, el: Element): boolean {
  if (el.hidden) return true;
  const defs = groupDefs(fig);
  return ancestorsOf(fig, el.groupId).some((g) => defs[g].hidden);
}

/** Locked for interaction purposes: own flag OR any ancestor group's padlock. */
export function effectiveLocked(fig: Figure, el: Element): boolean {
  if (el.locked) return true;
  const defs = groupDefs(fig);
  return ancestorsOf(fig, el.groupId).some((g) => defs[g].locked);
}

// ---------------------------------------------------------------------------
// Registry maintenance
// ---------------------------------------------------------------------------

/** Drop registry entries that no longer contain any element (deep) and clear
 *  parentIds pointing at unregistered groups. Call after any op that deletes
 *  elements or dissolves groups. Leaves element groupIds untouched (a dangling
 *  groupId is deliberate tolerance, not garbage). */
export function gcGroups(fig: Figure): void {
  const defs = fig.groups;
  if (!defs) return;
  const live = new Set<Id>();
  for (const e of fig.elements) for (const g of ancestorsOf(fig, e.groupId)) live.add(g);
  for (const gid of Object.keys(defs)) if (!live.has(gid)) delete defs[gid];
  for (const g of Object.values(defs)) if (g.parentId && !defs[g.parentId]) delete g.parentId;
  if (!Object.keys(defs).length) delete fig.groups;
}

/** Next default group name: "Group N", N = 1 + the highest existing
 *  default-named group in the figure (no collisions with prior defaults). */
export function nextGroupName(fig: Figure): string {
  let max = 0;
  for (const g of Object.values(groupDefs(fig))) {
    const m = /^Group (\d+)$/.exec(g.name);
    if (m) max = Math.max(max, +m[1]);
  }
  return `Group ${max + 1}`;
}

/** Clone the GroupDefs needed by copies of `els`: every registered group in
 *  any element's chain gets a fresh id (recorded in `remap`) and a cloned def
 *  (same name/hidden/locked; parentId remapped) — names and nesting survive
 *  duplication with independent identity. Callers merge the returned defs into
 *  the destination figure's registry and rewrite each copy's groupId through
 *  `remap`. DANGLING source ids get no def (they were loose already) but ARE
 *  remapped, so copies stay co-selected among themselves like their originals.
 *  Replaces the hand-rolled grpRemap loops (duplicate / paste / dup-figure;
 *  Canvas performAltDup still hand-rolls until the Canvas wave adopts this). */
export function cloneGroupsFor(
  groups: Record<Id, GroupDef> | undefined,
  els: Element[],
  remap: Map<Id, Id>,
): Record<Id, GroupDef> {
  const defs = groups ?? {};
  for (const e of els) {
    let cur = e.groupId;
    const seen = new Set<Id>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (!remap.has(cur)) remap.set(cur, newId("grp"));
      const def = defs[cur];
      if (!def) break; // dangling: remapped for co-selection, nothing to clone
      cur = def.parentId;
    }
  }
  const out: Record<Id, GroupDef> = {};
  for (const [old, fresh] of remap) {
    const def = defs[old];
    if (!def || out[fresh]) continue;
    const clone: GroupDef = { ...structuredClone(def), id: fresh };
    if (def.parentId && defs[def.parentId] && remap.has(def.parentId)) clone.parentId = remap.get(def.parentId)!;
    else delete clone.parentId;
    out[fresh] = clone;
  }
  return out;
}

/** Re-order `fig.elements` (stably) so every registered group's deep members
 *  are contiguous: at every tree level, units keep their first-appearance
 *  z-order. Idempotent (a compliant figure is untouched); returns true when
 *  anything moved. Migration heal — the editing ops maintain the invariant
 *  incrementally after load. */
export function enforceZContiguity(fig: Figure): boolean {
  if (!fig.groups || !Object.keys(fig.groups).length) return false;
  const seq = new Map<string, number>();
  let n = 0;
  const slot = (k: string): number => {
    if (!seq.has(k)) seq.set(k, n++);
    return seq.get(k)!;
  };
  const keyed = fig.elements.map((e) => {
    const path: number[] = [];
    let prefix = "";
    for (const gid of chainOf(fig, e)) {
      prefix += "/" + gid;
      path.push(slot(prefix));
    }
    path.push(slot(prefix + "/#" + e.id));
    return { e, path };
  });
  const sorted = [...keyed].sort((a, b) => {
    const len = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < len; i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
    return a.path.length - b.path.length;
  });
  const moved = sorted.some((s, i) => s.e !== fig.elements[i]);
  if (moved) fig.elements = sorted.map((s) => s.e);
  return moved;
}

// ---------------------------------------------------------------------------
// Derived render tree
// ---------------------------------------------------------------------------

export type RenderNode =
  | { kind: "element"; el: Element }
  | { kind: "group"; def: GroupDef; children: RenderNode[] };

/** Derive the nested render forest from the flat z-ordered array + registry.
 *  Bottom-z first (fig.elements order); a group node sits at the z-position of
 *  its first (lowest) member and holds its children in z-order. Tolerant of
 *  invariant violations: an element whose group's run already ended (straggler)
 *  or whose groupId has no def renders as a LOOSE node at the deepest
 *  still-open ancestor level — never a crash, nothing dropped. */
export function buildRenderTree(fig: Figure): RenderNode[] {
  const defs = groupDefs(fig);
  const roots: RenderNode[] = [];
  const stack: { id: Id; node: Extract<RenderNode, { kind: "group" }> }[] = [];
  const closed = new Set<Id>();
  const container = (): RenderNode[] => (stack.length ? stack[stack.length - 1].node.children : roots);
  for (const el of fig.elements) {
    const chain = chainOf(fig, el); // [top .. immediate], registered only
    let k = 0;
    while (k < stack.length && k < chain.length && stack[k].id === chain[k]) k++;
    while (stack.length > k) closed.add(stack.pop()!.id);
    for (let i = k; i < chain.length; i++) {
      if (closed.has(chain[i])) break; // straggler: render loose at this level
      const node: Extract<RenderNode, { kind: "group" }> = { kind: "group", def: defs[chain[i]], children: [] };
      container().push(node);
      stack.push({ id: chain[i], node });
    }
    container().push({ kind: "element", el });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Groups-only summary (slides / agent digests)
// ---------------------------------------------------------------------------

export interface FigureGroupNode {
  id: Id;
  name: string;
  hidden?: boolean;
  locked?: boolean;
  /** nested child groups (z-order of first member) */
  groups: FigureGroupNode[];
  /** immediate element member ids (z-order) */
  elementIds: Id[];
}

/** Groups-only view of a figure — the handle the slide animator's parts tree
 *  (embedFigure expansion, P9) and agent context digests consume. */
export function figureGroupTree(fig: Figure): FigureGroupNode[] {
  const walk = (nodes: RenderNode[]): { groups: FigureGroupNode[]; elementIds: Id[] } => {
    const groups: FigureGroupNode[] = [];
    const elementIds: Id[] = [];
    for (const n of nodes) {
      if (n.kind === "element") {
        elementIds.push(n.el.id);
        continue;
      }
      const inner = walk(n.children);
      groups.push({
        id: n.def.id,
        name: n.def.name,
        ...(n.def.hidden ? { hidden: true } : {}),
        ...(n.def.locked ? { locked: true } : {}),
        groups: inner.groups,
        elementIds: inner.elementIds,
      });
    }
    return { groups, elementIds };
  };
  return walk(buildRenderTree(fig)).groups;
}
