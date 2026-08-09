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
import {
  guardContextCorrectionResult,
  makeContextCorrectionPacket,
  normalizeCorrectionCandidates,
  rescueApprovalKey,
  rescueReplacementAllowed,
  stableCorrectionHash,
  type CorrectionAggressiveness,
  type CandidateNormalizationOptions,
  type CorrectionCandidate,
  type ContextCorrectionDiagnosticStage,
  type ContextCorrectionPacketV1,
  type ProjectLanguageContextV1,
} from "./contextualCorrectionCore";
import {
  contextualCorrectionService,
  type ContextualCorrectionProvider,
} from "./contextualCorrectionService";
import {
  LOCAL_CORRECTION_RESET_EVENT,
  LOCAL_LANGUAGE_CHANGED_EVENT,
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
  contextualEnabled?(): boolean;
  contextualProvider?(): ContextualCorrectionProvider;
  contextualModel?(): string;
  contextualDialect?(): ProjectLanguageContextV1["dialect"];
  contextualAggressiveness?(): CorrectionAggressiveness;
  personalGuidance?(): string;
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
  delay: number;
  expiresAt: number;
  contextual?: boolean;
}

type ContextIssueStatus = "deferred" | "pending" | "declined" | "flagged";

interface ContextIssue {
  id: string;
  candidateId?: string;
  requestId?: string;
  from: number;
  to: number;
  original: string;
  status: ContextIssueStatus;
  harperKind: string;
  harperMessage: string;
  suggestions: string[];
  rescueSuggestions: string[];
  rejectedSuggestions: string[];
  reason?: string;
  attemptedReplacement?: string;
}

interface CorrectionVisualState {
  recent: RecentCorrection[];
  issues: ContextIssue[];
  openId: string | null;
  decorations: DecorationSet;
}

type RevertMode = "undo" | "add-word" | "remove-alias";

interface CorrectionActions {
  revert(view: EditorView, correction: RecentCorrection, mode: RevertMode): void;
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
const upsertContextIssues = StateEffect.define<ContextIssue[]>({
  map(value, changes) {
    return value.map((issue) => ({
      ...issue,
      from: changes.mapPos(issue.from, 1),
      to: changes.mapPos(issue.to, -1),
    }));
  },
});
const removeContextIssues = StateEffect.define<string[]>();
const clearContextIssues = StateEffect.define<null>();
const aliasExpansions = Annotation.define<RecentCorrection[]>();

function buildDecorations(recent: readonly RecentCorrection[], issues: readonly ContextIssue[]): DecorationSet {
  return Decoration.set(
    [
      ...recent
      .filter((c) => c.from < c.to)
      .map((c) =>
        Decoration.mark({
          class: `cm-local-correction${c.contextual ? " cm-local-correction-contextual" : ""} cm-local-correction-delay-${c.delay % 4}`,
          attributes: {
            "data-flux-correction": c.id,
            "aria-label": `${c.kind === "alias" ? "Expanded alias" : "Corrected"} ${c.original} to ${c.replacement}`,
          },
        }).range(c.from, c.to),
      ),
      ...issues
        .filter((issue) => issue.from < issue.to)
        .map((issue) => Decoration.mark({
          class: `cm-context-issue cm-context-issue-${issue.status}`,
          attributes: {
            "data-flux-context-issue": issue.id,
            // Chromium's native spelling marker would otherwise remain red
            // underneath Flux's orange declined state. Suppress it only for
            // the span whose full visual lifecycle Flux now owns.
            spellcheck: "false",
            "aria-label": issue.status === "declined"
              ? `Possible issue left unchanged: ${issue.original}`
              : `Possible issue detected: ${issue.original}`,
          },
        }).range(issue.from, issue.to)),
    ],
    true,
  );
}

const correctionVisualField = StateField.define<CorrectionVisualState>({
  create: () => ({ recent: [], issues: [], openId: null, decorations: Decoration.none }),
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
    let openId = value.openId;

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
      } else if (effect.is(upsertContextIssues)) {
        for (const issue of effect.value) {
          issues = issues.filter((existing) => !(
            existing.id === issue.id
            || (existing.original === issue.original && existing.from < issue.to && existing.to > issue.from)
          ));
          issues.push(issue);
        }
      } else if (effect.is(removeContextIssues)) {
        const ids = new Set(effect.value);
        issues = issues.filter((issue) => !ids.has(issue.id));
        if (openId && ids.has(openId)) openId = null;
      } else if (effect.is(clearContextIssues)) {
        issues = [];
        if (openId && !recent.some((c) => c.id === openId)) openId = null;
      }
    }
    return { recent, issues, openId, decorations: buildDecorations(recent, issues) };
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
            dom.className = "cm-context-issue-menu";
            dom.dataset.fluxContextIssueDetails = issue.status;
            dom.setAttribute("role", "dialog");
            dom.setAttribute("aria-label", "Correction judgment details");

