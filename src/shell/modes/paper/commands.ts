// ---------------------------------------------------------------------------
// WS-4.3 (fortify plan): THE Paper shortcut table. The window keydown handler
// and the ⌘K palette used to be maintained separately and had drifted: the
// terminal had TWO window chords but advertised one; several hints promised
// keys actually owned by the CodeMirror keymap layer; six actions duplicated
// handler logic in both places. This table is the single source: the palette
// list and the window dispatcher are both GENERATED from it.
//
//   owner "window" — chord(s) live on the window keydown dispatcher here.
//   owner "cm"     — the real binding lives in editing/keymap.ts (single
//                    source for those hint strings); palette-hint-only here.
//   owner "none"   — palette-only action, no chord.
//
// The Esc layering guards (export menu, preview un-trap) are MODAL, not
// commands — they stay verbatim in PaperMode's handler, after table dispatch.
// Dynamic groups (figure-width presets, background scenes, quarto-gated
// export) also stay in PaperMode; they are palette-only and carry no chords.
// ---------------------------------------------------------------------------

import { CM_HINTS } from "./editing/keymap";

/** Everything a command can do, injected by PaperMode. */
export interface PaperCmdCtx {
  previewActive(): boolean;
  togglePreview(): void;
  setView(mode: "continuous" | "paginated"): void;
  setCitationStyle(style: "author-year" | "numeric"): void;
  vimFlavor(): "off" | "vim" | "flux";
  setVimFlavor(flavor: "off" | "vim" | "flux"): void;
  openFigurePicker(): void;
  openFigRefPicker(): void;
  outlinerOpen(): boolean;
  toggleOutliner(): void;
  marginOpen(): boolean;
  toggleMargin(): void;
  summonPane(kind: string): void;
  editCitationAtCursor(): void;
  openDoiPrompt(mode: "library" | "cite"): void;
  startComment(): void;
  closeActivePane(): void;
  closeAllPanes(): void;
  widerMargin(): void;
  narrowerMargin(): void;
  rerollBgSeed(): void;
  foldSection(): void;
  unfoldSection(): void;
  foldAll(): void;
  unfoldAll(): void;
  openExportDialog(): void;
  togglePalette(): void;
  /** Table editing at the caret (editing/tableOps.ts; no-ops off-table). */
  tableCmd(
    cmd:
      | "row-below"
      | "row-above"
      | "delete-row"
      | "col-right"
      | "col-left"
      | "delete-col"
      | "align"
      | "format",
  ): void;
  /** Convert the clipboard (TSV/CSV) into a table at the caret. */
  pasteAsTable(): void;
}

export interface PaperCommandRow {
  id: string;
  title: (ctx: PaperCmdCtx) => string;
  /** Palette hint. window rows default to a display of their first chord. */
  hint?: string;
  keywords?: string;
  /** Window chords, "Mod+Alt+Shift+<KeyboardEvent.code>" (order-insensitive
   *  modifiers; Mod = meta OR ctrl, matching the old handler exactly). */
  keys?: string[];
  owner: "window" | "cm" | "none";
  /** Include in the palette (default true). */
  palette?: boolean;
  run: (ctx: PaperCmdCtx) => void;
}

/** Human hint from a chord ("Mod+Shift+KeyE" → "⌘⇧E", "Alt+KeyT" → "Alt+T"). */
export function chordHint(chord: string): string {
  const parts = chord.split("+");
  const code = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const key = code.startsWith("Key")
    ? code.slice(3)
    : code === "Backquote"
      ? "`"
      : code === "Minus"
        ? "−"
        : code === "Equal"
          ? "="
          : code;
  if (mods.has("Mod")) return `${mods.has("Ctrl") ? "⌃" : ""}⌘${mods.has("Alt") ? "⌥" : ""}${mods.has("Shift") ? "⇧" : ""}${key}`;
  const prefix = `${mods.has("Ctrl") ? "⌃" : ""}${mods.has("Alt") ? "Alt+" : ""}${mods.has("Shift") ? "⇧" : ""}`;
  return `${prefix}${key}`;
}

export function matchesChord(e: KeyboardEvent, chord: string): boolean {
  const parts = chord.split("+");
  const code = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const mod = e.metaKey || e.ctrlKey;
  return (
    e.code === code &&
    mod === mods.has("Mod") &&
    e.altKey === mods.has("Alt") &&
    e.shiftKey === mods.has("Shift")
  );
}

