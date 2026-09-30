import { familyOf } from "./family";
// ---------------------------------------------------------------------------
// Flux Slide — autoAnimatePlot (§ the one-click magic). Turn a FluxPlot's own
// authored build hints (manifest.build.order + build.presets) into a ready-to-
// play beat sequence: "hide everything, then reveal it the way the plot says to."
//
// This is the consumption layer the whole pillar was built for. The plot already
// ships a scene graph (parts tree) + a build script (order + per-role presets);
// here we walk that into beats + tracks the player runs. The result is the user's
// north-star scatter sequence with zero manual authoring: axes draw on, gridlines
// fade, the fit line draws itself as the points stagger in left→right, legend last.
//
// Design notes:
//  • build.order entries are a MIX of tree-node ids ("axis.x", "setosa.points")
//    and role-refs that name no node ("gridlines" = every gridline group). Both
//    resolve here; the player then expands a node id → its leaves at play time.
//  • A CONTAINER entry ("axis.x") is decomposed to per-child tracks so its spine
//    + ticks draw-on while its tick-labels + title fade-in (you can't draw-on
//    text) — and its gridlines child is skipped because "gridlines" is its own
//    build step (roleClaims), so nothing animates twice.
//  • Tracks bucket into phase beats (Axes → Gridlines → Data → Legend) so one
//    "advance" reveals a coherent layer, matching how a presenter narrates.
// ---------------------------------------------------------------------------

import { buildPartTree, type XrayNode } from "../plot/tree";
import type { FluxPlotManifest } from "../plot/types";
import { slideById, addBeat, setAnimation, setPartVisibility, findElement } from "./ops";
import { hasTweenableSeries } from "../plot/project";
import type { Beat, Track, PresetName, Deck, Slide, TargetRef } from "./types";
import type { Element } from "../types";
import type { Id } from "../types";
import { newId } from "../ids";
import { presetDef } from "./presetCatalog";
import { isHandoff, resolveTargetLeaves, targetPartIds, isWholeElementRef } from "./targets";
import { resolveBeat } from "./resolve";

// manifest animation name → player preset name. fluxplot's closed vocabulary
// (presets.PRESET_NAMES, enumerated in its schema since 0.3.1) is the first
// block; the bare legacy spellings below it come from hand-written manifests.
const ANIM_TO_PRESET: Record<string, PresetName> = {
  "draw-on": "drawOn",
  "fade-in": "fade",
  "stagger-in": "stagger",
  "grow-from-baseline": "growBaseline",
  "fade-rise": "fadeRise",
  "write-on": "writeOn",
  "pop-in": "popIn",
  fade: "fade",
  grow: "growBaseline",
  "grow-baseline": "growBaseline",
  rise: "fadeRise",
};

// roles that must never draw-on / scale (they're text or fills) — always fade.
const TEXTISH = new Set(["tick-label", "axis-title", "title", "subtitle", "legend-label", "label", "annotation", "colorbar-label", "colorbar-tick-label"]);
// roles whose natural reveal is the self-draw (a stroked path).
const STROKABLE = new Set(["spine", "tick", "line", "reference-line", "significance-bracket", "errorbar"]);

// a leaf/child role → the high-level build.presets key it inherits from.
function highLevelKey(role: string): string {
  if (role === "spine" || role === "tick" || role === "tick-label" || role === "axis-title" || role === "title") return "axis";
  if (role.startsWith("colorbar-")) return "colorbar";
  return role;
}

// which beat (phase) a role reveals in. Grouping build.order into phases makes
// each "advance" expose a coherent layer the way a talk is narrated. A colour
// key is scaffold (it explains the data), so it builds with the axes.
const PHASE: Record<string, number> = {
  axis: 0, spine: 0, tick: 0, "tick-label": 0, "axis-title": 0, title: 0, subtitle: 0,
  colorbar: 0, "colorbar-solids": 0, "colorbar-outline": 0, "colorbar-label": 0, "colorbar-tick": 0, "colorbar-tick-label": 0,
  gridline: 1, "colorbar-gridline": 1,
  line: 2, area: 2, point: 2, bar: 2, "reference-line": 2, errorbar: 2,
  legend: 3, "legend-entry": 3, "legend-swatch": 3, "legend-label": 3, annotation: 3, overlay: 3, "significance-bracket": 3,
};
const PHASE_LABELS = ["Axes", "Gridlines", "Data", "Legend & annotations"];

