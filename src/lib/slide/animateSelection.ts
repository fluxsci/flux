// Animate a set of targets in one step (2026-09-15 surface redesign) — the
// ONE implementation behind the animator's Appear / Emphasize / Disappear
// buttons (SlideMode) and the X-ray's "Animate selected" (which hands over
// every picked row: five series of one plot, the x-axis of three plots, or a
// mix of whole objects and parts). Pure over the Deck; the caller wraps it in
// commitDeckLive so the whole batch is one undo entry.

import type { Deck, Track } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import { slideById, addBeat, appendAnimation } from "./ops";
import { suggestTrack, suggestElementTrack } from "./autobuild";
import { familyOf } from "./family";
import { semanticTargets, trackDuration } from "./compile";
import { staggerSpan } from "./stagger";

export interface AnimateTarget {
  elementId: string;
  /** A plot part id; absent = the whole object. */
  partId?: string;
}
export type AnimateKind = "appear" | "emphasize" | "disappear";

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
): AnimateResult | null {
  const slide = slideById(deck, slideId);
  if (!slide || !targets.length) return null;
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
  for (const t of targets) {
    const el = slide.elements.find((e) => e.id === t.elementId);
    if (!el) continue;
    const part = t.partId;
    const track: Track =
      part && !exit
        ? suggestTrack(el.type === "plot" ? manifestOf(el.assetId) : undefined, el.id, part)
        : suggestElementTrack(el, { exit, ...(part ? { part } : {}) });
    if (kind === "emphasize") {
      track.preset = "highlight";
      track.duration = 500;
    }
    const prior = beat.tracks.filter(
      (x) => x.target === el.id && (x.part ?? "") === (track.part ?? "") && familyOf(x) === "appearance",
    );
    track.start = prior.reduce(
      (end, x) =>
        Math.max(
          end,
          (x.start ?? 0) +
            trackDuration(x) +
            staggerSpan(x, semanticTargets(x, slide, { plotManifest: (id) => manifestOf(id) }).length),
        ),
      0,
    );
    const added = appendAnimation(deck, slideId, beat.id, track);
    if (added?.id) created.push(added.id);
  }
  return { beatIndex: bi, trackIds: created };
}
