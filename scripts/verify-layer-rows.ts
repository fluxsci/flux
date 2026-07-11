#!/usr/bin/env -S npx tsx
// WS-1 Fix 6a — parity + semantics for the pure layer-rows selector
// (src/lib/figure/derived/layerRows.ts), which replaced Sidebar.svelte's
// component-local buildRows. The ORACLE below is a literal copy of the
// original component algorithm (per-group membersDeep and all); the selector
// must produce deep-identical rows on every fixture, including group-free,
// nested, collapsed, hidden, dangling-groupId, and straggler shapes.
//   npx tsx scripts/verify-layer-rows.ts

import type { Element, Figure, GroupDef } from "../src/lib/types";
import { membersDeep, buildRenderTree, type RenderNode } from "../src/lib/groups";
import { deriveLayerRows, type LayerRow } from "../src/lib/figure/derived/layerRows";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// ---- ORACLE: the original Sidebar.svelte buildRows, verbatim ----------------
function oracleBuildRows(fig: Figure, collapsedSet: Record<string, boolean>): LayerRow[] {
  const out: LayerRow[] = [];
  const zIndex = new Map(fig.elements.map((e, i) => [e.id, i]));
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
          dim: ancestorHidden || !!n.el.hidden,
        });
        continue;
      }
      const members = membersDeep(fig, n.def.id);
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

// ---- fixtures ----------------------------------------------------------------
const rect = (id: string, over: Partial<Element> = {}): Element =>
  ({ type: "rect", id, x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#000", stroke: "#000", strokeWidth: 1, cornerRadius: 0, ...over }) as Element;
const figOf = (elements: Element[], groups?: Record<string, GroupDef>): Figure => ({
  id: "f1",
  canvasId: "c1",
  name: "F",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  elements,
  ...(groups ? { groups } : {}),
});

const fixtures: { name: string; fig: Figure; collapsed: Record<string, boolean> }[] = [
  { name: "empty figure", fig: figOf([]), collapsed: {} },
  { name: "flat, no groups", fig: figOf([rect("a"), rect("b"), rect("c", { hidden: true })]), collapsed: {} },
  {
    name: "nested groups (expanded)",
    fig: figOf(
      [rect("a", { groupId: "g1" }), rect("b", { groupId: "g2" }), rect("c", { groupId: "g2" }), rect("d")],
      {
        g1: { id: "g1", name: "Outer" },
        g2: { id: "g2", name: "Inner", parentId: "g1" },
      },
    ),
    collapsed: {},
  },
  {
    name: "nested groups (outer collapsed)",
    fig: figOf(
      [rect("a", { groupId: "g1" }), rect("b", { groupId: "g2" }), rect("c", { groupId: "g2" }), rect("d")],
      {
        g1: { id: "g1", name: "Outer" },
        g2: { id: "g2", name: "Inner", parentId: "g1" },
      },
    ),
    collapsed: { g1: true },
  },
  {
    name: "hidden group dims members; hidden element dims itself",
    fig: figOf(
      [rect("a", { groupId: "g1" }), rect("b", { groupId: "g1", hidden: true }), rect("c", { hidden: true })],
      { g1: { id: "g1", name: "G", hidden: true } },
    ),
    collapsed: {},
  },
  {
    name: "locked group + empty-ish registry entry",
    fig: figOf([rect("a", { groupId: "g1" }), rect("b")], {
      g1: { id: "g1", name: "G", locked: true },
      gGhost: { id: "gGhost", name: "Ghost" }, // no members anywhere
    }),
    collapsed: {},
  },
  {
    name: "dangling groupId (loose tolerance)",
    fig: figOf([rect("a", { groupId: "nope" }), rect("b")]),
    collapsed: {},
  },
  {
    name: "straggler violating z-contiguity",
    fig: figOf(
      [rect("a", { groupId: "g1" }), rect("x"), rect("b", { groupId: "g1" })], // g1 run interrupted
      { g1: { id: "g1", name: "G" } },
    ),
    collapsed: {},
  },
];

console.log("— parity: deriveLayerRows ≡ original component algorithm —");
for (const f of fixtures) {
  const a = JSON.stringify(oracleBuildRows(f.fig, f.collapsed));
  const b = JSON.stringify(deriveLayerRows(f.fig, f.collapsed));
  assert(a === b, `${f.name}: identical rows`);
}

console.log("— semantics —");
{
  const f = fixtures[2]; // nested expanded
  const rows = deriveLayerRows(f.fig, f.collapsed);
  assert(rows[0].kind === "el" && rows[0].key === "e:d", "top-z row first (loose element d)");
  const g1 = rows.find((r) => r.key === "g:g1");
  assert(!!g1 && g1.kind === "group" && g1.memberIds.length === 3, "outer group carries deep member ids (a,b,c)");
  const g2 = rows.find((r) => r.key === "g:g2");
  assert(!!g2 && g2.depth === 1, "nested group indents one level");
  const inner = rows.filter((r) => r.kind === "el" && (r.key === "e:b" || r.key === "e:c"));
  assert(inner.every((r) => r.depth === 2), "inner members indent two levels");
}
{
  const f = fixtures[3]; // outer collapsed
  const rows = deriveLayerRows(f.fig, f.collapsed);
  assert(rows.length === 2, "collapsed outer group shows only its header + the loose element");
  assert(!rows.some((r) => r.key === "e:a" || r.key === "g:g2"), "collapsed group's children absent");
}
{
  const f = fixtures[4]; // hidden dims
  const rows = deriveLayerRows(f.fig, f.collapsed);
  const a = rows.find((r) => r.key === "e:a");
  assert(!!a && a.dim, "member of hidden group dims via ancestor");
  const g = rows.find((r) => r.key === "g:g1");
  assert(!!g && g.dim, "hidden group row dims itself");
}
{
  // scale sanity: derive on a 5k-element figure with 50 groups stays well under a frame
  const els: Element[] = [];
  const groups: Record<string, GroupDef> = {};
  for (let g = 0; g < 50; g++) {
    groups["g" + g] = { id: "g" + g, name: "G" + g };
    for (let i = 0; i < 100; i++) els.push(rect(`e${g}-${i}`, { groupId: "g" + g }));
  }
  const big = figOf(els, groups);
  const t0 = performance.now();
  const rows = deriveLayerRows(big, {});
  const ms = performance.now() - t0;
  assert(rows.length === 5050, `5k elements + 50 groups → 5050 rows`);
  assert(ms < 100, `derive at 5k elements in ${ms.toFixed(1)}ms (<100ms)`);
}

console.log(failures ? `\nLAYER ROWS: FAIL (${failures})` : "\nLAYER ROWS: PASS");
process.exit(failures ? 1 : 0);
