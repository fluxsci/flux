// ---------------------------------------------------------------------------
// Flux Slide — the ONE renderer (framework-agnostic, DOM-building).
//
// D2: "one renderer, two hosts." This module builds a slide's element DOM with
// no Svelte imports, so the SAME code drives (a) the in-app editor stage, (b)
// the in-app present mode + P2 player, and (c) the exported self-contained HTML.
// There is never a second renderer.
//
// Each element renders as an absolutely-positioned wrapper at AUTHORING pixels
// (the stage is a fixed StageSize scaled to fit by the host). HTML for rich
// content (textBox/math/video/image/embedFigure); inline SVG for plots & vector
// shapes. Semantic plots keep their addressable, id-prefixed parts so the P2
// player + P3 morph can animate `control.line`, `control.point.k`, etc.
// ---------------------------------------------------------------------------

import katex from "katex";
import { get } from "svelte/store";
import type { Element as FigElement } from "../../types";
import { plotDom, plotManifests } from "../../plot/store";
import { prefixIds, applyOverrides } from "../../plot/parse";
import type { Slide, SlideElement, StageSize, DeckTheme, TextBlock } from "../types";
import { themeCssVars } from "../theme";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SlideRenderCtx {
  theme: DeckTheme;
  /** asset id → URL or data: URI (image/video). */
  assetUrl?: (assetId: string) => string | undefined;
  /** figure id → standalone SVG markup (embedFigure; from figureToSvg). */
  figureSvg?: (figureId: string) => string | undefined;
  /** per-plot generation (bumped on regenerate) — folds into the re-render. */
  plotGen?: Record<string, number>;
  mode?: "edit" | "present" | "export";
}

export interface RenderedSlide {
  /** elId → the wrapper element (the P2 player/editor animates/overlays these). */
  elements: Map<string, HTMLElement>;
}

