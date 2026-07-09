// Part-kind inference, effective style reads, and breadcrumbs for plot parts.
//
// A selected plot part should behave like the equivalent NATIVE object — a tick
// label gets the text property set, a gridline the stroke set. This module is
// the one place that decides a part's kind and reads its EFFECTIVE style values
// (override → live mounted DOM → pristine cached DOM), so the FluxFig Menu, the
// Inspector and the X-Ray never disagree. Everything here is read-only and
// linkedom-safe (getComputedStyle is a guarded, browser-only last resort).

import type { FluxPlotManifest, PartNode } from "./types";
import type { SemanticPlotElement, PartOverride } from "../types";
import { drawablesUnder, buildPartIndex } from "./parse";
import { inferRole, labelForPart } from "./tree";
import { plotDom } from "./store";

export type PartKind = "text" | "line" | "shape" | "container";

// ---------------------------------------------------------------------------
// Role sets (moved here from PlotXray.svelte — the single source of truth).
// TEXT additionally covers subtitle/label/annotation (unambiguously text; the
// X-Ray previously fell back to "shape" editors for them).
// ---------------------------------------------------------------------------
export const TEXT_ROLES = new Set([
  "axis-title",
  "title",
  "subtitle",
  "tick-label",
  "legend-label",
  "label",
  "annotation",
]);
export const LINEY_ROLES = new Set(["line", "reference-line", "gridline", "spine", "errorbar", "tick", "axis"]);
export const CONTAINER_ROLES = new Set(["series", "plot-area", "figure", "legend", "legend-entry"]);

/** Kind from a role name alone (the X-Ray's original precedence: text →
 *  container → line → shape). For DOM-aware inference use partKind. */
export function partKindFromRole(role: string): PartKind {
  if (TEXT_ROLES.has(role)) return "text";
  if (CONTAINER_ROLES.has(role)) return "container";
  if (LINEY_ROLES.has(role)) return "line";
  return "shape";
}

const KNOWN_KINDS = new Set<string>(["text", "line", "shape", "container"]);

// Whole-plot scaffolding: clicking these must keep dragging the WHOLE plot
// (the plot would otherwise be un-draggable by its own background / frame).
const SCAFFOLD_ROLES = new Set(["figure", "plot-area", "panel", "background", "axis"]);

