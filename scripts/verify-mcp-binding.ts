import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { harness } from './lib/harness.mjs';
import { installTestLauncher, rawMcp, scratchProject } from './lib/mcpFixture';
import { VERBS, registerMcpVerbs, runCliVerb } from '../flux-core/registry';
import { createMcpBinding, walkProjectRoot } from '../flux-core/mcpBinding';
import { ensureProjectContext } from '../flux-core/context';
import { bridgeAvailable } from '../flux-core/liveClient';
const h = harness('verify-mcp-binding');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-binding-')));
const launcher = await installTestLauncher(path.resolve(import.meta.dirname, '..'), path.join(temp, 'bin'));
const a = await scratchProject(path.join(temp, 'A'), 'Project A'), b = await scratchProject(path.join(temp, 'B'), 'Project B');
const env = { ...process.env, FLUX_MCP_TOOLSET: 'full' };
for (const key of ['FLUX_PROJECT', 'FLUX_CLIENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'GEMINI_CLI']) delete env[key];
const clients: Awaited<ReturnType<typeof rawMcp>>[] = [];
const textOf = r => r.content.find(c => c.type === 'text')?.text ?? '';
try {
  const c = await rawMcp(launcher, temp, [], env); clients.push(c); await c.initialize('claude-code');
  const unbound = await c.call('list_project');
  h.ok(unbound.isError && textOf(unbound).includes("No Flux project connected. Call connect("), 'unbound project tool returns NotConnectedError');
  h.ok(!(await c.call('config_paths')).isError, 'machine tool works unbound');
  h.ok(!(await c.call('connect')).isError && (await c.call('list_project')).isError, 'omitted target outside a project connects globally without binding');
  h.eq(JSON.parse(textOf(await c.call('list_project', { project: a }))).title, 'Project A', 'unbound call accepts an absolute project');
  h.ok((await c.call('ensure_context')).isError && !await fs.stat(path.join(temp, 'Context')).catch(() => null), 'unbound ensure_context cannot scaffold cwd');
  await c.call('connect', { target: a });
  h.eq(JSON.parse(textOf(await c.call('list_project'))).title, 'Project A', 'explicit connect binds A');
  h.eq(JSON.parse(textOf(await c.call('list_project', { project: b }))).title, 'Project B', 'absolute per-call override selects B');
  h.eq(JSON.parse(textOf(await c.call('list_project', { project: '../B' }))).title, 'Project B', 'relative project override resolves against A');
  h.eq(JSON.parse(textOf(await c.call('list_project'))).title, 'Project A', 'override leaves default bound to A');
  h.ok((await c.call('connect', { target: path.join(temp, 'missing') })).isError, 'invalid connect fails');
  h.eq(JSON.parse(textOf(await c.call('list_project'))).title, 'Project A', 'failed connect preserves the prior binding');
  await fs.mkdir(path.join(a, 'plots'), { recursive: true });
  await fs.writeFile(path.join(a, 'plots', 'binding.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>');
  const composed = await c.call('compose_figure', { plotPaths: ['plots/binding.svg'], id: 'binding-figure' });
  h.ok(!composed.isError, `real compose_figure reads root-relative plotPaths from a different server cwd: ${textOf(composed)}`);
  h.ok((await c.call('ensure_context', { project: temp })).isError && !await fs.stat(path.join(temp, 'Context')).catch(() => null), 'project guard runs before heal writes');
  let rejected = false; try { await ensureProjectContext(temp, { title: 'bypass' }); } catch { rejected = true; }
  h.ok(rejected && !await fs.stat(path.join(temp, 'Context')).catch(() => null), 'direct heal guard also applies with a prepared title');
  const list = (await c.request('tools/list')).result.tools.map(t => t.name);
  const log = list.includes('write_log') ? 'write_log' : 'note';
  const written = await c.call(log, { text: 'identity proof', title: 'MCP identity' });
  h.ok(!written.isError, 'log-writing tool executes');
  const journal = (await fs.readFile(path.join(a, '.meta', 'journal.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  h.eq(journal.at(-1).client, 'claude-code', 'handshake clientInfo stamps the journal identity');
  await c.call('connect', { target: 'global' });
  h.eq(JSON.parse(textOf(await c.call('list_project'))).title, 'Project A', 'global connect preserves an existing project binding');
  h.eq(JSON.parse(textOf(await c.call('list_project', { project: a }))).title, 'Project A', 'per-call project still works after global connect');
  const child = path.join(a, 'nested', 'cwd'); await fs.mkdir(child, { recursive: true });
  const auto = await rawMcp(launcher, child, [], env); clients.push(auto); await auto.initialize('codex');
  h.eq(JSON.parse(textOf(await auto.call('list_project'))).title, 'Project A', 'cwd walk-up supplies default root');
  h.ok(!await fs.stat(path.join(a, '.meta', 'live', 'sessions')).catch(() => null), 'auto-binding creates no connected presence');
  const explicit = await createMcpBinding(a, { FLUX_PROJECT: b }, temp);
  h.eq(explicit.bound, a, 'explicit startup root takes precedence over FLUX_PROJECT');
  h.eq((await createMcpBinding(undefined, { FLUX_PROJECT: b }, child)).bound, b, 'FLUX_PROJECT takes precedence over cwd');
  const deep = path.join(a, ...Array.from({ length: 8 }, (_, i) => `d${i}`)); await fs.mkdir(deep, { recursive: true });
  h.eq(await walkProjectRoot(deep), null, 'walk-up is bounded to eight levels');

  // Exercise every declared path through SDK validation and the actual dispatcher;
  // only the final operation is replaced by a spy so no export/network is needed.
  const server = new McpServer({ name: 'path-policy', version: '1' });
  registerMcpVerbs(server, async () => a, { toolset: 'full', defaultRoot: () => a });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const sdk = new Client({ name: 'path-policy', version: '1' });
  await server.connect(st); await sdk.connect(ct);
  function sample(schema: z.ZodTypeAny): unknown {
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) return sample(schema._def.innerType);
    if (schema instanceof z.ZodString) return 'fixture';
    if (schema instanceof z.ZodNumber) return 1;
    if (schema instanceof z.ZodBoolean) return false;
    if (schema instanceof z.ZodEnum) return schema.options[0];
    if (schema instanceof z.ZodLiteral) return schema.value;
    if (schema instanceof z.ZodArray) return [sample(schema.element)];
    if (schema instanceof z.ZodObject) return Object.fromEntries(Object.entries(schema.shape).filter(([, v]) => !(v as z.ZodTypeAny).isOptional()).map(([k, v]) => [k, sample(v as z.ZodTypeAny)]));
    if (schema instanceof z.ZodUnion) return sample(schema.options[0]);
    return {};
  }
  try {
    for (const v of VERBS.filter(v => Object.keys(v.pathParams ?? {}).length)) {
      const args = sample(z.object(v.params)) as Record<string, any>;
      for (const [key, kind] of Object.entries(v.pathParams!)) {
        let obj = args; const parts = key.split('.');
        for (const part of parts.slice(0, -1)) obj = obj[part] ||= {};
        obj[parts.at(-1)!] = kind === 'paths' ? ['relative.svg', path.join(temp, 'absolute.svg')] : 'relative.svg';
      }
      const original = v.handler, render = v.render;
      try {
        v.handler = (_ctx, input) => input; v.render = undefined;
        const reply = await sdk.callTool({ name: v.name, arguments: args });
        h.ok(!reply.isError, `${v.name}: declared path inputs pass real MCP schema validation`);
        if (reply.isError) continue;
        const resolved = JSON.parse(textOf(reply));
        for (const [key, kind] of Object.entries(v.pathParams!)) {
          const value = key.split('.').reduce((o, k) => o[k], resolved);
          h.eq(value, kind === 'paths' ? [path.join(a, 'relative.svg'), path.join(temp, 'absolute.svg')] : path.join(a, 'relative.svg'), `${v.name}.${key}: root-relative MCP resolution; absolutes preserved`);
        }
      } finally { v.handler = original; v.render = render; }
    }
    const v = VERBS.find(v => v.name === 'compose_figure')!, handler = v.handler, render = v.render, cwd = process.cwd();
    try {
      v.handler = (_ctx, args) => args; v.render = undefined; process.chdir(temp);
      let output = '', exit = 0;
      await runCliVerb(v.cli, { pos: ['relative.svg'], posRooted: ['relative.svg'], flags: {}, rootFlags: a, rootPositional: a }, { log: s => output = s, err: s => output = s, setExit: n => exit = n });
      h.ok(exit === 0 && JSON.parse(output).plotPaths[0] === path.join(temp, 'relative.svg'), 'CLI twin resolves filesystem inputs against cwd, not root');
    } finally { process.chdir(cwd); v.handler = handler; v.render = render; }
  } finally { await sdk.close(); await server.close(); }

  const alias = path.join(temp, 'alias'); await fs.symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const http = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: req.headers.authorization === 'Bearer fixture', root: a })); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const port = (http.address() as { port: number }).port;
    await fs.mkdir(path.join(a, '.meta', 'live'), { recursive: true });
    await fs.writeFile(path.join(a, '.meta', 'live', 'bridge.json'), JSON.stringify({ root: a, port, url: `http://127.0.0.1:${port}`, token: 'fixture' }));
    h.ok(await bridgeAvailable(alias), 'live bridge accepts a symlink alias of the same real root');
    await fs.writeFile(path.join(a, '.meta', 'live', 'bridge.json'), JSON.stringify({ root: b, port, url: `http://127.0.0.1:${port}`, token: 'fixture' }));
    h.ok(!await bridgeAvailable(a), 'live bridge still rejects a different real root');
  } finally { await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())); }
} finally { for (const c of clients) await c.close(); await fs.rm(temp, { recursive: true, force: true }); }
await h.done();
