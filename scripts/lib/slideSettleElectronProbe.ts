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
import { hops, judge, KNOWN_OPEN } from "./slideSettleSweep";

const probe = (message: string) => console.log(`PROBE ${message}`);
const decks = await corpus("compact");
/** The cues played for real: one per preset family x element behaviour (a real click and a fresh page each, ~3 s apiece). The seek gate
 *  (verify-slide-settle-sweep.ts) covers every preset on every kind; this one adds what only a compositor shows. Slide id # from-to. */
export const PLAY: Record<string, string[]> = {
  preset_fadeRise: ["p_fadeRise#1-1", "p_fadeRise#2-2", "p_fadeRise#4-4"], preset_popIn: ["p_popIn#1-1", "p_popIn#2-2"], preset_fade: ["p_fade#1-1"],
  preset_drawOn: ["p_drawOn#3-3", "p_drawOn#4-4", "p_drawOn#6-6"], preset_drawOff: ["p_drawOff#3-3", "p_drawOff#6-6"], preset_growBaseline: ["p_growBaseline#1-1"],
  preset_stagger: ["p_stagger#1-1"], preset_stagger_many: ["p_many#1-1"], preset_writeOn: ["p_writeOn#1-1", "p_writeOn#2-2"], preset_fadeOut: ["p_fadeOut#2-2"], preset_popOut: ["p_popOut#2-2"],
  preset_move: ["p_move#1-1"], preset_scale: ["p_scale#1-1"], preset_rotate: ["p_rotate#1-1"], preset_dim: ["p_dim#2-2"], preset_countUp: ["p_countUp#1-1"],
  change: ["change#1-1", "change#3-3", "change#4-4", "change#5-5", "change#7-7", "change#9-9", "change#11-11", "change#13-13", "change#16-16", "change#17-17", "change#18-18", "change#19-19", "change#20-20"],
  become: ["become#1-1", "become#2-2", "become#3-3", "become#4-4"], springs: ["springs#1-1", "springs#3-3", "springs#5-5"], camera: ["camera#1-1", "camera#2-2", "camera#3-3", "camera#4-4", "camera#5-5"],
  chains: ["chains#1-1", "chains#2-2", "chains#3-3", "chains#4-6"], plot_scatter: ["scatter#1-1", "scatter#2-2", "scatter_scaleIn#1-1"], plot_parts: ["parts_pulse#1-1", "parts_scaleOut#1-1"], plot_bars: ["bars#2-2"], plot_lines: ["lines#2-2"],
  interrupt: ["int#1-1"],
  // Release 2 vocabulary (lane V measured it headless only): scale in / scale out / pulse / encircle on a text and a shape, and the soft wipe on a text (its
  // leading edge is a mask-image, which forces its own raster layer while it plays: landing == rest render, nothing changes after it)
  preset_scaleIn: ["p_scaleIn#1-1", "p_scaleIn#2-2"], preset_scaleOut: ["p_scaleOut#1-1", "p_scaleOut#2-2"], preset_pulse: ["p_pulse#1-1", "p_pulse#2-2"], preset_encircle: ["p_encircle#1-1", "p_encircle#2-2"], become_stroked: ["line_shape#1-1", "corners#1-1"], ghost: ["ghost#2-2"],
  // the draw seam: thick closed strokes drawn on and off (the corner closing at the landing is GPU-only)
  draw_seam: ["seam#1-1", "seam#2-2", "seam#3-3", "seam#4-4", "seam#5-5", "seam#6-6"],
  // WP 3.1: the x-clock sweep (line + band + markers on one front), bare lines with the lead dot, and a retreat along x
  plot_sweep: ["sweep#2-2", "sweep_pen#2-2", "sweep_pen#3-3"],
  // WP 3.3: a hand-off and a swap bent by an arc, a rigid turn
  arcs_turns: ["arc_handoff#1-1", "arc_swap#1-1", "turn_rigid#1-1"],
  // WP 3.2: a connector and a label following a box (arc) and a circle (spring), and a label riding a slow move
  attach: ["follow#1-1", "follow#2-2", "draw_moving#1-1", "label_resize#1-1"],
  // R2 follow-up F1: round hand-offs (one rasteriser at both ends), stroked corners, a cornerRadius Change, compound holes
  handoff_round: ["dot_int#1-1", "dot_grow#1-1", "ring_ring#1-1", "six_dots#1-1"],
  become_corners: ["tri_circle#1-1", "rect_circle#1-1", "arrow_circle#1-1", "arrow_circle_ho#1-1", "butt_line_rect#1-1", "ell_rect#1-1", "ell_rect_ho#1-1", "translucent#1-1", "rect_line_round#1-1", "line_rect_round#1-1", "circ_diamond_ho#1-1", "diamond_circ_ho#1-1"],
  set_flights: ["rect_3ellipses#1-1", "six_ring#1-1"], become_depth: ["dest_under#1-1"],
  corner_radius: ["path_20_0#1-1"], compound: ["hole_moves#1-1", "hole_fills#1-1", "hole_opens#1-1", "donut_circle#1-1", "donut_circle_ho#1-1", "donut_same_wind#1-1"],
};
/** Cues whose motion must be CONTINUOUS (a slow text glide): the presented frames inside the motion may not hop (slideSettleSweep `hops`). The stem edit
 *  painted in place stair-stepped (a ~23 unit hop every fourth frame at 1200 ms); on a compositor layer it is smooth. */
