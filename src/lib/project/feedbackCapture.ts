// Snapshot & annotate — the pure half of "point at it" feedback (2026-09-15).
// A note can carry a SNAPSHOT: a crop of the frozen window plus the numbered
// marks (arrows, boxes, pen strokes) the user drew on it, each mark anchored to
// the element under its tip so the agent can find the thing by name as well as
// by eye. Pure (no DOM, no Node): shared by the overlay, the ledger, flux-core's
// `flux feedback` and the gates. The PNG itself lives beside the ledger at
// .meta/feedback/<noteId>.png; the stamp carries only its project-relative path.

export type MarkKind = "arrow" | "box" | "pen";

export interface FeedbackMark {
  kind: MarkKind;
  /** 1-based badge number drawn on the mark — the note's text refers to it. */
  n: number;
  /** CSS-px window coordinates. arrow: [tail, head]; box: [corner, corner]; pen: the stroke. */
  points: [number, number][];
  /** The element under the mark's tip (arrow head / box centre / stroke start), if any. */
  anchor?: { path: string; text?: string } | null;
}

export interface FeedbackSnapshot {
  /** Project-relative PNG path; null when the build cannot capture the window (browser). */
  image: string | null;
  /** The crop, CSS px in window coordinates. */
  rect: { x: number; y: number; w: number; h: number };
  window: { w: number; h: number; dpr: number };
  marks: FeedbackMark[];
}

export const SNAPSHOT_DIR_REL = ".meta/feedback";
export const SNAPSHOT_PAD = 48;
export const ARROW_HEAD = 14;
const MIN_W = 240;
const MIN_H = 160;

/** The crop for a set of marks: their bounds (arrow heads included) padded by
 *  `pad`, grown to at least 240×160 around their centre, clamped to the window.
 *  No marks → the whole window. Integer pixels, so the PNG composes exactly. */
export function snapshotCrop(
  marks: readonly FeedbackMark[],
  win: { w: number; h: number },
  pad = SNAPSHOT_PAD,
): { x: number; y: number; w: number; h: number } {
  const W = Math.max(1, Math.round(win.w));
  const H = Math.max(1, Math.round(win.h));
  const pts = marks.flatMap((m) => m.points);
  if (!pts.length) return { x: 0, y: 0, w: W, h: H };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const grow = pad + ARROW_HEAD;
  x0 -= grow; y0 -= grow; x1 += grow; y1 += grow;
  if (x1 - x0 < MIN_W) { const c = (x0 + x1) / 2; x0 = c - MIN_W / 2; x1 = c + MIN_W / 2; }
  if (y1 - y0 < MIN_H) { const c = (y0 + y1) / 2; y0 = c - MIN_H / 2; y1 = c + MIN_H / 2; }
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const w = Math.max(1, Math.min(W - x, Math.ceil(x1) - x));
  const h = Math.max(1, Math.min(H - y, Math.ceil(y1) - y));
  return { x, y, w, h };
}

/** Where a mark's number badge sits: an arrow's head, a box's top-left corner, a stroke's start. */
export function markBadgePoint(m: FeedbackMark): [number, number] {
  const p = m.points;
  if (!p.length) return [0, 0];
  const a = p[0], b = p[p.length - 1];
  if (m.kind === "arrow") return b;
  if (m.kind === "box") return [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
  return a;
}

/** The point a mark points AT — what gets anchored: the arrow head, the box centre, the stroke start. */
export function markTargetPoint(m: FeedbackMark): [number, number] {
  const p = m.points;
  if (!p.length) return [0, 0];
  const a = p[0], b = p[p.length - 1];
  if (m.kind === "arrow") return b;
  if (m.kind === "box") return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return a;
}

/** The arrow-head triangle at `to`, pointing away from `from`. */
export function arrowHead(from: [number, number], to: [number, number], size = ARROW_HEAD): [number, number][] {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const bx = to[0] - ux * size, by = to[1] - uy * size;
  const wx = -uy * size * 0.45, wy = ux * size * 0.45;
  return [to, [bx + wx, by + wy], [bx - wx, by - wy]];
}

/** The minimal element shape the path builder reads (DOM elements satisfy it; gates fake it). */
export interface AnchorNode {
  tagName: string;
  id?: string;
  className?: unknown;
  textContent?: string | null;
  parentElement?: AnchorNode | null;
  attributes?: ArrayLike<{ name: string; value: string }>;
}

function classesOf(n: AnchorNode): string[] {
  const c = n.className;
  const s = typeof c === "string" ? c : c && typeof (c as { baseVal?: unknown }).baseVal === "string" ? (c as { baseVal: string }).baseVal : "";
  return s.split(/\s+/).filter((x) => x && !/^svelte-/.test(x)).slice(0, 2);
}
function keyAttrs(n: AnchorNode): string[] {
  const out: string[] = [];
  const attrs = n.attributes;
  if (!attrs) return out;
  for (let i = 0; i < attrs.length && out.length < 3; i++) {
    const { name, value } = attrs[i];
    if (!(name.startsWith("data-") || name === "aria-label" || name === "title")) continue;
    if (name === "data-kind" || name === "data-n") continue;
    const v = String(value ?? "");
    if (!v || v.length > 32 || v === "true") { if (name.startsWith("data-") && !v) out.push(`[${name}]`); continue; }
    out.push(`[${name}=${/^[\w.:-]+$/.test(v) ? v : JSON.stringify(v)}]`);
  }
  return out;
}

/** A short, greppable description of the element under a mark: up to `depth`
 *  named ancestors as `tag.class[data-x=y]` (Svelte's hashed classes and bare
 *  layout wrappers skipped), plus the element's own short text. */
export function anchorPathOf(el: AnchorNode | null | undefined, depth = 4): { path: string; text?: string } | null {
  if (!el) return null;
  const segs: string[] = [];
  let cur: AnchorNode | null | undefined = el;
  while (cur && segs.length < depth) {
    const tag = String(cur.tagName || "").toLowerCase();
    if (!tag || tag === "html" || tag === "body") break;
    const cls = classesOf(cur);
    const attrs = keyAttrs(cur);
    const named = cur.id || cls.length || attrs.length || cur === el;
    if (named) segs.unshift(tag + (cur.id ? "#" + cur.id : "") + cls.map((c) => "." + c).join("") + attrs.join(""));
    cur = cur.parentElement;
  }
  if (!segs.length) return null;
  const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
  const text = raw ? (raw.length > 40 ? raw.slice(0, 37) + "…" : raw) : undefined;
  const path = segs.join(" > ");
  return text ? { path, text } : { path };
}

/** One line for the stamp: `snapshot ×2 (1 → button.tool "Gallery", 2 → …)`. */
export function describeSnapshot(s: FeedbackSnapshot | null | undefined): string {
  if (!s) return "";
  const n = s.marks.length;
  const where = s.marks.slice(0, 3).map((m) => `${m.n} → ${m.anchor?.path ?? "?"}${m.anchor?.text ? ` "${m.anchor.text}"` : ""}`);
  const more = n > 3 ? `, +${n - 3}` : "";
  return (n ? `snapshot ×${n}` : "snapshot") + (where.length ? ` (${where.join(", ")}${more})` : "") + (s.image ? "" : " (no screenshot)");
}
