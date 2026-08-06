#!/usr/bin/env -S npx tsx
// Hermetic contract/security gate for the main-process correction provider.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const provider = require("../electron/ipc/corrections.cjs") as {
  createCorrectionFamily(options: Record<string, unknown>): { registerHandlers(ipc: unknown): void; shutdown(): void };
  validatePacket(packet: unknown): any;
  validateResult(packet: unknown, result: unknown): any;
  resultSchema(packet: unknown): any;
  messagesFor(packet: unknown): Array<{ role: string; content: string }>;
  localModelTask(packet: unknown, candidate: unknown, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; suggestionIndexMap: number[] };
  preservationTask(packet: unknown, candidate: unknown, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> };
  needsPreservationVeto(candidate: unknown): boolean;
  rescueApprovalTask(packet: unknown, candidate: unknown, replacement: string, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; suggestionIndexMap: number[] };
  proposalTask(packet: unknown, candidate: unknown, promptProfile?: "ollama" | "managed"): { messages: Array<{ role: string; content: string }>; schema: Record<string, unknown> };
  cleanProposal(candidate: unknown, result: unknown): string;
  rescueRejected(packet: any, result: any, attempt: (candidate: any) => Promise<string | { replacement: string; stage: string; attemptedReplacement?: string }>): Promise<{ result: any; attempts: number; accepted: number }>;
  attemptBoundedRescue(packet: any, candidate: any, chat: (task: any) => Promise<{ parsed: any }>, promptProfile?: "ollama" | "managed"): Promise<{ replacement: string; stage: string; attemptedReplacement?: string }>;
  outputTokenBudget(packet: { candidates: unknown[] }): number;
};
const h = harness("verify-contextual-correction-provider");
const scratch = mkdtempSync(path.join(tmpdir(), "flux-context-provider-"));
const projectRoot = path.join(scratch, "project");
const configRoot = path.join(scratch, "FluxConfig");
mkdirSync(projectRoot, { recursive: true });

const packet = (requestId = "request-1", text = "The signal was recorded form cortex.") => ({
  version: 1,
  requestId,
  snapshotHash: createHash("sha256").update(text).digest("hex").slice(0, 16),
  lane: "sentence",
  text,
  candidates: [{
    id: "c-12345678",
    from: text.indexOf("form"),
    to: text.indexOf("form") + 4,
    original: "form",
    suggestions: [{ replacement: "from", source: "dictionary" }],
    rescueSuggestions: [],
    rejectedSuggestions: [],
    harperKind: "WordChoice",
    harperMessage: "candidate",
    lane: "sentence",
    policyClass: "real-word",
    rescueEligible: false,
    evidence: {},
  }],
  nearbyContext: { sectionPath: ["Results"] },
  projectContext: { revision: "r1", dialect: "american", sectionPath: ["Results"], canonicalTerms: ["iGluSnFR4f"], contextHints: [] },
  createdAt: 1,
});

