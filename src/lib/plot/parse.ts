// Parse + address a FluxPlot semantic SVG inside the app.
//
// The same plot may be placed many times on a canvas, so each placement's
// inlined copy gets its ids (and every internal reference to them) prefixed with
// the element's own id — otherwise duplicate `id="control.point.3"` /
// `<clipPath>` defs would collide and `url(#…)` would resolve to the wrong
// instance. The manifest keeps the canonical (unprefixed) ids; we recover the
// semantic id from a clicked node by stripping the prefix.

import type { FluxPlotManifest, PartInfo, PartNode } from "./types";
import type { PartOverride } from "../types";
import { resolveTargets } from "./tree";
import { normalizeSvgForParts, isDrawableTag, insideDefs } from "./derive";

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

// --- override application -------------------------------------------------
//
// The semantic id usually sits on a <g> WRAPPER while the generator (matplotlib)
// puts explicit inline styles on the child drawables (`<text style="font-size:
// 5px; fill:#100f0f">`, `<path style="stroke:#dad8ce">`). An inline style on a
// child always beats a style inherited from the wrapper, so wrapper-level writes
// silently did nothing for paint/font properties (only display:none and opacity
// — which composite rather than inherit — worked). The fix: structural props
// (hidden/opacity/dx/dy) stay on the wrapper; paint/font props are DRILLED to
// the drawable descendants and written as inline style there, which wins.

/** The wrapper itself if drawable, else its drawable descendants — excluding
 *  anything inside a <defs> subtree (template content). */
export function drawablesUnder(el: Element): Element[] {
  if (isDrawableTag(el.tagName)) return [el];
  const out: Element[] = [];
  for (const d of Array.from(el.querySelectorAll("text,tspan,path,line,polyline,polygon,rect,circle,ellipse,image,use"))) {
    if (!insideDefs(d)) out.push(d);
  }
  return out;
}

const TEXTY = new Set(["text", "tspan"]);

/** A drawable's OWN declared fill (inline style or presentation attribute), or
 *  null when it declares nothing. Used to avoid filling `fill:none` line paths
 *  when a group-level fill override fans out to mixed leaves. Linkedom-safe. */
function declaredFill(el: Element): string | null {
  const style = el.getAttribute("style") ?? "";
  const m = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
  if (m) return m[1].trim();
  return el.getAttribute("fill");
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

      // Wrapper-level: visibility, compositing opacity, translation.
      const s = el.style;
      if (ov.hidden != null) s.display = ov.hidden ? "none" : "";
      if (ov.opacity != null) s.opacity = String(ov.opacity);
      if (ov.dx != null || ov.dy != null) {
        const dx = Number(ov.dx ?? 0) || 0;
        const dy = Number(ov.dy ?? 0) || 0;
        // The clone is pristine per application, so the attribute present here
        // IS the node's original transform — a plain prepend is idempotent.
        const orig = el.getAttribute("transform") ?? "";
        const t = [`translate(${dx} ${dy})`, orig].filter(Boolean).join(" ");
        el.setAttribute("transform", t);
      }

      // Drawable-level: paint + font properties (inline style on the drawable
      // itself wins over its generator-declared inline values — we overwrite
      // the same declaration).
      const hasPaint =
        ov.stroke != null ||
        ov.fill != null ||
        ov.strokeWidth != null ||
        ov.fontSize != null ||
        ov.fontFamily != null ||
        ov.fontWeight != null ||
        ov.fontStyle != null ||
        ov.textDecoration != null;
      if (!hasPaint) continue;

      for (const d of drawablesUnder(el)) {
        const ds = (d as SVGElement).style;
        if (ov.stroke != null) ds.stroke = String(ov.stroke);
        if (ov.strokeWidth != null) ds.strokeWidth = String(ov.strokeWidth);
        if (ov.fill != null) {
          // Don't fill shapes that explicitly opt out (line paths) unless the
          // override targets exactly this node (leaf-level intent is explicit).
          const own = declaredFill(d);
          const leafIntent = d === el;
          if (leafIntent || own == null || own.toLowerCase() !== "none") ds.fill = String(ov.fill);
        }
        const texty = TEXTY.has(d.tagName?.toLowerCase() ?? "");
        if (texty) {
          if (ov.fontSize != null) ds.fontSize = `${ov.fontSize}px`;
          if (ov.fontFamily != null) ds.fontFamily = String(ov.fontFamily);
          if (ov.fontWeight != null) ds.fontWeight = String(ov.fontWeight);
          if (ov.fontStyle != null) ds.fontStyle = String(ov.fontStyle);
          if (ov.textDecoration != null) ds.textDecoration = String(ov.textDecoration);
        }
      }
    }
  }
}

