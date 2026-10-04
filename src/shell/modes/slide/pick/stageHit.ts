// The Become picker's DOM half: what is under the pointer, and where a unit is
// on the stage. Hover walks the BROWSER hit node's ancestors — the annotate /
// readout path (§4 "One context/target vocabulary") — and never rescans the
// scene or a manifest per move: part indexes are built once per manifest
// identity (manifests are immutable; regeneration replaces them).

import type { Element as FigElement, Figure, SemanticPlotElement } from "../../../../lib/types";
import type { FluxPlotManifest } from "../../../../lib/plot/types";
import { partDomId } from "../../../../lib/plot/parse";
import { resolvePartId, isScaffoldPart } from "../../../../lib/plot/partStyle";
import { buildPartTree } from "../../../../lib/plot/tree";
import { membersDeep, topGroupOf } from "../../../../lib/groups";
import { isDataRole, type MarqueeCandidate, type PickUnit, type StageRect } from "./pickModel";
import { leafPartIds, partIndexOf } from "../../../../lib/plot/partMarquee";

export interface HitContext {
  fig: Figure;
  manifestFor: (el: SemanticPlotElement) => FluxPlotManifest | undefined;
  /** Hidden/unborn/stashed targets never pick. */
  excluded: (elementId: string, partId?: string) => boolean;
}

export { partIndexOf };

const nodeTargets = new WeakMap<FluxPlotManifest, Map<string, string[]>>();
/** A part id's concrete leaf ids (itself for a leaf). */
export function targetsOf(manifest: FluxPlotManifest, partId: string): string[] {
  let m = nodeTargets.get(manifest);
  if (!m) {
    m = new Map();
    const walk = (n: ReturnType<typeof buildPartTree>) => { if (!n) return; m!.set(n.id, n.targets); n.children.forEach(walk); };
    walk(buildPartTree(manifest));
    nodeTargets.set(manifest, m);
  }
  return m.get(partId) ?? [partId];
}

export interface Hit { unit: PickUnit; elementId: string }

/** The finest meaningful unit under a hit node: a plot's semantic leaf part
 *  (never scaffold — a background/plot-area/axis-container hit means the whole
 *  plot), a 3D model's furniture part, or the element itself (a group member
 *  stays the member). `wholeObject` (Alt) widens to the plot / top group. */
export function hitUnit(node: Element | null, ctx: HitContext, wholeObject = false): Hit | null {
  const wrapper = node?.closest?.("[data-editor-element-id]");
  const elementId = wrapper?.getAttribute("data-editor-element-id");
  if (!wrapper || !elementId) return null;
  const el = ctx.fig.elements.find((e) => e.id === elementId);
  if (!el || ctx.excluded(elementId)) return null;
  if (wholeObject) {
    const top = el.groupId ? topGroupOf(ctx.fig, el.groupId) : null;
    if (top) {
      const first = membersDeep(ctx.fig, top)[0];
      return { unit: { element: first?.id ?? el.id, group: top }, elementId };
    }
    return { unit: { element: el.id }, elementId };
  }
  if (el.type === "plot") {
    const manifest = ctx.manifestFor(el);
    const pid = resolvePartId(manifest, node, el.id, partIndexOf(manifest));
    if (pid && !isScaffoldPart(manifest, pid) && !ctx.excluded(el.id, pid)) return { unit: { element: el.id, part: pid }, elementId };
    return { unit: { element: el.id }, elementId };
  }
  if (el.type === "model3d") {
    const part = node?.closest?.("[data-model3d-furniture] [data-part-id]");
    const pid = part && wrapper.contains(part) ? part.getAttribute("data-part-id") : null;
    if (pid && !ctx.excluded(el.id, pid)) return { unit: { element: el.id, part: pid }, elementId };
  }
  return { unit: { element: el.id }, elementId };
}

const wrapperOf = (root: ParentNode, id: string) => root.querySelector(`[data-editor-element-id="${CSS.escape(id)}"]`);

/** The live nodes a unit paints with. A container part (a series, an axis
 *  group) often has no DOM node of its own: it paints as its leaf targets. */
