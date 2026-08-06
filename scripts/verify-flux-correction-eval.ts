#!/usr/bin/env -S npx tsx
// Hermetic acceptance gate for the locked corpora and committed real-model
// ablation reports. It never contacts Ollama, Flux-managed inference, or cloud.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import { buildCorrectionCorpus, CORRECTION_CORPUS_VERSION } from "./lib/fluxCorrectionCorpus";
import { buildCorrectionUnseenCorpus, CORRECTION_UNSEEN_CORPUS_VERSION } from "./lib/fluxCorrectionUnseenCorpus";
import { buildCorrectionConfirmationCorpus, CORRECTION_CONFIRMATION_CORPUS_VERSION } from "./lib/fluxCorrectionConfirmationCorpus";
import { buildCorrectionAggressivenessCorpus, CORRECTION_AGGRESSIVENESS_CORPUS_VERSION } from "./lib/fluxCorrectionAggressivenessCorpus";

const h = harness("verify-flux-correction-eval");
const STANDARD_HASH = "8fd35709e73a763fedfaa026fbb248fcde132b0b37cb63b78385da79ad8aa74b";
const DEVELOPMENT_HASH = "2b67dff2d12ec30ccbe3b3e76f7eca7eab74f13c739860d02a4a448691935483";
const CONFIRMATION_HASH = "87b063603cd56786432af4b4738c38b9d862fa798acba63b7bb70d8b18fd150f";
const AGGRESSIVENESS_HASH = "3065dbab8b4cad7b734bf7e3eb3f8445f622b2cdcfc7bb1527a87ac173c759f2";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const report = (name: string) => JSON.parse(readFileSync(`artifacts/flux-correction-eval/${name}.json`, "utf8"));

h.section("locked and disjoint corpora");
const standard = buildCorrectionCorpus();
const development = buildCorrectionUnseenCorpus();
const confirmation = buildCorrectionConfirmationCorpus();
const aggressiveness = buildCorrectionAggressivenessCorpus();
h.eq([CORRECTION_CORPUS_VERSION, standard.length, hash(standard)], ["flux-correction-v2", 3_500, STANDARD_HASH], "the versioned 3,500-case general corpus retains its locked content hash");
h.eq([CORRECTION_UNSEEN_CORPUS_VERSION, development.length, hash(development)], ["flux-correction-unseen-v1", 160, DEVELOPMENT_HASH], "the 160-case rescue development corpus retains its locked hash");
h.eq([CORRECTION_CONFIRMATION_CORPUS_VERSION, confirmation.length, hash(confirmation)], ["flux-correction-confirmation-v1", 128, CONFIRMATION_HASH], "the untouched 128-case confirmation corpus retains its locked hash");
h.eq([CORRECTION_AGGRESSIVENESS_CORPUS_VERSION, aggressiveness.length, hash(aggressiveness)], ["flux-correction-aggressiveness-v1", 24, AGGRESSIVENESS_HASH], "the fixed 24-case three/four-edit stress corpus retains its locked hash");
h.eq([
  confirmation.filter((item) => item.gold[0]?.action === "use").length,
  confirmation.filter((item) => item.gold[0]?.action === "keep").length,
], [64, 64], "confirmation balances 64 authentic typo repairs with 64 scientific-term preservation cases");
h.eq(new Set(confirmation.map((item) => item.id)).size, confirmation.length, "every confirmation case has a unique stable ID");
const developmentLexemes = new Set(development.flatMap((item) => item.gold.map((gold) => gold.original.toLocaleLowerCase())));
const confirmationLexemes = new Set(confirmation.flatMap((item) => item.gold.map((gold) => gold.original.toLocaleLowerCase())));
h.eq([...confirmationLexemes].filter((value) => developmentLexemes.has(value)), [], "confirmation originals are lexeme-disjoint from the development corpus");
h.ok(confirmation.every((item) => item.gold.every((gold) => item.text.toLocaleLowerCase().includes(gold.original.toLocaleLowerCase()))), "every confirmation gold edit names exact source text");
const provenance = readFileSync("scripts/lib/fluxCorrectionConfirmationCorpus.ts", "utf8");
h.ok(provenance.includes("TOEFL-Spell") && provenance.includes("CC BY-SA") && provenance.includes("created only after prompt v11"), "confirmation provenance records source, license, and post-freeze timing");

