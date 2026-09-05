// ---------------------------------------------------------------------------
// Flux Slide — the player runtime (§5). Framework-agnostic (no Svelte): the ONE
// engine that drives the editor's beat preview, in-app present mode, and the
// exported HTML. It renders a slide through the one renderer, resolves each
// track to cached DOM bindings, and samples every effect from one clock. Native
// effects are paused and time-addressed alongside geometry. Random/reverse
// seeks, previews, presentation, thumbnails, and HTML export share these rules.
// ---------------------------------------------------------------------------

import { DUR } from "../../motion/tokens";
import { smoothstep, cubicBezierFn } from "../../motion/tokens";
import { animate, prefersReducedMotion } from "../../motion/motion";
import { buildPartIndex } from "../../plot/parse";
import { resolveTargets } from "../../plot/tree";
import type { FluxPlotManifest } from "../../plot/types";
import { renderSlide, type SlideRenderCtx, type RenderedSlide } from "./render";
import { PRESETS, PRESET_WRAPPER_PROPS, type TargetNode, type PresetCtx } from "./presets";
import { morphCompatible, type MorphController } from "./morph";
import { createCountUp } from "./countup";
import { createTransform } from "./transform";
import { applyState, transformPreState } from "../tween";
import { editorCameraTransform } from "../../editorPresentation";
import type { Deck, Slide, Track, StageSize, DeckTheme } from "../types";

const SEP = "__"; // mirrors plot/parse prefixIds — plot part DOM id = `${elId}__${semanticId}`

export interface PlayerOpts extends Omit<SlideRenderCtx, "theme"> {
  theme: DeckTheme;
  /** assetId → its plot manifest (for role/series/index part targeting). */
  plotManifest?: (assetId: string) => FluxPlotManifest | undefined;
  reducedMotion?: boolean;
}

export { resolveEasing, resolveEasingFn } from "../easing";
import { resolveEasing, resolveEasingFn } from "../easing";
import { compileSlide, type AnimationIssue } from "../compile";
import { staggerRanks } from "../stagger";

// --- target resolution -------------------------------------------------------
/** A node's spatial coordinate for stagger ordering: the data-space value the
 *  semantic SVG carries (data-x/data-y), else the rendered geometry (x/y, cx/cy). */
function spatialCoord(node: TargetNode, axis: "x" | "y"): number | null {
  const el = node as unknown as { getAttribute?: (n: string) => string | null };
  const at = (name: string): number | null => {
    const v = el.getAttribute?.(name);
    if (v == null || v === "") return null;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  };
  return at(`data-${axis}`) ?? at(axis) ?? at(axis === "x" ? "cx" : "cy");
}

/** The plot manifest backing a slide element (its assetId → manifest), or none. */
function manifestFor(target: string, slide: Slide, opts: PlayerOpts, beatIndex = 0): FluxPlotManifest | undefined {
  const el = transformPreState(slide, target, beatIndex);
  const assetId = el && "assetId" in el ? (el as { assetId: string }).assetId : undefined;
  return assetId ? opts.plotManifest?.(assetId) : undefined;
}

/** A track → the DOM nodes it animates (whole element, a plot part, a plot
 *  part-set by role/series/index, or the camera layer). A DANGLING target
 *  (its element deleted in the editor) resolves to [] — the track no-ops
 *  cleanly; it is surfaced by the animator/diagnostics, never pruned. */
function resolveNodes(track: Track, slide: Slide, rendered: RenderedSlide, cameraLayer: HTMLElement, opts: PlayerOpts, beatIndex = 0, contentRoots?: Map<string, HTMLElement>): TargetNode[] {
  if (track.target === "@camera" || track.target === "@stage") return [cameraLayer];
  const wrap = rendered.elements.get(track.target);
  if (!wrap) return [];
  const content = contentRoots?.get(track.target) ?? wrap;

  // a plot part OR a part-GROUP by parts-tree id: a leaf id → that one node; a
  // group/container id (e.g. "axis.x", "series.main.point-group") → every leaf
  // member, in tree order. This is the only path that reaches axis parts (spine/
  // ticks/labels/gridlines live in the parts tree, not the series part-index).
  if (track.part) {
    const ids = resolveTargets(manifestFor(track.target, slide, opts, beatIndex), track.part);
    return ids
      .map((id) => content.querySelector<SVGElement>(`[id="${track.target}${SEP}${id}"]`))
      .filter((n): n is SVGElement => !!n);
  }

  // a plot part-set by role / series / index
  const sel = track.selector;
  if (sel && (sel.role || sel.series || sel.index != null)) {
    const idx = buildPartIndex(manifestFor(track.target, slide, opts, beatIndex));
    const wantIdx = sel.index == null ? null : new Set(Array.isArray(sel.index) ? sel.index : [sel.index]);
    const parts = Object.values(idx)
      .filter((p) => (!sel.role || p.role === sel.role) && (!sel.series || p.series === sel.series) && (!wantIdx || (p.index != null && wantIdx.has(p.index))))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return parts
      .map((p) => content.querySelector<SVGElement>(`[id="${track.target}${SEP}${p.id}"]`))
      .filter((n): n is SVGElement => !!n);
  }

  // whole element
  return [(wrap as HTMLElement & { __slideEffects?: HTMLElement }).__slideEffects ?? wrap];
}

