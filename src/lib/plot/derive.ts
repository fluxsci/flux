// Normalize an SVG's DOM so per-part styling is actually possible, and (Phase 4)
// derive a parts manifest for SVGs that ship without one.
//
// Runs once per asset at cachePlot time on the PRISTINE cached DOM — the one
// seam shared by the app renderer, the app exporter (both clone the cache) and
// flux-core's headless exporter (via preparePlot). Everything here is pure DOM
// attribute/structure work: linkedom-safe (no getComputedStyle / getBBox / CTM).
//
// Why normalization is load-bearing (not cosmetic):
//  - matplotlib tick marks / scatter markers are `<use href="#def">` referencing
//    ONE shared `<defs>` path. Styling one tick would either restyle the shared
//    def (leaks to every tick) or style the <use> (loses to the def's own inline
//    style in the use shadow tree). Inlining each <use> into its own cloned node
//    is the only way per-instance styling works.
//  - Arbitrary SVGs may carry <script>/<foreignObject>/on* handlers — we inline
//    untrusted files into the live editor DOM, so those must go.
//  - Derived-manifest ids (Phase 4) must be deterministic across sessions, so
//    unlabeled structural nodes get stable DFS-position ids stamped here.

import type { FluxPlotManifest, PartNode } from "./types";

const DRAWABLE_TAGS = new Set([
  "text",
  "tspan",
  "path",
  "line",
  "polyline",
  "polygon",
  "rect",
  "circle",
  "ellipse",
  "image",
  "use",
]);

const STRUCTURAL_SKIP = new Set(["defs", "clippath", "style", "metadata", "title", "desc", "script", "foreignobject"]);

export function isDrawableTag(tag: string | undefined): boolean {
  return DRAWABLE_TAGS.has((tag ?? "").toLowerCase());
}

/** True if `el` sits inside a <defs> subtree (template content, never styled directly). */
export function insideDefs(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.tagName?.toLowerCase() === "defs") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Sanitize — we inline foreign SVG bytes into the editor document.
// ---------------------------------------------------------------------------
function sanitize(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("script, foreignObject"))) el.remove();
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes ?? [])) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        const v = (attr.value ?? "").trim();
        // Keep same-document (#id) and data: references; drop javascript:/external.
        if (v && !v.startsWith("#") && !v.startsWith("data:")) el.removeAttribute(attr.name);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Inline shared <use> markers.
// ---------------------------------------------------------------------------
const XLINK = "http://www.w3.org/1999/xlink";

function useHref(u: Element): string | null {
  const href = u.getAttribute("href") ?? u.getAttributeNS?.(XLINK, "href") ?? u.getAttribute("xlink:href");
  return href && href.startsWith("#") ? href.slice(1) : null;
}

/** Parse an inline style attribute into a property map (last declaration wins). */
function parseStyle(s: string | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!s) return m;
  for (const decl of s.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim();
    if (k) m.set(k, v);
  }
  return m;
}

function styleString(m: Map<string, string>): string {
  return [...m.entries()].map(([k, v]) => `${k}: ${v}`).join("; ");
}

/** Shadow-tree style semantics for <use>: the referenced element's OWN declared
 *  properties win; the use's properties fill in what the target doesn't declare. */
function mergeUseStyle(target: Element, use: Element): void {
  const useMap = parseStyle(use.getAttribute("style"));
  if (!useMap.size) return;
  const own = parseStyle(target.getAttribute("style"));
  let changed = false;
  for (const [k, v] of useMap) {
    // A presentation ATTRIBUTE on the target also counts as "declared".
    if (!own.has(k) && !target.getAttribute(k)) {
      own.set(k, v);
      changed = true;
    }
  }
  if (changed) target.setAttribute("style", styleString(own));
}

/** Replace every `<use href="#X">` that references <defs> content with its own
 *  cloned copy of X, so each instance is independently styleable. The clone
 *  keeps the USE's identity (semantic id, if any); the def's id is stripped
 *  from the clone (it would collide across instances). Defs that end up with
 *  no remaining <use> references are removed. */
