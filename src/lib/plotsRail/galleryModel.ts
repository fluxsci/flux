// The Plots rail gallery's pure rules (gate: scripts/verify-plots-rail-model.ts): which plots a
// filter / focus folder / similar-names view shows, how variants stack, the journal width class
// of a physical size, and Peek's small formatters. No DOM, no stores — GalleryPane composes them.

import { galleryNameSimilarity } from "../plot/galleryNames";

/** The fields these rules read (a PlotItem satisfies it). */
export interface ModelItem {
  abs: string;
  name: string;
  dir: string;
  mtimeMs: number;
  semantic?: boolean;
}

// ------------------------------------------------------------------------------- filters

export interface Filters { unused: boolean; fluxplot: boolean; dissected: boolean }

export function anyFilter(f: Filters): boolean {
  return f.unused || f.fluxplot || f.dissected;
}

/**
 * Keep the items every active filter accepts. `placed(item)` = how many placements it has in the
 * project; `dissections(item)` = its dissection file count, or null while unknown (an unknown
 * count is kept — a filter never hides a plot on a guess; it disappears once the count is 0).
 */
export function applyFilters<T extends ModelItem>(items: T[], f: Filters, placed: (it: T) => number, dissections: (it: T) => number | null): T[] {
  if (!anyFilter(f)) return items;
  return items.filter((it) => {
    if (f.unused && placed(it) > 0) return false;
    if (f.fluxplot && !it.semantic) return false;
    if (f.dissected) { const n = dissections(it); if (n !== null && n <= 0) return false; }
    return true;
  });
}

// ------------------------------------------------------------------------------- focus folder

/** Whether a plot's folder lies in the focused folder's subtree ("" = everything). */
export function inFolder(dir: string, focus: string): boolean {
  return !focus || dir === focus || dir.startsWith(focus + "/");
}

/** One folder up ("" above a top-level folder). */
export function parentFolder(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i < 0 ? "" : dir.slice(0, i);
}

// ------------------------------------------------------------------------------- similar names

/** Plots whose file names are variants of `ref`'s (the reference first), best match first;
 *  ties keep the incoming order. The gallery dialog's "Similar names" rule. */
export function similarTo<T extends ModelItem>(items: T[], ref: T): T[] {
  const scored = items
    .map((it, i) => ({ it, i, score: it.abs === ref.abs ? Infinity : galleryNameSimilarity(ref.name, it.name) }))
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.it);
}

// ------------------------------------------------------------------------------- variant stacks

// A trailing variant suffix: _v3 / -v12 (versions), _2 / -07 (numbered runs), _a / -B (panels).
const VARIANT_RE = /^(.+?)[_-](?:[vV]\d+|\d+|[a-zA-Z])$/;

/** The stack key of a file name (sans extension), or null when it carries no variant suffix. */
export function variantKey(name: string): string | null {
  const stem = name.replace(/\.[^.]+$/, "");
  const m = VARIANT_RE.exec(stem);
  return m ? m[1].toLowerCase() : null;
}

export type StackEntry<T> =
  | { kind: "plot"; item: T; head?: { key: string; count: number } }
  | { kind: "stack"; key: string; top: T; members: T[] };

/**
 * Stack the variants among ONE folder's items (already in display order). Items sharing a key —
 * the suffixed variants plus an unsuffixed original whose whole stem is the key — form a stack
 * when there are at least two and at least one carries a suffix. A stack sits where its first
 * member was; its top is the newest member. An expanded stack lays its members out in place,
 * the first one marked `head` (the collapse badge).
 */
export function stackVariants<T extends ModelItem>(items: T[], expanded: ReadonlySet<string>): StackEntry<T>[] {
  const keyOf = new Map<T, string>();
  const groups = new Map<string, T[]>();
  const suffixed = new Set<string>();
  for (const it of items) {
    const k = variantKey(it.name);
    if (k) { suffixed.add(`${it.dir}\u0000${k}`); keyOf.set(it, `${it.dir}\u0000${k}`); }
  }
  for (const it of items) {
    if (!keyOf.has(it)) {
      const whole = `${it.dir}\u0000${it.name.replace(/\.[^.]+$/, "").toLowerCase()}`;
      if (suffixed.has(whole)) keyOf.set(it, whole);
    }
    const k = keyOf.get(it);
    if (k) { const g = groups.get(k); if (g) g.push(it); else groups.set(k, [it]); }
  }
  const out: StackEntry<T>[] = [];
  const placed = new Set<string>();
  for (const it of items) {
    const k = keyOf.get(it);
    const g = k ? groups.get(k)! : null;
    if (!k || !g || g.length < 2) { out.push({ kind: "plot", item: it }); continue; }
    if (placed.has(k)) continue;
    placed.add(k);
    const key = k.replace("\u0000", "/");
    if (expanded.has(key)) {
      g.forEach((m, i) => out.push(i === 0 ? { kind: "plot", item: m, head: { key, count: g.length } } : { kind: "plot", item: m }));
    } else {
      const top = g.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
      out.push({ kind: "stack", key, top, members: g });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------- physical size

/** Journal width class of a physical width (single column ≈ 85–90 mm, double ≈ 170–183 mm). */
export function widthClass(physMm: [number, number] | null | undefined): { label: string; title: string } | null {
  if (!physMm || !(physMm[0] > 0)) return null;
  const w = physMm[0];
  const mm = `${w.toFixed(1)} mm wide`;
  if (w <= 95) return { label: "1c", title: `${mm} — fits one journal column (≈ 85–90 mm)` };
  if (w <= 150) return { label: "1.5c", title: `${mm} — a 1.5-column figure (≈ 110–140 mm)` };
  if (w <= 190) return { label: "2c", title: `${mm} — full page width, two columns (≈ 170–183 mm)` };
  return { label: ">2c", title: `${mm} — wider than a journal page (183 mm)` };
}

/** `89.0 × 61.2 mm`. */
export function formatMm(physMm: [number, number] | null | undefined): string {
  return physMm && physMm[0] > 0 && physMm[1] > 0 ? `${physMm[0].toFixed(1)} × ${physMm[1].toFixed(1)} mm` : "";
}

/** "just now" · "12 min ago" · "3 h ago" · "yesterday" · "5 days ago" · a date. */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!(ms > 0)) return "";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** `12 KB` / `3.4 MB`. */
export function formatBytes(n: number): string {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
