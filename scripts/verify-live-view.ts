// Real transport + main relay + renderer handshake; only capturePage is faked.
import * as fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { get } from 'svelte/store';
import { harness } from './lib/harness.mjs';
import { mountFigureCommandFixture } from './lib/liveEditorFixture';
import { TestProcessScope } from './lib/testProcess.mjs';
import { installTestLauncher, rawMcp, scratchProject } from './lib/mcpFixture';
import { installBridge } from '../src/lib/bridge/install';
import { getAppContext } from '../src/lib/bridge/appContext';
import { currentProject, view } from '../src/shell/shellStore';
import { setFocusedMode } from '../src/shell/paneStore';
import { paperSelection } from '../src/lib/project/paperSelectionStore';
import { settings, decodeSettings } from '../src/lib/settings';
import { annotationOpen, askOpen } from '../src/shell/agent/annotationVisibility';
import { createLiveViewActivity, recentAgentActivity, lastAgentView, liveViewActivity } from '../src/lib/bridge/liveView';
import { describeStamp } from '../src/lib/project/annotations';
import { parsePresence } from '../src/lib/project/presence';
import { getView, bridgeAvailable, dispatchCommand } from '../flux-core/liveClient';
import { setClient } from '../flux-core/journal';
import { resolveSpawn } from '../electron/execResolve.cjs';

