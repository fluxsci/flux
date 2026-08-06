#!/usr/bin/env -S npx tsx
// Hermetic lifecycle/security gate for Flux's managed llama.cpp helper.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const { createCorrectionRuntime, MODEL } = require("../electron/ipc/correctionRuntime.cjs");
const h = harness("verify-correction-runtime");
h.eq(
  [MODEL.displayName, MODEL.bytes, MODEL.sha256, MODEL.promptVersion, MODEL.evaluationVersion],
  ["Qwen3 4B Instruct 2507 · Q4_K_M", 2_497_280_480, "85e4a5b7b8ef0e48af0e8658f5aaab9c2324c76c1641493f4d1e25fce54b18b9", 13, "flux-correction-v3"],
  "the managed path pins the held-out-selected artifact and confirmation-era prompt/evaluation exactly",
);
const scratch = mkdtempSync(path.join(tmpdir(), "flux-correction-runtime-"));
const config = path.join(scratch, "FluxConfig");
const resources = path.join(scratch, "resources");
const runtimeDir = path.join(resources, "corrections", "runtime");
mkdirSync(runtimeDir, { recursive: true });
const server = path.join(runtimeDir, "llama-server");
writeFileSync(server, "verified helper");
chmodSync(server, 0o755);
writeFileSync(path.join(runtimeDir, "runtime-manifest.json"), JSON.stringify({ release: "verify", serverSha256: createHash("sha256").update("verified helper").digest("hex") }));

const tiny = {
  ...MODEL,
  id: "tiny-verify-model",
  displayName: "Tiny verification model",
  file: "tiny.gguf",
  bytes: 3,
  sha256: createHash("sha256").update("abc").digest("hex"),
  url: "https://models.invalid/tiny.gguf",
  contextLength: 256,
};
const modelDir = path.join(config, "Models", "corrections", tiny.id);
mkdirSync(modelDir, { recursive: true });
writeFileSync(path.join(modelDir, `${tiny.file}.part`), "a");

function isPrimeRequest(init?: RequestInit) {
  try {
    const body = JSON.parse(String(init?.body || "{}"));
    return body.response_format?.json_schema?.schema?.properties?.ready?.const === true;
  } catch { return false; }
}

function completion(content: unknown, usage = { prompt_tokens: 11, completion_tokens: 5 }) {
  return new Response(JSON.stringify({ model: tiny.id, choices: [{ message: { content: JSON.stringify(content) } }], usage }), { status: 200 });
}

const fetches: Array<{ url: string; init?: RequestInit }> = [];
const spawns: Array<{ executable: string; args: string[]; child: EventEmitter & Record<string, any> }> = [];
const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  fetches.push({ url, init });
  if (url === tiny.url) {
    h.eq((init?.headers as Record<string, string>)?.range, "bytes=1-", "an interrupted model download resumes with an HTTP range");
    return new Response("bc", { status: 206 });
  }
  if (url.endsWith("/health")) return new Response("ok", { status: 200 });
  const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
  h.ok(url.startsWith("http://127.0.0.1:") && auth.startsWith("Bearer ") && auth.length > 30, "runtime traffic is authenticated and loopback-only");
  return isPrimeRequest(init) ? completion({ ready: true }) : completion({ useSuggestion: true, suggestionIndex: 0 });
};
const spawnImpl = (executable: string, args: string[]) => {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  spawns.push({ executable, args, child });
  return child;
};
let atomicWrites = 0;
const runtime = createCorrectionRuntime({
  configRoot: () => config,
  resourcesPath: () => resources,
  isPackaged: () => true,
  model: tiny,
  fetchImpl,
  spawnImpl,
  atomicWrite: (file: string, value: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); atomicWrites += 1; },
});
const handlers = new Map<string, (...args: any[]) => any>();
runtime.registerHandlers({ handle: (name: string, callback: (...args: any[]) => any) => handlers.set(name, callback) });

h.section("explicit resumable model lifecycle");
h.ok(!runtime.status().installed && !runtime.status().available, "no model download occurs merely because the runtime exists");
const progress: unknown[] = [];
await handlers.get("correction:modelInstall")!({ sender: { send: (_channel: string, payload: unknown) => progress.push(payload) } });
h.ok(runtime.status().installed && runtime.status().available, "a resumed model is size- and SHA-256-verified before becoming available");
h.eq(atomicWrites, 1, "verified model metadata is committed once through the atomic writer");
h.ok(progress.length >= 3 && JSON.stringify(progress.at(-1)).includes('"complete":true'), "download, verification, and completion progress reach the renderer");
h.eq(readFileSync(path.join(modelDir, tiny.file), "utf8"), "abc", "the completed model replaces its partial file exactly");

