// The Dynamic Margin's view + pane registry (Redesign v2). Adding a context view
// or a conjurable pane is a single entry here. Views are mutually exclusive (the
// ViewRail switches them); panes stack on top and pop on Escape.

import type { ViewDescriptor, PaneDescriptor } from "./types";
import StatsView from "./views/StatsView.svelte";
import FigureView from "./views/FigureView.svelte";
import BibliographyView from "./views/BibliographyView.svelte";
import CommentsView from "./views/CommentsView.svelte";
import PomodoroView from "./views/PomodoroView.svelte";
import ReferencePdfView from "./views/ReferencePdfView.svelte";
import ReferenceSearchPane from "./panes/ReferenceSearchPane.svelte";
import { isStructured } from "./panes/refQuery";

export const VIEWS: ViewDescriptor[] = [
  { id: "figure", title: "Figures", icon: "image", keywords: "figure plot zoom panel", component: FigureView },
  {
    id: "bibliography",
    title: "References",
    icon: "bookOpen",
    keywords: "bibliography citations refs library",
    badge: (h) => h.citedKeys.size || null,
    component: BibliographyView,
  },
  {
    id: "comments",
    title: "Comments",
    icon: "message",
    keywords: "notes annotations review",
    badge: (h) => h.comments.count || null,
    component: CommentsView,
  },
  { id: "stats", title: "Statistics", icon: "hash", keywords: "word count stats length", component: StatsView },
  { id: "pomodoro", title: "Timer", icon: "clock", keywords: "pomodoro focus timer", component: PomodoroView },
  {
    id: "reference-pdf",
    title: "Reference PDF",
    icon: "page",
    keywords: "pdf reader paper",
    enabled: false,
    component: ReferencePdfView,
  },
];

export const PANES: PaneDescriptor[] = [
  {
    id: "reference-search",
    title: "Reference Search",
    keywords: "search references cite insert",
    matchQuery: (q) => isStructured(q),
    component: ReferenceSearchPane,
  },
];

export function viewById(id: string): ViewDescriptor | undefined {
  return VIEWS.find((v) => v.id === id);
}
export function paneById(id: string): PaneDescriptor | undefined {
  return PANES.find((p) => p.id === id);
}

export interface Launchable {
  kind: "view" | "pane";
  id: string;
  title: string;
}

export function searchLaunchables(q: string): Launchable[] {
  const t = q.trim().toLowerCase();
  const rows = [
    ...VIEWS.filter((v) => v.enabled !== false).map((v) => ({
      kind: "view" as const,
      id: v.id,
      title: v.title,
      kw: v.keywords ?? "",
    })),
    ...PANES.map((p) => ({ kind: "pane" as const, id: p.id, title: p.title, kw: p.keywords ?? "" })),
  ];
  return rows
    .filter((x) => !t || `${x.title} ${x.kw}`.toLowerCase().includes(t))
    .map(({ kind, id, title }) => ({ kind, id, title }));
}

export function routePaneForQuery(q: string): PaneDescriptor | undefined {
  return PANES.find((p) => p.matchQuery?.(q));
}
