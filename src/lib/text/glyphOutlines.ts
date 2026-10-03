// ---------------------------------------------------------------------------
// Flux — GLYPH OUTLINES for text ↔ shape Becomes (oct2 W3 §3.2). Pure: given a
// text element, its browser-measured glyph positions (player/textMorph.ts
// measureTextChars) and a glyph source (glyphFont.ts in the GUI, the baked
// payload in an exported deck), produce STAGE outlines — one filled ring per
// connected letter part, placed at the measured baseline start of each
// character and scaled by fontSize / unitsPerEm — so the correspondence planner
// treats a word exactly like a set of drawn shapes: a rect splits and pours into
// the letters, the letters merge back into a rect.
//
// Counters (the holes in o, e, a, B) are KEYHOLED into their outer ring: a
// zero-width bridge joins each hole to its outline, wound opposite, so one ring
// draws the letter with its hole under the ordinary nonzero fill — the planner
// pairs whole letters, never a free-floating hole.
//
// No font, or a character the font lacks: GLYPH BOXES — one rounded rect per
// letter (its measured box, radius 25 % of its height) in the text colour, so a
// shape still splits into one piece per letter and lands on each; the caller
// crossfades to the live text over the final 15 % of raw progress.
// No opentype.js here: the exported runtime reads baked records through this.
// ---------------------------------------------------------------------------

import type { TextElement, VectorNode } from "../types";
import type { StageOutline } from "../slide/stageOutline";
import { pathToSubpaths, nodesExtent, reverseNodes } from "../path";
import { segmentRange, resolvedRunStyle, scriptMetrics } from "../textRuns";

/** One glyph: SVG path data in FONT UNITS, y-down, origin at the baseline start. */
export interface GlyphRecord { d: string; advance: number }
export interface GlyphSource {
  unitsPerEm: number;
  /** null for a character the font has no glyph for (.notdef). */
  glyph(ch: string): GlyphRecord | null;
}
/** What the export payload carries per font request key. */
export interface BakedGlyphFont { unitsPerEm: number; glyphs: Record<string, GlyphRecord> }

/** A baked record set as a source (the exported deck's runtime). */
export function bakedSource(baked: BakedGlyphFont): GlyphSource {
  return { unitsPerEm: baked.unitsPerEm, glyph: (ch) => baked.glyphs[ch] ?? null };
}

/** A measured glyph: baseline START point and extent box, stage px, unrotated frame. */
export interface MeasuredGlyph { x: number; y: number; box: { x: number; y: number; w: number; h: number } }

/** The font a character paints with. `family` is the element's CSS stack. */
export interface GlyphStyle { family: string; weight: number; style: "normal" | "italic" }

/** The full look of the character at text offset `at` (runs resolved). */
export function glyphStyleAt(el: TextElement, at: number): GlyphStyle & { size: number; color: string } {
  const seg = segmentRange(el.text, el.runs, at, at + 1)[0];
  const look = seg ? resolvedRunStyle(el, seg) : { fontWeight: el.fontWeight, fontStyle: el.fontStyle, color: undefined };
  const size = seg?.script ? scriptMetrics(seg.script, el.fontSize).size : el.fontSize;
  return { family: el.fontFamily, weight: Number(look.fontWeight) || 400, style: look.fontStyle === "italic" ? "italic" : "normal", size, color: look.color ?? el.color };
}

/** Every distinct font a text paints with, with the characters it paints — the
 *  preload list for the GUI and exactly what an export bakes. */
export function textGlyphNeeds(el: TextElement): { style: GlyphStyle; chars: string[] }[] {
  const by = new Map<string, { style: GlyphStyle; chars: Set<string> }>();
  for (let i = 0; i < el.text.length;) {
    const cp = el.text.codePointAt(i)!, ch = String.fromCodePoint(cp);
    if (!/\s/.test(ch)) {
      const s = glyphStyleAt(el, i), style: GlyphStyle = { family: s.family, weight: s.weight, style: s.style };
      const key = `${style.family}|${style.weight}|${style.style}`;
      if (!by.has(key)) by.set(key, { style, chars: new Set() });
      by.get(key)!.chars.add(ch);
    }
    i += ch.length;
  }
  return [...by.values()].map(({ style, chars }) => ({ style, chars: [...chars].sort() }));
}

