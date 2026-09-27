// ---------------------------------------------------------------------------
// Flux Slide — the ONE renderer (framework-agnostic, DOM-building).
//
// "One renderer, N hosts": this module builds a slide's element DOM with no
// Svelte imports, so the SAME code drives (a) the editor's filmstrip
// thumbnails + build preview, (b) in-app present mode, and (c) the exported
// self-contained HTML. There is never a second renderer.
//
// Slides-are-figures: a slide's elements are the figure `Element` union, and
// the static markup comes from the figure module's ONE element serializer
// (export.ts `elementToSvg`) — so a slide presents exactly as the same
// elements export from a figure (dash, arrowheads, wrapped text, crops, flips
// — full parity by construction). Each element still gets its own absolutely-
// positioned wrapper at authoring pixels (the stage is a fixed StageSize
// scaled to fit by the host), because the player animates these wrappers.
// Semantic plots mount as LIVE inline SVG with addressable, id-prefixed parts
// so the player + morph can animate `control.line`, `control.point.k`, etc.
//
// Video placements use their ordinary poster in static hosts, and one retained
// decoder in a player. Appearance and geometry still belong to the same wrapper.
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import type { Element as FigElement } from "../../types";
import { plotDom, plotManifests } from "../../plot/store";
import { prefixIds, applyOverrides } from "../../plot/parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "../../plot/compensate";
import { elementToSvg, textSvgLayout, segmentAttrs, type AssetSizeFn } from "../../export";
import { elementBBox } from "../../geometry";
import { lerpColor } from "../../color/interp";
import type { Slide, StageSize, DeckTheme } from "../types";
import { themeCssVars } from "../theme";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SlideRenderCtx {
  /** Pristine SVG/manifest lookup scoped to this rendering host. */
  plotRoot?: (assetId: string) => SVGSVGElement | undefined;
  plotManifest?: (assetId: string) => import("../../plot/types").FluxPlotManifest | undefined;
  theme: DeckTheme;
  /** asset id → URL or data: URI (images / plot fallbacks). */
  assetUrl?: (assetId: string) => string | undefined;
  /** asset id → intrinsic display size (crop rendering of raster elements). */
  assetSize?: AssetSizeFn;
  /** per-plot generation (bumped on regenerate) — folds into the re-render. */
  plotGen?: Record<string, number>;
  /** deck-level default slide background (falls back to the theme's). */
  deckBackground?: string;
  mode?: "edit" | "present" | "export";
  /** Static hosts must never allocate a decoder for each thumbnail. */
  videoPlayback?: boolean;
  /** Derived ghost styling; never written into the figure/deck model. */
  ghostPartFactors?: Record<string, Record<string, { opacity: number }>>;
}

export interface RenderedSlide {
  /** elId → the wrapper element (the player/editor animates/overlays these). */
  elements: Map<string, HTMLElement>;
  sourceSlide?: Slide;
}

// --- the wrapper every element shares ---------------------------------------
// Positioned at the element's UNROTATED bbox; rotation/flips ride a CSS
// transform on the wrapper (same pivot — the bbox centre — as the canvas and
// the export's `rot()`), so the markup inside renders rotation-free.
function wrapper(el: FigElement): HTMLDivElement {
  const w = document.createElement("div");
  w.className = "sl-el";
  w.dataset.elId = el.id;
  w.dataset.elType = el.type;
  const s = w.style;
  s.position = "absolute";
  s.boxSizing = "border-box";
  applyWrapperBox(w, el);
  return w;
}

/** The LAYOUT box a wrapper rests in: whole stage pixels. The element's exact
 *  box is realized on top of it by a residual transform (below), because a
 *  layout box is pixel-SNAPPED when painted while a transform is not — a
 *  fractional `left` used to land up to half a stage pixel (several device
 *  pixels under the present/export fit-scale) away from where the same box
 *  painted mid-flight, so every transform ended with a visible jump as it
 *  settled. Rest and motion now share one placement law and the endpoint is
 *  the limit of the frames before it. */
export function layoutBoxOf(bb: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  return { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.max(1, Math.round(bb.w)), h: Math.max(1, Math.round(bb.h)) };
}

const RESIDUAL_EPS = 1e-4;

