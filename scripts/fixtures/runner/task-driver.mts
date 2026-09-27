// Fake installed CLI which really calls Flux MCP against the runner's scratch project.
import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveSpawn } from '../../../electron/execResolve.cjs';
const driver = process.argv[2], args = process.argv.slice(3);
if (args.includes('--version')) { console.log(driver === 'claude' ? '2.1.283' : 'codex-cli 0.157.1'); process.exit(0); }
if (args.includes('--help')) {
  console.log('--input-format --output-format --verbose --include-partial-messages --tools --permission-mode --permission-prompt-tool --permission-prompts --allowedTools --disallowedTools --add-dir --strict-mcp-config --mcp-config --resume --append-system-prompt --append-system-prompt-file --json --skip-git-repo-check --sandbox --cd --image --config --model --effort [PROMPT]'); process.exit(0);
}
const emit = (e: unknown) => console.log(JSON.stringify(e));
let text = '';
if (driver === 'claude') {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) { text = JSON.parse(line).message.content; lines.close(); break; }
} else for await (const chunk of process.stdin) text += chunk;
const root = process.env.FLUX_PROJECT!;
const resolved = resolveSpawn(process.env.FAKE_TASK_LAUNCHER!, ['mcp', root]);
const transport = new StdioClientTransport({ command: resolved.command, args: resolved.args, env: process.env as Record<string, string>, cwd: process.cwd(), stderr: 'pipe' });
const client = new Client({ name: driver, version: 'fixture' });
try {
  await client.connect(transport);
  const state = JSON.parse(await fs.readFile(process.env.FLUX_RUNNER_STATE!, 'utf8'));
  const itemId = JSON.parse(/assigned you inbox item ("[^"]+")/.exec(text)![1]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw Error(JSON.stringify(result));
    return result;
  };
  const tools = await client.listTools();
  await fs.appendFile(process.env.FAKE_TASK_EVIDENCE!, JSON.stringify({ cwd: process.cwd(), state, args, text, approve: tools.tools.some(t => t.name === 'approve') }) + '\n');
  if (driver === 'claude') emit({ type: 'system', subtype: 'init', session_id: 'vendor-thread', mcp_servers: [{ name: 'flux', status: 'connected' }] });
  else { emit({ type: 'thread.started', thread_id: 'vendor-thread' }); emit({ type: 'turn.started' }); }
  const claim = await call('claim_item', { id: itemId });
  if (!JSON.parse((claim.content as any[])[0].text).claimed) throw Error('Fake could not claim');
  if (text.includes('hold-task')) await new Promise(() => {});
  if (!text.includes('fallback-task')) await call('resolve_item', { id: itemId, note: `Done by ${state.name}` });
  const message = 'Final background answer';
  if (driver === 'claude') {
    emit({ type: 'assistant', message: { id: 'final', content: [{ type: 'text', text: message }] } });
    emit({ type: 'result', usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0.01 });
  } else { emit({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: message } }); emit({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } }); }
} catch (e) { console.error(e); process.exitCode = 1; }
finally { await client.close(); }