// --- tiny inline-style reader (linkedom-safe; mirrors derive.ts semantics) ---
function parseStyleAttr(s: string | null | undefined): Map<string, string> {
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

function q(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Resolve the manifest PartNode for an id (tree nodes only — member leaves
 *  live in `members` arrays and have no node of their own). */
function findPartNode(manifest: FluxPlotManifest | undefined, partId: string): PartNode | null {
  const root = manifest?.parts as PartNode | undefined;
  if (!root) return null;
  const dfs = (n: PartNode): PartNode | null => {
    if ((n.id ?? n.ref) === partId) return n;
    for (const c of n.children ?? []) {
      const f = dfs(c);
      if (f) return f;
    }
    return null;
  };
  return dfs(root);
}

/** The DOM node for a part: the LIVE mounted node when present (id prefixed
 *  per placement), else the pristine cached DOM's node (headless fallback). */
export function partNode(el: SemanticPlotElement, partId: string): Element | null {
  if (typeof document !== "undefined") {
    const live = document.getElementById(`${el.id}__${partId}`);
    if (live) return live as unknown as Element;
  }
  const cached = plotDom.get(el.assetId);
  if (!cached) return null;
  return (cached as unknown as Element).querySelector?.(`[id="${q(partId)}"]`) ?? null;
}

/** A drawable's own declared fill (inline style or presentation attribute). */
function declaredFillOf(d: Element): string | null {
  const inline = parseStyleAttr(d.getAttribute("style")).get("fill");
  return inline ?? d.getAttribute("fill");
}

/**
 * Infer a part's kind: text | line | shape | container.
 *
 * Precedence:
 *  1. an authored `data-kind` attribute on the part's DOM node — fluxplot will
 *     start emitting these (Phase 10); authoritative when present;
 *  2. the manifest role (group nodes map through their groupRole:
 *     tick-labels → text, gridlines → line, …) via the role sets above;
 *  3. the tag of the first drawable under the node (path splits on declared
 *     fill:none → line, else shape); a drawable-less <g> is a container.
 */
export function partKind(
  manifest: FluxPlotManifest | undefined,
  partId: string,
  node?: Element | null,
): PartKind {
  const dk = node?.getAttribute?.("data-kind");
  if (dk && KNOWN_KINDS.has(dk)) return dk as PartKind;

  const info = buildPartIndex(manifest)[partId];
  const role = info?.role ?? inferRole(partId);
  if (TEXT_ROLES.has(role)) return "text";
  if (CONTAINER_ROLES.has(role)) return "container";
  if (LINEY_ROLES.has(role)) return "line";

  if (node) {
    const d = drawablesUnder(node)[0];
    if (!d) return "container";
    const tag = d.tagName?.toLowerCase() ?? "";
    if (tag === "text" || tag === "tspan") return "text";
    if (tag === "line" || tag === "polyline") return "line";
    if (tag === "path") return (declaredFillOf(d) ?? "").toLowerCase() === "none" ? "line" : "shape";
    return "shape";
  }
  return "shape";
}

/** Resolve the part a click means, walking up from the hit node like
 *  parse.semanticIdFromNode but PREFERRING the nearest manifest-covered id.
 *  Phase-1 normalization stamps anonymous inner drawables with `n<idx>` ids
 *  (the <text> INSIDE a ticklabel <g>), so the raw nearest id is often an
 *  unnamed leaf whose override would not survive regeneration — the covered
 *  ancestor ("axis.x.ticklabel.2") is the durable, labeled address. Falls back
 *  to the nearest raw id when nothing on the chain is covered. */
export function resolvePartId(
  manifest: FluxPlotManifest | undefined,
  node: Element | null,
  elementId: string,
): string | null {
  const p = elementId + "__";
  const idx = buildPartIndex(manifest);
  let nearest: string | null = null;
  let el: Element | null = node;
  while (el) {
    const id = el.getAttribute?.("id");
    if (id && id.startsWith(p)) {
      const sem = id.slice(p.length);
      if (nearest == null) nearest = sem;
      if (idx[sem]) return sem;
    }
    el = el.parentElement;
  }
  return nearest;
}

/** True when a clicked part is plot SCAFFOLDING — the figure/plot-area frame,
 *  a background patch, an axis container — i.e. things a drag should treat as
 *  "move the whole plot", not "move this part". Un-manifested ids (matplotlib
 *  `patch_N` backgrounds, stamped structural ids the manifest doesn't cover)
 *  count as scaffold: everything REAL is covered by the manifest (incl. the
 *  orphan-defense `unclassified` group). The parts-tree ROOT is always scaffold. */
export function isScaffoldPart(manifest: FluxPlotManifest | undefined, partId: string): boolean {
  if (!manifest) return true;
  const info = buildPartIndex(manifest)[partId];
  if (!info) return true; // un-manifested → whole-plot drag
  if (SCAFFOLD_ROLES.has(info.role)) return true;
  const root = manifest.parts as PartNode | undefined;
  if (root && (root.id ?? root.ref) === partId) return true; // undefined-role container root
  return false;
}

// ---------------------------------------------------------------------------
// Effective style values
// ---------------------------------------------------------------------------
/** Effective values for a part, keyed like PartOverride. Only the keys
 *  meaningful for the part's kind are present. */
export interface PartStyleValues {
  [k: string]: string | number | boolean | undefined;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: string;
  textDecoration?: string;
  dx?: number;
  dy?: number;
  hidden?: boolean;
}

function toNum(v: unknown): number | undefined {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function firstFont(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const f = v.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  return f || undefined;
}

function weightNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "bold" || t === "bolder") return 700;
  if (t === "normal") return 400;
  return toNum(t);
}

/**
 * Read a part's EFFECTIVE style with precedence:
 *   el.overrides[partId]  →  the node's first drawable's inline style /
 *   presentation attributes (live mounted node when available, else the
 *   pristine cached DOM)  →  getComputedStyle (browser-only, connected nodes).
 *
 * dx/dy/hidden are override-only truths (the source SVG never has them);
 * opacity falls back to the wrapper node's own declaration.
 */
export function readPartStyle(
  el: SemanticPlotElement,
  partId: string,
  manifest?: FluxPlotManifest,
): PartStyleValues {
  const node = partNode(el, partId);
  const kind = partKind(manifest, partId, node);
  const ov: PartOverride = el.overrides?.[partId] ?? {};
  const d = node ? (drawablesUnder(node)[0] ?? null) : null;
  const dStyle = parseStyleAttr(d?.getAttribute?.("style"));

  const fromDrawable = (prop: string): string | undefined => {
    if (!d) return undefined;
    const inline = dStyle.get(prop);
    if (inline) return inline;
    const attr = d.getAttribute(prop);
    if (attr) return attr;
    // Browser-only last resort — inherited/CSS-block values on live nodes.
    if (
      typeof window !== "undefined" &&
      typeof getComputedStyle === "function" &&
      (d as unknown as { isConnected?: boolean }).isConnected
    ) {
      try {
        const cv = getComputedStyle(d as unknown as globalThis.Element).getPropertyValue(prop);
        if (cv) return cv;
      } catch {
        /* detached / non-CSS node */
      }
    }
    return undefined;
  };

  const out: PartStyleValues = {};
  // Wrapper-level (override-authoritative).
  out.hidden = Boolean(ov.hidden);
  out.dx = typeof ov.dx === "number" ? ov.dx : 0;
  out.dy = typeof ov.dy === "number" ? ov.dy : 0;
  const nodeStyle = parseStyleAttr(node?.getAttribute?.("style"));
  out.opacity =
    typeof ov.opacity === "number"
      ? ov.opacity
      : (toNum(nodeStyle.get("opacity") ?? node?.getAttribute?.("opacity")) ?? 1);

  if (kind === "text") {
    out.fontSize = typeof ov.fontSize === "number" ? ov.fontSize : toNum(fromDrawable("font-size"));
    out.fontFamily =
      typeof ov.fontFamily === "string" ? ov.fontFamily : firstFont(fromDrawable("font-family"));
    out.fontWeight =
      typeof ov.fontWeight === "number" ? ov.fontWeight : (weightNum(fromDrawable("font-weight")) ?? 400);
    out.fontStyle = typeof ov.fontStyle === "string" ? ov.fontStyle : (fromDrawable("font-style") ?? "normal");
    out.textDecoration =
      typeof ov.textDecoration === "string" ? ov.textDecoration : (fromDrawable("text-decoration") ?? "none");
    out.fill = typeof ov.fill === "string" ? ov.fill : (fromDrawable("fill") ?? "#000000");
  } else if (kind === "line") {
    out.stroke = typeof ov.stroke === "string" ? ov.stroke : (fromDrawable("stroke") ?? "#000000");
    out.strokeWidth =
      typeof ov.strokeWidth === "number" ? ov.strokeWidth : (toNum(fromDrawable("stroke-width")) ?? 1);
  } else if (kind === "shape") {
    out.fill = typeof ov.fill === "string" ? ov.fill : (fromDrawable("fill") ?? "#000000");
    out.stroke = typeof ov.stroke === "string" ? ov.stroke : (fromDrawable("stroke") ?? "none");
    out.strokeWidth =
      typeof ov.strokeWidth === "number" ? ov.strokeWidth : (toNum(fromDrawable("stroke-width")) ?? 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------
/** Human labels from the parts-tree root down to the part ("Figure › Plot area
 *  › X axis › Tick labels › Tick label 3"). Member leaves get a synthesized
 *  final segment. Empty when the manifest has no parts tree or the id is not
 *  covered by it. */
export function partBreadcrumb(manifest: FluxPlotManifest | undefined, partId: string): string[] {
  const root = manifest?.parts as PartNode | undefined;
  if (!root || !root.role) return [];
  const path: string[] = [];
  const dfs = (n: PartNode): boolean => {
    path.push(labelForPart(n));
    if ((n.id ?? n.ref) === partId) return true;
    if ((n.members ?? []).includes(partId)) {
      path.push(labelForPart({ id: partId }));
      return true;
    }
    for (const c of n.children ?? []) if (dfs(c)) return true;
    path.pop();
    return false;
  };
  return dfs(root) ? path : [];
}

/** Display label for a part id (extended part-index label, composed
 *  role · series · #index fallback, raw id last). */
export function partDisplayLabel(manifest: FluxPlotManifest | undefined, partId: string): string {
  const info = buildPartIndex(manifest)[partId];
  if (!info) return partId;
  if (info.label) return info.label;
  const composed = [info.role, info.series, info.index !== undefined ? `#${info.index}` : null]
    .filter(Boolean)
    .join(" · ");
  return composed || partId;
}
