import type * as slideOps from "../../src/lib/slide/ops";

/** Full ghost-birth deck, with only generated identities and timestamps made
 * deterministic. Golden captured from fa47852 (the integration head before M3). */
export function ghostDisappearBytes(ops: typeof slideOps): string {
  const d = ops.createDeck({ id: "ghost-disappear", title: "Ghost defaults", withTitleSlide: false });
  const s = ops.addSlide(d, { id: "slide", layout: "blank", name: "Ghosts" });
  s.elements = [{ id: "source", name: "Source", type: "rect", x: 20, y: 30, width: 50, height: 40,
    rotation: 10, fill: "#ff0000", stroke: "none", strokeWidth: 0, cornerRadius: 3 }];
  const b = ops.addBeat(d, s.id, { id: "birth", label: "Copies" })!;
  ops.addGhostTransform(d, s.id, b.id, "source", { count: 2, original: "disappear", states: [{ x: 100 }, { y: 150 }] });
  d.created = d.modified = "2026-09-28T00:00:00.000Z";
  const ids = new Map<string, string>();
  return JSON.stringify(d, (_key, value) => {
    if (typeof value !== "string" || !/^(?:beat|track|tgrp|rect)_[a-z0-9]+_\d+$/.test(value)) return value;
    if (!ids.has(value)) ids.set(value, `${value.split("_")[0]}_fixture_${ids.size}`);
    return ids.get(value);
  }, 2) + "\n";
}
