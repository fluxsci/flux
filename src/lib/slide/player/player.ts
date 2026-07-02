// ---------------------------------------------------------------------------
// Flux Slide — the player runtime (§5). Framework-agnostic (no Svelte): the ONE
// engine that drives the editor's beat preview, in-app present mode, and the
// exported HTML. It renders a slide through the one renderer, resolves each
// track to DOM nodes + a preset's keyframes, and owns:
//   • static-state — the deterministic resting look at any (slide, beat): apply
//     every track up to that beat at its END (O(1) nav, the basis for export
//     frame-stepping + thumbnails; §4.2).
//   • the sequencer — forward nav PLAYS a beat's tracks via WAAPI (start→delay,
//     duration, easing, fill:both), folding `with-prev` beats and auto-advancing
//     `auto` beats; back nav jumps to the prior static state.
//   • interruptible (P4): next/prev mid-beat cancels in-flight anims and snaps to
//     the static state. Reduced-motion (P6): durations→0 via animate().
// ---------------------------------------------------------------------------

import { DUR } from "../../motion/tokens";
import { smoothEasing, EASE, smoothstep, influenceToCss, influenceToBezier, cubicBezierFn } from "../../motion/tokens";
import { animate, prefersReducedMotion } from "../../motion/motion";
import { buildPartIndex } from "../../plot/parse";
import { resolveTargets } from "../../plot/tree";
import type { FluxPlotManifest } from "../../plot/types";
import { renderSlide, type SlideRenderCtx, type RenderedSlide } from "./render";
import { PRESETS, type TargetNode, type PresetCtx, type NodeAnim } from "./presets";
import { createMorph, morphCompatible, type MorphController } from "./morph";
import { createCountUp } from "./countup";
import type { Deck, Slide, Track, EasingToken, Influence, StageSize, DeckTheme, TransitionKind } from "../types";

/** A unified handle the sequencer awaits + can interrupt — a WAAPI Animation or
 *  the morph's rAF driver both satisfy it. */
interface Playable { finished: Promise<unknown>; cancel(): void }

const SEP = "__"; // mirrors plot/parse prefixIds — plot part DOM id = `${elId}__${semanticId}`

export interface PlayerOpts extends Omit<SlideRenderCtx, "theme"> {
  theme: DeckTheme;
  /** assetId → its plot manifest (for role/series/index part targeting). */
  plotManifest?: (assetId: string) => FluxPlotManifest | undefined;
  reducedMotion?: boolean;
}

export function resolveEasing(tok?: EasingToken, inf?: Influence): string {
  // an explicit AE-style influence profile overrides the named token
  if (inf && (inf.in > 0 || inf.out > 0)) return influenceToCss(inf);
  if (tok === "smooth") return smoothEasing();
  if (tok === "linear") return "linear";
  return EASE[tok ?? "standard"] ?? EASE.standard;
}

/** The same easing as a JS sampler y(t) — for the morph driver, which eases time
 *  in rAF (not via WAAPI), so it honours the same influence profile as keyframes. */
export function resolveEasingFn(tok?: EasingToken, inf?: Influence): (t: number) => number {
  if (inf && (inf.in > 0 || inf.out > 0)) return cubicBezierFn(influenceToBezier(inf));
  if (tok === "linear") return (t) => t;
  return smoothstep; // smooth/standard/enter/exit keep manim's easy-ease for morph
}

// --- target resolution -------------------------------------------------------
function staggerRank(i: number, n: number, from: string): number {
  const mid = (n - 1) / 2;
  switch (from) {
    case "end": return n - 1 - i;
    case "center": return Math.round(Math.abs(i - mid));
    case "edges": return Math.round(mid - Math.abs(i - mid));
    default: return i; // "start"
  }
}

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

/** Each node's 0..n-1 position along the stagger key. "x"/"y" sort by spatial
 *  coordinate (points without one keep array order, after the located ones);
 *  everything else keeps array order. `from` then sets direction (start/end/…). */
