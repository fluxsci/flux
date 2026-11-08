// Paper's live word counts — one per editor pane, fed ONLY by the 150 ms idle
// mirror (`latestIdle`), never by the keystroke path. Everything Paper shows
// about words reads this object: the status-bar count, the "N selected"
// readout, the outline's per-section numbers, the word-count popover and the
// Statistics pane. The counting itself is the shared pure core
// (src/lib/manuscript/wordCount.ts + wordBudget.ts) that Journal Check, the
// journal export summary and flux-core also call.
//
//   · analysis: one O(document) pass per idle tick (memoised per line, so a
//     re-count after an edit re-masks only the changed lines);
//   · selection: a selection change only RECORDS its ranges after a 150 ms
//     settle; the count is two binary searches over the cached analysis, and
//     only while the analysed text is the document the ranges belong to;
//   · venue: the popover's pick (persisted per machine in localStorage), else
//     the project's export venue (`project.json` style.journal), else Nature;
//   · target: an optional `word-target:` key in the document's front matter —
//     text is truth, so it travels with the manuscript and agents can read it.

import { EditorView } from "@codemirror/view";
import { analyzeWords, countRange } from "../../../lib/manuscript/wordCount";
import { countRulesFor, wordBudget } from "../../../lib/manuscript/wordBudget";
import { resolveJournalStyle } from "../../../lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../../../lib/style/journalPresets";
import { frontMatterEndLine, frontMatterField } from "./frontmatter";
import { setFrontMatterKey } from "./scholar/frontMatter";
import type { FigureRef } from "./scholar/figures";
import { paperPerf } from "./science/changeGate";

export const WORD_TARGET_KEY = "word-target";
const VENUE_KEY = "flux.paper.countVenue";
/** Selection settle — the same 150 ms as the idle mirror. */
const SELECTION_SETTLE_MS = 150;

export interface PaperWordCountSource {
  /** The idle mirror of the document (PaperMode's `latestIdle`). */
  text: () => string;
  figures: () => readonly FigureRef[];
  /** The project's export venue (project.json `style.journal`). */
  projectVenue: () => string | null | undefined;
  view: () => EditorView | undefined;
}

function readVenue(): string | null {
  try {
    return localStorage.getItem(VENUE_KEY) || null;
  } catch {
    return null;
  }
}

/** A positive whole number of words, or null (absent / unparseable). */
export function parseWordTarget(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[,_\s]/g, ""));
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

export function createPaperWordCounts(src: PaperWordCountSource) {
  let venuePick = $state<string | null>(readVenue());
  let sel = $state<{ ranges: [number, number][]; length: number } | null>(null);
  let selTimer: ReturnType<typeof setTimeout> | undefined;

  const venueId = $derived(venuePick ?? src.projectVenue() ?? "nature");
  const style = $derived(resolveJournalStyle(venueId, BUILTIN_JOURNAL_STYLES));
  // Keyed by VALUE: a figure autosave hands Paper a new figures array even when
  // no caption changed, and the hidden Paper pane must not re-analyse the
  // document on another mode's edits (guide §9, hidden-pane subscriptions).
  // An equal string stops the invalidation here.
  const captionsKey = $derived(JSON.stringify(src.figures().map((f) => [f.label, f.caption])));
  const captions = $derived(new Map(JSON.parse(captionsKey) as [string, string][]));
  const analysis = $derived.by(() => {
    const text = src.text();
    const t0 = performance.now();
    const a = analyzeWords(text, { legendFor: (label) => captions.get(label) });
    paperPerf.wordAnalyses++;
    paperPerf.wordAnalysisMs = performance.now() - t0;
    return a;
  });
  const budget = $derived(wordBudget(analysis, countRulesFor(style)));
  const target = $derived(parseWordTarget(frontMatterField(src.text(), WORD_TARGET_KEY)));
  const outline = $derived(new Map(budget.sections.map((s) => [s.from, s.words] as const)));
  const selected = $derived.by<number | null>(() => {
    if (!sel || sel.length !== analysis.length) return null;
    let n = 0;
    for (const [from, to] of sel.ranges) n += countRange(analysis, from, to);
    return n;
  });

  function recordSelection(): void {
    const v = src.view();
    if (!v) return;
    const ranges = v.state.selection.ranges.filter((r) => !r.empty).map((r) => [r.from, r.to] as [number, number]);
    sel = ranges.length ? { ranges, length: v.state.doc.length } : null;
  }

  // Keystroke-path cost: one emptiness check per transaction. A caret move or
  // a keystroke with nothing selected does no work at all.
  const watcher = EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    clearTimeout(selTimer);
    if (u.state.selection.ranges.every((r) => r.empty)) {
      if (sel) sel = null;
      return;
    }
    selTimer = setTimeout(recordSelection, SELECTION_SETTLE_MS);
  });

  function removeTargetLine(view: EditorView): void {
    const doc = view.state.doc;
    const close = frontMatterEndLine(doc);
    for (let i = 2; i < close; i++) {
      const l = doc.line(i);
      if (/^word-target\s*:/.test(l.text)) {
        view.dispatch({ changes: { from: l.from, to: Math.min(l.to + 1, doc.length) }, userEvent: "input" });
        return;
      }
    }
  }

  return {
    get venueId() { return venueId; },
    get style() { return style; },
    get budget() { return budget; },
    /** The status bar's number: main text under the current venue's rules. */
    get main() { return budget.main; },
    get selected() { return selected; },
    get outline() { return outline; },
    get target() { return target; },
    watcher,
    setVenue(id: string): void {
      venuePick = id;
      try {
        localStorage.setItem(VENUE_KEY, id);
      } catch {
        /* private mode: the pick lasts the session */
      }
    },
    /** Write (or with null, remove) the document's `word-target:`. */
    setTarget(n: number | null): void {
      const view = src.view();
      if (!view) return;
      if (n == null) removeTargetLine(view);
      else setFrontMatterKey(view, WORD_TARGET_KEY, String(Math.round(n)));
    },
    /** Return focus to the editor after the popover closes. */
    focusEditor(): void {
      src.view()?.focus();
    },
    dispose(): void {
      clearTimeout(selTimer);
    },
  };
}

export type PaperWordCounts = ReturnType<typeof createPaperWordCounts>;
