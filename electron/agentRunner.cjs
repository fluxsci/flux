"use strict";
// Main-process owner for installed CLIs. No vendor credentials are read here.
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { resolveSpawn } = require("./execResolve.cjs");
const drivers = { claude: require("./runnerDrivers/claude.cjs"), codex: require("./runnerDrivers/codex.cjs") };
const SESSION = /^[a-zA-Z0-9_-]{1,128}$/;

function killTree(child, force = false, platform = process.platform) {
  if (!child?.pid) return;
  try {
    if (platform === "win32") {
      const p = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
      p.on("error", () => {});
    } else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch { /* already reaped */ }
}
function spawnOwned(command, args, opts) {
  const { trackChild, ...spawnOptions } = opts;
  const rs = resolveSpawn(command, args, { env: opts.env });
  const child = spawn(rs.command, rs.args, { ...spawnOptions, windowsVerbatimArguments: rs.windowsVerbatimArguments,
    detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  trackChild?.(child);
  return child;
}
function collect(command, args, opts, signal, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawnOwned(command, args, opts);
    let stdout = "", stderr = "", error;
    const stop = () => { error ??= new Error("Agent preparation cancelled"); killTree(child, true); };
    const timer = setTimeout(() => { error = new Error(`Timed out running ${path.basename(command)}`); killTree(child, true); }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", s => { stdout += s; if (stdout.length > 2 * 1024 * 1024) { error = new Error("CLI probe output exceeded its limit"); killTree(child, true); } });
    child.stderr.on("data", s => { stderr = (stderr + s).slice(-16000); });
    child.on("error", e => { error = e; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      if (error || code !== 0) reject(error ?? new Error(stderr.trim() || `${path.basename(command)} exited ${code}`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {}); child.stdin.end();
    if (signal?.aborted) stop();
  });
}
async function pruneRuns(dir, now = Date.now()) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.filter(e => /^[a-f0-9-]{36}(?:\.jsonl)?$/.test(e.name)).map(async e => {
    const p = path.join(dir, e.name);
    const stat = await fs.stat(p).catch(() => null);
    if (stat && stat.mtimeMs < now - 30 * 24 * 60 * 60 * 1000) await fs.rm(p, { recursive: e.isDirectory(), force: true });
  }));
}
function createAgentRunner({ userDataDir, launcher, emit, preferences = () => ({}), env = process.env, binaries = {}, idleMs = 600000, killGraceMs = 1000 }) {
  const runs = new Map(), queue = [], caps = new Map(), children = new Set();
  const logDir = path.join(userDataDir, "runs");
  let loginPath, environment, cacheWrite = Promise.resolve(), closed = false;
  const ready = pruneRuns(logDir);
  // Attach a rejection handler before any run awaits initial filesystem work.
  ready.catch(() => {});
  function trackChild(child) {
    children.add(child);
    child.once("close", () => children.delete(child));
    if (closed) killTree(child, true);
  }
  async function runnerEnv() {
    if (!environment) environment = (async () => {
      let shellPath = "";
      if (process.platform !== "win32") {
        loginPath ??= collect(env.SHELL || "/bin/sh", ["-ilc", 'printf "\\n__FLUX_PATH__%s\\n" "$PATH"'], { env, cwd: userDataDir, trackChild }, undefined, 5000)
          .then(s => s.match(/__FLUX_PATH__([^\r\n]*)/)?.[1] ?? "").catch(() => "");
        shellPath = await loginPath;
      }
      const base = env.Path || env.PATH || "";
      return { ...env, PATH: [path.dirname(launcher), base, shellPath].filter(Boolean).join(path.delimiter), FLUX_CLIENT: "fluxchat" };
    })();
    return environment;
  }
  async function findBinary(name, runEnv) {
    if (binaries[name]) return binaries[name];
    if (process.platform === "win32") return name; // execResolve owns PATH × PATHEXT.
    for (const dir of runEnv.PATH.split(path.delimiter).filter(Boolean)) {
      const p = path.join(dir, name);
      try { await fs.access(p, require("node:fs").constants.X_OK); if ((await fs.stat(p)).isFile()) return p; } catch { /* next PATH entry */ }
    }
    throw new Error(`${name === "claude" ? "Claude Code" : "Codex"} is not installed on PATH`);
  }
  async function detect(name) {
    await ready;
    const runEnv = await runnerEnv();
    let binary;
    try { binary = await findBinary(name, runEnv); }
    catch (e) { return { driver: name, detected: false, available: false, reason: e.message }; }
    try {
      const version = (await collect(binary, ["--version"], { env: runEnv, cwd: userDataDir, trackChild })).trim();
      const key = `${name}:${binary}:${version}`;
      if (caps.has(key)) return caps.get(key);
      const file = path.join(userDataDir, "runner-caps.json");
      const disk = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
      // Cache is disposable, versioned, and stores no raw CLI output or identity.
      let cap = disk.schema === 1 ? disk.entries?.[key] : null;
      if (!cap || typeof cap.available !== "boolean") {
        const help = await collect(binary, name === "claude" ? ["--help"] : ["exec", "--help"], { env: runEnv, cwd: userDataDir, trackChild });
        const resume = name === "codex" ? await collect(binary, ["exec", "resume", "--help"], { env: runEnv, cwd: userDataDir, trackChild }) : "";
        cap = drivers[name].capabilities(version, help, resume);
        const entry = cap;
        cacheWrite = cacheWrite.catch(() => {}).then(async () => {
          const latest = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
          const entries = latest.schema === 1 ? latest.entries ?? {} : {};
          entries[key] = entry;
          const tmp = `${file}.${randomUUID()}.tmp`;
          await fs.writeFile(tmp, JSON.stringify({ schema: 1, entries }), { mode: 0o600 });
          await fs.rename(tmp, file);
        });
        await cacheWrite;
      }
      const result = { ...cap, driver: name, binary, detected: true };
      caps.set(key, result); return result;
    } catch (e) { return { driver: name, binary, detected: true, available: false, reason: e.message }; }
  }
  let detecting;
  function capabilities() { return detecting ??= Promise.all(Object.keys(drivers).map(detect)).finally(() => { detecting = undefined; }); }
  function event(run, payload) {
    if (run.cancelled && !(payload.type === "status" && payload.state === "cancelled")) return;
    if (payload.type === "session") {
      if (!SESSION.test(payload.sessionId)) return fail(run, new Error("CLI returned an invalid session id"));
      run.sessionId = payload.sessionId;
    }
    if (payload.type === "status") {
      run.state = payload.state;
      if (["idle", "failed", "done"].includes(payload.state)) {
        run.inFlight = false;
        if (run.driver === "claude" && payload.state === "idle") armIdle(run);
      }
    }
    const { fatal, ...data } = payload;
    emit(run.owner, { ...data, runId: run.id, seq: ++run.seq });
    if (fatal) fail(run, new Error(payload.message));
  }
  function armIdle(run) {
    clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(() => { if (!run.inFlight) { run.idling = true; killTree(run.child, true); } }, idleMs);
    run.idleTimer.unref?.();
  }
  function fail(run, error) {
    if (run.cancelled || run.failed) return;
    run.failed = true; run.inFlight = false; clearTimeout(run.idleTimer);
    event(run, { type: "error", message: error.message || String(error) });
    event(run, { type: "status", state: "failed" });
    run.abort.abort(); killTree(run.child, true);
  }
  async function prepare(run) {
    await ready;
    const runEnv = await runnerEnv();
    const cap = await detect(run.driver);
    if (!cap.available) throw new Error(cap.reason);
    if (run.model && !cap.model) throw new Error("Installed CLI does not support model selection");
    if (run.effort && !cap.effort) throw new Error("Installed CLI does not support effort selection");
    const dir = path.join(logDir, run.id);
    await fs.mkdir(dir, { mode: 0o700 });
    run.dir = dir;
    run.log = createWriteStream(path.join(logDir, `${run.id}.jsonl`), { flags: "a", mode: 0o600 });
    run.log.on("error", e => fail(run, e));
    await fs.access(launcher).catch(() => { throw new Error("The flux command-line launcher is missing — run AI status → Repair"); });
    const result = await collect(launcher, ["connect", run.root, "--depth", "ask", "--json"], { env: { ...runEnv, FLUX_PROJECT: run.root }, cwd: run.cwd, trackChild }, run.abort.signal, 60000);
    const packPath = JSON.parse(result).askPackPath;
    if (typeof packPath !== "string" || !path.isAbsolute(packPath)) throw new Error("Flux connect returned no Ask pack; repair the Flux AI Bundle");
    const stat = await fs.stat(packPath);
    if (stat.size > 128 * 1024) throw new Error("Ask pack exceeds its size limit");
    const packText = await fs.readFile(packPath, "utf8");
    const mcpPath = path.join(dir, "mcp.json");
    await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: { flux: { command: launcher, args: ["mcp", run.root],
      env: { FLUX_MCP_READONLY: "1", FLUX_CLIENT: "fluxchat", FLUX_PROJECT: run.root } } } }), { mode: 0o600 });
    return { caps: cap, binary: cap.binary, packPath, packText, mcpPath, runDir: dir, launcher, root: run.root, cwd: run.cwd,
      model: run.model, effort: run.effort, env: { ...runEnv, FLUX_PROJECT: run.root, FLUX_MCP_READONLY: "1" } };
  }
  async function imagePaths(run, images) {
    if (!images?.length) return [];
    if (!Array.isArray(images) || images.length > 6) throw new Error("Ask accepts at most six PNG images");
    const files = [];
    for (const image of images) {
      const bytes = Buffer.from(image.png ?? []);
      if (bytes.length > 16 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid Ask PNG");
      const file = path.join(run.dir, `${randomUUID()}.png`);
      await fs.writeFile(file, bytes, { mode: 0o600 }); files.push(file);
    }
    return files;
  }
  function raw(run, channel, text) {
    if (!run.log?.write(JSON.stringify({ ts: new Date().toISOString(), channel, raw: text }) + "\n")) {
      run.child?.stdout.pause(); run.child?.stderr.pause();
      run.log?.once("drain", () => { run.child?.stdout.resume(); run.child?.stderr.resume(); });
    }
  }
  async function launch(run) {
    if (run.cancelled) return;
    run.launching = true;
    try {
      run.prepared ??= await prepare(run);
      if (run.cancelled) return;
      const turn = run.pending; run.pending = null;
      const images = await imagePaths(run, turn?.images);
      if (run.cancelled) return;
      const o = { ...run.prepared, resume: run.sessionId, images };
      // An empty Codex run is only preparation; exec itself starts on Send.
      if (run.driver === "codex" && !turn) { event(run, { type: "status", state: "idle" }); return; }
      const child = spawnOwned(o.binary, drivers[run.driver].args(o), { env: o.env, cwd: run.cwd, trackChild });
      run.child = child; run.idling = false; run.failed = false;
      const parse = drivers[run.driver].parser(e => event(run, e));
      const decoder = new StringDecoder("utf8"); let buffer = "", stderr = "";
      const line = text => {
        if (!text.trim()) return;
        raw(run, "stdout", text);
        try { parse(JSON.parse(text)); } catch (e) { fail(run, new Error(`Invalid ${run.driver} event: ${e.message}`)); }
      };
      child.stdout.on("data", bytes => {
        buffer += decoder.write(bytes);
        if (buffer.length > 8 * 1024 * 1024) { fail(run, new Error("CLI event exceeded 8 MiB")); return; }
        let n; while ((n = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, n)); buffer = buffer.slice(n + 1); }
      });
      child.stderr.setEncoding("utf8"); child.stderr.on("data", s => { stderr = (stderr + s).slice(-16000); raw(run, "stderr", s); });
      child.stdin.on("error", e => { if (!run.cancelled && run.inFlight) fail(run, e); });
      child.on("error", e => fail(run, e));
      child.on("close", code => {
        buffer += decoder.end(); if (buffer.trim()) line(buffer);
        run.child = null; clearTimeout(run.idleTimer);
        if (run.cancelled) { killTree(child, true); finish(run); }
        else if (run.idling) event(run, { type: "status", state: "idle", reason: "Session sleeping; the next question resumes it" });
        else if (code !== 0 || (run.inFlight && !run.pending)) fail(run, new Error(stderr.trim() || `${run.driver} exited before completing the turn (${code})`));
        pump();
      });
      if (turn) {
        if (run.driver === "claude") child.stdin.write(drivers.claude.turn(turn.text, images));
        else child.stdin.end(drivers.codex.turn(turn.text, o.packText, !!o.resume));
      } else armIdle(run);
    } catch (e) { fail(run, e); }
    finally { run.launching = false; if (run.cancelled && !run.child) finish(run); pump(); }
  }
  function active() { return [...runs.values()].filter(r => r.child || r.launching).length; }
  function pump() {
    while (!closed && active() < 3 && queue.length) {
      const run = queue.shift(); run.queued = false;
      if (!run.cancelled && !run.failed) run.launchPromise = launch(run);
    }
  }
  function enqueue(run) {
    if (run.queued || run.launching) return;
    run.queued = true; queue.push(run);
    event(run, { type: "status", state: "starting", ...(active() >= 3 ? { reason: "Queued — three agent runs are active" } : {}) });
    setImmediate(pump);
  }
  function owned(owner, id) {
    const r = runs.get(id);
    if (!r || r.owner !== owner || r.cancelled) throw new Error("Agent run is not owned by this window");
    return r;
  }
  async function start(owner, options) {
    if (closed) throw new Error("Agent runner is closed");
    if (options.mode !== "ask") throw new Error("Only read-only Ask runs are supported");
    const prefs = preferences().fluxchat ?? {};
    const driver = options.driver || prefs.driver || "claude";
    if (!Object.hasOwn(drivers, driver)) throw new Error("Unknown agent driver");
    if (options.resume && !SESSION.test(options.resume)) throw new Error("Invalid resume session id");
    const root = await fs.realpath(options.root);
    const cwd = options.cwd ? await fs.realpath(options.cwd) : root;
    const rel = path.relative(root, cwd);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Agent cwd must be in the open project");
    if (!(await fs.stat(path.join(root, "project.json"))).isFile()) throw new Error("Ask requires a Flux project");
    const firstMessage = options.firstMessage ?? "";
    if (typeof firstMessage !== "string" || firstMessage.length > 256000) throw new Error("Invalid Ask message");
    const model = prefs.model || "", effort = prefs.effort || "";
    if (typeof model !== "string" || model.length > 200 || /[\0\r\n]/.test(model)) throw new Error("Invalid model preference");
    const efforts = driver === "claude" ? ["", "low", "medium", "high", "max"] : ["", "minimal", "low", "medium", "high", "xhigh"];
    if (!efforts.includes(effort)) throw new Error("Invalid effort preference for this agent");
    const run = { id: randomUUID(), owner, driver, root, cwd, model, effort, seq: 0,
      sessionId: options.resume, state: "starting", pending: firstMessage ? { text: firstMessage, images: options.images } : null,
      inFlight: !!firstMessage, abort: new AbortController() };
    runs.set(run.id, run);
    // Defer pushes until the IPC start reply has delivered the run id.
    setImmediate(() => enqueue(run));
    return { runId: run.id, driver };
  }
  async function send(owner, { runId, text, images }) {
    const run = owned(owner, runId);
    if (typeof text !== "string" || !text.trim() || text.length > 256000) throw new Error("Invalid Ask message");
    if (run.inFlight || run.pending) throw new Error("Wait for the current answer or stop it first");
    if (run.launching) await run.launchPromise;
    if (run.cancelled) throw new Error("Agent run was cancelled");
    if (run.inFlight || run.pending) throw new Error("Wait for the current answer or stop it first");
    run.inFlight = true; clearTimeout(run.idleTimer);
    try {
      if (run.driver === "claude" && run.child && !run.idling && !run.failed) {
        const paths = await imagePaths(run, images);
        if (run.cancelled) return;
        event(run, { type: "status", state: "running" });
        run.child.stdin.write(drivers.claude.turn(text, paths));
      } else {
        run.failed = false; run.pending = { text, images };
        if (run.child) {
          // A completed Codex process may still be flushing stdout. Its close
          // must precede the resume; never overwrite an owned child handle.
          run.child.once("close", () => enqueue(run));
        } else enqueue(run);
      }
    } catch (e) { fail(run, e); throw e; }
  }
  function finish(run) {
    clearTimeout(run.killTimer); clearTimeout(run.idleTimer);
    run.log?.end(); runs.delete(run.id);
    if (run.dir) void fs.rm(run.dir, { recursive: true, force: true }).catch(() => {});
  }
  function cancel(owner, { runId }) {
    const run = owned(owner, runId);
    run.cancelled = true; run.abort.abort(); clearTimeout(run.idleTimer);
    event(run, { type: "status", state: "cancelled" });
    if (run.child) {
      killTree(run.child);
      run.killTimer = setTimeout(() => killTree(run.child, true), killGraceMs); run.killTimer.unref?.();
    } else if (!run.launching) finish(run);
    pump();
  }
  function cancelOwner(owner) { for (const r of [...runs.values()]) if (r.owner === owner && !r.cancelled) cancel(owner, { runId: r.id }); }
  function dispose() {
    closed = true;
    for (const r of [...runs.values()]) if (!r.cancelled) cancel(r.owner, { runId: r.id });
    // will-quit cannot wait for a grace timer. Kill all owned subprocess groups,
    // including an in-progress capability/pack probe, before Electron exits.
    return Promise.all([...children].map(child => new Promise(resolve => {
      child.once("close", resolve); killTree(child, true);
    })));
  }
  return { start, send, cancel, capabilities, cancelOwner, dispose };
}
module.exports = { createAgentRunner, killTree, pruneRuns };
