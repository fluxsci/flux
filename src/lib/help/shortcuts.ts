// The keyboard reference's content and the small notation it is written in. Pure (no DOM, no
// stores): Help.svelte draws it, verify-help-shortcuts.ts checks it, and the search runs on it.
//
// NOTATION — one string per row, read by `keyPieces`:
//   +      joins a chord                      Mod+Shift+M
//   " / "  separates alternatives             Alt+A / Alt+B
//   " – "  a run                              Mod+1 – Mod+5
//   " · "  separate things in one row         R / C / G · Plus / Minus
// A token that names a key becomes a key cap; anything else (click, drag, wheel, "a mode icon")
// is a gesture and is drawn as words. Write keys with these names:
//   Mod    Ctrl on Windows/Linux, ⌘ on macOS (what `e.ctrlKey || e.metaKey` accepts)
//   Ctrl   the Control key on every platform (⌃ on macOS)
//   Alt    ⌥ Option on macOS            Shift   ⇧ on macOS
//   Up Down Left Right Arrows Enter Esc Tab Space Delete Backspace Home End PageUp PageDown
//   Plus Minus Slash (the + − / keys, which the notation itself uses)
// A row may carry `mac`, a different chord on macOS.

export type SectionId = "global" | "figure" | "slide" | "paper" | "library" | "reader";
export interface ShortcutRow {
  keys: string;
  does: string;
  /** The chord on macOS when it is not just Mod → ⌘. */
  mac?: string;
}
export interface ShortcutGroup {
  title: string;
  /** When the group's keys apply, if not always: "while Inbox is open". */
  when?: string;
  rows: ShortcutRow[];
}
export interface ShortcutSection {
  id: SectionId;
  label: string;
  groups: ShortcutGroup[];
}

const r = (keys: string, does: string, mac?: string): ShortcutRow => (mac ? { keys, does, mac } : { keys, does });

