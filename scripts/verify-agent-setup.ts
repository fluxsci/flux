import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { harness } from './lib/harness.mjs';
import { agentFixture, tree } from './lib/agentSetupFixture';
import * as setup from '../electron/agentSetup.cjs';
import { ensureFluxConfig, resolveOwnCliCommandsSync, launcherBodies, launcherOwnerSync } from '../electron/fluxPaths.cjs';
import { TestProcessScope } from './lib/testProcess.mjs';
import { tsxCli } from './lib/tsxRun.mjs';
const h = harness('verify-agent-setup'), scope = new TestProcessScope();
let fixture: Awaited<ReturnType<typeof agentFixture>>;
async function fresh() { if (fixture) await fixture.cleanup(); fixture = await agentFixture(); }
async function probe() { return setup.probeAgents({ runtime: fixture.runtime }); }
async function install(options = {}) { return setup.applySetup(setup.planSetup({ probe: await probe(), ...options }), { yes: true }); }
async function rejects(fn: () => Promise<unknown>, label: string) { try { await fn(); h.fail(label); } catch { h.ok(true, label); } }
const skill = (name: string, body = 'Use careful statistics.') => `---\nname: ${name}\ndescription: Statistical conventions\n---\n${body}\n`;
try {
  await fresh();
  const originalHook = { matcher: '', hooks: [{ type: 'command', command: 'echo user-hook' }] };
  await fixture.put('.claude/settings.json', JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { UserPromptSubmit: [originalHook], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }));
  await fixture.put('.codex/hooks.json', JSON.stringify({ description: 'Mine', hooks: { UserPromptSubmit: [originalHook] } }));
  await fixture.put('.codex/config.toml', '# user config\nmodel = "mine"\n');
  const before = await tree(fixture.home), snapshot = await probe();
  h.ok(snapshot.every(a => a.present && a.binary), 'detects both PATH binaries');
  h.ok(snapshot[1].capabilities.promptHook, 'installed Codex capability probe detects prompt hooks');
  const plan = setup.planSetup({ probe: snapshot });
  h.eq(await tree(fixture.home), before, 'probe and dry planning write nothing to user HOME');
  h.ok(plan.actions.some(a => a.path.endsWith('openai.yaml')), 'Codex metadata is planned');
  const report = await setup.applySetup(plan);
  h.ok(report.backups.length >= 3, 'modified configs receive backups');
  const claude = JSON.parse(await fixture.read('.claude.json'));
  h.eq(claude.mcpServers.flux, setup.registration(fixture.runtime, 'claude'), 'Claude receives canonical MCP command and timeout env');
  const config = await fixture.read('.codex/config.toml');
  h.ok(config.includes('tool_timeout_sec = 3600') && config.includes('FLUX_CLIENT = "codex"') && config.includes('FLUX_WAIT_MAX_MS = "3300000"'), 'Codex timeout/client/env keys are written');
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const value = JSON.parse(await fixture.read(file));
    h.eq(value.hooks.UserPromptSubmit[0], originalHook, `${file}: existing prompt hook survives`);
    h.eq(value.hooks.UserPromptSubmit[1], setup.hookEntry(fixture.runtime), `${file}: one managed refresh hook installed`);
  }
  const first = await tree(fixture.home), again = setup.planSetup({ probe: await probe() });
  h.eq(again.actions.length, 0, 'second setup plans no changes');
  await setup.applySetup(again);
  h.eq(await tree(fixture.home), first, 'repeat setup preserves every byte, including backup set');
  const calls = await fixture.argv();
  const add = calls.find(c => c.args[1] === 'add-json');
  h.eq(add.args.slice(0, 3), ['mcp', 'add-json', 'flux'], 'add-json puts the name first');
  h.eq(add.args.slice(4), ['--scope', 'user'], 'add-json scope follows single JSON positional');
  const remove = setup.planRemove({ probe: await probe() });
  await rejects(() => setup.applyRemove(remove), 'remove requires explicit confirmation');
  await setup.applyRemove(remove, { yes: true });
  for (const file of ['.claude/settings.json', '.codex/hooks.json', '.codex/config.toml']) h.eq(Buffer.from((await tree(fixture.home))[file], 'base64').toString(), Buffer.from(before[file], 'base64').toString(), `${file}: original bytes restored`);
  h.ok(!await fs.stat(path.join(fixture.home, '.claude.json')).catch(() => null), 'new Claude config removed after remove');
  h.ok(!await fs.stat(path.join(fixture.home, '.agents/skills/flux-connect/SKILL.md')).catch(() => null), 'managed stock skill removed');
  const afterRemove = await tree(fixture.home); await setup.applyRemove(setup.planRemove({ probe: await probe() }), { yes: true });
  h.eq(await tree(fixture.home), afterRemove, 'repeated remove is idempotent');
  await install();
  h.ok(await fs.stat(path.join(fixture.home,'.agents/skills/flux-connect/SKILL.md')).catch(()=>null), 'reconnect after remove installs the skill again');
  const skillRoot = path.join(fixture.home,'.agents/skills');
  for (const entry of await fs.readdir(skillRoot,{withFileTypes:true})) {
    if (entry.name.includes('.bak-flux-')) h.ok(entry.isFile(), 'skill backups are files, never discoverable skill directories');
  }


  await fresh();
  const unmanaged = '# Preserve formatting\nmodel = "custom"\n[mcp_servers.flux]\ncommand = "mine"\nargs = ["arg"]\n[mcp_servers.flux.env]\nTOKEN = "private"\n\n[mcp_servers.other]\ncommand = "other"\n';
  await fixture.put('.codex/config.toml', unmanaged);
  await fixture.put('.agents/skills/flux-connect/SKILL.md', 'USER SKILL');
  const conflict = setup.planSetup({ probe: await probe(), agents: ['codex'] });
  h.ok(conflict.actions.some(a => a.confirmation), 'unmanaged Codex table needs confirmation');
  await rejects(() => setup.applySetup(conflict), 'unmanaged table cannot be overwritten without --yes');
  const changed = await setup.applySetup(conflict, { yes: true });
  h.eq(await fixture.read('.agents/skills/flux-connect/SKILL.md'), 'USER SKILL', 'unmanaged skill stays byte-identical');
  const replaced = await fixture.read('.codex/config.toml');
  h.ok(replaced.includes('# (disabled by Flux setup ') && replaced.includes('[mcp_servers.other]\ncommand = "other"'), 'disabled original is commented; adjacent table stays active');
  h.ok(changed.backups.some(p => /config\.toml\.bak-flux-\d{8}-\d{4}/.test(p)), 'backup name contains date and minute');
  h.ok((await Promise.all(changed.backups.map(p => fs.readFile(p,'utf8')))).includes(unmanaged), 'backup retains exact unmanaged TOML');
  await fixture.put('.codex/config.toml', replaced + '\n[extra]\nvalue = 42\n');
  await setup.applyRemove(setup.planRemove({ probe: await probe(), agents: ['codex'] }), { yes: true });
  h.eq(await fixture.read('.codex/config.toml'), unmanaged + '\n[extra]\nvalue = 42\n', 'remove restores unmanaged table and keeps subsequent unrelated edits');

  await fresh(); await install();
  const editedHooks=JSON.parse(await fixture.read('.claude/settings.json'));
  editedHooks.hooks.UserPromptSubmit.push(originalHook); editedHooks.theme='new user setting';
  await fixture.put('.claude/settings.json',JSON.stringify(editedHooks));
  await setup.applyRemove(setup.planRemove({probe:await probe()}),{yes:true});
  const keptHooks=JSON.parse(await fixture.read('.claude/settings.json'));
  h.eq(keptHooks.hooks.UserPromptSubmit,[originalHook],'remove preserves user hook added after setup');
  h.eq(keptHooks.theme,'new user setting','remove preserves unrelated settings added after setup');

  // A launcher owned by a checkout that still exists but whose built CLI is gone is dead
  // (every `flux` fails): setup repairs it without --use-this-install. A live other owner
  // still requires the explicit choice.
  await fresh();
  const cli = fixture.runtime.cli, deadRoot = path.join(path.dirname(fixture.home), 'kept-checkout');
  const deadScript = path.join(deadRoot, 'dist', 'flux-cli.mjs');
  await fs.mkdir(deadRoot, { recursive: true }); await fs.mkdir(path.dirname(cli), { recursive: true });
  const otherBody = launcherBodies({ ...fixture.runtime, target: deadRoot, build: 'dead123', electron: false, executable: process.execPath, args: [deadScript] }).main;
  await fs.writeFile(cli, otherBody, { mode: 0o755 });
  const deadPlan = setup.planSetup({ probe: await probe() });
  h.ok(!deadPlan.checks.some(c => c.id === 'launcher.owner'), 'setup treats a launcher whose built CLI is gone as dead (checkout kept)');
  await setup.applySetup(deadPlan, { yes: true });
  h.eq(launcherOwnerSync(cli)?.target, fixture.runtime.target, 'setup repairs the dead launcher to this install');
  await fs.mkdir(path.dirname(deadScript), { recursive: true }); await fs.writeFile(deadScript, '');
  await fs.writeFile(cli, otherBody, { mode: 0o755 });
  h.ok(setup.planSetup({ probe: await probe() }).checks.some(c => c.id === 'launcher.owner'), 'a live other owner still requires --use-this-install');

  await fresh(); process.env.FAKE_NO_ADD_JSON = '1';
  await install({ agents: ['claude'] });
  const fallback = (await fixture.argv()).find(c => c.args[1] === 'add');
  h.eq(fallback.args.slice(0, 6), ['mcp','add','flux','--scope','user','--env'], 'fallback puts name and scope before variadic env');
  h.ok(fallback.args.indexOf('--') > 5 && fallback.args.at(-1) === 'mcp', 'fallback terminates env args before executable');
  await fresh();
  await fs.rm(path.join(fixture.bin, 'claude' + (process.platform === 'win32' ? '.cmd' : '')));
  await fixture.put('.claude/settings.json', '{"theme":"dark"}');
  const noBinary = await probe();
  h.ok(noBinary[0].present && !noBinary[0].binary, 'config-home-only extension installation detected');
  const noBinaryReport = await setup.applySetup(setup.planSetup({ probe: noBinary, agents: ['claude'] }));
  h.ok(noBinaryReport.checks.some(c => c.id === 'claude.binary' && /Close Claude/.test(c.fix || '')), 'no-binary fallback reports close-Claude requirement');
  h.ok(JSON.parse(await fixture.read('.claude.json')).mcpServers.flux, 'no-binary fallback writes atomic user config');

  await fresh();
  await fixture.put('.claude.json', '{"mcpServers":{"flux":{"command":"other-server","args":[]}},"theme":"mine"}');
  const unrelated = await fixture.read('.claude.json');
  await install({ agents: ['claude'] });
  h.eq(await fixture.read('.claude.json'), unrelated, '--yes never replaces an unrelated Claude MCP server');
  await fresh();
  await fixture.put('.claude.json', '{"mcpServers":{"flux":{"command":"node","args":["old/flux-mcp.ts"]}},"theme":"mine"}');
  const fluxOld = await fixture.read('.claude.json'), fluxPlan = setup.planSetup({ probe: await probe(), agents: ['claude'] });
  await rejects(() => setup.applySetup(fluxPlan), 'recognizable old MCP command needs replacement confirmation');
  await setup.applySetup(fluxPlan, { yes: true });
  await setup.applyRemove(setup.planRemove({ probe: await probe(), agents: ['claude'] }), { yes: true });
  h.eq(await fixture.read('.claude.json'), fluxOld, 'Claude replacement restores original registration and exact config');
  process.env.FAKE_FAIL_ADD = '1';
  await rejects(async () => setup.applySetup(setup.planSetup({probe: await probe(),agents:['claude']}),{yes:true}), 'failed vendor add reports failure');
  h.eq(await fixture.read('.claude.json'),fluxOld,'failed replacement restores prior registration after successful remove');
  delete process.env.FAKE_FAIL_ADD;


  await fresh();
  const stalePlan = setup.planSetup({ probe: await probe(), agents: ['codex'] });
  await fixture.put('.codex/config.toml', '# concurrent user change');
  await rejects(() => setup.applySetup(stalePlan), 'concurrent vendor config edit refuses before any apply');
  h.ok(!await fs.stat(path.join(fixture.home,'.agents/skills/flux-connect/SKILL.md')).catch(() => null), 'failed preflight performs no partial skill install');

  await fresh();
  await fixture.put('FluxConfig/Context/UserContext/Skills/stats/SKILL.md', skill('stats'));
  await fixture.put('FluxConfig/Context/UserContext/Skills/bad/SKILL.md', skill('wrong'));
  await fixture.put('FluxConfig/Context/UserContext/Skills/collision/SKILL.md', skill('collision'));
  await fixture.put('.agents/skills/collision/SKILL.md', 'mine');
  const pub = await install();
  h.ok(pub.checks.some(c => c.id === 'skill.bad'), 'invalid skill reported, not published');
  h.ok(pub.checks.some(c => c.id === 'codex.skill.collision'), 'name collision reported');
  h.eq(await fixture.read('.agents/skills/collision/SKILL.md'), 'mine', 'name collision left intact');
  for (const vendor of ['.claude','.agents']) h.eq(await fixture.read(`${vendor}/skills/stats/SKILL.md`), skill('stats'), `${vendor}: user skill published`);
  await fixture.put('FluxConfig/Context/UserContext/Skills/stats/SKILL.md', skill('stats','Live edit.'));
  if (process.platform !== 'win32') h.eq(await fixture.read('.claude/skills/stats/SKILL.md'), skill('stats','Live edit.'), 'symlink exposes live source edits without sync');
  await fs.rm(path.join(fixture.home,'FluxConfig/Context/UserContext/Skills/stats'),{recursive:true});
  await setup.publishUserSkills();
  for (const vendor of ['.claude','.agents']) h.ok(!await fs.lstat(path.join(fixture.home,`${vendor}/skills/stats`)).catch(() => null), `${vendor}: deleted source unpublishes managed skill`);
  await setup.applyRemove(setup.planRemove({ probe: await probe() }), { yes: true });
  await fixture.put('FluxConfig/Context/UserContext/Skills/later/SKILL.md',skill('later'));
  await setup.publishUserSkills();
  h.ok(!await fs.stat(path.join(fixture.home,'.agents/skills/later')).catch(() => null), 'disconnected vendor receives no new skills');

  await fresh(); await install({ agents: ['codex'] });
  await fixture.put('FluxConfig/Context/UserContext/Skills/stats/SKILL.md',skill('stats'));
  await fixture.put('FluxConfig/Context/UserContext/Skills/stats/assets/a.bin','\u0000binary\u00ff');
  await setup.publishUserSkills({copy:true});
  h.ok(!(await fs.lstat(path.join(fixture.home,'.agents/skills/stats'))).isSymbolicLink(),'copy fallback publishes directory');
  await fixture.put('FluxConfig/Context/UserContext/Skills/stats/SKILL.md',skill('stats','Copy update.'));
  await setup.publishUserSkills({copy:true});
  h.eq(await fixture.read('.agents/skills/stats/SKILL.md'),skill('stats','Copy update.'),'copy fallback resyncs changes');
  await fixture.put('.agents/skills/stats/SKILL.md','user edited vendor copy');
  await fixture.put('FluxConfig/Context/UserContext/Skills/stats/SKILL.md',skill('stats','New source.'));
  h.ok((await setup.publishUserSkills({copy:true})).checks.some(c=>/changed/.test(c.message)),'edited copy is reported');
  h.eq(await fixture.read('.agents/skills/stats/SKILL.md'),'user edited vendor copy','edited vendor copy preserved');
  await fixture.put('FluxConfig/Context/UserContext/Skills/to-delete/SKILL.md',skill('to-delete'));
  await setup.publishUserSkills({copy:true});
  await fs.rm(path.join(fixture.home,'FluxConfig/Context/UserContext/Skills/to-delete'),{recursive:true});
  const unpublished=await setup.publishUserSkills({copy:true});
  h.ok(!await fs.stat(path.join(fixture.home,'.agents/skills/to-delete')).catch(()=>null),'deleted source unpublishes unedited managed copy');
  h.ok(unpublished.backups.some(p=>p.includes('to-delete.bak-flux-')),'unpublishing managed copy reports its lossless backup');


  await fresh(); await install({ agents: ['codex'] });
  const templateDir=path.join(fixture.temp,'templates'); await fs.cp(path.resolve('resources/agent-skills/flux-connect'),templateDir,{recursive:true});
  await fs.appendFile(path.join(templateDir,'SKILL.md'),'\nUpdated template.\n');
  await fs.rm(path.join(fixture.home,'.config/flux/agent-setup.json'));
  await setup.refreshInstalledSkills({runtime:fixture.runtime,templateDir});
  h.ok((await fixture.read('.agents/skills/flux-connect/SKILL.md')).includes('Updated template.'),'managed unedited template refreshes on hash change');
  await fixture.put('.agents/skills/flux-connect/SKILL.md','user edit');
  await fs.appendFile(path.join(templateDir,'SKILL.md'),'\nAnother change.\n');
  await setup.refreshInstalledSkills({runtime:fixture.runtime,templateDir});
  h.eq(await fixture.read('.agents/skills/flux-connect/SKILL.md'),'user edit','edited managed skill never auto-rewritten');
  h.ok(!await fs.stat(path.join(fixture.home,'.claude/skills/flux-connect')).catch(()=>null),'refresh never installs new vendor skill');
  await setup.applyRemove(setup.planRemove({probe:await probe(),agents:['codex']}),{yes:true});
  await fixture.put('FluxConfig/Context/UserContext/Skills/disconnected/SKILL.md',skill('disconnected'));
  await setup.refreshInstalledSkills({runtime:fixture.runtime});
  h.ok(!await fs.stat(path.join(fixture.home,'.agents/skills/disconnected')).catch(()=>null),'edited stock skill left by remove does not reconnect the vendor');


  await fresh();
  const own = resolveOwnCliCommandsSync();
  await setup.applySetup(setup.planSetup({probe:await setup.probeAgents({runtime:own}),agents:['codex']}));
  await fixture.put('FluxConfig/Context/UserContext/Skills/new-skill/SKILL.md',skill('new-skill'));
  await ensureFluxConfig();
  h.ok(await fs.stat(path.join(fixture.home,'.agents/skills/new-skill/SKILL.md')).catch(()=>null),'ensureFluxConfig publishes for already-connected vendor');
  await fixture.put('FluxConfig/Context/UserContext/Skills/newer-skill/SKILL.md',skill('newer-skill'));
  await ensureFluxConfig();
  h.ok(await fs.stat(path.join(fixture.home,'.agents/skills/newer-skill/SKILL.md')).catch(()=>null),'ensureFluxConfig fast path still resyncs skills');

  const quoted = setup.splitCodex('[mcp_servers."flux"]\ncommand="x"\n[mcp_servers."flux".env]\nKEY="x"\n[other]\nvalue=1\n');
  h.eq(quoted.tables.length,2,'quoted TOML flux keys are recognized');
  const embedded = 'prompt = """\n# >>> flux (managed by Flux) >>>\n[mcp_servers.flux]\ncommand="example"\n# <<< flux <<<\n"""\n';
  h.eq(setup.splitCodex(embedded).outside,embedded,'markers inside multiline TOML strings are preserved');
  h.eq(setup.splitCodex(embedded).tables.length,0,'example table inside multiline string is not a registration');

  for (const electron of [false,true]) {
    const win = setup.registration({...fixture.runtime,platform:'win32',electron,cli:'C:\\Users\\A B\\flux.cmd',executable:electron?'C:\\Apps\\Flux.exe':'C:\\node.exe',args:['C:\\Apps\\resources\\app.asar.unpacked\\dist\\flux-cli.mjs']},'codex');
    h.ok(!win.command.endsWith('.cmd') && win.args[1]==='mcp','Windows MCP uses direct runtime + script, never .cmd');
    h.eq(win.env.ELECTRON_RUN_AS_NODE,electron?'1':undefined,'Windows Electron-as-Node env is conditional');
  }
  await fresh();
  const cliBefore = await tree(fixture.home);
  const entry = scope.spawn(tsxCli(), [path.resolve('flux-cli.ts'),'connect','setup','--agents','codex','--dry-run'], {env:{...process.env,FLUX_NO_MIGRATE:'1'},nodeArgs:[],deadlineMs:30000});
  await entry.closed;
  h.eq(entry.code,0,`CLI setup dry-run is intercepted before registry dispatch: ${entry.stderr}`);
  h.eq(await tree(fixture.home),cliBefore,'CLI dry-run bypasses ensureFluxConfig and writes nothing');
  h.ok(entry.stdout.includes('changes') && !entry.stdout.includes('not a project'),'CLI dry-run reports actionable paths without a project');
} catch(e) { h.fail(e instanceof Error ? e.stack || e.message : String(e)); }
await h.done(async()=>{await scope.dispose(); if(fixture)await fixture.cleanup();});
