#!/usr/bin/env -S npx tsx
// Animation rework §7 — presets & templates: payload validation (user-editable
// files are never trusted), preset derivation from live tracks, template slot
// derivation (part→ROLE, axis-agnostic; element→{type,nth}), the matching
// engine (the AXIS-SWAP apply: an x-axis-derived template lands on a y-axis
// container; generic shape sets bind by type+order), partial-match reporting,
// and the memBridge localStorage round-trip the ui fixture uses.
// Run: npx tsx scripts/verify-anim-presets.ts
import {
  parseAnimPreset, parseAnimTemplate, makeAnimPreset, presetTrackOf,
  deriveTemplateSlots, applyTemplate,
  type AnimTemplate, type TemplateCtx,
} from "../src/lib/slide/animTemplates";
import type { Element } from "../src/lib/types";
import type { Track } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// --- payload validation --------------------------------------------------------
{
  const good = makeAnimPreset("Fast draw", { target: "e1", preset: "drawOn", duration: 400, params: { mode: "both-ends" }, stagger: { perMs: 30 } });
  assert(parseAnimPreset(good) !== null, "a makeAnimPreset payload validates");
  assert(good.family === "appearance" && good.track.preset === "drawOn" && !("target" in good.track), "presets carry HOW, never the binding (no target)");
  const t = makeAnimPreset("Slow become", { target: "e1", preset: "transform", duration: 900, to: { state: { x: 1 } } });
  assert(t.family === "transform" && !("to" in t.track), "transform presets are timing-only (no captured state)");
  assert(parseAnimPreset({}) === null && parseAnimPreset({ fluxPreset: 1, kind: "anim", name: 1 }) === null, "malformed presets are rejected");
  assert(parseAnimTemplate({ fluxPreset: 1, kind: "animTemplate", name: "x", slots: [] }) === null, "an empty template is rejected");
  assert(
    parseAnimTemplate({ fluxPreset: 1, kind: "animTemplate", name: "x", slots: [{ match: { kind: "part" }, track: {} }] }) === null,
    "a part slot without a role is rejected",
  );
}

// --- fixture: a plot with x+y axis part trees + loose shapes -------------------
const axisTree = (ax: "x" | "y") => ({
  id: `axis.${ax}`, role: "axis", children: [
    { id: `axis.${ax}.spine`, role: "spine" },
    { id: `axis.${ax}.ticks`, role: "tick", members: [`${ax}t0`, `${ax}t1`] },
    { id: `axis.${ax}.tick-labels`, role: "tick-label", members: [`${ax}l0`, `${ax}l1`] },
    { id: `axis.${ax}.title`, role: "axis-title" },
  ],
});
const manifest = {
  spec: "fluxplot", schemaVersion: "1", plotType: "scatter", svg: "",
  size: { width: 480, height: 400, unit: "px" },
  axes: [], series: [],
  parts: { id: "plot", role: "plot", children: [axisTree("x"), axisTree("y")] },
} as unknown as FluxPlotManifest;

const el = (type: Element["type"], id: string, x: number): Element =>
  ({ type, id, x, y: 0, width: 40, height: 40, rotation: 0, fill: "#aaa", stroke: "#000", strokeWidth: 1, cornerRadius: 0 }) as unknown as Element;
const elements: Element[] = [
  { ...(el("rect", "r1", 0) as object) } as Element,
  { ...(el("ellipse", "c1", 50) as object) } as Element,
  { ...(el("rect", "r2", 100) as object) } as Element,
  { ...(el("ellipse", "c2", 150) as object) } as Element,
  { type: "plot", id: "p1", x: 0, y: 100, width: 300, height: 200, rotation: 0, assetId: "as1" } as unknown as Element,
];
const ctx: TemplateCtx = { elements, manifestFor: (id) => (id === "p1" ? manifest : undefined) };

// --- slot derivation: the x-axis build → axis-agnostic ROLES -------------------
const xTracks: Track[] = [
  { id: "t1", target: "p1", part: "axis.x.spine", preset: "drawOn", duration: 500 },
  { id: "t2", target: "p1", part: "axis.x.ticks", preset: "drawOn", duration: 300, stagger: { perMs: 20 } },
  { id: "t3", target: "p1", part: "axis.x.tick-labels", preset: "writeOn", duration: 350 },
  { id: "t4", target: "p1", part: "axis.x.title", preset: "writeOn", duration: 400 },
];
const { slots: xSlots, skipped: xSkipped } = deriveTemplateSlots(xTracks, ctx);
assert(xSlots.length === 4 && xSkipped.length === 0, "the x-axis build derives 4 slots");
assert(
  JSON.stringify(xSlots.map((s) => (s.match as { role: string }).role)) === JSON.stringify(["spine", "tick", "tick-label", "axis-title"]),
  "part slots store ROLES — axis-agnostic (never axis.x.*)",
);
assert(xSlots[1].track.stagger?.perMs === 20, "slot tracks carry the reusable settings");

// --- THE AXIS SWAP: apply the x-derived template to the y-axis container -------
const xTpl: AnimTemplate = { fluxPreset: 1, kind: "animTemplate", name: "X-axis build", slots: xSlots };
{
  const res = applyTemplate(xTpl, { kind: "part-container", elementId: "p1", partId: "axis.y" }, ctx);
  assert(res.matched === 4 && res.unmatched.length === 0, "all 4 slots bind inside the y-axis subtree");
  const parts = res.tracks.map((t) => t.part);
  assert(
    JSON.stringify(parts) === JSON.stringify(["axis.y.spine", "axis.y.ticks", "axis.y.tick-labels", "axis.y.title"]),
    `…onto the Y-axis parts (${parts.join(", ")})`,
  );
  assert(res.tracks.every((t) => t.target === "p1" && t.id), "bound tracks target the scoped plot with fresh ids");
  assert(res.tracks[0].preset === "drawOn" && res.tracks[2].preset === "writeOn", "each slot's preset settings ride along");
}

