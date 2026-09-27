import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TestProcessScope } from './testProcess.mjs';
import { resolveSpawn } from '../../electron/execResolve.cjs';
import { installLaunchers, resolveOwnCliCommandsSync } from '../../electron/fluxPaths.cjs';

export async function installTestLauncher(repo: string, binDir: string) {
  const runtime = resolveOwnCliCommandsSync({ appRoot: repo, binDir, nodePath: process.execPath, packaged: false, appImage: '' });
  const saved = process.env.FLUX_NO_MIGRATE;
  try { delete process.env.FLUX_NO_MIGRATE; await installLaunchers([], { runtime }); }
  finally { if (saved === undefined) delete process.env.FLUX_NO_MIGRATE; else process.env.FLUX_NO_MIGRATE = saved; }
  return runtime.cli;
}

/** Raw newline JSON-RPC, with owned processes and deadlines on every response. */
export async function rawMcp(launcher: string, cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const scope = new TestProcessScope();
  const resolved = resolveSpawn(launcher, ['mcp', ...args]);
  const entry = scope.spawn(resolved.args[0], resolved.args.slice(1), { command: resolved.command, windowsVerbatimArguments: resolved.windowsVerbatimArguments, nodeArgs: [], cwd,
    env: { ...env, FLUX_NO_MIGRATE: '1' }, deadlineMs: 120000 });
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  const unsolicited: unknown[] = [];
  let sequence = 0, buffer = '', protocolError: Error | undefined;
  entry.child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line), waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); waiter.resolve(message); } else unsolicited.push(message);
      } catch { protocolError = new Error(`Non-protocol stdout: ${line}`); for (const w of pending.values()) w.reject(protocolError); }
    }
  });
  entry.closed.then(() => { for (const w of pending.values()) w.reject(new Error(`MCP exited: ${entry.stderr}`)); });
  try {
    // Server readiness is on stderr; stdout must remain entirely empty until initialize.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP startup timeout: ${entry.stderr}`)), 30000);
      const ready = () => { if (entry.stderr.includes('flux MCP server on stdio')) { clearTimeout(timer); entry.child.stderr.off('data', ready); resolve(); } };
      entry.child.stderr.on('data', ready); ready();
      entry.closed.then(() => { clearTimeout(timer); reject(new Error(`MCP exited before ready: ${entry.stderr}`)); });
    });
  } catch (e) { await scope.dispose(); throw e; }
  const beforeHandshake = entry.stdout;
  async function request(method: string, params: unknown = {}) {
    if (protocolError) throw protocolError;
    const id = ++sequence;
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${entry.stderr}`)); }, 30000);
      pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
      entry.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return { beforeHandshake, unsolicited, entry, request,
    async initialize(name = 'verify', version = '1') {
      const reply = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version } });
      entry.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return reply;
    },
    async call(name: string, args: Record<string, unknown> = {}) { return (await request('tools/call', { name, arguments: args })).result; },
    close: () => scope.dispose(),
  };
}

export async function scratchProject(root: string, title: string) {
  const core = await import('../../flux-core/index');
  await core.scaffold(root, { title });
  return await fs.realpath(path.resolve(root));
}
