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
  clickToBeatStart?: number | null; auto?: boolean;
  landedAt: number | null; restBeforeToFirst: number | null; restAfter: number | null; postLanding: number; postLandingFrames: number;
  error?: string;
}
export interface RtResult { gpu: Record<string, string>; stageWidth: number; cues: RtCue[] }

export interface RtOptions { preJs?: string; dump?: string; dumpAll?: boolean; width?: number; height?: number; restMs?: number; tailMs?: number; only?: (slideId: string, from: number, to: number) => boolean; switches?: string[][]; maxMs?: number }

/** Run every cue of `payload.deck` (or the filtered ones) and return the presented-frame measurements. */
export async function realtimeSweep(payload: SweepPayload, name: string, opts: RtOptions = {}): Promise<RtResult> {
  const repo = process.cwd(), electron = require("electron") as string;
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "flux-settle-rt-"));
  try {
    const html = path.join(out, "deck.html"); let text = (await exportDeckHtml(payload as never)).html;
    if (opts.preJs) text = text.replace(/<head[^>]*>/i, m => `${m}<script>${opts.preJs}</script>`);
    await fs.writeFile(html, text);
    const cues = payload.deck.slides.flatMap((slide, si) => cuesOf(slide).filter(c => !opts.only || opts.only(slide.id, c.from, c.to)).map(c => ({ name: `${name}/${slide.id}#${c.from}-${c.to}`, slide: si, from: c.from, to: c.to, label: kindsOf(slide, c.from, c.to), auto: slide.beats[c.from]?.advance === "auto" })));
    const width = opts.width ?? 1280, height = opts.height ?? 720;
    const job = { html, out, cues, width, height, stageWidth: payload.deck.stage.width, restMs: opts.restMs ?? 450, tailMs: opts.tailMs ?? 900, maxMs: opts.maxMs ?? 9000, switches: opts.switches ?? [["force-color-profile", "srgb"]], dump: opts.dump, dumpAll: opts.dumpAll, dead: Number(process.env.DEAD ?? 6) };
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
/** Thresholds of the real-time domain (budgets, not neighbours: the frame is 16.7 ms at 60 fps). */
export const RT = { firstClockMs: 25, gapMs: 24, restAfter: 1.0, postLanding: 1.0 };
export function rtFlags(c: RtCue): string[] {
  const f: string[] = [];
  if (c.error) return [`ERROR ${c.error.split("\n")[0]}`];
  const s = summarize(c);
  if (c.firstClockMs != null && c.firstClockMs > RT.firstClockMs) f.push(`SKIPPED BEGINNING (${c.firstClockMs.toFixed(0)} ms in at the first tick)`);
  if (s.landGap > RT.gapMs) f.push(`LONG FRAME AT LANDING (${s.landGap.toFixed(0)} ms)`);
  if (c.restAfter != null && c.restAfter > RT.restAfter) f.push("LANDING != REST RENDER");
  if (c.postLanding > RT.postLanding) f.push("CHANGE AFTER LANDING");
  return f;
}
