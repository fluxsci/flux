/** Apply direct-manipulation transforms only to the affected scene wrappers.
 * Keeping the live transform out of the keyed element template avoids waking
 * every mounted element for each pointer movement. Geometry stays in the model
 * until the single release commit; these CSS transforms are disposable. */
export function transientSceneTransforms() {
  const nodes = new Map<string, SVGGElement>();
  let transforms = new Map<string, string>();
  const apply = (id: string, node: SVGGElement) => {
    const transform = transforms.get(id) ?? '';
    node.style.transform = transform;
    node.style.willChange = transform ? 'transform' : '';
  };
  return {
    register(node: SVGGElement, id: string) {
      nodes.set(id, node);
      apply(id, node);
      return { destroy() { if (nodes.get(id) === node) nodes.delete(id); } };
    },
    update(move: ReadonlySet<string> | null, moveTransform: string, rotate: ReadonlySet<string> | null, rotateTransform: string) {
      const previous = transforms;
      transforms = new Map();
      for (const id of rotate ?? []) transforms.set(id, rotateTransform);
      for (const id of move ?? []) transforms.set(id, moveTransform);
      for (const id of new Set([...previous.keys(), ...transforms.keys()])) {
        if (previous.get(id) === transforms.get(id)) continue;
        const node = nodes.get(id);
        if (node) apply(id, node);
      }
    },
  };
}
