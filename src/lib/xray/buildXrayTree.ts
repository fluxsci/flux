// ---------------------------------------------------------------------------
// Unified X-ray tree (figure-v1 P8) — one pure builder for every target the
// X-ray can be rooted on:
//
//   {kind:"element"} — a single element. A semantic plot expands IN PLACE: the
//     element row IS the plot's figure root (its children are the manifest
//     part-tree's children mapped to part rows), so a fluxplot inside a group
//     shows its own "Figure" root next to sibling shapes — the owner's exact
//     conceptual model ("fluxplot = a well-supported specific kind of group").
//     Non-plot elements are leaf rows.
//   {kind:"group"} — a registry group (groups.ts). Children = nested child
//     groups (by name) + member elements, walked TOP-Z FIRST so the X-ray and
//     the Sidebar layers agree on direction.
//
// Ctrl-click re-rooting resolves through the ids carried on each row: a group
// row re-roots to its group target, an element row to its element target, and
// a part row to its OWNING PLOT's element target ("as if x-rayed alone").
//
// Pure and DOM-free: (project, target, manifests) in → rows out. The GUI
// rebuilds on every project mutation, so per-row hidden/locked states are
// always current. Row ids ("el:…", "grp:…", "part:<elId>__<partId>") are
// stable across rebuilds AND re-roots, so expand/selection state survives.
// ---------------------------------------------------------------------------

import type { Element, Figure, Id, Project, SemanticPlotElement } from "../types";
import type { FluxPlotManifest } from "../plot/types";
import type { Model3dElement, Scene3dManifest, Model3dInfo } from '../model3d/types';
import { buildModel3dTree } from '../model3d/tree';
import { buildScene3dPartIndex, type Scene3dPartIndex, resolveScene3dPartStyle } from '../model3d/scene3d';
import { partDomId } from "../plot/parse";
import { buildPartTree, type XrayNode } from "../plot/tree";
import { buildRenderTree, groupDefs, membersDeep, type RenderNode } from "../groups";
import { distinctiveParts, manifestIndex, overrideState, partContext, plotHint, type OverrideState } from "./rowContext";
import { labelForPart, inferRole, resolveTargets } from "../plot/tree";

export const partRowId = (elementId: string, partId: string): string => `part:${partDomId(elementId, partId)}`;

/** What the X-ray is rooted on (store.xrayRoot). `elements` (2026-09-15) is
 *  a MULTI-PLOT root: several plots x-rayed together, each expanding under a
 *  synthetic "N plots" row, plus the COMMON part rows they share (below). */
type SemanticElement = SemanticPlotElement | Model3dElement;
type Models = Record<string, Scene3dManifest>;
type ModelInfo = Record<string, Model3dInfo>;
export type XrayTarget =
  | { kind: "element"; figId: Id; elementId: Id }
  | { kind: "elements"; figId: Id; elementIds: Id[] }
  | { kind: "group"; figId: Id; groupId: Id };

/** One row of the unified X-ray tree. */
export interface XRow {
  /** Stable unique row key: "el:<id>" | "grp:<id>" | "part:<elId>__<partId>" |
   *  "set:<figId>" (multi-plot root) | "common:<partId>" (a part shared by
   *  every plot of a multi-plot root). */
  id: string;
  kind: "element" | "part" | "group" | "set" | "common";
  label: string;
  /** part role, element type ("figure" for plots — the row IS the part root), or "group". */
  role: string;
  /** element rows + part rows (the part's owning plot). */
  elementId?: Id;
  /** part rows only — the override key. `common` rows carry it too, with the
   *  plots it applies to in `elementIds`. */
  partId?: string;
  /** `common` rows: every plot of the multi-plot root that has this part. */
  elementIds?: Id[];
  /** `common` rows: how many of those plots currently hide the part
   *  (0 = shown everywhere, elementIds.length = hidden everywhere). */
  hiddenCount?: number;
  /** group rows only. */
  groupId?: Id;
  /** The row's OWN hidden state (element flag / GroupDef eye / override.hidden). */
  hidden?: boolean;
  locked?: boolean;
  /** Container semantics (expandable). */
  isGroup: boolean;
  /** Leaf count for fan-out rows (part groups / group member totals). */
  count?: number;
  children: XRow[];
  // --- context (xray/rowContext.ts): BESIDE the label, never in it ----------
  /** Meaningful ancestors, root-most first ("X axis"): shown where a row has
   *  lost its hierarchy (search results, common rows). */
  path?: string[];
  /** One-line value preview: tick texts, a title's text, a plot's y title. */
  preview?: string;
  /** An identifying paint (a series' / legend entry's colour). */
  swatch?: string;
  /** The axis a part belongs to ("x", "y", "x2" …). */
  axis?: string;
  /** A group MEMBER (one tick label, one point): a row of its own under its group. */
  member?: boolean;
  /** The row's own override restyles it (beyond hidden). */
  styled?: boolean;
  /** Something beneath is restyled / hidden. */
  styledBeneath?: boolean;
  hiddenBeneath?: boolean;
  /** Part rows drawn PARTLY hidden: how many of their leaves are hidden. */
  hiddenParts?: number;
  /** An ancestor is hidden (the row draws nothing, whatever its own eye says). */
  inheritedHidden?: boolean;
  /** Element rows shown beside sibling plots: the label split into the prefix
   *  every sibling shares (drawn dim) and its distinctive key; `ordinal` tells
   *  identical labels apart (one plot placed twice). */
  keyParts?: { prefix: string; key: string; ordinal: number | null };
}

