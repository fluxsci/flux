// The Dynamic Margin's pane registry. Every surface is a "dynamic pane" —
// summoned by hotkey or ⌘K, stacked vertically in the margin, splitting its
// height equally. Adding a pane is a single entry here (plus a hotkey branch
// in PaperMode if it earns one). Colors are the pane's outline/legend ink,
// matching the owner's color-coding: search blue, terminal green, comments
// magenta, figures cyan.

import type { PaneDescriptor } from "./types";
import StatsView from "./views/StatsView.svelte";
import FigureView from "./views/FigureView.svelte";
import BibliographyView from "./views/BibliographyView.svelte";
import CommentsView from "./views/CommentsView.svelte";
import TerminalView from "./views/TerminalView.svelte";
import ReferenceSearchPane from "./panes/ReferenceSearchPane.svelte";
import CitationGroupPane from "./panes/CitationGroupPane.svelte";
import { focus as focusTerminal } from "./terminalSession";

export const PANES: PaneDescriptor[] = [
  {
    id: "reference-search",
    title: "Reference Search",
    color: "var(--flx-blue-600)",
    hotkey: "Alt+R",
    component: ReferenceSearchPane,
  },
  {
    id: "terminal",
    title: "Terminal",
    color: "var(--flx-olive-600)",
    hotkey: "Alt+T",
    focus: focusTerminal,
    component: TerminalView,
  },
  {
    id: "comments",
    title: "Comments",
    color: "var(--flx-magenta-600)",
    hotkey: "Alt+A",
    badge: (h) => h.comments.count || null,
    component: CommentsView,
  },
  {
    id: "figure",
    title: "Figures",
    color: "var(--flx-cyan-600)",
    hotkey: "Alt+F",
    component: FigureView,
  },
  {
    id: "bibliography",
    title: "References",
    color: "var(--flx-purple-600)",
    badge: (h) => h.citedKeys.size || null,
    component: BibliographyView,
  },
  {
    id: "citation-group",
    title: "Citation Group",
    color: "var(--flx-orange-600)",
    hotkey: "Alt+C",
    component: CitationGroupPane,
  },
  {
    id: "stats",
    title: "Statistics",
    color: "var(--flx-yellow-600)",
    component: StatsView,
  },
];

export function paneById(id: string): PaneDescriptor | undefined {
  return PANES.find((p) => p.id === id);
}
