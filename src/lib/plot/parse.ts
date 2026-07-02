// Parse + address a FluxPlot semantic SVG inside the app.
//
// The same plot may be placed many times on a canvas, so each placement's
// inlined copy gets its ids (and every internal reference to them) prefixed with
// the element's own id — otherwise duplicate `id="control.point.3"` /
// `<clipPath>` defs would collide and `url(#…)` would resolve to the wrong
// instance. The manifest keeps the canonical (unprefixed) ids; we recover the
// semantic id from a clicked node by stripping the prefix.

import type { FluxPlotManifest, PartInfo } from "./types";
import type { PartOverride } from "../types";
import { resolveTargets } from "./tree";

const XLINK = "http://www.w3.org/1999/xlink";
const SEP = "__";

/** Parse semantic SVG text into a detached <svg> root, or null if malformed. */
export function parsePlotSvg(svgText: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;
  return root as unknown as SVGSVGElement;
}

function prefixOf(elementId: string): string {
  return elementId + SEP;
}

/** Rewrite every id and every internal id-reference under `root` with `prefix`. */
export function prefixIds(root: Element, elementId: string): void {
  const p = prefixOf(elementId);
  const map = new Map<string, string>();
  for (const el of [root, ...Array.from(root.querySelectorAll("[id]"))]) {
    const old = el.getAttribute("id");
    if (!old) continue;
    const neu = p + old;
    map.set(old, neu);
    el.setAttribute("id", neu);
  }
  const URL_ATTRS = ["clip-path", "mask", "filter", "fill", "stroke", "marker-start", "marker-mid", "marker-end"];
  const rewriteUrls = (s: string) => s.replace(/url\(#([^)]+)\)/g, (_m, id) => `url(#${map.get(id) ?? id})`);
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attr of URL_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && v.includes("url(#")) el.setAttribute(attr, rewriteUrls(v));
    }
    // FIG-11: an inline `style="fill:url(#…)"` binds a gradient/clip/mask too — the
    // attribute pass above misses it, so two placements of the same plot would resolve
    // the SAME (unprefixed) id and collide (wrong fill/clip on one of them).
    const style = el.getAttribute("style");
    if (style && style.includes("url(#")) el.setAttribute("style", rewriteUrls(style));
    // plain href (SVG2) and namespaced xlink:href (matplotlib <use>)
    const href = el.getAttribute("href");
    if (href && href.startsWith("#")) el.setAttribute("href", "#" + (map.get(href.slice(1)) ?? href.slice(1)));
    const xh = el.getAttributeNS(XLINK, "href");
    if (xh && xh.startsWith("#")) el.setAttributeNS(XLINK, "xlink:href", "#" + (map.get(xh.slice(1)) ?? xh.slice(1)));
  }
  // FIG-11: <style> blocks reference gradients/clips by url(#…) as well (e.g. a CSS rule
  // `.area{fill:url(#grad)}`) — rewrite those so a second placement's CSS points at ITS
  // prefixed gradient, not the first placement's.
  for (const st of Array.from(root.querySelectorAll("style"))) {
    const css = st.textContent;
    if (css && css.includes("url(#")) st.textContent = rewriteUrls(css);
  }
}

/** Walk up from a clicked node to the nearest prefixed id → canonical semantic id. */
export function semanticIdFromNode(node: Element | null, elementId: string): string | null {
  const p = prefixOf(elementId);
  let el: Element | null = node;
  while (el) {
    const id = el.getAttribute ? el.getAttribute("id") : null;
    if (id && id.startsWith(p)) return id.slice(p.length);
    el = el.parentElement;
  }
  return null;
}

/** Apply per-part style overrides to the inlined DOM. A key may be a leaf semantic
 * id (`control.point.3`) or a group/container id (`axis.x.tick-labels`, `axis.x`),
 * which the manifest resolves to its current leaf members — so a group edit survives
 * regeneration. Passing `manifest` enables that expansion; without it, keys are literal. */
export function applyOverrides(
  root: Element,
  overrides: Record<string, PartOverride> | undefined,
  elementId: string,
  manifest?: FluxPlotManifest,
): void {
  if (!overrides) return;
  const p = prefixOf(elementId);
  for (const [partId, ov] of Object.entries(overrides)) {
    for (const tid of resolveTargets(manifest, partId)) {
      const el = root.querySelector(`[id="${cssEscape(p + tid)}"]`) as SVGElement | null;
      if (!el) continue;
      const s = el.style;
      if (ov.hidden != null) s.display = ov.hidden ? "none" : "";
      if (ov.stroke != null) s.stroke = String(ov.stroke);
      if (ov.fill != null) s.fill = String(ov.fill);
      if (ov.strokeWidth != null) s.strokeWidth = String(ov.strokeWidth);
      if (ov.opacity != null) s.opacity = String(ov.opacity);
      if (ov.fontSize != null) s.fontSize = `${ov.fontSize}px`;
      if (ov.fontFamily != null) s.fontFamily = String(ov.fontFamily);
      if (ov.fontWeight != null) s.fontWeight = String(ov.fontWeight);
    }
  }
}

function cssEscape(s: string): string {
  // CSS.escape exists in Chromium (the app's runtime); fall back just in case.
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

/** Flatten a manifest into a semantic-id → part lookup, for the inspector. */
export function buildPartIndex(m: FluxPlotManifest | undefined): Record<string, PartInfo> {
  const idx: Record<string, PartInfo> = {};
  if (!m) return idx;
  for (const s of m.series ?? []) {
    if (s.svg?.line) idx[s.svg.line] = { id: s.svg.line, role: "line", series: s.id };
    if (s.svg?.points) idx[s.svg.points] = { id: s.svg.points, role: "point", series: s.id };
    for (const pt of s.points ?? []) {
      idx[pt.svgId] = { id: pt.svgId, role: "point", series: s.id, index: pt.index, x: pt.x, y: pt.y };
    }
    const bars = s.svg?.bars;
    if (Array.isArray(bars)) bars.forEach((b, i) => (idx[b] = { id: b, role: "bar", series: s.id, index: i }));
  }
  for (const o of m.overlays ?? []) idx[o.svgId] = { id: o.svgId, role: o.role, label: o.label };
  for (const g of m.guides ?? []) if (g.svgId) idx[g.svgId] = { id: g.svgId, role: g.role };
  return idx;
}