// --- spec model (a flattened, timed animation per node) ----------------------
interface Spec {
  node: TargetNode;
  beatIndex: number;
  keyframes: Keyframe[];
  delay: number;
  duration: number;
  easing: string;
  enter: boolean;
  /** The authoring identity (target+part+selector) all of a track's node-specs
   *  share. The RE-BASELINE window is computed per key, not per node, because an
   *  enter and a re-enter of the same logical target may resolve to different
   *  nodes (fade acts on the part's <g>, drawOn drills to its path). */
  key: string;
  prep?: () => void;
  /** A `camera` track: its FROM keyframe must be re-read from the live layer at
   *  PLAY time (not this build time) so chained moves start from the current pose. */
  camera?: boolean;
  /** Present only for `morph` tracks — a data-space driver instead of keyframes. */
  morph?: MorphController;
  /** Time-easing sampler for a morph (honours the track's influence/easing). */
  morphEase?: (t: number) => number;
  trackId?: string;
  baseStyle?: Record<string, string>;
}

// transformPreState moved to ../tween (pure) — the endpoint checkout and the
// player must share ONE fold. Re-exported for existing consumers/gates.
export { transformPreState } from "../tween";

/** Flatten a slide's beats → timed per-node specs (the static-state + play substrate). */
export function computeSlideAnims(slide: Slide, rendered: RenderedSlide, cameraLayer: HTMLElement, stage: StageSize, opts: PlayerOpts): Spec[] {
  const specs: Spec[] = [];
  const contentRoots = new Map<string, HTMLElement>();
  const ctx: PresetCtx = { theme: opts.theme, stage };
  // Placement/rotation/opacity belong to the document wrapper. Appearance
  // effects operate on a child layer, so rising in cannot erase a concurrent
  // position change or an authored rotation/translucency.
  for (const beat of slide.beats) for (const track of beat.tracks) {
    if (track.disabled || track.part || track.selector || !PRESET_WRAPPER_PROPS[track.preset ?? "fade"]) continue;
    const wrap = rendered.elements.get(track.target) as (HTMLElement & { __slideEffects?: HTMLElement }) | undefined;
    if (!wrap?.firstElementChild || wrap.__slideEffects) continue;
    const effects = document.createElement("div");
    effects.className = "sl-effects";
    effects.style.cssText = "position:absolute;inset:0;transform-origin:center center";
    while (wrap.firstChild) effects.appendChild(wrap.firstChild);
    wrap.appendChild(effects);
    wrap.__slideEffects = effects;
  }
  slide.beats.forEach((beat, bi) => {
    for (const track of beat.tracks) {
      // A disabled track keeps its authored timing in the deck but is invisible
      // to play/static/export — the non-destructive Mask/Show substrate.
      if (track.disabled || track.keyframes || track.preset && !(track.preset in PRESETS) && !["transform", "morph", "countUp"].includes(track.preset)) continue;
      const key = `${track.target}|${track.part ?? ""}|${JSON.stringify(track.selector ?? null)}`;
      // transform — the state tween (rework §4). Pre = fold of earlier
      // transforms; end = pre ⊕ to.state. Plots may ALSO carry a content
      // morph target (to.assetId) — one track, both halves.
      if (track.preset === "transform" || track.preset === "morph") {
        const wrap = rendered.elements.get(track.target);
        const preEl = transformPreState(slide, track.target, bi);
        if (!wrap || !preEl) continue; // dangling target — tolerated no-op
        const endEl = applyState(preEl, track.to?.state as Record<string, unknown> | undefined);
        if (endEl.type === "plot" && track.to?.assetId) endEl.assetId = track.to.assetId;
        let morphTo: { A: import("../../plot/types").FluxPlotManifest; B: import("../../plot/types").FluxPlotManifest } | undefined;
        const el = slide.elements.find((e) => e.id === track.target);
        if (el && el.type === "plot" && track.to?.assetId) {
          const A = opts.plotManifest?.(preEl.type === "plot" ? preEl.assetId : el.assetId);
          const B = opts.plotManifest?.(track.to.assetId);
          if (A && B && morphCompatible(A, B)) morphTo = { A, B };
        }
        const driver = createTransform(wrap, preEl, endEl, {
          theme: opts.theme, assetUrl: opts.assetUrl, assetSize: opts.assetSize,
          plotGen: opts.plotGen, deckBackground: opts.deckBackground, mode: opts.mode,
          plotManifest: opts.plotManifest, morphTo, contentHost: contentRoots.get(track.target),
        });
        if (driver.targetRoot) contentRoots.set(track.target, driver.targetRoot);
        specs.push({
          node: wrap, beatIndex: bi, keyframes: [], enter: false, key, trackId: track.id,
          delay: track.start ?? 0, duration: track.duration ?? (track.preset === "morph" ? 1200 : 600),
          easing: resolveEasing(track.easing ?? "smooth", track.influence),
          morph: driver,
          morphEase: resolveEasingFn(track.easing ?? "smooth", track.influence),
        });
        continue;
      }
      // countUp — a number-tween driver sharing the morph plumbing (rAF play,
      // static seek 0|1, reduced-motion snap). Targets the first resolved node;
      // for a text element, drill to the innermost tspan/text node so writing
      // the tween text doesn't flatten the rendered markup.
      if (track.preset === "countUp") {
        let node = resolveNodes(track, slide, rendered, cameraLayer, opts, bi, contentRoots)[0];
        if (!track.part && !track.selector) node = contentRoots.get(track.target) ?? node;
        const leaves = Array.from((node as HTMLElement | undefined)?.querySelectorAll?.("tspan") ?? []);
        const textNode = leaves.find((n) => /\d/.test(n.textContent ?? "")) ?? leaves[0] ??
          (node as HTMLElement | undefined)?.querySelector?.("text");
        if (textNode) node = textNode as unknown as HTMLElement;
        if (node) {
          specs.push({
            node, beatIndex: bi, keyframes: [], enter: false, key, trackId: track.id,
            delay: track.start ?? 0, duration: track.duration ?? 800,
            easing: resolveEasing(track.easing ?? "standard", track.influence),
            morph: createCountUp(node, track),
            morphEase: resolveEasingFn(track.easing ?? "standard", track.influence),
          });
        }
        continue;
      }
      const nodes = resolveNodes(track, slide, rendered, cameraLayer, opts, bi, contentRoots);
      if (!nodes.length) continue;
      const preset = PRESETS[track.preset ?? "fade"] ?? PRESETS.fade;
      const nodeAnims = preset(nodes, track, ctx);
      if (track.preset === "camera") {
        const previous = compileSlide(slide, stage, opts).sample(bi - 1).camera;
        const cameraSlide = { ...slide, camera: previous };
        for (const na of nodeAnims) na.keyframes[0] = { transform: baseCameraTransform(cameraSlide, stage) || "translate(0px, 0px) scale(1)" };
      }
      const n = nodes.length;
      const perMs = track.stagger?.perMs ?? 0;
      const from = track.stagger?.from ?? "start";
      const by = track.stagger?.by;
      const ranks = perMs ? staggerRanks(n, from, by === "x" || by === "y" ? nodes.map((node) => spatialCoord(node, by)) : undefined) : [];
      nodeAnims.forEach((na, i) => {
        specs.push({
          node: na.node,
          beatIndex: bi,
          keyframes: na.keyframes,
          delay: (track.start ?? 0) + (perMs ? ranks[na.index] * perMs : 0),
          duration: track.duration ?? DUR.gentle,
          easing: resolveEasing(track.easing, track.influence),
          enter: na.enter,
          key,
          prep: na.prep,
          camera: track.preset === "camera",
          trackId: track.id,
        });
      });
    }
  });
  for (const spec of specs) {
    spec.baseStyle = Object.fromEntries(ANIM_PROPS.map((p) => [p, (spec.node as HTMLElement).style[p] ?? ""]));
    if (spec.keyframes.some((frame) => "opacity" in frame)) {
      // SVG parts can have authored opacity of their own. Effects are factors
      // over that styling, just as whole-object effects factor the outer box.
      // Compile it once into the shared native/static frames (no frame reads).
      const ownOpacity = spec.baseStyle.opacity || spec.node.getAttribute?.("opacity") ||
        (typeof getComputedStyle === "function" ? getComputedStyle(spec.node).opacity : "1");
      const factor = Number.isFinite(Number(ownOpacity)) && ownOpacity !== "" ? Number(ownOpacity) : 1;
      if (factor !== 1) spec.keyframes = spec.keyframes.map((frame) => "opacity" in frame ? { ...frame, opacity: Number(frame.opacity) * factor } : frame);
    }
  }
  return specs;
}

