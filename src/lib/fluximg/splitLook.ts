/**
 * How a split channel panel looks: in GRAY (its intensities on a neutral scale) or in COLOUR (its channel as it is in
 * the merged image). Pure (no DOM, no Svelte, no project store): the live view's Split key, the flip of an existing
 * split and the linked colour that follows the composite (`ops.setFluximgView`) share these definitions.
 *
 * A channel's colouring is what the view STORES for it (its colour or colour map, and invert): the window, norm and
 * gamma are linked between the panels already (`viewOps.sharedPatch`). A panel's look is read against its composite:
 *   - `color`: its channel is coloured exactly as the composite's (stored overrides equal: both may be the image's own);
 *   - `gray`: its channel is the gray map (and not equal to the composite's);
 *   - `hand`: anything else: someone recoloured it by hand, and that choice is kept (the flip leaves it, and a later
 *     change of the composite's colour does not reach it).
 */
import type { FluximgChannelView, FluximgView } from "./view";

export type SplitLook = "color" | "gray";

const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The colouring a channel view stores (null = the image's own), normalised the way the view resolves it: a colour wins over a map. */
export function colouring(c: FluximgChannelView | null | undefined): { color: string | null; lut: string | null; invert: boolean } {
  const color = c && isColor(c.color) ? c.color.toLowerCase() : null;
  return { color, lut: color ? null : c && isName(c.lut) ? c.lut : null, invert: !!c?.invert };
}
const sameColouring = (a: FluximgChannelView | null | undefined, b: FluximgChannelView | null | undefined): boolean => {
  const x = colouring(a), y = colouring(b);
  return x.color === y.color && x.lut === y.lut && x.invert === y.invert;
};

/** The channel view a split panel stores for its own channel, from the composite's channel at the time. */
export function panelChannel(src: FluximgChannelView | null | undefined, look: SplitLook): FluximgChannelView {
  const base: FluximgChannelView = { ...(src ?? {}) };
  delete base.visible; // a panel shows its channel alone (composite "single"): the composite's eye is not its own
  if (look === "gray") return { ...base, lut: "gray", color: null as unknown as undefined };
  return base;
}

/** The whole view of split panel `i` of `n` (a sparse recipe: the composite's view, showing only channel `i`). */
export function splitPanelView(src: FluximgView | null | undefined, i: number, n: number, link: string, look: SplitLook): FluximgView {
  const channels: Array<FluximgChannelView | null> = [];
  for (let k = 0; k < n; k++) channels.push(k === i ? panelChannel(src?.channels?.[k], look) : (src?.channels?.[k] ?? null));
  return { ...structuredClone(src ?? {}), link, composite: "single", solo: i, channels, furniture: { channelLabels: {} } };
}

/** A panel's look against its composite's channel (see the header). */
export function lookOf(panel: FluximgChannelView | null | undefined, composite: FluximgChannelView | null | undefined): SplitLook | "hand" {
  if (sameColouring(panel, composite)) return "color";
  const c = colouring(panel);
  return !c.color && c.lut === "gray" ? "gray" : "hand";
}

/** What `splitPanels` and `flipPlan` read of an element. */
export interface SplitElement { id: string; type: string; assetId?: string; hidden?: boolean; view?: FluximgView | null }

const isPanel = (e: SplitElement): boolean => e.view?.composite === "single" && typeof e.view.solo === "number" && !e.view.insetOf;

/**
 * The split of an image: its linked channel panels (one figure's elements of the same image sharing the link, each
 * showing one channel alone; `el` itself when it is one) and the composite they were split from (the linked element
 * that blends its channels; null when it is gone).
 */
export function splitPanels<T extends SplitElement>(elements: readonly T[], el: T): { panels: T[]; composite: T | null } {
  const link = el.view?.link;
  if (!link) return { panels: [], composite: null };
  const linked = elements.filter((e) => e.type === el.type && e.assetId === el.assetId && e.view?.link === link);
  const panels = linked.filter(isPanel);
  const composite = (!isPanel(el) && !el.view?.insetOf ? el : null) ?? linked.find((e) => !isPanel(e) && !e.view?.insetOf) ?? null;
  return { panels, composite };
}

/**
 * Flip an existing split between gray and colour, in one step: every panel that is gray becomes its composite's
 * colour, or, when none is gray, every coloured one becomes gray. Panels recoloured by hand keep their colour.
 * Null when the image has no split panels. `patches` are per element, in `set-image-view`'s language.
 */
export function flipPlan<T extends SplitElement>(elements: readonly T[], el: T): { to: SplitLook; patches: Array<{ id: string; view: FluximgView }> } | null {
  const { panels, composite } = splitPanels(elements, el);
  if (!panels.length) return null;
  const compCh = (k: number): FluximgChannelView | null => composite?.view?.channels?.[k] ?? null;
  const looks = panels.map((p) => { const k = p.view!.solo!; return { p, k, look: lookOf(p.view?.channels?.[k], compCh(k)) }; });
  const to: SplitLook = looks.some((l) => l.look === "gray") ? "color" : "gray";
  const patches: Array<{ id: string; view: FluximgView }> = [];
  for (const { p, k, look } of looks) {
    if (look === "hand" || look === to) continue;
    const c = colouring(compCh(k));
    const patch: FluximgChannelView = to === "gray"
      ? { lut: "gray", color: null as unknown as undefined }
      : { color: (c.color ?? null) as unknown as undefined, lut: (c.color ? null : c.lut) as unknown as undefined, invert: (c.invert || null) as unknown as undefined };
    const channels: Array<FluximgChannelView | null> = [];
    for (let i = 0; i < k; i++) channels.push(null);
    channels.push(patch);
    patches.push({ id: p.id, view: { channels } });
  }
  return { to, patches };
}

/** The look of an existing split, as its key shows it: colour when no non-hand panel is gray. Null without panels. */
export function splitLookOf<T extends SplitElement>(elements: readonly T[], el: T): SplitLook | null {
  const plan = flipPlan(elements, el);
  return plan ? (plan.to === "gray" ? "color" : "gray") : null;
}

/**
 * The colour a composite's channel edit hands on: when `before` (the composite's channel before the edit) and a linked
 * panel showing that channel are coloured alike, the panel follows the edit's colour fields; a gray panel or one
 * recoloured by hand does not. Null when the panel does not follow or the edit has no colour in it.
 */
export function followPatch(edit: FluximgChannelView | null | undefined, before: FluximgChannelView | null | undefined, panel: FluximgChannelView | null | undefined): FluximgChannelView | null {
  if (!edit || !("color" in edit || "lut" in edit || "invert" in edit)) return null;
  if (!sameColouring(before, panel)) return null;
  const out: FluximgChannelView = {};
  if ("color" in edit) out.color = edit.color;
  if ("lut" in edit) out.lut = edit.lut;
  if ("invert" in edit) out.invert = edit.invert;
  return out;
}
