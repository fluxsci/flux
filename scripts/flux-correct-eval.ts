#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Dialect, LocalLinter } from "harper.js";
import { slimBinary } from "harper.js/slimBinary";
import {
  extractProjectVocabularyOccurrences,
  generateMechanicalRescueVariants,
  mechanicalScore,
  planLocalCorrections,
  type LocalLintRecord,
} from "../src/shell/modes/paper/editing/localCorrectionCore";
import {
  makeContextCorrectionPacket,
  normalizeCorrectionCandidates,
  guardContextCorrectionResult,
  contextDecisionCacheKey,
  rescueApprovalKey,
  rescueReplacementAllowed,
  type ContextCorrectionPacketV1,
  type ContextCorrectionResultV1,
  type CorrectionAggressiveness,
  type CorrectionCandidate,
  type ProjectLanguageContextV1,
} from "../src/shell/modes/paper/editing/contextualCorrectionCore";
import {
  buildCorrectionCorpus,
  buildCorrectionRescueCorpus,
  CORRECTION_CORPUS_VERSION,
  CORRECTION_RESCUE_CORPUS_VERSION,
  type CorrectionCorpusCase,
  type CorrectionCorpusPartition,
} from "./lib/fluxCorrectionCorpus";
import {
  buildCorrectionUnseenCorpus,
  CORRECTION_UNSEEN_CORPUS_VERSION,
} from "./lib/fluxCorrectionUnseenCorpus";
import {
  buildCorrectionConfirmationCorpus,
  CORRECTION_CONFIRMATION_CORPUS_VERSION,
} from "./lib/fluxCorrectionConfirmationCorpus";
import {
  buildCorrectionAggressivenessCorpus,
  CORRECTION_AGGRESSIVENESS_CORPUS_VERSION,
} from "./lib/fluxCorrectionAggressivenessCorpus";

const require = createRequire(import.meta.url);
const providerCore = require("../electron/ipc/corrections.cjs") as {
  messagesFor(packet: ContextCorrectionPacketV1): Array<{ role: string; content: string }>;
  resultSchema(packet: ContextCorrectionPacketV1): Record<string, unknown>;
  validateResult(packet: ContextCorrectionPacketV1, result: unknown): ContextCorrectionResultV1;
  outputTokenBudget(packet: ContextCorrectionPacketV1): number;
  localModelTask(packet: ContextCorrectionPacketV1, candidate: CorrectionCandidate, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown>; suggestionIndexMap: number[] };
  preservationTask(packet: ContextCorrectionPacketV1, candidate: CorrectionCandidate, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> };
  needsPreservationVeto(candidate: CorrectionCandidate): boolean;
  rescueApprovalTask(packet: ContextCorrectionPacketV1, candidate: CorrectionCandidate, replacement: string, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown>; suggestionIndexMap: number[] };
  proposalTask(packet: ContextCorrectionPacketV1, candidate: CorrectionCandidate, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> };
  cleanProposal(candidate: CorrectionCandidate, result: unknown): string;
  rescueRejected(packet: ContextCorrectionPacketV1, result: ContextCorrectionResultV1, attempt: (candidate: CorrectionCandidate) => Promise<string | { replacement: string; stage: string; attemptedReplacement?: string }>): Promise<{ result: ContextCorrectionResultV1; attempts: number; accepted: number }>;
  attemptBoundedRescue(packet: ContextCorrectionPacketV1, candidate: CorrectionCandidate, chat: (task: { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> }) => Promise<{ parsed: any }>, promptProfile?: "ollama" | "managed"): Promise<{ replacement: string; stage: string; attemptedReplacement?: string }>;
};
const managedCore = require("../electron/ipc/correctionRuntime.cjs") as {
  createCorrectionRuntime(options: Record<string, unknown>): ManagedRuntime;
};

interface ManagedRuntime {
  warm(): Promise<void>;
  chat(task: { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> }, signal?: AbortSignal): Promise<{ content: string; promptTokens: number; outputTokens: number }>;
  shutdown(): Promise<void>;
  status(): Record<string, unknown>;
}

type Provider = "oracle" | "ollama" | "managed";
type Contract = "direct" | "batch";
interface Options {
  suite: "standard" | "rescue" | "unseen" | "confirmation" | "aggressiveness";
  rescueMode: "none" | "local-only" | "full";
  aggressiveness: CorrectionAggressiveness;
  provider: Provider;
  contract: Contract;
  model: string;
  thinking: boolean;
  repeats: number;
  limit: number;
  family: string;
  partition: CorrectionCorpusPartition | "all";
  output: string;
}

