import {
  correctionPairKey,
  damerauLevenshtein,
  keyboardAdjacentSubstitution,
  looksTechnical,
  mechanicalScore,
  oneSubstitution,
  planExplicitVocabularyCorrections,
  protectedMarkdownRanges,
  safeTypoBoundary,
  type LocalLintRecord,
  type PlannedLocalCorrection,
} from "./localCorrectionCore";

export type ContextualCorrectionLane = "sentence" | "paragraph";
export type CorrectionAggressiveness = "standard" | "aggressive" | "really-aggressive";
export type ContextualCorrectionClass =
  | "mechanical"
  | "boundary"
  | "real-word"
  | "scientific-term"
  | "phrase-punctuation";

export interface CandidateSuggestion {
  replacement: string;
  source: "harper" | "dictionary" | "project" | "keyboard" | "lexicon";
}

export interface CorrectionCandidate {
  id: string;
  from: number;
  to: number;
  original: string;
  suggestions: CandidateSuggestion[];
  /** Locally dictionary-verified nearby words shown only in the rescue pass. */
  rescueSuggestions: string[];
  rejectedSuggestions: string[];
  harperKind: string;
  harperMessage: string;
  lane: ContextualCorrectionLane;
  policyClass: ContextualCorrectionClass;
  rescueEligible: boolean;
  /** Renderer-owned edit-distance ceiling for this exact spelling span. */
  rescueMaxDistance: 1 | 2 | 3 | 4;
  evidence: {
    mechanicalScore: number;
    editDistance: number;
    keyboardAdjacent: boolean;
    personalDictionaryMatch: boolean;
    projectDictionaryMatch: boolean;
    projectOccurrenceCount: number;
    canonicalCaseMatch: boolean;
  };
}

export interface ProjectLanguageContextV1 {
  revision: string;
  dialect: "american" | "british" | "canadian" | "australian";
  projectTitle?: string;
  documentTitle?: string;
  sectionPath: string[];
  personalGuidance?: string;
  projectGuidance?: string;
  canonicalTerms: string[];
  contextHints: string[];
}

export interface ContextCorrectionPacketV1 {
  version: 1;
  requestId: string;
  snapshotHash: string;
  lane: ContextualCorrectionLane;
  text: string;
  candidates: CorrectionCandidate[];
  nearbyContext: {
    previousSentence?: string;
    nextSentence?: string;
    sectionPath: string[];
  };
  projectContext: ProjectLanguageContextV1;
  aggressiveness: CorrectionAggressiveness;
  createdAt: number;
}

export interface ContextCorrectionDecisionV1 {
  candidateId: string;
  action: "keep" | "use" | "rescue";
  suggestionIndex?: number;
  replacement?: string;
}

export type ContextCorrectionDiagnosticStage =
  | "accepted-suggestion"
  | "accepted-rescue"
  | "kept"
  | "proposal-declined"
  | "proposal-invalid"
  | "scientific-preserved"
  | "approval-declined";

export interface ContextCorrectionDiagnosticV1 {
  candidateId: string;
  stage: ContextCorrectionDiagnosticStage;
  replacement?: string;
}

export interface ContextCorrectionResultV1 {
  version: 1;
  requestId: string;
  decisions: ContextCorrectionDecisionV1[];
  /** Structured product diagnostics only; never model reasoning or free prose. */
  diagnostics?: ContextCorrectionDiagnosticV1[];
  provider?: string;
  model?: string;
  elapsedMs?: number;
  promptEvalCount?: number;
  evalCount?: number;
  cacheHit?: boolean;
}

export interface CandidateNormalizationOptions {
  blockedPairs?: ReadonlySet<string>;
  explicitWords?: readonly string[];
  personalWords?: readonly string[];
  projectWords?: readonly string[];
  projectOccurrences?: ReadonlyMap<string, number>;
  suppressRepeatedUnknowns?: boolean;
  aggressiveness?: CorrectionAggressiveness;
}

export function stableCorrectionHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function overlaps(from: number, to: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([a, b]) => from < b && to > a);
}