// --- small, escaped inline markdown (**bold**, *italic*, `code`) -------------
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(s: string): string {
  return escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

// Static markers; "number" is resolved per-block in fillTextBox (it needs the
// running position within the list, so it can't be computed from one block).
function markerFor(b: TextBlock): string {
  switch (b.marker) {
    case "bullet":
      return "•";
    case "dash":
      return "–";
    default:
      return "";
  }
}

// --- the wrapper every element shares ---------------------------------------
function wrapper(el: SlideElement): HTMLDivElement {
  const w = document.createElement("div");
  w.className = "sl-el";
  w.dataset.elId = el.id;
  w.dataset.elType = el.type;
  const s = w.style;
  s.position = "absolute";
  s.left = `${el.x}px`;
  s.top = `${el.y}px`;
  s.width = `${el.width}px`;
  s.height = `${el.height}px`;
  s.boxSizing = "border-box";
  if (el.rotation) s.transform = `rotate(${el.rotation}deg)`;
  s.transformOrigin = "center center";
  if (el.opacity != null) s.opacity = String(el.opacity);
  return w;
}

// --- per-type content --------------------------------------------------------
function fillTextBox(w: HTMLElement, el: Extract<SlideElement, { type: "textBox" }>): void {
  w.style.display = "flex";
  w.style.flexDirection = "column";
  w.style.overflow = "hidden";
  w.style.color = el.color ?? "var(--sl-text)";
  w.style.fontFamily = el.fontFamily ?? "var(--sl-font-body)";
  w.style.fontSize = `${el.fontSize ?? 32}px`;
  w.style.fontWeight = String(el.fontWeight ?? 400);
  if (el.fontStyle) w.style.fontStyle = el.fontStyle;
  w.style.lineHeight = String(el.lineHeight ?? 1.25);
  w.style.textAlign = el.align ?? "left";
  w.style.justifyContent =
    el.valign === "middle" ? "center" : el.valign === "bottom" ? "flex-end" : "flex-start";
  // Per-level ordinal counters for "number" markers. A numbered block increments
  // its level's counter and clears any deeper levels, so 1./2./3. counts within a
  // box (nested numbered runs restart under their parent) — the natural list feel.
  const counters: number[] = [];
  for (const b of el.blocks) {
    const line = document.createElement("div");
    line.className = "sl-block";
    line.dataset.blockId = b.id;
    const level = b.level ?? 0;
    line.style.paddingLeft = `${level * 1.4}em`;
    if (b.emphasis === "accent") line.style.color = "var(--sl-accent)";
    else if (b.emphasis === "muted") line.style.color = "var(--sl-text-muted)";
    let mk = markerFor(b);
    if (b.marker === "number") {
      counters[level] = (counters[level] ?? 0) + 1;
      counters.length = level + 1; // reset deeper levels
      mk = `${counters[level]}.`;
    }
    if (mk) {
      // Flex row → a hanging indent: wrapped text lines up under the first line's
      // text, not under the marker. min-width keeps multi-digit numbers aligned.
      line.style.display = "flex";
      line.style.alignItems = "baseline";
      line.innerHTML =
        `<span class="sl-mk" style="color:var(--sl-accent);flex:0 0 auto;margin-right:0.5em;` +
        `min-width:${b.marker === "number" ? "1.4em" : "auto"};` +
        `${b.marker === "number" ? "text-align:right;" : ""}">${mk}</span>` +
        `<span class="sl-tx" style="flex:1 1 auto;min-width:0">${inlineMd(b.text)}</span>`;
    } else {
      line.innerHTML = `<span class="sl-tx">${inlineMd(b.text)}</span>`;
    }
    w.appendChild(line);
  }
}

function fillMath(w: HTMLElement, el: Extract<SlideElement, { type: "math" }>): void {
  w.style.display = "flex";
  w.style.alignItems = "center";
  w.style.justifyContent = "center";
  w.style.color = el.color ?? "var(--sl-text)";
  if (el.fontSize) w.style.fontSize = `${el.fontSize}px`;
  try {
    katex.render(el.tex, w, {
      displayMode: el.display !== false,
      throwOnError: false,
      output: "html",
    });
  } catch {
    w.textContent = el.tex; // last-resort: show the source
  }
}

function fillImage(
  w: HTMLElement,
  el: Extract<SlideElement, { type: "image" | "svg" }>,
  ctx: SlideRenderCtx,
): void {
  const url = ctx.assetUrl?.(el.assetId);
  if (!url) {
    w.classList.add("sl-missing");
    w.textContent = "missing image";
    return;
  }
  const img = document.createElement("img");
  img.src = url;
  img.style.width = "100%";
  img.style.height = "100%";
  // Preserve aspect ratio by default (a slide image should never be stretched);
  // the box is sized to the image's aspect at import, so "contain" fills it edge
  // to edge without distortion.
  img.style.objectFit = "contain";
  img.draggable = false;
  w.appendChild(img);
}

function fillVideo(w: HTMLElement, el: Extract<SlideElement, { type: "video" }>, ctx: SlideRenderCtx): void {
  const url = ctx.assetUrl?.(el.assetId);
  const v = document.createElement("video");
  if (url) v.src = url;
  v.style.width = "100%";
  v.style.height = "100%";
  v.style.objectFit = "contain";
  v.muted = el.muted ?? true;
  v.loop = el.loop ?? false;
  v.controls = el.controls ?? false;
  v.playsInline = true;
  if (el.poster) {
    const purl = ctx.assetUrl?.(el.poster);
    if (purl) v.poster = purl;
  }
  // Autoplay is honored by the player on the element's build beat (not here).
  w.appendChild(v);
}

function fillEmbedFigure(
  w: HTMLElement,
  el: Extract<SlideElement, { type: "embedFigure" }>,
  ctx: SlideRenderCtx,
): void {
  const svg = ctx.figureSvg?.(el.figureId);
  if (!svg) {
    w.classList.add("sl-missing");
    w.textContent = `figure: ${el.figureId}`;
    return;
  }
  w.innerHTML = svg;
  const inner = w.querySelector("svg");
  if (inner) {
    inner.setAttribute("width", "100%");
    inner.setAttribute("height", "100%");
    inner.setAttribute("preserveAspectRatio", el.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet");
  }
}

/** Mount a semantic plot into the wrapper as an inline <svg>, keeping its parts
 *  addressable (id-prefixed by element id) for the P2 player + P3 morph. */
function fillPlot(w: HTMLElement, el: Extract<SlideElement, { type: "plot" }>): void {
  const cached = plotDom.get(el.assetId);
  if (!cached) {
    w.classList.add("sl-missing");
    w.textContent = "plot not loaded";
    return;
  }
  const inst = document.importNode(cached, true) as SVGSVGElement;
  prefixIds(inst, el.id);
  inst.setAttribute("width", "100%");
  inst.setAttribute("height", "100%");
  inst.setAttribute("preserveAspectRatio", "none");
  inst.style.overflow = "visible";
  // applyOverrides needs the live manifest; `get` from svelte/store is framework-neutral.
  applyOverrides(inst, el.overrides, el.id, get(plotManifests)[el.assetId]);
  w.appendChild(inst);
}

// --- a vector shape (figure rect/ellipse/line/path) as inline SVG -----------
function fillShape(w: HTMLElement, el: FigElement): void {
  if (el.type === "rect") {
    w.style.background = el.fill;
    if (el.strokeWidth) w.style.border = `${el.strokeWidth}px solid ${el.stroke}`;
    if (el.cornerRadius) w.style.borderRadius = `${el.cornerRadius}px`;
    return;
  }
  if (el.type === "ellipse") {
    w.style.background = el.fill;
    if (el.strokeWidth) w.style.border = `${el.strokeWidth}px solid ${el.stroke}`;
    w.style.borderRadius = "50%";
    return;
  }
  // line / path → an inline SVG sized to the wrapper, drawn in element-local coords.
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("viewBox", `0 0 ${el.width || 1} ${el.height || 1}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.overflow = "visible";
  if (el.type === "line") {
    const ln = document.createElementNS(SVG_NS, "line");
    ln.setAttribute("x1", String(el.x1));
    ln.setAttribute("y1", String(el.y1));
    ln.setAttribute("x2", String(el.x2));
    ln.setAttribute("y2", String(el.y2));
    ln.setAttribute("stroke", el.stroke);
    ln.setAttribute("stroke-width", String(el.strokeWidth));
    ln.setAttribute("stroke-linecap", "round");
    svg.appendChild(ln);
  } else if (el.type === "path") {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", el.d);
    p.setAttribute("fill", el.closed ? el.fill : "none");
    p.setAttribute("stroke", el.stroke);
    p.setAttribute("stroke-width", String(el.strokeWidth));
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
  }
  w.appendChild(svg);
}

function fillFigureText(w: HTMLElement, el: Extract<FigElement, { type: "text" }>): void {
  w.style.display = "flex";
  w.style.alignItems = "flex-start";
  w.style.color = el.color;
  w.style.fontFamily = el.fontFamily;
  w.style.fontSize = `${el.fontSize}px`;
  w.style.fontWeight = String(el.fontWeight);
  if (el.fontStyle === "italic") w.style.fontStyle = "italic";
  w.style.textAlign = el.align;
  w.style.whiteSpace = "pre-wrap";
  w.textContent = el.text;
}

// --- the main entry ---------------------------------------------------------
/** Render a slide's static (resting) state into `host`, applying the theme. */
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
  host.style.background = slide.background ?? ctx.theme.background;
  // Apply the theme as scoped --sl-* custom properties on the stage root.
  for (const decl of themeCssVars(ctx.theme).split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) host.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }

  const elements = new Map<string, HTMLElement>();
  for (const el of slide.elements) {
    const w = wrapper(el);
    switch (el.type) {
      case "textBox":
        fillTextBox(w, el);
        break;
      case "math":
        fillMath(w, el);
        break;
      case "video":
        fillVideo(w, el, ctx);
        break;
      case "embedFigure":
        fillEmbedFigure(w, el, ctx);
        break;
      case "image":
      case "svg":
        fillImage(w, el, ctx);
        break;
      case "plot":
        fillPlot(w, el);
        break;
      case "rect":
      case "ellipse":
      case "line":
      case "path":
        fillShape(w, el);
        break;
      case "text":
        fillFigureText(w, el);
        break;
      default:
        break;
    }
    host.appendChild(w);
    elements.set(el.id, w);
  }
  return { elements };
}
