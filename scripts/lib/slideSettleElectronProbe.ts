/** Start/settle in the REAL-TIME + COMPOSITOR domain (lane J), launched by verify-slide-settle-electron.cjs. Each cue of the compact corpus
 *  is played with a real click (and the interrupt decks with a second click mid-step) in OFFSCREEN Electron (show:false: no window is ever
 *  shown, no dev server, no port), and the frames the compositor PRESENTED are judged (scripts/lib/slideSettleRealtime.ts: thresholds and
 *  flags). Criteria (all judged, none merely printed): the click reaches the first moving frame within the Nielsen budget (START HITCH) and
 *  the cue clock has not run ahead at it (SKIPPED BEGINNING); no uneven pacing inside the motion and no long frame at landing; the first
 *  presented frame equals the rest before it and the first frame that changed steps like the one after it (START STEP, FIRST FRAME != REST);
 *  the landing frame equals the static render of the end state, steps like its neighbours and nothing changes after it; an interrupt settles
 *  without a jump. */
import assert from "node:assert/strict";
import { corpus } from "./slideSettleCorpus";
import { chromaShare, GRAYSCALE_MAX_SHARE, realtimeSweep, rtFlags, rtRow, RT_HEAD } from "./slideSettleRealtime";
import { judge, KNOWN_OPEN } from "./slideSettleSweep";

const probe = (message: string) => console.log(`PROBE ${message}`);
const decks = await corpus("compact");
/** The cues played for real: one per preset family x element behaviour (a real click and a fresh page each, ~3 s apiece). The seek gate
 *  (verify-slide-settle-sweep.ts) covers every preset on every kind; this one adds what only a compositor shows. Slide id # from-to. */
