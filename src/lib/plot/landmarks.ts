// Scientific layout landmarks. Shared by Figure/Slide and Node: no layout reads,
// store access, source IO or mutation. A prepared SVG is evidence, not a box fallback.
import type { Element as SceneElement, Figure, SemanticPlotElement } from '../types';
import type { FluxPlotManifest, PartNode } from './types';
import { isDerivedManifest } from './derive';
import { buildPartIndex, drawablesUnder } from './parse';
import { aliasPartId } from './tree';
import { parseStyleAttr } from './paint';
import { parseColor } from '../color/interp';
import { partStageOutlines } from '../slide/targetGeometry';
import { rotatePoint } from '../geometry';
import { effectiveHidden, effectiveLocked, unitKeyOf } from '../groups';

export type SpineAxis = 'x' | 'y';
export interface SpineChoice { plotId?: string; panelId?: string; spineId?: string }
export interface SpineContext {
  manifest(assetId: string): FluxPlotManifest | undefined;
  plotRoot(assetId: string): Element | null | undefined;
  /** Supply the owning figure for inherited group state and completeness checks. */
  figure?: Figure;
  scope?: string | null;
  excluded?: ReadonlySet<string>;
  partExcluded?(plotId: string, spineId: string): boolean;
}
export interface SpineUnit {
  key: string;
  members: SceneElement[];
  /** An adapter may explain a context-specific exclusion (e.g. a stashed slide member). */
  unavailableReason?: string;
}
export interface SpineCandidate {
  plotId: string;
  panelId: string;
  spineId: string;
  axis: SpineAxis;
  axisKey: 'x' | 'y' | 'x2' | 'y2';
  side: 'bottom' | 'top' | 'left' | 'right';
  label: string;
  inset: boolean;
  eligible: boolean;
  reason?: string;
  coordinate?: number;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
}
export interface SpineCandidates { candidates: SpineCandidate[]; reason?: string }
export interface SpineLandmark extends SpineCandidate {
  unitKey: string;
  eligible: true;
  coordinate: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
}
export interface SpineResolution extends SpineCandidates { landmark?: SpineLandmark }
export interface SpineIssue { unitKey: string; reason: string }
export interface SpineAlignmentPlan {
  translations: { id: string; dx: number; dy: number }[];
  landmarks: SpineLandmark[];
  issues: SpineIssue[];
}

// Immutable prepared roots release their indexes/candidates on source replacement.
interface RootIndex { nodes: Map<string, Element>; styleIssue?: string; results: Map<string, SpineCandidates> }
const roots = new WeakMap<Element, RootIndex>();
const manifestIds = new WeakMap<FluxPlotManifest, number>();
let nextManifest = 0;
function manifestKey(manifest: FluxPlotManifest): number {
  let id = manifestIds.get(manifest);
  if (id === undefined) { id = ++nextManifest; manifestIds.set(manifest, id); }
  return id;
}

/** Same safe cap/join subset as bakePlotStyles; classification never writes the root. */
function stylesheetIssue(root: Element): string | undefined {
  for (const sheet of Array.from(root.querySelectorAll('style'))) {
    if (Array.from(sheet.attributes).some(a => a.name !== 'type' || a.value.trim().toLowerCase() !== 'text/css')) return 'Conditional SVG styles are unsupported';
    const css = (sheet.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (css.replace(/\*\s*\{[^{}]*\}/g, '').trim()) return 'SVG stylesheet visibility or geometry cannot be resolved';
    for (const rule of css.matchAll(/\*\s*\{([^{}]*)\}/g)) {
      for (const declaration of rule[1].split(';').map(v => v.trim()).filter(Boolean)) {
        const match = /^(stroke-linecap|stroke-linejoin)\s*:\s*(butt|round|square|miter|bevel)$/i.exec(declaration);
        if (!match || !(match[1].toLowerCase() === 'stroke-linecap' ? ['butt', 'round', 'square'] : ['miter', 'round', 'bevel']).includes(match[2].toLowerCase())) return 'SVG stylesheet visibility or geometry cannot be resolved';
      }
    }
  }
}
function indexRoot(root: Element): RootIndex {
  let value = roots.get(root);
  if (!value) {
    value = { nodes: new Map(), results: new Map(), styleIssue: stylesheetIssue(root) };
    for (const node of [root, ...Array.from(root.querySelectorAll('[id]'))]) {
      const id = node.getAttribute('id');
      if (id) value.nodes.set(id, node);
    }
    roots.set(root, value);
  }
  return value;
}

// Metadata ancestry provides the axis when a spine's own role is not encoded in its id.
function semanticAxes(manifest: FluxPlotManifest): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (node: PartNode, inherited?: string) => {
    const id = node.id ?? node.ref;
    const axis = node.axis ?? (id ? /(?:^|\.)axis\.(x2?|y2?)(?:\.|$)/.exec(id)?.[1] : undefined) ?? inherited;
    if (id && axis) result.set(aliasPartId(manifest, id), axis);
    for (const member of node.members ?? []) if (axis) result.set(aliasPartId(manifest, member), axis);
    node.children?.forEach(child => walk(child, axis));
  };
  if (manifest.parts) walk(manifest.parts);
  return result;
}

