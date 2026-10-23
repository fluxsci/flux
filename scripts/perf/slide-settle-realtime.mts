// Real-time + compositor start/settle probe (lane J). Plays every cue of a deck/corpus with a real click in OFFSCREEN Electron
// (never a visible window) and reports what the compositor presented: the click-to-first-moving-frame delay and the cue clock at
// that frame (a skipped beginning), the longest player gap and the landing gap (a landing hitch), the change between the last
// presented frame and the static render of the end state, and the change AFTER the landing (a re-bake, a sharpness step, an
// anti-aliasing flip). Columns and thresholds: scripts/lib/slideSettleRealtime.ts.
//   ROOT=<project> DECK=<deckId> | DECKFILE=<deck.json> [PLOTS=<plots.json>] | CORPUS=synthetic|compact|rig|all [ONLY=<name part>]
//   [CUES=slideId#from-to,...] [JSON=<file>]   node --import tsx scripts/perf/slide-settle-realtime.mts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { realtimeSweep, rtRow, RT_HEAD, type RtCue } from "../lib/slideSettleRealtime";
import type { SweepPayload } from "../lib/slideSettleSweep";

const env = process.env;
const decks: { name: string; payload: SweepPayload }[] = [];
if (env.ROOT && env.DECK) {
  const { gatherDeckPayload } = await import("../../flux-core/slides");
  decks.push({ name: env.DECK, payload: (await gatherDeckPayload(env.ROOT, env.DECK, undefined, { refreshSources: false })).payload as unknown as SweepPayload });
} else if (env.DECKFILE) {
  const deck = JSON.parse(await fs.readFile(env.DECKFILE, "utf8")), plots: Record<string, unknown> = {};
  if (env.PLOTS) for (const [id, v] of Object.entries<{ svg: string; manifest: string }>(JSON.parse(await fs.readFile(env.PLOTS, "utf8")))) plots[id] = { svg: await fs.readFile(v.svg, "utf8"), manifest: JSON.parse(await fs.readFile(v.manifest, "utf8")) };
  decks.push({ name: path.basename(env.DECKFILE).replace(/\.json$/, ""), payload: { deck, ...(env.PLOTS ? { plots } : {}) } });
} else if (env.CORPUS) {
  const { corpus } = await import("../lib/slideSettleCorpus");
  for (const d of await corpus(env.CORPUS as "synthetic")) if (!env.ONLY || d.name.includes(env.ONLY)) decks.push(d);
} else throw new Error("ROOT+DECK, DECKFILE or CORPUS is required (see the header)");
const want = env.CUES?.split(",");
const all: RtCue[] = [];
console.log(RT_HEAD);
for (const d of decks) {
  const r = await realtimeSweep(d.payload, d.name, { restMs: env.RESTMS ? Number(env.RESTMS) : undefined, preJs: env.PREJS, dump: env.DUMP, dumpAll: !!env.DUMPALL, only: want ? (s, f, t) => want.includes(`${s}#${f}-${t}`) : undefined });
  if (!all.length) console.log(`# gpu: ${JSON.stringify(r.gpu)}`);
  for (const c of r.cues) { all.push(c); console.log(rtRow(c)); }
}
if (env.JSON) await fs.writeFile(env.JSON, JSON.stringify(all));
