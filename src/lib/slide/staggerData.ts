// Stagger ordering keys read from the data (colour-system plan F7): a track's `stagger.by` may
// order targets by their data-space x / y (as before), by their VALUE (`"data"`, or
// `{ key: "value" }`: a hexagon's mean, a cell's value, a bar's height, a point's colour value),
// by their COUNT (`{ key: "count" }`: observations per hexagon) or by their INDEX. The player
// reads the attributes fluxplot writes on the node (`data-x`, `data-value`, `data-count`,
// `data-index`); the compiler and any headless path read the manifest instead, so both rank the
// same targets the same way.
import type { Stagger } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import { projectWith, seriesFits, viewFits } from "../plot/project";

export type StaggerKey = "x" | "y" | "value" | "count" | "index";

/** The ordering key behind a `stagger.by`, or null for plain target order (and for "radial", ranked by `radialCoordinates`). */
export function staggerKey(by: Stagger["by"] | undefined): StaggerKey | null {
  if (!by || by === "index" || by === "radial") return null;
  if (by === "x" || by === "y") return by;
  if (by === "data") return "value";
  return by.key === "index" ? "index" : by.key;
}

const ATTR: Record<StaggerKey, string[]> = {
  x: ["data-x", "x", "cx"], y: ["data-y", "y", "cy"], value: ["data-value"], count: ["data-count"], index: ["data-index"],
};

