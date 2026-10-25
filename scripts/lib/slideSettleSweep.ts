// Start/settle SWEEP core (lane J): paint change across the boundaries of every cue of a deck, in the portable player
// (headless Chrome, CPU raster, seek domain). Shared by scripts/perf/slide-twitch-sweep.mts (the probe, any deck) and
// scripts/verify-slide-settle-sweep.ts (the gate, a curated corpus).
//
// The manim law this measures: the frame before a cue IS the rest state; the first moving frame differs from it by one frame
// of motion; the last frame of motion converges on the static render of the end state; nothing changes after the landing.
//
// A cue is what one Present click plays: the beat (and its with-previous followers) from `from` to `to`. Its length is the
// PLAYER'S OWN (`fluxDeck.state().duration` after a seek: compiled cue end, stagger and per-node delays included), never
// max(start + duration). Every window is measured twice:
//   * a 2 ms window  - an INSTANT jump (a pop at t = 0+, a snap at the last 2 ms) shows as a spike next to an equal window;
//   * a one-frame window (16.7 ms at 60 fps) - a ONE-FRAME pop (a first frame that moves 5x what the next one does) is told
//     from a fast start.
// Thresholds are relative to the NEIGHBOURING window of the same width (a smooth curve changes about as much in its first
// window as in the one beside it), with an absolute floor under which a change is sub-visible noise.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { exportDeckHtml } from "../../src/lib/slide/export/exportDeck";
import { cueEnd } from "../../src/lib/slide/video";
import type { Deck, Slide } from "../../src/lib/slide/types";

export const FRAME_MS = 1000 / 60;
/** Tiny windows (ms): wide enough that an eased start still moves < 1/255 of a level, narrow enough that a pop is a spike. */
export const TINY_MS = 2;
/** The window of the MID FREEZE test (six frames: long enough that a discrete count flip or a quantised glide cannot hide in it). */
export const QUARTER_MS = 100;
/** "Seek to the end" (page.evaluate would serialise Infinity to null): the player clamps a seek to the cue length. */
const REST = 1e9;
/** The comparison is PERCEPTUAL: both images are averaged 2x2 (a 1 device-pixel box filter) and a per-channel difference under
 *  `DEAD_BAND` levels (4 %) counts as equal. A bezier ring against the browser's own ellipse differs by 0.03 % of its radius, a resized
 *  rect's edge by 0.15 device px, a headless raster steps slow edges by 1/4 px: sub-visible all, but each would read as a boundary
 *  "change" at 1:1. A dot, a stroke that thickens, text that re-rasterises (bolder/softer), a corner that pops, a colour step are far
 *  above it. DEAD=0 prints the raw numbers (the probes accept it). */
export const DEAD_BAND = Number(process.env.DEAD ?? 10);

export interface SweepPayload { deck: Deck; plots?: Record<string, unknown>; assets?: Record<string, string>; [k: string]: unknown }
export interface CueRow {
  slide: number; slideId: string; from: number; to: number; label: string;
  /** The player's own cue length (ms). */
  dur: number;
  /** pre = the rest state before the cue (static end of the previous step); NaN when the cue starts the slide. */
  dPre: number;
  /** Δ t=0 → t=2 ms, 2 → 4 ms, 0 → 1 frame, 1 → 2 frames. */
  s02: number; s24: number; sF: number; sF2: number;
  /** the same two frame windows WITHOUT the dead band: a smooth start grows from nothing (t^2 .. t^3), and the dead band reads every sub-4 % early
   *  frame as exactly 0, so the second-frame test needs the raw numbers or a slow start (a growing bar) looks like a late pop. */
  sFr: number; sF2r: number;
  /** mid-flight Δ over 2 ms and over one frame (the cue's own motion scale). */
  mid: number; midF: number;
  /** RAW change over `QUARTER_MS` starting a quarter of the way into the cue: a cue that moves at mid-flight is never still a quarter in (a text
   *  rewrite whose spans counted and recoloured unseen under the static render, then took over in one frame, read 0.0 here and 100 at mid-flight). */
  q4: number;
  /** Δ D-4 → D-2, D-2 → D, D-2F → D-F, D-F → D. */
  e42: number; e20: number; eF2: number; eF: number;
  /** landing reached by seeking forward frame by frame vs seeked directly (a controller crossing must leave the same pixels). */
  dRun: number;
  flags: string[];
}

