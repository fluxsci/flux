/**
 * Pairing by key (stage 2, plan D10), shared by every kind: an image object's key, a plot series' id and name. Pure and
 * kind-free, so the base runtimes keep it (Become pairs plot series by key in a deck without images too); the image
 * modules re-export it from `fluximg/parts`.
 */

const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A key as it is compared: trimmed, lower-cased; a number written as text is its number ("03", "3.0" → "3"). */
export function keyText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (NUMBER_TEXT.test(s)) { const x = Number(s); if (Number.isFinite(x)) return String(x); }
  return s.toLowerCase();
}
export const sameKey = (a: unknown, b: unknown): boolean => { const x = keyText(a); return x !== null && x === keyText(b); };

/** Who a Become member is, for the "key" pair policy: an image object's key, or a plot series' id and name. */
export interface KeyedMember { keys: readonly string[] }
/** The keys an image object or a plot part answers to (normalised; empty = it pairs with nothing by key). */
export function memberKeys(owner: { key?: string; series?: string; seriesName?: string }): string[] {
  const out: string[] = [];
  for (const v of [owner.key, owner.series, owner.seriesName]) { const k = keyText(v); if (k !== null && !out.includes(k)) out.push(k); }
  return out;
}

/**
 * The pairing by key of two member lists: groups of (source indices, destination indices) sharing a key, in source
 * order, plus the members left unmatched. A member matches the FIRST key it shares with the other side. `pairs` counts
 * the matched keys (one footprint and one trace = 1 pair).
 */
export function keyGroups(A: readonly KeyedMember[], B: readonly KeyedMember[]): { groups: Array<{ key: string; a: number[]; b: number[] }>; unmatchedA: number[]; unmatchedB: number[]; pairs: number } {
  const bByKey = new Map<string, number[]>();
  B.forEach((m, j) => { for (const k of m.keys) { let l = bByKey.get(k); if (!l) bByKey.set(k, l = []); if (!l.includes(j)) l.push(j); } });
  const groups = new Map<string, { key: string; a: number[]; b: number[] }>(), usedB = new Set<number>(), unmatchedA: number[] = [];
  A.forEach((m, i) => {
    const k = m.keys.find((x) => bByKey.has(x));
    if (k === undefined) { unmatchedA.push(i); return; }
    let g = groups.get(k);
    if (!g) { g = { key: k, a: [], b: bByKey.get(k)!.filter((j) => !usedB.has(j)) }; for (const j of g.b) usedB.add(j); groups.set(k, g); }
    g.a.push(i);
  });
  const list = [...groups.values()].filter((g) => g.b.length);
  const leftA = [...groups.values()].filter((g) => !g.b.length).flatMap((g) => g.a);
  const unmatchedB = B.map((_, j) => j).filter((j) => !usedB.has(j));
  return { groups: list, unmatchedA: [...unmatchedA, ...leftA].sort((x, y) => x - y), unmatchedB, pairs: list.length };
}

/**
 * Whether "auto" pairs by key (plan D10): at least two keys match and more than half of the SMALLER side's members
 * are matched. Members are counted by distinct key on each side (a series drawn as a line and 40 points is one member).
 */
export function keyPolicyApplies(A: readonly KeyedMember[], B: readonly KeyedMember[]): boolean {
  const distinct = (side: readonly KeyedMember[]) => new Set(side.map((m) => m.keys.join("\u0000")).filter(Boolean));
  const a = distinct(A), b = distinct(B);
  if (!a.size || !b.size) return false;
  const { groups } = keyGroups(A, B);
  if (groups.length < 2) return false;
  const smaller = Math.min(a.size, b.size);
  return groups.length * 2 > smaller;
}