const ANIM_PROPS = ["opacity", "transform", "clipPath", "strokeDashoffset", "strokeDasharray", "strokeLinecap", "transformOrigin"] as const;
function clearAnimStyles(node: TargetNode, properties: readonly string[]) {
  const s = (node as HTMLElement).style;
  for (const p of properties) s.removeProperty(p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
}
const IDENTITY_FN = /^(translate\(0(px)?,\s*0(px)?\)|translateX\(0(px)?\)|translateY\(0(px)?\)|scale\(1\)|scaleX\(1\)|scaleY\(1\)|rotate\(0deg\))$/;
/** Apply the cumulative resting look from a node's past specs. Non-transform props
 *  are last-wins; transform is COMPOSED by function (translate/scale/rotate/…), last
 *  of each type winning — so a `move` then a `scale` keep BOTH, instead of the scale
 *  clobbering the translate (B11). Identity components are dropped. */
function applyAccumulated(node: TargetNode, past: Spec[]) {
  const s = (node as HTMLElement).style as unknown as Record<string, string>;
  const tfns = new Map<string, string>(); // function name → its full "fn(args)"
  let sawTransform = false;
  for (const spec of past) {
    const kf = spec.keyframes[spec.keyframes.length - 1];
    for (const [k, v] of Object.entries(kf)) {
      if (k === "offset" || k === "easing" || k === "composite" || v == null) continue;
      if (k === "transform") {
        sawTransform = true;
        for (const m of String(v).matchAll(/([\w-]+)\(([^)]*)\)/g)) tfns.set(m[1], m[0]);
      } else s[k] = String(v);
    }
  }
  if (sawTransform) {
    const parts = [...tfns.values()].filter((t) => !IDENTITY_FN.test(t));
    s.transform = parts.length ? parts.join(" ") : "none";
  }
}
/** Apply the deterministic static (resting) look at `beatIndex`: every node gets
 *  the cumulative END state of all specs ≤ beatIndex; nodes whose first spec is
 *  an enter beyond beatIndex are hidden at that spec's start keyframe. */
