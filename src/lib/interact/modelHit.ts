// Raster presses have no element DOM to hit. Resolve the same plain-click
// unit from the model, in paint order, without measuring or mounting anything.
import type { Element, Figure } from '../types';
import { chainOf, effectiveHidden, effectiveLocked, unitKeyOf } from '../groups';
import { rectIntersectsElement, rotatePoint, type Rect } from '../geometry';

export interface ModelHitContext {
  selection?: ReadonlySet<string>;
  enteredGroupId?: string | null;
  /** Cached placement-local ink bounds: undefined = the ordinary box;
   * null = no visible ink. The caller retains these when live DOM unmounts. */
  plotBounds?: (element: Element) => Rect | null | undefined;
}
export function hitElementAt(fig: Figure, point: { x: number; y: number }, ctx: ModelHitContext = {}): { element: Element; ids: Set<string>; scope: string | null } | null {
  for (let i = fig.elements.length - 1; i >= 0; i--) {
    const el = fig.elements[i];
    if (effectiveHidden(fig, el) || effectiveLocked(fig, el)) continue;
    const ink = el.type === 'plot' ? ctx.plotBounds?.(el) : undefined;
    if (ink === null) continue;
    if (ink !== undefined) {
      const p = rotatePoint(point, { x: el.x + el.width / 2, y: el.y + el.height / 2 }, -(el.rotation ?? 0));
      const x = el.x + (el.flipX ? el.width - ink.x - ink.w : ink.x), y = el.y + (el.flipY ? el.height - ink.y - ink.h : ink.y);
      if (p.x < x || p.x > x + ink.w || p.y < y || p.y > y + ink.h) continue;
    } else if (!rectIntersectsElement({ x: point.x - 0.05, y: point.y - 0.05, w: 0.1, h: 0.1 }, el)) continue;
    const scope = ctx.enteredGroupId && chainOf(fig, el).includes(ctx.enteredGroupId) ? ctx.enteredGroupId : null;
    const unit = unitKeyOf(fig, el, scope);
    return { element: el, scope, ids: new Set(fig.elements.filter(e => unitKeyOf(fig, e, scope) === unit).map(e => e.id)) };
  }
  return null;
}
