#!/usr/bin/env -S npx tsx
// 2026-10-02 — the Slide Become picker's pure model (owner ask "A better
// 'Become' UI", Deck 3 slide 3). Pins:
//   (a) toggle semantics — a click picks, a second click unpicks; the waiting
//       source never picks itself; a part and its whole object (a group and
//       its member) are mutually exclusive, the last pick wins;
//   (b) units → refs: one ref per object, parts unioned in pick order, groups
//       as {element, group} — the `refsForTargets` law the commit relies on;
//   (c) composeDestination: none / one / the W1 set form (normalized when the
//       W1 normalizer exists);
//   (d) chips collapse same-kind runs ("6 points · W1", "2 ellipses"), a lone
//       unit keeps its own short label, at most `max` chips plus a count;
//   (e) the marquee law: fully inside only, whole objects win over their own
//       leaves, data marks preferred over furniture, zero-area boxes excluded;
//   (f) `a` widening over a real boxplot manifest (group mates → counterpart
//       groups → every child) and the shared X-ray sibling rule itself;
//   (g) describeUnit words for parts and objects.
//   Run: node scripts/run-verifies.mjs --tier pure --only become-picker
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import {
  addUnits, chipRuns, composeDestination, conflicts, isSourceUnit, marqueeUnits, pluralKind, refsToUnits, removeUnits,
  toggleUnit, unitsToRefs, widenParts, isDataRole, boxFrom, type MarqueeCandidate, type PickUnit,
} from "../src/shell/modes/slide/pick/pickModel";
import { describeUnit } from "../src/shell/modes/slide/pick/pickLabels";
import { widenToSiblings, rowParents, type XRow } from "../src/lib/xray/buildXrayTree";

let n = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  n++; console.log("  ok:", msg);
}
const J = (v: unknown) => JSON.stringify(v);
const here = import.meta.dirname;
const BOX = JSON.parse(await fs.readFile(path.join(here, "fixtures", "plots", "mpl_boxplot_FLUXPLOT.fluxplot.json"), "utf8")) as FluxPlotManifest;

// --- (a) toggle -----------------------------------------------------------------------------------
{
  const source = { element: "rect" };
  const ctx = { membersOf: (g: string) => (g === "g1" ? ["e1", "e2"] : []) };
  let r = toggleUnit([], { element: "plot", part: "p.0" }, source, ctx);
  assert(r.picked && r.units.length === 1, "a plain click picks the unit");
  r = toggleUnit(r.units, { element: "plot", part: "p.0" }, source, ctx);
  assert(!r.picked && r.units.length === 0, "clicking a picked unit unpicks it");
  r = toggleUnit([], { element: "rect" }, source, ctx);
  assert(!r.picked && !r.units.length, "the source never picks itself");
  assert(isSourceUnit({ element: "plot", part: "a" }, { element: "plot", parts: ["a"] }) && !isSourceUnit({ element: "plot", part: "b" }, { element: "plot", parts: ["a"] }), "a part source excludes only its own parts");
  let u = addUnits([], [{ element: "plot" }], source, ctx);
  u = addUnits(u, [{ element: "plot", part: "p.1" }], source, ctx);
  assert(J(u) === J([{ element: "plot", part: "p.1" }]), "a part replaces its whole plot (the last pick wins)");
  u = addUnits(u, [{ element: "plot" }], source, ctx);
  assert(J(u) === J([{ element: "plot" }]), "Alt+click's whole plot replaces its parts");
  u = addUnits([{ element: "e1" }, { element: "e3" }], [{ element: "e1", group: "g1" }], source, ctx);
  assert(J(u) === J([{ element: "e3" }, { element: "e1", group: "g1" }]), "a group pick replaces its member picks, others stay");
  assert(conflicts({ element: "e2" }, { element: "e1", group: "g1" }, ctx) && !conflicts({ element: "e3" }, { element: "e1", group: "g1" }, ctx), "group/member conflicts read the deep members");
  assert(J(removeUnits(u, [{ element: "e3" }])) === J([{ element: "e1", group: "g1" }]), "removeUnits drops exact units");
}