/** The transform for a slide's base camera pose (matches the `camera` preset's math), or
 *  "" for no/identity camera. Applied at rest so slide.camera is honored (B14) — in the player
 *  AND (SLD-11) in the editor stage, which previously reset the camera layer to identity. */
export function baseCameraTransform(slide: Slide, stage: StageSize): string {
  const c = slide.camera;
  if (!c || (c.x === stage.width / 2 && c.y === stage.height / 2 && (c.zoom ?? 1) === 1)) return "";
  const { x, y, zoom } = editorCameraTransform(c, stage);
  return `translate(${x}px, ${y}px) scale(${zoom})`;
}

// Compiled DOM binding state. No selectors or scene reconstruction in sampling.
interface BoundNode { node: TargetNode; keyframed: Spec[]; properties: string[]; blockers: Map<Spec, Spec[]>; controllers: Spec[]; lastController: number }
interface BoundPlan { nodes: BoundNode[]; natives: Map<Spec, Animation>; samplers: Map<Spec, (t: number) => Keyframe> }
const bindings = new WeakMap<Spec[], BoundPlan>();
function numericSampler(a: unknown, b: unknown): (t: number) => string | number {
  if (typeof a === "number" && typeof b === "number") return (t) => a + (b - a) * t;
  const sa = String(a ?? ""), sb = String(b ?? "");
  const rx = /-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi;
  const na = (sa.match(rx) ?? []).map(Number), nb = (sb.match(rx) ?? []).map(Number);
  if (na.length && na.length === nb.length) return (t) => { let i = 0; return sb.replace(rx, () => String(na[i] + (nb[i] - na[i++]) * t)); };
  return (t) => t < .5 ? sa : sb;
}
function frameSampler(spec: Spec): (t: number) => Keyframe {
  const frames = spec.keyframes;
  const segments = frames.slice(1).map((frame, i) => ({
    from: Number(frames[i].offset ?? i / (frames.length - 1)),
    to: Number(frame.offset ?? (i + 1) / (frames.length - 1)),
    props: Object.keys(frame).filter((p) => !["offset", "easing", "composite"].includes(p)).map((p) => [p, numericSampler((frames[i] as Record<string, unknown>)[p], (frame as Record<string, unknown>)[p])] as const),
  }));
  const coeff = spec.easing.match(/-?\d*\.?\d+/g)?.map(Number);
  const ease = spec.easing === "linear" ? (t: number) => t : spec.easing.startsWith("linear(") ? smoothstep : coeff?.length === 4 ? cubicBezierFn(coeff as [number, number, number, number]) : smoothstep;
  return (raw) => {
    if (raw <= 0) return frames[0];
    if (raw >= 1) return frames.at(-1)!;
    const t = ease(raw);
    const segment = segments.find((s) => t <= s.to) ?? segments.at(-1)!;
    const u = Math.max(0, Math.min(1, (t - segment.from) / (segment.to - segment.from || 1)));
    return Object.fromEntries(segment.props.map(([p, sample]) => [p, sample(u)]));
  };
}
function boundPlan(specs: Spec[]): BoundPlan {
  let plan = bindings.get(specs);
  if (plan) return plan;
  const map = new Map<TargetNode, Spec[]>();
  for (const spec of specs) { const list = map.get(spec.node) ?? []; list.push(spec); map.set(spec.node, list); }
  plan = { nodes: [...map].map(([node, list]) => {
    list.sort((a, b) => a.beatIndex - b.beatIndex || a.delay - b.delay);
    const keyframed = list.filter((s) => s.keyframes.length);
    const properties = new Set(keyframed.flatMap((s) => s.keyframes.flatMap((f) => Object.keys(f).filter((p) => !["offset", "easing", "composite"].includes(p)))));
    const channels = keyframed.map((s) => new Set(s.keyframes.flatMap((f) => Object.keys(f).filter((p) => !["offset", "easing", "composite"].includes(p)))));
    const blockers = new Map(keyframed.map((s, i) => [s, keyframed.filter((_, j) => j > i && [...channels[i]].some((p) => channels[j].has(p)))]));
    if (properties.has("strokeDashoffset")) { properties.add("strokeDasharray"); properties.add("strokeLinecap"); }
    if (properties.has("transform")) properties.add("transformOrigin");
    return { node, keyframed, properties: [...properties], blockers, controllers: list.filter((s) => s.morph), lastController: -2 };
  }), natives: new Map(), samplers: new Map() };
  // Materialize content layers in story order before a first random seek.
  // Otherwise seeking directly to a late text change could nest its layer
  // underneath an earlier change which is only materialized afterwards.
  for (const group of plan.nodes) for (const controller of group.controllers) controller.morph!.seek(0);
  for (const spec of specs) if (spec.keyframes.length) plan.samplers.set(spec, frameSampler(spec));
  bindings.set(specs, plan);
  return plan;
}
export function disposeSlideAnims(specs: Spec[]): void {
  const plan = bindings.get(specs);
  if (plan) for (const animation of plan.natives.values()) { try { animation.cancel(); } catch { /* detached */ } }
  bindings.delete(specs);
}
function progressAt(spec: Spec, beat: number, time: number): number {
  if (spec.beatIndex < beat) return 1;
  if (spec.beatIndex > beat || time < spec.delay) return -1;
  return spec.duration <= 0 ? 1 : Math.min(1, (time - spec.delay) / spec.duration);
}
/** Seek any frame, including reverse/random seeks. Native effects and custom
 * geometry use the same time; a stopped frame has no running animation loop. */
