// `get_plot_data` — a plot's data, from its manifest (colour-system plan F5).
//
// The cheapest way for an agent to reason about a figure precisely instead of from a PNG: the
// series (exact nullable x/y, per-point ids, the colour), the payloads fluxplot records
// (glowbar / fluxbox statistics, hexmatrix bins, distributions, field values and levels, image
// channels, bands, bars), the colour scales (without their 256-entry tables unless asked), the
// axes' domains and scales, and the overlays (a significance bracket with the test behind it).
// Large arrays are cut to a window (`offset` / `limit`) and every cut is reported with the
// array's true length, so a caller pages instead of receiving megabytes.
import type { FluxPlotManifest } from "./types";

export interface PlotDataOptions {
  /** One series (its id, or its name) instead of all. */
  seriesId?: string;
  /** Sections to include (default all): series, colorScales, axes, overlays, guides, style. Add
   *  `lut` to keep the colour tables. */
  fields?: string[];
  /** Window into every array longer than `limit`: skip this many entries … */
  offset?: number;
  /** … and return at most this many (default 1000; capped at 10000). */
  limit?: number;
}

export interface PlotDataPage { path: string; total: number; offset: number; limit: number; returned: number }

export interface PlotDataResult {
  spec: string | null;
  schemaVersion: string | null;
  plotType: string | null;
  series?: Record<string, unknown>[];
  colorScales?: Record<string, unknown>[];
  axes?: Record<string, unknown>[];
  overlays?: Record<string, unknown>[];
  guides?: Record<string, unknown>[];
  style?: unknown;
  /** Figure-scope parts (suptitle, sup-labels, figure legends, fig.text, the figure background). */
  figure?: unknown;
  /** The panels (`insetOf` names an inset's host). */
  panels?: Record<string, unknown>[];
  /** Every array that was windowed, by JSON path. Empty when nothing was. */
  pages: PlotDataPage[];
  offset: number;
  limit: number;
}

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 10000;
export const SECTIONS = ["series", "colorScales", "axes", "overlays", "guides", "style", "figure", "panels"] as const;
/** The per-series keys carried (the drawn-parts bookkeeping — svg ids, components, capabilities —
 *  is for the renderer, not for reasoning about data). `axis` says a series reads a twin's value
 *  axis (`y2` / `x2`); the payloads are fluxplot's per-kind records. */
const SERIES_KEYS = ["id", "name", "kind", "label", "panelId", "axis", "roles", "data", "points", "color", "bar", "band", "uncertainty",
  "distribution", "field", "glowbar", "fluxbox", "hexmatrix", "image", "surface", "step", "stem", "regression", "kde"] as const;

/** Window `value`'s long arrays in place (on a copy), recording each cut. Arrays of fewer than
 *  `limit` entries pass whole; the walk continues into objects and into the kept entries. */
export function paginate(value: unknown, offset: number, limit: number, path: string, pages: PlotDataPage[]): unknown {
  if (Array.isArray(value)) {
    let items = value, base = 0;
    if (value.length > limit) { // only a long array is windowed; short ones pass whole
      items = value.slice(offset, offset + limit);
      base = offset;
      pages.push({ path, total: value.length, offset, limit, returned: items.length });
    }
    return items.map((v, i) => (typeof v === "object" && v !== null ? paginate(v, offset, limit, `${path}[${i + base}]`, pages) : v));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = typeof v === "object" && v !== null ? paginate(v, offset, limit, `${path}.${k}`, pages) : v;
    return out;
  }
  return value;
}

/** The plot's data as `get_plot_data` returns it. Throws for an unknown series. */
export function plotData(manifest: FluxPlotManifest | undefined, opts: PlotDataOptions = {}): PlotDataResult {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const wanted = new Set((opts.fields?.length ? opts.fields : [...SECTIONS]).map((f) => f.trim()).filter(Boolean));
  const keepLut = wanted.has("lut");
  const pages: PlotDataPage[] = [];
  const out: PlotDataResult = {
    spec: (manifest as { spec?: string } | undefined)?.spec ?? null,
    schemaVersion: manifest?.schemaVersion ?? null,
    plotType: (manifest as { plotType?: string } | undefined)?.plotType ?? null,
    pages, offset, limit,
  };
  if (!manifest) return out;
  if (wanted.has("series")) {
    let series = manifest.series ?? [];
    if (opts.seriesId) {
      series = series.filter((s) => s.id === opts.seriesId || s.name === opts.seriesId);
      if (!series.length) throw new Error(`Series not found: ${opts.seriesId} (have ${(manifest.series ?? []).map((s) => s.id).join(", ")})`);
    }
    out.series = series.map((s) => {
      const rec: Record<string, unknown> = {}, src = s as unknown as Record<string, unknown>;
      for (const k of SERIES_KEYS) if (src[k] !== undefined) rec[k] = src[k];
      return paginate(rec, offset, limit, `series[${s.id}]`, pages) as Record<string, unknown>;
    });
  }
  if (wanted.has("colorScales")) {
    out.colorScales = (manifest.colorScales ?? []).map((sc) => {
      const { colormap, ...rest } = sc as unknown as { colormap: Record<string, unknown> } & Record<string, unknown>;
      const { lut, ...cm } = colormap;
      return { ...rest, colormap: keepLut ? { ...cm, lut } : { ...cm, N: colormap.N ?? (Array.isArray(lut) ? lut.length : undefined) } };
    });
  }
  if (wanted.has("axes")) {
    out.axes = (manifest.axes ?? []).map((a) => {
      const rec = a as unknown as Record<string, unknown>;
      const axis = (v: unknown) => {
        if (!v || typeof v !== "object") return v;
        const { anchors: _anchors, ...keep } = v as Record<string, unknown>;
        return keep;
      };
      const kept: Record<string, unknown> = { id: rec.id, panelId: rec.panelId, projection: rec.projection };
      for (const k of ["x", "y", "y2", "x2", "z"]) if (rec[k] !== undefined) kept[k] = axis(rec[k]);
      return paginate(kept, offset, limit, `axes[${rec.id}]`, pages) as Record<string, unknown>;
    });
  }
  if (wanted.has("overlays")) out.overlays = paginate(manifest.overlays ?? [], offset, limit, "overlays", pages) as Record<string, unknown>[];
  if (wanted.has("guides")) {
    out.guides = (manifest.guides ?? []).map((g) => {
      const { parts: _parts, ...rest } = g as unknown as Record<string, unknown>;
      return paginate(rest, offset, limit, `guides[${(g as { id?: string }).id}]`, pages) as Record<string, unknown>;
    });
  }
  if (wanted.has("style")) out.style = (manifest as { style?: unknown }).style ?? null;
  if (wanted.has("figure")) out.figure = (manifest as { figure?: unknown }).figure ?? null;
  if (wanted.has("panels")) out.panels = ((manifest as { panels?: Record<string, unknown>[] }).panels ?? []).map((p) => ({ ...p }));
  return out;
}
