import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { agentFixture, tree } from './lib/agentSetupFixture';
import * as realSetup from '../electron/agentSetup.cjs';
import { readProjectComments } from '../src/shell/agent/monitorComments';
import { harness } from './lib/harness.mjs';
import { monitorColor, agentChecks, checkLabel, emptyMonitorStatus, type AgentMonitorStatus } from '../src/lib/project/agentMonitor';
import { makeReleaseSession, makeNote, makeClaim, foldAnnotations, serializeEvent, parseLedger } from '../src/lib/project/annotations';
const require = createRequire(import.meta.url);
const { createAgentSetupFamily } = require('../electron/ipc/agentSetup.cjs');
const h = harness('verify-ai-monitor');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-monitor-'));
try {
  const status: AgentMonitorStatus = { ...emptyMonitorStatus(), checkedAt: '2026-09-27T00:00:00Z', agents: [{ id: 'claude', present: true, connected: true, version: '1', binary: '/bin/claude', skillDir: '/skills/flux-connect' }], checks: [{ id: 'launcher', status: 'ok', message: 'Ready' }] };
  h.eq(monitorColor(status), 'green', 'one healthy connected agent is green');
  h.eq(monitorColor({ ...status, checks: [{ id: 'mcp', status: 'fail', message: 'Broken' }] }), 'red', 'broken shared MCP is red');
  h.eq(monitorColor({ ...status, checks: [{ id: 'claude.mcp', status: 'fail', message: 'Broken' }] }), 'red', 'broken connected registration is red');
  h.eq(monitorColor({ ...status, checks: [{ id: 'context.user', status: 'warn', message: 'Blank' }] }), 'amber', 'blank user context is amber');
  h.eq(monitorColor({ ...status, agents: [...status.agents, { ...status.agents[0], id: 'codex', connected: false }] }), 'amber', 'detected unconnected Codex needs attention');
  h.eq(monitorColor({ ...status, agents: [] }), 'amber', 'no connection nags before dismissal');
  h.eq(monitorColor({ ...status, agents: [] }, true), 'green', 'dismissal removes only connection nag');
  h.eq(monitorColor({ ...status, agents: [], checks: [{ id: 'launcher', status: 'fail', message: 'Missing' }] }, true), 'red', 'dismissal cannot conceal failures');
  h.eq(monitorColor({ ...status, checks: [{ id: 'codex.mcp', status: 'fail', message: 'Absent' }] }), 'green', 'absent unconnected vendor does not break healthy integration');
  h.eq(monitorColor(emptyMonitorStatus()), 'amber', 'uncached status stays unknown');
  const rows = agentChecks(status, 'claude');
  h.eq(rows.map(r => r.id), ['claude.skill', 'claude.mcp', 'claude.responds', 'claude.published', 'claude.hook'], 'agent checklist covers the five required parts');
  h.ok(rows.every(r => r.pending), 'unchecked parts do not claim success');
  h.eq(checkLabel('codex.published.stats'), 'Your skill: stats', 'publication row is human readable');
  const note = makeNote('work', { surface: 'paper' }, 'human');
  const session = { id: 's', name: 'heron' };
  const events = [note, makeClaim(note.id, session, 'agent'), makeReleaseSession(session, 'human')];
  const folded = foldAnnotations(parseLedger(events.map(serializeEvent).join('')));
  h.ok(folded.stoppedSessions.has('s') && !folded.byId.get(note.id)?.claim, 'Stop watching round-trips the shared release-session builder and releases claims');

  const handlers = new Map();
  class Sender extends EventEmitter { id: number; pushed: { channel: string; data: any }[] = []; constructor(id: number) { super(); this.id = id; } isDestroyed() { return false; } send(channel: string, data: any) { this.pushed.push({ channel, data }); } }
  const sender = new Sender(1), second = new Sender(2), e = { sender };
  let applied = 0, published = 0, freshDoctors = 0, quickDoctors = 0;
  let confirmation = true, launcherBroken = false, publishBroken = false;
  const config = '{"token":"credential-never-display","mcpServers":{"flux":{"command":"old"}}}';
  const after = '{"token":"credential-never-display","mcpServers":{"flux":{"command":"new"}}}';
  const agent = { id: 'codex', present: true, binary: '/bin/codex', version: '0.1', skillDir: '/skills/flux-connect', config: { text: config }, hooks: { text: '{}' }, capabilities: { promptHook: true }, state: { connected: true }, runtime: { cli: '/bin/flux', build: 'test' }, owner: { target: '/test/install' } };
  const setup = {
    probeAgents: async () => [agent],
    probeChecks: async (opts: any) => setup.doctor({ ...opts, quick: true }),
    doctor: async (opts: any) => { if (opts.quick) quickDoctors++; else freshDoctors++; const checks = [{ id: 'launcher', status: launcherBroken ? 'fail' : 'ok', message: launcherBroken ? 'Missing launcher' : 'Ready' }, { id: 'codex.mcp', status: 'fail', message: 'Bad credential-never-display', fix: 'Replace credential-never-display' }, ...(!opts.quick ? [{ id: 'mcp', status: 'ok', message: '123 full tools; connect available' }] : [])]; checks.forEach(c => opts.onCheck?.(c)); return checks; },
    planSetup: ({ agents }: any) => ({ kind: 'setup', agents, actions: [{ path: '/config', before: confirmation ? config : null, after, confirmation }], checks: [], nextSteps: ['Restart session'] }),
    planRemove: ({ agents }: any) => ({ kind: 'remove', agents, actions: [{ path: '/config', before: config, after: null }], checks: [], nextSteps: [] }),
    applySetup: async () => { applied++; return { checks: [], nextSteps: [] }; },
    applyRemove: async () => { applied--; return { checks: [], nextSteps: [] }; },
    publishUserSkills: async () => { published++; if (publishBroken) throw new Error('Publication unavailable'); return { checks: [] }; },
    validateSkill: (text: string, name: string) => ({ name, description: text.includes('description:') ? 'valid' : '', ...(!text.includes('name: ' + name) ? { error: 'Invalid' } : {}) }),
  };
  const opened: string[] = [], revealed: string[] = [];
  createAgentSetupFamily({ setup, paths: { userContextPathSync: () => tmp }, rootForSender: () => '/project', bridgeForSender: () => true,
    knownProjects: async () => [{ root: '/project', lastConnected: '2026-09-27T00:00:00Z' }], shell: { openPath: async (file: string) => { opened.push(file); return ''; }, showItemInFolder: (file: string) => revealed.push(file) },
  }).registerHandlers({ handle: (name: string, call: any) => handlers.set(name, call) });
  const call = (name: string, request?: any, event = e) => handlers.get('agentsetup:' + name)(event, request);
  await call('status', { refresh: true });
  for (let n = 0; n < 50 && !sender.pushed.length; n++) await new Promise(r => setTimeout(r, 1)); // await async cache publication
  const cached = await call('status');
  h.ok(cached.checkedAt && cached.project.bridge && cached.project.lastConnected, 'cached status includes only this sender project bridge and connection');
  h.ok(quickDoctors === 1 && freshDoctors === 0 && applied === 0 && published === 0, 'startup probe never runs execution checks or writes vendor config');
  h.ok(!JSON.stringify(cached).includes('credential-never-display') && !('config' in cached.agents[0]), 'status omits raw configs and redacts quoted config values');
  h.ok(sender.pushed.some(p => p.channel === 'agentsetup:changed'), 'fresh probe publishes row updates');
  const diagnostic = await call('doctor');
  h.ok(freshDoctors === 1 && diagnostic.checks.length === 3, 'explicit doctor returns the doctor JSON shape');
  h.ok(sender.pushed.filter(p => p.channel === 'agentsetup:progress').length === 3, 'doctor emits per-row progress');
  h.ok(!JSON.stringify(sender.pushed).includes('credential-never-display'), 'progress and status pushes never leak config values');
  const refreshed = async () => {
    const count = sender.pushed.length;
    await call('status', { refresh: true });
    for (let n = 0; n < 50 && sender.pushed.length === count; n++) await new Promise(r => setTimeout(r, 1));
    return call('status');
  };
  h.ok((await refreshed()).checks.some((c: any) => c.id === 'mcp' && c.status === 'ok'), 'cheap refresh retains explicit doctor evidence for the same install');
  launcherBroken = true;
  h.ok((await refreshed()).checks.some((c: any) => c.id === 'launcher' && c.status === 'fail'), 'fresh launcher failure overrides an old successful doctor');
  launcherBroken = false; agent.runtime.build = 'new-build';
  h.ok((await refreshed()).checks.some((c: any) => c.id === 'mcp' && c.pending), 'changing the install invalidates execution evidence without running doctor');
  const planned = await call('apply', { agents: ['codex'] });
  h.eq(planned.plan.replacements, [{ path: '/config', before: config, after }], 'replacement confirmation alone carries the exact before/after diff');
  h.eq(applied, 0, 'replacement does not write before confirmation');
  let rejected = false;
  try { await call('apply', { token: planned.plan.token, confirm: true }, { sender: second }); } catch { rejected = true; }
  h.ok(rejected, 'another window cannot use a confirmation token');
  await call('apply', { token: planned.plan.token, confirm: true });
  h.eq(applied, 1, 'the owning window can apply its reviewed plan');
  rejected = false; try { await call('apply', { token: planned.plan.token, confirm: true }); } catch { rejected = true; }
  h.ok(rejected, 'confirmation is single-use');
  confirmation = false;
  await call('apply', { agents: ['codex'] });
  h.eq(applied, 2, 'explicit Connect applies a fresh plan in one click');
  const removing = await call('remove', { agents: ['codex'] });
  h.eq(applied, 2, 'disconnect shows removal diff before writing');
  await call('remove', { token: removing.plan.token, confirm: true });
  h.eq(applied, 1, 'disconnect routes to shared applyRemove');
  rejected = false; try { await call('apply', { agents: ['arbitrary'], actions: [{ path: '/etc/passwd' }] }); } catch { rejected = true; }
  h.ok(rejected, 'renderer cannot supply arbitrary file actions or agents');
  const skill = await call('skills', { action: 'new', name: 'stats-conventions' });
  h.ok((await fs.readFile(skill.created, 'utf8')).includes('name: stats-conventions') && skill.skills[0].name === 'stats-conventions', 'New skill creates a valid folder template and lists it');
  h.eq(opened, [skill.created], 'New skill opens SKILL.md in the OS editor');
  h.eq(published, 1, 'new skills publish through the shared setup service');
  await call('skills', { action: 'reveal', name: 'stats-conventions' });
  h.eq(revealed, [skill.created], 'Reveal uses the owned skill path');
  publishBroken = true;
  const unpublished = await call('skills', { action: 'new', name: 'figure-rules' });
  h.ok(opened.includes(unpublished.created) && unpublished.checks.some((c: any) => c.status === 'fail'), 'publication failure still opens the authored skill and reports repair guidance');
  publishBroken = false;
  for (const name of ['../escape', 'flux-connect', 'CON', 'con', 'stats\n', 'stats-conventions']) {
    rejected = false; try { await call('skills', { action: 'new', name }); } catch { rejected = true; }
    h.ok(rejected, `refuses unsafe, reserved or existing skill: ${name}`);
  }

  const fixture = await agentFixture();
  try {
    const before = await tree(fixture.home), start = performance.now();
    const snapshot = await realSetup.probeAgents({ runtime: fixture.runtime, commands: false });
    const checks = await realSetup.probeChecks({ runtime: fixture.runtime, probe: snapshot });
    const elapsed = performance.now() - start;
    h.ok(elapsed <= 1000, `file-only probe updates within 1s (${Math.round(elapsed)} ms)`);
    h.ok(checks.some(c => c.id === 'launcher') && !checks.some(c => c.id === 'mcp' || c.id === 'rendering'), 'real file-only inspector leaves execution checks to doctor');
    h.eq(await tree(fixture.home), before, 'real fast probe writes no home files');
    h.ok(!await fs.stat(process.env.FAKE_AGENT_LOG!).then(() => true, () => false), 'real fast probe never launches a vendor process');
  } finally { await fixture.cleanup(); }

  const thread = (id: string) => ({ id, anchor: { start: 0, end: 1, quote: 'x', prefix: '', suffix: '' }, resolved: false, messages: [{ author: 'You', body: id, createdAt: '2026-09-27T00:00:00Z' }] });
  const sidecars = new Map([
    ['/project/paper/comments.json', JSON.stringify({ threads: [thread('legacy')] })],
    ['/project/paper/main.comments.json', JSON.stringify({ threads: [thread('legacy'), thread('promoted')] })],
  ]);
  const oldWindow = globalThis.window;
  Object.assign(globalThis, { window: { fig: { exists: async (file: string) => sidecars.has(file), readText: async (file: string) => sidecars.get(file) } } });
  try {
    const project = { root: '/project', manifest: { manuscript: { path: 'paper/main.qmd' } } } as any;
    const comments = await readProjectComments(project, [{ path: 'paper/main.qmd' }]);
    h.eq(comments.map(c => c.id), ['legacy', 'promoted'], 'monitor reads both historical main sidecars and deduplicates threads');
    sidecars.set('/project/paper/comments.json', 'broken');
    let refused = false; try { await readProjectComments(project, [{ path: 'paper/main.qmd' }]); } catch { refused = true; }
    h.ok(refused, 'unreadable comments are reported, never counted as an empty inbox');
  } finally { Object.assign(globalThis, { window: oldWindow }); }
} catch (e) { h.fail(e instanceof Error ? e.stack || e.message : String(e)); }
await h.done(() => fs.rm(tmp, { recursive: true, force: true }));
