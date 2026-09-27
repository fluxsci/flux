import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { harness } from './lib/harness.mjs';
import { installTestLauncher, rawMcp, scratchProject } from './lib/mcpFixture';
const h = harness('verify-mcp-launcher');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-launcher-'));
const launcher = await installTestLauncher(path.resolve(import.meta.dirname, '..'), path.join(temp, 'bin'));
const root = await scratchProject(path.join(temp, 'project'), 'MCP launcher');
const clients: Awaited<ReturnType<typeof rawMcp>>[] = [];
try {
  const core = await rawMcp(launcher, temp, [], { ...process.env, FLUX_MCP_TOOLSET: 'core' }); clients.push(core);
  h.eq(core.beforeHandshake, '', 'no stdout bytes before initialize');
  const initialized = await core.initialize();
  h.ok(initialized.result.instructions.includes('Connecting loads a lot of context, so do it only when asked.'), 'initialize includes exact passive instructions');
  const coreList = (await core.request('tools/list')).result;
  h.ok(Buffer.byteLength(JSON.stringify(coreList)) <= 20000, `core tools/list <=20KB (${Buffer.byteLength(JSON.stringify(coreList))} bytes)`);
  const names = coreList.tools.map(t => t.name);
  h.ok(names.includes('connect') && (names.includes('write_log') || names.includes('note')), 'connect and log-writing tool are present');
  const prompts = (await core.request('prompts/list')).result.prompts;
  h.ok(prompts.some(p => p.name === 'connect'), 'connect prompt is discoverable');
  const prompt = (await core.request('prompts/get', { name: 'connect', arguments: { target: root } })).result;
  h.ok(prompt.messages[0].content.text.includes(root), 'connect prompt carries the requested target');
  const full = await rawMcp(launcher, temp, ['--toolset', 'full'], { ...process.env, FLUX_MCP_TOOLSET: 'core' }); clients.push(full);
  await full.initialize();
  const fullNames = (await full.request('tools/list')).result.tools.map(t => t.name);
  h.ok(names.every(n => fullNames.includes(n)) && fullNames.length > names.length, 'CLI full override contains every core tool and the full surface');
  await full.call('connect', { target: root });
  for (const [verb, args] of [
    ['list_project', {}], ['list_documents', {}], ['get_manuscript', {}], ['config_paths', {}],
    ['list_decks', {}], ['list_dissections', {}], ['validate_project', {}], ['list_comments', {}],
    ['get_caption', { figureId: 'missing' }], ['set_caption', { id: 17 }],
  ] as [string, Record<string, unknown>][]) {
    const direct = await full.call(verb, args), meta = await full.call('flux_verb', { verb, args });
    h.eq(meta, direct, `${verb}: flux_verb and dedicated tool return identical results`);
  }
  const search = await core.call('flux_verbs', { query: 'rotate_elements' });
  const defs = JSON.parse(search.content[0].text);
  h.ok(defs.length === 1 && defs[0].inputSchema.properties.project, 'flux_verbs discovers non-core schema with project override');
  h.ok((await core.call('flux_verb', { verb: 'not_a_verb' })).isError, 'unknown meta verb fails');
  const index = await core.call('flux_verbs', {});
  const indexText = index.content[0].text as string;
  h.ok(Buffer.byteLength(indexText) <= 20000 && !indexText.includes('"inputSchema"'), `flux_verbs without a query is a compact index, no schemas (${Buffer.byteLength(indexText)} bytes)`);
  h.ok(/^rotate_elements — /m.test(indexText) && /^get_paper_text — /m.test(indexText), 'the index lists registry verbs and hand-written tools alike');
  h.ok(!coreList.tools.some(t => t.name === 'get_reading_context'), 'fixture premise: get_reading_context is not a core tool');
  await core.call('connect', { target: root });
  h.eq(await core.call('flux_verb', { verb: 'get_reading_context' }), await full.call('get_reading_context'), 'core flux_verb reaches a hand-written tool the core list omits, with the dedicated result');
  h.ok((await core.call('flux_verb', { verb: 'render_figure', args: {} })).isError, 'hand-written tool arguments are validated through flux_verb');
  const manualDefs = JSON.parse((await core.call('flux_verbs', { query: 'get_canvas_image' })).content[0].text);
  h.ok(manualDefs[0]?.name === 'get_canvas_image' && manualDefs[0].inputSchema.properties.project, 'flux_verbs returns hand-written tool schemas, exact name first');
  const broad = await core.call('flux_verbs', { query: 'figure' });
  h.ok(JSON.parse(broad.content[0].text).length === 15 && /more match; narrow the query/.test(broad.content[1]?.text ?? ''), 'a broad query is capped and says what it left out');
} finally { for (const c of clients) await c.close(); await fs.rm(temp, { recursive: true, force: true }); }
await h.done();
