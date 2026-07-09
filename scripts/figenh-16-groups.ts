#!/usr/bin/env -S npx tsx
// figure-v1 P7 (pure) — named nestable groups: the registry model (types.ts
// GroupDef + Figure.groups), the pure derivation module (src/lib/groups.ts),
// the ops that write it (group/ungroup/rename/setGroupState/delete-GC/
// group-aware reorder+z-order/duplicate-clone), and the load-time migration
// (legacy flat groupIds → synthesized defs + z-contiguity, idempotent).
//   Run: npx tsx scripts/figenh-16-groups.ts
import type { Element, Figure, Project } from "../src/lib/types";
import * as ops from "../src/lib/ops";
import {
  ancestorsOf,
  buildRenderTree,
  chainOf,
  cloneGroupsFor,
  effectiveHidden,
  effectiveLocked,
  enforceZContiguity,
  figureGroupTree,
  gcGroups,
  groupIndex,
  membersDeep,
  topGroupOf,
  unitKeyOf,
} from "../src/lib/groups";
import { migrateProject } from "../src/lib/migrate";
import { figureToSvg } from "../src/lib/export";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const rect = (id: string, x: number, fill = "#888888"): Element =>
  ({ type: "rect", id, x, y: 20, width: 60, height: 40, rotation: 0, fill, stroke: "#222222", strokeWidth: 2, cornerRadius: 0 }) as Element;

function proj(els: Element[]): { p: Project; f: Figure } {
  const f: Figure = {
    id: "f1",
    name: "F",
    canvasId: "c1",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    background: "#ffffff",
    elements: els,
  };
  const p: Project = { version: 2, name: "t", canvases: [{ id: "c1", name: "C" }], figures: [f], assets: [], palette: [] };
  return { p, f };
}
const order = (f: Figure) => f.elements.map((e) => e.id);

// ---------------------------------------------------------------------------
console.log("1) group(): named registry entry + z-contiguity splice");
// ---------------------------------------------------------------------------
{
  // a and c are separated by x — grouping must splice them contiguous at the
  // TOPMOST member's index (c's slot), preserving relative order.
  const { p, f } = proj([rect("a", 0), rect("x", 60), rect("c", 120), rect("y", 180)]);
  const gid = ops.group(p, ["a", "c"])!;
  assert(!!gid, "group returns a gid");
  assert(f.groups?.[gid]?.name === "Group 1", `def registered + auto-named (${f.groups?.[gid]?.name})`);
  assert(eq(order(f), ["x", "a", "c", "y"]), `members spliced contiguous at topmost member (${order(f)})`);
  assert(f.elements.filter((e) => e.groupId === gid).length === 2, "both members carry the new groupId");
  assert(ops.group(p, ["a"]) === null, "single-unit group refused (null)");
  assert(ops.group(p, ["a", "c"]) === null, "grouping one whole existing group alone refused (1 unit)");

  const gid2 = ops.group(p, ["a", "y"], { name: "  Pair  " })!;
  assert(f.groups?.[gid2]?.name === "Pair", "explicit name trimmed + used");
  // a pulls in its WHOLE group (partial member selection expands to the unit)
  assert(membersDeep(f, gid2).length === 3 && f.groups?.[gid]?.parentId === gid2, "partial selection pulled the whole group in; old group NESTED via parentId");
  assert(eq(order(f), ["x", "a", "c", "y"]), `nesting splice kept z-order (${order(f)})`);
}

