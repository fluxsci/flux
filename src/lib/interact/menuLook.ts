// How the property menu (F) LAYS OUT and DRAWS the fields of interact/propertyMenu.ts (2026-11-20 redesign).
// The field model says what a property IS; this says how the menu shows it: which properties stand as a row,
// which pair up, which are small keys on their group's head, and which instrument draws a number. Pure (no DOM,
// no stores): the menu component and its gate read the same answers.

/** The part of a Field this module reads (structural, so nothing here imports the field model's stores). */
export interface LookField {
  key: string;
  label: string;
  group: string;
  kind: string;
  /** The numeric property behind the field ("rotation", "fillOpacity" …), when it has one. */
  prop?: string;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
}

/** What draws a number beside its value. Each one draws the property it sets. */
export type Instrument = "fader" | "dial" | "corner" | "weight" | "track";

const OPACITIES = new Set(["opacity", "fillOpacity", "strokeOpacity"]);
/** Whole-turn angles: a hand on a dial. (Elevation and field of view are not whole turns: they keep a track.) */
const TURNS = new Set(["rotation", "orbitAzimuth", "orbitRoll"]);

export function rangeOf(f: LookField): { min: number; max: number } | null {
  if (f.kind !== "number") return null;
  const min = f.min ?? f.softMin, max = f.max ?? f.softMax;
  return min == null || max == null || !(max > min) ? null : { min, max };
}

export function instrumentOf(f: LookField): Instrument | null {
  if (f.kind !== "number") return null;
  if (f.prop && OPACITIES.has(f.prop)) return "fader";
  if (f.prop && TURNS.has(f.prop)) return "dial";
  if (f.prop === "cornerRadius") return "corner";
  if (f.prop === "strokeWidth") return "weight";
  return rangeOf(f) ? "track" : null;
}

/** The geometric properties the canvas can measure on the object itself while their row is in hand. */
export type MeasureProp = "x" | "y" | "width" | "height" | "rotation" | "cornerRadius";
const MEASURED = new Set<string>(["x", "y", "width", "height", "rotation", "cornerRadius"]);
export const measureOf = (f: LookField | null | undefined): MeasureProp | null => (f?.kind === "number" && f.prop && MEASURED.has(f.prop) ? (f.prop as MeasureProp) : null);

/** A number as the menu shows it at rest: two decimals. (In hand, a row shows and steps its exact value.) */
export function shortNum(v: number): string {
  return Number.isFinite(v) ? String(+v.toFixed(2)) : "0";
}

/** The value at a fraction of a field's range: the inverse of numericStep.numericFraction, on the field's step. */
export function valueAtFraction(t: number, min: number, max: number, step = 1, factor?: number): number {
  const u = Math.max(0, Math.min(1, t));
  if (factor && min > 0 && max > min) return +(min * (max / min) ** u).toPrecision(4);
  const raw = min + (max - min) * u, s = step > 0 ? step : 1;
  return +Math.max(min, Math.min(max, Math.round(raw / s) * s)).toFixed(6);
}

// --- glyphs (16 × 16, drawn with the current colour; `.f` = filled) ------------------------------------------------
export const MENU_GLYPHS = {
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.6 13.6"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  back: '<path d="M9.6 3.6 5.2 8l4.4 4.4"/>',
  go: '<path d="M6 3.6 10.4 8 6 12.4"/>',
  lock: '<rect x="3.6" y="7.4" width="8.8" height="6.2" rx="1.6"/><path d="M5.6 7.4V5.3a2.4 2.4 0 0 1 4.8 0v2.1"/>',
  // "no X" draws X struck out: the fill is a solid square, the stroke an outline
  nofill: '<path class="f" d="M3.4 3.4h7.3L3.4 10.7zM12.6 12.6H5.3l7.3-7.3z"/><path d="M2.4 13.6 13.6 2.4"/>',
  nostroke: '<rect x="3.3" y="3.3" width="9.4" height="9.4" rx="1.4" stroke-width="1.7"/><path d="M2.2 13.8 13.8 2.2"/>',
  dashed: '<path d="M1.8 8h3M6.5 8h3M11.2 8h3"/>',
  arrowStart: '<path d="M13.5 8H3M6.6 4.4 3 8l3.6 3.6"/>',
  arrowEnd: '<path d="M2.5 8H13M9.4 4.4 13 8l-3.6 3.6"/>',
  panelLabel: '<path d="M4.6 12.6 8 3.4l3.4 9.2M5.9 9.4h4.2" stroke-width="1.7"/>',
  italic: '<path d="M10.6 3.4H6.8M9.2 12.6H5.4M9.1 3.4 6.9 12.6"/>',
  underline: '<path d="M5 3.4v4.3a3 3 0 0 0 6 0V3.4M4.2 13.2h7.6"/>',
  visible: '<path d="M1.6 8s2.4-4.1 6.4-4.1S14.4 8 14.4 8s-2.4 4.1-6.4 4.1S1.6 8 1.6 8z"/><circle class="f" cx="8" cy="8" r="1.9"/>',
  preset: '<path d="M4.4 2.6h7.2v10.9L8 10.9l-3.6 2.6z"/>',
  crop: '<path d="M4.6 1.8v9.6h9.6M1.8 4.6h9.6v9.6"/>',
  copy: '<rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.4"/><path d="M3 10.2V3.6A.8.8 0 0 1 3.8 2.8h6.6"/>',
  chevron: '<path d="M4.4 6.2 8 9.8l3.6-3.6"/>',
} as const;
export type MenuGlyph = keyof typeof MENU_GLYPHS;

