import type { Readable } from "svelte/store";
// The Dynamic Margin's shared contract. PaperMode builds a single getter-backed
// `MarginHost` (stable identity, reactive field reads) and passes it down; the
// pane stack itself lives in marginPanes.ts (module-scope stores, summonable
// from anywhere). Every surface is a "dynamic pane" declared in registry.ts —
// adding one later is a single entry.

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
  /** The 150ms-debounced mirror of `latest` (PAP-7) — anything that runs whole-doc
   *  regexes (Stats, TOC-ish views) reads THIS, never the per-keystroke `latest`. */
  readonly latestIdle: string;
  /** 2.2: write `citation-style:` into the front matter (single-line dispatch);
   *  the derived style store re-labels every chip + the References list live. */
  setCitationStyle(style: "author-year" | "numeric"): void;
  /** WS-4.2: THIS editor's numbering (per-pane) — views subscribe to these
   *  instead of importing module-global stores. */
  numbering: {
    ordinals: Readable<Map<string, number>>;
    style: Readable<"author-year" | "numeric">;
  };
  readonly citedKeys: Set<string>;
  readonly figures: FigureRef[];
  /** The project's cited subset (references/library.bib) — the bibliography. */
  readonly references: BibEntry[];
  /** The whole machine-global FluxLib for the reference SEARCH — you search to find
   *  any paper to cite, not only ones already cited here. Union of FluxLib + any
   *  project-local-only entries; citing one materializes it into `references`. */
  readonly libraryReferences: BibEntry[];
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

/** Per-pane-instance API handed to pane components: `closePane` closes THAT
 *  pane (the frame binds it); `summon` opens-or-focuses any other pane. */
export interface MarginApi {
  summon: (id: string, opts?: { initialQuery?: string }) => void;
  closePane: () => void;
}

export interface PaneDescriptor {
  id: string;
  title: string;
  /** The pane's outline/legend color (a `--flx-*-600` token, text-grade on cream). */
  color: string;
  /** Shown in ⌘K hints; the binding itself lives in PaperMode's keydown ladder. */
  hotkey?: string;
  badge?: (host: MarginHost) => string | number | null;
  /** Focus-if-open behavior override (default: first input/textarea, else the frame). */
  focus?: () => void;
  // Heterogeneous registry: each pane reads the props it needs (host/margin),
  // some none — so the stored type is permissive while each component stays
  // strongly typed at its own definition.
  component: Component<any>;
}
