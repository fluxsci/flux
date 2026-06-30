// Build the navigable parts tree (for the Plot X-Ray) and resolve a node id to
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

// A node rendered in the X-Ray tree.
export interface XrayNode {
  id: string; // the addressable key (override is stored under this)
  role: string;
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

function indexTree(root: PartNode | undefined): Map<string, PartNode> {
  const m = new Map<string, PartNode>();
  const walk = (n: PartNode) => {
    const k = key(n);
    if (k && !m.has(k)) m.set(k, n);
    for (const c of n.children ?? []) walk(c);
  };
  if (root) walk(root);
  return m;
}

/** The concrete leaf ids an override key controls. Group/container → its leaves; leaf → itself. */
export function resolveTargets(manifest: FluxPlotManifest | undefined, key_: string): string[] {
  const tree = manifest?.parts as PartNode | undefined;
  if (!tree) return [key_];
  const node = indexTree(tree).get(key_);
  if (!node) return [key_]; // a literal leaf id not present in the tree
  if (node.role === "group" || (node.children && node.children.length)) return leavesUnder(node);
  return [key_];
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
};

function inferRole(id: string): string {
  if (/\.point\.\d+$/.test(id)) return "point";
  if (/\.bar\.\d+$/.test(id)) return "bar";
  if (/\.gridline\.\d+$/.test(id)) return "gridline";
  if (/\.tick\.\d+$/.test(id)) return "tick";
  if (/\.ticklabel\.\d+$/.test(id)) return "tick-label";
  if (/\.title$/.test(id)) return id.startsWith("axis.") ? "axis-title" : "title";
  if (id.startsWith("subtitle")) return "subtitle";
  if (/\.spine(-\d+)?$/.test(id)) return "spine";
  if (/\.line$/.test(id)) return "line";
  if (/\.area$/.test(id)) return "area";
  if (/\.errorbar$/.test(id)) return "errorbar";
  if (/\.swatch$/.test(id)) return "legend-swatch";
  if (/\.label$/.test(id)) return "legend-label";
  if (id.startsWith("significance-bracket")) return "significance-bracket";
  if (id.startsWith("reference-line")) return "reference-line";
  if (id.startsWith("annotation")) return "annotation";
  // custom plot kinds tag their drawn part `{series}.x-<kind>` (violin, heatmap-cell, …)
  const seg = id.split(".").pop() ?? "";
  if (seg.startsWith("x-")) return seg;
  return "part";
}

const LEAF_LABEL: Record<string, string> = {
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
  const id = key(node) ?? "";
  switch (role) {
    case "figure":
      return "Figure";
    case "plot-area":
      return "Plot area";
    case "axis":
      return (node.axis === "y" ? "Y" : "X") + " axis";
    case "legend":
      return "Legend";
    case "legend-entry":
      return "Entry " + lastIndex(id);
    case "series":
      return "Series: " + (node.id ?? "");
    case "group":
      return GROUP_LABEL[node.groupRole ?? ""] ?? node.groupRole ?? "Group";
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

/** Build the X-Ray tree from a manifest, or null if it has no parts tree (pre-0.2.0). */
export function buildPartTree(manifest: FluxPlotManifest | undefined): XrayNode | null {
  const root = manifest?.parts as PartNode | undefined;
  if (!root || !root.role) return null;

  const toXray = (n: PartNode): XrayNode => {
    const id = key(n) ?? "";
    const role = n.role ?? inferRole(id);
    const childNodes = (n.children ?? []).map(toXray);
    const isGroup = role === "group" || childNodes.length > 0;
    return {
      id,
      role: role === "group" ? n.groupRole ?? "group" : role,
      label: labelFor(n, role),
      axis: n.axis,
      isGroup,
      targets: leavesUnder(n),
      children: childNodes,
    };
  };
  return toXray(root);
}
