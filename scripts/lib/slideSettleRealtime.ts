// Real-time + compositor start/settle measurement (lane J), driver side: export a deck, run scripts/lib/slideSettleElectronEntry.cjs in
// OFFSCREEN Electron (show:false; no window is ever shown, no dev server, no port) and judge what the compositor PRESENTED.
// Shared by scripts/perf/slide-settle-realtime.mts (the probe, any corpus) and scripts/lib/slideSettleElectronProbe.ts (the gate).
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { exportDeckHtml } from "../../src/lib/slide/export/exportDeck";
import { cuesOf, kindsOf, type SweepPayload } from "./slideSettleSweep";

const require = createRequire(import.meta.url);
export interface RtFrame { t: number; d: number }
export interface RtTick { t: number; time: number; playing: boolean; dur: number }
export interface RtCue {
  name: string; slide: number; from: number; to: number; label: string;
  ticks: RtTick[]; frames: RtFrame[]; durationMs: number;
  /** ms from the click to the first player frame whose cue clock had moved, and that clock */
  clickToFirstTickMs: number | null; firstClockMs: number | null;
  clickToBeatStart?: number | null; auto?: boolean; interruptAtMs?: number; jumpRatio?: number;
  landedAt: number | null; restBeforeToFirst: number | null; restAfter: number | null; postLanding: number; postLandingFrames: number;
  /** ink / chromatic-ink pixel counts of the static end render and of the last presented frame (LCD fringes vs grayscale anti-aliasing) */
  refChroma?: { ink: number; chromatic: number } | null; landChroma?: { ink: number; chromatic: number } | null;
  error?: string;
}
export interface RtResult { gpu: Record<string, string>; stageWidth: number; cues: RtCue[] }

export interface RtOptions { fresh?: boolean; interrupts?: Record<string, number>; preJs?: string; dump?: string; dumpAll?: boolean; width?: number; height?: number; restMs?: number; tailMs?: number; only?: (slideId: string, from: number, to: number) => boolean; switches?: string[][]; maxMs?: number }

/** Run every cue of `payload.deck` (or the filtered ones) and return the presented-frame measurements. */
export async function realtimeSweep(payload: SweepPayload, name: string, opts: RtOptions = {}): Promise<RtResult> {
  const repo = process.cwd(), electron = require("electron") as string;
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "flux-settle-rt-"));
  try {
    const html = path.join(out, "deck.html"); let text = (await exportDeckHtml(payload as never)).html;
    if (opts.preJs) text = text.replace(/<head[^>]*>/i, m => `${m}<script>${opts.preJs}</script>`);
    await fs.writeFile(html, text);
    const cues = payload.deck.slides.flatMap((slide, si) => cuesOf(slide).filter(c => !opts.only || opts.only(slide.id, c.from, c.to)).map(c => ({ name: `${name}/${slide.id}#${c.from}-${c.to}`, slide: si, from: c.from, to: c.to, label: kindsOf(slide, c.from, c.to), auto: slide.beats[c.from]?.advance === "auto", ...(opts.interrupts?.[`${slide.id}#${c.from}-${c.to}`] ? { interruptAtMs: opts.interrupts[`${slide.id}#${c.from}-${c.to}`] } : {}) })));
    const width = opts.width ?? 1280, height = opts.height ?? 720;
    const job = { html, out, cues, width, height, stageWidth: payload.deck.stage.width, restMs: opts.restMs ?? 450, tailMs: opts.tailMs ?? 900, maxMs: opts.maxMs ?? 9000, switches: opts.switches ?? [["force-color-profile", "srgb"]], dump: opts.dump, dumpAll: opts.dumpAll, fresh: opts.fresh, dead: Number(process.env.DEAD ?? 10) };
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_SETTLE_JOB: JSON.stringify(job) }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    const args = [path.join(repo, "scripts/lib/slideSettleElectronEntry.cjs"), ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []), ...(env.FLUX_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(electron, args, { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] }); let o = "", e = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("settle harness timed out")); }, 20 * 60 * 1000);
      child.stdout.on("data", b => { o += b; }); child.stderr.on("data", b => { e += b; });
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`settle harness exit ${code}\n${(o + e).slice(-3000)}`)); });
    });
    return JSON.parse(await fs.readFile(path.join(out, "settle.json"), "utf8")) as RtResult;
  } finally { await fs.rm(out, { recursive: true, force: true }); }
}

