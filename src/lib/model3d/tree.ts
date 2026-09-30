/** Pure semantic tree, shared with X-ray and headless inspection. */
import type { Model3dInfo, Scene3dManifest } from './types';
import type { XrayNode } from '../plot/tree';
import { buildScene3dPartIndex } from './parts';
/** Furniture rows name what they ARE before what they say: a bare "1 µm" or a
 *  "Height" next to the field "height" is ambiguous in a part tree. */
const ROLE_NOUN: Record<string, string> = {
  scalebar: 'Scale bar', colorbar: 'Colorbar', legend: 'Legend', title: 'Title', subtitle: 'Subtitle',
  'axis-title': 'Axis title', 'tick-label': 'Tick labels', tick: 'Ticks', gridline: 'Gridlines', pane: 'Panes', axis: 'Axis',
  'surface-field': 'Field', 'surface-missing': 'Missing values',
};
function partLabel(part: ReturnType<typeof buildScene3dPartIndex>[string]): string {
  const own = part.label ?? (typeof part.field === 'object' ? part.field.label : undefined) ?? part.text;
  const noun = ROLE_NOUN[part.role];
  if (!noun) return own ?? part.id;
  return own && own !== noun ? `${noun} · ${own}` : noun;
}
export function buildModel3dTree(manifest?: Scene3dManifest, info?: Pick<Model3dInfo, 'partNames'>): XrayNode {
  const root: XrayNode = { id: '@model', role: 'model3d', kind: 'container', label: '3D model', isGroup: true, targets: [], children: [] };
  if (!manifest) {
    root.children = [...new Set(info?.partNames ?? [])].map(id => ({ id, role: 'mesh', kind: 'shape' as const, label: id, isGroup: false, targets: [id], children: [] }));
    root.targets = root.children.map(n => n.id); return root;
  }
  const index = buildScene3dPartIndex(manifest), nodes = new Map<string, XrayNode>();
  for (const part of Object.values(index)) nodes.set(part.id, { id: part.id, role: part.role, kind: 'shape', label: partLabel(part), isGroup: false, targets: part.synthetic ? [] : [part.id], children: [] });
  for (const part of Object.values(index)) {
    const node = nodes.get(part.id)!;
    const parent = part.parent ? nodes.get(part.parent) : root;
    if (!parent) throw new Error(`Missing 3D part parent ${part.parent}`);
    parent.children.push(node); parent.isGroup = true;
  }
  for (const part of Object.values(index)) if (nodes.get(part.id)!.children.length && !part.node) nodes.get(part.id)!.targets = [];
  // Iterative traversal makes even deep authored parent chains stack-safe.
  const order: XrayNode[] = [], queue = [root], seen = new Set<XrayNode>();
  while (queue.length) { const node = queue.pop()!; if (seen.has(node)) throw new Error('Cyclic 3D part tree'); seen.add(node); order.push(node); for (const child of node.children) queue.push(child); }
  if (seen.size !== nodes.size + 1) throw new Error('Cyclic 3D part tree');
  for (let i = order.length - 1; i >= 0; i--) { const node = order[i]; for (const child of node.children) for (const target of child.targets) node.targets.push(target); }
  return root;
}