export const SMOOTH = ["change#19-19"];
/** The cues the DEVICE-SCALE pass plays (devicePixelRatio 1.25, below): every family whose start or landing a fractional display used to step. */
export const PLAY_DSF: Record<string, string[]> = {
  change: Array.from({ length: 20 }, (_, i) => `change#${i + 1}-${i + 1}`),
  become: ["become#1-1", "become#2-2", "become#3-3", "become#4-4"], preset_move: ["p_move#1-1"], preset_fadeRise: ["p_fadeRise#1-1", "p_fadeRise#2-2"], preset_popIn: ["p_popIn#1-1"],
  preset_scaleIn: ["p_scaleIn#1-1"], preset_writeOn: ["p_writeOn#1-1"], preset_drawOn: ["p_drawOn#3-3"], springs: ["springs#1-1", "springs#3-3", "springs#5-5"],
  chains: ["chains#1-1", "chains#2-2", "chains#3-3", "chains#4-6"], arcs_turns: ["arc_handoff#1-1", "arc_swap#1-1", "turn_rigid#1-1"], attach: ["follow#1-1", "follow#2-2", "draw_moving#1-1", "label_resize#1-1"],
  handoff_round: ["dot_int#1-1", "six_dots#1-1"], camera: ["camera#1-1", "camera#2-2", "camera#3-3"],
};
const DSF_MIN_CUES = 45;
const flagsOf = (c: Parameters<typeof rtFlags>[0], deck: string) => {
  const flags = rtFlags(c);
  if (SMOOTH.includes(c.name.slice(deck.length + 1)) && c.landedAt != null) {
    const motion = c.frames.filter(x => x.t >= 0 && x.t <= c.landedAt! + 20).map(x => x.d), at = hops(motion);
    if (at.length) flags.push(`HOP (${at.length} frame${at.length > 1 ? "s" : ""}: ${at.slice(0, 3).map(i => `${motion[i].toFixed(1)} beside ${Math.max(motion[i - 1], motion[i + 1]).toFixed(1)}`).join(", ")})`);
  }
  return flags;
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
const MAX_RETRIED = 4, MAX_RETRIED_DSF = 3;
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
    const attempts = [judge(flagsOf(c, d.name), open, "rt")];
    if (attempts[0].failing.length || attempts[0].stale.length) {
      const only = c.name.slice(d.name.length + 1);
      for (let i = 0; i < 2; i++) {
        const again = (await run((slide, from, to) => `${slide}#${from}-${to}` === only)).cues[0];
        if (!again) continue;
        probe(`retry ${i + 1} ${rtRow(again)}`);
        attempts.push(judge(flagsOf(again, d.name), open, "rt"));
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

// THE DEVICE-SCALE PASS (smoothness pass, 2026-10-24): the same judging on a FRACTIONALLY scaled display, devicePixelRatio 1.25 (the owner's
// desktop), in a window whose size is a whole number of device pixels (1004 x 612 CSS = 1255 x 765: a real Wayland surface is one; an odd CSS
// size at 1.25 is not, and its rounding moves the measurement, not the slide) and a stage scale that lands on no grid at all (1.96 device px
// per stage px). Every move used to end with a 0.5-0.7 device px jump here and every glide's start / later cue stepped its anti-aliasing: the
// pass at devicePixelRatio 1 could see neither (whole stage pixels are whole device pixels there). Judged with no KNOWN_OPEN tolerance beyond
// the main pass's own entries; a stale entry is the main pass's business.
const DSF = { dsf: 1.25, width: 1004, height: 612 };
let dsfCues = 0;
probe(`device-scale pass: devicePixelRatio ${DSF.dsf}, ${DSF.width}x${DSF.height}`);
for (const d of decks) {
  const want = PLAY_DSF[d.name]; if (!want) continue;
  const run = (only: (slide: string, from: number, to: number) => boolean) => realtimeSweep(d.payload, d.name, { fresh: true, restMs: 350, tailMs: 450, only, ...DSF });
  const r = await run((slide, from, to) => want.includes(`${slide}#${from}-${to}`));
  for (const c of r.cues) {
    dsfCues++;
    probe(`dsf ${rtRow(c)}`);
    const open = KNOWN_OPEN[c.name], attempts = [judge(flagsOf(c, d.name), open, "rt")];
    if (attempts[0].failing.length) {
      const only = c.name.slice(d.name.length + 1);
      for (let i = 0; i < 2; i++) {
        const again = (await run((slide, from, to) => `${slide}#${from}-${to}` === only)).cues[0];
        if (!again) continue;
        probe(`dsf retry ${i + 1} ${rtRow(again)}`);
        attempts.push(judge(flagsOf(again, d.name), open, "rt"));
      }
      retried.push(`dsf ${c.name}`);
    }
    const seen = new Map<string, { n: number; text: string }>();
    for (const a of attempts) for (const flag of new Set(a.failing.map(cls))) seen.set(flag, { n: (seen.get(flag)?.n ?? 0) + 1, text: a.failing.find(x => cls(x) === flag)! });
    const failing = [...seen.values()].filter(v => v.n >= (attempts.length === 1 ? 1 : 2)).map(v => v.text);
    if (failing.length) failures.push(`dsf ${c.name}: ${failing.join(", ")}`);
  }
}
assert.ok(dsfCues >= DSF_MIN_CUES, `the device-scale pass measured ${dsfCues} cues`);
probe(`retried ${retried.length} cue(s)${retried.length ? `: ${retried.join(", ")}` : ""}`);
assert.ok(cues >= 46, `the real-time sweep measured ${cues} cues`);
const retriedMain = retried.filter(n => !n.startsWith("dsf ")), retriedDsf = retried.filter(n => n.startsWith("dsf "));
assert.ok(retriedMain.length <= MAX_RETRIED, `${retriedMain.length} cues needed a second look (more than ${MAX_RETRIED}: a loaded machine or an intermittent defect): ${retriedMain.join(", ")}`);
assert.ok(retriedDsf.length <= MAX_RETRIED_DSF, `${retriedDsf.length} device-scale cues needed a second look (more than ${MAX_RETRIED_DSF}): ${retriedDsf.join(", ")}`);
assert.equal(failures.length, 0, `real-time start/settle failures:\n${failures.join("\n")}`);
console.log(`SLIDE SETTLE ELECTRON: PASS (${cues} cues + ${dsfCues} at devicePixelRatio ${DSF.dsf}, ${retried.length} retried)`);