function args(): Options {
  const values = process.argv.slice(2);
  const get = (name: string) => {
    const at = values.indexOf(name);
    return at >= 0 ? values[at + 1] : undefined;
  };
  const requestedProvider = get("--provider");
  const provider: Provider = requestedProvider === "ollama" ? "ollama" : requestedProvider === "managed" || requestedProvider === "flux" ? "managed" : "oracle";
  const partition = get("--partition") ?? "held-out";
  if (!["development", "calibration", "held-out", "all"].includes(partition)) throw new Error(`Unknown partition: ${partition}`);
  const requestedAggressiveness = get("--aggressiveness") ?? "standard";
  if (!["standard", "aggressive", "really-aggressive"].includes(requestedAggressiveness)) throw new Error(`Unknown aggressiveness: ${requestedAggressiveness}`);
  return {
    suite: get("--suite") === "rescue" ? "rescue" : get("--suite") === "unseen" ? "unseen" : get("--suite") === "confirmation" ? "confirmation" : get("--suite") === "aggressiveness" ? "aggressiveness" : "standard",
    rescueMode: get("--rescue-mode") === "none" ? "none" : get("--rescue-mode") === "local-only" ? "local-only" : "full",
    aggressiveness: requestedAggressiveness as CorrectionAggressiveness,
    provider,
    contract: get("--contract") === "batch" ? "batch" : "direct",
    model: get("--model") || (provider === "managed" ? "qwen3-4b-q4_k_m" : "qwen3:4b-instruct"),
    thinking: values.includes("--thinking"),
    repeats: Math.max(1, Math.min(3, Number(get("--repeats") || 1))),
    limit: Math.max(0, Number(get("--limit") || 0)),
    family: get("--family") || "",
    partition: partition as Options["partition"],
    output: get("--out") || "artifacts/flux-correction-eval",
  };
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function wilsonLower(successes: number, total: number, z = 1.959963984540054): number {
  if (!total) return 0;
  const p = successes / total;
  const z2 = z * z;
  const center = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (center - spread) / (1 + z2 / total);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
  const out = [...values];
  const random = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function shuffledPacket(packet: ContextCorrectionPacketV1, seed: number): ContextCorrectionPacketV1 {
  return {
    ...packet,
    candidates: shuffle(packet.candidates, seed).map((candidate, index) => ({
      ...candidate,
      suggestions: shuffle(candidate.suggestions, seed + index * 997),
    })),
  };
}

async function lint(linter: LocalLinter, text: string): Promise<LocalLintRecord[]> {
  const raw = await linter.lint(text, { language: "plaintext", dedup: true });
  const out: LocalLintRecord[] = [];
  for (const item of raw) {
    const span = item.span();
    const suggestions = item.suggestions();
    const problem = item.get_problem_text();
    const kind = item.lint_kind();
    const replacements = suggestions.map((suggestion) => suggestion.get_replacement_text());
    let partsAreKnown: boolean | undefined;
    const boundaryForm = /\s/.test(problem) ? problem : replacements.length === 1 && /\s/.test(replacements[0]) ? replacements[0] : "";
    if ((kind === "WordChoice" || kind === "BoundaryError" || kind === "Typo") && boundaryForm) {
      partsAreKnown = true;
      for (const part of boundaryForm.trim().split(/\s+/)) {
        const partLints = await linter.lint(part, { language: "plaintext", dedup: true });
        if (partLints.some((candidate) => candidate.lint_kind() === "Spelling" || candidate.lint_kind() === "Typo")) partsAreKnown = false;
        for (const candidate of partLints) candidate.free();
      }
    }
    out.push({
      from: span.start,
      to: span.end,
      problem,
      kind,
      message: item.message(),
      suggestions: replacements,
      ...(partsAreKnown == null ? {} : { partsAreKnown }),
    });
    span.free();
    for (const suggestion of suggestions) suggestion.free();
    item.free();
  }
  for (const record of out) {
    if (record.kind !== "Spelling" && record.kind !== "Typo") continue;
    const variants = generateMechanicalRescueVariants(record.problem);
    if (!variants.length) continue;
    const harper = new Set(record.suggestions.map((value) => value.toLocaleLowerCase()));
    const verified: string[] = [];
    for (const variant of variants) {
      const checks = await linter.lint(variant, { language: "plaintext", dedup: true });
      let unknown = false;
      for (const check of checks) {
        if (check.lint_kind() === "Spelling" || check.lint_kind() === "Typo") unknown = true;
        check.free();
      }
      if (!unknown && !harper.has(variant.toLocaleLowerCase())) verified.push(variant);
    }
    record.rescueSuggestions = verified
      .sort((a, b) => mechanicalScore(record.problem, b) - mechanicalScore(record.problem, a) || a.localeCompare(b, "en"))
      .slice(0, 6);
  }
  return out;
}

function mergeLints(actual: LocalLintRecord[], extra: readonly LocalLintRecord[] = []): LocalLintRecord[] {
  const merged = new Map(actual.map((item) => [`${item.from}:${item.to}:${item.problem}`, item]));
  for (const item of extra) {
    const key = `${item.from}:${item.to}:${item.problem}`;
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, suggestions: [...new Set([...prior.suggestions, ...item.suggestions])] } : item);
  }
  return [...merged.values()];
}

function projectContext(test: CorrectionCorpusCase): ProjectLanguageContextV1 {
  return {
    revision: `eval-${test.id}`,
    dialect: "american",
    sectionPath: ["Evaluation"],
    personalGuidance: "Correct clear errors while preserving scientific terminology.",
    projectGuidance: test.context?.projectGuidance ?? "",
    canonicalTerms: test.context?.canonicalTerms ?? test.explicitWords ?? [],
    contextHints: [],
    ...test.context,
  };
}

function suggestionForGold(candidate: CorrectionCandidate, original: string, replacement: string): string | undefined {
  for (const suggestion of candidate.suggestions) {
    if (candidate.original.toLocaleLowerCase() === original.toLocaleLowerCase() && suggestion.replacement.toLocaleLowerCase() === replacement.toLocaleLowerCase()) return suggestion.replacement;
    const offset = candidate.original.toLocaleLowerCase().indexOf(original.toLocaleLowerCase());
    if (offset < 0) continue;
    const equivalent = `${candidate.original.slice(0, offset)}${replacement}${candidate.original.slice(offset + original.length)}`;
    if (equivalent.toLocaleLowerCase() === suggestion.replacement.toLocaleLowerCase()) return suggestion.replacement;
  }
  return undefined;
}

