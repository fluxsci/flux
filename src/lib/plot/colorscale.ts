// The colour law of a fluxplot colour scale, ported from matplotlib 3.11 (pure: no DOM).
//
// A manifest `colorScales[]` entry carries the exact lookup table matplotlib indexed (`lut`,
// `#rrggbbaa`) plus `under` / `over` / `bad`, and a `norm` record with its parameters. This
// module reproduces `ScalarMappable.to_rgba` hex for hex — `normalize` ports every norm's
// `__call__`, `lookup` the `Colormap.__call__` indexing rule — and is the ONE place both engines
// colour a value (the DOM recolour, the colorbar redraw, the slide tween, the verbs).
// fluxplot's `colorscale.py::apply` is the reference; `scripts/fixtures/colorscale_vectors.json`
// (copied from fluxplot) pins both sides through verify-colorscale-parity.ts.
//
// The lookup rule: x·N truncated indexes `lut`; x == 1 → the last entry; x < 0 → `under`;
// x·N ≥ N → `over`; NaN (or a non-finite input) → `bad`. A `boundary` / `none` norm yields an
// INDEX, used directly (−1 → under, N → over). ±Infinity coming out of a norm (a two-slope
// value beyond its limits) is under / over, never bad.
import type { FluxPlotColorScale } from "./types";
import type { ColorScaleView } from "../types";

export type ColorScaleNorm = FluxPlotColorScale["norm"];
export type ColorScaleColormap = FluxPlotColorScale["colormap"];
export type NormKind = ColorScaleNorm["kind"];

/** The norm kinds a consumer may switch a continuous scale to (the plan's editable set). */
export const SWITCHABLE_NORM_KINDS: NormKind[] = ["linear", "log", "power", "symlog", "twoslope", "centered"];
/** The kinds `normalize` yields a colour INDEX for rather than a fraction. */
export const INDEX_KINDS: readonly NormKind[] = ["boundary", "none"];

const logBase = (v: number, base: number): number =>
  base === 10 ? Math.log10(v) : base === 2 ? Math.log2(v) : base === Math.E ? Math.log(v) : Math.log(v) / Math.log(base);

/** matplotlib's `np.interp` arithmetic for one segment (exact endpoints). */
function segment(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x === x1) return y1;
  const slope = (y1 - y0) / (x1 - x0);
  return slope * (x - x0) + y0;
}

/** Port of each matplotlib norm's `__call__` for one value: a fraction in (about) [0, 1] for
 *  the continuous kinds, a colour index for `boundary` / `none`, NaN for a bad value (missing,
 *  non-finite, non-positive on a log scale). A `custom` norm cannot be evaluated → NaN. */
export function normalize(norm: ColorScaleNorm, v: number): number {
  if (!Number.isFinite(v)) return NaN;
  const kind = norm.kind;
  if (kind === "none") return v;
  if (kind === "boundary") {
    const b = norm.boundaries ?? [], ncolors = norm.ncolors ?? 0, extend = norm.extend ?? "neither";
    if (!b.length || !ncolors) return NaN;
    const lo = b[0] as number, hi = b[b.length - 1] as number;
    const offset = extend === "min" || extend === "both" ? 1 : 0;
    const regions = b.length - 1 + offset + (extend === "max" || extend === "both" ? 1 : 0);
    let x = v, maxCol = ncolors;
    if (norm.clip) { x = Math.min(hi, Math.max(lo, x)); maxCol = ncolors - 1; }
    let count = 0;
    for (const edge of b) if ((edge as number) <= x) count++;
    let idx: number = count - 1 + offset;
    if (ncolors > regions) {
      if (regions === 1) { if (idx === 0) idx = Math.floor((ncolors - 1) / 2); }
      else idx = ((ncolors - 1) / (regions - 1)) * idx;
    }
    idx = Math.trunc(idx); // astype(int16)
    if (x < lo) idx = -1;
    if (x >= hi) idx = maxCol;
    return idx;
  }
  const vmin = norm.vmin, vmax = norm.vmax;
  if (vmin == null || vmax == null || !Number.isFinite(vmin) || !Number.isFinite(vmax) || vmin > vmax) return NaN;
  if (kind === "twoslope") {
    const vcenter = norm.vcenter ?? 0;
    if (!(vmin <= vcenter && vcenter <= vmax)) return NaN;
    if (v < vmin) return -Infinity;
    if (v > vmax) return Infinity;
    if (v <= vcenter) return vcenter === vmin ? (v === vmin ? 0 : 0.5) : segment(v, vmin, vcenter, 0, 0.5);
    return vcenter === vmax ? 1 : segment(v, vcenter, vmax, 0.5, 1);
  }
  if (vmin === vmax) return 0;
  let x = v;
  if (norm.clip) x = Math.min(vmax, Math.max(vmin, x));
  switch (kind) {
    case "linear":
    case "centered":
      return (x - vmin) / (vmax - vmin);
    case "power": {
      const r = (x - vmin) / (vmax - vmin);
      return r > 0 ? Math.pow(r, norm.gamma ?? 1) : r;
    }
    case "log": {
      const base = norm.base ?? 10;
      if (x <= 0) return NaN;
      const t = logBase(x, base), lo = logBase(vmin, base), hi = logBase(vmax, base);
      return (t - lo) / (hi - lo);
    }
    case "symlog": {
      const base = norm.base ?? 10, linthresh = norm.linthresh ?? 1, linscale = norm.linscale ?? 1;
      const adj = linscale / (1 - 1 / base), lnBase = Math.log(base);
      const trf = (a: number) => Math.abs(a) <= linthresh ? a * adj
        : Math.sign(a) * linthresh * (adj - Math.log(linthresh) / lnBase + Math.log(Math.abs(a)) / lnBase);
      const lo = trf(vmin), hi = trf(vmax);
      return (trf(x) - lo) / (hi - lo);
    }
    default:
      return NaN;
  }
}

