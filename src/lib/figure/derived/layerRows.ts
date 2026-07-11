// ---------------------------------------------------------------------------
// Pure selector for the Layers-sidebar rows (WS-1 Fix 6a, fortify plan).
//
// Extracted verbatim-in-behavior from Sidebar.svelte's component-local
// buildRows so (a) the row model is unit-testable without a DOM
// (scripts/verify-layer-rows.ts pins parity against the original algorithm),
// and (b) the walk builds its group-membership map ONCE per call instead of
// calling membersDeep per group row (which re-scanned all elements × chain
// depth for every group).
//
// Framework-free: types + groups helpers only — no Svelte, no DOM.
// ---------------------------------------------------------------------------

import type { Element, Figure, GroupDef, Id } from "../../types";
import { ancestorsOf, buildRenderTree, type RenderNode } from "../../groups";

export type LayerRow =
  | { kind: "el"; key: string; el: Element; depth: number; zTop: number; zBottom: number; dim: boolean }
  | {
      kind: "group";
      key: string;
      def: GroupDef;
      depth: number;
      zTop: number;
      zBottom: number;
      memberIds: string[];
      collapsed: boolean;
      dim: boolean;
    };

/** Flatten the figure's render tree into sidebar rows, top-z first, depth-
 *  indented; collapsed groups contribute their header row only. `dim` carries
 *  effective (own-or-ancestor) hidden state for row styling. */
export function deriveLayerRows(fig: Figure, collapsedSet: Record<string, boolean>): LayerRow[] {
  const out: LayerRow[] = [];
  const zIndex = new Map(fig.elements.map((e, i) => [e.id, i]));
  // Deep membership per group in ONE pass over elements (z-ascending order —
  // identical to membersDeep's filter order, without the per-group rescan).
  const membersByGroup = new Map<Id, Element[]>();
  for (const e of fig.elements) {
    for (const gid of ancestorsOf(fig, e.groupId)) {
      let arr = membersByGroup.get(gid);
      if (!arr) membersByGroup.set(gid, (arr = []));
      arr.push(e);
    }
  }
  const walk = (nodes: RenderNode[], depth: number, ancestorHidden: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.kind === "element") {
        const z = zIndex.get(n.el.id) ?? 0;
        out.push({
          kind: "el",
          key: "e:" + n.el.id,
          el: n.el,
          depth,
          zTop: z,
          zBottom: z,
          dim: ancestorHidden || !!n.el.hidden, // effectiveHidden dimming
        });
        continue;
      }
      const members = membersByGroup.get(n.def.id) ?? [];
      const zs = members.map((m) => zIndex.get(m.id) ?? 0);
      const dim = ancestorHidden || !!n.def.hidden;
      const isCollapsed = !!collapsedSet[n.def.id];
      out.push({
        kind: "group",
        key: "g:" + n.def.id,
        def: n.def,
        depth,
        zTop: zs.length ? Math.max(...zs) : 0,
        zBottom: zs.length ? Math.min(...zs) : 0,
        memberIds: members.map((m) => m.id),
        collapsed: isCollapsed,
        dim,
      });
      if (!isCollapsed) walk(n.children, depth + 1, dim);
    }
  };
  walk(buildRenderTree(fig), 0, false);
  return out;
}
