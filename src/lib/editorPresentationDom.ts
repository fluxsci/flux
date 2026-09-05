import { tick } from "svelte";

interface PartDisplay {
  elementId: string;
  states?: Record<string, { visible?: boolean; opacity?: number }>;
  ghost?: boolean;
  generation?: number;
}

/** Apply derived part visibility after plot mounting, preserving authored
 *  styles. Restore only styles this action owns and ignore detached clones. */
export function presentEditorParts(host: SVGGElement, initial: PartDisplay) {
  let params = initial;
  let generation = 0;
  const originals = new Map<SVGElement, { opacity: string; pointerEvents: string }>();
  function restore() {
    for (const [node, style] of originals) {
      node.style.opacity = style.opacity;
      node.style.pointerEvents = style.pointerEvents;
    }
    originals.clear();
  }
  async function apply() {
    const current = ++generation;
    await tick();
    if (current !== generation) return;
    restore();
    for (const [partId, state] of Object.entries(params.states ?? {})) {
      const node = host.querySelector<SVGElement>(`[id="${CSS.escape(`${params.elementId}__${partId}`)}"]`);
      if (!node) continue;
      originals.set(node, { opacity: node.style.opacity, pointerEvents: node.style.pointerEvents });
      const hidden = state.visible === false || state.opacity === 0;
      const authored = node.style.opacity ? Number(node.style.opacity) : Number(node.getAttribute("opacity") ?? 1);
      node.style.opacity = String(hidden && params.ghost ? 0.25 : (hidden ? 0 : state.opacity ?? 1) * (Number.isFinite(authored) ? authored : 1));
      if (hidden && !params.ghost) node.style.pointerEvents = "none";
    }
  }
  void apply();
  return {
    update(next: PartDisplay) {
      const changed = next.states !== params.states || next.elementId !== params.elementId || next.ghost !== params.ghost || next.generation !== params.generation;
      params = next;
      if (changed) void apply();
    },
    destroy() { generation++; restore(); },
  };
}
