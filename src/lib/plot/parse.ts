import { rewriteLocalUrls, rewriteCssReferences, passivePaint, svgNamespace } from "./passiveSvg";
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
import { resolveTargets, inferRole, labelForPart } from "./tree";
import { normalizeSvgForParts, deriveManifestFromSvg, isDrawableTag, insideDefs } from "./derive";

const XLINK = "http://www.w3.org/1999/xlink";
const SEP = "__";

/** Parse semantic SVG text into a detached <svg> root, or null if malformed. */
export function parsePlotSvg(svgText: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg" || svgNamespace(root)!=="http://www.w3.org/2000/svg") return null;
  return root as unknown as SVGSVGElement;
}

function prefixOf(elementId: string): string {
  return elementId + SEP;
}

/** Rewrite every id and every internal id-reference under `root` with `prefix`,
 *  then scope the plot's <style> rules to `root` (see scopePlotStyles below). */
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
  const rewriteUrls = (s: string) => rewriteLocalUrls(s, map);
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attr of URL_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, rewriteUrls(v));
    }
    // FIG-11: an inline `style="fill:url(#…)"` binds a gradient/clip/mask too — the
    // attribute pass above misses it, so two placements of the same plot would resolve
    // the SAME (unprefixed) id and collide (wrong fill/clip on one of them).
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", rewriteCssReferences(`x{${style}}`, map).replace(/^x\{|\}$/g, ""));
    // plain href (SVG2) and namespaced xlink:href (matplotlib <use>)
    for (const attr of Array.from(el.attributes)) {
      if (attr.localName === "href" || attr.name.split(":").at(-1) === "href") {
        const value = attr.value.trim();
        if (value.startsWith("#")) el.setAttribute(attr.name, "#"+(map.get(value.slice(1)) ?? value.slice(1)));
      }
      if (["aria-labelledby", "aria-describedby"].includes(attr.name)) el.setAttribute(attr.name,attr.value.split(/\s+/).map(id=>map.get(id)??id).join(" "));
    }

  }
  // FIG-11: <style> blocks reference gradients/clips by url(#…) as well (e.g. a CSS rule
  // `.area{fill:url(#grad)}`) — rewrite those so a second placement's CSS points at ITS
  // prefixed gradient, not the first placement's.
  for (const st of Array.from(root.querySelectorAll("style"))) {
    const css = st.textContent;
    if (css) st.textContent = rewriteCssReferences(css, map);
  }
  scopePlotStyles(root, elementId);
}

// Bake the uniform matplotlib stroke defaults without introducing a second CSS
// engine. Anything beyond this deliberately small, static subset keeps ALL its
// sheets (scoped by prefixIds). Partially baking arbitrary CSS changes cascade
// priority, selector matching and conditional rules; exports must look the same.
export function bakePlotStyles(root: Element): { baked: number; kept: number; attrs: number } {
  const styles = Array.from(root.querySelectorAll("style"));
  const defaults = new Map<string, string>();
  let rules = 0;
  for (const st of styles) {
    // Only ordinary CSS sheets qualify. A media/title/type attribute can make
    // the same rule inactive; preserving the sheet preserves that condition.
    if (Array.from(st.attributes).some(a => a.name !== "type" || a.value.trim().toLowerCase() !== "text/css")) {
      return { baked: 0, kept: styles.length, attrs: 0 };
    }
    const css = (st.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const matches = Array.from(css.matchAll(/\*\s*\{([^{}]*)\}/g));
    if (css.replace(/\*\s*\{[^{}]*\}/g, "").trim()) return { baked: 0, kept: styles.length, attrs: 0 };
    for (const m of matches) {
      for (const decl of m[1].split(";").map(s => s.trim()).filter(Boolean)) {
        const pair = /^(stroke-linecap|stroke-linejoin)\s*:\s*(butt|round|square|miter|bevel)$/i.exec(decl);
        if (!pair) return { baked: 0, kept: styles.length, attrs: 0 };
        const prop = pair[1].toLowerCase(), value = pair[2].toLowerCase();
        const allowed = prop === "stroke-linecap" ? ["butt", "round", "square"] : ["miter", "round", "bevel"];
        if (!allowed.includes(value)) return { baked: 0, kept: styles.length, attrs: 0 };
        defaults.set(prop, value);
      }
      rules++;
    }
  }
  let attrs = 0;
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const [prop, value] of defaults) {
      // Valid inline declarations still win over this presentation attribute.
      // Invalid inline declarations are ignored by CSS, so they must retain
      // the universal rule's fallback too. No inline CSS parser is needed.
      el.setAttribute(prop, value);
      attrs++;
    }
  }
  for (const st of styles) st.remove();
  return { baked: rules, kept: 0, attrs };
}

