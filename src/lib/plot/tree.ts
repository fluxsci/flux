// Build the navigable parts tree (for the X-Ray) and resolve a node id to
// the concrete leaf semantic ids it controls.
//
// FluxPlot >=0.2.0 emits a `parts` tree of container nodes ({id|ref, role,
// children}) and group nodes ({id, role:"group", groupRole, members[]}). A
// group/container is addressed by ONE id (e.g. "axis.x.tick-labels" or
// "axis.x"); an override keyed by that id is re-resolved to its current leaf
// members every mount, so "hide all x ticks" survives regeneration.

import type { FluxPlotManifest, PartNode } from "./types";

// PartNode (the raw manifest scene-graph node) now lives in ./types alongside the
// manifest it belongs to, and is re-exported here for existing importers.
export type { PartNode };

/** A part's kind: what its editors and its reveal animation may assume about it. */
export type PartKind = "text" | "line" | "shape" | "container";

/** The ONE role → kind fallback (colour-system plan F2). A manifest node's own `kind` wins
 *  wherever it exists (fluxplot ≥ 0.3.1 writes one on every parts-tree node and `memberRole`
 *  on groups); this table answers for older manifests, id-inferred roles and role refs. Roles
 *  it does not name are shapes unless the DOM says otherwise (partStyle.partKind). */
export const KIND_BY_ROLE: Record<string, PartKind> = {
  "axis-title": "text", title: "text", subtitle: "text", "tick-label": "text", "legend-label": "text", label: "text",
  annotation: "text", "colorbar-label": "text", "colorbar-tick-label": "text",
  line: "line", "reference-line": "line", gridline: "line", spine: "line", errorbar: "line", tick: "line", axis: "line",
  "significance-bracket": "line", "colorbar-tick": "line", "colorbar-outline": "line",
  series: "container", "plot-area": "container", figure: "container", legend: "container", "legend-entry": "container",
  "axis-group": "container", "axes-group": "container", "field-group": "container",
};
export const KNOWN_KINDS = new Set<string>(["text", "line", "shape", "container"]);
export function kindForRole(role: string): PartKind {
  return KIND_BY_ROLE[role] ?? "shape";
}
/** A node's kind: the manifest's, else the role table's. */
export function kindOfNode(node: { kind?: string | null } | undefined, role: string): PartKind {
  return node?.kind && KNOWN_KINDS.has(node.kind) ? (node.kind as PartKind) : kindForRole(role);
}

// A node rendered in the X-Ray tree.
export interface XrayNode {
  id: string; // the addressable key (override is stored under this)
  role: string;
  /** text | line | shape | container — the manifest's kind, else the role table's. */
  kind: PartKind;
  label: string;
  axis?: string;
  isGroup: boolean; // group or container (controls a subtree)
  targets: string[]; // concrete leaf semantic ids this node styles/hides
  children: XrayNode[];
}

function key(n: PartNode): string | undefined {
  return n.id ?? n.ref;
}

/** All concrete leaf semantic ids beneath a manifest node (members, or recursing children). */
export function leavesUnder(n: PartNode): string[] {
  if (n.members && n.members.length) return n.members.slice();
  if (n.children && n.children.length) return n.children.flatMap(leavesUnder);
  const k = key(n);
  return k ? [k] : [];
}

const treeIndexMemo = new WeakMap<PartNode, Map<string, PartNode>>();
/** id → node over a parts tree, memoised per tree object (resolveTargets runs per
 *  override key on every mount and every Slide frame). */
function indexTree(root: PartNode | undefined): Map<string, PartNode> {
  if (root) { const hit = treeIndexMemo.get(root); if (hit) return hit; }
  const m = new Map<string, PartNode>();
  const walk = (n: PartNode) => {
    const k = key(n);
    if (k && !m.has(k)) m.set(k, n);
    for (const c of n.children ?? []) walk(c);
  };
  if (root) { walk(root); treeIndexMemo.set(root, m); }
  return m;
}

const depthMemo = new WeakMap<PartNode, Map<string, number>>();
/** How SPECIFIC an override key is: its depth in the parts tree (a group's
 *  member one deeper than the group). Keys the tree does not name are leaves
 *  — the most specific of all. */
export function partDepth(manifest: FluxPlotManifest | undefined, id: string): number {
  const root = manifest?.parts as PartNode | undefined;
  if (!root) return 0;
  let m = depthMemo.get(root);
  if (!m) {
    const depths = new Map<string, number>();
    const walk = (n: PartNode, d: number) => {
      const k = key(n);
      if (k && !depths.has(k)) depths.set(k, d);
      for (const mem of n.members ?? []) if (!depths.has(mem)) depths.set(mem, d + 1);
      for (const c of n.children ?? []) walk(c, d + 1);
    };
    walk(root, 0);
    depthMemo.set(root, depths);
    m = depths;
  }
  return m.get(aliasPartId(manifest, id)) ?? Number.MAX_SAFE_INTEGER;
}