/** Optional drawing lookup: the pristine plot DOM by asset id (text previews
 *  read the drawn text; without it they fall back to the manifest). */
export type PlotDomOf = (assetId: string) => globalThis.Element | null | undefined;

function figOf(p: Project, figId: Id): Figure | null {
  return p.figures.find((f) => f.id === figId) ?? null;
}

function baseName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const b = path.split(/[\\/]/).pop() ?? path;
  const stem = b.replace(/\.(?:svg|glb)$/i, "");
  return stem || undefined;
}

/** Display label for an element row: user name → (plots) svg basename →
 *  part-tree root label ("Figure") → indexed type ("rect 3", Sidebar's
 *  convention, 1-based z index). */
export function elementLabel(
  fig: Figure,
  el: Element,
  manifests: Record<string, FluxPlotManifest>,
): string {
  if (el.name) return el.name;
  if (el.type === "plot") {
    const plot = el as SemanticPlotElement;
    const root = buildPartTree(manifests[plot.assetId]);
    return baseName(plot.source?.svgPath) ?? root?.label ?? "Plot";
  }
  if (el.type === "model3d") return baseName(el.source?.glbPath) ?? "3D model";
  const z = fig.elements.findIndex((e) => e.id === el.id);
  return `${el.type} ${z + 1}`;
}

/** Header label for a root target (breadcrumb segments). */
export function targetLabel(
  p: Project,
  target: XrayTarget,
  manifests: Record<string, FluxPlotManifest>,
): string {
  const fig = figOf(p, target.figId);
  if (!fig) return "—";
  if (target.kind === "group") return groupDefs(fig)[target.groupId]?.name ?? "group";
  if (target.kind === "elements") {
    const n = target.elementIds.filter((id) => fig.elements.some((e) => e.id === id)).length;
    const kinds = target.elementIds.map(id => fig.elements.find(e => e.id === id)?.type);
    return `${n} ${kinds.every(k => k === "model3d") ? "models" : kinds.every(k => k === "plot") ? "plots" : "objects"}`;
  }
  const el = fig.elements.find((e) => e.id === target.elementId);
  return el ? elementLabel(fig, el, manifests) : "—";
}

// --- part rows (manifest part tree, mapped under a plot element) ------------
interface PlotCtx { manifest: FluxPlotManifest; dom: globalThis.Element | null; state: OverrideState }
function plotCtx(el: SemanticElement, manifests: Record<string, FluxPlotManifest>, doms?: PlotDomOf): PlotCtx | undefined {
  if (el.type !== "plot") return undefined;
  const manifest = manifests[el.assetId];
  if (!manifest) return undefined;
  return { manifest, dom: doms?.(el.assetId) ?? null, state: overrideState(manifest, el.overrides as Record<string, Record<string, unknown>> | undefined) };
}
/** Is a plot part drawn hidden — every leaf it covers hidden by the rendering rule? */
function drawnHidden(pc: PlotCtx, partId: string): boolean {
  if (!pc.state.hiddenLeaf.size) return false;
  const leaves = resolveTargets(pc.manifest, partId);
  return leaves.length > 0 && leaves.every((l) => pc.state.hiddenLeaf.get(l));
}
/** Context + state for a plot part row. `leaves` = the drawn leaves the row
 *  controls; `ancestorHides` = some ancestor's OWN flag hides it. */
