// What the Cascade pop-up SHOWS of a cascade (2026-11-20 redesign): the ladder, what each rank gets, written from
// the same law the core applies (cascade.ts `stepOf`). Pure: the pop-up and its gate read the same answers.
import { stepOf } from "../cascade";

export interface LadderSpec {
  mode: "add" | "mul";
  delta: number;
  factor: number;
  /** Per-step OKLCh shift, for a colour property (the mode is then ignored). */
  color?: { dL: number; dC: number; dH: number } | null;
  firstFixed: boolean;
}
export interface Rung {
  /** 0-based rank in the cascade's order. */
  rank: number;
  text: string;
  /** This unit keeps the value it has. */
  still: boolean;
}

const mag = (v: number): string => String(+Math.abs(v).toFixed(3));
/** A signed offset: "+25", "−0.15", and a plain "0" for none (U+2212, the minus of a number). */
export const signed = (v: number, unit = ""): string => (+v.toFixed(3) === 0 ? "0" : (v > 0 ? "+" : "−") + mag(v) + unit);

/** What the unit at `rank` gets. */
export function cascadeRung(spec: LadderSpec, rank: number): Rung {
  const step = stepOf(rank, spec.firstFixed);
  if (spec.color) {
    const parts = ([["dL", ""], ["dC", ""], ["dH", "°"]] as const).filter(([k]) => +spec.color![k]);
    if (!parts.length || !step) return { rank, text: "0", still: true };
    // One component: its shift. Several: how many steps this unit takes (three numbers a unit would not be read).
    if (parts.length === 1) return { rank, text: signed(+spec.color[parts[0][0]] * step, parts[0][1]), still: false };
    return { rank, text: `${step}×`, still: false };
  }
  if (spec.mode === "mul") {
    const f = spec.factor > 0 ? spec.factor ** step : NaN;
    return { rank, text: Number.isFinite(f) ? `×${+f.toPrecision(3)}` : "×?", still: f === 1 };
  }
  const d = (+spec.delta || 0) * step;
  return { rank, text: signed(d), still: +d.toFixed(3) === 0 };
}

/** The rungs shown for `count` units: every one while they fit, else the first few, a gap (null) and the last. */
export function cascadeLadder(spec: LadderSpec, count: number, max = 6): (Rung | null)[] {
  const n = Math.max(0, Math.floor(count));
  if (n <= max) return Array.from({ length: n }, (_, k) => cascadeRung(spec, k));
  return [...Array.from({ length: max - 2 }, (_, k) => cascadeRung(spec, k)), null, cascadeRung(spec, n - 1)];
}

/** The unit a property's label names in its parenthesis ("Rotation (°)" → "°"), for the value beside it. A "×"
 *  (zoom) is left unsaid: beside the add | multiply switch it would read as the other mode. */
export function unitOfLabel(label: string): string {
  const u = label.match(/\(([^)]+)\)\s*$/)?.[1] ?? "";
  return u === "\u00d7" ? "" : u;
}