export interface Thresholds {
  /** px²-per-stage-px² units under which a window change is invisible. */
  floorTiny: number; floorFrame: number;
  /** a boundary window must exceed this many times its neighbour to count as a spike. */
  ratioTiny: number; ratioFrame: number;
  /** the SECOND frame of a start: a smooth start grows 3x (t^2) to 7x (t^3) from its first frame to its second, never from nothing to a sizeable
   *  part of the cue's own motion (judged on the RAW frame windows, sFr / sF2r). It is a pop when it exceeds `ratioSecond` x the first frame AND `secondOfMid` of a mid-flight frame
   *  (a content swap that lands one frame late, e.g. the count-up's digit slots replacing the resting number). */
  ratioSecond: number; secondOfMid: number;
  /** ... and above this many units (3x floorFrame): a quick curve (dim, quick smooth) moves most of a small element's change in its second frame while
   *  the first reads ~0 and nothing moves at mid-flight, so a low floor would call every quick start a pop. */
  floorSecond: number;
  /** MID FREEZE: the raw change over `QUARTER_MS` at D/4 must exceed this when the cue moves at mid-flight (`midF` above floorFrame). */
  freeze: number;
  /** a post-landing change must stay under this (it should be exactly 0). */
  rest: number;
  /** the landing reached frame by frame vs seeked directly: a seek has no priming frame, so headless Chrome bakes a gliding layer
   *  mid-flight at a fractional phase (up to ~20 units for a staggered word); a controller residue (a stale style) is >= 100. */
  run: number;
  /** the frame before the cue vs its t=0 frame: a cue that promotes a layer (a gliding or recolouring node) is re-rastered by headless Chrome
   *  at its first frame, which moves sub-pixel edges of the whole stage by up to ~17 units; a real pre-roll pop (a dimmed highlight) is >= 100. */
  pre: number;
}
/** The floors are physical: 6 units is a 0.1 stage px shift of a 60 px edge (a 3 px round-cap dot is 7). Under it sits the residue of
 *  device-pixel snapping: a wrapper's layout box is whole STAGE px, which at a fractional fit scale (2.5x here) the browser snaps to the
 *  device grid at rest but not in flight, so a resized stroked shape lands up to ~0.15 device px off its last frame. Nobody can see that;
 *  a dot, a thickened stroke, re-rasterised text, a popped corner are all well above it. */
export const THRESHOLDS: Thresholds = { floorTiny: 6, floorFrame: 8, ratioTiny: 4, ratioFrame: 3, ratioSecond: 10, secondOfMid: 0.25, floorSecond: 24, freeze: 0.5, rest: 2, run: 30, pre: 25 };

const spike = (a: number, b: number, floor: number, ratio: number) => a > floor && a > ratio * Math.max(b, 0.25);

/** HOP: a presented frame inside a motion that must be CONTINUOUS (a glide: stem edit, number + unit) changes several times more than both of its
 *  neighbours. Painted in place, a slow text glide moves in quarter-device-pixel hops (0.8, 23.4, 0.3 beside 1.1: smooth on a compositor layer,
 *  stair-stepped in place); a layer moves it at float precision. Judged only for the cues a gate lists as continuous (a count flips digits,
 *  a stagger starts nodes one by one: their series are legitimately spiky). `d` = the change from the previous presented frame; the first and
 *  the last frame of the motion belong to START STEP / LANDING STEP. */
export const HOP = { ratio: 4, floor: 8 } as const;
export function hops(d: readonly number[], t = HOP): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < d.length; i++) if (d[i] > t.floor && d[i] > t.ratio * Math.max(d[i - 1], d[i + 1])) out.push(i);
  return out;
}