h.section("authenticated sidecar ownership");
const reply = await runtime.chat({
  messages: [{ role: "user", content: "untrusted marked sentence" }],
  schema: { type: "object", properties: { useSuggestion: { type: "boolean" }, suggestionIndex: { type: "integer" } }, required: ["useSuggestion", "suggestionIndex"] },
}, new AbortController().signal);
h.ok(JSON.parse(reply.content).useSuggestion && reply.promptTokens === 11, "managed inference returns only the constrained selection payload and usage");
h.eq(spawns.length, 1, "one warm helper is shared across decisions");
const args = spawns[0].args;
h.ok(args.includes("127.0.0.1") && args.includes("--api-key") && !args.includes("0.0.0.0"), "llama-server binds loopback with a per-process API token");
h.ok(spawns[0].executable === server && args.includes(path.join(modelDir, tiny.file)), "main owns the verified helper and model paths");
h.ok(args.includes("--reasoning") && args.includes("off"), "managed Qwen reasoning is disabled at server startup");
h.eq(args[args.indexOf("--ctx-size") + 1], "512", "the total server context preserves 256 tokens for each of two parallel slots");
h.eq(args[args.indexOf("--parallel") + 1], "2", "two correction candidates can run concurrently");
const decisionBody = JSON.parse(String(fetches.at(-1)?.init?.body || "{}"));
h.ok(decisionBody.reasoning_effort === "none" && decisionBody.chat_template_kwargs?.enable_thinking === false, "every managed request independently pins non-thinking Qwen output");
h.ok(runtime.status().ready, "warm means a structured inference probe has succeeded, not merely that health returned 200");
h.ok(fetches.every(({ url }) => url === tiny.url || url.startsWith("http://127.0.0.1:")), "the managed provider exposes no arbitrary network destination");

await handlers.get("correction:modelUnload")!({});
h.ok(!runtime.status().running, "the user can unload the warm helper without removing the model");
await handlers.get("correction:modelRemove")!({});
h.ok(!runtime.status().installed, "removal deletes only the validated model directory");
h.eq(await handlers.get("correction:modelCancel")!({}), false, "cancel is a no-op when no download is active");
mkdirSync(modelDir, { recursive: true });
writeFileSync(path.join(modelDir, tiny.file), "abc");
writeFileSync(path.join(modelDir, "manifest.json"), JSON.stringify({ ...tiny, sha256: "legacy-model-sha", verified: true }));
h.ok(runtime.status().updateRequired && !runtime.status().installed, "an older installed artifact is surfaced as an explicit model update instead of a generic missing install");

h.section("forced shutdown and packaging pins");
writeFileSync(path.join(modelDir, "manifest.json"), JSON.stringify({ ...tiny, verified: true }));
const stubbornSignals: string[] = [];
const stubborn = createCorrectionRuntime({
  configRoot: () => config,
  resourcesPath: () => resources,
  isPackaged: () => true,
  model: tiny,
  fetchImpl,
  stopGraceMs: 5,
  atomicWrite: () => {},
  spawnImpl: () => {
    const processRef = new EventEmitter() as EventEmitter & Record<string, any>;
    processRef.stderr = new EventEmitter();
    processRef.exitCode = null;
    processRef.kill = (signal: string) => {
      stubbornSignals.push(signal);
      if (signal === "SIGKILL") {
        processRef.exitCode = 0;
        queueMicrotask(() => processRef.emit("exit", 0, signal));
      }
      return true;
    };
    return processRef;
  },
});
await stubborn.chat({ messages: [], schema: { type: "object" } });
await stubborn.shutdown();
h.eq(stubbornSignals.join(","), "SIGTERM,SIGKILL", "a helper that ignores graceful shutdown is forcibly reaped");

