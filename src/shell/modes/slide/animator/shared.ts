// Shared vocabulary of the animator components: preset colors, editor option
// lists, chip labels, and the temporal math the Gantt lanes are built on.

import type { Slide, Track, PresetName, TargetRef } from "../../../../lib/slide/types";
import type { Figure, Element } from "../../../../lib/types";
import type { FluxPlotManifest, PartNode } from "../../../../lib/plot/types";
import { buildModel3dTree } from "../../../../lib/model3d/tree";
import { labelForPart } from "../../../../lib/plot/tree";
import { elementLabel } from "../../../../lib/xray/buildXrayTree";
import { isHandoff, trackRef, targetPartIds, isScene3dManifest } from "../../../../lib/slide/targets";
import { semanticTargets, trackDuration } from "../../../../lib/slide/compile";
import { resolveTrack, resolveStart, resolveBeat, type StyleContext, type ManifestFor } from "../../../../lib/slide/resolve";
import { staggerSpan } from "../../../../lib/slide/stagger";
import { EASING_TOKENS } from "../../../../lib/slide/curves";
import { PRESET_CATALOG, presetDef, EDITABLE_PRESETS, KNOWN_PRESETS } from "../../../../lib/slide/presetCatalog";

export const PRESET_COLOR: Record<string, string> = Object.fromEntries(
  Object.values(PRESET_CATALOG).map(def => [def.name, def.colour]),
);

export const EDIT_PRESETS: PresetName[] = [...EDITABLE_PRESETS];
export const EASINGS: readonly string[] = EASING_TOKENS;
export function presetLabel(preset: string): string {
  return KNOWN_PRESETS.has(preset) ? presetDef(preset).label : preset;
}

/** The three WAYS of transforming, read off the one transform track: a birth
 *  (`ghostFrom`) is a Ghost; an endpoint that names another kind (`state.type`)
 *  or another content asset (`to.assetId`) is a Become; anything else is a
 *  Change. Purely a label — playback never distinguishes them. */
export type TransformWay = "change" | "ghost" | "become";
export function transformWay(t: Track): TransformWay {
  if (t.ghostFrom) return "ghost";
  const st = t.to?.state as Record<string, unknown> | undefined;
  if (t.to?.become || (st && typeof st.type === "string") || t.to?.assetId) return "become";
  return "change";
}
export const WAY_LABEL: Record<TransformWay, string> = { change: "Change", ghost: "Ghost", become: "Become" };
/** The lane sub-label: "Transform · Become", "Fade in", … */
export function trackKindLabel(t: Track, deck: StyleContext = {}): string {
  t = resolveTrack(t, deck);
  if (t.preset === "transform") return `Transform · ${WAY_LABEL[transformWay(t)]}`;
  return presetLabel(t.preset ?? "fade");
}
/** Element type → a compact glyph for tree rows / chip labels (the figure
 *  element union — slides-are-figures). */
export const EL_GLYPH: Record<string, string> = {
  model3d: "◇", plot: "▤", text: "¶", image: "▣", video: "▶", rect: "▭", ellipse: "◯", line: "╱", path: "〰",
};

/** A compact label for a track chip (prefixed with a P-tag when the slide has
 *  several plots so identical part names stay distinguishable). */
export function refLabel(ref: TargetRef, slide: Slide | null, manifestFor: ManifestFor = () => undefined, plotTags = new Map<string, string>(), maxParts = 1): string {
  const el = slide?.elements.find(e => e.id === ref.element);
  if (ref.group) return slide?.groups?.[ref.group]?.name || "Group";
  if (!el || !slide) return "missing";
  const manifest = manifestFor(el.id);
  const manifests = el.type === "plot" && manifest && !isScene3dManifest(manifest) ? { [el.assetId]: manifest } : {};
  const tag = plotTags.get(el.id);
  const name = (tag ? `${tag} · ` : "") + elementLabel(slide as unknown as Figure, el as Element, manifests);
  const ids = ref.selector ? targetPartIds({ parts: ref.parts, selector: ref.selector }, manifest) : [...new Set(ref.parts ?? [])];
  if (!ids.length) return name;
  const nodes = new Map<string, PartNode>();
  const walk = (n: PartNode) => { if (n.id || n.ref) nodes.set((n.id ?? n.ref)!, n); n.children?.forEach(walk); };
  if (isScene3dManifest(manifest)) {
    const queue = [buildModel3dTree(manifest)];
    for (const node of queue) { nodes.set(node.id, { id: node.id, label: node.label }); queue.push(...node.children); }
  } else if (manifest?.parts) walk(manifest.parts);
  const labels = ids.slice(0, ids.length > maxParts ? 1 : maxParts).map(id => {
    const node = nodes.get(id) ?? { id };
    const label = labelForPart(node);
    const axis = id.match(/(?:^|\.)axis\.([xyz])\./)?.[1];
    return axis && !node.label ? `${axis.toUpperCase()} axis ${label.toLowerCase()}` : label;
  });
  return `${name} › ${labels.join(", ")}${ids.length > maxParts ? ` + ${ids.length - 1}` : ""}`;
}