// The second-frame rule reads a QUANTISED slow start as a content swap, and three study-rig cues still show it (`CORPUS=rig`, measured by R2 F2; none is a
//  defect, none is in the gate's corpus, so they are recorded here instead of being tolerated by an entry nothing could check):
//    W `dim_demo` (slide 5 `dim`)        raw 1.4 -> 214.7: opacity 1 -> 0.99558 (16.7 ms) -> 0.98060 (33 ms): a 0.0044 step is under one 8-bit level on most
//                                         fills, 0.015 reaches 1 to 3 levels, so the first frame reads 0 and the second a whole shape;
//    T6 `growBaseline` (bars_mixed)      raw 12.2 -> 260.1: scaleY 0.0063 -> 0.0277 on bars 0.2 to 0.4 axis units tall (about 6 px): a 0.04 px, then a 0.17 px sliver;
//    T3 `writeOn` on text, HARD clip     raw 0.0 -> 75.5: a pre-WP-2.4 track has no `edge`, and the hard edge crosses the first stem in frame 2. The soft
//                                         edge every new writeOn is authored with reads 0.0 -> 4.7 on the same text (and plays clean on the compositor).
//  The same rule still catches the real thing (a content swap one frame late: the count-up case in KNOWN_OPEN, START POP 2nd frame 209, gated).
/** The verdict for one measured cue, from its windows alone (pure; the gate pins it). */
export function classify(r: Omit<CueRow, "flags">, t: Thresholds = THRESHOLDS): string[] {
  const flags: string[] = [];
  if (Number.isFinite(r.dPre) && r.dPre > t.pre) flags.push("PRE-ROLL CHANGE");
  if (spike(r.s02, r.s24, t.floorTiny, t.ratioTiny)) flags.push("START POP (2ms)");
  if (spike(r.sF, r.sF2, t.floorFrame, t.ratioFrame)) flags.push("START POP (frame)");
  if (r.sF2r > t.floorSecond && r.sF2r > t.ratioSecond * Math.max(r.sFr, 0.25) && r.sF2r > t.secondOfMid * r.midF) flags.push("START POP (2nd frame)");
  if (spike(r.e20, r.e42, t.floorTiny, t.ratioTiny)) flags.push("END SNAP (2ms)");
  if (spike(r.eF, r.eF2, t.floorFrame, t.ratioFrame)) flags.push("END SNAP (frame)");
  if (r.midF > t.floorFrame && r.q4 < t.freeze) flags.push("MID FREEZE");
  if (r.dRun > t.run) flags.push("POST CHANGE");
  return flags;
}

export interface SweepPage { page: import("puppeteer-core").Page; close(): Promise<void>; k: number; clip: { x: number; y: number; width: number; height: number } }

/** Export the deck to a standalone HTML file and open it. One page per deck (the export bakes its payload). */
export async function openDeck(browser: import("puppeteer-core").Browser, payload: SweepPayload, tmp: string, name = "deck"): Promise<SweepPage> {
  const file = path.join(tmp, `${name.replace(/[^\w.-]+/g, "_")}.html`);
  await fs.writeFile(file, (await exportDeckHtml(payload as never)).html);
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction("!!window.fluxDeck?.seek");
  const cam = await page.evaluate(() => { const r = (document.querySelector(".sl-camera") as HTMLElement).parentElement!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  return { page, k: cam.w / payload.deck.stage.width, clip: { x: cam.x, y: cam.y, width: cam.w, height: cam.h }, close: () => page.close() };
}

type Hook = { seek(s: number, b: number, t: number, from?: number): void; state(): { duration: number } };
/** Every cue a click plays, in order: a click beat and its with-previous followers; step zero when it animates. */
export function cuesOf(slide: Slide): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let b = 0; b < slide.beats.length;) {
    const to = cueEnd(slide, b);
    if (slide.beats.slice(b, to + 1).some(x => x.tracks.length)) out.push({ from: b, to });
    b = to + 1;
  }
  return out;
}