function classifyCandidate(original: string, suggestions: readonly string[], kind: string): ContextualCorrectionClass {
  if (looksTechnical(original) || suggestions.some(looksTechnical)) return "scientific-term";
  if (/\s/.test(original) || suggestions.some((value) => /\s/.test(value)) || kind === "BoundaryError") return "boundary";
  if (kind === "Spelling" || kind === "Typo") {
    if (!suggestions.length) return "mechanical";
    if (suggestions.some((value) => mechanicalScore(original, value) >= 56)) return "mechanical";
    if (suggestions.some((value) => oneSubstitution(original.toLocaleLowerCase(), value.toLocaleLowerCase()))) return "real-word";
  }
  return "phrase-punctuation";
}

const PLAIN_RESCUE_WORD = /^[\p{L}\p{M}]{4,32}$/u;

export function candidateRescueEligible(original: string, kind: string): boolean {
  return (kind === "Spelling" || kind === "Typo") && PLAIN_RESCUE_WORD.test(original) && !looksTechnical(original);
}

function caseShape(value: string): "lower" | "upper" | "title" | "mixed" {
  if (value === value.toLocaleLowerCase()) return "lower";
  if (value === value.toLocaleUpperCase()) return "upper";
  const [first = "", ...rest] = [...value];
  if (first === first.toLocaleUpperCase() && rest.join("") === rest.join("").toLocaleLowerCase()) return "title";
  return "mixed";
}

/** The renderer's hard limit for a model-originated exact-span replacement. */
export function rescueDistanceLimit(
  original: string,
  aggressiveness: CorrectionAggressiveness = "standard",
): 1 | 2 | 3 | 4 {
  if (original.length < 6) return 1;
  if (aggressiveness === "really-aggressive") {
    if (original.length >= 10) return 4;
    if (original.length >= 7) return 3;
  }
  if (aggressiveness === "aggressive" && original.length >= 9) return 3;
  return 2;
}

function rescuePairAllowed(original: string, kind: string, replacement: string, maxDistance = rescueDistanceLimit(original)): boolean {
  if (!candidateRescueEligible(original, kind)) return false;
  if (!PLAIN_RESCUE_WORD.test(replacement) || looksTechnical(replacement)) return false;
  if (original.toLocaleLowerCase() === replacement.toLocaleLowerCase()) return false;
  if (caseShape(original) !== caseShape(replacement)) return false;
  // The rescue lane is spelling-only. Removing a visibly intact inflection is
  // a grammar/number rewrite (`segmentations` -> `segmentation`), even when the
  // resulting word is nearby and dictionary-valid.
  const intactSuffix = ["ing", "ed", "ly", "s"].find((suffix) => original.toLocaleLowerCase().endsWith(suffix));
  if (intactSuffix && !replacement.toLocaleLowerCase().endsWith(intactSuffix)) return false;
  const semanticPrefix = ["hyper", "hypo", "anti", "non", "pre", "post", "sub", "super", "inter", "intra"]
    .find((prefix) => original.toLocaleLowerCase().startsWith(prefix));
  if (semanticPrefix && !replacement.toLocaleLowerCase().startsWith(semanticPrefix)) return false;
  const distance = damerauLevenshtein(original, replacement);
  // Standard keeps the original one/two-edit envelope. Aggressive may use
  // three edits only for 9+-letter tokens. Really aggressive expands only the
  // longer-word envelope to three/four while the independent context, lexicon,
  // and renderer gates remain mandatory. Short words stay one-edit because
  // their neighborhoods are semantically crowded.
  return distance > 0 && distance <= maxDistance;
}

export function rescueReplacementAllowed(candidate: CorrectionCandidate, replacement: string): boolean {
  return candidate.rescueEligible
    && rescuePairAllowed(candidate.original, candidate.harperKind, replacement, candidate.rescueMaxDistance);
}

export function rescueApprovalKey(candidateId: string, replacement: string): string {
  return `${candidateId}\u0000${replacement.toLocaleLowerCase()}`;
}

function cleanSuggestions(original: string, values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value === original || value.length > 64 || /[\n\r\t]/.test(value)) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 6) break;
  }
  return out;
}

function lettersOnlyForContext(value: string): string {
  return [...value].filter((char) => /[\p{L}\p{M}]/u.test(char)).join("").toLocaleLowerCase();
}