function goldForCandidate(test: CorrectionCorpusCase, candidate: CorrectionCandidate) {
  return test.gold.find((gold) => {
    if (!matchesGoldOccurrence(test, candidate, gold)) return false;
    if (suggestionForGold(candidate, gold.original, gold.replacement) !== undefined) return true;
    return candidate.original.toLocaleLowerCase() === gold.original.toLocaleLowerCase()
      && candidate.rescueSuggestions.some((replacement) => replacement.toLocaleLowerCase() === gold.replacement.toLocaleLowerCase());
  });
}

function occurrenceAt(text: string, needle: string, position: number): number {
  let occurrence = 0;
  let from = 0;
  while (from < position) {
    const found = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase(), from);
    if (found < 0 || found >= position) break;
    occurrence += 1;
    from = found + Math.max(1, needle.length);
  }
  return occurrence;
}

function matchesGoldOccurrence(test: CorrectionCorpusCase, candidate: CorrectionCandidate, gold: CorrectionCorpusCase["gold"][number]): boolean {
  if (!candidate.original.toLocaleLowerCase().includes(gold.original.toLocaleLowerCase())) return false;
  return gold.occurrence === undefined || occurrenceAt(test.text, gold.original, candidate.from) === gold.occurrence;
}

function goldAtCandidate(test: CorrectionCorpusCase, candidate: CorrectionCandidate) {
  return test.gold.find((gold) => matchesGoldOccurrence(test, candidate, gold));
}

function expectedDecision(test: CorrectionCorpusCase, candidate: CorrectionCandidate) {
  const gold = goldAtCandidate(test, candidate);
  if (!gold || gold.action === "keep") return { action: "keep" as const, replacement: candidate.original };
  const supplied = suggestionForGold(candidate, gold.original, gold.replacement);
  if (supplied) return { action: "use" as const, replacement: supplied };
  const offset = candidate.original.toLocaleLowerCase().indexOf(gold.original.toLocaleLowerCase());
  return {
    action: "rescue" as const,
    replacement: `${candidate.original.slice(0, offset)}${gold.replacement}${candidate.original.slice(offset + gold.original.length)}`,
  };
}

function oracle(packet: ContextCorrectionPacketV1, test: CorrectionCorpusCase, rescueMode: Options["rescueMode"]): ContextCorrectionResultV1 {
  return {
    version: 1,
    requestId: packet.requestId,
    decisions: packet.candidates.map((candidate) => {
      const expected = expectedDecision(test, candidate);
      const index = candidate.suggestions.findIndex((suggestion) => suggestion.replacement.toLocaleLowerCase() === expected.replacement.toLocaleLowerCase());
      return index >= 0
        ? { candidateId: candidate.id, action: expected.action === "keep" ? "keep" : "use", suggestionIndex: index }
        : expected.action === "rescue" && rescueMode !== "none"
          && (rescueMode === "full" || candidate.rescueSuggestions.some((value) => value.toLocaleLowerCase() === expected.replacement.toLocaleLowerCase()))
          ? { candidateId: candidate.id, action: "rescue", replacement: expected.replacement }
          : { candidateId: candidate.id, action: "keep", suggestionIndex: 0 };
    }),
  };
}

async function ollama(packet: ContextCorrectionPacketV1, options: Options): Promise<{ result: ContextCorrectionResultV1; elapsedMs: number; promptTokens: number; outputTokens: number }> {
  const started = performance.now();
  if (options.contract === "batch") {
    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: providerCore.messagesFor(packet),
        stream: false,
        format: providerCore.resultSchema(packet),
        think: options.thinking,
        keep_alive: "30m",
        options: { temperature: 0, seed: 29, num_predict: providerCore.outputTokenBudget(packet), num_ctx: 2_048 },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(String(body.error || `${response.status} ${response.statusText}`));
    return {
      result: providerCore.validateResult(packet, JSON.parse(body.message?.content || "{}")),
      elapsedMs: performance.now() - started,
      promptTokens: Number(body.prompt_eval_count) || 0,
      outputTokens: Number(body.eval_count) || 0,
    };
  }
  const responses: Array<Record<string, any>> = [];
  const chat = async (task: { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> }) => {
    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: task.messages,
        stream: false,
        format: task.schema,
        think: options.thinking,
        keep_alive: "30m",
        options: { temperature: 0, seed: 29, num_predict: 96, num_ctx: 2_048 },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(String(body.error || `${response.status} ${response.statusText}`));
    responses.push(body);
    return JSON.parse(body.message?.content || "{}");
  };
  const selections = await Promise.all(packet.candidates.map(async (candidate) => {
    if (!candidate.suggestions.length) return { candidate, selection: { useSuggestion: false, suggestionIndex: 0 } };
    const task = providerCore.localModelTask(packet, candidate);
    const selection = await chat(task);
    const sourceSuggestionIndex = task.suggestionIndexMap[selection.suggestionIndex];
    if (typeof selection.useSuggestion !== "boolean" || (selection.useSuggestion && !Number.isInteger(sourceSuggestionIndex))) throw new Error("Provider returned an invalid local selection");
    return { candidate, selection: { ...selection, suggestionIndex: Number.isInteger(sourceSuggestionIndex) ? sourceSuggestionIndex : 0 } };
  }));
  const parsed = { decisions: selections.map(({ candidate, selection }) => ({ candidateId: candidate.id, action: selection.useSuggestion ? "use" : "keep", suggestionIndex: selection.suggestionIndex })) };
  const initial = providerCore.validateResult(packet, parsed);
  if (options.rescueMode === "none") {
    return {
      result: initial,
      elapsedMs: performance.now() - started,
      promptTokens: responses.reduce((sum, value) => sum + (Number(value.prompt_eval_count) || 0), 0),
      outputTokens: responses.reduce((sum, value) => sum + (Number(value.eval_count) || 0), 0),
    };
  }
  const legacyAttempt = async (candidate: CorrectionCandidate) => {
    const proposal = await chat(providerCore.proposalTask(packet, candidate));
    const replacement = providerCore.cleanProposal(candidate, proposal);
    if (!replacement) return proposal?.propose === true
      ? { replacement: "", stage: "proposal-invalid", attemptedReplacement: String(proposal.replacement || "").slice(0, 32) }
      : { replacement: "", stage: "proposal-declined" };
    if (options.rescueMode === "local-only" && !candidate.rescueSuggestions.some((value) => value.toLocaleLowerCase() === replacement.toLocaleLowerCase())) return { replacement: "", stage: "proposal-invalid", attemptedReplacement: replacement };
    if (providerCore.needsPreservationVeto(candidate)) {
      const preservation = await chat(providerCore.preservationTask(packet, candidate));
      if (preservation.originalValid !== false) return { replacement: "", stage: "scientific-preserved", attemptedReplacement: replacement };
    }
    const task = providerCore.rescueApprovalTask(packet, candidate, replacement);
    const approval = await chat(task);
    return approval.useSuggestion === true && task.suggestionIndexMap[approval.suggestionIndex] === 0
      ? { replacement, stage: "accepted-rescue" }
      : { replacement: "", stage: "approval-declined", attemptedReplacement: replacement };
  };
  const rescued = await providerCore.rescueRejected(packet, initial, options.rescueMode === "full"
    ? (candidate) => providerCore.attemptBoundedRescue(packet, candidate, async (task) => ({ parsed: await chat(task) }))
    : legacyAttempt);
  return {
    result: rescued.result,
    elapsedMs: performance.now() - started,
    promptTokens: responses.reduce((sum, value) => sum + (Number(value.prompt_eval_count) || 0), 0),
    outputTokens: responses.reduce((sum, value) => sum + (Number(value.eval_count) || 0), 0),
  };
}