function withContext(row: XRow, partId: string, leaves: readonly string[], pc: PlotCtx | undefined, ancestorHides: boolean): XRow {
  if (!pc) return row;
  const c = partContext(pc.manifest, partId, pc.dom);
  if (c.path.length) row.path = c.path;
  if (c.preview) row.preview = c.preview;
  if (c.swatch) row.swatch = c.swatch;
  if (c.axis) row.axis = c.axis;
  if (pc.state.styled.has(partId)) row.styled = true;
  if (pc.state.styledBeneath.has(partId)) row.styledBeneath = true;
  // Visibility as DRAWN (the rendering rule): all leaves hidden → hidden; some → partial.
  if (pc.state.hiddenLeaf.size && leaves.length) {
    let n = 0;
    for (const l of leaves) if (pc.state.hiddenLeaf.get(l)) n++;
    row.hidden = n === leaves.length;
    if (n && n < leaves.length) { row.hiddenBeneath = true; row.hiddenParts = n; }
    if (row.hidden && ancestorHides && !pc.state.ownHidden.has(partId)) row.inheritedHidden = true;
  }
  return row;
}
function partRow(el: SemanticElement, n: XrayNode, models: Models = {}, index?: Scene3dPartIndex, pc?: PlotCtx, inherited = false): XRow {
  const row: XRow = {
    id: partRowId(el.id, n.id),
    kind: "part",
    label: n.label,
    role: n.role,
    elementId: el.id,
    partId: n.id,
    hidden: el.type === "model3d" ? Boolean(resolveScene3dPartStyle(models[el.assetId], el.overrides, n.id, {index}).hidden) : Boolean(el.overrides?.[n.id]?.hidden),
    isGroup: n.isGroup,
    count: n.targets.length > 1 ? n.targets.length : undefined,
    children: [],
  };
  withContext(row, n.id, n.targets, pc, inherited);
  const below = inherited || !!pc?.state.ownHidden.has(n.id);
  row.children = n.children.map((c) => partRow(el, c, models, index, pc, below));
  // A group's MEMBERS (one tick label, one point …) are rows of their own under it,
  // so a single drilled member can be revealed and picked (and its family is one ←).
  if (pc && !n.children.length && n.isGroup) {
    const members = partContext(pc.manifest, n.id, pc.dom).members ?? [];
    for (const m of members) row.children.push(memberRow(el, m, pc, below));
  }
  return row;
}
const MEMBER_ROLE_MEMO = new WeakMap<FluxPlotManifest, Map<string, string>>();
/** member id → its role (the group's memberRole, else the id grammar) — buildPartIndex's rule. */
function memberRole(manifest: FluxPlotManifest, id: string): string {
  let m = MEMBER_ROLE_MEMO.get(manifest);
  if (!m) {
    m = new Map();
    const walk = (n: { members?: string[]; memberRole?: string | null; children?: unknown[] }) => {
      for (const id of n.members ?? []) if (!m!.has(id)) m!.set(id, n.memberRole ?? inferRole(id));
      for (const c of (n.children ?? []) as typeof n[]) walk(c);
    };
    if (manifest.parts) walk(manifest.parts as never);
    MEMBER_ROLE_MEMO.set(manifest, m);
  }
  return m.get(id) ?? inferRole(id);
}
function memberRow(el: SemanticElement, id: string, pc: PlotCtx, inherited: boolean): XRow {
  const role = memberRole(pc.manifest, id);
  const row: XRow = {
    id: partRowId(el.id, id),
    kind: "part",
    label: labelForPart({ id, role }),
    role,
    elementId: el.id,
    partId: id,
    hidden: Boolean(el.overrides?.[id]?.hidden),
    isGroup: false,
    member: true,
    children: [],
  };
  return withContext(row, id, [id], pc, inherited);
}

