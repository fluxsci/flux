import type { FurnitureNode } from './furniture';
/** Reconcile stable keyed SVG nodes. No SVG serialization or layout measurement. */
export function paintFurniture(parent: SVGElement, nodes: readonly FurnitureNode[]): void {
  const existing = new Map([...parent.children].map(node => [node.getAttribute('data-furniture-key'), node as SVGElement]));
  let previous: SVGElement | null = null;
  for (const node of nodes) {
    let element = existing.get(node.key);
    if (element?.localName !== node.tag) { element?.remove(); element = undefined; }
    if (!element) element = document.createElementNS('http://www.w3.org/2000/svg', node.tag);
    existing.delete(node.key);
    for (const attr of [...element.attributes]) if (attr.name !== 'data-furniture-key' && !(attr.name in node.attrs)) element.removeAttribute(attr.name);
    element.setAttribute('data-furniture-key', node.key);
    for (const [key, value] of Object.entries(node.attrs)) if (element.getAttribute(key) !== String(value)) element.setAttribute(key, String(value));
    if (node.children) paintFurniture(element, node.children);
    else if (element.textContent !== (node.text ?? '')) element.textContent = node.text ?? '';
    const next: ChildNode | null = previous ? previous.nextSibling : parent.firstChild;
    if (next !== element) parent.insertBefore(element, next);
    previous = element;
  }
  for (const element of existing.values()) element.remove();
}
