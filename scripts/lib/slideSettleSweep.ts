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
  /** mid-flight Δ over 2 ms (the cue's own motion scale). */
  mid: number;
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
  /** pre-roll and post-landing changes must stay under this (they should be exactly 0). */
  rest: number;
}
/** The floors are physical: 6 units is a 0.1 stage px shift of a 60 px edge (a 3 px round-cap dot is 7). Under it sits the residue of
 *  device-pixel snapping: a wrapper's layout box is whole STAGE px, which at a fractional fit scale (2.5x here) the browser snaps to the
 *  device grid at rest but not in flight, so a resized stroked shape lands up to ~0.15 device px off its last frame. Nobody can see that;
 *  a dot, a thickened stroke, re-rasterised text, a popped corner are all well above it. */
export const THRESHOLDS: Thresholds = { floorTiny: 6, floorFrame: 8, ratioTiny: 4, ratioFrame: 3, rest: 2 };

const spike = (a: number, b: number, floor: number, ratio: number) => a > floor && a > ratio * Math.max(b, 0.25);

/** The verdict for one measured cue, from its windows alone (pure; the gate pins it). */
export function classify(r: Omit<CueRow, "flags">, t: Thresholds = THRESHOLDS): string[] {
  const flags: string[] = [];
  if (Number.isFinite(r.dPre) && r.dPre > t.rest) flags.push("PRE-ROLL CHANGE");
  if (spike(r.s02, r.s24, t.floorTiny, t.ratioTiny)) flags.push("START POP (2ms)");
  if (spike(r.sF, r.sF2, t.floorFrame, t.ratioFrame)) flags.push("START POP (frame)");
  if (spike(r.e20, r.e42, t.floorTiny, t.ratioTiny)) flags.push("END SNAP (2ms)");
  if (spike(r.eF, r.eF2, t.floorFrame, t.ratioFrame)) flags.push("END SNAP (frame)");
  if (r.dRun > t.rest) flags.push("POST CHANGE");
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
        mid: await grab(s, to, D / 2, from), mid2: await grab(s, to, D / 2 + TINY_MS, from),
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
        s02: diff(f.p0, f.p2), s24: diff(f.p2, f.p4), sF: diff(f.p0, f.pF), sF2: diff(f.pF, f.p2F),
        mid: diff(f.mid, f.mid2),
        e42: diff(f.e4, f.e2), e20: diff(f.e2, f.e0), eF2: diff(f.e2F, f.eF), eF: diff(f.eF, f.e0),
        dRun: diff(f.e0, run),
      };
      rows.push({ ...row, flags: classify(row, opts.thresholds) });
    }
  }
  return rows;
}

const n = (v: number, w = 6) => (Number.isFinite(v) ? v.toFixed(1) : "  -").padStart(w);
export const TABLE_HEAD = "slide beat   dur(ms) tracks    pre   s0-2   s2-4  s0-F  sF-2F    mid  e-4-2  e-2-0 e-2F-F  e-F-0   run  verdict";
export function tableRow(r: CueRow, name = ""): string {
  const beat = r.from === r.to ? String(r.from) : `${r.from}-${r.to}`;
  return `${(name || String(r.slide)).slice(0, 18).padStart(5)} ${beat.padStart(4)}  ${String(Math.round(r.dur)).padStart(7)} ${r.label.slice(0, 9).padEnd(9)} ${n(r.dPre)} ${n(r.s02)} ${n(r.s24)} ${n(r.sF)} ${n(r.sF2, 6)} ${n(r.mid)} ${n(r.e42)} ${n(r.e20)} ${n(r.eF2, 7)} ${n(r.eF)} ${n(r.dRun)}  ${r.flags.join(", ") || "ok"}`;
}

export async function withBrowser<T>(fn: (browser: import("puppeteer-core").Browser, tmp: string) => Promise<T>): Promise<T> {
  const { launch } = await import("./driver.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-settle-sweep-"));
  const { browser } = await launch({ width: 1600, height: 900 });
  try { return await fn(browser, tmp); }
  finally { await browser.close(); await fs.rm(tmp, { recursive: true, force: true }); }
}

/** Cues whose boundary discontinuity is owned by ANOTHER Release 2 lane (or is a documented open item) and fixed there: never a threshold
 *  fudge. Keyed `deck#from-to` (or `deck/slide#from-to` in the probes), valued by the flags tolerated and the owner. The integrator
 *  deletes an entry when its lane has merged; a flag NOT listed here fails the gate. */
export const KNOWN_OPEN: Record<string, { flags: string[]; owner: string }> = {
  // highlight / dim start as a wink: the element is dimmed at t = 0 (opacity level -> 1). Lane V (WP 2.2, T6 emphasis that MOVES) rewrites it.
  "preset_highlight#1-1": { flags: ["PRE-ROLL CHANGE"], owner: "lane V (highlight is a wink)" },
  "preset_highlight#2-2": { flags: ["PRE-ROLL CHANGE"], owner: "lane V (highlight is a wink)" },
  "preset_highlight#3-3": { flags: ["PRE-ROLL CHANGE"], owner: "lane V (highlight is a wink)" },
  "preset_highlight#4-4": { flags: ["PRE-ROLL CHANGE"], owner: "lane V (highlight is a wink)" },
  "preset_highlight#5-5": { flags: ["PRE-ROLL CHANGE"], owner: "lane V (highlight is a wink)" },
  // a text rewrite hands the original static text to the span layer: the glyph-matched morph's first/last frame differ from the resting
  // text by anti-aliasing (50 stage px^2). Lane T (WP 2.5, text glide lanes / letters travel) owns textMorph.ts.
  "change#3-3": { flags: ["START POP (2ms)", "START POP (frame)", "END SNAP (2ms)", "END SNAP (frame)"], owner: "lane T (text morph layers)" },
  // a text box RESIZED in flight keeps its font size through a counter-scaled composite (net 1:1), which rasterises soft against the
  // hinted rest text (53 stage px^2). Open in lane J: see the report (the fix is a transform-free resize path for text-only content).
  "change#2-2": { flags: ["END SNAP (2ms)", "END SNAP (frame)", "POST CHANGE"], owner: "lane J open (text box resize rasterises soft in flight)" },
  // a Ghost copy of a TEXT is born exactly on top of its source: two layers of the same anti-aliased glyphs read bolder than one
  // (edge coverage c becomes 1-(1-c)^2), so the first frame differs from the rest by 20 stage px^2. Open in lane J.
  "ghost#2-2": { flags: ["PRE-ROLL CHANGE"], owner: "lane J open (a born text copy doubles its source's anti-aliasing)" },
  "springs#4-4": { flags: ["END SNAP (2ms)", "END SNAP (frame)", "POST CHANGE"], owner: "lane J open (text box resize rasterises soft in flight)" },
};
