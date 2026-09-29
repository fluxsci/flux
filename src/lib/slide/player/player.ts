// ---------------------------------------------------------------------------
// Flux Slide — the player runtime (§5). Framework-agnostic (no Svelte): the ONE
// engine that drives the editor's beat preview, in-app present mode, and the
// exported HTML. It renders a slide through the one renderer, resolves each
// track to cached DOM bindings, and samples every effect from one clock. Native
// effects are paused and time-addressed alongside geometry. Random/reverse
// seeks, previews, presentation, thumbnails, and HTML export share these rules.
// ---------------------------------------------------------------------------

import { beatDelayMs } from "../timing";
import { DUR } from "../../motion/tokens";
import { animate, prefersReducedMotion } from "../../motion/motion";
import { partDomId } from "../../plot/parse";
import type { FluxPlotManifest } from "../../plot/types";
import { isHandoff, targetPartIds, hasPartBinding, trackKey, type ResolvedTarget } from "../targets";
import { get } from "svelte/store";
import { plotDom, plotManifests } from "../../plot/store";
import { renderSlide, fillContent, applyWrapperBox, promoteMovingWrapper, settleWrapper, armFlightMark, releaseFlightMark, type SlideRenderCtx, type RenderedSlide } from "./render";
import { PRESETS, PRESET_WRAPPER_PROPS, type TargetNode, type PresetCtx } from "./presets";
import { KNOWN_PRESETS } from "../presetCatalog";
import type { MorphController } from "../../plot/project";
import { createCountUp } from "./countup";
import { createTransform } from "./transform";
import { modelHandoffMedia } from "./model3dHandoff";
import { createHandoff, type HandoffController } from "./handoff";
import { planHandoff } from "../handoffPlan";
import { transformEndState, transformPreState } from "../tween";
import { editorCameraTransform } from "../../editorPresentation";
import type { Deck, Slide, Track, StageSize, DeckTheme } from "../types";

export interface PlayerOpts extends Omit<SlideRenderCtx, "theme"> {
  animStyles?: Deck["animStyles"];
  theme: DeckTheme;
  /** assetId → its plot manifest (for role/series/index part targeting). */
  plotManifest?: (assetId: string) => FluxPlotManifest | undefined;
  reducedMotion?: boolean;
  /** Documents advance exactly one authored beat per explicit action. */
  manualSteps?: boolean;
}