const TOGGLE_GLYPH: Record<string, MenuGlyph> = {
  "lock aspect ratio": "lock",
  "no fill (outline only)": "nofill",
  "no stroke": "nostroke",
  "dashed stroke": "dashed",
  "arrow start": "arrowStart",
  "arrow end": "arrowEnd",
  "panel label": "panelLabel",
  italic: "italic",
  underline: "underline",
  visible: "visible",
};
/** The mark of an on/off property; null when it has none of its own (the key then carries a word). */
export const toggleGlyph = (label: string): MenuGlyph | null => TOGGLE_GLYPH[label] ?? null;
/** The mark of a "run this" row. */
export function actionGlyph(label: string): MenuGlyph {
  if (/preset/i.test(label)) return "preset";
  if (/^reset crop/i.test(label)) return "crop";
  if (/^copy /i.test(label)) return "copy";
  return "go";
}
/** The word on a key that has no mark: the label without a parenthetical, at most two words. */
export const toggleWord = (label: string): string => label.replace(/\s*\(.*\)\s*$/, "").split(/\s+/).slice(0, 2).join(" ");

// --- layout ------------------------------------------------------------------------------------------------------
export interface RowLook<F extends LookField> {
  f: F;
  /** 0 = a full row; 1 / 2 = the left / right cell of a pair. */
  half: 0 | 1 | 2;
  /** In a pair, the leading word of the label that stays visible ("x" of "x position"); the rest is still there to read. */
  lead?: string;
}
export interface GroupLook<F extends LookField> {
  name: string;
  /** The on/off properties: small keys on the group's head. */
  keys: F[];
  rows: RowLook<F>[];
  /** A group that is one "run this" row and nothing else stands without a head. */
  bare: boolean;
}

/** Position with its size beside it: x | width over y | height (or x | y when the selection has no box). */
function pairUp<F extends LookField>(rows: F[]): RowLook<F>[] {
  const by = (p: string) => rows.find((f) => f.kind === "number" && f.prop === p);
  const x = by("x"), y = by("y"), w = by("width"), h = by("height");
  const cell = (f: F, half: 1 | 2): RowLook<F> => ({ f, half, lead: f.prop === "x" || f.prop === "y" ? f.label.split(" ")[0] : undefined });
  let paired: RowLook<F>[] = [];
  if (x && y && w && h) paired = [cell(x, 1), cell(w, 2), cell(y, 1), cell(h, 2)];
  else if (x && y) paired = [cell(x, 1), cell(y, 2)];
  else if (w && h) paired = [cell(w, 1), cell(h, 2)];
  if (!paired.length) return rows.map((f) => ({ f, half: 0 }));
  const taken = new Set(paired.map((r) => r.f));
  const first = rows.findIndex((f) => taken.has(f));
  const rest = rows.filter((f) => !taken.has(f)).map((f): RowLook<F> => ({ f, half: 0 }));
  // The pairs stand where the first of them stood.
  const before = rows.slice(0, first).filter((f) => !taken.has(f)).length;
  return [...rest.slice(0, before), ...paired, ...rest.slice(before)];
}

export function looksOf<F extends LookField>(groups: { name: string; fields: F[] }[]): GroupLook<F>[] {
  return groups.map((g) => {
    const keys = g.fields.filter((f) => f.kind === "toggle"), rows = g.fields.filter((f) => f.kind !== "toggle");
    return { name: g.name, keys, rows: pairUp(rows), bare: !keys.length && rows.length === 1 && rows[0].kind === "action" };
  });
}

/** Lines a layout takes: a head per group that has one, a line per row, half a line per paired cell. */
export function menuLines<F extends LookField>(looks: GroupLook<F>[]): number {
  let n = 0;
  for (const g of looks) n += (g.bare ? 0 : 1) + g.rows.filter((r) => !r.half).length + Math.ceil(g.rows.filter((r) => r.half).length / 2);
  return n;
}

/** Sizes the menu is built from (px). */
export const MENU = { row: 24, column: 264, gap: 4, pad: 4, chrome: 104, card: 12 } as const;
/** The menu's width for a number of columns. */
export const menuWidth = (cols: number): number => cols * MENU.column + (cols - 1) * MENU.gap + 2 * MENU.pad;

/** Columns: one while the lines fit it, more when there are many lines or the window is short; never more than
 *  the window's width holds. The menu grows sideways instead of scrolling. */
export function menuColumns(lines: number, groups: number, viewW: number, viewH: number): 1 | 2 | 3 {
  // `chrome`: the head at its tallest (two lines), the note a part can add, the foot and the plate's padding.
  const tall = lines * MENU.row + groups * MENU.card;
  const byCount = lines > 40 ? 3 : lines > 22 ? 2 : 1;
  const byHeight = Math.ceil(tall / Math.max(200, viewH - MENU.chrome - 16));
  const fit = viewW >= menuWidth(3) + 16 ? 3 : viewW >= menuWidth(2) + 16 ? 2 : 1;
  return Math.max(1, Math.min(fit, Math.max(byCount, byHeight), 3)) as 1 | 2 | 3;
}