h.section("bounded packet and model contract");
const valid = provider.validatePacket(packet());
h.eq(valid.requestId, "request-1", "a bounded candidate packet validates");
h.ok(provider.resultSchema(valid).properties.decisions.items.properties.useSuggestion.type === "boolean", "the small model answers the calibrated boolean selection task");
h.ok(provider.outputTokenBudget(valid) >= 168, "the JSON output budget cannot truncate a one-candidate response");
const mapped = provider.validateResult(valid, { version: 1, requestId: "request-1", decisions: [{ candidateId: "c-12345678", useSuggestion: true, suggestionIndex: 0 }] });
h.eq(mapped.decisions[0], { candidateId: "c-12345678", action: "use", suggestionIndex: 0 }, "provider booleans translate into Flux's closed mutation contract");
h.ok(provider.messagesFor(valid)[0].content.includes("untrusted data"), "the stable prompt explicitly treats manuscript text as untrusted data");
const alternatives = ["foam", "from", "form"];
const candidateA = { ...valid.candidates[0], suggestions: alternatives.map((replacement) => ({ replacement })) };
const candidateB = { ...candidateA, suggestions: [...candidateA.suggestions].reverse() };
const stableA = provider.localModelTask({ ...valid, candidates: [candidateA] }, candidateA);
const stableB = provider.localModelTask({ ...valid, candidates: [candidateB] }, candidateB);
h.eq(stableA.messages, stableB.messages, "local model prompts are invariant to Harper suggestion ordering");
const presented = JSON.parse(stableA.messages[1].content).suggestions as Array<{ index: number; replacement: string }>;
const presentedFrom = presented.find((suggestion) => suggestion.replacement === "from")!.index;
h.eq(candidateA.suggestions[stableA.suggestionIndexMap[presentedFrom]].replacement, "from", "a canonical model index maps back to the exact source suggestion");
const managedTask = provider.localModelTask({ ...valid, candidates: [candidateA] }, candidateA, "managed");
h.ok(!stableA.messages[1].content.includes("candidateClass") && managedTask.messages[1].content.includes('"candidateClass":"real-word"'), "the managed backend receives calibrated Harper evidence while Ollama retains its independently validated prompt");
const rescueText = "The wayus in which the system acts remain unclear.";
const rescuePacket = (requestId = "request-rescue") => ({
  ...packet(requestId, rescueText),
  candidates: [{
    id: "c-87654321",
    from: rescueText.indexOf("wayus"),
    to: rescueText.indexOf("wayus") + 5,
    original: "wayus",
    suggestions: [{ replacement: "way us", source: "harper" }],
    rescueSuggestions: ["ways"],
    rejectedSuggestions: [],
    harperKind: "Typo",
    harperMessage: "candidate",
    lane: "sentence",
    policyClass: "boundary",
    rescueEligible: true,
    evidence: {},
  }],
});
const rescueValid = provider.validatePacket(rescuePacket());
h.ok(provider.proposalTask(rescueValid, rescueValid.candidates[0]).schema.properties.propose.type === "boolean", "a rejected spelling candidate opens one bounded proposal schema");
h.ok(provider.proposalTask(rescueValid, rescueValid.candidates[0]).messages[1].content.includes('"localProposals":["ways"]'), "Flux proposals are labeled separately from rejected Harper suggestions");
h.ok(provider.preservationTask(rescueValid, rescueValid.candidates[0]).messages[0].content.includes("scientific-term preservation veto"), "scientific-form rescue has an independent fail-closed term-preservation question");
h.eq([provider.needsPreservationVeto(rescueValid.candidates[0]), provider.needsPreservationVeto({ ...rescueValid.candidates[0], original: "gabaergic" })], [false, true], "the extra preservation challenge is reserved for recognizable scientific morphology");
h.eq(provider.cleanProposal(rescueValid.candidates[0], { propose: true, replacement: "ways" }), "ways", "a bounded Flux proposal may proceed to fresh contextual approval");
h.ok(provider.rescueApprovalTask(rescueValid, rescueValid.candidates[0], "ways").messages[0].content.includes("Independently verify"), "rescue uses a dedicated fresh contextual approval prompt");
h.eq(provider.cleanProposal(rescueValid.candidates[0], { propose: true, replacement: "way us" }), "", "a generated proposal cannot repeat a rejected Harper suggestion");
h.eq(provider.cleanProposal(rescueValid.candidates[0], { propose: true, replacement: "otherwise" }), "", "a distant model word cannot consume a fresh approval call");
const wideText = "The subseqeubn result remained stable.";
const wideBase = {
  ...rescuePacket("request-wide"),
  text: wideText,
  candidates: [{
    ...rescuePacket().candidates[0],
    id: "c-11111111",
    from: wideText.indexOf("subseqeubn"),
    to: wideText.indexOf("subseqeubn") + "subseqeubn".length,
    original: "subseqeubn",
    suggestions: [],
    rescueSuggestions: [],
    rejectedSuggestions: [],
  }],
};
const standardWide = provider.validatePacket({ ...wideBase, candidates: wideBase.candidates.map((candidate) => ({ ...candidate })) });
const aggressiveWide = provider.validatePacket({ ...wideBase, requestId: "request-wide-a", aggressiveness: "aggressive", candidates: wideBase.candidates.map((candidate) => ({ ...candidate, rescueMaxDistance: 3 })) });
h.eq(
  [provider.cleanProposal(standardWide.candidates[0], { propose: true, replacement: "subsequent" }), provider.cleanProposal(aggressiveWide.candidates[0], { propose: true, replacement: "subsequent" })],
  ["", "subsequent"],
  "aggressive widens the enforced long-word proposal envelope while standard remains two edits",
);
h.ok(provider.proposalTask(aggressiveWide, aggressiveWide.candidates[0]).messages[1].content.includes('"maxEdits":3'), "the proposal task receives the exact renderer-owned edit ceiling");
h.ok(provider.localModelTask({ ...aggressiveWide, aggressiveness: "really-aggressive" }, aggressiveWide.candidates[0]).messages[0].content.includes("Abstain only when"), "really aggressive has an explicit higher-recall decision policy rather than a cosmetic settings label");
const attemptPacket = (aggressiveness: "standard" | "aggressive" | "really-aggressive") => ({
  aggressiveness,
  candidates: Array.from({ length: 6 }, (_, index) => ({ id: `c-${String(index + 1).padStart(8, "0")}`, rescueEligible: true })),
});
const attemptInitial = (value: ReturnType<typeof attemptPacket>) => ({
  version: 1,
  requestId: "attempts",
  decisions: value.candidates.map((candidate) => ({ candidateId: candidate.id, action: "keep", suggestionIndex: 0 })),
});
const attemptCounts: number[] = [];
for (const mode of ["standard", "aggressive", "really-aggressive"] as const) {
  const value = attemptPacket(mode);
  const rescued = await provider.rescueRejected(value, attemptInitial(value), async () => ({ replacement: "", stage: "proposal-declined" }));
  attemptCounts.push(rescued.attempts);
  h.ok(rescued.result.diagnostics.every((diagnostic: any) => diagnostic.stage === "proposal-declined" || diagnostic.stage === "kept"), `${mode} returns structured abstention diagnostics without model prose`);
}
h.eq(attemptCounts, [2, 4, 6], "standard, aggressive, and really aggressive inspect two, four, and every bounded candidate respectively");
const retryText = "The tissue prexarxion remained viable.";
const retryPacket = provider.validatePacket({
  ...rescuePacket("request-retry"),
  aggressiveness: "aggressive",
  text: retryText,
  candidates: [{
    ...rescuePacket().candidates[0],
    id: "c-22222222",
    from: retryText.indexOf("prexarxion"),
    to: retryText.indexOf("prexarxion") + "prexarxion".length,
    original: "prexarxion",
    suggestions: [],
    rescueSuggestions: ["precaution", "preparation"],
    rejectedSuggestions: [],
    rescueMaxDistance: 3,
  }],
});
let proposalN = 0;
let approvalN = 0;
const retried = await provider.attemptBoundedRescue(retryPacket, retryPacket.candidates[0], async (task) => {
  if (task.schema.properties.propose) {
    proposalN += 1;
    return { parsed: { propose: true, replacement: proposalN === 1 ? "precaution" : "preparation" } };
  }
  approvalN += 1;
  return { parsed: { useSuggestion: approvalN === 2, suggestionIndex: 0 } };
});
h.eq([retried, proposalN, approvalN], [{ replacement: "preparation", stage: "accepted-rescue" }, 2, 2], "wider modes may reject one plausible neighbor and try one fresh bounded alternative");
const noSuggestion = { ...rescuePacket("request-empty"), candidates: [{ ...rescuePacket().candidates[0], suggestions: [] }] };
h.eq(provider.validateResult(provider.validatePacket(noSuggestion), { decisions: [{ candidateId: "c-87654321", useSuggestion: false, suggestionIndex: 0 }] }).decisions[0].action, "keep", "a zero-suggestion spelling lint remains representable as an abstention");
for (const malformed of [
  { ...packet(), requestId: "spaces are invalid" },
  { ...packet(), candidates: [] },
  { ...packet(), text: "x".repeat(4_001) },
  { ...packet(), candidates: [{ ...packet().candidates[0], to: 999 }] },
]) {
  let rejected = false;
  try { provider.validatePacket(malformed); } catch { rejected = true; }
  h.ok(rejected, "malformed or oversized packets fail closed");
}

