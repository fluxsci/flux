// Shared authoring contract for live colour scales (colour-system plan A7.5 / A7.6): the
// Inspector, the property menu, the X-ray and the `set_plot_color_scale` verb all turn a
// field patch into a validated `ColorScaleView` patch here, and the "Apply to source" path
// turns a view into the v2 recipe control fluxplot understands. Pure — no DOM, no stores.
import type { ColorScaleView, ColorScaleTable } from "../types";
import type { FluxPlotManifest, FluxPlotColorScale } from "./types";
import { effectiveScale, viewIsIdentity, SWITCHABLE_NORM_KINDS, type LutResolver, type NormKind } from "./colorscale";

export type ExtendKind = "neither" | "min" | "max" | "both";
export type ViewNormKind = NonNullable<NonNullable<ColorScaleView["norm"]>["kind"]>;

/** One edit. `null` restores that field's generated value; `reset` restores the scale. */
export interface ColorScaleFields {
  scaleId?: string;
  cmap?: string | ColorScaleTable | null;
  reversed?: boolean | null;
  norm?: ViewNormKind | null;
  vmin?: number | null; vmax?: number | null; vcenter?: number | null;
  gamma?: number | null; linthresh?: number | null; linscale?: number | null;
  extend?: ExtendKind | null;
  reset?: boolean;
}

/** The scale an edit addresses: the named one, else the plot's only one. */
export function pickScale(manifest: FluxPlotManifest | undefined, scaleId?: string): FluxPlotColorScale {
  const scales = manifest?.colorScales ?? [];
  if (!scales.length) throw new Error("This plot records no colour scales (regenerate it with fluxplot ≥ 0.3.1).");
  if (scaleId) {
    const found = scales.find((s) => s.id === scaleId);
    if (!found) throw new Error(`No colour scale ‹${scaleId}›; this plot has: ${scales.map((s) => s.id).join(", ")}.`);
    return found;
  }
  if (scales.length > 1) throw new Error(`Name the colour scale (scaleId): ${scales.map((s) => s.id).join(", ")}.`);
  return scales[0];
}

/** The norm kinds this scale may be switched to (its own kind always included). */
export function normKindsFor(scale: FluxPlotColorScale): ViewNormKind[] {
  const kinds = (scale.editable?.normKinds ?? []).filter((k): k is ViewNormKind => SWITCHABLE_NORM_KINDS.includes(k as NormKind));
  const own = scale.norm.kind as ViewNormKind;
  if (SWITCHABLE_NORM_KINDS.includes(own) && !kinds.includes(own)) kinds.unshift(own);
  return kinds;
}

/** A validated view patch for `fields` over the current `view` of `scale` (null = reset).
 *  Throws with the reason when the result could not be painted (a log minimum ≤ 0, a
 *  two-slope centre outside its limits, a colormap fluxplot does not ship, a raster scale). */
