// Agent registration is shared by Electron main and the CLI. Planning consumes
// a probe snapshot; applying rechecks every baseline before touching vendor files.
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { load: loadYaml, JSON_SCHEMA } = require("js-yaml");
const fluxPaths = require("./fluxPaths.cjs");
const { resolveSpawn } = require("./execResolve.cjs");
const { shareRetry } = require("./fsRetry.cjs");
const leases = require("./operationLease.cjs");
const { runProcess } = require("./processRunner.cjs");

const START = "# >>> flux (managed by Flux — change it in Flux → AI status) >>>";
const END = "# <<< flux <<<";
const HOOK_MARKER = "flux-connect: refresh context (managed by Flux)";
const MANIFEST = ".flux-managed.json";
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const { isDeepStrictEqual: equal } = require("node:util");
const check = (id, status, message, fix, paths) => ({ id, status, message, ...(fix ? { fix } : {}), ...(paths ? { paths } : {}) });
const repair = "Run flux connect setup to repair; review the proposed changes first.";

function read(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing a symlinked config file: ${file}`);
    return fs.readFileSync(file, "utf8");
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function object(text, file) {
  if (text === null) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${file}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected an object in ${file}`);
  return value;
}
function exists(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
function snapshot(file) {
  try { return { path: file, text: read(file) }; }
  catch (e) { return { path: file, text: null, error: e.message }; }
}
function quote(value, platform = process.platform) {
  if (/[\r\n]/.test(value)) throw new Error("Newlines are not supported in launcher paths");
  if (platform === "win32") {
    if (/["%!]/.test(value)) throw new Error("Unsupported shell character in Windows launcher path");
    return `"${value}"`;
  }
  return '"' + value.replace(/[\\"$`]/g, "\\$&") + '"';
}

function registration(runtime, agent) {
  const env = { FLUX_WAIT_MAX_MS: "3300000", ...(agent === "codex" ? { FLUX_CLIENT: "codex" } : {}) };
  return runtime.platform === "win32"
    ? { type: "stdio", command: runtime.executable, args: [...runtime.args, "mcp"], env: { ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), ...env } }
    : { type: "stdio", command: runtime.cli, args: ["mcp"], env };
}
function hookEntry(runtime) {
  return { hooks: [{ type: "command", command: `${quote(runtime.cli, runtime.platform)} connect --hook-delta`, statusMessage: HOOK_MARKER }] };
}
function codexBlock(spec) {
  return [START, "[mcp_servers.flux]", `command = ${JSON.stringify(spec.command)}`, `args = ${JSON.stringify(spec.args)}`,
    "tool_timeout_sec = 3600", "", "[mcp_servers.flux.env]", ...Object.entries(spec.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`), END, ""].join("\n");
}

// Recognize quoted TOML key components too. Never mistake a nested table's next
// sibling (or a header inside a multiline string) for part of our own block.
function tomlSections(text) {
  const lines = text.match(/.*(?:\r?\n|$)/g).filter(Boolean);
  const headers = [], markers = []; let multiline = null, offset = 0;
  for (const line of lines) {
    if (!multiline) {
      if (/^# >>> flux .*>>>\r?\n?$/.test(line)) markers.push({ kind: "start", index: offset, length: line.length });
      if (/^# <<< flux <<<\r?\n?$/.test(line)) markers.push({ kind: "end", index: offset, length: line.length });
      const match = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line.trimEnd());
      if (match) {
        const keys = match[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|[\w-]+/g) || [];
        headers.push({ start: offset, keys: keys.map(k => k.startsWith('"') ? JSON.parse(k) : k.startsWith("'") ? k.slice(1, -1) : k) });
      } else if (/^\s*\[\[/.test(line)) headers.push({ start: offset, keys: [] });
    }
    // Strip single-line strings/comments before tracking multiline delimiters.
    for (let i = 0; i < line.length;) {
      if (multiline) {
        const end = line.indexOf(multiline, i);
        if (end < 0) break;
        i = end + 3; multiline = null;
      } else if (line[i] === '#') break;
      else if (line.slice(i, i + 3) === '"""' || line.slice(i, i + 3) === "'''") { multiline = line.slice(i, i + 3); i += 3; }
      else if (line[i] === '"' || line[i] === "'") {
        const q = line[i++];
        while (i < line.length) { if (q === '"' && line[i] === '\\') i += 2; else if (line[i++] === q) break; }
      } else i++;
    }
    offset += line.length;
  }
  return Object.assign(headers.map((h, i) => ({ ...h, end: headers[i + 1]?.start ?? text.length })), { markers });
}
function splitCodex(text) {
  text ||= "";
  const layout = tomlSections(text);
  const starts = layout.markers.filter(m => m.kind === "start"), ends = layout.markers.filter(m => m.kind === "end");
  if (starts.length !== ends.length || starts.length > 1 || starts.length && starts[0].index >= ends[0].index) throw new Error("Malformed or duplicate Flux config markers");
  const start = starts[0]?.index ?? -1, end = ends.length ? ends[0].index + ends[0].length : -1;
  const outside = start < 0 ? text : text.slice(0, start) + text.slice(end);
  const tables = tomlSections(outside).filter(h => h.keys[0] === "mcp_servers" && h.keys[1] === "flux");
  return { outside, tables, managed: start < 0 ? null : text.slice(start, end), start, end };
}
function commentTable(text, date) {
  const prefix = `# (disabled by Flux setup ${date}) `;
  return text.replace(/^.+$|^(?=\r?\n)/gm, line => prefix + line);
}
function addCodex(text, spec, date) {
  const { outside, tables } = splitCodex(text);
  let base = outside;
  for (const table of tables.slice().reverse()) {
    const disabled = commentTable(base.slice(table.start, table.end), date);
    base = base.slice(0, table.start) + disabled + base.slice(table.end);
  }
  return base + (base && !base.endsWith("\n") ? "\n" : "") + codexBlock(spec);
}
function mergeHook(text, runtime) {
  const data = object(text, "hook config");
  if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks))) throw new Error("Invalid hooks object");
  const groups = data.hooks?.UserPromptSubmit ?? [];
  if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks))) throw new Error("Invalid UserPromptSubmit hook array");
  const kept = groups.map(g => ({ ...g, hooks: g.hooks.filter(h => h.statusMessage !== HOOK_MARKER) })).filter(g => g.hooks.length);
  return json({ ...data, hooks: { ...data.hooks, UserPromptSubmit: [...kept, hookEntry(runtime)] } });
}
function stripHook(text) {
  const data = object(text, "hook config");
  if (!Array.isArray(data.hooks?.UserPromptSubmit)) return text;
  const groups = data.hooks.UserPromptSubmit.map(g => ({ ...g, hooks: g.hooks.filter(h => h.statusMessage !== HOOK_MARKER) })).filter(g => g.hooks.length);
  if (groups.length) data.hooks.UserPromptSubmit = groups; else delete data.hooks.UserPromptSubmit;
  if (!Object.keys(data.hooks).length) delete data.hooks;
  return json(data);
}