export function chipLabel(t: Track, slide: Slide | null, plotTags: Map<string, string>, deck: StyleContext = {}, manifestFor: ManifestFor = () => undefined): string {
  t = resolveTrack(t, deck);
  if (t.target.startsWith("@")) return t.target.slice(1);
  if (isHandoff(t)) return `${refLabel(trackRef(t), slide, manifestFor, plotTags)} → ${refLabel(t.to.become.ref, slide, manifestFor, plotTags)}`;
  // Ghost chips describe lineage; ordinary bindings share the semantic ref label.
  if (t.ghostFrom) return `${refLabel({ element: t.ghostFrom }, slide, manifestFor, plotTags)} → ${refLabel(trackRef(t), slide, manifestFor, plotTags)}`;
  return refLabel(trackRef(t), slide, manifestFor, plotTags);
}

/** A track whose element target no longer exists on the slide (the figure
 *  editor deleted it). Tolerated (the player no-ops), marked in the timeline,
 *  never auto-pruned — an undo of the deletion restores the animation. */
export function isDanglingTrack(t: Track, slide: Slide | null): boolean {
  if (t.target.startsWith("@")) return false;
  return !slide?.elements.some((e) => e.id === t.target);
}

/** How many targets a track fans out to (drives the stagger tail length). */
export function trackFanout(t: Track, slide: Slide | null, manifest: ReturnType<ManifestFor>): number {
  if (slide && (t.part || t.parts?.length || t.selector)) return Math.max(1, semanticTargets(t, slide, {plotManifest: () => !isScene3dManifest(manifest) ? manifest : undefined, modelManifest: () => isScene3dManifest(manifest) ? manifest : undefined}).length);
  return 1;
}

/** A track's time footprint within its beat: [start, start+duration+staggerSpan]. */
export function trackEndMs(t: Track, slide: Slide | null, manifest: ReturnType<ManifestFor>, deck: StyleContext = {}, manifestFor: ManifestFor = () => manifest): number {
  const beat = slide?.beats.find(b => b.tracks.some(x => x === t || t.id != null && x.id === t.id));
  const start = beat ? resolveStart(t, beat, deck, manifestFor).start : resolveTrack(t, deck).start ?? 0;
  t = resolveTrack(t, deck);
  const dur = trackDuration(t);
  const span = staggerSpan(t, trackFanout(t, slide, manifest));
  return start + dur + span;
}

/** The latest end time of any track on a beat (min 1ms so empty beats layout). */
export function beatEndMs(tracks: Track[], slide: Slide | null, manifestFor: ManifestFor, deck: StyleContext = {}): number {
  let end = 0;
  const resolved = resolveBeat({ id: "", tracks }, deck, manifestFor).tracks;
  for (const t of resolved) if (!t.disabled) end = Math.max(end, (t.start ?? 0) + trackDuration(t) + staggerSpan(t, trackFanout(t, slide, manifestFor(t.target))));
  return end;
}

/** Auto-fit px-per-ms: the slide's longest beat maps to ~260px, clamped sane. */
export function autoPxPerMs(maxEndMs: number): number {
  return Math.max(0.04, Math.min(0.35, 260 / Math.max(1, maxEndMs)));
}

/** The minor grid step between two ruler ticks: half a tick, a quarter once
 *  the timeline is zoomed in past .3 px/ms (a 250ms tick then subdivides to
 *  62.5ms lines that still sit ≥18px apart). */
export function minorTickStep(tickStep: number, pxPerMs: number): number {
  return tickStep / (pxPerMs > 0.3 ? 4 : 2);
}

/** The minor grid lines of a beat: every subdivision of the ruler ticks that
 *  is NOT itself a tick (the timeline draws ticks as major lines). */
export function minorTicks(durationMs: number, tickStep: number, pxPerMs: number): number[] {
  const step = minorTickStep(tickStep, pxPerMs);
  const per = Math.round(tickStep / step);
  const out: number[] = [];
  for (let i = 1; i * step <= durationMs; i++) if (i % per) out.push(i * step);
  return out;
}

/** Snap a ms value within an 8-screen-px threshold, nearest first, to other
 *  tracks' boundaries (magnets) or a DRAWN grid line (`gridStepMs`: the
 *  timeline's minor step, so every major and minor line it paints is a snap
 *  target). Failing those, the 50ms round-number grid (same threshold), then
 *  10ms quantization. `originMs` places the value on the beat's time axis: a
 *  duration drag passes the track's start, so the END edge (not the duration)
 *  lands on the line. Alt disables via `enabled:false`. */
export function snapMs(ms: number, magnets: number[], pxPerMs: number, enabled: boolean, gridStepMs = 50, originMs = 0): number {
  if (!enabled) return Math.max(0, Math.round(ms));
  const thresholdMs = 8 / pxPerMs;
  const onGrid = (step: number) => Math.round((ms + originMs) / step) * step - originMs;
  let best = onGrid(gridStepMs);
  let bestD = Math.abs(ms - best);
  for (const m of magnets) {
    const d = Math.abs(ms - m);
    if (d < bestD) { best = m; bestD = d; }
  }
  if (bestD <= thresholdMs) return Math.max(0, best);
  const round = onGrid(50);
  if (Math.abs(ms - round) <= thresholdMs) return Math.max(0, round);
  return Math.max(0, Math.round(ms / 10) * 10);
}

/** True when `ms` sits on a snap grid line (a drawn line of `gridStepMs`, or the
 *  50ms round-number grid) — the drag guide lights the line it snapped to. */
export function gridLineAt(ms: number, gridStepMs: number): number | null {
  for (const step of [gridStepMs, 50]) {
    const g = Math.round(ms / step) * step;
    if (Math.abs(g - ms) <= .5) return g;
  }
  return null;
}