/** `Colormap.__call__` for one normalised value (`integer` when the norm yields an index). */
export function lookupIndex(N: number, x: number, integer: boolean): number | "under" | "over" | "bad" {
  if (Number.isNaN(x)) return "bad";
  if (integer) {
    if (x < 0) return "under";
    if (x >= N) return "over";
    return Math.trunc(x);
  }
  let scaled = x * N;
  if (scaled === N) scaled = N - 1;
  if (scaled < 0) return "under";
  if (scaled >= N) return "over";
  return Math.trunc(scaled);
}

export function lookup(colormap: ColorScaleColormap, x: number, integer = false): string {
  const i = lookupIndex(colormap.N, x, integer);
  if (i === "bad") return colormap.bad;
  if (i === "under") return colormap.under;
  if (i === "over") return colormap.over;
  return colormap.lut[i] ?? colormap.over;
}

/** The `#rrggbbaa` matplotlib paints `v` with under `scale`. */
export function colorFor(scale: Pick<FluxPlotColorScale, "colormap" | "norm">, v: number): string {
  return lookup(scale.colormap, normalize(scale.norm, v), INDEX_KINDS.includes(scale.norm.kind));
}

// --- colours as numbers (the DOM writer's fast path) --------------------------------------
export interface Rgba { r: number; g: number; b: number; a: number }

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → channels; anything else → null. */
export function parseHex(s: string): Rgba | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = parseInt(h, 16);
  return h.length === 6
    ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
    : { r: (n >>> 24) & 255, g: (n >> 16) & 255, b: (n >> 8) & 255, a: (n & 255) / 255 };
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
/** `#rrggbb` (what an SVG `fill` takes; alpha travels separately as *-opacity). */
export function rgbHex(c: Rgba): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}
/** `#rrggbbaa`, matplotlib's `to_hex(keep_alpha=True)` rounding. */
export function rgbaHex(c: Rgba): string {
  return `${rgbHex(c)}${hex2(Math.round(c.a * 255))}`;
}

/** A colormap's table plus the three special colours as one parsed array: entries 0..N−1 are
 *  the LUT, then under (N), over (N+1), bad (N+2). One parse per apply, then integer reads. */
export interface ParsedColormap { N: number; colors: Rgba[]; hex: string[] }
export function parseColormap(colormap: ColorScaleColormap): ParsedColormap {
  const hex = [...colormap.lut, colormap.under, colormap.over, colormap.bad];
  return { N: colormap.N, hex, colors: hex.map((h) => parseHex(h) ?? { r: 0, g: 0, b: 0, a: 0 }) };
}
/** Slot into a ParsedColormap for a normalised value. */
export function slotFor(N: number, x: number, integer: boolean): number {
  const i = lookupIndex(N, x, integer);
  return i === "bad" ? N + 2 : i === "under" ? N : i === "over" ? N + 1 : i;
}

// --- a view over a scale ---------------------------------------------------------------------
export interface ColormapTable { lut: string[]; under?: string; over?: string; bad?: string; name?: string }
/** Resolves a colormap NAME to its table (the lazily loaded fluxplot definitions), or null. */
export type LutResolver = (name: string) => ColormapTable | null;

export interface EffectiveScale {
  colormap: ColorScaleColormap;
  norm: ColorScaleNorm;
  /** Why the view could not be applied in full (the scale is left as generated for that part). */
  issues: string[];
  /** A named colormap the resolver did not know (a lazy table not loaded yet). */
  unresolved?: string;
}

function tableToColormap(table: ColormapTable, base: ColorScaleColormap): ColorScaleColormap {
  const lut = table.lut.map((c) => { const p = parseHex(c); return p ? rgbaHex(p) : c; }) as [string, ...string[]];
  const N = lut.length;
  const fix = (c: string | undefined, fallback: string) => { const p = c ? parseHex(c) : null; return p ? rgbaHex(p) : fallback; };
  return {
    ...base, name: table.name ?? "custom", source: "custom", N, lut,
    under: fix(table.under, lut[0]), over: fix(table.over, lut[N - 1]), bad: fix(table.bad, "#00000000"),
    discrete: N <= 32, approximate: false,
  };
}

