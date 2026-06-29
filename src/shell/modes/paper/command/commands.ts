// A command for the ⌘K palette. The palette is the home for every mode-level
// action now that the paper module has no toolbar (Redesign v2). PaperMode owns
// the handlers and builds the list; the palette is a generic presenter.

export interface Command {
  id: string;
  title: string;
  /** Right-aligned hint — a group label or a shortcut. */
  hint?: string;
  /** Extra terms to match on (not shown). */
  keywords?: string;
  run: () => void;
}
