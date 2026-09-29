/** DOM-free cue compilation and inspected state. Compilation is revision-scoped;
 * playback binds its targets once and samples only the active cue's properties. */
import type { Element } from "../types";
import type { FluxPlotManifest } from "../plot/types";
import type { Slide, StageSize, Track, Camera, TargetRef, BecomeSpec } from "./types";
import { lerpElement, overshootBox, arcBox, transformEndState, transformPreState } from "./tween";
import { resolveCurve, type ResolvedCurve } from "./curves";
import { countUpText } from "./player/countup";
import { seriesAxes, seriesTweenable, plotViewIssues } from "../plot/project";
import { staggerRanks, staggerSpan, staggerDelay, staggerSeed } from "./stagger";
import { resolveGhosts, copyFrameSource, ghostBirths, type GhostBirth, type ResolvedGhosts } from "./ghost";
import { familyOf } from "./family";
import { presetDef, isEnterPreset, isExitPreset, KNOWN_PRESETS } from "./presetCatalog";
import { isHandoff, targetPartIds, hasPartBinding, trackKey, trackRef, sameRef, type ResolvedTarget } from "./targets";
import { handoffTargetResolver, handoffTargetsOverlap } from "./handoffTargets";
import { targetOutlines, type GeometryCtx } from "./targetGeometry";
import { resolveBeat, type StyleContext } from "./resolve";
import { trackDuration } from "./timing";
import { sampleCamera } from "./camera";
import { modelPair, modelPairIssue, modelVideoHandoff, type ModelAssetLookup } from "./model3dMorph";
export { trackDuration } from "./timing";
export { ghostTargetIds } from "./ghost";

export interface AnimationIssue { trackId?: string; target: string; reason: string }
export interface CompileOptions extends StyleContext, ModelAssetLookup {
  plotManifest?: (assetId: string) => FluxPlotManifest | undefined;
  /** Pristine prepared roots, when available, for outline diagnostics. */
  plotRoot?: GeometryCtx["plotRoot"];
}
export interface CompiledTrack { track: Track; beat: number; start: number; duration: number; end: number; parts: string[]; ranks: number[]; maxRank: number; ease: ResolvedCurve }
export interface PartFrame { opacity: number; visible: boolean; transform?: string }
export interface SlideFrame {
  elements: Element[];
  camera?: Camera;
  partStates: Record<string, Record<string, PartFrame>>;
  issues: AnimationIssue[];
  presentation: {
    elementStates: Record<string, PartFrame>;
    hiddenElementIds: string[];
    unbornElementIds?: string[];
    partStates: Record<string, Record<string, PartFrame>>;
    camera?: Camera;
  };
}
export interface CompiledSlide {
  resolvedSlide: Slide;
  births: GhostBirth[];
  partFactors: ResolvedGhosts["partFactors"];
  cues: { id: string; duration: number; tracks: CompiledTrack[] }[];
  issues: AnimationIssue[];
  handoffs: { trackId: string; beat: number; source: ResolvedTarget[]; destination: ResolvedTarget[]; spec: BecomeSpec }[];
  /** Manifest-aware canonical resolution, shared with Become authoring. */
  resolveTarget(ref: TargetRef, beat: number): ResolvedTarget[];
  sample(beat: number, timeMs?: number): SlideFrame;
  preState(target: string, beat: number): Element | null;
  copySourceState(source: string, birthBeat: number): Element | null;
}
/** The plot leaf ids a track's binding names (`part` ∪ `parts` ∪ `selector`,
 *  minus `selector.except`) under the target's manifest at its beat — ONE
 *  resolver shared with the player (`targets.targetPartIds`). [] for a
 *  whole-element track. */
