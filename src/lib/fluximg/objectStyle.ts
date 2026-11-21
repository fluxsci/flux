/**
 * Styling a layer's objects by the columns of its table: THE LAW (pure: no DOM, no Node, no Svelte).
 *
 * A label or vector layer that has a table can colour each object by a column and set each object's opacity from a
 * numeric column (`FluximgLayerView.styleBy`). Nothing is stored per object: the style is derived here, every time,
 * from the table and the request, so the editor, the live view, exports, Paper and flux-core draw the same.
 *
 *   kind        a column is NUMERIC when every value that is not null is a finite number; a column with no value
 *               at all is "empty"; anything else is CATEGORICAL.
 *   categories  the distinct non-null values in an order that does not depend on the rows: numbers ascending, then
 *               strings in natural order (digit runs by value, letters case-insensitively, then by code point),
 *               then false, true. Category i takes palette[i % palette.length]: past the palette's length the
 *               colours repeat (wrap-around). Adding or reordering rows therefore never recolours a category that
 *               keeps its place among the values; a NEW value sorting before it shifts it, as in any sorted legend.
 *   numbers     x = (v − lo) / (hi − lo) over `range` (default the column's finite min..max), clamped; a degenerate
 *               range (hi ≤ lo) puts every value in the map's middle (x = 0.5). The colour is THE channel law:
 *               `lut.channelTable` (256 slots, `reverse` = invert) at `lut.slotOf(x)`, so an object's colour is the
 *               colour a pixel of that value gets under the same map (and a plot's colour scale, `plot/colorscale`).
 *               Default map: viridis. A numeric column with an explicit `palette` (and no `lut`) is coloured as
 *               categories: integer codes such as cluster numbers.
 *   opacity     linear from `range` (default min..max) onto `to` (default [0.15, 1]), clamped to `to`; a degenerate
 *               range gives the middle of `to`. The column must be numeric.
 *   missing     an object whose value is null in a styling column, or that has no row: "dim" (default) draws it in
 *               neutral grey DIM_COLOR at DIM_OPACITY; "hide" leaves it out.
 *
 * A styling column that does not exist (or an opacity column that is not numeric) is an ISSUE and that part of the
 * styling is not applied; this never throws.
 */
import type { FluximgTable } from "./types";
import type { FluximgStyleBy } from "./view";
import { channelTable, hexToRgb, makeNormalizer, normalizeValue, slotOf } from "./lut";

export type Cell = number | string | boolean | null;
export type ColumnKind = "number" | "category" | "empty";

/**
 * fluxplot's categorical cycle for dark backgrounds (`fluxplot.style.CYCLE_DARK`): the Flexoki 400 weights in the
 * order that keeps every adjacent pair apart for colour-deficient readers (blue, orange, purple, green, magenta,
 * yellow, cyan, red). An image is dark, so the dark cycle. `verify-fluximg-object-style` pins it against the shipped
 * Flexoki collection.
 */
export const DEFAULT_PALETTE: readonly string[] = ["#4385be", "#da702c", "#8b7ec8", "#35ab49", "#ce5d97", "#d0a215", "#3aa99f", "#d14d41"];
/** The colour map a numeric column uses when none is named. */
export const DEFAULT_STYLE_LUT = "viridis";
/** Where a numeric opacity column maps by default: faint, never invisible, to opaque. */
export const DEFAULT_OPACITY_TO: readonly [number, number] = [0.15, 1];
/** An object without a value, dimmed: Flexoki base-500, mid grey, reads on black images and on the dark board alike. */
export const DIM_COLOR = "#878580";
export const DIM_OPACITY = 0.35;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isColor = (v: unknown): v is string => typeof v === "string" && hexToRgb(v) !== null;

/** "number" when every non-null value is a finite number, "empty" when there is none, else "category". */
export function columnKind(values: readonly unknown[]): ColumnKind {
  let any = false;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    any = true;
    if (!finite(v)) return "category";
  }
  return any ? "number" : "empty";
}

