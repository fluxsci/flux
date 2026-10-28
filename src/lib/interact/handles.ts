// WS-3.2 (fortify plan): the ONE resize-handle vocabulary, shared by the
// figure Canvas and the slide Stage (they had drifted into byte-identical
// copies). Framework-free math/constants only — no Svelte, no DOM, no stores
// (the slide export runtime bundles through here).

import type { Rect } from "../geometry";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** The four drawn corner handles and the four edges (2026-10-21: edges are
 *  grabbable BANDS along their whole length, no longer knobs). */
export const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
export const EDGES: Handle[] = ["n", "e", "s", "w"];

export function handlePos(h: Handle, b: Rect): [number, number] {
  const map: Record<Handle, [number, number]> = {
    nw: [b.x, b.y],
    n: [b.x + b.w / 2, b.y],
    ne: [b.x + b.w, b.y],
    e: [b.x + b.w, b.y + b.h / 2],
    se: [b.x + b.w, b.y + b.h],
    s: [b.x + b.w / 2, b.y + b.h],
    sw: [b.x, b.y + b.h],
    w: [b.x, b.y + b.h / 2],
  };
  return map[h];
}

export const cursorFor: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

// --- the cursor each handle shows (2026-10-21) ---------------------------------
// The crosshair family (src/lib/cursor/cursorFamily.ts) draws the resize and
// rotate states as the crosshair's own arms changing form; these map a handle
// or rotate zone to the CSS variable that carries that state. `cursorFor` above
// keeps the OS names as the per-state fallbacks.

export type ResizeAxis = "ns" | "ew" | "nwse" | "nesw";

export function resizeAxisFor(h: Handle): ResizeAxis {
  switch (h) {
    case "n":
    case "s":
      return "ns";
    case "e":
    case "w":
      return "ew";
    case "nw":
    case "se":
      return "nwse";
    default:
      return "nesw";
  }
}

/** `var(--cursor-resize-<axis>[-tone])` for a handle. The bare name follows
 *  the surface through CSS inheritance; the HOST's gesture cursor names the
 *  tone it captured at the press (a `cursor` change on the host stops at the
 *  `.el` firewalls, a custom-property change there would not). */
export function resizeCursorVar(h: Handle, tone?: "light" | "dark"): string {
  return `var(--cursor-resize-${resizeAxisFor(h)}${tone ? `-${tone}` : ""})`;
}

export type RotateZone = "n" | "ne" | "se" | "sw" | "nw";
export const ROTATE_ZONES: RotateZone[] = ["ne", "se", "sw", "nw"];

/** `var(--cursor-rotate-<zone>[-tone])` for a rotate zone (the knob is `n`). */
export function rotateCursorVar(z: RotateZone, tone?: "light" | "dark"): string {
  return `var(--cursor-rotate-${z}${tone ? `-${tone}` : ""})`;
}

// --- the selection's hit zones (2026-10-21, owner: "the whole edge is the handle") ----
// Figma law: four corner handles; every EDGE is grabbable along its whole
// length for a one-axis resize; the region just OUTSIDE each corner rotates.
// Pure screen-px geometry so the Canvas renders exactly what this returns and
// the pure gate pins the precedence (corner > edge > rotate) by construction.

export interface ZoneOpts {
  /** Drawn corner handle size (screen px). */
  hs?: number;
  /** Corner hit square size (≥ hs), centred on the corner. */
  cornerHit?: number;
  /** Edge band reach OUTSIDE the box. */
  bandOut?: number;
  /** Edge band reach INSIDE the box (clamped to a quarter of the box side so a
   *  tiny selection keeps ≥ half of its interior for moving). Shallower than the
   *  outward reach on purpose: the object's own body near its edge stays a
   *  grab-and-move (a plot's margin, a photo's border), as in Figma. */
  bandIn?: number;
  /** Corner square reach INSIDE the box (same clamp and reason). */
  cornerIn?: number;
  /** Rotate zone reach beyond the corner hit square. */
  rotate?: number;
  /** Clip every zone to this rect (screen px): the figure's frame plus a small
   *  margin, so zones never cover chrome that lives outside it — the figure
   *  title bar above the frame, a neighbouring figure's frame bands. */
  clip?: Rect;
}