/** Perceptual change between two RGBA screenshots (see DEAD_BAND), in stage px^2 per stage px^2 (scale `k`). */
export function perceptualDiff(a: ArrayLike<number>, b: ArrayLike<number>, width: number, k: number, dead = DEAD_BAND): number {
  const h = Math.floor(a.length / 4 / width);
  let d = 0;
  for (let y = 0; y + 1 < h; y += 2) for (let x = 0; x + 1 < width; x += 2) {
    const i = (y * width + x) * 4, j = i + width * 4;
    for (let c = 0; c < 3; c++) {
      const va = (a[i + c] + a[i + 4 + c] + a[j + c] + a[j + 4 + c]) / 4, vb = (b[i + c] + b[i + 4 + c] + b[j + c] + b[j + 4 + c]) / 4;
      const v = Math.abs(va - vb) - dead;
      if (v > 0) d += v * 4;      // one averaged pixel stands for four
    }
  }
  return d / 765 / (k * k);
}

export function kindsOf(slide: Slide, from: number, to: number): string {
  const tracks = slide.beats.slice(from, to + 1).flatMap(b => b.tracks);
  return [...new Set(tracks.map(t => (t.to as { become?: unknown } | undefined)?.become ? "handoff" : t.preset ?? "?"))].join("+");
}

export interface SweepOptions { slides?: number[]; cues?: (slide: Slide, from: number, to: number) => boolean; thresholds?: Thresholds }

export async function sweepDeck(sp: SweepPage, payload: SweepPayload, opts: SweepOptions = {}): Promise<CueRow[]> {
  const { page, k, clip } = sp;
  const seek = (s: number, b: number, t: number, from = b) => page.evaluate(({ s, b, t, from }) => { (window as unknown as { fluxDeck: Hook }).fluxDeck.seek(s, b, t, from); }, { s, b, t, from });
  const settle = () => page.evaluate(`new Promise(r => requestAnimationFrame(r))`);
  const grab = async (s: number, b: number, t: number, from = b) => {
    await seek(s, b, t, from); await settle();
    const img = await loadImage(await page.screenshot({ clip, type: "png" }) as Buffer);
    const c = createCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0);
    return c.getImageData(0, 0, img.width, img.height).data;
  };
  const W = Math.round(clip.width);
  const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => perceptualDiff(a, b, W, k);
  const raw = (a: Uint8ClampedArray, b: Uint8ClampedArray) => perceptualDiff(a, b, W, k, 0);
  const rows: CueRow[] = [];
  const slides = opts.slides ?? payload.deck.slides.map((_, i) => i);
  for (const s of slides) {
    const slide = payload.deck.slides[s];
    for (const { from, to } of cuesOf(slide)) {
      if (opts.cues && !opts.cues(slide, from, to)) continue;
      await seek(s, to, 0, from);
      const D = await page.evaluate(() => (window as unknown as { fluxDeck: Hook }).fluxDeck.state().duration);
      if (!(D > 0)) continue;
      const F = FRAME_MS;
      // the frame before the cue: the static end of the previous step (none for a cue that opens the slide)
      const pre = from > 0 ? await grab(s, from - 1, REST) : undefined;
      const f = {
        p0: await grab(s, to, 0, from), p2: await grab(s, to, TINY_MS, from), p4: await grab(s, to, 2 * TINY_MS, from),
        pF: await grab(s, to, Math.min(F, D), from), p2F: await grab(s, to, Math.min(2 * F, D), from),
        mid: await grab(s, to, D / 2, from), mid2: await grab(s, to, D / 2 + TINY_MS, from), midF: await grab(s, to, D / 2 + F, from),
        q0: await grab(s, to, D / 4, from), q1: await grab(s, to, Math.min(D, D / 4 + QUARTER_MS), from),
        e2F: await grab(s, to, Math.max(0, D - 2 * F), from), eF: await grab(s, to, Math.max(0, D - F), from),
        e4: await grab(s, to, Math.max(0, D - 2 * TINY_MS), from), e2: await grab(s, to, Math.max(0, D - TINY_MS), from), e0: await grab(s, to, D, from),
      };
      // the landing reached the way playback reaches it: every frame in order, then the end (controllers cross their boundaries)
      for (let t = 0; t < D; t += F) await seek(s, to, t, from);
      await seek(s, to, D, from); await settle();
      const img = await loadImage(await page.screenshot({ clip, type: "png" }) as Buffer);
      const c = createCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0);
      const run = c.getImageData(0, 0, img.width, img.height).data;
      const row: Omit<CueRow, "flags"> = {
        slide: s, slideId: slide.id, from, to, label: kindsOf(slide, from, to), dur: D,
        dPre: pre ? diff(pre, f.p0) : NaN,
        s02: diff(f.p0, f.p2), s24: diff(f.p2, f.p4), sF: diff(f.p0, f.pF), sF2: diff(f.pF, f.p2F), sFr: raw(f.p0, f.pF), sF2r: raw(f.pF, f.p2F),
        mid: diff(f.mid, f.mid2), midF: diff(f.mid, f.midF), q4: raw(f.q0, f.q1),
        e42: diff(f.e4, f.e2), e20: diff(f.e2, f.e0), eF2: diff(f.e2F, f.eF), eF: diff(f.eF, f.e0),
        dRun: diff(f.e0, run),
      };
      rows.push({ ...row, flags: classify(row, opts.thresholds) });
    }
  }
  return rows;
}

