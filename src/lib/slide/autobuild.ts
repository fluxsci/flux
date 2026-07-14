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
import { morphCompatible } from "./player/morph";
import type { Beat, Track, PresetName, Deck } from "./types";
import type { Element } from "../types";
import type { Id } from "../types";
import { newId } from "../ids";

// manifest animation name → player preset name
const ANIM_TO_PRESET: Record<string, PresetName> = {
  "draw-on": "drawOn",
  "fade-in": "fade",
  fade: "fade",
  "stagger-in": "stagger",
  grow: "growBaseline",
  "grow-baseline": "growBaseline",
  "write-on": "writeOn",
  "pop-in": "popIn",
  rise: "fadeRise",
};

// roles that must never draw-on / scale (they're text or fills) — always fade.
const TEXTISH = new Set(["tick-label", "axis-title", "title", "subtitle", "legend-label", "label", "annotation"]);
// roles whose natural reveal is the self-draw (a stroked path).
const STROKABLE = new Set(["spine", "tick", "line", "reference-line", "significance-bracket", "errorbar"]);

// a leaf/child role → the high-level build.presets key it inherits from.
function highLevelKey(role: string): string {
  if (role === "spine" || role === "tick" || role === "tick-label" || role === "axis-title" || role === "title") return "axis";
  return role;
}

// which beat (phase) a role reveals in. Grouping build.order into phases makes
// each "advance" expose a coherent layer the way a talk is narrated.
const PHASE: Record<string, number> = {
  axis: 0, spine: 0, tick: 0, "tick-label": 0, "axis-title": 0, title: 0, subtitle: 0,
  gridline: 1,
  line: 2, area: 2, point: 2, bar: 2, "reference-line": 2, errorbar: 2,
  legend: 3, "legend-entry": 3, "legend-swatch": 3, "legend-label": 3, annotation: 3, overlay: 3,
};
const PHASE_LABELS = ["Axes", "Gridlines", "Data", "Legend & annotations"];

const DEFAULT_DUR: Partial<Record<PresetName, number>> = {
  fade: 300, drawOn: 600, stagger: 240, growBaseline: 500, writeOn: 500, popIn: 300, fadeRise: 320,
};

/** The reveal preset for a role, honouring the plot's authored animation but
 *  refusing nonsense (draw-on a text label) and routing points to a stagger. */
function presetForRole(role: string, anim?: string): PresetName {
  if (TEXTISH.has(role)) return "fade";
  if (role === "point" || role === "bar") return "stagger";
  const mapped = anim ? ANIM_TO_PRESET[anim] : undefined;
  if (mapped) return mapped;
  if (STROKABLE.has(role)) return "drawOn";
  return "fade";
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
  staggerMs?: number;
  nLeaves: number;
}

/** Walk a plot's build hints → a phase-grouped beat sequence (excludes the empty
 *  resting beat 0; the applier prepends that). Returns [] if the plot has no
 *  parts tree (pre-0.2.0) — the caller should fall back to a whole-element fade. */
export function autoAnimatePlot(manifest: FluxPlotManifest | undefined, elId: string): Beat[] {
  const xray = buildPartTree(manifest);
  if (!xray) return [];

  // index every node by id + by role
  const byId = new Map<string, XrayNode>();
  const byRole = new Map<string, XrayNode[]>();
  const walk = (n: XrayNode) => {
    byId.set(n.id, n);
    const list = byRole.get(n.role);
    if (list) list.push(n); else byRole.set(n.role, [n]);
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
      durationMs: cfg?.durationMs ?? DEFAULT_DUR[preset] ?? 400,
      staggerMs: cfg?.staggerMs,
      nLeaves: node.targets.length,
    });
  };

  for (const entry of order) {
    const node = byId.get(entry);
    if (node && node.children.length) {
      // container ("axis.x"): per-child, skipping children handled by a role-ref step
      for (const c of node.children) if (!roleClaims.has(c.role)) emit(c);
    } else if (node) {
      emit(node); // a group ("setosa.points") or leaf ("fit.line")
    } else {
      // a role-ref ("gridlines") → every node of that role
      for (const n of byRole.get(singular(entry)) ?? []) emit(n);
    }
  }

  const beats: Beat[] = [];
  phases.forEach((tracks, ph) => {
    if (!tracks.length) return;
    beats.push({ id: `auto-${ph}`, label: PHASE_LABELS[ph], tracks: tracks.map((pt) => planToTrack(pt, elId, ph, tracks)) });
  });
  return beats;
}

/** One plan entry → a Track. In the Data phase, points stagger left→right by x
 *  and the geometry (line/area) starts partway through that stagger so it
 *  resolves "just as the points finish" — the user's exact scatter beat. */
function planToTrack(pt: PlanTrack, elId: string, phase: number, peers: PlanTrack[]): Track {
  const track: Track = { id: newId("track"), target: elId, part: pt.part, preset: pt.preset, duration: pt.durationMs, start: 0 };
  if (pt.preset === "stagger") {
    track.stagger = { perMs: pt.staggerMs ?? 40, by: "x", from: "start" };
    track.params = { child: "fade" }; // points FADE in (staggered) — cleaner than rise for a scatter
  }
  if (phase === 2 && pt.preset !== "stagger") {
    const pts = peers.find((p) => p.preset === "stagger");
    if (pts) track.start = Math.round(0.5 * pts.nLeaves * (pts.staggerMs ?? 40));
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
  const track: Track = { id: newId("track"), target: elId, part, preset, duration: cfg?.durationMs ?? DEFAULT_DUR[preset] ?? 400, start: 0 };
  if (preset === "stagger") {
    track.stagger = { perMs: cfg?.staggerMs ?? 40, by: "x", from: "start" };
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
  return candidates.map((c) => ({ assetId: c.assetId, compatible: morphCompatible(manifestA, c.manifest) }));
}

/** The phase-order rank of a beat: the resting beat sorts first, auto phase beats
 *  by their phase index (auto-0 < auto-1 …), and any manual beat after the auto
 *  build. Used to slot a newly-produced phase beat into the right position. */
function phaseRank(b: Beat, index: number): number {
  if (index === 0) return -1; // beat 0 is always the resting state
  if (b.id.startsWith("auto-")) return Number(b.id.slice(5)) || 0;
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

  // 1. Drop ONLY this element's existing tracks (idempotent re-animate); every
  //    other element's tracks stay exactly where they are.
  for (const b of slide.beats) b.tracks = b.tracks.filter((t) => t.target !== elId);

  // 2. Guarantee a resting beat 0.
  if (!slide.beats.length) slide.beats = [{ id: "base", label: "Start", tracks: [] }];

  // 3. Merge each phase beat by id: append this element's tracks to an existing
  //    phase beat, or insert the missing phase beat in phase order.
  for (const ab of auto) {
    const existing = slide.beats.find((b) => b.id === ab.id);
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
  slide.beats = slide.beats.filter((b, i) => i === 0 || b.tracks.length > 0 || !b.id.startsWith("auto-"));
  return auto.length;
}
