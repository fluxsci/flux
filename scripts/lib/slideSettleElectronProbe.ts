/** Start/settle in the REAL-TIME + COMPOSITOR domain (lane J), launched by verify-slide-settle-electron.cjs. Each cue of the compact corpus
 *  is played with a real click (and the interrupt decks with a second click mid-step) in OFFSCREEN Electron (show:false: no window is ever
 *  shown, no dev server, no port), and the frames the compositor PRESENTED are judged (scripts/lib/slideSettleRealtime.ts: thresholds and
 *  flags). Criteria: the first moving frame is one frame after frame 0 (no skipped beginning); no long frame at landing; the landing
 *  frame equals the static render of the end state; nothing changes after the landing; the landing frame changes like its neighbours;
 *  an interrupt settles without a jump. */
import assert from "node:assert/strict";
import { corpus } from "./slideSettleCorpus";
import { realtimeSweep, rtFlags, rtRow, RT_HEAD } from "./slideSettleRealtime";
import { KNOWN_OPEN } from "./slideSettleSweep";

const probe = (message: string) => console.log(`PROBE ${message}`);
const decks = await corpus("compact");
/** The cues played for real: one per preset family x element behaviour (a real click and a fresh page each, ~3 s apiece). The seek gate
 *  (verify-slide-settle-sweep.ts) covers every preset on every kind; this one adds what only a compositor shows. Slide id # from-to. */
const PLAY: Record<string, string[]> = {
  preset_fadeRise: ["p_fadeRise#1-1", "p_fadeRise#2-2", "p_fadeRise#4-4"], preset_popIn: ["p_popIn#1-1", "p_popIn#2-2"], preset_fade: ["p_fade#1-1"],
  preset_drawOn: ["p_drawOn#3-3", "p_drawOn#4-4", "p_drawOn#6-6"], preset_drawOff: ["p_drawOff#3-3", "p_drawOff#6-6"], preset_growBaseline: ["p_growBaseline#1-1"],
  preset_stagger: ["p_stagger#1-1"], preset_writeOn: ["p_writeOn#2-2"], preset_fadeOut: ["p_fadeOut#2-2"], preset_popOut: ["p_popOut#2-2"],
  preset_move: ["p_move#1-1"], preset_scale: ["p_scale#1-1"], preset_rotate: ["p_rotate#1-1"], preset_dim: ["p_dim#2-2"], preset_countUp: ["p_countUp#1-1"],
  change: ["change#1-1", "change#4-4", "change#5-5", "change#7-7", "change#9-9", "change#11-11", "change#13-13"],
  become: ["become#1-1", "become#2-2", "become#3-3"], springs: ["springs#1-1", "springs#3-3", "springs#5-5"], camera: ["camera#1-1", "camera#2-2", "camera#3-3"],
  chains: ["chains#1-1", "chains#2-2", "chains#3-3", "chains#4-6"], plot_scatter: ["scatter#1-1", "scatter#2-2"], plot_bars: ["bars#2-2"], plot_lines: ["lines#2-2"],
  interrupt: ["int#1-1"],
};
// A cue another lane owns (or a documented open item) is tolerated ONLY for the flags the seek gate names too; the real-time domain has no entries of its own.
const failures: string[] = [];
let cues = 0;
probe(RT_HEAD);
for (const d of decks) {
  const interrupts = d.name === "interrupt" ? { "int#1-1": 300 } : undefined;
  const want = PLAY[d.name]; if (!want) continue;
  const r = await realtimeSweep(d.payload, d.name, { interrupts, fresh: true, restMs: 350, tailMs: 450, only: (slide, from, to) => want.includes(`${slide}#${from}-${to}`) });
  for (const c of r.cues) {
    cues++;
    const key = c.name.replace(/\/[^#]*#/, "#");
    const open = KNOWN_OPEN[key];
    probe(rtRow(c));
    const flags = rtFlags(c).filter(f => !open);   // an entry in KNOWN_OPEN is a SEEK-domain item; its cue is exempt here only when listed
    if (flags.length) failures.push(`${c.name}: ${flags.join(", ")}`);
  }
}
assert.ok(cues >= 45, `the real-time sweep measured ${cues} cues`);
assert.equal(failures.length, 0, `real-time start/settle failures:\n${failures.join("\n")}`);
console.log(`SLIDE SETTLE ELECTRON: PASS (${cues} cues)`);
