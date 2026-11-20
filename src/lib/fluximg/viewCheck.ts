/**
 * Strict checking of a view patch against a bundle's manifest (pure: no DOM, no Node, no Svelte).
 *
 * `resolveView` is lenient by design: a stored view written by an older build or a hand edit must still draw, so it
 * clamps and ignores. An AGENT's patch deserves the opposite: every key it sends must mean something for THIS image,
 * or it is told exactly what is wrong (`problems`, which refuse the edit) before anything is written. `warnings`
 * name settings that are valid but will not show (a scale bar on an image without a pixel size).
 */
import type { FluximgManifest } from "./types";
import type { FluximgView } from "./view";
import { positionDims } from "./viewOps";
import { hexToRgb } from "./lut";

const MODES = ["max", "mean", "min", "sum", "std"];
const CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"];
const NORMS = ["linear", "log", "gamma"];

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const int = (v: unknown): v is number => finite(v) && Number.isInteger(v);
const isColor = (v: unknown): boolean => typeof v === "string" && hexToRgb(v) !== null;
const list = (xs: readonly string[]): string => xs.length ? xs.map((x) => `"${x}"`).join(", ") : "(none)";

export interface ViewCheckOptions {
  /** True when a colour-map name is known (load the tables first). Absent: names are not checked. */
  knownLut?: (name: string) => boolean;
}

export interface ViewCheck { problems: string[]; warnings: string[] }