// --- (b) refs ---------------------------------------------------------------------------------------
{
  const units: PickUnit[] = [{ element: "plot", part: "b" }, { element: "ell" }, { element: "plot", part: "a" }, { element: "m1", group: "g" }];
  const refs = unitsToRefs(units);
  assert(J(refs) === J([{ element: "plot", parts: ["b", "a"] }, { element: "ell" }, { element: "m1", group: "g" }]), "one ref per object, parts unioned in pick order, groups kept");
  assert(J(unitsToRefs(refsToUnits(refs))) === J(refs), "refs → units → refs is the identity");
}

// --- (c) destination --------------------------------------------------------------------------------
{
  assert(composeDestination([]) === null, "no picks → no destination");
  assert(J(composeDestination([{ element: "a", parts: ["x"] }])) === J({ element: "a", parts: ["x"] }), "one ref passes through untouched");
  const set = composeDestination([{ element: "a" }, { element: "b" }]) as { element: string; members?: unknown[] };
  assert(set.element === "a" && set.members?.length === 2, "several refs compose W1's set form, element = first member");
  const normalized = composeDestination([{ element: "a" }, { element: "b" }], (r) => ({ ...r, element: "N" }));
  assert(normalized?.element === "N", "the W1 normalizer is applied when present");
}

// --- (d) chips --------------------------------------------------------------------------------------
{
  const describe = (u: PickUnit) => (u.part
    ? { kind: "point", owner: u.element, context: u.part.startsWith("w") ? "wake" : "sleep", label: `Plot › Point ${u.part}`, chip: `Point ${u.part}` }
    : { kind: u.element.startsWith("e") ? "ellipse" : "rect", owner: "", label: u.element === "r1" ? "Rect 1" : u.element });
  const six = ["w1", "w2", "w3", "w4", "w5", "w6"].map((p) => ({ element: "plot", part: p }));
  assert(J(chipRuns(six, describe).chips.map((c) => c.label)) === J(["6 points · wake"]), "six points of one series collapse to \"6 points · wake\"");
  const mixed = chipRuns([...six.slice(0, 2), { element: "plot", part: "s1" }, { element: "e1" }, { element: "e2" }, { element: "r1" }], describe);
  assert(J(mixed.chips.map((c) => c.label)) === J(["3 points", "2 ellipses", "Rect 1"]), "mixed contexts drop the context; kinds collapse; a lone rect keeps its label");
  assert(mixed.chips[0].units.length === 3, "a chip carries its units (× removes them all)");
  assert(chipRuns([{ element: "plot", part: "w1" }], describe).chips[0].label === "Point w1", "a lone part uses its short chip label");
  const many = chipRuns(["a", "b", "c", "d", "e", "f", "g", "h"].map((k, i) => ({ element: "x" + i })), (u) => ({ kind: u.element, owner: "", label: u.element }), 6);
  assert(many.chips.length === 6 && many.more === 2, "at most six chips, the rest counted");
  assert(pluralKind("box", 2) === "boxes" && pluralKind("tick label", 3) === "tick labels" && pluralKind("whisker", 2) === "whiskers" && pluralKind("point", 1) === "point", "plural words");
}

// --- (e) marquee ------------------------------------------------------------------------------------
{
  const box = boxFrom({ x: 100, y: 100 }, { x: 0, y: 0 });
  assert(J(box) === J({ x: 0, y: 0, w: 100, h: 100 }), "boxFrom normalizes any drag direction");
  const c: MarqueeCandidate[] = [
    { unit: { element: "plot" }, rect: { x: -50, y: -50, w: 300, h: 300 }, level: "object" },
    ...[0, 1, 2, 3, 4, 5].map((i): MarqueeCandidate => ({ unit: { element: "plot", part: `w${i}` }, rect: { x: 10 + i * 10, y: 10, w: 6, h: 6 }, level: "leaf", data: true })),
    { unit: { element: "plot", part: "far" }, rect: { x: 95, y: 95, w: 10, h: 10 }, level: "leaf", data: true },
    { unit: { element: "plot", part: "tick" }, rect: { x: 5, y: 50, w: 4, h: 1 }, level: "leaf", data: false },
    { unit: { element: "ell" }, rect: { x: 20, y: 60, w: 30, h: 20 }, level: "object" },
    { unit: { element: "bg" }, rect: { x: 0, y: 0, w: 0, h: 0 }, level: "object" },
  ];
  const picked = marqueeUnits(c, box).map((u) => u.part ?? u.element);
  assert(J(picked) === J(["ell", "w0", "w1", "w2", "w3", "w4", "w5"]), "exactly the six fully-inside points + the loose ellipse; the half-out mark, the tick (data preferred) and the zero-area box are left");
  assert(J(marqueeUnits(c, { x: 0, y: 45, w: 12, h: 10 }).map((u) => u.part)) === J(["tick"]), "furniture is picked when no data mark is inside");
  assert(J(marqueeUnits(c, { x: -60, y: -60, w: 400, h: 400 }).map((u) => u.part ?? u.element)) === J(["plot", "ell"]), "a whole plot inside is picked whole, not leaf by leaf");
  assert(isDataRole("point") && isDataRole("box") && !isDataRole("tick-label") && !isDataRole("spine"), "data vs furniture roles");
}