h.section("fixed providers, cache, profiles, and encrypted secret");
const handlers = new Map<string, (...args: any[]) => any>();
const ipc = { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) };
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`cipher:${value}`, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8").slice(7),
};
let ollamaCalls = 0;
let ollamaWarmCalls = 0;
let openaiCalls = 0;
let holdNextOllama = false;
const requestedUrls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requestedUrls.push(url);
  if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3:4b-instruct" }] }), { status: 200 });
  const body = JSON.parse(String(init?.body || "{}"));
  if (url.includes("11434")) {
    ollamaCalls += 1;
    if (holdNextOllama) {
      holdNextOllama = false;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason || new Error("aborted")), { once: true });
      });
    }
    h.ok(body.stream === false && body.think === false && body.options?.num_ctx === 2_048 && body.keep_alive === "15m", "Ollama receives a warm, bounded-context, non-thinking request");
    if (body.format?.properties?.ready) {
      ollamaWarmCalls += 1;
      return new Response(JSON.stringify({ model: "qwen3:4b-instruct", message: { content: JSON.stringify({ ready: true }) }, prompt_eval_count: 16, eval_count: 4 }), { status: 200 });
    }
    if (body.format?.properties?.propose) {
      return new Response(JSON.stringify({ model: "qwen3:4b-instruct", message: { content: JSON.stringify({ propose: true, replacement: "ways" }) }, prompt_eval_count: 40, eval_count: 8 }), { status: 200 });
    }
    if (body.format?.properties?.originalValid) {
      return new Response(JSON.stringify({ model: "qwen3:4b-instruct", message: { content: JSON.stringify({ originalValid: false }) }, prompt_eval_count: 40, eval_count: 8 }), { status: 200 });
    }
    h.ok(body.format?.properties?.useSuggestion && !body.messages?.[1]?.content?.includes("candidateClass"), "Ollama decisions remain constrained to their validated simple candidate prompt");
    const candidatePayload = JSON.parse(body.messages?.[1]?.content || "{}");
    const useSuggestion = candidatePayload.suggestions?.[0]?.replacement !== "way us";
    return new Response(JSON.stringify({ model: "qwen3:4b-instruct", message: { content: JSON.stringify({ useSuggestion, suggestionIndex: 0 }) }, prompt_eval_count: 80, eval_count: 20 }), { status: 200 });
  }
  openaiCalls += 1;
  const schema = body.text?.format?.schema?.properties || {};
  const output = schema.propose
    ? JSON.stringify({ propose: true, replacement: "ways" })
    : schema.originalValid
      ? JSON.stringify({ originalValid: false })
    : schema.useSuggestion
      ? JSON.stringify({ useSuggestion: true, suggestionIndex: 0 })
      : JSON.stringify({ decisions: [{ candidateId: body.input?.[1]?.content?.includes("c-87654321") ? "c-87654321" : "c-12345678", useSuggestion: !body.input?.[1]?.content?.includes("way us"), suggestionIndex: 0 }] });
  h.ok(body.store === false && body.text?.format?.strict === true, "OpenAI is optional, non-stored, and schema constrained");
  return new Response(JSON.stringify({ status: "completed", model: "gpt-5.6-luna", output: [{ type: "message", content: [{ type: "output_text", text: output }] }], usage: { input_tokens: 80, output_tokens: 20 } }), { status: 200 });
}) as typeof fetch;