export function unitNodes(unit: PickUnit, root: ParentNode, fig: Figure, manifestFor?: (el: SemanticPlotElement) => FluxPlotManifest | undefined): Element[] {
  if (unit.group) return membersDeep(fig, unit.group).map((m) => wrapperOf(root, m.id)).filter((n): n is Element => !!n);
  if (unit.part) {
    // Scoped to the element's own wrapper: a thumbnail or another pane may
    // carry the same prefixed ids, and the wrapper's subtree is one plot.
    const wrapper = wrapperOf(root, unit.element);
    const node = wrapper?.querySelector(`[id="${CSS.escape(partDomId(unit.element, unit.part))}"]`)
      ?? wrapper?.querySelector(`[data-model3d-furniture] [data-part-id="${CSS.escape(unit.part)}"]`);
    if (node || !wrapper) return node ? [node] : [];
    const el = fig.elements.find((e) => e.id === unit.element);
    const manifest = el?.type === "plot" ? manifestFor?.(el) : undefined;
    const leaves = manifest ? targetsOf(manifest, unit.part) : [];
    return leaves.map((pid) => wrapper.querySelector(`[id="${CSS.escape(partDomId(unit.element, pid))}"]`)).filter((n): n is Element => !!n);
  }
  const w = wrapperOf(root, unit.element);
  return w ? [w] : [];
}

export interface FrameBox { left: number; top: number; scale: number }

/** The slide frame on screen: its client origin and px-per-stage-px scale. */
export function frameBox(host: ParentNode, slideId: string, stageWidth: number): FrameBox | null {
  const bg = host.querySelector(`[data-annotation-figure="${CSS.escape(slideId)}"] > rect.figure-bg`);
  const r = bg?.getBoundingClientRect();
  if (!r || !r.width || !stageWidth) return null;
  return { left: r.left, top: r.top, scale: r.width / stageWidth };
}

export function toStage(r: { left: number; top: number; width: number; height: number }, f: FrameBox): StageRect {
  return { x: (r.left - f.left) / f.scale, y: (r.top - f.top) / f.scale, w: r.width / f.scale, h: r.height / f.scale };
}

/** A unit's stage box: the union of its painted nodes, or null when unmounted. */
export function unitStageRect(unit: PickUnit, root: ParentNode, fig: Figure, f: FrameBox, manifestFor?: (el: SemanticPlotElement) => FluxPlotManifest | undefined): StageRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of unitNodes(unit, root, fig, manifestFor)) {
    const r = n.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  return x0 === Infinity ? null : toStage({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }, f);
}

/** Every unit a marquee may pick, measured once at the press (one rect read
 *  per candidate on a clean layout; the drag itself is pure arithmetic). */
export function marqueeCandidates(root: ParentNode, ctx: HitContext, f: FrameBox): MarqueeCandidate[] {
  const out: MarqueeCandidate[] = [];
  for (const el of ctx.fig.elements as FigElement[]) {
    if (ctx.excluded(el.id)) continue;
    const wrapper = wrapperOf(root, el.id);
    if (!wrapper) continue;
    const r = wrapper.getBoundingClientRect();
    if (r.width || r.height) out.push({ unit: { element: el.id }, rect: toStage(r, f), level: "object" });
    if (el.type !== "plot") continue;
    const manifest = ctx.manifestFor(el);
    if (!manifest) continue;
    const idx = partIndexOf(manifest);
    const byId = new Map<string, Element>();
    for (const n of wrapper.querySelectorAll("[id]")) byId.set(n.id, n);
    for (const pid of leafPartIds(manifest)) {
      if (ctx.excluded(el.id, pid)) continue;
      const node = byId.get(partDomId(el.id, pid));
      const pr = node?.getBoundingClientRect();
      if (!pr || (!pr.width && !pr.height)) continue;
      out.push({ unit: { element: el.id, part: pid }, rect: toStage(pr, f), level: "leaf", data: isDataRole(idx[pid]?.role) });
    }
  }
  return out;
}