h.section("same-case rescue ablation");
const oracleNone = report("oracle-qwen3_4b-instruct-direct-held-out-confirmation-none");
const oracleLocal = report("oracle-qwen3_4b-instruct-direct-held-out-confirmation-local-only");
const oracleFull = report("oracle-qwen3_4b-instruct-direct-held-out-confirmation");
const ollamaNone = report("ollama-qwen3_4b-instruct-direct-held-out-confirmation-none");
const ollamaLocal = report("ollama-qwen3_4b-instruct-direct-held-out-confirmation-local-only");
const ollamaFull = report("ollama-qwen3_4b-instruct-direct-held-out-confirmation");
const managedFull = report("managed-qwen3-4b-q4_k_m-direct-held-out-confirmation");
for (const value of [oracleNone, oracleLocal, oracleFull, ollamaNone, ollamaLocal, ollamaFull, managedFull]) {
  h.eq([value.corpusVersion, value.corpusHash, value.metrics.failures], [CORRECTION_CONFIRMATION_CORPUS_VERSION, CONFIRMATION_HASH, 0], `${value.options.provider}/${value.options.rescueMode} report is from the exact locked corpus with zero provider failures`);
  h.eq([value.metrics.protectedChanges, value.metrics.orderStability], [0, 1], `${value.options.provider}/${value.options.rescueMode} preserves every scientific term and is order-stable`);
}
h.eq([
  oracleNone.metrics.correctAutomaticEdits,
  oracleLocal.metrics.correctAutomaticEdits,
  oracleFull.metrics.correctAutomaticEdits,
], [7, 58, 64], "oracle ablation exposes the exact no-rescue, local-proposal, and full-generation ceilings");
h.eq(oracleFull.candidateAvailabilityByClass.mechanical, { gold: 57, available: 51, rate: 51 / 57 }, "Harper/local candidates expose only 51 of the 57 sentence-level typo targets");
h.eq([
  ollamaNone.metrics.correctAutomaticEdits,
  ollamaLocal.metrics.correctAutomaticEdits,
  ollamaFull.metrics.correctAutomaticEdits,
], [7, 55, 60], "real Qwen ablation recovers five additional untouched typos only with bounded free generation");
h.ok(ollamaFull.metrics.coverage - ollamaLocal.metrics.coverage >= 0.075, "bounded generation raises total same-case coverage by at least 7.5 percentage points");
h.ok(ollamaFull.metrics.precision === 1 && ollamaFull.metrics.coverage >= 0.93 && ollamaFull.metrics.wilson95Lower >= 0.93, "selected Ollama path clears precision, coverage, and Wilson gates");
h.eq([ollamaNone.options.repeats, ollamaLocal.options.repeats, ollamaFull.options.repeats], [3, 3, 3], "every real Ollama arm uses three shuffled repeats");

h.section("Flux-managed parity and measured latency");
h.eq([managedFull.options.provider, managedFull.options.contract, managedFull.options.repeats], ["managed", "direct", 3], "managed evidence exercises its real candidate-wise runtime three times");
h.ok(managedFull.metrics.precision === 1 && managedFull.metrics.coverage >= ollamaFull.metrics.coverage, "Flux-managed preserves perfect precision and matches or exceeds Ollama coverage");
h.ok(managedFull.metrics.latencyMs.p50 < 400 && managedFull.metrics.latencyMs.p95 < 600 && managedFull.metrics.latencyMs.p99 < 750, "Flux-managed Vulkan inference stays inside the sentence-level latency budget");
h.ok(ollamaFull.metrics.latencyMs.p50 < managedFull.metrics.latencyMs.p50 && ollamaFull.metrics.latencyMs.p95 < managedFull.metrics.latencyMs.p95, "the committed same-machine measurement honestly records Ollama as modestly faster");

