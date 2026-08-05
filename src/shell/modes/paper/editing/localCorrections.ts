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
  extractCorrectionWindow,
  extractProjectVocabulary,
  planLocalCorrections,
  protectedMarkdownRanges,
  type PlannedLocalCorrection,
} from "./localCorrectionCore";
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
}

interface CorrectionVisualState {
  recent: RecentCorrection[];
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
const aliasExpansions = Annotation.define<RecentCorrection[]>();

function buildDecorations(recent: readonly RecentCorrection[]): DecorationSet {
  return Decoration.set(
    recent
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
    true,
  );
}

const correctionVisualField = StateField.define<CorrectionVisualState>({
  create: () => ({ recent: [], openId: null, decorations: Decoration.none }),
  update(value, tr) {
    let recent = value.recent.map((c) => ({
      ...c,
      from: tr.changes.mapPos(c.from, -1),
      to: tr.changes.mapPos(c.to, 1),
    }));
    let openId = value.openId;

    if (tr.docChanged) {
      recent = recent.filter(
        (c) => tr.newDoc.sliceString(c.from, c.to) === c.replacement,
      );
      if (openId && !recent.some((c) => c.id === openId)) openId = null;
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
      }
    }
    return { recent, openId, decorations: buildDecorations(recent) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    showTooltip.from(field, (value): Tooltip | null => {
      const correction = value.recent.find((c) => c.id === value.openId);
      if (!correction) return null;
      return {
        pos: correction.from,
        end: correction.to,
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
          label.textContent = correction.kind === "alias" ? "Expanded alias" : "Corrected";
          const change = document.createElement("span");
          change.className = "cm-local-correction-change";
          change.textContent = `${correction.original} → ${correction.replacement}`;
          copy.append(label, change);

          const controls = document.createElement("div");
          controls.className = "cm-local-correction-actions";
          const undo = document.createElement("button");
          undo.type = "button";
          undo.textContent = "Undo";
          undo.title = correction.kind === "alias"
            ? "Restore the alias this time"
            : "Restore this text and do not repeat this correction in this project";
          undo.onclick = () => view.state.facet(correctionActions).revert(view, correction, "undo");
          controls.append(undo);

          if (correction.kind === "alias" && correction.aliasScope) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "Remove alias";
            remove.title = `Remove “${correction.original}” from the ${correction.aliasScope === "personal" ? "personal" : "project"} aliases`;
            remove.onclick = () => view.state.facet(correctionActions).revert(view, correction, "remove-alias");
            controls.append(remove);
          } else if (!/\s/.test(correction.original)) {
            const add = document.createElement("button");
            add.type = "button";
            add.textContent = "Add to dictionary";
            add.title = `Always recognize “${correction.original}” in this project`;
            add.onclick = () => view.state.facet(correctionActions).revert(view, correction, "add-word");
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
  if (firstLine.text.includes("|") || /^\s*(?:```|~~~)/.test(firstLine.text)) return true;

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

function insertedBoundary(update: ViewUpdate): boolean {
  for (const tr of update.transactions) {
    if (!tr.isUserEvent("input.type") || tr.isUserEvent("input.type.compose")) continue;
    let boundary = false;
    tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      const text = inserted.toString();
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "\n") {
          boundary = true;
          break;
        }
        if (!/\s/.test(text[i])) continue;
        let before = fromB + i - 1;
        while (before >= 0 && /["'’\])}]/.test(tr.newDoc.sliceString(before, before + 1))) before -= 1;
        if (before >= 0 && /[.!?]/.test(tr.newDoc.sliceString(before, before + 1))) {
          boundary = true;
          break;
        }
      }
    });
    if (boundary) return true;
  }
  return false;
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
}

class CorrectionController {
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
  private failedNoticeShown = false;
  private enabledState: boolean;
  private readonly resetLearning = () => {
    this.profile = new LocalCorrectionProfile(this.activeProjectKey);
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
    this.activeProjectKey = options.projectKey();
    this.profile = new LocalCorrectionProfile(this.activeProjectKey);
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
      this.pending = null;
      this.queue = [];
      this.lastBatch = [];
      if (this.triggerTimer) {
        clearTimeout(this.triggerTimer);
        this.triggerTimer = null;
      }
      if (this.options.enabled()) {
        this.options.onStatus?.("loading");
        this.scheduleWarm();
      }
    }
    const enabled = this.options.enabled();
    if (enabled !== this.enabledState) {
      this.enabledState = enabled;
      if (enabled) {
        this.options.onStatus?.("loading");
        this.scheduleWarm();
      } else {
        this.options.onStatus?.("off");
        if (this.triggerTimer) clearTimeout(this.triggerTimer);
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
      this.queue = this.queue.map((queued) => {
        const from = update.changes.mapPos(queued.from, -1);
        const to = update.changes.mapPos(queued.to, -1);
        return {
          ...queued,
          from,
          to,
          // A prior local fix may land inside a newer queued snapshot. Refresh
          // that snapshot from the mapped document rather than dropping the
          // rest of the completed sentence.
          text: update.state.doc.sliceString(from, to),
        };
      });
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
      } else if (changesTouchRange(update, this.lastBatch[0].from, this.lastBatch.at(-1)!.to)) {
        this.lastBatch = [];
      } else {
        this.lastBatch = mapped;
      }
    }

    if (update.docChanged) this.scheduleVocabularyRefresh();
    if (!enabled) {
      this.options.onStatus?.("off");
      return;
    }
    if (insertedBoundary(update)) this.scheduleCorrection();
  }

  destroy(): void {
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    if (this.vocabularyTimer) clearTimeout(this.vocabularyTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.idleHandle != null && "cancelIdleCallback" in window) window.cancelIdleCallback(this.idleHandle);
    window.removeEventListener(LOCAL_CORRECTION_RESET_EVENT, this.resetLearning);
    window.removeEventListener(LOCAL_LANGUAGE_CHANGED_EVENT, this.languageChanged);
    this.unsubscribeStatus?.();
  }

  private scheduleWarm(): void {
    const warm = () => {
      this.idleHandle = null;
      this.refreshVocabulary();
      localCorrectionService.warm(this.activeProjectKey, [...this.projectWords]);
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
    if (replace) localCorrectionService.replaceVocabulary(this.activeProjectKey, words);
    else localCorrectionService.updateVocabulary(this.activeProjectKey, words);
  }

  private scheduleCorrection(): void {
    const queued = this.captureWindow();
    if (!queued) return;
    const same = this.queue.findIndex((item) => item.from === queued.from);
    if (same >= 0) this.queue[same] = queued;
    else if (!this.pending || this.pending.from !== queued.from || this.pending.text !== queued.text) {
      this.queue.push(queued);
      this.queue = this.queue.slice(-4);
    }
    if (this.triggerTimer || this.inFlight) return;
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      void this.runCorrection();
    }, 24);
  }

  private captureWindow(): PendingWindow | null {
    if (!this.options.enabled() || !this.view.hasFocus || !this.view.state.selection.main.empty) return null;
    const head = this.view.state.selection.main.head;
    const floor = Math.max(0, head - 520);
    const slice = this.view.state.doc.sliceString(floor, head);
    const localWindow = extractCorrectionWindow(slice, slice.length);
    if (!localWindow) return null;
    const queued: PendingWindow = {
      id: ++this.requestN,
      from: floor + localWindow.from,
      to: floor + localWindow.to,
      text: localWindow.text,
    };
    return protectedByEditor(this.view.state, queued.from, queued.to) ? null : queued;
  }

  private async runCorrection(): Promise<void> {
    if (this.inFlight || !this.options.enabled()) return;
    const pending = this.queue.shift();
    if (!pending) return;
    if (this.view.state.doc.sliceString(pending.from, pending.to) !== pending.text) {
      if (this.queue.length) this.scheduleQueuedRun();
      return;
    }

    this.pending = pending;
    this.inFlight = true;
    try {
      const lints = await localCorrectionService.lint(pending.text);
      if (this.pending?.id !== pending.id || !this.options.enabled()) return;
      if (this.view.state.doc.sliceString(pending.from, pending.to) !== pending.text) return;

      const plans = planLocalCorrections(pending.text, lints, {
        blockedPairs: this.profile.blockedPairs(),
        projectWords: this.projectWords,
        explicitWords: this.explicitWords,
      })
        .map((plan) => ({
          ...plan,
          from: pending.from + plan.from,
          to: pending.from + plan.to,
        }))
        .filter((plan) => {
          if (protectedByEditor(this.view.state, plan.from, plan.to)) return false;
          return this.view.state.doc.sliceString(plan.from, plan.to) === plan.original;
        });
      if (plans.length) this.apply(plans);
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
  const controllerPlugin = ViewPlugin.define(
    (view) => (controller = new CorrectionController(view, options)),
    {
      eventHandlers: {
        mousedown(event, view) {
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-flux-correction]")
            : null;
          if (!target) {
            const state = view.state.field(correctionVisualField, false);
            if (state?.openId) view.dispatch({ effects: openRecent.of(null) });
            return false;
          }
          event.preventDefault();
          view.dispatch({ effects: openRecent.of(target.dataset.fluxCorrection ?? null) });
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