// --- element rows ------------------------------------------------------------
function elementRow(fig: Figure, el: Element, manifests: Record<string, FluxPlotManifest>, models: Models = {}, info: ModelInfo = {}, doms?: PlotDomOf): XRow {
  const row: XRow = {
    id: "el:" + el.id,
    kind: "element",
    label: elementLabel(fig, el, manifests),
    role: el.type === "plot" ? "figure" : el.type,
    elementId: el.id,
    hidden: Boolean(el.hidden),
    locked: Boolean(el.locked),
    isGroup: false,
    children: [],
  };
  if (el.type === "plot") {
    // Expand in place: this row IS the plot's figure root — the part tree's
    // root node is folded into the element row (no "plot → Figure" double
    // nesting); its children become part rows keyed by the owning element.
    const plot = el as SemanticPlotElement;
    const tree = buildPartTree(manifests[plot.assetId]);
    if (tree) {
      const pc = plotCtx(plot, manifests, doms);
      row.children = tree.children.map((c) => partRow(plot, c, {}, undefined, pc, !!el.hidden));
      row.isGroup = true;
      const hint = pc ? plotHint(pc.manifest, pc.dom) : undefined;
      if (hint) row.preview = hint;
      if (pc?.state.styled.size) row.styledBeneath = true;
      if (pc && [...pc.state.hiddenLeaf.values()].some(Boolean)) row.hiddenBeneath = true;
    }
  }
  if (el.type === "model3d") {
    const tree = buildModel3dTree(models[el.assetId], info[el.assetId]);
    const index = models[el.assetId] ? buildScene3dPartIndex(models[el.assetId]) : undefined;
    row.children = tree.children.map(c => partRow(el, c, models, index)); row.isGroup = row.children.length > 0;
  }
  return row;
}

/** Side by side, plots are told apart by what their labels do NOT share (and
 *  copies of one plot by an ordinal). Applies to the plot rows among `rows`. */
function markPlotKeys(rows: XRow[]): void {
  const plots = rows.filter((r) => r.kind === "element" && (r.role === "figure" || r.role === "model3d"));
  if (plots.length < 2) return;
  const split = distinctiveParts(plots.map((r) => r.label));
  plots.forEach((r, i) => { if (split[i].prefix || split[i].ordinal) r.keyParts = split[i]; });
}

// --- group rows ---------------------------------------------------------------
function findGroupNode(nodes: RenderNode[], gid: Id): Extract<RenderNode, { kind: "group" }> | null {
  for (const n of nodes) {
    if (n.kind !== "group") continue;
    if (n.def.id === gid) return n;
    const inner = findGroupNode(n.children, gid);
    if (inner) return inner;
  }
  return null;
}

function mapRenderChildren(
  fig: Figure,
  nodes: RenderNode[],
  manifests: Record<string, FluxPlotManifest>,
  models: Models = {}, info: ModelInfo = {}, doms?: PlotDomOf,
): XRow[] {
  const out: XRow[] = [];
  // Top-z first (reverse of fig.elements order) — matches the Sidebar layers.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === "element") out.push(elementRow(fig, n.el, manifests, models, info, doms));
    else out.push(groupRow(fig, n, manifests, models, info, doms));
  }
  return out;
}

function groupRow(
  fig: Figure,
  node: Extract<RenderNode, { kind: "group" }>,
  manifests: Record<string, FluxPlotManifest>,
  models: Models = {}, info: ModelInfo = {}, doms?: PlotDomOf,
): XRow {
  const members = membersDeep(fig, node.def.id);
  const row: XRow = {
    id: "grp:" + node.def.id,
    kind: "group",
    label: node.def.name,
    role: "group",
    groupId: node.def.id,
    hidden: Boolean(node.def.hidden),
    locked: Boolean(node.def.locked),
    isGroup: true,
    count: members.length,
    children: mapRenderChildren(fig, node.children, manifests, models, info, doms),
  };
  markPlotKeys(row.children);
  return row;
}

// --- multi-plot roots: the plots side by side + the parts they share -------
/** Part ids present in EVERY given plot's manifest tree (id AND role must
 *  agree — ids are deterministic per generator, so equal-recipe plots share
 *  them exactly; a coincidental id with a different role is not "common").
 *  Order follows the first plot's tree (depth-first), and containers are kept
 *  so hiding "X axis" everywhere is one row. */