function suppliedSuggestionSafe(lint: LocalLintRecord, suggestion: CandidateSuggestion, maxDistance: 1 | 2 | 3 | 4): boolean {
  if (suggestion.source === "lexicon") return rescuePairAllowed(lint.problem, lint.kind, suggestion.replacement, maxDistance);
  if (lint.kind !== "Spelling" && lint.kind !== "Typo") return true;
  if (/\s/.test(lint.problem + suggestion.replacement)) return safeTypoBoundary(lint.problem, suggestion.replacement);
  const score = mechanicalScore(lint.problem, suggestion.replacement);
  if (score < 56) return false;
  if (lettersOnlyForContext(lint.problem).length < 6 && score < 88) return false;
  return true;
}

const CONTEXTUAL_CONFUSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  affect: ["effect"], effect: ["affect"],
  than: ["then"], then: ["than"], loose: ["lose"], lose: ["loose"],
  principal: ["principle"], principle: ["principal"], cite: ["site"], site: ["cite"],
  complement: ["compliment"], compliment: ["complement"], passed: ["past"], past: ["passed"],
  there: ["their"], their: ["there"],
});

function contextualConfusionLints(source: string): LocalLintRecord[] {
  const out: LocalLintRecord[] = [];
  for (const match of source.matchAll(/[\p{L}]+(?:['’][\p{L}]+)?/gu)) {
    const suggestions = CONTEXTUAL_CONFUSIONS[match[0].toLocaleLowerCase()];
    if (!suggestions) continue;
    out.push({
      from: match.index,
      to: match.index + match[0].length,
      problem: match[0],
      kind: "WordChoice",
      message: "Context-sensitive word choice",
      suggestions: [...suggestions],
    });
  }
  return out;
}

/** Preserve every safe Harper proposal, including proposals the mechanical lane declines. */
export function normalizeCorrectionCandidates(
  source: string,
  lints: readonly LocalLintRecord[],
  lane: ContextualCorrectionLane,
  options: CandidateNormalizationOptions = {},
): CorrectionCandidate[] {
  const blocked = options.blockedPairs ?? new Set<string>();
  const explicitWords = options.explicitWords ?? [];
  const personal = new Set((options.personalWords ?? []).map((word) => word.toLocaleLowerCase()));
  const project = new Set((options.projectWords ?? []).map((word) => word.toLocaleLowerCase()));
  const exact = new Set(explicitWords.map((word) => word.toLocaleLowerCase()));
  const occurrences = options.projectOccurrences ?? new Map<string, number>();
  const aggressiveness = options.aggressiveness ?? "standard";
  const protectedRanges = protectedMarkdownRanges(source);
  const candidates: CorrectionCandidate[] = [];

  const add = (lint: LocalLintRecord, suggestions: CandidateSuggestion[], rawRescueSuggestions: readonly string[] = []) => {
    if (lint.from < 0 || lint.to <= lint.from || lint.to > source.length) return;
    if (source.slice(lint.from, lint.to) !== lint.problem) return;
    if (overlaps(lint.from, lint.to, protectedRanges)) return;
    const originalKey = lint.problem.toLocaleLowerCase();
    if (exact.has(originalKey)) return;
    const projectOccurrenceCount = occurrences.get(originalKey) ?? 0;
    const unknownSpelling = lint.kind === "Spelling" || lint.kind === "Typo";
    if (options.suppressRepeatedUnknowns !== false && unknownSpelling && projectOccurrenceCount >= 3) return;
    const rescueEligible = candidateRescueEligible(lint.problem, lint.kind);
    const rescueMaxDistance = rescueDistanceLimit(lint.problem, aggressiveness);
    const safeSuggestions = suggestions
      .filter((suggestion) => !blocked.has(correctionPairKey(lint.problem, suggestion.replacement)))
      .filter((suggestion) => suppliedSuggestionSafe(lint, suggestion, rescueMaxDistance))
      .slice(0, 6);
    // The word-level lane has already declined these Harper spelling choices.
    // Do not present the same uncertain list again as ordinary selectable
    // answers: expose dictionary-valid entries as explicitly fallible Flux
    // proposals in the rescue pass. Project/dictionary choices and non-spelling
    // grammar candidates retain the normal bounded selection path.
    const allowed = unknownSpelling
      ? safeSuggestions.filter((suggestion) => suggestion.source !== "harper")
      : safeSuggestions;
    const boundedHarperProposals = unknownSpelling
      ? suggestions
        .filter((suggestion) => suggestion.source === "harper")
        .filter((suggestion) => !blocked.has(correctionPairKey(lint.problem, suggestion.replacement)))
        .filter((suggestion) => rescuePairAllowed(lint.problem, lint.kind, suggestion.replacement, rescueMaxDistance))
        .map((suggestion) => suggestion.replacement)
      : [];
    const allowedKeys = new Set(allowed.map((suggestion) => suggestion.replacement.toLocaleLowerCase()));
    const proposalKeys = new Set(boundedHarperProposals.map((replacement) => replacement.toLocaleLowerCase()));
    const rejectedSuggestions = suggestions
      .map((suggestion) => suggestion.replacement)
      .filter((replacement) => !allowedKeys.has(replacement.toLocaleLowerCase()))
      .filter((replacement) => !proposalKeys.has(replacement.toLocaleLowerCase()))
      .slice(0, 6);
    const rejectedKeys = new Set(rejectedSuggestions.map((replacement) => replacement.toLocaleLowerCase()));
    const withheldHarper = safeSuggestions
      .filter((suggestion) => suggestion.source === "harper" && !allowedKeys.has(suggestion.replacement.toLocaleLowerCase()))
      .map((suggestion) => suggestion.replacement);
    const rescueSuggestions = cleanSuggestions(lint.problem, [...boundedHarperProposals, ...withheldHarper, ...rawRescueSuggestions])
      .filter((replacement) => !allowedKeys.has(replacement.toLocaleLowerCase()))
      .filter((replacement) => !rejectedKeys.has(replacement.toLocaleLowerCase()))
      .filter((replacement) => !blocked.has(correctionPairKey(lint.problem, replacement)))
      .filter((replacement) => rescuePairAllowed(lint.problem, lint.kind, replacement, rescueMaxDistance))
      .slice(0, 6);
    if (!allowed.length && !rescueEligible) return;
    const conflicts = candidates.filter((candidate) => lint.from < candidate.to && lint.to > candidate.from);
    if (conflicts.length) {
      const newLength = lint.to - lint.from;
      const longest = Math.max(...conflicts.map((candidate) => candidate.to - candidate.from));
      if (longest >= newLength) return;
      for (const conflict of conflicts) candidates.splice(candidates.indexOf(conflict), 1);
    }
    const stable = `${lane}\u0000${lint.from}:${lint.to}\u0000${lint.problem}\u0000${rescueMaxDistance}\u0000${allowed.map((s) => s.replacement).join("\u0001")}\u0000${rescueSuggestions.join("\u0001")}\u0000${rejectedSuggestions.join("\u0001")}`;
    candidates.push({
      id: `c-${stableCorrectionHash(stable)}`,
      from: lint.from,
      to: lint.to,
      original: lint.problem,
      suggestions: allowed,
      rescueSuggestions,
      rejectedSuggestions,
      harperKind: lint.kind,
      harperMessage: lint.message.slice(0, 240),
      lane,
      policyClass: classifyCandidate(lint.problem, allowed.map((s) => s.replacement), lint.kind),
      rescueEligible,
      rescueMaxDistance,
      evidence: {
        mechanicalScore: allowed.length ? Math.max(...allowed.map((s) => mechanicalScore(lint.problem, s.replacement))) : 0,
        editDistance: allowed.length ? Math.min(...allowed.map((s) => damerauLevenshtein(lint.problem, s.replacement))) : 99,
        keyboardAdjacent: allowed.some((s) => keyboardAdjacentSubstitution(lint.problem, s.replacement)),
        personalDictionaryMatch: personal.has(originalKey),
        projectDictionaryMatch: project.has(originalKey),
        projectOccurrenceCount,
        canonicalCaseMatch: [...personal, ...project].some((word) => word === originalKey),
      },
    });
  };

  for (const lint of [...lints].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const replacements = cleanSuggestions(lint.problem, lint.suggestions);
    const rescue = cleanSuggestions(lint.problem, lint.rescueSuggestions ?? [])
      .filter((replacement) => !replacements.some((harper) => harper.toLocaleLowerCase() === replacement.toLocaleLowerCase()));
    add(lint, replacements.map((replacement): CandidateSuggestion => ({ replacement, source: "harper" })), rescue);
  }

  for (const lint of contextualConfusionLints(source)) {
    if (candidates.some((candidate) => candidate.from === lint.from && candidate.to === lint.to)) continue;
    add(lint, lint.suggestions.map((replacement) => ({ replacement, source: "dictionary" })));
  }

  // Explicit mixed-case scientific terms are a candidate source even when
  // Harper does not know them.
  for (const plan of planExplicitVocabularyCorrections(source, explicitWords, blocked)) {
    if (candidates.some((candidate) => candidate.from < plan.to && candidate.to > plan.from)) continue;
    add(
      { ...plan, problem: plan.original, suggestions: [plan.replacement] },
      [{ replacement: plan.replacement, source: project.has(plan.replacement.toLocaleLowerCase()) ? "project" : "dictionary" }],
    );
  }

  return candidates.slice(0, lane === "paragraph" ? 12 : 8);
}

export function makeContextCorrectionPacket(
  requestId: string,
  text: string,
  candidates: CorrectionCandidate[],
  projectContext: ProjectLanguageContextV1,
  nearbyContext: ContextCorrectionPacketV1["nearbyContext"] = { sectionPath: [] },
  lane: ContextualCorrectionLane = "sentence",
  aggressiveness: CorrectionAggressiveness = "standard",
): ContextCorrectionPacketV1 {
  return {
    version: 1,
    requestId,
    snapshotHash: stableCorrectionHash(text),
    lane,
    text,
    candidates,
    nearbyContext,
    projectContext,
    aggressiveness,
    createdAt: Date.now(),
  };
}

export interface DecisionGuardOptions {
  blockedPairs?: ReadonlySet<string>;
  explicitWords?: readonly string[];
  maxEdits?: number;
  approvedRescues?: ReadonlySet<string>;
}

function contextualPairAllowed(text: string, candidate: CorrectionCandidate, replacement: string): boolean {
  const original = candidate.original.toLocaleLowerCase();
  const next = replacement.toLocaleLowerCase();
  // These ultra-common real-word pairs are syntactic proofreading, not
  // spelling rescue. A small local model's occasional false positive is more
  // disruptive than leaving the user to correct them explicitly.
  if ((original === "from" && next === "form") || (original === "form" && next === "from")) return false;
  if ((original === "its" && next === "it's") || (original === "it's" && next === "its")) return false;
  if (original === "cite" && next === "site") {
    const before = text.slice(Math.max(0, candidate.from - 32), candidate.from).toLocaleLowerCase();
    if (/\b(?:please|must|should|can|could|will|to)\s*$/.test(before)) return false;
    return /\b(?:recording|injection|surgical|stimulation|target|binding)\s*$/.test(before);
  }
  if (original === "site" && next === "cite") return false;
  if (original === "then" && next === "than") {
    const clause = text.slice(Math.max(0, text.lastIndexOf(".", candidate.from - 1) + 1), candidate.from).toLocaleLowerCase();
    return /\b(?:more|less|greater|smaller|larger|better|worse|rather|other|different)\b/.test(clause);
  }
  // A generated adjective cannot silently replace the nominal subject of a
  // finite verb (`Background fluorescent was ...`). Small models sometimes
  // prefer the closest dictionary neighbor even when it changes part of
  // speech; this deterministic guard keeps the rescue lane spelling-only.
  if (/(?:ent|ant|ive|al|ous|ic|ary|ory)$/u.test(next)) {
    const after = text.slice(candidate.to).toLocaleLowerCase();
    if (/^\s+(?:is|are|was|were|has|have|had|does|do|did)\b/.test(after)) return false;
  }
  return true;
}

/** A model result is only a list of selections; this guard owns every mutation invariant. */
export function guardContextCorrectionResult(
  packet: ContextCorrectionPacketV1,
  result: ContextCorrectionResultV1,
  liveText: string,
  options: DecisionGuardOptions = {},
): PlannedLocalCorrection[] {
  if (result.version !== 1 || result.requestId !== packet.requestId) return [];
  if (stableCorrectionHash(liveText) !== packet.snapshotHash || liveText !== packet.text) return [];
  const blocked = options.blockedPairs ?? new Set<string>();
  const approvedRescues = options.approvedRescues ?? new Set<string>();
  const explicit = new Set((options.explicitWords ?? []).map((word) => word.toLocaleLowerCase()));
  const candidates = new Map(packet.candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const plans: PlannedLocalCorrection[] = [];
  for (const decision of result.decisions) {
    if (!decision || seen.has(decision.candidateId)) return [];
    seen.add(decision.candidateId);
    const candidate = candidates.get(decision.candidateId);
    if (!candidate) return [];
    if (decision.action === "keep") continue;
    let replacement: string;
    let source: CandidateSuggestion["source"] | "model";
    if (decision.action === "use" && Number.isInteger(decision.suggestionIndex)) {
      const suggestion = candidate.suggestions[decision.suggestionIndex!];
      if (!suggestion) return [];
      replacement = suggestion.replacement;
      source = suggestion.source;
    } else if (decision.action === "rescue" && typeof decision.replacement === "string") {
      replacement = decision.replacement;
      source = "model";
      if (!approvedRescues.has(rescueApprovalKey(candidate.id, replacement))) continue;
      if (!rescueReplacementAllowed(candidate, replacement)) continue;
    } else {
      return [];
    }
    if (candidate.policyClass === "mechanical" || candidate.harperKind === "Spelling" || candidate.harperKind === "Typo") {
      const selectedScore = mechanicalScore(candidate.original, replacement);
      const bestScore = candidate.suggestions.length
        ? Math.max(...candidate.suggestions.map((value) => mechanicalScore(candidate.original, value.replacement)))
        : 0;
      // A locally lexicon-verified one-edit rescue is allowed to beat a bad
      // spacing suggestion contextually (`wayus` -> `ways`, not `way us`).
      // Other supplied suggestions retain the original deterministic ranker.
      if (source === "lexicon") {
        if (!rescueReplacementAllowed(candidate, replacement)) continue;
      } else if (source === "harper" && (candidate.harperKind === "Spelling" || candidate.harperKind === "Typo")) {
        if (/\s/.test(candidate.original + replacement)) {
          if (!safeTypoBoundary(candidate.original, replacement)) continue;
        } else if (selectedScore < 56 || (lettersOnlyForContext(candidate.original).length < 6 && selectedScore < 88)) {
          continue;
        }
        if (selectedScore < bestScore) continue;
      } else if (source !== "model" && selectedScore < bestScore) continue;
    }
    if (!contextualPairAllowed(liveText, candidate, replacement)) continue;
    if (liveText.slice(candidate.from, candidate.to) !== candidate.original) return [];
    if (explicit.has(candidate.original.toLocaleLowerCase())) continue;
    if (blocked.has(correctionPairKey(candidate.original, replacement))) continue;
    if (overlaps(candidate.from, candidate.to, protectedMarkdownRanges(liveText))) continue;
    if (plans.some((plan) => candidate.from < plan.to && candidate.to > plan.from)) return [];
    plans.push({
      from: candidate.from,
      to: candidate.to,
      original: candidate.original,
      replacement,
      kind: /\s/.test(candidate.original + replacement) ? "spacing" : "spelling",
      message: candidate.harperMessage || "Context-aware local correction",
    });
    if (plans.length > (options.maxEdits ?? 6)) return [];
  }
  // Candidates missing from decisions intentionally mean keep/abstain.
  return plans.sort((a, b) => a.from - b.from);
}

export function contextDecisionCacheKey(packet: ContextCorrectionPacketV1): string {
  return stableCorrectionHash(JSON.stringify({
    text: packet.text,
    candidates: packet.candidates.map((candidate) => [
      candidate.original,
      candidate.suggestions.map((suggestion) => suggestion.replacement),
      candidate.rescueSuggestions,
      candidate.rejectedSuggestions,
    ]),
    revision: packet.projectContext.revision,
    dialect: packet.projectContext.dialect,
    aggressiveness: packet.aggressiveness,
  }));
}
