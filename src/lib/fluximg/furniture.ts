/**
 * fluximg furniture: the scale bar, the depth / time stamp and the channel names, as SVG in the element's box
 * (origin top-left, canvas px). Pure string building (twin-engine rule): the same markup is the element at rest,
 * the export (resvg) and Paper.
 *
 * Text follows the Chromium / resvg agreement rules: Flux's figure text font (Arial 400), `text-anchor` for
 * horizontal alignment, and an explicit baseline `y` computed from the font size (no `dominant-baseline`, no
 * measurement). Sizes in the view are points; 1 pt = 4/3 canvas px.
 */
import type { FluximgAxis, FluximgManifest } from "./types";
import type { FurnitureCorner, PixelRect, ResolvedView } from "./view";
import { escapeXml, FURNITURE_FONT, FURNITURE_WEIGHT, PT, svgNum } from "./layers";

/** Cap height and descent of the figure font as fractions of the font size (Arial: 0.716, 0.212). */
const CAP = 0.72;
const DESCENT = 0.21;
const LINE = 1.25;
/** Rough advance per character, used only to keep a centred scale-bar label off the box edge. */
const EM_PER_CHAR = 0.55;

/** The largest of 1, 2, 5 x 10^n not above `max` (0 when there is none). */
export function niceLength(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 0;
  const n = Math.floor(Math.log10(max));
  for (let e = n + 1; e >= n - 1; e--) {
    for (const m of [5, 2, 1]) {
      // toPrecision removes the binary noise of m * 10^e (0.30000000000000004 and friends).
      const v = Number((m * Math.pow(10, e)).toPrecision(12));
      if (v <= max * (1 + 1e-12)) return v;
    }
  }
  return 0;
}

/** The next (dir 1) or previous (dir -1) length in the 1, 2, 5 x 10^n series. */
export function roundNeighbour(v: number, dir: 1 | -1): number {
  if (!(v > 0) || !Number.isFinite(v)) return v;
  const e = Math.floor(Math.log10(v) + 1e-9), series = [1, 2, 5, 10];
  const m = v / Math.pow(10, e);
  // Where v sits in the series (it may not be on it: a typed 30 goes to 50 or 20).
  let k = series.findIndex((x) => Math.abs(x - m) < 1e-6);
  let next: number;
  if (k >= 0) next = dir > 0 ? (k === 3 ? 20 : series[k + 1]) : k === 0 ? 0.5 : series[k - 1];
  else { k = series.findIndex((x) => x > m); next = dir > 0 ? series[k] : series[k - 1]; }
  return Number((next * Math.pow(10, e)).toPrecision(12));
}

/** Inset of furniture from the box edge: 4 % of the shorter side, 6..24 px. */
export function furnitureInset(box: { width: number; height: number }): number {
  return Math.min(24, Math.max(6, 0.04 * Math.min(box.width, box.height)));
}

const MINUS = "−";
const signed = (s: string): string => (s.startsWith("-") ? MINUS + s.slice(1) : s);

/** Decimals that print every position of an axis faithfully, at most 6. */
function axisDecimals(axis: FluximgAxis): number {
  if (axis.coords && axis.coords.length) {
    let d = 0;
    for (const v of axis.coords) while (d < 6 && Math.abs(Number(v.toFixed(d)) - v) > 1e-9 * Math.max(1, Math.abs(v))) d++;
    return d;
  }
  const s = Math.abs(axis.scale ?? 1);
  return s > 0 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(s) - 1e-9))) : 0;
}

/** "−50.5 µm", "3.20 s", "a" (a categorical label), "3/24" (no physical axis). Index is 0-based. */
export function positionText(axis: FluximgAxis | undefined, index: number, length: number): string {
  if (axis?.labels && axis.labels[index] !== undefined) return axis.labels[index];
  let value: number | null = null;
  if (axis?.coords && axis.coords[index] !== undefined) value = axis.coords[index];
  else if (axis && typeof axis.scale === "number") value = (axis.offset ?? 0) + axis.scale * index;
  if (value === null || !Number.isFinite(value)) return `${index + 1}/${length}`;
  const text = signed(value.toFixed(axisDecimals(axis!)));
  return axis!.unit ? `${text} ${axis!.unit}` : text;
}

