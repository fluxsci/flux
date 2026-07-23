// ---------------------------------------------------------------------------
// Cascade — pure core (twin-engine shared, guide §2). A cascade applies a
// stepped delta across an ordered multi-selection: the unit at rank k gets
// `value ⊕ delta·step_k`, where step_k = k when "first stays fixed" is on,
// else k+1 (0-indexed ranks). This module owns the math, the unit/order
// resolution, and the property metadata; the mutations live in ops.ts
// (cascadeElements) and slide/ops.ts (cascadeTracks) so both engines run the
// exact same logic. No DOM, no Svelte, no Node.
// ---------------------------------------------------------------------------

import type { Element, Figure, Id } from "./types";
import { unitKeyOf } from "./groups";
import { selectionBBox } from "./geometry";
import type { OklchDelta } from "./color/interp";

export const ELEMENT_CASCADE_PROPS = [
  "x",
  "y",
  "rotation",
  "opacity",
  "width",
  "height",
  "strokeWidth",
  "cornerRadius",
  "fontSize",
  "fill",
  "stroke",
  "color",
] as const;
export type ElementCascadeProp = (typeof ELEMENT_CASCADE_PROPS)[number];

export const TRACK_CASCADE_PROPS = ["start", "duration", "influence.in", "influence.out", "stagger.perMs"] as const;
export type TrackCascadeProp = (typeof TRACK_CASCADE_PROPS)[number];

export type CascadeMode = "add" | "mul";
export type CascadeOrder = "selection" | "layer" | "x" | "y";

export interface CascadeSpec {
  property: ElementCascadeProp;
  /** Numeric mode; ignored for color props. Default "add". */
  mode?: CascadeMode;
  /** add: value + delta·step. fontSize deltas are in PT (converted ×4/3). */
  delta?: number;
  /** mul: value · factor^step. Must be > 0. */
  factor?: number;
  /** Color props: per-step OKLCh shift. */
  color?: OklchDelta;
  /** Default "selection" = the given id order. */
  order?: CascadeOrder;
  reverse?: boolean;
  /** Default false: every unit steps (first gets 1·delta). */
  firstFixed?: boolean;
}

export interface TrackCascadeSpec {
  property: TrackCascadeProp;
  mode?: CascadeMode;
  delta?: number;
  factor?: number;
  /** "timeline" (beat index, then lane index — default) or "list" (given order). */
  order?: "timeline" | "list";
  reverse?: boolean;
  firstFixed?: boolean;
}

/** The rank→multiplier law. firstFixed pins rank 0 at zero delta. */
export function stepOf(rank: number, firstFixed: boolean | undefined): number {
  return firstFixed ? rank : rank + 1;
}

/** Numeric target for one step. Throws on a non-positive mul factor (verbs
 *  surface it; the popover prevents it with an input floor). */
export function cascadeValue(base: number, spec: { mode?: CascadeMode; delta?: number; factor?: number }, step: number): number {
  if (spec.mode === "mul") {
    const f = spec.factor;
    if (!(typeof f === "number" && f > 0)) throw new Error("cascade: multiplicative factor must be > 0");
    return base * Math.pow(f, step);
  }
  return base + (spec.delta ?? 0) * step;
}

// --- units -------------------------------------------------------------------

/** One cascade rank: a whole top-level group (rigid), or a loose element. */
export interface CascadeUnit {
  key: string;
  els: Element[];
}

/** Decompose ids into selection units in FIRST-APPEARANCE order of `ids`
 *  (the selection Set iterates in insertion order, so this is click order for
 *  shift-click-built selections). Unit identity is the canonical
 *  `groups.unitKeyOf` (top-level group / dangling-group flat unit / the
 *  element itself). Ids missing from the figure are skipped. */
export function cascadeUnits(fig: Figure, ids: Id[]): CascadeUnit[] {
  const byId = new Map<Id, Element>();
  for (const e of fig.elements) byId.set(e.id, e);
  const units = new Map<string, Element[]>();
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue;
    const key = unitKeyOf(fig, e);
    const arr = units.get(key);
    if (arr) {
      if (!arr.includes(e)) arr.push(e);
    } else units.set(key, [e]);
  }
  return [...units.entries()].map(([key, els]) => ({ key, els }));
}

/** Order units for ranking. "selection" keeps the given (first-appearance)
 *  order; "layer" sorts by each unit's topmost z (min elements[] index);
 *  "x"/"y" sort by unit bbox center (layer tie-break). `reverse` flips the
 *  final order. Callers order AFTER restoring baselines, so spatial keys are
 *  stable across live re-previews of an x/y cascade. */
