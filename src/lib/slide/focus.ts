// ---------------------------------------------------------------------------
// Flux Slide — Focus (WP 4.4; T6 P2, absorbs W4): dim everything except the selection, the 3b1b idiom in one click. The pure half:
// which elements stay bright and which dim. A label that sits INSIDE a selected object belongs to it (stays bright), as does
// everything in a selected element's group; everything else, labels and containers alike, dims together, so a dimmed card never
// keeps a full-contrast label (the single-element `dim` preset is element-level and says so).
// ---------------------------------------------------------------------------
import { rotatedAABB, type Rect } from "../geometry";

export interface FocusElement { id: string; hidden?: boolean; type: string; x: number; y: number; width: number; height: number; rotation?: number; groupId?: string }
const inside = (a: Rect, outer: Rect, eps = 0.5) => a.x >= outer.x - eps && a.y >= outer.y - eps && a.x + a.w <= outer.x + outer.w + eps && a.y + a.h <= outer.y + outer.h + eps;
/** `bright` = the selection plus every visible element wholly inside a selected element's box (or in the same group as a selected
 *  element); `dim` = every other visible element, in slide order. */
export function focusPlan(elements: readonly FocusElement[], selected: readonly string[]): { bright: string[]; dim: string[] } {
  const sel = new Set(selected), live = elements.filter((e) => !e.hidden);
  const boxes = new Map(live.map((e) => [e.id, rotatedAABB(e as never)]));
  const groups = new Set(live.filter((e) => sel.has(e.id) && e.groupId).map((e) => e.groupId));
  const bright = live.filter((e) => sel.has(e.id) || (e.groupId && groups.has(e.groupId)) ||
    selected.some((s) => s !== e.id && boxes.has(s) && inside(boxes.get(e.id)!, boxes.get(s)!))).map((e) => e.id);
  const keep = new Set(bright);
  return { bright, dim: live.filter((e) => !keep.has(e.id)).map((e) => e.id) };
}