export function applyAt(specs: Spec[], beat: number, time = Infinity, native = false): void {
  const plan = boundPlan(specs);
  const rebase = new Map<string, Spec>();
  for (const spec of specs) if (spec.enter && progressAt(spec, beat, time) >= 0) rebase.set(spec.key, spec);
  const superseded = (spec: Spec) => {
    const later = rebase.get(spec.key);
    return later && (spec.beatIndex < later.beatIndex || spec.beatIndex === later.beatIndex && spec.delay < later.delay);
  };
  const activeNatives = new Set<Spec>();
  for (const group of plan.nodes) {
    const { node, keyframed, properties, controllers } = group;
    if (controllers.length) {
      let selected = -1;
      for (let i = 0; i < controllers.length; i++) if (progressAt(controllers[i], beat, time) >= 0) selected = i;
      if (selected !== group.lastController) {
        // Reset future crossfade layers outside-in before applying the past.
        // Their DOM is retained so inner-node animation bindings survive.
        for (let i = controllers.length - 1; i >= 0; i--) controllers[i].morph!.seek(0);
        for (let i = 0; i < selected; i++) controllers[i].morph!.seek(1);
        group.lastController = selected;
      }
      if (selected >= 0) {
        const spec = controllers[selected], p = progressAt(spec, beat, time);
        spec.morph!.seek((spec.morphEase ?? smoothstep)(Math.max(0, p)));
      } else controllers[0].morph!.seek(0);
    }
    if (!keyframed.length) continue;
    clearAnimStyles(node, properties);
    const base = keyframed[0].baseStyle;
    if (base) for (const key of properties) if (base[key]) (node.style as unknown as Record<string, string>)[key] = base[key];
    const applied: Spec[] = [];
    for (const spec of keyframed) {
      const p = progressAt(spec, beat, time);
      if (superseded(spec)) continue;
      spec.prep?.();
      if (p < 0) {
        if (!applied.length && spec === keyframed[0] && spec.enter) applied.push({ ...spec, keyframes: [spec.keyframes[0]] });
        continue;
      }
      const frame = plan.samplers.get(spec)!(p);
      applied.push({ ...spec, keyframes: [frame] });
      // Use native effects for active frames when available. Their time is
      // explicitly controlled; no independent WAAPI clock can drift from data.
      if (native && p > 0 && p < 1 && typeof node.animate === "function" && !spec.keyframes.some((k) => "transform" in k) && !group.blockers.get(spec)?.some((later) => progressAt(later, beat, time) >= 0)) {
        let animation = plan.natives.get(spec);
        if (!animation) {
          animation = node.animate(spec.keyframes, { duration: spec.duration, easing: spec.easing, fill: "both" });
          animation.pause();
          animation.finished.catch(() => {});
          plan.natives.set(spec, animation);
        }
        animation.currentTime = p * spec.duration;
        activeNatives.add(spec);
      }
    }
    if (applied.length) applyAccumulated(node, applied);
  }
  for (const [spec, animation] of plan.natives) if (!activeNatives.has(spec)) { animation.cancel(); plan.natives.delete(spec); }
}
export function applyStatic(specs: Spec[], beatIndex: number): void { applyAt(specs, beatIndex, Infinity); }