/** The reveal preset for a role, honouring the plot's authored animation but
 *  refusing nonsense (draw-on a text label) and routing points to a stagger.
 *  Bars stagger only when the plot says so; otherwise they grow from their
 *  baseline, the generator's default for them. */
function presetForRole(role: string, anim?: string): PresetName {
  const mapped = anim ? ANIM_TO_PRESET[anim] : undefined;
  if (TEXTISH.has(role)) return mapped === "fadeRise" ? "fadeRise" : "fade"; // text may fade or rise, never draw/scale
  if (role === "point") return "stagger";
  if (role === "bar") return anim === "stagger-in" ? "stagger" : (mapped ?? "growBaseline");
  if (mapped) return mapped;
  if (STROKABLE.has(role)) return "drawOn";
  return "fade";
}

/** The player's stagger ordering key for a plot's `staggerBy` hint. The player
 *  reads data-x / data-y / array order today; the value/count/category keys
 *  (hexagons by value) fall back to x until the player learns them. */
function staggerAxis(by?: string): "index" | "x" | "y" {
  return by === "y" || by === "index" ? by : "x";
}

function singular(s: string): string {
  return s.endsWith("s") ? s.slice(0, -1) : s;
}

// a flat, phase-tagged plan entry before it becomes a Track.
interface PlanTrack {
  part: string;
  role: string;
  preset: PresetName;
  durationMs: number;
  delayMs?: number;
  staggerMs?: number;
  staggerBy?: string;
  nLeaves: number;
}

/** Walk a plot's build hints → a phase-grouped beat sequence (excludes the empty
 *  resting beat 0; the applier prepends that). Returns [] if the plot has no
 *  parts tree (pre-0.2.0) — the caller should fall back to a whole-element fade. */
export function autoAnimatePlot(manifest: FluxPlotManifest | undefined, elId: string): Beat[] {
  const xray = buildPartTree(manifest);
  if (!xray) return [];

  // index every node by id + by role, and every group MEMBER by its owning
  // group: fluxplot lists a bar series' components (counts.bar.0, .1, …) in
  // build.order while the tree groups them as counts.bars, so a member id
  // resolves to the group that reveals it (once).
  const byId = new Map<string, XrayNode>();
  const byRole = new Map<string, XrayNode[]>();
  const memberOwner = new Map<string, XrayNode>();
  const walk = (n: XrayNode) => {
    byId.set(n.id, n);
    const list = byRole.get(n.role);
    if (list) list.push(n); else byRole.set(n.role, [n]);
    if (n.isGroup && !n.children.length) for (const leaf of n.targets) if (!memberOwner.has(leaf)) memberOwner.set(leaf, n);
    n.children.forEach(walk);
  };
  walk(xray);

  const presets = manifest?.build?.presets ?? {};
  const order = manifest?.build?.order ?? [];

  // role-refs in build.order (entries that name no tree node, e.g. "gridlines")
  // claim that role for their own step, so containers don't double-animate it.
  const roleClaims = new Set<string>();
  for (const e of order) if (!byId.has(e)) roleClaims.add(singular(e));

  const animFor = (node: XrayNode): string | undefined =>
    presets[node.role]?.animation ?? presets[highLevelKey(node.role)]?.animation;

  const phases: PlanTrack[][] = [[], [], [], []];
  const seen = new Set<string>();
  const emit = (node: XrayNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const preset = presetForRole(node.role, animFor(node));
    const ph = PHASE[node.role] ?? PHASE[highLevelKey(node.role)] ?? 2;
    const cfg = presets[node.role] ?? presets[highLevelKey(node.role)];
    phases[ph].push({
      part: node.id,
      role: node.role,
      preset,
      durationMs: cfg?.durationMs ?? presetDef(preset).autoBuildDurationMs ?? 400,
      delayMs: cfg?.delayMs,
      staggerMs: cfg?.staggerMs,
      staggerBy: cfg?.staggerBy,
      nLeaves: node.targets.length,
    });
  };

  for (const entry of order) {
    const node = byId.get(entry) ?? memberOwner.get(entry);
    if (node && node.children.length) {
      // container ("axis.x"): per-child, skipping children handled by a role-ref step
      for (const c of node.children) if (!roleClaims.has(c.role)) emit(c);
    } else if (node) {
      emit(node); // a group ("setosa.points", "counts.bars") or leaf ("fit.line")
    } else {
      // a role-ref ("gridlines") → every node of that role
      for (const n of byRole.get(singular(entry)) ?? []) emit(n);
    }
  }

  const beats: Beat[] = [];
  phases.forEach((tracks, ph) => {
    if (!tracks.length) return;
    const ids = tracks.map(() => newId("track"));
    beats.push({ id: `auto-${ph}`, generatedBy: "auto-reveal", autoPhase: ph, label: PHASE_LABELS[ph], tracks: tracks.map((pt, i) => ({ ...planToTrack(pt, elId, ph, tracks, ids, i), generatedBy: "auto-reveal" as const })) });
  });
  return beats;
}

