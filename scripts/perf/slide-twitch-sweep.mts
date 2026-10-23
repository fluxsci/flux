// Boundary-pop SWEEP over every cue of a deck in the portable player (headless Chrome, seek domain). Lane J rewrote the
// measurement: it now drives each cue from the PLAYER'S OWN length (compiled cue end, stagger and per-node delays included)
// and measures every boundary twice, a 2 ms window and a one-frame (16.7 ms) window, so an instant jump and a one-frame pop
// are told apart from a fast start. The core and its thresholds live in scripts/lib/slideSettleSweep.ts; read its header.
//
//   ROOT=<project> DECK=<deckId> [SLIDES=0,1,2]          a deck of a Flux project
//   DECKFILE=<deck.json> [PLOTS=<plots.json>] [SLIDES=]    a bare deck (the rig decks under notes/manim_exploration/scratch)
//   CORPUS=synthetic|compact|rig|all                       the lane-J corpus (scripts/lib/slideSettleCorpus.ts)
//   ONLY=<substring>                                       corpus decks whose name contains it
//   JSON=<file>                                            also write every row as JSON
//   node --import tsx scripts/perf/slide-twitch-sweep.mts
//
// Columns (px² per stage px², whole stage): pre = rest before the cue vs its t=0 frame; s0-2 / s2-4 = the first two 2 ms
// windows; s0-F / sF-2F = the first two frames; mid = 2 ms mid-flight; e-4-2 / e-2-0 = the last two 2 ms windows; e-2F-F / e-F-0
// = the last two frames; run = the landing reached frame by frame vs seeked directly. Verdicts: see classify().
// Headless (CPU raster) quantizes slowly moving straight edges to 1/4 px: that is not a defect.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openDeck, sweepDeck, tableRow, TABLE_HEAD, withBrowser, type CueRow, type SweepPayload } from "../lib/slideSettleSweep";

const env = process.env;
const decks: { name: string; payload: SweepPayload }[] = [];
if (env.ROOT && env.DECK) {
  const { gatherDeckPayload } = await import("../../flux-core/slides");
  const { payload } = await gatherDeckPayload(env.ROOT, env.DECK, undefined, { refreshSources: false });
  decks.push({ name: env.DECK, payload: payload as unknown as SweepPayload });
} else if (env.DECKFILE) {
  const deck = JSON.parse(await fs.readFile(env.DECKFILE, "utf8"));
  const plots: Record<string, { svg: string; manifest: unknown }> = {};
  if (env.PLOTS) for (const [id, v] of Object.entries<{ svg: string; manifest: string }>(JSON.parse(await fs.readFile(env.PLOTS, "utf8")))) plots[id] = { svg: await fs.readFile(v.svg, "utf8"), manifest: JSON.parse(await fs.readFile(v.manifest, "utf8")) };
  decks.push({ name: path.basename(env.DECKFILE).replace(/\.deck\.json$|\.json$/, ""), payload: { deck, ...(env.PLOTS ? { plots } : {}) } });
} else if (env.CORPUS) {
  const { corpus } = await import("../lib/slideSettleCorpus");
  for (const d of await corpus(env.CORPUS as "synthetic" | "compact" | "rig" | "all")) if (!env.ONLY || d.name.includes(env.ONLY)) decks.push(d);
} else throw new Error("ROOT+DECK, DECKFILE or CORPUS is required (see the header)");

const slides = env.SLIDES ? env.SLIDES.split(",").map(Number) : undefined;
const all: (CueRow & { deck: string })[] = [];
await withBrowser(async (browser, tmp) => {
  console.log(TABLE_HEAD);
  for (const d of decks) {
    const sp = await openDeck(browser, d.payload, tmp, d.name);
    try {
      for (const r of await sweepDeck(sp, d.payload, { slides })) { all.push({ ...r, deck: d.name }); console.log(tableRow(r, decks.length > 1 ? d.name : "")); }
    } catch (e) { console.log(`${d.name}: sweep failed: ${(e as Error).message}`); }
    finally { await sp.close(); }
  }
});
const bad = all.filter(r => r.flags.length);
console.log(`\n${all.length} cues, ${bad.length} flagged`);
if (env.JSON) await fs.writeFile(env.JSON, JSON.stringify(all, null, 1));