// --- part slots against a plot ELEMENT scope -----------------------------------
{
  const res = applyTemplate(xTpl, { kind: "elements", ids: ["p1"] }, ctx);
  assert(res.matched === 4, "the same template binds against a selected plot ELEMENT (first unclaimed role per slot)");
}

// --- generic shape template: {type, nth} by document order ---------------------
const shapeTracks: Track[] = [
  { id: "s1", target: "r1", preset: "popIn", duration: 300 },
  { id: "s2", target: "c1", preset: "fade", duration: 250 },
  { id: "s3", target: "r2", preset: "popIn", duration: 300, start: 100 },
  { id: "s4", target: "c2", preset: "fade", duration: 250, start: 100 },
];
const { slots: shapeSlots } = deriveTemplateSlots(shapeTracks, ctx);
assert(
  JSON.stringify(shapeSlots.map((s) => s.match)) ===
    JSON.stringify([
      { kind: "element", type: "rect", nth: 0 },
      { kind: "element", type: "ellipse", nth: 0 },
      { kind: "element", type: "rect", nth: 1 },
      { kind: "element", type: "ellipse", nth: 1 },
    ]),
  "element slots record {type, nth} in document order",
);
const shapeTpl: AnimTemplate = { fluxPreset: 1, kind: "animTemplate", name: "2r2e", slots: shapeSlots };
{
  // a DIFFERENT set of 2 rects + 2 ellipses, listed shuffled — binds by type+order
  const other: Element[] = [el("ellipse", "e9", 10), el("rect", "r9", 20), el("rect", "r8", 30), el("ellipse", "e8", 40)];
  const res = applyTemplate(shapeTpl, { kind: "elements", ids: ["e9", "r9", "r8", "e8"] }, { elements: other, manifestFor: () => undefined });
  assert(res.matched === 4, "the shape template binds a different 2-rect-2-ellipse set");
  const byId = new Map(res.tracks.map((t) => [t.target, t]));
  assert(byId.get("r9")?.preset === "popIn" && byId.get("r8")?.start === 100, "rect slots land on the rects in order (r9 first, r8 second with its 100ms offset)");
  assert(byId.get("e9")?.preset === "fade" && byId.get("e8")?.start === 100, "ellipse slots land on the ellipses in order");
}

// --- partial application is allowed and REPORTED -------------------------------
{
  const res = applyTemplate(shapeTpl, { kind: "elements", ids: ["r1", "c1"] }, ctx);
  assert(res.matched === 2 && res.total === 4, "a smaller scope binds what it can (2/4)");
  assert(res.unmatched.length === 2 && res.unmatched.every((u) => /#2/.test(u)), `…and reports the misses (${res.unmatched.join("; ")})`);
}
{
  const res = applyTemplate(xTpl, { kind: "elements", ids: ["r1"] }, ctx);
  assert(res.matched === 0 && res.unmatched.length === 4, "a role template against a bare rect matches nothing — reported, never invented");
}

// --- camera tracks don't template ----------------------------------------------
{
  const { slots, skipped } = deriveTemplateSlots([{ id: "c", target: "@camera", preset: "camera" }], ctx);
  assert(slots.length === 0 && skipped.length === 1, "camera tracks are skipped with a reason");
}

// --- memBridge round trip (the ui fixture's storage twin) ----------------------
{
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const { createMemBridge } = await import("../src/lib/project/memBridge");
  const bridge = createMemBridge() as unknown as {
    readAnimLibrary(kind: string): Promise<{ rel: string; payload: unknown }[]>;
    writeAnimLibrary(kind: string, rel: string, payload: unknown): Promise<boolean>;
    deleteAnimLibrary(kind: string, rel: string): Promise<boolean>;
  };
  const preset = makeAnimPreset("Round trip", { target: "x", preset: "fade", duration: 123 });
  assert(await bridge.writeAnimLibrary("preset", "round-trip.json", preset), "memBridge writes a preset");
  assert(await bridge.writeAnimLibrary("template", "tpl.json", xTpl), "…and a template (separate key)");
  const back = await bridge.readAnimLibrary("preset");
  assert(back.length === 1 && parseAnimPreset(back[0].payload)?.track.duration === 123, "the preset round-trips through the fixture store");
  const tpls = await bridge.readAnimLibrary("template");
  assert(tpls.length === 1 && parseAnimTemplate(tpls[0].payload)?.slots.length === 4, "the template round-trips");
  await bridge.deleteAnimLibrary("preset", "round-trip.json");
  assert((await bridge.readAnimLibrary("preset")).length === 0, "delete removes it");
}

// --- presetTrackOf strips bindings ---------------------------------------------
{
  const stripped = presetTrackOf({ id: "z", target: "e", part: "axis.x", selector: { role: "point" }, preset: "stagger", duration: 200, to: { state: { x: 1 } }, groupId: "g" });
  assert(!("target" in stripped) && !("part" in stripped) && !("selector" in stripped) && !("to" in stripped) && !("groupId" in stripped), "presetTrackOf keeps only the reusable settings");
}

console.log("\nANIM PRESETS & TEMPLATES (matching engine + storage): PASS");