function renderSkill(runtime, agent, templateDir = path.join(__dirname, "..", "resources", "agent-skills", "flux-connect")) {
  const template = fs.readFileSync(path.join(templateDir, "SKILL.md"), "utf8");
  const metadata = fs.readFileSync(path.join(templateDir, "agents", "openai.yaml"), "utf8");
  // Codex has its own invocation policy in openai.yaml; no reliance on how a
  // vendor treats the other's optional frontmatter fields.
  const source = agent === "codex" ? template.replace(/^argument-hint:.*\n/m, "") : template;
  const files = { "SKILL.md": source.replaceAll('"{{FLUX_CLI}}"', quote(runtime.cli, runtime.platform)).replaceAll("{{FLUX_CLI}}", runtime.cli) };
  if (agent === "codex") files["agents/openai.yaml"] = metadata;
  const manifest = { owner: "flux", version: runtime.build, templateHash: sha(template + metadata), files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])) };
  return { files, manifest };
}
function skillStatus(dir, rendered) {
  const marker = snapshot(path.join(dir, MANIFEST));
  try {
    if (marker.error) throw new Error(marker.error);
    if (exists(dir)?.isSymbolicLink()) throw new Error("exists, not managed by Flux (symlink)");
    if (!marker.text) return { state: exists(dir) ? "unmanaged" : "missing", files: {}, marker };
    const managed = object(marker.text, marker.path);
    if (managed.owner !== "flux" || !managed.files || typeof managed.files !== "object") throw new Error("exists, not managed by Flux");
    if (exists(path.join(dir, "agents"))?.isSymbolicLink()) throw new Error("Managed metadata directory is a symlink; left untouched");
    const files = {};
    for (const name of Object.keys(managed.files)) {
      if (!["SKILL.md", "agents/openai.yaml"].includes(name)) throw new Error("Unrecognized managed skill file");
      files[name] = read(path.join(dir, name));
      if (files[name] === null || sha(files[name]) !== managed.files[name]) return { state: "edited", files, marker, managed };
    }
    if (!managed.files["SKILL.md"]) throw new Error("Missing SKILL.md hash");
    const extra = Object.keys(skillTree(dir)).filter(name => name !== MANIFEST && !Object.hasOwn(managed.files, name));
    if (extra.length) return { state: "edited", files, marker, managed, error: `Additional user files: ${extra.join(", ")}` };
    return { state: equal(managed.files, rendered.manifest.files) && managed.templateHash === rendered.manifest.templateHash ? "current" : "outdated", files, marker, managed, treeHash: treeHash(dir) };
  } catch (e) { return { state: "unmanaged", files: {}, marker, error: e.message }; }
}

async function run(command, args, options = {}) {
  const bytes = []; let total = 0;
  const result = await runProcess({ executable: command, argv: args, cwd: options.cwd || os.homedir(), envDelta: options.env || {} }, {
    timeoutMs: options.timeout || 10000, maxOutputBytes: 4 * 1024 * 1024,
    onOutput(stream, chunk) {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) throw new Error("Output exceeded 4 MiB");
      if (options.binary && stream === "stdout") bytes.push(chunk);
    },
  });
  return { code: result.code, stdout: options.binary ? Buffer.concat(bytes) : result.stdout, stderr: result.stderr,
    error: result.status === "exited" ? undefined : `Process ${result.status}` };
}

