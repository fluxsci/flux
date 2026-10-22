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

import { buildPartTree, kindForRole, type PartKind, type XrayNode } from "../plot/tree";
import type { FluxPlotManifest } from "../plot/types";
import { slideById, addBeat, setAnimation, setPartVisibility, findElement } from "./ops";
import { hasTweenableSeries } from "../plot/project";
import type { Beat, Track, PresetName, Deck, Slide, TargetRef, Stagger } from "./types";
import { planStagger, staggerFields, lagTotal, lagStarts } from "./stagger";
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

// What a part MAY do comes from its kind (the manifest's, else tree.KIND_BY_ROLE — plan F2):
// text never draws on or scales, a stroked line's natural reveal is the self-draw. Gridlines
// and whole axes fade (a self-drawing grid is noise).
const NO_DRAW_LINES = new Set(["gridline", "axis", "colorbar-gridline"]);

// a leaf/child role → the high-level build.presets key it inherits from.
function highLevelKey(role: string): string {
  if (role === "spine" || role === "tick" || role === "tick-label" || role === "axis-title" || role === "title") return "axis";
  if (role.startsWith("colorbar-")) return "colorbar";
  return role;
}

// which beat (phase) a role reveals in. Grouping build.order into phases makes
// each "advance" expose a coherent layer the way a talk is narrated. A colour
// key is scaffold (it explains the data), so it builds with the axes.
const ROLE_PHASE: Record<string, number> = {
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
function presetForRole(role: string, anim?: string, kind: PartKind = kindForRole(role)): PresetName {
  const mapped = anim ? ANIM_TO_PRESET[anim] : undefined;
  if (kind === "text") return mapped === "fadeRise" ? "fadeRise" : "fade"; // text may fade or rise, never draw/scale
  if (role === "point") return "stagger";
  if (role === "bar") return anim === "stagger-in" ? "stagger" : (mapped ?? "growBaseline");
  if (mapped) return mapped;
  if (kind === "line" && !NO_DRAW_LINES.has(role)) return "drawOn";
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
  axis?: "x" | "y";
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
/** How a plot's build hints become beats: the four shared phases (Axes → Gridlines → Data →
 *  Legend), or `perPanel` — the same four phases panel by panel, in the manifest's panel order
 *  with an inset right after its host; figure-scope titles lead, figure legends and
 *  annotations close (colour-system plan F7). */
export interface AutoBuildOptions {
  perPanel?: boolean;
  /** The PACE table (`CLASSIC_PACE` | `V2_PACE`). Selects numbers only; the STRUCTURE (scaffold order, folded gridlines,
   *  capped lag totals, chains) is the same for every pace. Absent = `DEFAULT_PACE`. Playback never reads a pace: it is
   *  what AUTHORING writes into the tracks (X1). */
  pace?: AutoPace;
  /** Pen length per plot part id, in STAGE units (`partPenLengths`, one pure measure for GUI and CLI). Absent = no
   *  length scaling (the manifest/pace duration is used). */
  lengths?: Record<string, number>;
}

export function autoAnimatePlot(manifest: FluxPlotManifest | undefined, elId: string, options: AutoBuildOptions = {}): Beat[] {
  const xray = buildPartTree(manifest);
  if (!xray) return [];
  const panels = (manifest as { panels?: { id: string; label?: string; insetOf?: string }[] } | undefined)?.panels ?? [];
  if (options.perPanel && panels.length > 1) return autoAnimatePanels(manifest!, elId, panels, xray, options);

  const phases = planPhases(manifest!, xray, manifest?.build?.order ?? [], null);
  const beats: Beat[] = [];
  const plan = choreograph(phases, options.pace ?? DEFAULT_PACE, options.lengths ?? {});
  plan.phases.forEach((tracks, ph) => {
    if (!tracks.length) return;
    const ids = tracks.map(() => newId("track"));
    beats.push({ id: `auto-${ph}`, generatedBy: "auto-reveal", autoPhase: ph, label: plan.label(ph, tracks), tracks: plan.build(ph, tracks, ids, elId).map(t => ({ ...t, generatedBy: "auto-reveal" as const })) });
  });
  return beats;
}

/** The phase-grouped plan for the build.order entries given; `prefix` restricts a role-ref
 *  ("gridlines") to one panel's nodes. */
function planPhases(manifest: FluxPlotManifest, xray: XrayNode, order: readonly string[], prefix: string | null): PlanTrack[][] {
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
    const preset = presetForRole(node.role, animFor(node), node.kind);
    // an unknown role narrates by its kind: text joins the annotations, marks join the data
    const ph = ROLE_PHASE[node.role] ?? ROLE_PHASE[highLevelKey(node.role)] ?? (node.kind === "text" ? 3 : 2);
    const cfg = presets[node.role] ?? presets[highLevelKey(node.role)];
    const axis = /(^|\.)axis\.([xy])(\.|$)/.exec(node.id)?.[2] as "x" | "y" | undefined;
    phases[ph].push({
      part: node.id,
      axis,
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
      // a role-ref ("gridlines") → every node of that role (in this panel, when building per panel)
      for (const n of byRole.get(singular(entry)) ?? []) if (!prefix || n.id.startsWith(prefix)) emit(n);
    }
  }
  return phases;
}

/** The per-panel build: a beat sequence per panel (its four phases), panels in manifest order
 *  with each inset right after its host, figure-scope parts (unprefixed ids: the suptitle, the
 *  figure legend, fig.text) as a leading Axes beat and a closing Legend beat. Beat ids are
 *  `auto-<group>-<phase>`, `autoPhase` counts through the groups so merging and ranking keep
 *  working. */
function autoAnimatePanels(manifest: FluxPlotManifest, elId: string, panels: { id: string; label?: string; insetOf?: string }[], xray: XrayNode, options: AutoBuildOptions = {}): Beat[] {
  const ordered: typeof panels = [];
  for (const p of panels) {
    if (p.insetOf) continue;
    ordered.push(p, ...panels.filter((q) => q.insetOf === p.id));
  }
  for (const p of panels) if (!ordered.includes(p)) ordered.push(p); // an inset whose host is unknown
  const order = manifest.build?.order ?? [];
  const groups: { label: string; entries: string[]; prefix: string | null }[] = [];
  const figureEntries = order.filter((e) => !panels.some((p) => e.startsWith(p.id + ".")));
  const figureLead = figureEntries.filter((e) => /^figure\.(title|xlabel|ylabel|background)$/.test(e));
  const figureLegends = ((manifest as { figure?: { legends?: string[] } }).figure?.legends ?? []).filter((id) => !order.includes(id));
  const figureTail = [...figureEntries.filter((e) => !figureLead.includes(e) && e !== "gridlines"), ...figureLegends];
  if (figureLead.length) groups.push({ label: "Figure", entries: figureLead, prefix: null });
  for (const p of ordered) groups.push({ label: p.label ?? p.id, entries: order.filter((e) => e.startsWith(p.id + ".") || e === "gridlines"), prefix: p.id + "." });
  if (figureTail.length) groups.push({ label: "Figure", entries: figureTail, prefix: null });
  const beats: Beat[] = [];
  groups.forEach((g, gi) => {
    const plan = choreograph(planPhases(manifest, xray, g.entries, g.prefix), options.pace ?? DEFAULT_PACE, options.lengths ?? {});
    plan.phases.forEach((tracks, ph) => {
      if (!tracks.length) return;
      const ids = tracks.map(() => newId("track"));
      beats.push({ id: `auto-${gi}-${ph}`, generatedBy: "auto-reveal", autoPhase: gi * 4 + ph, label: `${g.label} · ${plan.label(ph, tracks)}`,
        tracks: plan.build(ph, tracks, ids, elId).map(t => ({ ...t, generatedBy: "auto-reveal" as const })) });
    });
  });
  return beats;
}

// ---------------------------------------------------------------------------
// CHOREOGRAPHY (T2). Pure: the manifest-derived plan in, Tracks out. ONE structure for every pace; the `AutoPace` table
// only supplies the numbers. Every stagger is written with EXISTING Total-mode fields (`duration` = each target's window,
// `stagger.totalMs` = first-to-last start), produced by `planStagger`, so no schema field, player branch or compile branch
// exists for it and old apps open the deck.
//   scaffold first   spines draw from the origin corner, ticks lag along their axis, tick labels follow their ticks, frame
//                    spines and titles land as the pen finishes; gridlines fold into the SAME click, anchored to their
//                    own axis's ticks (no dead start, no extra click)
//   data             marks lag with a CAPPED total; the line starts while the points are still arriving; secondary
//                    marks follow their primary at half its window; composite series chain (box -> whiskers -> ...)
//   legend           its own click; the frame no longer leaks into Data; entries lag
// ---------------------------------------------------------------------------

/** A staggered scaffold group. `windowMs` unset: `planStagger(totalMs, lag, maxRank)` (totalMs = whole footprint, first
 *  start to last end). `windowMs` set: that fixed window, and `totalMs` is the first-to-last start spread (Total mode). */
export interface ScaffoldStagger { startMs: number; totalMs: number; lag: number; windowMs?: number }

/** The Axes click, as named numbers (X5 for V2_PACE; T2's unit-400 table for CLASSIC_PACE). */
export interface AutoScaffold {
  /** primary spines (`axis.x.spine`, `axis.y.spine`, drawn concurrently from the origin corner): a fixed draw (V2, exempt
   *  from the drawOn floor and `drawDuration`) or null = `drawDuration(len, window)` */
  spineMs: number | null;
  /** frame spines (`….top` / `….right`): a `fade` of `ms` (V2), or a `drawOn` of the primary spine's window (classic) */
  frameSpine: { preset: "fade" | "drawOn"; ms: number | null; startMs: number };
  ticks: ScaffoldStagger;
  tickLabels: ScaffoldStagger;
  /** axis titles, title, subtitle: `startMs` fixed, or null = `max(spineRefMs, longest spine end) - leadMs` */
  titles: { ms: number; startMs: number | null; spineRefMs: number; leadMs: number };
  /** parts the scaffold has no row for (whole-axis group, colour key): never a pop at t = 0 */
  otherStartMs: number;
  /** gridlines (fade): `planStagger(totalMs, lag, …)`, anchored to the SAME axis's ticks (edge start) at `anchorOffsetMs` */
  grid: { totalMs: number; lag: number; anchorOffsetMs: number };
}

/** X5: the V2 Axes click is one 700 ms gesture (measured 690 ms, R4_T8 §3.4). */
export const SCAFFOLD_MS = 700;
export const SCAFFOLD_SPINE_MS = 520;
export const SCAFFOLD_TICK_WINDOW_MS = 140;
export const SCAFFOLD_TICK_SPREAD_MS = 450;
export const SCAFFOLD_LABEL_START_MS = 40;
export const SCAFFOLD_LABEL_WINDOW_MS = 200;
export const SCAFFOLD_FRAME_SPINE_MS = 200;
export const SCAFFOLD_FRAME_SPINE_START_MS = 420;
export const SCAFFOLD_TITLE_MS = 250;
export const SCAFFOLD_TITLE_START_MS = 370;
export const SCAFFOLD_GRID_TOTAL_MS = 380;
export const SCAFFOLD_GRID_ANCHOR_MS = 225;

export interface AutoPace {
  id: "classic" | "v2";
  /** reference length of the Axes click (ms): 400 classic (T2's table is fractions of it), `SCAFFOLD_MS` for V2 */
  unit: number;
  /** minimum window per preset. Classic has none; V2 READS the catalog (`presetDef(p).autoBuildDurationMs`), never a copy. */
  floor: (preset: PresetName) => number;
  scaffold: AutoScaffold;
  /** points: lag ratio (null = the plot's authored staggerMs / window, today's pacing) and the cap on the group */
  pointLag: number | null;
  /** classic: cap on the SPREAD (first-to-last start); v2: cap on the whole group (first start to last end) */
  pointCap: number;
  /** bars of one series enter one after another (child growBaseline) at this ratio; null = together, unless the plot authors `stagger-in` */
  barLag: number | null;
  barCap: number;
  /** length-scaled pen draws (data lines, fit lines, annotations); null = the authored/floored duration */
  draw: { pxPerSec: number; minMs: number; maxMs: number } | null;
  /** the line starts this share of the points' group footprint after they start (classic keeps today's half of the spread) */
  lineOverlap: number;
  /** data-series line draws carry an explicit easing (V2: the pen moves at constant speed); undefined = the preset default */
  lineEasing?: "linear";
}

/** The catalog's authored window for a preset (0 when the preset has none). One helper, no copied table. */
const catalogFloor = (preset: PresetName): number => presetDef(preset).autoBuildDurationMs ?? 0;

export const CLASSIC_PACE: AutoPace = {
  id: "classic", unit: 400, floor: () => 0,
  scaffold: {
    spineMs: null,
    frameSpine: { preset: "drawOn", ms: null, startMs: 80 },
    ticks: { startMs: 60, totalMs: 320, lag: 0.2 },
    tickLabels: { startMs: 80, totalMs: 400, lag: 0.2 },
    titles: { ms: 280, startMs: null, spineRefMs: 400, leadMs: 120 },
    otherStartMs: 80,
    grid: { totalMs: 340, lag: 0.3, anchorOffsetMs: 160 },
  },
  pointLag: null, pointCap: 1200, barLag: null, barCap: 1500, draw: null, lineOverlap: 0.5,
};
export const V2_PACE: AutoPace = {
  id: "v2", unit: SCAFFOLD_MS, floor: catalogFloor,
  scaffold: {
    spineMs: SCAFFOLD_SPINE_MS,
    frameSpine: { preset: "fade", ms: SCAFFOLD_FRAME_SPINE_MS, startMs: SCAFFOLD_FRAME_SPINE_START_MS },
    ticks: { startMs: 0, totalMs: SCAFFOLD_TICK_SPREAD_MS, lag: 0.2, windowMs: SCAFFOLD_TICK_WINDOW_MS },
    tickLabels: { startMs: SCAFFOLD_LABEL_START_MS, totalMs: SCAFFOLD_TICK_SPREAD_MS, lag: 0.2, windowMs: SCAFFOLD_LABEL_WINDOW_MS },
    titles: { ms: SCAFFOLD_TITLE_MS, startMs: SCAFFOLD_TITLE_START_MS, spineRefMs: 0, leadMs: 0 },
    otherStartMs: SCAFFOLD_LABEL_START_MS,
    grid: { totalMs: SCAFFOLD_GRID_TOTAL_MS, lag: 0.3, anchorOffsetMs: SCAFFOLD_GRID_ANCHOR_MS },
  },
  pointLag: 0.1, pointCap: 2000, barLag: 0.25, barCap: 1500, draw: { pxPerSec: 600, minMs: 600, maxMs: 1600 }, lineOverlap: 0.55,
  lineEasing: "linear",
};
/** Named lookup for hosts that take a pace by name (the `animate-plot` verb, `--pace classic|v2`). */
export const AUTO_PACES: Readonly<Record<AutoPace["id"], AutoPace>> = { classic: CLASSIC_PACE, v2: V2_PACE };
/** What an entry point uses when no `pace` is passed. Release 1 ships CLASSIC; the pace lane's integration flips it to V2. */
export const DEFAULT_PACE: AutoPace = CLASSIC_PACE;

/** Whether a build at `pace` reads pen lengths at all (so a host can skip measuring a plot that nothing will use). */
export const paceUsesLengths = (pace: AutoPace = DEFAULT_PACE): boolean => pace.draw !== null;

/** Draw duration from the pen length (stage px): `len / v` clamped, on a 50 ms grid; no measure -> `fallback`. */
export function drawDuration(len: number | undefined, fallback: number, pace: AutoPace): number {
  if (!pace.draw || !(len && len > 0)) return fallback;
  return Math.round(Math.max(pace.draw.minMs, Math.min(pace.draw.maxMs, len / pace.draw.pxPerSec * 1000)) / 50) * 50;
}

/** The fields of ONE staggered group of `n` targets whose own authored window is `window`. */
function groupStagger(pace: AutoPace, n: number, window: number, perMsHint: number, by: "index" | "x" | "y"): { duration: number; stagger: Stagger; footprint: number } {
  if (pace.pointLag === null) {
    // classic pacing, capped: the plot's own Each step while the spread fits (byte-identical to today's tracks), else the
    // step that makes the spread exactly the cap (same window, same mode: Each, so the Animator row stays the author's number)
    const step = n > 1 ? Math.min(perMsHint, Math.floor(pace.pointCap / (n - 1) * 100) / 100) : perMsHint;
    return { duration: window, stagger: { perMs: step, by, from: "start" }, footprint: window + step * Math.max(0, n - 1) };
  }
  const f = staggerFields(planStagger(lagTotal(n, window, pace.pointLag, pace.pointCap), pace.pointLag, Math.max(0, n - 1)), { by, from: "start" });
  return { ...f, footprint: f.duration + (f.stagger.totalMs ?? 0) };
}

const COMPOSITE = ["box", "whisker", "cap", "median", "mean", "flier"];
const isSecondary = (role: string) => /^(errorbar|whisker|cap|median|mean|flier|segment)(-\d+)?$/.test(role);
const win = (pt: PlanTrack, pace: AutoPace) => Math.max(pt.durationMs, pace.floor(pt.preset));
/** A frame spine is the top/right one; the primary spines (bottom/left, or the pre-0.3.2 bare `axis.<x|y>.spine`) are the axes. */
const isFrameSpine = (pt: PlanTrack) => pt.role === "spine" && /\.(top|right)$/.test(pt.part);
/** A y axis draws bottom to top (origin corner first) and `staggerRanks` orders `by: "y"` by ascending SCREEN y, so the
 *  y-axis groups lag from the END to follow the pen; x lags from the start. */
const scaffoldFrom = (axis: "x" | "y" | undefined): "start" | "end" => (axis === "y" ? "end" : "start");

function choreograph(phases: PlanTrack[][], pace: AutoPace, lengths: Record<string, number>) {
  // gridlines fold into the Axes click; the legend frame/background belongs with the legend, not the Data phase it landed in
  const moved: PlanTrack[][] = [[], [], [], []];
  phases.forEach((list, ph) => list.forEach(pt => {
    const legendish = /(^|\.)legend(\.|$)/.test(pt.part);
    moved[ph === 1 ? 0 : legendish && ph === 2 ? 3 : ph].push(pt);
  }));
  const sc = pace.scaffold;
  const build = (ph: number, tracks: PlanTrack[], ids: string[], elId: string): Track[] => {
    const out: Track[] = [];
    const idOf = (pt: PlanTrack) => ids[tracks.indexOf(pt)];
    const mk = (pt: PlanTrack, extra: Partial<Track>): Track => ({ id: idOf(pt), target: elId, part: pt.part, preset: pt.preset, duration: win(pt, pace), start: pt.delayMs ?? 0, ...extra });
    /** a scaffold stagger group along its own axis */
    const scaffoldGroup = (pt: PlanTrack, spec: ScaffoldStagger): Track => {
      const shared = { by: pt.axis === "y" ? "y" as const : "x" as const, from: scaffoldFrom(pt.axis) };
      const f = spec.windowMs !== undefined
        ? { duration: spec.windowMs, stagger: { ...shared, totalMs: pt.nLeaves > 1 ? spec.totalMs : 0 } as Stagger }
        : staggerFields(planStagger(spec.totalMs, spec.lag, Math.max(0, pt.nLeaves - 1)), shared);
      return mk(pt, { start: spec.startMs, ...f });
    };
    if (ph === 0) {
      const spineDur = (pt: PlanTrack) => sc.spineMs ?? drawDuration(lengths[pt.part], win(pt, pace), pace);
      const spineEnd = Math.max(sc.titles.spineRefMs, ...tracks.filter(t => t.role === "spine").map(t => isFrameSpine(t) ? sc.frameSpine.startMs + (sc.frameSpine.ms ?? spineDur(t)) : spineDur(t)));
      const tickTrackOf = new Map<"x" | "y", Track>();
      for (const pt of tracks) {
        if (pt.role === "gridline" || pt.role === "colorbar-gridline") continue;
        if (pt.role === "spine") {
          if (!isFrameSpine(pt)) out.push(mk(pt, { duration: spineDur(pt), start: 0 }));
          else out.push(mk(pt, { preset: sc.frameSpine.preset, duration: sc.frameSpine.ms ?? spineDur(pt), start: sc.frameSpine.startMs }));
        }
        else if (pt.role === "tick") { const tr = scaffoldGroup(pt, sc.ticks); out.push(tr); if (pt.axis) tickTrackOf.set(pt.axis, tr); }
        else if (pt.role === "tick-label") out.push(scaffoldGroup(pt, sc.tickLabels));
        else if (pt.role === "axis-title" || pt.role === "title" || pt.role === "subtitle") out.push(mk(pt, { duration: sc.titles.ms, start: sc.titles.startMs ?? Math.max(0, spineEnd - sc.titles.leadMs) }));
        else out.push(mk(pt, { start: sc.otherStartMs })); // whole-axis group, colour key: scaffold, never a pop at t = 0
      }
      for (const pt of tracks) {
        if (pt.role !== "gridline" && pt.role !== "colorbar-gridline") continue;
        const ticks = pt.axis ? tickTrackOf.get(pt.axis) : undefined;
        // anchored to the ticks: retiming the spine/tick tracks carries the grid with them (beat-local, same click)
        const g = scaffoldGroup(pt, { startMs: 0, totalMs: sc.grid.totalMs, lag: sc.grid.lag });
        out.push(ticks ? { ...g, start: 0, anchor: { trackId: ticks.id!, edge: "start", offsetMs: sc.grid.anchorOffsetMs } } : { ...g, start: sc.ticks.startMs + sc.grid.anchorOffsetMs });
      }
      return out;
    }
    if (ph === 2) {
      const pointTracks = tracks.filter(t => t.preset === "stagger" && t.role !== "bar"); // points, hexagons, any authored stagger group
      const pointsPt = pointTracks[0]; // the line, area and annotations anchor to the FIRST series' group
      const pointFit = new Map(pointTracks.map(pt => [pt, groupStagger(pace, pt.nLeaves, win(pt, pace), pt.staggerMs ?? 40, staggerAxis(pt.staggerBy))] as const));
      const pointsFit = pointsPt ? pointFit.get(pointsPt) : undefined;
      const barsPt = tracks.find(t => t.role === "bar" && (t.preset === "growBaseline" || t.preset === "stagger"));
      const barsWin = barsPt ? win({ ...barsPt, preset: "growBaseline" }, pace) : 0;
      const barsFit = !barsPt || barsPt.nLeaves < 2 ? undefined
        : barsPt.preset === "stagger" ? groupStagger(pace, barsPt.nLeaves, barsWin, barsPt.staggerMs ?? 40, staggerAxis(barsPt.staggerBy)) // the plot authors a bar stagger
        : pace.barLag !== null ? staggerFields(planStagger(lagTotal(barsPt.nLeaves, barsWin, pace.barLag, pace.barCap), pace.barLag, barsPt.nLeaves - 1), { by: "x", from: "start" })
        : undefined;
      const lineLead = pointsPt && pointsFit
        ? Math.round(pace.pointLag === null ? pace.lineOverlap * Math.min(pointsPt.nLeaves * (pointsPt.staggerMs ?? 40), pace.pointCap) : pace.lineOverlap * pointsFit.footprint)
        : 0;
      const lineish = tracks.filter(t => t.preset === "drawOn" && !isSecondary(t.role));
      let lineIdx = 0;
      // composite series (box plots): <series>.box -> whiskers -> caps -> medians -> means -> fliers, each component entering as
      // the previous is half done; the next series follows the same law (manim AnimationGroup(lag_ratio .5), natural durations)
      const comp = new Map<PlanTrack, { series: string; rank: number }>();
      for (const pt of tracks) {
        const m = /^(.*)\.(box|whiskers?|caps?|medians?|means?|fliers?)$/.exec(pt.part);
        if (m) comp.set(pt, { series: m[1], rank: COMPOSITE.indexOf(m[2].replace(/s$/, "")) });
      }
      if (comp.size > 1 && !pointsPt) {
        const bySeries = new Map<string, PlanTrack[]>();
        for (const pt of tracks) if (comp.has(pt)) { const k = comp.get(pt)!.series; bySeries.set(k, [...(bySeries.get(k) ?? []), pt]); }
        let prevHead: Track | undefined;
        for (const list of bySeries.values()) {
          list.sort((a, b) => comp.get(a)!.rank - comp.get(b)!.rank);
          let prev: Track | undefined;
          for (const pt of list) {
            const tr = mk(pt, { duration: Math.max(win(pt, pace), pace.id === "v2" ? 450 : 0) });
            const lead = prev ?? prevHead;
            if (lead) { tr.anchor = { trackId: lead.id!, edge: "start", offsetMs: Math.round(0.5 * (lead.duration ?? 0)) }; tr.start = 0; }
            if (!prev) prevHead = tr;
            out.push(tr); prev = tr;
          }
        }
        for (const pt of tracks) if (!comp.has(pt)) out.push(mk(pt, {}));
        return out;
      }
      for (const pt of tracks) {
        const fit = pointFit.get(pt);
        if (fit) {
          out.push(mk(pt, { duration: fit.duration, stagger: fit.stagger, params: { child: "fade" } })); // child -> "scaleIn" once WP 2.2 lands it
        } else if (pt === barsPt) {
          out.push(barsFit ? mk(pt, { preset: "stagger", duration: barsFit.duration, stagger: barsFit.stagger, params: { child: "growBaseline" } }) : mk(pt, { preset: "growBaseline", duration: barsWin }));
        } else if (isSecondary(pt.role) && (barsPt || pointsPt)) {
          // secondary marks (error bars, whiskers, caps...) enter as their primary is half done and share its pacing
          const tr = mk(pt, { start: 0, anchor: { trackId: idOf((barsPt ?? pointsPt)!), edge: "start", offsetMs: Math.round(0.5 * (barsPt ? barsWin : win(pointsPt!, pace))) } });
          if (pt.nLeaves > 1 && barsFit) Object.assign(tr, { duration: barsFit.duration, stagger: barsFit.stagger });
          out.push(tr);
        } else if (pt.preset === "drawOn") {
          const track = mk(pt, { duration: drawDuration(lengths[pt.part], win(pt, pace), pace) });
          if (pace.lineEasing && pt.role === "line") track.easing = pace.lineEasing; // data-series pen: constant speed
          if (pointsPt) { track.anchor = { trackId: idOf(pointsPt), edge: "start", offsetMs: (pt.delayMs ?? 0) + lineLead }; track.start = 0; }
          else if (lineish.length > 1 && lineIdx > 0) { const prev = out.find(o => o.part === lineish[lineIdx - 1].part); if (prev) { track.anchor = { trackId: prev.id!, edge: "start", offsetMs: Math.round(0.5 * (prev.duration ?? 0)) }; track.start = 0; } }
          lineIdx += lineish.includes(pt) ? 1 : 0;
          out.push(track);
        } else if (pointsPt && (pt.preset === "fade" || pt.preset === "fadeRise")) {
          out.push(mk(pt, { anchor: { trackId: idOf(pointsPt), edge: "start", offsetMs: (pt.delayMs ?? 0) + lineLead }, start: 0 }));
        } else out.push(mk(pt, {}));
      }
      return out;
    }
    // phase 3 — legend & annotations: the frame first, then the entries lag
    const entries = tracks.filter(t => /legend-entry/.test(t.role));
    const frameWin = Math.max(0, ...tracks.filter(t => /(^|\.)legend\.(background|frame)$/.test(t.part)).map(t => win(t, pace)));
    const entryTotal = lagTotal(entries.length, Math.max(300, ...entries.map(t => win(t, pace))), 0.3, 700);
    const slots = lagStarts(entries.length, entryTotal, 0.3);
    let k = 0;
    for (const pt of tracks) {
      if (/legend-entry/.test(pt.role)) { const i = k++; out.push(mk(pt, { duration: slots.childMs, start: (pt.delayMs ?? 0) + Math.round(0.4 * frameWin) + slots.startsMs[i] })); }
      else out.push(mk(pt, {}));
    }
    return out;
  };
  const label = (ph: number, tracks: PlanTrack[]) => ph === 0 && tracks.some(t => t.role === "gridline" || t.role === "colorbar-gridline") ? "Axes & grid" : PHASE_LABELS[ph];
  return { phases: moved, build, label };
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
export function suggestTrack(manifest: FluxPlotManifest | undefined, elId: string, part: string, options: Pick<AutoBuildOptions, "pace" | "lengths"> = {}): Track {
  const xray = buildPartTree(manifest);
  const node = xray ? findNode(xray, part) : null;
  const role = node?.role ?? "";
  const presets = manifest?.build?.presets ?? {};
  const anim = presets[role]?.animation ?? presets[highLevelKey(role)]?.animation;
  const preset = presetForRole(role, anim);
  const cfg = presets[role] ?? presets[highLevelKey(role)];
  const pace = options.pace ?? DEFAULT_PACE;
  const window = Math.max(cfg?.durationMs ?? presetDef(preset).autoBuildDurationMs ?? 400, pace.floor(preset));
  // a primary spine's draw is the scaffold's fixed constant (V2), exempt from the floor and the length scaling
  const penMs = role === "spine" && pace.scaffold.spineMs !== null ? pace.scaffold.spineMs : drawDuration(options.lengths?.[part], window, pace);
  const track: Track = { id: newId("track"), target: elId, part, preset, duration: preset === "drawOn" ? penMs : window, start: cfg?.delayMs ?? 0 };
  if (preset === "drawOn" && role === "line" && pace.lineEasing) track.easing = pace.lineEasing;
  if (preset === "stagger") {
    const fit = groupStagger(pace, node?.targets.length ?? 1, window, cfg?.staggerMs ?? 40, staggerAxis(cfg?.staggerBy));
    track.duration = fit.duration; track.stagger = fit.stagger;
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
export function animatePart(deck: Deck, slideId: Id, elId: Id, part: string, manifest: FluxPlotManifest | undefined, beatIndex?: number, options: Pick<AutoBuildOptions, "pace" | "lengths"> = {}): number {
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
  setAnimation(deck, slideId, slide.beats[bi].id, suggestTrack(manifest, elId, part, options));
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
export function applyAutoAnimation(deck: Deck, slideId: Id, elId: Id, manifest: FluxPlotManifest | undefined, options: AutoBuildOptions = {}): number {
  const slide = slideById(deck, slideId);
  if (!slide) return 0;
  const auto = autoAnimatePlot(manifest, elId, options);
  if (!auto.length) return 0;
  const birth = slide.beats.find(b => b.tracks.some(t => t.target === elId && t.ghostFrom));

  // 1. Drop ONLY this element's existing tracks (idempotent re-animate); every
  //    other element's tracks stay exactly where they are.
  for (const b of slide.beats) {
    // Legacy auto-* phase ownership is recognized once and stamped explicitly.
    const legacy = /^auto-(?:\d+|\d+-\d+|ghost-.+-\d+)$/.test(b.id);
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
  // A set may span several objects; the remainder build is one plot's (D2).
  return plot?.type === "plot" && !!manifest && !ref.group && !ref.members && !isWholeElementRef(ref)
    && !slide.beats.some(b => b.tracks.some(t => t.target === plot.id && familyOf(t) === "appearance"));
}

/** Build the plot's remaining leaves after its hand-off, preserving manual
 * tracks and other plots' shared build phases. A partially excluded group
 * becomes an explicit part set so none of its remaining leaves are lost.
 * Anchors are beat-local: an effect anchored across a generated reveal that is
 * excluded or moves behind the landing keeps its effective start, and a
 * rebuilt phase never reuses a beat id an authored effect still holds. */
export function autoAnimateExcept(deck: Deck, slideId: Id, plotId: Id, manifest: FluxPlotManifest | undefined, exceptLeaves: readonly string[], options: AutoBuildOptions = {}): number {
  const slide = slideById(deck, slideId);
  if (!slide) return 0;
  const manifestFor = (id: Id) => id === plotId ? manifest : undefined;
  const starts = new Map(slide.beats.flatMap(b => resolveBeat(b, deck, manifestFor).tracks.map(t => [t.id, t.start ?? 0] as const)));
  const moved = new Set(slide.beats.flatMap(b => b.tracks.filter(t => t.target === plotId && t.generatedBy === "auto-reveal").map(t => t.id)));
  if (!applyAutoAnimation(deck, slideId, plotId, manifest, options)) return 0;
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
