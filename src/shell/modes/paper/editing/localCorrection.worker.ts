import { LocalLinter } from "harper.js";
import { slimBinary } from "harper.js/slimBinary";
import type { LocalLintRecord } from "./localCorrectionCore";

type Inbound =
  | { type: "init"; words: string[] }
  | { type: "words"; words: string[] }
  | { type: "lint"; id: number; text: string };

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

let operations = Promise.resolve();
self.onmessage = (event: MessageEvent<Inbound>) => {
  const message = event.data;
  // Dictionary refreshes and lints share one WASM linter. Serialize them so a
  // background vocabulary import can never clear words halfway through a
  // sentence request.
  operations = operations.then(async () => {
    try {
      if (message.type === "init") {
        await ensureReady(message.words);
        return;
      }
      if (message.type === "words") {
        await replaceWords(message.words);
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
        let partsAreKnown: boolean | undefined;
        if ((kind === "WordChoice" || kind === "BoundaryError") && /\s/.test(problem)) {
          partsAreKnown = true;
          for (const part of problem.trim().split(/\s+/)) {
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
          suggestions: suggestions.map((s) => s.get_replacement_text()),
          ...(partsAreKnown == null ? {} : { partsAreKnown }),
        };
        span.free();
        for (const suggestion of suggestions) suggestion.free();
        lint.free();
        lints.push(record);
      }
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
    }
  });
};