/** One plan entry → a Track. In the Data phase, points stagger left→right by x
 *  and the geometry (line/area) starts partway through that stagger so it
 *  resolves "just as the points finish" — the user's exact scatter beat. */
function planToTrack(pt: PlanTrack, elId: string, phase: number, peers: PlanTrack[], ids: string[], index: number): Track {
  const track: Track = { id: ids[index], target: elId, part: pt.part, preset: pt.preset, duration: pt.durationMs, start: pt.delayMs ?? 0 };
  if (pt.preset === "stagger") {
    track.stagger = { perMs: pt.staggerMs ?? 40, by: staggerAxis(pt.staggerBy), from: "start" };
    track.params = { child: "fade" }; // points FADE in (staggered) — cleaner than rise for a scatter
  }
  if (phase === 2 && pt.preset !== "stagger") {
    const pts = peers.find((p) => p.preset === "stagger");
    if (pts) track.anchor = { trackId: ids[peers.indexOf(pts)], edge: "start", offsetMs: (pt.delayMs ?? 0) + Math.round(0.5 * pts.nLeaves * (pts.staggerMs ?? 40)) };
  }
  return track;
}

/** Find a node by id anywhere in an xray tree. */
function findNode(root: XrayNode, id: string): XrayNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

/** A sensible single default Track for one part (used by the X-ray "Animate"
 *  toggle): the plot's authored preset for that role, role-corrected, with a
 *  spatial stagger for point/bar groups. Falls back to a plain fade. */
export function suggestTrack(manifest: FluxPlotManifest | undefined, elId: string, part: string): Track {
  const xray = buildPartTree(manifest);
  const node = xray ? findNode(xray, part) : null;
  const role = node?.role ?? "";
  const presets = manifest?.build?.presets ?? {};
  const anim = presets[role]?.animation ?? presets[highLevelKey(role)]?.animation;
  const preset = presetForRole(role, anim);
  const cfg = presets[role] ?? presets[highLevelKey(role)];
  const track: Track = { id: newId("track"), target: elId, part, preset, duration: cfg?.durationMs ?? presetDef(preset).autoBuildDurationMs ?? 400, start: cfg?.delayMs ?? 0 };
  if (preset === "stagger") {
    track.stagger = { perMs: cfg?.staggerMs ?? 40, by: staggerAxis(cfg?.staggerBy), from: "start" };
    track.params = { child: "fade" };
  }
  return track;
}

/** Make ONE part "animate in" (the X-ray "Animate" toggle): clear any mask and
 *  ensure a reveal track exists on a build beat — never beat 0 (the resting
 *  state). If the part ALREADY has tracks anywhere on the slide (e.g. it was
 *  masked — which merely disabled them), they are re-enabled with their authored
 *  timing intact and NO new track is added; only a track-less part gets the
 *  suggested default. `beatIndex` targets an existing build beat; otherwise the
 *  last build beat is used (creating beat 1 if the slide only has the resting
 *  beat). Returns the beat index the track landed on, or -1 if the slide is
 *  missing. */
export function animatePart(deck: Deck, slideId: Id, elId: Id, part: string, manifest: FluxPlotManifest | undefined, beatIndex?: number): number {
  const slide = slideById(deck, slideId);
  if (!slide) return -1;
  setPartVisibility(deck, elId, part, "animate"); // clear any mask, re-enable tracks
  const existingAt = slide.beats.findIndex((b) => b.tracks.some((t) => t.target === elId && t.part === part));
  if (existingAt > 0) return existingAt; // authored timing preserved — nothing to add
  let bi = beatIndex != null && beatIndex > 0 && beatIndex < slide.beats.length ? beatIndex : -1;
  if (bi < 0) {
    if (slide.beats.length <= 1) addBeat(deck, slideId, { label: "Beat 1", advance: "click" });
    bi = slide.beats.length - 1;
  }
  setAnimation(deck, slideId, slide.beats[bi].id, suggestTrack(manifest, elId, part));
  return bi;
}

