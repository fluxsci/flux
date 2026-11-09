// Display tiers for raster images — the editor never paints an image at more pixels than the screen needs.
//
// Why (measured 2026-11-09 on the owner's scratch project, Figure 22: nine PNGs of 28 MP, 103 MB): the
// live DOM held each original as a 27 MB data URL. Every zoom-proxy capture — 1.5 s after any zoom or
// edit — re-serialized all nine and decoded 254 MP on the main thread: a 520–590 ms freeze, up to 1 s,
// after EVERY settle. Chromium also decodes a 28 MP image to 113 MB to draw it 300 px wide. Per-frame
// and per-capture cost must follow what is on screen, never what is on disk.
//
// A TIER is a downsampled copy on a half-octave ladder: level k has natural / 2^(k/2) pixels a side,
// so a tier is at most 2× the pixels the screen needs. The image element shows the coarsest tier that
// is still at least screen-sharp, capped at TIER_MAX_PIXELS; past that cap (deep zoom into a large
// image) a DETAIL — the visible part only, at screen density — is drawn over the tier and is excluded
// from every scene capture. Exports, saves and pictures use the original bytes: tiers are display only.
// This module is the pure policy (figure/imageDisplay.ts owns residency and IO).

/** Images at or under this many pixels show their own bytes: a tier would save nothing. */
export const TIER_MIN_SOURCE_PIXELS = 600_000;
/** No tier above this many pixels: a tier's bytes ride every scene capture. */
export const TIER_MAX_PIXELS = 2_000_000;
/** The coarsest tier kept (px on the long side). */
export const TIER_MIN_SIDE = 192;
/** A detail's pixel budget (the visible part of one image at screen density). */
export const DETAIL_MAX_PIXELS = 4_000_000;
/** Sharper than the screen by this factor before a tier counts as enough (resampling headroom). */
export const TIER_HEADROOM = 1;

export interface TierSize { level: number; width: number; height: number }

export const needsTiers = (naturalWidth: number, naturalHeight: number): boolean =>
  naturalWidth > 0 && naturalHeight > 0 && naturalWidth * naturalHeight > TIER_MIN_SOURCE_PIXELS;

/** Level k is the natural size divided by 2^(k/2) (level 0 = the original). */
export function tierSize(naturalWidth: number, naturalHeight: number, level: number): TierSize {
  const f = Math.pow(2, level / 2);
  return { level, width: Math.max(1, Math.round(naturalWidth / f)), height: Math.max(1, Math.round(naturalHeight / f)) };
}

/** The sharpest tier allowed (the smallest level whose pixels fit TIER_MAX_PIXELS). */
export function sharpestLevel(naturalWidth: number, naturalHeight: number): number {
  for (let level = 1; level < 64; level++) { const s = tierSize(naturalWidth, naturalHeight, level); if (s.width * s.height <= TIER_MAX_PIXELS) return level; }
  return 64;
}
/** The coarsest tier kept (the largest level whose long side is still ≥ TIER_MIN_SIDE). */
export function coarsestLevel(naturalWidth: number, naturalHeight: number): number {
  const first = sharpestLevel(naturalWidth, naturalHeight);
  let level = first;
  while (level < 64) { const s = tierSize(naturalWidth, naturalHeight, level + 1); if (Math.max(s.width, s.height) < TIER_MIN_SIDE) break; level++; }
  return level;
}
/** The tier for `density` device pixels per source pixel: the coarsest one still at least that sharp,
 *  clamped to the ladder. `density` ≥ 1 means the screen wants more than the original has. */
export function levelFor(naturalWidth: number, naturalHeight: number, density: number): number {
  const first = sharpestLevel(naturalWidth, naturalHeight), last = coarsestLevel(naturalWidth, naturalHeight);
  if (!(density > 0)) return last;
  // 2^(-level/2) ≥ density·headroom  ⇔  level ≤ −2·log2(density·headroom)
  const level = Math.floor(-2 * Math.log2(density * TIER_HEADROOM) + 1e-9);
  return Math.min(last, Math.max(first, level));
}
/** Every level of the ladder, sharpest first. */
export function ladder(naturalWidth: number, naturalHeight: number): TierSize[] {
  const out: TierSize[] = [];
  for (let level = sharpestLevel(naturalWidth, naturalHeight), last = coarsestLevel(naturalWidth, naturalHeight); level <= last; level++) out.push(tierSize(naturalWidth, naturalHeight, level));
  return out;
}

