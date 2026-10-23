// ---------------------------------------------------------------------------
// Flux Slide — pure grow / pulse geometry (WP 1.2 origins are data; WP 2.2 scaleIn / scaleOut / pulse). No DOM, so the
// player's preset compilers, the PPTX twins and any headless consumer share ONE answer (twin-engine rule).
//
//  • barGrow()        — which axis a bar scales along and which EDGE of its own fill box is its baseline.
//  • isManifestBar()  — does the manifest list this part id as a bar?
//  • growOrigin()     — the CSS transform-origin of a `scaleIn` / `scaleOut` / `pulse` on a WHOLE element.
//  • growStage()      — the same origin as a stage point (the PPTX twin).
//  • groupPoint()     — the shared centre of several elements that enter / pulse together (`"group"`).
//  • pulsePeak()      — the pulse scale: size-aware default, clamped to stay on the stage.
// ---------------------------------------------------------------------------
import type { FluxPlotManifest } from "../plot/types";
import { elementBBox, rotatedAABB, unionRect, type Rect } from "../geometry";
import { isPoint, type PointParam } from "./presetCatalog";

export interface BarGrow {
  /** CSS scale function the entrance animates: scaleY for vertical bars, scaleX for horizontal. */
  fn: "scaleY" | "scaleX";
  /** The baseline edge of the bar's own box, as a `transform-origin` (percent of its fill-box). */
  origin: string;
}

type BarInfo = { orientation?: string; length?: (number | null)[] };

type BarEntry = { bar?: BarInfo; index: number };
// One part-id -> (series bar info, index) map per manifest, built on first use: a histogram of thousands of bins must not
// scan every series' bar list for every node (O(bars^2) at build). Manifests are immutable once loaded.
const barIndexes = new WeakMap<object, Map<string, BarEntry>>();
function barIndex(manifest: FluxPlotManifest): Map<string, BarEntry> {
  let map = barIndexes.get(manifest);
  if (!map) {
    map = new Map();
    for (const s of manifest.series ?? []) {
      const bars = s.svg?.bars;
      if (!Array.isArray(bars)) continue;
      const bar = (s as unknown as { bar?: BarInfo }).bar;
      bars.forEach((id, index) => { if (!map!.has(id)) map!.set(id, { bar, index }); });
    }
    barIndexes.set(manifest, map);
  }
  return map;
}

/** The series info and index that list `partId` among their bars, or undefined (the first series to list it wins). */
const barSeries = (manifest: FluxPlotManifest | undefined, partId: string): BarEntry | undefined => manifest ? barIndex(manifest).get(partId) : undefined;

/** Is `partId` one of the manifest's bars (`series[].svg.bars`)? */
export const isManifestBar = (manifest: FluxPlotManifest | undefined, partId: string): boolean => !!barSeries(manifest, partId);

/** Orientation + sign of one bar. Orientation is `series[].bar.orientation`; the sign is the signed
 *  `bar.length[i]` (value − baseline), else the node's own `data-x` (horizontal) / `data-y` (vertical)
 *  value. Absent manifest/bar info = the legacy reading: a vertical bar growing up from its bottom edge.
 *  Inverted VALUE axes are not detected (axis anchors cannot be matched to a series' panel reliably);
 *  inverted CATEGORY axes (ranked barh lists) never move the value axis. */
export function barGrow(manifest: FluxPlotManifest | undefined, partId: string, dataAttrs?: { x?: number | null; y?: number | null }): BarGrow {
  const found = barSeries(manifest, partId);
  const horizontal = found?.bar?.orientation === "horizontal";
  const length = found?.bar?.length?.[found.index];
  const datum = horizontal ? dataAttrs?.x : dataAttrs?.y;
  const negative = typeof length === "number" ? length < 0 : typeof datum === "number" && datum < 0;
  return horizontal
    ? { fn: "scaleX", origin: negative ? "100% 50%" : "0% 50%" }
    : { fn: "scaleY", origin: negative ? "50% 0%" : "50% 100%" };
}

// ---------------------------------------------------------------------------
// scaleIn / scaleOut / pulse origins (manim GrowFromPoint / GrowFromCenter / GrowFromEdge / GrowArrow, Indicate)
// ---------------------------------------------------------------------------
export type Compass = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw" | "center";
const COMPASS: Record<Compass, readonly [number, number]> = {
  center: [50, 50], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50], nw: [0, 0],
};
export const isCompass = (v: unknown): v is Compass => typeof v === "string" && Object.prototype.hasOwnProperty.call(COMPASS, v);
/** `transform-origin` for a compass point of the node's own box (fill-box on an SVG part). */
export const compassOrigin = (c: Compass): string => `${COMPASS[c][0]}% ${COMPASS[c][1]}%`;

/** The slice of a slide element the grow geometry reads (structural: a stored Element satisfies it). */
export interface GrowElement {
  type: string; x: number; y: number; width: number; height: number; rotation?: number;
  x1?: number; y1?: number; x2?: number; y2?: number; arrowStart?: boolean; arrowEnd?: boolean;
}
export type StagePoint = PointParam;
const isLine = (e: GrowElement): boolean => e.type === "line" && e.x1 !== undefined && e.x2 !== undefined;
const boxOf = (e: GrowElement): Rect => elementBBox(e as never);