export interface PlayerState {
  slide: number;
  beat: number;
  totalBeats: number;
  totalSlides: number;
  time: number;
  duration: number;
  playing: boolean;
  issues: AnimationIssue[];
}
type Ev = "change" | "beatStart" | "beatEnd" | "frame";
export interface PlayRange { slide: number; fromBeat?: number; toBeat?: number; loop?: boolean }
export interface Player {
  goTo(slide: number, beat: number, opts?: { animate?: boolean }): void;
  seek(slide: number, beat: number, timeMs: number): void;
  play(range: PlayRange): void;
  pause(): void;
  resume(): void;
  stop(): void;
  next(): void;
  prev(): void;
  nextSlide(): void;
  prevSlide(): void;
  state(): PlayerState;
  setMediaPaused(paused: boolean): void;
  on(ev: Ev, cb: (s: PlayerState) => void): () => void;
  destroy(): void;
}

export function createPlayer(mount: HTMLElement, deck: Deck, opts: PlayerOpts): Player {
  const stage = deck.stage, reduced = opts.reducedMotion ?? prefersReducedMotion();
  mount.replaceChildren();
  mount.style.position = "relative"; mount.style.overflow = "hidden";
  mount.style.width = `${stage.width}px`; mount.style.height = `${stage.height}px`;
  const cameraLayer = document.createElement("div");
  cameraLayer.className = "sl-camera";
  cameraLayer.style.cssText = "position:absolute;inset:0;transform-origin:0 0;";
  mount.appendChild(cameraLayer);
  const listeners: Record<Ev, Set<(s: PlayerState) => void>> = { change: new Set(), beatStart: new Set(), beatEnd: new Set(), frame: new Set() };
  let si = -1, bi = 0, time = 0, duration = 0, playing = false, raf = 0, generation = 0, origin = 0;
  let specs: Spec[] = [], issues: AnimationIssue[] = [], durations: number[] = [];
  let auto: ReturnType<typeof setTimeout> | undefined;
  let range: PlayRange | null = null;
  let transition: Animation | null = null;
  const ctx: SlideRenderCtx = { ...opts, deckBackground: deck.background };
  const beats = () => Math.max(1, deck.slides[si]?.beats.length ?? 0);
  function state(): PlayerState { return { slide: si, beat: bi, totalBeats: beats(), totalSlides: deck.slides.length, time, duration, playing, issues }; }
  const emit = (event: Ev) => { const value = state(); for (const listener of listeners[event]) listener(value); };
  function cancelClock(): void {
    generation++; if (raf) cancelAnimationFrame(raf); raf = 0;
    clearTimeout(auto); auto = undefined; playing = false;
    transition?.cancel(); transition = null;
  }
  function build(index: number): void {
    if (index === si) return;
    disposeSlideAnims(specs);
    si = index;
    const slide = deck.slides[si];
    if (!slide) { specs = []; durations = [0]; return; }
    mount.style.background = slide.background ?? deck.background ?? opts.theme.background;
    const rendered = renderSlide(cameraLayer, slide, stage, ctx);
    cameraLayer.style.transform = baseCameraTransform(slide, stage);
    const compiled = compileSlide(slide, stage, opts);
    issues = compiled.issues;
    specs = computeSlideAnims(slide, rendered, cameraLayer, stage, opts);
    durations = Array.from({ length: beats() }, (_, beat) => Math.max(0, ...specs.filter((s) => s.beatIndex === beat).map((s) => s.delay + s.duration)));
  }
  function paint(native = false): void {
    applyAt(runSpecs ?? specs, bi, time, native);
    emit("frame");
  }
  let runSpecs: Spec[] | null = null;
  function scheduleAuto(): void {
    const next = deck.slides[si]?.beats[bi + 1];
    if (next?.advance === "auto") {
      const stamp = generation;
      auto = setTimeout(() => { if (stamp === generation) nextCue(); }, Math.max(0, next.autoDelayMs ?? 600));
    }
  }
  function finish(): void {
    const session = generation;
    playing = false; raf = 0; time = duration; paint(); emit("beatEnd"); emit("change");
    if (session !== generation) return; // a listener stopped/started another run
    if (range) {
      const last = Math.min(beats() - 1, range.toBeat ?? beats() - 1);
      if (bi < last) { begin(bi + 1, bi + 1); return; }
      const first = Math.max(0, Math.min(beats() - 1, range.fromBeat ?? Math.min(1, beats() - 1)));
      if (range.loop && durations.slice(first, last + 1).some((d) => d > 0)) { begin(first, first); return; }
      range = null;
    } else scheduleAuto();
  }
  function tick(timestamp: number): void {
    if (!playing) return;
    const session = generation;
    time = Math.min(duration, Math.max(0, timestamp - origin));
    paint(true);
    if (session !== generation) return;
    if (time >= duration) finish();
    else queueFrame();
  }
  function queueFrame(): void {
    const session = generation;
    raf = requestAnimationFrame((timestamp) => { if (session === generation) tick(timestamp); });
  }
  function begin(from: number, to: number): void {
    cancelClock();
    const session = generation;
    if (runSpecs) { disposeSlideAnims(runSpecs); for (const node of bindings.get(specs)?.nodes ?? []) node.lastController = -2; }
    bi = Math.max(0, Math.min(beats() - 1, to));
    runSpecs = from < bi ? specs.map((s) => s.beatIndex >= from && s.beatIndex <= bi ? { ...s, beatIndex: bi } : s) : null;
    duration = Math.max(0, ...durations.slice(from, bi + 1));
    time = 0;
    playing = true;
    paint(); emit("beatStart"); emit("change");
    if (session !== generation) return;
    if (reduced || !duration) { finish(); return; }
    origin = performance.now();
    queueFrame();
  }
  function seek(index: number, beat: number, ms: number): void {
    cancelClock(); range = null;
    if (runSpecs) { disposeSlideAnims(runSpecs); for (const node of bindings.get(specs)?.nodes ?? []) node.lastController = -2; } runSpecs = null;
    build(Math.max(0, Math.min(deck.slides.length - 1, index)));
    bi = Math.max(0, Math.min(beats() - 1, beat));
    duration = durations[bi] ?? 0; time = Math.max(0, Math.min(duration, ms));
    paint(); emit("change");
  }
  function goTo(index: number, beat: number, config: { animate?: boolean } = {}): void {
    const changed = index !== si, forward = index >= si;
    if (config.animate && !changed && beat > bi) { range = null; begin(beat, beat); return; }
    seek(index, beat, Infinity);
    const kind = deck.slides[si]?.transition ?? deck.defaults?.transition ?? "none";
    if (changed && !reduced && kind !== "none" && typeof cameraLayer.animate === "function") {
      transition = kind === "fade" ? animate(cameraLayer, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.gentle, reduce: false }) : animate(mount, [{ transform: `translateX(${forward ? stage.width : -stage.width}px)` }, { transform: "translateX(0px)" }], { duration: DUR.gentle, reduce: false });
    }
    scheduleAuto();
  }
  function nextCue(): void {
    range = null;
    if (bi >= beats() - 1) { nextSlide(); return; }
    let end = bi + 1;
    while (end + 1 < beats() && deck.slides[si].beats[end + 1].advance === "with-prev") end++;
    begin(bi + 1, end);
  }
  function prev(): void {
    if (bi <= 0) { prevSlide(); return; }
    let start = bi;
    while (start > 0 && deck.slides[si].beats[start]?.advance === "with-prev") start--;
    seek(si, Math.max(0, start - 1), Infinity);
  }
  function nextSlide(): void { if (si < deck.slides.length - 1) goTo(si + 1, 0); }
  function prevSlide(): void { if (si > 0) goTo(si - 1, Math.max(0, deck.slides[si - 1].beats.length - 1)); }
  function play(request: PlayRange): void {
    cancelClock(); build(Math.max(0, Math.min(deck.slides.length - 1, request.slide)));
    range = { ...request };
    const from = Math.max(0, Math.min(beats() - 1, request.fromBeat ?? Math.min(1, beats() - 1)));
    begin(from, from);
  }
  function pause(): void { cancelClock(); paint(); emit("change"); }
  function resume(): void {
    if (playing || time >= duration) return;
    clearTimeout(auto); playing = true; origin = performance.now() - time;
    const session = generation;
    emit("change"); if (session === generation) queueFrame();
  }
  function stop(): void { seek(si, bi, 0); }
  function setMediaPaused(paused: boolean): void {
    for (const video of Array.from(cameraLayer.querySelectorAll("video"))) {
      if (paused) video.pause?.(); else if (video.dataset.autoplay === "1") void video.play?.();
    }
  }
  function on(event: Ev, listener: (s: PlayerState) => void): () => void { listeners[event].add(listener); return () => listeners[event].delete(listener); }
  function destroy(): void { cancelClock(); disposeSlideAnims(specs); if (runSpecs) disposeSlideAnims(runSpecs); mount.replaceChildren(); for (const set of Object.values(listeners)) set.clear(); }
  if (deck.slides.length) goTo(0, 0);
  return { goTo, seek, play, pause, resume, stop, next: nextCue, prev, nextSlide, prevSlide, state, setMediaPaused, on, destroy };
}

/** The same evaluated endpoint as live playback; camera included. */
export function renderStaticAt(host: HTMLElement, slide: Slide, stage: StageSize, beat: number, opts: PlayerOpts): RenderedSlide {
  // The host's transform belongs to its fit/thumbnail scale. Camera motion
  // gets a separate layer exactly as it does in createPlayer.
  host.replaceChildren();
  const camera = document.createElement("div");
  camera.className = "sl-camera";
  camera.style.transformOrigin = "0 0";
  host.appendChild(camera);
  const rendered = renderSlide(camera, slide, stage, opts);
  camera.style.transform = baseCameraTransform(slide, stage);
  const specs = computeSlideAnims(slide, rendered, camera, stage, opts);
  applyStatic(specs, beat);
  return rendered;
}
