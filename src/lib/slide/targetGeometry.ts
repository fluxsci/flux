// Geometry bridge: pristine prepared SVG/model state → outlines in stage px.
// No layout reads or DOM writes. Preparation belongs to preparePlot, never here.
import type { Element as SceneElement, SemanticPlotElement, VectorNode, PartOverride, GroupDef } from "../types";
import type { FluxPlotManifest, PartInfo } from "../plot/types";
import type { SlideFrame } from "./compile";
import type { TargetRef } from "./types";
import type { StageOutline, OutlineOwner, OutlinePaint } from "./stageOutline";
import { elementOutline, elementPaint, type Outline } from "./outline";
import { elementBBox, type Rect } from "../geometry";
import { pathToSubpaths, nodesExtent } from "../path";
import { resolveTargetLeaves, leavesOf } from "./targets";
import { buildPartIndex, drawablesUnder } from "../plot/parse";
import { resolveTargets } from "../plot/tree";
import { svgIntrinsicPx, cropViewBoxValue, ptTrueFactors } from "../plot/compensate";
import { parseStyleAttr, readPaint } from "../plot/paint";
import { IDENTITY, compose, parseTransform, applyToNodes, applyToPoint, type SvgMatrix } from "../plot/svgMatrix";
import { viewFits, projectSeries, projectWith, guideData, guideAxes, type Fit, retickable } from "../plot/project";

export interface GeometryCtx {
  manifest(assetId: string): FluxPlotManifest | undefined;
  /** The PRISTINE prepared root (preparePlot's output, unprefixed ids). */
  plotRoot(assetId: string): Element | undefined;
  /** SlideFrame has no registry; callers pass the owning slide's group defs. */
  groups?: Record<string, GroupDef>;
  /** Letter outlines for a text element (oct2 W3): unrotated stage-px rings, one
   *  per connected letter part (player/glyphProvider.ts measures and places them;
   *  boxes stand in for letters with no font outline). When it yields outlines a
   *  text is no longer a box-only crossfade target. Sync and cache-backed. */
  glyphs?: (el: Extract<SceneElement, { type: "text" }>) => StageOutline[] | null;
}

const translate = (x: number, y: number): SvgMatrix => [1, 0, 0, 1, x, y];
const scale = (x: number, y: number): SvgMatrix => [x, 0, 0, y, 0, 0];
function boxNodes(b: Rect): VectorNode[] {
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
    .map(([x, y]) => ({ x, y, type: "corner" }));
}

/** CSS rotate() scaleX/Y() applies flips FIRST, about the unrotated box centre.
 *  Drawn elementOutline already owns flips; SVG geometry needs them here. */