// --- the order of categories --------------------------------------------------------------------------------

/** Code-point order (not UTF-16 units: an astral character sorts by its code point). */
function codePointCompare(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i].codePointAt(0)!, q = y[i].codePointAt(0)!;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
}
const CHUNK = /[0-9]+|[^0-9]+/g;
/**
 * Natural order: runs of ASCII digits compare by value ("d2" before "d10"), other runs case-insensitively (by code
 * point of the lower-cased text, so no locale enters), digits before letters; ties (case, leading zeros) are broken
 * by plain code-point order. Deterministic in every engine (no `localeCompare`).
 */
export function naturalCompare(a: string, b: string): number {
  const ca = a.match(CHUNK) ?? [], cb = b.match(CHUNK) ?? [];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i], y = cb[i];
    const dx = x.charCodeAt(0) <= 57 && x.charCodeAt(0) >= 48, dy = y.charCodeAt(0) <= 57 && y.charCodeAt(0) >= 48;
    if (dx && dy) {
      const tx = x.replace(/^0+(?=\d)/, ""), ty = y.replace(/^0+(?=\d)/, "");
      if (tx.length !== ty.length) return tx.length - ty.length;
      if (tx !== ty) return tx < ty ? -1 : 1;
      continue;
    }
    if (dx !== dy) return dx ? -1 : 1;
    const lx = x.toLowerCase(), ly = y.toLowerCase();
    if (lx !== ly) return codePointCompare(lx, ly);
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  return codePointCompare(a, b);
}
const rank = (v: Exclude<Cell, null>): number => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
/** Numbers ascending, then strings (natural), then false, true. */
export function compareCells(a: Exclude<Cell, null>, b: Exclude<Cell, null>): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ra === 2) return (a ? 1 : 0) - (b ? 1 : 0);
  return naturalCompare(a as string, b as string);
}
/** A value's identity as a category: 1 and "1" are different values. */
export const cellId = (v: Exclude<Cell, null>): string => `${typeof v === "number" ? "n" : typeof v === "string" ? "s" : "b"}:${String(v)}`;
/** A value as a legend prints it. */
export const cellLabel = (v: Exclude<Cell, null>): string => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))) : String(v));

/** The distinct non-null values of a column in the law's order. */
export function categoriesOf(values: readonly unknown[]): Array<Exclude<Cell, null>> {
  const seen = new Map<string, Exclude<Cell, null>>();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    const id = cellId(v);
    if (!seen.has(id)) seen.set(id, v);
  }
  return [...seen.values()].sort(compareCells);
}

/** The finite min and max of a column, or null. */
export function numericExtent(values: readonly unknown[]): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) if (finite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo <= hi ? [lo, hi] : null;
}

/** What one column of a table holds: what an agent or the board can style by. */
export interface ColumnSummary { name: string; kind: ColumnKind; distinct: number; range: [number, number] | null; missing: number }
/** Every column but the key, with its kind, number of distinct values and (numbers) range. */
export function columnSummaries(table: FluximgTable | null | undefined): ColumnSummary[] {
  if (!table || typeof table.columns !== "object" || !table.columns) return [];
  const out: ColumnSummary[] = [];
  for (const [name, values] of Object.entries(table.columns)) {
    if (name === table.key || !Array.isArray(values)) continue;
    const kind = columnKind(values);
    let missing = 0;
    for (const v of values) if (v === null || v === undefined) missing++;
    out.push({ name, kind, distinct: categoriesOf(values).length, range: kind === "number" ? numericExtent(values) : null, missing });
  }
  return out;
}