// ---------------------------------------------------------------------------
console.log("2) nesting semantics (⌘G on groups) + ancestry helpers");
// ---------------------------------------------------------------------------
{
  const { p, f } = proj([rect("a", 0), rect("b", 60), rect("c", 120), rect("d", 180)]);
  const g1 = ops.group(p, ["a", "b"], { name: "Inner" })!;
  const g2 = ops.group(p, ["a", "c"])!; // group-of-group: g1 nests under g2
  assert(f.groups?.[g1]?.parentId === g2, "selected top group nested (parentId → new gid)");
  assert(f.groups?.[g2]?.name === "Group 1", "auto-name counts only default-named defs");
  assert(eq(membersDeep(f, g2).map((e) => e.id), ["a", "b", "c"]), "membersDeep crosses nesting");
  assert(eq(chainOf(f, f.elements.find((e) => e.id === "a")!), [g2, g1]), "chainOf = [top..immediate]");
  assert(topGroupOf(f, g1) === g2 && topGroupOf(f, g2) === g2, "topGroupOf walks to the root");
  assert(eq(ancestorsOf(f, g1), [g1, g2]), "ancestorsOf = [self..root]");
  const idx = groupIndex(f);
  assert(eq(idx.roots, [g2]) && eq(idx.children.get(g2), [g1]), "groupIndex roots/children");
  assert(idx.members.get(g1)!.length === 2 && idx.members.get(g2)!.length === 1, "groupIndex immediate members");
  const tree = figureGroupTree(f);
  assert(tree.length === 1 && tree[0].id === g2 && tree[0].groups[0]?.id === g1 && eq(tree[0].groups[0].elementIds, ["a", "b"]) && eq(tree[0].elementIds, ["c"]), "figureGroupTree nests groups + element ids");

  // deeper: group the group-of-groups with d
  const g3 = ops.group(p, ["b", "d"])!;
  assert(f.groups?.[g2]?.parentId === g3, "third level nests the previous TOP group");
  assert(eq(membersDeep(f, g3).map((e) => e.id).sort(), ["a", "b", "c", "d"]), "membersDeep at depth 3");
}

// ---------------------------------------------------------------------------
console.log("3) ungroup: dissolve top-level, reparent children; gcGroups");
// ---------------------------------------------------------------------------
{
  const { p, f } = proj([rect("a", 0), rect("b", 60), rect("c", 120)]);
  const g1 = ops.group(p, ["a", "b"], { name: "Inner" })!;
  const g2 = ops.group(p, ["a", "c"], { name: "Outer" })!;
  ops.ungroup(p, ["c"]); // c's TOP group = g2 → dissolve it
  assert(!f.groups?.[g2], "top-level group def removed");
  assert(f.groups?.[g1] && f.groups[g1].parentId === undefined, "child group survived, reparented to top level");
  assert(f.elements.find((e) => e.id === "c")!.groupId === undefined, "direct member went loose");
  assert(f.elements.find((e) => e.id === "a")!.groupId === g1, "nested members untouched");

  // dissolving a NESTED group directly (group id) → members join the parent
  const g3 = ops.group(p, ["a", "c"], { name: "Outer2" })!;
  ops.ungroup(p, [g1]);
  assert(!f.groups?.[g1], "explicit group id dissolves exactly that group");
  assert(f.elements.find((e) => e.id === "a")!.groupId === g3, "its members moved to the PARENT group");

  // delete → gc: removing all members erases the def
  ops.deleteElements(p, ["a", "b", "c"]);
  assert(!f.groups || !f.groups[g3], "deleteElements gc'd the emptied group def");
}

