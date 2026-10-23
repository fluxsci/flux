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
import { classify, hops, judge, KNOWN_OPEN, openDeck, openKey, seekFlagValue, sweepDeck, tableRow, TABLE_HEAD, THRESHOLDS, withBrowser, type CueRow } from "./lib/slideSettleSweep";
import { corpus } from "./lib/slideSettleCorpus";

const h = harness("verify-slide-settle-sweep");

// -- 1. the verdict function (pure) ------------------------------------------------------------------------------------------
{
  h.section("verdict function");
  const calm = { slide: 0, slideId: "s", from: 1, to: 1, label: "x", dur: 700, dPre: 0, s02: 0, s24: 0, sF: 3, sF2: 6, sFr: 3, sF2r: 6, mid: 10, midF: 80, q4: 60, e42: 0, e20: 0, eF2: 6, eF: 2, dRun: 0 };
  h.eq(classify(calm), [], "a smooth ease-in / ease-out step has no verdict");
  h.eq(classify({ ...calm, s02: 7, s24: 0.1 }), ["START POP (2ms)"], "an instant jump in the first 2 ms beside a quiet window is a start pop");
  h.eq(classify({ ...calm, sF: 20, sF2: 2 }), ["START POP (frame)"], "a first frame that moves 10x the next one is a one-frame start pop");
  h.eq(classify({ ...calm, sF: 0, sF2: 201, sFr: 0, sF2r: 201, midF: 432 }), ["START POP (2nd frame)"], "a second frame that jumps from nothing to a frame of the cue's own motion is a late start pop (the count-up's digit slots replacing the number)");
  h.eq(classify({ ...calm, sF: 0.5, sF2: 12, sFr: 0.5, sF2r: 12, midF: 90 }), [], "a quadratic-ish start whose second frame is ~10 % of a mid-flight frame is not a pop");
  h.eq(classify({ ...calm, sF: 0, sF2: 17, sFr: 0, sF2r: 17, midF: 5600 }), [], "a headless 1/4 px quantisation step on a huge camera move (sF 0, sF2 17 of 5600) is not a pop");
  h.eq(classify({ ...calm, sF: 4, sF2: 30, sFr: 4, sF2r: 30, midF: 90 }), [], "a start that grows 7x (cubic ease) is smooth");
  h.eq(classify({ ...calm, sF: 0, sF2: 8.8, sFr: 0, sF2r: 8.8, midF: 0 }), [], "a quick curve that moves a small element's whole change in its second frame (nothing moves at mid-flight) is under the second-frame floor");
  h.eq(classify({ ...calm, sF: 0, sF2: 13.4, sFr: 3.1, sF2r: 15.9, midF: 10.6 }), [], "a slow start the dead band reads as 0 (every early change under 4 %) is not a late pop: the test is on the RAW windows");
  h.eq(classify({ ...calm, q4: 0 }), ["MID FREEZE"], "a cue that moves at mid-flight but is dead 100 ms a quarter in froze under a static render (a text rewrite whose count and colour ran unseen, then took over in one frame)");
  h.eq(classify({ ...calm, q4: 0.2 }), ["MID FREEZE"], "a quarter-way window under half a unit of change is still a freeze");
  h.eq(classify({ ...calm, q4: 0, midF: 3 }), [], "a cue that does not move at mid-flight (a late or tiny element) has nothing to freeze");
  h.eq(classify({ ...calm, q4: 3 }), [], "a slow, sub-visible quarter is not a freeze (a quintic start of a long cue)");
  h.eq(classify({ ...calm, e20: 14, e42: 0 }), ["END SNAP (2ms)"], "a jump in the last 2 ms beside a quiet window is an end snap");
  h.eq(classify({ ...calm, eF: 12, eF2: 2 }), ["END SNAP (frame)"], "a last frame that moves 6x the one before is a one-frame end snap");
  h.eq(classify({ ...calm, dPre: 5 }), [], "a promoted layer re-rastered at the first frame is under the pre-roll floor");
  h.eq(classify({ ...calm, dPre: 140 }), ["PRE-ROLL CHANGE"], "the first frame is not the rest state (a dimmed highlight)");
  h.eq(classify({ ...calm, dRun: 5 }), [], "a gliding layer baked mid-flight by a seek is under the run floor");
  h.eq(classify({ ...calm, dRun: 120 }), ["POST CHANGE"], "the landing depends on how it was reached (a stale style)");
  h.eq(classify({ ...calm, s02: 0.6, s24: 0, e20: 0.8, e42: 0, sF: 1.2, sF2: 0.1, eF: 1.9, eF2: 0.2 }), [], "sub-visible boundary change is below the floor");
  h.eq(classify({ ...calm, s02: 30, s24: 29 }), [], "a fast start whose neighbour moves as much is not a pop");
  {
    const open = { seek: ["START POP (frame)"], rt: ["START STEP"], rtMay: ["LANDING STEP"], owner: "x" };
    h.eq(judge(["START POP (frame)"], open, "seek"), { failing: [], tolerated: ["START POP (frame)"], stale: [] }, "a listed flag is tolerated");
    h.eq(judge(["START POP (frame)", "END SNAP (2ms)"], open, "seek").failing, ["END SNAP (2ms)"], "a flag that is not listed still fails");
    h.eq(judge([], open, "seek").stale, ["START POP (frame)"], "a REQUIRED entry whose flag stopped firing is stale (fails: delete it)");
    h.eq(judge(["START STEP (20.4 before 0.0)", "LANDING STEP (30.4 after 9.4)"], open, "rt"), { failing: [], tolerated: ["START STEP (20.4 before 0.0)", "LANDING STEP (30.4 after 9.4)"], stale: [] }, "real-time flags match by prefix; rtMay is tolerated without being required");
    h.eq(judge(["LANDING STEP (20.1 after 0.6)"], { ...open, max: { "LANDING STEP": 25 } }, "rt").tolerated, ["LANDING STEP (20.1 after 0.6)"], "a tolerated flag under its pinned max is tolerated");
    h.eq(judge(["LANDING STEP (70.9 after 0.0)"], { ...open, max: { "LANDING STEP": 25 } }, "rt").failing, ["LANDING STEP (70.9 after 0.0) over its pinned max 25"], "a tolerated flag over its pinned max FAILS (a regression from 20 to 70 cannot pass by prefix)");
    h.eq(judge(["START POP (2ms)"], { seek: ["START POP (2ms)"], max: { "START POP": 12 }, owner: "x" }, "seek", seekFlagValue({ ...calm, s02: 40, s24: 0 } as never)).failing.length, 1, "the same pin reads a seek flag's measured window");
    h.eq(judge(["START STEP (1 before 0)"], { ...open, rt: undefined }, "seek"), { failing: ["START STEP (1 before 0)"], tolerated: [], stale: ["START POP (frame)"] }, "domains do not leak into each other");
  }
  h.eq(hops([0, 0, 0.2, 0.5, 0.5, 1.1, 1.3, 0.8, 23.4, 0.3, 0.8, 1.1, 22.7, 1.0, 1.1]), [8, 12], "a presented frame that steps 20x its neighbours inside a glide is a hop (the stem edit painted in place: a ~23 unit hop every fourth frame)");
  h.eq(hops([0, 0, 0.2, 0.5, 0.9, 1.2, 2.5, 2.6, 3.8, 4.0, 5.2, 5.9, 10.7, 10.0, 9.7, 8.2, 8.9, 7.4, 3.6, 2.6, 2.0, 0.9, 0.2]), [], "a smooth glide (a ramp up, a ramp down, a layer moving at float precision) has no hop");
  h.eq(hops([0, 0, 0.1, 9.9, 10.5, 11.2, 12]), [], "a first changing frame is START STEP's, a fast start is not a hop (its neighbour moves as much)");
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
  // R2 follow-up F1 (geometry): the hand-off / Change starts and landings it fixed stay in the corpus (a deck that left it would let them regress unseen)
  const cuesOfDeck = (name: string) => decks.find(d => d.name === name)?.payload.deck.slides.length ?? 0;
  for (const [name, n] of [["become_stroked", 2], ["become_corners", 8], ["handoff_round", 5], ["corner_radius", 3], ["compound", 6], ["set_flights", 2], ["plot_chain", 3], ["become_depth", 2]] as const) h.ok(cuesOfDeck(name) >= n, `corpus keeps the ${name} cases (${cuesOfDeck(name)} >= ${n}): stroke band, round hand-offs, cornerRadius Change, compound holes, flights landing on a set, chained plot Changes, hand-offs that land under an element drawn after them`);
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
  const key = openKey(name, r.slideId, r.from, r.to), open = KNOWN_OPEN[key];
  const { failing, tolerated, stale } = judge(r.flags, open, "seek", seekFlagValue(r));
  h.ok(failing.length === 0 && stale.length === 0, `${key} (${r.label}, ${Math.round(r.dur)} ms): ${failing.join(", ") || (stale.length ? `STALE KNOWN_OPEN entry (${stale.join(", ")} no longer fires: delete it from scripts/lib/slideSettleSweep.ts)` : "clean start, clean landing")}${tolerated.length ? ` [known open: ${tolerated.join(", ")} - ${open!.owner}]` : ""}`);
}
{
  const measured = new Set(results.flatMap(({ name, rows }) => rows.map(r => openKey(name, r.slideId, r.from, r.to))));
  for (const [key, open] of Object.entries(KNOWN_OPEN)) if (open.seek) h.ok(measured.has(key), `KNOWN_OPEN ${key} names a cue the sweep measures`);
}
h.ok(cues >= 80, `the sweep measured ${cues} cues (a corpus that shrinks fails)`);
await h.done();