function orderRanks(nodeAnims: NodeAnim[], by: string): number[] {
  if (by !== "x" && by !== "y") return nodeAnims.map((na) => na.index);
  const coords = nodeAnims.map((na) => spatialCoord(na.node, by));
  const order = nodeAnims.map((_, i) => i).sort((a, b) => {
    const ca = coords[a], cb = coords[b];
    if (ca == null && cb == null) return a - b;
    if (ca == null) return 1;
    if (cb == null) return -1;
    return ca - cb || a - b;
  });
  const rank = new Array<number>(nodeAnims.length);
  order.forEach((origIdx, r) => { rank[origIdx] = r; });
  return rank;
}

/** The plot manifest backing a slide element (its assetId → manifest), or none. */
function manifestFor(target: string, slide: Slide, opts: PlayerOpts): FluxPlotManifest | undefined {
  const el = slide.elements.find((e) => e.id === target);
  const assetId = el && "assetId" in el ? (el as { assetId: string }).assetId : undefined;
  return assetId ? opts.plotManifest?.(assetId) : undefined;
}

/** A track → the DOM nodes it animates (whole element, text blocks, a plot part,
 *  a plot part-set by role/series/index, or the camera layer). */
function resolveNodes(track: Track, slide: Slide, rendered: RenderedSlide, cameraLayer: HTMLElement, opts: PlayerOpts): TargetNode[] {
  if (track.target === "@camera" || track.target === "@stage") return [cameraLayer];
  const wrap = rendered.elements.get(track.target);
  if (!wrap) return [];

  // text-box blocks (reveal bullets)
  if (track.selector?.blocks) {
    const blocks = Array.from(wrap.querySelectorAll<HTMLElement>(".sl-block"));
    if (track.selector.blocks === "all") return blocks;
    const want = new Set(track.selector.blocks);
    return blocks.filter((b) => want.has(b.dataset.blockId ?? ""));
  }

  // a plot part OR a part-GROUP by parts-tree id: a leaf id → that one node; a
  // group/container id (e.g. "axis.x", "series.main.point-group") → every leaf
  // member, in tree order. This is the only path that reaches axis parts (spine/
  // ticks/labels/gridlines live in the parts tree, not the series part-index).
  if (track.part) {
    const ids = resolveTargets(manifestFor(track.target, slide, opts), track.part);
    return ids
      .map((id) => wrap.querySelector<SVGElement>(`[id="${track.target}${SEP}${id}"]`))
      .filter((n): n is SVGElement => !!n);
  }

  // a plot part-set by role / series / index
  const sel = track.selector;
  if (sel && (sel.role || sel.series || sel.index != null)) {
    const idx = buildPartIndex(manifestFor(track.target, slide, opts));
    const wantIdx = sel.index == null ? null : new Set(Array.isArray(sel.index) ? sel.index : [sel.index]);
    const parts = Object.values(idx)
      .filter((p) => (!sel.role || p.role === sel.role) && (!sel.series || p.series === sel.series) && (!wantIdx || (p.index != null && wantIdx.has(p.index))))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return parts
      .map((p) => wrap.querySelector<SVGElement>(`[id="${track.target}${SEP}${p.id}"]`))
      .filter((n): n is SVGElement => !!n);
  }

  // whole element
  return [wrap];
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
}

