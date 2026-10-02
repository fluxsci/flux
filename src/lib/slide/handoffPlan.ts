// Shared preparation for playback and animator warming. No live DOM or layout.
import type { SlideFrame } from "./compile";
import type { Track, TargetRef, BecomeSpec } from "./types";
import type { StageOutline } from "./stageOutline";
import { trackRef, isWholeElementRef } from "./targets";
import { targetOutlines, plotStageMapping, type GeometryCtx } from "./targetGeometry";
import { planCorrespondence, type CorrespondencePlan, type DataHint } from "./correspondence";
import { viewFits } from "../plot/project";

/** An outline wholly outside a cropped plot cannot take part in a flight.
 *  Test in the plot's unrotated frame, including its flips. Partial overlaps
 *  keep their geometry; the flight driver clips them to the destination box. */
function insideCrop(outline: StageOutline, frame: SlideFrame): boolean {
  const plot = frame.elements.find(el => el.id === outline.owner.elementId);
  if (plot?.type !== "plot" || !plot.crop) return true;
  const b = outline.bbox, cx = plot.x + plot.width / 2, cy = plot.y + plot.height / 2;
  const angle = -plot.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const x of [b.x, b.x + b.w]) for (const y of [b.y, b.y + b.h]) {
    const px = c * (x - cx) - s * (y - cy) + cx, py = s * (x - cx) + c * (y - cy) + cy;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  return maxX >= plot.x && minX <= plot.x + plot.width && maxY >= plot.y && minY <= plot.y + plot.height;
}

function axisHint(ref: TargetRef, outlines: StageOutline[], frame: SlideFrame, ctx: GeometryCtx): DataHint["destAxisFit"] {
  // A set has no single destination axis to land data on: auto pairs it by
  // position or tiles (choosePolicy without a fit).
  if (ref.members) return undefined;
  const plot = frame.elements.find(el => el.id === ref.element);
  if (plot?.type !== "plot" || plot.rotation % 360 !== 0) return undefined;
  const manifest = ctx.manifest(plot.assetId), root = ctx.plotRoot(plot.assetId);
  if (!manifest || !root) return undefined;
  const seriesId = outlines.find(o => o.owner.series)?.owner.series;
  const series = manifest.series?.find(s => s.id === seriesId);
  const fits = viewFits(manifest, plot.view, series?.panelId);
  return fits ? plotStageMapping(plot, root).fitX(fits.x) : undefined;
}

/** `group` (MERGE, Oct-2): every hand-off of the step landing on this same
 *  destination ref, in story order, this track included. Each lander plans
 *  the ONE shared correspondence of all their sources against the destination
 *  (the time-reverse of a set split: the destination tiles among the sources)
 *  and keeps only the pairs its own source owns; the last lander also carries
 *  the destination-only pairs (leftovers, a filled ring's underlay), which
 *  resolve as the group lands. */
export function planHandoff(track: Track, frame: SlideFrame, ctx: GeometryCtx, group?: readonly Track[]): CorrespondencePlan {
  if (group && group.length > 1) return planMergeShare(track, frame, ctx, group);
  return planOne(track, frame, ctx);
}

const ownerKey = (o: { elementId: string; partId?: string }) => `${o.elementId}\0${o.partId ?? ""}`;
function planMergeShare(track: Track, frame: SlideFrame, ctx: GeometryCtx, group: readonly Track[]): CorrespondencePlan {
  const isMe = (t: Track) => t === track || !!t.id && t.id === track.id;
  // Every lander plans the SAME correspondence (group order), so the pieces
  // they share out tile the destination exactly once.
  const sources = group.map(t => targetOutlines(trackRef(t), frame, ctx).filter(o => insideCrop(o, frame)));
  const full = planOne(track, frame, ctx, sources.flat());
  const mine = new Set(sources[group.findIndex(isMe)]?.map(o => ownerKey(o.owner)) ?? []);
  const last = isMe(group[group.length - 1]);
  const pairs = full.pairs.filter(p => p.fade || !p.a ? last : (p.a.owner.members ?? [p.a.owner]).some(m => mine.has(ownerKey(m))));
  return { pairs, policy: full.policy, driver: full.driver, destinations: full.destinations, prepare() { for (const p of pairs) p.plan?.prepare(); } };
}

function planOne(track: Track, frame: SlideFrame, ctx: GeometryCtx, sourceOutlines?: StageOutline[]): CorrespondencePlan {
  const spec = track.to!.become as BecomeSpec, source = trackRef(track);
  const a = sourceOutlines ?? targetOutlines(source, frame, ctx).filter(o => insideCrop(o, frame));
  const b = targetOutlines(spec.ref, frame, ctx).filter(o => insideCrop(o, frame));
  const data: DataHint = { destAxisFit: axisHint(spec.ref, b, frame, ctx), sourceAxisFit: axisHint(source, a, frame, ctx) };
  const dest = frame.elements.find(el => el.id === spec.ref.element);
  // Whole-plot default: one source becomes the merged axes, not a slice of
  // every tick/label/data mark. All remaining parts use the planner's ordinary
  // b-only envelope. Explicit non-default policies still mean what they say.
  if (dest?.type === "plot" && isWholeElementRef(spec.ref) && (!spec.pair || spec.pair === "auto" || spec.pair === "tile")) {
    const spines = b.filter(o => /(?:^|\.)axis\.[xy]\.spine$/.test(o.owner.partId ?? ""));
    if (spines.length) {
      const flight = planCorrespondence(a, spines, { pair: "tile", data });
      const rest = planCorrespondence([], b.filter(o => !spines.includes(o)));
      return { pairs: [...flight.pairs, ...rest.pairs], policy: "tile", driver: flight.driver,
        destinations: [...flight.destinations, ...rest.destinations], prepare() { flight.prepare(); rest.prepare(); } };
    }
  }
  if (spec.ref.members && (!spec.pair || spec.pair === "auto" || spec.pair === "tile")) {
    // A set member that is a WHOLE plot lands like a whole-plot hand-off: its
    // merged spines take part in the flight with the other members, and its
    // remaining parts fade in on the b-only envelope.
    const wholePlots = new Set(spec.ref.members.filter(m => isWholeElementRef(m) && frame.elements.find(el => el.id === m.element)?.type === "plot").map(m => m.element));
    const spine = (o: StageOutline) => /(?:^|\.)axis\.[xy]\.spine$/.test(o.owner.partId ?? "");
    const spined = new Set([...wholePlots].filter(id => b.some(o => o.owner.elementId === id && spine(o))));
    if (spined.size) {
      const flying = b.filter(o => !spined.has(o.owner.elementId) || spine(o)), resting = b.filter(o => !flying.includes(o));
      const flight = planCorrespondence(a, flying, { pair: spec.pair, data });
      const rest = planCorrespondence([], resting);
      return { pairs: [...flight.pairs, ...rest.pairs], policy: flight.policy, driver: flight.driver,
        destinations: [...flight.destinations, ...rest.destinations], prepare() { flight.prepare(); rest.prepare(); } };
    }
  }
  return planCorrespondence(a, b, { pair: spec.pair, data });
}