async function warmOllama(options: Options): Promise<void> {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { ready: { type: "boolean", const: true } },
    required: ["ready"],
  };
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: "Return JSON with ready set to true." }],
      stream: false,
      format: schema,
      think: false,
      keep_alive: "30m",
      options: { temperature: 0, seed: 29, num_predict: 32, num_ctx: 2_048 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(String(body.error || `${response.status} ${response.statusText}`));
  const parsed = JSON.parse(body.message?.content || "{}");
  if (parsed.ready !== true) throw new Error("Ollama failed the evaluation readiness probe");
}

async function managed(packet: ContextCorrectionPacketV1, options: Options, runtime: ManagedRuntime): Promise<{ result: ContextCorrectionResultV1; elapsedMs: number; promptTokens: number; outputTokens: number }> {
  const started = performance.now();
  if (options.contract === "batch") {
    const response = await runtime.chat({ messages: providerCore.messagesFor(packet), schema: providerCore.resultSchema(packet) }, AbortSignal.timeout(8_000));
    return {
      result: providerCore.validateResult(packet, JSON.parse(response.content || "{}")),
      elapsedMs: performance.now() - started,
      promptTokens: response.promptTokens,
      outputTokens: response.outputTokens,
    };
  }
  const responses: Array<{ content: string; promptTokens: number; outputTokens: number }> = [];
  const chat = async (task: { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> }) => {
    const response = await runtime.chat(task, AbortSignal.timeout(8_000));
    responses.push(response);
    return JSON.parse(response.content || "{}");
  };
  const selections = await Promise.all(packet.candidates.map(async (candidate) => {
    if (!candidate.suggestions.length) return { candidate, selection: { useSuggestion: false, suggestionIndex: 0 } };
    const task = providerCore.localModelTask(packet, candidate, "managed");
    const selection = await chat(task);
    const sourceSuggestionIndex = task.suggestionIndexMap[selection.suggestionIndex];
    if (typeof selection.useSuggestion !== "boolean" || (selection.useSuggestion && !Number.isInteger(sourceSuggestionIndex))) throw new Error("Managed provider returned an invalid local selection");
    return { candidate, selection: { ...selection, suggestionIndex: Number.isInteger(sourceSuggestionIndex) ? sourceSuggestionIndex : 0 } };
  }));
  const initial = providerCore.validateResult(packet, { decisions: selections.map(({ candidate, selection }) => ({
    candidateId: candidate.id,
    action: selection.useSuggestion ? "use" : "keep",
    suggestionIndex: selection.suggestionIndex,
  })) });
  if (options.rescueMode === "none") {
    return {
      result: initial,
      elapsedMs: performance.now() - started,
      promptTokens: responses.reduce((sum, value) => sum + value.promptTokens, 0),
      outputTokens: responses.reduce((sum, value) => sum + value.outputTokens, 0),
    };
  }
  const legacyAttempt = async (candidate: CorrectionCandidate) => {
    const proposal = await chat(providerCore.proposalTask(packet, candidate, "managed"));
    const replacement = providerCore.cleanProposal(candidate, proposal);
    if (!replacement) return proposal?.propose === true
      ? { replacement: "", stage: "proposal-invalid", attemptedReplacement: String(proposal.replacement || "").slice(0, 32) }
      : { replacement: "", stage: "proposal-declined" };
    if (options.rescueMode === "local-only" && !candidate.rescueSuggestions.some((value) => value.toLocaleLowerCase() === replacement.toLocaleLowerCase())) return { replacement: "", stage: "proposal-invalid", attemptedReplacement: replacement };
    if (providerCore.needsPreservationVeto(candidate)) {
      const preservation = await chat(providerCore.preservationTask(packet, candidate, "managed"));
      if (preservation.originalValid !== false) return { replacement: "", stage: "scientific-preserved", attemptedReplacement: replacement };
    }
    const task = providerCore.rescueApprovalTask(packet, candidate, replacement, "managed");
    const approval = await chat(task);
    return approval.useSuggestion === true && task.suggestionIndexMap[approval.suggestionIndex] === 0
      ? { replacement, stage: "accepted-rescue" }
      : { replacement: "", stage: "approval-declined", attemptedReplacement: replacement };
  };
  const rescued = await providerCore.rescueRejected(packet, initial, options.rescueMode === "full"
    ? (candidate) => providerCore.attemptBoundedRescue(packet, candidate, async (task) => ({ parsed: await chat(task) }), "managed")
    : legacyAttempt);
  return {
    result: rescued.result,
    elapsedMs: performance.now() - started,
    promptTokens: responses.reduce((sum, value) => sum + value.promptTokens, 0),
    outputTokens: responses.reduce((sum, value) => sum + value.outputTokens, 0),
  };
}

