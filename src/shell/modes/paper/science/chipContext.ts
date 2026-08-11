// The seam between the live-preview chip widgets (which detect @fig/@cite tokens
// and render their "finished" form) and Svelte-land (which owns figure
// rendering, bib resolution, hover cards and mode navigation). Widgets call
// these handlers; PaperMode registers them on mount (Flux_Paper_Plan.md B).
//
// Per-editor (dual-paper 2026-08-11): the registry is keyed by the editor's
// root DOM element (view.dom) — the old module-global mutable objects meant
// every PaperMode mount overwrote them app-wide, so a chip click in pane A
// dispatched through pane B's closures (B's view.posAtDOM on A's element).
// Every widget call site already passes its own element; lookup walks to the
// owning `.cm-editor`. Completion `apply(view, …)` call sites look up by view.

import type { EditorView } from "@codemirror/view";

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

// Slash-menu / toolbar insert actions that open Svelte-side pickers (B6).
export interface SlashHandlers {
  onInsertFigure?: () => void;
  onInsertCitation?: () => void;
  /** Open the figure-REFERENCE picker (`@@` / "/cross-reference"): figure →
   *  panel selection → inserts `@fig-x[-panels]` at the caret. */
  onInsertFigRef?: () => void;
}

// Table block-widget actions (B3): the hover bar / header alignment toggles.
// Same element-not-position contract as EmbedHandlers — PaperMode resolves the
// table fresh via view.posAtDOM(el).
export type TableAction =
  | { kind: "add-row" }
  | { kind: "add-col" }
  | { kind: "format" }
  | { kind: "copy" } // table → clipboard as TSV (Excel-ready)
  | { kind: "align"; col: number }
  /** Click on a rendered cell → caret into its SOURCE cell (row -1 = header). */
  | { kind: "cell"; row: number; col: number }
  /** Click on the rendered caption → caret into the `: Caption {#tbl-…}` line.
   *  The source block collapses to a pill off-caret (science/tableFold.ts), so
   *  the caption needs the same one-click route into its source that the cells
   *  have. */
  | { kind: "caption" };
export interface TableHandlers {
  onTableAction?: (el: HTMLElement, action: TableAction) => void;
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

export interface PaperHandlers {
  chip?: ChipHandlers;
  slash?: SlashHandlers;
  table?: TableHandlers;
  embed?: EmbedHandlers;
}

const registry = new Map<HTMLElement, PaperHandlers>(); // editor root (.cm-editor) -> handlers

/** PaperMode registers its per-instance handlers against its editor's root DOM
 *  (view.dom). Returns the unregister fn (onDestroy). */
export function registerPaperHandlers(editorDom: HTMLElement, handlers: PaperHandlers): () => void {
  registry.set(editorDom, handlers);
  return () => {
    if (registry.get(editorDom) === handlers) registry.delete(editorDom);
  };
}

/** Resolve the handlers owning `el` (any element inside the editor DOM).
 *  Single-registration fallback: widget elements can sit in an overlay
 *  portaled OUTSIDE .cm-editor in principle — with one paper pane the sole
 *  entry is unambiguous, so lookup degrades to exactly the old behavior. */
export function handlersForEl(el: HTMLElement | null | undefined): PaperHandlers | undefined {
  const root = el?.closest?.(".cm-editor");
  if (root) {
    const h = registry.get(root as HTMLElement);
    if (h) return h;
  }
  if (registry.size === 1) return registry.values().next().value;
  return undefined;
}

/** Resolve the handlers for a known EditorView (completion `apply` sites). */
export function handlersForView(view: EditorView): PaperHandlers | undefined {
  return registry.get(view.dom) ?? (registry.size === 1 ? registry.values().next().value : undefined);
}

/** Build-time gate for optional widget affordances (the table hover bar):
 *  at toDOM() the element is not attached yet, so per-editor lookup can't run —
 *  "some paper pane registered handlers" is the render condition, and the
 *  CLICK-time dispatch resolves per-editor via handlersForEl. Headless
 *  single-field harnesses register nothing and keep the plain widget. */
export function anyPaperHandlers(): boolean {
  return registry.size > 0;
}