export const SECTIONS: ShortcutSection[] = [
  {
    id: "global",
    label: "Global",
    groups: [
      {
        title: "Everywhere",
        rows: [
          r("?", "Show or hide this reference (on the Home screen too)"),
          r("Mod+K", "Command palette (Paper: the full Paper palette; Library: the add box)"),
          r("Mod+1 – Mod+5", "Switch mode (Figure, Slide, Paper, Library, Reader)"),
          r("click a mode icon", "Switch mode"),
          r("Alt+click a mode icon", "Open that mode in a split pane", "Alt+click / Mod+click a mode icon"),
          r("Mod+Shift+N", "New window: a second project side by side"),
          r("Mod+Z / Mod+Shift+Z", "Undo / redo, in Figure, Slide and Paper"),
          r("Esc", "Back out one level: a gesture, a sub-mode, a pane, an overlay"),
          r("click the Flux wordmark", "Back to the Home screen"),
          r("Left / Right", "On a focused divider between two panes: resize them (Shift: bigger steps)"),
        ],
      },
      {
        title: "Agents",
        rows: [
          r("Alt+Q", "Open or close Inbox: annotations and margin comments"),
          r("Mod+Shift+M", "Annotate: a note and a picture for your agents"),
          r("Mod+Shift+J", "Ask about this: a read-only question to Claude Code or Codex"),
        ],
      },
      {
        title: "Inbox",
        when: "while Inbox is open",
        rows: [
          r("Up / Down", "Move between rows"),
          r("Enter", "Jump to the row's saved location"),
          r("R", "Reply"),
          r("A", "Assign the selected item"),
          r("E", "Archive or unarchive the selected item"),
          r("Enter / Shift+Enter", "In Reply: send / new line"),
          r("?", "Show the filter grammar and keys"),
          r("Esc", "Close what is open inside it (a picker, the help, a zoomed image), then Inbox"),
        ],
      },
      {
        title: "Annotate",
        when: "while Annotate is open",
        rows: [
          r("Alt+A / Alt+B / Alt+P", "Arrow / box / pen: drag on the picture to mark a target"),
          r("Alt+Z", "Undo the last mark (Backspace in an empty note does the same)"),
          r("Alt+Up / Alt+Down", "Widen / narrow the hovered target (the wheel over the picture too)"),
          r("Tab", "In the note: change who it goes to"),
          r("Enter / Shift+Enter", "Add the annotation / new line"),
          r("Esc", "Close the recipient menu, then cancel and keep the draft (Annotate's own chord too)"),
        ],
      },
      {
        title: "Ask",
        when: "while Ask is open",
        rows: [
          r("Enter / Shift+Enter", "Send / new line"),
          r("Esc", "While it answers: stop and keep what arrived. Otherwise: discard the exchange"),
        ],
      },
    ],
  },
  {
    id: "figure",
    label: "Figure",
    groups: [
      {
        title: "Tools",
        rows: [
          r("V", "Select"),
          r("K", "Scale"),
          r("H", "Pan (hand)"),
          r("T", "Text"),
          r("Alt+R", "Rectangle"),
          r("O", "Ellipse"),
          r("L / Shift+L", "Line / arrow"),
          r("P", "Pen (Enter or a double-click finishes, Esc drops the draft)"),
        ],
      },
      {
        title: "Canvas",
        rows: [
          r("wheel", "Pan"),
          r("Shift+wheel", "Pan sideways"),
          r("Mod+wheel", "Zoom at the pointer"),
          r("Space+drag", "Pan (the middle button too)"),
          r("Alt", "Held, with a selection: measure the distance to whatever the pointer is over"),
          r("Shift+R / Shift+G", "Rulers / background grid"),
          r("Mod+B", "Hide or show the left sidebar (bold wins when text is selected)"),
          r("Mod+Shift+B", "Hide or show the right rail (Inspector)"),
          r("drag a rail edge", "Resize the sidebar or Inspector (double-click resets)"),
        ],
      },
      {
        title: "Select and move",
        rows: [
          r("drag empty canvas", "Marquee select"),
          r("Shift+click", "Add to or remove from the selection"),
          r("double-click", "Go in: a group's inside, a text's editor, a plot's part, a path's nodes"),
          r("Mod+click a plot", "Select the part under the pointer (holding the key previews it)"),
          r("Mod+Shift+click a part", "Add or drop a part in the pick"),
          r("Mod+drag in a plot", "Marquee the plot's parts (Shift adds)"),
          r("drag inside the box", "Move the selection (Alt: no snapping · Shift: along one axis)"),
          r("Alt+drag", "Duplicate"),
          r("drag an edge or corner", "Resize (Alt: about the centre · Shift: keep the aspect)"),
          r("drag outside a corner", "Rotate (Shift snaps to 15°)"),
          r("Mod+drag a handle", "Crop (the content stays pinned; reset in the Inspector)"),
          r("Arrows", "Nudge by 1 px (Shift: 10 px); a drilled plot part too"),
          r("Mod+A", "Select all"),
          r("Mod+Alt+A", "Select everything with the same fill (Shift: in the whole project)"),
        ],
      },
      {
        title: "Inspect and style",
        rows: [
          r("F", "Property menu beside the selection: a letter arms a row, the wheel or the arrows adjust it, Enter or Space applies"),
          r("R", "X-ray the selected plots or group"),
          r("Shift+Alt+R", "X-ray the drilled part's family (one tick label → all tick labels)"),
          r("X", "Hide or show the selection (or the drilled plot part)"),
          r("D", "Dissect: the selected plot's companion material"),
          r("Alt+M / Shift+Alt+M", "Figure-Meta / open it pinned (Paper too)"),
          r("Alt+L", "Mark the selected text as a panel label"),
          r("Mod+B / Mod+I / Mod+U", "Bold / italic / underline on text and text-like plot parts"),
          r("Mod+Alt+C / Mod+Alt+V", "Copy style / paste style"),
          r("Mod+P", "Insert a design preset"),
        ],
      },
      {
        title: "Align and arrange",
        rows: [
          r("A", "Align & Arrange, on Align: W / A / S / D edges, H / V centres, Shift+H / Shift+V even spacing, X / Y plot spines"),
          r("Alt+T", "Align & Arrange, on Arrange: pink gap guides and a fixed point"),
          r("Space", "Switch between Align and Arrange while the tool is open"),
          r("R / C / G · Plus / Minus", "In Arrange: row / column / grid · more / fewer rows"),
          r("1 / 2 / 3", "In Arrange: fix the start / centre / end"),
          r("Enter / Esc", "Keep / cancel what the tool did on this visit"),
          r("Shift+A", "Crystallize: snap a loose selection into its row, column or grid (plots on their axes)"),
          r("Shift+Alt+A", "Crystallize by bounding box"),
          r("Alt+A / Alt+W / Alt+S / Alt+D", "Align left / top / bottom / right"),
          r("Alt+H / Alt+V", "Centre horizontally / vertically"),
          r("Shift+H / Shift+V", "Flip horizontally / vertically"),
          r("[ / ]", "Send to back / bring to front"),
          r("Mod+[ / Mod+]", "One step back / forward"),
          r("Mod+G / Mod+Shift+G", "Group / ungroup"),
          r("Mod+Shift+I", "Bring the selection inside the frame (never resizes)"),
          r("Mod+Shift+C", "Cascade a stepped change across the selection"),
        ],
      },
      {
        title: "Edit",
        rows: [
          r("Mod+Z", "Undo"),
          r("Mod+Shift+Z / Mod+Y", "Redo"),
          r("Mod+X / Mod+C / Mod+V", "Cut / copy / paste"),
          r("Mod+D", "Duplicate (repeats continue the offset)"),
          r("Mod+Shift+L", "Lock or unlock"),
          r("Delete / Backspace", "Delete the selection"),
        ],
      },
      {
        title: "Text",
        when: "while editing text",
        rows: [
          r("Mod+B / Mod+I / Mod+U", "Bold / italic / underline: the selected part, or what you type next"),
          r("Mod+. / Mod+,", "Superscript / subscript"),
          r("Esc", "Leave the text"),
        ],
      },
      {
        title: "Figures and files",
        rows: [
          r("Mod+S", "Save"),
          r("Mod+O", "Open a project"),
          r("Mod+R", "Name the figure: family, number, nickname"),
          r("Mod+click / Shift+click a figure's row", "Pick several figures in the sidebar (Shift: a run)"),
          r("Alt+Up / Alt+Down", "Move the figure up / down the sidebar's list (dragging a row does the same)"),
          r("Alt+drag a figure's title", "Duplicate the whole figure in its family"),
          r("Mod+Shift+K", "Import image files"),
        ],
      },
      {
        title: "Layers",
        when: "with the Layers list focused",
        rows: [
          r("Up / Down / Home / End", "Move through the layers"),
          r("Left / Right", "Fold / unfold a group"),
          r("F2", "Rename the layer or group"),
        ],
      },
      {
        title: "Plots",
        rows: [
          r("Alt+G", "Sidebar: Plots / Layers (a hidden sidebar opens to Plots)"),
          r("Alt+Slash", "Open or close the folder navigator, beside the rail"),
          r("Alt+1 / Alt+2", "Plots view or gallery: this project's plots / your global library"),
          r("Shift+Alt+G", "Plot gallery in its own window"),
          r("Alt+Shift+C", "Copy the selected plots' full source paths"),
        ],
      },
      {
        title: "Plots view",
        when: "with the Plots view focused",
        rows: [
          r("Slash", "Search (typing in the grid does the same)"),
          r("Down / Enter", "From the search: into the grid"),
          r("Arrows · Home / End · PageUp / PageDown", "Move through the plots"),
          r("Enter", "Place the plot, or open a stack of variants"),
          r("Mod+Enter", "On a stack: place it instead of opening it"),
          r("Space", "Quick look at the plot"),
          r("Shift+Space", "Peek at the plot: its size, source and notes"),
          r("Mod+A", "Select every plot shown"),
          r("Mod+Plus / Mod+Minus", "Bigger / smaller thumbnails"),
          r("Backspace", "Step out: of similar names, a folder shown alone, a collection"),
          r("Esc", "Clear the search, then step out, then leave the view"),
        ],
      },
      {
        title: "Folder navigator",
        when: "after Alt+/ on the Plots view",
        rows: [
          r("type", "Search the folders: matches are marked, the highlight goes to the first"),
          r("Up / Down", "Move the highlight (the caret stays in the search)"),
          r("Enter", "Show the highlighted folder's plots in the gallery"),
          r("Left / Right", "In the tree: fold, or step out to the parent / unfold, or step in"),
          r("Alt+click a folder's arrow", "Fold or unfold the whole branch"),
          r("Esc", "Clear the search, then close the navigator"),
        ],
      },
      {
        title: "Figure-Meta",
        when: "while Figure-Meta is open",
        rows: [
          r("Up / Down", "In the search: move through the figures"),
          r("Enter", "In the search: go to the chosen figure's first field"),
          r("Mod+S", "Save at once (captions also save as you leave a field)"),
          r("Mod+Z / Mod+Shift+Z", "Outside a field: undo / redo a metadata edit"),
          r("Mod+wheel", "Zoom the preview at the pointer"),
          r("Mod+0", "Fit the figure and its caption"),
          r("Shift+Alt+M", "Pin it in its own window"),
          r("Esc", "Close it"),
        ],
      },
      {
        title: "X-ray",
        when: "while the X-ray is open",
        rows: [
          r("Up / Down", "Move through the rows (Shift: extend the pick)"),
          r("Left / Right", "Fold, or step out to the parent / unfold, or step in to the first child"),
          r("S", "Search the rows"),
          r("Shift+click / Mod+click", "Pick several rows (a press-and-drag sweeps a run)"),
          r("A", "Pick the siblings"),
          r("Shift+A", "Pick the same part on every plot of the figure"),
          r("Mod+A / Alt+A", "Pick every row shown (after a search: every result)"),
          r("X", "Hide or show the pick"),
          r("Enter / F", "Open the pick's properties"),
          r("V", "On an axis row: the axis view"),
          r("Mod+Enter / double-click", "Make the row the root"),
          r("Backspace", "Clear the search, or go back to the previous root"),
          r("R / Esc", "Close the X-ray"),
        ],
      },
      {
        title: "Path nodes",
        when: "after Enter or a double-click on a path",
        rows: [
          r("V / P / D", "Edit nodes / pen (extend or merge at the ends) / delete nodes"),
          r("Ctrl+drag a segment", "Bend it"),
          r("Mod+A", "Select every node"),
          r("Delete / Backspace", "Delete the selected nodes"),
          r("Enter", "Finish"),
          r("Esc", "Step back out"),
        ],
      },
      {
        title: "Dissect viewer",
        when: "after D on a plot (on a slide too)",
        rows: [
          r("Arrows", "In the grid: move through the files"),
          r("Enter / Space", "In the grid: open the file"),
          r("[ / ]", "In the grid: smaller / bigger tiles"),
          r("1–9", "Jump to a section (with a file open: open its first file)"),
          r("Left / Right", "With a file open: flip to the previous / next file"),
          r("Up / Down", "With a file open: step to the previous / next group"),
          r("Home / End", "With a file open: the first / last file"),
          r("Enter", "On an open picture: fit ↔ 1:1"),
          r("Mod+wheel · Plus / Minus", "Zoom at the pointer · zoom in / out"),
          r("Space+drag · Shift+wheel", "Pan · pan sideways"),
          r("0", "Reset the zoom"),
          r("Mod+Enter / Mod+S", "In a note: save it"),
          r("Esc", "Step back out: open file → grid → closed"),
        ],
      },
      {
        title: "3D orbit",
        when: "after a double-click on a 3D model",
        rows: [
          r("drag / Shift+drag / Alt+drag", "Orbit / pan / roll"),
          r("wheel", "Zoom"),
          r("Arrows", "Turn 5° (Shift: 15°)"),
          r("1–6 · 0", "Axis views · home"),
          r("P", "Orthographic / perspective"),
          r("Enter / Esc", "Finish / cancel"),
        ],
      },
    ],
  },
  {
    id: "slide",
    label: "Slide",
    groups: [
      {
        title: "Stage",
        rows: [
          r("F5 / Shift+F5", "Present from the start / from this slide"),
          r("Down / Up · PageDown / PageUp", "Next / previous slide, with nothing selected"),
          r("F2", "Rename the slide"),
          r("Space / Esc", "While a preview plays on the stage: pause or resume / stop"),
          r("Alt+G", "Left rail: Plots / Slides"),
          r("Mod+B", "Hide or show the left rail (bold wins when text is selected)"),
          r("Mod+Shift+B", "Hide or show the right rail"),
          r("every Figure key", "Works on the stage: tools, select, align, arrange, X-ray, plots (naming and ordering figures aside)"),
        ],
      },
      {
        title: "Animate",
        when: "with the animator open",
        rows: [
          r("Mod+Shift+A", "Add an appearance for the selection"),
          r("Mod+Shift+D", "Add a disappearance"),
          r("Mod+Shift+C", "Change: add one, or switch between Before and After"),
          r("B / Mod+Shift+E", "Become: pick what the selection turns into (B opens the animator if needed)"),
          r("Mod+Alt+G", "Ghost: copies that transform on their own"),
          r("Mod+Alt+A", "Appear from…: pick what the selection appears from"),
          r("Mod+Alt+C", "Cascade across the selected tracks (fewer than two: across the selected objects)"),
          r("Esc", "Leave a Before / After edit"),
        ],
      },
      {
        title: "Picking for Become",
        when: "while a Become or Appear from… pick is armed",
        rows: [
          r("click", "Pick or unpick the part or object under the pointer"),
          r("Alt+click", "Pick the whole plot or group"),
          r("drag / Alt+drag", "Pick everything inside / remove it"),
          r("double-click", "Pick it and confirm at once"),
          r("A", "Widen the last pick to its siblings"),
          r("K", "Keep the source: it stays on the slide"),
          r("Backspace / Delete", "Drop the last pick"),
          r("R", "X-ray the hovered plot; its rows join or leave the pick"),
          r("Shift+Alt+R", "X-ray it with the picks' families"),
          r("Space / Enter", "Confirm the pick"),
          r("Esc", "Cancel without making a transform"),
        ],
      },
      {
        title: "Animator dock",
        when: "with the dock focused",
        rows: [
          r("Left / Right", "Previous / next beat"),
          r("Up / Down", "Previous / next track"),
          r("Space", "Play or pause"),
          r("Enter", "Jump to the track's fields"),
          r("P / D / T / G / E", "Effect / duration / start / stagger / easing"),
          r("Alt+Left / Alt+Right", "Nudge the start"),
          r("Alt+Shift+Left / Alt+Shift+Right", "Change the duration"),
          r("Alt+A / Alt+D", "Align starts / ends (again: the next lane above · Shift resizes)"),
          r("[ / ]", "Move the track to the previous / next beat"),
          r("Mod+D", "Duplicate tracks"),
          r("Mod+G / Mod+Shift+G", "Group / ungroup tracks"),
          r("Mod+A", "Select this step's effects"),
          r("X", "Disable the track"),
          r("Delete / Backspace", "Remove the track"),
          r("Shift+click / Mod+click a track", "Add it to the selection"),
          r("Alt+drag a bar", "Copy it to another step or row (Alt also turns snapping off)"),
          r("Mod+drag a bar's left edge", "Make it follow another effect's start or end"),
          r("Mod+Alt+drag a bar", "Onto another lane: inherit that effect's animation (Shift: its start too)"),
          r("Mod+wheel", "Zoom the timeline"),
          r("Esc", "Stop the preview, or clear the selection and leave Before / After"),
          r("M", "In the X-ray: animate the picked rows (then 1–6 chooses how)"),
        ],
      },
      {
        title: "Easing editor",
        rows: [
          r("1–9", "Choose a tile in the focused group"),
          r("Arrows", "Move a focused bezier handle by 0.01 (Shift: 0.1)"),
          r("Mod+V", "Paste a curve"),
          r("Enter / Esc", "Commit / restore the opening curve"),
        ],
      },
      {
        title: "Presenting",
        rows: [
          r("Right / Space / PageDown", "Next step (Shift: next slide)"),
          r("Left / Backspace / PageUp", "Previous step (Shift: previous slide)"),
          r("Up / Down", "Whole slides"),
          r("Home / End", "First / last slide"),
          r("type a number, Enter", "Jump to that slide"),
          r("B / W", "Blank the screen black / white"),
          r("S", "Presenter notes"),
          r("F", "Full screen"),
          r("R", "Reset the timer"),
          r("M", "Reduce motion"),
          r("click", "The left quarter of the screen goes back, anywhere else forward"),
          r("Esc", "Stop presenting"),
        ],
      },
    ],
  },
  {
    id: "paper",
    label: "Paper",
    groups: [
      {
        title: "Editing & view",
        rows: [
          r("Mod+K", "Command palette: everything is here"),
          r("Mod+Shift+E", "Switch between editing and the full-width preview (Esc leaves the preview)"),
          r("Mod+Z", "Undo"),
          r("Mod+Shift+Z / Mod+Y", "Redo"),
          r("Mod+F", "Find, with replace in the same bar (Enter / Shift+Enter step through the matches)"),
          r("F3 / Mod+G", "Next match"),
          r("Shift+F3 / Mod+Shift+G", "Previous match"),
          r("Mod+D", "Select the next occurrence of the selection"),
          r("Mod+Shift+L", "Select every occurrence of the selection"),
          r("Mod+Alt+G", "Go to a line"),
          r("Ctrl+Shift+[ / Ctrl+Shift+]", "Fold / unfold the current section", "Mod+Alt+[ / Mod+Alt+]"),
          r("Ctrl+Alt+[ / Ctrl+Alt+]", "Fold / unfold every section"),
          r("Mod+Plus / Mod+Minus", "Bigger / smaller text"),
          r("Mod+0", "Text size back to 100%"),
          r("Mod+Enter", "Follow what is under the caret: a figure reference, a citation"),
        ],
      },
      {
        title: "Formatting",
        rows: [
          r("Mod+B / Mod+I / Mod+E", "Bold / italic / inline code"),
          r("Mod+. / Mod+,", "Superscript / subscript (again to remove)"),
          r("Mod+Shift+1 – Mod+Shift+4", "Heading level"),
          r("Mod+Shift+0", "Back to a paragraph"),
          r("Mod+Shift+8 / Mod+Shift+7", "Bullet list / numbered list"),
          r("Mod+Shift+.", "Block quote"),
          r("Mod+Shift+K", "Insert a link"),
          r("@ / @@", "Typing: cite / pick a figure to reference"),
          r("Slash", "Typing, at the start of a line: the block palette"),
          r("Ctrl+Space", "Open the suggestions for what you are typing"),
        ],
      },
      {
        title: "Lines",
        rows: [
          r("Alt+Up / Alt+Down", "Move the line up / down"),
          r("Shift+Alt+Up / Shift+Alt+Down", "Copy the line up / down"),
          r("Mod+[ / Mod+]", "Indent less / more (nests a list item)"),
          r("Mod+Alt+Up / Mod+Alt+Down", "Add a caret above / below"),
          r("Mod+Slash", "Turn the line into a comment and back"),
        ],
      },
      {
        title: "Panels",
        rows: [
          r("Alt+O", "Left panel: documents and outline (drag its edge to resize)"),
          r("Mod+Shift+B", "Dynamic margin"),
          r("Alt+R", "Reference search"),
          r("Alt+F", "Figures"),
          r("Alt+A", "Comments"),
          r("Alt+J", "Journal Check"),
          r("Alt+K", "Manuscript Check"),
          r("Alt+P / Mod+Alt+P", "Close the active pane / close them all"),
          r("Alt+E", "Export: file format and journal style"),
          r("Alt+M", "Figure-Meta"),
        ],
      },
      {
        title: "Documents and outline",
        when: "with the left panel focused",
        rows: [
          r("Up / Down / Home / End", "Move through the rows"),
          r("Right / Left", "Unfold / fold a folder or a heading, or step into / out of it"),
          r("Enter", "Open the document, or jump to the heading"),
          r("type", "In the filter: narrow the documents (Enter opens the first, Down goes into the list, Esc clears)"),
          r("Alt+Up / Alt+Down", "Move a document up / down the list (dragging the row does the same)"),
          r("Delete", "Delete the focused document, after a confirmation"),
        ],
      },
      {
        title: "Margin panes",
        when: "with a pane focused",
        rows: [
          r("Up / Down · PageUp / PageDown", "Reference search: move through the results"),
          r("Space", "Reference search: mark several references"),
          r("Enter", "Reference search: cite the marked references, or the highlighted one"),
          r("Backspace", "Reference search: unmark · citation editor: remove a reference"),
          r("Mod+Enter", "Comments: post the comment"),
          r("Esc", "Back to the editor"),
        ],
      },
      {
        title: "References and figures",
        rows: [
          r("Alt+C", "Edit the citation at the caret"),
          r("Mod+Alt+M", "Comment on the selection"),
          r("Mod+Alt+Minus / Mod+Alt+Plus", "Figure width down / up, with the caret on its line"),
          r("Alt+D / Shift+Alt+D", "Add or remove the selected word in your personal / the project's dictionary"),
          r("Shift+Alt+W", "Word tools for the selected word: dictionaries and aliases"),
        ],
      },
      {
        title: "Tables",
        when: "with the caret in a table",
        rows: [
          r("Tab / Shift+Tab", "Next / previous cell (Tab past the last cell adds a row)"),
          r("Enter", "Add a row below (on an empty last row: leave the table)"),
          r("Mod+Alt+R / Mod+Alt+Shift+R", "Add a row below / delete the row"),
          r("Mod+Alt+C / Mod+Alt+Shift+C", "Add a column to the right / delete the column"),
          r("Mod+Alt+A", "Change the column's alignment"),
        ],
      },
    ],
  },
  {
    id: "library",
    label: "Library",
    groups: [
      {
        title: "Search and move",
        rows: [
          r("type", "Search, from anywhere in the list"),
          r("Up / Down", "Move the row highlight (Down from the search enters the list, Up from the top returns)"),
          r("Enter", "Copy the highlighted row's citation key"),
          r("Space", "Tick the row"),
          r("Esc", "Back to the search box"),
          r("Mod+K", "Jump to the add box"),
        ],
      },
      {
        title: "Actions",
        rows: [
          r("Alt+F", "Fetch PDFs for the ticked rows"),
          r("Alt+Delete / Alt+Backspace", "Delete the ticked (or highlighted) rows, with Undo"),
          r("Enter", "In the add box: add the DOI or URL"),
          r("click a row", "Copy its citation key"),
          r("Mod+click a row", "Details"),
          r("Mod+Shift+click a row", "Open the PDF, fetching it if needed"),
          r("Alt+click a row", "Open the DOI"),
        ],
      },
    ],
  },
  {
    id: "reader",
    label: "Reader",
    groups: [
      {
        title: "Read",
        rows: [
          r("PageUp / PageDown", "Previous / next page"),
          r("Home / End", "First / last page"),
          r("Plus / Minus", "Zoom in / out"),
          r("0", "Fit the width"),
          r("Mod+wheel", "Zoom at the pointer"),
          r("Mod+F", "Search this PDF (Enter / Shift+Enter step through the matches)"),
        ],
      },
      {
        title: "Tabs",
        rows: [
          r("Ctrl+Tab / Ctrl+Shift+Tab", "Next / previous tab"),
          r("Ctrl+PageDown / Ctrl+PageUp", "Next / previous tab"),
          r("Ctrl+W", "Close the tab (a middle-click on it too)"),
          r("Alt+click a tab", "Open that paper in a split pane", "Alt+click / Mod+click a tab"),
          r("drag a tab", "Reorder the tabs"),
        ],
      },
      {
        title: "Panels",
        rows: [
          r("Mod+B / Mod+Shift+B", "Hide or show the left / right sidebar"),
          r("Alt+R", "Search your reference library (right sidebar)"),
          r("Alt+A", "Highlights (right sidebar)"),
          r("drag a sidebar edge", "Resize it (double-click resets)"),
        ],
      },
      {
        title: "Mark and collect",
        rows: [
          r("select text", "A menu by the selection: five highlight colours, Annotate, Ask"),
          r("Mod+Enter", "In a highlight's note: save it"),
          r("Alt+drag", "Pop a region of the page out into a floating panel"),
          r("Mod+Alt+drag", "Snip a region into plots/paper_snips, with its citation"),
          r("Enter / Esc", "After a snip: save it under the typed name / cancel"),
          r("Esc", "Close the topmost thing: the selection's menu, the PDF menu, a highlight's note"),
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Reading the notation

export type KeyPiece =
  | { kind: "key"; text: string }
  /** A gesture or other words: "click a plot", "wheel". */
  | { kind: "words"; text: string }
  /** A separator: "/" (or), "–" (to), "·" (and). */
  | { kind: "sep"; text: string };

/** How a named key is drawn: [Windows/Linux, macOS]. */
const CAPS: Record<string, [string, string]> = {
  Mod: ["Ctrl", "⌘"],
  Ctrl: ["Ctrl", "⌃"],
  Alt: ["Alt", "⌥"],
  Shift: ["Shift", "⇧"],
  Up: ["↑", "↑"],
  Down: ["↓", "↓"],
  Left: ["←", "←"],
  Right: ["→", "→"],
  Arrows: ["Arrows", "Arrows"],
  Enter: ["Enter", "↩"],
  Esc: ["Esc", "Esc"],
  Tab: ["Tab", "Tab"],
  Space: ["Space", "Space"],
  Delete: ["Delete", "Delete"],
  Backspace: ["Backspace", "⌫"],
  Home: ["Home", "Home"],
  End: ["End", "End"],
  PageUp: ["PgUp", "PgUp"],
  PageDown: ["PgDn", "PgDn"],
  Plus: ["+", "+"],
  Minus: ["−", "−"],
  Slash: ["/", "/"],
};
/** A single character, an F-key, or a run of digits such as 1–9 is a key; longer text is a gesture. */
const isKeyName = (token: string) => token in CAPS || [...token].length === 1 || /^F\d{1,2}$/.test(token) || /^\d–\d$/.test(token) || token === "@@";

function chordPieces(chord: string, mac: boolean, out: KeyPiece[]) {
  for (const token of chord.split("+").map((t) => t.trim()).filter(Boolean)) {
    if (token in CAPS) out.push({ kind: "key", text: CAPS[token][mac ? 1 : 0] });
    else if (isKeyName(token)) out.push({ kind: "key", text: token });
    else {
      // "click a plot": words after the last key of the chord. Join consecutive word tokens.
      const last = out.at(-1);
      if (last?.kind === "words") last.text += ` ${token}`;
      else out.push({ kind: "words", text: token });
    }
  }
}

const MODIFIERS = new Set(["Mod", "Ctrl", "Alt", "Shift"]);
const modifiersOf = (chord: string) => chord.split("+").map((t) => t.trim()).filter((t) => MODIFIERS.has(t)).join("+");
/** A run of three or more alternatives under the same modifiers is drawn Alt A / W / S / D. */
function withoutRepeatedModifiers(alternatives: string[]): string[] {
  if (alternatives.length < 3 || alternatives.some((a) => a.includes(" – "))) return alternatives;
  const held = modifiersOf(alternatives[0]);
  if (!held || alternatives.some((a) => modifiersOf(a) !== held)) return alternatives;
  return alternatives.map((a, i) => (i ? a.split("+").map((t) => t.trim()).filter((t) => !MODIFIERS.has(t)).join("+") : a));
}

/**
 * The pieces to draw for a row's keys on this platform. `spelled` keeps every alternative's
 * modifiers (for search and screen readers); the drawn form drops the repeats.
 */
export function keyPieces(row: ShortcutRow, mac: boolean, spelled = false): KeyPiece[] {
  const source = mac && row.mac ? row.mac : row.keys;
  const out: KeyPiece[] = [];
  source.split(" · ").forEach((item, i) => {
    if (i) out.push({ kind: "sep", text: "·" });
    const alternatives = item.split(" / ");
    (spelled ? alternatives : withoutRepeatedModifiers(alternatives)).forEach((alternative, j) => {
      if (j) out.push({ kind: "sep", text: "/" });
      alternative.split(" – ").forEach((end, k) => {
        if (k) out.push({ kind: "sep", text: "–" });
        // "Mod+click a plot": only the leading tokens are keys. Split the gesture's own words off
        // first so a one-letter word ("a") is never mistaken for the A key.
        const gesture = end.match(/^(.*?\+)?((?:double-|middle-)?(?:click|drag|wheel|type|select|every|hold)\b.*)$/);
        if (gesture) {
          if (gesture[1]) chordPieces(gesture[1], mac, out);
          out.push({ kind: "words", text: gesture[2] });
        } else chordPieces(end, mac, out);
      });
    });
  });
  return out;
}

/** The keys as plain text ("Ctrl+Shift+M"), for search and for screen readers. */
export function keyText(row: ShortcutRow, mac: boolean): string {
  let text = "";
  let previous: KeyPiece | undefined;
  for (const piece of keyPieces(row, mac, true)) {
    if (piece.kind === "sep") text += ` ${piece.text} `;
    else if (previous && previous.kind !== "sep") text += piece.kind === "words" ? ` ${piece.text}` : `+${piece.text}`;
    else text += piece.text;
    previous = piece;
  }
  return text;
}

export interface ShortcutHit {
  section: ShortcutSection;
  group: ShortcutGroup;
  row: ShortcutRow;
}

const fold = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
/** Query words: split on spaces; "ctrl+shift+m" stays one word so a chord can be typed as written. */
export const queryTerms = (query: string) => fold(query).split(" ").filter(Boolean);

/**
 * Every row matching all the query's words, in reading order. A word matches the keys (as drawn
 * on either platform, so "cmd", "ctrl" and "⌘" all find Mod), the description, or the group.
 */
export function searchShortcuts(query: string, mac: boolean): ShortcutHit[] {
  const terms = queryTerms(query).map((term) => (term === "cmd" || term === "command" ? "⌘" : term === "option" || term === "opt" ? "⌥" : term));
  if (!terms.length) return [];
  const hits: ShortcutHit[] = [];
  for (const section of SECTIONS) {
    for (const group of section.groups) {
      for (const row of group.rows) {
        const haystack = fold(`${keyText(row, mac)} ${keyText(row, !mac)} ${row.keys} ${row.does} ${group.title} ${group.when ?? ""} ${section.label}`);
        if (terms.every((term) => haystack.includes(term))) hits.push({ section, group, row });
      }
    }
  }
  return hits;
}

/** `text` cut into runs, the ones that match a query word marked, for drawing without innerHTML. */
export function markRuns(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const lower = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) spans.push([at, at + term.length]);
  }
  if (!spans.length) return [{ text, hit: false }];
  spans.sort((a, b) => a[0] - b[0]);
  const runs: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [from, to] of spans) {
    if (to <= cursor) continue;
    const start = Math.max(from, cursor);
    if (start > cursor) runs.push({ text: text.slice(cursor, start), hit: false });
    runs.push({ text: text.slice(start, to), hit: true });
    cursor = to;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), hit: false });
  return runs;
}

export const shortcutCount = () => SECTIONS.reduce((n, section) => n + section.groups.reduce((m, group) => m + group.rows.length, 0), 0);