interface Counters {
  automatic: number;
  correctAutomatic: number;
  goldUses: number;
  correctedGold: Set<string>;
  candidateGold: number;
  availableGold: number;
  protectedChanges: number;
  calls: number;
  allKeep: number;
  allUse: number;
  words: number;
  promptTokens: number;
  outputTokens: number;
  failures: number;
}

interface FamilyCounters {
  automatic: number;
  correctAutomatic: number;
  goldUses: number;
  correctedGold: Set<string>;
  candidateGold: number;
  availableGold: number;
  calls: number;
  failures: number;
}

function emptyCounters(): Counters {
  return { automatic: 0, correctAutomatic: 0, goldUses: 0, correctedGold: new Set(), candidateGold: 0, availableGold: 0, protectedChanges: 0, calls: 0, allKeep: 0, allUse: 0, words: 0, promptTokens: 0, outputTokens: 0, failures: 0 };
}

async function realisticCallRateAudit(linter: LocalLinter) {
  const clean = [
    "The cortical response remained stable across repeated stimulation trials.",
    "Fluorescence was measured before and after the baseline recording period.",
    "Each preparation contributed one observation to the final biological analysis.",
    "The microscope objective remained calibrated throughout the imaging session.",
  ];
  const ambiguous = [
    "The signal was recorded form the motor cortex.",
    "The treatment did not effect the firing rate.",
    "The second group was larger then the first group.",
    "We did not want to loose low amplitude events.",
    "The principal of sparse coding guided the analysis.",
    "The mouse past through the central chamber.",
    "The inhibitory input complimented the excitatory drive.",
    "Please inspect the recording cite in the methods.",
  ];
  const sentences = [
    ...Array.from({ length: 82 }, (_, index) => clean[index % clean.length]),
    ...Array.from({ length: 10 }, () => "The somata response remained stable in each preparation."),
    ...ambiguous,
  ];
  const joined = sentences.join(" ");
  const occurrences = new Map([...extractProjectVocabularyOccurrences([joined])].map(([key, value]) => [key, value.n]));
  const keys = new Set<string>();
  let rawCandidateSentences = 0;
  let suppressedCandidates = 0;
  for (let index = 0; index < sentences.length; index += 1) {
    const text = sentences[index];
    const records = await lint(linter, text);
    const layer1 = planLocalCorrections(text, records);
    const unresolved = (suppressRepeatedUnknowns: boolean) => normalizeCorrectionCandidates(text, records, "sentence", { projectOccurrences: occurrences, suppressRepeatedUnknowns })
      .filter((candidate) => !layer1.some((plan) => candidate.from < plan.to && candidate.to > plan.from));
    const raw = unresolved(false);
    const filtered = unresolved(true);
    if (raw.length) rawCandidateSentences += 1;
    suppressedCandidates += Math.max(0, raw.length - filtered.length);
    if (!filtered.length) continue;
    const packet = makeContextCorrectionPacket(`rate-${index}`, text, filtered, {
      revision: "realistic-v1", dialect: "american", sectionPath: ["Results"], canonicalTerms: [], contextHints: [],
    });
    keys.add(contextDecisionCacheKey(packet));
  }
  const words = joined.trim().split(/\s+/).length;
  return {
    sentences: sentences.length,
    words,
    rawCandidateSentences,
    suppressedCandidates,
    providerCallsAfterSuppressionAndCache: keys.size,
    callsPer1000Words: keys.size / words * 1000,
    target: 20,
    passes: keys.size / words * 1000 <= 20,
  };
}

function recordEdit(counters: Counters, family: FamilyCounters, test: CorrectionCorpusCase, original: string, replacement: string, from: number) {
  counters.automatic += 1;
  family.automatic += 1;
  const gold = test.gold.find((item) => {
    if (item.action !== "use") return false;
    if (item.occurrence !== undefined && occurrenceAt(test.text, item.original, from) !== item.occurrence) return false;
    if (item.original.toLocaleLowerCase() === original.toLocaleLowerCase() && item.replacement.toLocaleLowerCase() === replacement.toLocaleLowerCase()) return true;
    const offset = original.toLocaleLowerCase().indexOf(item.original.toLocaleLowerCase());
    if (offset < 0) return false;
    const equivalent = `${original.slice(0, offset)}${item.replacement}${original.slice(offset + item.original.length)}`;
    return equivalent.toLocaleLowerCase() === replacement.toLocaleLowerCase();
  });
  if (gold) {
    counters.correctAutomatic += 1;
    family.correctAutomatic += 1;
    counters.correctedGold.add(`${test.id}:${gold.original}:${gold.replacement}`);
    family.correctedGold.add(`${test.id}:${gold.original}:${gold.replacement}`);
  } else if (test.family === "protected-syntax" || test.family === "scientific-terminology" || test.family === "unseen-scientific-preservation" || test.family === "confirmation-scientific-preservation" || test.family === "aggression-preservation") {
    counters.protectedChanges += 1;
  }
}