/** A numeric column's distribution in `bins` equal bins over its extent (the board draws it under the range handles). */
export function columnHistogram(values: readonly unknown[], bins = 48): { lo: number; hi: number; counts: number[] } | null {
  const ext = numericExtent(values);
  if (!ext) return null;
  const lo = ext[0], hi = ext[1] > ext[0] ? ext[1] : ext[0] + 1;
  const counts = new Array<number>(bins).fill(0), k = bins / (hi - lo);
  for (const v of values) if (finite(v)) counts[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) * k)))]++;
  return { lo, hi, counts };
}

// --- the colour law -----------------------------------------------------------------------------------------

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");
/** The colour of slot `slot` of a 256-entry RGBA table, as `#rrggbb` (the alpha of a map entry is not an object's). */
export const slotColor = (table: Uint8Array, slot: number): string => `#${hex2(table[slot * 4])}${hex2(table[slot * 4 + 1])}${hex2(table[slot * 4 + 2])}`;

/** x in [0, 1] for a value over a range; a degenerate range is the middle. */
export function normalizeOver(range: readonly [number, number], v: number): number {
  if (!(range[1] > range[0])) return 0.5;
  return normalizeValue(makeNormalizer(range, "linear"), v);
}

/** The colour of a numeric value under a map (THE channel law; `reverse` = the channel's `invert`). */
export function numberColor(table: Uint8Array, range: readonly [number, number], v: number): string {
  return slotColor(table, slotOf(normalizeOver(range, v)));
}

/** A map's 256 colours as a table, through the same function a channel's pixels use. */
export function styleTable(lut: string, reverse: boolean, resolveLut: (name: string) => string[] | null): Uint8Array {
  return channelTable({ color: null, lut, invert: reverse }, resolveLut);
}

// --- the result ---------------------------------------------------------------------------------------------

export interface ObjectStyle { color?: string; opacity?: number; hidden?: boolean }
export interface CategoryEntry { label: string; color: string; count: number; keys: string[] }
export interface ObjectLegend {
  /** What the colours mean, or null when the layer is not coloured by a column. */
  color:
    | { kind: "category"; column: string; entries: CategoryEntry[] }
    | { kind: "number"; column: string; lut: string; reverse: boolean; range: [number, number]; stops: string[] }
    | null;
  /** What the opacities mean, or null. */
  opacity: { column: string; range: [number, number]; to: [number, number] } | null;
  /** Objects without a value in a styling column. */
  missing: { mode: "dim" | "hide"; color: string; opacity: number; count: number; keys: string[] } | null;
}
export interface ObjectStyles { byKey: Map<string, ObjectStyle>; legend: ObjectLegend | null; issues: string[] }

const EMPTY: ObjectStyles = Object.freeze({ byKey: new Map(), legend: null, issues: [] }) as ObjectStyles;

function columnList(table: FluximgTable): string {
  const names = Object.keys(table.columns).filter((c) => c !== table.key);
  return names.length ? names.map((c) => `"${c}"`).join(", ") : "(none)";
}

/**
 * Every object's style from its row. `layerKey` is the layer's key column (the column whose text is each shape's
 * `data-key`); the table's own `key` is used when the layer names none or a column it does not have. Objects are
 * the table's rows: a shape without a row has no value and is drawn by `missing` by its caller (`layerMarkup`
 * treats a key absent from `byKey` as unstyled, so the missing style is listed here for every row with a null).
 */
