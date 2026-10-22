// Which tone of the crosshair a surface needs (2026-10-21, owner: "ditch the
// halo and let the colour follow the background"). The cursor is a hardware
// image, so it cannot sample pixels; instead the TONE is decided structurally
// from the model, once per render, and delivered through CSS inheritance:
// the app chrome and the canvas are dark (the on-dark set is the :root
// default), a figure's paper takes the tone of its background colour, a
// filled shape or a dark-theme plot its own, and known light surfaces (PDF
// pages, gallery tiles, the Figure-Meta sheet) opt in with `.cursor-on-light`.
// Nothing here runs per pointer move, and no host-level property flips per
// hover — the cursor FIREWALL (guide §4) stands.
import { hexToRgb } from "../colorSpace";
import type { Element, Figure } from "../types";
import type { FluxPlotManifest as PlotManifest } from "../plot/types";

export type CursorTone = "light" | "dark";

/** WCAG relative luminance of a CSS colour, or null when it cannot be read
 *  (named colours, gradients, `transparent`, `none`). */
export function relativeLuminance(color: string | undefined | null): number | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  if (c === "white") return 1;
  if (c === "black") return 0;
  let hex = c;
  if (/^#[0-9a-f]{3,4}$/.test(c)) hex = "#" + [...c.slice(1, 4)].map((ch) => ch + ch).join("");
  if (/^#[0-9a-f]{8}$/.test(c)) hex = c.slice(0, 7);
  const rgb = hexToRgb(hex);
  if (rgb) return lum(rgb.r, rgb.g, rgb.b);
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(c);
  if (m) return lum(+m[1], +m[2], +m[3]);
  return null;
}
function lum(r: number, g: number, b: number): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** A surface of this colour wants the crosshair drawn for a LIGHT background
 *  (dark mark) or a DARK one (light mark). `fallback` covers unreadable colours. */
export function toneOfColor(color: string | undefined | null, fallback: CursorTone | null = null): CursorTone | null {
  const L = relativeLuminance(color);
  if (L == null) return fallback;
  return L >= 0.4 ? "light" : "dark"; // 0.4: #808080 (0.216) is dark, #c0c0c0 (0.527) light
}

/** The tone of a figure's paper. A transparent background shows the dark canvas. */
export function figureTone(fig: Pick<Figure, "background"> | null | undefined): CursorTone {
  if (!fig) return "dark";
  return toneOfColor(fig.background, "dark") ?? "dark";
}

/** The tone an element's own body asks for, or null when the figure's tone
 *  should stand: solid fills (rect, ellipse, closed path) and plots whose
 *  manifest records a dark paper/plot token decide; strokes, text, images and
 *  everything else show the paper through. */
export function elementTone(el: Element, manifest?: PlotManifest | null): CursorTone | null {
  switch (el.type) {
    case "rect":
    case "ellipse": {
      if ((el as { fillMap?: unknown }).fillMap) return null;
      const fill = (el as { fill?: string }).fill;
      if (!fill || fill === "none" || fill === "transparent") return null;
      return toneOfColor(fill, null);
    }
    case "path": {
      const p = el as { fill?: string; closed?: boolean; fillMap?: unknown };
      if (p.fillMap || !p.closed) return null;
      if (!p.fill || p.fill === "none" || p.fill === "transparent") return null;
      return toneOfColor(p.fill, null);
    }
    case "plot": {
      const tokens = (manifest as { style?: { tokens?: Record<string, string> } } | null | undefined)?.style?.tokens;
      const paper = tokens?.paper ?? tokens?.plot;
      if (!paper || paper === "none" || paper === "transparent") return null;
      return toneOfColor(paper, null);
    }
    default:
      return null;
  }
}

/** The tone the selection chrome (handles, bands, rotate zones) should use:
 *  a single selected element's own tone when it has one, else the figure's. */
export function chromeTone(fig: Pick<Figure, "background"> | null, selected: Element[], manifestOf: (el: Element) => PlotManifest | null | undefined): CursorTone {
  if (selected.length === 1) {
    const own = elementTone(selected[0], manifestOf(selected[0]));
    if (own) return own;
  }
  return figureTone(fig);
}