const area = (nodes: VectorNode[]) => {
  let a = 0;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) a += (nodes[j].x * nodes[i].y - nodes[i].x * nodes[j].y);
  return a / 2;
};
const inside = (p: { x: number; y: number }, poly: VectorNode[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) hit = !hit;
  }
  return hit;
};
const copy = (n: VectorNode): VectorNode => ({ ...n, hIn: n.hIn && { ...n.hIn }, hOut: n.hOut && { ...n.hOut } });

/** Drop zero-length segments (font outlines repeat a contour's start point): a
 *  node equal to the previous one hands its outgoing handle to it. */
export function dedupeRing(nodes: VectorNode[]): VectorNode[] {
  const out: VectorNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - n.x) < 1e-9 && Math.abs(last.y - n.y) < 1e-9) { if (n.hOut) last.hOut = { ...n.hOut }; else delete last.hOut; continue; }
    out.push(copy(n));
  }
  const first = out[0], end = out[out.length - 1];
  if (out.length > 1 && Math.abs(first.x - end.x) < 1e-9 && Math.abs(first.y - end.y) < 1e-9) { if (end.hIn) first.hIn = { ...end.hIn }; out.pop(); }
  return out;
}

/** Join each hole to its outer ring with a zero-width bridge at their closest
 *  node pair (wound opposite to the outer ring), so one nonzero-filled ring
 *  draws the letter with its counter. Rings with no hole pass through. */
export function keyholeRings(rings: VectorNode[][]): VectorNode[][] {
  const info = rings.map((nodes) => ({ nodes, area: area(nodes), bbox: nodesExtent(nodes, true) }));
  const contains = (a: typeof info[number], b: typeof info[number]) =>
    a !== b && Math.abs(a.area) > Math.abs(b.area) && b.bbox.x >= a.bbox.x - 1e-6 && b.bbox.y >= a.bbox.y - 1e-6 &&
    b.bbox.x + b.bbox.w <= a.bbox.x + a.bbox.w + 1e-6 && b.bbox.y + b.bbox.h <= a.bbox.y + a.bbox.h + 1e-6 && inside(b.nodes[0], a.nodes);
  const depth = info.map((r) => info.filter((o) => contains(o, r)).length);
  const outers = info.map((r, i) => ({ r, i })).filter(({ i }) => depth[i] % 2 === 0);
  const holes = new Map<number, number[]>();
  info.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    // the smallest containing ring one level up owns this hole
    let owner = -1;
    for (const o of outers) if (depth[o.i] === depth[i] - 1 && contains(o.r, r) && (owner < 0 || Math.abs(o.r.area) < Math.abs(info[owner].area))) owner = o.i;
    if (owner >= 0) holes.set(owner, [...(holes.get(owner) ?? []), i]);
  });
  return outers.map(({ r, i }) => {
    let ring = r.nodes.map(copy);
    for (const h of holes.get(i) ?? []) {
      let hole = info[h].nodes.map(copy);
      if (Math.sign(info[h].area) === Math.sign(r.area)) hole = reverseNodes(hole);
      let bi = 0, bj = 0, best = Infinity;
      for (let a = 0; a < ring.length; a++) for (let b = 0; b < hole.length; b++) {
        const d = (ring[a].x - hole[b].x) ** 2 + (ring[a].y - hole[b].y) ** 2;
        if (d < best) { best = d; bi = a; bj = b; }
      }
      const out = copy(ring[bi]); delete out.hOut; out.type = "corner";
      const into = copy(hole[bj]); delete into.hIn; into.type = "corner";
      const around = [...hole.slice(bj + 1), ...hole.slice(0, bj)];
      const back = copy(hole[bj]); delete back.hOut; back.type = "corner";
      const home = copy(ring[bi]); delete home.hIn; home.type = "corner";
      ring = [...ring.slice(0, bi), out, into, ...around, back, home, ...ring.slice(bi + 1)];
    }
    return ring;
  });
}

