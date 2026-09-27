// Current user-facing surfaces only; historical records and migration fixtures
// deliberately stay outside this census (overhaul §10.5, owner ruling 1).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { harness } from './lib/harness.mjs';
import { scan, scannedFile, type Hit } from './lib/retiredAgentScan';
import { installTestLauncher, rawMcp } from './lib/mcpFixture';
import { TestProcessScope } from './lib/testProcess.mjs';
import { resolveSpawn } from '../electron/execResolve.cjs';

const h = harness('verify-no-retired-agent-layer'), repo = path.resolve(import.meta.dirname, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-remnants-'));
const scope = new TestProcessScope();
const hits: Hit[] = [];
async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(repo, dir), { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))).flat();
}
try {
  h.section('scanner controls');
  h.eq(scan('sample.md', 'Flux principal; FLUX DISPATCH; Flux attend; Flux agents; principal component; dispatch_command'), [], 'case-sensitive commands and homophones stay permitted');
  h.eq(scan('sample.md', 'flux principal; flux dispatch; flux attend; flux agents').length, 4, 'lowercase retired commands fail');
  h.eq(scan('sample.md', 'PRINCIPAL.MD; Workers.md; AGENTS-config.md; AGENTS.JSON; PRINCIPAL AGENT; dispatched worker; Add & send; review\npass; Context/Transcripts; context/dispatches; Project/MISSION.qmd; Snapshot & annotate; Note to agent; flux NOTE; flux feedback; add-annotation; LIST_ANNOTATIONS; SYNCTHING').length, 18, 'every case-insensitive token fails, including wrapped prose');
  const ui = `<script lang="ts">\n// flux principal\n/* agents.json */\nconst principal = /Syncthing/;\nconst label: string = "flux note";\nconst tip = \`First\nreview pass\`;\n</script>\n<!-- Note to agent -->\n<button title="Snapshot &amp; annotate">Add &amp; send</button>\n<style>/* Syncthing */ button { color: red }</style>`;
  h.eq(scan('sample.svelte', ui).map(x => [x.line, x.token]), [[5, 'flux note'], [7, 'review pass'], [10, 'Add & send'], [10, 'Snapshot & annotate']], 'Svelte strings and markup decode entities; comments, regexes, identifiers and CSS are excluded');
  h.eq(scan('sample.ts', '// Syncthing\nconst x = `line\\nflux note\nflux feedback ${"add-annotation"}`;').map(x => [x.line, x.token]), [[2, 'flux note'], [3, 'add-annotation'], [3, 'flux feedback']], 'TypeScript templates retain physical source lines and interpolation literals');
  h.eq(scan('sample.svelte', '<script>const x = `value ${1}: flux note`; const y = "\\u0053yncthing";</script>\n<p>{`flux feedback ${x}`}</p>').map(x => [x.line, x.token]), [[1, 'flux note'], [1, 'Syncthing'], [2, 'flux feedback']], 'Svelte template expressions and escaped literals are included');
  for (const file of ['docs/AGENT_ENGINEERING_GUIDE-RUNNING.md', 'docs/V020_HISTORY.qmd', 'docs/for_agents/migrate-to-flux-connect.md', 'scripts/oneoff/migrate.mjs', 'scripts/fixtures/old.svelte', 'artifacts/old.qmd', '.git/history']) h.ok(!scannedFile(file), `excluded: ${file}`);

  h.section('current source and documentation');
  const files = ['README.md', 'electron/fluxContextDocs.gen.cjs', ...(await Promise.all(['docs', 'resources/flux-context', 'resources/agent-skills', 'src'].map(walk))).flat()].filter(scannedFile).sort();
  for (const file of files) hits.push(...scan(file, await fs.readFile(path.join(repo, file), 'utf8')));
  // Moved intact from R3: this retired IPC is functionality, not a word census.
  hits.push(...scan('electron/ipc/contract.cjs', await fs.readFile(path.join(repo, 'electron/ipc/contract.cjs'), 'utf8'), ['agent:principalSpec']));
  h.ok(files.length > 100, `scanned ${files.length} current files`);

  h.section('running CLI help and both real MCP toolsets');
  const launcher = await installTestLauncher(repo, path.join(scratch, 'bin'));
  const env = { ...process.env, FLUX_NO_MIGRATE: '1' };
  for (const key of ['FLUX_PROJECT', 'FLUX_MCP_TOOLSET', 'FLUX_MCP_READONLY']) delete env[key];
  const command = resolveSpawn(launcher, ['help']);
  const help = scope.spawn(command.args[0], command.args.slice(1), { command: command.command, windowsVerbatimArguments: command.windowsVerbatimArguments, nodeArgs: [], cwd: scratch, env });
  await scope.waitExit(help);
  h.eq(help.code, 0, `CLI help exits cleanly: ${help.stderr}`);
  h.ok(help.stdout.includes('connect') && help.stdout.length > 100, 'CLI returns actual help');
  hits.push(...scan('<flux help>', help.stdout));
  const counts: number[] = [];
  for (const toolset of ['core', 'full']) {
    const client = await rawMcp(launcher, scratch, ['--toolset', toolset], env);
    try {
      h.eq((await client.initialize()).result?.serverInfo?.name, 'flux', `${toolset}: real server initializes`);
      const result = await client.request('tools/list');
      if (!Array.isArray(result.result?.tools)) throw new Error(`tools/list failed: ${JSON.stringify(result)}`);
      const tools = result.result.tools;
      h.ok(tools.some((t: any) => t.name === 'connect'), `${toolset}: tool list contains connect`);
      counts.push(tools.length);
      hits.push(...scan(`<mcp tools/list ${toolset}>`, JSON.stringify(tools, null, 2)));
      client.entry.child.stdin.end();
      await client.entry.closed;
    } finally { await client.close(); }
  }
  h.ok(counts[0] > 0 && counts[1] > counts[0], `both toolsets scanned (${counts.join(' / ')} tools)`);
} catch (e) { h.fail(e instanceof Error ? e.stack : String(e)); }
for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.token}`);
h.eq(hits.length, 0, 'no retired agent layer on current surfaces');
await h.done(async () => { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); });