export function colorScalePatch(scale: FluxPlotColorScale, view: ColorScaleView | undefined, fields: ColorScaleFields, resolve?: LutResolver): Partial<ColorScaleView> | null {
  if (fields.reset) {
    if (Object.entries(fields).some(([k, v]) => k !== "reset" && k !== "scaleId" && v !== undefined)) throw new Error("Reset cannot be combined with other colour-scale edits.");
    return null;
  }
  if (scale.recolor !== "live") throw new Error(`Colour scale ‹${scale.id}› is a raster: change its colours by regenerating the plot.`);
  const patch: Partial<ColorScaleView> = {};
  if (fields.cmap !== undefined) {
    if (fields.cmap === null) patch.cmap = undefined;
    else if (typeof fields.cmap === "string") {
      if (!scale.editable?.cmap) throw new Error(`Colour scale ‹${scale.id}› does not allow a colormap change.`);
      const table = resolve?.(fields.cmap) ?? null;
      if (!table) throw new Error(`Colormap ‹${fields.cmap}› is not one fluxplot ships (use a qualified name such as crameri.batlow, or a table).`);
      patch.cmap = { ...table, name: fields.cmap };
    } else {
      if (!fields.cmap.lut?.length) throw new Error("A colormap table needs a non-empty lut.");
      patch.cmap = fields.cmap;
    }
  }
  if (fields.reversed !== undefined) patch.reversed = fields.reversed ?? undefined;
  if (fields.extend !== undefined) {
    if (fields.extend !== null && !["neither", "min", "max", "both"].includes(fields.extend)) throw new Error("extend must be neither, min, max or both.");
    patch.extend = fields.extend ?? undefined;
  }
  const normKeys = ["vmin", "vmax", "vcenter", "gamma", "linthresh", "linscale"] as const;
  if (fields.norm !== undefined || normKeys.some((k) => fields[k] !== undefined)) {
    const norm: Record<string, unknown> = {};
    if (fields.norm !== undefined) {
      if (fields.norm !== null && !normKindsFor(scale).includes(fields.norm)) throw new Error(`Colour scale ‹${scale.id}› can be ${normKindsFor(scale).join(", ")} — not ${fields.norm}.`);
      norm.kind = fields.norm;
    }
    if ((fields.vmin !== undefined || fields.vmax !== undefined) && !scale.editable?.limits) throw new Error(`Colour scale ‹${scale.id}› has fixed limits (a ${scale.norm.kind} norm).`);
    for (const k of normKeys) if (fields[k] !== undefined) {
      const v = fields[k];
      if (v !== null && !Number.isFinite(v)) throw new Error(`${k} must be a finite number.`);
      norm[k] = v;
    }
    patch.norm = norm as ColorScaleView["norm"];
  }
  if (!Object.keys(patch).length) throw new Error("Set a colormap, a limit, a norm or extend — or reset the scale.");
  // validate the result as a consumer would paint it
  const next: ColorScaleView = { ...view, ...patch, norm: { ...view?.norm, ...(patch.norm ?? {}) } };
  for (const [k, v] of Object.entries(next.norm ?? {})) if (v == null) delete (next.norm as Record<string, unknown>)[k];
  if (next.norm && !Object.keys(next.norm).length) delete next.norm;
  for (const k of ["cmap", "reversed", "extend"] as const) if (next[k] === undefined) delete next[k];
  const eff = effectiveScale(scale, next, resolve);
  if (eff.issues.length) throw new Error(eff.issues.join(" "));
  return patch;
}

/** The v2 `recipe.params.__fluxplot__[scale.id]` control that regenerates the plot as `view`
 *  paints it live: a named colormap by name (fluxplot rebuilds it), a bare table as a table,
 *  the limits, the norm kind with its parameters, extend. Absent view fields restate the
 *  generated record, so an editor always writes the complete state. */
export function controlFromView(scale: FluxPlotColorScale, view: ColorScaleView | undefined, resolve?: LutResolver): Record<string, unknown> {
  const eff = effectiveScale(scale, view, resolve);
  const cmap = view?.cmap;
  let cmapSpec: unknown = scale.colormap.name;
  if (typeof cmap === "string") cmapSpec = cmap;
  else if (cmap && typeof cmap === "object") cmapSpec = cmap.name ?? { lut: cmap.lut.map((c) => c.length === 9 ? c : c.slice(0, 7)), under: eff.colormap.under, over: eff.colormap.over, bad: eff.colormap.bad };
  const norm: Record<string, unknown> = { kind: eff.norm.kind };
  for (const k of ["vcenter", "gamma", "linthresh", "linscale"] as const) if (eff.norm[k] != null) norm[k] = eff.norm[k];
  return {
    cmap: cmapSpec,
    ...(view?.reversed ? { reversed: true } : {}),
    vmin: eff.norm.vmin, vmax: eff.norm.vmax,
    norm,
    extend: eff.norm.extend,
  };
}

/** A short human line for a scale (the legend of its editor block). */
export function describeScale(scale: FluxPlotColorScale): string {
  return scale.label ? `${scale.label} (${scale.id})` : scale.id;
}

export { viewIsIdentity };