export const PAPER_COMMANDS: PaperCommandRow[] = [
  // NOTE: the ⌘K chord itself moved to the SHELL (Workspace.svelte), which
  // routes it back here via commandBus.paperPaletteRequest while Paper is
  // focused — a row here too would double-fire and net to a no-op.
  {
    id: "view-toggle",
    title: (c) => (c.previewActive() ? "Switch to Edit" : "Switch to Preview"),
    keys: ["Mod+Shift+KeyE"],
    owner: "window",
    keywords: "preview edit render",
    run: (c) => c.togglePreview(),
  },
  { id: "view-continuous", title: () => "Continuous view", hint: "View", keywords: "scroll column", owner: "none", run: (c) => c.setView("continuous") },
  { id: "view-paginated", title: () => "Paginated view", hint: "View", keywords: "page sheets print", owner: "none", run: (c) => c.setView("paginated") },
  {
    id: "cite-style-numeric",
    title: () => "Citation style: numbered (Vancouver)",
    hint: "References",
    keywords: "citation numeric vancouver brackets [1] style",
    owner: "none",
    run: (c) => c.setCitationStyle("numeric"),
  },
  {
    id: "cite-style-authoryear",
    title: () => "Citation style: author–year",
    hint: "References",
    keywords: "citation author year apa harvard style",
    owner: "none",
    run: (c) => c.setCitationStyle("author-year"),
  },
  {
    id: "toggle-vim",
    title: (c) => (c.vimFlavor() === "off" ? "Enable Vim mode" : "Disable Vim mode"),
    hint: "Editor",
    keywords: "vim modal hjkl normal insert keyboard",
    owner: "none",
    run: (c) => c.setVimFlavor(c.vimFlavor() === "off" ? "vim" : "off"),
  },
  {
    id: "toggle-flux-vim",
    title: (c) =>
      c.vimFlavor() === "flux"
        ? "Switch to plain Vim"
        : c.vimFlavor() === "vim"
          ? "Switch to flux-Vim (jj → Esc)"
          : "Enable flux-Vim (jj → Esc)",
    hint: "Editor",
    keywords: "vim flux flavor jj escape insert normal modal",
    owner: "none",
    run: (c) => c.setVimFlavor(c.vimFlavor() === "flux" ? "vim" : "flux"),
  },
  { id: "insert-figure", title: () => "Insert figure…", hint: "Insert", keywords: "image panel embed", owner: "none", run: (c) => c.openFigurePicker() },
  { id: "insert-figref", title: () => "Reference a figure…", hint: "@@", keywords: "crossref cross-reference cite figure panel fig", owner: "none", run: (c) => c.openFigRefPicker() },
  {
    id: "toggle-outliner",
    title: (c) => (c.outlinerOpen() ? "Hide left panel" : "Show left panel"),
    keys: ["Alt+KeyO"],
    owner: "window",
    keywords: "outline toc headings sections documents sidebar left panel",
    run: (c) => c.toggleOutliner(),
  },
  {
    id: "toggle-margin",
    title: (c) => (c.marginOpen() ? "Hide dynamic margin" : "Show dynamic margin"),
    // Mod+Shift+B joins for cross-mode consistency: it toggles the right rail
    // in figure + slide (keyboard.ts), so it toggles paper's right rail too.
    // (Verified absent from CM_CHORD_STRINGS — verify-paper-commands gates it.)
    keys: ["Alt+KeyD", "Mod+Shift+KeyB"],
    owner: "window",
    keywords: "panel margin sidebar dynamic right rail",
    run: (c) => c.toggleMargin(),
  },
  { id: "margin-search", title: () => "Search references…", keys: ["Alt+KeyR"], owner: "window", keywords: "find cite reference bibliography", run: (c) => c.summonPane("reference-search") },
  { id: "edit-citation", title: () => "Edit citation at cursor", keys: ["Alt+KeyC"], owner: "window", keywords: "citation group edit references multi cite", run: (c) => c.editCitationAtCursor() },
  { id: "margin-citation-group", title: () => "Citation group", hint: "Margin", keywords: "edit citation group cite references multi", owner: "none", run: (c) => c.summonPane("citation-group") },
  { id: "margin-references", title: () => "References", hint: "Margin", keywords: "bibliography citations library", owner: "none", run: (c) => c.summonPane("bibliography") },
  { id: "margin-journal-check", title: () => "Journal Check", keys: ["Alt+KeyJ"], owner: "window", keywords: "journal style nature compliance limits check submission", run: (c) => c.summonPane("journal-check") },
  { id: "add-doi-library", title: () => "Add DOI to FluxLib", hint: "Reference", keywords: "doi reference library fluxlib add paper crossref import", owner: "none", run: (c) => c.openDoiPrompt("library") },
  { id: "add-doi-cite", title: () => "Add DOI & cite here", hint: "Reference", keywords: "doi cite citation reference insert crossref", owner: "none", run: (c) => c.openDoiPrompt("cite") },
  { id: "margin-figures", title: () => "Figures", keys: ["Alt+KeyF"], owner: "window", keywords: "image plot zoom panel", run: (c) => c.summonPane("figure") },
  { id: "margin-comments", title: () => "Comments", keys: ["Alt+KeyA"], owner: "window", keywords: "notes annotations review", run: (c) => c.summonPane("comments") },
  {
    id: "comment-selection",
    title: () => "Comment on selection",
    hint: CM_HINTS.commentSelection, // real binding: editing keymap layer
    keywords: "annotate note review remark",
    owner: "cm",
    run: (c) => c.startComment(),
  },
  { id: "margin-stats", title: () => "Statistics", hint: "Margin", keywords: "word count length", owner: "none", run: (c) => c.summonPane("stats") },
  {
    id: "margin-terminal",
    title: () => "Terminal",
    // BOTH chords on one row — the old palette advertised Alt+T only.
    keys: ["Alt+KeyT", "Mod+Backquote"],
    owner: "window",
    keywords: "shell console command cli bash zsh run",
    run: (c) => c.summonPane("terminal"),
  },
  { id: "margin-close-pane", title: () => "Close margin pane", keys: ["Alt+KeyP"], owner: "window", keywords: "dynamic pane close dismiss", run: (c) => c.closeActivePane() },
  { id: "margin-close-all", title: () => "Clear dynamic margin", keys: ["Mod+Alt+KeyP"], owner: "window", keywords: "close all panes clear margin dismiss", run: (c) => c.closeAllPanes() },
  { id: "margin-bg-seed", title: () => "New background seed", hint: "Margin", keywords: "dynamic background reroll shuffle random art", owner: "none", run: (c) => c.rerollBgSeed() },
  { id: "fold-section", title: () => "Fold section", hint: CM_HINTS.foldSection, keywords: "collapse heading hide section fold", owner: "cm", run: (c) => c.foldSection() },
  { id: "unfold-section", title: () => "Unfold section", hint: CM_HINTS.unfoldSection, keywords: "expand heading show section unfold", owner: "cm", run: (c) => c.unfoldSection() },
  { id: "fold-all", title: () => "Fold all sections", hint: "Fold", keywords: "collapse everything outline overview", owner: "none", run: (c) => c.foldAll() },
  { id: "unfold-all", title: () => "Unfold all sections", hint: "Fold", keywords: "expand everything", owner: "none", run: (c) => c.unfoldAll() },
  // Table editing (real bindings: editing/tableOps.ts tableKeymap — CM layer).
  { id: "table-row-below", title: () => "Table: add row below", hint: CM_HINTS.tableRowBelow, keywords: "table insert row below add", owner: "cm", run: (c) => c.tableCmd("row-below") },
  { id: "table-row-above", title: () => "Table: add row above", hint: "Table", keywords: "table insert row above add", owner: "none", run: (c) => c.tableCmd("row-above") },
  { id: "table-delete-row", title: () => "Table: delete row", hint: CM_HINTS.tableDeleteRow, keywords: "table remove delete row", owner: "cm", run: (c) => c.tableCmd("delete-row") },
  { id: "table-col-right", title: () => "Table: add column right", hint: CM_HINTS.tableColRight, keywords: "table insert column right add", owner: "cm", run: (c) => c.tableCmd("col-right") },
  { id: "table-col-left", title: () => "Table: add column left", hint: "Table", keywords: "table insert column left add", owner: "none", run: (c) => c.tableCmd("col-left") },
  { id: "table-delete-col", title: () => "Table: delete column", hint: CM_HINTS.tableDeleteCol, keywords: "table remove delete column", owner: "cm", run: (c) => c.tableCmd("delete-col") },
  { id: "table-align", title: () => "Table: cycle column alignment", hint: CM_HINTS.tableAlign, keywords: "table align left center right column", owner: "cm", run: (c) => c.tableCmd("align") },
  { id: "table-format", title: () => "Table: format (align the pipes)", hint: "Table", keywords: "table format tidy align pipes pretty", owner: "none", run: (c) => c.tableCmd("format") },
  { id: "paste-as-table", title: () => "Paste as table (TSV/CSV)", hint: "Table", keywords: "table paste csv tsv excel sheets convert clipboard", owner: "none", run: (c) => c.pasteAsTable() },
  { id: "margin-wider", title: () => "Wider side panel", hint: "Layout", keywords: "margin panel resize grow", owner: "none", run: (c) => c.widerMargin() },
  { id: "margin-narrower", title: () => "Narrower side panel", hint: "Layout", keywords: "margin panel resize shrink", owner: "none", run: (c) => c.narrowerMargin() },
  // One row instead of the old per-format trio: format and journal style are
  // now picked in the dialog, so a palette row per format would multiply out.
  { id: "export", title: () => "Export…", hint: "Export", keywords: "download print pdf word docx html journal style nature", owner: "window", keys: ["Alt+KeyE"], run: (c) => c.openExportDialog() },
];

/** Palette entries generated from the table (dynamic rows appended by PaperMode). */
export function paletteFromTable(ctx: PaperCmdCtx): {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}[] {
  return PAPER_COMMANDS.filter((r) => r.palette !== false).map((r) => ({
    id: r.id,
    title: r.title(ctx),
    hint: r.hint ?? (r.owner === "window" && r.keys?.length ? r.keys.map(chordHint).join(" · ") : undefined),
    keywords: r.keywords,
    run: () => r.run(ctx),
  }));
}

/** Table-driven window dispatcher. Returns true when a chord fired. */
export function dispatchWindowKey(e: KeyboardEvent, ctx: PaperCmdCtx): boolean {
  for (const row of PAPER_COMMANDS) {
    if (row.owner !== "window" || !row.keys) continue;
    for (const chord of row.keys) {
      if (matchesChord(e, chord)) {
        e.preventDefault();
        row.run(ctx);
        return true;
      }
    }
  }
  return false;
}
