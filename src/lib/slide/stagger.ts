import type { Track, Stagger } from "./types";
import { resolveCurve, parseCurve, formatCurve } from "./curves";

/** FNV-1a keeps an unseeded saved track's order stable in every host. */
export function staggerSeed(track: Track): number {
  if (track.stagger?.seed !== undefined) return track.stagger.seed >>> 0;
  let seed = 2166136261;
  for (const char of track.id ?? track.target) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}

/** A click must change the order even when adjacent seeds produce a tie. */
export function reshuffleSeed(track: Track, count: number): number {
  let seed = staggerSeed(track);
  if (count < 2) return (seed + 1) >>> 0;
  const before = staggerRanks(count, "random", undefined, seed);
  do {
    seed = (seed + 1) >>> 0;
  } while (staggerRanks(count, "random", undefined, seed).every((rank, i) => rank === before[i]));
  return seed;
}

/** One ordering policy for semantic targets, timeline footprints and playback.
 * Geometry children of one target share a rank. Missing spatial coordinates
 * retain their input order, after targets with a data-space coordinate. */
export function staggerRanks(count: number, from = "start", coordinates?: readonly (number | null)[], seed = 0, totalSpan = false, spacing: "even" | "true" = "even"): number[] {
  if (spacing === "true" && coordinates && count > 1 && (from === "start" || from === "end")) {
    // spacing "true": FRACTIONAL ranks. rank / maxRank is the target's normalised coordinate (callers pass PIXEL-space coordinates from
    // manifestCoordinates(..., "pixel"), so a log axis is right), hence staggerDelay's span * curve(rank / maxRank) places each target on
    // the coordinate axis, and evenly spaced coordinates reproduce "even". The max rank stays count - 1 (footprints and spans survive).
    const known = coordinates.filter((c): c is number => c != null), lo = Math.min(...known), hi = Math.max(...known);
    if (known.length > 1 && hi > lo) return Array.from({ length: count }, (_, i) => {
      const c = coordinates[i], f = c == null ? 1 : (c - lo) / (hi - lo);
      return (from === "end" ? 1 - f : f) * (count - 1);
    });
  }
  const order = Array.from({ length: count }, (_, i) => i);
  if (coordinates) order.sort((a, b) => {
    const ca = coordinates[a], cb = coordinates[b];
    return ca == null ? cb == null ? a - b : 1 : cb == null ? -1 : ca - cb || a - b;
  });
  if (from === "random") {
    // Mulberry32 + Fisher-Yates: no ambient randomness in playback or export.
    for (let i = count - 1; i > 0; i--) {
      let n = seed = (seed + 0x6d2b79f5) | 0;
      n = Math.imul(n ^ n >>> 15, n | 1);
      n ^= n + Math.imul(n ^ n >>> 7, n | 61);
      const j = Math.floor(((n ^ n >>> 14) >>> 0) / 4294967296 * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  const ranks = new Array<number>(count), middle = (count - 1) / 2;
  order.forEach((index, rank) => {
    ranks[index] = from === "end" ? count - 1 - rank
      : from === "center" ? Math.round(Math.abs(rank - middle))
      : from === "edges" ? Math.round(middle - Math.abs(rank - middle)) : rank;
  });
  if (totalSpan && count > 1) {
    const min = Math.min(...ranks), max = Math.max(...ranks);
    // Total measures first-to-last. An all-tied order uses input order so even
    // two Center/Edges targets can occupy the requested span. Each stays intact.
    order.forEach((index, rank) => { ranks[index] = max === min ? rank : ranks[index] - min; });
  }
  return ranks;
}

const distributions = new WeakMap<Stagger, { spec: Stagger["curve"]; fn: (t: number) => number }>();
/** The one delay law. Span calculation warms the curve before any frame reads it. */
export function staggerDelay(track: Track, rank: number, maxRank: number): number {
  const st = track.stagger;
  if (!st || maxRank <= 0) return 0;
  let distribution = distributions.get(st);
  if (st.curve && (!distribution || distribution.spec !== st.curve)) {
    const resolved = resolveCurve(typeof st.curve === "string" ? { easing: st.curve } : { curve: st.curve });
    distribution = { spec: st.curve, fn: resolved.clamped };
    distributions.set(st, distribution);
  }
  // Retain the exact legacy multiplication when no distribution is requested.
  if (st.totalMs === undefined && !st.curve) return Math.max(0, st.perMs ?? 0) * rank;
  const span = Math.max(0, st.totalMs ?? (st.perMs ?? 0) * maxRank);
  return span * (st.curve ? distribution!.fn(rank / maxRank) : rank / maxRank);
}

export function staggerSpan(track: Track, targetCount: number): number {
  const maxRank = Math.max(0, ...staggerRanks(targetCount, track.stagger?.from, undefined, staggerSeed(track), track.stagger?.totalMs !== undefined));
  return staggerDelay(track, maxRank, maxRank);
}

/** Shared authoring patch: choosing Each/Total clears the other mode. */
export function patchStagger(current: Stagger | undefined, patch: Partial<Stagger>): Stagger {
  if (patch.perMs !== undefined && patch.totalMs !== undefined) throw new Error("Choose Each or Total stagger, not both");
  for (const key of ["perMs", "totalMs"] as const) {
    if (patch[key] !== undefined && (!Number.isFinite(patch[key]) || patch[key]! < 0)) throw new Error(`${key} must be non-negative and finite`);
  }
  if (patch.seed !== undefined && (!Number.isInteger(patch.seed) || patch.seed < 0 || patch.seed > 0xffffffff)) throw new Error("Stagger seed must be an unsigned 32-bit integer");
  if (patch.by !== undefined && !(typeof patch.by === "string" ? ["index", "x", "y", "data"].includes(patch.by) : ["value", "count", "index"].includes(patch.by?.key ?? ""))) throw new Error("Unknown stagger ordering key");
  if (patch.from !== undefined && !["start", "end", "center", "edges", "random"].includes(patch.from)) throw new Error("Unknown stagger origin");
  if (patch.spacing !== undefined && !["even", "true"].includes(patch.spacing)) throw new Error("Unknown stagger spacing");
  const next = { ...(current ?? { perMs: 40 }), ...patch };
  // "true" spacing needs a spatial key and a one-ended origin: asking for it otherwise is refused; changing the key or the origin of a
  // stagger that has it returns it to even
  if (next.spacing === "true" && (!(next.by === "x" || next.by === "y") || (next.from ?? "start") !== "start" && next.from !== "end")) {
    if (patch.spacing === "true") throw new Error("Stagger spacing \"true\" needs by x or y and from start or end");
    delete next.spacing;
  }
  if (next.spacing === "even") delete next.spacing;
  if (patch.totalMs !== undefined) delete next.perMs;
  else if (patch.perMs !== undefined) delete next.totalMs;
  if (patch.curve !== undefined) {
    const curve = parseCurve(formatCurve(patch.curve));
    if (!curve) throw new Error("Invalid stagger curve");
    next.curve = curve;
  }
  return next;
}

// ---------------------------------------------------------------------------
// PLANNER (profile-independent, pure): a TOTAL-INVARIANT lag-ratio schedule written as EXISTING fields.
//
// manim's `lag_ratio` law (animation.py:384-391, composition.py:160): n children share a fixed total T;
// each child's window is T / (1 + maxRank L) and the next starts L x window later. Flux stores no "lag"
// mode: the planner RETURNS `{ duration: window, stagger: { totalMs: spread } }` (Total mode, shipped and
// pinned), so footprint = duration + totalMs = T exactly, old apps open the deck, and every consumer of
// `staggerSpan` (compile end, anchors, align, timeline bars) is already correct.
// ---------------------------------------------------------------------------

/** A target's window never drops under max(150 ms, 20 % of the group total): when it would, the RATIO gives
 *  way, never the total. 20 % is manim's own asymptote (Write: lag = min(4/n, 0.2)); 150 ms ~ 9 frames. */
export const LAG_MIN_CHILD_MS = 150;
export const LAG_MIN_CHILD_FRAC = 0.2;

export interface StaggerPlan {
  /** effective lag ratio after the floor */ lag: number;
  /** each target's window (ms, integer) */ childMs: number;
  /** first start to last start (ms, integer) = totalMs - childMs */ spanMs: number;
  /** start-to-start step (spanMs / maxRank) */ stepMs: number;
  /** group footprint = childMs + spanMs = the requested total */ totalMs: number;
}
/** `totalMs` = whole group first start to last end; `maxRank` = highest rank (ties share one rank, so NOT n - 1 for from:center|edges).
 *  Assumes ORDINAL ranks (law "rank"); a caller with fractional ranks (T8's `law:"coordinate"`) chooses its own (window, totalMs) pair. */
export function planStagger(totalMs: number, lag: number, maxRank: number): StaggerPlan {
  const T = Math.max(0, Math.round(totalMs)), L = Math.max(0, lag);
  if (!(maxRank > 0) || T <= 0) return { lag: L, childMs: T, spanMs: 0, stepMs: 0, totalMs: T };
  const floor = Math.min(T, Math.max(LAG_MIN_CHILD_MS, LAG_MIN_CHILD_FRAC * T));
  const eff = T / (1 + maxRank * L) >= floor ? L : (T / floor - 1) / maxRank;
  const childMs = Math.max(1, Math.round(T / (1 + maxRank * eff)));
  const spanMs = T - childMs;
  return { lag: eff, childMs, spanMs, stepMs: spanMs / maxRank, totalMs: T };
}
/** The fields a plan writes onto a Track (Total mode); `shared` = by/from/curve/seed. Single target: no spread. */
export function staggerFields(plan: StaggerPlan, shared: Pick<Stagger, "by" | "from" | "curve" | "seed"> = {}): { duration: number; stagger: Stagger } {
  return { duration: plan.childMs, stagger: { ...shared, totalMs: plan.spanMs } };
}
/** manim's natural LaggedStart time for n children of window `refMs`, capped: min(cap, ref (1 + (n-1) L)). */
export function lagTotal(n: number, refMs: number, lag: number, capMs: number): number {
  return Math.round(Math.min(capMs, refMs * (1 + Math.max(0, n - 1) * lag)));
}
/** manim's Write sizing as data: 1 s below 15 items, 2 s from 15, ratio 0.2 (the 20 % floor reproduces min(4/n, 0.2)). */
export function writeTiming(n: number): { totalMs: number; lag: number } {
  return { totalMs: n < 15 ? 1000 : 2000, lag: 0.2 };
}
/** Per-target literal starts for n SEPARATE tracks (multi-select Appear): window + start offsets of one lag schedule. */
export function lagStarts(n: number, totalMs: number, lag: number): { childMs: number; startsMs: number[] } {
  const p = planStagger(totalMs, lag, Math.max(0, n - 1));
  return { childMs: p.childMs, startsMs: Array.from({ length: n }, (_, i) => Math.round(p.stepMs * i)) };
}
/** The whole group's footprint (what the Animator shows as "whole build"): duration + spread. */
export function trackFootprint(track: Track, targetCount: number): number {
  return Math.max(0, track.duration ?? 0) + staggerSpan(track, targetCount);
}
