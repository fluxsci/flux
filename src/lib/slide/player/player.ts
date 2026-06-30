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
import { smoothEasing, EASE } from "../../motion/tokens";
import { animate, allDone, prefersReducedMotion } from "../../motion/motion";
import { buildPartIndex } from "../../plot/parse";
import type { FluxPlotManifest } from "../../plot/types";
import { renderSlide, type SlideRenderCtx, type RenderedSlide } from "./render";
import { PRESETS, type TargetNode, type PresetCtx } from "./presets";
import type { Deck, Slide, Track, EasingToken, StageSize, DeckTheme, EmbedFigureElement } from "../types";

const SEP = "__"; // mirrors plot/parse prefixIds — plot part DOM id = `${elId}__${semanticId}`

export interface PlayerOpts extends Omit<SlideRenderCtx, "theme"> {
  theme: DeckTheme;
  /** assetId → its plot manifest (for role/series/index part targeting). */
  plotManifest?: (assetId: string) => FluxPlotManifest | undefined;
  reducedMotion?: boolean;
}

export function resolveEasing(tok?: EasingToken): string {
  if (tok === "smooth") return smoothEasing();
  if (tok === "linear") return "linear";
  return EASE[tok ?? "standard"] ?? EASE.standard;
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

  // a single plot part by semantic id
  if (track.part) {
    const n = wrap.querySelector<SVGElement>(`[id="${track.target}${SEP}${track.part}"]`);
    return n ? [n] : [];
  }

  // a plot part-set by role / series / index
  const sel = track.selector;
  if (sel && (sel.role || sel.series || sel.index != null)) {
    const el = slide.elements.find((e) => e.id === track.target);
    const assetId = el && "assetId" in el ? (el as { assetId: string }).assetId : undefined;
    const idx = buildPartIndex(assetId ? opts.plotManifest?.(assetId) : undefined);
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
  prep?: () => void;
}

/** Flatten a slide's beats → timed per-node specs (the static-state + play substrate). */
export function computeSlideAnims(slide: Slide, rendered: RenderedSlide, cameraLayer: HTMLElement, stage: StageSize, opts: PlayerOpts): Spec[] {
  const specs: Spec[] = [];
  const ctx: PresetCtx = { theme: opts.theme, stage };
  slide.beats.forEach((beat, bi) => {
    for (const track of beat.tracks) {
      const nodes = resolveNodes(track, slide, rendered, cameraLayer, opts);
      if (!nodes.length) continue;
      const preset = PRESETS[track.preset ?? "fade"] ?? PRESETS.fade;
      const nodeAnims = preset(nodes, track, ctx);
      const n = nodeAnims.length;
      const perMs = track.stagger?.perMs ?? 0;
      const from = track.stagger?.from ?? "start";
      for (const na of nodeAnims) {
        specs.push({
          node: na.node,
          beatIndex: bi,
          keyframes: na.keyframes,
          delay: (track.start ?? 0) + (perMs ? staggerRank(na.index, n, from) * perMs : 0),
          duration: track.duration ?? DUR.gentle,
          easing: resolveEasing(track.easing),
          enter: na.enter,
          prep: na.prep,
        });
      }
    }
  });
  return specs;
}

const ANIM_PROPS = ["opacity", "transform", "clipPath", "strokeDashoffset", "strokeDasharray", "transformOrigin"] as const;
function clearAnimStyles(node: TargetNode) {
  const s = (node as HTMLElement).style;
  for (const p of ANIM_PROPS) s.removeProperty(p.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
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
export function applyStatic(specs: Spec[], beatIndex: number): void {
  const byNode = new Map<TargetNode, Spec[]>();
  for (const s of specs) {
    const list = byNode.get(s.node) ?? [];
    list.push(s);
    byNode.set(s.node, list);
  }
  for (const [node, list] of byNode) {
    list.sort((a, b) => a.beatIndex - b.beatIndex || a.delay - b.delay);
    for (const s of list) s.prep?.();
    clearAnimStyles(node);
    const past = list.filter((s) => s.beatIndex <= beatIndex);
    if (past.length) {
      // accumulate per-property: later specs override, untouched props persist
      for (const s of past) applyKeyframe(node, s.keyframes[s.keyframes.length - 1]);
    } else if (list[0].enter) {
      applyKeyframe(node, list[0].keyframes[0]); // hidden until its intro beat
    }
  }
}

function playSpecs(specs: Spec[], lo: number, hi: number): Animation[] {
  const anims: Animation[] = [];
  for (const s of specs) {
    if (s.beatIndex < lo || s.beatIndex > hi) continue;
    s.prep?.();
    anims.push(animate(s.node, s.keyframes, { delay: s.delay, duration: s.duration, easing: s.easing, fill: "both" }));
  }
  return anims;
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
  let active: Animation[] = [];
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
  }
  function cancelActive() {
    for (const a of active) { try { a.cancel(); } catch { /* already gone */ } }
    active = [];
    clearTimeout(autoTimer);
  }
  function curBeats(): number {
    return deck.slides[slideIndex]?.beats.length ?? 1;
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
      active = playSpecs(specs, bi, bi);
      emit("beatStart"); emit("change");
      allDone(...active).then(() => { emit("beatEnd"); maybeAuto(); });
    } else {
      applyStatic(specs, bi);
      slideIndex = si; beatIndex = bi;
      emit("change");
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
      active = reduced ? [] : playSpecs(specs, t, e);
      if (reduced) applyStatic(specs, e);
      emit("beatStart"); emit("change");
      allDone(...active).then(() => { emit("beatEnd"); maybeAuto(); });
    } else {
      nextSlide();
    }
  }

  function maybeAuto() {
    const beats = deck.slides[slideIndex]?.beats ?? [];
    const nb = beats[beatIndex + 1];
    if (nb?.advance === "auto") {
      autoTimer = setTimeout(() => next(), nb.autoDelayMs ?? 600);
    }
  }

  function prev() {
    if (beatIndex > 0) {
      cancelActive();
      let p = beatIndex - 1;
      while (p > 0 && deck.slides[slideIndex].beats[p].advance === "with-prev") p--;
      applyStatic(specs, p);
      beatIndex = p;
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
      const target = slideIndex - 1;
      buildSlide(target);
      slideIndex = target;
      beatIndex = deck.slides[target].beats.length - 1;
      applyStatic(specs, beatIndex);
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
  return { goTo, next, prev, nextSlide, prevSlide, state, on, destroy };
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
