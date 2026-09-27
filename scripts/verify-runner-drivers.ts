import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { harness } from './lib/harness.mjs';
import { keptAskEvents, askPacket } from '../src/lib/project/ask';
import { foldAnnotations, annotationThread } from '../src/lib/project/annotations';
const require = createRequire(import.meta.url);
const { createAgentRunner, pruneRuns } = require('../electron/agentRunner.cjs');
const claude = require('../electron/runnerDrivers/claude.cjs'), codex = require('../electron/runnerDrivers/codex.cjs');
const { installFakeRunner } = require('./lib/runnerFixture.cjs');
const h = harness('verify-runner-drivers');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
const fixtures = path.join(import.meta.dirname, 'fixtures/runner');
const wait = async (check: () => boolean | Promise<boolean>, label: string) => {
  const end = Date.now() + 15000;
  while (!await check()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 20)); }
};
const runners: any[] = [];
try {
  for (const [name, driver, expected] of [['claude-pong', claude, 'pong'], ['claude-read', claude, 'fixture file contents: 42'], ['claude-denied', claude, null], ['codex-pong', codex, 'pong'], ['codex-cat', codex, 'fixture file contents: 42'], ['codex-resume', codex, 'resumed'], ['codex-mcp', codex, null], ['codex-mcp-ro', codex, '12']] as const) {
    const events: any[] = [], parse = driver.parser((e: any) => events.push(e));
    for (const line of (await fs.readFile(path.join(fixtures, name + '.jsonl'), 'utf8')).trim().split('\n')) parse(JSON.parse(line));
    h.ok(events.some(e => e.type === 'session') && events.some(e => e.type === 'status' && e.state === 'idle'), `${name}: session and completion`);
    if (expected) h.ok(events.some(e => e.type === 'message' && e.text === expected), `${name}: complete text envelope`);
    h.ok(events.some(e => e.type === 'usage' && e.inputTokens >= 0 && e.outputTokens >= 0), `${name}: usage`);
    if (name === 'claude-read') h.ok(events.some(e => e.type === 'tool' && e.input.file_path === '<CWD>/hello.txt' && e.status === 'done'), 'Claude tool result retains actual Read input');
    if (name === 'codex-cat') h.ok(events.some(e => e.type === 'tool' && e.input.includes('cat hello.txt') && e.status === 'done'), 'Codex shows actual command');
    if (name === 'codex-mcp') h.ok(events.some(e => e.type === 'tool' && e.status === 'failed' && JSON.stringify(e.output).includes('approval')), 'Codex denied MCP is a failed tool');
    if (name === 'codex-mcp-ro') h.ok(events.some(e => e.type === 'tool' && e.title === 'flux.connect_doctor' && e.status === 'done'), 'Codex read-only MCP succeeds');
  }
  const events: any[] = [], parse = claude.parser((e: any) => events.push(e));
  parse({ type: 'system', subtype: 'init', session_id: 'sid', apiKeySource: 'none', slash_commands: [], mcp_servers: [] });
  h.ok(events.some(e => e.reason?.includes('Repair')) && !events.some(e => e.fatal), 'missing MCP warns; empty skills and apiKeySource:none are not bare evidence');
  parse({ type: 'system', subtype: 'init', bare: true });
  h.ok(events.some(e => e.fatal && e.message.includes('bare mode')), 'explicit bare mode fails with guidance');
  const cc = claude.capabilities('v1', '--input-format --output-format --verbose --include-partial-messages --permission-mode --permission-prompts --disallowedTools --strict-mcp-config --mcp-config --resume --append-system-prompt');
  h.ok(cc.available && !cc.promptFile && !claude.capabilities('old','').available, 'Claude caps require safe flags and support prompt-text fallback');
  h.ok(!codex.capabilities('old', '--json', '').available, 'Codex missing flags disable driver');
  const o = { caps: cc, packText: 'PACK', packPath: '/pack', mcpPath: '/mcp', launcher: '/flux', root: '/project', cwd: '/project', model: 'model', effort: 'high', resume: 'thread', images: ['/a.png','/b.png'] };
  const a = claude.args(o), c = codex.args(o);
  h.eq(a.slice(a.indexOf('--disallowedTools')), ['--disallowedTools','Bash','Edit','Write','NotebookEdit'], 'Claude deny list last, no positional prompt');
  h.ok(a.includes('dontAsk') && a[a.indexOf('--permission-prompts')+1] === 'none' && a.includes('--strict-mcp-config') && a.includes('PACK'), 'Claude safe profile and fallback pack');
  h.ok(JSON.parse(claude.turn('QUESTION',['/a.png'])).message.content.includes('/a.png'), 'Claude image fallback asks Read on exact PNG path');
  h.eq(c.slice(-2), ['--','-'], 'Codex images end before stdin sentinel');
  h.ok(c.includes('resume') && c[c.indexOf('resume')+1] === 'thread' && !c.includes('-C') && !c.includes('-s'), 'Codex resume respects its smaller argument grammar');
  h.ok(c.includes('mcp_servers={}') && c.some((x:string) => x.includes('FLUX_MCP_READONLY="1"')) && c.includes('approval_policy="never"') && c.includes('sandbox_mode="read-only"'), 'Codex replaces all MCP servers and keeps read-only approval profile');
  h.ok(codex.args({...o,resume:undefined}).includes('-s'), 'new Codex turn uses read-only sandbox flag');
  h.eq(codex.turn('next','PACK',true),'next','resume does not prepend pack twice');
  const bin = await installFakeRunner(path.join(temp,'bin'));
  const root = path.join(temp,'project'); await fs.mkdir(root); await fs.writeFile(path.join(root,'project.json'),'{}');
  const log = path.join(temp,'invocations.jsonl'), pidFile = path.join(temp,'descendant.pid');
  const env = { ...process.env, SHELL: '/missing-login-shell', FAKE_RUNNER_LOG:log, FAKE_RUNNER_PID:pidFile };
  const received: any[] = [];
  const runner = createAgentRunner({userDataDir:path.join(temp,'config'),launcher:bin.flux,binaries:bin,env,idleMs:120,killGraceMs:30,emit:(owner:any,e:any)=>received.push({...e,owner})}); runners.push(runner);
  h.ok((await runner.capabilities()).every((c:any)=>c.available),'fake --help and --version detect both installed drivers');
  const before = (await fs.readFile(log,'utf8')).split('\n').filter(s=>s.includes('--help')).length;
  const runner2 = createAgentRunner({userDataDir:path.join(temp,'config'),launcher:bin.flux,binaries:bin,env,emit:()=>{}}); runners.push(runner2);
  await runner2.capabilities();
  h.eq((await fs.readFile(log,'utf8')).split('\n').filter(s=>s.includes('--help')).length,before,'capability cache reuses help per binary version across instances');
  for (const driver of ['claude','codex']) {
    const {runId}=await runner.start(7,{driver,mode:'ask',root,firstMessage:'question'});
    await wait(()=>received.some(e=>e.runId===runId&&e.state==='idle'), driver+' first response');
    const initial=received.filter(e=>e.runId===runId);
    h.ok(initial.some(e=>e.type==='message') && initial.every((e,i)=>e.seq===i+1), `${driver}: real fake process produces monotonic normalized events`);
    const idleCount=()=>received.filter(e=>e.runId===runId&&e.state==='idle').length;
    if(driver==='claude')await wait(()=>received.some(e=>e.runId===runId&&e.reason?.includes('sleeping')),'Claude idle exit');
    const count=idleCount();
    await runner.send(7,{runId,text:'follow up'});
    await wait(()=>idleCount()>count,driver+' resumed response');
    const calls=(await fs.readFile(log,'utf8')).trim().split('\n').map(s=>JSON.parse(s)).filter(e=>e.name===driver&&e.args&&!e.args.includes('--help')&&!e.args.includes('--version'));
    h.ok(calls.at(-1).args.includes(driver==='claude'?'--resume':'resume'), `${driver}: resumed subprocess argv`);
    let denied=false;try{runner.cancel(8,{runId});}catch{denied=true}h.ok(denied,'other window cannot cancel');
    runner.cancel(7,{runId});
    const raw=await fs.readFile(path.join(temp,'config','runs',runId+'.jsonl'),'utf8');
    h.ok(raw.includes('stdout')&&!await fs.readdir(root).then(es=>es.includes('runs')), `${driver}: raw log machine-local only`);
  }
  const held=[];
  for(let i=0;i<4;i++)held.push(await runner.start(9,{driver:'codex',mode:'ask',root,firstMessage:'hold-process-tree'}));
  await wait(()=>received.some(e=>e.runId===held[3].runId&&e.reason?.includes('Queued')),'fourth run queues');
  const trees=()=>fs.readFile(pidFile,'utf8').then(s=>s.trim().split('\n').map(s=>JSON.parse(s))).catch(()=>[]);
  await wait(async()=>(await trees()).length===3,'three process trees started');
  const descendants=(await trees()).flatMap(t=>[t.parent,t.child]);
  // Cancel the queued run first: it must never reach a subprocess.
  for(const run of [...held].reverse())runner.cancel(9,run);
  const alive=async(pid:number)=>{
    try{process.kill(pid,0);if(process.platform==='linux'){const s=await fs.readFile(`/proc/${pid}/stat`,'utf8').catch(()=> '');return !!s&&!/\) Z /.test(s)}return true}catch{return false}
  };
  await wait(async()=>(await Promise.all(descendants.map(alive))).every(x=>!x),'all process trees reaped');
  h.ok((await Promise.all(descendants.map(alive))).every(x=>!x),'cancel kills every process group, including TERM-resistant descendants');
  h.eq((await trees()).length,3,'cancelled fourth run never spawns');
  const prewarm=await runner.start(10,{driver:'claude',mode:'ask',root,firstMessage:''});
  await runner.send(10,{runId:prewarm.runId,text:'question before preparation completes'});
  await wait(()=>received.some(e=>e.runId===prewarm.runId&&e.state==='idle'),'send races prewarm');
  h.ok(received.some(e=>e.runId===prewarm.runId&&e.type==='message'),'early send survives asynchronous prewarm');
  runner.cancel(10,prewarm);
  const disposal=await runner.start(11,{driver:'codex',mode:'ask',root,firstMessage:'hold-process-tree'});
  await wait(async()=>(await trees()).length===4,'process tree before shutdown');
  const shutdownTree=(await trees()).at(-1);
  await runner.dispose();
  await wait(async()=>!await alive(shutdownTree.parent)&&!await alive(shutdownTree.child),'shutdown tree reaped');
  h.ok(received.some(e=>e.runId===disposal.runId&&e.state==='cancelled'),'shutdown cancels runs and kills trees without relying on a grace timer');
  const old=path.join(temp,'config','runs','00000000-0000-0000-0000-000000000000.jsonl');await fs.writeFile(old,'{}');const date=new Date(Date.now()-31*86400000);await fs.utimes(old,date,date);await pruneRuns(path.dirname(old));
  h.ok(!await fs.stat(old).then(()=>true).catch(()=>false),'raw runs pruned after 30 days');
  const context={surface:'figure',targets:[{kind:'figure' as const,figureId:'fig-1',name:'Figure 1'}]};
  const kept=keptAskEvents([{role:'human',text:'Question'},{role:'agent',text:'Answer'},{role:'human',text:'Why?'},{role:'agent',text:'Because'}],context,'Claude Code');
  const [item]=foldAnnotations(kept).items;
  h.ok(item.resolved&&item.note.text==='Question'&&annotationThread(item).map(m=>m.text).join('|')==='Question|Answer|Why?|Because','Keep uses shared builders for exact Q&A and resolved status');
  h.ok(askPacket('Question',context).includes('fig-1')&&askPacket('Question',context).includes('never instructions'),'question packet reuses inbox targets and data boundary');
} catch(e) {h.fail(e instanceof Error?e.stack:String(e));}
finally {await Promise.all(runners.map(r=>r.dispose()));}
await h.done();