function cssEscape(s: string): string {
  // CSS.escape exists in Chromium (the app's runtime); fall back just in case.
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Orphan defense: make UN-manifested SVG content addressable.
//
// A generator gap (a raw ax.plot() the tagger didn't sweep, a colorbar axis, an
// old pre-regen SVG) leaves visible geometry with no manifest part — invisible
// to the X-ray tree, unmaskable (applyOverrides only walks known ids), immune
// even to a whole-figure mask (leavesUnder enumerates known leaves). This pass
// runs at cachePlot time — the ONE seam shared by the app AND the export
// runtime — and appends a synthetic "unclassified" group whose members are the
// orphan ids, so they become maskable/animatable and ride figure-level masks.
// ---------------------------------------------------------------------------
const ORPHAN_SKIP = new Set(["defs", "clippath", "style", "metadata", "title", "desc"]);

/** Append a synthetic `unclassified` parts group for id-carrying SVG content the
 *  manifest doesn't cover. Pure DOM reads (linkedom-safe); returns the manifest
 *  unchanged when there is no parts tree or nothing is orphaned, else a copy
 *  with the group attached under the plot-area (or root) node. */
export function augmentManifestOrphans(
  svgRoot: Element,
  manifest: FluxPlotManifest | undefined,
): FluxPlotManifest | undefined {
  const parts = manifest?.parts;
  if (!manifest || !parts || !parts.role) return manifest;

  // The ids the manifest addresses DIRECTLY (leaf coverage). Container/group
  // names (figure, plot-area, axis.x, …) are deliberately NOT in this set —
  // their coverage is "the enumerated leaves beneath them", so the walk must
  // descend THROUGH them to find strays living alongside the covered leaves.
  const covered = new Set<string>();
  const walkPart = (n: PartNode) => {
    const members = n.members ?? [];
    const children = n.children ?? [];
    for (const m of members) covered.add(m);
    for (const c of children) walkPart(c);
    if (!members.length && !children.length) {
      const k = n.id ?? n.ref;
      if (k) covered.add(k);
    }
  };
  walkPart(parts);
  for (const s of manifest.series ?? []) {
    if (s.svg?.line) covered.add(s.svg.line);
    if (s.svg?.points) covered.add(s.svg.points);
    for (const pt of s.points ?? []) covered.add(pt.svgId);
    const bars = s.svg?.bars;
    if (Array.isArray(bars)) for (const b of bars) covered.add(b);
  }
  for (const o of manifest.overlays ?? []) covered.add(o.svgId);
  for (const g of manifest.guides ?? []) if (g.svgId) covered.add(g.svgId);

  // Which elements CONTAIN covered content (one pass, ancestors marked).
  const hasCoveredDesc = new Set<Element>();
  for (const el of Array.from(svgRoot.querySelectorAll("[id]"))) {
    if (!covered.has(el.getAttribute("id") ?? "")) continue;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (hasCoveredDesc.has(p)) break;
      hasCoveredDesc.add(p);
    }
  }

  // matplotlib's OWN backgrounds — the first patch_N child of the figure group
  // and of each plot-area — are scaffolding, not content; orphaning them would
  // put a permanent "Unclassified" row on every plot. (Real patch content, like
  // streamplot arrowheads, is swept into tagged extras by the generator.)
  const bgSkip = new Set<Element>();
  const hosts = [svgRoot.querySelector('[id="figure"]'), ...Array.from(svgRoot.querySelectorAll('[id^="plot-area"]'))];
  for (const host of hosts) {
    if (!host) continue;
    for (const c of Array.from(host.children)) {
      if (/^patch_\d+$/.test((c as Element).getAttribute?.("id") ?? "")) {
        bgSkip.add(c as Element);
        break;
      }
    }
  }

  // DFS: a covered id ends its branch (already addressed); an uncovered id with
  // NO covered descendant is one orphan (its whole subtree); otherwise descend —
  // so wrappers like matplotlib's xtick_N or the figure root never match, while
  // a stray line2d_N or a whole unaddressed colorbar axis matches ONCE.
  const orphans: string[] = [];
  const visit = (el: Element) => {
    if (ORPHAN_SKIP.has(el.tagName?.toLowerCase() ?? "") || bgSkip.has(el)) return;
    const id = el.getAttribute?.("id");
    if (id && covered.has(id)) return;
    if (id && !hasCoveredDesc.has(el)) {
      orphans.push(id);
      return;
    }
    for (const c of Array.from(el.children ?? [])) visit(c as Element);
  };
  for (const c of Array.from(svgRoot.children)) visit(c as Element);
  if (!orphans.length) return manifest;

  const cloned = structuredClone(parts) as PartNode;
  const findRole = (n: PartNode, role: string): PartNode | null => {
    if (n.role === role) return n;
    for (const c of n.children ?? []) {
      const f = findRole(c, role);
      if (f) return f;
    }
    return null;
  };
  const host = findRole(cloned, "plot-area") ?? cloned;
  host.children = host.children ?? [];
  host.children.push({ id: "unclassified", role: "group", groupRole: "unclassified", members: orphans } as PartNode);
  return { ...manifest, parts: cloned };
}

// ---------------------------------------------------------------------------
// The ONE preparation seam. Every consumer of a plot DOM — app cache
// (plot/store.ts cachePlot → renderer + exporter clones) and flux-core's
// headless exporter (buildPlotMarkup) — must go through this, so normalization
// (sanitize / <use>-inline / id stamping) and orphan augmentation behave
// identically in-app and headless. Parsing bytes directly elsewhere is a bug.
// ---------------------------------------------------------------------------
export function preparePlot(
  svgText: string,
  manifest?: FluxPlotManifest,
): { root: SVGSVGElement | null; manifest?: FluxPlotManifest } {
  const root = parsePlotSvg(svgText);
  if (!root) return { root: null, manifest };
  normalizeSvgForParts(root as unknown as Element);
  // Phase 4 (vanilla pipeline) adds: if (!manifest) manifest = deriveManifestFromSvg(root)
  if (manifest) {
    manifest = augmentManifestOrphans(root as unknown as Element, manifest) ?? manifest;
  }
  return { root, manifest };
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