export const ZONE_DEFAULTS: Required<Omit<ZoneOpts, "clip">> = { hs: 9, cornerHit: 13, bandOut: 6, bandIn: 4, cornerIn: 4, rotate: 16 };
/** Below this screen size on an axis, every zone on that axis reaches OUTSIDE
 *  the box only (the frame's own rule): a 10 px label, a 2 px scale bar and a
 *  zero-height row of lines keep their whole body as the move area. */
export const ZONE_SMALL_SIDE = 24;

export type HitZone =
  | { kind: "corner"; handle: Handle; rect: Rect }
  | { kind: "edge"; handle: Handle; rect: Rect }
  | { kind: "rotate"; zone: RotateZone; rect: Rect };

/** The zones for a selection box in SCREEN px, in paint order: rotate zones,
 *  then edge bands, then corner squares — so a later (topmost) zone wins where
 *  two overlap, which is the precedence corner > edge > rotate. Edge bands run
 *  only BETWEEN the corner squares; a box too short for two corner squares gets
 *  no band on that pair of edges (its corners still resize both axes). */
export function selectionHitZones(box: Rect, opts: ZoneOpts = {}): HitZone[] {
  const o = { ...ZONE_DEFAULTS, ...opts };
  const ch = Math.max(o.hs, o.cornerHit);
  const half = ch / 2;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const out: HitZone[] = [];
  // rotate: the L outside each corner, from the corner square's outer edges out by `rotate`
  const R = o.rotate;
  const cornerPos: Record<RotateZone, [number, number] | null> = {
    nw: [box.x, box.y],
    ne: [right, box.y],
    se: [right, bottom],
    sw: [box.x, bottom],
    n: null,
  };
  for (const z of ROTATE_ZONES) {
    const [cx, cy] = cornerPos[z]!;
    const sx = z.includes("w") ? -1 : 1; // which side of the corner the zone lies on, horizontally
    const sy = z.includes("n") ? -1 : 1;
    // one rect reaching diagonally outward: from the corner square's outer edge to R beyond it,
    // and along the box edge by `half` (so it never overlaps the edge bands)
    const x0 = sx < 0 ? cx - half - R : cx + half;
    const y0 = sy < 0 ? cy - half - R : cy + half;
    out.push({ kind: "rotate", zone: z, rect: { x: x0, y: y0, w: R, h: R } });
    // the two arms of the L along the edges, outside the band's outer reach
    out.push({ kind: "rotate", zone: z, rect: { x: x0, y: sy < 0 ? cy - half : cy - half, w: R, h: ch } });
    out.push({ kind: "rotate", zone: z, rect: { x: sx < 0 ? cx - half : cx - half, y: y0, w: ch, h: R } });
  }
  // Inward reach: a quarter of the side, capped, and NONE on a small side
  // (ZONE_SMALL_SIDE) — the body of a thin object is all move area.
  const cInX = box.w < ZONE_SMALL_SIDE ? 0 : Math.min(o.cornerIn, half, box.w / 4);
  const cInY = box.h < ZONE_SMALL_SIDE ? 0 : Math.min(o.cornerIn, half, box.h / 4);
  const inX = box.w < ZONE_SMALL_SIDE ? 0 : Math.min(o.bandIn, box.w / 4);
  const inY = box.h < ZONE_SMALL_SIDE ? 0 : Math.min(o.bandIn, box.h / 4);
  // edge bands: along an edge only when the box is at least two outer reaches
  // deep ACROSS it (a zero-height row of lines or a 2 px scale bar would
  // otherwise have its whole stroke under the n/s bands and could never be
  // moved — and a 10 px label must not be height-resized by accident), and
  // when some length is left between the corner squares' INWARD extents (the
  // squares, painted last, win their own area, so there is no dead strip at a
  // square's foot). A one-line text (≈20 px tall) therefore keeps its e/w
  // bands — dragging a label's edge to make it wrap is the everyday case.
  if (box.h >= 2 * o.bandOut && box.w - 2 * cInX > 0) {
    out.push({ kind: "edge", handle: "n", rect: { x: box.x + cInX, y: box.y - o.bandOut, w: box.w - 2 * cInX, h: o.bandOut + inY } });
    out.push({ kind: "edge", handle: "s", rect: { x: box.x + cInX, y: bottom - inY, w: box.w - 2 * cInX, h: o.bandOut + inY } });
  }
  if (box.w >= 2 * o.bandOut && box.h - 2 * cInY > 0) {
    out.push({ kind: "edge", handle: "w", rect: { x: box.x - o.bandOut, y: box.y + cInY, w: o.bandOut + inX, h: box.h - 2 * cInY } });
    out.push({ kind: "edge", handle: "e", rect: { x: right - inX, y: box.y + cInY, w: o.bandOut + inX, h: box.h - 2 * cInY } });
  }
  // corners last (topmost) — see below; the clip is applied to the whole list.
  // The square reaches `half` OUTWARD on both axes
  // but only cIn INWARD (none on a small side), so the body near a corner is
  // still a move and a tiny selection keeps its interior free; the squares
  // still resize both axes from outside.
  for (const h of CORNERS) {
    const [cx, cy] = handlePos(h, box);
    const x0 = h.includes("w") ? cx - half : cx - cInX;
    const y0 = h.includes("n") ? cy - half : cy - cInY;
    out.push({ kind: "corner", handle: h, rect: { x: x0, y: y0, w: half + cInX, h: half + cInY } });
  }
  return o.clip ? clipZones(out, o.clip) : out;
}