export function semanticTargets(track: Track, slide: Slide, opts: CompileOptions, beatIndex = slide.beats.findIndex((b) => b.tracks.some((t) => t === track || !!track.id && t.id === track.id))): string[] {
  if (!hasPartBinding(track)) return [];
  const el = transformPreState(slide, track.target, Math.max(0, beatIndex));
  const manifest = el?.type === "plot" ? opts.plotManifest?.(el.assetId) : undefined;
  return targetPartIds(track, manifest);
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function compileOrdinarySlide(slide: Slide, stage: StageSize, opts: CompileOptions, partFactors: ResolvedGhosts["partFactors"] = {}): Pick<CompiledSlide, "cues" | "issues" | "sample" | "handoffs" | "resolveTarget"> {
  const issues: AnimationIssue[] = [];
  const resolveTarget = handoffTargetResolver(slide, opts.plotManifest ?? (() => undefined));
  for (const el of slide.elements) if (el.type === "plot") {
    for (const reason of plotViewIssues(opts.plotManifest?.(el.assetId), el.view)) issues.push({ target: el.id, reason });
  }
  const cues = slide.beats.map((beat, bi) => {
    const tracks: CompiledTrack[] = [];
    for (const track of beat.tracks) {
      if (track.disabled) continue;
      let reason = "";
      if (track.keyframes) reason = "Custom keyframes are unsupported. Choose an effect or Change instead.";
      else if (!KNOWN_PRESETS.has(track.preset ?? "fade")) reason = `Unknown effect: ${track.preset}`;
      else if (!track.target.startsWith("@") && !slide.elements.some((e) => e.id === track.target)) reason = "Target object is missing. Retarget or remove this effect.";
      else if (familyOf(track) === "media" && bi === 0) reason = "Add video commands to a playback step after Design.";
      else if (familyOf(track) === "media" && slide.elements.find(e => e.id === track.target)?.type !== "video") reason = "Video commands require a video clip target.";
      else if (familyOf(track) === "media" && (track.part || track.selector || track.stagger)) reason = "Video commands apply to the whole clip.";
      if (reason) { issues.push({ trackId: track.id, target: track.target, reason }); continue; }
      if (track.preset === "transform" && track.to?.assetId && opts.plotManifest) {
        const pre = transformPreState(slide, track.target, bi);
        if (pre?.type === "plot") {
          const a = opts.plotManifest(pre.assetId), b = opts.plotManifest(track.to.assetId);
          // Plan §3.7: shared semantic parts bind and tween; a series without a
          // (tweenable) counterpart fades on its own — never a whole-plot crossfade.
          if (a && b) for (const id of new Set([...(a.series ?? []).map(s => s.id), ...(b.series ?? []).map(s => s.id)])) {
            const sa = a.series?.find(s => s.id === id), sb = b.series?.find(s => s.id === id);
            if (!sa || !sb) issues.push({ trackId: track.id, target: track.target, reason: `Series ‹${id}› has no counterpart and fades.` });
            else if (!seriesTweenable(sa, sb, seriesAxes(a, sa), seriesAxes(b, sb)))
              issues.push({ trackId: track.id, target: track.target, reason: `Series ‹${id}› has no tweenable counterpart and fades.` });
          }
        }
      }
      if (track.preset === "transform") {
        const pre = transformPreState(slide, track.target, bi);
        const end = pre ? transformEndState(pre, track) : undefined;
        if (!isHandoff(track) && track.to?.assetId) {
          const pair = modelPair(pre ?? undefined, end, opts), reason = pair && modelPairIssue(pair);
          if (reason) issues.push({ trackId: track.id, target: track.target, reason });
        }
        if (end?.type === "plot") for (const reason of plotViewIssues(opts.plotManifest?.(end.assetId), end.view))
          issues.push({ trackId: track.id, target: track.target, reason });
      }
      const parts = semanticTargets(track, slide, opts, bi);
      if (hasPartBinding(track) && !parts.length) issues.push({ trackId: track.id, target: track.target, reason: "No matching plot parts. Retarget this effect." });
      const start = Math.max(0, track.start ?? 0), duration = trackDuration(track);
      const el = transformPreState(slide, track.target, bi), manifest = el?.type === "plot" ? opts.plotManifest?.(el.assetId) : undefined;
      const by = track.stagger?.by;
      const coordinates = by === "x" || by === "y" ? new Map((manifest?.series ?? []).flatMap((s) => (s.points ?? []).map((p) => [p.svgId, p[by]] as const))) : undefined;
      const ranks = staggerRanks(Math.max(1, parts.length), track.stagger?.from, coordinates ? parts.map((id) => coordinates.get(id) ?? null) : undefined, staggerSeed(track), track.stagger?.totalMs !== undefined);
      tracks.push({ track, beat: bi, start, duration, end: start + duration + staggerSpan(track, parts.length), parts, ranks, maxRank: Math.max(0, ...ranks), ease: resolveCurve(track, familyOf(track)) });
    }
    // Same target/property concurrent effects are visible diagnostics, never a
    // silent replacement. Different channels (e.g. Change + Fade) compose.
    for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i], b = tracks[j];
      const family = familyOf;
      if (trackKey(a.track) === trackKey(b.track) && family(a.track) === family(b.track) && a.start < b.end && b.start < a.end) {
        issues.push({ trackId: b.track.id, target: b.track.target, reason: "Effects overlap on the same target. Later effects take precedence; move their timing to play sequentially." });
      }
    }
    return { id: beat.id, duration: Math.max(0, ...tracks.map((t) => t.end)), tracks: tracks.sort((a, b) => a.start - b.start) };
  });
  const handoffs: CompiledSlide["handoffs"] = [];
  const flights = new Map<CompiledTrack, { source: string[]; destination: string[] }>();
  const keysOf = (targets: ResolvedTarget[]) => targets.flatMap(t => t.partIds === null ? [t.elementId] : t.partIds.map(p => `${t.elementId}\0${p}`));
  const births = ghostBirths(slide);
  for (const cue of cues) for (const ct of cue.tracks) {
    if (ct.track.preset !== "transform" || !isHandoff(ct.track)) continue;
    const spec = ct.track.to.become;
    const source = resolveTarget(trackRef(ct.track), ct.beat), destination = resolveTarget(spec.ref, ct.beat);
    const posterVideo = source.length === 1 && destination.length === 1 && source[0].partIds === null && destination[0].partIds === null
      && modelVideoHandoff(transformPreState(slide, source[0].elementId, ct.beat) ?? undefined, transformPreState(slide, destination[0].elementId, ct.beat) ?? undefined);
    const unborn = births.filter(b => !b.enabled || b.beat > ct.beat || b.beat === ct.beat && b.start > ct.start);
    let reason = !slide.elements.some(e => e.id === spec.ref.element) ? "Destination parts not found. Retarget this Become."
      : unborn.some(b => b.target === spec.ref.element || destination.some(t => t.elementId === b.target)) ? "The destination is not yet born at this step. Choose a later step."
      : !destination.length ? "Destination parts not found. Retarget this Become."
      : !source.length ? "Source parts not found. Retarget this Become."
      : sameRef(trackRef(ct.track), spec.ref) ? "Choose a different object for the source to become."
      : unborn.some(b => source.some(t => t.elementId === b.target)) ? "The source is not yet born at this step. Choose a later step."
      : !posterVideo && slide.elements.some(e => e.type === "video" && [...source, ...destination].some(t => t.elementId === e.id)) ? "Video clips cannot take part in a Become. Use Change for their geometry."
      : "";
    if (!reason && handoffs.some(h => h.beat === ct.beat && handoffTargetsOverlap(destination, h.destination)))
      reason = "Another hand-off in this step already lands on these destination parts. Choose different parts or another step.";
    if (reason) { issues.push({ trackId: ct.track.id, target: ct.track.target, reason }); continue; }
    handoffs.push({ trackId: ct.track.id ?? "", beat: ct.beat, source, destination, spec });
    flights.set(ct, { source: keysOf(source), destination: keysOf(destination) });
  }
  function sample(beatIndex: number, timeMs = Infinity): SlideFrame {
    const elements = structuredClone(slide.elements);
    const byId = new Map(elements.map((e) => [e.id, e]));
    const appearance = new Map<string, PartFrame>();
    const handoffVisibility = new Map<string, boolean>(), inFlight = new Set<string>();
    const spatial = new Map<string, Map<string, number[]>>();
    const partStates: SlideFrame["partStates"] = {};
    let camera = slide.camera ? { ...slide.camera } : undefined;
    const targetsFor = (ct: CompiledTrack) => hasPartBinding(ct.track) ? ct.parts.map((p) => `${ct.track.target}\0${p}`) : [ct.track.target];
    // Future first entrances hide; an exit before an entrance still starts
    // visible. This baseline is independent of prior seeks/playback history.
    const first = new Set<string>(), entrances = new Set<string>(), firstCount = new Set<string>();
    for (const cue of cues) for (const ct of cue.tracks) {
      const flight = flights.get(ct);
      if (flight) {
        // A prior entrance owns the initial baseline. Sources are pseudo-exits,
        // so a reverse hand-off later in the slide never hides the first source.
        for (const key of flight.source) if (!entrances.has(key)) {
          first.add(key); entrances.add(key); appearance.set(key, { opacity: 1, visible: true });
        }
        for (const key of flight.destination) if (!entrances.has(key)) {
          first.add(key); entrances.add(key); appearance.set(key, { opacity: 0, visible: false });
        }
        continue;
      }
      if (ct.track.preset === "countUp") {
        const el = byId.get(ct.track.target);
        if (el?.type === "text" && !firstCount.has(el.id)) { firstCount.add(el.id); el.text = countUpText(el.text, ct.track)(0); }
        continue;
      }
      if (familyOf(ct.track) === "media") continue;
      if (ct.track.preset === "transform" || ct.track.preset === "camera") continue;
      for (const key of targetsFor(ct)) {
        if (isEnterPreset(ct.track.preset)) entrances.add(key);
        if (!first.has(key)) { first.add(key); appearance.set(key, { opacity: isEnterPreset(ct.track.preset) ? 0 : 1, visible: !isEnterPreset(ct.track.preset) }); }
      }
    }
    for (const flight of flights.values()) for (const key of [...flight.source, ...flight.destination])
      handoffVisibility.set(key, appearance.get(key)?.visible ?? true);
    for (let bi = 0; bi <= Math.min(beatIndex, cues.length - 1); bi++) for (const ct of cues[bi].tracks) {
      const track = ct.track, preset = track.preset ?? "fade";
      if (familyOf(track) === "media") continue;
      const local = bi < beatIndex ? Infinity : timeMs;
      if (local < ct.start) continue;
      const raw = ct.duration > 0 ? clamp((local - ct.start) / ct.duration) : 1;
      const t = ct.ease.clamped(raw);
      const el = byId.get(track.target);
      if (preset === "transform" && isHandoff(track)) {
        const flight = flights.get(ct);
        if (flight) {
          if (raw > 0) for (const key of flight.source) {
            appearance.set(key, { opacity: 0, visible: false }); handoffVisibility.set(key, false);
            if (raw < 1) inFlight.add(key);
          }
          for (const key of flight.destination) {
            appearance.set(key, { opacity: raw >= 1 ? 1 : 0, visible: raw >= 1 }); handoffVisibility.set(key, raw >= 1);
            if (raw > 0 && raw < 1) inFlight.add(key);
          }
        }
        continue; // a hand-off changes presentation, never the source's props
      }
      if (preset === "transform" && el) {
        if (hasPartBinding(track)) continue;
        const pre = transformPreState(slide, track.target, bi) ?? el;
        const end = transformEndState(pre, track);
        const u = ct.ease.fn(raw);
        const sampled = arcBox(overshootBox(lerpElement(pre, end, t, raw), pre, end, u), pre, end, u, track.arc);
        for (const key of Object.keys(el)) if (!(key in sampled)) delete (el as unknown as Record<string, unknown>)[key];
        Object.assign(el, sampled);
        continue;
      }
      if (preset === "countUp" && el?.type === "text") {
        const pre = transformPreState(slide, track.target, bi);
        el.text = countUpText(pre?.type === "text" ? pre.text : el.text, track)(t, raw);
        continue;
      }
      if (preset === "camera") {
        const from = camera ?? { x: stage.width / 2, y: stage.height / 2, zoom: 1 };
        const to = { x: track.to?.x ?? from.x, y: track.to?.y ?? from.y, zoom: track.to?.zoom ?? from.zoom };
        // The camera is a physical channel: it takes the unclamped curve. Zoom
        // is geometric (log space), so an overshooting spring keeps it positive.
        camera = sampleCamera(from, to, ct.ease.fn(raw), stage, track.to?.path, from);
        continue;
      }
      for (const [i, key] of targetsFor(ct).entries()) {
        const at = ct.duration > 0 ? ct.ease.clamped(clamp((local - ct.start - staggerDelay(track, ct.ranks[i] ?? 0, ct.maxRank)) / ct.duration)) : 1;
        const previous = appearance.get(key) ?? { opacity: 1, visible: true };
        const opacity = isEnterPreset(preset) ? at : isExitPreset(preset) ? 1 - at : preset === "dim" ? 1 - .7 * at : preset === "highlight" ? .4 + .6 * at : previous.opacity;
        appearance.set(key, { opacity, visible: opacity > 0 });
        if (handoffVisibility.has(key) && (isEnterPreset(preset) || isExitPreset(preset))) handoffVisibility.set(key, opacity > 0);
      }
      // Legacy spatial effects remain inspectable at their endpoint.
      if (el && !ct.parts.length) {
        const u = ct.ease.fn(raw);
        const effects = spatial.get(el.id) ?? new Map<string, number[]>(); spatial.set(el.id, effects);
        if (preset === "move") effects.set("move", [Number(track.to?.x ?? 0) * u, Number(track.to?.y ?? 0) * u]);
        if (preset === "rotate") effects.set("rotate", [Number(track.to?.rotation ?? track.to?.deg ?? track.params?.deg ?? 15) * u]);
        if (preset === "scale") effects.set("scale", [1 + (Number(track.to?.scale ?? track.params?.scale ?? 1.15) - 1) * u]);
      }
    }
    // Appearance offsets are a child of authored/changed geometry at runtime.
    // Fold them after Changes, in CSS function order, so an unrelated Change
    // cannot erase a move and repeated legacy effects replace their channel.
    for (const [id, effects] of spatial) {
      const el = byId.get(id)!; let dx = 0, dy = 0, scale = 1, rotation = 0;
      for (const [kind, value] of [...effects].reverse()) {
        if (kind === "move") { dx += value[0]; dy += value[1]; }
        else if (kind === "scale") { dx *= value[0]; dy *= value[0]; scale *= value[0]; }
        else if (kind === "rotate") { const a = value[0] * Math.PI / 180, x = dx; dx = x * Math.cos(a) - dy * Math.sin(a); dy = x * Math.sin(a) + dy * Math.cos(a); rotation += value[0]; }
      }
      const angle = el.rotation * Math.PI / 180, x = dx * (el.flipX ? -1 : 1), y = dy * (el.flipY ? -1 : 1);
      el.x += x * Math.cos(angle) - y * Math.sin(angle) - el.width * (scale - 1) / 2;
      el.y += x * Math.sin(angle) + y * Math.cos(angle) - el.height * (scale - 1) / 2;
      el.width *= scale; el.height *= scale; el.rotation += rotation;
    }
    const elementStates: Record<string, PartFrame> = {};
    for (const [key, state] of appearance) {
      // Emphasis changes opacity, but only entrances may reveal a hidden side.
      if (handoffVisibility.get(key) === false || inFlight.has(key)) { state.opacity = 0; state.visible = false; }
      const [id, part] = key.split("\0");
      if (part) (partStates[id] ??= {})[part] = state;
      else elementStates[id] = state;
    }
    for (const [id, parts] of Object.entries(partFactors)) for (const [part, factor] of Object.entries(parts)) {
      const own = partStates[id]?.[part];
      const opacity = (own?.opacity ?? 1) * factor.opacity;
      (partStates[id] ??= {})[part] = { opacity, visible: opacity > 0 };
    }
    return { elements, camera, partStates, issues, presentation: { elementStates, hiddenElementIds: Object.entries(elementStates).filter(([, state]) => !state.visible).map(([id]) => id), partStates, camera } };
  }
  const preFrames = new Map<string, SlideFrame>();
  const ctx: GeometryCtx = { manifest: opts.plotManifest ?? (() => undefined), plotRoot: opts.plotRoot ?? (() => undefined), groups: slide.groups };
  for (const [ct, flight] of flights) {
    const ref = ct.track.to!.become!.ref;
    // Missing plot roots are unavailable geometry, not proof of a raster pair.
    if ([...flight.source, ...flight.destination].some(key => {
      const el = transformPreState(slide, key.split("\0")[0], ct.beat);
      return el?.type === "plot" && !ctx.plotRoot(el.assetId);
    })) continue;
    const key = `${ct.beat}:${ct.start}`;
    let frame = preFrames.get(key);
    if (!frame) { frame = sample(ct.beat, ct.start); preFrames.set(key, frame); }
    const pair = flight.source.length === 1 && flight.destination.length === 1
      ? modelPair(frame.elements.find(e => e.id === flight.source[0]), frame.elements.find(e => e.id === flight.destination[0]), opts) : undefined;
    if (pair) {
      const reason = modelPairIssue(pair);
      if (reason) issues.push({ trackId: ct.track.id, target: ct.track.target, reason });
      continue;
    }
    const a = targetOutlines(trackRef(ct.track), frame, ctx), b = targetOutlines(ref, frame, ctx);
    if (a.length && b.length && a.every(o => o.paint.text || o.paint.raster) && b.every(o => o.paint.text || o.paint.raster))
      issues.push({ trackId: ct.track.id, target: ct.track.target, reason: "Neither side of this Become has an outline; it crossfades" });
  }
  return { cues, issues, sample, handoffs, resolveTarget };
}
export function compileSlide(slide: Slide, stage: StageSize = { width: 640, height: 360 }, opts: CompileOptions = {}): CompiledSlide {
  // Resolve styles and anchors before the ghost and transform folds, which
  // then see inherited timing. Families and pre-states read `preset`/`to`,
  // which never come from a style (slide/resolve.ts header), so the manifest
  // lookup reads the authored slide. Authored tracks stay untouched.
  const timingIssues: AnimationIssue[] = [];
  const timed = { ...slide, beats: slide.beats.map((beat, bi) => {
    const resolved = resolveBeat(beat, opts, target => {
      const el = transformPreState(slide, target, bi);
      return el?.type === "plot" ? opts.plotManifest?.(el.assetId) : undefined;
    });
    timingIssues.push(...resolved.issues);
    return { ...beat, tracks: resolved.tracks };
  }) };
  const resolved = resolveGhosts(timed, (working, beat, factors) => compileOrdinarySlide(working, stage, opts, factors).sample(beat));
  const plain = compileOrdinarySlide(resolved.slide, stage, opts, resolved.partFactors);
  const issues = [...timingIssues, ...resolved.issues, ...plain.issues];
  const sample = (beat: number, time = Infinity): SlideFrame => {
    const frame = plain.sample(beat, time);
    frame.issues = issues;
    frame.presentation.unbornElementIds = resolved.births.filter(b => !b.enabled || beat < b.beat || beat === b.beat && time < b.start).map(b => b.target);
    return frame;
  };
  return { ...plain, issues, sample, resolvedSlide: resolved.slide, births: resolved.births, partFactors: resolved.partFactors,
    preState: (target, beat) => transformPreState(resolved.slide, target, beat),
    copySourceState: (source, beat) => copyFrameSource(resolved.slide, sample(beat - 1), source, beat),
  };
}
export function evaluateSlideState(slide: Slide, beat: number, timeMs = Infinity, opts: CompileOptions & { stage?: StageSize } = {}): SlideFrame {
  return compileSlide(slide, opts.stage, opts).sample(beat, timeMs);
}