/** One rounded-rect ring for a measured glyph box (the fallback). */
export function glyphBoxNodes(box: MeasuredGlyph["box"]): VectorNode[] {
  // The extent box runs ascender to descender; trim it toward the ink and pull
  // the sides in so neighbouring letters read as separate pieces.
  const x = box.x + box.w * 0.08, w = Math.max(0.5, box.w * 0.84), y = box.y + box.h * 0.14, h = Math.max(0.5, box.h * 0.72);
  const r = Math.min(w / 2, h * 0.25), k = 0.5523 * r;
  const n = (px: number, py: number, hIn?: [number, number], hOut?: [number, number]): VectorNode => ({ x: px, y: py, type: "smooth", ...(hIn ? { hIn: { dx: hIn[0], dy: hIn[1] } } : {}), ...(hOut ? { hOut: { dx: hOut[0], dy: hOut[1] } } : {}) });
  return [
    n(x + r, y, [-k, 0], undefined), n(x + w - r, y, undefined, [k, 0]),
    n(x + w, y + r, [0, -k], undefined), n(x + w, y + h - r, undefined, [0, k]),
    n(x + w - r, y + h, [k, 0], undefined), n(x + r, y + h, undefined, [-k, 0]),
    n(x, y + h - r, [0, k], undefined), n(x, y + r, undefined, [0, -k]),
  ];
}

export interface TextGlyphOutlines {
  outlines: StageOutline[];
  /** Some letter had no font outline and drew as a box. */
  boxes: boolean;
}

/** The letters of `el` as stage outlines (the element's UNROTATED frame; the
 *  geometry bridge applies placement). `chars[i]` is the measured glyph at
 *  UTF-16 offset i; `fontFor` returns the source for a style, or null when none
 *  is readable (→ boxes). `forceBoxes` draws every letter as its box. */
export function textGlyphOutlines(el: TextElement, chars: (MeasuredGlyph | null)[], fontFor: (style: GlyphStyle) => GlyphSource | null, forceBoxes = false): TextGlyphOutlines {
  const out: StageOutline[] = [];
  let boxes = false, order = 0;
  const paint = (color: string) => ({ fill: color, stroke: "none", strokeWidth: 0, cap: "butt" as const, opacity: el.opacity ?? 1 });
  for (let i = 0; i < el.text.length;) {
    const ch = String.fromCodePoint(el.text.codePointAt(i)!), at = i;
    i += ch.length;
    const g = chars[at];
    if (!g || /\s/.test(ch)) continue;
    const look = glyphStyleAt(el, at);
    const src = forceBoxes ? null : fontFor(look);
    const rec = src?.glyph(ch) ?? null;
    let rings: VectorNode[][] = [];
    if (rec) {
      if (!rec.d) continue; // a glyph with no contours draws nothing
      const s = look.size / src!.unitsPerEm;
      rings = pathToSubpaths(rec.d).filter((p) => p.nodes.length >= 2).map((p) => p.nodes.map((n) => ({
        ...n, x: g.x + n.x * s, y: g.y + n.y * s,
        ...(n.hIn ? { hIn: { dx: n.hIn.dx * s, dy: n.hIn.dy * s } } : {}),
        ...(n.hOut ? { hOut: { dx: n.hOut.dx * s, dy: n.hOut.dy * s } } : {}),
      }))).map(dedupeRing);
      rings = keyholeRings(rings);
    } else {
      boxes = true;
      rings = [glyphBoxNodes(g.box)];
    }
    for (const nodes of rings) {
      if (nodes.length < 3) continue;
      out.push({ nodes, closed: true, bbox: nodesExtent(nodes, true), owner: { elementId: el.id, role: rec ? "glyph" : "glyph-box", index: order++ }, paint: paint(look.color) });
    }
  }
  return { outlines: out, boxes };
}
