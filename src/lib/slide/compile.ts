/** DOM-free cue compilation and inspected state. Compilation is revision-scoped;
 * playback binds its targets once and samples only the active cue's properties. */
import type { Element } from "../types";
import type { FluxPlotManifest } from "../plot/types";
import { resolveTargets } from "../plot/tree";
import { buildPartIndex } from "../plot/parse";
import type { Slide, StageSize, Track, Camera } from "./types";
import { applyState, lerpElement, transformPreState } from "./tween";
import { resolveEasingFn } from "./easing";
import { countUpText } from "./player/countup";
import { morphCompatible } from "./player/morph";
import { staggerRanks, staggerSpan } from "./stagger";

export interface AnimationIssue { trackId?: string; target: string; reason: string }
export interface CompileOptions { plotManifest?: (assetId: string) => FluxPlotManifest | undefined }
export interface CompiledTrack { track: Track; beat: number; start: number; duration: number; end: number; parts: string[]; ranks: number[]; ease: (t: number) => number }
export interface PartFrame { opacity: number; visible: boolean; transform?: string }
export interface SlideFrame {
  elements: Element[];
  camera?: Camera;
  partStates: Record<string, Record<string, PartFrame>>;
  issues: AnimationIssue[];
  presentation: {
    elementStates: Record<string, PartFrame>;
    hiddenElementIds: string[];
    partStates: Record<string, Record<string, PartFrame>>;
    camera?: Camera;
  };
}
export interface CompiledSlide {
  cues: { id: string; duration: number; tracks: CompiledTrack[] }[];
  issues: AnimationIssue[];
  sample(beat: number, timeMs?: number): SlideFrame;
}
const enters = new Set(["fade", "fadeRise", "popIn", "drawOn", "growBaseline", "stagger", "writeOn"]);
const exits = new Set(["fadeOut", "popOut", "drawOff", "wipeOut"]);
const known = new Set([...enters, ...exits, "highlight", "dim", "move", "scale", "rotate", "camera", "countUp", "morph", "transform"]);
export function trackDuration(track: Track): number {
  return Math.max(0, track.duration ?? (track.preset === "transform" ? 600 : track.preset === "morph" ? 1200 : track.preset === "countUp" ? 800 : 320));
}
export function semanticTargets(track: Track, slide: Slide, opts: CompileOptions, beatIndex = slide.beats.findIndex((b) => b.tracks.some((t) => t === track || !!track.id && t.id === track.id))): string[] {
  const el = transformPreState(slide, track.target, Math.max(0, beatIndex));
  const manifest = el?.type === "plot" ? opts.plotManifest?.(el.assetId) : undefined;
  if (track.part) return resolveTargets(manifest, track.part);
  if (track.selector) {
    const sel = track.selector;
    const indices = sel.index == null ? null : new Set(Array.isArray(sel.index) ? sel.index : [sel.index]);
    return Object.values(buildPartIndex(manifest)).filter((p) => (!sel.role || p.role === sel.role) && (!sel.series || p.series === sel.series) && (!indices || p.index != null && indices.has(p.index))).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((p) => p.id);
  }
  return [];
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function compileSlide(slide: Slide, stage: StageSize = { width: 640, height: 360 }, opts: CompileOptions = {}): CompiledSlide {
  const issues: AnimationIssue[] = [];
  const cues = slide.beats.map((beat, bi) => {
    const tracks: CompiledTrack[] = [];
    for (const track of beat.tracks) {
      if (track.disabled) continue;
      let reason = "";
      if (track.keyframes) reason = "Custom keyframes are unsupported. Choose an effect or Change instead.";
      else if (!known.has(track.preset ?? "fade")) reason = `Unknown effect: ${track.preset}`;
      else if (!track.target.startsWith("@") && !slide.elements.some((e) => e.id === track.target)) reason = "Target object is missing. Retarget or remove this effect.";
      if (reason) { issues.push({ trackId: track.id, target: track.target, reason }); continue; }
      if ((track.preset === "transform" || track.preset === "morph") && track.to?.assetId && opts.plotManifest) {
        const pre = transformPreState(slide, track.target, bi);
        if (pre?.type === "plot") {
          const a = opts.plotManifest(pre.assetId), b = opts.plotManifest(track.to.assetId);
          if (a && b && !morphCompatible(a, b)) issues.push({ trackId: track.id, target: track.target, reason: "Plot structures differ; this Change crossfades the complete source and destination." });
        }
      }
      const parts = semanticTargets(track, slide, opts, bi);
      if ((track.part || track.selector) && !parts.length) issues.push({ trackId: track.id, target: track.target, reason: "No matching plot parts. Retarget this effect." });
      const start = Math.max(0, track.start ?? 0), duration = trackDuration(track);
      const el = transformPreState(slide, track.target, bi), manifest = el?.type === "plot" ? opts.plotManifest?.(el.assetId) : undefined;
      const by = track.stagger?.by;
      const coordinates = by === "x" || by === "y" ? new Map((manifest?.series ?? []).flatMap((s) => (s.points ?? []).map((p) => [p.svgId, p[by]] as const))) : undefined;
      const ranks = staggerRanks(Math.max(1, parts.length), track.stagger?.from, coordinates ? parts.map((id) => coordinates.get(id) ?? null) : undefined);
      tracks.push({ track, beat: bi, start, duration, end: start + duration + staggerSpan(track, parts.length), parts, ranks, ease: resolveEasingFn(track.easing ?? (track.preset === "transform" || track.preset === "morph" ? "smooth" : undefined), track.influence) });
    }
    // Same target/property concurrent effects are visible diagnostics, never a
    // silent replacement. Different channels (e.g. Change + Fade) compose.
    for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i], b = tracks[j];
      const family = (t: Track) => t.preset === "transform" || t.preset === "morph" ? "change" : t.preset === "camera" ? "camera" : "effect";
      if (a.track.target === b.track.target && (a.track.part ?? "") === (b.track.part ?? "") && JSON.stringify(a.track.selector ?? null) === JSON.stringify(b.track.selector ?? null) && family(a.track) === family(b.track) && a.start < b.end && b.start < a.end) {
        issues.push({ trackId: b.track.id, target: b.track.target, reason: "Effects overlap on the same target. Later effects take precedence; move their timing to play sequentially." });
      }
    }
    return { id: beat.id, duration: Math.max(0, ...tracks.map((t) => t.end)), tracks: tracks.sort((a, b) => a.start - b.start) };
  });
  function sample(beatIndex: number, timeMs = Infinity): SlideFrame {
    const elements = structuredClone(slide.elements);
    const byId = new Map(elements.map((e) => [e.id, e]));
    const appearance = new Map<string, PartFrame>();
    const spatial = new Map<string, Map<string, number[]>>();
    const partStates: SlideFrame["partStates"] = {};
    let camera = slide.camera ? { ...slide.camera } : undefined;
    const targetsFor = (ct: CompiledTrack) => ct.track.part || ct.track.selector ? ct.parts.map((p) => `${ct.track.target}\0${p}`) : [ct.track.target];
    // Future first entrances hide; an exit before an entrance still starts
    // visible. This baseline is independent of prior seeks/playback history.
    const first = new Set<string>(), firstCount = new Set<string>();
    for (const cue of cues) for (const ct of cue.tracks) {
      if (ct.track.preset === "countUp") {
        const el = byId.get(ct.track.target);
        if (el?.type === "text" && !firstCount.has(el.id)) { firstCount.add(el.id); el.text = countUpText(el.text, ct.track)(0); }
        continue;
      }
      if (ct.track.preset === "transform" || ct.track.preset === "morph" || ct.track.preset === "camera") continue;
      for (const key of targetsFor(ct)) if (!first.has(key)) { first.add(key); appearance.set(key, { opacity: enters.has(ct.track.preset ?? "fade") ? 0 : 1, visible: !enters.has(ct.track.preset ?? "fade") }); }
    }
    for (let bi = 0; bi <= Math.min(beatIndex, cues.length - 1); bi++) for (const ct of cues[bi].tracks) {
      const track = ct.track, preset = track.preset ?? "fade";
      const local = bi < beatIndex ? Infinity : timeMs;
      if (local < ct.start) continue;
      const raw = ct.duration > 0 ? clamp((local - ct.start) / ct.duration) : 1;
      const t = ct.ease(raw);
      const el = byId.get(track.target);
      if ((preset === "transform" || preset === "morph") && el) {
        const pre = transformPreState(slide, track.target, bi) ?? el;
        const end = applyState(pre, track.to?.state);
        if (end.type === "plot" && track.to?.assetId) end.assetId = track.to.assetId;
        const sampled = lerpElement(pre, end, t);
        for (const key of Object.keys(el)) if (!(key in sampled)) delete (el as unknown as Record<string, unknown>)[key];
        Object.assign(el, sampled);
        continue;
      }
      if (preset === "countUp" && el?.type === "text") {
        const pre = transformPreState(slide, track.target, bi);
        el.text = countUpText(pre?.type === "text" ? pre.text : el.text, track)(t);
        continue;
      }
      if (preset === "camera") {
        const from = camera ?? { x: stage.width / 2, y: stage.height / 2, zoom: 1 };
        camera = { x: from.x + (Number(track.to?.x ?? from.x) - from.x) * t, y: from.y + (Number(track.to?.y ?? from.y) - from.y) * t, zoom: from.zoom + (Number(track.to?.zoom ?? from.zoom) - from.zoom) * t };
        continue;
      }
      for (const [i, key] of targetsFor(ct).entries()) {
        const at = ct.duration > 0 ? ct.ease(clamp((local - ct.start - (ct.ranks[i] ?? 0) * (track.stagger?.perMs ?? 0)) / ct.duration)) : 1;
        const previous = appearance.get(key) ?? { opacity: 1, visible: true };
        const opacity = enters.has(preset) ? at : exits.has(preset) ? 1 - at : preset === "dim" ? 1 - .7 * at : preset === "highlight" ? .4 + .6 * at : previous.opacity;
        appearance.set(key, { opacity, visible: opacity > 0 });
      }
      // Legacy spatial effects remain inspectable at their endpoint.
      if (el && !ct.parts.length) {
        const effects = spatial.get(el.id) ?? new Map<string, number[]>(); spatial.set(el.id, effects);
        if (preset === "move") effects.set("move", [Number(track.to?.x ?? 0) * t, Number(track.to?.y ?? 0) * t]);
        if (preset === "rotate") effects.set("rotate", [Number(track.to?.rotation ?? track.to?.deg ?? track.params?.deg ?? 15) * t]);
        if (preset === "scale") effects.set("scale", [1 + (Number(track.to?.scale ?? track.params?.scale ?? 1.15) - 1) * t]);
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
      const [id, part] = key.split("\0");
      if (part) (partStates[id] ??= {})[part] = state;
      else elementStates[id] = state;
    }
    return { elements, camera, partStates, issues, presentation: { elementStates, hiddenElementIds: Object.entries(elementStates).filter(([, state]) => !state.visible).map(([id]) => id), partStates, camera } };
  }
  return { cues, issues, sample };
}
export function evaluateSlideState(slide: Slide, beat: number, timeMs = Infinity, opts: CompileOptions & { stage?: StageSize } = {}): SlideFrame {
  return compileSlide(slide, opts.stage, opts).sample(beat, timeMs);
}