// ---------------------------------------------------------------------------
// Non-plot elements — the same one-click "animate this" for text/shapes/media
// ---------------------------------------------------------------------------

// per-kind enter defaults: what each element kind naturally does when it
// appears. The union is the FIGURE element union (slides-are-figures): shapes
// render as inline SVG geometry, so line/path self-draw and rect/ellipse pop.
const ELEMENT_ENTER: Record<string, { preset: PresetName; duration: number }> = {
  text: { preset: "fadeRise", duration: 380 },
  image: { preset: "fade", duration: 350 },
  rect: { preset: "popIn", duration: 300 },
  ellipse: { preset: "popIn", duration: 300 },
  line: { preset: "drawOn", duration: 500 },
  path: { preset: "drawOn", duration: 600 },
  plot: { preset: "fade", duration: 400 },
};
// per-kind exit defaults — the mirror family.
const ELEMENT_EXIT: Record<string, { preset: PresetName; duration: number }> = {
  line: { preset: "drawOff", duration: 450 },
  path: { preset: "drawOff", duration: 500 },
  rect: { preset: "popOut", duration: 260 },
  ellipse: { preset: "popOut", duration: 260 },
};

/** A sensible default Track for a WHOLE element (the analog of `suggestTrack`
 *  for non-plot rows in the animator tree). `exit` flips to the disappear
 *  family. `part` narrows the track to a named plot part with deterministic
 *  defaults (enter fade / exit fadeOut). */
export function suggestElementTrack(
  el: Element,
  opts: { exit?: boolean; preset?: PresetName; part?: string } = {},
): Track {
  if (opts.part) {
    return {
      id: newId("track"),
      target: el.id,
      part: opts.part,
      preset: opts.exit ? "fadeOut" : "fade",
      duration: opts.exit ? 300 : 400,
      start: 0,
    };
  }
  const kind = el.type;
  const def = (opts.exit ? ELEMENT_EXIT[kind] : undefined) ?? (opts.exit ? { preset: "fadeOut" as PresetName, duration: 300 } : ELEMENT_ENTER[kind] ?? { preset: "fade" as PresetName, duration: 350 });
  return { id: newId("track"), target: el.id, preset: def.preset, duration: def.duration, start: 0 };
}

/** Give ONE element an enter (or exit) animation on a build beat — the non-plot
 *  analog of `animatePart`, and the GUI's "Animate in / Animate out" quick
 *  action. Adds to `beatIndex` when given (never 0), else the last build beat
 *  (creating beat 1 if only the resting beat exists). `part` narrows to a
 *  named plot part. Returns the beat index and the track id, or null if the
 *  element/slide is missing. */
export function animateElement(
  deck: Deck,
  slideId: Id,
  elId: Id,
  opts: { beatIndex?: number; exit?: boolean; preset?: PresetName; part?: string } = {},
): { beatIndex: number; trackId: Id } | null {
  const slide = slideById(deck, slideId);
  const found = findElement(deck, elId);
  if (!slide || !found) return null;
  let bi = opts.beatIndex != null && opts.beatIndex > 0 && opts.beatIndex < slide.beats.length ? opts.beatIndex : -1;
  if (bi < 0) {
    if (slide.beats.length <= 1) addBeat(deck, slideId, { label: "Beat 1", advance: "click" });
    bi = slide.beats.length - 1;
  }
  const track = suggestElementTrack(found.el, opts);
  if (opts.preset) track.preset = opts.preset;
  setAnimation(deck, slideId, slide.beats[bi].id, track);
  return { beatIndex: bi, trackId: track.id! };
}

/** Which project plots can the selected plot morph into? One shared gate for
 *  GUI menu + CLI/MCP so they never disagree with the player. */
export function listMorphCandidates(
  manifestA: FluxPlotManifest | undefined,
  candidates: { assetId: Id; manifest: FluxPlotManifest | undefined }[],
): { assetId: Id; compatible: boolean }[] {
  return candidates.map((c) => ({ assetId: c.assetId, compatible: hasTweenableSeries(manifestA, c.manifest) }));
}

/** The phase-order rank of a beat: the resting beat sorts first, auto phase beats
 *  by their phase index (auto-0 < auto-1 …), and any manual beat after the auto
 *  build. Used to slot a newly-produced phase beat into the right position. */
