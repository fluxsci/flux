// Real launcher + real stdio server, with only the vendor CLIs replaced. Run
// through run-verifies: every file and process stays inside its scratch machine.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { harness } from './lib/harness.mjs';
import { TestProcessScope } from './lib/testProcess.mjs';
import { agentFixture, tree } from './lib/agentSetupFixture';
import { installTestLauncher, rawMcp } from './lib/mcpFixture';
import { cleanEnv, dataOf, textOf, until, worker } from './lib/inboxFixture';
import { historicalMission, HISTORICAL_NOTEBOOK, HISTORICAL_AGENTS_STUB } from './oneoff/migrate-2026-09-flux-connect.mjs';
import { resolveSpawn } from '../electron/execResolve.cjs';
import { ensureFluxConfig, binDirSync, userDataDir, resolveOwnCliCommandsSync } from '../electron/fluxPaths.cjs';
import { readAnnotationState, readPresence } from '../flux-core/annotations';
import { makeNote } from '../src/lib/project/annotations';
import { proofCode, imageCode } from '../flux-core/connect/codes';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const h = harness('verify-connect-e2e'), scope = new TestProcessScope();
const repo = path.resolve(import.meta.dirname, '..');
const fixture = await agentFixture();
const clients: Awaited<ReturnType<typeof rawMcp>>[] = [];
const exists = async (file: string) => !!await fs.stat(file).catch(() => null);
const read = (file: string) => fs.readFile(file, 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

try {
  // agentFixture installs only fake vendor commands on PATH and redirects all
  // vendor homes as well as HOME/XDG. Its fake Flux runtime is never used here.
  for (const key of ['FLUX_CONNECT_CACHE', 'FLUX_CONNECT_FALLBACK', 'FLUX_MCP_READONLY', 'FLUX_MCP_TOOLSET']) delete process.env[key];
  const cfg = await ensureFluxConfig();
  h.ok(cfg.fluxConfigPath.startsWith(fixture.home + path.sep), 'ensureFluxConfig uses the scratch HOME');
  for (const file of ['WHO-AM-I.md', 'RULES.md', 'Skills/README.md']) h.ok(await exists(path.join(cfg.userContextPath, file)), `UserContext seed: ${file}`);
  const manuals = (await fs.readdir(path.join(repo, 'resources/flux-context'))).filter(n => n.endsWith('.md')).sort();
  h.eq((await fs.readdir(cfg.fluxContextPath)).sort(), ['.version', ...manuals], 'all shipped manuals and their version stamp installed');
  for (const file of manuals) h.ok((await read(path.join(cfg.fluxContextPath, file))).length > 100, `stock manual has content: ${file}`);

  const launcher = await installTestLauncher(repo, binDirSync());
  h.ok(launcher.startsWith(fixture.home + path.sep), 'real launcher installed in the scratch bin dir');
  h.ok((await read(launcher)).includes(repo), 'launcher targets this checkout, not the vendor fixture runtime');
  const env = cleanEnv();
  async function cli(args: string[]) {
    const childEnv = { ...env };
    // Setup/removal refuse the runner guard; enable them only in this fixture's
    // independently created HOME, with both vendor config paths redirected.
    if (args[0] === 'connect' && ['setup', 'remove'].includes(args[1])) delete childEnv.FLUX_NO_MIGRATE;
    const resolved = resolveSpawn(launcher, args);
    const entry = scope.spawn(resolved.args[0], resolved.args.slice(1), {
      command: resolved.command, windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      nodeArgs: [], env: childEnv, cwd: fixture.temp, deadlineMs: 60000,
    });
    await scope.waitExit(entry);
    if (entry.code !== 0) throw new Error(`flux ${args.join(' ')} exited ${entry.code}: ${entry.stderr}\n${entry.stdout}`);
    h.ok(true, `launcher: ${args.slice(0, 2).join(' ')}`);
    return entry.stdout;
  }

  h.section('scaffold and legacy copy');
  const fresh = path.join(fixture.temp, 'Fresh project'), legacy = path.join(fixture.temp, 'Legacy project');
  await cli(['new', fresh, '--title', 'Connect acceptance']);
  h.ok(await exists(path.join(fresh, 'Context/ProjectContext.qmd')), 'new scaffold uses ProjectContext');
  await put(fresh, 'paper/methods.qmd', '---\ntitle: Methods\n---\n\n## Sampling\n\nE2E-LINKED-METHODS: sample every recording.\n');
  await put(fresh, 'plots/example.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="#fffcf0"/><circle cx="120" cy="80" r="55" fill="#205ea6"/></svg>');
  await cli(['compose-figure', path.join(fresh, 'plots/example.svg'), '--id', 'e2e-figure', '--root', fresh]);
  await fs.cp(fresh, legacy, { recursive: true });
  await fs.rm(path.join(legacy, 'Context/ProjectContext.qmd'));
  // The one-shot intentionally preserves authored links for manual review.
  // An absolute link remains valid on both sides of the Context folder move.
  const methodsLink = encodeURI(path.join(legacy, 'paper/methods.qmd').split(path.sep).join('/'));
  const mission = historicalMission('Connect acceptance') + `\n## Study details\n\nE2E-PROJECT-CONTEXT: a preserved research question.\n\n[Methods](${methodsLink})\n`;
  await put(legacy, 'Context/Project/MISSION.qmd', mission);
  await put(legacy, 'Context/NOTEBOOK.md', HISTORICAL_NOTEBOOK + '\n### 2026-09-26 10:00 — Baseline\n\nE2E-LOG: the original observation.\n');
  await put(legacy, 'Context/RULES.md', '# Rules\n\nE2E-RULE: keep original trial IDs.\n');
  await put(legacy, 'AGENTS.md', HISTORICAL_AGENTS_STUB);
  await put(legacy, 'CLAUDE.md', '@AGENTS.md\n');
  const records = { 'Context/Transcripts/session.txt': 'preserve the transcript\n', 'Context/Dispatches/work/result.json': '{"result":"preserve"}\n', '.meta/agent/session.json': '{"session":"preserve"}\n' };
  for (const [file, content] of Object.entries(records)) await put(legacy, file, content);
  const freshBefore = await tree(fresh);

  h.section('setup through the installed launcher');
  await fixture.put('FluxConfig/Context/UserContext/Skills/e2e-stats/SKILL.md', '---\nname: e2e-stats\ndescription: Acceptance fixture conventions\n---\nKeep trial IDs.\n');
  await cli(['connect', 'setup', '--yes']);
  const claude = JSON.parse(await fixture.read('.claude.json'));
  const runtime = resolveOwnCliCommandsSync({ appRoot: repo, nodePath: process.execPath, packaged: false, appImage: '' });
  const command = process.platform === 'win32' ? runtime.executable : launcher;
  const args = process.platform === 'win32' ? [...runtime.args, 'mcp'] : ['mcp'];
  h.eq(claude.mcpServers.flux, { type: 'stdio', command, args, env: { FLUX_WAIT_MAX_MS: '3300000' } }, 'Claude MCP registration targets this real launcher/runtime');
  const codex = await fixture.read('.codex/config.toml');
  h.ok(['[mcp_servers.flux]', `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`, 'tool_timeout_sec = 3600', 'FLUX_CLIENT = "codex"', 'FLUX_WAIT_MAX_MS = "3300000"'].every(line => codex.split('\n').includes(line)), 'Codex MCP registration targets this real launcher/runtime with its timeouts');
  for (const vendor of ['.claude', '.agents']) {
    const dir = path.join(fixture.home, vendor, 'skills/flux-connect');
    const managed = JSON.parse(await read(path.join(dir, '.flux-managed.json')));
    const expected = vendor === '.claude' ? ['SKILL.md'] : ['SKILL.md', 'agents/openai.yaml'];
    h.eq(Object.keys(managed.files).sort(), expected.sort(), `${vendor}: complete managed file inventory`);
    for (const file of expected) {
      const body = await read(path.join(dir, file));
      h.eq(sha(body), managed.files[file], `${vendor}/${file}: installed bytes match ownership manifest`);
      h.ok(!body.includes('{{FLUX_CLI}}'), `${vendor}/${file}: launcher placeholder rendered`);
    }
    h.ok((await read(path.join(dir, 'SKILL.md'))).includes(launcher), `${vendor}: skill names the real launcher`);
    h.eq(await fixture.read(`${vendor}/skills/e2e-stats/SKILL.md`), await fixture.read('FluxConfig/Context/UserContext/Skills/e2e-stats/SKILL.md'), `${vendor}: user skill published`);
  }
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const hooks = JSON.parse(await fixture.read(file)).hooks.UserPromptSubmit;
    h.ok(hooks.some((entry: any) => entry.hooks.some((hook: any) => hook.command.includes('--hook-delta') && hook.command.includes(launcher))), `${file}: refresh hook installed`);
  }
  h.ok(await exists(path.join(userDataDir(), 'agent-setup.json')), 'setup ownership receipt installed');
  h.ok(await exists(path.join(binDirSync(), process.platform === 'win32' ? 'flux-connect.cmd' : 'flux-connect')), 'flux-connect launcher alias installed');
  h.ok((await fixture.argv()).some(c => c.vendor === 'claude' && c.args[1] === 'add-json'), 'setup used the fake vendor CLI registration protocol');

  h.section('one-shot migration, then connect');
  // Owner ruling 2 overrides §10.6's implied in-app migration. Apply the
  // committed standalone migrator before connect; the app remains legacy-free.
  const migration = scope.spawn(path.join(repo, 'scripts/oneoff/migrate-2026-09-flux-connect.mjs'), ['--roots', legacy, '--apply'], { nodeArgs: [], cwd: fixture.temp, env, deadlineMs: 30000 });
  await scope.waitExit(migration);
  h.eq(migration.code, 0, `one-shot migration applies: ${migration.stderr}`);
  h.ok(!await exists(path.join(legacy, 'Context/Project/MISSION.qmd')), 'old Context path is gone');
  const context = await read(path.join(legacy, 'Context/ProjectContext.qmd'));
  h.eq(context, mission.replace('title: "Mission — ', 'title: "Project context — '), 'authored context and its link preserved with only the generated title changed');
  const notebook = await read(path.join(legacy, 'Context/NOTEBOOK.md'));
  h.ok(notebook.includes('## Log') && !notebook.includes('## Session log') && notebook.includes('E2E-LOG'), 'Log heading migrated without losing entries');
  h.ok((await read(path.join(legacy, 'AGENTS.md'))).includes('flux-connect'), 'project pointer migrated');
  const archive = path.join(legacy, '.meta/archive/2026-09-agent-workflow');
  for (const [file, content] of Object.entries(records)) {
    h.ok(!await exists(path.join(legacy, file)), `${file}: retired directory removed`);
    h.eq(await read(path.join(archive, file.replace(/^(?:Context|\.meta)\//, ''))), content, `${file}: historical bytes archived intact`);
  }
  const beforeConnect = await tree(legacy);
  const pack = JSON.parse(await cli(['connect', legacy, '--json']));
  h.eq(pack.root, await fs.realpath(legacy), 'CLI pack belongs to the migrated copy');
  h.ok([pack.briefPath, pack.bundlePath, pack.manifestPath, ...pack.images.map((img: any) => img.path)].every(file => file.startsWith(userDataDir() + path.sep)), 'all pack artifacts stay inside the scratch machine config');
  const brief = await read(pack.briefPath), bundle = await read(pack.bundlePath);
  h.ok(brief.length <= 10000 && brief.startsWith('# FLUX-CONNECT BRIEF') && brief.trimEnd().endsWith(`END OF FLUX-CONNECT BRIEF ${pack.packId}`), 'complete bounded brief with matching sentinel');
  const manifest = JSON.parse(await read(pack.manifestPath));
  h.eq([manifest.packId, manifest.root, manifest.depth], [pack.packId, pack.root, 'core'], 'manifest identifies this core pack');
  for (const marker of ['E2E-PROJECT-CONTEXT', 'E2E-LINKED-METHODS', 'E2E-RULE', 'E2E-LOG']) h.ok(bundle.includes(marker), `bundle contains ${marker}`);
  const codes = 'ABCDEFGH'.split('').map(s => proofCode(pack.packId, `section:${s}`));
  h.ok(codes.every(code => bundle.includes(code) && !brief.includes(code)), 'all eight section proofs are in the bundle only');
  h.eq(pack.images.length, 1, 'default core connect renders the canvas overview');
  for (const [i, img] of pack.images.entries()) {
    const png = await fs.readFile(img.path);
    h.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `image ${i}: PNG signature`);
    const decoded = await loadImage(png), canvas = createCanvas(decoded.width, decoded.height), ctx = canvas.getContext('2d');
    ctx.drawImage(decoded, 0, 0);
    const pixels = ctx.getImageData(0, 0, decoded.width, decoded.height).data;
    let blue = 0;
    for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3] > 200 && pixels[p + 2] > pixels[p] + 60 && pixels[p + 2] > pixels[p + 1] + 30) blue++;
    h.ok(decoded.width > 100 && decoded.height > 100 && blue > 100, `image ${i}: decoded fixture plot pixels, not an empty PNG`);
    codes.push(imageCode(pack.packId, i));
  }
  h.ok((await cli(['connect', '--check-receipt', pack.packId, codes.join(' ')])).includes('✓ complete'), 'receipt accepts the pack section and image proofs');
  h.eq(await tree(legacy), beforeConnect, 'CLI connect leaves every migrated project byte unchanged');

  h.section('real MCP watch, second-process append, claim and resolve');
  const client = await rawMcp(launcher, fixture.temp, [], cleanEnv({ CODEX_THREAD_ID: 'connect-e2e' }));
  clients.push(client);
  h.eq(client.beforeHandshake, '', 'server stdout is quiet before initialize');
  h.eq((await client.initialize('codex', 'e2e')).result.serverInfo.name, 'flux', 'real server initializes');
  const connection = await client.call('connect', { target: legacy });
  h.ok(!connection.isError && connection.structuredContent.root === pack.root, 'MCP connect binds the migrated project');
  const sessions = await readPresence(legacy), me = sessions[0];
  h.ok(sessions.length === 1 && me.id === 'connect-e2e' && !me.watching && me.pid > 0, 'explicit connect publishes one passive server presence');
  h.ok(textOf(connection).includes(`You are ${me.name}`), 'connection receipt names the real session');
  h.eq(dataOf(await client.call('list_inbox')).items, [], 'connected inbox starts empty');
  const note = makeNote('Check the circle #acceptance', { surface: 'figure', activeFigureId: 'e2e-figure', targets: [{ kind: 'figure', figureId: 'e2e-figure' }] }, 'human', 'any');
  const writer = worker(scope, legacy, 'append', { event: note });
  await writer.ready;
  const waiting = client.call('wait_for_inbox', { timeoutMs: 10000 });
  await until(async () => (await readPresence(legacy)).find(s => s.id === me.id)?.watching, 'MCP watch has started');
  writer.child.stdin.write('GO\n');
  const delivered = dataOf(await waiting);
  await scope.waitExit(writer);
  h.eq(writer.code, 0, `second-process annotation append succeeds: ${writer.stderr}`);
  h.eq(delivered.items.map((i: any) => i.id), [note.id], 'wait_for_inbox delivers the second-process annotation');
  h.ok(!!delivered.cursor && !delivered.stopped, 'wait returns a continuation cursor');
  const claim = dataOf(await client.call('claim_item', { id: note.id }));
  h.eq(claim.claimed, true, 'the connected session claims the annotation');
  h.eq((await readAnnotationState(legacy)).state.byId.get(note.id)?.claim?.session.id, me.id, 'ledger fold records the actual session holder');
  const resolved = await client.call('resolve_item', { id: note.id, note: 'Checked the fixture circle.' });
  h.ok(!resolved.isError, 'resolve_item succeeds');
  const state = await readAnnotationState(legacy), item = state.state.byId.get(note.id);
  h.ok(item?.resolved && item.resolveNote === 'Checked the fixture circle.', 'ledger fold shows the annotation resolved with its reply');
  h.eq(state.events.filter(e => ('target' in e ? e.target : 'id' in e ? e.id : null) === note.id).map(e => e.kind), ['note', 'claim', 'resolve'], 'one append-only note/claim/resolve sequence');
  h.eq(dataOf(await client.call('list_inbox')).items, [], 'resolved annotation leaves the open inbox');
  // Closing stdin reaches the server even when the launcher runs tsx, whose
  // child owns the presence PID. Killing the wrapper alone is not this check.
  client.entry.child.stdin.end();
  await client.entry.closed;
  h.eq(client.entry.code, 0, 'MCP server closes cleanly on EOF');
  h.eq(await readPresence(legacy), [], 'server exit removes its presence record');
  h.eq(await fs.readdir(path.join(legacy, '.meta/live/sessions')), [], 'no heartbeat or temporary presence files survive exit');

  h.section('remove through the installed launcher');
  await cli(['connect', 'remove', '--yes']);
  for (const vendor of ['.claude', '.agents']) {
    h.ok(!await exists(path.join(fixture.home, vendor, 'skills/flux-connect')), `${vendor}: stock skill removed`);
    h.ok(!await exists(path.join(fixture.home, vendor, 'skills/e2e-stats')), `${vendor}: published skill removed`);
  }
  h.ok(!await exists(path.join(fixture.home, '.claude.json')), 'new Claude registration file removed');
  for (const file of ['.codex/config.toml', '.claude/settings.json', '.codex/hooks.json']) h.ok(!await exists(path.join(fixture.home, file)), `${file}: new managed config removed`);
  h.ok(await exists(path.join(cfg.userContextPath, 'Skills/e2e-stats/SKILL.md')), 'removal preserves the authored UserContext skill');
  h.ok(await exists(launcher), 'removal preserves the shared Flux launcher');
  h.eq(await tree(fresh), freshBefore, 'original new project remains unchanged throughout acceptance');
} catch (e) { h.fail(e instanceof Error ? e.stack : String(e)); }
await h.done(async () => { for (const client of clients) await client.close(); await scope.dispose(); await fixture.cleanup(); });