export function objectStyles(table: FluximgTable | null | undefined, layerKey: string | null | undefined, styleBy: FluximgStyleBy | null | undefined, resolveLut: (name: string) => string[] | null): ObjectStyles {
  if (!styleBy || (!styleBy.color && !styleBy.opacity)) return EMPTY;
  if (!table || !table.columns || typeof table.columns !== "object") return { byKey: new Map(), legend: null, issues: ["the layer's table is not available"] };
  const keyName = layerKey && Array.isArray(table.columns[layerKey]) ? layerKey : table.key;
  const keyCol = table.columns[keyName];
  if (!Array.isArray(keyCol)) return { byKey: new Map(), legend: null, issues: [`the table has no key column "${keyName}"`] };
  const n = keyCol.length, issues: string[] = [];
  const keys = keyCol.map((v) => String(v));
  const mode: "dim" | "hide" = styleBy.missing === "hide" ? "hide" : "dim";

  // Colour: one colour (or "missing") per row.
  let colorOf: Array<string | null> | null = null, colorLegend: ObjectLegend["color"] = null;
  const c = styleBy.color;
  if (c && typeof c.column === "string") {
    const values = table.columns[c.column];
    if (!Array.isArray(values)) issues.push(`colour: no column "${c.column}" in the table (it has ${columnList(table)})`);
    else {
      const kind = columnKind(values);
      const palette = Array.isArray(c.palette) ? c.palette.filter(isColor).map((x) => x.toLowerCase()) : [];
      const categorical = kind === "category" || (kind === "number" && palette.length > 0 && !c.lut);
      colorOf = new Array<string | null>(n).fill(null);
      if (kind === "empty") issues.push(`colour: column "${c.column}" has no values`);
      else if (categorical) {
        const pal = palette.length ? palette : DEFAULT_PALETTE.slice();
        const cats = categoriesOf(values);
        const index = new Map(cats.map((v, i) => [cellId(v), i]));
        const entries: CategoryEntry[] = cats.map((v, i) => ({ label: cellLabel(v), color: pal[i % pal.length], count: 0, keys: [] }));
        for (let r = 0; r < n; r++) {
          const v = values[r];
          if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) continue;
          const i = index.get(cellId(v as Exclude<Cell, null>));
          if (i === undefined) continue;
          colorOf[r] = entries[i].color;
          entries[i].count++;
          entries[i].keys.push(keys[r]);
        }
        colorLegend = { kind: "category", column: c.column, entries };
      } else {
        const lut = typeof c.lut === "string" && c.lut ? c.lut : DEFAULT_STYLE_LUT;
        const reverse = c.reverse === true;
        const ext = numericExtent(values)!;
        const range: [number, number] = Array.isArray(c.range) && finite(c.range[0]) && finite(c.range[1]) && c.range[1] > c.range[0] ? [c.range[0], c.range[1]] : [ext[0], ext[1]];
        const t = styleTable(lut, reverse, resolveLut);
        for (let r = 0; r < n; r++) { const v = values[r]; if (finite(v)) colorOf[r] = numberColor(t, range, v); }
        const stops = Array.from({ length: 9 }, (_, i) => slotColor(t, Math.min(255, Math.round((i / 8) * 255))));
        colorLegend = { kind: "number", column: c.column, lut, reverse, range, stops };
      }
    }
  }

  // Opacity: a number (or "missing") per row.
  let opacityOf: Array<number | null> | null = null, opacityLegend: ObjectLegend["opacity"] = null;
  const o = styleBy.opacity;
  if (o && typeof o.column === "string") {
    const values = table.columns[o.column];
    if (!Array.isArray(values)) issues.push(`opacity: no column "${o.column}" in the table (it has ${columnList(table)})`);
    else if (columnKind(values) !== "number") issues.push(`opacity: column "${o.column}" is not numeric (opacity needs numbers)`);
    else {
      const ext = numericExtent(values)!;
      const range: [number, number] = Array.isArray(o.range) && finite(o.range[0]) && finite(o.range[1]) && o.range[1] > o.range[0] ? [o.range[0], o.range[1]] : [ext[0], ext[1]];
      const to: [number, number] = Array.isArray(o.to) && finite(o.to[0]) && finite(o.to[1]) ? [clamp01(o.to[0]), clamp01(o.to[1])] : [DEFAULT_OPACITY_TO[0], DEFAULT_OPACITY_TO[1]];
      opacityOf = new Array<number | null>(n).fill(null);
      for (let r = 0; r < n; r++) {
        const v = values[r];
        if (!finite(v)) continue;
        const x = range[1] > range[0] ? Math.min(1, Math.max(0, (v - range[0]) / (range[1] - range[0]))) : 0.5;
        opacityOf[r] = round4(to[0] + (to[1] - to[0]) * x);
      }
      opacityLegend = { column: o.column, range, to };
    }
  }

  if (!colorOf && !opacityOf) return { byKey: new Map(), legend: null, issues };
  const byKey = new Map<string, ObjectStyle>();
  const missingKeys: string[] = [];
  for (let r = 0; r < n; r++) {
    const col = colorOf ? colorOf[r] : undefined, op = opacityOf ? opacityOf[r] : undefined;
    if (col === null || op === null) {
      missingKeys.push(keys[r]);
      byKey.set(keys[r], mode === "hide" ? { hidden: true } : { color: DIM_COLOR, opacity: DIM_OPACITY });
      continue;
    }
    const s: ObjectStyle = {};
    if (col !== undefined) s.color = col;
    if (op !== undefined) s.opacity = op;
    byKey.set(keys[r], s);
  }
  const legend: ObjectLegend = {
    color: colorLegend, opacity: opacityLegend,
    missing: missingKeys.length ? { mode, color: DIM_COLOR, opacity: DIM_OPACITY, count: missingKeys.length, keys: missingKeys } : null,
  };
  return { byKey, legend, issues };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** The style a shape gets when its key has no row in the table (it has no value in any column). */
