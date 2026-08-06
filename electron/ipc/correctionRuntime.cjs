"use strict";

// Flux-managed llama.cpp lifecycle. Executable acquisition is a packaging step;
// the only runtime download is the explicit, user-requested, checksummed model.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { Readable, Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PARALLEL_SLOTS = 2;
const PRIME_TIMEOUT_MS = 15_000;

const MODEL = Object.freeze({
  id: "qwen3-4b-q4_k_m",
  displayName: "Qwen3 4B Instruct 2507 · Q4_K_M",
  upstream: "Qwen/Qwen3-4B-Instruct-2507 via ollama/library/qwen3:4b-instruct",
  revision: "0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0",
  file: "Qwen3-4B-Q4_K_M.gguf",
  bytes: 2_497_280_480,
  sha256: "85e4a5b7b8ef0e48af0e8658f5aaab9c2324c76c1641493f4d1e25fce54b18b9",
  url: "https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:85e4a5b7b8ef0e48af0e8658f5aaab9c2324c76c1641493f4d1e25fce54b18b9",
  license: "Apache-2.0",
  parameters: "4B",
  quantization: "Q4_K_M",
  contextLength: 2_048,
  chatTemplate: "embedded-jinja",
  promptVersion: 13,
  evaluationVersion: "flux-correction-v3",
  minimumFluxVersion: "0.1.0",
});