export { resolveEasing, resolveEasingFn } from "../easing";
import { resolveCurve, type ResolvedCurve } from "../curves";
import { compileSlide, type CompiledSlide, type AnimationIssue } from "../compile";
import { staggerRanks, staggerDelay, staggerSeed } from "../stagger";
import { cueEnd } from "../video";
import { isVideoCommand, type VideoEvent } from "../mediaTimeline";
import { createVideoController } from "./media";
import { createModel3dController, flushSlideModels } from "./model3d";

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
function manifestFor(target: string, slide: Slide, opts: PlayerOpts, beatIndex = 0): FluxPlotManifest | import('../../model3d/types').Scene3dManifest | undefined {
  const el = transformPreState(slide, target, beatIndex);
  const assetId = el && "assetId" in el ? (el as { assetId: string }).assetId : undefined;
  return assetId ? el?.type === 'model3d' ? opts.modelManifest?.(assetId) : opts.plotManifest?.(assetId) : undefined;
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

  // plot parts (a leaf id, a parts-tree group/container id → its leaf members
  // in tree order, several ids, or a role/series/index selector) resolve through
  // the ONE binding resolver the compiler uses (targets.targetPartIds) — a
  // track can never animate one set and be inspected as another. This is the
  // only path that reaches axis parts (spine/ticks/labels/gridlines live in the
  // parts tree, not the series part-index).
  if (hasPartBinding(track)) {
    const ids = targetPartIds(track, manifestFor(track.target, slide, opts, beatIndex));
    return ids
      .map((id) => content.querySelector<SVGElement>(`[id="${partDomId(track.target, id)}"]`))
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
  ease: ResolvedCurve;
  enter: boolean;
  /** The authoring identity (target+part+selector) all of a track's node-specs
   *  share. The RE-BASELINE window is computed per key, not per node, because an
   *  enter and a re-enter of the same logical target may resolve to different
   *  nodes (fade acts on the part's <g>, drawOn drills to its path). */
  key: string;
  prep?: () => void;
  /** Rebuild all camera frames from live FROM at play time, or restore on seek. */
  refreshCamera?: (transform?: string) => boolean;
  /** Exact transform for eased progress outside [0,1] (the camera's geometric path). */
  transformAt?: (u: number) => string;
  /** Present only for `morph` tracks — a data-space driver instead of keyframes. */
  morph?: MorphController;
  handoff?: HandoffController;
  trackId?: string;
  /** All expanded children share this compiled track, including id-less decks. */
  owner?: Track;
  preset?: string;
  baseStyle?: Record<string, string>;
}

// transformPreState moved to ../tween (pure) — the endpoint checkout and the
// player must share ONE fold. Re-exported for existing consumers/gates.
export { transformPreState } from "../tween";

type HandoffRecord = CompiledSlide["handoffs"][number];
const flightLayers = new WeakMap<Spec[], SVGSVGElement>();

/** Flatten a slide's beats → timed per-node specs (the static-state + play substrate). */
export function computeSlideAnims(slide: Slide, rendered: RenderedSlide, cameraLayer: HTMLElement, stage: StageSize, opts: PlayerOpts, compiled = compileSlide(slide, stage, opts)): Spec[] {
  slide = compiled.resolvedSlide;
  opts = { ...opts, ghostPartFactors: compiled.partFactors };
  const specs: Spec[] = [];
  for (const birth of compiled.births) {
    const el = slide.elements.find(e => e.id === birth.target), wrap = rendered.elements.get(birth.target);
    if (!el || !wrap) continue;
    // One materialization per slide build. Later seeks retain these exact nodes.
    if (rendered.sourceSlide !== slide) { wrap.replaceChildren(); fillContent(wrap, el, opts); applyWrapperBox(wrap, el); }
    specs.push({ node: wrap, beatIndex: birth.enabled ? birth.beat : Number.MAX_SAFE_INTEGER, keyframes: [{ visibility: "hidden" }, { visibility: "visible" }], delay: birth.start, duration: 0, ease: resolveCurve({ easing: "linear" }), enter: true, key: `ghost:${birth.target}`, trackId: birth.track.id });
  }
  const contentRoots = new Map<string, HTMLElement>();
  const manifest = opts.plotManifest ?? ((id: string) => get(plotManifests)[id]);
  const geometry = { manifest, plotRoot: opts.plotRoot ?? ((id: string) => plotDom.get(id)), groups: slide.groups };
  const handoffs: HandoffRecord[] = compiled.handoffs;
  const ctx: PresetCtx = { theme: opts.theme, stage };
  // Placement/rotation/opacity belong to the document wrapper. Appearance
  // effects operate on a child layer, so rising in cannot erase a concurrent
  // position change or an authored rotation/translucency.
  for (const cue of compiled.cues) for (const { track } of cue.tracks) {
    if (track.disabled || hasPartBinding(track) || !PRESET_WRAPPER_PROPS[track.preset ?? "fade"]) continue;
    const wrap = rendered.elements.get(track.target) as (HTMLElement & { __slideEffects?: HTMLElement }) | undefined;
    if (!wrap?.firstElementChild || wrap.__slideEffects) continue;
    const effects = document.createElement("div");
    effects.className = "sl-effects";
    effects.style.cssText = "position:absolute;inset:0;transform-origin:center center";
    while (wrap.firstChild) effects.appendChild(wrap.firstChild);
    wrap.appendChild(effects);
    wrap.__slideEffects = effects;
  }
  compiled.cues.forEach((cue, bi) => {
    for (const ct of cue.tracks) {
      const track = ct.track;
      // A disabled track keeps its authored timing in the deck but is invisible
      // to play/static/export — the non-destructive Mask/Show substrate.
      if (track.disabled || track.keyframes || isVideoCommand(track) || !KNOWN_PRESETS.has(track.preset ?? "fade")) continue;
      const key = trackKey(track);
      // transform — the state tween (rework §4). Pre = fold of earlier
      // transforms; end = pre ⊕ to.state. Plots may ALSO carry a content
      // morph target (to.assetId) — one track, both halves.
      if (track.preset === "transform") {
        const wrap = rendered.elements.get(track.target);
        const preEl = transformPreState(slide, track.target, bi);
        if (!wrap || !preEl) continue; // dangling target — tolerated no-op
        if (isHandoff(track)) {
          const handoff = handoffs.find(h => h.trackId === track.id && h.beat === bi);
          if (!handoff) continue;
          const preFrame = compiled.sample(bi, track.start ?? 0);
          const roots = new Map(contentRoots);
          const rootFor = (id: string) => roots.get(id) ?? rendered.elements.get(id);
          const nodesFor = (targets: ResolvedTarget[]): Element[] => targets.flatMap<Element>(target => {
            const root = rootFor(target.elementId), wrapper = rendered.elements.get(target.elementId);
            if (!root || !wrapper) return [];
            return target.partIds === null ? [wrapper] : target.partIds.flatMap(id => {
              const node = root.querySelector<SVGElement>(`[id="${partDomId(target.elementId, id).replace(/["\\]/g, "\\$&")}"]`);
              return node ? [node] : [];
            });
          });
          const sourceNodes = hasPartBinding(track) ? resolveNodes(track, slide, rendered, cameraLayer, opts, bi, contentRoots) : [wrap];
          const destinationNodes = nodesFor(handoff.destination);
          if (!sourceNodes.length || !destinationNodes.length) continue;
          // A whole model in ANY flight (part, group or multi-destination too)
          // needs the model clone: its DOM holds only furniture, never the mesh.
          // The live mount is limited to a whole 1:1 model pair.
          const elementOf = (id: string) => preFrame.elements.find(e => e.id === id);
          const whole = !hasPartBinding(track) && handoff.destination.length === 1 && handoff.destination[0].partIds === null;
          const modelFlight = [...handoff.source, ...handoff.destination].some(t => t.partIds === null && elementOf(t.elementId)?.type === "model3d");
          const driver = createHandoff({ flight: rendered.flight, sourceNodes, destinationNodes, spec: handoff.spec,
            plan: () => planHandoff(track, preFrame, geometry),
            media: modelFlight ? modelHandoffMedia(whole ? elementOf(track.target) : undefined, whole ? elementOf(handoff.destination[0].elementId) : undefined, preFrame.elements, opts) : undefined,
            ctx: {
              order: bi * 1e9 + (track.start ?? 0), targetRoot: rootFor(handoff.destination[0].elementId),
              node: owner => owner.partId ? rootFor(owner.elementId)?.querySelector(`[id="${partDomId(owner.elementId, owner.partId).replace(/["\\]/g, "\\$&")}"]`) ?? undefined : rootFor(owner.elementId),
              crop: owner => {
                const el = preFrame.elements.find(e => e.id === owner.elementId);
                return el?.type === "plot" && el.crop ? el : undefined;
              },
            },
          });
          // The surviving content belongs to the destination identity. Never
          // redirect later source tracks into that other element's DOM.
          if (driver.targetRoot && handoff.destination.length === 1) contentRoots.set(handoff.destination[0].elementId, driver.targetRoot);
          specs.push({ node: sourceNodes[0] as TargetNode, beatIndex: bi, keyframes: [], enter: false, key, trackId: track.id, owner: track,
            delay: ct.start, duration: ct.duration,
            ease: ct.ease,
            morph: driver, handoff: driver });
          if (handoff.spec.reveal === "draw") {
            const draw = { ...track, preset: "drawOn" as const, params: undefined };
            for (const na of PRESETS.drawOn(destinationNodes as TargetNode[], draw, ctx)) specs.push({
              node: na.node, beatIndex: bi, keyframes: na.keyframes, enter: na.enter,
              key: `handoff-draw:${track.id}`, prep: na.prep, preset: "drawOn", trackId: track.id, owner: track,
              delay: ct.start + ct.duration, duration: DUR.gentle,
              ease: resolveCurve(draw),
            });
          }
          continue;
        }
        const endEl = transformEndState(preEl, track);
        const driver = createTransform(wrap, preEl, endEl, {
          arc: track.arc,
          theme: opts.theme, assetUrl: opts.assetUrl, assetSize: opts.assetSize,
          plotGen: opts.plotGen, deckBackground: opts.deckBackground, mode: opts.mode,
          videoPlayback: opts.videoPlayback,
          model3d: opts.model3d, modelAsset: opts.modelAsset, modelManifest: opts.modelManifest,
          modelPoster: opts.modelPoster, pixelScale: opts.pixelScale,
          plotRoot: opts.plotRoot, plotManifest: opts.plotManifest, contentHost: contentRoots.get(track.target),
          ghostPartFactors: opts.ghostPartFactors,
        });
        if (driver.targetRoot) contentRoots.set(track.target, driver.targetRoot);
        specs.push({
          node: wrap, beatIndex: bi, keyframes: [], enter: false, key, trackId: track.id, owner: track,
          delay: ct.start, duration: ct.duration,
          ease: ct.ease,
          morph: driver,
        });
        continue;
      }
      // countUp — a number-tween driver sharing the morph plumbing (rAF play,
      // static seek 0|1, reduced-motion snap). Targets the first resolved node;
      // for a text element, drill to the innermost tspan/text node so writing
      // the tween text doesn't flatten the rendered markup.
      if (track.preset === "countUp") {
        let node = resolveNodes(track, slide, rendered, cameraLayer, opts, bi, contentRoots)[0];
        if (!hasPartBinding(track)) node = contentRoots.get(track.target) ?? node;
        const leaves = Array.from((node as HTMLElement | undefined)?.querySelectorAll?.("tspan") ?? []);
        const textNode = leaves.find((n) => /\d/.test(n.textContent ?? "")) ?? leaves[0] ??
          (node as HTMLElement | undefined)?.querySelector?.("text");
        if (textNode) node = textNode as unknown as HTMLElement;
        if (node) {
          specs.push({
            node, beatIndex: bi, keyframes: [], enter: false, key, trackId: track.id, owner: track,
            delay: ct.start, duration: ct.duration,
            ease: ct.ease,
            morph: createCountUp(node, track),
          });
        }
        continue;
      }
      const nodes = resolveNodes(track, slide, rendered, cameraLayer, opts, bi, contentRoots);
      if (!nodes.length) continue;
      const preset = PRESETS[track.preset ?? "fade"] ?? PRESETS.fade;
      const nodeAnims = preset(nodes, track, track.preset === "camera" ? {
        ...ctx, cameraFrom: compiled.sample(bi, ct.start).camera ?? { x: stage.width / 2, y: stage.height / 2, zoom: 1 },
      } : ctx);
      const n = nodes.length;
      const from = track.stagger?.from ?? "start";
      const by = track.stagger?.by;
      const ranks = track.stagger ? staggerRanks(n, from, by === "x" || by === "y" ? nodes.map((node) => spatialCoord(node, by)) : undefined, staggerSeed(track), track.stagger?.totalMs !== undefined) : [];
      // Mesh targets have no DOM nodes. Furniture in the same binding keeps
      // its rank among ALL semantic leaves, exactly as the mesh sampler does.
      const modelParts = hasPartBinding(track) && transformPreState(slide, track.target, bi)?.type === 'model3d';
      const semanticRank = modelParts ? new Map(ct.parts.map((id, i) => [partDomId(track.target, id), ct.ranks[i]])) : undefined;
      const maxRank = modelParts ? ct.maxRank : Math.max(0, ...ranks);
      nodeAnims.forEach((na) => {
        specs.push({
          node: na.node,
          beatIndex: bi,
          keyframes: na.keyframes,
          delay: ct.start + staggerDelay(track, semanticRank?.get(na.node.id) ?? ranks[na.index] ?? 0, maxRank),
          duration: ct.duration,
          ease: ct.ease,
          enter: na.enter,
          key,
          prep: na.prep,
          refreshCamera: na.refreshCamera,
          transformAt: na.transformAt,
          trackId: track.id, owner: track,
          preset: track.preset,
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
  flightLayers.set(specs, rendered.flight);
  return specs;
}

const ANIM_PROPS = ["opacity", "transform", "visibility", "clipPath", "strokeDashoffset", "strokeDasharray", "strokeLinecap", "transformOrigin"] as const;
const SVG_NS = "http://www.w3.org/2000/svg";
/** How a keyframed spec moves its node: a flight whose keyframes differ only
 *  in translate() rides a compositor layer while it plays (render.ts layer
 *  hygiene — the camera pan, `move`, fadeRise's lift); one that scales or
 *  rotates paints in place. */
function transformFlight(keyframes: Keyframe[]): "none" | "translate" | "other" {
  const frames = keyframes.filter((k) => "transform" in k);
  if (!frames.length) return "none";
  const rest = frames.map((k) => [...String(k.transform).matchAll(/([\w-]+)\(([^)]*)\)/g)].filter((m) => !m[1].startsWith("translate")).map((m) => m[0]).join(" "));
  return rest.every((r) => r === rest[0]) ? "translate" : "other";
}
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
interface BoundNode { node: TargetNode; keyframed: Spec[]; properties: string[]; blockers: Map<Spec, Spec[]>; controllers: Spec[]; lastController: number; flights: Map<Spec, "translate" | "other">; glides: boolean }
interface BoundPlan { nodes: BoundNode[]; natives: Map<Spec, Animation>; samplers: Map<Spec, (t: number) => Keyframe> }
const bindings = new WeakMap<Spec[], BoundPlan>();
function numericSampler(a: unknown, b: unknown): { sample: (t: number) => string | number; discrete: boolean } {
  if (typeof a === "number" && typeof b === "number") return { sample: (t) => a + (b - a) * t, discrete: false };
  const sa = String(a ?? ""), sb = String(b ?? "");
  const rx = /(-?(?:\d*\.)?\d+(?:e[-+]?\d+)?)([a-z%]*)/gi;
  const aParts = [...sa.matchAll(rx)], bParts = [...sb.matchAll(rx)];
  const na = aParts.map(m => Number(m[1])), nb = bParts.map(m => Number(m[1]));
  // A unitless zero endpoint still needs its other endpoint's unit in flight.
  const units = bParts.map((m, i) => m[2] || aParts[i]?.[2] || "");
  if (na.length && na.length === nb.length) return { sample: (t) => { let i = 0; return sb.replace(rx, () => String(na[i] + (nb[i] - na[i]) * t) + units[i++]); }, discrete: false };
  return { sample: (t) => t < .5 ? sa : sb, discrete: true };
}
function frameSampler(spec: Spec): (t: number) => Keyframe {
  const frames = spec.keyframes;
  const properties = [...new Set(frames.flatMap(frame => Object.keys(frame).filter(p => !["offset", "easing", "composite"].includes(p))))];
  const channels = properties.map(property => {
    const points = frames.flatMap((frame, i) => property in frame
      ? [{ at: Number(frame.offset ?? i / (frames.length - 1)), value: (frame as Record<string, unknown>)[property] }] : []);
    const segments = points.slice(1).map((point, i) => ({ from: points[i].at, to: point.at, ...numericSampler(points[i].value, point.value) }));
    return { property, box: property === "transform",
      // Non-numeric values (including named colors) are discrete channels too.
      discrete: property === "visibility" || property === "strokeLinecap" || property === "transformOrigin" || segments.some(s => s.discrete),
      segments,
      constant: points[0]?.value };
  });
  const frame: Record<string, unknown> = {};
  return (raw) => {
    if (raw <= 0) return frames[0];
    if (raw >= 1) return frames.at(-1)!;
    const u = spec.ease.fn(raw), t = spec.ease.clamped(raw);
    for (const channel of channels) {
      const progress = channel.discrete ? raw : channel.box ? u : t;
      // Overshoot leaves the keyframed range: a spec that knows its exact path
      // (the camera) samples it instead of extrapolating the last segment.
      if (channel.box && spec.transformAt && (u < 0 || u > 1)) { frame[channel.property] = spec.transformAt(u); continue; }
      const segments = channel.segments;
      if (!segments.length) { frame[channel.property] = channel.constant; continue; }
      let i = 0;
      while (i < segments.length - 1 && progress > segments[i].to) i++;
      const segment = segments[i];
      const local = (progress - segment.from) / (segment.to - segment.from || 1);
      frame[channel.property] = segment.sample(channel.box ? local : Math.max(0, Math.min(1, local)));
    }
    return frame as Keyframe;
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
    const flights = new Map<Spec, "translate" | "other">();
    for (const s of keyframed) { const kind = transformFlight(s.keyframes); if (kind !== "none") flights.set(s, kind); }
    return { node, keyframed, properties: [...properties], blockers, controllers: list.filter((s) => s.morph), lastController: -2, flights, glides: [...flights.values()].includes("translate") };
  }), natives: new Map(), samplers: new Map() };
  // Materialize content layers in story order before a first random seek.
  // Otherwise seeking directly to a late text change could nest its layer
  // underneath an earlier change which is only materialized afterwards.
  for (const group of plan.nodes) for (const controller of group.controllers) controller.morph!.seek(0, 0);
  for (const spec of specs) if (spec.keyframes.length) plan.samplers.set(spec, frameSampler(spec));
  bindings.set(specs, plan);
  return plan;
}
export function disposeSlideAnims(specs: Spec[], releaseControllers = true): void {
  const plan = bindings.get(specs);
  if (plan) {
    for (const animation of plan.natives.values()) { try { animation.cancel(); } catch { /* detached */ } }
    // a slide torn down mid-flight leaves no promoted node behind
    for (const group of plan.nodes) if (group.node.namespaceURI !== SVG_NS) releaseFlightMark(group.node as HTMLElement);
  }
  if (releaseControllers) {
    for (const spec of specs) spec.morph?.dispose?.();
    flightLayers.get(specs)?.replaceChildren();
    flightLayers.delete(specs);
  }
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
    return later && (!spec.owner || spec.owner !== later.owner) && (spec.beatIndex < later.beatIndex || spec.beatIndex === later.beatIndex && spec.delay < later.delay);
  };
  const activeNatives = new Set<Spec>();
  // Content writes establish this frame's paint before part appearances
  // factor it, even when the appearance precedes a Change in story order.
  for (const group of plan.nodes) {
    const { controllers } = group;
    if (controllers.length) {
      let selected = -1;
      for (let i = 0; i < controllers.length; i++) if (progressAt(controllers[i], beat, time) >= 0) selected = i;
      if (selected !== group.lastController) {
        // Reset future crossfade layers outside-in before applying the past.
        // Their DOM is retained so inner-node animation bindings survive.
        for (let i = controllers.length - 1; i >= 0; i--) controllers[i].morph!.seek(0, 0);
        for (let i = 0; i < selected; i++) controllers[i].morph!.seek(1, 1);
        group.lastController = selected;
      }
      if (selected >= 0) {
        const spec = controllers[selected], p = progressAt(spec, beat, time);
        spec.morph!.seek(spec.ease.fn(p), p);
      } else controllers[0].morph!.seek(0, 0);
    }
  }
  for (const group of plan.nodes) {
    const { node, keyframed, properties, flights, glides } = group;
    if (!keyframed.length) continue;
    clearAnimStyles(node, properties);
    const base = keyframed[0].baseStyle;
    if (base) for (const key of properties) if (base[key]) (node.style as unknown as Record<string, string>)[key] = base[key];
    const applied: Spec[] = [];
    // transform flights in progress on this node: all translation-only → the
    // node rides its own layer this frame (render.ts layer hygiene)
    let moving = 0, pureMoves = 0;
    for (const spec of keyframed) {
      const p = progressAt(spec, beat, time);
      if (superseded(spec)) continue;
      // Completed draw-on contributes no temporary dash/cap styling. The
      // authored resting attributes remain correct after any later geometry change.
      if (!(p >= 1 && spec.preset === "drawOn")) spec.prep?.();
      if (p < 0) {
        if (!applied.length && spec === keyframed[0] && spec.enter) applied.push({ ...spec, keyframes: [spec.keyframes[0]] });
        continue;
      }
      const sampled = plan.samplers.get(spec)!(p);
      const frame = p >= 1 && spec.preset === "drawOn"
        ? Object.fromEntries(Object.entries(sampled).filter(([property]) => !["strokeDashoffset", "strokeDasharray", "strokeLinecap"].includes(property)))
        : sampled;
      applied.push({ ...spec, keyframes: [frame] });
      const flight = p > 0 && p < 1 ? flights.get(spec) : undefined;
      if (flight) { moving++; if (flight === "translate") pureMoves++; }
      // Use native effects for active frames when available. Their time is
      // explicitly controlled; no independent WAAPI clock can drift from data.
      if (native && p > 0 && p < 1 && typeof node.animate === "function" && !spec.keyframes.some((k) => "transform" in k) && !group.blockers.get(spec)?.some((later) => progressAt(later, beat, time) >= 0)) {
        let animation = plan.natives.get(spec);
        if (!animation) {
          animation = node.animate(spec.keyframes, { duration: spec.duration, easing: spec.ease.css, fill: "both" });
          animation.pause();
          animation.finished.catch(() => {});
          plan.natives.set(spec, animation);
        }
        animation.currentTime = p * spec.duration;
        activeNatives.add(spec);
      }
    }
    if (applied.length) applyAccumulated(node, applied);
    if (node.namespaceURI !== SVG_NS) {
      if (moving && moving === pureMoves) promoteMovingWrapper(node as HTMLElement);
      else { settleWrapper(node as HTMLElement); if (glides) armFlightMark(node as HTMLElement); }
    }
  }
  for (const [spec, animation] of plan.natives) if (!activeNatives.has(spec)) { animation.cancel(); plan.natives.delete(spec); }
  for (const spec of specs) if (spec.handoff && superseded(spec)) spec.handoff.releaseSource();
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
  /** Native clips continue while the presenter waits between animation steps. */
  mediaPlaying: boolean;
  mediaPaused: boolean;
  issues: AnimationIssue[];
}
type Ev = "change" | "beatStart" | "beatEnd" | "frame";
export interface PlayRange { slide: number; fromBeat?: number; toBeat?: number; loop?: boolean }
export interface Player {
  goTo(slide: number, beat: number, opts?: { animate?: boolean }): void;
  /** Capture samples its absolute media clock separately, avoiding two decoder
   * seeks (static beat time followed by output time) for the same frame. */
  seek(slide: number, beat: number, timeMs: number, fromBeat?: number, sampleMedia?: boolean): void;
  beatDurations(): number[];
  readyMedia(): Promise<unknown>;
  captureMedia(events: readonly VideoEvent[], timeMs: number): Promise<void>;
  /** Repaint at the current time after the host's stage fit/DPR changes. */
  refresh(): void;
  play(range: PlayRange): void;
  pause(): void;
  resume(): void;
  stop(): void;
  next(opts?: { animate?: boolean }): void;
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
  let media: ReturnType<typeof createVideoController> | undefined;
  let models: ReturnType<typeof createModel3dController> | undefined;
  let modelAppearance: CompiledSlide | undefined;
  let auto: ReturnType<typeof setTimeout> | undefined;
  let range: PlayRange | null = null;
  let transition: Animation | null = null;
  const ctx: SlideRenderCtx = { ...opts, deckBackground: deck.background, videoPlayback: true };
  const beats = () => Math.max(1, deck.slides[si]?.beats.length ?? 0);
  function state(): PlayerState { return { slide: si, beat: bi, totalBeats: beats(), totalSlides: deck.slides.length, time, duration, playing, issues, ...(media?.state() ?? { mediaPlaying: false, mediaPaused: false }) }; }
  const emit = (event: Ev) => { const value = state(); for (const listener of listeners[event]) listener(value); };
  function cancelClock(): void {
    generation++; if (raf) cancelAnimationFrame(raf); raf = 0;
    clearTimeout(auto); auto = undefined; playing = false;
    transition?.cancel(); transition = null;
  }
  function build(index: number): void {
    if (index === si) return;
    selectRun(-1, -1);
    disposeSlideAnims(specs);
    media?.destroy(); media = undefined;
    models?.destroy(); models = undefined;
    modelAppearance = undefined;
    si = index;
    const slide = deck.slides[si];
    if (!slide) { specs = []; durations = [0]; return; }
    mount.style.background = slide.background ?? deck.background ?? opts.theme.background;
    const compiled = compileSlide(slide, stage, { ...opts, animStyles: deck.animStyles });
    const modelIds = new Set(compiled.resolvedSlide.elements.filter(el => el.type === 'model3d').map(el => el.id));
    if (compiled.cues.some(cue => cue.tracks.some(ct => ct.parts.length && compiled.preState(ct.track.target, ct.beat)?.type === 'model3d')) || Object.keys(compiled.partFactors).some(id => modelIds.has(id))) modelAppearance = compiled;
    const rendered = renderSlide(cameraLayer, compiled.resolvedSlide, stage, { ...ctx, ghostPartFactors: compiled.partFactors });
    cameraLayer.style.transform = baseCameraTransform(slide, stage);
    issues = compiled.issues;
    specs = computeSlideAnims(slide, rendered, cameraLayer, stage, { ...opts, videoPlayback: true }, compiled);
    models = createModel3dController(cameraLayer, compiled.resolvedSlide, ctx, (target, reason) => {
      if (!issues.some(issue => issue.target === target && issue.reason === reason)) issues = [...issues, { target, reason }];
      emit('change');
    });
    durations = Array.from({ length: beats() }, (_, beat) => Math.max(0, compiled.cues[beat]?.duration ?? 0, ...specs.filter((s) => s.beatIndex === beat).map((s) => s.delay + s.duration)));
    media = createVideoController(cameraLayer, compiled.resolvedSlide, durations, !!opts.manualSteps, () => emit("change"), (target, reason) => {
      if (!issues.some(issue => issue.target === target && issue.reason === reason)) issues = [...issues, { target, reason }];
      emit("change");
    }, compiled.cues.map(c => c.tracks.map(t => t.track)));
  }
  function paint(native = false): void {
    applyAt(runSpecs ?? specs, bi, time, native);
    // Mesh parts sample the same run as the re-based DOM specs (selectRun).
    models?.flush(modelAppearance?.sample(bi, time, runFrom).partStates);
    if (playing) media?.tick(time);
    emit("frame");
  }
  let runSpecs: Spec[] | null = null;
  let runKey = "";
  /** First beat of the concurrent run ending at `bi` (a with-prev cue). */
  let runFrom: number | undefined;
  function selectRun(from: number, to: number): void {
    const key = from < to ? `${si}:${from}:${to}` : "";
    if (key === runKey) return;
    if (runSpecs) { disposeSlideAnims(runSpecs, false); for (const node of bindings.get(specs)?.nodes ?? []) node.lastController = -2; }
    runKey = key;
    runFrom = from < to ? from : undefined;
    runSpecs = from < to ? specs.map((s) => s.beatIndex >= from && s.beatIndex <= to ? { ...s, beatIndex: to } : s) : null;
  }
  function scheduleAuto(): void {
    if (opts.manualSteps) return;
    const next = deck.slides[si]?.beats[bi + 1];
    if (next?.advance === "auto") {
      const stamp = generation;
      auto = setTimeout(() => { if (stamp === generation) nextCue(); }, beatDelayMs(next));
    }
  }
  function finish(): void {
    const session = generation;
    media?.tick(duration);
    playing = false; raf = 0; time = duration; paint(); emit("beatEnd"); emit("change");
    if (session !== generation) return; // a listener stopped/started another run
    if (range) {
      const last = Math.min(beats() - 1, range.toBeat ?? beats() - 1);
      if (bi < last) { begin(bi + 1, bi + 1); return; }
      const first = Math.max(0, Math.min(beats() - 1, range.fromBeat ?? Math.min(1, beats() - 1)));
      if (range.loop && durations.slice(first, last + 1).some((d) => d > 0)) { media?.seek(first - 1, Infinity); begin(first, first); return; }
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
  function begin(from: number, to: number, instant = false): void {
    cancelClock();
    const session = generation;
    // Parsing/upload is completed before starting the authored clock. A later
    // navigation/cancel owns a new generation and cannot start this old cue.
    if (models && !models.isReady() || specs.some(spec => spec.handoff && !spec.handoff.isReady())) {
      const resumeReady = () => { if (session === generation) begin(from, to, instant); };
      void Promise.all([models?.ready(), ...specs.flatMap(spec => spec.handoff ? [spec.handoff.ready()] : [])]).then(resumeReady, resumeReady);
      return;
    }
    bi = Math.max(0, Math.min(beats() - 1, to));
    selectRun(from, bi);
    // Camera keyframes remain ordinary transform flights. Rebase once before
    // binding, never during sampling; later moves start at the preceding end.
    let cameraFrom = cameraLayer.style.transform, cameraChanged = false;
    for (const spec of (runSpecs ?? specs).filter(s => s.refreshCamera && s.beatIndex === bi).sort((a, b) => a.delay - b.delay)) {
      cameraChanged = spec.refreshCamera!(cameraFrom) || cameraChanged;
      cameraFrom = String(spec.keyframes.at(-1)!.transform);
    }
    // Samplers and natives only: hand-off controllers own flight layers and
    // visibility claims that must outlive a camera rebase.
    if (cameraChanged) { disposeSlideAnims(specs, false); if (runSpecs) disposeSlideAnims(runSpecs, false); }
    duration = Math.max(0, ...durations.slice(from, bi + 1));
    time = 0;
    playing = true;
    media?.begin(from, bi);
    paint(); emit("beatStart"); emit("change");
    if (session !== generation) return;
    if (reduced || instant || !duration) { finish(); return; }
    origin = performance.now();
    queueFrame();
  }
  function seek(index: number, beat: number, ms: number, fromBeat = beat, sampleMedia = true): void {
    cancelClock(); range = null;
    build(Math.max(0, Math.min(deck.slides.length - 1, index)));
    bi = Math.max(0, Math.min(beats() - 1, beat));
    const from = Math.max(0, Math.min(bi, fromBeat));
    selectRun(from, bi);
    let cameraChanged = false;
    for (const spec of specs) if (spec.refreshCamera) cameraChanged = spec.refreshCamera() || cameraChanged;
    if (cameraChanged) { disposeSlideAnims(specs, false); if (runSpecs) disposeSlideAnims(runSpecs, false); }
    duration = Math.max(0, ...durations.slice(from, bi + 1)); time = Math.max(0, Math.min(duration, ms));
    if (sampleMedia) media?.seek(bi, ms, from);
    paint(); emit("change");
  }
  function goTo(index: number, beat: number, config: { animate?: boolean } = {}): void {
    const changed = index !== si, forward = index >= si;
    if (config.animate && !changed && beat > bi) { range = null; begin(beat, beat); return; }
    seek(index, beat, Infinity);
    const kind = deck.slides[si]?.transition ?? deck.defaults?.transition ?? "none";
    if (!opts.manualSteps && changed && !reduced && kind !== "none" && typeof cameraLayer.animate === "function") {
      transition = kind === "fade" ? animate(cameraLayer, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.gentle, reduce: false }) : animate(mount, [{ transform: `translateX(${forward ? stage.width : -stage.width}px)` }, { transform: "translateX(0px)" }], { duration: DUR.gentle, reduce: false });
    }
    scheduleAuto();
  }
  function nextCue(config: { animate?: boolean } = {}): void {
    range = null;
    if (opts.manualSteps && playing) { seek(si, bi, Infinity); return; }
    if (bi >= beats() - 1) { if (!opts.manualSteps) nextSlide(); return; }
    let end = bi + 1;
    if (!opts.manualSteps) end = cueEnd(deck.slides[si], end);
    begin(bi + 1, end, config.animate === false);
  }
  function prev(): void {
    if (bi <= 0) { if (!opts.manualSteps) prevSlide(); return; }
    let start = bi;
    while (!opts.manualSteps && start > 0 && deck.slides[si].beats[start]?.advance === "with-prev") start--;
    seek(si, Math.max(0, start - 1), Infinity);
  }
  function nextSlide(): void { if (si < deck.slides.length - 1) goTo(si + 1, 0); }
  function prevSlide(): void { if (si > 0) goTo(si - 1, Math.max(0, deck.slides[si - 1].beats.length - 1)); }
  function play(request: PlayRange): void {
    cancelClock(); build(Math.max(0, Math.min(deck.slides.length - 1, request.slide)));
    range = { ...request };
    const from = Math.max(0, Math.min(beats() - 1, request.fromBeat ?? Math.min(1, beats() - 1)));
    media?.seek(from - 1, Infinity);
    begin(from, from);
  }
  function pause(): void { cancelClock(); media?.pause(true); paint(); emit("change"); }
  function resume(): void {
    media?.pause(false);
    if (playing || time >= duration) return;
    clearTimeout(auto); playing = true; origin = performance.now() - time;
    const session = generation;
    emit("change"); if (session === generation) queueFrame();
  }
  function stop(): void { seek(si, bi, 0); media?.stop(); emit("change"); }
  function setMediaPaused(paused: boolean): void {
    media?.pause(paused, "host");
  }
  function on(event: Ev, listener: (s: PlayerState) => void): () => void { listeners[event].add(listener); return () => listeners[event].delete(listener); }
  function destroy(): void { cancelClock(); media?.destroy(); media = undefined; models?.destroy(); models = undefined; disposeSlideAnims(specs); if (runSpecs) disposeSlideAnims(runSpecs, false); mount.replaceChildren(); document.removeEventListener("visibilitychange", visibility); for (const set of Object.values(listeners)) set.clear(); }
  const visibility = () => media?.pause(document.hidden, "document");
  document.addEventListener("visibilitychange", visibility);
  if (deck.slides.length) goTo(0, 0);
  return { goTo, seek, refresh: () => paint(), beatDurations: () => [...durations], readyMedia: () => Promise.all([media?.ready(), models?.ready(), ...specs.flatMap(spec => spec.handoff ? [spec.handoff.ready()] : [])]), captureMedia: async (events, ms) => { await Promise.all([media?.capture(events, ms), ...specs.flatMap(spec => spec.handoff ? [spec.handoff.ready()] : [])]); await models?.settled(); }, play, pause, resume, stop, next: nextCue, prev, nextSlide, prevSlide, state, setMediaPaused, on, destroy };
}

/** The same evaluated endpoint as live playback; camera included. */
export function renderStaticAt(host: HTMLElement, slide: Slide, stage: StageSize, beat: number, opts: PlayerOpts): RenderedSlide {
  // Static thumbnails and next-slide views never allocate a GPU host or decoder.
  opts = { ...opts, model3d: undefined, videoPlayback: false };
  // The host's transform belongs to its fit/thumbnail scale. Camera motion
  // gets a separate layer exactly as it does in createPlayer.
  host.replaceChildren();
  const camera = document.createElement("div");
  camera.className = "sl-camera";
  camera.style.transformOrigin = "0 0";
  host.appendChild(camera);
  const compiled = compileSlide(slide, stage, opts);
  const rendered = renderSlide(camera, compiled.resolvedSlide, stage, { ...opts, ghostPartFactors: compiled.partFactors });
  camera.style.transform = baseCameraTransform(slide, stage);
  const specs = computeSlideAnims(slide, rendered, camera, stage, opts, compiled);
  applyStatic(specs, beat);
  // Stills carry the step's mesh-part appearance too (bindings + poster keys).
  flushSlideModels(camera, compiled.resolvedSlide.elements.some(el => el.type === "model3d") ? compiled.sample(beat).partStates : undefined);
  // Dispose owns restoration of live controllers. Bake the sampled visibility
  // into a still before releasing those leases, just as keyframe styles remain.
  const visibility = (specs.some(spec => spec.handoff) ? Array.from(camera.querySelectorAll<HTMLElement | SVGElement>("[style]")) : [])
    .map(node => ({ node, value: node.style.getPropertyValue("visibility"), priority: node.style.getPropertyPriority?.("visibility") ?? "" }));
  disposeSlideAnims(specs); // a still: nothing armed or bound outlives it
  for (const { node, value, priority } of visibility) {
    if (value) node.style.setProperty("visibility", value, priority); else node.style.removeProperty("visibility");
  }
  return rendered;
}