/** Which leaves the element's overrides hide or show: THE one rule, shared by
 *  rendering (applyOverrides) and the X-ray's eyes. The MOST SPECIFIC hidden
 *  flag wins — a member over its group, a group over its axis — and among keys
 *  equally specific, the later one. So "hide the tick labels, show tick label
 *  3" draws tick label 3, whatever order the keys were written in. */
export function hiddenLeaves(manifest: FluxPlotManifest | undefined, overrides: Record<string, { hidden?: boolean | null } | undefined> | undefined): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!overrides) return out;
  const keys = Object.keys(overrides).filter((k) => overrides[k]?.hidden != null);
  if (!keys.length) return out;
  const ranked = keys.map((k, i) => ({ k, i, d: partDepth(manifest, k) })).sort((a, b) => a.d - b.d || a.i - b.i);
  for (const { k } of ranked) {
    const h = !!overrides[k]!.hidden;
    for (const leaf of resolveTargets(manifest, k)) out.set(leaf, h);
  }
  return out;
}

/** The current id for a part id an OLDER fluxplot emitted (colour-system plan C7). fluxplot
 *  0.3.2 renamed spines (`axis.x.spine` → `axis.x.spine.bottom`) and re-slugged some series
 *  roots; `manifest.idAliases` maps each old id — or an old series root standing for every id
 *  under it — to the new one, panel-prefixed on both sides. Exact match first, then the longest
 *  prefix key followed by a dot; an id no alias covers is returned as is. The alias table is
 *  read from the manifest each call (it is small) so a regenerated manifest is honoured. */
export function aliasPartId(manifest: FluxPlotManifest | undefined, id: string): string {
  const aliases = (manifest as { idAliases?: Record<string, string> } | undefined)?.idAliases;
  if (!aliases || !id) return id;
  const exact = aliases[id];
  if (exact) return exact;
  // an id that already IS (or sits under) a current alias target is current: a leaf alias's
  // target (`axis.x.spine.bottom`) must not be re-aliased through its own old prefix
  for (const target of Object.values(aliases)) if (id === target || id.startsWith(target + ".")) return id;
  let best: string | null = null;
  for (const key of Object.keys(aliases)) if (id.startsWith(key + ".") && (best === null || key.length > best.length)) best = key;
  return best === null ? id : aliases[best] + id.slice(best.length);
}

/** The concrete leaf ids an override key controls. Group/container → its leaves; leaf → itself.
 *  A key saved under an id an older fluxplot emitted is resolved through `idAliases` first. */
