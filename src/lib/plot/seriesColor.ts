// One colour for a whole series (colour-system plan B2, Flux half).
//
// A fluxplot series is drawn by several parts — its line, its points, its bars, an error-bar
// composite, a band — and keyed by a legend swatch. `seriesColorPatch(manifest, seriesId, hex)`
// names every one of them and the paint each takes (a line its stroke, a bar its fill, a marker
// or a swatch both), so `ops.setSeriesColor` writes one override per part and the plot reads as
// one colour again; `null` clears exactly those keys. `legendSwatchesOf` is the coupling a plain
// `restyle_part` of a series' line or bars uses to keep the legend honest (plan F6).
import { buildPartIndex } from "./parse";
import { kindOfNode } from "./tree";
import type { FluxPlotManifest } from "./types";
import type { PartOverride } from "../types";

export type SeriesPaint = "fill" | "stroke" | "both";
export interface SeriesPart { partId: string; role: string; paint: SeriesPaint }

/** Roles painted on both faces whatever their kind: markers and legend swatches (a marker's
 *  edge is its face by default; a swatch stands for the series, so a bar swatch's edge and a
 *  line swatch's stroke both take the colour). */
const BOTH_ROLES = new Set(["point", "legend-swatch", "x-hexbin"]);

/** The parts a series is drawn by (the manifest's `svg`, `components` and `points`), in
 *  manifest order, deduplicated. Empty for an unknown series. */
export function seriesPartIds(manifest: FluxPlotManifest | undefined, seriesId: string): string[] {
  const s = manifest?.series?.find((x) => x.id === seriesId);
  if (!s) return [];
  const out: string[] = [];
  const push = (id: unknown) => { if (typeof id === "string" && id && !out.includes(id)) out.push(id); };
  for (const v of Object.values(s.svg ?? {})) { if (Array.isArray(v)) v.forEach(push); else push(v); }
  for (const c of s.components ?? []) { push(c.svgId); (c.members ?? []).forEach(push); }
  for (const p of s.points ?? []) push(p.svgId);
  return out;
}

/** The legend swatch ids keyed to a series (`guides[legend].entries[].series`). */
export function legendSwatchesOf(manifest: FluxPlotManifest | undefined, seriesId: string): string[] {
  const out: string[] = [];
  for (const g of manifest?.guides ?? []) {
    if (g.role !== "legend") continue;
    for (const e of (g as { entries?: { series?: string; swatch?: string }[] }).entries ?? []) {
      if (e.series === seriesId && e.swatch && !out.includes(e.swatch)) out.push(e.swatch);
    }
  }
  return out;
}

/** The series a part belongs to: a series-level id (`svg.*`, a component or a member, a
 *  point), else undefined (scaffold, overlays, swatches). */
export function seriesOf(manifest: FluxPlotManifest | undefined, partId: string): string | undefined {
  for (const s of manifest?.series ?? []) if (seriesPartIds(manifest, s.id).includes(partId)) return s.id;
  return undefined;
}

/** The series whose WHOLE drawing a part is — its line, its points group, its area, its field
 *  (a string-valued `svg.*` id) — else undefined: recolouring one bar or one point highlights
 *  it and must not repaint the legend key. */
export function seriesPrimaryOf(manifest: FluxPlotManifest | undefined, partId: string): string | undefined {
  for (const s of manifest?.series ?? []) {
    for (const v of Object.values(s.svg ?? {})) if (v === partId) return s.id;
  }
  return undefined;
}

/** Why a series cannot take one colour, or null: unknown, or colour-mapped (its colour scale
 *  paints it — edit that instead). */
export function seriesColorIssue(manifest: FluxPlotManifest | undefined, seriesId: string): string | null {
  const s = manifest?.series?.find((x) => x.id === seriesId);
  if (!s) return `Series not found: ${seriesId}`;
  if (s.color?.scale || s.color?.hex === "varies" || s.field?.colorScale) return `Series ${seriesId} is coloured by its colour scale ‹${s.color?.scale ?? s.field?.colorScale ?? "?"}›: edit that instead (set_plot_color_scale).`;
  return null;
}

/** How a part of role/kind takes a series colour, or null when it takes none (text). */
export function paintForRole(role: string, kind: string | undefined): SeriesPaint | null {
  if (BOTH_ROLES.has(role)) return "both";
  const k = kindOfNode({ kind }, role);
  if (k === "line") return "stroke";
  if (k === "shape") return "fill";
  return null;
}

/** Every part of the series plus its legend swatches, each with the paint it takes. */
export function seriesParts(manifest: FluxPlotManifest | undefined, seriesId: string): SeriesPart[] {
  const index = buildPartIndex(manifest);
  const out: SeriesPart[] = [];
  for (const partId of seriesPartIds(manifest, seriesId)) {
    const info = index[partId];
    const role = info?.role ?? "part";
    const paint = paintForRole(role, info?.kind);
    if (paint) out.push({ partId, role, paint });
  }
  for (const partId of legendSwatchesOf(manifest, seriesId)) out.push({ partId, role: "legend-swatch", paint: "both" });
  return out;
}

/** The override patch per part for `color` (`null` clears the same keys). */
export function seriesColorPatch(manifest: FluxPlotManifest | undefined, seriesId: string, color: string | null): Record<string, PartOverride> {
  const out: Record<string, PartOverride> = {};
  for (const { partId, paint } of seriesParts(manifest, seriesId)) {
    const patch: Record<string, string | null> = {};
    if (paint !== "stroke") patch.fill = color;
    if (paint !== "fill") patch.stroke = color;
    out[partId] = patch as PartOverride;
  }
  return out;
}

/** The swatch patch that mirrors a part edit onto the series' legend swatches: only a fill or
 *  stroke colour travels (a hidden line does not hide its key), and it paints both faces. */
export function swatchMirror(patch: PartOverride): PartOverride | null {
  const colour = (typeof patch.stroke === "string" && patch.stroke) || (typeof patch.fill === "string" && patch.fill) || null;
  if (!colour || colour === "none") return null;
  return { fill: colour, stroke: colour };
}