export function commonPartIds(
  plots: SemanticElement[],
  manifests: Record<string, FluxPlotManifest>,
  models: Models = {}, info: ModelInfo = {},
): { id: string; label: string; role: string; isGroup: boolean }[] {
  if (plots.length < 2) return [];
  const trees = plots.map((pl) => pl.type === "model3d" ? buildModel3dTree(models[pl.assetId], info[pl.assetId]) : buildPartTree(manifests[pl.assetId]));
  if (trees.some((t) => !t)) return [];
  const index = (root: XrayNode) => {
    const m = new Map<string, XrayNode>();
    const walk = (n: XrayNode) => {
      for (const c of n.children) {
        m.set(c.id, c);
        walk(c);
      }
    };
    walk(root);
    return m;
  };
  const maps = trees.map((t) => index(t!));
  const out: { id: string; label: string; role: string; isGroup: boolean }[] = [];
  for (const [id, n] of maps[0]) {
    if (maps.every((m) => m.get(id)?.role === n.role)) out.push({ id, label: n.label, role: n.role, isGroup: n.isGroup });
  }
  return out;
}

/** The `common:` rows for a multi-plot root: one row per shared part, flat
 *  (containers first-come, as the first plot's tree orders them), each carrying
 *  the plots it applies to and how many of them hide it. */
export function commonPartRows(
  plots: SemanticElement[],
  manifests: Record<string, FluxPlotManifest>,
  models: Models = {}, info: ModelInfo = {}, doms?: PlotDomOf,
): XRow[] {
  const indices = new Map(plots.filter(p => p.type === "model3d" && models[p.assetId]).map(p => [p.assetId, buildScene3dPartIndex(models[p.assetId])]));
  const ctxs = plots.map((pl) => plotCtx(pl, manifests, doms));
  return commonPartIds(plots, manifests, models, info).map((c) => {
    const ids = plots.map((pl) => pl.id);
    // As DRAWN on each plot (the rendering rule): a part hidden with its axis counts.
    const hiddenOn = (pl: SemanticElement, i: number) => pl.type === "model3d" ? Boolean(resolveScene3dPartStyle(models[pl.assetId], pl.overrides, c.id, {index:indices.get(pl.assetId)}).hidden)
      : ctxs[i] ? drawnHidden(ctxs[i]!, c.id) : Boolean(pl.overrides?.[c.id]?.hidden);
    const hiddenCount = plots.filter(hiddenOn).length;
    const row: XRow = {
      id: "common:" + c.id,
      kind: "common",
      label: c.label,
      role: c.role,
      partId: c.id,
      elementIds: ids,
      hidden: hiddenCount === ids.length,
      hiddenCount,
      isGroup: false,
      count: ids.length,
      children: [],
    };
    // Context from the plots themselves: the path (equal-id parts share it), the
    // value when every plot shows the same one, else "varies" (y ranges differ).
    if (ctxs.every(Boolean)) {
      const each = ctxs.map((pc) => partContext(pc!.manifest, c.id, pc!.dom));
      if (each[0].path.length) row.path = each[0].path;
      if (each[0].axis) row.axis = each[0].axis;
      const previews = each.map((x) => x.preview ?? "");
      if (previews.some(Boolean)) row.preview = previews.every((v) => v === previews[0]) ? previews[0] : "varies";
      if (each[0].swatch && each.every((x) => x.swatch === each[0].swatch)) row.swatch = each[0].swatch;
      if (ctxs.some((pc) => pc!.state.styled.has(c.id))) row.styled = true;
      if (ctxs.some((pc) => pc!.state.styledBeneath.has(c.id))) row.styledBeneath = true;
      // hidden everywhere, but by an ancestor's flag on every plot (not its own)
      if (row.hidden && ctxs.every((pc) => !pc!.state.ownHidden.has(c.id))) row.inheritedHidden = true;
    }
    return row;
  });
}

/** The flat common rows nested as the FIRST plot's tree nests them (X axis ›
 *  Spine / Tick marks / Tick labels), for display: a shared list of 40+ parts
 *  reads as a tree, not a wall of "Line ×5". Scaffolding (figure, plot area)
 *  stays a row of its own but holds nothing: what sits in it is top-level.
 *  Rows are copied (the flat list stays the search/selection source). */