h.section("user-facing judgment modes");
const modeStandard = report("ollama-qwen3_4b-instruct-direct-all-confirmation");
const modeAggressive = report("ollama-qwen3_4b-instruct-direct-all-confirmation-aggressive");
const modeReally = report("ollama-qwen3_4b-instruct-direct-all-confirmation-really-aggressive");
for (const value of [modeStandard, modeAggressive, modeReally]) {
  h.eq([value.corpusVersion, value.corpusHash, value.options.repeats, value.metrics.failures], [CORRECTION_CONFIRMATION_CORPUS_VERSION, CONFIRMATION_HASH, 3, 0], `${value.options.aggressiveness} uses the exact untouched confirmation corpus for three failure-free repeats`);
  h.eq([value.metrics.precision, value.metrics.protectedChanges, value.metrics.orderStability], [1, 0, 1], `${value.options.aggressiveness} is perfectly precise, preserves every scientific term, and is order-stable on confirmation`);
}
h.eq([modeStandard.metrics.correctAutomaticEdits, modeAggressive.metrics.correctAutomaticEdits, modeReally.metrics.correctAutomaticEdits], [59, 61, 61], "Aggressive recovers two additional ordinary typos while Really aggressive does not invent extra confirmation edits");
h.ok(modeStandard.metrics.latencyMs.p50 < 260 && modeAggressive.metrics.latencyMs.p50 < 430 && modeReally.metrics.latencyMs.p50 < 430, "all three modes remain inside the sentence-level median latency budget");

const stressStandard = report("ollama-qwen3_4b-instruct-direct-all-aggressiveness");
const stressAggressive = report("ollama-qwen3_4b-instruct-direct-all-aggressiveness-aggressive");
const stressReally = report("ollama-qwen3_4b-instruct-direct-all-aggressiveness-really-aggressive");
for (const value of [stressStandard, stressAggressive, stressReally]) {
  h.eq([value.corpusVersion, value.corpusHash, value.options.repeats, value.metrics.failures], [CORRECTION_AGGRESSIVENESS_CORPUS_VERSION, AGGRESSIVENESS_HASH, 3, 0], `${value.options.aggressiveness} uses the exact stress corpus for three failure-free repeats`);
  h.eq([value.metrics.precision, value.metrics.protectedChanges, value.metrics.orderStability], [1, 0, 1], `${value.options.aggressiveness} remains precise, preserves every control, and is order-stable under hard damage`);
}
h.eq([stressStandard.metrics.correctAutomaticEdits, stressAggressive.metrics.correctAutomaticEdits, stressReally.metrics.correctAutomaticEdits], [0, 3, 10], "the measured modes expose genuinely different 2-edit, long-word 3-edit, and 3/4-edit rescue reach");
h.eq([
  stressStandard.candidateAvailabilityByClass.mechanical.available,
  stressAggressive.candidateAvailabilityByClass.mechanical.available,
  stressReally.candidateAvailabilityByClass.mechanical.available,
], [0, 4, 7], "the stress reports record the expected widening of locally surfaced candidates");

const managedAggressive = report("managed-qwen3-4b-q4_k_m-direct-all-confirmation-aggressive");
const managedReallyStress = report("managed-qwen3-4b-q4_k_m-direct-all-aggressiveness-really-aggressive");
h.eq([
  managedAggressive.corpusHash,
  managedAggressive.options.repeats,
  managedAggressive.metrics.precision,
  managedAggressive.metrics.coverage,
  managedAggressive.metrics.protectedChanges,
  managedAggressive.metrics.failures,
], [CONFIRMATION_HASH, 1, 1, 0.96875, 0, 0], "Flux-managed Aggressive preserves precision while recovering 62/64 untouched typos");
h.ok(managedAggressive.metrics.latencyMs.p95 < 800 && managedAggressive.metrics.latencyMs.p99 < 1_200, "Flux-managed Aggressive remains within the 1.5-second live application window at p99");
h.eq([
  managedReallyStress.corpusHash,
  managedReallyStress.options.repeats,
  managedReallyStress.metrics.precision,
  managedReallyStress.metrics.correctAutomaticEdits,
  managedReallyStress.metrics.protectedChanges,
  managedReallyStress.metrics.failures,
], [AGGRESSIVENESS_HASH, 1, 1, 10, 0, 0], "Flux-managed Really aggressive matches Ollama's precise 10/12 hard-damage reach");
h.ok(managedReallyStress.metrics.latencyMs.p95 < 750, "Flux-managed Really aggressive stress latency remains comfortably below the live deadline");

await h.done();