/** Flatten a slide's beats → timed per-node specs (the static-state + play substrate). */
export function computeSlideAnims(slide: Slide, rendered: RenderedSlide, cameraLayer: HTMLElement, stage: StageSize, opts: PlayerOpts): Spec[] {
  const specs: Spec[] = [];
  const ctx: PresetCtx = { theme: opts.theme, stage };
  slide.beats.forEach((beat, bi) => {
    for (const track of beat.tracks) {
      // A disabled track keeps its authored timing in the deck but is invisible
      // to play/static/export — the non-destructive Mask/Show substrate.
      if (track.disabled) continue;
      const key = `${track.target}|${track.part ?? ""}|${JSON.stringify(track.selector ?? null)}`;
      // morph — a data-space driver over a plot element (not keyframe-based).
      if (track.preset === "morph") {
        const wrap = rendered.elements.get(track.target);
        const el = slide.elements.find((e) => e.id === track.target);
        const fromId = el && "assetId" in el ? (el as { assetId: string }).assetId : undefined;
        const toId = track.to?.assetId;
        const A = fromId ? opts.plotManifest?.(fromId) : undefined;
        const B = toId ? opts.plotManifest?.(toId) : undefined;
        // SLD-8: only run the morph when the two plots are structurally compatible. An
        // incompatible pair (disjoint series, or a non-point target like a bar chart) used to
        // create a morph that silently mis-tweened; skip it instead so the element holds at A.
        if (wrap && A && B && morphCompatible(A, B)) {
          specs.push({
            node: wrap, beatIndex: bi, keyframes: [], enter: false, key,
            delay: track.start ?? 0, duration: track.duration ?? 1200, easing: resolveEasing(track.easing ?? "smooth", track.influence),
            morph: createMorph(wrap, track.target, A, B),
            morphEase: resolveEasingFn(track.easing ?? "smooth", track.influence),
          });
        }
        continue;
      }
      // countUp — a number-tween driver sharing the morph plumbing (rAF play,
      // static seek 0|1, reduced-motion snap). Targets the first resolved node;
      // for a whole text box, drill to its first .sl-block so writing the tween
      // text doesn't flatten the box's block structure.
      if (track.preset === "countUp") {
        let node = resolveNodes(track, slide, rendered, cameraLayer, opts)[0];
        const block = (node as HTMLElement | undefined)?.querySelector?.(".sl-block");
        if (block) node = block as HTMLElement;
        if (node) {
          specs.push({
            node, beatIndex: bi, keyframes: [], enter: false, key,
            delay: track.start ?? 0, duration: track.duration ?? 800,
            easing: resolveEasing(track.easing ?? "standard", track.influence),
            morph: createCountUp(node, track),
            morphEase: resolveEasingFn(track.easing ?? "standard", track.influence),
          });
        }
        continue;
      }
      const nodes = resolveNodes(track, slide, rendered, cameraLayer, opts);
      if (!nodes.length) continue;
      const preset = PRESETS[track.preset ?? "fade"] ?? PRESETS.fade;
      const nodeAnims = preset(nodes, track, ctx);
      const n = nodeAnims.length;
      const perMs = track.stagger?.perMs ?? 0;
      const from = track.stagger?.from ?? "start";
      const ranks = perMs ? orderRanks(nodeAnims, track.stagger?.by ?? "index") : [];
      nodeAnims.forEach((na, i) => {
        specs.push({
          node: na.node,
          beatIndex: bi,
          keyframes: na.keyframes,
          delay: (track.start ?? 0) + (perMs ? staggerRank(ranks[i], n, from) * perMs : 0),
          duration: track.duration ?? DUR.gentle,
          easing: resolveEasing(track.easing, track.influence),
          enter: na.enter,
          key,
          prep: na.prep,
          camera: track.preset === "camera",
        });
      });
    }
  });
  return specs;
}

