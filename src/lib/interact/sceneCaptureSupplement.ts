// Complete a bounded viewport snapshot with a few culled placements from frames
// already in its live SVG. This builds detached markup only; it never changes
// culling, mounts a component, changes the model or creates per-figure rasters.
import { elementToSvg } from '../export';
import { effectiveHidden } from '../groups';
import { assetDisplaySize } from '../ops';
import { dataUrlToBytes } from '../assets';
import { buildPlotMarkup } from '../plot/inlineMarkup';
import { xmlEscape } from '../xml';
import type { Asset, Element as ModelElement, Figure, Project } from '../types';
import type { FluxPlotManifest } from '../plot/types';
import type { DeckTheme } from '../slide/types';

export const SNAPSHOT_SUPPLEMENT_LIMITS = Object.freeze({ placements: 32, sourceBytes: 2 * 1024 * 1024, nodes: 10_000, sceneNodes: 150_000 });
export interface SnapshotSupplement {
  before: Map<Node, string>;
  after: Map<Node, string>;
  append: Map<Node, string>;
  capturedExtraIDs: Map<string, Set<string>>;
  nodeEstimate: number;
  preparedCount: number;
}
export interface SnapshotSupplementOptions {
  sceneSvg: SVGSVGElement;
  figures: readonly Figure[];
  assets: readonly Asset[];
  assetData: Readonly<Record<string, string>>;
  manifests: Readonly<Record<string, FluxPlotManifest>>;
  baseNodes: number;
  current: () => boolean;
  yield?: () => Promise<void>;
  theme?: DeckTheme | null;
  presentation?: unknown;
}
const nodeCount = (markup: string) => (markup.match(/<[A-Za-z][\w:.-]*(?=[\s/>])/g) ?? []).length;
/** Bound manifest/model traversal BEFORE buildPlotMarkup's JSON cache key. A
 * giant data-bearing sidecar must not create a synchronous stringify here. */
function boundedJsonBytes(value: unknown, max: number): number | null {
  const encoder = new TextEncoder(), stack = [value], seen = new Set<object>();
  let bytes = 0, visits = 0;
  while (stack.length) {
    if (++visits > 100_000) return null;
    const item = stack.pop();
    if (item === undefined) continue;
    if (item === null) bytes += 4;
    else if (typeof item === 'string') {
      if (item.length > max) return null;
      bytes += encoder.encode(JSON.stringify(item)).length;
    } else if (typeof item === 'number') { if (!Number.isFinite(item)) return null; bytes += 24; }
    else if (typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'object') {
      if (seen.has(item)) return null; seen.add(item);
      if (Array.isArray(item)) { bytes += item.length + 2; if (item.length > 100_000) return null; for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]); }
      else {
        const keys = Object.keys(item); bytes += keys.length * 4 + 2;
        for (const key of keys) { bytes += encoder.encode(key).length; stack.push((item as Record<string, unknown>)[key]); }
      }
    } else return null;
    if (bytes > max) return null;
  }
  return bytes;
}
function sourceBytes(data: string, remaining: number): Uint8Array | null {
  // Reject an oversized base64 source before allocating its decoded copy.
  if (!data.startsWith('data:') || data.length > remaining * 4 / 3 + 256) return null;
  try { const bytes = dataUrlToBytes(data); return bytes.length <= remaining ? bytes : null; } catch { return null; }
}
const empty = (): SnapshotSupplement => ({ before: new Map(), after: new Map(), append: new Map(), capturedExtraIDs: new Map(), nodeEstimate: 0, preparedCount: 0 });