function inlineDefUses(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const inlinedDefIds = new Set<string>();

  for (const use of Array.from(root.querySelectorAll("use"))) {
    const refId = useHref(use);
    if (!refId) continue;
    // querySelector with attribute match avoids CSS.escape needs for dotted ids.
    const target = root.querySelector(`[id="${refId.replace(/"/g, '\\"')}"]`);
    if (!target || !insideDefs(target)) continue; // only defs-hosted templates

    const clone = target.cloneNode(true) as Element;
    clone.removeAttribute("id");
    for (const idc of Array.from(clone.querySelectorAll?.("[id]") ?? [])) idc.removeAttribute("id");
    mergeUseStyle(clone, use);

    // Carry the use's placement: x/y become a translate prepended to the use's
    // own transform (matplotlib puts tick/marker positions on the <use>).
    const x = parseFloat(use.getAttribute("x") ?? "0") || 0;
    const y = parseFloat(use.getAttribute("y") ?? "0") || 0;
    const useTransform = use.getAttribute("transform") ?? "";
    const translate = x || y ? `translate(${x} ${y})` : "";
    const combined = [translate, useTransform].filter(Boolean).join(" ");

    // The clone IS the replacement: identity + placement land directly on it.
    const replacement = clone;
    const cloneTransform = clone.getAttribute("transform") ?? "";
    const t = [combined, cloneTransform].filter(Boolean).join(" ");
    if (t) replacement.setAttribute("transform", t);
    const useId = use.getAttribute("id");
    if (useId) replacement.setAttribute("id", useId);
    // Carry data-* semantics the generator may have put on the use (fluxplot
    // per-point markers: data-role/data-index/data-x/data-y).
    for (const attr of Array.from(use.attributes ?? [])) {
      if (attr.name.startsWith("data-")) replacement.setAttribute(attr.name, attr.value);
    }

    use.replaceWith(replacement);
    inlinedDefIds.add(refId);
  }

  // Drop defs templates nothing references anymore (only <use> ever referenced
  // marker defs; clip paths etc. are url(#…)-referenced and were never inlined).
  for (const id of inlinedDefIds) {
    const stillUsed = Array.from(root.querySelectorAll("use")).some((u) => useHref(u) === id);
    if (stillUsed) continue;
    const def = root.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`);
    if (def && insideDefs(def)) def.remove();
  }
}

// ---------------------------------------------------------------------------
// 3. Stamp deterministic ids on unlabeled structure.
// ---------------------------------------------------------------------------
/** Any <g> or drawable without an id whose parent carries one gets a stable
 *  DFS-position id (`n<index>`). The <svg> root counts as id-carrying so SVGs
 *  with NO ids at all (Illustrator/Inkscape exports) still become addressable
 *  top-down. Bytes-identical input ⇒ identical ids, so overrides keyed on
 *  stamped ids are stable for files that never regenerate. */
function stampIds(root: Element): void {
  let dfs = 0;
  const walk = (el: Element, parentHasId: boolean) => {
    const tag = el.tagName?.toLowerCase() ?? "";
    if (STRUCTURAL_SKIP.has(tag)) return;
    dfs++;
    const hasId = !!el.getAttribute("id");
    if (!hasId && parentHasId && (tag === "g" || DRAWABLE_TAGS.has(tag))) {
      el.setAttribute("id", `n${dfs}`);
    }
    const nowHasId = hasId || !!el.getAttribute("id");
    for (const c of Array.from(el.children ?? [])) walk(c as Element, nowHasId);
  };
  // Treat the root as id-carrying (see doc above).
  for (const c of Array.from(root.children ?? [])) walk(c as Element, true);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
/** Mutates the cached pristine DOM in place. Idempotent: running twice yields
 *  the same tree (sanitize removes nothing new, all defs-uses already inlined,
 *  id stamping only fills gaps deterministically). */
export function normalizeSvgForParts(root: Element): void {
  sanitize(root);
  inlineDefUses(root);
  stampIds(root);
}

// ---------------------------------------------------------------------------
// Derived manifests — make ANY svg x-rayable.
//
// A fluxplot ships a real manifest; every other SVG gets one synthesized from
// its own DOM structure here. matplotlib's native id vocabulary (figure_1,
// axes_1, xtick_3, line2d_7, text_2 …) maps to friendly roles/labels; anything
// else falls back to the tag of its first drawable. Ids are whatever the file
// carries plus the deterministic stamps from normalizeSvgForParts, so override
// keys are stable for files that never regenerate.
//
// NEVER PERSIST a derived manifest to disk: sidecar presence is the fluxplot/
// vanilla discriminator, and re-deriving on every load keeps deriver
// improvements retroactive. (io/figbridge save paths skip isDerivedManifest.)
// ---------------------------------------------------------------------------

export const DERIVED_SPEC = "fluxplot-derived/1";

export function isDerivedManifest(m: FluxPlotManifest | undefined): boolean {
  return m?.spec === DERIVED_SPEC;
}

const MAX_DERIVE_DEPTH = 8;
const MAX_DERIVE_NODES = 800;

const UNIT_TO_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

function sizeOf(root: Element): { width: number; height: number; unit: string } {
  const parse = (v: string | null): { n: number; unit: string } | null => {
    const m = (v ?? "").match(/^\s*([\d.]+)\s*(px|pt|pc|mm|cm|in)?\s*$/);
    return m ? { n: parseFloat(m[1]), unit: m[2] ?? "px" } : null;
  };
  const w = parse(root.getAttribute("width"));
  const h = parse(root.getAttribute("height"));
  if (w && h) return { width: w.n, height: h.n, unit: w.unit };
  const vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3], unit: "px" };
  return { width: 0, height: 0, unit: "px" };
}

function textPreview(el: Element): string {
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return t.length > 18 ? t.slice(0, 17) + "…" : t;
}

function firstDrawableTag(el: Element): string | null {
  if (isDrawableTag(el.tagName)) return el.tagName.toLowerCase();
  for (const d of Array.from(
    el.querySelectorAll("text,tspan,path,line,polyline,polygon,rect,circle,ellipse,image,use"),
  )) {
    if (!insideDefs(d)) return d.tagName.toLowerCase();
  }
  return null;
}

/** matplotlib-aware role + label for one id-carrying node. */
function classify(el: Element, id: string): { role: string; label: string; axis?: string } {
  let m: RegExpMatchArray | null;
  if (/^figure(_\d+)?$/.test(id)) return { role: "figure", label: "Figure" };
  if ((m = id.match(/^axes_(\d+)$/))) return { role: "plot-area", label: `Plot area ${m[1]}` };
  if (/^plot-area/.test(id)) return { role: "plot-area", label: "Plot area" };
  if (/^matplotlib\.axis_\d+$/.test(id)) {
    // x or y from the tick ids beneath
    const isY = !!el.querySelector('[id^="ytick_"]');
    return { role: "axis", axis: isY ? "y" : "x", label: isY ? "Y axis" : "X axis" };
  }
  if ((m = id.match(/^xtick_(\d+)$/))) return { role: "tick", label: `X tick ${m[1]}` };
  if ((m = id.match(/^ytick_(\d+)$/))) return { role: "tick", label: `Y tick ${m[1]}` };
  if ((m = id.match(/^text_(\d+)$/))) {
    const preview = textPreview(el);
    return { role: "text", label: preview ? `Text “${preview}”` : `Text ${m[1]}` };
  }
  if ((m = id.match(/^line2d_(\d+)$/))) return { role: "line", label: `Line ${m[1]}` };
  if ((m = id.match(/^patch_(\d+)$/))) return { role: "shape", label: `Patch ${m[1]}` };
  if (/^legend(_\d+)?$/.test(id)) return { role: "legend", label: "Legend" };
  if ((m = id.match(/^PathCollection_(\d+)$/))) return { role: "points", label: `Points ${m[1]}` };
  if ((m = id.match(/^LineCollection_(\d+)$/))) return { role: "line", label: `Lines ${m[1]}` };
  if ((m = id.match(/^(Quad|Poly)\w*_(\d+)$/))) return { role: "shape", label: `${m[1]} mesh ${m[2]}` };

  // Generic: kind from content.
  const tag = firstDrawableTag(el);
  if (tag === "text" || tag === "tspan") {
    const preview = textPreview(el);
    return { role: "text", label: preview ? `Text “${preview}”` : id };
  }
  if (tag === "path" || tag === "line" || tag === "polyline") return { role: "line", label: id };
  if (tag) return { role: "shape", label: id };
  return { role: "container", label: id };
}

/** Synthesize a manifest for a non-fluxplot SVG from its (normalized) DOM. */
export function deriveManifestFromSvg(root: Element): FluxPlotManifest {
  let count = 0;

  // An id-carrying <g>/drawable becomes a part; un-id'd wrappers are descended
  // through transparently so their id'd children attach to the nearest part.
  const partChildrenOf = (el: Element, depth: number): PartNode[] => {
    const out: PartNode[] = [];
    for (const c of Array.from(el.children ?? []) as Element[]) {
      const tag = c.tagName?.toLowerCase() ?? "";
      if (STRUCTURAL_SKIP.has(tag)) continue;
      const id = c.getAttribute("id");
      if (id && (tag === "g" || isDrawableTag(tag))) {
        if (count >= MAX_DERIVE_NODES) return out; // cap: parents become leaves
        count++;
        const { role, label, axis } = classify(c, id);
        const node: PartNode = { id, role, label };
        if (axis) node.axis = axis;
        // Depth/node caps make this node a LEAF addressing its whole subtree —
        // overrides drill to descendants anyway, so it stays fully functional.
        if (depth < MAX_DERIVE_DEPTH) {
          const kids = partChildrenOf(c, depth + 1);
          if (kids.length) node.children = kids;
        }
        out.push(node);
      } else {
        out.push(...partChildrenOf(c, depth));
      }
    }
    return out;
  };

  const top = partChildrenOf(root, 1);
  // matplotlib shape: one figure_N root — promote it. Anything else gets a
  // synthetic figure-role root so augmentManifestOrphans/buildPartTree work.
  const parts: PartNode =
    top.length === 1 && top[0].role === "figure"
      ? top[0]
      : { id: "svg", role: "figure", label: "SVG", children: top };

  return {
    spec: DERIVED_SPEC,
    schemaVersion: "0",
    generator: { name: "flux-derived", version: "1" },
    plotType: "svg",
    svg: "",
    size: sizeOf(root),
    axes: [],
    series: [],
    parts,
  };
}