/** The scale bar's label number: up to 6 significant digits, no trailing zeros. */
const lengthText = (v: number): string => signed(String(Number(v.toPrecision(6))));

/** One stamp line per dimension other than c, y, x (or the view's chosen dims), in stored order. */
export function stampLines(manifest: FluximgManifest, rv: ResolvedView): string[] {
  const { dims, shape } = manifest.pixels;
  const st = rv.furniture.stamp;
  const chosen = st && st.dims.length ? new Set(st.dims) : null;
  const lines: string[] = [];
  dims.forEach((d, k) => {
    if (d === "c" || d === "y" || d === "x" || (chosen && !chosen.has(d))) return;
    const pr = rv.projection;
    // Plane numbers are 1-based and inclusive on screen: from (inclusive) .. to (exclusive) → from+1 – to.
    if (pr && pr.dim === d) lines.push(`${pr.mode} ${d} ${pr.from + 1}–${pr.to}`);
    else lines.push(`${d} ${positionText(manifest.axes[d], rv.index[d] ?? 0, shape[k])}`);
  });
  return lines;
}

/** The channels whose names are drawn: the solo channel in `single`, else the visible ones. */
function labelledChannels(rv: ResolvedView): ResolvedView["channels"] {
  if (rv.composite === "single") return rv.channels.filter((c) => c.index === rv.solo);
  return rv.channels.filter((c) => c.visible);
}

type Box = { width: number; height: number };
const isTop = (c: FurnitureCorner): boolean => c.startsWith("top");
const isLeft = (c: FurnitureCorner): boolean => c.endsWith("left");
const textAttrs = (fs: number, fill: string): string =>
  ` fill="${escapeXml(fill)}" font-family="${FURNITURE_FONT}" font-size="${svgNum(fs)}" font-weight="${FURNITURE_WEIGHT}"`;

/** Lines of text stacked in a corner, starting `used` px in from the corner's horizontal edge. */
function cornerText(lines: Array<{ text: string; id: string; fill: string }>, corner: FurnitureCorner, fs: number, box: Box, inset: number, used: number, extra: string): { svg: string; height: number } {
  const x = isLeft(corner) ? inset : box.width - inset, anchor = isLeft(corner) ? "start" : "end", lh = LINE * fs, n = lines.length;
  const first = isTop(corner) ? inset + used + CAP * fs : box.height - inset - used - DESCENT * fs - (n - 1) * lh;
  const svg = lines.map((l, i) => `<text id="${escapeXml(l.id)}"${extra} x="${svgNum(x)}" y="${svgNum(first + i * lh)}" text-anchor="${anchor}"${textAttrs(fs, l.fill)}>${escapeXml(l.text)}</text>`).join("");
  return { svg, height: (n - 1) * lh + (CAP + DESCENT) * fs };
}

export interface ScalebarGeometry { x: number; y: number; width: number; height: number; length: number; unit: string; text: string }

/** Where the scale bar goes, or null when there is none (no bar, no x unit / pixel size, nothing to show). */
export function scalebarGeometry(manifest: FluximgManifest, rv: ResolvedView, crop: PixelRect, box: Box, used = 0): ScalebarGeometry | null {
  const sb = rv.furniture.scalebar, ax = manifest.axes.x;
  if (!sb || !ax || !(typeof ax.scale === "number" && ax.scale > 0) || !ax.unit) return null;
  if (!(crop.width > 0 && box.width > 0 && box.height > 0)) return null;
  const length = sb.length ?? niceLength(0.25 * crop.width * ax.scale);
  if (!(length > 0)) return null;
  const width = (length / ax.scale) * (box.width / crop.width);
  const inset = furnitureInset(box), height = Math.max(0, sb.thickness) * PT;
  const x = isLeft(sb.corner) ? inset : box.width - inset - width;
  const y = isTop(sb.corner) ? inset + used : box.height - inset - used - height;
  return { x, y, width, height, length, unit: ax.unit, text: `${lengthText(length)} ${ax.unit}` };
}

