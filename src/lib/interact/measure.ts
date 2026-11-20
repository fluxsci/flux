// The measure on the object (2026-11-20): while a geometric row of the property menu is in hand (or under the
// pointer), the canvas draws that one dimension on the selected object itself, in the menu's blue: the width
// along its foot, the height at its side, its position from the figure's edge, its turn as a wedge, its corner
// radius as the circle that rounds it. The menu publishes WHICH property; the canvas draws it. Screen-space
// chrome only: nothing here touches the model.
import { writable } from "svelte/store";
import { shortNum, type MeasureProp } from "./menuLook";

/** The property the property menu has in hand, when the canvas can measure it. Null whenever the menu is closed. */
export const fluxFigMeasure = writable<MeasureProp | null>(null);

/** What the measure reads of an element (figure units). */
export interface Measured { x: number; y: number; width?: number; height?: number; rotation?: number; cornerRadius?: number }
/** Figure → screen: screen = offset + figure × zoom. */
export interface MeasureProjection { x: number; y: number; zoom: number }

export interface MeasureDrawing {
  /** Solid strokes (one path). */
  d: string;
  /** Dashed strokes: a zero line, the rounding circle. */
  dash: string;
  /** A filled wedge (rotation). */
  wedge: string;
  dot: { x: number; y: number } | null;
  pill: { x: number; y: number; text: string };
}

const OFF = 16, TICK = 6;
const n = (v: number): string => String(+v.toFixed(2));

/** The drawing for one property of one element, in screen px. Marks that belong to the object (width, height,
 *  corner radius) turn with it; its position is measured to its own unturned box, as the model stores it. */
export function measureDrawing(prop: MeasureProp, el: Measured, p: MeasureProjection): MeasureDrawing | null {
  const boxed = el.width != null && el.height != null;
  const w = (el.width ?? 0) * p.zoom, h = (el.height ?? 0) * p.zoom, x = p.x + el.x * p.zoom, y = p.y + el.y * p.zoom;
  const cx = x + w / 2, cy = y + h / 2, turn = ((el.rotation ?? 0) * Math.PI) / 180, co = Math.cos(turn), si = Math.sin(turn);
  /** A point of the element's own frame, turned about its middle. */
  const t = (px: number, py: number): [number, number] => [cx + (px - cx) * co - (py - cy) * si, cy + (px - cx) * si + (py - cy) * co];
  const seg = (a: [number, number], b: [number, number]) => `M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}`;
  const at = (q: [number, number], text: string) => ({ x: q[0], y: q[1], text });
  if (prop === "width") {
    if (!boxed) return null;
    const yy = y + h + OFF;
    return { d: seg(t(x, yy), t(x + w, yy)) + seg(t(x, yy - TICK), t(x, yy + TICK)) + seg(t(x + w, yy - TICK), t(x + w, yy + TICK)), dash: "", wedge: "", dot: null, pill: at(t(cx, yy), shortNum(el.width!)) };
  }
  if (prop === "height") {
    if (!boxed) return null;
    const xx = x - OFF;
    return { d: seg(t(xx, y), t(xx, y + h)) + seg(t(xx - TICK, y), t(xx + TICK, y)) + seg(t(xx - TICK, y + h), t(xx + TICK, y + h)), dash: "", wedge: "", dot: null, pill: at(t(xx, cy), shortNum(el.height!)) };
  }
  if (prop === "cornerRadius") {
    if (!boxed) return null;
    const r = Math.max(0, Math.min((el.cornerRadius ?? 0) * p.zoom, w / 2, h / 2)), c = t(x + r, y + r), text = `r ${shortNum(el.cornerRadius ?? 0)}`;
    if (r < 1.5) return { d: seg(t(x + 14, y), t(x, y)) + seg(t(x, y), t(x, y + 14)), dash: "", wedge: "", dot: null, pill: at(t(x + 34, y + 20), text) };
    const k = r * (1 - Math.SQRT1_2), edge = t(x + k, y + k);
    return { d: seg(c, edge), dash: `M${n(c[0] - r)} ${n(c[1])}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`, wedge: "", dot: { x: c[0], y: c[1] }, pill: at(t(x + r + 26, y + r + 17), text) };
  }
  if (prop === "x") {
    const x0 = p.x;
    return { d: `M${n(x0)} ${n(cy)}H${n(x)}M${n(x0)} ${n(cy - TICK)}v${2 * TICK}M${n(x)} ${n(cy - TICK)}v${2 * TICK}`, dash: "", wedge: "", dot: null, pill: { x: (x0 + x) / 2, y: cy, text: shortNum(el.x) } };
  }
  if (prop === "y") {
    const y0 = p.y;
    return { d: `M${n(cx)} ${n(y0)}V${n(y)}M${n(cx - TICK)} ${n(y0)}h${2 * TICK}M${n(cx - TICK)} ${n(y)}h${2 * TICK}`, dash: "", wedge: "", dot: null, pill: { x: cx, y: (y0 + y) / 2, text: shortNum(el.y) } };
  }
  // rotation: zero stands straight up; the wedge opens to where the object now points
  const deg = el.rotation ?? 0, R = Math.max(18, Math.min(boxed ? Math.min(w, h) * 0.3 : 24, 60)), L = R + 12, a = turn - Math.PI / 2;
  const hand: [number, number] = [cx + L * Math.cos(a), cy + L * Math.sin(a)], onArc: [number, number] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  const wedge = Math.abs(deg) > 0.5 ? `M${n(cx)} ${n(cy)}V${n(cy - R)}A${n(R)} ${n(R)} 0 ${Math.abs(deg) > 180 ? 1 : 0} ${deg >= 0 ? 1 : 0} ${n(onArc[0])} ${n(onArc[1])}Z` : "";
  return { d: seg([cx, cy], hand), dash: `M${n(cx)} ${n(cy)}V${n(cy - L)}`, wedge, dot: { x: cx, y: cy }, pill: { x: cx, y: cy + 19, text: `${shortNum(deg)}°` } };
}