            const copy = document.createElement("div");
            copy.className = "cm-context-issue-copy";
            const label = document.createElement("strong");
            label.textContent = issue.status === "declined"
              ? "Left unchanged"
              : issue.status === "pending"
                ? "Checking with smart context…"
                : issue.status === "flagged"
                  ? "Flagged by the local checker"
                  : "Waiting for sentence context…";
            const word = document.createElement("span");
            word.className = "cm-context-issue-word";
            word.textContent = issue.attemptedReplacement
              ? `${issue.original} → ${issue.attemptedReplacement}`
              : issue.original;
            const reason = document.createElement("span");
            reason.className = "cm-context-issue-reason";
            reason.textContent = issue.reason || issue.harperMessage || `${issue.harperKind} issue detected locally`;
            copy.append(label, word, reason);

            const options = [...new Set([
              ...issue.suggestions,
              ...issue.rescueSuggestions,
              ...issue.rejectedSuggestions,
            ])].slice(0, 8);
            if (options.length) {
              const considered = document.createElement("span");
              considered.className = "cm-context-issue-considered";
              considered.textContent = `Considered: ${options.join(", ")}`;
              copy.append(considered);
            }

            const close = document.createElement("button");
            close.type = "button";
            close.className = "icon";
            close.setAttribute("aria-label", "Close correction judgment details");
            close.textContent = "×";
            close.onclick = () => view.dispatch({ effects: openRecent.of(null) });
            dom.append(copy, close);
            return { dom };
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
          label.textContent = resolvedCorrection.kind === "alias" ? "Expanded alias" : "Corrected";
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
            remove.textContent = "Remove alias";
            remove.title = `Remove “${resolvedCorrection.original}” from the ${resolvedCorrection.aliasScope === "personal" ? "personal" : "project"} aliases`;
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

function diagnosticReason(stage: ContextCorrectionDiagnosticStage, replacement?: string): string {
  if (stage === "proposal-declined") return "The smart layer did not find a plausible spelling repair within the allowed bounds.";
  if (stage === "proposal-invalid") return replacement
    ? `The smart layer proposed “${replacement}”, but it fell outside this mode’s spelling-only safety bounds.`
    : "The smart layer proposed a repair, but it fell outside this mode’s spelling-only safety bounds.";
  if (stage === "scientific-preserved") return "Flux kept this because it may be valid scientific or intentional terminology.";
  if (stage === "approval-declined") return replacement
    ? `Flux considered “${replacement}”, but the independent approval pass did not prefer it to the original.`
    : "The independent approval pass did not prefer the proposed repair to the original.";
  if (stage === "kept") return "The smart layer preferred the original wording over the available corrections.";
  return "The correction was accepted by the smart layer but did not pass the final editor safety checks.";
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

interface PendingContext {
  from: number;
  to: number;
  packet: ContextCorrectionPacketV1;
}

interface BacklogChunk {
  from: number;
  to: number;
  text: string;
}

// Decoration cost is O(issues) on every transaction; a messy manuscript must
// not turn the whole document red or tax typing. First-come, capped.
const MAX_BACKLOG_FLAGS = 300;

class CorrectionController {
  private profile: LocalCorrectionProfile;
  private activeProjectKey: string;
  private projectWords = new Set<string>();
  private projectOccurrences = new Map<string, number>();
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
  private contextualInFlight = false;
  private activeContext: PendingContext | null = null;
  private contextualQueue: PendingContext[] = [];
  private backlogTimer: ReturnType<typeof setTimeout> | null = null;
  private backlogGen = 0;
  private backlogChunks: BacklogChunk[] = [];
  private backlogFlagged = 0;
  private failedNoticeShown = false;
  private enabledState: boolean;
  private contextualEnabledState: boolean;
  private dialectState: ProjectLanguageContextV1["dialect"];
  private aggressivenessState: CorrectionAggressiveness;
  private providerState: ContextualCorrectionProvider;
  private modelState: string;
  private readonly resetLearning = () => {
    this.profile.clearBlockedPairs();
    this.projectWords.clear();
    this.refreshVocabulary(true);
  };
  private readonly languageChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ projectKey?: string; scope?: LocalLanguageScope }>).detail;
    if (detail?.scope !== "personal" && detail?.projectKey !== this.activeProjectKey) return;
    this.profile = new LocalCorrectionProfile(this.activeProjectKey);
    this.refreshVocabulary(true);
    refreshLocalWordTools(this.view);
  };

  constructor(
    private readonly view: EditorView,
    private readonly options: LocalCorrectionsOptions,
  ) {
    this.enabledState = options.enabled();
    this.contextualEnabledState = options.contextualEnabled?.() !== false;
    this.dialectState = options.contextualDialect?.() ?? "american";
    this.aggressivenessState = options.contextualAggressiveness?.() ?? "standard";
    this.providerState = options.contextualProvider?.() ?? "flux";
    this.modelState = options.contextualModel?.() ?? "qwen3-4b-q4_k_m";
    this.activeProjectKey = options.projectKey();
    this.profile = new LocalCorrectionProfile(this.activeProjectKey);
    void this.profile.ready().then((hydrated) => {
      if (!hydrated || this.activeProjectKey !== options.projectKey()) return;
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
    if (options.enabled()) this.scheduleWarm();
    else options.onStatus?.("off");
  }

  update(update: ViewUpdate): void {
    const projectKey = this.options.projectKey();
    if (projectKey !== this.activeProjectKey) {
      this.activeProjectKey = projectKey;
      this.profile = new LocalCorrectionProfile(projectKey);
      this.projectWords.clear();
      this.projectOccurrences.clear();
      this.pending = null;
      this.queue = [];
      if (this.activeContext) void contextualCorrectionService.cancel(this.activeContext.packet.requestId);
      this.activeContext = null;
      this.contextualQueue = [];
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
        if (hydrated && this.activeProjectKey === projectKey) this.refreshVocabulary(true);
      });
    }
    const enabled = this.options.enabled();
    const contextualEnabled = this.options.contextualEnabled?.() !== false;
    const dialect = this.options.contextualDialect?.() ?? "american";
    const aggressiveness = this.options.contextualAggressiveness?.() ?? "standard";
    const provider = this.options.contextualProvider?.() ?? "flux";
    const model = this.options.contextualModel?.() ?? (provider === "ollama" ? "qwen3:4b-instruct" : "qwen3-4b-q4_k_m");
    if (dialect !== this.dialectState) {
      this.dialectState = dialect;
      localCorrectionService.setDialect(this.activeProjectKey, dialect, [...this.projectWords]);
    }
    if (provider !== this.providerState || model !== this.modelState || aggressiveness !== this.aggressivenessState) {
      this.providerState = provider;
      this.modelState = model;
      this.aggressivenessState = aggressiveness;
      if (this.activeContext) void contextualCorrectionService.cancel(this.activeContext.packet.requestId);
      this.activeContext = null;
      this.contextualQueue = [];
      this.removeTransientIssues();
      if (enabled && contextualEnabled) {
        void contextualCorrectionService.warm(provider, model);
      }
    }
    if (contextualEnabled !== this.contextualEnabledState) {
      this.contextualEnabledState = contextualEnabled;
      if (contextualEnabled && enabled) void contextualCorrectionService.warm(provider, model);
      else {
        if (this.activeContext) void contextualCorrectionService.cancel(this.activeContext.packet.requestId);
        this.activeContext = null;
        this.contextualQueue = [];
        this.removeTransientIssues();
      }
    }
    if (enabled !== this.enabledState) {
      this.enabledState = enabled;
      if (enabled) {
        this.options.onStatus?.("loading");
        this.scheduleWarm();
      } else {
        this.options.onStatus?.("off");
        if (this.triggerTimer) clearTimeout(this.triggerTimer);
        if (this.activeContext) void contextualCorrectionService.cancel(this.activeContext.packet.requestId);
        this.activeContext = null;
        this.contextualQueue = [];
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
    if (this.activeContext && update.docChanged) {
      if (changesTouchRange(update, this.activeContext.from, this.activeContext.to)) {
        const requestId = this.activeContext.packet.requestId;
        void contextualCorrectionService.cancel(this.activeContext.packet.requestId);
        this.activeContext = null;
        this.removeRequestIssuesSoon([requestId]);
      } else {
        this.activeContext.from = update.changes.mapPos(this.activeContext.from, -1);
        this.activeContext.to = update.changes.mapPos(this.activeContext.to, -1);
      }
    }
    if (this.contextualQueue.length && update.docChanged) {
      const dropped: string[] = [];
      this.contextualQueue = this.contextualQueue.flatMap((queued) => {
        if (changesTouchRange(update, queued.from, queued.to)) {
          dropped.push(queued.packet.requestId);
          return [];
        }
        return [{
          ...queued,
          from: update.changes.mapPos(queued.from, -1),
          to: update.changes.mapPos(queued.to, -1),
        }];
      });
      this.removeRequestIssuesSoon(dropped);
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

    if (update.docChanged) this.scheduleVocabularyRefresh();
    if (!enabled) {
      this.options.onStatus?.("off");
      return;
    }
    // A document arriving OUTSIDE typing — open, switch, external reload — is
    // the backlog-flag trigger: existing Harper issues get a red underline
    // without any correction or model call. User events (typing, undo, our own
    // applies) and the alias expander's appended replacement never rescan.
    const programmaticLoad = update.transactions.some((tr) =>
      tr.docChanged && tr.annotation(Transaction.userEvent) == null && !tr.annotation(aliasExpansions));
    if (programmaticLoad) this.scheduleBacklogScan();
    const boundaries = insertedBoundaries(update);
    if (boundaries.has("word")) this.scheduleCorrection("word");
    if (boundaries.has("sentence")) this.scheduleCorrection("sentence");
  }

  destroy(): void {
    this.backlogGen += 1;
    if (this.backlogTimer) clearTimeout(this.backlogTimer);
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    if (this.vocabularyTimer) clearTimeout(this.vocabularyTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.idleHandle != null && "cancelIdleCallback" in window) window.cancelIdleCallback(this.idleHandle);
    window.removeEventListener(LOCAL_CORRECTION_RESET_EVENT, this.resetLearning);
    window.removeEventListener(LOCAL_LANGUAGE_CHANGED_EVENT, this.languageChanged);
    this.unsubscribeStatus?.();
    if (this.activeContext) void contextualCorrectionService.cancel(this.activeContext.packet.requestId);
  }

  private scheduleWarm(): void {
    const warm = () => {
      this.idleHandle = null;
      this.refreshVocabulary();
      localCorrectionService.setDialect(this.activeProjectKey, this.dialectState, [...this.projectWords]);
      localCorrectionService.warm(this.activeProjectKey, [...this.projectWords]);
      if (this.options.contextualEnabled?.() !== false) {
        const provider = this.options.contextualProvider?.() ?? "flux";
        const model = this.options.contextualModel?.() ?? (provider === "ollama" ? "qwen3:4b-instruct" : "qwen3-4b-q4_k_m");
        void contextualCorrectionService.warm(provider, model);
      }
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
    const sources = [
      this.view.state.doc.toString(),
      ...(this.options.contextStrings?.() ?? []),
    ];
    this.explicitWords = this.profile.allWords();
    const words = [...this.explicitWords, ...extractProjectVocabulary(sources)];
    this.projectWords = new Set(words.map((w) => w.toLocaleLowerCase()));
    this.projectOccurrences = new Map(
      [...extractProjectVocabularyOccurrences(sources)].map(([key, value]) => [key, value.n]),
    );
    if (replace) localCorrectionService.replaceVocabulary(this.activeProjectKey, words);
    else localCorrectionService.updateVocabulary(this.activeProjectKey, words);
  }

  private normalizationOptions(): CandidateNormalizationOptions {
    return {
      blockedPairs: this.profile.blockedPairs(),
      explicitWords: this.explicitWords,
      personalWords: this.profile.words("personal"),
      projectWords: this.profile.words("project"),
      projectOccurrences: this.projectOccurrences,
      aggressiveness: this.options.contextualAggressiveness?.() ?? "standard",
    };
  }

  private candidateIssues(
    pending: Pick<PendingWindow, "from">,
    candidates: readonly CorrectionCandidate[],
    status: ContextIssueStatus,
    requestId?: string,
  ): ContextIssue[] {
    return candidates.map((candidate) => ({
      id: `ci-${stableCorrectionHash(`${pending.from + candidate.from}:${pending.from + candidate.to}\u0000${candidate.original}`)}`,
      candidateId: candidate.id,
      requestId,
      from: pending.from + candidate.from,
      to: pending.from + candidate.to,
      original: candidate.original,
      status,
      harperKind: candidate.harperKind,
      harperMessage: candidate.harperMessage,
      suggestions: candidate.suggestions.map((suggestion) => suggestion.replacement),
      rescueSuggestions: [...candidate.rescueSuggestions],
      rejectedSuggestions: [...candidate.rejectedSuggestions],
    }));
  }

  /** Does a window starting at `from` open a real sentence in the document? */
  private startsSentence(from: number): boolean {
    return windowStartsSentence(this.view.state.doc.sliceString(Math.max(0, from - 96), from));
  }

  /**
   * A window that has just been linted is the authority on the range it may
   * correct: a deferred span in there that this pass no longer proposes came
   * from an earlier, narrower window and must not sit at "waiting for sentence
   * context" forever. Nothing outside that range is touched — the rest of the
   * window was context, and its issues belong to the lane that raised them.
   */
  private publishDeferredIssues(pending: PendingWindow, fresh: readonly ContextIssue[]): void {
    const scope = correctableRange(pending);
    const keep = new Set(fresh.map((issue) => issue.id));
    const stale = (this.view.state.field(correctionVisualField, false)?.issues ?? [])
      .filter((issue) => issue.status === "deferred" && !keep.has(issue.id))
      .filter((issue) => issue.from >= scope.from && issue.to <= scope.to)
      .map((issue) => issue.id);
    if (!stale.length && !fresh.length) return;
    this.view.dispatch({
      effects: [
        ...(stale.length ? [removeContextIssues.of(stale)] : []),
        ...(fresh.length ? [upsertContextIssues.of([...fresh])] : []),
      ],
    });
  }

  private removeTransientIssues(): void {
    queueMicrotask(() => {
      const visual = this.view.state.field(correctionVisualField, false);
      // Deferred/pending spans belong to an in-flight judgment pass; flagged
      // backlog spans and settled declines are provider-independent and stay.
      const ids = visual?.issues
        .filter((issue) => issue.status === "deferred" || issue.status === "pending")
        .map((issue) => issue.id) ?? [];
      if (ids.length) this.view.dispatch({ effects: removeContextIssues.of(ids) });
    });
  }

  private clearIssuesSoon(): void {
    queueMicrotask(() => this.view.dispatch({ effects: clearContextIssues.of(null) }));
  }

  private removeRequestIssuesSoon(requestIds: readonly string[]): void {
    const requests = new Set(requestIds);
    if (!requests.size) return;
    queueMicrotask(() => {
      const visual = this.view.state.field(correctionVisualField, false);
      const ids = visual?.issues
        .filter((issue) => issue.requestId && requests.has(issue.requestId) && issue.status !== "declined")
        .map((issue) => issue.id) ?? [];
      if (ids.length) this.view.dispatch({ effects: removeContextIssues.of(ids) });
    });
  }

  private declineContext(
    pending: PendingContext,
    result: import("./contextualCorrectionCore").ContextCorrectionResultV1 | null,
    acceptedCandidateIds: ReadonlySet<string>,
    fallbackReason: string,
    approvedRescues: ReadonlySet<string> = new Set(),
    forceFallbackReason = false,
  ): void {
    const decisions = new Map(result?.decisions.map((decision) => [decision.candidateId, decision]) ?? []);
    const diagnostics = new Map(result?.diagnostics?.map((diagnostic) => [diagnostic.candidateId, diagnostic]) ?? []);
    const issues = this.candidateIssues(pending, pending.packet.candidates, "declined", pending.packet.requestId)
      .filter((issue) => issue.candidateId && !acceptedCandidateIds.has(issue.candidateId))
      .map((issue) => {
        const candidate = pending.packet.candidates.find((value) => value.id === issue.candidateId)!;
        const decision = decisions.get(candidate.id);
        const diagnostic = diagnostics.get(candidate.id);
        const selected = decision?.action === "use" && Number.isInteger(decision.suggestionIndex)
          ? candidate.suggestions[decision.suggestionIndex!]?.replacement
          : decision?.action === "rescue" ? decision.replacement : undefined;
        let reason = fallbackReason;
        if (forceFallbackReason) {
          reason = fallbackReason;
        } else if (decision?.action === "rescue" && selected && !approvedRescues.has(rescueApprovalKey(candidate.id, selected))) {
          reason = `Flux proposed “${selected}”, but the final local dictionary check could not verify it.`;
        } else if ((decision?.action === "use" || decision?.action === "rescue") && !acceptedCandidateIds.has(candidate.id)) {
          reason = "The smart layer selected a repair, but Flux’s final document-safety checks rejected it.";
        } else if (diagnostic) {
          reason = diagnosticReason(diagnostic.stage, diagnostic.replacement);
        }
        return {
          ...issue,
          reason,
          attemptedReplacement: diagnostic?.replacement ?? selected,
        };
      });
    if (issues.length) this.view.dispatch({ effects: upsertContextIssues.of(issues) });
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
   * only decorates — it never edits and never calls the judgment model. Live
   * lanes always outrank it: the caret's own sentence is skipped, busy lanes
   * defer the scan, and an existing issue's status is never downgraded.
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
    if (this.inFlight || this.queue.length || this.contextualInFlight) {
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
      const raw = await localCorrectionService.lint(chunk.text);
      if (gen !== this.backlogGen || !this.options.enabled()) return;
      if (this.view.state.doc.sliceString(chunk.from, chunk.to) !== chunk.text) {
        next();
        return;
      }
      // Long paragraphs are cut at whitespace when they hold no sentence
      // boundary, so a chunk can start mid-sentence like any other window.
      const lints = scopeWindowLints(chunk, raw, this.startsSentence(chunk.from));
      const existing = this.view.state.field(correctionVisualField, false)?.issues ?? [];
      const candidates = normalizeCorrectionCandidates(chunk.text, lints, "sentence", {
        ...this.normalizationOptions(),
        harperLintsOnly: true,
      }).filter((candidate) => {
        const from = chunk.from + candidate.from;
        const to = chunk.from + candidate.to;
        if (existing.some((issue) => from < issue.to && to > issue.from)) return false;
        return !protectedByEditor(this.view.state, from, to);
      });
      const kept = candidates.slice(0, Math.max(0, MAX_BACKLOG_FLAGS - this.backlogFlagged));
      this.backlogFlagged += kept.length;
      if (kept.length) {
        this.view.dispatch({ effects: upsertContextIssues.of(this.candidateIssues(chunk, kept, "flagged")) });
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
    // Both lanes now anchor at the sentence start and can hold identical text,
    // so an in-flight word run must never swallow the sentence run that carries
    // the same text into contextual judgment.
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
    // Sentence snapshots are rare, semantically complete, and feed the smart
    // lane. Never let a burst of word-boundary work starve them while the user
    // is typing continuously.
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
      const raw = await localCorrectionService.lint(pending.text, pending.focus);
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
        // A sentence snapshot containing mechanical edits is recaptured after
        // those edits land so the model never judges stale pre-Harper text.
        if (pending.lane === "sentence") this.scheduleCorrection("sentence");
      } else {
        const candidates = withinFocus(normalizeCorrectionCandidates(
          pending.text,
          lints,
          "sentence",
          this.normalizationOptions(),
        ), pending.focus);
        this.publishDeferredIssues(pending, this.candidateIssues(pending, candidates, "deferred"));
        if (pending.lane === "sentence") this.enqueueContextual(pending, lints, candidates);
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

  private enqueueContextual(
    pending: PendingWindow,
    lints: readonly import("./localCorrectionCore").LocalLintRecord[],
    normalized?: readonly CorrectionCandidate[],
  ): void {
    if (this.options.contextualEnabled?.() === false) return;
    const candidates = normalized?.length
      ? [...normalized]
      : normalizeCorrectionCandidates(pending.text, lints, "sentence", this.normalizationOptions());
    if (!candidates.length) return;
    const contextStrings = (this.options.contextStrings?.() ?? [])
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 24)
      .map((value) => value.slice(0, 160));
    const headingLines: string[] = [];
    const document = this.view.state.doc;
    let lineNumber = document.lineAt(pending.from).number;
    // Context assembly runs behind the caret, but it still shares the renderer
    // thread. Walk a fixed number of lines backward rather than stringifying
    // the manuscript; four recent headings are more useful than an O(doc)
    // scan and keep late model preparation outside the typing budget.
    for (let scanned = 0; lineNumber > 0 && scanned < 300 && headingLines.length < 4; scanned += 1) {
      const text = document.line(lineNumber).text;
      if (/^#{1,6}\s+/.test(text)) headingLines.unshift(text.replace(/^#{1,6}\s+/, "").trim());
      lineNumber -= 1;
    }
    const dialect = this.options.contextualDialect?.() ?? "american";
    const canonicalTerms: string[] = [];
    const seenTerms = new Set<string>();
    for (const source of [this.explicitWords, this.projectWords]) {
      for (const word of source) {
        const key = word.toLocaleLowerCase();
        if (!word || seenTerms.has(key)) continue;
        seenTerms.add(key);
        canonicalTerms.push(word);
        if (canonicalTerms.length >= 80) break;
      }
      if (canonicalTerms.length >= 80) break;
    }
    const projectContext: ProjectLanguageContextV1 = {
      revision: stableCorrectionHash(JSON.stringify([
        dialect,
        this.explicitWords,
        contextStrings,
        this.options.personalGuidance?.() ?? "",
        this.profile.guidance("project"),
      ])),
      dialect,
      projectTitle: contextStrings[0],
      documentTitle: contextStrings[1] ?? contextStrings[0],
      sectionPath: headingLines,
      personalGuidance: (this.options.personalGuidance?.() ?? this.profile.guidance("personal")).slice(0, 500),
      projectGuidance: this.profile.guidance("project").slice(0, 500),
      canonicalTerms,
      contextHints: contextStrings,
    };
    const packet = makeContextCorrectionPacket(
      `paper-${++this.requestN}`,
      pending.text,
      candidates,
      projectContext,
      { sectionPath: headingLines },
      "sentence",
      this.options.contextualAggressiveness?.() ?? "standard",
    );
    this.view.dispatch({ effects: upsertContextIssues.of(this.candidateIssues(pending, candidates, "pending", packet.requestId)) });
    const queued = { from: pending.from, to: pending.to, packet };
    const same = this.contextualQueue.findIndex((item) => item.from === queued.from);
    if (same >= 0) this.contextualQueue[same] = queued;
    else this.contextualQueue.push(queued);
    this.contextualQueue = this.contextualQueue.slice(-3);
    void this.runContextual();
  }

  private async runContextual(): Promise<void> {
    if (this.contextualInFlight || !this.options.enabled() || this.options.contextualEnabled?.() === false) return;
    const pending = this.contextualQueue.shift();
    if (!pending) return;
    if (this.view.state.doc.sliceString(pending.from, pending.to) !== pending.packet.text) {
      if (this.contextualQueue.length) void this.runContextual();
      return;
    }
    this.contextualInFlight = true;
    this.activeContext = pending;
    try {
      const result = await contextualCorrectionService.decide(pending.packet, {
        provider: this.options.contextualProvider?.() ?? "ollama",
        model: this.options.contextualModel?.() ?? "qwen3:4b-instruct",
        thinking: false,
        aggressiveness: pending.packet.aggressiveness,
      });
      if (this.activeContext?.packet.requestId !== pending.packet.requestId) return;
      if (Date.now() - pending.packet.createdAt > 1_500) {
        this.declineContext(
          pending,
          result,
          new Set(),
          "The judgment arrived after Flux’s safe 1.5-second application window, so the text was left untouched.",
          new Set(),
          true,
        );
        return;
      }
      const candidates = new Map(pending.packet.candidates.map((candidate) => [candidate.id, candidate]));
      const approvedRescues = new Set<string>();
      await Promise.all(result.decisions.map(async (decision) => {
        if (decision.action !== "rescue" || typeof decision.replacement !== "string") return;
        const candidate = candidates.get(decision.candidateId);
        if (!candidate || !rescueReplacementAllowed(candidate, decision.replacement!)) return;
        try {
          // Harper independently proves every model-originated word. Project
          // vocabulary has its own explicit correction path; an unfamiliar
          // generated token must never bootstrap itself into silent prose.
          const validation = await localCorrectionService.lint(decision.replacement!);
          const unknown = validation.some((lint) => lint.kind === "Spelling" || lint.kind === "Typo");
          if (!unknown) approvedRescues.add(rescueApprovalKey(candidate.id, decision.replacement!));
        } catch {
          // A failed lexical check rejects only the generated proposal. Normal
          // supplied-candidate decisions in the same result remain usable.
        }
      }));
      if (this.activeContext?.packet.requestId !== pending.packet.requestId) return;
      if (Date.now() - pending.packet.createdAt > 1_500) {
        this.declineContext(
          pending,
          result,
          new Set(),
          "The final local check finished after Flux’s safe 1.5-second application window, so the text was left untouched.",
          approvedRescues,
          true,
        );
        return;
      }
      const live = this.view.state.doc.sliceString(this.activeContext.from, this.activeContext.to);
      const guarded = guardContextCorrectionResult(pending.packet, result, live, {
        blockedPairs: this.profile.blockedPairs(),
        explicitWords: this.explicitWords,
        approvedRescues,
      });
      const plans = guarded.map((plan) => ({
        ...plan,
        from: this.activeContext!.from + plan.from,
        to: this.activeContext!.from + plan.to,
      })).filter((plan) => !protectedByEditor(this.view.state, plan.from, plan.to));
      const acceptedCandidateIds = new Set(plans.flatMap((plan) => pending.packet.candidates
        .filter((candidate) => (
          this.activeContext!.from + candidate.from === plan.from
          && this.activeContext!.from + candidate.to === plan.to
          && candidate.original === plan.original
        ))
        .map((candidate) => candidate.id)));
      this.declineContext(
        pending,
        result,
        acceptedCandidateIds,
        "The smart layer left this possible issue unchanged.",
        approvedRescues,
      );
      if (plans.length) this.apply(plans, true);
    } catch (error) {
      // Context judgment is optional and fail-closed. Harper remains live, and
      // the visible issue settles so a provider problem never looks like a
      // judgment that is still running.
      if (this.activeContext?.packet.requestId === pending.packet.requestId) {
        const message = error instanceof Error && error.message
          ? `Smart judgment could not finish: ${error.message.slice(0, 180)}`
          : "Smart judgment could not finish; the text was left unchanged.";
        this.declineContext(pending, null, new Set(), message);
      }
    } finally {
      if (this.activeContext?.packet.requestId === pending.packet.requestId) this.activeContext = null;
      this.contextualInFlight = false;
      if (this.contextualQueue.length) void this.runContextual();
    }
  }

  expandAliases(tr: Transaction): Transaction | readonly TransactionSpec[] {
    if (
      !this.options.enabled() ||
      !tr.docChanged ||
      !tr.isUserEvent("input.type") ||
      tr.isUserEvent("input.type.compose")
    ) return tr;

    const matches = new Map<number, { from: number; to: number; original: string; replacement: string; scope: LocalLanguageScope }>();
    tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      const text = inserted.toString();
      for (let i = 0; i < text.length; i += 1) {
        if (!/[\s.,;:!?()[\]{}]/.test(text[i])) continue;
        const boundary = fromB + i;
        let from = boundary;
        while (from > 0 && /[\p{L}\p{M}\d_-]/u.test(tr.newDoc.sliceString(from - 1, from))) from -= 1;
        if (from === boundary || boundary - from > 32 || matches.has(from)) continue;
        const original = tr.newDoc.sliceString(from, boundary);
        const alias = this.profile.resolveAlias(original);
        if (!alias || alias.expansion === original || protectedAliasRange(tr.newDoc, from, boundary)) continue;
        matches.set(from, {
          from,
          to: boundary,
          original,
          replacement: alias.expansion,
          scope: alias.scope,
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

  private apply(plans: Array<PlannedLocalCorrection & { from: number; to: number }>, contextual = false): void {
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
        contextual,
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
  const controllerPlugin = ViewPlugin.define(
    (view) => (controller = new CorrectionController(view, options)),
    {
      eventHandlers: {
        mousedown(event, view) {
          const correctionTarget = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-flux-correction]")
            : null;
          const issueTarget = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-flux-context-issue]")
            : null;
          const targetId = correctionTarget?.dataset.fluxCorrection ?? issueTarget?.dataset.fluxContextIssue;
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
      revert(_view, correction, mode) {
        controller?.revert(correction, mode);
      },
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
