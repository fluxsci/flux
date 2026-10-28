// Paper's local correction fabric: boundary-triggered, worker-backed, and
// deliberately outside the synchronous typing path. Harper proposes; the pure
// planner + current editor state decide; CodeMirror owns application and undo.

import {
  Annotation,
  Facet,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  extractProjectVocabulary,
  extractProjectVocabularyOccurrences,
  planLocalCorrections,
  protectedMarkdownRanges,
  scopeWindowLints,
  withinFocus,
  type PlannedLocalCorrection,
} from "./localCorrectionCore";
import {
  backlogScanWindows,
  classifyTypedBoundaries,
  extractCompletedWordWindow,
  extractSentenceWindow,
  windowStartsSentence,
} from "./localCorrectionBoundary";
import { normalizeSpellingCandidates, spellingIssueId, type SpellingCandidate } from "./localSpelling";
import type { CorrectionDialect } from "../../../../lib/settings";
import {
  LOCAL_CORRECTION_RESET_EVENT,
  LOCAL_LANGUAGE_CHANGED_EVENT,
  LOCAL_LANGUAGE_ERROR_EVENT,
  LocalCorrectionProfile,
  type LocalLanguageScope,
} from "./localCorrectionProfile";
import {
  localWordTools,
  refreshLocalWordTools,
  type LocalWordToolsSnapshot,
} from "./localWordTools";
import {
  localCorrectionService,
  type LocalCorrectionEngineStatus,
} from "./localCorrectionService";

export type LocalCorrectionUiStatus = "off" | LocalCorrectionEngineStatus;

export interface LocalCorrectionsOptions {
  enabled(): boolean;
  projectKey(): string;
  contextStrings?(): string[];
  dialect?(): CorrectionDialect;
  onStatus?(status: LocalCorrectionUiStatus): void;
  onError?(message: string): void;
  onNotice?(message: string): void;
}

interface RecentCorrection {
  id: string;
  from: number;
  to: number;
  original: string;
  replacement: string;
  kind: PlannedLocalCorrection["kind"] | "alias";
  message: string;
  aliasScope?: LocalLanguageScope;
  /** A remembered spelling correction rather than an authored abbreviation. */
  learned?: boolean;
  delay: number;
  expiresAt: number;
}

interface SpellingIssue extends SpellingCandidate {
  id: string;
}

interface CorrectionVisualState {
  recent: RecentCorrection[];
  issues: SpellingIssue[];
  openId: string | null;
  /** The open menu was summoned by hovering, not a click: it closes when the
   *  pointer leaves or typing resumes. */
  hover: boolean;
  decorations: DecorationSet;
}

type RevertMode = "undo" | "add-word" | "remove-alias";

interface CorrectionActions {
  revert(view: EditorView, correction: RecentCorrection, mode: RevertMode): void;
  correct(issue: SpellingIssue, replacement: string, typed: boolean): void;
  recognize(issue: SpellingIssue): void;
  /** Pointer entered (true) or left (false) a hover-opened spelling menu. */
  hoverMenu(inside: boolean): void;
}

const correctionActions = Facet.define<CorrectionActions, CorrectionActions>({
  combine(values) {
    return values[0];
  },
});

const addRecent = StateEffect.define<RecentCorrection[]>({
  map(value, changes) {
    return value.map((c) => ({
      ...c,
      from: changes.mapPos(c.from, -1),
      to: changes.mapPos(c.to, 1),
    }));
  },
});
const removeRecent = StateEffect.define<string[]>();
const openRecent = StateEffect.define<string | null>();
const hoverIssue = StateEffect.define<string>();
const upsertSpellingIssues = StateEffect.define<SpellingIssue[]>({
  map(value, changes) {
    return value.map((issue) => ({
      ...issue,
      from: changes.mapPos(issue.from, 1),
      to: changes.mapPos(issue.to, -1),
    }));
  },
});
const removeSpellingIssues = StateEffect.define<string[]>();
const clearSpellingIssues = StateEffect.define<null>();
const aliasExpansions = Annotation.define<RecentCorrection[]>();

function buildDecorations(recent: readonly RecentCorrection[], issues: readonly SpellingIssue[]): DecorationSet {
  return Decoration.set(
    [
      ...recent
      .filter((c) => c.from < c.to)
      .map((c) =>
        Decoration.mark({
          class: `cm-local-correction cm-local-correction-delay-${c.delay % 4}`,
          attributes: {
            "data-flux-correction": c.id,
            "aria-label": `${c.kind === "alias" ? "Expanded alias" : "Corrected"} ${c.original} to ${c.replacement}`,
          },
        }).range(c.from, c.to),
      ),
      ...issues
        .filter((issue) => issue.from < issue.to)
        .map((issue) => Decoration.mark({
          class: "cm-spelling-issue",
          attributes: {
            "data-flux-spelling-issue": issue.id,
            "aria-label": `Possible spelling issue: ${issue.original}`,
          },
        }).range(issue.from, issue.to)),
    ],
    true,
  );
}