/** The shared origin of elements that enter / pulse TOGETHER: the centre of the union of their ROTATED boxes (manim animates
 *  a VGroup about the group's centre). undefined for an empty set. */
export function groupPoint(els: readonly GrowElement[]): StagePoint | undefined {
  const u = unionRect(els.map(e => rotatedAABB(e as never)));
  return u ? { x: u.x + u.w / 2, y: u.y + u.h / 2 } : undefined;
}

/** The origin in the element's own UNROTATED local frame (px from its box's top-left), or undefined = "the centre".
 *  `from`: a compass word | "tail" | "auto" (the tail of a line / arrow, else the centre) | a stage point | "group" (the caller
 *  resolves it into `group`; without one it reads as "auto"). The tail of an arrow is the end without a head (a plain or double-headed line: its start / its centre). */
export function growLocal(from: unknown, el: GrowElement | undefined, group?: StagePoint): StagePoint | undefined {
  if (!el) return undefined;
  const b = boxOf(el), rad = -(el.rotation ?? 0) * Math.PI / 180;
  // "group" with no group point (a lone track, nothing else enters with it) is plain "auto"
  if (from === undefined || from === "auto" || from === "tail" || from === "group" && !group) {
    if (!isLine(el)) return undefined;
    const doubleHead = !!el.arrowStart && !!el.arrowEnd;
    if (doubleHead) return undefined;
    const tail = el.arrowStart ? [el.x + el.x2!, el.y + el.y2!] : [el.x + el.x1!, el.y + el.y1!];
    return { x: tail[0] - b.x, y: tail[1] - b.y };
  }
  if (isCompass(from)) { const [fx, fy] = COMPASS[from]; return { x: b.w * fx / 100, y: b.h * fy / 100 }; }
  const pt = from === "group" ? group : isPoint(from) ? from : undefined;
  if (pt) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = pt.x - cx, dy = pt.y - cy;
    return { x: cx + dx * Math.cos(rad) - dy * Math.sin(rad) - b.x, y: cy + dx * Math.sin(rad) + dy * Math.cos(rad) - b.y };
  }
  return undefined;
}
export function growOrigin(from: unknown, el: GrowElement | undefined, group?: StagePoint): string {
  const p = growLocal(from, el, group);
  return p ? `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px` : "50% 50%";
}
/** The same origin in STAGE coordinates (the PPTX Morph twin scales its box about this point). */
export function growStage(from: unknown, el: GrowElement, group?: StagePoint): StagePoint {
  const b = boxOf(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2, l = growLocal(from, el, group);
  if (!l) return { x: cx, y: cy };
  const a = (el.rotation ?? 0) * Math.PI / 180, dx = b.x + l.x - cx, dy = b.y + l.y - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

export const PULSE_MIN = 1.12, PULSE_MAX = 1.3, PULSE_GROW_UNITS = 8, STAGE_MARGIN = 6;
/** Default pulse peak for a box of the given short side: at least `PULSE_GROW_UNITS` stage units (8 = 24 px at 1080p) of growth on
 *  a small target, never below 1.12 nor above 1.3. */
export const pulseAuto = (box: { w: number; h: number } | undefined): number =>
  box && Math.min(box.w, box.h) > 0 ? Math.min(PULSE_MAX, Math.max(PULSE_MIN, 1 + PULSE_GROW_UNITS / Math.min(box.w, box.h))) : PULSE_MIN;
/** The pulse peak: an authored finite `scale` > 1 (capped at 3), else `pulseAuto`; then clamped so the grown box about `about`
 *  (default its centre) keeps `margin` stage units from the stage edge. Never below 1 (a shrink pulse is not supported:
 *  `scale` <= 1 falls back to the auto peak). */
export function pulsePeak(authored: unknown, box: Rect | undefined, stage: { width: number; height: number }, about?: StagePoint, margin = STAGE_MARGIN): number {
  let k = typeof authored === "number" && Number.isFinite(authored) && authored > 1 ? Math.min(authored, 3) : pulseAuto(box);
  if (!box) return Math.max(1, k);
  const ax = about?.x ?? box.x + box.w / 2, ay = about?.y ?? box.y + box.h / 2;
  // the grown box edge is a + (edge - a)·k: keep every edge inside [margin, stage - margin]
  const lim = (lo: number, hi: number, a: number, max: number) => {
    let r = Infinity;
    if (lo < a) r = Math.min(r, (a - margin) / (a - lo)); else if (lo > a) r = Math.min(r, (max - margin - a) / (lo - a));
    if (hi > a) r = Math.min(r, (max - margin - a) / (hi - a)); else if (hi < a) r = Math.min(r, (a - margin) / (a - hi));
    return r;
  };
  k = Math.min(k, lim(box.x, box.x + box.w, ax, stage.width), lim(box.y, box.y + box.h, ay, stage.height));
  return Math.max(1, k);
}