function phaseRank(b: Beat, index: number): number {
  if (index === 0) return -1; // beat 0 is always the resting state
  if (b.generatedBy === "auto-reveal") return b.autoPhase ?? 0;
  if (/^auto-\d+$/.test(b.id)) return Number(b.id.slice(5)) || 0;
  return Number.POSITIVE_INFINITY; // manual beats follow the auto build
}

/** Apply an auto-build for ONE plot element to a slide WITHOUT disturbing the
 *  animations of any other element. Re-running it for the same element replaces
 *  only that element's tracks (idempotent); running it for a second plot MERGES
 *  that plot's phase tracks into the shared phase beats (Axes / Gridlines / Data /
 *  Legend) so both plots build in coherent layers instead of one clobbering the
 *  other. Returns the number of build beats this element contributed (0 if the
 *  plot had no parts tree — the caller falls back to a whole-element fade). */
export function applyAutoAnimation(deck: Deck, slideId: Id, elId: Id, manifest: FluxPlotManifest | undefined): number {
  const slide = slideById(deck, slideId);
  if (!slide) return 0;
  const auto = autoAnimatePlot(manifest, elId);
  if (!auto.length) return 0;
  const birth = slide.beats.find(b => b.tracks.some(t => t.target === elId && t.ghostFrom));

  // 1. Drop ONLY this element's existing tracks (idempotent re-animate); every
  //    other element's tracks stay exactly where they are.
  for (const b of slide.beats) {
    // Legacy auto-* phase ownership is recognized once and stamped explicitly.
    const legacy = /^auto-(?:\d+|ghost-.+-\d+)$/.test(b.id);
    if (legacy) { b.generatedBy = "auto-reveal"; b.autoPhase ??= Number(b.id.match(/(\d+)$/)?.[1] ?? 0); b.autoTarget ??= b.id.match(/^auto-ghost-(.+)-\d+$/)?.[1]; }
    const ownedGroups = new Set(b.tracks.filter(t => t.target === elId && !t.ghostFrom && (t.generatedBy === "auto-reveal" || legacy && !["transform", "media"].includes(familyOf(t)))).map(t => t.groupId).filter(Boolean));
    b.tracks = b.tracks.filter(t => t.target !== elId || !!t.ghostFrom ||
      (t.generatedBy !== "auto-reveal" && !(legacy && !["transform", "media"].includes(familyOf(t)))));
    if (b.groups) { const used = new Set(b.tracks.map(t => t.groupId).filter(Boolean)); b.groups = b.groups.filter(g => used.has(g.id) || !ownedGroups.has(g.id)); }
  }

  // 2. Guarantee a resting beat 0.
  if (!slide.beats.length) slide.beats = [{ id: "base", label: "Start", tracks: [] }];

  // A ghost cannot reveal parts before it exists. Its own phase sequence
  // follows its birth; ordinary plots still share the global phase beats.
  if (birth) {
    const prefix = `auto-ghost-${elId}-`;
    slide.beats = slide.beats.filter(b => b.autoTarget !== elId || b.tracks.length > 0);
    let at = slide.beats.findIndex(b => b.id === birth.id) + 1;
    for (const ab of auto) {
      ab.id = `${prefix}${ab.id.slice(5)}`;
      ab.autoTarget = elId;
      const existing = slide.beats.find(b => b.generatedBy === "auto-reveal" && b.autoTarget === elId && b.autoPhase === ab.autoPhase);
      if (existing) existing.tracks.push(...ab.tracks);
      else slide.beats.splice(at++, 0, ab);
    }
  } else for (const ab of auto) {
    const existing = slide.beats.find((b) => b.generatedBy === "auto-reveal" && b.autoPhase === ab.autoPhase && !b.autoTarget);
    if (existing) {
      existing.tracks.push(...ab.tracks);
    } else {
      const r = phaseRank(ab, 1);
      let i = 1;
      while (i < slide.beats.length && phaseRank(slide.beats[i], i) <= r) i++;
      slide.beats.splice(i, 0, ab);
    }
  }

  // 4. Remove any auto-* phase beat left empty (a phase this element no longer
  //    produces and no other element fills) — never the resting or a manual beat.
  slide.beats = slide.beats.filter((b, i) => i === 0 || b.tracks.length > 0 || b.generatedBy !== "auto-reveal");
  return auto.length;
}