const loginProbes = new Map();
async function vendorProbe(binary, args, config) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "flux-agent-probe-"));
  try {
    await fsp.mkdir(path.join(temp, ".codex"));
    await fsp.mkdir(path.join(temp, ".claude"));
    if (config) {
      let servers = {};
      try { servers = object(config, "Claude config").mcpServers || {}; } catch { /* planner reports invalid config */ }
      await fsp.writeFile(path.join(temp, ".claude.json"), json({ mcpServers: servers }), { mode: 0o600 });
    }
    return await run(binary, args, { cwd: temp, env: { ...process.env, HOME: temp, USERPROFILE: temp, CODEX_HOME: path.join(temp, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(temp, ".claude"), XDG_CONFIG_HOME: path.join(temp, ".config"), FLUX_NO_MIGRATE: "1" } });
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
}
async function findBinary(name, login = true) {
  const win = process.platform === "win32";
  if (win) {
    const r = resolveSpawn(name, []);
    if (r.command !== name) return r.windowsVerbatimArguments ? (r.args[3].match(/^""([^"\r\n]+)"/)?.[1] || null) : r.command;
    return null;
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const file = path.resolve(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* next PATH entry */ }
  }
  if (!login || name !== "claude" || !process.env.SHELL) return null;
  const key = [os.homedir(), process.env.SHELL, process.env.PATH].join("\0");
  if (!loginProbes.has(key)) loginProbes.set(key, run(process.env.SHELL, ["-lc", "command -v claude"], { timeout: 3000 }).then(r => {
    const candidate = r.stdout.trim();
    return r.code === 0 && path.isAbsolute(candidate) && exists(candidate)?.isFile() ? candidate : null;
  }));
  return loginProbes.get(key);
}
function statePath() { return path.join(fluxPaths.userDataDir(), "agent-setup.json"); }
function readState() {
  const snap = snapshot(statePath());
  if (snap.error) throw new Error(snap.error);
  const value = object(snap.text, snap.path);
  if (snap.text && (value.owner !== "flux" || value.version !== 1 || !value.agents)) throw new Error("Unrecognized agent setup state; left untouched");
  for (const [id, entry] of Object.entries(value.agents || {})) {
    if (!["claude", "codex"].includes(id) || !entry || typeof entry !== "object") throw new Error("Invalid agent in setup state");
    for (const [name, record] of Object.entries(entry.publications || {})) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name === "flux-connect" || !record || !["symlink", "copy"].includes(record.mode) || !path.isAbsolute(record.source || "")) throw new Error("Invalid skill publication in setup state");
    }
  }
  return { snap, value: snap.text ? value : { owner: "flux", version: 1, agents: {} } };
}

async function probeAgents(options = {}) {
  const runtime = options.runtime || fluxPaths.resolveOwnCliCommandsSync({ commands: options.commands });
  const state = readState();
  const launcher = snapshot(runtime.cli), owner = launcher.error ? null : fluxPaths.launcherOwnerSync(runtime.cli);
  return Promise.all(["claude", "codex"].map(async id => {
    const home = path.join(os.homedir(), id === "claude" ? ".claude" : ".codex");
    const skillDir = path.join(os.homedir(), id === "claude" ? ".claude" : ".agents", "skills", "flux-connect");
    const config = snapshot(id === "claude" ? path.join(os.homedir(), ".claude.json") : path.join(home, "config.toml"));
    const hooks = snapshot(path.join(home, id === "claude" ? "settings.json" : "hooks.json"));
    const binary = await findBinary(id, options.commands !== false);
    let version = null;
    const rendered = renderSkill(runtime, id, options.templateDir);
    let capabilities = { promptHook: id === "claude", hookEnabled: id === "claude", addJson: true }, mcpGet = null;
    if (binary && options.commands !== false) {
      const info = vendorProbe(binary, ["--version"]);
      if (id === "claude") {
        const [help, get] = await Promise.all([vendorProbe(binary, ["mcp", "--help"]), vendorProbe(binary, ["mcp", "get", "flux"], config.error ? null : config.text)]);
        capabilities.addJson = help.code === 0 && /\badd-json\b/.test(help.stdout);
        mcpGet = get;
      } else {
        const features = await vendorProbe(binary, ["features", "list"]);
        const match = /^hooks\s+\S+\s+(true|false)\s*$/m.exec(features.stdout);
        capabilities.promptHook = features.code === 0 && !!match;
        const featureSection = tomlSections(config.text || "").find(t => t.keys.length === 1 && t.keys[0] === "features");
        const configured = featureSection && /^\s*(?:hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/m.exec(config.text.slice(featureSection.start, featureSection.end));
        capabilities.hookEnabled = configured ? configured[1] === "true" : match?.[1] === "true";
      }
      const result = await info;
      if (result.code === 0) version = result.stdout.trim().split("\n")[0].slice(0, 160);
    }
    return { id, present: !!binary || !!exists(home) || id === "codex" && !!exists(path.join(os.homedir(), ".agents")), binary, version,
      home, skillDir, skill: skillStatus(skillDir, rendered), rendered, config, hooks, capabilities, mcpGet,
      runtime, launcher, owner, ownerAlive: !!owner && fs.existsSync(owner.target), date: new Date().toISOString().slice(0, 10), state: state.value.agents[id] || null, stateSnapshot: state.snap };
  }));
}

function selected(probe, agents) {
  if (!Array.isArray(probe)) throw new Error("Call probeAgents() first and pass its snapshot as probe");
  const ids = agents === undefined ? probe.filter(a => a.present || a.state).map(a => a.id) : typeof agents === "string" ? agents.split(",") : agents;
  if (ids.some(id => !["claude", "codex"].includes(id))) throw new Error("Supported agents: claude,codex. Other agents use the printed MCP instructions.");
  return probe.filter(a => ids.includes(a.id));
}
function planSetup(options = {}) {
  const chosen = selected(options.probe, options.agents), runtime = options.probe[0]?.runtime;
  if (!runtime) throw new Error("Empty agent probe");
  const plan = { kind: "setup", runtime, agents: chosen.map(a => a.id), actions: [], checks: [], createLocalBin: !!options.createLocalBin, useThisInstall: !!options.useThisInstall,
    probe: options.probe, nextSteps: ["Restart open Claude Code / Codex sessions to load the MCP server and skills.",
      `Other agents: register ${JSON.stringify(registration(runtime, "other"))}; run ${quote(path.join(path.dirname(runtime.cli), "flux-connect" + (runtime.platform === "win32" ? ".cmd" : "")), runtime.platform)} <project> and follow the brief.`] };
  const first = options.probe[0];
  if (first.launcher.error || first.launcher.text && !first.owner) {
    plan.checks.push(check("launcher", "fail", first.launcher.error || "Launcher exists, not managed by Flux.", "Move your launcher aside explicitly before setup.", [runtime.cli]));
    return plan;
  }
  if (first.owner && first.ownerAlive && first.owner.target !== runtime.target && !options.useThisInstall) {
    plan.checks.push(check("launcher.owner", "fail", `Launcher belongs to ${first.owner.target}.`, "Run setup --use-this-install to choose this install.", [runtime.cli]));
    return plan;
  }
  for (const agent of chosen) {
    const id = agent.id;
    if (["missing", "outdated"].includes(agent.skill.state)) {
      for (const [name, text] of Object.entries(agent.rendered.files)) plan.actions.push({ kind: "file", role: "skill", agent: id, path: path.join(agent.skillDir, name), before: agent.skill.files[name] ?? null, after: text });
      plan.actions.push({ kind: "file", role: "skill", agent: id, path: path.join(agent.skillDir, MANIFEST), before: agent.skill.marker.text, after: json(agent.rendered.manifest) });
    } else if (agent.skill.state !== "current") plan.checks.push(check(`${id}.skill`, "warn", `${agent.skillDir}: ${agent.skill.state === "edited" ? "managed skill was edited; left untouched" : "exists, not managed by Flux"}.`, "Move the skill aside to install the stock version.", [agent.skillDir]));
    try {
      if (agent.config.error) throw new Error(agent.config.error);
      const spec = registration(runtime, id);
      if (id === "claude") {
        const data = object(agent.config.text, agent.config.path);
        if (data.mcpServers !== undefined && (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers))) throw new Error("Invalid mcpServers object");
        const before = data.mcpServers?.flux ?? null;
        if (!equal(before, spec)) {
          const owned = before && agent.state?.mcp && equal(before, agent.state.mcp.spec);
          const looksFlux = before && typeof before.command === "string" && (/flux-mcp/.test(before.command + " " + (before.args || []).join(" ")) || before.command === runtime.cli || before.command === runtime.executable && (before.args || []).includes(runtime.args[0]));
          if (before && !owned && !looksFlux) plan.checks.push(check("claude.mcp", "warn", "The flux MCP name is taken by an unrelated server; left untouched.", "Rename that server before connecting Flux.", [agent.config.path]));
          else plan.actions.push({ kind: "claude-mcp", agent: id, path: agent.config.path, before: agent.config.text,
            after: json({ ...data, mcpServers: { ...data.mcpServers, flux: spec } }), spec, previous: before, binary: agent.binary, addJson: agent.capabilities.addJson, confirmation: !!before && !owned });
        }
        if (!agent.binary) plan.checks.push(check("claude.binary", "warn", "Using ~/.claude.json because no Claude CLI was found.", "Close Claude Code while setup edits this file; restart it afterward.", [agent.config.path]));
        if (agent.mcpGet?.code === 0 && !before) plan.checks.push(check("claude.scope", "warn", "Another scope already defines flux; a user registration may be shadowed.", "Inspect claude mcp get flux in your project and remove its overriding entry."));
      } else {
        const parts = splitCodex(agent.config.text);
        const after = addCodex(agent.config.text, spec, agent.date);
        if (after !== agent.config.text) plan.actions.push({ kind: "file", role: "mcp", agent: id, path: agent.config.path, before: agent.config.text, after, confirmation: parts.tables.length > 0 });
      }
    } catch (e) { plan.checks.push(check(`${id}.mcp`, "fail", e.message, "Fix the vendor config syntax, then run setup again.", [agent.config.path])); }
    try {
      if (!agent.capabilities.promptHook) plan.checks.push(check(`${id}.hook`, "warn", "No supported prompt-submit hook was detected; MCP refresh remains available.", "Update Codex and run setup again."));
      else {
        if (agent.hooks.error) throw new Error(agent.hooks.error);
        const after = mergeHook(agent.hooks.text, runtime);
        if (after !== agent.hooks.text) plan.actions.push({ kind: "file", role: "hook", agent: id, path: agent.hooks.path, before: agent.hooks.text, after });
        if (id === "codex") {
          plan.nextSteps.push("In Codex, open /hooks and review/trust the Flux refresh hook.");
          if (!agent.capabilities.hookEnabled) plan.checks.push(check("codex.hook.disabled", "warn", "Codex hooks are disabled.", "Enable features.hooks in your Codex config, then review the hook in /hooks."));
        }
      }
    } catch (e) { plan.checks.push(check(`${id}.hook`, "fail", e.message, "Fix the hooks config, then run setup again.", [agent.hooks.path])); }
  }
  if (options.createLocalBin && runtime.platform === "darwin") plan.nextSteps.push(`Add ~/.local/bin to PATH yourself: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`);
  return plan;
}

async function syncDir(dir) {
  if (process.platform === "win32") return;
  const handle = await fsp.open(dir, "r");
  try { await handle.sync(); } catch (e) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(e.code)) throw e; }
  finally { await handle.close(); }
}
async function backup(file, before, report) {
  if (before === null) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  const base = `${file}.bak-flux-${stamp}`;
  for (let i = 0; ; i++) {
    const dest = base + (i ? `-${i}` : "");
    try {
      const handle = await fsp.open(dest, "wx", 0o600);
      try { await handle.writeFile(before); await handle.sync(); } finally { await handle.close(); }
      await syncDir(path.dirname(dest)); report.backups.push(dest); return;
    } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
}
async function write(file, before, after, report, requestedMode) {
  if (before === after) return;
  if (read(file) !== before) throw new Error(`Changed since planning; re-probe before applying: ${file}`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await backup(file, before, report);
  if (after === null) { await shareRetry(() => fsp.unlink(file)); await syncDir(path.dirname(file)); return; }
  const tmp = file + ".tmp-" + crypto.randomUUID();
  const mode = requestedMode ?? (before === null ? 0o600 : fs.statSync(file).mode & 0o777);
  try {
    const handle = await fsp.open(tmp, "wx", mode);
    try { await handle.writeFile(after); await handle.sync(); } finally { await handle.close(); }
    if (read(file) !== before) throw new Error(`Changed during apply: ${file}`);
    await shareRetry(() => fsp.rename(tmp, file)); await syncDir(path.dirname(file));
  } finally { await fsp.rm(tmp, { force: true }); }
}
async function withSetupLock(fn) {
  const dir = path.join(fluxPaths.userDataDir(), "locks");
  return leases.queued(dir, "agent-setup", async () => {
    const got = await leases.acquire(dir, "agent-setup", "flux-connect");
    if (!got.ok) throw new Error(`Agent setup is busy (${got.heldBy}); retry after it finishes.`);
    try { return await fn(); } finally { await leases.release(got.lease); }
  });
}
async function saveState(state, report) { const file = statePath(); await write(file, read(file), json(state), report); }
async function applyClaude(action, report) {
  if (!action.binary) return write(action.path, action.before, action.after, report);
  if (read(action.path) !== action.before) throw new Error(`Changed since planning: ${action.path}`);
  await fsp.mkdir(path.dirname(action.path), { recursive: true });
  await backup(action.path, action.before, report);
  const runChecked = async args => { const r = await run(action.binary, args); if (r.code !== 0 || r.error) throw new Error(`claude ${args.slice(0, 3).join(" ")}: ${r.error || r.stderr || r.stdout}`); };
  try {
    if (action.previous) await runChecked(["mcp", "remove", "flux", "--scope", "user"]);
    if (action.spec) {
      if (action.addJson) await runChecked(["mcp", "add-json", "flux", JSON.stringify(action.spec), "--scope", "user"]);
      else await runChecked(["mcp", "add", "flux", "--scope", "user", "--env", ...Object.entries(action.spec.env || {}).map(([k, v]) => `${k}=${v}`), "--", action.spec.command, ...action.spec.args]);
    }
    const current = object(read(action.path), action.path);
    if (!equal(current.mcpServers?.flux ?? null, action.spec)) throw new Error("Claude CLI did not write the expected user-scope MCP registration");
  } catch (error) {
    // A failed add after a successful remove must not strand the previous
    // server. Restore only our field, preserving unrelated concurrent edits.
    const now = read(action.path), data = object(now, action.path), server = data.mcpServers?.flux ?? null;
    if (server === null || equal(server, action.spec)) {
      if (action.previous) data.mcpServers = { ...data.mcpServers, flux: action.previous };
      else if (data.mcpServers) { delete data.mcpServers.flux; if (!Object.keys(data.mcpServers).length) delete data.mcpServers; }
      const restored = equal(data, object(action.before, action.path)) ? action.before : json(data);
      await write(action.path, now, restored, report);
    }
    throw new Error(`${error.message}; previous registration restored where unchanged. Inspect the backup before retrying.`);
  }
}

async function applySetup(plan, options = {}) {
  if (plan.kind !== "setup") throw new Error("Expected a setup plan");
  if (process.env.FLUX_NO_MIGRATE === "1") throw new Error("FLUX_NO_MIGRATE disables setup; clear it only for an authorized home before applying.");
  if (plan.checks.some(c => c.status === "fail")) throw new Error("Setup has failed checks; fix them before applying.");
  if (plan.actions.some(a => a.confirmation) && !options.yes) throw new Error("Replacing an existing MCP registration requires confirmation (--yes).");
  return withSetupLock(async () => {
    if (read(statePath()) !== plan.probe[0].stateSnapshot.text) throw new Error("Agent setup state changed since planning; re-probe.");
    for (const action of plan.actions) if (read(action.path) !== action.before) throw new Error(`Changed since planning: ${action.path}`);
    if (read(plan.runtime.cli) !== plan.probe[0].launcher.text) throw new Error("Launcher changed since planning; re-probe.");
    const report = { checks: [...plan.checks], changes: [], backups: [], nextSteps: plan.nextSteps };
    const state = readState().value;
    // Record ownership before publication so interruption remains repairable.
    for (const id of plan.agents) { state.agents[id] ||= { files: {}, mcp: null }; state.agents[id].connected = true; }
    for (const action of plan.actions) {
      const entry = state.agents[action.agent];
      if (action.kind === "claude-mcp") entry.mcp = { previous: entry.mcp ? entry.mcp.previous : action.previous, spec: action.spec, original: entry.mcp ? entry.mcp.original : action.before, installed: action.after };
      else if (action.role !== "skill") entry.files[action.role] = { path: action.path, original: entry.files[action.role] ? entry.files[action.role].original : action.before, installed: action.after };
    }
    await saveState(state, report);
    const launcherEvents = [];
    await fluxPaths.installLaunchers(launcherEvents, { runtime: plan.runtime, createConvenience: plan.createLocalBin, useThisInstall: plan.useThisInstall, publish: (file, before, after) => write(file, before, after, report, 0o755) });
    report.changes.push(...launcherEvents.map(e => ({ agent: "shared", path: e.detail, action: e.action })));
    for (const action of plan.actions) {
      if (action.kind === "claude-mcp") await applyClaude(action, report);
      else await write(action.path, action.before, action.after, report);
      report.changes.push({ agent: action.agent, path: action.path, action: "installed/updated" });
    }
    const published = await publishUnlocked(state, { agents: plan.agents });
    report.checks.push(...published.checks); report.changes.push(...published.changes); report.backups.push(...published.backups);
    await saveState(state, report);
    return report;
  });
}

function planRemove(options = {}) {
  const chosen = selected(options.probe, options.agents);
  const plan = { kind: "remove", agents: chosen.map(a => a.id), actions: [], checks: [], probe: options.probe, nextSteps: ["Restart open agent sessions to unload Flux's MCP server and skills."] };
  for (const agent of chosen) {
    if (["current", "outdated"].includes(agent.skill.state)) {
      plan.actions.push({ kind: "skill-remove", agent: agent.id, path: agent.skillDir, before: agent.skill.treeHash, after: null });
    } else if (agent.skill.state !== "missing") plan.checks.push(check(`${agent.id}.skill`, "warn", "Edited or unmanaged skill left untouched.", "Remove it manually if desired.", [agent.skillDir]));
    if (!agent.state) continue;
    for (const [role, record] of Object.entries(agent.state.files || {})) {
      const current = role === "hook" ? agent.hooks : agent.config;
      try {
        if (current.error) throw new Error(current.error);
        let after = current.text;
        if (current.text === record.installed) after = record.original;
        else if (current.text && role === "hook") after = stripHook(current.text);
        else if (current.text && role === "mcp") {
          const parsed = splitCodex(current.text), old = splitCodex(record.original);
          if (parsed.managed !== splitCodex(record.installed).managed) throw new Error("Managed MCP block was edited; left untouched");
          after = parsed.outside;
          for (const table of old.tables) {
            const source = old.outside.slice(table.start, table.end);
            const disabled = commentTable(source, /# \(disabled by Flux setup ([^)]+)\)/.exec(record.installed)?.[1] || "");
            if (!after.includes(disabled)) throw new Error("Disabled original MCP table was edited; left untouched");
            after = after.replace(disabled, source);
          }
        }
        if (after !== current.text) plan.actions.push({ kind: "file", agent: agent.id, path: current.path, before: current.text, after });
      } catch (e) { plan.checks.push(check(`${agent.id}.${role}`, "warn", e.message, "Review and remove the edited entry manually.", [current.path])); }
    }
    if (agent.id === "claude" && agent.state.mcp) {
      const record = agent.state.mcp;
      try {
        if (agent.config.error) throw new Error(agent.config.error);
        const data = object(agent.config.text, agent.config.path);
        if (!equal(data.mcpServers?.flux ?? null, record.spec)) throw new Error("Claude MCP registration changed; left untouched");
        if (record.previous) data.mcpServers.flux = record.previous;
        else { delete data.mcpServers.flux; if (!Object.keys(data.mcpServers).length) delete data.mcpServers; }
        const after = equal(object(agent.config.text, agent.config.path), object(record.installed, agent.config.path)) ? record.original : json(data);
        plan.actions.push({ kind: "claude-mcp", agent: "claude", path: agent.config.path, before: agent.config.text, after,
          previous: record.spec, spec: record.previous, binary: agent.binary, addJson: agent.capabilities.addJson });
      } catch (e) { plan.checks.push(check("claude.mcp", "warn", e.message, "Review and remove the edited entry manually.", [agent.config.path])); }
    }
  }
  return plan;
}
async function applyRemove(plan, options = {}) {
  if (plan.kind !== "remove") throw new Error("Expected a removal plan");
  if (!options.yes) throw new Error("Disconnecting agents requires confirmation (--yes).");
  return withSetupLock(async () => {
    if (read(statePath()) !== plan.probe[0].stateSnapshot.text) throw new Error("Agent setup state changed since planning; re-probe.");
    for (const action of plan.actions) if ((action.kind === "skill-remove" ? treeHash(action.path) : read(action.path)) !== action.before) throw new Error(`Changed since planning: ${action.path}`);
    const report = { checks: [...plan.checks], changes: [], backups: [], nextSteps: plan.nextSteps };
    const state = readState().value;
    for (const action of plan.actions) {
      if (action.kind === "skill-remove") {
        await backupSkillTree(action.path, report, true);
        if (treeHash(action.path) !== action.before) throw new Error(`Changed during removal: ${action.path}`);
        const retired = path.join(path.dirname(action.path), ".flux-removed-" + crypto.randomUUID());
        await fsp.rename(action.path, retired); await syncDir(path.dirname(action.path));
        await fsp.rm(retired, { recursive: true });
      } else if (action.kind === "claude-mcp" && action.binary) {
        await applyClaude(action, report);
        // The CLI normalizes JSON; restore original bytes only when its semantic
        // result is exactly our proposal (no concurrent user changes).
        const now = read(action.path);
        if (equal(object(now, action.path), object(action.after, action.path))) await write(action.path, now, action.after, report);
      } else await write(action.path, action.before, action.after, report);
      report.changes.push({ agent: action.agent, path: action.path, action: "removed/restored" });
    }
    const published = await publishUnlocked(state, { agents: plan.agents, remove: true });
    report.checks.push(...published.checks); report.changes.push(...published.changes); report.backups.push(...published.backups);
    for (const id of plan.agents) {
      if (exists(path.join(os.homedir(), id === "claude" ? ".claude" : ".agents", "skills", "flux-connect", MANIFEST))) {
        state.agents[id] ||= { files: {}, mcp: null }; state.agents[id].connected = false;
      } else delete state.agents[id];
    }
    await saveState(state, report);
    return report;
  });
}

function validateSkill(text, name) {
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || name === "flux-connect") throw new Error("Use a lowercase hyphenated name (1–64 characters); flux-connect is reserved");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error("SKILL.md needs YAML frontmatter");
    const meta = loadYaml(match[1], { schema: JSON_SCHEMA });
    if (!meta || meta.name !== name) throw new Error("Frontmatter name must equal the folder name");
    if (typeof meta.description !== "string" || !meta.description.trim()) throw new Error("Frontmatter description is required");
    return { name, description: meta.description.trim() };
  } catch (e) { return { name, error: e.message }; }
}
function skillTree(dir, includeBackups = false) {
  const files = {};
  function walk(at, prefix) {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!includeBackups && entry.name.includes(".bak-flux-")) continue;
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Skill contains a symlink: ${relative}`);
      if (entry.isDirectory()) walk(path.join(at, entry.name), relative + "/");
      else if (entry.isFile()) files[relative] = fs.readFileSync(path.join(at, entry.name));
      else throw new Error(`Unsupported skill entry: ${relative}`);
    }
  }
  walk(dir, ""); return files;
}
function treeHash(dir) { return sha(json(Object.fromEntries(Object.entries(skillTree(dir, true)).map(([name, bytes]) => [name, sha(bytes)])))); }
function userSkills() {
  const dir = path.join(fluxPaths.userContextPathSync(), "Skills");
  const skills = [];
  if (!exists(dir)) return skills;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(dir, entry.name);
    try {
      const meta = validateSkill(read(path.join(source, "SKILL.md")) || "", entry.name);
      skills.push({ ...meta, source });
    } catch (e) { skills.push({ name: entry.name, source, error: e.message }); }
  }
  return skills;
}
function ownedPublication(dest, record) {
  const stat = exists(dest);
  if (!stat) return true;
  if (record.mode === "symlink") return stat.isSymbolicLink() && path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === record.source;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  try { return equal(Object.fromEntries(Object.entries(skillTree(dest)).map(([k, v]) => [k, sha(v)])), record.hashes); } catch { return false; }
}
async function backupSkillTree(dest, report, includeBackups = false) {
  const files = Object.fromEntries(Object.entries(skillTree(dest, includeBackups)).map(([name, bytes]) => [name, {
    base64: bytes.toString("base64"), mode: fs.statSync(path.join(dest, name)).mode & 0o777,
  }]));
  // A backup directory containing SKILL.md would itself be discovered as a
  // second vendor skill. Store a lossless, self-describing file instead.
  await backup(dest, json({ format: "flux-skill-backup-v1", files }), report);
}
async function publishUnlocked(state, options = {}) {
  const report = { checks: [], changes: [], backups: [], nextSteps: [] };
  const skills = userSkills();
  for (const skill of skills) if (skill.error) report.checks.push(check(`skill.${skill.name}`, "warn", skill.error, "Fix this skill's frontmatter before publishing.", [skill.source]));
  for (const id of options.agents || Object.keys(state.agents)) {
    if (!state.agents[id] || state.agents[id].connected === false && !options.remove) continue;
    const entry = state.agents[id]; entry.publications ||= {};
    const dir = path.join(os.homedir(), id === "claude" ? ".claude" : ".agents", "skills");
    const wanted = new Map(options.remove ? [] : skills.filter(s => !s.error).map(s => [s.name, s]));
    for (const [name, record] of Object.entries(entry.publications)) {
      const dest = path.join(dir, name);
      if (!ownedPublication(dest, record)) { report.checks.push(check(`${id}.skill.${name}`, "warn", "Published skill was changed; left untouched.", "Move the vendor copy aside to resume publishing.", [dest])); wanted.delete(name); continue; }
      if (!wanted.has(name) || record.source !== wanted.get(name).source) {
        if (exists(dest)) {
          if (record.mode === "symlink") { await backup(dest, fs.readlinkSync(dest), report); await fsp.unlink(dest); }
          else { await backupSkillTree(dest, report); await fsp.rm(dest, { recursive: true }); }
          await syncDir(dir);
          report.changes.push({ agent: id, path: dest, action: "unpublished" });
        }
        delete entry.publications[name];
      }
    }
    for (const [name, skill] of wanted) {
      const dest = path.join(dir, name), record = entry.publications[name];
      if (!record && exists(dest)) { report.checks.push(check(`${id}.skill.${name}`, "warn", "Name taken by an existing skill; left untouched.", "Rename your UserContext skill or move the existing vendor skill.", [dest])); continue; }
      try {
        await fsp.mkdir(dir, { recursive: true });
        if ((!record || record.mode === "symlink") && !options.copy) {
          if (exists(dest)) continue;
          try {
            await fsp.symlink(skill.source, dest, "dir");
            entry.publications[name] = { mode: "symlink", source: skill.source };
            report.changes.push({ agent: id, path: dest, action: "published symlink" }); continue;
          } catch (e) { if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP"].includes(e.code)) throw e; }
        }
        const files = skillTree(skill.source), hashes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)]));
        if (record?.mode === "copy" && equal(hashes, record.hashes) && exists(dest)) continue;
        // Publish the whole tree as one directory rename. An old managed copy is
        // retained beside it, including binary assets and file modes.
        const tmp = dest + ".tmp-" + crypto.randomUUID();
        await fsp.mkdir(tmp);
        try {
          for (const [name, bytes] of Object.entries(files)) {
            const file = path.join(tmp, name); await fsp.mkdir(path.dirname(file), { recursive: true });
            const handle = await fsp.open(file, "wx", fs.statSync(path.join(skill.source, name)).mode & 0o777);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          }
          let saved;
          if (exists(dest)) {
            if (exists(dest).isSymbolicLink()) await backup(dest, fs.readlinkSync(dest), report);
            else await backupSkillTree(dest, report);
            saved = path.join(dir, ".flux-old-" + crypto.randomUUID());
            await fsp.rename(dest, saved);
          }
          try { await fsp.rename(tmp, dest); } catch (e) { if (saved) await fsp.rename(saved, dest); throw e; }
          await syncDir(dir);
          if (saved) await fsp.rm(saved, { recursive: true, force: true });
        } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
        entry.publications[name] = { mode: "copy", source: skill.source, hashes };
        report.changes.push({ agent: id, path: dest, action: "published copy" });
      } catch (e) { report.checks.push(check(`${id}.skill.${name}`, "warn", e.message, "Check the skill's files and vendor directory permissions.", [dest])); }
    }
  }
  return report;
}
async function publishUserSkills(options = {}) {
  return withSetupLock(async () => {
    const state = readState().value;
    const report = await publishUnlocked(state, options); await saveState(state, report); return report;
  });
}
async function refreshInstalledSkills(options = {}) {
  // No vendor executable probes on startup. A setup receipt or an installed
  // managed stock skill proves prior connection; a vendor directory does not.
  const initial = readState();
  const installed = ["claude", "codex"].filter(id => exists(path.join(os.homedir(), id === "claude" ? ".claude" : ".agents", "skills", "flux-connect", MANIFEST)));
  if (!installed.length && !Object.keys(initial.value.agents).length) return { checks: [], changes: [], backups: [], nextSteps: [] };
  return withSetupLock(async () => {
    const report = { checks: [], changes: [], backups: [], nextSteps: [] }, state = readState().value;
    const runtime = options.runtime || fluxPaths.resolveOwnCliCommandsSync();
    const owner = fluxPaths.launcherOwnerSync(runtime.cli);
    if (owner && owner.target !== runtime.target) return report;
    for (const id of new Set([...Object.keys(state.agents), ...installed])) {
      if (state.agents[id]?.connected === false) continue;
      const dir = path.join(os.homedir(), id === "claude" ? ".claude" : ".agents", "skills", "flux-connect");
      const rendered = renderSkill(runtime, id, options.templateDir), status = skillStatus(dir, rendered);
      if (["current", "outdated", "edited"].includes(status.state)) state.agents[id] ||= { files: {}, mcp: null };
      if (status.state !== "outdated") continue;
      for (const [name, text] of Object.entries(rendered.files)) await write(path.join(dir, name), status.files[name] ?? null, text, report);
      await write(path.join(dir, MANIFEST), status.marker.text, json(rendered.manifest), report);
      report.changes.push({ agent: id, path: dir, action: "refreshed template" });
    }
    const published = await publishUnlocked(state, options);
    report.checks.push(...published.checks); report.changes.push(...published.changes); report.backups.push(...published.backups);
    await saveState(state, report); return report;
  });
}

async function probeMcp(runtime) {
  const spec = registration(runtime, "other"), resolved = resolveSpawn(spec.command, [...spec.args, "--toolset", "full"]);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, { cwd: os.homedir(), detached: process.platform !== "win32", windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      env: { ...process.env, ...spec.env, FLUX_NO_MIGRATE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", stderr = "", phase = 0, settled = false, closed = false;
    const stop = force => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => {});
        } else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch { /* process already reaped */ }
    };
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const deliver = () => { if (error) reject(error); else resolve(value); };
      if (closed) { deliver(); return; }
      child.stdin.end(); stop(false);
      // A diagnostic never leaves a hung MCP process behind.
      const kill = setTimeout(() => stop(true), 250); kill.unref();
      child.once("close", () => { clearTimeout(kill); stop(true); deliver(); });
    };
    const timer = setTimeout(() => finish(new Error(`MCP handshake exceeded 10 seconds. ${stderr}`)), 10000);
    const send = (id, method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) + "\n");
    child.on("error", e => finish(e));
    child.on("close", code => { closed = true; finish(new Error(`MCP exited (${code}). ${stderr}`)); });
    child.stdin.on("error", e => finish(e));
    child.stderr.on("data", b => {
      stderr = (stderr + b).slice(-4000);
      if (phase === 0 && stderr.includes("flux MCP server on stdio")) {
        phase = 1; send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "flux-doctor", version: "1" } });
      }
    });
    child.stdout.on("data", b => {
      if (phase === 0) return finish(new Error("Unexpected stdout before the MCP handshake"));
      buffer += b;
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error("MCP response exceeded 4 MiB"));
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.error) throw new Error(JSON.stringify(reply.error));
          if (phase === 1 && reply.id === 1 && reply.result?.protocolVersion) {
            phase = 2; send(null, "notifications/initialized"); send(2, "tools/list");
          } else if (phase === 2 && reply.id === 2) {
            const names = reply.result?.tools?.map(t => t.name) || [];
            if (!names.includes("connect") || names.length < 100) throw new Error(`Full MCP toolset has ${names.length} tools; connect and at least 100 are required`);
            finish(null, names.length);
          } else if (reply.id || phase === 1) throw new Error("Unexpected MCP response");
        } catch (e) { finish(new Error(`Invalid MCP stdout: ${e.message}`)); }
      }
    });
  });
}
async function probeRender(runtime) {
  const { createRequire } = require("node:module");
  const base = path.join(__dirname, "..", "package.json").replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  const modulePath = createRequire(base).resolve("@resvg/resvg-js");
  const program = `const {Resvg}=require(process.argv[1]);process.stdout.write(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>').render().asPng());`;
  const result = await run(runtime.executable, ["-e", program, modulePath], { binary: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  if (result.code !== 0 || !result.stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(result.error || result.stderr || "Renderer did not produce a PNG");
  return result.stdout.length;
}
function newestSource(root) {
  let newest = 0;
  function visit(file) {
    const stat = fs.statSync(file); newest = Math.max(newest, stat.mtimeMs);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  }
  for (const name of ["flux-cli.ts", "flux-mcp.ts", "flux-core", "electron", "resources/agent-skills"]) {
    const file = path.join(root, name); if (exists(file)) visit(file);
  }
  return newest;
}
async function inspectSetup(options = {}) {
  const checks = [], add = (id, status, message, fix, paths) => {
    const result = check(id, status, message, fix, paths);
    checks.push(result);
    options.onCheck?.(result);
  };
  let runtime, agents;
  try { runtime = options.runtime || options.probe?.[0]?.runtime || fluxPaths.resolveOwnCliCommandsSync({ commands: !options.quick }); }
  catch (e) { add("launcher", "fail", e.message, repair); }
  if (runtime) {
    try {
      const body = read(runtime.cli);
      if (!body) throw new Error("Launcher is missing");
      const owner = fluxPaths.launcherOwnerSync(runtime.cli);
      if (!owner) throw new Error("Launcher is not managed by Flux");
      if (!fs.existsSync(owner.target)) throw new Error("Launcher points at a missing install");
      if (owner.target !== runtime.target) throw new Error(`Launcher belongs to ${owner.target}`);
      if (options.quick) {
        add("launcher", "ok", `Launcher belongs to this install (${runtime.build}); execution checked by Run doctor.`, null, [runtime.cli, owner.target]);
      } else {
        const spec = registration(runtime, "other");
        const args = runtime.platform === "win32" ? [...runtime.args, "version"] : ["version"];
        const result = await run(spec.command, args, { env: { ...process.env, ...spec.env, FLUX_NO_MIGRATE: "1" } });
        if (result.code !== 0 || result.error) throw new Error(result.error || result.stderr || "Launcher could not execute version");
        const info = JSON.parse(result.stdout);
        if (String(info.commit).replace(/-dirty$/, "") !== runtime.build.replace(/-dirty$/, "")) throw new Error(`Launcher build ${info.commit} differs from ${runtime.build}`);
        add("launcher", "ok", `Launcher executes this build (${info.commit}).`, null, [runtime.cli]);
        if (!runtime.electron) {
          const version = await run(runtime.executable, ["--version"]);
          if (version.code !== 0 || Number(/^v(\d+)/.exec(version.stdout)?.[1]) < 22 || !/^v\d+/.test(version.stdout)) throw new Error("Source launcher needs Node >=22");
          add("launcher.node", "ok", `Pinned runtime ${version.stdout.trim()}.`, null, [runtime.executable]);
          const bundle = path.join(runtime.target, "dist", "flux-cli.mjs");
          if (exists(bundle)) {
            const stale = newestSource(runtime.target) > fs.statSync(bundle).mtimeMs;
            add("launcher.dist", stale ? "warn" : "ok", stale ? "Source files are newer than the CLI bundle." : "CLI bundle is current.", stale ? "Run npm run build:cli in this checkout." : null, [bundle]);
          } else add("launcher.dist", "ok", "Source launcher uses tsx; no bundle is installed.");
        }
      }
    } catch (e) { add("launcher", "fail", e.message, repair, [runtime.cli]); }
    if (!options.quick) await Promise.all([
      (async () => { try { const count = await probeMcp(runtime); add("mcp", "ok", `MCP initialized cleanly; ${count} full tools include connect.`); } catch (e) { add("mcp", "fail", e.message, "Repair the launcher and run flux mcp --toolset full to inspect stderr."); } })(),
      (async () => { try { const bytes = await probeRender(runtime); add("rendering", "ok", `Built-in SVG rendered to PNG (${bytes} bytes).`); } catch (e) { add("rendering", "fail", e.message, "Reinstall Flux's PNG renderer or repair this checkout's dependencies."); } })(),
    ]);
    try { agents = options.probe || await probeAgents({ runtime, commands: !options.quick }); }
    catch (e) { add("agents", "fail", e.message, "Fix agent-setup.json or the vendor config syntax, then run doctor again."); }
  }
  for (const agent of agents || []) {
    const id = agent.id;
    if (!agent.present && !agent.state) { add(`${id}.detected`, "warn", "Agent is not installed or configured.", `Install ${id}, then run flux connect setup --agents ${id}.`); continue; }
    const current = agent.skill.state === "current";
    add(`${id}.skill`, current ? "ok" : "warn", current ? "Managed skill is current and its hashes match." : `Skill is ${agent.skill.state}; edited and unmanaged files are preserved.`, current ? null : repair, [agent.skillDir]);
    try {
      if (agent.config.error) throw new Error(agent.config.error);
      const expected = registration(runtime, id);
      if (id === "claude") {
        const spec = object(agent.config.text, agent.config.path).mcpServers?.flux;
        if (!equal(spec, expected)) throw new Error(spec ? "MCP registration differs from this install." : "MCP registration is missing.");
      } else {
        const parts = splitCodex(agent.config.text);
        if (parts.tables.length) throw new Error("Unmanaged or duplicate flux MCP tables are present.");
        if (parts.managed !== codexBlock(expected)) throw new Error("MCP block is missing, changed, or has the wrong tool_timeout_sec (expected 3600).");
      }
      const expectedPaths = runtime.platform === "win32" ? [expected.command, ...runtime.args.filter(a => path.win32.isAbsolute(a))] : [expected.command];
      if (expectedPaths.some(p => !fs.existsSync(p))) throw new Error("MCP registration contains a dangling executable or script path.");
      add(`${id}.mcp`, "ok", "User MCP registration points at this install.", null, [agent.config.path]);
    } catch (e) { add(`${id}.mcp`, "fail", e.message, repair, [agent.config.path]); }
    try {
      if (!agent.capabilities.promptHook) { add(`${id}.hook`, "warn", "Prompt-submit hook support was not detected; MCP supplies refresh.", "Update the agent and run setup again."); continue; }
      if (agent.hooks.error) throw new Error(agent.hooks.error);
      const data = object(agent.hooks.text, agent.hooks.path), handlers = (data.hooks?.UserPromptSubmit || []).flatMap(g => g.hooks || []);
      const hooks = handlers.filter(h => h.statusMessage === HOOK_MARKER);
      if (hooks.length !== 1 || !equal(hooks[0], hookEntry(runtime).hooks[0])) throw new Error("Refresh hook is missing, duplicated, or points at another install.");
      add(`${id}.hook`, agent.capabilities.hookEnabled ? "ok" : "warn", agent.capabilities.hookEnabled ? "Managed prompt-submit refresh hook is installed." : "Hook is installed, but hooks are disabled.",
        id === "codex" ? "Review/trust this hook in Codex /hooks; enable features.hooks if disabled." : null, [agent.hooks.path]);
    } catch (e) { add(`${id}.hook`, "fail", e.message, repair, [agent.hooks.path]); }
  }
  try {
    const status = fluxPaths.inspectFluxContextSync();
    add("context.stock", status.ok ? "ok" : "warn", status.ok ? "FluxContext matches the bundled manual." : status.message, status.ok ? null : "Move any differing stock file aside, then open Flux to restore it.", [fluxPaths.fluxContextPathSync()]);
  } catch (e) { add("context.stock", "fail", e.message, "Open Flux to resync the stock manual."); }
  try {
    const file = path.join(fluxPaths.userContextPathSync(), "WHO-AM-I.md"), text = read(file);
    const blank = !text || text === fluxPaths.WHO_AM_I_SEED || !text.replace(/^#.*$|<!--[^]*?-->/gm, "").trim();
    add("context.user", blank ? "warn" : "ok", blank ? "User context is blank; agents know nothing about you yet." : "User context is filled in.", blank ? "Fill in UserContext/WHO-AM-I.md." : null, [file]);
    for (const skill of userSkills()) add(`context.skill.${skill.name}`, skill.error ? "warn" : "ok", skill.error || skill.description,
      skill.error ? "Fix name/description in the skill frontmatter." : null, [skill.source]);
    for (const agent of agents || []) {
      if (!agent.state || agent.state.connected === false) continue;
      for (const skill of userSkills().filter(s => !s.error)) {
        const dest = path.join(path.dirname(agent.skillDir), skill.name), record = agent.state.publications?.[skill.name];
        const valid = record && exists(dest) && record.source === skill.source && ownedPublication(dest, record);
        add(`${agent.id}.published.${skill.name}`, valid ? "ok" : "warn", valid ? "User skill is published." : "User skill is missing, changed, or its name is taken.", valid ? null : repair, [dest]);
      }
    }
  } catch (e) { add("context.user", "fail", e.message, "Check UserContext permissions and skill frontmatter."); }
  try {
    const file = path.join(fluxPaths.userDataDir(), "projects.json"), text = read(file);
    if (!text) add("projects", "ok", "No project history yet.", null, [file]);
    else {
      const data = object(text, file);
      if (data.v !== 1 || !Array.isArray(data.projects) || data.projects.some(p => typeof p.root !== "string")) throw new Error("projects.json has an invalid schema");
      const missing = data.projects.filter(p => !fs.existsSync(path.join(p.root, "project.json"))).map(p => p.root);
      add("projects", missing.length ? "warn" : "ok", missing.length ? `${missing.length} recorded project roots are missing.` : `${data.projects.length} recorded project roots exist.`, missing.length ? "Reopen moved projects in Flux; project history will refresh." : null, [file, ...missing]);
    }
  } catch (e) { add("projects", "fail", e.message, "Restore projects.json from a backup or move it aside to rebuild project history."); }
  return checks.sort((a, b) => a.id.localeCompare(b.id));
}

// The monitor uses only file checks on refresh. Execution checks remain explicit.
const probeChecks = (options = {}) => inspectSetup({ ...options, quick: true });
const doctor = (options = {}) => inspectSetup({ ...options, quick: false });

module.exports = { probeChecks, probeAgents, planSetup, applySetup, planRemove, applyRemove, publishUserSkills, refreshInstalledSkills,
  doctor, renderSkill, validateSkill, registration, hookEntry, splitCodex, HOOK_MARKER };