export function nestCommonRows(flat: XRow[], manifest: FluxPlotManifest | undefined): XRow[] {
  if (!manifest || !flat.length) return flat;
  const index = manifestIndex(manifest);
  const byPart = new Map(flat.map((r) => [r.partId!, { ...r, children: [] as XRow[] }]));
  const top: XRow[] = [];
  for (const r of flat) {
    const node = byPart.get(r.partId!)!;
    let up = index.entries.get(r.partId!)?.parent ?? null, home: XRow | undefined;
    while (up) {
      const e = index.entries.get(up);
      if (e && !SCAFFOLD_ROLES.has(e.role) && byPart.has(up)) { home = byPart.get(up); break; }
      up = e?.parent ?? null;
    }
    if (home) { home.children.push(node); home.isGroup = true; } else top.push(node);
  }
  return top;
}
const SCAFFOLD_ROLES = new Set(["figure", "plot-area"]); // = rowContext SCAFFOLD

/** Build the unified X-ray tree for a target, or null when the target no
 *  longer resolves (deleted element / dissolved group / gone figure). */
export function buildXrayTree(
  p: Project,
  target: XrayTarget | null,
  manifests: Record<string, FluxPlotManifest>,
  models: Models = {},
  doms?: PlotDomOf,
): XRow | null {
  const info: ModelInfo = Object.fromEntries(p.assets.filter(a => a.model).map(a => [a.id, a.model!]));
  if (!target) return null;
  const fig = figOf(p, target.figId);
  if (!fig) return null;
  if (target.kind === "element") {
    const el = fig.elements.find((e) => e.id === target.elementId);
    return el ? elementRow(fig, el, manifests, models, info, doms) : null;
  }
  if (target.kind === "elements") {
    const els = target.elementIds
      .map((id) => fig.elements.find((e) => e.id === id))
      .filter((e): e is Element => !!e);
    if (!els.length) return null;
    if (els.length === 1) return elementRow(fig, els[0], manifests, models, info, doms);
    // Top-z first, like every other multi-row listing.
    const ordered = [...els].sort((a, b) => fig.elements.indexOf(b) - fig.elements.indexOf(a));
    const set: XRow = {
      id: "set:" + fig.id,
      kind: "set",
      label: `${els.length} ${els.every(e => e.type === "model3d") ? "models" : els.every(e => e.type === "plot") ? "plots" : "objects"}`,
      role: "set",
      hidden: els.every((el) => !!el.hidden),
      isGroup: true,
      count: els.length,
      children: ordered.map((e) => elementRow(fig, e, manifests, models, info, doms)),
    };
    markPlotKeys(set.children);
    return set;
  }
  if (!groupDefs(fig)[target.groupId]) return null;
  const node = findGroupNode(buildRenderTree(fig), target.groupId);
  return node ? groupRow(fig, node, manifests, models, info, doms) : null;
}

/** The minimal shape the sibling rule reads: X-ray rows and plot part-tree nodes both fit. */
export interface SiblingNode { id: string; role: string; label: string; kind: string; children: readonly SiblingNode[] }

/** The parent of every row id in a tree (common rows are top-level: no parent). */
export function rowParents<T extends SiblingNode>(t: T | null): Map<string, T> {
  const out = new Map<string, T>();
  const walk = (n: T) => { for (const c of n.children as readonly T[]) { out.set(c.id, n); walk(c); } };
  if (t) walk(t);
  return out;
}

/** The `a` rule — widen a pick to its siblings, shared by the X-ray and the
 *  Slide Become picker. First press: the SAME row (role + label + kind) under
 *  each sibling of the parent (X axis › Tick marks → Y axis › Tick marks too),
 *  so one key reaches the counterpart parts. When that adds nothing (already
 *  there, or no counterparts), the press takes every row under the same parent
 *  instead. Returns the widened id set (the pick included), or null when
 *  nothing would be added. Pure: rows in, ids out. */
export function widenToSiblings<T extends SiblingNode>(tree: T | null, picked: readonly T[], parents: Map<string, T> = rowParents(tree)): Set<string> | null {
  if (!picked.length) return null;
  const have = new Set(picked.map((n) => n.id));
  const counterparts = new Set(have);
  for (const n of picked) {
    const p = parents.get(n.id), g = p && parents.get(p.id);
    for (const aunt of g?.children ?? []) for (const c of aunt.children) if (c.role === n.role && c.label === n.label && c.kind === n.kind) counterparts.add(c.id);
  }
  let next = counterparts;
  if (next.size === have.size) {
    next = new Set(have);
    for (const n of picked) for (const c of parents.get(n.id)?.children ?? []) next.add(c.id);
  }
  return next.size === have.size ? null : next;
}
