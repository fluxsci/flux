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

/**
 * The palette's matches for a query, best first: a title that starts with it,
 * then a title (or a word in it) that contains it, then keyword or hint matches.
 * Stable within each rank, so a surface's own ordering still breaks ties.
 * ("Annotate" must find "Annotate…" before "Comment on selection", whose
 * keywords mention annotate.)
 */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
  const t = query.trim().toLowerCase();
  if (!t) return [...commands];
  const rank = (c: Command): number => {
    const title = c.title.toLowerCase();
    if (title.startsWith(t)) return 0;
    if (title.split(/[\s:·…—-]+/).some((w) => w.startsWith(t))) return 1;
    if (title.includes(t)) return 2;
    if (((c.keywords ?? "") + " " + (c.hint ?? "")).toLowerCase().includes(t)) return 3;
    return -1;
  };
  return commands
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}
