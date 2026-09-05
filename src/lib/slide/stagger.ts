import type { Track } from "./types";

/** One ordering policy for semantic targets, timeline footprints and playback.
 * Geometry children of one target share a rank. Missing spatial coordinates
 * retain their input order, after targets with a data-space coordinate. */
export function staggerRanks(count: number, from = "start", coordinates?: readonly (number | null)[]): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  if (coordinates) order.sort((a, b) => {
    const ca = coordinates[a], cb = coordinates[b];
    return ca == null ? cb == null ? a - b : 1 : cb == null ? -1 : ca - cb || a - b;
  });
  const ranks = new Array<number>(count), middle = (count - 1) / 2;
  order.forEach((index, rank) => {
    ranks[index] = from === "end" ? count - 1 - rank
      : from === "center" ? Math.round(Math.abs(rank - middle))
      : from === "edges" ? Math.round(middle - Math.abs(rank - middle)) : rank;
  });
  return ranks;
}

export function staggerSpan(track: Track, targetCount: number): number {
  return Math.max(0, track.stagger?.perMs ?? 0) * Math.max(0, ...staggerRanks(targetCount, track.stagger?.from));
}