// ---------------------------------------------------------------------------
console.log("4) rename + group state + effectiveHidden/Locked + export hook");
// ---------------------------------------------------------------------------
{
  const { p, f } = proj([rect("a", 0, "#d62728"), rect("b", 60, "#2ca02c"), rect("c", 120, "#1f77b4")]);
  const g1 = ops.group(p, ["a", "b"], { name: "Pair" })!;
  const g2 = ops.group(p, ["a", "c"], { name: "All" })!;
  assert(ops.renameGroup(p, g1, "Panel A"), "renameGroup returns true");
  assert(f.groups?.[g1]?.name === "Panel A", "name updated");
  assert(!ops.renameGroup(p, "nope", "X") && !ops.renameGroup(p, g1, "   "), "unknown id / blank name refused");

  assert(ops.setGroupState(p, g2, { hidden: true }), "setGroupState hidden");
  const a = f.elements.find((e) => e.id === "a")!;
  assert(!a.hidden && effectiveHidden(f, a), "member effectiveHidden via ANCESTOR (own flag untouched)");
  const svg = figureToSvg(f, () => undefined);
  assert(!svg.includes("#d62728") && !svg.includes("#1f77b4"), "figureToSvg omits members of a hidden group");
  ops.setGroupState(p, g2, { hidden: false });
  assert(f.groups?.[g2]?.hidden === undefined, "hidden=false deletes the flag");
  assert(figureToSvg(f, () => undefined).includes("#d62728"), "…and export shows them again");

  ops.setGroupState(p, g1, { locked: true });
  assert(effectiveLocked(f, a) && !a.locked, "effectiveLocked via ancestor");
  assert(!effectiveLocked(f, f.elements.find((e) => e.id === "c")!), "sibling outside the locked group unaffected");
}

// ---------------------------------------------------------------------------
console.log("5) cloneGroupsFor: duplicate + duplicateFigure + paste-shape");
// ---------------------------------------------------------------------------
{
  const { p, f } = proj([rect("a", 0), rect("b", 60), rect("c", 120)]);
  const g1 = ops.group(p, ["a", "b"], { name: "Inner" })!;
  const g2 = ops.group(p, ["a", "c"], { name: "Outer" })!;

  // ops.duplicateElements → fresh ids, names+nesting preserved
  const dupIds = ops.duplicateElements(p, "f1", ["a", "b", "c"], { dx: 10, dy: 10 });
  assert(dupIds.length === 3, "duplicate made 3 copies");
  const copyA = f.elements.find((e) => e.id === dupIds[0])!;
  const cg1 = copyA.groupId!;
  assert(cg1 && cg1 !== g1, "copies got a FRESH immediate group id");
  assert(f.groups?.[cg1]?.name === "Inner", "cloned def keeps the name");
  const cg2 = f.groups?.[cg1]?.parentId;
  assert(!!cg2 && cg2 !== g2 && f.groups?.[cg2!]?.name === "Outer", "nesting cloned with fresh parent id");
  assert(eq(membersDeep(f, cg2!).map((e) => e.id).sort(), [...dupIds].sort()), "cloned group contains exactly the copies");
  assert(membersDeep(f, g2).length === 3, "original group untouched");

  // ops.duplicateFigure → whole registry cloned
  const fig2Id = ops.duplicateFigure(p, "f1")!;
  const f2 = p.figures.find((ff) => ff.id === fig2Id)!;
  assert(Object.keys(f2.groups ?? {}).length === Object.keys(f.groups ?? {}).length, "duplicateFigure cloned the registry");
  assert(!Object.keys(f2.groups ?? {}).some((gid) => f.groups?.[gid]), "…with fully fresh group ids");
  const names = Object.values(f2.groups ?? {}).map((g) => g.name).sort();
  assert(eq(names, Object.values(f.groups ?? {}).map((g) => g.name).sort()), "…names preserved");
  assert(f2.elements.every((e) => !e.groupId || f2.groups?.[e.groupId]), "every copied groupId resolves in the copied registry");

  // paste-path shape: cloneGroupsFor over a SNAPSHOT registry (what keyboard.ts does)
  const snapshot = structuredClone(f.groups!);
  const clip = [structuredClone(f.elements.find((e) => e.id === "a")!)];
  const remap = new Map<string, string>();
  const cloned = cloneGroupsFor(snapshot, clip, remap);
  assert(remap.has(g1) && remap.has(g2), "paste remaps the full ancestor chain");
  assert(cloned[remap.get(g1)!].name === "Inner" && cloned[remap.get(g1)!].parentId === remap.get(g2), "paste clones defs with remapped nesting");

  // dangling tolerance (Canvas performAltDup residual): remapped but no def
  const loose: Element = { ...rect("z", 500), groupId: "grp_dangling" } as Element;
  const remap2 = new Map<string, string>();
  const cloned2 = cloneGroupsFor(f.groups, [loose], remap2);
  assert(remap2.has("grp_dangling") && Object.keys(cloned2).length === 0, "dangling groupId: remapped for co-selection, no def cloned");
}

