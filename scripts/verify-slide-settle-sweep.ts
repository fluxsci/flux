// Start/settle sweep gate (lane J, seek domain). Every cue of a curated corpus (every preset of the catalog on every element
// kind, Change / Become / Ghost / springs / camera / chains, plot-part builds) is played through the portable player in headless
// Chrome and measured at its boundaries (scripts/lib/slideSettleSweep.ts; read its header for the windows and the thresholds):
//   START   the frame before a cue is the rest state; the first 2 ms and the first frame change like the window beside them
//   END     the last 2 ms / the last frame change like the window beside them (a smooth step converges, a snap is a spike)
//   AFTER   the landing reached frame by frame is pixel-equal to the landing seeked directly (a controller crossing leaves no residue)
// plus the verdict function itself (a spike next to a quiet neighbour is flagged, a smooth ramp is not) and the corpus coverage
// (every non-media preset, every element kind and every plot-part family are exercised, so the gate cannot go quietly narrow).
// Headless Chrome quantizes slowly moving straight edges to 1/4 px: the neighbour-relative thresholds absorb it.
import { PRESET_CATALOG } from "../src/lib/slide/presetCatalog";
import { harness } from "./lib/harness.mjs";
import { classify, KNOWN_OPEN, openDeck, sweepDeck, tableRow, TABLE_HEAD, THRESHOLDS, withBrowser, type CueRow } from "./lib/slideSettleSweep";
import { corpus, KINDS } from "./lib/slideSettleCorpus";

const h = harness("verify-slide-settle-sweep");

// -- 1. the verdict function (pure) ------------------------------------------------------------------------------------------
{
  h.section("verdict function");
  const calm = { slide: 0, slideId: "s", from: 1, to: 1, label: "x", dur: 700, dPre: 0, s02: 0, s24: 0, sF: 3, sF2: 6, mid: 10, e42: 0, e20: 0, eF2: 6, eF: 2, dRun: 0 };
  h.eq(classify(calm), [], "a smooth ease-in / ease-out step has no verdict");
  h.eq(classify({ ...calm, s02: 7, s24: 0.1 }), ["START POP (2ms)"], "an instant jump in the first 2 ms beside a quiet window is a start pop");
  h.eq(classify({ ...calm, sF: 20, sF2: 2 }), ["START POP (frame)"], "a first frame that moves 10x the next one is a one-frame start pop");
  h.eq(classify({ ...calm, e20: 14, e42: 0 }), ["END SNAP (2ms)"], "a jump in the last 2 ms beside a quiet window is an end snap");
  h.eq(classify({ ...calm, eF: 12, eF2: 2 }), ["END SNAP (frame)"], "a last frame that moves 6x the one before is a one-frame end snap");
  h.eq(classify({ ...calm, dPre: 5 }), ["PRE-ROLL CHANGE"], "the first frame is not the rest state");
  h.eq(classify({ ...calm, dRun: 5 }), ["POST CHANGE"], "the landing depends on how it was reached");
  h.eq(classify({ ...calm, s02: 0.6, s24: 0, e20: 0.8, e42: 0, sF: 1.2, sF2: 0.1, eF: 1.9, eF2: 0.2 }), [], "sub-visible boundary change is below the floor");
  h.eq(classify({ ...calm, s02: 30, s24: 29 }), [], "a fast start whose neighbour moves as much is not a pop");
  h.ok(THRESHOLDS.floorTiny > 0 && THRESHOLDS.ratioTiny >= 3 && THRESHOLDS.ratioFrame >= 2, "thresholds are relative (a ratio to the neighbour) with an absolute floor");
}

// -- 2. the corpus ------------------------------------------------------------------------------------------------------------
const decks = await corpus("compact");
{
  h.section("corpus coverage");
  const presets = new Set<string>(), kinds = new Set<string>(), parts = new Set<string>();
  for (const { payload } of decks) for (const slide of payload.deck.slides) {
    const types = new Map(slide.elements.map(e => [e.id, e.type === "line" && (e as { arrowEnd?: boolean }).arrowEnd ? "arrow" : e.type]));
    for (const beat of slide.beats) for (const t of beat.tracks) {
      presets.add(t.preset ?? "?"); if (t.to && (t.to as { become?: unknown }).become) presets.add("become");
      if (t.ghostFrom) presets.add("ghost");
      kinds.add(String(types.get(t.target) ?? t.target));
      if (t.selector?.role) parts.add(`role:${t.selector.role}`);
      if (t.part) parts.add(t.part.replace(/\.\d+$/, "").replace(/^(\w+)\.line$/, "line"));
    }
  }
  for (const def of Object.values(PRESET_CATALOG)) if (def.family !== "media") h.ok(presets.has(def.name), `corpus exercises preset ${def.name}`);
  h.ok(presets.has("become") && presets.has("ghost"), "corpus exercises Become (hand-off) and Ghost");
  for (const k of ["text", "rect", "ellipse", "line", "arrow", "path", "image"]) h.ok(kinds.has(k), `corpus animates element kind ${k}`);
  for (const p of ["role:point", "role:bar", "axis.x.spine", "axis.x.ticks", "axis.x.tick-labels", "line"]) h.ok(parts.has(p), `corpus animates plot part ${p}`);
  void KINDS;
}

// -- 3. the sweep --------------------------------------------------------------------------------------------------------------
const results: { name: string; rows: CueRow[] }[] = [];
await withBrowser(async (browser, tmp) => {
  const queue = [...decks];
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const sp = await openDeck(browser, d.payload, tmp, d.name);
      try { results.push({ name: d.name, rows: await sweepDeck(sp, d.payload) }); } finally { await sp.close(); }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
});
results.sort((a, b) => a.name.localeCompare(b.name));
h.section("boundaries");
console.log(TABLE_HEAD);
let cues = 0;
for (const { name, rows } of results) for (const r of rows) {
  cues++;
  console.log(tableRow(r, name));
  const key = `${name}#${r.from}-${r.to}`;
  const open = KNOWN_OPEN[key];
  const flags = r.flags.filter(f => !open?.flags.includes(f));
  const tolerated = r.flags.filter(f => open?.flags.includes(f));
  h.ok(flags.length === 0, `${key} (${r.label}, ${Math.round(r.dur)} ms): ${flags.join(", ") || "clean start, clean landing"}${tolerated.length ? ` [known open: ${tolerated.join(", ")} - ${open!.owner}]` : ""}`);
}
h.ok(cues >= 80, `the sweep measured ${cues} cues (a corpus that shrinks fails)`);
await h.done();
