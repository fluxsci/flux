#!/usr/bin/env -S npx tsx
// figure-v1 P7 (pure) — groups agent parity: the same ops core behind
//   • the live bridge (dispatchCommand): group {ids,name} → {groupId},
//     ungroup, rename_group, set_group_state, list_groups (read),
//     select {groupId} sugar — all undoable via the store;
//   • flux-core file verbs (mutateFigModel round-trip on a scratch project):
//     groupElements/ungroupElements/renameGroup/setGroupState/listGroups,
//     with renderFigureSvg honoring the group eye (effectiveHidden);
//   • the CLI binary (list-groups smoke);
//   • store.expandGroups deep/scoped expansion + the enteredGroupId plumbing.
//
//  Run: npx tsx scripts/figenh-16-parity.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "svelte/store";
import * as core from "../flux-core/index";
import * as ops from "../src/lib/ops";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import { getAppContext } from "../src/lib/bridge/appContext";
import type { Element, Project } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rect = (id: string, x: number, fill: string): Element =>
  ({ type: "rect", id, x, y: 20, width: 100, height: 80, rotation: 0, fill, stroke: "#222222", strokeWidth: 2, cornerRadius: 0 }) as Element;

// ---------------------------------------------------------------------------
console.log("1) live bridge on a headless store");
// ---------------------------------------------------------------------------
const proj: Project = {
  version: 2,
  name: "t",
  canvases: [{ id: "c1", name: "C" }],
  figures: [
    {
      id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 900, height: 500, background: "#ffffff",
      elements: [rect("r1", 10, "#d62728"), rect("mid", 130, "#999999"), rect("r2", 250, "#2ca02c"), rect("r3", 370, "#1f77b4")],
    },
  ],
  assets: [],
  palette: [],
};
store.loadProject(structuredClone(proj), null);
store.activeFigureId.set("f1");
const fig = () => get(store.project).figures[0];
const order = () => fig().elements.map((e) => e.id);

{
  // group by explicit ids + name → named def, z-splice, {groupId} returned
  const r = (await dispatchCommand({ type: "group", ids: ["r1", "r2"], name: "Panel A" })) as { groupId: string };
  assert(!!r.groupId, "bridge group returns {groupId}");
  const gid = r.groupId;
  assert(fig().groups?.[gid]?.name === "Panel A", "named def registered on the model");
  assert(eq(order(), ["mid", "r1", "r2", "r3"]), `members spliced z-contiguous (${order()})`);

  store.undo();
  assert(!fig().groups?.[gid] && eq(order(), ["r1", "mid", "r2", "r3"]), "group is ONE undoable edit (registry + order revert)");
  store.redo();
  assert(fig().groups?.[gid]?.name === "Panel A", "…and redo restores it");

  // select {groupId} sugar
  await dispatchCommand({ type: "select", groupId: gid });
  assert(eq([...get(store.selection)].sort(), ["r1", "r2"]), "select {groupId} selects the members (deep)");

  // rename_group
  await dispatchCommand({ type: "rename_group", groupId: gid, name: "Panel B" });
  assert(fig().groups?.[gid]?.name === "Panel B", "rename_group updates the def");
  let threw = "";
  try {
    await dispatchCommand({ type: "rename_group", groupId: "nope", name: "X" });
  } catch (err) {
    threw = String(err);
  }
  assert(/unknown group/.test(threw), "rename_group throws for an unknown id (no undo burned)");

  // set_group_state hidden → export drops members; appContext digests groups
  await dispatchCommand({ type: "set_group_state", groupId: gid, hidden: true });
  assert(fig().groups?.[gid]?.hidden === true, "set_group_state wrote hidden");
  const { figureToSvg } = await import("../src/lib/export");
  const svg = figureToSvg(fig(), () => undefined);
  assert(!svg.includes("#d62728") && !svg.includes("#2ca02c") && svg.includes("#1f77b4"), "figureToSvg omits the hidden group's members only");
  const ctx = getAppContext();
  const cg = ctx.activeFigure?.groups?.find((g) => g.id === gid);
  assert(!!cg && cg.name === "Panel B" && cg.hidden === true && cg.members === 2, "appContext digest carries the groups summary");
  assert(ctx.activeFigure?.elements.some((e) => e.groupId === gid), "appContext elements expose groupId");

  // list_groups (read)
  const lg = (await dispatchCommand({ type: "list_groups", figureId: "f1" })) as { groups: { id: string; name: string; members: string[] }[] };
  assert(lg.groups.length === 1 && lg.groups[0].id === gid && eq(lg.groups[0].members.sort(), ["r1", "r2"]), "list_groups returns name + member ids");

  // nesting through the bridge: group the group with r3
  await dispatchCommand({ type: "select", groupId: gid });
  const r2res = (await dispatchCommand({ type: "group", ids: ["r1", "r3"], name: "Outer" })) as { groupId: string };
  assert(fig().groups?.[gid]?.parentId === r2res.groupId, "grouping a group NESTS it (parentId)");

  // ungroup dissolves the TOP level; child reparents
  await dispatchCommand({ type: "ungroup", ids: ["r1"] });
  assert(!fig().groups?.[r2res.groupId], "ungroup dissolved the top group");
  assert(fig().groups?.[gid] && fig().groups?.[gid].parentId === undefined, "child group survived, now top-level");

  // expandGroups (deep + scoped) — the store seam the Canvas wave builds on
  const p = get(store.project);
  const deep = store.expandGroups(p, new Set(["r1"]));
  assert(eq([...deep].sort(), ["r1", "r2"]), "expandGroups (no scope) expands to the top unit");
  const outer2 = ops.group(p, ["r1", "r3"], { name: "Outer2" })!; // direct op: scope fixture
  const scoped = store.expandGroups(p, new Set(["r1"]), outer2);
  assert(eq([...scoped].sort(), ["r1", "r2"]), "expandGroups (scope=outer) stops at the child unit");
  const unscoped = store.expandGroups(p, new Set(["r1"]));
  assert(eq([...unscoped].sort(), ["r1", "r2", "r3"]), "…while no-scope expands to the whole outer group");

  // enteredGroupId plumbing: cleared by clearSelection, pruned when def dies
  store.enteredGroupId.set(outer2);
  store.clearSelection();
  assert(get(store.enteredGroupId) === null, "clearSelection clears enteredGroupId");
  store.enteredGroupId.set(outer2);
  store.commit((pp) => ops.ungroup(pp, [outer2]));
  store.undo(); // pruneSelection runs on undo/redo
  store.redo();
  assert(get(store.enteredGroupId) === null, "pruneSelection drops a dangling enteredGroupId");
}