const n = (v: number, w = 6) => (Number.isFinite(v) ? v.toFixed(1) : "  -").padStart(w);
export const TABLE_HEAD = "slide beat   dur(ms) tracks    pre   s0-2   s2-4  s0-F  sF-2F  s0-Fr sF-2Fr    mid   midF     q4  e-4-2  e-2-0 e-2F-F  e-F-0   run  verdict";
export function tableRow(r: CueRow, name = ""): string {
  const beat = r.from === r.to ? String(r.from) : `${r.from}-${r.to}`;
  return `${(name || String(r.slide)).slice(0, 18).padStart(5)} ${beat.padStart(4)}  ${String(Math.round(r.dur)).padStart(7)} ${r.label.slice(0, 9).padEnd(9)} ${n(r.dPre)} ${n(r.s02)} ${n(r.s24)} ${n(r.sF)} ${n(r.sF2, 6)} ${n(r.sFr)} ${n(r.sF2r, 7)} ${n(r.mid)} ${n(r.midF, 7)} ${n(r.q4)} ${n(r.e42)} ${n(r.e20)} ${n(r.eF2, 7)} ${n(r.eF)} ${n(r.dRun)}  ${r.flags.join(", ") || "ok"}`;
}

export async function withBrowser<T>(fn: (browser: import("puppeteer-core").Browser, tmp: string) => Promise<T>): Promise<T> {
  const { launch } = await import("./driver.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-settle-sweep-"));
  const { browser } = await launch({ width: 1600, height: 900 });
  try { return await fn(browser, tmp); }
  finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
}

/** One tolerated cue. `seek` = flags it MUST show in the seek-domain sweep, `rt` = flags it MUST show in the real-time gate, `rtMay` = flags the real-time
 *  gate tolerates without requiring (a ratio test that straddles its threshold from run to run). A REQUIRED flag that no longer fires fails
 *  the gate ("stale entry: delete it"), so an entry can never outlive its defect and silently allow a regression of exactly that class. Flags
 *  are matched by prefix (the real-time flags carry their numbers). */
export interface OpenCase {
  seek?: string[]; rt?: string[]; rtMay?: string[];
  /** A pinned MAGNITUDE per flag prefix (stage px^2 per stage px^2): a tolerated flag whose value is above it fails, so a tolerated defect cannot grow
   *  unseen (a regression from 20 to 70 would otherwise pass: flags match by prefix). Set it above what the cue reads from run to run, below a defect. */
  max?: Record<string, number>;
  owner: string;
}
/** Key of a cue in KNOWN_OPEN: `deck/slideId#from-to`. */
export const openKey = (deck: string, slideId: string, from: number, to: number) => `${deck}/${slideId}#${from}-${to}`;
/** Cues whose boundary discontinuity is owned by ANOTHER Release 2 lane (or is a documented open item) and fixed there: never a threshold
 *  fudge. The integrator deletes an entry when its lane has merged; a flag NOT listed here fails the gate, and a listed (required) flag that
 *  stops firing fails it too. */