/** Check a sparse patch (`FluximgView` with nulls meaning "clear") against a manifest. */
export function checkViewPatch(manifest: FluximgManifest, patch: unknown, options: ViewCheckOptions = {}): ViewCheck {
  const problems: string[] = [], warnings: string[] = [];
  if (!isObj(patch)) return { problems: ["the view must be an object, e.g. {\"index\": {\"z\": 3}}"], warnings };
  const p = manifest.pixels, dims = positionDims(manifest), nC = manifest.channels.length;
  const size = (d: string): number => p.shape[p.dims.indexOf(d)];
  const layerIds = manifest.layers.map((l) => l.id);
  const layerOf = (id: string) => manifest.layers.find((l) => l.id === id);
  const lutOk = (where: string, v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v !== "string" || !v.trim()) problems.push(`${where}: a colour-map name is a non-empty string`);
    else if (options.knownLut && !options.knownLut(v)) problems.push(`${where}: unknown colour map "${v}" (try gray, viridis, magma, inferno, cmasher.ember, crameri.batlow)`);
  };
  const colorOk = (where: string, v: unknown): void => {
    if (v !== null && v !== undefined && !isColor(v)) problems.push(`${where}: a colour is "#rrggbb" (or "#rgb"), got ${JSON.stringify(v)}`);
  };
  const rangeOk = (where: string, v: unknown): void => {
    if (v === null || v === undefined) return;
    if (!(Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && v[1] > v[0])) problems.push(`${where}: a range is [black, white] in value units with white > black, got ${JSON.stringify(v)}`);
  };
  const unitOk = (where: string, v: unknown): void => {
    if (v !== null && v !== undefined && !(finite(v) && v >= 0 && v <= 1)) problems.push(`${where}: must be between 0 and 1, got ${JSON.stringify(v)}`);
  };
  const boolOk = (where: string, v: unknown): void => {
    if (v !== null && v !== undefined && typeof v !== "boolean") problems.push(`${where}: must be true or false`);
  };
  const keysOk = (where: string, o: Record<string, unknown>, allowed: readonly string[]): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${where}: unknown setting "${k}" (allowed: ${list(allowed)})`);
  };

  keysOk("view", patch, ["index", "projection", "channels", "composite", "solo", "smooth", "background", "layers", "layerOrder", "furniture", "insetOf", "link"]);

  const index = patch.index;
  if (index !== undefined && index !== null) {
    if (!isObj(index)) problems.push(`index: an object of positions, e.g. {"${dims[0] ?? "z"}": 0}`);
    else for (const [d, v] of Object.entries(index)) {
      if (!dims.includes(d)) { problems.push(`index.${d}: this image has no "${d}" dimension to step through (it has ${list(dims)})`); continue; }
      if (v === null) continue;
      if (!int(v) || v < 0 || v >= size(d)) problems.push(`index.${d}: a plane number from 0 to ${size(d) - 1}, got ${JSON.stringify(v)}`);
    }
  }

  const proj = patch.projection;
  if (proj !== undefined && proj !== null) {
    if (!isObj(proj)) problems.push(`projection: {"dim", "mode", "from", "to"} or null to show one plane`);
    else {
      keysOk("projection", proj, ["dim", "mode", "from", "to"]);
      const d = proj.dim;
      if (d !== undefined && (typeof d !== "string" || !dims.includes(d))) problems.push(`projection.dim: one of ${list(dims)}, got ${JSON.stringify(d)}`);
      if (proj.mode !== undefined && !MODES.includes(proj.mode as string)) problems.push(`projection.mode: one of ${list(MODES)}, got ${JSON.stringify(proj.mode)}`);
      const n = typeof d === "string" && dims.includes(d) ? size(d) : null;
      for (const k of ["from", "to"] as const) {
        const v = proj[k];
        if (v !== undefined && (!int(v) || v < 0 || (n !== null && v > n))) problems.push(`projection.${k}: a plane number from 0 to ${n ?? "the dimension's size"}, got ${JSON.stringify(v)}`);
      }
      if (int(proj.from) && int(proj.to) && !(proj.to > proj.from)) problems.push(`projection: "to" is exclusive and must be greater than "from" (from ${proj.from}, to ${proj.to})`);
    }
  }

  const chans = patch.channels;
  if (chans !== undefined && chans !== null) {
    if (!Array.isArray(chans)) problems.push(`channels: a list with one entry per channel (null leaves one unchanged)`);
    else {
      if (chans.length > nC) problems.push(`channels: this image has ${nC} channel${nC === 1 ? "" : "s"} (${list(manifest.channels.map((c) => c.name))}), the patch names ${chans.length}`);
      chans.forEach((c, i) => {
        if (c === null || c === undefined || i >= nC) return;
        const w = `channels[${i}] ("${manifest.channels[i].name}")`;
        if (!isObj(c)) { problems.push(`${w}: an object such as {"range": [100, 4000]}, or null`); return; }
        keysOk(w, c, ["visible", "color", "lut", "range", "norm", "gamma", "invert"]);
        boolOk(`${w}.visible`, c.visible); boolOk(`${w}.invert`, c.invert);
        colorOk(`${w}.color`, c.color); lutOk(`${w}.lut`, c.lut); rangeOk(`${w}.range`, c.range);
        if (c.norm !== undefined && c.norm !== null && !NORMS.includes(c.norm as string)) problems.push(`${w}.norm: one of ${list(NORMS)}`);
        if (c.gamma !== undefined && c.gamma !== null && !(finite(c.gamma) && c.gamma > 0)) problems.push(`${w}.gamma: a positive number`);
        if (c.norm === "log" && Array.isArray(c.range) && finite(c.range[0]) && c.range[0] <= 0) warnings.push(`${w}: a log window needs a black point above 0; this one is drawn linear`);
      });
    }
  }

  if (patch.composite !== undefined && patch.composite !== null && patch.composite !== "blend" && patch.composite !== "single") problems.push(`composite: "blend" (add every visible channel) or "single" (only channel "solo")`);
  if (patch.solo !== undefined && patch.solo !== null && (!int(patch.solo) || patch.solo < 0 || patch.solo >= nC)) problems.push(`solo: a channel number from 0 to ${nC - 1}`);
  boolOk("smooth", patch.smooth);
  if (patch.background !== undefined && patch.background !== null && patch.background !== "transparent" && !isColor(patch.background)) problems.push(`background: "#rrggbb" or "transparent"`);
  if (patch.insetOf !== undefined && patch.insetOf !== null && (typeof patch.insetOf !== "string" || !patch.insetOf)) problems.push(`insetOf: the id of the element this one is a blow-out of`);
  if (patch.link !== undefined && patch.link !== null && (typeof patch.link !== "string" || !patch.link)) problems.push(`link: a name shared by the panels that move together`);

  const layers = patch.layers;
  if (layers !== undefined && layers !== null) {
    if (!isObj(layers)) problems.push(`layers: an object keyed by layer id (this image has ${list(layerIds)})`);
    else for (const [id, lv] of Object.entries(layers)) {
      const layer = layerOf(id);
      if (!layer) { problems.push(`layers.${id}: no such layer (this image has ${list(layerIds)})`); continue; }
      if (lv === null) continue;
      if (!isObj(lv)) { problems.push(`layers.${id}: an object such as {"visible": true}, or null`); continue; }
      const intensity = layer.kind === "intensity";
      keysOk(`layers.${id}`, lv, intensity ? ["visible", "opacity", "color", "lut", "range"] : ["visible", "opacity", "color", "strokeWidth", "fillOpacity"]);
      boolOk(`layers.${id}.visible`, lv.visible); unitOk(`layers.${id}.opacity`, lv.opacity); colorOk(`layers.${id}.color`, lv.color);
      if (intensity) { lutOk(`layers.${id}.lut`, lv.lut); rangeOk(`layers.${id}.range`, lv.range); }
      else {
        unitOk(`layers.${id}.fillOpacity`, lv.fillOpacity);
        if (lv.strokeWidth !== undefined && lv.strokeWidth !== null && !(finite(lv.strokeWidth) && lv.strokeWidth >= 0)) problems.push(`layers.${id}.strokeWidth: screen pixels, 0 or more`);
      }
    }
  }
  const order = patch.layerOrder;
  if (order !== undefined && order !== null) {
    if (!Array.isArray(order)) problems.push(`layerOrder: a list of layer ids, bottom to top`);
    else for (const id of order) if (typeof id !== "string" || !layerOf(id)) problems.push(`layerOrder: no layer ${JSON.stringify(id)} (this image has ${list(layerIds)})`);
  }

  const fur = patch.furniture;
  if (fur !== undefined && fur !== null) {
    if (!isObj(fur)) problems.push(`furniture: an object with scalebar, stamp, channelLabels, names, colorbar (each false/null for off, {} for on)`);
    else {
      keysOk("furniture", fur, ["scalebar", "stamp", "channelLabels", "names", "colorbar"]);
      const item = (k: string, allowed: string[]): Record<string, unknown> | null => {
        const v = fur[k];
        if (v === undefined || v === null || v === false) return null;
        if (!isObj(v)) { problems.push(`furniture.${k}: {} (on, with defaults), an object of settings, or false (off)`); return null; }
        keysOk(`furniture.${k}`, v, allowed);
        if (v.corner !== undefined && !CORNERS.includes(v.corner as string)) problems.push(`furniture.${k}.corner: one of ${list(CORNERS)}`);
        colorOk(`furniture.${k}.color`, v.color);
        if (v.fontSize !== undefined && !(finite(v.fontSize) && v.fontSize > 0)) problems.push(`furniture.${k}.fontSize: points, above 0`);
        return v;
      };
      const sb = item("scalebar", ["length", "corner", "color", "label", "thickness", "fontSize"]);
      if (sb) {
        if (sb.length !== undefined && !(finite(sb.length) && sb.length > 0)) problems.push(`furniture.scalebar.length: a length in the x axis' unit, above 0`);
        if (sb.thickness !== undefined && !(finite(sb.thickness) && sb.thickness > 0)) problems.push(`furniture.scalebar.thickness: points, above 0`);
        boolOk("furniture.scalebar.label", sb.label);
        const ax = manifest.axes?.x;
        if (!ax || !(finite(ax.scale) && ax.scale > 0) || !ax.unit) warnings.push(`furniture.scalebar: this image does not state a physical pixel size, so no scale bar is drawn`);
      }
      const st = item("stamp", ["dims", "corner", "color", "fontSize"]);
      if (st && st.dims !== undefined) {
        if (!Array.isArray(st.dims)) problems.push(`furniture.stamp.dims: a list of dimensions (${list(dims)})`);
        else for (const d of st.dims) if (!dims.includes(d as string)) problems.push(`furniture.stamp.dims: no "${String(d)}" dimension (this image has ${list(dims)})`);
      }
      if (st && !dims.length) warnings.push(`furniture.stamp: this image has no depth or time dimension, so the stamp is empty`);
      item("channelLabels", ["corner", "fontSize"]);
      item("colorbar", ["corner", "color", "fontSize"]);
      const nm = item("names", ["layers", "fontSize"]);
      if (nm && nm.layers !== undefined) {
        const objects = manifest.layers.filter((l) => l.kind !== "intensity").map((l) => l.id);
        if (!Array.isArray(nm.layers)) problems.push(`furniture.names.layers: a list of vector or label layer ids (${list(objects)})`);
        else for (const id of nm.layers) if (!objects.includes(id as string)) problems.push(`furniture.names.layers: ${JSON.stringify(id)} is not a vector or label layer (this image has ${list(objects)})`);
      }
    }
  }
  return { problems, warnings };
}

/** The stored view after a patch is still one this image can show (a projection whose pieces came from two patches). */
export function checkMergedView(manifest: FluximgManifest, view: FluximgView | undefined): string[] {
  const out: string[] = [];
  const p = view?.projection;
  if (p) {
    const dims = positionDims(manifest);
    const n = dims.includes(p.dim) ? manifest.pixels.shape[manifest.pixels.dims.indexOf(p.dim)] : 0;
    if (!dims.includes(p.dim) || !MODES.includes(p.mode) || !int(p.from) || !int(p.to) || p.from < 0 || p.to > n || p.to <= p.from)
      out.push(`projection: needs all of dim (${list(dims)}), mode (${list(MODES)}), from and to (0 ≤ from < to ≤ the dimension's size); the view would hold ${JSON.stringify(p)}`);
  }
  return out;
}