/** Static markup fill: the element serialized by the ONE figure serializer
 *  (rotation/flips/opacity stripped — the wrapper owns them), viewBoxed to the
 *  wrapper's box. Strokes may overhang (overflow visible). */
function fillStatic(w: HTMLElement, el: FigElement, ctx: SlideRenderCtx): void {
  const neutral: FigElement = { ...el, rotation: 0 };
  delete neutral.flipX;
  delete neutral.flipY;
  delete neutral.opacity;
  const bb = elementBBox(neutral);
  const markup = elementToSvg(neutral, (id) => ctx.assetUrl?.(id), undefined, ctx.assetSize);
  if (!markup) {
    w.classList.add("sl-missing");
    w.textContent = el.type === "image" ? "missing image" : el.type;
    return;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("viewBox", `${bb.x} ${bb.y} ${Math.max(bb.w, 1)} ${Math.max(bb.h, 1)}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.overflow = "visible";
  // display:block — an INLINE svg sits on the host's text BASELINE, so a
  // small-height svg (a near-horizontal line's 1px box, a one-line text)
  // gets pushed DOWN by the host font's ascent minus its own height (~12px
  // at default fonts), and the offset differs per host (app present vs
  // export vs canvas). Block layout pins it to the wrapper's top-left.
  svg.style.display = "block";
  svg.innerHTML = markup;
  w.appendChild(svg);
}

/** Patch an already-filled static wrapper to a NEW state of the same element
 *  IN PLACE, preserving node identity: attributes are copied onto the
 *  existing DOM nodes (inline `style` — where WAAPI leftovers and drawOn's
 *  dash scaffolding live — is deliberately untouched), so animations bound to
 *  inner geometry survive a transform's per-frame content updates. Falls back
 *  to a full re-fill (fresh nodes) when the markup STRUCTURE changed (a
 *  discrete flip mid-tween: arrowheads appearing, wrap line count changing).
 *  Returns true when identity was preserved. */
export function updateStaticContent(w: HTMLElement, el: FigElement, ctx: SlideRenderCtx): boolean {
  const svg = w.firstElementChild as SVGSVGElement | null;
  if (!svg || svg.tagName?.toLowerCase() !== "svg") {
    w.replaceChildren();
    w.classList.remove("sl-missing");
    fillStatic(w, el, ctx);
    return false;
  }
  const neutral: FigElement = { ...el, rotation: 0 };
  delete neutral.flipX;
  delete neutral.flipY;
  delete neutral.opacity;
  const bb = elementBBox(neutral);
  svg.setAttribute("viewBox", `${bb.x} ${bb.y} ${Math.max(bb.w, 1)} ${Math.max(bb.h, 1)}`);
  const markup = elementToSvg(neutral, (id) => ctx.assetUrl?.(id), undefined, ctx.assetSize);
  const tpl = document.createElementNS(SVG_NS, "svg");
  tpl.innerHTML = markup;
  const walk = (a: Element, b: Element): boolean => {
    if (a.tagName !== b.tagName) return false;
    const ac = Array.from(a.children);
    const bc = Array.from(b.children);
    if (ac.length !== bc.length) return false;
    for (let i = 0; i < ac.length; i++) if (!walk(ac[i], bc[i])) return false;
    return true;
  };
  const oldKids = Array.from(svg.children);
  const newKids = Array.from(tpl.children);
  const sameShape = oldKids.length === newKids.length && oldKids.every((k, i) => walk(k, newKids[i]));
  if (!sameShape) {
    svg.innerHTML = markup;
    return false;
  }
  const patch = (dst: Element, src: Element) => {
    for (const attr of Array.from(dst.attributes)) {
      if (attr.name === "style") continue;
      if (!src.hasAttribute(attr.name)) dst.removeAttribute(attr.name);
    }
    for (const attr of Array.from(src.attributes)) {
      if (attr.name === "style") {
        // the serializer's own style attr must land (fonts etc.), but WAAPI/
        // dash leftovers live in the LIVE node's style — merge: serializer
        // wins per-declaration, live-only props survive.
        const live = dst.getAttribute("style") ?? "";
        const next = attr.value;
        if (live && live !== next) {
          const liveDecls = live.split(";").map((s) => s.trim()).filter(Boolean);
          const nextNames = new Set(next.split(";").map((s) => s.split(":")[0]?.trim()).filter(Boolean));
          const keep = liveDecls.filter((d) => !nextNames.has(d.split(":")[0]?.trim()));
          dst.setAttribute("style", [next, ...keep].filter(Boolean).join("; "));
        } else if (dst.getAttribute("style") !== next) {
          dst.setAttribute("style", next);
        }
        continue;
      }
      if (dst.getAttribute(attr.name) !== attr.value) dst.setAttribute(attr.name, attr.value);
    }
    // text content of leaf nodes (tspans, text)
    if (!src.children.length && !dst.children.length && dst.textContent !== src.textContent) {
      dst.textContent = src.textContent;
    }
    for (let i = 0; i < src.children.length; i++) patch(dst.children[i], src.children[i]);
  };
  for (let i = 0; i < newKids.length; i++) patch(oldKids[i], newKids[i]);
  return true;
}

/** Compile the serializer's two endpoints into stable attribute bindings.
 * Normal shape transforms never serialize/parse SVG during playback. A
 * topology change returns null so the caller can crossfade complete layers. */
export function compileStaticContent(w: HTMLElement, pre: FigElement, end: FigElement, ctx: SlideRenderCtx, dataGeometry?: { circles: ReadonlySet<string>; lines: ReadonlySet<string> }): ((el: FigElement, t: number) => void) | null {
  if (pre.type === "text" && end.type === "text") {
    const svg = w.firstElementChild, text = svg?.querySelector("text");
    if (!svg || !text) return null;
    const spans = Array.from(text.children);
    const segmentKeys: (string | null)[] = [];
    let priorAttrs = Object.keys(textSvgLayout(pre).attrs);
    return (el) => {
      if (el.type !== "text") return;
      const neutral = { ...el, rotation: 0, opacity: undefined };
      const bb = elementBBox(neutral);
      svg.setAttribute("viewBox", `${bb.x} ${bb.y} ${Math.max(bb.w, 1)} ${Math.max(bb.h, 1)}`);
      const { attrs, spans: laid } = textSvgLayout(neutral);
      for (const name of priorAttrs) if (!(name in attrs)) text.removeAttribute(name);
      for (const [name, value] of Object.entries(attrs)) if (text.getAttribute(name) !== value) text.setAttribute(name, value);
      priorAttrs = Object.keys(attrs);
      // A wrap boundary changes only tspan count. Other frames update cached
      // nodes in place; no serialization, parser, or selector on the frame path.
      while (spans.length > laid.length) { spans.pop()!.remove(); segmentKeys.pop(); }
      while (spans.length < laid.length) { const span = document.createElementNS(SVG_NS, "tspan"); text.appendChild(span); spans.push(span); segmentKeys.push(null); }
      for (let i = 0; i < spans.length; i++) {
        const sp = laid[i];
        spans[i].setAttribute("x", String(sp.x)); spans[i].setAttribute("dy", String(sp.dy));
        // Justification is per line and can change between endpoints (a line
        // that becomes a paragraph's last stops stretching) — remove, never stale.
        if (sp.textLength != null) { spans[i].setAttribute("textLength", String(sp.textLength)); spans[i].setAttribute("lengthAdjust", "spacing"); }
        else if (spans[i].hasAttribute("textLength")) { spans[i].removeAttribute("textLength"); spans[i].removeAttribute("lengthAdjust"); }
        // Per-range formatting nests one tspan per differing piece. Rebuilding
        // costs DOM, so it happens only when the pieces actually changed — an
        // unformatted line keeps the plain textContent fast path untouched.
        const key = sp.segments ? JSON.stringify(sp.segments.map((seg) => [seg.text, segmentAttrs(el, seg), seg.dx ?? 0, seg.dy ?? 0])) : null;
        if (key !== null) {
          if (segmentKeys[i] !== key) {
            spans[i].textContent = "";
            for (const seg of sp.segments!) {
              const attrs = Object.entries(segmentAttrs(el, seg));
              if (seg.dx != null) attrs.unshift(["dx", String(seg.dx)]);
              if (seg.dy != null) attrs.unshift(["dy", String(seg.dy)]);
              if (!attrs.length) { spans[i].appendChild(document.createTextNode(seg.text)); continue; }
              const piece = document.createElementNS(SVG_NS, "tspan");
              for (const [name, value] of attrs) piece.setAttribute(name, value);
              piece.textContent = seg.text;
              spans[i].appendChild(piece);
            }
            segmentKeys[i] = key;
          }
        } else {
          segmentKeys[i] = null;
          // textContent of a span with nested pieces already EQUALS the plain
          // line, so the child check is what actually clears formatting a
          // frame has dropped.
          if (spans[i].firstElementChild || spans[i].textContent !== sp.text) spans[i].textContent = sp.text;
        }
      }
    };
  }
  const from = document.createElement("div"), to = document.createElement("div");
  fillContent(from, pre, ctx); fillContent(to, end, ctx);
  const liveSvg = w.firstElementChild;
  const aSvg = from.firstElementChild, bSvg = to.firstElementChild;
  if (!liveSvg || !aSvg || !bSvg) return null;
  const bindings: { node: Element; name: string; sample: (t: number) => string | null }[] = [];
  const texts: { node: Element; a: string; b: string }[] = [];
  const numbers = /-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi;
  const bind = (node: Element, a: Element, b: Element, lineGeometry = false): boolean => {
    if (node.tagName !== a.tagName || a.tagName !== b.tagName || node.children.length !== a.children.length || a.children.length !== b.children.length) return false;
    const names = new Set([...Array.from(a.attributes), ...Array.from(b.attributes)].map((x) => x.name));
    const id = a.getAttribute("id") ?? "";
    const ownsLine = lineGeometry || !!dataGeometry?.lines.has(id);
    const ownsCircle = a.tagName.toLowerCase() === "circle" && !!dataGeometry?.circles.has(id);
    for (const name of names) {
      if (name === "id" || name === "viewBox" && pre.type !== "plot") continue;
      if (ownsLine && name === "d" || ownsCircle && (name === "cx" || name === "cy")) continue;
      const av = a.getAttribute(name), bv = b.getAttribute(name);
      // Earlier box-only motion can leave content in its original SVG frame.
      // A later content Change moves the viewBox to its own pre-state, so even
      // an endpoint-constant shaft/shape attribute must bind if the live node
      // still holds the old frame's value. Never replace those shared nodes.
      if (av === bv && node.getAttribute(name) === av) continue;
      let sample: (t: number) => string | null = (t) => t < .5 ? av : bv;
      if (av !== null && bv !== null) {
        if (name === "fill" || name === "stroke") sample = (t) => lerpColor(av, bv, t);
        else {
          const an = (av.match(numbers) ?? []).map(Number), bn = (bv.match(numbers) ?? []).map(Number);
          if (an.length && an.length === bn.length) sample = (t) => { let i = 0; return bv.replace(numbers, () => String(an[i] + (bn[i] - an[i++]) * t)); };
        }
      }
      bindings.push({ node, name, sample });
    }
    if (!a.children.length && a.textContent !== b.textContent) texts.push({ node, a: a.textContent ?? "", b: b.textContent ?? "" });
    for (let i = 0; i < a.children.length; i++) if (!bind(node.children[i], a.children[i], b.children[i], ownsLine)) return false;
    return true;
  };
  if (!bind(liveSvg, aSvg, bSvg)) return null;
  const path = pre.type === "path" ? liveSvg.querySelector("path") : null;
  return (el, t) => {
    if (el.type !== "plot") {
      const bb = elementBBox({ ...el, rotation: 0 });
      liveSvg.setAttribute("viewBox", `${bb.x} ${bb.y} ${Math.max(bb.w, 1)} ${Math.max(bb.h, 1)}`);
    }
    for (const binding of bindings) {
      const value = binding.sample(t);
      if (value === null) binding.node.removeAttribute(binding.name);
      else if (binding.node.getAttribute(binding.name) !== value) binding.node.setAttribute(binding.name, value);
    }
    // The path tween owns its resampled geometry; interpolating raw d strings
    // would pair unrelated commands when the node count changed.
    if (path && el.type === "path") path.setAttribute("d", el.d);
    for (const text of texts) text.node.textContent = t < .5 ? text.a : text.b;
  };
}

/** The ONE content dispatch — a plot mounts live inline SVG, everything else
 *  the serialized static markup. renderSlide and the transform driver share
 *  this entry so there is never a second renderer. */
export function fillContent(w: HTMLElement, el: FigElement, ctx: SlideRenderCtx): void {
  if (el.type === "plot") fillPlot(w, el, ctx);
  else if (el.type === "video") fillVideo(w, el, ctx);
  else fillStatic(w, el, ctx);
}

function fillVideo(w: HTMLElement, el: Extract<FigElement, { type: "video" }>, ctx: SlideRenderCtx): void {
  const poster = ctx.assetUrl?.(el.posterAssetId), source = ctx.assetUrl?.(el.assetId);
  if (!ctx.videoPlayback || !source) {
    if (poster) {
      const image = document.createElement("img"); image.src = poster; image.alt = el.name ?? "Video clip"; image.draggable = false;
      image.style.cssText = "display:block;width:100%;height:100%;object-fit:fill"; w.append(image);
    } else { w.classList.add("sl-missing"); w.textContent = "Video unavailable"; }
    return;
  }
  const video = document.createElement("video");
  video.dataset.slideVideo = el.id;
  video.preload = "auto"; video.playsInline = true; video.controls = false;
  video.muted = !!el.muted; video.loop = !!el.loop; video.disablePictureInPicture = true;
  video.setAttribute("aria-label", el.name ?? "Video clip");
  if (poster) video.poster = poster;
  video.style.cssText = "display:block;width:100%;height:100%;object-fit:fill";
  video.src = source; w.append(video);
}

/** Bind inherited appearance factors once. The saved SVG's own opacity and
 * explicit overrides remain independent from the copied presentation factor. */
const ghostOpacityBase = new WeakMap<SVGElement, number>();
export function compileGhostPartOpacity(scope: ParentNode, el: FigElement, ctx: SlideRenderCtx): ((current: FigElement) => void) | undefined {
  const factors = ctx.ghostPartFactors?.[el.id];
  if (el.type !== "plot" || !factors) return;
  const bindings = Object.entries(factors).flatMap(([part, state]) => {
    const node = scope.querySelector<SVGElement>(`[id="${el.id}__${part}"]`);
    if (!node) return [];
    const raw = node.style.opacity || node.getAttribute("opacity") || "1";
    const base = ghostOpacityBase.get(node) ?? (Number.isFinite(Number(raw)) ? Number(raw) : 1);
    ghostOpacityBase.set(node, base);
    return [{ node, part, factor: state.opacity, base }];
  });
  return current => {
    if (current.type !== "plot") return;
    for (const b of bindings) b.node.style.opacity = String((current.overrides?.[b.part]?.opacity ?? b.base) * b.factor);
  };
}

/** Mount a semantic plot into the wrapper as LIVE inline <svg>, keeping its
 *  parts addressable (id-prefixed by element id) for the player + morph.
 *  pt-true compensation matches the figure editor: resizing the plot element
 *  rescales geometry while text/glyph/stroke sizes stay at true points (the
 *  stage's own fit-scale above this is uniform CSS — unaffected). */
function fillPlot(w: HTMLElement, el: Extract<FigElement, { type: "plot" }>, ctx: SlideRenderCtx): void {
  const cached = (ctx.plotRoot ? ctx.plotRoot(el.assetId) : plotDom.get(el.assetId));
  if (!cached) {
    // <image> fallback (same as the canvas): the asset bytes render, parts
    // simply aren't addressable.
    const url = ctx.assetUrl?.(el.assetId);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.style.width = "100%";
      img.style.height = "100%";
      img.draggable = false;
      w.appendChild(img);
      return;
    }
    w.classList.add("sl-missing");
    w.textContent = "plot not loaded";
    return;
  }
  const intrinsic = svgIntrinsicPx(cached);
  const inst = document.importNode(cached, true) as SVGSVGElement;
  prefixIds(inst, el.id);
  inst.setAttribute("width", "100%");
  inst.setAttribute("height", "100%");
  inst.setAttribute("preserveAspectRatio", "none");
  inst.style.display = "block"; // same inline-baseline hazard as fillStatic
  if (el.crop) {
    inst.setAttribute("viewBox", cropViewBoxValue(cached.getAttribute("viewBox"), intrinsic, el.crop));
    inst.style.overflow = "hidden";
  } else {
    inst.style.overflow = "visible";
  }
  // applyOverrides needs the live manifest; `get` from svelte/store is framework-neutral.
  const ghostOpacity = compileGhostPartOpacity(inst, el, ctx);
  applyOverrides(inst, el.overrides, el.id, (ctx.plotManifest ? ctx.plotManifest(el.assetId) : get(plotManifests)[el.assetId]));
  ghostOpacity?.(el);
  compensatePtTrue(inst, {
    elW: el.width,
    elH: el.height,
    crop: el.crop ?? null,
    contentScale: el.contentScale,
    intrinsic,
  });
  w.appendChild(inst);
}

// --- the main entry ---------------------------------------------------------
/** Render a slide's static (resting) state into `host`, applying the theme.
 *  Hidden elements (the Layers eye — own flag or an ancestor group's) are
 *  omitted, matching canvas + export. */
export function renderSlide(
  host: HTMLElement,
  slide: Slide,
  stage: StageSize,
  ctx: SlideRenderCtx,
): RenderedSlide {
  host.replaceChildren();
  host.style.setProperty("width", `${stage.width}px`);
  host.style.setProperty("height", `${stage.height}px`);
  host.style.position = "relative";
  host.style.overflow = "hidden";
  host.style.background = slide.background ?? ctx.deckBackground ?? ctx.theme.background;
  // Apply the theme as scoped --sl-* custom properties on the stage root.
  for (const decl of themeCssVars(ctx.theme).split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) host.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }

  // Group eyes: an element hidden by an ancestor group's eye must not present.
  const groupHidden = (el: FigElement): boolean => {
    let gid = el.groupId;
    const seen = new Set<string>();
    while (gid && !seen.has(gid)) {
      seen.add(gid);
      const def = slide.groups?.[gid];
      if (!def) break;
      if (def.hidden) return true;
      gid = def.parentId;
    }
    return false;
  };

  const elements = new Map<string, HTMLElement>();
  for (const el of slide.elements) {
    if (el.hidden || groupHidden(el)) continue;
    const w = wrapper(el);
    fillContent(w, el, ctx);
    host.appendChild(w);
    elements.set(el.id, w);
  }
  return { elements, sourceSlide: slide };
}

/** The wrapper box/transform/opacity for an element state at REST — exported
 *  so the transform driver's endpoints apply EXACTLY the math renderSlide's
 *  wrapper() uses. The layout box is the element's box rounded to whole stage
 *  pixels (layoutBoxOf); when the exact box differs (a fractional position or
 *  size) the difference rides a residual transform in the same composite form
 *  mid-flight frames use, so settling into place never snaps. An element on
 *  whole pixels gets the classic `rotate()`/flip transform about its centre. */
export function applyWrapperBox(w: HTMLElement, el: FigElement, opts: { skipOpacity?: boolean; skipTransform?: boolean } = {}): void {
  const bb = elementBBox({ ...el, rotation: 0 });
  const base = layoutBoxOf(bb);
  const s = w.style;
  const bx = `${base.x}px`, by = `${base.y}px`, bw = `${base.w}px`, bh = `${base.h}px`;
  if (s.left !== bx) s.left = bx;
  if (s.top !== by) s.top = by;
  if (s.width !== bw) s.width = bw;
  if (s.height !== bh) s.height = bh;
  if (!opts.skipTransform) {
    const cw = Math.max(bb.w, 1), ch = Math.max(bb.h, 1);
    const residual = Math.abs(bb.x - base.x) > RESIDUAL_EPS || Math.abs(bb.y - base.y) > RESIDUAL_EPS ||
      Math.abs(cw - base.w) > RESIDUAL_EPS || Math.abs(ch - base.h) > RESIDUAL_EPS;
    if (residual) {
      s.transform = compositeTransform(el, bb, base);
      s.transformOrigin = "0 0";
    } else {
      const t: string[] = [];
      if (el.rotation) t.push(`rotate(${el.rotation}deg)`);
      if (el.flipX) t.push("scaleX(-1)");
      if (el.flipY) t.push("scaleY(-1)");
      s.transform = t.length ? t.join(" ") : "";
      // composite frames pin the origin to 0 0 — restore the classic pivot
      s.transformOrigin = "center center";
    }
  }
  if (!opts.skipOpacity) s.opacity = el.opacity != null ? String(el.opacity) : "";
}

/** The composite transform that realizes exact box `bb` on layout box `base`:
 *  translate + (rotation/flips conjugated about the current box centre) +
 *  scale, origin 0 0. ONE formula for mid-flight frames and fractional rest. */
function compositeTransform(el: FigElement, bb: { x: number; y: number; w: number; h: number }, base: { x: number; y: number; w: number; h: number }): string {
  const cw = Math.max(bb.w, 1), ch = Math.max(bb.h, 1);
  const sx = cw / Math.max(base.w, 1), sy = ch / Math.max(base.h, 1);
  // micro-pixel precision, free of float dust (10.4 − 10 = 0.40000000000000036)
  const n = (v: number) => Math.round(v * 1e6) / 1e6;
  const parts: string[] = [`translate(${n(bb.x - base.x)}px, ${n(bb.y - base.y)}px)`];
  const spin: string[] = [];
  if (el.rotation) spin.push(`rotate(${el.rotation}deg)`);
  if (el.flipX) spin.push("scaleX(-1)");
  if (el.flipY) spin.push("scaleY(-1)");
  if (spin.length) {
    // about the CURRENT box centre (the classic pivot), conjugated because the
    // origin is pinned at 0 0 for the scale math
    parts.push(`translate(${n(cw / 2)}px, ${n(ch / 2)}px)`, ...spin, `translate(${n(-cw / 2)}px, ${n(-ch / 2)}px)`);
  }
  if (sx !== 1 || sy !== 1) parts.push(`scale(${n(sx)}, ${n(sy)})`);
  return parts.join(" ");
}

// --- layer hygiene for pure moves ------------------------------------------
// A wrapper that only TRANSLATES during its flight is promoted to its own
// compositor layer for exactly that flight (`will-change: transform`) and
// demoted the moment it rests. Promoted, the browser rasterizes the element
// once and moves the raster at float precision — the only way moving TEXT
// glides: glyphs painted in place snap their baseline to whole device pixels
// (Skia positions axis-aligned text sub-pixel in x only), so a text element
// re-painted per frame steps down the screen one device pixel at a time while
// a shape beside it slides (measured: Δy per ms 0 / 0.445 stage px vs 0.06
// uniform, scripts/perf/slide-motion-probe). It is also what makes a heavy
// element (a plot with a thousand marks) move for free: no repaint per frame,
// only the layer's transform. Demotion at rest is the crisp-at-rest rule
// (Canvas.svelte P6): a promoted layer keeps a resampled raster, and sits at a
// fractional offset slightly soft; painting in place at rest is exact. Scaling
// or rotating flights are never promoted — a fixed raster would be resampled
// every frame (soft while growing, then a sharpen pop on settle); those keep
// painting exactly, and text inside them is re-laid-out per frame anyway.
//
// Two refinements, both measured (the probe's MODE=recolor and GAP=400 runs):
//  • Chromium bakes a layer's fractional offset into its raster ("raster
//    translation") whenever it (re)rasters a layer whose transform it does not
//    consider animating — so a promoted element that also REPAINTS per frame
//    (a colour lerp, a data morph) stepped again. A paused, additive, no-op
//    transform animation ARMED AT REST (armFlightMark — it must precede the
//    promotion) marks the transform as animating for the compositor and costs
//    nothing; with it the repainting text glides too.
//  • A FRESH layer likewise bakes the offset of its first frame. That is fine
//    in play (one layer per flight), but frame-by-frame capture with seconds
//    of encoding between frames would demote and re-promote every frame; the
//    video runtime therefore HOLDS flight layers (holdFlightLayers) so every
//    frame is the same raster moved.
// A scrub that parks mid-flight is demoted after LAYER_COOL_MS of quiet, so
// nothing rests promoted. One timer serves every hot wrapper (never a frame
// callback: playback owns the single animation clock).
const LAYER_COOL_MS = 250;
const hotWrappers = new Map<HTMLElement, number>();
const animatingMarks = new WeakMap<HTMLElement, Animation>();
let coolTimer: ReturnType<typeof setTimeout> | null = null;
let holdLayers = false;
function coolCheck(): void {
  coolTimer = null;
  if (holdLayers) return;
  const now = performance.now();
  for (const [w, at] of hotWrappers) if (now - at > LAYER_COOL_MS) settleWrapper(w);
  if (hotWrappers.size) coolTimer = setTimeout(coolCheck, LAYER_COOL_MS);
}
/** Rest frame of a node that will fly: mark its transform as animating for the
 *  compositor with a paused, additive, no-op animation. Inert at rest (no
 *  layer, painted in place), it must exist BEFORE the flight's promotion —
 *  attached in the same frame as a transform change the browser runs it on
 *  the main thread and the mark does nothing (measured). */
export function armFlightMark(w: HTMLElement): void {
  if (animatingMarks.has(w) || typeof w.animate !== "function") return;
  const mark = w.animate([{ transform: "translate(0px, 0px)" }, { transform: "translate(0px, 0px)" }], { duration: 1e7, composite: "add" });
  mark.pause();
  mark.finished.catch(() => { /* cancelled with the node */ });
  animatingMarks.set(w, mark);
}
/** Mid-flight frame of a pure move: keep the wrapper on its own layer. */
export function promoteMovingWrapper(w: HTMLElement): void {
  if (!hotWrappers.has(w)) w.style.willChange = "transform";
  hotWrappers.set(w, performance.now());
  if (!coolTimer && !holdLayers) coolTimer = setTimeout(coolCheck, LAYER_COOL_MS);
}
/** Endpoint frame: back to painting in place (crisp at rest). */
export function settleWrapper(w: HTMLElement): void {
  if (hotWrappers.delete(w)) w.style.willChange = "";
}
/** A node leaving the player (slide torn down): drop its mark. */
export function releaseFlightMark(w: HTMLElement): void {
  settleWrapper(w);
  const mark = animatingMarks.get(w);
  if (mark) { mark.cancel(); animatingMarks.delete(w); }
}
/** Frame-by-frame capture: keep flight layers alive between frames however
 *  long a frame takes. Endpoints still demote; releasing the hold cools. */
export function holdFlightLayers(on: boolean): void {
  holdLayers = on;
  if (!on && hotWrappers.size && !coolTimer) coolTimer = setTimeout(coolCheck, LAYER_COOL_MS);
}
/** Whether a flight from `pre` to `end` is a pure move — same box size, no
 *  rotation or flips at either end — the only flights that ride a layer. */
export function pureMove(pre: FigElement, end: FigElement): boolean {
  if (pre.rotation || end.rotation || pre.flipX || end.flipX || pre.flipY || end.flipY) return false;
  const a = elementBBox({ ...pre, rotation: 0 }), b = elementBBox({ ...end, rotation: 0 });
  return Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6;
}

/** MID-FLIGHT wrapper application for morph frames (the glide fix): the
 *  layout box stays FROZEN at `base` (the t1 box the endpoints write) and the
 *  current state's box rides a COMPOSITOR transform instead — translate +
 *  scale, with rotation/flips conjugated about the current box centre.
 *
 *  Why: animating left/top/width/height re-lays-out and re-paints per frame,
 *  and the svg child's painted origin pixel-snaps to whole STAGE px — under
 *  the host's fit-scale (present + export scale the stage with a CSS
 *  transform) every snap lands as a multi-device-pixel jump, which reads as
 *  jitter at slow speeds (the anim_test lesson). Compositor transforms
 *  interpolate at float precision with no snapping and no layout. Because
 *  content svgs are width/height:100% + preserveAspectRatio:none, stretching
 *  the frozen base box by (w/w0, h/h0) is EXACTLY the viewBox→box mapping the
 *  per-frame layout write produced — same visual, smooth path. Endpoints
 *  (t≤0 / t≥1) still go through applyWrapperBox, so resting states, gates,
 *  and downstream readers see the classic layout box unchanged. */
export function applyWrapperBoxComposite(
  w: HTMLElement,
  el: FigElement,
  base: { x: number; y: number; w: number; h: number },
  opts: { skipOpacity?: boolean } = {},
): void {
  const bb = elementBBox({ ...el, rotation: 0 });
  const s = w.style;
  const bx = `${base.x}px`, by = `${base.y}px`;
  const bw = `${Math.max(base.w, 1)}px`, bh = `${Math.max(base.h, 1)}px`;
  if (s.left !== bx) s.left = bx;
  if (s.top !== by) s.top = by;
  if (s.width !== bw) s.width = bw;
  if (s.height !== bh) s.height = bh;
  s.transformOrigin = "0 0";
  s.transform = compositeTransform(el, bb, base);
  if (!opts.skipOpacity) s.opacity = el.opacity != null ? String(el.opacity) : "";
}