const fetchScript = readFileSync(path.join(process.cwd(), "scripts/fetch-correction-runtime.mjs"), "utf8");
const builder = readFileSync(path.join(process.cwd(), "electron-builder.yml"), "utf8");
const release = readFileSync(path.join(process.cwd(), ".github/workflows/release.yml"), "utf8");
h.ok(fetchScript.includes('const RELEASE = "b10288"') && fetchScript.includes("archiveSha256") && fetchScript.includes("serverSha256") && fetchScript.includes("files,"), "the packaging helper is release-, archive-, executable-, and dependency-checksum pinned");
h.ok(fetchScript.includes("ubuntu-vulkan-x64") && fetchScript.includes("eda0a9c25e15bb478b1227edb2464f20cec222b945308401617a558c8a55a48e"), "Linux packages stage the pinned Vulkan helper instead of the CPU-only archive");
h.ok(fetchScript.includes("libggml-metal") && fetchScript.includes("libggml-vulkan") && fetchScript.includes("backend"), "accelerator libraries are discovered and checksummed into the runtime manifest");
h.ok(builder.includes("build/correction-runtime/darwin-${arch}/") && builder.includes("build/correction-runtime/linux-${arch}/"), "each packaged architecture receives only its matching helper runtime");
h.ok(release.includes("fetch-correction-runtime.mjs --platform darwin --arches arm64,x64") && release.includes("fetch-correction-runtime.mjs --platform linux --arches x64"), "release CI explicitly stages every supported correction runtime before packaging");
h.ok(release.includes("@lydell/node-pty-darwin-arm64@1.1.0") && release.includes("@lydell/node-pty-darwin-x64@1.1.0"), "dual-architecture macOS packages stage both pinned terminal prebuilds");

writeFileSync(path.join(modelDir, tiny.file), "abd");
const tampered = createCorrectionRuntime({
  configRoot: () => config,
  resourcesPath: () => resources,
  isPackaged: () => true,
  model: tiny,
  fetchImpl,
  atomicWrite: () => {},
  spawnImpl: () => { throw new Error("tampered model must never spawn"); },
});
let tamperRejected = false;
try { await tampered.chat({ messages: [], schema: { type: "object" } }); } catch (error) { tamperRejected = /checksum/.test(String(error)); }
h.ok(tamperRejected && !tampered.status().available, "an equal-size model modified after install fails checksum verification before spawn");

writeFileSync(path.join(modelDir, tiny.file), "abc");
let recoveryProcess: (EventEmitter & Record<string, any>) | null = null;
let crashNext = true;
let recoverySpawns = 0;
const recover = createCorrectionRuntime({
  configRoot: () => config,
  resourcesPath: () => resources,
  isPackaged: () => true,
  model: tiny,
  atomicWrite: () => {},
  fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (isPrimeRequest(init)) return completion({ ready: true });
    if (crashNext) {
      crashNext = false;
      recoveryProcess!.exitCode = 1;
      recoveryProcess!.emit("exit", 1, null);
      throw new Error("simulated helper crash");
    }
    return new Response(JSON.stringify({ model: tiny.id, choices: [{ message: { content: JSON.stringify({ useSuggestion: false, suggestionIndex: 0 }) } }], usage: {} }), { status: 200 });
  },
  spawnImpl: () => {
    const processRef = new EventEmitter() as EventEmitter & Record<string, any>;
    processRef.stderr = new EventEmitter();
    processRef.exitCode = null;
    processRef.kill = (signal: string) => {
      processRef.exitCode = 0;
      queueMicrotask(() => processRef.emit("exit", 0, signal));
      return true;
    };
    recoveryProcess = processRef;
    recoverySpawns += 1;
    return processRef;
  },
});
const recovered = await recover.chat({ messages: [], schema: { type: "object" } });
h.ok(recoverySpawns === 2 && JSON.parse(recovered.content).useSuggestion === false, "one helper crash triggers exactly one clean restart and retry");
crashNext = true;
let retryStormBlocked = false;
try { await recover.chat({ messages: [], schema: { type: "object" } }); } catch (error) { retryStormBlocked = /simulated helper crash/.test(String(error)); }
h.ok(retryStormBlocked && recoverySpawns === 2, "a second helper crash fails closed without a restart storm");

