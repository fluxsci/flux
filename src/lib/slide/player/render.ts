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
// VIDEO SEAM: when the slide-only video element returns, add its wrapper
// branch here (a `<video>` fill keyed by a video-capable deck asset kind) and
// its union member in slide/types.ts. Nothing ships now.
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import type { Element as FigElement } from "../../types";
import { plotDom, plotManifests } from "../../plot/store";
import { prefixIds, applyOverrides } from "../../plot/parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "../../plot/compensate";
import { elementToSvg, type AssetSizeFn } from "../../export";
import { elementBBox } from "../../geometry";
import type { Slide, StageSize, DeckTheme } from "../types";
import { themeCssVars } from "../theme";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SlideRenderCtx {
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
}

export interface RenderedSlide {
  /** elId → the wrapper element (the player/editor animates/overlays these). */
  elements: Map<string, HTMLElement>;
}

// --- the wrapper every element shares ---------------------------------------
// Positioned at the element's UNROTATED bbox; rotation/flips ride a CSS
// transform on the wrapper (same pivot — the bbox centre — as the canvas and
// the export's `rot()`), so the markup inside renders rotation-free.
function wrapper(el: FigElement): HTMLDivElement {
  const bb = elementBBox({ ...el, rotation: 0 });
  const w = document.createElement("div");
  w.className = "sl-el";
  w.dataset.elId = el.id;
  w.dataset.elType = el.type;
  const s = w.style;
  s.position = "absolute";
  s.left = `${bb.x}px`;
  s.top = `${bb.y}px`;
  s.width = `${Math.max(bb.w, 1)}px`;
  s.height = `${Math.max(bb.h, 1)}px`;
  s.boxSizing = "border-box";
  const t: string[] = [];
  if (el.rotation) t.push(`rotate(${el.rotation}deg)`);
  if (el.flipX) t.push("scaleX(-1)");
  if (el.flipY) t.push("scaleY(-1)");
  if (t.length) s.transform = t.join(" ");
  s.transformOrigin = "center center";
  if (el.opacity != null) s.opacity = String(el.opacity);
  return w;
}

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

/** The ONE content dispatch — a plot mounts live inline SVG, everything else
 *  the serialized static markup. renderSlide and the transform driver share
 *  this entry so there is never a second renderer. */
export function fillContent(w: HTMLElement, el: FigElement, ctx: SlideRenderCtx): void {
  if (el.type === "plot") fillPlot(w, el, ctx);
  else fillStatic(w, el, ctx);
}

/** Mount a semantic plot into the wrapper as LIVE inline <svg>, keeping its
 *  parts addressable (id-prefixed by element id) for the player + morph.
 *  pt-true compensation matches the figure editor: resizing the plot element
 *  rescales geometry while text/glyph/stroke sizes stay at true points (the
 *  stage's own fit-scale above this is uniform CSS — unaffected). */
function fillPlot(w: HTMLElement, el: Extract<FigElement, { type: "plot" }>, ctx: SlideRenderCtx): void {
  const cached = plotDom.get(el.assetId);
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
  if (el.crop) {
    inst.setAttribute("viewBox", cropViewBoxValue(cached.getAttribute("viewBox"), intrinsic, el.crop));
    inst.style.overflow = "hidden";
  } else {
    inst.style.overflow = "visible";
  }
  // applyOverrides needs the live manifest; `get` from svelte/store is framework-neutral.
  applyOverrides(inst, el.overrides, el.id, get(plotManifests)[el.assetId]);
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
  return { elements };
}

/** The wrapper box/transform/opacity for an element state — exported so the
 *  transform driver applies EXACTLY the math renderSlide's wrapper() uses. */
export function applyWrapperBox(w: HTMLElement, el: FigElement, opts: { skipOpacity?: boolean; skipTransform?: boolean } = {}): void {
  const bb = elementBBox({ ...el, rotation: 0 });
  const s = w.style;
  s.left = `${bb.x}px`;
  s.top = `${bb.y}px`;
  s.width = `${Math.max(bb.w, 1)}px`;
  s.height = `${Math.max(bb.h, 1)}px`;
  if (!opts.skipTransform) {
    const t: string[] = [];
    if (el.rotation) t.push(`rotate(${el.rotation}deg)`);
    if (el.flipX) t.push("scaleX(-1)");
    if (el.flipY) t.push("scaleY(-1)");
    s.transform = t.length ? t.join(" ") : "";
  }
  if (!opts.skipOpacity) s.opacity = el.opacity != null ? String(el.opacity) : "";
}
