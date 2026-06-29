// The Dynamic Margin's shared contract (Redesign v2). PaperMode builds a single
// getter-backed `MarginHost` (stable identity, reactive field reads) and passes
// it down; DynamicMargin owns the `MarginApi` (active view / pane stack). Views
// and panes are declared in a registry so adding one later is a single entry.

import type { Component } from "svelte";
import type { EditorView } from "@codemirror/view";
import type { FigureRef } from "../scholar/figures";
import type { BibEntry } from "../scholar/bib";
import type { CommentThread } from "../comments/comments";

export interface CommentBridge {
  threads: (CommentThread & { draft?: boolean })[];
  ranges: Map<string, { from: number; to: number }>;
  activeId: string | null;
  author: string;
  count: number;
  onSubmitNew: (id: string, body: string) => void;
  onCancelNew: (id: string) => void;
  onReply: (id: string, body: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onFocus: (id: string) => void;
  onStart: () => void;
}

/** A citation occurrence in the document (a `[@…]` group or a bare `@key`). */
export interface CitationGroup {
  from: number;
  to: number;
  keys: string[];
}

export interface MarginHost {
  readonly view: EditorView | undefined;
  readonly latest: string;
  readonly citedKeys: Set<string>;
  readonly figures: FigureRef[];
  readonly references: BibEntry[];
  readonly comments: CommentBridge;
  /** Insert (target omitted) or replace (target given) a citation group. */
  writeCites: (keys: string[], target?: { from: number; to: number }) => void;
  removeCite: (key: string) => void;
  citationAtCaret: () => CitationGroup | null;
  insertFigure: (ref: FigureRef) => void;
  addDoi: (doi: string) => Promise<string | null>;
  focusEditor: () => void;
  openFigure: (id: string) => void;
}

export interface MarginApi {
  readonly activeView: string;
  setView: (id: string) => void;
  openPane: (id: string, opts?: { initialQuery?: string }) => void;
  closePane: () => void;
}

export interface ViewDescriptor {
  id: string;
  title: string;
  icon: string;
  keywords?: string;
  enabled?: boolean;
  badge?: (host: MarginHost) => string | number | null;
  // Heterogeneous registry: each view reads the props it needs (host/margin),
  // some none — so the stored type is permissive while each component stays
  // strongly typed at its own definition.
  component: Component<any>;
}

export interface PaneDescriptor {
  id: string;
  title: string;
  keywords?: string;
  /** True when a typed omnibox query should auto-route to this pane. */
  matchQuery?: (q: string) => boolean;
  component: Component<any>;
}
