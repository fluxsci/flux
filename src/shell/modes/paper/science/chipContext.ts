// The seam between the live-preview chip widgets (which detect @fig/@cite tokens
// and render their "finished" form) and Svelte-land (which owns figure
// rendering, bib resolution, hover cards and mode navigation). Widgets call
// these handlers; PaperMode registers them on mount (Flux_Paper_Plan.md B).

export type ChipTarget =
  | { kind: "figref"; label: string }
  | { kind: "cite"; keys: string[] };

export interface ChipHandlers {
  /** `anchor` = the chip's DOM element (resolve positions fresh via
   *  view.posAtDOM — widget instances persist across rebuilds, so a captured
   *  offset would go stale). */
  onActivate?: (t: ChipTarget, anchor?: HTMLElement) => void;
  onHover?: (t: ChipTarget, anchor: HTMLElement) => void;
  onLeave?: () => void;
}

export const chipHandlers: ChipHandlers = {};

export function setChipHandlers(h: ChipHandlers) {
  chipHandlers.onActivate = h.onActivate;
  chipHandlers.onHover = h.onHover;
  chipHandlers.onLeave = h.onLeave;
}

// Slash-menu / toolbar insert actions that open Svelte-side pickers (B6).
export interface SlashHandlers {
  onInsertFigure?: () => void;
  onInsertCitation?: () => void;
}
export const slashHandlers: SlashHandlers = {};
export function setSlashHandlers(h: SlashHandlers) {
  slashHandlers.onInsertFigure = h.onInsertFigure;
  slashHandlers.onInsertCitation = h.onInsertCitation;
}

// Figure-embed block-widget actions (B2).
export interface EmbedHandlers {
  onOpenFigure?: (figId: string) => void;
  /**
   * Write a width attr for the embed whose widget DOM is `el` (null clears
   * it). The element — not a position — crosses the seam because widget
   * instances persist across rebuilds and a captured offset would go stale;
   * PaperMode resolves it fresh via view.posAtDOM(el).
   */
  onSetWidth?: (el: HTMLElement, width: string | null) => void;
}
export const embedHandlers: EmbedHandlers = {};
export function setEmbedHandlers(h: EmbedHandlers) {
  embedHandlers.onOpenFigure = h.onOpenFigure;
  embedHandlers.onSetWidth = h.onSetWidth;
}
