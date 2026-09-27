// W6a: monitor behavior over a memBridge; native utility/preload acceptance is separate.
import { launch, gotoApp, APP_URL, realErrors, waitFor, shot } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-ai-monitor-gui');
const { browser, page } = await launch({ width: 1400, height: 1050 });
const clickText = (scope, text) => page.evaluate(({ scope, text }) => {
  const button = [...document.querySelectorAll(scope + ' button')].find(b => b.textContent.trim() === text);
  if (!button) throw Error('Missing button: ' + text); button.click();
}, { scope, text });
async function install() {
  await page.evaluate(async () => {
    const { createMemBridge } = await import('/src/lib/project/memBridge.ts');
    window.fig ??= createMemBridge();
    const fb = window.fig;
    const listeners = new Set(), progress = new Set();
    window.__aiCalls = []; window.__aiOpened = []; window.__aiCopied = '';
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__aiCopied = text; } });
    const status = { checkedAt: new Date().toISOString(), agents: ['claude', 'codex'].map(id => ({ id, present: true, connected: false, binary: '/fixture/bin/' + id, version: '1.2.3', skillDir: '/fixture/' + id + '/flux-connect' })),
      checks: [{ id: 'launcher', status: 'ok', message: 'Launcher ready', paths: ['/fixture/bin/flux'] }, { id: 'context.stock', status: 'ok', message: 'Manual synced' }, { id: 'context.user', status: 'ok', message: 'Filled in' }, { id: 'mcp', status: 'ok', message: '124 full tools include connect; registration uses core' }, { id: 'rendering', status: 'ok', message: 'Rendered PNG' }],
      launcher: '/fixture/bin/flux', version: 'fixture-build', owner: '/fixture/install', skillsPath: '/fixture/UserContext/Skills', project: null };
    window.__aiStatus = status;
    window.__aiPublish = async patch => {
      Object.assign(status, patch); for (const f of listeners) f(structuredClone(status));
      await (await import('/src/shell/agent/aiMonitorState.ts')).refreshAI();
    };
    fb.agentSetupStatus = async options => { window.__aiCalls.push(['status', options]); return structuredClone(status); };
    fb.onAgentSetupChanged = cb => { listeners.add(cb); return () => listeners.delete(cb); };
    fb.onAgentSetupProgress = cb => { progress.add(cb); return () => progress.delete(cb); };
    fb.agentSetupDoctor = async () => {
      window.__aiCalls.push(['doctor']);
      for (const check of status.checks) for (const fn of progress) fn({ check, checkedAt: status.checkedAt });
      return { checks: status.checks };
    };
    let pendingAgent;
    fb.agentSetupApply = async request => {
      window.__aiCalls.push(['apply', request]);
      if (window.__aiReplace && !request.token) {
        pendingAgent = request.agents[0];
        return { plan: { token: 'reviewed-plan', kind: 'setup', agents: request.agents, checks: [], nextSteps: [], replacements: [{ path: '/fixture/codex/config.toml', before: 'command = "old-flux"', after: 'command = "new-flux"' }] } };
      }
      status.agents.find(a => a.id === (request.agents?.[0] ?? pendingAgent)).connected = true;
      for (const cb of listeners) cb(structuredClone(status));
      return { applied: true, checks: [], nextSteps: ['Restart the agent session.'] };
    };
    fb.agentSetupRemove = async request => { window.__aiCalls.push(['remove', request]); return { plan: { token: 'remove', kind: 'remove', agents: request.agents, checks: [], nextSteps: [], replacements: [{ path: '/fixture/config', before: 'Flux entry', after: null }] } }; };
    const skillList = [];
    fb.agentSetupSkills = async request => {
      window.__aiCalls.push(['skills', request]);
      if (request.action === 'new') {
        const file = status.skillsPath + '/' + request.name + '/SKILL.md';
        await fb.writeText(file, '---\nname: ' + request.name + '\ndescription: A procedure\n---\n');
        skillList.push({ name: request.name, path: file, description: 'A procedure' }); window.__aiOpened.push(file);
        return { path: status.skillsPath, skills: [...skillList], created: file };
      }
      return { path: status.skillsPath, skills: [...skillList] };
    };
    fb.openPath = async path => { window.__aiOpened.push(path); };
    const state = await import('/src/shell/agent/aiMonitorState.ts');
    window.__stopAI = state.startAIMonitor(); await state.refreshAI();
  });
}
try {
  await gotoApp(page, { url: APP_URL }); await install();
  await waitFor(page, () => document.querySelector('.ai-indicator')?.dataset.status === 'amber', null, { label: 'unconnected amber' });
  h.ok(!!await page.$('.ai-home'), 'first-run Home card is visible');
  h.ok((await page.$$eval('.ai-home button', bs => bs.map(b => b.textContent))).includes('Connect Claude Code'), 'Home offers detected-agent Connect');
  await page.click('[aria-label="Dismiss Connect an AI agent"]');
  h.ok(!await page.$('.ai-home') && await page.evaluate(() => localStorage.getItem('flux.ai.dismissed') === 'true'), 'dismissal persists');
  await page.evaluate(() => window.__aiPublish({ agents: window.__aiStatus.agents.map(a => ({ ...a, connected: true })) }));
  h.eq(await page.$eval('.ai-indicator', e => e.dataset.status), 'green', 'healthy connected agents show green');
  await page.evaluate(() => window.__aiPublish({ checks: [...window.__aiStatus.checks, { id: 'codex.mcp', status: 'fail', message: 'Injected full error\nMCP process exited 7', paths: ['/fixture/codex/config.toml'], fix: 'Repair this registration.' }] }));
  h.eq(await page.$eval('.ai-indicator', e => e.dataset.status), 'red', 'broken connected registration shows red');
  const paint = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now(); document.querySelector('[aria-label="AI status"]').click();
    requestAnimationFrame(() => resolve({ ms: performance.now() - start, painted: !!document.querySelector('.ai-panel') }));
  }));
  h.ok(paint.painted && paint.ms <= 100, `cached panel paints within 100 ms (${Math.round(paint.ms)} ms)`);
  await page.waitForSelector('.ai-panel');
  h.ok(await page.$$eval('.ai-panel section[aria-label]', els => ['Agents','Bundle','Sessions','This project','Skills'].every(s => els.some(e => e.getAttribute('aria-label') === s))), 'all four sections and nested Skills render');
  await page.click('[data-check="codex.mcp"] summary');
  h.ok(await page.$eval('[data-check="codex.mcp"]', e => e.textContent.includes('MCP process exited 7') && e.textContent.includes('/fixture/codex/config.toml')), 'expanded row shows exact path and full injected error');
  await page.evaluate(() => window.__aiReplace = true);
  await clickText('[data-agent="codex"]', 'Repair'); await page.waitForSelector('[aria-label="Confirm agent setup"]');
  h.eq(await page.$$eval('.confirmation pre', es => es.map(e => e.textContent)), ['command = "old-flux"', 'command = "new-flux"'], 'replacement dialog shows exact before/after');
  h.ok(!await page.evaluate(() => window.__aiCalls.some(([name, req]) => name === 'apply' && req.token)), 'no confirmation apply has occurred');
  await clickText('.confirmation', 'Confirm changes');
  await waitFor(page, () => !document.querySelector('.confirmation'), null, { label: 'confirmation applied' });
  h.ok(await page.evaluate(() => window.__aiCalls.some(([name, req]) => name === 'apply' && req.token === 'reviewed-plan' && req.confirm)), 'Confirm submits the main-owned token');
  await clickText('.skills', 'New skill…'); await page.type('.skills input', 'stats-conventions'); await clickText('.skills', 'Create and open');
  await waitFor(page, () => document.querySelector('.skills')?.textContent.includes('No user skills yet.') === false, null, { label: 'new skill listed' });
  h.ok(await page.evaluate(() => window.__aiOpened.some(p => p.endsWith('/stats-conventions/SKILL.md'))), 'New skill opens SKILL.md through the bridge');
  await clickText('.skills', 'Reveal in folder');
  h.ok(await page.evaluate(() => window.__aiCalls.some(([name, req]) => name === 'skills' && req.action === 'reveal')), 'Reveal in folder invokes skills reveal');
  await clickText('.tools', 'Copy diagnostics');
  await waitFor(page, () => window.__aiCopied.includes('"checks"'), null, { label: 'doctor clipboard' });
  h.ok(await page.evaluate(() => Array.isArray(JSON.parse(window.__aiCopied).checks)), 'Copy diagnostics is doctor JSON');
  await shot(page, 'ai-monitor');
  // The mounted subtree, including native event listeners, survives pin/dock.
  const popupReady = new Promise(resolve => page.once('popup', resolve));
  await page.click('.ai-panel .pin'); const popup = await popupReady; await popup.waitForSelector('.ai-panel');
  await popup.click('.ai-panel .pin'); await page.bringToFront(); await page.waitForSelector('.ai-panel');
  h.ok(await page.$eval('.skills', e => e.textContent.includes('stats-conventions')), 'pin/dock retains state and controls work in the inert window');
  await page.click('[aria-label="Close AI status"]');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod); await page.keyboard.press('KeyK'); await page.keyboard.up(mod); await page.waitForSelector('.cp input');
  await page.type('.cp input', 'New agent skill'); await page.keyboard.press('Enter'); await page.waitForSelector('.skills input');
  h.ok(!!await page.$('.skills input'), 'Home command palette opens the New agent skill name prompt');
  await page.click('[aria-label="Close AI status"]');
  await page.evaluate(() => window.__stopAI?.());
  await gotoApp(page, { url: APP_URL }); await install();
  h.ok(!await page.$('.ai-home'), 'Home dismissal survives a fresh app document');
  await page.evaluate(() => window.__stopAI?.());
  await gotoApp(page, { url: new URL('?fixture=demo', APP_URL).href }); await install();
  await page.evaluate(async () => {
    const F = window.__flux, root = F.get(F.shell.currentProject).path;
    window.__aiStatus.project = { root, bridge: true, lastConnected: new Date().toISOString() };
    const session = { v: 1, id: 'heron-session', name: 'heron', display: 'claude · cli · heron', product: 'claude', surface: 'cli', client: 'claude', pid: 1, host: 'fixture', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), watching: true, live: true };
    await window.fig.writeText(root + '/.meta/live/sessions/heron-session.json', JSON.stringify(session));
    window.fig._emitFsChange({ subsystem: 'presence', path: root + '/.meta/live/sessions/heron-session.json' });
    await window.__aiPublish({});
  });
  await page.click('[aria-label="AI status"]');
  await page.waitForSelector('[data-session="heron-session"]'); await page.click('[data-session="heron-session"] summary'); await clickText('[data-session="heron-session"]', 'Stop watching');
  await waitFor(page, () => document.querySelector('[data-session="heron-session"]')?.textContent.includes('Stopped'), null, { label: 'session released' });
  h.ok(await page.evaluate(async () => {
    const root = window.__flux.get(window.__flux.shell.currentProject).path;
    const lines = (await window.fig.readText(root + '/.meta/feedback.ndjson')).trim().split('\n').map(JSON.parse);
    return lines.some(e => e.kind === 'release-session' && e.session.id === 'heron-session' && e.client === 'human');
  }), 'Stop watching writes release-session to the shared ledger');
  h.ok(await page.$eval('[aria-label="This project"]', e => e.textContent.includes('Running for this window.')), 'project bridge comes from the sender status');
  h.eq(realErrors(page), [], 'console clean across Home, confirmation, utility and session workflows');
} catch (e) { h.fail(e.stack || String(e)); }
await h.done(() => browser.close());
