import { Dialect, LocalLinter } from "harper.js";
import { slimBinary } from "harper.js/slimBinary";
import {
  generateMechanicalRescueVariants,
  mechanicalScore,
  type LocalLintRecord,
} from "./localCorrectionCore";

type Inbound =
  | { type: "init"; words: string[] }
  | { type: "words"; words: string[] }
  | { type: "dialect"; dialect: "american" | "british" | "canadian" | "australian"; words: string[] }
  | { type: "lint"; id: number; text: string; mode?: "repair" | "lintOnly"; focus?: { from: number; to: number } };

type Outbound =
  | { type: "ready" }
  | { type: "lints"; id: number; lints: LocalLintRecord[]; elapsedMs: number }
  | { type: "error"; id?: number; message: string };

const linter = new LocalLinter({ binary: slimBinary });
let ready: Promise<void> | null = null;

function ensureReady(words: string[] = []): Promise<void> {
  if (!ready) {
    ready = linter.setup().then(async () => {
      if (words.length) await linter.importWords(words);
      self.postMessage({ type: "ready" } satisfies Outbound);
    });
  }
  return ready;
}

async function replaceWords(words: string[]): Promise<void> {
  await ensureReady();
  await linter.clearWords();
  if (words.length) await linter.importWords(words);
}

const dialects = {
  american: Dialect.American,
  british: Dialect.British,
  canadian: Dialect.Canadian,
  australian: Dialect.Australian,
} as const;

async function verifiedMechanicalWords(problem: string, id: number): Promise<string[]> {
  const variants = generateMechanicalRescueVariants(problem);
  if (!variants.length) return [];
  const verified: string[] = [];
  // Validate each form as its own document. Harper's sentence-level rules may
  // coalesce or cap diagnostics in an artificial many-word probe, which can
  // accidentally make an unchecked nonsense form look dictionary-backed.
  for (const variant of variants) {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (cancelled.has(id)) return [];
    // Rescue probes are scheduling quanta: a completed word in another pane
    // can run before this request starts its next independent WASM operation.
    const barrier = queue.findIndex(m => m.type !== "lint");
    const next = queue.findIndex((m, i) => (barrier < 0 || i < barrier) && m.type === "lint" && m.mode !== "lintOnly");
    if (next >= 0) await processMessage(queue.splice(next, 1)[0]);
    const raw = await linter.lint(variant, { language: "plaintext", dedup: true });
    let unknown = false;
    for (const lint of raw) {
      if (lint.lint_kind() === "Spelling" || lint.lint_kind() === "Typo") unknown = true;
      lint.free();
    }
    if (!unknown) verified.push(variant);
  }
  return verified
    .sort((a, b) => mechanicalScore(problem, b) - mechanicalScore(problem, a) || a.localeCompare(b, "en"))
    .slice(0, 6);
}

const queue: Inbound[] = [];
const cancelled = new Set<number>();
const activeIds = new Set<number>();
let running = false;
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // Preserve dictionary barriers; within a lint batch, live completion
      // precedes annotation-only work. A backlog never runs rescue probes.
      const barrier = queue.findIndex(m => m.type !== "lint");
      const until = barrier < 0 ? queue.length : barrier;
      const foreground = queue.findIndex((m, i) => i < until && m.type === "lint" && m.mode !== "lintOnly");
      const [message] = queue.splice(foreground >= 0 ? foreground : 0, 1);
      await processMessage(message);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { running = false; }
}
self.onmessage = (event: MessageEvent<Inbound | { type: "cancel"; ids: number[] }>) => {
  if (event.data.type === "cancel") {
    for (const id of event.data.ids) if (activeIds.has(id) || queue.some(m => m.type === "lint" && m.id === id)) cancelled.add(id);
    for (let i = queue.length - 1; i >= 0; i--) { const m = queue[i]; if (m.type === "lint" && cancelled.has(m.id)) { queue.splice(i, 1); cancelled.delete(m.id); } }
    return;
  }
  queue.push(event.data); void drain();
};
async function processMessage(message: Inbound) {
    if (message.type === "lint") activeIds.add(message.id);
    try {
      if (message.type === "init") {
        await ensureReady(message.words);
        return;
      }
      if (message.type === "words") {
        await replaceWords(message.words);
        return;
      }
      if (message.type === "dialect") {
        await ensureReady();
        await linter.setDialect(dialects[message.dialect]);
        await linter.clearWords();
        if (message.words.length) await linter.importWords(message.words);
        return;
      }

      await ensureReady();
      const started = performance.now();
      const raw = await linter.lint(message.text, { language: "plaintext", dedup: true });
      const lints: LocalLintRecord[] = [];
      for (const lint of raw) {
        const span = lint.span();
        const suggestions = lint.suggestions();
        const problem = lint.get_problem_text();
        const kind = lint.lint_kind();
        const replacements = suggestions.map((s) => s.get_replacement_text());
        let partsAreKnown: boolean | undefined;
        const boundaryForm = /\s/.test(problem) ? problem : replacements.length === 1 && /\s/.test(replacements[0]) ? replacements[0] : "";
        if ((kind === "WordChoice" || kind === "BoundaryError" || kind === "Typo") && boundaryForm) {
          partsAreKnown = true;
          for (const part of boundaryForm.trim().split(/\s+/)) {
            const partLints = await linter.lint(part, { language: "plaintext", dedup: true });
            if (partLints.some((candidate) => candidate.lint_kind() === "Spelling" || candidate.lint_kind() === "Typo")) {
              partsAreKnown = false;
            }
            for (const candidate of partLints) candidate.free();
          }
        }
        const record: LocalLintRecord = {
          from: span.start,
          to: span.end,
          problem,
          kind,
          message: lint.message(),
          suggestions: replacements,
          ...(partsAreKnown == null ? {} : { partsAreKnown }),
        };
        span.free();
        for (const suggestion of suggestions) suggestion.free();
        lint.free();
        lints.push(record);
      }
      for (const record of message.mode === "lintOnly" ? [] : lints) {
        if (record.kind !== "Spelling" && record.kind !== "Typo") continue;
        // Words the caller supplied purely as context are never corrected, and
        // the rescue search below costs tens of milliseconds per word.
        if (message.focus && (record.from < message.focus.from || record.to > message.focus.to)) continue;
        const verified = await verifiedMechanicalWords(record.problem, message.id);
        const harper = new Set(record.suggestions.map((value) => value.toLocaleLowerCase()));
        record.rescueSuggestions = verified.filter((value) => !harper.has(value.toLocaleLowerCase()));
      }
      if (cancelled.delete(message.id)) return;
      self.postMessage({
        type: "lints",
        id: message.id,
        lints,
        elapsedMs: performance.now() - started,
      } satisfies Outbound);
    } catch (error) {
      self.postMessage({
        type: "error",
        id: message.type === "lint" ? message.id : undefined,
        message: error instanceof Error ? error.message : String(error),
      } satisfies Outbound);
    } finally {
      if (message.type === "lint") { activeIds.delete(message.id); cancelled.delete(message.id); }
    }
}
