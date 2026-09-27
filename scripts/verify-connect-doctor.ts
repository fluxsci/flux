import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { harness } from './lib/harness.mjs';
import { agentFixture, tree } from './lib/agentSetupFixture';
import * as setup from '../electron/agentSetup.cjs';
import { rawMcp, installTestLauncher } from './lib/mcpFixture';
const h = harness('verify-connect-doctor'), fixture = await agentFixture();
async function checks() { return setup.doctor({runtime:fixture.runtime}); }
async function expectCheck(id:string,status:string,label:string) {
  const found = (await checks()).find(c=>c.id===id && c.status===status);
  h.ok(!!found,label); if(status!=='ok')h.ok(!!found?.fix,`${id}: diagnostic includes a fix`);
}
try {
  const before = await tree(fixture.home);
  const missing = await checks();
  h.ok(missing.some(c=>c.id==='launcher'&&c.status==='fail'),'missing launcher fails');
  h.ok(missing.some(c=>c.id==='claude.skill'&&c.status==='warn'),'missing skill warns');
  h.ok(missing.some(c=>c.id==='codex.mcp'&&c.status==='fail'),'missing Codex MCP fails');
  h.eq(await tree(fixture.home),before,'doctor does not initialize Flux or vendor state');
  await setup.applySetup(setup.planSetup({probe:await setup.probeAgents({runtime:fixture.runtime})}));
  await expectCheck('launcher','ok','launcher executes matching build');
  await expectCheck('mcp','ok','MCP initializes and lists >=100 full tools');
  await expectCheck('rendering','ok','tiny SVG renders through real out-of-process resvg');
  await expectCheck('codex.hook','ok','Codex installed prompt hook is diagnosed');
  await expectCheck('claude.hook','ok','Claude installed prompt hook is diagnosed');
  await expectCheck('context.user','warn','empty UserContext warns');
  const clean = await tree(fixture.home); await checks(); h.eq(await tree(fixture.home),clean,'healthy doctor leaves all user files unchanged');
  await fixture.put('.agents/skills/flux-connect/SKILL.md','edited');
  await expectCheck('codex.skill','warn','edited managed skill warns');
  await fixture.put('.claude/settings.json','{"hooks":{"UserPromptSubmit":[]}}');
  await expectCheck('claude.hook','fail','missing refresh hook fails');
  await fixture.put('.codex/config.toml',(await fixture.read('.codex/config.toml')).replace('tool_timeout_sec = 3600','tool_timeout_sec = 30'));
  await expectCheck('codex.mcp','fail','incorrect MCP timeout fails');
  await fixture.put('.codex/config.toml',(await fixture.read('.codex/config.toml'))+'\n[mcp_servers.flux]\ncommand="duplicate"\n');
  await expectCheck('codex.mcp','fail','duplicate unmanaged MCP table fails');
  await fixture.put('.claude.json','{"mcpServers":{"flux":{"command":"/missing/flux","args":["mcp"]}}}');
  await expectCheck('claude.mcp','fail','dangling/mismatched Claude registration fails');
  process.env.FAKE_MCP_CASE='noise'; await expectCheck('mcp','fail','unsolicited MCP stdout fails');
  process.env.FAKE_MCP_CASE='missing'; await expectCheck('mcp','fail','missing connect tool fails');
  delete process.env.FAKE_MCP_CASE;
  await fixture.put('FluxConfig/Context/UserContext/Skills/bad/SKILL.md','---\nname: mismatch\n---\n');
  await expectCheck('context.skill.bad','warn','invalid user skill diagnosed');
  await fixture.put('.config/flux/projects.json','{"v":1,"projects":[{"root":"/definitely-missing","title":"Gone"}]}');
  await expectCheck('projects','warn','missing recorded project root warns');
  await fixture.put('.config/flux/projects.json','not json');
  await expectCheck('projects','fail','unreadable projects JSON fails');
  const all = await checks();
  h.ok(!all.some(c=>/legacy|pre-neutral/.test(c.id+' '+c.message)),'doctor contains no legacy layout checks');
  const real = await installTestLauncher(path.resolve('.'),path.join(fixture.temp,'real-bin'));
  const mcp = await rawMcp(real,fixture.home);
  try {
    await mcp.initialize();
    const listed = (await mcp.request('tools/list')).result.tools;
    const tool = listed.find((t:{name:string})=>t.name==='connect_doctor');
    h.ok(!!tool && tool.annotations.readOnlyHint,'connect_doctor is a read-only core tool');
    h.ok(!listed.some((t:{name:string})=>/connect_(setup|remove)/.test(t.name)),'no MCP setup or remove tools');
    const report = await mcp.call('connect_doctor');
    h.ok(Array.isArray(report.structuredContent?.checks),'MCP doctor returns per-check structured diagnostics without binding a project');
    const unknown = await mcp.call('connect_doctor',{checkReceipt:{packId:'sample',proof:[]}});
    h.ok(unknown.isError && /No flux-connect pack "sample"/.test(unknown.content[0].text),'a receipt for a pack that is not on this machine is refused, never claimed verified');
    const { scratchProject } = await import('./lib/mcpFixture');
    const { proofCode } = await import('../flux-core/connect/codes');
    const project = await scratchProject(path.join(fixture.home, 'receipt-project'), 'Receipt');
    const packed = await mcp.call('connect',{target:project,noRender:true});
    const { packId } = packed.structuredContent as { packId: string };
    const codes = ['A','B','C','D','E','F','G','H'].map(s=>proofCode(packId,`section:${s}`));
    const good = await mcp.call('connect_doctor',{checkReceipt:{packId,proof:codes}});
    h.ok(!good.isError && good.structuredContent?.receipt?.complete === true,'the doctor confirms a complete receipt against the pack');
    const short = await mcp.call('connect_doctor',{checkReceipt:{packId,proof:codes.slice(0,3).join(' ')}});
    h.ok(short.structuredContent?.receipt?.complete === false && short.structuredContent.receipt.sections.filter((x:{ok:boolean})=>!x.ok).length === 5,'…and names the sections an incomplete receipt missed');
  } finally { await mcp.close(); }
} catch(e){h.fail(e instanceof Error?e.stack||e.message:String(e));}
await h.done(fixture.cleanup);