const f1 = (v: number | null | undefined, w = 7) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(1)).padStart(w);
/** Summary of one cue's presented sequence: pacing, start hitch, landing, post-landing change. */
export function summarize(c: RtCue) {
  const moving = c.ticks.filter(t => t.playing && t.time > 0);
  const gaps = moving.slice(1).map((t, i) => t.t - moving[i].t);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const lastGaps = gaps.slice(-4), landGap = lastGaps.length ? Math.max(...lastGaps) : 0;
  const frameGaps = c.frames.slice(1).map((f, i) => f.t - c.frames[i].t);
  const motion = c.frames.filter(f => c.landedAt != null && f.t <= c.landedAt + 20);
  return { n: moving.length, maxGap, landGap, frameGapMax: frameGaps.length ? Math.max(...frameGaps) : 0, presented: c.frames.length, motionFrames: motion.length };
}
export const RT_HEAD = "cue                                  dur  click>1st  clock@1st  maxGap  landGap  rest>1st  restAfter  postLand(n)  verdict";
export function rtRow(c: RtCue): string {
  const s = summarize(c);
  const flags = rtFlags(c);
  return `${c.name.slice(-34).padEnd(34)} ${f1(c.durationMs, 6)} ${f1(c.clickToFirstTickMs, 9)} ${f1(c.firstClockMs, 10)} ${f1(s.maxGap, 7)} ${f1(s.landGap, 8)} ${f1(c.restBeforeToFirst, 9)} ${f1(c.restAfter, 10)} ${f1(c.postLanding, 8)}(${c.postLandingFrames})  ${flags.join(", ") || "ok"}`;
}
/** Thresholds of the real-time domain. Budgets, not neighbours: the frame is 16.7 ms at 60 fps, so "no long frame" is two vsyncs and "the
 *  clock starts at the first presented frame" is one frame of motion after frame 0.
 *  Units of the change columns are stage px^2 per stage px^2 (perceptual, see slideSettleSweep DEAD_BAND). */
export const RT = {
  /** START HITCH: the click (or the cue's start) to the first player frame whose cue clock moved. The Nielsen budget for "instantaneous"; the
   *  measured value is 0.3 to 18 ms, one presented frame later for a cue that primes a gliding layer (frame 0 first). */
  clickToFirstTickMs: 100,
  /** SKIPPED BEGINNING: the cue clock at the first player frame that moved. The player clamps the first tick to FIRST_TICK_MAX_MS (20), so
   *  this asserts the clamp is in force: a setup delay is a hitch, never progress. */
  firstClockMs: 34,
  /** UNEVEN PACING: the longest gap between two player frames anywhere in the motion, and (LONG FRAME AT LANDING) in the last four frames */
  maxGapMs: 34, gapMs: 34,
  /** the last presented frame vs the static render of the end state, and the change after the landing frame (a sharpness / AA step). The same
   *  for a camera cue: its raster is baked at the landing pose (rasterKeeper EARLY_BAKE_LEAD_FRAMES), so both read 0.0. The landing floor is the
   *  physical 6 units of the seek gate (a 0.1 stage px shift of a 60 px edge; slideSettleSweep THRESHOLDS): the legacy `scale` preset lands
   *  2.9 against the fresh render in about 1 run in 7 (before and after this round: a transform-scaled raster against the same transform painted at
   *  rest), which no viewer can see; every defect the gate exists for reads 7 and above (the old landing of a fadeRise 11.6, a stagger 7.0, a
   *  text rewrite 26). Nothing may change after the landing frame: 2. */
  restAfter: 6, postLanding: 2,
  /** the landing frame and the first changing frame change like their neighbours: d_last <= max(3 x previous, floor), d_first <= max(4 x next, floor) */
  stepRatio: 3, startRatio: 4, stepFloor: 6,
  /** a presented frame whose change from its predecessor exceeds this has moved (the rest frames before the motion read exactly 0) */
  moveEps: 0.05,
  /** an interrupt settles velocity-continuously: no presented frame changes more than this multiple of the frames before it (floor 6) */
  jumpRatio: 6,
};
/** The share of ink pixels that carry colour fringes. The slide stage is a will-change layer (the camera layer), which disables LCD text, so slide
 *  text is grayscale-antialiased end to end and a promotion or demotion of a sub-layer cannot flip LCD <-> grayscale. A text-only deck reads ~0.5 %
 *  (the few coloured pixels are the theme's); LCD text would read ~60 %. */