// ---------------------------------------------------------------------------
console.log("6) group-aware reorderElement / setZOrder never fragment runs");
// ---------------------------------------------------------------------------
{
  const { p, f } = proj([rect("a", 0), rect("g1a", 60), rect("g1b", 120), rect("b", 180)]);
  const g1 = ops.group(p, ["g1a", "g1b"])!;
  assert(eq(order(f), ["a", "g1a", "g1b", "b"]), "baseline order");

  // loose element into the middle of a run → snaps to a boundary
  ops.reorderElement(p, "f1", "a", 2);
  const runIdx = () => f.elements.map((e, i) => (e.groupId === g1 ? i : -1)).filter((i) => i >= 0);
  let ri = runIdx();
  assert(ri[1] - ri[0] === 1, `run stays contiguous after loose-element reorder (${order(f)})`);

  // move the WHOLE group by its id to the bottom
  ops.reorderElement(p, "f1", g1, 0);
  ri = runIdx();
  assert(ri[0] === 0 && ri[1] === 1, `group id moves the whole run (${order(f)})`);

  // an element inside a group stays inside its run
  ops.reorderElement(p, "f1", "g1a", 3);
  ri = runIdx();
  assert(ri[1] - ri[0] === 1, `member reorder clamped inside its own run (${order(f)})`);
  assert(eq(order(f).slice(0, 2).sort(), ["g1a", "g1b"]), "members swapped within the run");

  // setZOrder: whole-group front/back + unit bump
  ops.setZOrder(p, "f1", ["g1a", "g1b"], "front");
  assert(eq(order(f).slice(-2).sort(), ["g1a", "g1b"]), `group to front as a block (${order(f)})`);
  ops.setZOrder(p, "f1", ["g1a", "g1b"], "backward");
  ri = runIdx();
  assert(ri[1] - ri[0] === 1, `backward bump keeps the block intact (${order(f)})`);
  ops.setZOrder(p, "f1", ["g1a", "g1b"], "back");
  assert(eq(order(f).slice(0, 2).sort(), ["g1a", "g1b"]), `group to back as a block (${order(f)})`);

  // bump INSIDE a group: partial selection reorders within the run only
  assert(eq(order(f).slice(0, 2), ["g1b", "g1a"]), `pre-bump run order (${order(f)})`);
  ops.setZOrder(p, "f1", ["g1a"], "backward");
  assert(eq(order(f).slice(0, 2), ["g1a", "g1b"]), `within-group backward bump swapped members (${order(f)})`);
  ops.setZOrder(p, "f1", ["g1b"], "forward");
  assert(eq(order(f).slice(0, 2), ["g1a", "g1b"]), `forward bump at the run's top does NOT escape the group (${order(f)})`);
  ri = runIdx();
  assert(ri[1] - ri[0] === 1, "…and the run is still contiguous");

  // a foreign element can never be bumped INTO a run
  ops.setZOrder(p, "f1", ["a"], "backward");
  ri = runIdx();
  assert(ri[1] - ri[0] === 1, `foreign backward bump hops OVER the run (${order(f)})`);
}