let atomicSeq = 0;
let managedCalls = 0;
let managedWarms = 0;
const managedRuntime = {
  MODEL: { id: "qwen3-4b-q4_k_m" },
  status: () => ({ available: true, installed: true, running: true, ready: managedWarms > 0, acceleration: "vulkan", model: { id: "qwen3-4b-q4_k_m" } }),
  warm: async () => { managedWarms += 1; },
  chat: async (task: { messages: Array<{ content: string }>; schema?: any }) => {
    managedCalls += 1;
    if (task.schema?.properties?.propose) {
      h.ok(task.messages[0].content.includes("normal suggestions were rejected or removed"), "managed rescue generation is exact-span and explicitly follows rejection");
      return { content: JSON.stringify({ propose: true, replacement: "ways" }), promptTokens: 12, outputTokens: 4, model: "qwen3-4b-q4_k_m" };
    }
    if (task.schema?.properties?.originalValid) {
      h.ok(task.messages[0].content.includes("preservation veto"), "managed rescue independently checks whether the original is a valid scientific term");
      return { content: JSON.stringify({ originalValid: false }), promptTokens: 12, outputTokens: 4, model: "qwen3-4b-q4_k_m" };
    }
    const payload = JSON.parse(task.messages[1].content);
    h.ok(task.messages[1].content.includes("candidateClass"), "managed decisions receive the backend-calibrated candidate evidence");
    return { content: JSON.stringify({ useSuggestion: payload.suggestions?.[0]?.replacement !== "way us", suggestionIndex: 0 }), promptTokens: 12, outputTokens: 4, model: "qwen3-4b-q4_k_m" };
  },
  shutdown: async () => {},
};
const family = provider.createCorrectionFamily({
  safeStorage,
  configRoot: () => configRoot,
  currentProjectRoot: () => projectRoot,
  runtime: managedRuntime,
  atomicWrite: (file: string, value: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.verify-${++atomicSeq}`;
    writeFileSync(temp, value);
    writeFileSync(file, readFileSync(temp));
    rmSync(temp);
  },
});
family.registerHandlers(ipc);
const event = { sender: { id: 7 } };
const decide = handlers.get("correction:decide")!;
await Promise.all([
  handlers.get("correction:warm")!(event, { provider: "ollama", model: "qwen3:4b-instruct" }),
  handlers.get("correction:warm")!(event, { provider: "ollama", model: "qwen3:4b-instruct" }),
]);
h.eq([ollamaWarmCalls, ollamaCalls], [1, 1], "concurrent Ollama warm requests coalesce into one structured readiness inference");
const ollamaStatus = await handlers.get("correction:status")!(event, "ollama", "qwen3:4b-instruct");
h.ok(ollamaStatus.ready, "Ollama status becomes ready only after the selected model emits structured JSON");
const first = await decide(event, { provider: "ollama", model: "qwen3:4b-instruct", packet: packet("request-1") });
const cached = await decide(event, { provider: "ollama", model: "qwen3:4b-instruct", packet: packet("request-2") });
h.eq([first.decisions[0].action, cached.cacheHit, ollamaCalls], ["use", true, 2], "a semantic duplicate is served by the bounded main-process cache");
const ollamaBeforeRescue = ollamaCalls;
const ollamaRescue = await decide(event, { provider: "ollama", model: "qwen3:4b-instruct", packet: rescuePacket("request-rescue-ollama") });
h.eq(
  [ollamaRescue.decisions[0].action, ollamaRescue.decisions[0].replacement, ollamaCalls - ollamaBeforeRescue],
  ["rescue", "ways", 3],
  "Ollama proposes one new word and freshly approves it in three bounded calls",
);
h.ok(requestedUrls.every((url) => url === "http://127.0.0.1:11434/api/chat" || url === "http://127.0.0.1:11434/api/tags"), "local provider URLs are fixed loopback endpoints");
const managed = await decide(event, { provider: "flux", model: "qwen3-4b-q4_k_m", packet: packet("request-managed", "The signal was recorded form cortex yesterday.") });
h.eq([managed.provider, managedCalls], ["flux", 1], "the Flux-managed helper uses the same closed provider contract");
const managedBeforeRescue = managedCalls;
const managedRescue = await decide(event, { provider: "flux", model: "qwen3-4b-q4_k_m", packet: rescuePacket("request-rescue-managed") });
h.eq(
  [managedRescue.decisions[0].action, managedRescue.decisions[0].replacement, managedCalls - managedBeforeRescue],
  ["rescue", "ways", 3],
  "Flux-managed uses the same propose then fresh-approve rescue contract",
);
await handlers.get("correction:warm")!(event, { provider: "flux", model: "qwen3-4b-q4_k_m" });
const managedStatus = await handlers.get("correction:status")!(event, "flux", "qwen3-4b-q4_k_m");
h.eq([managedWarms, managedStatus.ready, managedStatus.acceleration], [1, true, "vulkan"], "Flux warm delegates to the managed structured readiness probe and reports its accelerator");
holdNextOllama = true;
const cancelledDecision = decide(event, { provider: "ollama", model: "qwen3:4b-instruct", packet: packet("request-cancel", "The signal was recorded form cortex during cancellation.") });
await new Promise((resolve) => setTimeout(resolve, 0));
const cancelled = await handlers.get("correction:cancel")!(event, "request-cancel");
let cancellationRejected = false;
try { await cancelledDecision; } catch (error) { cancellationRejected = /cancel/i.test(String(error)); }
h.ok(cancelled && cancellationRejected, "renderer cancellation aborts the exact in-flight provider request and fails closed");
const timeoutHandlers = new Map<string, (...args: any[]) => any>();
const timeoutFamily = provider.createCorrectionFamily({
  safeStorage,
  configRoot: () => configRoot,
  currentProjectRoot: () => projectRoot,
  runtime: managedRuntime,
  requestTimeoutMs: 5,
  atomicWrite: () => {},
});
timeoutFamily.registerHandlers({ handle: (name: string, fn: (...args: any[]) => any) => timeoutHandlers.set(name, fn) });
await timeoutHandlers.get("correction:warm")!(event, { provider: "ollama", model: "qwen3:4b-instruct" });
holdNextOllama = true;
let timeoutRejected = false;
try {
  await timeoutHandlers.get("correction:decide")!(event, { provider: "ollama", model: "qwen3:4b-instruct", packet: packet("request-timeout", "The signal was recorded form cortex during timeout.") });
} catch (error) { timeoutRejected = /timed out/i.test(String(error)); }
h.ok(timeoutRejected, "a provider exceeding the hard deadline is aborted and cannot return a late mutation");
timeoutFamily.shutdown();

await handlers.get("correction:profileSet")!(event, { scope: "personal", projectRoot: "", data: { words: ["NREM"], aliases: [], guidance: "Keep acronyms." } });
await handlers.get("correction:profileSet")!(event, { scope: "project", projectRoot, data: { words: ["iGluSnFR4f"], aliases: [], blockedPairs: [], guidance: "Keep sensor names." } });
const profiles = await handlers.get("correction:profileGet")!(event, projectRoot);
h.eq([profiles.personal.words[0], profiles.project.words[0]], ["NREM", "iGluSnFR4f"], "personal and active-project language profiles persist in separate durable files");
let escaped = false;
try { await handlers.get("correction:profileSet")!(event, { scope: "project", projectRoot: path.join(scratch, "other"), data: {} }); } catch { escaped = true; }
h.ok(escaped, "project profile writes cannot escape the active project");

await handlers.get("correction:cloudKeySet")!(event, "sk-test-secret");
const secretBytes = readFileSync(path.join(configRoot, "Secrets", "corrections.json"), "utf8");
h.ok(!secretBytes.includes("sk-test-secret") && (await handlers.get("correction:cloudKeyStatus")!(event)).configured, "the optional cloud key is stored only through OS encryption");
const cloud = await decide(event, { provider: "openai", model: "gpt-5.6-luna", packet: packet("request-cloud", "The signal was recorded form cortex today.") });
h.eq([cloud.provider, openaiCalls], ["openai", 1], "the opt-in cloud path uses the same validated decision contract");
h.ok(requestedUrls.at(-1) === "https://api.openai.com/v1/responses", "the cloud destination is a fixed Responses API endpoint");
const openaiBeforeRescue = openaiCalls;
const cloudRescue = await decide(event, { provider: "openai", model: "gpt-5.6-luna", packet: rescuePacket("request-rescue-openai") });
h.eq(
  [cloudRescue.decisions[0].action, cloudRescue.decisions[0].replacement, openaiCalls - openaiBeforeRescue],
  ["rescue", "ways", 3],
  "the opt-in cloud provider cannot bypass proposal validation or fresh approval",
);

family.shutdown();
globalThis.fetch = originalFetch;
await h.done(() => rmSync(scratch, { recursive: true, force: true }));