const correctionVisualField = StateField.define<CorrectionVisualState>({
  create: () => ({ recent: [], issues: [], openId: null, hover: false, decorations: Decoration.none }),
  update(value, tr) {
    let recent = value.recent.map((c) => ({
      ...c,
      from: tr.changes.mapPos(c.from, -1),
      to: tr.changes.mapPos(c.to, 1),
    }));
    let issues = value.issues.map((issue) => ({
      ...issue,
      from: tr.changes.mapPos(issue.from, 1),
      to: tr.changes.mapPos(issue.to, -1),
    }));
    let openId = value.openId, hover = value.hover;
    if (hover && (tr.isUserEvent("input") || tr.isUserEvent("delete"))) openId = null;

    if (tr.docChanged) {
      recent = recent.filter(
        (c) => tr.newDoc.sliceString(c.from, c.to) === c.replacement,
      );
      issues = issues.filter(
        (issue) => tr.newDoc.sliceString(issue.from, issue.to) === issue.original,
      );
      if (openId && !recent.some((c) => c.id === openId) && !issues.some((issue) => issue.id === openId)) openId = null;
    }
    const expanded = tr.annotation(aliasExpansions);
    if (expanded?.length) recent = [...recent, ...expanded];
    for (const effect of tr.effects) {
      if (effect.is(addRecent)) {
        const ids = new Set(effect.value.map((c) => c.id));
        recent = [...recent.filter((c) => !ids.has(c.id)), ...effect.value];
      } else if (effect.is(removeRecent)) {
        const ids = new Set(effect.value);
        recent = recent.filter((c) => !ids.has(c.id));
        if (openId && ids.has(openId)) openId = null;
      } else if (effect.is(openRecent)) {
        openId = effect.value;
        hover = false;
      } else if (effect.is(hoverIssue)) {
        openId = effect.value;
        hover = true;
      } else if (effect.is(upsertSpellingIssues)) {
        for (const issue of effect.value) {
          issues = issues.filter((existing) => !(
            existing.id === issue.id
            || (existing.original === issue.original && existing.from < issue.to && existing.to > issue.from)
          ));
          issues.push(issue);
        }
      } else if (effect.is(removeSpellingIssues)) {
        const ids = new Set(effect.value);
        issues = issues.filter((issue) => !ids.has(issue.id));
        if (openId && ids.has(openId)) openId = null;
      } else if (effect.is(clearSpellingIssues)) {
        issues = [];
        if (openId && !recent.some((c) => c.id === openId)) openId = null;
      }
    }
    return { recent, issues, openId, hover: openId != null && hover, decorations: buildDecorations(recent, issues) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    showTooltip.from(field, (value): Tooltip | null => {
      const correction = value.recent.find((c) => c.id === value.openId);
      const issue = value.issues.find((candidate) => candidate.id === value.openId);
      if (!correction && !issue) return null;
      if (issue) {
        return {
          pos: issue.from,
          end: issue.to,
          above: true,
          strictSide: false,
          arrow: true,
          create(view) {
            const dom = document.createElement("div");
            dom.className = "cm-spelling-menu";
            dom.setAttribute("role", "dialog");
            dom.setAttribute("aria-label", `Correct ${issue.original}`);
            dom.addEventListener("mousedown", (event) => event.stopPropagation());
            const actions = view.state.facet(correctionActions);
            dom.addEventListener("mouseenter", () => actions.hoverMenu(true));
            dom.addEventListener("mouseleave", () => actions.hoverMenu(false));
            const header = document.createElement("div");
            header.className = "cm-spelling-header";
            const word = document.createElement("strong");
            word.textContent = issue.original;
            const add = document.createElement("button");
            add.type = "button";
            add.className = "icon";
            add.textContent = "+";
            add.title = "Add to your personal dictionary";
            add.setAttribute("aria-label", `Add ${issue.original} to personal dictionary`);
            add.onclick = () => actions.recognize(issue);
            const close = document.createElement("button");
            close.type = "button";
            close.className = "icon";
            close.textContent = "×";
            close.setAttribute("aria-label", "Close spelling suggestions");
            close.onclick = () => { view.dispatch({ effects: openRecent.of(null) }); view.focus(); };
            header.append(word, add, close);
            const choices = document.createElement("div");
            choices.className = "cm-spelling-choices";
            for (const replacement of issue.suggestions.slice(0, 5)) {
              const choice = document.createElement("button");
              choice.type = "button";
              choice.textContent = replacement;
              choice.dataset.spellingSuggestion = replacement;
              choice.onclick = () => actions.correct(issue, replacement, false);
              choices.append(choice);
            }
            if (!issue.suggestions.length) {
              const none = document.createElement("span");
              none.className = "empty";
              none.textContent = "No suggestions";
              choices.append(none);
            }
            const form = document.createElement("form");
            form.className = "cm-spelling-custom";
            const input = document.createElement("input");
            input.type = "text";
            input.spellcheck = false;
            input.autocomplete = "off";
            input.maxLength = 64;
            input.placeholder = "Type the word you meant";
            input.setAttribute("aria-label", "Custom spelling correction");
            const save = document.createElement("button");
            save.type = "submit";
            save.textContent = "Replace";
            save.disabled = true;
            input.oninput = () => { save.disabled = !/^[\p{L}\p{M}\d][\p{L}\p{M}\d_'’.-]{0,63}$/u.test(input.value.trim()) || input.value.trim() === issue.original; };
            form.onsubmit = (event) => { event.preventDefault(); if (!save.disabled) actions.correct(issue, input.value.trim(), true); };
            dom.onkeydown = (event) => {
              event.stopPropagation();
              if (event.key === "Escape") { event.preventDefault(); close.click(); return; }
              if (event.target === input) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const stops = [...choices.querySelectorAll("button"), input];
                const at = stops.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "ArrowDown" ? (at + 1) % stops.length : (at - 1 + stops.length) % stops.length;
                event.preventDefault(); stops[next]?.focus();
              } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                input.focus(); // typing on a suggestion starts a custom correction
              }
            };
            form.append(input, save);
            dom.append(header, choices, form);
            // A click asks for the menu: arrows and Enter work at once. A hover
            // only shows it and leaves the keyboard in the manuscript.
            const clicked = !view.state.field(correctionVisualField).hover;
            return { dom, mount: () => { if (clicked) (choices.querySelector("button") ?? input).focus({ preventScroll: true }); } };
          },
        };
      }
      const resolvedCorrection = correction!;
      return {
        pos: resolvedCorrection.from,
        end: resolvedCorrection.to,
        above: true,
        strictSide: false,
        arrow: true,
        create(view) {
          const dom = document.createElement("div");
          dom.className = "cm-local-correction-menu";
          dom.setAttribute("role", "dialog");
          dom.setAttribute("aria-label", "Local correction");

          const copy = document.createElement("div");
          copy.className = "cm-local-correction-copy";
          const label = document.createElement("span");
          label.textContent = resolvedCorrection.kind === "alias" && !resolvedCorrection.learned ? "Expanded alias" : "Corrected";
          const change = document.createElement("span");
          change.className = "cm-local-correction-change";
          change.textContent = `${resolvedCorrection.original} → ${resolvedCorrection.replacement}`;
          copy.append(label, change);

          const controls = document.createElement("div");
          controls.className = "cm-local-correction-actions";
          const undo = document.createElement("button");
          undo.type = "button";
          undo.textContent = "Undo";
          undo.title = resolvedCorrection.kind === "alias"
            ? "Restore the alias this time"
            : "Restore this text and do not repeat this correction in this project";
          undo.onclick = () => view.state.facet(correctionActions).revert(view, resolvedCorrection, "undo");
          controls.append(undo);

          if (resolvedCorrection.kind === "alias" && resolvedCorrection.aliasScope) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = resolvedCorrection.learned ? "Forget" : "Remove alias";
            remove.title = resolvedCorrection.learned
              ? `Stop correcting “${resolvedCorrection.original}” to “${resolvedCorrection.replacement}”`
              : `Remove “${resolvedCorrection.original}” from the ${resolvedCorrection.aliasScope === "personal" ? "personal" : "project"} aliases`;
            remove.onclick = () => view.state.facet(correctionActions).revert(view, resolvedCorrection, "remove-alias");
            controls.append(remove);
          } else if (!/\s/.test(resolvedCorrection.original)) {
            const add = document.createElement("button");
            add.type = "button";
            add.textContent = "Add to dictionary";
            add.title = `Always recognize “${resolvedCorrection.original}” in this project`;
            add.onclick = () => view.state.facet(correctionActions).revert(view, resolvedCorrection, "add-word");
            controls.append(add);
          }

          const close = document.createElement("button");
          close.type = "button";
          close.className = "icon";
          close.setAttribute("aria-label", "Close correction details");
          close.textContent = "×";
          close.onclick = () => view.dispatch({ effects: openRecent.of(null) });
          controls.append(close);
          dom.append(copy, controls);
          return { dom };
        },
      };
    }),
  ],
});