/** Does the sharpest tier still fall short of the screen (so a detail is wanted)? */
export function tierIsSoft(naturalWidth: number, naturalHeight: number, density: number): boolean {
  const s = tierSize(naturalWidth, naturalHeight, sharpestLevel(naturalWidth, naturalHeight));
  return s.width / naturalWidth < Math.min(1, density) * 0.8;
}

export interface SourceRect { x: number; y: number; width: number; height: number }
export interface DetailPlan { source: SourceRect; width: number; height: number; density: number }
/** The detail for one placement: `visible` is the part of the image on screen, in SOURCE pixels (already
 *  clipped to the image). Grown by a margin so a small pan keeps it, snapped to a 64 px grid so the same
 *  resting view asks for the same detail, drawn at screen density (never above the source's own), and
 *  shrunk uniformly to DETAIL_MAX_PIXELS. Null when nothing is visible. */
export function detailPlan(naturalWidth: number, naturalHeight: number, visible: SourceRect, density: number): DetailPlan | null {
  if (!(visible.width > 0) || !(visible.height > 0)) return null;
  const mx = visible.width * 0.25, my = visible.height * 0.25, grid = 64;
  const x0 = Math.max(0, Math.floor((visible.x - mx) / grid) * grid), y0 = Math.max(0, Math.floor((visible.y - my) / grid) * grid);
  const x1 = Math.min(naturalWidth, Math.ceil((visible.x + visible.width + mx) / grid) * grid), y1 = Math.min(naturalHeight, Math.ceil((visible.y + visible.height + my) / grid) * grid);
  const source = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (!(source.width > 0) || !(source.height > 0)) return null;
  let scale = Math.min(1, density);
  const pixels = source.width * source.height * scale * scale;
  if (pixels > DETAIL_MAX_PIXELS) scale *= Math.sqrt(DETAIL_MAX_PIXELS / pixels);
  return { source, width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)), density: scale };
}
/** A resident detail still serves a view when it covers the visible part and is at least 0.8× as dense. */
export function detailServes(have: DetailPlan, visible: SourceRect, density: number): boolean {
  const s = have.source;
  return visible.x >= s.x - 0.5 && visible.y >= s.y - 0.5 && visible.x + visible.width <= s.x + s.width + 0.5 && visible.y + visible.height <= s.y + s.height + 0.5
    && have.density >= Math.min(1, density) * 0.8;
}

/** Cache layout under <project>/.meta/cache/display/. The meta names the source it was made from. */
export const DISPLAY_CACHE_VERSION = 1;
export const displayCacheDir = (root: string): string => `${root.replace(/[\\/]+$/, "")}/.meta/cache/display`;
export const displayCacheMeta = (root: string, assetId: string): string => `${displayCacheDir(root)}/${assetId}.json`;
export const displayCacheTier = (root: string, assetId: string, level: number): string => `${displayCacheDir(root)}/${assetId}.L${level}.png`;
export interface DisplayCacheMeta { version: number; source: { size: number; mtimeMs: number }; natural: { width: number; height: number }; levels: number[] }
export function cacheMetaValid(meta: unknown, source: { size: number; mtimeMs: number } | null): meta is DisplayCacheMeta {
  const m = meta as DisplayCacheMeta | null;
  return !!m && !!source && m.version === DISPLAY_CACHE_VERSION && m.source?.size === source.size && m.source?.mtimeMs === source.mtimeMs
    && m.natural?.width > 0 && m.natural?.height > 0 && Array.isArray(m.levels) && m.levels.every(Number.isInteger);
}