function createCorrectionRuntime({
  configRoot,
  resourcesPath,
  isPackaged,
  atomicWrite,
  model = MODEL,
  fetchImpl = fetch,
  spawnImpl = spawn,
  stopGraceMs = 2_000,
  runtimePlatform = process.platform,
  runtimeArch = process.arch,
}) {
  let child = null;
  let port = 0;
  let token = "";
  let ready = false;
  let starting = null;
  let installController = null;
  let idleTimer = null;
  let crashRestarts = 0;
  let lifecycleGeneration = 0;
  const stoppingProcesses = new WeakSet();
  let verifiedModelFingerprint = "";
  let modelIntegrityFailed = false;
  let lastError = "";

  const modelDir = () => path.join(configRoot(), "Models", "corrections", model.id);
  const modelFile = () => path.join(modelDir(), model.file);
  const modelManifest = () => path.join(modelDir(), "manifest.json");
  const runtimeDir = () => isPackaged()
    ? path.join(resourcesPath(), "corrections", "runtime")
    : path.resolve(__dirname, "..", "..", "build", "correction-runtime", `${runtimePlatform}-${runtimeArch}`);
  const serverFile = () => path.join(runtimeDir(), runtimePlatform === "win32" ? "llama-server.exe" : "llama-server");
  const runtimeManifest = () => path.join(runtimeDir(), "runtime-manifest.json");

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  async function sha256(file) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(file), new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } }));
    return hash.digest("hex");
  }

  function manifestInstalled() {
    const manifest = readJson(modelManifest());
    try {
      const stat = fs.statSync(modelFile());
      return !!manifest && manifest.sha256 === model.sha256 && manifest.verified === true && stat.size === model.bytes;
    } catch { return false; }
  }

  function installed() {
    return manifestInstalled() && !modelIntegrityFailed;
  }

  function updateRequired() {
    const manifest = readJson(modelManifest());
    return !!manifest?.verified && manifest.id === model.id && typeof manifest.sha256 === "string" && manifest.sha256 !== model.sha256;
  }

  async function verifyModel() {
    if (!manifestInstalled()) throw new Error("Install the Flux contextual correction model in Settings first");
    const stat = fs.statSync(modelFile());
    const fingerprint = `${stat.size}:${stat.mtimeMs}`;
    if (verifiedModelFingerprint === fingerprint) return;
    const digest = await sha256(modelFile());
    if (digest !== model.sha256) {
      modelIntegrityFailed = true;
      verifiedModelFingerprint = "";
      lastError = "Flux correction model checksum verification failed";
      throw new Error(lastError);
    }
    modelIntegrityFailed = false;
    verifiedModelFingerprint = fingerprint;
  }

  async function verifyRuntime() {
    const manifest = readJson(runtimeManifest());
    if (!manifest || !fs.existsSync(serverFile())) throw new Error("The packaged Flux correction runtime is unavailable");
    const digest = await sha256(serverFile());
    if (digest !== manifest.serverSha256) throw new Error("Flux correction runtime checksum verification failed");
    if (manifest.files && typeof manifest.files === "object") {
      if (manifest.files[runtimePlatform === "win32" ? "llama-server.exe" : "llama-server"] !== digest) {
        throw new Error("Flux correction runtime manifest is incomplete");
      }
      for (const [entry, expected] of Object.entries(manifest.files)) {
        if (!entry || path.basename(entry) !== entry || typeof expected !== "string") throw new Error("Flux correction runtime manifest is invalid");
        const file = path.join(runtimeDir(), entry);
        if (!fs.existsSync(file) || await sha256(file) !== expected) throw new Error(`Flux correction runtime dependency checksum failed: ${entry}`);
      }
    }
    if (manifest.backend) {
      const backendFile = path.join(runtimeDir(), path.basename(manifest.backend.file || ""));
      if (!manifest.backend.file || !fs.existsSync(backendFile) || await sha256(backendFile) !== manifest.backend.sha256) {
        throw new Error(`Flux correction ${manifest.acceleration || "accelerator"} backend checksum verification failed`);
      }
    }
  }

  function freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const selected = typeof address === "object" && address ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(selected));
      });
    });
  }

  async function terminate(current) {
    if (!current || current.exitCode != null) return;
    stoppingProcesses.add(current);
    current.kill("SIGTERM");
    await new Promise((resolve) => {
      let exited = false;
      const timer = setTimeout(() => {
        if (!exited && current.exitCode == null) current.kill("SIGKILL");
        resolve();
      }, stopGraceMs);
      current.once("exit", () => {
        exited = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function stop() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    lifecycleGeneration += 1;
    const current = child;
    child = null;
    port = 0;
    token = "";
    ready = false;
    await terminate(current);
  }

  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop(), 30 * 60_000);
    idleTimer.unref?.();
  }

  async function waitHealthy(selectedPort, selectedToken, processRef) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (processRef.exitCode != null) throw new Error(lastError || "Flux correction runtime exited while loading");
      try {
        const response = await fetchImpl(`http://127.0.0.1:${selectedPort}/health`, {
          headers: { authorization: `Bearer ${selectedToken}` },
          signal: AbortSignal.timeout(600),
        });
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("Flux correction model did not become ready in time");
  }

  function completionBody(task, maxTokens = 96) {
    return {
      model: "flux-correction",
      messages: task.messages,
      temperature: 0,
      seed: 29,
      max_tokens: maxTokens,
      // Qwen3's embedded template defaults to thinking. The correction task
      // needs a tiny schema decision, not a private reasoning trace. Pin this
      // per request as well as at server startup so a future template update
      // cannot silently consume the whole output budget before emitting JSON.
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { name: "flux_correction", strict: true, schema: task.schema } },
    };
  }

  async function complete(selectedPort, selectedToken, task, signal, maxTokens = 96) {
    const response = await fetchImpl(`http://127.0.0.1:${selectedPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${selectedToken}` },
      body: JSON.stringify(completionBody(task, maxTokens)),
      signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body.error?.message || `${response.status} ${response.statusText}`).slice(0, 500));
    return body;
  }

  async function prime(selectedPort, selectedToken) {
    const task = {
      messages: [
        { role: "system", content: "Return only the requested JSON schema. This is a Flux correction-runtime readiness check." },
        { role: "user", content: "Set ready to true." },
      ],
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ready: { type: "boolean", const: true } },
        required: ["ready"],
      },
    };
    const body = await complete(selectedPort, selectedToken, task, AbortSignal.timeout(PRIME_TIMEOUT_MS), 32);
    const content = body.choices?.[0]?.message?.content || "";
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error("Flux correction runtime returned no structured readiness result"); }
    if (parsed?.ready !== true) throw new Error("Flux correction runtime failed its structured readiness check");
  }

  async function start() {
    if (child && child.exitCode == null && port && token && ready) { scheduleIdle(); return; }
    if (starting) return await starting;
    const generation = lifecycleGeneration;
    const startPromise = (async () => {
      if (child && child.exitCode == null && port && token) {
        await prime(port, token);
        ready = true;
        scheduleIdle();
        return;
      }
      await verifyModel();
      await verifyRuntime();
      const selectedPort = await freePort();
      if (generation !== lifecycleGeneration) throw new Error("Flux correction runtime start was cancelled");
      const selectedToken = crypto.randomBytes(24).toString("base64url");
      let stderr = "";
      const manifest = readJson(runtimeManifest()) || {};
      const args = [
        "--model", modelFile(),
        "--host", "127.0.0.1",
        "--port", String(selectedPort),
        "--api-key", selectedToken,
        // llama-server divides the total context among parallel slots. Reserve
        // the model's declared context for each concurrent candidate request.
        "--ctx-size", String(model.contextLength * PARALLEL_SLOTS),
        "--parallel", String(PARALLEL_SLOTS),
        "--jinja",
        "--reasoning", "off",
        "--no-webui",
      ];
      if (model.chatTemplate && model.chatTemplate !== "embedded-jinja") args.push("--chat-template", model.chatTemplate);
      if (manifest.acceleration === "metal" || manifest.acceleration === "vulkan") {
        // Apple Silicon and the pinned Linux Vulkan helper both support full
        // offload. CPU-only systems retain llama.cpp's safe CPU fallback.
        args.push("--gpu-layers", "all", "--flash-attn", "on");
      }
      const processRef = spawnImpl(serverFile(), args, { cwd: runtimeDir(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      processRef.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
      processRef.once("exit", (code, signal) => {
        if (child === processRef) { child = null; port = 0; token = ""; ready = false; }
        if (!stoppingProcesses.has(processRef)) lastError = `Flux correction runtime exited (${code ?? signal ?? "unknown"}): ${stderr.slice(-500)}`;
      });
      if (generation !== lifecycleGeneration) {
        await terminate(processRef);
        throw new Error("Flux correction runtime start was cancelled");
      }
      child = processRef;
      port = selectedPort;
      token = selectedToken;
      try {
        await waitHealthy(selectedPort, selectedToken, processRef);
        // `/health` means the model is loaded, not that the chat template can
        // emit our schema. Prime one tiny non-thinking completion before the UI
        // is allowed to call the provider warm.
        await prime(selectedPort, selectedToken);
        ready = true;
        lastError = "";
        scheduleIdle();
      } catch (error) {
        await stop();
        throw error;
      }
    })();
    starting = startPromise;
    try { await startPromise; } finally { if (starting === startPromise) starting = null; }
  }

  async function chat(task, signal) {
    if (signal?.aborted) throw signal.reason || new Error("Correction request cancelled");
    if (signal) {
      let onAbort;
      try {
        await Promise.race([
          start(),
          new Promise((_, reject) => {
            onAbort = () => reject(signal.reason || new Error("Correction request cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    } else await start();
    scheduleIdle();
    const call = async () => {
      const body = await complete(port, token, task, signal);
      return {
        content: body.choices?.[0]?.message?.content || "",
        promptTokens: Number(body.usage?.prompt_tokens) || 0,
        outputTokens: Number(body.usage?.completion_tokens) || 0,
        model: String(body.model || model.id).slice(0, 120),
      };
    };
    try { return await call(); } catch (error) {
      if (signal?.aborted || (child && child.exitCode == null) || crashRestarts >= 1) throw error;
      crashRestarts += 1;
      await stop();
      await start();
      return await call();
    }
  }

  async function download(sender) {
    if (installController) throw new Error("The correction model download is already running");
    if (installed()) return status();
    installController = new AbortController();
    const directory = modelDir();
    const partial = `${modelFile()}.part`;
    const emitProgress = (payload) => {
      if (sender && typeof sender.send === "function") sender.send("correction:modelProgress", payload);
    };
    fs.mkdirSync(directory, { recursive: true });
    try {
      let offset = 0;
      try { offset = fs.statSync(partial).size; } catch {}
      if (offset > model.bytes) { fs.truncateSync(partial, 0); offset = 0; }
      let response = await fetchImpl(model.url, { headers: offset ? { range: `bytes=${offset}-` } : {}, signal: installController.signal, redirect: "follow" });
      if (offset && response.status !== 206) {
        fs.truncateSync(partial, 0);
        offset = 0;
        response = await fetchImpl(model.url, { signal: installController.signal, redirect: "follow" });
      }
      if (!response.ok || !response.body) throw new Error(`Model download failed: ${response.status} ${response.statusText}`);
      let received = offset;
      const progress = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > model.bytes) {
          installController?.abort(new Error("Model download exceeded its signed size"));
          callback(new Error("Model download exceeded its signed size"));
          return;
        }
        emitProgress({ modelId: model.id, received, total: model.bytes });
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(partial, { flags: offset ? "a" : "w" }), { signal: installController.signal });
      const stat = fs.statSync(partial);
      if (stat.size !== model.bytes) throw new Error(`Model size mismatch: expected ${model.bytes}, got ${stat.size}`);
      emitProgress({ modelId: model.id, received: stat.size, total: model.bytes, verifying: true });
      const digest = await sha256(partial);
      if (digest !== model.sha256) {
        fs.rmSync(partial, { force: true });
        throw new Error("Model checksum verification failed; the invalid partial file was removed");
      }
      fs.renameSync(partial, modelFile());
      atomicWrite(modelManifest(), JSON.stringify({ version: 1, ...model, verified: true, installedAt: new Date().toISOString() }, null, 2) + "\n");
      const installedStat = fs.statSync(modelFile());
      verifiedModelFingerprint = `${installedStat.size}:${installedStat.mtimeMs}`;
      modelIntegrityFailed = false;
      emitProgress({ modelId: model.id, received: stat.size, total: model.bytes, complete: true });
      return status();
    } finally {
      installController = null;
    }
  }

  async function remove() {
    await stop();
    const root = path.resolve(configRoot());
    const target = path.resolve(modelDir());
    if (!target.startsWith(`${root}${path.sep}`) || path.basename(path.dirname(target)) !== "corrections" || path.basename(target) !== model.id) throw new Error("Refusing unsafe correction model removal");
    fs.rmSync(target, { recursive: true, force: true });
    verifiedModelFingerprint = "";
    modelIntegrityFailed = false;
    return status();
  }

  function status() {
    const manifest = readJson(runtimeManifest()) || {};
    return {
      provider: "flux",
      available: installed() && fs.existsSync(serverFile()) && fs.existsSync(runtimeManifest()),
      installed: installed(),
      updateRequired: updateRequired(),
      running: !!child && child.exitCode == null,
      ready: !!child && child.exitCode == null && ready,
      downloading: !!installController,
      model,
      runtime: manifest.release || null,
      acceleration: manifest.acceleration || (runtimePlatform === "darwin" && runtimeArch === "arm64" ? "metal" : "cpu"),
      contextPerSlot: model.contextLength,
      parallelSlots: PARALLEL_SLOTS,
      error: lastError || undefined,
    };
  }

  function registerHandlers(ipc) {
    ipc.handle("correction:modelStatus", () => status());
    ipc.handle("correction:modelInstall", (event) => download(event.sender));
    ipc.handle("correction:modelCancel", () => { if (!installController) return false; installController.abort(new Error("Model download cancelled")); return true; });
    ipc.handle("correction:modelRemove", () => remove());
    ipc.handle("correction:modelUnload", () => stop().then(() => true));
    ipc.handle("correction:modelWarm", () => start().then(() => true));
  }

  async function shutdown() {
    installController?.abort(new Error("Flux is closing"));
    await stop();
  }

  return { registerHandlers, status, warm: start, chat, shutdown, MODEL: model };
}

module.exports = { createCorrectionRuntime, MODEL };