export const GRAYSCALE_MAX_SHARE = 0.02;
export const chromaShare = (c?: { ink: number; chromatic: number } | null): number | null => (c && c.ink > 0 ? c.chromatic / c.ink : null);
export function rtFlags(c: RtCue): string[] {
  const f: string[] = [];
  if (c.error) return [`ERROR ${c.error.split("\n")[0]}`];
  const s = summarize(c);
  if (c.interruptAtMs) {
    if ((c.jumpRatio ?? 0) > RT.jumpRatio) f.push(`INTERRUPT JUMP (x${(c.jumpRatio ?? 0).toFixed(1)})`);
    return f;
  }
  if (c.clickToFirstTickMs != null && c.clickToFirstTickMs > RT.clickToFirstTickMs) f.push(`START HITCH (${c.clickToFirstTickMs.toFixed(0)} ms to the first moving frame)`);
  if (c.firstClockMs != null && c.firstClockMs > RT.firstClockMs) f.push(`SKIPPED BEGINNING (${c.firstClockMs.toFixed(0)} ms in at the first tick)`);
  if (s.maxGap > RT.maxGapMs) f.push(`UNEVEN PACING (${s.maxGap.toFixed(0)} ms between player frames)`);
  if (s.landGap > RT.gapMs) f.push(`LONG FRAME AT LANDING (${s.landGap.toFixed(0)} ms)`);
  if (c.restAfter != null && c.restAfter > RT.restAfter) f.push("LANDING != REST RENDER");
  if (c.postLanding > RT.postLanding) f.push("CHANGE AFTER LANDING");
  // the start: the first frame that CHANGED (a cue that primes a gliding layer presents frame 0 first, identical to the rest) against the frame
  // after it, and the first presented frame against the rest before it
  {
    const frames = c.frames.filter(x => x.t >= 0), at = frames.findIndex(x => x.d > RT.moveEps);
    const next = at >= 0 ? frames[at + 1]?.d ?? 0 : 0;
    if (at >= 0 && frames[at].d > Math.max(RT.startRatio * next, RT.stepFloor)) f.push(`START STEP (${frames[at].d.toFixed(1)} before ${next.toFixed(1)})`);
    const after = Math.max(frames[1]?.d ?? 0, frames[2]?.d ?? 0);
    if (c.restBeforeToFirst != null && c.restBeforeToFirst > Math.max(RT.startRatio * after, RT.stepFloor)) f.push(`FIRST FRAME != REST (${c.restBeforeToFirst.toFixed(1)} against ${after.toFixed(1)} after it)`);
  }
  // the landing frame: the last presented frame that belongs to the motion (page time <= landedAt + 20 ms) against the one before it
  if (c.landedAt != null) {
    const motion = c.frames.filter(x => x.t >= 0 && x.t <= c.landedAt! + 20);
    if (motion.length >= 3) {
      const last = motion[motion.length - 1], prev = Math.max(motion[motion.length - 2].d, motion[motion.length - 3].d);
      if (last.d > Math.max(RT.stepRatio * prev, RT.stepFloor)) f.push(`LANDING STEP (${last.d.toFixed(1)} after ${prev.toFixed(1)})`);
    }
  }
  return f;
}