export function orderUnits(units: CascadeUnit[], fig: Figure, order: CascadeOrder | undefined, reverse: boolean | undefined): CascadeUnit[] {
  const zIndex = new Map<Id, number>();
  fig.elements.forEach((e, i) => zIndex.set(e.id, i));
  const minZ = (u: CascadeUnit) => Math.min(...u.els.map((e) => zIndex.get(e.id) ?? 0));
  let out = [...units];
  if (order === "layer") {
    out.sort((a, b) => minZ(a) - minZ(b));
  } else if (order === "x" || order === "y") {
    const center = (u: CascadeUnit) => {
      const b = selectionBBox(u.els);
      if (!b) return 0;
      return order === "x" ? b.x + b.w / 2 : b.y + b.h / 2;
    };
    const keyed = out.map((u) => ({ u, c: center(u), z: minZ(u) }));
    keyed.sort((a, b) => a.c - b.c || a.z - b.z);
    out = keyed.map((k) => k.u);
  }
  if (reverse) out.reverse();
  return out;
}

// --- element property metadata -------------------------------------------------

/** fontSize is edited in pt everywhere (Inspector convention); the model
 *  stores canvas px = pt·4/3. Cascade add-deltas for fontSize are given in pt. */
export const PT_TO_PX = 4 / 3;

const STROKED = new Set(["line", "rect", "ellipse", "path"]);
/** Types whose W/H edits go through ops.setBoxDim safely. `path` and `line` are
 *  EXCLUDED: setBoxDim writes the box only and nothing remaps a path's `d`/nodes
 *  or a line's endpoints, so a W/H edit would desync the rendered geometry from
 *  its box. This is the ONE source of truth — the cascade, the Inspector W/H
 *  fields, and the FluxFig-menu W/H keys all gate on `supportsBoxDim`. */
const BOX_DIM = new Set(["rect", "ellipse", "image", "plot", "text"]);
export function supportsBoxDim(type: string): boolean {
  return BOX_DIM.has(type);
}

export function isColorProp(prop: ElementCascadeProp): prop is "fill" | "stroke" | "color" {
  return prop === "fill" || prop === "stroke" || prop === "color";
}

/** Can this MEMBER element carry the property? (Style props on a group unit
 *  apply to the accepting members only — f-menu union-by-presence semantics.) */
export function memberAccepts(e: Element, prop: ElementCascadeProp): boolean {
  switch (prop) {
    case "x":
    case "y":
    case "rotation":
    case "opacity":
      return true;
    case "width":
    case "height":
      return BOX_DIM.has(e.type);
    case "strokeWidth":
      return STROKED.has(e.type);
    case "cornerRadius":
      return e.type === "rect" || e.type === "path";
    case "fontSize":
    case "color":
      return e.type === "text";
    case "fill":
      return e.type === "rect" || e.type === "ellipse" || e.type === "path";
    case "stroke":
      return STROKED.has(e.type);
  }
}

/** Can this UNIT consume a rank for the property? Units that don't accept are
 *  excluded BEFORE ranking (they never consume a step). W/H additionally
 *  require a single-element unit — a group's box resize is a scale gesture,
 *  not a member-box write. */
export function unitAccepts(u: CascadeUnit, prop: ElementCascadeProp): boolean {
  if (prop === "width" || prop === "height") return u.els.length === 1 && memberAccepts(u.els[0], prop);
  return u.els.some((e) => memberAccepts(e, prop));
}

/** Post-math clamp per property (model units). */
export function clampElementValue(prop: ElementCascadeProp, v: number): number {
  switch (prop) {
    case "opacity":
      return Math.min(1, Math.max(0, v));
    case "strokeWidth":
    case "cornerRadius":
      return Math.max(0, v);
    case "width":
    case "height":
      return Math.max(1, v);
    case "fontSize":
      return Math.max(PT_TO_PX, v); // ≥ 1pt, in stored px
    default:
      return v;
  }
}

// --- track property metadata ----------------------------------------------------

/** Track-side clamps (ms / percent), matching the animator's own edit floors
 *  (trackActions.nudgeSelected: start ≥ 0, duration ≥ 50). */
export function clampTrackValue(prop: TrackCascadeProp, v: number): number {
  switch (prop) {
    case "start":
    case "stagger.perMs":
      return Math.max(0, v);
    case "duration":
      return Math.max(50, v);
    case "influence.in":
    case "influence.out":
      return Math.min(100, Math.max(0, v));
  }
}

// --- popover ↔ track-flavor seam -------------------------------------------------

/** The slide animator injects this into CascadePopover so the one component
 *  serves both flavors without src/lib importing mode code (bundle rule §9). */
export interface TrackCascadeAdapter {
  /** Ordered-track count + per-property applicable counts ("n of m apply"). */
  info(): { total: number; applies: Record<TrackCascadeProp, number> };
  begin(): void;
  preview(spec: TrackCascadeSpec): void;
  /** Keep the previewed result (already one coalesced undo step). */
  commit(): void;
  /** Revert everything the session previewed. */
  cancel(): void;
}