export function missingStyle(styleBy: FluximgStyleBy | null | undefined): ObjectStyle | null {
  if (!styleBy || (!styleBy.color && !styleBy.opacity)) return null;
  return styleBy.missing === "hide" ? { hidden: true } : { color: DIM_COLOR, opacity: DIM_OPACITY };
}

// --- a cache: one computation per (table, request, colour maps loaded) ----------------------------------------

const memo = new WeakMap<object, Map<string, ObjectStyles>>();
/**
 * `objectStyles`, remembered per table OBJECT and request: the editor's memoised layer markup, the live overlay, the
 * key and the board all ask for the same styles of the same table, and a plane step must not recompute them.
 * Whether the colour map is loaded is part of the request (before it is, a numeric column is gray).
 */
export function cachedObjectStyles(table: FluximgTable | null | undefined, layerKey: string | null | undefined, styleBy: FluximgStyleBy | null | undefined, resolveLut: (name: string) => string[] | null): ObjectStyles {
  if (!styleBy || (!styleBy.color && !styleBy.opacity)) return EMPTY;
  if (!table) return objectStyles(table, layerKey, styleBy, resolveLut);
  const lut = styleBy.color ? (typeof styleBy.color.lut === "string" && styleBy.color.lut ? styleBy.color.lut : DEFAULT_STYLE_LUT) : "";
  const sig = `${layerKey ?? ""}|${JSON.stringify(styleBy)}|${lut && resolveLut(lut) ? 1 : 0}`;
  let per = memo.get(table);
  if (!per) { per = new Map(); memo.set(table, per); }
  let hit = per.get(sig);
  if (!hit) {
    hit = objectStyles(table, layerKey, styleBy, resolveLut);
    per.set(sig, hit);
    if (per.size > 32) per.delete(per.keys().next().value as string);
  }
  return hit;
}

/** "footprints coloured by dendrite", "… faded by distance": what a styled layer shows, in words. */
export function describeStyleBy(layerName: string, styleBy: FluximgStyleBy | null | undefined): string {
  if (!styleBy) return "";
  const parts: string[] = [];
  if (styleBy.color?.column) parts.push(`coloured by ${styleBy.color.column}`);
  if (styleBy.opacity?.column) parts.push(`opacity by ${styleBy.opacity.column}`);
  if (!parts.length) return "";
  return `${layerName} ${parts.join(", ")}${styleBy.missing === "hide" ? " (objects without a value hidden)" : ""}`;
}
