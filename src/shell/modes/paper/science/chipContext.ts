// The seam between the live-preview chip widgets (which detect @fig/@cite tokens
// and render their "finished" form) and Svelte-land (which owns figure
// rendering, bib resolution, hover cards and mode navigation). Widgets call
// these handlers; PaperMode registers them on mount (Flux_Paper_Plan.md B).

export type ChipTarget =
  | { kind: "figref"; label: string }
  | { kind: "cite"; keys: string[] };

export interface ChipHandlers {
  onActivate?: (t: ChipTarget) => void;
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
}
export const embedHandlers: EmbedHandlers = {};
export function setEmbedHandlers(h: EmbedHandlers) {
  embedHandlers.onOpenFigure = h.onOpenFigure;
}