h.section("accelerated runtime contract");
const metalResources = path.join(scratch, "metal-resources");
const metalRuntimeDir = path.join(metalResources, "corrections", "runtime");
mkdirSync(metalRuntimeDir, { recursive: true });
writeFileSync(path.join(metalRuntimeDir, "llama-server"), "metal helper");
chmodSync(path.join(metalRuntimeDir, "llama-server"), 0o755);
writeFileSync(path.join(metalRuntimeDir, "libggml-metal.0.dylib"), "metal backend");
writeFileSync(path.join(metalRuntimeDir, "libllama.0.dylib"), "llama dependency");
const metalManifest = {
  release: "verify",
  acceleration: "metal",
  serverSha256: createHash("sha256").update("metal helper").digest("hex"),
  backend: { file: "libggml-metal.0.dylib", sha256: createHash("sha256").update("metal backend").digest("hex") },
  files: {
    "llama-server": createHash("sha256").update("metal helper").digest("hex"),
    "libggml-metal.0.dylib": createHash("sha256").update("metal backend").digest("hex"),
    "libllama.0.dylib": createHash("sha256").update("llama dependency").digest("hex"),
  },
};
writeFileSync(path.join(metalRuntimeDir, "runtime-manifest.json"), JSON.stringify(metalManifest));
const metalSpawns: string[][] = [];
const metal = createCorrectionRuntime({
  configRoot: () => config,
  resourcesPath: () => metalResources,
  isPackaged: () => true,
  runtimePlatform: "darwin",
  runtimeArch: "arm64",
  model: tiny,
  fetchImpl,
  atomicWrite: () => {},
  spawnImpl: (_executable: string, metalArgs: string[]) => {
    const processRef = new EventEmitter() as EventEmitter & Record<string, any>;
    processRef.stderr = new EventEmitter();
    processRef.exitCode = null;
    processRef.kill = (signal: string) => {
      processRef.exitCode = 0;
      queueMicrotask(() => processRef.emit("exit", 0, signal));
      return true;
    };
    metalSpawns.push(metalArgs);
    return processRef;
  },
});
await metal.warm();
h.ok(metalSpawns[0].includes("--gpu-layers") && metalSpawns[0].includes("all") && metalSpawns[0].includes("--flash-attn"), "Metal and Vulkan manifests request full GPU offload and flash attention");
h.eq([metal.status().acceleration, metal.status().ready], ["metal", true], "accelerated status is explicit and only ready after structured inference");
await metal.shutdown();
writeFileSync(path.join(metalRuntimeDir, "libllama.0.dylib"), "tampered dependency");
const dependencyTampered = createCorrectionRuntime({
  configRoot: () => config,
  resourcesPath: () => metalResources,
  isPackaged: () => true,
  runtimePlatform: "darwin",
  runtimeArch: "arm64",
  model: tiny,
  fetchImpl,
  atomicWrite: () => {},
  spawnImpl: () => { throw new Error("tampered dependency must never spawn"); },
});
let dependencyTamperRejected = false;
try { await dependencyTampered.warm(); } catch (error) { dependencyTamperRejected = /dependency checksum/.test(String(error)); }
h.ok(dependencyTamperRejected, "any packaged shared-library modification is rejected before spawn");
writeFileSync(path.join(metalRuntimeDir, "libllama.0.dylib"), "llama dependency");
writeFileSync(path.join(metalRuntimeDir, "libggml-metal.0.dylib"), "tampered backend");
metalManifest.files["libggml-metal.0.dylib"] = createHash("sha256").update("tampered backend").digest("hex");
writeFileSync(path.join(metalRuntimeDir, "runtime-manifest.json"), JSON.stringify(metalManifest));
const backendTampered = createCorrectionRuntime({
  configRoot: () => config,
  resourcesPath: () => metalResources,
  isPackaged: () => true,
  runtimePlatform: "darwin",
  runtimeArch: "arm64",
  model: tiny,
  fetchImpl,
  atomicWrite: () => {},
  spawnImpl: () => { throw new Error("tampered backend must never spawn"); },
});
let backendTamperRejected = false;
try { await backendTampered.warm(); } catch (error) { backendTamperRejected = /backend checksum/.test(String(error)); }
h.ok(backendTamperRejected, "an accelerator library modified after packaging is rejected before spawn");

await runtime.shutdown();
await stubborn.shutdown();
await tampered.shutdown();
await recover.shutdown();
await dependencyTampered.shutdown();
await backendTampered.shutdown();
await h.done(() => rmSync(scratch, { recursive: true, force: true }));