/** Shared eligibility for the inspector and the post-Become toast. */
export function canAutoAnimateRest(slide: Slide, ref: TargetRef, manifest: FluxPlotManifest | undefined): boolean {
  const plot = slide.elements.find(e => e.id === ref.element);
  return plot?.type === "plot" && !!manifest && !ref.group && !isWholeElementRef(ref)
    && !slide.beats.some(b => b.tracks.some(t => t.target === plot.id && familyOf(t) === "appearance"));
}

/** Build the plot's remaining leaves after its hand-off, preserving manual
 * tracks and other plots' shared build phases. A partially excluded group
 * becomes an explicit part set so none of its remaining leaves are lost.
 * Anchors are beat-local: an effect anchored across a generated reveal that is
 * excluded or moves behind the landing keeps its effective start, and a
 * rebuilt phase never reuses a beat id an authored effect still holds. */
export function autoAnimateExcept(deck: Deck, slideId: Id, plotId: Id, manifest: FluxPlotManifest | undefined, exceptLeaves: readonly string[]): number {
  const slide = slideById(deck, slideId);
  if (!slide) return 0;
  const manifestFor = (id: Id) => id === plotId ? manifest : undefined;
  const starts = new Map(slide.beats.flatMap(b => resolveBeat(b, deck, manifestFor).tracks.map(t => [t.id, t.start ?? 0] as const)));
  const moved = new Set(slide.beats.flatMap(b => b.tracks.filter(t => t.target === plotId && t.generatedBy === "auto-reveal").map(t => t.id)));
  if (!applyAutoAnimation(deck, slideId, plotId, manifest)) return 0;
  const except = new Set(exceptLeaves);
  const generated: Beat[] = [];
  for (const beat of slide.beats) {
    const resolved = resolveBeat(beat, deck, manifestFor).tracks;
    const kept: Track[] = [];
    for (const track of beat.tracks) {
      if (track.target !== plotId || track.generatedBy !== "auto-reveal") continue;
      moved.add(track.id);
      if (!starts.has(track.id)) starts.set(track.id, resolved.find(t => t.id === track.id)?.start ?? 0);
      const leaves = targetPartIds(track, manifest), rest = leaves.filter(id => !except.has(id));
      if (!rest.length) continue;
      if (rest.length !== leaves.length) { delete track.part; delete track.selector; track.parts = rest; }
      kept.push(track);
    }
    const keptIds = new Set(kept.map(t => t.id));
    for (const track of kept) if (track.anchor && !keptIds.has(track.anchor.trackId)) {
      track.start = resolved.find(t => t.id === track.id)?.start ?? 0;
      delete track.anchor;
    }
    beat.tracks = beat.tracks.filter(t => t.target !== plotId || t.generatedBy !== "auto-reveal" || keptIds.has(t.id));
    if (kept.length) generated.push({ ...beat, id: `auto-rest-${plotId}-${beat.autoPhase}`, autoTarget: plotId, tracks: kept, groups: undefined });
  }
  const landing = slide.beats.findLast(b => b.tracks.some(t => !t.disabled && isHandoff(t) &&
    resolveTargetLeaves(t.to.become.ref, slide, manifestFor).some(r => r.elementId === plotId)));
  if (landing) {
    // Global auto phases precede manual steps. Move only this plot's generated
    // tracks behind its landing, leaving every other phase participant in place.
    for (const beat of slide.beats) beat.tracks = beat.tracks.filter(t => t.target !== plotId || t.generatedBy !== "auto-reveal");
  }
  slide.beats = slide.beats.filter((b, i) => i === 0 || b.tracks.length || b.generatedBy !== "auto-reveal");
  if (landing) {
    const ids = new Set(slide.beats.map(b => b.id));
    for (const phase of generated) {
      const base = phase.id;
      for (let n = 2; ids.has(phase.id); n++) phase.id = `${base}-${n}`;
      ids.add(phase.id);
    }
    slide.beats.splice(slide.beats.indexOf(landing) + 1, 0, ...generated);
  }
  for (const beat of slide.beats) {
    const ids = new Set(beat.tracks.map(t => t.id));
    for (const track of beat.tracks) if (track.anchor && !ids.has(track.anchor.trackId) && (moved.has(track.id) || moved.has(track.anchor.trackId))) {
      track.start = starts.get(track.id) ?? track.start ?? 0;
      delete track.anchor;
    }
  }
  return generated.length;
}
