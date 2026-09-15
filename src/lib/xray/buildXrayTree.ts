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
import { buildPartTree, type XrayNode } from "../plot/tree";
import { buildRenderTree, groupDefs, membersDeep, type RenderNode } from "../groups";

/** What the X-ray is rooted on (store.xrayRoot). `elements` (2026-09-15) is
 *  a MULTI-PLOT root: several plots x-rayed together, each expanding under a
 *  synthetic "N plots" row, plus the COMMON part rows they share (below). */
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
}

function figOf(p: Project, figId: Id): Figure | null {
  return p.figures.find((f) => f.id === figId) ?? null;
}

function baseName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const b = path.split(/[\\/]/).pop() ?? path;
  const stem = b.replace(/\.svg$/i, "");
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
    return `${n} plots`;
  }
  const el = fig.elements.find((e) => e.id === target.elementId);
  return el ? elementLabel(fig, el, manifests) : "—";
}

// --- part rows (manifest part tree, mapped under a plot element) ------------
function partRow(el: SemanticPlotElement, n: XrayNode): XRow {
  return {
    id: `part:${el.id}__${n.id}`,
    kind: "part",
    label: n.label,
    role: n.role,
    elementId: el.id,
    partId: n.id,
    hidden: Boolean(el.overrides?.[n.id]?.hidden),
    isGroup: n.isGroup,
    count: n.targets.length > 1 ? n.targets.length : undefined,
    children: n.children.map((c) => partRow(el, c)),
  };
}

// --- element rows ------------------------------------------------------------
function elementRow(fig: Figure, el: Element, manifests: Record<string, FluxPlotManifest>): XRow {
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
      row.children = tree.children.map((c) => partRow(plot, c));
      row.isGroup = true;
    }
  }
  return row;
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
): XRow[] {
  const out: XRow[] = [];
  // Top-z first (reverse of fig.elements order) — matches the Sidebar layers.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === "element") out.push(elementRow(fig, n.el, manifests));
    else out.push(groupRow(fig, n, manifests));
  }
  return out;
}

function groupRow(
  fig: Figure,
  node: Extract<RenderNode, { kind: "group" }>,
  manifests: Record<string, FluxPlotManifest>,
): XRow {
  const members = membersDeep(fig, node.def.id);
  return {
    id: "grp:" + node.def.id,
    kind: "group",
    label: node.def.name,
    role: "group",
    groupId: node.def.id,
    hidden: Boolean(node.def.hidden),
    locked: Boolean(node.def.locked),
    isGroup: true,
    count: members.length,
    children: mapRenderChildren(fig, node.children, manifests),
  };
}

// --- multi-plot roots: the plots side by side + the parts they share -------
/** Part ids present in EVERY given plot's manifest tree (id AND role must
 *  agree — ids are deterministic per generator, so equal-recipe plots share
 *  them exactly; a coincidental id with a different role is not "common").
 *  Order follows the first plot's tree (depth-first), and containers are kept
 *  so hiding "X axis" everywhere is one row. */
export function commonPartIds(
  plots: SemanticPlotElement[],
  manifests: Record<string, FluxPlotManifest>,
): { id: string; label: string; role: string; isGroup: boolean }[] {
  if (plots.length < 2) return [];
  const trees = plots.map((pl) => buildPartTree(manifests[pl.assetId]));
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
  plots: SemanticPlotElement[],
  manifests: Record<string, FluxPlotManifest>,
): XRow[] {
  return commonPartIds(plots, manifests).map((c) => {
    const ids = plots.map((pl) => pl.id);
    const hiddenCount = plots.filter((pl) => Boolean(pl.overrides?.[c.id]?.hidden)).length;
    return {
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
  });
}

/** Build the unified X-ray tree for a target, or null when the target no
 *  longer resolves (deleted element / dissolved group / gone figure). */
export function buildXrayTree(
  p: Project,
  target: XrayTarget | null,
  manifests: Record<string, FluxPlotManifest>,
): XRow | null {
  if (!target) return null;
  const fig = figOf(p, target.figId);
  if (!fig) return null;
  if (target.kind === "element") {
    const el = fig.elements.find((e) => e.id === target.elementId);
    return el ? elementRow(fig, el, manifests) : null;
  }
  if (target.kind === "elements") {
    const els = target.elementIds
      .map((id) => fig.elements.find((e) => e.id === id))
      .filter((e): e is Element => !!e);
    if (!els.length) return null;
    if (els.length === 1) return elementRow(fig, els[0], manifests);
    // Top-z first, like every other multi-row listing.
    const ordered = [...els].sort((a, b) => fig.elements.indexOf(b) - fig.elements.indexOf(a));
    return {
      id: "set:" + fig.id,
      kind: "set",
      label: `${els.length} plots`,
      role: "set",
      isGroup: true,
      count: els.length,
      children: ordered.map((e) => elementRow(fig, e, manifests)),
    };
  }
  if (!groupDefs(fig)[target.groupId]) return null;
  const node = findGroupNode(buildRenderTree(fig), target.groupId);
  return node ? groupRow(fig, node, manifests) : null;
}
