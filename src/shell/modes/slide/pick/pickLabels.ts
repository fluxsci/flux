// Names for picked units: the chip words ("6 points · W1", "2 ellipses") and
// the hover readout's label, which is exactly the lane's (`refLabel`). Pure:
// slide + manifests in, words out (pinned by `verify-become-picker.ts`).

import type { FluxPlotManifest } from "../../../../lib/plot/types";
import { partIndexOf } from "./stageHit";
import { buildPartTree, type XrayNode } from "../../../../lib/plot/tree";

const GENERIC = new Set(["part", "group", "container"]);
const homes = new WeakMap<FluxPlotManifest, Map<string, { node: XrayNode; series?: XrayNode }>>();
/** The deepest part-tree node holding a leaf, and its nearest series ancestor. */
function partHome(manifest: FluxPlotManifest | undefined, leaf: string): { node: XrayNode; series?: XrayNode } | undefined {
  if (!manifest) return undefined;
  let m = homes.get(manifest);
  if (!m) {
    m = new Map();
    const walk = (n: XrayNode, series?: XrayNode) => {
      const s2 = n.role === "series" ? n : series;
      for (const t of n.targets) m!.set(t, { node: n, series: s2 }); // deeper nodes overwrite
      if (n.id) m!.set(n.id, { node: n, series: s2 });
      n.children.forEach((c) => walk(c, s2));
    };
    const root = buildPartTree(manifest);
    if (root) walk(root);
    homes.set(manifest, m);
  }
  return m.get(leaf);
}
import type { PickUnit, UnitDescription } from "./pickModel";

interface SlideLike { elements: readonly { id: string; type: string; assetId?: string }[] }

export interface LabelContext {
  slide: SlideLike;
  manifestFor: (elementId: string) => FluxPlotManifest | undefined;
  /** `animator/shared.ts refLabel` bound to the slide. */
  refLabel: (ref: { element: string; parts?: string[]; group?: string }) => string;
}

const TYPE_WORD: Record<string, string> = { model3d: "model", rect: "rect", ellipse: "ellipse", line: "line", path: "path", text: "text", plot: "plot", image: "image", video: "clip" };

export function unitRef(u: PickUnit): { element: string; parts?: string[]; group?: string } {
  return u.group ? { element: u.element, group: u.group } : u.part ? { element: u.element, parts: [u.part] } : { element: u.element };
}

export function describeUnit(u: PickUnit, ctx: LabelContext): UnitDescription {
  const label = ctx.refLabel(unitRef(u));
  if (u.group) return { kind: "group", owner: "", label };
  const el = ctx.slide.elements.find((e) => e.id === u.element);
  if (!u.part) return { kind: TYPE_WORD[el?.type ?? ""] ?? "object", owner: "", label };
  const manifest = ctx.manifestFor(u.element);
  const idx = partIndexOf(manifest);
  const info = idx[u.part] as { role?: string; series?: string } | undefined;
  const home = partHome(manifest, u.part);
  // A group member's own index role is generic ("part"): the group names it (a cap of "caps").
  const role = info?.role && !GENERIC.has(info.role) ? info.role : home && !GENERIC.has(home.node.role) ? home.node.role : info?.role ?? "part";
  const seriesNode = info?.series ? (idx[info.series] as { label?: string } | undefined) : home?.series;
  const series = seriesNode?.label?.replace(/^Series:\s*/, "");
  const own = label.includes(" › ") ? label.slice(label.lastIndexOf(" › ") + 3) : label;
  return { kind: role.replace(/-/g, " "), owner: u.element, context: series, label, chip: series && !own.includes(series) ? `${own} · ${series}` : own };
}