export const PLAY: Record<string, string[]> = {
  preset_fadeRise: ["p_fadeRise#1-1", "p_fadeRise#2-2", "p_fadeRise#4-4"], preset_popIn: ["p_popIn#1-1", "p_popIn#2-2"], preset_fade: ["p_fade#1-1"],
  preset_drawOn: ["p_drawOn#3-3", "p_drawOn#4-4", "p_drawOn#6-6"], preset_drawOff: ["p_drawOff#3-3", "p_drawOff#6-6"], preset_growBaseline: ["p_growBaseline#1-1"],
  preset_stagger: ["p_stagger#1-1"], preset_stagger_many: ["p_many#1-1"], preset_writeOn: ["p_writeOn#2-2"], preset_fadeOut: ["p_fadeOut#2-2"], preset_popOut: ["p_popOut#2-2"],
  preset_move: ["p_move#1-1"], preset_scale: ["p_scale#1-1"], preset_rotate: ["p_rotate#1-1"], preset_dim: ["p_dim#2-2"], preset_countUp: ["p_countUp#1-1"],
  change: ["change#1-1", "change#4-4", "change#5-5", "change#7-7", "change#9-9", "change#11-11", "change#13-13", "change#16-16", "change#17-17"],
  become: ["become#1-1", "become#2-2", "become#3-3"], springs: ["springs#1-1", "springs#3-3", "springs#5-5"], camera: ["camera#1-1", "camera#2-2", "camera#3-3", "camera#4-4", "camera#5-5"],
  chains: ["chains#1-1", "chains#2-2", "chains#3-3", "chains#4-6"], plot_scatter: ["scatter#1-1", "scatter#2-2"], plot_bars: ["bars#2-2"], plot_lines: ["lines#2-2"],
  interrupt: ["int#1-1"], become_stroked: ["line_shape#1-1", "corners#1-1"], ghost: ["ghost#2-2"],
  // R2 follow-up F1: round hand-offs (one rasteriser at both ends), stroked corners, a cornerRadius Change, compound holes
  handoff_round: ["dot_int#1-1", "dot_grow#1-1", "ring_ring#1-1", "six_dots#1-1"],
  become_corners: ["tri_circle#1-1", "rect_circle#1-1", "arrow_circle#1-1", "arrow_circle_ho#1-1", "butt_line_rect#1-1", "ell_rect#1-1", "ell_rect_ho#1-1", "translucent#1-1"],
  set_flights: ["rect_3ellipses#1-1", "six_ring#1-1"],
  corner_radius: ["path_20_0#1-1"], compound: ["hole_moves#1-1", "hole_fills#1-1", "hole_opens#1-1", "donut_circle#1-1", "donut_circle_ho#1-1", "donut_same_wind#1-1"],
};
// A cue another lane owns (or a documented open item) is tolerated ONLY for the flags KNOWN_OPEN names for the real-time domain, and a REQUIRED
// entry whose flag stopped firing fails the gate (the entry must be deleted).
//
// The gate's HOME / XDG dirs are fresh, so every GPU cache is cold: the first use of a pipeline in the whole run (a round-cap line whose stroke
// width animates, the first `drawOff`) can hitch once, ~80-100 ms, 3 runs in 3 cold and 0 in 22 warm. That is not a defect of the cue, and the
// retry sees it warm; it is measured in the lane report as an open risk.
//
// This runs on a live desktop, so a frame the machine dropped must not fail a structural gate, and a structural defect must not hide behind a
// retry. A cue that fails its first run is run twice more on fresh pages and judged by MAJORITY: a flag class counts when it shows in at least
// 2 of the 3 runs. Every retried cue is printed and counted, and more than MAX_RETRIED of them fails the gate (a loaded machine or an
// intermittent defect shows up as many retries, not as one). A defect that fires in fewer than ~1 run in 3 is below this gate's resolution:
// measure its rate with the probe (REPEAT=<n> scripts/perf/slide-settle-realtime.mts) before and after a fix.
const MAX_RETRIED = 4;
const cls = (flag: string) => flag.split(" (")[0];
const failures: string[] = [], retried: string[] = [], played = new Set<string>();
let cues = 0;
probe(RT_HEAD);
for (const d of decks) {
  const interrupts = d.name === "interrupt" ? { "int#1-1": 300 } : undefined;
  const want = PLAY[d.name]; if (!want) continue;
  const run = (only: (slide: string, from: number, to: number) => boolean) => realtimeSweep(d.payload, d.name, { interrupts, fresh: true, restMs: 350, tailMs: 450, only });
  const r = await run((slide, from, to) => want.includes(`${slide}#${from}-${to}`));
  for (const c of r.cues) {
    cues++; played.add(c.name);
    const open = KNOWN_OPEN[c.name];
    probe(rtRow(c));
    const attempts = [judge(rtFlags(c), open, "rt")];
    if (attempts[0].failing.length || attempts[0].stale.length) {
      const only = c.name.slice(d.name.length + 1);
      for (let i = 0; i < 2; i++) {
        const again = (await run((slide, from, to) => `${slide}#${from}-${to}` === only)).cues[0];
        if (!again) continue;
        probe(`retry ${i + 1} ${rtRow(again)}`);
        attempts.push(judge(rtFlags(again), open, "rt"));
      }
      retried.push(c.name);
    }
    const count = (pick: (a: ReturnType<typeof judge>) => string[]) => {
      const seen = new Map<string, { n: number; text: string }>();
      for (const a of attempts) for (const flag of new Set(pick(a).map(cls))) seen.set(flag, { n: (seen.get(flag)?.n ?? 0) + 1, text: pick(a).find(x => cls(x) === flag)! });
      return [...seen.values()].filter(v => v.n >= (attempts.length === 1 ? 1 : 2)).map(v => v.text);
    };
    // LCD vs grayscale (class iii): the text-only deck's stage carries no colour fringes at rest or on the landing frame
    if (c.name === "preset_fadeRise/p_fadeRise#1-1") {
      const rest = chromaShare(c.refChroma), land = chromaShare(c.landChroma);
      if (rest == null || land == null || rest > GRAYSCALE_MAX_SHARE || land > GRAYSCALE_MAX_SHARE) failures.push(`${c.name}: slide text is not grayscale-antialiased (chromatic ink: rest ${rest}, landing ${land}; max ${GRAYSCALE_MAX_SHARE}): a layer promotion could flip LCD <-> grayscale`);
      probe(`grayscale text: chromatic share rest ${rest?.toFixed(4)}, landing ${land?.toFixed(4)} (an LCD page reads ~0.6: scripts/perf/slide-lcd-probe.cjs)`);
    }
    const failing = count(a => a.failing), stale = count(a => a.stale);
    if (failing.length) failures.push(`${c.name}: ${failing.join(", ")}`);
    if (stale.length) failures.push(`${c.name}: STALE KNOWN_OPEN entry (${stale.join(", ")} no longer fires in the real-time domain: delete it from scripts/lib/slideSettleSweep.ts)`);
  }
}
for (const [key, open] of Object.entries(KNOWN_OPEN)) if (open.rt && !played.has(key)) failures.push(`${key}: KNOWN_OPEN names a real-time flag for a cue the gate does not play (add it to PLAY or delete the entry)`);
probe(`retried ${retried.length} cue(s)${retried.length ? `: ${retried.join(", ")}` : ""}`);
assert.ok(cues >= 46, `the real-time sweep measured ${cues} cues`);
assert.ok(retried.length <= MAX_RETRIED, `${retried.length} cues needed a second look (more than ${MAX_RETRIED}: a loaded machine or an intermittent defect): ${retried.join(", ")}`);
assert.equal(failures.length, 0, `real-time start/settle failures:\n${failures.join("\n")}`);
console.log(`SLIDE SETTLE ELECTRON: PASS (${cues} cues, ${retried.length} retried)`);