/**
 * Everything switched on in the resolved view's furniture, as one `<g>` ("" when nothing is). Items sharing a
 * corner stack away from it in a fixed order: scale bar, stamp, channel names.
 */
export function furnitureSvg(manifest: FluximgManifest, rv: ResolvedView, crop: PixelRect, box: Box, idPrefix: string, resolveLut?: (name: string) => string[] | null): string {
  if (!(box.width > 0 && box.height > 0)) return "";
  const f = rv.furniture, inset = furnitureInset(box);
  const used: Record<FurnitureCorner, number> = { "bottom-right": 0, "bottom-left": 0, "top-right": 0, "top-left": 0 };
  const parts: string[] = [];

  if (f.scalebar) {
    const sb = f.scalebar, g = scalebarGeometry(manifest, rv, crop, box);
    if (g) {
      const fs = sb.fontSize * PT, gap = 0.25 * fs;
      parts.push(`<rect id="${escapeXml(idPrefix + "scalebar")}" data-part="scalebar" x="${svgNum(g.x)}" y="${svgNum(g.y)}" width="${svgNum(g.width)}" height="${svgNum(g.height)}" fill="${escapeXml(sb.color)}"/>`);
      let h = g.height;
      if (sb.label) {
        // Centred on the bar, but kept inside the box when the text is wider than the bar.
        const half = (EM_PER_CHAR * fs * g.text.length) / 2;
        const cx = Math.min(box.width - inset - half, Math.max(inset + half, g.x + g.width / 2));
        const y = isTop(sb.corner) ? g.y + g.height + gap + CAP * fs : g.y - gap - DESCENT * fs;
        parts.push(`<text id="${escapeXml(idPrefix + "scalebar.label")}" data-part="scalebar.label" x="${svgNum(cx)}" y="${svgNum(y)}" text-anchor="middle"${textAttrs(fs, sb.color)}>${escapeXml(g.text)}</text>`);
        h += gap + (CAP + DESCENT) * fs;
      }
      used[sb.corner] += h + 0.4 * sb.fontSize * PT;
    }
  }

  if (f.stamp) {
    const st = f.stamp, lines = stampLines(manifest, rv);
    if (lines.length) {
      const fs = st.fontSize * PT;
      const t = cornerText(lines.map((text, i) => ({ text, id: `${idPrefix}stamp.${i}`, fill: st.color })), st.corner, fs, box, inset, used[st.corner], "");
      parts.push(`<g id="${escapeXml(idPrefix + "stamp")}" data-part="stamp">${t.svg}</g>`);
      used[st.corner] += t.height + 0.4 * fs;
    }
  }

  if (f.channelLabels) {
    const cl = f.channelLabels, chans = labelledChannels(rv);
    if (chans.length) {
      const fs = cl.fontSize * PT;
      // A colour map has no single colour: its name is white.
      const lines = chans.map((c) => ({ text: c.name, id: `${idPrefix}channel.${c.index}`, fill: !c.lut && c.color ? c.color : "#ffffff" }));
      const t = cornerText(lines, cl.corner, fs, box, inset, used[cl.corner], ` data-part="channel"`);
      parts.push(t.svg);
      used[cl.corner] += t.height + 0.4 * fs;
    }
  }

  if (f.colorbar) {
    const cb = f.colorbar, chans = labelledChannels(rv);
    if (chans.length) {
      const fs = cb.fontSize * PT, gap = 0.25 * fs;
      // A bar per shown channel: its colours from the black point (left) to the white point (right).
      const width = Math.min(Math.max(40, 0.3 * box.width), Math.max(20, box.width - 2 * inset)), height = Math.max(2, 0.55 * fs);
      const rowH = height + gap + (CAP + DESCENT) * fs, step = rowH + 0.5 * fs;
      const total = chans.length * step - 0.5 * fs;
      const x = isLeft(cb.corner) ? inset : box.width - inset - width;
      const top = isTop(cb.corner) ? inset + used[cb.corner] : box.height - inset - used[cb.corner] - total;
      const defs: string[] = [], bars: string[] = [];
      chans.forEach((c, k) => {
        const y = top + k * step, gid = `${idPrefix}colorbar.${c.index}.ramp`;
        defs.push(`<linearGradient id="${escapeXml(gid)}" gradientUnits="userSpaceOnUse" x1="${svgNum(x)}" y1="0" x2="${svgNum(x + width)}" y2="0">${rampStops(c, resolveLut)}</linearGradient>`);
        bars.push(`<rect id="${escapeXml(`${idPrefix}colorbar.${c.index}`)}" data-part="colorbar" x="${svgNum(x)}" y="${svgNum(y)}" width="${svgNum(width)}" height="${svgNum(height)}" fill="url(#${escapeXml(gid)})" stroke="${escapeXml(cb.color)}" stroke-width="${svgNum(Math.max(0.3, 0.05 * fs))}"/>`);
        const ty = y + height + gap + CAP * fs;
        // The window in the image's own values; how values spread across it is said when it is not linear.
        const how = c.norm === "log" && c.range[0] > 0 ? "log" : c.norm === "gamma" && c.gamma !== 1 ? `γ ${trimNumber(c.gamma)}` : "";
        bars.push(`<text id="${escapeXml(`${idPrefix}colorbar.${c.index}.min`)}" data-part="colorbar.label" x="${svgNum(x)}" y="${svgNum(ty)}" text-anchor="start"${textAttrs(fs, cb.color)}>${escapeXml(valueText(c.range[0]))}</text>`);
        if (how) bars.push(`<text id="${escapeXml(`${idPrefix}colorbar.${c.index}.norm`)}" data-part="colorbar.label" x="${svgNum(x + width / 2)}" y="${svgNum(ty)}" text-anchor="middle"${textAttrs(fs, cb.color)}>${escapeXml(how)}</text>`);
        bars.push(`<text id="${escapeXml(`${idPrefix}colorbar.${c.index}.max`)}" data-part="colorbar.label" x="${svgNum(x + width)}" y="${svgNum(ty)}" text-anchor="end"${textAttrs(fs, cb.color)}>${escapeXml(valueText(c.range[1]))}</text>`);
      });
      parts.push(`<g id="${escapeXml(idPrefix + "colorbar")}" data-part="colorbar"><defs>${defs.join("")}</defs>${bars.join("")}</g>`);
      used[cb.corner] += total + 0.4 * fs;
    }
  }

  return parts.length ? `<g id="${escapeXml(idPrefix + "furniture")}" data-part="furniture">${parts.join("")}</g>` : "";
}

/** Up to 4 significant digits, no trailing zeros, U+2212 for minus: a bar's end value. */
const trimNumber = (v: number): string => signed(String(Number(v.toPrecision(4))));
const valueText = (v: number): string => (Number.isInteger(v) && Math.abs(v) < 1e7 ? signed(String(v)) : trimNumber(v));

/** Gradient stops of a channel's colours: black to its colour, or nine samples of its colour map (gray when unknown). */
function rampStops(c: { color: string | null; lut: string | null; invert: boolean }, resolveLut?: (name: string) => string[] | null): string {
  let colors: string[];
  if (c.color) colors = ["#000000", c.color];
  else {
    const table = c.lut && resolveLut ? resolveLut(c.lut) : null;
    colors = table && table.length > 1
      ? Array.from({ length: 9 }, (_, i) => table[Math.round((i / 8) * (table.length - 1))].slice(0, 7))
      : ["#000000", "#ffffff"];
  }
  if (c.invert) colors = colors.slice().reverse();
  return colors.map((col, i) => `<stop offset="${svgNum(i / (colors.length - 1))}" stop-color="${escapeXml(col)}"/>`).join("");
}