/** Intersect every zone with `clip`, dropping the empty ones (paint order kept). */
export function clipZones(zones: HitZone[], clip: Rect): HitZone[] {
  const out: HitZone[] = [];
  for (const z of zones) {
    const x0 = Math.max(z.rect.x, clip.x);
    const y0 = Math.max(z.rect.y, clip.y);
    const x1 = Math.min(z.rect.x + z.rect.w, clip.x + clip.w);
    const y1 = Math.min(z.rect.y + z.rect.h, clip.y + clip.h);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    out.push({ ...z, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } } as HitZone);
  }
  return out;
}

/** Keep handles outside the artwork frame, while reserving figure title bars
 * for moving the frame. Rectangle subtraction preserves all remaining reach. */
export function excludeZones(zones: HitZone[], avoid: readonly Rect[]): HitZone[] {
  for (const a of avoid) {
    const next: HitZone[] = [];
    for (const z of zones) {
      const r = z.rect, x0 = Math.max(r.x, a.x), y0 = Math.max(r.y, a.y);
      const x1 = Math.min(r.x+r.w, a.x+a.w), y1 = Math.min(r.y+r.h, a.y+a.h);
      if (x1 <= x0 || y1 <= y0) { next.push(z); continue; }
      const pieces = [
        { x: r.x, y: r.y, w: r.w, h: y0-r.y },
        { x: r.x, y: y1, w: r.w, h: r.y+r.h-y1 },
        { x: r.x, y: y0, w: x0-r.x, h: y1-y0 },
        { x: x1, y: y0, w: r.x+r.w-x1, h: y1-y0 },
      ];
      for (const rect of pieces) if (rect.w > 0 && rect.h > 0) next.push({ ...z, rect });
    }
    zones = next;
  }
  return zones;
}

/** The clip a figure gives its selection zones (screen px): the frame plus the
 *  bands' outer reach on three sides, but only `TITLEBAR_GAP` above the top —
 *  the figure title bar sits just above the frame and must stay clickable. */
export const ZONE_TITLEBAR_GAP = 3;
export function zoneClipForFrame(frame: Rect, opts: ZoneOpts = {}): Rect {
  const o = { ...ZONE_DEFAULTS, ...opts };
  const side = Math.max(o.bandOut, o.rotate);
  return { x: frame.x - side, y: frame.y - ZONE_TITLEBAR_GAP, w: frame.w + 2 * side, h: frame.h + side + ZONE_TITLEBAR_GAP };
}

/** Which zone a screen point hits, honouring paint order (last wins). */
export function hitZoneAt(zones: HitZone[], x: number, y: number): HitZone | null {
  for (let i = zones.length - 1; i >= 0; i--) {
    const r = zones[i].rect;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return zones[i];
  }
  return null;
}