async function approvedRescueKeys(
  linter: LocalLinter,
  packet: ContextCorrectionPacketV1,
  result: ContextCorrectionResultV1,
): Promise<Set<string>> {
  const candidates = new Map(packet.candidates.map((candidate) => [candidate.id, candidate]));
  const approved = new Set<string>();
  for (const decision of result.decisions) {
    if (decision.action !== "rescue" || typeof decision.replacement !== "string") continue;
    const candidate = candidates.get(decision.candidateId);
    if (!candidate || !rescueReplacementAllowed(candidate, decision.replacement)) continue;
    const raw = await linter.lint(decision.replacement, { language: "plaintext", dedup: true });
    let unknown = false;
    for (const item of raw) {
      if (item.lint_kind() === "Spelling" || item.lint_kind() === "Typo") unknown = true;
      item.free();
    }
    if (!unknown) approved.add(rescueApprovalKey(candidate.id, decision.replacement));
  }
  return approved;
}

async function main() {
  const options = args();
  const all = options.suite === "rescue"
    ? buildCorrectionRescueCorpus()
    : options.suite === "unseen" ? buildCorrectionUnseenCorpus()
      : options.suite === "confirmation" ? buildCorrectionConfirmationCorpus()
        : options.suite === "aggressiveness" ? buildCorrectionAggressivenessCorpus() : buildCorrectionCorpus();
  const corpusVersion = options.suite === "rescue"
    ? CORRECTION_RESCUE_CORPUS_VERSION
    : options.suite === "unseen" ? CORRECTION_UNSEEN_CORPUS_VERSION
      : options.suite === "confirmation" ? CORRECTION_CONFIRMATION_CORPUS_VERSION
        : options.suite === "aggressiveness" ? CORRECTION_AGGRESSIVENESS_CORPUS_VERSION : CORRECTION_CORPUS_VERSION;
  let corpus = options.partition === "all" ? all : all.filter((test) => test.partition === options.partition);
  if (options.family) corpus = corpus.filter((test) => test.family === options.family);
  if (options.limit) corpus = corpus.slice(0, options.limit);
  const corpusHash = createHash("sha256").update(JSON.stringify(all)).digest("hex");
  const linter = new LocalLinter({ binary: slimBinary, dialect: Dialect.American });
  await linter.setup();
  let managedRuntime: ManagedRuntime | undefined;
  if (options.provider === "ollama") await warmOllama(options);
  if (options.provider === "managed") {
    managedRuntime = managedCore.createCorrectionRuntime({
      configRoot: () => process.env.FLUX_CONFIG_ROOT || path.join(homedir(), "FluxConfig"),
      resourcesPath: () => process.cwd(),
      isPackaged: () => false,
      atomicWrite: () => {},
    });
    await managedRuntime.warm();
    console.error(`Managed runtime ready: ${JSON.stringify(managedRuntime.status())}`);
  }

  const counters = emptyCounters();
  const callRateAudit = await realisticCallRateAudit(linter);
  const latency: number[] = [];
  const classAvailability = new Map<string, { gold: number; available: number }>();
  const familyCounters = new Map<string, FamilyCounters>();
  const repeatSemantics = new Map<string, string[]>();
  const cases: Array<Record<string, unknown>> = [];
  const falseEditExamples: Array<Record<string, unknown>> = [];
  const missingCandidateExamples: Array<Record<string, unknown>> = [];
  const wrongDecisionExamples: Array<Record<string, unknown>> = [];

  for (let caseIndex = 0; caseIndex < corpus.length; caseIndex += 1) {
    const test = corpus[caseIndex];
    const family = familyCounters.get(test.family) ?? { automatic: 0, correctAutomatic: 0, goldUses: 0, correctedGold: new Set<string>(), candidateGold: 0, availableGold: 0, calls: 0, failures: 0 };
    familyCounters.set(test.family, family);
    counters.words += test.text.trim().split(/\s+/).length;
    for (const gold of test.gold) if (gold.action === "use") { counters.goldUses += 1; family.goldUses += 1; }
    const records = mergeLints(await lint(linter, test.text), test.extraLints);
    const layer1 = planLocalCorrections(test.text, records, { explicitWords: test.explicitWords ?? [] });
    for (const plan of layer1) {
      const before = counters.correctAutomatic;
      recordEdit(counters, family, test, plan.original, plan.replacement, plan.from);
      if (counters.correctAutomatic === before && falseEditExamples.length < 30) falseEditExamples.push({ id: test.id, family: test.family, text: test.text, original: plan.original, replacement: plan.replacement });
    }
    const candidates = normalizeCorrectionCandidates(test.text, records, test.family === "paragraph-cross-sentence" ? "paragraph" : "sentence", {
      explicitWords: test.explicitWords ?? [],
      projectWords: test.context?.canonicalTerms ?? [],
      suppressRepeatedUnknowns: false,
      aggressiveness: options.aggressiveness,
    }).filter((candidate) => !layer1.some((plan) => candidate.from < plan.to && candidate.to > plan.from));

    for (const gold of test.gold.filter((value) => value.action === "use")) {
      if (layer1.some((plan) => plan.original.toLocaleLowerCase() === gold.original.toLocaleLowerCase() && plan.replacement.toLocaleLowerCase() === gold.replacement.toLocaleLowerCase())) continue;
      counters.candidateGold += 1;
      family.candidateGold += 1;
      const group = classAvailability.get(test.policyClass) ?? { gold: 0, available: 0 };
      group.gold += 1;
      const available = candidates.some((candidate) => goldForCandidate(test, candidate));
      if (available) { counters.availableGold += 1; family.availableGold += 1; group.available += 1; }
      else if (missingCandidateExamples.length < 30) missingCandidateExamples.push({ id: test.id, family: test.family, text: test.text, gold, candidates: candidates.map((candidate) => ({ original: candidate.original, suggestions: candidate.suggestions.map((suggestion) => suggestion.replacement), rescueSuggestions: candidate.rescueSuggestions })) });
      classAvailability.set(test.policyClass, group);
    }

    if (!candidates.length) continue;
    const packet = makeContextCorrectionPacket(`eval-${test.id}`, test.text, candidates, projectContext(test), { sectionPath: ["Evaluation"] }, test.family === "paragraph-cross-sentence" ? "paragraph" : "sentence", options.aggressiveness);
    const runSemantics: string[] = [];
    for (let repeat = 0; repeat < options.repeats; repeat += 1) {
      const request = shuffledPacket({ ...packet, requestId: `${packet.requestId}-r${repeat}` }, 1701 + caseIndex * 31 + repeat * 1009);
      let result: ContextCorrectionResultV1;
      try {
        if (options.provider === "oracle") {
          result = oracle(request, test, options.rescueMode);
        } else {
          counters.calls += 1;
          family.calls += 1;
          const response = options.provider === "managed"
            ? await managed(request, options, managedRuntime!)
            : await ollama(request, options);
          result = response.result;
          latency.push(response.elapsedMs);
          counters.promptTokens += response.promptTokens;
          counters.outputTokens += response.outputTokens;
        }
      } catch (error) {
        counters.failures += 1;
        family.failures += 1;
        cases.push({ id: test.id, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const decisions = new Map(result.decisions.map((decision) => [decision.candidateId, decision]));
      const diagnostics = new Map(result.diagnostics?.map((diagnostic) => [diagnostic.candidateId, diagnostic]) ?? []);
      const approvedRescues = await approvedRescueKeys(linter, request, result);
      const acceptedPlans = guardContextCorrectionResult(request, result, request.text, { approvedRescues });
      const semantics: string[] = [];
      let uses = 0;
      for (const candidate of request.candidates) {
        const decision = decisions.get(candidate.id);
        const proposed = decision?.action === "use"
          ? candidate.suggestions[decision.suggestionIndex ?? -1]?.replacement
          : decision?.action === "rescue" ? decision.replacement : undefined;
        const replacement = acceptedPlans.find((plan) => plan.from === candidate.from && plan.to === candidate.to && plan.original === candidate.original)?.replacement;
        semantics.push(`${candidate.id}:${replacement ?? "KEEP"}`);
        if (repeat === 0) {
          const expected = expectedDecision(test, candidate);
          const actual = replacement ?? candidate.original;
          if (actual.toLocaleLowerCase() !== expected.replacement.toLocaleLowerCase() && wrongDecisionExamples.length < 50) {
            wrongDecisionExamples.push({ id: test.id, family: test.family, text: test.text, candidate: candidate.original, suggestions: candidate.suggestions.map((value) => value.replacement), rescueSuggestions: candidate.rescueSuggestions, rejectedSuggestions: candidate.rejectedSuggestions, expected, decision, diagnostic: diagnostics.get(candidate.id), proposed, actual });
          }
        }
        if (repeat === 0 && replacement) {
          uses += 1;
          recordEdit(counters, family, test, candidate.original, replacement, candidate.from);
        }
      }
      if (repeat === 0) {
        if (!uses) counters.allKeep += 1;
        if (uses === request.candidates.length) counters.allUse += 1;
      }
      runSemantics.push(semantics.sort().join("|"));
    }
    repeatSemantics.set(test.id, runSemantics);
  }

  await linter.dispose();
  await managedRuntime?.shutdown();
  const precision = counters.automatic ? counters.correctAutomatic / counters.automatic : 1;
  const coverage = counters.goldUses ? counters.correctedGold.size / counters.goldUses : 1;
  const availability = counters.candidateGold ? counters.availableGold / counters.candidateGold : 1;
  const stableCases = [...repeatSemantics.values()].filter((values) => values.length > 1 && new Set(values).size === 1).length;
  const repeatedCases = [...repeatSemantics.values()].filter((values) => values.length > 1).length;
  const shippedFamilies = [...familyCounters].filter(([name]) => name !== "paragraph-cross-sentence").map(([, value]) => value);
  const shippedAutomatic = shippedFamilies.reduce((sum, value) => sum + value.automatic, 0);
  const shippedCorrect = shippedFamilies.reduce((sum, value) => sum + value.correctAutomatic, 0);
  const shippedGoldUses = shippedFamilies.reduce((sum, value) => sum + value.goldUses, 0);
  const shippedCorrected = shippedFamilies.reduce((sum, value) => sum + value.correctedGold.size, 0);
  const report = {
    version: 1,
    corpusVersion,
    corpusHash,
    generatedAt: new Date().toISOString(),
    options,
    counts: { all: all.length, evaluated: corpus.length, ...Object.fromEntries([...new Set(all.map((test) => test.family))].map((family) => [family, all.filter((test) => test.family === family).length])) },
    metrics: {
      precision,
      wilson95Lower: wilsonLower(counters.correctAutomatic, counters.automatic),
      coverage,
      candidateAvailability: availability,
      automaticEdits: counters.automatic,
      correctAutomaticEdits: counters.correctAutomatic,
      protectedChanges: counters.protectedChanges,
      providerCalls: counters.calls,
      providerCallsPerPass: counters.calls / options.repeats,
      callsPer1000Words: counters.words ? counters.calls / options.repeats / counters.words * 1000 : 0,
      allKeepCalls: counters.allKeep,
      allUseCalls: counters.allUse,
      orderStability: repeatedCases ? stableCases / repeatedCases : 1,
      failures: counters.failures,
      latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), p99: percentile(latency, 0.99) },
      tokens: { prompt: counters.promptTokens, output: counters.outputTokens },
    },
    shippedSentencePolicy: {
      paragraphLaneEnabled: false,
      precision: shippedAutomatic ? shippedCorrect / shippedAutomatic : 1,
      wilson95Lower: wilsonLower(shippedCorrect, shippedAutomatic),
      coverage: shippedGoldUses ? shippedCorrected / shippedGoldUses : 1,
      automaticEdits: shippedAutomatic,
      correctAutomaticEdits: shippedCorrect,
      reason: "Paragraph reconciliation is evidence-gated and excluded after its locked cases failed the precision gate.",
    },
    realisticCallRateAudit: callRateAudit,
    candidateAvailabilityByClass: Object.fromEntries([...classAvailability].map(([key, value]) => [key, { ...value, rate: value.gold ? value.available / value.gold : 1 }])),
    byFamily: Object.fromEntries([...familyCounters].map(([key, value]) => [key, {
      automaticEdits: value.automatic,
      precision: value.automatic ? value.correctAutomatic / value.automatic : 1,
      coverage: value.goldUses ? value.correctedGold.size / value.goldUses : 1,
      candidateAvailability: value.candidateGold ? value.availableGold / value.candidateGold : 1,
      providerCalls: value.calls / options.repeats,
      failures: value.failures,
    }])),
    falseEditExamples,
    missingCandidateExamples,
    wrongDecisionExamples,
    failures: cases,
  };

  mkdirSync(options.output, { recursive: true });
  const mode = options.contract === "direct" ? (options.thinking ? "thinking" : "direct") : (options.thinking ? "batch-thinking" : "batch");
  const suiteSuffix = options.suite === "standard" ? "" : `-${options.suite}`;
  const rescueSuffix = options.rescueMode === "full" ? "" : `-${options.rescueMode}`;
  const aggressivenessSuffix = options.aggressiveness === "standard" ? "" : `-${options.aggressiveness}`;
  const stem = `${options.provider}-${options.model.replace(/[^a-z0-9.-]+/gi, "_")}-${mode}-${options.partition}${suiteSuffix}${rescueSuffix}${aggressivenessSuffix}`;
  const jsonPath = path.join(options.output, `${stem}.json`);
  const mdPath = path.join(options.output, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(mdPath, `# Flux correction evaluation\n\n- Provider: ${options.provider}\n- Model: ${options.model}\n- Contract: ${options.contract}\n- Thinking: ${options.thinking}\n- Rescue mode: ${options.rescueMode}\n- Judgment: ${options.aggressiveness}\n- Corpus: ${corpusVersion} (${corpus.length}/${all.length} cases; \`${corpusHash}\`)\n- All experimental lanes: ${(precision * 100).toFixed(2)}% precision (Wilson lower ${(report.metrics.wilson95Lower * 100).toFixed(2)}%), ${(coverage * 100).toFixed(2)}% coverage\n- Shipped sentence policy: ${(report.shippedSentencePolicy.precision * 100).toFixed(2)}% precision (Wilson lower ${(report.shippedSentencePolicy.wilson95Lower * 100).toFixed(2)}%), ${(report.shippedSentencePolicy.coverage * 100).toFixed(2)}% coverage\n- Paragraph lane enabled: no (failed its locked precision gate)\n- Candidate availability: ${(availability * 100).toFixed(2)}%\n- Protected changes: ${counters.protectedChanges}\n- Calls / 1,000 words (adversarial corpus): ${report.metrics.callsPer1000Words.toFixed(1)}\n- Calls / 1,000 words (realistic suppression/cache audit): ${callRateAudit.callsPer1000Words.toFixed(1)} (${callRateAudit.passes ? "pass" : "fail"}; target ≤ ${callRateAudit.target})\n- Latency p50/p95/p99: ${report.metrics.latencyMs.p50.toFixed(0)} / ${report.metrics.latencyMs.p95.toFixed(0)} / ${report.metrics.latencyMs.p99.toFixed(0)} ms\n- Order stability: ${(report.metrics.orderStability * 100).toFixed(2)}%\n- Provider failures: ${counters.failures}\n\n## Candidate availability by policy class\n\n${Object.entries(report.candidateAvailabilityByClass).map(([key, value]: [string, any]) => `- ${key}: ${(value.rate * 100).toFixed(2)}% (${value.available}/${value.gold})`).join("\n")}\n`);
  console.log(JSON.stringify({ jsonPath, mdPath, metrics: report.metrics, candidateAvailabilityByClass: report.candidateAvailabilityByClass }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
