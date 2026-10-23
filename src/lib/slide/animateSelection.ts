// Animate a set of targets in one step (2026-09-15 surface redesign) — the
// ONE implementation behind the animator's Appear / Emphasize / Disappear
// buttons (SlideMode) and the X-ray's "Animate selected" (which hands over
// every picked row: five series of one plot, the x-axis of three plots, or a
// mix of whole objects and parts). Pure over the Deck; the caller wraps it in
// commitDeckLive so the whole batch is one undo entry.

import type { Deck, Track } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import { slideById, addBeat, appendAnimation } from "./ops";
import { suggestTrack, suggestElementTrack, type AutoPace } from "./autobuild";
import { familyOf } from "./family";
import { newId } from "../ids";
import { trackKey } from "./targets";
import { planStagger, lagTotal } from "./stagger";

export interface AnimateTarget {
  elementId: string;
  /** A plot part id; absent = the whole object. */
  partId?: string;
}
export type AnimateKind = "appear" | "emphasize" | "disappear";

/** Lag across a multi-target Appear/Disappear (manim `FadeIn(group, lag_ratio=0.1)`, 70 % of 3b1b's group fades): from this many
 *  targets (never two: a box and its label stay together) the tracks start one `step` after each other inside a capped group
 *  total. Unconditional (X1e): it is not a pace option. */
export const MULTI_LAG_MIN_TARGETS = 3;
export const MULTI_LAG_RATIO = 0.1;
export const MULTI_LAG_CAP_MS = 1000;

/** Reading order of whole elements: rows top to bottom (two elements share a row when their vertical centres are within half
 *  the taller one's height), left to right inside a row. Deterministic, independent of the order the selection was made in. */
export function readingOrder<T extends { x: number; y: number; width: number; height: number }>(els: readonly T[]): T[] {
  const byTop = [...els].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { cy: number; h: number; items: T[] }[] = [];
  for (const e of byTop) {
    const cy = e.y + e.height / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) <= 0.5 * Math.max(r.h, e.height));
    if (row) row.items.push(e); else rows.push({ cy, h: e.height, items: [e] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

export interface AnimateResult {
  beatIndex: number;
  trackIds: string[];
}

/** Add an appearance-family track per target into `beatIndex` (never the
 *  resting step 0 — a first step is created when the slide has none). A new
 *  effect follows the target's prior effects in the step, so entrance →
 *  emphasis → exit is useful immediately and never replaces. */
export function addAppearanceTracks(
  deck: Deck,
  slideId: string,
  targets: AnimateTarget[],
  kind: AnimateKind,
  beatIndex: number,
  manifests: Record<string, FluxPlotManifest | undefined>,
  options: { pace?: AutoPace } = {},
): AnimateResult | null {
  const slide = slideById(deck, slideId);
  if (!slide || !targets.length) return null;
  // A shared X-ray row and its per-plot row can name the same target. That
  // is one pick, not two consecutive appearances. Deduplicate within this
  // operation only: a later explicit Animate action still appends an effect.
  const elementsById = new Map(slide.elements.map((el) => [el.id, el]));
  const seen = new Set<string>();
  let unique = targets.filter((t) => {
    const key = JSON.stringify([t.elementId, t.partId ?? ""]);
    if (seen.has(key) || !elementsById.has(t.elementId)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return null;
  const lagged = kind !== "emphasize" && unique.length >= MULTI_LAG_MIN_TARGETS;
  // a marquee/shift-pick has no meaningful order: whole objects build in reading order (parts keep the order given)
  if (lagged && unique.every((t) => !t.partId)) {
    const rank = new Map(readingOrder(unique.map((t) => elementsById.get(t.elementId)!)).map((el, i) => [el.id, i]));
    unique = [...unique].sort((a, b) => rank.get(a.elementId)! - rank.get(b.elementId)!);
  }
  let bi = beatIndex;
  if (bi < 1) {
    if (slide.beats.length < 2) addBeat(deck, slideId, { label: "Step 1", advance: "click" });
    bi = Math.max(1, slide.beats.length - 1);
  }
  const beat = slide.beats[bi];
  if (!beat) return null;
  const exit = kind === "disappear";
  const created: string[] = [];
  const manifestOf = (assetId: string) => manifests[assetId];
  for (const t of unique) {
    const el = elementsById.get(t.elementId);
    if (!el) continue;
    const part = t.partId;
    const track: Track =
      part && !exit
        ? suggestTrack(el.type === "plot" ? manifestOf(el.assetId) : undefined, el.id, part, { pace: options.pace })
        : suggestElementTrack(el, { exit, ...(part ? { part } : {}) });
    if (kind === "emphasize") {
      track.preset = "highlight";
      track.duration = 500;
    }
    const key = trackKey(track);
    const prior = beat.tracks.filter((x) => trackKey(x) === key && familyOf(x) === "appearance");
    const last = prior.at(-1);
    if (last) {
      last.id ??= newId("track");
      track.anchor = { trackId: last.id, edge: "end" };
    }
    const added = appendAnimation(deck, slideId, beat.id, track);
    if (added?.id) created.push(added.id);
  }
  if (lagged) {
    // one lag schedule over the NEW tracks that follow nothing: window never longer than the track's own, starts one step apart
    const fresh = beat.tracks.filter((x) => x.id && created.includes(x.id) && !x.anchor);
    const ref = Math.max(0, ...fresh.map((x) => x.duration ?? 0));
    if (fresh.length >= MULTI_LAG_MIN_TARGETS && ref > 0) {
      const plan = planStagger(lagTotal(fresh.length, ref, MULTI_LAG_RATIO, MULTI_LAG_CAP_MS), MULTI_LAG_RATIO, fresh.length - 1);
      fresh.forEach((x, k) => { x.start = Math.round(plan.stepMs * k); x.duration = Math.min(x.duration ?? plan.childMs, plan.childMs); });
    }
  }
  return { beatIndex: bi, trackIds: created };
}