// ---------------------------------------------------------------------------
console.log("2) flux-core file verbs on a scratch project");
// ---------------------------------------------------------------------------
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "flux-p7-groups-"));
try {
  await core.scaffold(TMP, { title: "P7 groups parity" });
  const { figureId } = await core.createFigure(TMP, { id: "figp", name: "P" });
  {
    const m = await core.loadFigModel(TMP);
    ops.addElement(m.project, figureId, rect("r1", 10, "#d62728"));
    ops.addElement(m.project, figureId, rect("r2", 150, "#2ca02c"));
    ops.addElement(m.project, figureId, rect("r3", 290, "#1f77b4"));
    await core.saveFigModel(TMP, m.project, m.index, "seed");
  }

  const g = await core.groupElements(TMP, ["r1", "r2"], { name: "Pair" });
  assert(!!g.groupId, "flux-core groupElements returns the gid");
  {
    const { project } = await core.loadFigModel(TMP);
    const f = project.figures.find((ff) => ff.id === figureId)!;
    assert(f.groups?.[g.groupId]?.name === "Pair", "named def persisted to disk (canvas file)");
  }

  const lg1 = await core.listGroups(TMP, figureId);
  assert(lg1.groups.length === 1 && lg1.groups[0].name === "Pair" && eq(lg1.groups[0].members.sort(), ["r1", "r2"]), "flux-core listGroups reads it back");

  await core.renameGroup(TMP, g.groupId, "Panel Pair");
  assert((await core.listGroups(TMP)).groups[0].name === "Panel Pair", "flux-core renameGroup round-trips");

  await core.setGroupState(TMP, g.groupId, { hidden: true });
  const svg = await core.renderFigureSvg(TMP, figureId);
  assert(!svg.includes("#d62728") && !svg.includes("#2ca02c") && svg.includes("#1f77b4"), "headless render honors the group eye (effectiveHidden)");
  await core.setGroupState(TMP, g.groupId, { hidden: false });
  assert((await core.renderFigureSvg(TMP, figureId)).includes("#d62728"), "…and shows members again after unhide");

  // duplicate keeps groups independent (shared cloneGroupsFor core)
  const dup = await core.duplicateElements(TMP, figureId, ["r1", "r2"], { dx: 20, dy: 20 });
  {
    const { project } = await core.loadFigModel(TMP);
    const f = project.figures.find((ff) => ff.id === figureId)!;
    const copy = f.elements.find((e) => e.id === dup.ids[0])!;
    assert(!!copy.groupId && copy.groupId !== g.groupId, "flux-core duplicate remaps the group id");
    assert(f.groups?.[copy.groupId!]?.name === "Panel Pair", "…and clones the def (name preserved)");
  }

  // CLI smoke: list-groups over the same project
  try {
    const out = execFileSync("npx", ["tsx", "flux-cli.ts", "list-groups", "--figure", figureId, "--root", TMP], {
      cwd: path.resolve("."),
      stdio: "pipe",
    }).toString();
    const parsed = JSON.parse(out);
    assert(Array.isArray(parsed) && parsed.some((x: { name: string }) => x.name === "Panel Pair"), "CLI list-groups prints the registry");
  } catch (e) {
    assert(false, `CLI list-groups failed: ${(e as Error).message.split("\n")[0]}`);
  }

  let threw = "";
  try {
    await core.renameGroup(TMP, "missing", "X");
  } catch (err) {
    threw = String(err);
  }
  assert(/not found/.test(threw), "flux-core renameGroup throws for an unknown id");

  await core.ungroupElements(TMP, ["r1"]);
  const lg2 = await core.listGroups(TMP, figureId);
  assert(!lg2.groups.some((x) => x.id === g.groupId), "flux-core ungroup dissolved + GC'd the def");
} finally {
  await fs.rm(TMP, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nFIGENH-16-PARITY ALL PASS" : `\nFIGENH-16-PARITY ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