const h = harness('verify-live-view'), scope = new TestProcessScope();
const require = createRequire(import.meta.url);
const { createAgentFamily } = require('../electron/ipc/agent.cjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'live-view-')));
const repo = path.resolve(import.meta.dirname, '..');
const root = await scratchProject(path.join(temp, 'project'), 'Live view');
const otherRoot = await scratchProject(path.join(temp, 'other'), 'Other view');
const launcher = await installTestLauncher(repo, path.join(temp, 'bin'));
const clients: Awaited<ReturnType<typeof rawMcp>>[] = [];
const handlers = new Map<string, (...args: any[]) => void>();
const renderer = new Map<string, (value: any) => void>();
const roots = new Map<object, string>();
// Actual PNG bytes flow unchanged through HTTP, MCP and the CLI's output file.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
let dimensions = { width: 3200, height: 2000 }, resized: any, captures = 0, otherCaptures = 0;
let duringCapture: () => void = () => {}, spoofReply = false;
function fakeImage(size = dimensions): any {
  return { getSize: () => size, resize: (next: any) => { resized = next; return fakeImage(next); }, toPNG: () => png };
}
const win = { isDestroyed: () => false, webContents: {
  isDestroyed: () => false,
  capturePage: async () => { captures++; duringCapture(); return fakeImage(); },
  send: (channel: string, message: any) => {
    if (channel === 'bridge:context:request' && spoofReply)
      handlers.get('bridge:context:reply')!({ sender: other.webContents }, { id: message.id, context: { projectRoot: root, surface: 'spoof' }, allowed: true });
    renderer.get(channel)?.(message);
  },
} };
const other = { isDestroyed: () => false, webContents: {
  isDestroyed: () => false,
  capturePage: async () => { otherCaptures++; return fakeImage({ width: 400, height: 300 }); },
  send: (channel: string, message: any) => {
    if (channel === 'bridge:context:request') handlers.get('bridge:context:reply')!({ sender: other.webContents }, {
      id: message.id, context: { projectRoot: otherRoot, surface: 'library' }, allowed: true,
    });
  },
} };
roots.set(win.webContents, root); roots.set(other.webContents, otherRoot);
const family = createAgentFamily({ rootForSender: (e: any) => roots.get(e.sender), noteWrite: () => {},
  appendJournalLine: (r: string, entry: unknown) => appendFileSync(path.join(r, '.meta/journal.ndjson'), JSON.stringify(entry) + '\n'),
});
family.registerHandlers({ on: (channel: string, cb: (...args: any[]) => void) => handlers.set(channel, cb) });
const send = (channel: string, value: unknown) => handlers.get(channel)!({ sender: win.webContents }, value);
Object.assign(globalThis, { window: { fig: {
  readText: (file: string) => fs.readFile(file, 'utf8'),
  bridge: {
    pushContext: (context: unknown) => send('bridge:context', context),
    onDispatch: (cb: (value: any) => void) => renderer.set('bridge:dispatch', cb),
    reply: (id: number, result: unknown, error?: string) => send('bridge:dispatch:reply', { id, result, error }),
    onContextRequest: (cb: (value: any) => void) => renderer.set('bridge:context:request', cb),
    replyContext: (id: number, context: unknown, allowed: boolean) => send('bridge:context:reply', { id, context, allowed }),
    onViewed: (cb: (value: any) => void) => renderer.set('bridge:viewed', cb),
  },
} } });
async function until(predicate: () => unknown | Promise<unknown>, label: string) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const textOf = (r: any) => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const cli = async (args: string[], env = process.env) => {
  const command = resolveSpawn(launcher, args);
  const entry = scope.spawn(command.args[0], command.args.slice(1), { command: command.command, windowsVerbatimArguments: command.windowsVerbatimArguments, nodeArgs: [], env, cwd: temp, deadlineMs: 30000 });
  await scope.waitExit(entry); return entry;
};
try {
  family.setBridgeFor(root, win); family.setBridgeFor(otherRoot, other);
  currentProject.set({ path: root, name: 'Live view' }); view.set('workspace'); setFocusedMode('paper');
  installBridge();
  await until(() => bridgeAvailable(root), 'bridge startup');
  const info = JSON.parse(await fs.readFile(path.join(root, '.meta/live/bridge.json'), 'utf8'));
  const post = (body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${info.url}/capture`, {
    method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  h.eq((await fetch(`${info.url}/capture`, { method: 'POST' })).status, 401, 'capture requires bearer token');
  h.eq((await post({}, { authorization: 'Bearer wrong' })).status, 401, 'wrong token refused');
  h.eq((await post({}, { 'x-flux-project': otherRoot })).status, 409, 'wrong project header refused');
  h.eq(captures, 0, 'rejections never call capturePage');
  h.ok(decodeSettings({}).allowAgentView && !decodeSettings({ allowAgentView: false }).allowAgentView, 'viewing defaults on; saved off preference survives decoding');
  settings.update(v => ({ ...v, allowAgentView: false }));
  const disabled = await post();
  h.eq([disabled.status, await disabled.json()], [403, { error: 'live-view-disabled' }], 'disabled returns exact 403 live-view-disabled');
  h.eq(captures, 0, 'disabled refuses before capture');
  settings.update(v => ({ ...v, allowAgentView: true }));
  // No 120ms cached-context delay: the handshake reads the new selection now.
  paperSelection.set({ doc: 'paper/live.qmd', from: 5, to: 12, quote: 'current' });
  setClient('codex · test');
  const result = await getView(root);
  h.eq(result.stamp, getAppContext(), 'capture stamp is the shared current AppContext, including fresh selection');
  h.eq(result.png, png.toString('base64'), 'base64 PNG returned');
  h.eq(resized, { width: 1600, height: 1000, quality: 'best' }, 'default 1600 long edge retains aspect ratio');
  for (const [edge, expected] of [[800.9, 800], [10, 256], [100000, 1600]]) {
    await getView(root, edge); h.eq(resized.width, expected, `maxEdge ${edge} is rounded/clamped`);
  }
  dimensions = { width: 900, height: 3600 }; await getView(root, 1000);
  h.eq([resized.width, resized.height], [250, 1000], 'portrait long edge capped');
  dimensions = { width: 100, height: 80 }; resized = undefined; await getView(root);
  h.eq(resized, undefined, 'small captures never upscale');
  for (const invalid of [{ maxEdge: '100' }, { maxEdge: null }, []]) h.eq((await post(invalid)).status, 400, 'invalid capture options refused');
  await until(() => get(recentAgentActivity).length === 6, 'activity delivery');
  h.eq(get(lastAgentView)?.name, 'codex · test', 'unconnected client has a readable fallback name');
  let lines = (await fs.readFile(path.join(root, '.meta/journal.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  h.ok(lines.some(l => l.action === 'live_view' && l.client === 'codex · test'), 'live_view journal records requesting client');
  const count = get(recentAgentActivity).length;
  duringCapture = () => settings.update(v => ({ ...v, allowAgentView: false }));
  h.eq((await post()).status, 403, 'revoking consent during capture withholds the image');
  h.eq(get(recentAgentActivity).length, count, 'withheld image emits no viewed activity');
  duringCapture = () => {}; settings.update(v => ({ ...v, allowAgentView: true }));
  spoofReply = true; h.eq((await getView(root)).stamp.surface, 'paper', 'another window cannot answer the owning window handshake'); spoofReply = false;
  const unmount = mountFigureCommandFixture(root); annotationOpen.set(true);
  h.eq((await getView(root)).stamp.surface, 'figure', 'capture remains available with frozen Annotate');
  h.ok(await dispatchCommand(root, { type: 'add_text', text: 'blocked' }).then(() => false, e => String(e).includes('Annotate or Ask is open')), 'frozen Annotate still refuses writes');
  annotationOpen.set(false); askOpen.set(true);
  h.ok(await dispatchCommand(root, { type: 'add_text', text: 'blocked' }).then(() => false, e => String(e).includes('Annotate or Ask is open')), 'an open Ask refuses writes too');
  askOpen.set(false); unmount(); setFocusedMode('paper');
  const priorCaptures = captures;
  h.eq((await getView(otherRoot)).stamp.surface, 'library', 'second project gets its own context');
  h.ok(captures === priorCaptures && otherCaptures === 1, 'capture calls only the bridge-owning window');

  const mcp = await rawMcp(launcher, temp, ['--toolset', 'core']); clients.push(mcp); await mcp.initialize('codex');
  const tools = (await mcp.request('tools/list')).result;
  h.ok(tools.tools.some((t: any) => t.name === 'get_view'), 'get_view is a core tool');
  h.ok(Buffer.byteLength(JSON.stringify(tools)) <= 20000, `core tools/list stays <=20KB (${Buffer.byteLength(JSON.stringify(tools))} bytes)`);
  h.ok((await mcp.call('get_view')).isError, 'get_view requires a project binding or override');
  h.ok(!(await mcp.call('connect', { target: root, live: true })).isError, 'connect --live succeeds');
  const presenceFiles = await fs.readdir(path.join(root, '.meta/live/sessions'));
  const session = parsePresence(await fs.readFile(path.join(root, '.meta/live/sessions', presenceFiles[0]), 'utf8'))!;
  h.ok(session.live, 'live connection records live:true for Pairing');
  const mcpView = await mcp.call('get_view', { maxEdge: 600 });
  h.ok(!mcpView.isError && mcpView.content[0].type === 'image' && mcpView.content[0].mimeType === 'image/png', 'MCP returns inline image content');
  h.eq(mcpView.content[0].data, png.toString('base64'), 'MCP uses capture PNG bytes');
  h.eq(mcpView.content[1].text, describeStamp(getAppContext()), 'MCP uses shared describeStamp for the text line');
  await until(() => get(lastAgentView)?.name === session.name, 'presence name');
  h.eq(get(recentAgentActivity)[0].sessionId, session.id, 'recent activity and titlebar resolve exact presence identity');
  lines = (await fs.readFile(path.join(root, '.meta/journal.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  h.ok(lines.some(l => l.action === 'live_view' && l.sessionId === session.id), 'MCP journal includes session id');
  h.ok(!(await mcp.call('get_view', { project: otherRoot })).isError, 'MCP per-call project override uses its bridge');
  settings.update(v => ({ ...v, allowAgentView: false }));
  const refusal = await mcp.call('get_view');
  h.ok(refusal.isError && textOf(refusal).includes('live-view-disabled') && textOf(refusal).includes('Settings'), 'MCP reports viewing disabled plainly');
  const out = path.join(temp, 'view.png');
  await fs.writeFile(out, 'keep');
  const deniedCli = await cli(['view', '--root', root, '--png', '--out', out]);
  h.ok(deniedCli.code !== 0 && deniedCli.stderr.includes('live-view-disabled') && await fs.readFile(out, 'utf8') === 'keep', 'CLI disabled error preserves existing output');
  settings.update(v => ({ ...v, allowAgentView: true }));
  dimensions = { width: 3200, height: 2000 };
  const cliEnv = { ...process.env, CODEX_THREAD_ID: session.id };
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT']) delete cliEnv[key];
  const rendered = await cli(['view', '--root', root, '--png', '--out', out, '--max-edge', '700'], cliEnv);
  h.ok(rendered.code === 0 && rendered.stderr.includes(describeStamp(getAppContext())), `CLI writes PNG with context: ${rendered.stderr.trim()}`);
  h.ok((await fs.readFile(out)).equals(png) && resized.width === 700, 'CLI PNG bytes and max-edge reach same capture path');
  await until(() => get(lastAgentView)?.sessionId === session.id && get(lastAgentView)?.client === (cliEnv.FLUX_CLIENT || 'cli'), 'CLI presence identity');
  h.eq(get(lastAgentView)?.name, session.name, 'CLI uses an available vendor session id to resolve its presence name');
  h.ok((await cli(['view', '--root', root, '--out', out])).code !== 0, 'CLI requires explicit --png output contract');

  const activity = createLiveViewActivity(async () => 'heron'); activity.setRoot(root);
  for (let i = 0; i < 24; i++) await activity.record({ root, client: 'codex', at: String(i) });
  h.ok(get(activity.recent).length === 20 && get(activity.recent)[0].at === '23', 'activity list bounded to 20 newest entries');
  h.eq(get(activity.indicator)?.name, 'heron', 'indicator visible immediately after event');
  const began = Date.now();
  await until(() => !get(activity.indicator), 'two-second indicator expiration');
  h.ok(Date.now() - began >= 1900 && get(activity.recent).length === 20, 'indicator lasts two seconds; recent history survives expiration');
  activity.setRoot(otherRoot); h.eq(get(activity.recent), [], 'activity clears on project switch');
  let finishName!: (name: string) => void;
  const slow = createLiveViewActivity(() => new Promise(r => finishName = r)); slow.setRoot(root);
  const pending = slow.record({ root, client: 'codex', at: 'now' }); slow.setRoot(otherRoot); finishName('old'); await pending;
  h.ok(!get(slow.indicator) && !get(slow.recent).length, 'late presence lookup cannot leak into another project');
  duringCapture = () => family.setBridgeFor(null, win);
  h.ok(await getView(root).then(() => false, e => /ownership changed|bridge stopped/.test(String(e))), 'project handoff during capture withholds pixels');
} finally {
  for (const c of clients) await c.close();
  await scope.dispose(); family.stopAllBridges(); currentProject.set(null); liveViewActivity.setRoot(null);
  await fs.rm(temp, { recursive: true, force: true });
}
await h.done();
