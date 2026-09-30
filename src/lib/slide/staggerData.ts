// Stagger ordering keys read from the data (colour-system plan F7): a track's `stagger.by` may
// order targets by their data-space x / y (as before), by their VALUE (`"data"`, or
// `{ key: "value" }`: a hexagon's mean, a cell's value, a bar's height, a point's colour value),
// by their COUNT (`{ key: "count" }`: observations per hexagon) or by their INDEX. The player
// reads the attributes fluxplot writes on the node (`data-x`, `data-value`, `data-count`,
// `data-index`); the compiler and any headless path read the manifest instead, so both rank the
// same targets the same way.
import type { Stagger } from "./types";
import type { FluxPlotManifest } from "../plot/types";

export type StaggerKey = "x" | "y" | "value" | "count" | "index";

/** The ordering key behind a `stagger.by`, or null for plain target order. */
export function staggerKey(by: Stagger["by"] | undefined): StaggerKey | null {
  if (!by || by === "index") return null;
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
export function manifestCoordinates(manifest: FluxPlotManifest | undefined, partIds: readonly string[], key: StaggerKey): (number | null)[] {
  const out = new Map<string, number | null>();
  for (const s of manifest?.series ?? []) {
    const rec = s as unknown as Record<string, unknown>;
    const data = rec.data as { x?: (number | null)[]; y?: (number | null)[]; c?: (number | null)[] } | undefined;
    for (const p of s.points ?? []) {
      const v = key === "x" ? p.x : key === "y" ? p.y : key === "index" ? p.index : key === "value" ? data?.c?.[p.index] ?? p.y : null;
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
        const v = key === "index" ? i : key === "value" ? len : horizontal ? (key === "y" ? pos : len) : (key === "x" ? pos : len);
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