export async function prepareSnapshotSupplement(options: SnapshotSupplementOptions): Promise<SnapshotSupplement | null> {
  try { return await prepareSupplement(options); } catch { return null; }
}
async function prepareSupplement(options: SnapshotSupplementOptions): Promise<SnapshotSupplement | null> {
  const { sceneSvg, current } = options;
  const valid = () => current() && sceneSvg.isConnected;
  if (!valid() || !Number.isFinite(options.baseNodes) || options.baseNodes < 0 || options.baseNodes > SNAPSHOT_SUPPLEMENT_LIMITS.sceneNodes) return null;
  const frameNodes = new Map(Array.from(sceneSvg.querySelectorAll('[data-annotation-figure]')).map(n => [n.getAttribute('data-annotation-figure'), n]));
  type Placement = { figure: Figure; element: ModelElement; layer: globalThis.Element; next: globalThis.Element | null; svg?: string };
  const missing: Placement[] = [];
  for (const figure of options.figures) {
    const frame = frameNodes.get(figure.id); if (!frame) continue; // never add a new frame
    const layer = Array.from(frame.children).find(n => n.localName === 'g' && n.hasAttribute('clip-path'));
    if (!layer) return null;
    const wrappers = new Map(Array.from(layer.children).filter(n => n.classList.contains('el') && n.hasAttribute('data-editor-element-id')).map(n => [n.getAttribute('data-editor-element-id')!, n]));
    const eligible = figure.elements.filter(element => !effectiveHidden(figure, element));
    if ([...wrappers.keys()].some(id => !eligible.some(element => element.id === id))) return null;
    let next: globalThis.Element | null = null;
    for (let i = eligible.length - 1; i >= 0; i--) {
      const element = eligible[i], wrapper = wrappers.get(element.id);
      if (wrapper) next = wrapper;
      else missing.push({ figure, element, layer, next });
    }
  }
  if (!missing.length) return empty();
  // The existing export seam does not apply Slide theme/presentation states.
  // A precise current live view is preferable to a guessed supplement.
  if (options.theme || options.presentation || missing.length > SNAPSHOT_SUPPLEMENT_LIMITS.placements) return null;
  // Reverse discovery restores the model's z order inside each figure. Figure
  // groups are a flat contiguous ordering; effectiveHidden covers group eyes.
  missing.reverse();
  let bytes = 0, estimatedNodes = 0;
  const encoder = new TextEncoder();
  for (const placement of missing) {
    if (!valid()) return null;
    const element = placement.element;
    if (element.type === 'model3d') return null;
    const modelBytes = boundedJsonBytes(element, SNAPSHOT_SUPPLEMENT_LIMITS.sourceBytes - bytes);
    if (modelBytes === null) return null; bytes += modelBytes;
    if (element.type === 'plot' || element.type === 'image' || element.type === 'video') {
      const id = element.type === 'video' ? element.posterAssetId : element.assetId;
      const data = options.assetData[id]; if (!data) return null;
      const raw = sourceBytes(data, SNAPSHOT_SUPPLEMENT_LIMITS.sourceBytes - bytes); if (!raw) return null;
      bytes += raw.length;
      if (element.type === 'plot') {
        if (!/^data:image\/svg\+xml[;,]/i.test(data)) return null;
        const manifestBytes = boundedJsonBytes(options.manifests[id], SNAPSHOT_SUPPLEMENT_LIMITS.sourceBytes - bytes);
        if (manifestBytes === null) return null; bytes += manifestBytes;
        placement.svg = new TextDecoder().decode(raw);
        estimatedNodes += nodeCount(placement.svg) + 3;
      } else {
        // SVG-backed image fallbacks cannot honor semantic overrides and are
        // deliberately not decoded by the dense child's resource policy.
        if (!/^data:image\/(?:png|jpe?g|gif);base64,/i.test(data)) return null;
        estimatedNodes += 4;
      }
    } else if (element.type === 'text') estimatedNodes += (element.text.match(/\n/g)?.length ?? 0) + (element.runs?.length ?? 0) + 4;
    else estimatedNodes += 8;
    if (bytes > SNAPSHOT_SUPPLEMENT_LIMITS.sourceBytes || estimatedNodes > SNAPSHOT_SUPPLEMENT_LIMITS.nodes || options.baseNodes + estimatedNodes > SNAPSHOT_SUPPLEMENT_LIMITS.sceneNodes) return null;
  }
  const result = empty(), yieldWork = options.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let outputBytes = 0;
  for (const { figure, element, layer, next, svg } of missing) {
    await yieldWork(); if (!valid()) return null;
    let plotMarkup: string | undefined;
    if (element.type === 'plot') {
      plotMarkup = buildPlotMarkup(svg!, element, element.overrides, options.manifests[element.assetId]) ?? undefined;
      if (!plotMarkup) return null;
      // Match mountPlot's explicit overflow policy. This remains disconnected;
      // reading styles/layout from a hidden temporary mount is not involved.
      const root = new DOMParser().parseFromString(plotMarkup, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
      if (root.localName !== 'svg' || root.querySelector('parsererror')) return null;
      root.style.setProperty('overflow', element.crop ? 'hidden' : 'visible');
      plotMarkup = typeof XMLSerializer === 'undefined' ? String(root) : new XMLSerializer().serializeToString(root);
    }
    // ElementView owns one opacity group around every kind. Clear the field
    // before the export writer so primitives cannot receive opacity twice.
    const paint = elementToSvg({ ...element, opacity: undefined }, id => options.assetData[id], () => plotMarkup,
      id => assetDisplaySize({ assets: options.assets } as Project, id), undefined, figure.background);
    if (!paint || /\b(?:var|env)\s*\(|<foreignObject\b/i.test(paint)) return null;
    const markup = `<g data-editor-element-id="${xmlEscape(element.id)}" opacity="${element.opacity ?? 1}">${paint}</g>`;
    const nodes = nodeCount(markup); outputBytes += encoder.encode(markup).length;
    result.nodeEstimate += nodes;
    if (result.nodeEstimate > SNAPSHOT_SUPPLEMENT_LIMITS.nodes || options.baseNodes + result.nodeEstimate > SNAPSHOT_SUPPLEMENT_LIMITS.sceneNodes || outputBytes > SNAPSHOT_SUPPLEMENT_LIMITS.sourceBytes || !valid()) return null;
    const map = next ? result.before : result.append, target = next ?? layer;
    map.set(target, (map.get(target) ?? '') + markup);
    let ids = result.capturedExtraIDs.get(figure.id);
    if (!ids) result.capturedExtraIDs.set(figure.id, ids = new Set());
    ids.add(element.id); result.preparedCount++;
  }
  return valid() ? result : null;
}
