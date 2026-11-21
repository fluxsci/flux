/**
 * An image as a movie on a slide (stage 2, plan D7): which dimension it walks, how one pass is timed, and what a
 * stored `playback` setting may hold. Pure (no DOM, no stores): the slide ops, the compiler, the player and
 * flux-core read the same answers.
 *
 * A pass walks planes `from` .. `to - 1` of one dimension; it lasts `planes × period / speed`, where the period is
 * the data's own (a time axis in seconds plays in real time, anything else at 12 planes a second) or `1000 / fps`
 * when `fps` is set. Where the movie stands at a moment is the pure media clock (`slide/mediaTimeline`).
 */
import type { FluximgManifest } from "./types";
import type { FluximgPlayback, FluximgPlaybackMode } from "./element";
import { positionDims } from "./viewOps";
import { naturalRate } from "./live/rail";

export const PLAYBACK_MODES: readonly FluximgPlaybackMode[] = ["loop", "bounce", "once"];
/** The speeds the pace and movie dials step through, as multiples of the data's own rate. */
export const PACE_SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

const dimLen = (m: FluximgManifest, dim: string): number => { const i = m.pixels.dims.indexOf(dim); return i >= 0 ? m.pixels.shape[i] : 0; };

/** Dimensions an image can walk (play through, run as a movie): every position dimension with more than one plane. Time first, then depth, then the rest. */
export function walkableDims(m: FluximgManifest): string[] {
  const dims = positionDims(m).filter((d) => dimLen(m, d) > 1);
  const rank = (d: string): number => (d === "t" ? 0 : d === "z" ? 1 : 2);
  return dims.slice().sort((a, b) => rank(a) - rank(b));
}

/** The dimension a walk or a movie takes when none is named: the time axis, else depth, else the first walkable one. */
export const defaultWalkDim = (m: FluximgManifest): string | null => walkableDims(m)[0] ?? null;

/** A stored playback setting completed with its defaults, and one pass timed. */
export interface ResolvedPlayback {
  dim: string;
  mode: FluximgPlaybackMode;
  speed: number;
  fps: number | null;
  /** Planes `from` (inclusive) to `to` (exclusive). */
  from: number;
  to: number;
  planes: number;
  /** One plane, in ms (speed applied). */
  periodMs: number;
  /** One pass over the range, in ms (speed applied). */
  passMs: number;
}

const posNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The playback an image plays with: the stored setting where it fits the image, the defaults elsewhere (time axis,
 * else depth, else the first walkable dimension; loop; ×1; the whole range). Null when the image walks nothing.
 */
export function resolvePlayback(m: FluximgManifest, p: Partial<FluximgPlayback> | null | undefined): ResolvedPlayback | null {
  const dims = walkableDims(m);
  if (!dims.length) return null;
  const dim = p?.dim && dims.includes(p.dim) ? p.dim : dims[0];
  const n = dimLen(m, dim);
  const mode = p?.mode && PLAYBACK_MODES.includes(p.mode) ? p.mode : "loop";
  const speed = posNum(p?.speed) ? p!.speed! : 1;
  const fps = posNum(p?.fps) ? p!.fps! : null;
  let from = Number.isInteger(p?.from) && p!.from! >= 0 && p!.from! < n ? p!.from! : 0;
  let to = Number.isInteger(p?.to) && p!.to! > from && p!.to! <= n ? p!.to! : n;
  if (to <= from) { from = 0; to = n; }
  const planes = to - from;
  const periodMs = (fps ? 1000 / fps : 1000 / naturalRate(m, dim)) / speed;
  return { dim, mode, speed, fps, from, to, planes, periodMs, passMs: planes * periodMs };
}

/** What is wrong with a playback setting for this image (empty = fine). Used by the ops and by the headless verbs. */
export function playbackProblems(m: FluximgManifest | undefined, p: unknown): string[] {
  const out: string[] = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["playback must be an object {dim, mode, speed?, fps?, from?, to?}"];
  const o = p as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["dim", "mode", "speed", "fps", "from", "to"].includes(k)) out.push(`playback.${k} is not a playback setting (dim, mode, speed, fps, from, to)`);
  if (typeof o.mode !== "string" || !PLAYBACK_MODES.includes(o.mode as FluximgPlaybackMode)) out.push(`playback.mode must be loop, bounce or once`);
  if (o.speed !== undefined && !posNum(o.speed)) out.push("playback.speed must be a positive number");
  if (o.fps !== undefined && !posNum(o.fps)) out.push("playback.fps must be a positive number");
  if (typeof o.dim !== "string" || !o.dim) { out.push("playback.dim must name a dimension"); return out; }
  if (!m) return out;
  const dims = walkableDims(m);
  if (!dims.includes(o.dim)) { out.push(`playback.dim "${o.dim}" is not a dimension this image can play (${dims.length ? dims.join(", ") : "it has none"})`); return out; }
  const n = dimLen(m, o.dim);
  const from = o.from ?? 0, to = o.to ?? n;
  if (!Number.isInteger(from) || (from as number) < 0 || (from as number) >= n) out.push(`playback.from must be a whole plane 0..${n - 1}`);
  if (!Number.isInteger(to) || (to as number) > n || (to as number) <= (from as number)) out.push(`playback.to must be a whole plane after from, at most ${n}`);
  return out;
}
