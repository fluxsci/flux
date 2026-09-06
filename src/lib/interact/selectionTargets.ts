import type { Element, Figure, Id } from '../types';
import { effectiveHidden, effectiveLocked } from '../groups';

/** Explicit, shared targeting policy. Inspection can include locked/hidden objects;
 * authoring commands opt into editable targets. Presentation-only ghosts never
 * become mutation targets. Keep order identical to the figure's stacking order. */
export function selectionTargets(fig: Figure, ids: ReadonlySet<Id>, options: {
  editable?: boolean;
  visible?: boolean;
  excluded?: ReadonlySet<Id>;
  supports?: (element: Element) => boolean;
} = {}): Element[] {
  return fig.elements.filter(el => ids.has(el.id) && !options.excluded?.has(el.id)
    && (!(options.editable || options.visible) || !effectiveHidden(fig, el))
    && (!options.editable || !effectiveLocked(fig, el))
    && (!options.supports || options.supports(el)));
}