/** A target node's coordinate for `key` from the attributes fluxplot wrote (null when absent). */
export function nodeCoordinate(node: { getAttribute?: (n: string) => string | null; querySelector?: (s: string) => { getAttribute(n: string): string | null } | null } | null | undefined, key: StaggerKey): number | null {
  if (!node?.getAttribute) return null;
  for (const name of ATTR[key]) {
    const v = node.getAttribute(name) ?? node.querySelector?.(`[${name}]`)?.getAttribute(name) ?? null;
    if (v == null || v === "") continue;
    const num = Number(v);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/** The same coordinates from the manifest, for the compiler: points (x, y, colour value,
 *  index), hexagons (centre, value, count), heatmap cells (value by row / column), bars (height
 *  by position). Unknown parts are null and keep their input order after the ranked ones. */
export function manifestCoordinates(manifest: FluxPlotManifest | undefined, partIds: readonly string[], key: StaggerKey, space: "data" | "pixel" = "data"): (number | null)[] {
  const out = new Map<string, number | null>();
  for (const s of manifest?.series ?? []) {
    // "pixel": x / y of points and bars through the axis fit (a log axis is right), the clock an x-clock sweep draws on (WP 3.1),
    // ORIENTED like the data (a screen y grows downwards: the sign flips, so ascending still means ascending data and `from` keeps its
    // meaning). Hexbins and cells keep their data space.
    const fits = space === "pixel" && (key === "x" || key === "y") && manifest ? viewFits(manifest, undefined, s.panelId) : null;
    const fit = fits ? seriesFits(fits, (s as { axis?: string }).axis)?.[key as "x" | "y"] : undefined;
    const dir = fit ? Math.sign(projectWith(fit, 2) - projectWith(fit, 1)) || 1 : 1;
    const px = (v: number | null | undefined): number | null | undefined => fit && typeof v === "number" && Number.isFinite(v) ? dir * projectWith(fit, v) : v;
    const rec = s as unknown as Record<string, unknown>;
    const data = rec.data as { x?: (number | null)[]; y?: (number | null)[]; c?: (number | null)[] } | undefined;
    for (const p of s.points ?? []) {
      const v = px(key === "x" ? p.x : key === "y" ? p.y : key === "index" ? p.index : key === "value" ? data?.c?.[p.index] ?? p.y : null);
      out.set(p.svgId, typeof v === "number" && Number.isFinite(v) ? v : null);
    }
    const bins = (rec.hexmatrix as { bins?: { svgId?: string; x: number; y: number; value: number | null; count: number | null }[] } | undefined)?.bins;
    if (bins) for (const [i, b] of bins.entries()) if (b.svgId) out.set(b.svgId, key === "x" ? b.x : key === "y" ? b.y : key === "value" ? b.value : key === "count" ? b.count : i);
    const bars = s.svg?.bars;
    if (Array.isArray(bars)) {
      const bar = rec.bar as { length?: (number | null)[]; center?: (number | null)[]; orientation?: string } | undefined;
      bars.forEach((id, i) => {
        const horizontal = bar?.orientation === "horizontal";
        const pos = bar?.center?.[i] ?? (horizontal ? data?.y?.[i] : data?.x?.[i]) ?? null;
        const len = bar?.length?.[i] ?? (horizontal ? data?.x?.[i] : data?.y?.[i]) ?? null;
        const v = px(key === "index" ? i : key === "value" ? len : horizontal ? (key === "y" ? pos : len) : (key === "x" ? pos : len));
        out.set(id, typeof v === "number" && Number.isFinite(v) ? v : null);
      });
    }
    const field = rec.field as { values?: (number | null)[][]; shape?: number[] } | undefined;
    if (field?.values) for (const c of s.components ?? []) for (const m of c.members ?? []) {
      const mm = /\.cell\.(\d+)\.(\d+)$/.exec(m);
      if (!mm) continue;
      const r = Number(mm[1]), col = Number(mm[2]);
      const v = key === "value" ? field.values[r]?.[col] ?? null : key === "index" ? r * (field.shape?.[1] ?? 0) + col : key === "x" ? col : key === "y" ? r : null;
      out.set(m, typeof v === "number" && Number.isFinite(v) ? v : null);
    }
  }
  return partIds.map((id) => out.get(id) ?? null);
}

/** WP 4.3 (W7): each part's distance from `origin` (data units of its series' axes; absent = the centre of the parts) in the plot's PIXEL
 *  space, through each series' own view fits (a log axis, a twin axis, a squashed aspect measure as they look): THE radial order of both
 *  engines (the compiler from the manifest; the player from the same manifest, never DOM attributes). Points at (x, y), bars at the middle
 *  of their bar, hexbins at their centre; heatmap cells in (column, row) index space (square cells assumed; their origin likewise).
 *  Parts the manifest does not place are null and keep their order after the ranked ones (staggerRanks). */
export function radialCoordinates(manifest: FluxPlotManifest | undefined, partIds: readonly string[], origin?: { x: number; y: number }): (number | null)[] {
  const pos = new Map<string, { x: number; y: number; o: { x: number; y: number } | null }>();
  for (const s of manifest?.series ?? []) {
    const fits = manifest ? viewFits(manifest, undefined, s.panelId) : null, f = fits ? seriesFits(fits, (s as { axis?: string }).axis) : undefined;
    const P = (v: number, axis: "x" | "y") => (f?.[axis] ? projectWith(f[axis]!, v) : v);
    const at = (x: number | null | undefined, y: number | null | undefined) => typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? { x: P(x, "x"), y: P(y, "y") } : null;
    const o = origin ? { x: P(origin.x, "x"), y: P(origin.y, "y") } : null;
    const rec = s as unknown as Record<string, unknown>;
    const data = rec.data as { x?: (number | null)[]; y?: (number | null)[] } | undefined;
    for (const p of s.points ?? []) { const q = at(p.x, p.y); if (q) pos.set(p.svgId, { ...q, o }); }
    const bins = (rec.hexmatrix as { bins?: { svgId?: string; x: number; y: number }[] } | undefined)?.bins;
    if (bins) for (const b of bins) { const q = b.svgId ? at(b.x, b.y) : null; if (q) pos.set(b.svgId!, { ...q, o }); }
    const bars = s.svg?.bars;
    if (Array.isArray(bars)) {
      const bar = rec.bar as { length?: (number | null)[]; center?: (number | null)[]; orientation?: string } | undefined, horizontal = bar?.orientation === "horizontal";
      bars.forEach((id, i) => {
        const c = bar?.center?.[i] ?? (horizontal ? data?.y?.[i] : data?.x?.[i]) ?? null, len = bar?.length?.[i] ?? (horizontal ? data?.x?.[i] : data?.y?.[i]) ?? null;
        const q = typeof len === "number" ? (horizontal ? at(len / 2, c) : at(c, len / 2)) : null;
        if (q) pos.set(id, { ...q, o });
      });
    }
    const field = rec.field as { values?: unknown } | undefined;
    if (field?.values) for (const c of s.components ?? []) for (const m of c.members ?? []) {
      const mm = /\.cell\.(\d+)\.(\d+)$/.exec(m);
      if (mm) pos.set(m, { x: Number(mm[2]), y: Number(mm[1]), o: origin ? { ...origin } : null });
    }
  }
  const placed = partIds.map((id) => pos.get(id) ?? null), known = placed.filter((p): p is NonNullable<typeof p> => !!p);
  const centre = known.length ? { x: known.reduce((a, p) => a + p.x, 0) / known.length, y: known.reduce((a, p) => a + p.y, 0) / known.length } : { x: 0, y: 0 };
  return placed.map((p) => (p ? Math.hypot(p.x - (p.o ?? centre).x, p.y - (p.o ?? centre).y) : null));
}
