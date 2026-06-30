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
import { slideById } from "./ops";
import type { Beat, Track, PresetName, Deck } from "./types";
import type { Id } from "../types";

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
const TEXTISH = new Set(["tick-label", "axis-title", "title", "legend-label", "label", "annotation"]);
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
  axis: 0, spine: 0, tick: 0, "tick-label": 0, "axis-title": 0, title: 0,
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
  const track: Track = { target: elId, part: pt.part, preset: pt.preset, duration: pt.durationMs, start: 0 };
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

/** Apply an auto-build to a slide: replace its beats with [resting, …phase beats].
 *  Returns the number of build beats added (0 if the plot had no parts tree). */
export function applyAutoAnimation(deck: Deck, slideId: Id, elId: Id, manifest: FluxPlotManifest | undefined): number {
  const slide = slideById(deck, slideId);
  if (!slide) return 0;
  const auto = autoAnimatePlot(manifest, elId);
  if (!auto.length) return 0;
  const base: Beat = slide.beats[0]?.tracks.length === 0 ? slide.beats[0] : { id: "base", label: "Start", tracks: [] };
  slide.beats = [base, ...auto];
  return auto.length;
}