// --- clip-path hoisting (the editor's mounted DOM) ----------------------------
//
// matplotlib stamps the SAME `clip-path="url(#p…)"` on nearly every artist of an
// axes (4,038 of 4,163 elements in one dense fluxplot). In Chromium every
// clipped element is its own paint chunk, and layerization
// (PaintArtifactCompositor::Update) walks every chunk on every hover outline,
// selection change or overlay repaint — 4 ms per dense plot, ~10 ms per click
// on a 21-plot figure (2026-09-16). Wrapping each run of consecutive siblings
// that share a static user-space clip in ONE clipped <g> can reduce these
// chunks substantially. Only eligible leaf geometry is grouped: bounding-box
// clips, text, transforms, definitions and any stylesheet keep their original
// structure. Part translation restores the original per-child clips before
// moving. Editor cache only — exports serialize the pristine parse.

/** Wrap runs of ≥2 consecutive element siblings sharing a clip-path (and
 *  carrying no transform) in one clipped <g>. Returns counts for the gates. */
export function hoistPlotClips(root: Element): { groups: number; hoisted: number } {
  let groups = 0;
  let hoisted = 0;
  if (root.querySelector("style")) return { groups, hoisted };
  const clips = new Map(Array.from(root.querySelectorAll("clipPath[id]")).map(el => [el.id, el]));
  const safeClip = (el: Element): string | null => {
    if (!/^(path|rect|circle|ellipse|line|polyline|polygon)$/.test(el.localName) || el.hasAttribute("data-flux-glyph")) return null;
    if (el.children.length) return null; // Includes animate/animateTransform: this must be a static leaf.
    if (/(^|;)\s*(transform|clip-path)\s*:/i.test(el.getAttribute("style") ?? "")) return null;
    const cp = el.getAttribute("clip-path");
    const id = cp && /^url\(#([^()]+)\)$/.exec(cp)?.[1];
    const clip = id ? clips.get(id) : null;
    return clip && (clip.getAttribute("clipPathUnits") ?? "userSpaceOnUse") === "userSpaceOnUse" ? cp : null;
  };
  const hasTransform = (el: Element) => el.hasAttribute("transform") || /(^|;)\s*transform\s*:/.test(el.getAttribute("style") ?? "");
  const parents = [root, ...Array.from(root.querySelectorAll("g, svg, a"))];
  for (const parent of parents) {
    if (insideDefs(parent) || parent.closest("clipPath, mask, pattern, marker, symbol")) continue;
    const kids = Array.from(parent.children);
    let i = 0;
    while (i < kids.length) {
      const cp = safeClip(kids[i]);
      if (!cp || hasTransform(kids[i])) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < kids.length && safeClip(kids[j]) === cp && !hasTransform(kids[j])) j++;
      if (j - i >= 2) {
        const doc = parent.ownerDocument ?? document;
        const g = doc.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("clip-path", cp);
        g.setAttribute("data-flux-clip-run", "");
        parent.insertBefore(g, kids[i]);
        for (let k = i; k < j; k++) {
          kids[k].removeAttribute("clip-path");
          g.appendChild(kids[k]);
        }
        groups++;
        hoisted += j - i;
      }
      i = j;
    }
  }
  return { groups, hoisted };
}

/** A semantic edit can translate a formerly static child. Restore this run's
 *  original per-child clips first, so the clip follows the edited object just
 *  as it does in exports. The identity wrapper stays: live gesture references
 *  and traversal order remain valid. */
export function restorePlotClip(el: Element): void {
  const parent = el.parentElement;
  if (!parent?.hasAttribute("data-flux-clip-run")) return;
  const cp = parent.getAttribute("clip-path");
  if (cp) for (const child of Array.from(parent.children)) child.setAttribute("clip-path", cp);
  parent.removeAttribute("clip-path");
  parent.removeAttribute("data-flux-clip-run");
}

// --- <style> scoping --------------------------------------------------------
//
// An inlined plot shares the HOST document's cascade: an SVG <style> has no
// scope inside an HTML document (nor inside a composed export SVG), so
// matplotlib's preamble `*{stroke-linejoin: round; stroke-linecap: butt}`
// restyled every Flux <line>/<path>/<rect> on the canvas the moment a plot was
// mounted — round-capped lines drew FLAT until zooming in culled the plot out
// of the DOM (2026-09-11 report). The same rule leaked across plots, into paper
// embeds, and into exported SVGs (browsers and resvg honor it there too).
// prefixIds therefore scopes every rule to the placement's own root: the root
// is stamped `data-plot-scope="<elementId>"` and each selector becomes
// `[data-plot-scope="<elementId>"] <selector>`. Specificity rises uniformly,
// so the plot's OWN cascade (inline style > rules > presentation attributes) is
// unchanged. The descendant form is deliberate: it is what resvg/usvg's CSS
// supports (`@scope` is Chromium-only and resvg drops it — verified 2026-09-11).
export const PLOT_SCOPE_ATTR = "data-plot-scope";

/** Stamp `root` as the scope and rewrite every <style> under it. Style-less
 *  plots are untouched (no attribute, byte-identical). */
export function scopePlotStyles(root: Element, elementId: string): void {
  const styles = Array.from(root.querySelectorAll("style"));
  if (!styles.length) return;
  root.setAttribute(PLOT_SCOPE_ATTR, elementId);
  const scope = `[${PLOT_SCOPE_ATTR}="${elementId.replace(/[\\"]/g, (c) => "\\" + c)}"]`;
  for (const st of styles) {
    const css = st.textContent;
    if (css && css.trim()) st.textContent = scopeCss(css, scope);
  }
}