/** The scale a consumer must paint with once `view` is applied over the generated record:
 *  a colormap (name → table through `resolve`, or a table given outright; `reversed` flips it),
 *  limits, a norm kind switch with its parameters, `extend`. Validation mirrors fluxplot's
 *  `colorscale.make_norm`: log needs vmin > 0, twoslope needs vmin < vcenter < vmax. */
export function effectiveScale(scale: FluxPlotColorScale, view: ColorScaleView | undefined, resolve?: LutResolver): EffectiveScale {
  let colormap = scale.colormap;
  const issues: string[] = [];
  let unresolved: string | undefined;
  if (view?.cmap) {
    if (typeof view.cmap === "string") {
      const table = resolve?.(view.cmap) ?? null;
      if (table) colormap = tableToColormap({ ...table, name: view.cmap }, scale.colormap);
      else unresolved = view.cmap;
    } else if (view.cmap.lut?.length) colormap = tableToColormap(view.cmap, scale.colormap);
  }
  if (view?.reversed) {
    colormap = { ...colormap, name: colormap.name.endsWith("_r") ? colormap.name.slice(0, -2) : `${colormap.name}_r`,
      lut: [...colormap.lut].reverse() as [string, ...string[]], under: colormap.over, over: colormap.under };
  }
  let norm: ColorScaleNorm = { ...scale.norm };
  const nv = view?.norm;
  if (nv) {
    const kind = nv.kind ?? norm.kind;
    const vmin = nv.vmin ?? norm.vmin, vmax = nv.vmax ?? norm.vmax;
    const next: ColorScaleNorm = { kind, vmin, vmax, clip: norm.clip, extend: view?.extend ?? norm.extend };
    if (kind === "log") {
      next.base = norm.kind === "log" ? norm.base ?? 10 : 10;
      if (vmin != null && vmin <= 0) issues.push(`A log scale needs a minimum above 0 (got ${vmin}).`);
    } else if (kind === "symlog") {
      next.base = norm.kind === "symlog" ? norm.base ?? 10 : 10;
      next.linthresh = nv.linthresh ?? (norm.kind === "symlog" ? norm.linthresh : undefined) ?? 1;
      next.linscale = nv.linscale ?? (norm.kind === "symlog" ? norm.linscale : undefined) ?? 1;
      if (next.linthresh <= 0) issues.push("A symlog scale needs a positive linear threshold.");
    } else if (kind === "power") {
      next.gamma = nv.gamma ?? (norm.kind === "power" ? norm.gamma : undefined) ?? 1;
    } else if (kind === "twoslope") {
      next.vcenter = nv.vcenter ?? (norm.kind === "twoslope" || norm.kind === "centered" ? norm.vcenter : undefined) ?? 0;
      if (vmin != null && !(vmin < next.vcenter)) issues.push(`A two-slope scale needs its minimum below the centre (${vmin} vs ${next.vcenter}).`);
      if (vmax != null && !(next.vcenter < vmax)) issues.push(`A two-slope scale needs its centre below the maximum (${next.vcenter} vs ${vmax}).`);
    } else if (kind === "centered") {
      const vcenter = nv.vcenter ?? (norm.kind === "twoslope" || norm.kind === "centered" ? norm.vcenter : undefined) ?? 0;
      next.vcenter = vcenter;
      if (vmin != null && vmax != null) {
        const halfrange = Math.max(Math.abs(vcenter - vmin), Math.abs(vmax - vcenter));
        next.halfrange = halfrange; next.vmin = vcenter - halfrange; next.vmax = vcenter + halfrange;
      }
    } else if (kind === "boundary" || kind === "custom" || kind === "none") {
      // these keep their own parameters; only extend may change
      Object.assign(next, norm, { extend: next.extend });
    }
    if (next.vmin != null && next.vmax != null && next.vmin >= next.vmax && kind !== "boundary" && kind !== "none")
      issues.push("The minimum must lie below the maximum.");
    norm = issues.length ? { ...scale.norm } : next;
  } else if (view?.extend) norm = { ...norm, extend: view.extend };
  return { colormap, norm, issues, unresolved };
}

/** True when `view` changes nothing about `scale` (every field restates the generated value). */
export function viewIsIdentity(scale: FluxPlotColorScale, view: ColorScaleView | undefined): boolean {
  if (!view) return true;
  if (view.reversed) return false;
  if (view.cmap) {
    if (typeof view.cmap === "string") { if (view.cmap !== scale.colormap.name) return false; }
    else if (view.cmap.lut.join() !== scale.colormap.lut.map((c) => c.slice(0, 7)).join() && view.cmap.lut.join() !== scale.colormap.lut.join()) return false;
  }
  if (view.extend && view.extend !== scale.norm.extend) return false;
  const n = view.norm;
  if (n) {
    if (n.kind && n.kind !== scale.norm.kind) return false;
    for (const k of ["vmin", "vmax", "vcenter", "gamma", "linthresh", "linscale"] as const)
      if (n[k] != null && n[k] !== (scale.norm as Record<string, unknown>)[k]) return false;
  }
  return true;
}