export const KNOWN_OPEN: Record<string, OpenCase> = {
  // highlight / dim start as a wink: the element is dimmed at t = 0 (opacity level -> 1). Lane V (WP 2.2, T6 emphasis that MOVES) rewrites it.
  // a with-previous highlight starts at its OWN delay (120 ms in) with a one-frame dim of 147 stage px^2 and then holds (the wink): the real-time
  // gate's first-changing-frame rule sees it where the seek gate's windows at t = 0 cannot (the boundary is not at t = 0). Lane V rewrites highlight.
  // The count-up's first digit step lands on the SECOND frame: frame 0 is the rest, frame 1 still reads "0" (the count has not yet reached 0.5), frame 2
  // is the first flip (a glyph, 209 stage px^2 at 40 px: the motion's own scale, 154 to 201 on every later frame). R2 F2 measured it, and it is NOT the
  // place-value slots replacing the resting number late: the slotted "0" before the cue and on frames 0 and 1 are the same pixels (0.0 raw), the first
  // flip lands in the same slot, and with `steadyDigits: false` the step is the same (201 against 209). It is the plain quintic `smooth` of the track:
  // its dead lead-in keeps the value under 0.5 for 25 ms, and a quantised quantity has no frame between "0" and "1". Both sides measured (seek,
  // 900 ms, 1,234): `smooth` first flip on frame 2 (START POP 2nd frame 209, here); the appearance onset curve QUICK_SMOOTH flips inside the first 2 ms
  // (START POP 2ms 209); linear flips continuously and is clean, but a count that starts at full speed is not manim's `smooth`. The plan keeps countUp on
  // plain `smooth` (R4_T1 §3.4: "the one accepted residual", pinned by verify-pace-defaults); the real-time gate (the frames a viewer sees) reads the first flip
  // as the count's own first step (211 before 154) and passes without an entry.
  [openKey("preset_countUp", "p_countUp", 1, 1)]: { seek: ["START POP (2nd frame)"], owner: "inherent: a quantised count under plain smooth has no frame between 0 and 1 (plan R4_T1 keeps countUp on smooth; QUICK_SMOOTH moves the flip into the first 2 ms)" },
  // (2026-10-24: TEXT that glides to a FRACTIONAL position, which R2 recorded as resting half a device pixel soft on its gliding raster, now lands sharp
  // and on the static render: a node that rides a layer rests on a whole device pixel and its glide flies between the snapped ends (deviceGrid.ts).
  // Entries change#1 and springs#3 deleted; both cues are gated clean.)
  // Re-entering a part that is already SHOWN pops by definition: a node that is shown has to vanish before an enter can show it again, so every point
  // leaves (scale 0) and grows back at its own turn: the second `scaleIn` of the same points reads 22.7 before the cue and 22.8 on its second frame (one
  // 21 x 22 px point each; `fade` twice and `popIn` twice read the same: R2 F2 measured it, it is not a defect of scaleIn). Pinned here so that making
  // an enter on a shown node a no-op (or anything else) is a deliberate vocabulary decision, never a side effect: the entry fails once the pop is gone.
  [openKey("plot_scatter", "scatter_reenter", 2, 2)]: { seek: ["START POP (2nd frame)"], owner: "by definition: re-entering a shown part vanishes and re-enters it (a vocabulary decision for the owner: manim's own FadeIn on a shown mobject shows no pop)" },
  // (R2 follow-up F3 deleted the four stroked-morph seams F1 had pinned here as inherent: `become_stroked/corners` landing, `become_corners/ell_rect` and
  // `ell_rect_ho` starts, `set_flights/rect_3ellipses` landing. They were a rasteriser seam (the exact stroke band, or pieces cut at other stations, against the
  // resting path stroker) plus a raster step of the wrapper itself; a Become with a band or a flight made of pieces now hands over to the real renders at both
  // ends, and a morph that keeps its box no longer promotes its layer. See shapeHandover.ts and the F3 report.)
  // (2026-10-24: the FLIGHT DEPTH law's paint-order flip for a hand-off whose source and destination sit on different sides of a covering element X
  // (`src_over` / `src_under`, 3,651 here, ~5,700 at devicePixelRatio 1.25) is fixed: the flight flies on the upper of the two depths and passes under X
  // by a veil, copies of X's own wrapper above the flight masked to its dilated coverage and faded with the motion (handoff `covers`); both entries
  // deleted, the cues are gated clean.)
  // An asset Change between plots of DIFFERENT intrinsic size (sine 360x108 pt -> scatter 180x108 pt) is not yet one law: the controller reads the pt-true
  // compensation (`intrinsic`, `naturalViewBox`, transform.ts) from the START asset for the whole flight, so its last frame is not the static render of the
  // end plot (END SNAP, 8.0) and the next step of a chain starts from the picture the controller left, not from the rest state (PRE-ROLL CHANGE 4,154; 132,822 px
  // in the browser). Same-size chains (bars5 <-> bars10) are exact. Found by the F3 review (pre-existing, the same on the base). The chain's PRE-ROLL is
  // fixed (2026-10-24: every step re-projects the MOUNTED asset's DOM with that asset's compensation and viewBox, render.plotAssetOf; the second step read
  // its start asset's, 6,317 at devicePixelRatio 1.25). The END SNAP stays recorded, required: the entry fails when the per-frame intrinsic / viewBox lands.
  [openKey("plot_chain", "sine_scatter_sine", 1, 1)]: { seek: ["END SNAP (2ms)"], max: { "END SNAP": 12 }, owner: "open: an asset Change between plots of different intrinsic size reads its compensation from the start asset (the end is not the static render)" },
  // (2026-10-24: the compound `hole_fills` START STEP R2 recorded as a pixel-aligned hole edge leaving the grid was the flight promoting a node whose box
  // stays put onto a layer for the flight; only a flight whose box travels rides a layer now (transform.ts). Entry deleted, the cue is gated clean.)
  // Not a corpus cue, recorded so it is findable: a REVERSED dashed ring (lane S deviation 1, `r2s/dashed_ring`) keeps its authored pairing and collapses
  // mid-flight; re-pairing moves the chain start the dash pattern is anchored at and a dash offset cannot make both seams exact (report R2_F1, 5.3).
  // (2026-10-24: a turning TEXT, which R2 recorded as landing on its layer's raster (42 stage px^2 off a fresh render), lands on the fresh render: it rests
  // on a whole device pixel at its exact size on a layer that is a constant of the slide. Entry deleted; the cue is gated clean.)
};
/** What this cue's flags leave over once its tolerated ones are removed, plus the stale entries (a required flag that did not fire). */
export function judge(flags: string[], open: OpenCase | undefined, domain: "seek" | "rt", value: (flag: string) => number | undefined = flagValue): { failing: string[]; tolerated: string[]; stale: string[] } {
  const required = (domain === "seek" ? open?.seek : open?.rt) ?? [], allowed = [...required, ...(domain === "rt" ? open?.rtMay ?? [] : [])];
  const is = (flag: string, list: string[]) => list.some(g => flag.startsWith(g));
  const failing = flags.filter(x => !is(x, allowed)), tolerated: string[] = [];
  for (const f of flags.filter(x => is(x, allowed))) {
    const cap = Object.entries(open?.max ?? {}).find(([g]) => f.startsWith(g))?.[1], v = value(f);
    if (cap !== undefined && v !== undefined && v > cap) failing.push(`${f} over its pinned max ${cap}`); else tolerated.push(f);
  }
  return { failing, tolerated, stale: required.filter(g => !flags.some(x => x.startsWith(g))) };
}
/** The magnitude a REAL-TIME flag carries: the first number of "LANDING STEP (20.1 after 0.6)" / "START STEP (9.3 before 0.0)". */
export const flagValue = (flag: string): number | undefined => { const m = /\((\d+(?:\.\d+)?) (?:after|before)/.exec(flag); return m ? Number(m[1]) : undefined; };
/** The magnitude of a SEEK flag, read from its measured row (the sweep's flags are plain names). */
export const seekFlagValue = (r: Omit<CueRow, "flags">) => (flag: string): number | undefined =>
  flag.startsWith("START POP (2ms)") ? r.s02 : flag.startsWith("START POP (frame)") ? r.sF : flag.startsWith("START POP (2nd frame)") ? r.sF2r
  : flag.startsWith("END SNAP (2ms)") ? r.e20 : flag.startsWith("END SNAP (frame)") ? r.eF : flag.startsWith("POST CHANGE") ? r.dRun : undefined;