const PROTECTED_NODES = new Set([
  "Autolink",
  "CodeInfo",
  "CodeText",
  "Comment",
  "FencedCode",
  "HTMLBlock",
  "HTMLTag",
  "InlineCode",
  "ProcessingInstruction",
  "URL",
]);

function inFrontMatterDoc(doc: Text, pos: number): boolean {
  if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return false;
  const max = Math.min(doc.lines, 200);
  for (let n = 2; n <= max; n += 1) {
    const line = doc.line(n);
    if (line.text.trim() === "---") return pos <= line.to;
  }
  return false;
}

function protectedByEditor(state: EditorState, from: number, to: number): boolean {
  if (inFrontMatterDoc(state.doc, from)) return true;
  const firstLine = state.doc.lineAt(from);
  const lastLine = state.doc.lineAt(Math.max(from, to - 1));
  if (firstLine.number !== lastLine.number) return true;
  if (firstLine.text.includes("|") || /^\s*(?:```|~~~|>)/.test(firstLine.text)) return true;
  const localFrom = from - firstLine.from;
  const localTo = to - firstLine.from;
  if (protectedMarkdownRanges(firstLine.text).some(([a, b]) => localFrom < b && localTo > a)) return true;

  for (const pos of [from, Math.max(from, to - 1)]) {
    let node = syntaxTree(state).resolveInner(pos, 1);
    for (;;) {
      if (PROTECTED_NODES.has(node.name)) return true;
      if (!node.parent) break;
      node = node.parent;
    }
  }
  return false;
}

function hasOpenRun(prefix: string, marker: "`" | "$"): boolean {
  let open = 0;
  for (let i = 0; i < prefix.length;) {
    if (prefix[i] !== marker || (i > 0 && prefix[i - 1] === "\\")) {
      i += 1;
      continue;
    }
    let to = i + 1;
    while (to < prefix.length && prefix[to] === marker) to += 1;
    const size = to - i;
    if (!open) open = size;
    else if (open === size) open = 0;
    i = to;
  }
  return open > 0;
}

function insideUnclosedSyntax(line: string, at: number): boolean {
  const prefix = line.slice(0, at);
  if (hasOpenRun(prefix, "`") || hasOpenRun(prefix, "$")) return true;
  if (prefix.lastIndexOf("<") > prefix.lastIndexOf(">")) return true;
  if (prefix.lastIndexOf("{") > prefix.lastIndexOf("}")) return true;
  return prefix.lastIndexOf("](") > prefix.lastIndexOf(")");
}

function protectedAliasRange(doc: Text, from: number, to: number): boolean {
  if (inFrontMatterDoc(doc, from)) return true;
  const line = doc.lineAt(from);
  if (to > line.to || line.text.includes("|") || /^\s*(?:```|~~~)/.test(line.text)) return true;
  const localFrom = from - line.from;
  const localTo = to - line.from;
  if (insideUnclosedSyntax(line.text, localFrom)) return true;
  return protectedMarkdownRanges(line.text)
    .some(([a, b]) => localFrom < b && localTo > a);
}

function insertedBoundaries(update: ViewUpdate): Set<"word" | "sentence"> {
  const boundaries = new Set<"word" | "sentence">();
  for (const tr of update.transactions) {
    if (!tr.isUserEvent("input.type") || tr.isUserEvent("input.type.compose")) continue;
    tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      const text = inserted.toString();
      // Boundary classification only inspects the adjacent token, punctuation,
      // and at most a short scientific abbreviation. Converting the complete
      // manuscript on every keystroke made this nominally cheap observer scale
      // with document length and showed up in the real Electron INP gate.
      const floor = Math.max(0, fromB - 96);
      const ceiling = Math.min(tr.newDoc.length, fromB + text.length + 8);
      const local = tr.newDoc.sliceString(floor, ceiling);
      const kinds = classifyTypedBoundaries(local, fromB - floor, text);
      if (kinds.has("word")) boundaries.add("word");
      if (kinds.has("sentence") || kinds.has("paragraph")) boundaries.add("sentence");
    });
  }
  return boundaries;
}

function changesTouchRange(update: ViewUpdate, from: number, to: number): boolean {
  let touched = false;
  update.changes.iterChangedRanges((fromA, toA) => {
    if (fromA < to && toA > from) touched = true;
    if (fromA === toA && fromA > from && fromA < to) touched = true;
  });
  return touched;
}

interface PendingWindow {
  id: number;
  from: number;
  to: number;
  text: string;
  lane: "word" | "sentence";
  /** Window-relative range this lane may correct; the rest is linter context. */
  focus?: { from: number; to: number };
}

/** Document range a queued window is allowed to change — its focus, or all of it. */
function correctableRange(window: PendingWindow): { from: number; to: number } {
  if (!window.focus) return { from: window.from, to: window.to };
  return { from: window.from + window.focus.from, to: window.from + window.focus.to };
}

interface BacklogChunk {
  from: number;
  to: number;
  text: string;
}

// Decoration cost is O(issues) on every transaction; a messy manuscript must
// not turn the whole document red or tax typing. First-come, capped.
const MAX_BACKLOG_FLAGS = 300;

let correctionSession = 0;
class CorrectionController {
  private readonly workerScope = `paper-${++correctionSession}`;
  private disposed = false;
  private profile: LocalCorrectionProfile;
  private activeProjectKey: string;
  private projectWords = new Set<string>();
  private explicitWords: string[] = [];
  private triggerTimer: ReturnType<typeof setTimeout> | null = null;
  private vocabularyTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleHandle: number | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private requestN = 0;
  private recentN = 0;
  private inFlight = false;
  private pending: PendingWindow | null = null;
  private queue: PendingWindow[] = [];
  private lastBatch: RecentCorrection[] = [];
  private backlogTimer: ReturnType<typeof setTimeout> | null = null;
  private backlogGen = 0;
  private backlogChunks: BacklogChunk[] = [];
  private backlogFlagged = 0;
  private failedNoticeShown = false;
  private enabledState: boolean;
  private dialectState: CorrectionDialect;
  /** Flagged words the user is retyping by hand (see learnHandCorrections). */
  private editedIssues: Array<{ from: number; original: string; suggestions: string[]; until: number }> = [];
  private readonly resetLearning = () => {
    this.profile.clearBlockedPairs();
    this.projectWords.clear();
    this.refreshVocabulary(true);
  };
  private readonly languageError = (event: Event) => {
    const detail = (event as CustomEvent<{ projectKey?: string; message?: string }>).detail;
    if (detail?.projectKey === this.activeProjectKey && detail.message) this.options.onError?.(detail.message);
  };
  private readonly languageChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ projectKey?: string; scope?: LocalLanguageScope }>).detail;
    if (detail?.scope !== "personal" && detail?.projectKey !== this.activeProjectKey) return;
    this.profile = new LocalCorrectionProfile(this.activeProjectKey);
    this.refreshVocabulary(true);
    this.removeRecognizedIssues();
    refreshLocalWordTools(this.view);
    void this.profile.ready().then(() => {
      if (this.disposed) return;
      this.refreshVocabulary(true);
      this.removeRecognizedIssues();
    });
    this.scheduleBacklogScan(0);
  };

  constructor(
    private readonly view: EditorView,
    private readonly options: LocalCorrectionsOptions,
  ) {
    this.enabledState = options.enabled();
    this.dialectState = options.dialect?.() ?? "american";
    this.activeProjectKey = options.projectKey();
    this.profile = new LocalCorrectionProfile(this.activeProjectKey);
    void this.profile.ready().then((hydrated) => {
      if (this.disposed || !hydrated || this.activeProjectKey !== options.projectKey()) return;
      this.refreshVocabulary(true);
      refreshLocalWordTools(this.view);
    });
    this.unsubscribeStatus = localCorrectionService.subscribe((status) => {
      if (status === "error" && !this.failedNoticeShown) {
        this.failedNoticeShown = true;
        options.onError?.("Local corrections could not start. Your text was not changed.");
      }
      options.onStatus?.(options.enabled() ? status : "off");
    });
    window.addEventListener(LOCAL_CORRECTION_RESET_EVENT, this.resetLearning);
    window.addEventListener(LOCAL_LANGUAGE_CHANGED_EVENT, this.languageChanged);
    window.addEventListener(LOCAL_LANGUAGE_ERROR_EVENT, this.languageError);
    if (options.enabled()) this.scheduleWarm();
    else options.onStatus?.("off");
  }

  update(update: ViewUpdate): void {
    const projectKey = this.options.projectKey();
    if (projectKey !== this.activeProjectKey) {
      localCorrectionService.cancelScope(this.workerScope);
      this.activeProjectKey = projectKey;
      this.profile = new LocalCorrectionProfile(projectKey);
      this.projectWords.clear();
      this.pending = null;
      this.queue = [];
      this.lastBatch = [];
      this.backlogGen += 1;
      this.backlogChunks = [];
      if (this.backlogTimer) {
        clearTimeout(this.backlogTimer);
        this.backlogTimer = null;
      }
      this.clearIssuesSoon();
      if (this.triggerTimer) {
        clearTimeout(this.triggerTimer);
        this.triggerTimer = null;
      }
      if (this.options.enabled()) {
        this.options.onStatus?.("loading");
        this.scheduleWarm();
      }
      void this.profile.ready().then((hydrated) => {
        if (!this.disposed && hydrated && this.activeProjectKey === projectKey) this.refreshVocabulary(true);
      });
    }
    const enabled = this.options.enabled();
    const dialect = this.options.dialect?.() ?? "american";
    if (dialect !== this.dialectState) {
      this.dialectState = dialect;
      localCorrectionService.setDialect(this.activeProjectKey, dialect, [...this.projectWords]);
    }
    if (enabled !== this.enabledState) {
      this.enabledState = enabled;
      if (enabled) {
        this.options.onStatus?.("loading");
        this.scheduleWarm();
      } else {
        this.options.onStatus?.("off");
        localCorrectionService.cancelScope(this.workerScope);
        if (this.triggerTimer) clearTimeout(this.triggerTimer);
        this.clearIssuesSoon();
      }
    }
    if (this.pending && update.docChanged) {
      if (changesTouchRange(update, this.pending.from, this.pending.to)) {
        this.pending = null;
      } else {
        this.pending.from = update.changes.mapPos(this.pending.from, -1);
        this.pending.to = update.changes.mapPos(this.pending.to, -1);
      }
    }
    if (this.queue.length && update.docChanged) {
      this.queue = this.queue.flatMap((queued) => {
        const from = update.changes.mapPos(queued.from, -1);
        const to = update.changes.mapPos(queued.to, -1);
        // The focus rides the same change set: a stale offset would let the
        // lane correct a word it never captured.
        let focus = queued.focus;
        if (focus) {
          const scope = correctableRange(queued);
          const focusFrom = update.changes.mapPos(scope.from, -1) - from;
          const focusTo = update.changes.mapPos(scope.to, 1) - from;
          if (focusTo <= focusFrom || focusFrom < 0 || focusTo > to - from) return [];
          focus = { from: focusFrom, to: focusTo };
        }
        return [{
          ...queued,
          from,
          to,
          ...(focus ? { focus } : {}),
          // A prior local fix may land inside a newer queued snapshot. Refresh
          // that snapshot from the mapped document rather than dropping the
          // rest of the completed sentence.
          text: update.state.doc.sliceString(from, to),
        }];
      });
    }
    if (this.backlogChunks.length && update.docChanged) {
      this.backlogChunks = this.backlogChunks.map((chunk) => ({
        ...chunk,
        from: update.changes.mapPos(chunk.from, -1),
        to: update.changes.mapPos(chunk.to, -1),
      }));
    }

    const aliasRecent = update.transactions.flatMap((tr) => tr.annotation(aliasExpansions) ?? []);
    if (aliasRecent.length) this.scheduleExpiry(aliasRecent);

    if (this.lastBatch.length && update.docChanged) {
      const mapped = this.lastBatch.map((c) => ({
        ...c,
        from: update.changes.mapPos(c.from, -1),
        to: update.changes.mapPos(c.to, 1),
      }));
      if (update.transactions.some((tr) => tr.isUserEvent("undo"))) {
        for (const correction of mapped) {
          const restoredTo = correction.from + correction.original.length;
          if (update.state.doc.sliceString(correction.from, restoredTo) === correction.original) {
            this.profile.block(correction.original, correction.replacement);
          }
        }
        this.lastBatch = [];
      } else {
        // Learning is intentionally limited to an immediate, targeted Undo.
        // Any intervening document edit makes a later/bulk Undo non-teaching.
        this.lastBatch = [];
      }
    }

    if (update.docChanged) {
      this.learnHandCorrections(update);
      this.scheduleVocabularyRefresh();
    }
    if (!enabled) {
      this.options.onStatus?.("off");
      return;
    }
    // A document arriving OUTSIDE typing — open, switch, external reload — is
    // the backlog-flag trigger: existing Harper issues get a red underline
    // without changing the text. User events (typing, undo, our own
    // applies) and the alias expander's appended replacement never rescan.
    const programmaticLoad = update.transactions.some((tr) =>
      tr.docChanged && tr.annotation(Transaction.userEvent) == null && !tr.annotation(aliasExpansions));
    if (programmaticLoad) this.scheduleBacklogScan();
    const boundaries = insertedBoundaries(update);
    if (boundaries.has("word")) this.scheduleCorrection("word");
    if (boundaries.has("sentence")) this.scheduleCorrection("sentence");
  }

  /** A flagged word the user fixes by hand teaches the same mapping as picking
   *  it from the menu — but only when the finished word is one of the checker's
   *  own suggestions for it, so an unrelated rewrite never becomes an alias. */
  private learnHandCorrections(update: ViewUpdate): void {
    const now = Date.now();
    this.editedIssues = this.editedIssues
      .filter((edited) => edited.until > now)
      .map((edited) => ({ ...edited, from: update.changes.mapPos(edited.from, -1) }));
    if (!update.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"))) return;
    const kept = new Set(update.state.field(correctionVisualField, false)?.issues.map((issue) => issue.id));
    for (const issue of update.startState.field(correctionVisualField, false)?.issues ?? []) {
      if (kept.has(issue.id) || !issue.suggestions.length || !changesTouchRange(update, issue.from, issue.to)) continue;
      this.editedIssues = [...this.editedIssues, { from: update.changes.mapPos(issue.from, -1), original: issue.original, suggestions: issue.suggestions, until: now + 30_000 }].slice(-8);
    }
    if (!this.editedIssues.length || !insertedBoundaries(update).has("word")) return;
    const doc = update.state.doc;
    for (const edited of this.editedIssues) {
      let to = edited.from;
      while (to < doc.length && /[\p{L}\p{M}\d_'’.-]/u.test(doc.sliceString(to, to + 1))) to += 1;
      const word = doc.sliceString(edited.from, to);
      const at = update.state.selection.main.head;
      if (to === edited.from || at <= to || at > to + 1) continue; // learn when the word's own delimiter lands
      const choice = edited.suggestions.find((suggestion) => suggestion.toLocaleLowerCase() === word.toLocaleLowerCase());
      edited.until = 0;
      if (!choice || word === edited.original) continue;
      this.profile.setAlias(edited.original, word, "personal", true);
      this.broadcastLanguageChange("personal");
    }
  }

  destroy(): void {
    this.disposed = true;
    localCorrectionService.cancelScope(this.workerScope);
    this.pending = null; this.queue = [];
    this.backlogGen += 1;
    if (this.backlogTimer) clearTimeout(this.backlogTimer);
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    if (this.vocabularyTimer) clearTimeout(this.vocabularyTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.idleHandle != null && "cancelIdleCallback" in window) window.cancelIdleCallback(this.idleHandle);
    window.removeEventListener(LOCAL_CORRECTION_RESET_EVENT, this.resetLearning);
    window.removeEventListener(LOCAL_LANGUAGE_CHANGED_EVENT, this.languageChanged);
    window.removeEventListener(LOCAL_LANGUAGE_ERROR_EVENT, this.languageError);
    this.unsubscribeStatus?.();
  }

  private scheduleWarm(): void {
    const warm = () => {
      this.idleHandle = null;
      if (this.disposed || !this.options.enabled()) return;
      this.refreshVocabulary();
      localCorrectionService.setDialect(this.activeProjectKey, this.dialectState, [...this.projectWords]);
      localCorrectionService.warm(this.activeProjectKey, [...this.projectWords]);
      // Covers documents already present at editor creation (no load
      // transaction ever fires for them) and every enable/project-switch path.
      this.scheduleBacklogScan();
    };
    if ("requestIdleCallback" in window) {
      this.idleHandle = window.requestIdleCallback(warm, { timeout: 900 });
    } else {
      this.triggerTimer = setTimeout(warm, 120);
    }
  }

  private scheduleVocabularyRefresh(): void {
    if (this.vocabularyTimer) clearTimeout(this.vocabularyTimer);
    this.vocabularyTimer = setTimeout(() => {
      this.vocabularyTimer = null;
      const refresh = () => this.refreshVocabulary();
      if ("requestIdleCallback" in window) window.requestIdleCallback(refresh, { timeout: 1800 });
      else refresh();
    }, 1200);
  }

  private refreshVocabulary(replace = false): void {
    if (this.disposed) return;
    const sources = [
      this.view.state.doc.toString(),
      ...(this.options.contextStrings?.() ?? []),
    ];
    this.explicitWords = this.profile.explicitCorrectionWords();
    const occurrences = extractProjectVocabularyOccurrences(sources);
    const words = [...this.profile.allWords(), ...extractProjectVocabulary(sources, occurrences)];
    this.projectWords = new Set(words.map((w) => w.toLocaleLowerCase()));
    if (replace) localCorrectionService.replaceVocabulary(this.activeProjectKey, words);
    else localCorrectionService.updateVocabulary(this.activeProjectKey, words);
  }

  private candidateIssues(pending: Pick<PendingWindow, "from">, candidates: readonly SpellingCandidate[]): SpellingIssue[] {
    return candidates.map((candidate) => ({
      ...candidate,
      id: spellingIssueId(pending.from + candidate.from, pending.from + candidate.to, candidate.original),
      from: pending.from + candidate.from,
      to: pending.from + candidate.to,
    }));
  }

  /** Does a window starting at `from` open a real sentence in the document? */
  private startsSentence(from: number): boolean {
    return windowStartsSentence(this.view.state.doc.sliceString(Math.max(0, from - 96), from));
  }

  /**
   * A window that has just been linted is the authority on the range it may
   * correct: an issue this pass no longer reports must disappear from that
   * range. Nothing outside that range is touched — the rest of the
   * window was context, and its issues belong to the lane that raised them.
   */
  private publishSpellingIssues(pending: PendingWindow, fresh: readonly SpellingIssue[]): void {
    const scope = correctableRange(pending);
    const keep = new Set(fresh.map((issue) => issue.id));
    const stale = (this.view.state.field(correctionVisualField, false)?.issues ?? [])
      .filter((issue) => !keep.has(issue.id))
      .filter((issue) => issue.from >= scope.from && issue.to <= scope.to)
      .map((issue) => issue.id);
    if (!stale.length && !fresh.length) return;
    this.view.dispatch({
      effects: [
        ...(stale.length ? [removeSpellingIssues.of(stale)] : []),
        ...(fresh.length ? [upsertSpellingIssues.of([...fresh])] : []),
      ],
    });
  }

  private clearIssuesSoon(): void {
    queueMicrotask(() => { if (!this.disposed) this.view.dispatch({ effects: clearSpellingIssues.of(null) }); });
  }

  private removeRecognizedIssues(): void {
    const words = new Set(this.profile.allWords().map((word) => word.toLocaleLowerCase()));
    const ids = this.view.state.field(correctionVisualField, false)?.issues
      .filter((issue) => words.has(issue.original.toLocaleLowerCase())).map((issue) => issue.id) ?? [];
    if (ids.length) this.view.dispatch({ effects: removeSpellingIssues.of(ids) });
  }

  private scheduleBacklogScan(delay = 1200): void {
    if (!this.options.enabled()) return;
    if (this.backlogTimer) clearTimeout(this.backlogTimer);
    this.backlogTimer = setTimeout(() => {
      this.backlogTimer = null;
      this.startBacklogScan();
    }, delay);
  }

  private startBacklogScan(): void {
    if (!this.options.enabled()) return;
    const gen = ++this.backlogGen;
    this.backlogFlagged = 0;
    this.backlogChunks = backlogScanWindows(this.view.state.doc.toString());
    void this.runBacklogSlice(gen);
  }

  /**
   * Flag pre-existing Harper issues, one idle-paced chunk at a time. The scan
   * only decorates — it never edits. Live lanes always outrank it: the caret's
   * own sentence is skipped, busy lanes defer the scan, and existing issues
   * remain actionable while other chunks are checked.
   */
  private async runBacklogSlice(gen: number): Promise<void> {
    if (gen !== this.backlogGen || !this.options.enabled()) return;
    const chunk = this.backlogChunks.shift();
    if (!chunk) return;
    const next = () => {
      if (gen !== this.backlogGen) return;
      if ("requestIdleCallback" in window) window.requestIdleCallback(() => void this.runBacklogSlice(gen), { timeout: 600 });
      else setTimeout(() => void this.runBacklogSlice(gen), 80);
    };
    if (this.inFlight || this.queue.length) {
      this.backlogChunks.unshift(chunk);
      setTimeout(() => void this.runBacklogSlice(gen), 700);
      return;
    }
    const head = this.view.state.selection.main.head;
    if (this.view.hasFocus && chunk.from - 1 <= head && head <= chunk.to + 1) {
      // The user is writing here; the word/sentence lanes own this region.
      next();
      return;
    }
    if (this.view.state.doc.sliceString(chunk.from, chunk.to) !== chunk.text) {
      next();
      return;
    }
    try {
      const raw = await localCorrectionService.lint(chunk.text, undefined, "lintOnly", this.workerScope);
      if (gen !== this.backlogGen || !this.options.enabled()) return;
      if (this.view.state.doc.sliceString(chunk.from, chunk.to) !== chunk.text) {
        next();
        return;
      }
      // Long paragraphs are cut at whitespace when they hold no sentence
      // boundary, so a chunk can start mid-sentence like any other window.
      const lints = scopeWindowLints(chunk, raw, this.startsSentence(chunk.from));
      const existing = this.view.state.field(correctionVisualField, false)?.issues ?? [];
      const candidates = normalizeSpellingCandidates(chunk.text, lints, this.profile.allWords()).filter((candidate) => {
        const from = chunk.from + candidate.from;
        const to = chunk.from + candidate.to;
        if (existing.some((issue) => from < issue.to && to > issue.from)) return false;
        return !protectedByEditor(this.view.state, from, to);
      });
      const kept = candidates.slice(0, Math.max(0, MAX_BACKLOG_FLAGS - this.backlogFlagged));
      this.backlogFlagged += kept.length;
      if (kept.length) {
        this.view.dispatch({ effects: upsertSpellingIssues.of(this.candidateIssues(chunk, kept)) });
      }
      if (this.backlogFlagged >= MAX_BACKLOG_FLAGS) {
        this.backlogChunks = [];
        return;
      }
    } catch {
      // Worker unavailable — the service already surfaced one visible error.
      return;
    }
    next();
  }

  private scheduleCorrection(lane: "word" | "sentence"): void {
    const queued = this.captureWindow(lane);
    if (!queued) return;
    const same = this.queue.findIndex((item) => item.from === queued.from && item.lane === queued.lane);
    if (same >= 0) this.queue[same] = queued;
    // A sentence pass covers more than the focused word pass, even when the
    // two snapshots happen to contain identical text.
    else if (
      !this.pending
      || this.pending.lane !== queued.lane
      || this.pending.from !== queued.from
      || this.pending.text !== queued.text
    ) {
      this.queue.push(queued);
      while (this.queue.length > 8) {
        const oldestWord = this.queue.findIndex((item) => item.lane === "word");
        this.queue.splice(oldestWord >= 0 ? oldestWord : 0, 1);
      }
    }
    if (this.triggerTimer || this.inFlight) return;
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      void this.runCorrection();
    }, 24);
  }

  private captureWindow(lane: "word" | "sentence"): PendingWindow | null {
    if (!this.options.enabled() || !this.view.hasFocus || !this.view.state.selection.main.empty) return null;
    const head = this.view.state.selection.main.head;
    const floor = Math.max(0, head - (lane === "word" ? 400 : 760));
    const slice = this.view.state.doc.sliceString(floor, head);
    const localWindow = lane === "word"
      ? extractCompletedWordWindow(slice, slice.length)
      : extractSentenceWindow(slice, slice.length);
    if (!localWindow) return null;
    const queued: PendingWindow = {
      id: ++this.requestN,
      from: floor + localWindow.from,
      to: floor + localWindow.to,
      text: localWindow.text,
      lane,
      ...(localWindow.focus ? { focus: localWindow.focus } : {}),
    };
    // Protection asks "may Flux change this text", so it applies to the range
    // this lane can actually change — the leading sentence context is read-only
    // and must not veto a correction two words later.
    const guarded = correctableRange(queued);
    return protectedByEditor(this.view.state, guarded.from, guarded.to) ? null : queued;
  }

  private async runCorrection(): Promise<void> {
    if (this.inFlight || !this.options.enabled()) return;
    // Complete-sentence checks cover earlier deferred spelling issues; keep
    // them from starving behind continuously arriving word windows.
    const sentenceIndex = this.queue.findIndex((item) => item.lane === "sentence");
    const [pending] = this.queue.splice(sentenceIndex >= 0 ? sentenceIndex : 0, 1);
    if (!pending) return;
    if (this.view.state.doc.sliceString(pending.from, pending.to) !== pending.text) {
      if (this.queue.length) this.scheduleQueuedRun();
      return;
    }

    this.pending = pending;
    this.inFlight = true;
    try {
      const raw = await localCorrectionService.lint(pending.text, pending.focus, "repair", this.workerScope);
      if (this.pending?.id !== pending.id || !this.options.enabled()) return;
      if (this.view.state.doc.sliceString(pending.from, pending.to) !== pending.text) return;
      const lints = scopeWindowLints(pending, raw, this.startsSentence(pending.from));

      // Both planners also synthesize spans from the window text itself (the
      // confusion table, explicit vocabulary), so the focus has to bound their
      // OUTPUT too — filtering their lint input is not enough.
      const plans = withinFocus(planLocalCorrections(pending.text, lints, {
        blockedPairs: this.profile.blockedPairs(),
        projectWords: this.projectWords,
        explicitWords: this.explicitWords,
      }), pending.focus)
        .map((plan) => ({
          ...plan,
          from: pending.from + plan.from,
          to: pending.from + plan.to,
        }))
        .filter((plan) => {
          if (protectedByEditor(this.view.state, plan.from, plan.to)) return false;
          return this.view.state.doc.sliceString(plan.from, plan.to) === plan.original;
        });
      if (plans.length) {
        this.apply(plans);
        // Recapture after mechanical edits so remaining spelling flags are
        // based on the current source.
        if (pending.lane === "sentence") this.scheduleCorrection("sentence");
      } else {
        const candidates = withinFocus(normalizeSpellingCandidates(pending.text, lints, this.profile.allWords()), pending.focus);
        this.publishSpellingIssues(pending, this.candidateIssues(pending, candidates));
      }
    } catch {
      // The service publishes one visible error and otherwise fails closed.
    } finally {
      if (this.pending?.id === pending.id) this.pending = null;
      this.inFlight = false;
      if (this.queue.length) this.scheduleQueuedRun();
    }
  }

  private scheduleQueuedRun(): void {
    if (this.triggerTimer || this.inFlight) return;
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      void this.runCorrection();
    }, 0);
  }

  expandAliases(tr: Transaction): Transaction | readonly TransactionSpec[] {
    if (
      !this.options.enabled() ||
      !tr.docChanged ||
      !tr.isUserEvent("input.type") ||
      tr.isUserEvent("input.type.compose")
    ) return tr;

    const matches = new Map<number, { from: number; to: number; original: string; replacement: string; scope: LocalLanguageScope; learned: boolean }>();
    tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      const text = inserted.toString();
      for (let i = 0; i < text.length; i += 1) {
        if (!/[\s.,;:!?()[\]{}]/.test(text[i])) continue;
        const boundary = fromB + i;
        let from = boundary;
        while (from > 0 && /[\p{L}\p{M}\d_'’.-]/u.test(tr.newDoc.sliceString(from - 1, from))) from -= 1;
        if (from === boundary || boundary - from > 64 || matches.has(from)) continue;
        const original = tr.newDoc.sliceString(from, boundary);
        const alias = this.profile.resolveAlias(original);
        if (!alias || alias.expansion === original || protectedAliasRange(tr.newDoc, from, boundary)) continue;
        matches.set(from, {
          from,
          to: boundary,
          original,
          replacement: alias.expansion,
          scope: alias.scope,
          learned: !!alias.learned,
        });
      }
    });
    const ordered = [...matches.values()].sort((a, b) => a.from - b.from);
    if (!ordered.length) return tr;

    let delta = 0;
    const now = Date.now();
    const recent = ordered.map((match, index): RecentCorrection => {
      const from = match.from + delta;
      delta += match.replacement.length - (match.to - match.from);
      return {
        id: `la-${now.toString(36)}-${++this.recentN}`,
        from,
        to: from + match.replacement.length,
        original: match.original,
        replacement: match.replacement,
        kind: "alias",
        message: `${match.scope === "personal" ? "Personal" : "Project"} alias`,
        aliasScope: match.scope,
        learned: match.learned,
        delay: index,
        expiresAt: now + 9_000,
      };
    });
    return [
      tr,
      {
        changes: ordered.map((match) => ({ from: match.from, to: match.to, insert: match.replacement })),
        sequential: true,
        annotations: [
          isolateHistory.of("full"),
          aliasExpansions.of(recent),
        ],
      },
    ];
  }

  wordToolsSnapshot(word: string): LocalWordToolsSnapshot {
    return {
      projectWord: this.profile.hasWord(word, "project"),
      personalWord: this.profile.hasWord(word, "personal"),
      aliases: this.profile.aliasesForExpansion(word),
    };
  }

  toggleWord(word: string, scope: LocalLanguageScope): void {
    const result = this.profile.toggleWord(word, scope);
    const label = scope === "personal" ? "personal" : "project";
    this.options.onNotice?.(`${result === "added" ? "Added" : "Removed"} “${word}” ${result === "added" ? "to" : "from"} the ${label} dictionary.`);
    this.broadcastLanguageChange(scope);
  }

  setAlias(trigger: string, expansion: string, scope: LocalLanguageScope): void {
    this.profile.setAlias(trigger, expansion, scope);
    this.profile.addWord(expansion, scope);
    this.options.onNotice?.(`“${trigger}” now expands to “${expansion}” (${scope === "personal" ? "personal" : "project"}).`);
    this.broadcastLanguageChange(scope);
  }

  removeAlias(trigger: string, scope: LocalLanguageScope): void {
    if (!this.profile.removeAlias(trigger, scope)) return;
    this.options.onNotice?.(`Removed the ${scope === "personal" ? "personal" : "project"} alias “${trigger}”.`);
    this.broadcastLanguageChange(scope);
  }

  private broadcastLanguageChange(scope: LocalLanguageScope): void {
    window.dispatchEvent(new CustomEvent(LOCAL_LANGUAGE_CHANGED_EVENT, {
      detail: { projectKey: this.activeProjectKey, scope },
    }));
  }

  correctIssue(issue: SpellingIssue, replacement: string, typed: boolean): void {
    const current = this.view.state.field(correctionVisualField, false)?.issues.find((candidate) => candidate.id === issue.id);
    if (!current || this.view.state.doc.sliceString(current.from, current.to) !== current.original) return;
    if (!/^[\p{L}\p{M}\d][\p{L}\p{M}\d_'’.-]{0,63}$/u.test(replacement) || replacement === current.original) return;
    this.profile.setAlias(current.original, replacement, "personal", true);
    // A typed word the checker did not suggest is one it does not know yet.
    if (typed && !current.suggestions.includes(replacement)) this.profile.addWord(replacement, "personal");
    this.profile.unblock(current.original, replacement);
    this.broadcastLanguageChange("personal");
    this.view.dispatch({
      changes: { from: current.from, to: current.to, insert: replacement },
      effects: [removeSpellingIssues.of([current.id]), openRecent.of(null)],
      annotations: [Transaction.userEvent.of("input.spelling-correction"), isolateHistory.of("full")],
    });
    this.view.focus();
  }

  recognizeIssue(issue: SpellingIssue): void {
    if (!this.view.state.field(correctionVisualField, false)?.issues.some((candidate) => candidate.id === issue.id)) return;
    this.profile.addWord(issue.original, "personal");
    this.broadcastLanguageChange("personal");
    this.view.dispatch({ effects: openRecent.of(null) });
    this.view.focus();
  }

  private apply(plans: Array<PlannedLocalCorrection & { from: number; to: number }>): void {
    const ordered = [...plans].sort((a, b) => a.from - b.from);
    if (!ordered.every((p) => this.view.state.doc.sliceString(p.from, p.to) === p.original)) return;

    let delta = 0;
    const now = Date.now();
    const recent = ordered.map((plan, index): RecentCorrection => {
      const from = plan.from + delta;
      const correction: RecentCorrection = {
        id: `lc-${now.toString(36)}-${++this.recentN}`,
        from,
        to: from + plan.replacement.length,
        original: plan.original,
        replacement: plan.replacement,
        kind: plan.kind,
        message: plan.message,
        delay: index,
        expiresAt: now + 9_000,
      };
      delta += plan.replacement.length - (plan.to - plan.from);
      return correction;
    });

    this.view.dispatch({
      changes: ordered.map((p) => ({ from: p.from, to: p.to, insert: p.replacement })),
      annotations: [
        Transaction.userEvent.of("input.local-correction"),
        isolateHistory.of("full"),
      ],
    });
    this.view.dispatch({ effects: addRecent.of(recent) });
    this.lastBatch = recent;
    this.scheduleExpiry(recent);
  }

  private scheduleExpiry(recent: readonly RecentCorrection[]): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const delay = Math.max(0, Math.max(...recent.map((c) => c.expiresAt)) - Date.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      const visual = this.view.state.field(correctionVisualField, false);
      if (!visual) return;
      const expired = visual.recent.filter((c) => c.expiresAt <= Date.now()).map((c) => c.id);
      if (expired.length) this.view.dispatch({ effects: removeRecent.of(expired) });
    }, delay + 20);
  }

  revert(correction: RecentCorrection, mode: RevertMode): void {
    const current = this.view.state.field(correctionVisualField, false)?.recent.find(
      (c) => c.id === correction.id,
    );
    if (!current || this.view.state.doc.sliceString(current.from, current.to) !== current.replacement) return;
    if (current.kind === "alias") {
      if (mode === "remove-alias" && current.aliasScope) {
        this.profile.removeAlias(current.original, current.aliasScope);
        this.broadcastLanguageChange(current.aliasScope);
      }
    } else {
      this.profile.block(current.original, current.replacement);
      if (mode === "add-word") {
        this.profile.addWord(current.original, "project");
        this.broadcastLanguageChange("project");
      }
    }
    this.view.dispatch({
      changes: { from: current.from, to: current.to, insert: current.original },
      annotations: [
        Transaction.userEvent.of("input.local-correction-revert"),
        isolateHistory.of("full"),
      ],
    });
    this.view.dispatch({ effects: removeRecent.of([current.id]) });
    if (current.kind !== "alias") this.lastBatch = [];
    this.view.focus();
  }
}

export function localCorrections(options: LocalCorrectionsOptions): Extension {
  let controller: CorrectionController | null = null;
  let hoverView: EditorView | null = null;
  let hoverClose: ReturnType<typeof setTimeout> | null = null;
  // A hover-opened menu closes shortly after the pointer leaves both the word
  // and the menu (the gap between them must not close it).
  const hoverMenu = (inside: boolean) => {
    if (hoverClose) clearTimeout(hoverClose);
    hoverClose = null;
    if (inside || !hoverView) return;
    const view = hoverView;
    hoverClose = setTimeout(() => {
      hoverClose = null;
      const state = view.state.field(correctionVisualField, false);
      if (state?.hover && !view.dom.querySelector(".cm-spelling-menu")?.contains(document.activeElement)) view.dispatch({ effects: openRecent.of(null) });
    }, 300);
  };
  const controllerPlugin = ViewPlugin.define(
    (view) => (controller = new CorrectionController(view, options)),
    {
      eventHandlers: {
        mouseover(event, view) {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-flux-spelling-issue]") : null;
          const id = target?.dataset.fluxSpellingIssue;
          if (!id) return false;
          hoverView = view;
          hoverMenu(true);
          if (view.state.field(correctionVisualField, false)?.openId !== id) view.dispatch({ effects: hoverIssue.of(id) });
          return false;
        },
        mouseout(event, view) {
          const from = event.target instanceof Element ? event.target.closest("[data-flux-spelling-issue]") : null;
          const to = event.relatedTarget instanceof Element ? event.relatedTarget.closest("[data-flux-spelling-issue]") : null;
          if (from && from !== to && view.state.field(correctionVisualField, false)?.hover) hoverMenu(false);
          return false;
        },
        mousedown(event, view) {
          const correctionTarget = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-flux-correction]")
            : null;
          const issueTarget = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-flux-spelling-issue]")
            : null;
          const targetId = correctionTarget?.dataset.fluxCorrection ?? issueTarget?.dataset.fluxSpellingIssue;
          if (!targetId) {
            const state = view.state.field(correctionVisualField, false);
            if (state?.openId) view.dispatch({ effects: openRecent.of(null) });
            return false;
          }
          event.preventDefault();
          view.dispatch({ effects: openRecent.of(targetId) });
          return true;
        },
      },
    },
  );

  return [
    correctionVisualField,
    correctionActions.of({
      revert(_view, correction, mode) { controller?.revert(correction, mode); },
      correct(issue, replacement, typed) { controller?.correctIssue(issue, replacement, typed); },
      recognize(issue) { controller?.recognizeIssue(issue); },
      hoverMenu,
    }),
    EditorState.transactionFilter.of((tr) => controller?.expandAliases(tr) ?? tr),
    localWordTools(() => {
      const current = controller;
      return current ? {
        snapshot: (word) => current.wordToolsSnapshot(word),
        toggleWord: (word, scope) => current.toggleWord(word, scope),
        setAlias: (trigger, expansion, scope) => current.setAlias(trigger, expansion, scope),
        removeAlias: (trigger, scope) => current.removeAlias(trigger, scope),
        notice: (message) => options.onNotice?.(message),
      } : null;
    }),
    controllerPlugin,
    keymap.of([
      {
        key: "Escape",
        run(view) {
          const state = view.state.field(correctionVisualField, false);
          if (state?.openId) {
            view.dispatch({ effects: openRecent.of(null) });
            return true;
          }
          return false;
        },
      },
    ]),
  ];
}
