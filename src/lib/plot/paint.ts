// Attribute/inline-style paint only: no computed style, layout, or store reads.
import type { PartOverride } from "../types";
import { parseColor, formatColor } from "../color/interp";
import type { OutlinePaint } from "../slide/stageOutline";

/** Shared with the part inspector; inline declarations win over attributes. */
export function parseStyleAttr(s: string | null | undefined): Map<string, string> {
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

export function readPaint(node: Element, overrides: PartOverride = {}): OutlinePaint {
  const style = parseStyleAttr(node.getAttribute("style"));
  const val = (name: string): string => {
    const own = style.get(name) ?? node.getAttribute(name);
    if (own != null && own !== "inherit") return own.trim();
    // Paint inherits through SVG groups. Opacity composites instead and is
    // accumulated by the geometry bridge at the actual wrapper boundaries.
    if (name !== "opacity") for (let p = node.parentElement; p; p = p.parentElement) {
      const v = parseStyleAttr(p.getAttribute("style")).get(name) ?? p.getAttribute(name);
      if (v != null && v !== "inherit") return v.trim();
    }
    return "";
  };
  const colour = (s: string, alpha: string) => {
    if (/^(none|transparent)$/i.test(s)) return "none";
    const opacity = parseFloat(alpha);
    if (!Number.isFinite(opacity) || opacity >= 1) return s;
    const c = parseColor(s);
    return c ? formatColor({ ...c, a: c.a * Math.max(0, opacity) }) : s;
  };
  const tag = node.tagName.toLowerCase();
  const cap = val("stroke-linecap");
  const dash = val("stroke-dasharray");
  const width = parseFloat(val("stroke-width"));
  const opacity = parseFloat(val("opacity"));
  return {
    fill: tag === "line" || tag === "polyline" ? "none" : colour(overrides.fill ?? (val("fill") || "#000000"), val("fill-opacity")),
    stroke: colour(overrides.stroke ?? (val("stroke") || "none"), val("stroke-opacity")),
    strokeWidth: overrides.strokeWidth ?? (Number.isFinite(width) ? width : 1),
    cap: cap === "round" || cap === "square" ? cap : "butt",
    ...(dash && dash !== "none" ? { dash: dash.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite) } : {}),
    opacity: overrides.opacity ?? (Number.isFinite(opacity) ? opacity : 1),
  };
}