// Conditional group rules whose bodies hold ordinary rules — recurse into these.
// Every other at-rule (@font-face, @keyframes, @page, …) passes through verbatim:
// its body is declarations or keyframe selectors, never element selectors.
const NESTED_AT_RULE = /^@(media|supports|container|layer|document|scope)\b/;

/** Prefix every selector in `css` with `scope ` (descendant combinator).
 *  Block-less statements (`@import …;`) and non-conditional at-rules pass
 *  through; comments are dropped. Pure string work — no DOM, linkedom-safe. */
export function scopeCss(css: string, scope: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) {
      out += src.slice(i);
      break;
    }
    const semi = src.indexOf(";", i);
    if (semi >= 0 && semi < open) {
      // a statement with no block (`@import url(x);`) — verbatim
      out += src.slice(i, semi + 1);
      i = semi + 1;
      continue;
    }
    // matching close brace, nesting-aware (an unterminated block runs to the end)
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      j++;
    }
    const body = src.slice(open + 1, depth === 0 ? j - 1 : j);
    const prelude = src.slice(i, open);
    const lead = /^\s*/.exec(prelude)![0];
    const sel = prelude.trim();
    if (!sel) out += prelude + "{" + body + "}";
    else if (sel.startsWith("@")) out += lead + sel + "{" + (NESTED_AT_RULE.test(sel) ? scopeCss(body, scope) : body) + "}";
    else out += lead + splitSelectors(sel).map((s) => /:root\b/.test(s) ? s.replace(/:root\b/g, scope) : `${scope} ${s}`).join(", ") + "{" + body + "}";
    i = j;
  }
  return out;
}

/** Split a selector list on top-level commas — commas inside `:is(a, b)` or
 *  `[attr="a,b"]` belong to one selector. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, k));
      start = k + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
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

// A dx/dy-translated node's ORIGINAL transform (pre-override), so repeated
// applyOverrides on one live instance (the slide transform driver, per frame)
// replaces the translate instead of stacking prepends. Per DOM node, never
// serialized; one-shot clone flows never notice it.
const preOverrideTransform = new WeakMap<Element, string>();

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
        restorePlotClip(el);
        const dx = Number(ov.dx ?? 0) || 0;
        const dy = Number(ov.dy ?? 0) || 0;
        // Compose the translate over the node's PRE-OVERRIDE transform. A
        // plain prepend was fine when every application ran on a pristine
        // clone, but the slide transform driver re-applies overrides per
        // frame on the SAME instance — remember the original (per DOM node,
        // never serialized) so re-application replaces instead of stacking.
        let orig = preOverrideTransform.get(el);
        if (orig === undefined) {
          orig = el.getAttribute("transform") ?? "";
          preOverrideTransform.set(el, orig);
        }
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
        if (ov.stroke != null) ds.stroke = passivePaint(String(ov.stroke));
        if (ov.strokeWidth != null) ds.strokeWidth = String(ov.strokeWidth);
        if (ov.fill != null) {
          // Don't fill shapes that explicitly opt out (line paths) unless the
          // override targets exactly this node (leaf-level intent is explicit).
          const own = declaredFill(d);
          const leafIntent = d === el;
          if (leafIntent || own == null || own.toLowerCase() !== "none") ds.fill = passivePaint(String(ov.fill));
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
  // No sidecar manifest (a "vanilla" svg) → synthesize one from the DOM so ANY
  // svg is x-rayable/part-editable. NEVER persisted (see plot/derive.ts).
  if (!manifest) manifest = deriveManifestFromSvg(root as unknown as Element);
  manifest = augmentManifestOrphans(root as unknown as Element, manifest) ?? manifest;
  return { root, manifest };
}

/** Flatten a manifest into a semantic-id → part lookup, for the inspector /
 *  part-property UIs. Base layer = the ENTIRE parts tree (containers, groups,
 *  and their member leaves — so ticklabel/axis-title/gridline ids resolve to a
 *  real role + label instead of the "part" fallback); the series/overlays/
 *  guides entries are written after and OVERWRITE — they're richer (series id,
 *  point index, data coords). */
export function buildPartIndex(m: FluxPlotManifest | undefined): Record<string, PartInfo> {
  const idx: Record<string, PartInfo> = {};
  if (!m) return idx;
  const parts = m.parts as PartNode | undefined;
  if (parts && parts.role) {
    const walk = (n: PartNode) => {
      const k = n.id ?? n.ref;
      if (k && !idx[k]) {
        const role = n.role === "group" ? (n.groupRole ?? "group") : (n.role ?? inferRole(k));
        idx[k] = { id: k, role, label: labelForPart(n) };
      }
      for (const member of n.members ?? []) {
        if (!idx[member]) {
          idx[member] = { id: member, role: inferRole(member), label: labelForPart({ id: member }) };
        }
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(parts);
  }
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