export function resolveTargets(manifest: FluxPlotManifest | undefined, key_: string): string[] {
  const aliased = aliasPartId(manifest, key_);
  const tree = manifest?.parts as PartNode | undefined;
  if (!tree) return [aliased];
  const node = indexTree(tree).get(aliased);
  if (!node) return [aliased]; // a literal leaf id not present in the tree
  if (node.role === "group" || (node.children && node.children.length)) return leavesUnder(node);
  return [aliased];
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------
function lastIndex(id: string): string {
  const m = id.match(/(\d+)$/);
  return m ? m[1] : "";
}

const GROUP_LABEL: Record<string, string> = {
  tick: "Tick marks",
  "tick-label": "Tick labels",
  gridline: "Gridlines",
  point: "Points",
  bar: "Bars",
  // statistics marks fluxplot groups per series (box plots, error bars, means)
  errorbar: "Error bars",
  cap: "Caps",
  median: "Medians",
  mean: "Means",
  whisker: "Whiskers",
  flier: "Fliers",
  area: "Areas",
  line: "Lines",
  segment: "Segments",
  region: "Regions",
  // fluxplot's sweep of untagged-but-real artists (whiskers, glow layers, …)
  extra: "Extras",
  // Flux's own orphan defense — SVG content NO part covers (generator gaps)
  unclassified: "Unclassified",
};

/** Best-effort role from a semantic id's shape (fluxplot's deterministic id
 *  grammar). Used for ids that appear only as group MEMBERS in the manifest
 *  (ticklabels, gridlines, points…) — they carry no PartNode of their own. */
export function inferRole(id: string): string {
  if (/\.point\.\d+$/.test(id)) return "point";
  if (/\.bar\.\d+$/.test(id)) return "bar";
  if (/\.gridline\.\d+$/.test(id)) return "gridline";
  if (/\.tick\.\d+$/.test(id)) return "tick";
  if (/\.ticklabel\.\d+$/.test(id)) return "tick-label";
  if (/\.title$/.test(id)) return /(^|\.)axis\.[xyz]\.title$/.test(id) ? "axis-title" : "title";
  if (id.startsWith("subtitle")) return "subtitle";
  if (/\.spine(-\d+)?$/.test(id)) return "spine";
  if (/\.line$/.test(id)) return "line";
  if (/\.area$/.test(id)) return "area";
  if (/\.errorbar$/.test(id)) return "errorbar";
  if (/\.swatch$/.test(id)) return "legend-swatch";
  if (/\.label$/.test(id) && !/(^|\.)colorbar\./.test(id)) return "legend-label";
  if (id.startsWith("significance-bracket")) return "significance-bracket";
  if (id.startsWith("reference-line")) return "reference-line";
  if (id.startsWith("annotation")) return "annotation";
  if (/\.cell\.\d+\.\d+$/.test(id)) return "cell";
  if (/\.level\.\d+$/.test(id)) return "contour-level";
  if (/(^|\.)colorbar\./.test(id)) {
    if (/\.tick-label\.\d+$/.test(id)) return "colorbar-tick-label";
    if (/\.tick\.\d+$/.test(id)) return "colorbar-tick";
    for (const role of ["solids", "outline", "label"]) if (id.endsWith("." + role)) return "colorbar-" + role;
  }
  // custom plot kinds tag their drawn part `{series}.x-<kind>` (violin, heatmap-cell, …)
  const seg = id.split(".").pop() ?? "";
  if (seg.startsWith("x-")) return seg;
  return "part";
}

const LEAF_LABEL: Record<string, string> = {
  "colorbar-label": "Colorbar label",
  "colorbar-tick-label": "Colorbar tick label",
  "colorbar-tick": "Colorbar tick",
  "colorbar-outline": "Colorbar outline",
  "colorbar-solids": "Color ramp",
  "contour-level": "Contour level",
  line: "Line",
  area: "Area",
  errorbar: "Error bars",
  box: "Box",
  spine: "Spine",
  "axis-title": "Axis title",
  title: "Title",
  subtitle: "Subtitle",
  "tick-label": "Tick label",
  tick: "Tick",
  gridline: "Gridline",
  "legend-swatch": "Swatch",
  "legend-label": "Label",
  "reference-line": "Reference line",
  "significance-bracket": "Significance bracket",
  annotation: "Annotation",
};

function labelFor(node: PartNode, role: string): string {
  // A panel's authored label is its letter or slug ("a", "twin"): alone in a tree
  // row it reads as noise, so one word becomes "Panel a" (worded labels stand).
  if (role === "panel" && node.label && /^[\w-]+$/.test(node.label.trim())) return `Panel ${node.label.trim()}`;
  // Authored display label wins outright — DERIVED manifests (plot/derive.ts)
  // carry them ("X tick 3", "Text “hello”") so vanilla SVGs read friendly in
  // the X-ray instead of falling back to raw node ids.
  if (node.label) return node.label;
  const id = key(node) ?? "";
  switch (role) {
    case "figure":
      return "Figure";
    case "plot-area":
      return "Plot area";
    case "axis":
      return (node.axis ?? "x").toUpperCase() + " axis";
    case "legend":
      return "Legend";
    case "colorbar":
      return "Colorbar: " + id.split(".").at(-1);
    case "cell":
      return "Cell " + id.split(".").slice(-2).join(", ");
    case "legend-entry":
      return "Entry " + lastIndex(id);
    case "series":
      return "Series: " + (node.id ?? "");
    case "group": {
      const g = node.groupRole ?? "";
      if (GROUP_LABEL[g]) return GROUP_LABEL[g];
      // a custom kind's group (`x-contour`) reads as words, like its leaves
      if (g.startsWith("x-")) { const w = g.slice(2).replace(/-/g, " "); return w.charAt(0).toUpperCase() + w.slice(1); }
      return g || "Group";
    }
    case "point":
      return "Point #" + lastIndex(id);
    case "bar":
      return "Bar #" + lastIndex(id);
    default: {
      if (role.startsWith("x-")) {
        const w = role.slice(2).replace(/-/g, " ");
        return w.charAt(0).toUpperCase() + w.slice(1);
      }
      return LEAF_LABEL[role] ?? id ?? role;
    }
  }
}

/** Human label for one manifest node (or a synthesized `{id}` for a member
 *  leaf). Same labels the X-Ray tree shows; a trailing numeric index in the id
 *  is appended when the generic label lacks one ("Tick label 3"). Shared by
 *  buildPartIndex and partStyle.partBreadcrumb so names never drift. */
export function labelForPart(node: PartNode): string {
  if (node.label) return node.role === "panel" ? labelFor(node, "panel") : node.label; // authored labels are complete — no index suffix
  const id = key(node) ?? "";
  const role = node.role ?? inferRole(id);
  let label = labelFor(node, role);
  const ix = lastIndex(id);
  if (ix && !/\d/.test(label)) label = `${label} ${ix}`;
  return label;
}

/** Build the X-Ray tree from a manifest, or null if it has no parts tree (pre-0.2.0). */
export function buildPartTree(manifest: FluxPlotManifest | undefined): XrayNode | null {
  const root = manifest?.parts as PartNode | undefined;
  if (!root || !root.role) return null;

  const toXray = (n: PartNode): XrayNode => {
    const id = key(n) ?? "";
    const role = n.role ?? inferRole(id);
    const childNodes = (n.children ?? []).map(toXray);
    const isGroup = role === "group" || childNodes.length > 0;
    const shownRole = role === "group" ? n.groupRole ?? "group" : role;
    return {
      id,
      role: shownRole,
      kind: kindOfNode(n, isGroup && role !== "group" ? "container" : shownRole),
      label: labelFor(n, role),
      axis: n.axis,
      isGroup,
      targets: leavesUnder(n),
      children: childNodes,
    };
  };
  return toXray(root);
}