const ANIM_PROPS = ["opacity", "transform", "clipPath", "strokeDashoffset", "strokeDasharray", "transformOrigin"] as const;
function clearAnimStyles(node: TargetNode) {
  const s = (node as HTMLElement).style;
  for (const p of ANIM_PROPS) s.removeProperty(p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
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
function applyKeyframe(node: TargetNode, kf: Keyframe) {
  const s = (node as HTMLElement).style as unknown as Record<string, string>;
  for (const [k, v] of Object.entries(kf)) {
    if (k === "offset" || k === "easing" || k === "composite") continue;
    if (v != null) s[k] = String(v);
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
  const zoom = c.zoom ?? 1;
  const tx = stage.width / 2 - c.x * zoom;
  const ty = stage.height / 2 - c.y * zoom;
  return `translate(${tx}px, ${ty}px) scale(${zoom})`;
}

export function applyStatic(specs: Spec[], beatIndex: number): void {
  // RE-BASELINE windows, per authoring KEY (target+part+selector), not per node:
  // an enter restarts its logical target's story, so everything that key did in
  // earlier beats (an exit's hidden end-state, stale emphasis transforms) is
  // superseded. Computed per key because an enter and a re-enter of the same
  // target may resolve to DIFFERENT nodes (fade acts on a part's <g>; drawOn
  // drills to its inner path) — a per-node window would leave the <g> hidden.
  const windowStart = new Map<string, number>();
  for (const s of specs) {
    if (s.enter && s.beatIndex <= beatIndex) {
      windowStart.set(s.key, Math.max(windowStart.get(s.key) ?? 0, s.beatIndex));
    }
  }
  const superseded = (s: Spec) => s.beatIndex < (windowStart.get(s.key) ?? -1);

  const byNode = new Map<TargetNode, Spec[]>();
  for (const s of specs) {
    const list = byNode.get(s.node) ?? [];
    list.push(s);
    byNode.set(s.node, list);
  }
  for (const [node, list] of byNode) {
    list.sort((a, b) => a.beatIndex - b.beatIndex || a.delay - b.delay);
    // Reset to the base look BEFORE prep(), so prep's stroke-dasharray (draw-on)
    // and transform-origin (grow-baseline) SURVIVE into the resting state. If
    // cleared after prep, the pre-beat keyframe (strokeDashoffset:len / scaleY:0)
    // has nothing to act on and the part wrongly shows fully drawn/full-size at
    // rest before its beat — corrupting "hide all", the scrubber, and export.
    clearAnimStyles(node);
    for (const s of list) s.prep?.();
    // morph specs drive child geometry directly: B once its beat has passed, else A.
    const morphs = list.filter((s) => s.morph);
    for (const s of morphs) s.morph!.seek(s.beatIndex <= beatIndex ? 1 : 0);
    const kf = list.filter((s) => !s.morph);
    if (!kf.length) continue;
    const past = kf.filter((s) => s.beatIndex <= beatIndex && !superseded(s));
    if (past.length) {
      // accumulate: non-transform props last-wins; transform composed by fn (B11)
      applyAccumulated(node, past);
    } else if (kf[0].enter && kf[0].beatIndex > beatIndex) {
      // hidden until its intro beat. (A node whose past was entirely superseded
      // by a later re-enter on ANOTHER node of its key rests at the base look.)
      applyKeyframe(node, kf[0].keyframes[0]);
    }
  }
}

/** Drive a morph over `duration` via rAF, easing time with manim's smoothstep.
 *  Returns a Playable so the sequencer awaits + can interrupt it like a WAAPI anim. */
function runMorph(m: MorphController, duration: number, reduced: boolean, ease: (t: number) => number = smoothstep): Playable {
  let raf = 0, start = 0, cancelled = false;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
    if (reduced || duration <= 0) { m.seek(1); resolve(); return; }
    const step = (ts: number) => {
      if (cancelled) return;
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      m.seek(ease(t));
      if (t < 1) raf = requestAnimationFrame(step);
      else resolve();
    };
    raf = requestAnimationFrame(step);
  });
  // cancel must SETTLE `finished` (else settle()'s Promise.all hangs on this beat — B10).
  return { finished, cancel: () => { cancelled = true; if (raf) cancelAnimationFrame(raf); resolveFinished(); } };
}

const HIDE_PROPS: [prop: string, css: string[]][] = [
  ["opacity", ["opacity"]],
  ["transform", ["transform"]],
  ["clipPath", ["clip-path"]],
  ["strokeDashoffset", ["stroke-dashoffset", "stroke-dasharray"]],
];
/** A LIVE enter must re-baseline too: clear the hide-props its own keyframes do
 *  NOT animate (a drawOn re-enter after a fadeOut would otherwise play invisibly
 *  under the exit's inline opacity:0). Mirrors applyStatic's re-baseline rule. */
function clearStaleHidesForEnter(s: Spec) {
  const animated = new Set(s.keyframes.flatMap((k) => Object.keys(k)));
  const st = (s.node as HTMLElement).style;
  for (const [prop, css] of HIDE_PROPS) {
    if (!animated.has(prop)) for (const c of css) st.removeProperty(c);
  }
}

function playSpecs(specs: Spec[], lo: number, hi: number, reduced: boolean): Playable[] {
  // A LIVE enter re-baselines its whole KEY, mirroring applyStatic: earlier-beat
  // specs of the same key on OTHER nodes (an exit that hid the part's <g> while
  // this re-enter drills to its path) are stale — reset those nodes so the
  // re-enter is actually visible while it plays.
  const enterKeys = new Set<string>();
  for (const s of specs) if (s.beatIndex >= lo && s.beatIndex <= hi && s.enter) enterKeys.add(s.key);
  if (enterKeys.size) {
    const liveNodes = new Set(specs.filter((s) => s.beatIndex >= lo && s.beatIndex <= hi).map((s) => s.node));
    for (const o of specs) {
      if (o.beatIndex < lo && enterKeys.has(o.key) && !liveNodes.has(o.node)) clearAnimStyles(o.node);
    }
  }
  const out: Playable[] = [];
  for (const s of specs) {
    if (s.beatIndex < lo || s.beatIndex > hi) continue;
    s.prep?.();
    if (s.enter) clearStaleHidesForEnter(s);
    if (s.morph) { out.push(runMorph(s.morph, s.duration, reduced, s.morphEase)); continue; }
    // Camera: start from the layer's LIVE transform so a second move continues from
    // the first's pose instead of snapping back to identity (B8).
    if (s.camera && s.keyframes.length >= 2) {
      const live = (s.node as HTMLElement).style.transform;
      if (live) s.keyframes[0] = { ...s.keyframes[0], transform: live };
    }
    out.push(animate(s.node, s.keyframes, { delay: s.delay, duration: s.duration, easing: s.easing, fill: "both", reduce: reduced }));
  }
  return out;
}
/** Await a set of Playables (Animations + morph drivers), errors swallowed. */
function settle(ps: Playable[]): Promise<void> {
  return Promise.all(ps.map((p) => p.finished.catch(() => {}))).then(() => {});
}

// --- the live player ---------------------------------------------------------
export interface PlayerState {
  slide: number;
  beat: number;
  totalBeats: number;
  totalSlides: number;
}
type Ev = "change" | "beatStart" | "beatEnd";

export interface Player {
  goTo(slide: number, beat: number, opts?: { animate?: boolean }): void;
  next(): void;
  prev(): void;
  nextSlide(): void;
  prevSlide(): void;
  state(): PlayerState;
  /** Pause/resume all videos on the current slide (blank-screen / away). */
  setMediaPaused(paused: boolean): void;
  on(ev: Ev, cb: (s: PlayerState) => void): () => void;
  destroy(): void;
}

export function createPlayer(mount: HTMLElement, deck: Deck, opts: PlayerOpts): Player {
  const stage = deck.stage;
  const reduced = opts.reducedMotion ?? prefersReducedMotion();

  // mount → camera layer → rendered elements. Camera tracks transform the layer.
  mount.replaceChildren();
  mount.style.position = "relative";
  mount.style.overflow = "hidden";
  mount.style.width = `${stage.width}px`;
  mount.style.height = `${stage.height}px`;
  const cameraLayer = document.createElement("div");
  cameraLayer.className = "sl-camera";
  cameraLayer.style.cssText = "position:absolute;inset:0;transform-origin:0 0;";
  mount.appendChild(cameraLayer);

  let slideIndex = -1;
  let beatIndex = 0;
  let rendered: RenderedSlide | null = null;
  let specs: Spec[] = [];
  let active: Playable[] = [];
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners: Record<Ev, Set<(s: PlayerState) => void>> = { change: new Set(), beatStart: new Set(), beatEnd: new Set() };

  const figureSvg = opts.figureSvg;
  const renderCtx: SlideRenderCtx = { theme: opts.theme, assetUrl: opts.assetUrl, figureSvg, plotGen: opts.plotGen, mode: opts.mode };

  function emit(ev: Ev) {
    const s = state();
    for (const cb of listeners[ev]) cb(s);
  }
  function buildSlide(si: number) {
    const slide = deck.slides[si];
    mount.style.background = slide.background ?? opts.theme.background;
    rendered = renderSlide(cameraLayer, slide, stage, renderCtx);
    specs = computeSlideAnims(slide, rendered, cameraLayer, stage, opts);
    // Seed the resting camera to the slide's base pose; camera tracks animate from
    // here, and slides without a camera track stay parked at it (B14).
    cameraLayer.style.transform = baseCameraTransform(slide, stage);
    syncMedia();
  }
  // Bumped on every cancel/new run so a stale settle() (from a beat the presenter
  // already advanced past) can't re-fire beatEnd / schedule a stale auto (B7).
  let gen = 0;
  function cancelActive() {
    gen++;
    for (const a of active) { try { a.cancel(); } catch { /* already gone */ } }
    active = [];
    clearTimeout(autoTimer);
  }
  function curBeats(): number {
    // `|| 1`, not `?? 1`: a 0-beat slide must still report a single (resting) beat.
    return deck.slides[slideIndex]?.beats.length || 1;
  }

  // --- slide-to-slide transitions (§5.6): fade, or a directional slide/push -----
  // SLD-13: returns the animation (a Playable) so callers can register it in `active`
  // and the next cancelActive() interrupts an in-flight transition on a rapid re-nav.
  function slideTransition(kind: TransitionKind, forward: boolean): Playable | null {
    if (reduced || kind === "none") return null;
    if (kind === "slide" || kind === "push") {
      const from = forward ? stage.width : -stage.width;
      // animate the whole mount (not the camera layer) so a per-slide camera pose
      // is untouched; the new slide travels in from the leading edge.
      return animate(mount, [{ transform: `translateX(${from}px)` }, { transform: "translateX(0px)" }],
        { duration: DUR.gentle, easing: EASE.enter, reduce: reduced });
    }
    return animate(cameraLayer, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.gentle, easing: EASE.enter, reduce: reduced });
  }
  const transitionOf = (si: number): TransitionKind => deck.slides[si]?.transition ?? deck.defaults?.transition ?? "fade";

  // --- video playback (present only): autoplay on entry, pause on blank (B4/B15) -
  function videos(): HTMLVideoElement[] {
    return rendered ? Array.from(cameraLayer.querySelectorAll("video")) : [];
  }
  function syncMedia() {
    if (opts.mode !== "present") return;
    for (const v of videos()) if (v.dataset.autoplay === "1") { try { v.currentTime = 0; void v.play?.(); } catch { /* ignore */ } }
  }
  function setMediaPaused(paused: boolean) {
    for (const v of videos()) {
      if (paused) v.pause?.();
      else if (v.dataset.autoplay === "1") { try { void v.play?.(); } catch { /* ignore */ } }
    }
  }

  function goTo(si: number, bi: number, o: { animate?: boolean } = {}) {
    cancelActive();
    si = Math.max(0, Math.min(deck.slides.length - 1, si));
    const slideChanged = si !== slideIndex || !rendered;
    if (slideChanged) buildSlide(si);
    const beats = deck.slides[si].beats;
    bi = Math.max(0, Math.min(beats.length - 1, bi));

    if (o.animate && !slideChanged && !reduced && bi > beatIndex) {
      // forward within a slide: rest at the gap before, then play the run.
      applyStatic(specs, bi - 1);
      slideIndex = si; beatIndex = bi;
      active = playSpecs(specs, bi, bi, reduced);
      const g = gen;
      emit("beatStart"); emit("change");
      settle(active).then(() => { if (g !== gen) return; emit("beatEnd"); maybeAuto(); });
    } else {
      const forward = si >= slideIndex;
      applyStatic(specs, bi);
      slideIndex = si; beatIndex = bi;
      if (slideChanged) {
        const t = slideTransition(transitionOf(si), forward);
        if (t) active.push(t); // SLD-13: track so a rapid re-nav can cancel it
      }
      emit("change");
      maybeAuto(); // an auto beat right after the landing fires on entry/jump too (B9)
    }
  }

  function next() {
    if (!rendered) { goTo(0, 0); return; }
    const beats = deck.slides[slideIndex].beats;
    if (beatIndex < beats.length - 1) {
      const t = beatIndex + 1;
      let e = t;
      while (e + 1 < beats.length && beats[e + 1].advance === "with-prev") e++;
      cancelActive();
      if (!reduced) applyStatic(specs, t - 1);
      beatIndex = e;
      active = reduced ? [] : playSpecs(specs, t, e, reduced);
      if (reduced) applyStatic(specs, e);
      const g = gen;
      emit("beatStart"); emit("change");
      settle(active).then(() => { if (g !== gen) return; emit("beatEnd"); maybeAuto(); });
    } else {
      nextSlide();
    }
  }

  function maybeAuto() {
    clearTimeout(autoTimer); // never stack two pending auto-advances
    const beats = deck.slides[slideIndex]?.beats ?? [];
    const nb = beats[beatIndex + 1];
    if (nb?.advance === "auto") {
      autoTimer = setTimeout(() => next(), nb.autoDelayMs ?? 600);
    }
  }

  function prev() {
    if (beatIndex > 0) {
      cancelActive();
      // beatIndex is always a "landing" (a click beat's group-end). To reach the
      // PREVIOUS landing, rewind to this group's start `s` (walk back over its own
      // with-prev members) then step one before it — so we never rest on a partial
      // frame mid-group (B2).
      let s = beatIndex;
      while (s > 0 && deck.slides[slideIndex].beats[s].advance === "with-prev") s--;
      const target = Math.max(0, s - 1);
      applyStatic(specs, target);
      beatIndex = target;
      emit("change");
    } else if (slideIndex > 0) {
      prevSlide();
    }
  }
  function nextSlide() {
    if (slideIndex < deck.slides.length - 1) goTo(slideIndex + 1, 0);
  }
  function prevSlide() {
    if (slideIndex > 0) {
      cancelActive(); // SLD-13: bump gen + stop the outgoing slide's beat anims, so a
      // stale settle() can't fire beatEnd/maybeAuto against this newly-shown slide.
      const target = slideIndex - 1;
      buildSlide(target);
      slideIndex = target;
      beatIndex = deck.slides[target].beats.length - 1;
      applyStatic(specs, beatIndex);
      const t = slideTransition(transitionOf(target), false); // reverse: enters from the left
      if (t) active.push(t);
      emit("change");
    }
  }

  function state(): PlayerState {
    return { slide: slideIndex, beat: beatIndex, totalBeats: curBeats(), totalSlides: deck.slides.length };
  }
  function on(ev: Ev, cb: (s: PlayerState) => void) {
    listeners[ev].add(cb);
    return () => listeners[ev].delete(cb);
  }
  function destroy() {
    cancelActive();
    mount.replaceChildren();
  }

  goTo(0, 0);
  return { goTo, next, prev, nextSlide, prevSlide, state, setMediaPaused, on, destroy };
}

/** Editor helper: render a slide and freeze it at `beat`'s static state (so the
 *  beat scrubber previews builds). The host doubles as the camera layer. */
export function renderStaticAt(host: HTMLElement, slide: Slide, stage: StageSize, beat: number, opts: PlayerOpts): RenderedSlide {
  const ctx: SlideRenderCtx = { theme: opts.theme, assetUrl: opts.assetUrl, figureSvg: opts.figureSvg, plotGen: opts.plotGen, mode: opts.mode };
  const rendered = renderSlide(host, slide, stage, ctx);
  const specs = computeSlideAnims(slide, rendered, host, stage, opts);
  applyStatic(specs, beat);
  return rendered;
}
