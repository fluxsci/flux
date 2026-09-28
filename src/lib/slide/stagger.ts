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
export function staggerRanks(count: number, from = "start", coordinates?: readonly (number | null)[], seed = 0, totalSpan = false): number[] {
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
  if (patch.by !== undefined && !["index", "x", "y"].includes(patch.by)) throw new Error("Unknown stagger ordering key");
  if (patch.from !== undefined && !["start", "end", "center", "edges", "random"].includes(patch.from)) throw new Error("Unknown stagger origin");
  const next = { ...(current ?? { perMs: 40 }), ...patch };
  if (patch.totalMs !== undefined) delete next.perMs;
  else if (patch.perMs !== undefined) delete next.totalMs;
  if (patch.curve !== undefined) {
    const curve = parseCurve(formatCurve(patch.curve));
    if (!curve) throw new Error("Invalid stagger curve");
    next.curve = curve;
  }
  return next;
}
