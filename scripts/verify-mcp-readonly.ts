import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { harness } from './lib/harness.mjs';
import { installTestLauncher, rawMcp, scratchProject } from './lib/mcpFixture';
const h = harness('verify-mcp-readonly');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-readonly-'));
const launcher = await installTestLauncher(path.resolve(import.meta.dirname,'..'),path.join(temp,'bin'));
const root = await scratchProject(path.join(temp,'project'),'Read-only Ask');
const clients: Awaited<ReturnType<typeof rawMcp>>[]=[];
try {
  const original=await fs.readFile(path.join(root,'project.json'),'utf8');
  for(const toolset of ['core','full']) {
    const client=await rawMcp(launcher,root,[root,'--toolset',toolset],{...process.env,FLUX_MCP_READONLY:'1',FLUX_RUNNER_TOKEN:'must-not-enable-approve',FLUX_CLIENT:'fluxchat',FLUX_PROJECT:root});clients.push(client);await client.initialize();
    const tools=(await client.request('tools/list')).result.tools;
    h.ok(tools.length>10&&tools.every(t=>t.annotations?.readOnlyHint===true),`${toolset}: real server lists only annotated read-only tools`);
    h.ok(tools.some(t=>t.name==='flux_verb')&&!tools.some(t=>['approve','set_caption','dispatch_command','write_log','fetch_pdfs'].includes(t.name)),`${toolset}: writes absent; guarded meta dispatcher present`);
    for(const verb of ['set_caption','write_log','dispatch_command','organize_paper','fetch_pdfs']) {
      const r=await client.call('flux_verb',{verb,args:{}});
      h.ok(r.isError&&r.content.some(c=>c.text?.includes('Read-only Flux session refuses')),`${toolset}: ${verb} refused BEFORE validation/handler`);
    }
    const read=await client.call('flux_verb',{verb:'list_documents',args:{}});
    h.ok(!read.isError,`${toolset}: read through generic dispatch still works`);
    const index=(await client.call('flux_verbs',{})).content.map(c=>c.text??'').join('');
    h.ok(!/^dispatch_command — /m.test(index)&&!/^set_caption — /m.test(index)&&/^get_paper_text — /m.test(index),`${toolset}: discovery index respects same restriction`);
  }
  h.eq(await fs.readFile(path.join(root,'project.json'),'utf8'),original,'write refusals preserve manifest bytes');
}finally{for(const c of clients)await c.close();await fs.rm(temp,{recursive:true,force:true});}
await h.done();