// ---------------------------------------------------------------------------
console.log("7) buildRenderTree: z-order, nesting, straggler + dangling tolerance");
// ---------------------------------------------------------------------------
{
  const { p, f } = proj([rect("bg", 0), rect("a", 60), rect("b", 120), rect("c", 180)]);
  const g1 = ops.group(p, ["a", "b"], { name: "Inner" })!;
  const g2 = ops.group(p, ["a", "c"], { name: "Outer" })!;
  const tree = buildRenderTree(f);
  assert(tree.length === 2 && tree[0].kind === "element" && tree[1].kind === "group", "forest = [bg, Outer]");
  const outer = tree[1] as Extract<ReturnType<typeof buildRenderTree>[number], { kind: "group" }>;
  assert(outer.def.id === g2 && outer.children.length === 2, "outer group node holds [Inner, c]");
  assert(outer.children[0].kind === "group" && (outer.children[0] as { def: { id: string } }).def.id === g1, "nested group node first (z-order)");

  // straggler: force a non-contiguous member — renders loose, nothing lost
  const s = rect("straggler", 400) as Element & { groupId?: string };
  s.groupId = g1;
  f.elements.push(rect("sep", 300), s as Element);
  const t2 = buildRenderTree(f);
  const flat: string[] = [];
  const walk = (ns: ReturnType<typeof buildRenderTree>): void => {
    for (const n of ns) {
      if (n.kind === "element") flat.push(n.el.id);
      else walk(n.children);
    }
  };
  walk(t2);
  assert(flat.length === f.elements.length, "straggler tree keeps every element");
  assert(t2.some((n) => n.kind === "element" && n.el.id === "straggler"), "straggler renders as a LOOSE top-level node");

  // dangling groupId (performAltDup residual): loose in tree, keyed as one unit
  const d1 = { ...rect("d1", 500), groupId: "grp_missing" } as Element;
  const d2 = { ...rect("d2", 560), groupId: "grp_missing" } as Element;
  f.elements.push(d1, d2);
  const t3 = buildRenderTree(f);
  walk.length; // noop
  const topKinds = t3.map((n) => (n.kind === "element" ? n.el.id : "g"));
  assert(topKinds.includes("d1") && topKinds.includes("d2"), "dangling-group elements render loose (no crash)");
  assert(unitKeyOf(f, d1, null) === unitKeyOf(f, d2, null) && unitKeyOf(f, d1, null).startsWith("d:"), "…but share one anonymous unit key (co-selection preserved)");

  // gc tolerates + clears an empty def with a dangling parent
  f.groups!["grp_empty"] = { id: "grp_empty", name: "Empty", parentId: "grp_gone" };
  gcGroups(f);
  assert(!f.groups!["grp_empty"], "gcGroups drops memberless defs");
}

// ---------------------------------------------------------------------------
console.log("8) migration: legacy flat groupIds → synthesized defs, idempotent");
// ---------------------------------------------------------------------------
{
  // legacy doc: two flat groups, one interleaved (non-contiguous), no registry
  const els = [
    { ...rect("m1", 0), groupId: "legacy1" } as Element,
    rect("loose", 60),
    { ...rect("m2", 120), groupId: "legacy1" } as Element,
    { ...rect("n1", 180), groupId: "legacy2" } as Element,
    { ...rect("n2", 240), groupId: "legacy2" } as Element,
  ];
  const { p, f } = proj(els);
  (p as { version: number }).version = 1;
  migrateProject(p);
  assert(f.groups?.["legacy1"]?.name === "Group 1" && f.groups?.["legacy2"]?.name === "Group 2", "defs synthesized 'Group N' by first-seen order");
  assert(eq(order(f), ["m1", "m2", "loose", "n1", "n2"]), `z-contiguity enforced once (${order(f)})`);
  const snap = JSON.stringify(p);
  migrateProject(p);
  assert(JSON.stringify(p) === snap, "second migrate run is a byte-stable no-op (idempotent)");

  // registered ids pass through untouched; dangling parentId cleared
  const { p: p2, f: f2 } = proj([{ ...rect("q1", 0), groupId: "gq" } as Element, { ...rect("q2", 60), groupId: "gq" } as Element]);
  f2.groups = { gq: { id: "gq", name: "Kept", parentId: "gone" } };
  migrateProject(p2);
  assert(f2.groups?.["gq"]?.name === "Kept" && f2.groups["gq"].parentId === undefined, "existing def kept (name intact), dangling parentId cleared");
}

console.log(fails === 0 ? "\nFIGENH-16-GROUPS ALL PASS" : `\nFIGENH-16-GROUPS ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
