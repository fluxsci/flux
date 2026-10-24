// ---------------------------------------------------------------------------
// WP 3.2 — the ATTACHMENT driver of the player. ONE controller per slide, registered LAST so every applyAt runs it after every transform
// controller of the frame: it reads the driver boxes those controllers just wrote into `boxes` (their final sampled element: arc and spring
// overshoot included), solves the dependents with the pure `resolveAttachments` (slide/attach.ts, the same solve compile.sample runs), and
// writes each dependent's wrapper. No clock, no history: a frame is a function of the frame (seek-pure).
//
//  * CONNECTORS (line dependents) are painted by the REST law every frame they change: their stroke re-serialised in place
//    (`updateStaticContent` keeps node identity, so a draw on the line keeps running) on their own tight layout box. Never a frozen box
//    stretched by the compositor (a 26x scale): strokes stay crisp, and the effects layer is relative to the current box, so an appearance
//    behaves exactly as on an unattached line.
//  * LABELS (box dependents) glide like a moving element: while anything they hang on moves, a compositor composite over their constant
//    Design layout box on a promoted layer (float-precise, no whole-pixel stepping); at rest, the rest law. A label whose own Change resizes
//    it this frame (a new font size, a re-measured box) is placed by the rest law even in flight, like any re-laid-out text (transform.ts):
//    a composite would SCALE its Design raster and snap when it lands. Their flight MARK belongs to the player (applyAt `markFor`):
//    computeSlideAnims gives each label a marker controller (`glide`) for every beat in which its drivers move, so the mark is armed before
//    the motion's first frame and released by the same law as any gliding element.
// ---------------------------------------------------------------------------
import type { Element as FigElement } from "../../types";
import { elementBBox } from "../../geometry";
import { attachRefs, hasAttach, resolveAttachments } from "../attach";
import { applyWrapperBox, applyWrapperBoxComposite, layoutBoxOf, normalizeAttachedDash, promoteMovingWrapper, settleWrapper, updateStaticContent, type SlideRenderCtx } from "./render";
import type { MorphController } from "../../plot/project";

/** One element's state this frame, written by its transform controller: the sampled element, and whether it is in flight. */
export interface BoxRec { el: FigElement; moving: boolean }

/** The attachment controller of a slide. `selfDriven` = dependents that also play transforms of their own (a label's colour Change): their
 *  own controller writes their wrapper every frame, so the attachment rewrites it every frame too (never skipped as unchanged). */
export function createAttachDriver(elements: readonly FigElement[], wraps: ReadonlyMap<string, HTMLElement>, boxes: ReadonlyMap<string, BoxRec>, ctx: SlideRenderCtx, selfDriven: ReadonlySet<string>): MorphController {
  const dependents = elements.filter((e) => hasAttach(e) && wraps.has(e.id));
  const authored = new Map(elements.map((e) => [e.id, e]));
  const involved = new Set<string>();
  for (const e of dependents) { involved.add(e.id); for (const id of attachRefs(e)) if (authored.has(id)) involved.add(id); }
  // a label's composite rides its DESIGN layout box (the stored geometry is the Design solve): a constant of the slide, so a frame's DOM never
  // depends on which frame was painted before it
  const baseOf = new Map(dependents.filter((e) => e.type !== "line").map((e) => [e.id, layoutBoxOf(elementBBox({ ...e, rotation: 0 }))] as const));
  let last = new Map<string, string>();
  /** In flight this frame: the element's own controller, or (transitively) anything it hangs on. */
  const moving = (id: string, memo: Map<string, boolean>, seen = new Set<string>()): boolean => {
    const known = memo.get(id); if (known !== undefined) return known;
    if (seen.has(id)) return false; seen.add(id);
    const own = authored.get(id), v = (boxes.get(id)?.moving ?? false) || (own ? attachRefs(own).some((r) => moving(r, memo, seen)) : false);
    memo.set(id, v); return v;
  };
  function seek(): void {
    const frame: FigElement[] = [];
    for (const id of involved) {
      const own = authored.get(id)!, live = boxes.get(id)?.el;
      frame.push({ ...own, ...(live ?? {}), attach: own.attach } as FigElement);
    }
    resolveAttachments(frame);
    const byId = new Map(frame.map((e) => [e.id, e])), memo = new Map<string, boolean>(), next = new Map<string, string>();
    for (const dep of dependents) {
      const wrap = wraps.get(dep.id)!, el = byId.get(dep.id)!, flying = moving(dep.id, memo);
      const key = JSON.stringify([el.x, el.y, el.width, el.height, el.rotation, (el as { x2?: number }).x2, (el as { y2?: number }).y2, flying]);
      next.set(dep.id, key);
      if (last.get(dep.id) === key && !selfDriven.has(dep.id)) continue;
      if (el.type === "line") {
        const host = (wrap as HTMLElement & { __slideEffects?: HTMLElement }).__slideEffects ?? wrap;
        updateStaticContent(host, el, ctx);
        normalizeAttachedDash(host, el);
        applyWrapperBox(wrap, el, { skipOpacity: true });
      } else if (flying && el.width === dep.width && el.height === dep.height) {
        applyWrapperBoxComposite(wrap, el, baseOf.get(dep.id)!, { skipOpacity: true });
        promoteMovingWrapper(wrap);
      } else {
        applyWrapperBox(wrap, el, { skipOpacity: true });
        settleWrapper(wrap);
      }
    }
    last = next;
  }
  return { seek } as MorphController;
}
