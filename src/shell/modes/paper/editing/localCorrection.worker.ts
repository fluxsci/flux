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

const dialects = {
  american: Dialect.American,
  british: Dialect.British,
  canadian: Dialect.Canadian,
  australian: Dialect.Australian,
} as const;

async function verifiedMechanicalWords(problem: string): Promise<string[]> {
  const variants = generateMechanicalRescueVariants(problem);
  if (!variants.length) return [];
  const verified: string[] = [];
  // Validate each form as its own document. Harper's sentence-level rules may
  // coalesce or cap diagnostics in an artificial many-word probe, which can
  // accidentally make an unchecked nonsense form look dictionary-backed.
  for (const variant of variants) {
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
      for (const record of lints) {
        if (record.kind !== "Spelling" && record.kind !== "Typo") continue;
        const verified = await verifiedMechanicalWords(record.problem);
        const harper = new Set(record.suggestions.map((value) => value.toLocaleLowerCase()));
        record.rescueSuggestions = verified.filter((value) => !harper.has(value.toLocaleLowerCase()));
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
