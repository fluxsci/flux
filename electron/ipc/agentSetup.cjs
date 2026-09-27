"use strict";
// Main owns every plan. Only sender-bound, expiring confirmation tokens return
// from the renderer; arbitrary renderer file actions are never accepted.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const setupDefault = require('../agentSetup.cjs');
const pathsDefault = require('../fluxPaths.cjs');

function createAgentSetupFamily({ shell, rootForSender, bridgeForSender, setup = setupDefault, paths = pathsDefault, knownProjects = () => require('../projectsRegistry.cjs').listKnownProjects() }) {
  let cache = { checkedAt: null, agents: [], checks: [], launcher: '', owner: null, version: '', skillsPath: '' };
  let probe = [], refreshing = null, diagnosing = null, modifying = false;
  const subscribers = new Set(), plans = new Map();
  const versions = new Map(), capabilities = new Map(), secrets = new Set();
  let diagnostic = [], diagnosticInstall = '';
  const installKey = () => {
    const agent = probe[0], runtime = agent?.runtime;
    return JSON.stringify([runtime?.cli, runtime?.target, runtime?.build, agent?.launcher?.text, agent?.owner, agent?.ownerAlive]);
  };
  const stamp = () => new Date().toISOString();
  const skillsPath = () => path.join(paths.userContextPathSync(), 'Skills');
  function watch(sender) {
    if (subscribers.has(sender)) return;
    subscribers.add(sender);
    sender.once('destroyed', () => { subscribers.delete(sender); plans.delete(sender.id); });
  }
  function push(channel, data) {
    for (const sender of subscribers) if (!sender.isDestroyed()) {
      if (channel === 'status') sender.send("agentsetup:changed", data);
      else sender.send("agentsetup:progress", data);
    }
  }
  // Errors may quote malformed JSON/TOML, or a vendor may echo its input. Strip
  // exact config values before status, progress, reports or clipboard diagnostics.
  function safe(checks) {
    const collect = value => { if (typeof value === 'string' && value.length >= 3) { secrets.add(value); secrets.add(JSON.stringify(value).slice(1, -1)); } else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
    for (const agent of probe) for (const source of [agent.config?.text, agent.hooks?.text]) if (source) {
      try { collect(JSON.parse(source)); } catch { for (const m of source.matchAll(/["']([^"'\r\n]{3,})["']/g)) secrets.add(m[1]); }
    }
    const redact = value => {
      let text = String(value);
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
      return text;
    };
    return checks.map(c => ({ ...c, message: redact(c.message), ...(c.fix ? { fix: redact(c.fix) } : {}) }));
  }
  async function refresh() {
    if (refreshing) return refreshing;
    if (modifying) return cache;
    refreshing = (async () => {
      try {
        probe = await setup.probeAgents({ commands: false });
        if (diagnosticInstall !== installKey()) diagnostic = [];
        for (const agent of probe) {
          const remembered = capabilities.get(agent.binary);
          if (remembered && remembered.config === agent.config.text) agent.capabilities = remembered.value;
        }
        const checks = await setup.probeChecks({ probe });
        const runtime = probe[0]?.runtime;
        const now = stamp();
        cache = { checkedAt: now, agents: probe.map(a => ({ id: a.id, present: a.present, connected: !!a.state && a.state.connected !== false,
          binary: a.binary, version: versions.get(a.id) || null, skillDir: a.skillDir })),
          checks: safe(checks).map(c => ({ ...c, checkedAt: now })), launcher: runtime?.cli || '', owner: probe[0]?.owner?.target || null,
          version: runtime?.build || '', skillsPath: skillsPath() };
        // Execution checks are deliberately absent until the user runs doctor.
        // Preserve that last evidence across cheap refreshes, never run processes on a timer.
        for (const id of ['mcp', 'rendering']) if (!diagnostic.some(c => c.id === id)) cache.checks.push({ id, status: 'warn', pending: true, message: 'Run doctor to check this part.', fix: 'Run doctor.' });
        for (const check of diagnostic) if (['mcp', 'rendering', 'launcher', 'launcher.node', 'launcher.dist'].includes(check.id)) {
          if (check.id.startsWith('launcher') && cache.checks.some(c => c.id === 'launcher' && c.status === 'fail')) continue;
          cache.checks = cache.checks.filter(c => c.id !== check.id); cache.checks.push(check);
        }
        for (const agent of cache.agents) if (!cache.checks.some(c => c.id.startsWith(`${agent.id}.published.`))) cache.checks.push({ id: `${agent.id}.published`, status: 'ok', message: 'No user skills awaiting publication.', checkedAt: now });
      } catch (e) { cache = { ...cache, checkedAt: stamp(), checks: safe([{ id: 'status', status: 'fail', message: e.message, fix: 'Run doctor for details.' }]) }; }
      push('status', cache);
      return cache;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function projectStatus(e) {
    const root = rootForSender(e);
    if (!root) return null;
    const records = await knownProjects().catch(() => []);
    return { root, bridge: !!bridgeForSender(e), lastConnected: records.find(p => p.root === root)?.lastConnected || null };
  }
  async function mutate(e, request, remove) {
    if (!request || typeof request !== 'object') throw new Error('Invalid setup request');
    if (request.token) {
      const held = plans.get(e.sender.id); plans.delete(e.sender.id);
      if (!held || held.token !== request.token || held.expires < Date.now() || request.confirm !== true || held.remove !== remove) throw new Error('Setup confirmation expired. Review a new plan.');
      return apply(held.plan, remove);
    }
    if (!Array.isArray(request.agents) || !request.agents.length && !(request.useThisInstall && !remove) || request.agents.some(id => !['claude', 'codex'].includes(id))) throw new Error('Choose Claude Code or Codex');
    probe = await setup.probeAgents();
    for (const agent of probe) { if (agent.version) versions.set(agent.id, agent.version); if (agent.binary) capabilities.set(agent.binary, { config: agent.config.text, value: agent.capabilities }); }
    safe([]); // retain config values for redaction even after apply changes the snapshot
    const plan = remove ? setup.planRemove({ probe, agents: request.agents }) : setup.planSetup({ probe, agents: request.agents, useThisInstall: request.useThisInstall === true });
    const replacements = plan.actions.filter(a => a.confirmation || remove || a.before !== null && a.before !== a.after && (a.kind === 'claude-mcp' || a.role === 'mcp' || a.role === 'hook'));
    if (request.useThisInstall) plan.nextSteps.unshift(`Agent launcher owner: ${probe[0]?.owner?.target || "none"} → ${probe[0]?.runtime.target}`);
    if (replacements.length || request.useThisInstall || plan.checks.some(c => c.status === "fail")) {
      const token = randomUUID();
      plans.set(e.sender.id, { token, plan, remove, expires: Date.now() + 5 * 60_000 });
      return { plan: { token, kind: plan.kind, agents: plan.agents, checks: safe(plan.checks), nextSteps: plan.nextSteps,
        replacements: replacements.map(a => ({ path: a.path, before: a.before, after: a.after })) } };
    }
    return apply(plan, remove);
  }
  async function apply(plan, remove) {
    try {
      const report = await (remove ? setup.applyRemove(plan, { yes: true }) : setup.applySetup(plan, { yes: true }));
      return { applied: true, checks: safe(report.checks), nextSteps: report.nextSteps };
    } finally { diagnostic = []; }
  }
  async function skills(request = { action: 'list' }) {
    const base = skillsPath();
    const name = request.name;
    if (name !== undefined && (typeof name !== 'string' || name !== name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || name === 'flux-connect' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name))) throw new Error('Use a short lowercase name with hyphens, such as stats-conventions.');
    if (!['list', 'new', 'reveal', 'publish'].includes(request.action)) throw new Error('Unknown skills action');
    let created, checks;
    if (request.action === 'new') {
      if (!name) throw new Error('A skill needs a name');
      await fs.mkdir(base, { recursive: true });
      const dir = path.join(base, name);
      await fs.mkdir(dir); // exclusive: never overwrite an authored skill
      created = path.join(dir, 'SKILL.md');
      try {
        await fs.writeFile(created, `---\nname: ${name}\ndescription: Use ${name.replace(/-/g, ' ')} when the user asks for this procedure.\n---\n\n# ${name.replace(/-/g, ' ')}\n\nDescribe when to use this skill, the steps to follow, and how to check the result.\n`, { flag: 'wx' });
      } catch (e) { await fs.rmdir(dir).catch(() => {}); throw e; }
      const error = await shell.openPath(created);
      if (error) throw new Error(`Skill created at ${created}, but the editor could not open: ${error}`);
      try { checks = safe((await setup.publishUserSkills()).checks); }
      catch (e) { checks = safe([{ id: 'skills.publish', status: 'fail', message: e.message, fix: 'Re-publish after fixing the reported problem.' }]); }
    }
    if (request.action === 'publish') checks = safe((await setup.publishUserSkills()).checks);
    if (request.action === 'reveal') {
      const target = name ? path.join(base, name, 'SKILL.md') : base;
      await fs.access(target); shell.showItemInFolder(target);
    }
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const found = [];
    for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(base, entry.name, 'SKILL.md');
      try { found.push({ ...setup.validateSkill(await fs.readFile(file, 'utf8'), entry.name), path: file }); }
      catch (e) { found.push({ name: entry.name, path: file, error: e.message }); }
    }
    if (request.action === 'new' || request.action === 'publish') await refresh();
    return { path: base, skills: found, ...(created ? { created } : {}), ...(checks ? { checks } : {}) };
  }
  async function mutation(work) {
    if (modifying || diagnosing) throw new Error('Another agent setup or doctor is running. Try again when it finishes.');
    if (refreshing) await refreshing;
    if (modifying || diagnosing) throw new Error('Another agent setup or doctor is running. Try again when it finishes.');
    modifying = true;
    try { return await work(); }
    finally { modifying = false; await refresh(); }
  }
  async function guarded(work) {
    try { return await work(); } catch (e) { throw new Error(safe([{ id: 'operation', message: e.message || String(e) }])[0].message); }
  }
  function registerHandlers(ipc) {
    ipc.handle("agentsetup:status", async (e, options) => {
      watch(e.sender);
      if (options?.refresh || !cache.checkedAt) void refresh();
      const project = await projectStatus(e);
      return { ...cache, project };
    });
    ipc.handle("agentsetup:doctor", async e => {
      watch(e.sender);
      if (modifying) throw new Error('Agent setup is running. Run doctor when it finishes.');
      if (!diagnosing) diagnosing = (async () => {
        if (refreshing) await refreshing;
        probe = await setup.probeAgents();
        for (const agent of probe) { if (agent.version) versions.set(agent.id, agent.version); if (agent.binary) capabilities.set(agent.binary, { config: agent.config.text, value: agent.capabilities }); }
        const checks = await setup.doctor({ probe, onCheck: check => push('progress', { check: safe([check])[0], checkedAt: stamp() }) });
        diagnostic = safe(checks).map(c => ({ ...c, checkedAt: stamp() }));
        diagnosticInstall = installKey();
        await refresh();
        return { checks: safe(checks) };
      })().finally(() => { diagnosing = null; });
      return guarded(() => diagnosing);
    });
    ipc.handle("agentsetup:apply", (e, request) => { watch(e.sender); return guarded(() => mutation(() => mutate(e, request, false))); });
    ipc.handle("agentsetup:remove", (e, request) => { watch(e.sender); return guarded(() => mutation(() => mutate(e, request, true))); });
    ipc.handle("agentsetup:skills", (_e, request) => guarded(() => ['new', 'publish'].includes(request?.action) ? mutation(() => skills(request)) : skills(request)));
  }
  return { registerHandlers };
}
module.exports = { createAgentSetupFamily };