/** Refuse CSS transforms, nested viewports, unsupported clipping and inherited visibility.
 * Effective display/opacity from authored overrides is handled by partStageOutlines. */
function sourceIssue(node: Element, root: Element): string | undefined {
  let foundStrokeOpacity = false;
  for (let current: Element | null = node; current; current = current.parentElement) {
    const style = parseStyleAttr(current.getAttribute('style'));
    const value = (name: string) => (style.get(name) ?? current!.getAttribute(name))?.trim();
    if (current !== root && current.tagName.toLowerCase() === 'svg') return 'Nested SVG viewports are unsupported';
    if (style.has('transform') || style.has('transform-origin') || style.has('transform-box')) return 'CSS-transformed spines are unsupported';
    if (['clip-path', 'mask', 'filter'].some(name => { const v = value(name); return v && v !== 'none'; })) return 'Clipped, masked or filtered spines are unsupported';
    const visibility = value('visibility');
    if (visibility && !['visible', 'inherit'].includes(visibility)) return 'Spine is hidden or has unresolved visibility';
    // readPaint can only fold alpha into colours understood by parseColor. Named
    // SVG colours also obey stroke-opacity, so independently verify its inherited
    // visibility here (e.g. red + stroke-opacity:0 must not be an eligible spine).
    const strokeOpacity = value('stroke-opacity');
    if (!foundStrokeOpacity && strokeOpacity && strokeOpacity !== 'inherit') {
      foundStrokeOpacity = true;
      if (!/^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?%?$/i.test(strokeOpacity)) return 'Spine stroke opacity cannot be resolved';
      if (!(parseFloat(strokeOpacity) > 0)) return 'Spine has no visible stroke';
    }
    // Styles using CSS variables/currentColor/paint servers need a cascade engine.
    for (const name of ['stroke', 'stroke-width', 'stroke-opacity', 'opacity', 'display']) {
      const v = value(name);
      if (v && /var\(|url\(|currentcolor|!important/i.test(v)) return 'Spine paint or visibility cannot be resolved';
    }
    // Attributes are the supported transform channel. Unknown syntax must not be
    // silently ignored by the permissive animation geometry reader.
    const transform = current.getAttribute('transform')?.trim();
    if (transform) {
      if (current === root) return 'Root SVG transforms are unsupported';
      const calls = [...transform.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)];
      const rest = transform.replace(/(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([^)]*\)/g, '').replace(/[\s,]/g, '');
      const counts: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
      if (rest || !calls.length || calls.some(call => {
        const values = call[2].trim().split(/[\s,]+/).map(Number);
        return !counts[call[1]].includes(values.length) || !values.every(Number.isFinite);
      })) return 'Spine SVG transform is unsupported';
    }
    if (current === root) break;
  }
}

function visibleStroke(stroke: string): boolean | undefined {
  if (/^(none|transparent)$/i.test(stroke.trim())) return false;
  const color = parseColor(stroke);
  if (color) return color.a > 0;
  // SVG permits named CSS colours. They are opaque; other expressions require a renderer.
  if (/^(black|white|red|green|blue|yellow|orange|purple|gray|grey|silver|maroon|olive|lime|aqua|teal|navy|fuchsia)$/i.test(stroke)) return true;
  return undefined;
}

function candidateGeometry(plot: SemanticPlotElement, candidate: SpineCandidate, root: Element, manifest: FluxPlotManifest, indexed: RootIndex): SpineCandidate {
  const fail = (reason: string): SpineCandidate => ({ ...candidate, eligible: false, reason });
  if (indexed.styleIssue) return fail(indexed.styleIssue);
  const source = indexed.nodes.get(candidate.spineId);
  if (!source) return fail('Spine is missing from the accepted SVG');
  const drawables = drawablesUnder(source);
  if (!drawables.length) return fail('Spine has no drawable geometry');
  for (const drawable of drawables) {
    const issue = sourceIssue(drawable, root);
    if (issue) return fail(issue);
  }
  if (![plot.x, plot.y, plot.width, plot.height, plot.rotation ?? 0].every(Number.isFinite) || plot.width <= 0 || plot.height <= 0) return fail('Plot placement is invalid');
  // Axis-view changes project marks and tick furniture, never spine geometry. Avoid
  // traversing/projecting a dense data series solely to resolve its two-node spine.
  const outlines = partStageOutlines({ ...plot, view: undefined }, [candidate.spineId], {
    manifest: () => manifest, plotRoot: () => root,
  });
  if (!outlines.length) return fail('Spine is hidden or has no geometry');
  if (outlines.length !== 1) return fail('Choose a spine consisting of one continuous segment');
  const epsilon = 1e-6 * Math.max(1, plot.width, plot.height);
  const points: { x: number; y: number }[] = [];
  for (const outline of outlines) {
    const stroke = visibleStroke(outline.paint.stroke);
    if (stroke === undefined) return fail('Spine stroke colour cannot be resolved');
    if (!stroke || !((outline.paint.opacity ?? 1) > 0) || !(outline.paint.strokeWidth > 0)) return fail('Spine has no visible stroke');
    if (outline.closed) return fail('Spine must be a straight open segment');
    for (const node of outline.nodes) {
      if (![node.x, node.y].every(Number.isFinite)) return fail('Spine geometry is not finite');
      points.push({ x: node.x, y: node.y });
      // Curves can overshoot their endpoints even when controls are collinear;
      // their handles are not reliable visible segment endpoints.
      if ([node.hIn, node.hOut].some(h => h && (Math.abs(h.dx) > epsilon || Math.abs(h.dy) > epsilon))) return fail('Curved spines are unsupported');
    }
  }
  if (points.length < 2 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return fail('Spine geometry is empty or invalid');
  const coordinateKey = candidate.axis === 'x' ? 'y' : 'x';
  const alongKey = candidate.axis === 'x' ? 'x' : 'y';
  const coordinate = points[0][coordinateKey];
  if (points.some(point => Math.abs(point[coordinateKey] - coordinate) > epsilon)) return fail(`Spine is not ${candidate.axis === 'x' ? 'horizontal' : 'vertical'}`);
  const sorted = [...points].sort((a, b) => a[alongKey] - b[alongKey]);
  if (sorted.at(-1)![alongKey] - sorted[0][alongKey] <= epsilon) return fail('Spine has zero length');
  // Undo only the placement rotation/flips. The crop/viewBox mapping has already
  // been applied, so the effective viewport is [x,x+w] × [y,y+h] in this space.
  const center = { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 };
  for (const point of points) {
    const unrotated = rotatePoint(point, center, -(plot.rotation ?? 0));
    const x = center.x + (unrotated.x - center.x) * (plot.flipX ? -1 : 1);
    const y = center.y + (unrotated.y - center.y) * (plot.flipY ? -1 : 1);
    if (x < plot.x - epsilon || x > plot.x + plot.width + epsilon || y < plot.y - epsilon || y > plot.y + plot.height + epsilon) return fail('Spine is partially or fully clipped by the plot viewport');
  }
  return { ...candidate, eligible: true, coordinate, start: sorted[0], end: sorted.at(-1)! };
}

/** List named semantic candidates, retaining unavailable choices and their reasons. */
export function plotSpineCandidates(plot: SemanticPlotElement, axis: SpineAxis, ctx: SpineContext): SpineCandidates {
  const manifest = ctx.manifest(plot.assetId);
  if (!manifest || isDerivedManifest(manifest) || manifest.spec !== 'fluxplot/manifest' || !manifest.axes?.length) return { candidates: [], reason: 'This plot has no semantic scientific axes' };
  const root = ctx.plotRoot(plot.assetId);
  if (!root) return { candidates: [], reason: 'Plot geometry is not prepared or is unavailable' };
  const indexed = indexRoot(root);
  const key = JSON.stringify([manifestKey(manifest), plot.id, axis, plot.x, plot.y, plot.width, plot.height, plot.rotation, plot.flipX, plot.flipY, plot.crop, plot.contentScale, plot.opacity, plot.overrides]);
  const cached = indexed.results.get(key);
  if (cached) return structuredClone(cached);
  const parts = buildPartIndex(manifest), ancestry = semanticAxes(manifest);
  const candidates: SpineCandidate[] = [];
  for (const [partId, part] of Object.entries(parts)) {
    if (part.role !== 'spine') continue;
    const spineId = aliasPartId(manifest, partId);
    if (candidates.some(c => c.spineId === spineId)) continue;
    const axisKey = ancestry.get(spineId) ?? /(?:^|\.)axis\.(x2?|y2?)\./.exec(spineId)?.[1];
    if (!axisKey || !['x', 'y', 'x2', 'y2'].includes(axisKey) || !axisKey.startsWith(axis)) continue;
    const owners = manifest.axes.filter(a => a.panelId ? spineId.startsWith(a.panelId + '.') : manifest.axes.length === 1);
    if (owners.length !== 1) continue;
    const owner = owners[0], panel = manifest.panels?.find(p => p.id === owner.panelId);
    const explicitSide = /\.(bottom|top|left|right)$/.exec(spineId)?.[1] as SpineCandidate['side'] | undefined;
    const side = explicitSide ?? (axis === 'x' ? axisKey === 'x2' ? 'top' : 'bottom' : axisKey === 'y2' ? 'right' : 'left');
    const candidate: SpineCandidate = { plotId: plot.id, panelId: owner.panelId ?? '', spineId, axis,
      axisKey: axisKey as SpineCandidate['axisKey'], side, label: `${panel?.label ?? owner.panelId ?? 'Main panel'} · ${axisKey.toUpperCase()} ${side}`,
      inset: Boolean(panel?.insetOf), eligible: false };
    if (owner.projection && owner.projection !== 'rectilinear') candidates.push({ ...candidate, reason: 'Only rectilinear plot axes are supported' });
    else if (!(owner as unknown as Record<string, unknown>)[axisKey]) candidates.push({ ...candidate, reason: 'Spine has no corresponding axis descriptor' });
    else candidates.push(candidateGeometry(plot, candidate, root, manifest, indexed));
  }
  const result: SpineCandidates = { candidates, ...(!candidates.length ? { reason: `No semantic ${axis.toUpperCase()} spine is available` } : {}) };
  // Bounded per-root placement cache, shared across the same asset's placements.
  if (indexed.results.size >= 64) indexed.results.delete(indexed.results.keys().next().value!);
  indexed.results.set(key, result);
  return structuredClone(result);
}

export function resolveUnitSpine(unit: SpineUnit, axis: SpineAxis, ctx: SpineContext, choice: SpineChoice = {}): SpineResolution {
  if (unit.unavailableReason) return { candidates: [], reason: unit.unavailableReason };
  if (!unit.members.length) return { candidates: [], reason: 'Selection unit is empty' };
  if (ctx.figure) {
    const expected = ctx.figure.elements.filter(e => unitKeyOf(ctx.figure!, e, ctx.scope) === unit.key);
    const supplied = new Set(unit.members.map(e => e.id));
    if (expected.length && (expected.length !== supplied.size || expected.some(e => !supplied.has(e.id)))) return { candidates: [], reason: 'The complete plot group must move together' };
  }
  if (unit.members.some(e => ctx.excluded?.has(e.id) || (ctx.figure ? effectiveHidden(ctx.figure, e) || effectiveLocked(ctx.figure, e) : e.hidden || e.locked))) return { candidates: [], reason: 'Plot unit contains locked, hidden or excluded members' };
  const plots = unit.members.filter((e): e is SemanticPlotElement => e.type === 'plot');
  if (!plots.length) return { candidates: [], reason: 'Selection unit contains no semantic plot' };
  const all = plots.map(plot => ({ plot, result: plotSpineCandidates(plot, axis, ctx) }));
  const candidates = all.flatMap(entry => entry.result.candidates);
  if (!choice.plotId && plots.length !== 1) return { candidates, reason: 'Choose a representative plot for this group' };
  const selected = all.find(entry => entry.plot.id === (choice.plotId ?? plots[0].id));
  if (!selected) return { candidates, reason: 'The chosen plot is no longer in this selection unit' };
  if (selected.result.reason) return { candidates, reason: selected.result.reason };
  const manifest = ctx.manifest(selected.plot.assetId)!;
  let panelId = choice.panelId;
  if (panelId === undefined) {
    const mains = manifest.axes.filter(a => !manifest.panels?.find(p => p.id === a.panelId)?.insetOf);
    if (mains.length !== 1) return { candidates, reason: 'Choose a plot panel' };
    panelId = mains[0].panelId ?? '';
  }
  let options = selected.result.candidates.filter(c => c.panelId === panelId);
  if (choice.spineId) options = options.filter(c => c.spineId === aliasPartId(manifest, choice.spineId!));
  else options = options.filter(c => c.axisKey === axis && c.side === (axis === 'x' ? 'bottom' : 'left'));
  if (options.length !== 1) return { candidates, reason: options.length ? 'Choose one spine' : 'The chosen panel/spine is unavailable' };
  const candidate = options[0];
  if (ctx.partExcluded?.(candidate.plotId, candidate.spineId)) return { candidates, reason: 'The chosen spine is excluded in this editor view' };
  if (!candidate.eligible) return { candidates, reason: candidate.reason ?? 'The chosen spine is unavailable' };
  return { candidates, landmark: { ...candidate, unitKey: unit.key, eligible: true, coordinate: candidate.coordinate!, start: candidate.start!, end: candidate.end! } };
}

/** Atomic numeric plan. No translations are returned until every unit is eligible. */
export function planPlotSpineAlignment(units: SpineUnit[], axis: SpineAxis, referenceKey: string, ctx: SpineContext, choices: Record<string, SpineChoice> = {}): SpineAlignmentPlan {
  const issues: SpineIssue[] = [], landmarks: SpineLandmark[] = [];
  if (units.length < 2) issues.push({ unitKey: referenceKey, reason: 'Select at least two plot units' });
  const memberIds = new Set<string>(), unitKeys = new Set<string>();
  for (const unit of units) {
    if (unitKeys.has(unit.key) || unit.members.some(e => memberIds.has(e.id))) issues.push({ unitKey: unit.key, reason: 'Selection units overlap' });
    unitKeys.add(unit.key); unit.members.forEach(e => memberIds.add(e.id));
    const result = resolveUnitSpine(unit, axis, ctx, choices[unit.key]);
    if (result.landmark) landmarks.push(result.landmark);
    else issues.push({ unitKey: unit.key, reason: result.reason ?? 'Spine unavailable' });
  }
  const reference = landmarks.find(l => l.unitKey === referenceKey);
  if (!reference) issues.push({ unitKey: referenceKey, reason: 'Choose an eligible reference unit' });
  if (issues.length || !reference) return { translations: [], landmarks, issues };
  const coordinates = new Map(landmarks.map(l => [l.unitKey, l.coordinate]));
  const translations = units.flatMap(unit => {
    const delta = reference.coordinate - coordinates.get(unit.key)!;
    return unit.members.map(e => ({ id: e.id, dx: axis === 'y' ? delta : 0, dy: axis === 'x' ? delta : 0 }));
  });
  return { translations, landmarks, issues: [] };
}