// --- (f) widening ----------------------------------------------------------------------------------
{
  const leaves = (u: PickUnit[]) => u.map((x) => x.part).sort();
  const caps = widenParts(BOX, "p", ["peaches.cap.0"].filter(() => true));
  const capIds = (BOX.parts as { children: { children: { id: string; members?: string[] }[] }[] }).children[0].children.find((s) => (s as { id: string }).id === "peaches")!.children.find((g) => g.id === "peaches.caps")!.members!;
  const first = widenParts(BOX, "p", [capIds[0]]);
  assert(J(leaves(first)) === J([...capIds].sort()), "first a: the other members of the leaf's own group (one box plot's caps)");
  const second = widenParts(BOX, "p", first.map((u) => u.part!));
  assert(second.length === 6 && second.every((u) => /\.cap(-\d+)?$/.test(u.part!)), "second a: the same group under every sibling series (all six caps)");
  const third = widenParts(BOX, "p", second.map((u) => u.part!));
  assert(third.length > second.length && third.some((u) => /whisker/.test(u.part!)) && !third.some((u) => /^axis\./.test(u.part!)), "third a: every child of each series — whiskers, medians, boxes … never the axes");
  void caps;
  const spine = widenParts(BOX, "p", ["axis.x.spine"]);
  assert(spine.some((u) => u.part === "axis.y.spine"), "X axis spine widens to the Y axis spine (the X-ray's counterpart rule)");
  const row = (id: string, role: string, label: string, children: XRow[] = []): XRow => ({ id, kind: "part", role, label, isGroup: !!children.length, children });
  const tree = row("root", "figure", "Figure", [row("ax", "axis", "X axis", [row("ax.t", "tick", "Ticks"), row("ax.l", "tick-label", "Labels")]), row("ay", "axis", "Y axis", [row("ay.t", "tick", "Ticks")])]);
  const parents = rowParents(tree);
  assert(J([...widenToSiblings(tree, [parents.get("ax.t")!.children[0]], parents)!].sort()) === J(["ax.t", "ay.t"]), "shared rule step 1: counterparts under the parent's siblings");
  assert(J([...widenToSiblings(tree, [tree.children[0].children[0], tree.children[1].children[0]], parents)!].sort()) === J(["ax.l", "ax.t", "ay.t"]), "shared rule step 2: every child of the parent");
  assert(widenToSiblings(tree, [], parents) === null, "nothing picked → nothing to widen");
}

// --- (g) words --------------------------------------------------------------------------------------
{
  const capId = (BOX.parts as { children: { children: { id: string; members?: string[] }[] }[] }).children[0].children.find((s) => (s as { id: string }).id === "peaches")!.children.find((g) => g.id === "peaches.caps")!.members![0];
  const ctx = { slide: { elements: [{ id: "p", type: "plot", assetId: "a" }, { id: "e", type: "ellipse" }] }, manifestFor: () => BOX, refLabel: (r: { element: string; parts?: string[] }) => (r.parts ? `Plot 1 › Cap ${r.parts[0]}` : r.element === "e" ? "Ellipse 2" : "Plot 1") };
  const d = describeUnit({ element: "p", part: capId }, ctx);
  assert(d.kind === "cap" && d.owner === "p" && d.label.startsWith("Plot 1 › ") && !d.chip!.startsWith("Plot 1"), "a part: its role word, its plot as owner, the lane label, a short chip");
  assert(describeUnit({ element: "e" }, ctx).kind === "ellipse" && describeUnit({ element: "e" }, ctx).label === "Ellipse 2", "an object: its type word and lane label");
}
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-become-picker", ok: true, checks: n, failed: 0 })}`);
console.log("VERIFY-BECOME-PICKER PASS");