function placement(el: SceneElement, flips: boolean): SvgMatrix {
  const b = elementBBox(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const angle = el.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return compose(translate(cx, cy), compose([c, s, -s, c, 0, 0],
    compose(scale(flips && el.flipX ? -1 : 1, flips && el.flipY ? -1 : 1), translate(-cx, -cy))));
}

function stage(outline: Outline, matrix: SvgMatrix, owner: OutlineOwner, paint: OutlinePaint): StageOutline {
  const nodes = applyToNodes(outline.nodes, matrix);
  // bbox = the TRUE curve extent (never the control hull, never stroke overhang): the box
  // refitPath gives a path element, the frame planElementMorph plans a Become in, and the box
  // correspondence.ts derives for merged chains and tiled pieces. One definition, or a 1↔1
  // Become planned through the bridge stops reproducing today's.
  return { nodes, closed: outline.closed, bbox: nodesExtent(nodes, outline.closed), owner, paint };
}

export function elementStageOutlines(el: SceneElement, ctx?: Pick<GeometryCtx, "glyphs">): StageOutline[] {
  const b = elementBBox(el), outline = elementOutline(el);
  if (el.type === "text" && ctx?.glyphs) {
    const letters = ctx.glyphs(el);
    if (letters?.length) {
      const m = placement(el, true);
      return letters.map((o) => { const nodes = applyToNodes(o.nodes, m); return { ...o, nodes, bbox: nodesExtent(nodes, true) }; });
    }
  }
  if (outline) return [stage(outline, compose(placement(el, false), translate(b.x, b.y)),
    { elementId: el.id }, { ...elementPaint(el), opacity: el.opacity ?? 1 })];
  if (el.type !== "text" && el.type !== "image" && el.type !== "video" && el.type !== "plot" && el.type !== "model3d") return [];
  return [stage({ nodes: boxNodes(b), closed: true }, placement(el, true), { elementId: el.id }, {
    fill: el.type === "text" ? el.color : "none", stroke: "none", strokeWidth: 0, cap: "butt",
    opacity: el.opacity ?? 1, text: el.type === "text", raster: el.type !== "text",
  })];
}

// Roots are immutable and replaced on regeneration. Weak keys release all cached
// geometry with the asset; a warm call neither parses paths nor scans the DOM.
interface PreparedGeometry {
  ids: Map<string, Element>;
  local: WeakMap<Element, Outline[]>;
  transforms: WeakMap<Element, SvgMatrix>;
  paints: WeakMap<Element, OutlinePaint>;
  drawables: WeakMap<Element, Element[]>;
}
const prepared = new WeakMap<Element, PreparedGeometry>();
const indexes = new WeakMap<FluxPlotManifest, Record<string, PartInfo>>();
function indexFor(manifest: FluxPlotManifest | undefined): Record<string, PartInfo> {
  if (!manifest) return {};
  let index = indexes.get(manifest);
  if (!index) { index = buildPartIndex(manifest); indexes.set(manifest, index); }
  return index;
}
function geometryFor(root: Element): PreparedGeometry {
  let geo = prepared.get(root);
  if (!geo) {
    geo = { ids: new Map(), local: new WeakMap(), transforms: new WeakMap(), paints: new WeakMap(), drawables: new WeakMap() };
    for (const n of [root, ...Array.from(root.querySelectorAll("[id]"))]) {
      const id = n.getAttribute("id");
      if (id) geo.ids.set(id, n);
    }
    prepared.set(root, geo);
  }
  return geo;
}
function drawablesFor(node: Element, geo: PreparedGeometry): Element[] {
  let nodes = geo.drawables.get(node);
  if (!nodes) { nodes = drawablesUnder(node); geo.drawables.set(node, nodes); }
  return nodes;
}
const number = (node: Element, name: string, fallback = 0) => {
  const n = parseFloat(node.getAttribute(name) ?? "");
  return Number.isFinite(n) ? n : fallback;
};

function localOutlines(node: Element, geo: PreparedGeometry): Outline[] {
  const cached = geo.local.get(node);
  if (cached) return cached;
  const tag = node.tagName.toLowerCase();
  let out: Outline[] = [];
  if (tag === "path") out = pathToSubpaths(node.getAttribute("d") ?? "");
  else if (tag === "line") out = [{ nodes: [
    { x: number(node, "x1"), y: number(node, "y1"), type: "corner" },
    { x: number(node, "x2"), y: number(node, "y2"), type: "corner" },
  ], closed: false }];
  else if (tag === "polyline" || tag === "polygon") {
    const pts = (node.getAttribute("points")?.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    const nodes: VectorNode[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) nodes.push({ x: pts[i], y: pts[i + 1], type: "corner" });
    out = [{ nodes, closed: tag === "polygon" }];
  } else if (tag === "rect" || tag === "image" || tag === "text" || tag === "tspan") {
    // Text is a box-only crossfade target. Unmeasured text has an anchor box,
    // never a fabricated font-size × character-count outline. Explicit SVG
    // textLength/width/height are usable without a layout engine.
    const b = { x: number(node, "x"), y: number(node, "y"), w: number(node, "width", number(node, "textLength")), h: number(node, "height") };
    if (tag === "rect" && (number(node, "rx") || number(node, "ry"))) {
      const rx = Math.min(b.w / 2, Math.max(0, number(node, "rx", number(node, "ry"))));
      const ry = Math.min(b.h / 2, Math.max(0, number(node, "ry", number(node, "rx"))));
      out = pathToSubpaths(`M ${b.x + rx} ${b.y} H ${b.x + b.w - rx} A ${rx} ${ry} 0 0 1 ${b.x + b.w} ${b.y + ry} V ${b.y + b.h - ry} A ${rx} ${ry} 0 0 1 ${b.x + b.w - rx} ${b.y + b.h} H ${b.x + rx} A ${rx} ${ry} 0 0 1 ${b.x} ${b.y + b.h - ry} V ${b.y + ry} A ${rx} ${ry} 0 0 1 ${b.x + rx} ${b.y} Z`);
    } else out = [{ nodes: boxNodes(b), closed: true }];
  } else if (tag === "circle" || tag === "ellipse") {
    const rx = number(node, tag === "circle" ? "r" : "rx"), ry = number(node, tag === "circle" ? "r" : "ry");
    const outline = elementOutline({ type: "ellipse", id: "", x: 0, y: 0, width: 2 * rx, height: 2 * ry, rotation: 0, fill: "none", stroke: "none", strokeWidth: 0 });
    if (outline) out = [{ nodes: applyToNodes(outline.nodes, translate(number(node, "cx") - rx, number(node, "cy") - ry)), closed: true }];
  }
  out = out.filter((o) => o.nodes.length >= 2 && o.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  geo.local.set(node, out);
  return out;
}

function plotMapping(plot: SemanticPlotElement, root: Element) {
  const intrinsic = svgIntrinsicPx(root);
  const vbAttr = plot.crop ? cropViewBoxValue(root.getAttribute("viewBox"), intrinsic, plot.crop) : root.getAttribute("viewBox");
  const v = (vbAttr ?? "").trim().split(/[\s,]+/).map(Number);
  const vb = v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0
    ? { x: v[0], y: v[1], w: v[2], h: v[3] } : { x: 0, y: 0, ...intrinsic };
  const sx = plot.width / vb.w, sy = plot.height / vb.h;
  const mapping: SvgMatrix = [sx, 0, 0, sy, plot.x - vb.x * sx, plot.y - vb.y * sy];
  const toStage = compose(placement(plot, true), mapping);
  return { intrinsic, sx, sy, matrix: toStage };
}

/** The same cropped viewBox/placement mapping used by partStageOutlines.
 *  Axis fits are meaningful only for unrotated plots; callers fall back to
 *  spatial pairing when the data axes are not stage-axis-aligned. */
export function plotStageMapping(plot: SemanticPlotElement, root: Element): {
  toStage(x: number, y: number): { x: number; y: number };
  fitX(fit: Fit): Fit;
  fitY(fit: Fit): Fit;
} {
  const { matrix: m } = plotMapping(plot, root);
  const lift = (fit: Fit, s: number, offset: number): Fit => ({ ...fit,
    m: fit.m * s, c: fit.c * s + offset,
    ...(fit.linear === undefined ? {} : { linear: fit.linear * s, logarithmic: (fit.logarithmic ?? 0) * s }),
  });
  return { toStage: (x, y) => applyToPoint({ x, y }, m),
    fitX: fit => lift(fit, m[0], m[4]), fitY: fit => lift(fit, m[3], m[5]) };
}

// Read the projection kernel's output, without writing to the pristine root.
// These are the same data vertices/fits the one DOM writer applies before
// compensation. Filled marks retain their authored geometry, as in that writer.
function projectedGeometry(plot: SemanticPlotElement, root: Element, manifest: FluxPlotManifest | undefined, geo: PreparedGeometry) {
  const outlines = new Map<Element, Outline[]>(), offsets = new Map<Element, SvgMatrix>(), opacities = new Map<Element, number>();
  if (!plot.view || !manifest) return { outlines, offsets, opacities };
  for (const series of manifest.series ?? []) {
    const raw = viewFits(manifest, undefined, series.panelId), fits = viewFits(manifest, plot.view, series.panelId);
    if (!raw || !fits || series.rasterized || series.capabilities?.dataMorph === false || series.roles?.some(r => !["line", "point"].includes(r))) continue;
    const vertices = projectSeries(series, null, raw, fits, 1);
    if (!vertices.length || vertices.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    const part = series.svg?.line ? geo.ids.get(series.svg.line) : undefined;
    const line = part?.tagName.toLowerCase() === "path" ? part : part?.querySelector("path");
    if (line) {
      const paths: Outline[] = [];
      let previous = -2;
      for (const p of vertices) {
        if (p.index !== previous + 1) paths.push({ nodes: [], closed: false });
        paths[paths.length - 1].nodes.push({ x: p.x, y: p.y, type: "corner" });
        previous = p.index;
      }
      outlines.set(line, paths.filter(p => p.nodes.length >= 2));
    }
    const byIndex = new Map(vertices.map(p => [p.index, p]));
    for (const point of series.points ?? []) {
      const node = geo.ids.get(point.svgId), p = byIndex.get(point.index);
      if (!node || !p) continue;
      // Marker translate is a CSS individual transform in projectDom, before
      // its SVG transform. Circles instead have their centre attributes written.
      const circle = node.tagName.toLowerCase() === "circle";
      const dx = p.x - (circle ? number(node, "cx") : projectWith(raw.x, point.x));
      const dy = p.y - (circle ? number(node, "cy") : projectWith(raw.y, point.y));
      if (circle) outlines.set(node, localOutlines(node, geo).map(o => ({ ...o, nodes: applyToNodes(o.nodes, translate(dx, dy)) })));
      else offsets.set(node, translate(Math.round(dx * 100) / 100, Math.round(dy * 100) / 100));
    }
  }
  for (const [id, guide] of guideData(manifest, root)) {
    const node = geo.ids.get(id), axes = guideAxes(manifest, id);
    if (!node || !axes) continue;
    const raw = viewFits(manifest, undefined, axes.panelId), fits = viewFits(manifest, plot.view, axes.panelId);
    if (!raw || !fits) continue;
    const fit = fits[guide.axis], original = raw[guide.axis];
    const record = (axes as unknown as Record<string, { domain: number[] } | undefined>)[guide.axis];
    if (!fit || !original || !record) continue; // a twin axis the panel cannot project
    if (fit.m === original.m && fit.c === original.c && fit.log === original.log) continue;
    // at rest the DOM writer re-ticks this axis (F4): the generated ticks, labels and gridlines
    // are hidden and clones stand at the new positions — the model hides them too, so no flight
    // ever carries a hidden tick
    if (retickable(manifest, plot.view, axes.panelId, guide.axis)) { opacities.set(node, 0); continue; }
    const pixel = projectWith(fit, guide.value), origin = projectWith(original, guide.value);
    const ends = record.domain.map(v => projectWith(original, v));
    const lo = Math.min(...ends), hi = Math.max(...ends);
    const fade = Number.isFinite(pixel) ? Math.max(0, Math.min(1, (pixel - lo) / ((hi - lo) * .04), (hi - pixel) / ((hi - lo) * .04))) : 0;
    opacities.set(node, fade);
    const delta = Number.isFinite(pixel) ? pixel - origin : 0;
    offsets.set(node, translate(guide.axis.startsWith("x") ? delta : 0, guide.axis.startsWith("y") ? delta : 0));
  }
  return { outlines, offsets, opacities };
}

export function partStageOutlines(plot: SemanticPlotElement, leafIds: string[], ctx: GeometryCtx): StageOutline[] {
  if (!leafIds.length) return [];
  const root = ctx.plotRoot(plot.assetId);
  if (!root) return elementStageOutlines(plot);
  const manifest = ctx.manifest(plot.assetId), index = indexFor(manifest), geo = geometryFor(root);
  const { intrinsic, sx, sy, matrix: toStage } = plotMapping(plot, root);
  const projection = projectedGeometry(plot, root, manifest, geo);
  const { fx, fy, fs } = ptTrueFactors({ elW: plot.width, elH: plot.height, crop: plot.crop, contentScale: plot.contentScale, intrinsic });
  // A stroke renders at declared × fs (compensatePtTrue's style write, or the glyph/text
  // transform) × the outer viewBox→box scale; rotation and flips are rigid. In stage px that is
  // declared × contentScale × (CSS px per user unit), whatever the box size (the pt-true contract).
  const strokeScale = fs * Math.sqrt(sx * sy);
  const overrides = new Map<Element, PartOverride>();
  const paints = new Map<Element, PartOverride>();
  for (const [id, ov] of Object.entries(plot.overrides ?? {})) {
    for (const leaf of resolveTargets(manifest, id)) {
      const node = geo.ids.get(leaf);
      if (!node) continue;
      const prev = overrides.get(node) ?? {};
      overrides.set(node, { ...prev, ...ov, ...(ov.dx != null || ov.dy != null ? { dx: ov.dx ?? 0, dy: ov.dy ?? 0 } : {}) });
      // applyOverrides writes paint on descendants in authored override order.
      // A later container edit therefore wins even over a prior leaf edit.
      if (ov.fill != null || ov.stroke != null || ov.strokeWidth != null) for (const d of drawablesFor(node, geo)) {
        const paint = { ...paints.get(d) };
        if (ov.stroke != null) paint.stroke = ov.stroke;
        if (ov.strokeWidth != null) paint.strokeWidth = ov.strokeWidth;
        const ownFill = paint.fill ?? parseStyleAttr(d.getAttribute("style")).get("fill") ?? d.getAttribute("fill");
        if (ov.fill != null && (d === node || ownFill == null || ownFill.toLowerCase() !== "none")) paint.fill = ov.fill;
        paints.set(d, paint);
      }
    }
  }
  // Memoizing each ancestor makes a batch of N glyphs O(N), including nested transforms.
  interface NodeState { matrix: SvgMatrix; hidden: boolean; opacity: number }
  const states = new Map<Element, NodeState>();
  const rootStyle = parseStyleAttr(root.getAttribute("style"));
  const rootOpacity = parseFloat(rootStyle.get("opacity") ?? root.getAttribute("opacity") ?? "1");
  states.set(root, { matrix: IDENTITY, hidden: rootStyle.get("display") === "none", opacity: Number.isFinite(rootOpacity) ? rootOpacity : 1 });
  const stateOf = (node: Element): NodeState => {
    const cached = states.get(node);
    if (cached) return cached;
    const parent = node.parentElement ? stateOf(node.parentElement) : states.get(root)!;
    const ov = overrides.get(node), style = parseStyleAttr(node.getAttribute("style"));
    let m = geo.transforms.get(node);
    if (!m) { m = parseTransform(node.getAttribute("transform")); geo.transforms.set(node, m); }
    if (ov?.dx != null || ov?.dy != null) m = compose(translate(Number(ov.dx ?? 0), Number(ov.dy ?? 0)), m);
    const projected = projection.offsets.get(node);
    if (projected) m = compose(projected, m);
    if (node.getAttribute("data-flux-glyph") === "1") m = compose(m, scale(fx, fy));
    else if (node.tagName.toLowerCase() === "text") {
      const ax = number(node, "x"), ay = number(node, "y");
      m = compose(compose(translate(ax, ay), compose(scale(fx, fy), translate(-ax, -ay))), m);
    }
    const ownOpacity = parseFloat(style.get("opacity") ?? node.getAttribute("opacity") ?? "1");
    const state = {
      matrix: compose(parent.matrix, m),
      hidden: parent.hidden || (ov?.hidden ?? (style.get("display") === "none" || node.getAttribute("display") === "none")),
      opacity: parent.opacity * (ov?.opacity ?? (Number.isFinite(ownOpacity) ? ownOpacity : 1)) * (projection.opacities.get(node) ?? 1),
    };
    states.set(node, state);
    return state;
  };
  const out: StageOutline[] = [], seen = new Set<Element>();
  for (const id of leafIds) {
    const part = geo.ids.get(id);
    if (!part) continue;
    const info = index[id];
    const owner: OutlineOwner = { elementId: plot.id, partId: id,
      ...(info?.role ? { role: info.role } : {}), ...(info?.series ? { series: info.series } : {}),
      ...(info?.index != null ? { index: info.index } : {}),
      ...(info?.x != null || info?.y != null ? { data: { ...(info.x != null ? { x: info.x } : {}), ...(info.y != null ? { y: info.y } : {}) } } : {}),
    };
    for (const node of drawablesFor(part, geo)) {
      if (seen.has(node)) continue;
      if (node.tagName.toLowerCase() === "tspan") {
        let parent = node.parentElement;
        while (parent && parent !== root && !seen.has(parent)) parent = parent.parentElement;
        if (parent && seen.has(parent)) continue; // the text run already owns its spans
      }
      seen.add(node);
      const state = stateOf(node);
      if (state.hidden) continue;
      let basePaint = geo.paints.get(node);
      if (!basePaint) { basePaint = readPaint(node); geo.paints.set(node, basePaint); }
      const paint = paints.has(node) ? readPaint(node, paints.get(node)) : { ...basePaint };
      paint.opacity = state.opacity * (plot.opacity ?? 1);
      paint.strokeWidth *= strokeScale;
      if (paint.dash) paint.dash = paint.dash.map((n) => n * strokeScale);
      const tag = node.tagName.toLowerCase();
      if (tag === "text" || tag === "tspan") paint.text = true;
      if (tag === "image") paint.raster = true;
      const matrix = compose(toStage, state.matrix);
      for (const outline of projection.outlines.get(node) ?? localOutlines(node, geo)) out.push(stage(outline, matrix, owner, paint));
    }
  }
  return out;
}

export function targetOutlines(ref: TargetRef, frame: SlideFrame, ctx: GeometryCtx): StageOutline[] {
  const elements = new Map(frame.elements.map((el) => [el.id, el]));
  const out: StageOutline[] = [];
  for (const leaf of resolveTargetLeaves(ref, { elements: frame.elements, groups: ctx.groups }, ctx.manifest)) {
    const el = elements.get(leaf.elementId)!;
    if (el.type !== "plot") { out.push(...elementStageOutlines(el, ctx)); continue; }
    const root = ctx.plotRoot(el.assetId);
    if (!root) { out.push(...elementStageOutlines(el)); continue; }
    const manifest = ctx.manifest(el.assetId);
    const ids = leaf.partIds ?? Object.keys(indexFor(manifest)).filter((id) => {
      const leaves = leavesOf(manifest, id);
      return leaves.length === 1 && leaves[0] === id;
    });
    // A supplied prepared root can lack a manifest; its drawable ids still work.
    if (leaf.partIds === null && !ids.length) ids.push(...drawablesUnder(root).map((n) => n.getAttribute("id")).filter((id): id is string => !!id));
    out.push(...partStageOutlines(el, ids, ctx));
  }
  return out;
}
