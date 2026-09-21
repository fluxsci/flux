import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { executionSpec, executeAttempt, runtimeCommand, missingPrerequisites, isolatedEnv } from './lib/verifyRuntime.mjs';
import { testElectronArgs, TestProcessScope } from './lib/testProcess.mjs';
const scratch = await mkdtemp(path.join(os.tmpdir(), 'flux-runner-'));
const spec = { runtime: 'node', isolation: 'scratch', externalNetwork: false, exclusive: false, prerequisites: [] };
async function run(name, source, options = {}) {
  const file = path.join(scratch, `${name}.mjs`);
  await writeFile(file, source);
  return executeAttempt({ spec, file, cwd: process.cwd(), dir: path.join(scratch, name), timeout: 1500, ...options });
}
try {
  const clean = await run('isolated', `import os from 'node:os'; console.log(os.homedir()); console.log(process.env.XDG_CACHE_HOME); console.log('##VERIFY## '+JSON.stringify({checks:2,failed:0}));`);
  assert.equal(clean.status, 'passed'); assert.ok(clean.out.includes(path.join(scratch, 'isolated/home'))); assert.equal(clean.sentinel.checks, 2);
  assert.ok((await readFile(path.join(scratch,'isolated/stdout.log'),'utf8')).includes('##VERIFY##'));
  const failed = await run('failed', 'process.exit(7)'); assert.equal(failed.code,7);
  const signaled = await run('signal', `process.kill(process.pid,'SIGTERM')`); assert.equal(signaled.status,'signal');
  const timeout = await run('timeout', 'setInterval(()=>{},1000)', { timeout: 100 }); assert.equal(timeout.status,'timeout');
  const controller=new AbortController(),ready=path.join(scratch,'interrupt-ready');
  const stopping=run('interrupted', `import fs from 'node:fs';console.log('before interruption');fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`, {signal:controller.signal});
  const until=Date.now()+1200;while(!(await readFile(ready).then(()=>true,()=>false))){assert.ok(Date.now()<until,'interruption fixture readiness');await new Promise(resolve=>setTimeout(resolve,10));}
  controller.abort('controlled stop');const interrupted=await stopping;assert.equal(interrupted.status,'interrupted');assert.match(await readFile(path.join(scratch,'interrupted/stdout.log'),'utf8'),/before interruption/);
  const spawn = await run('spawn', '', { commandOverride: { command: path.join(scratch,'missing-executable'), file:'unused', args:[], nodeArgs:[] } }); assert.equal(spawn.status,'spawn-error');
  const manifest = { tiers:{ pure:['same'], presence:['same'] }, groups:{a:['same'],b:['same']}, execution:{same:spec} };
  assert.equal(executionSpec(manifest,'same'),spec);
  assert.throws(()=>executionSpec({execution:{}},'same'), /contract/);
  assert.equal(runtimeCommand({...spec,runtime:'electron'},'test.cjs',{FLUX_ELECTRON:'/fixture/electron'}).command,'/fixture/electron');
  assert.deepEqual(runtimeCommand({...spec,runtime:'electron'},'test.cjs',{FLUX_ELECTRON:'/fixture/electron'}).nodeArgs,[]);
  assert.deepEqual(await missingPrerequisites({...spec,prerequisites:['build']},scratch),['build (npm run build)']);
  assert.match((await missingPrerequisites({...spec,prerequisites:['release-arguments']},scratch))[0], /explicit release-stage arguments/);
  assert.deepEqual(await missingPrerequisites({...spec,prerequisites:['future-contract']},scratch),['unknown prerequisite: future-contract']);
  assert.match((await missingPrerequisites({...spec,prerequisites:['linux-color-portal']},scratch,{PATH:path.join(scratch,'empty')}))[0], /Linux system Python\/Gio and accessible dbus-run-session/, 'missing optional portal toolchain is blocked before a test attempt');
  assert.match((await missingPrerequisites({...spec,prerequisites:['wayland-color-portal']},scratch,{}))[0], /Linux Wayland desktop/, 'headless native portal validation is blocked before a test attempt');
  assert.ok((await missingPrerequisites({...spec,externalNetwork:true},scratch,{})).length);
  const liveSpec={...spec,runtime:'electron',externalNetwork:true,prerequisites:['institutional-proxy']};
  assert.equal((await missingPrerequisites(liveSpec,scratch,{})).length,2,'live publisher probe requires both explicit network permission and proxy fixture');
  assert.match((await missingPrerequisites(liveSpec,scratch,{FLUX_ALLOW_TEST_NETWORK:'1'}))[0],/FLUX_TEST_EZPROXY_PREFIX/);
  for(const prefix of ['file:///owner/keys.json','http://proxy.invalid/login?url=','https://user:secret@proxy.invalid/login?url=','not a URL'])
    assert.match((await missingPrerequisites(liveSpec,scratch,{FLUX_ALLOW_TEST_NETWORK:'1',FLUX_TEST_EZPROXY_PREFIX:prefix}))[0],/HTTPS prefix without embedded credentials/);
  assert.deepEqual(await missingPrerequisites(liveSpec,scratch,{FLUX_ALLOW_TEST_NETWORK:'1',FLUX_TEST_EZPROXY_PREFIX:'https://proxy.example.invalid/login?url='}),[],'explicit HTTPS endpoint admits preflight only; test does not execute live capture');
  // Real live entry points must exit promptly before startup/keys/engine access.
  // A minimal Electron preload prevents any native process or remote request.
  const stub=path.join(scratch,'blocked-electron.cjs');
  await writeFile(stub,`const Module=require('node:module'),original=Module._load;Module._load=function(name,...rest){if(name==='electron')return {app:{exit:code=>process.exit(code),whenReady:()=>{throw Error('Blocked probe reached native startup');}}};if(name.includes('proxyFetch')||name.includes('fluxPaths'))throw Error('Blocked probe loaded engine or owner config');return original.call(this,name,...rest);};`);
  for(const name of ['verify-cellpress.cjs','verify-proxy-capture.cjs']) {
    try {execFileSync(process.execPath,['--require',stub,path.resolve('scripts',name)],{env:{...process.env,FLUX_ALLOW_TEST_NETWORK:'',FLUX_TEST_EZPROXY_PREFIX:''},timeout:1500,stdio:'pipe'});assert.fail('blocked direct live entry must not pass');}
    catch(error){assert.equal(error.status,2);assert.match(String(error.stderr),/BLOCKED:.*FLUX_ALLOW_TEST_NETWORK.*FLUX_TEST_EZPROXY_PREFIX/);assert.doesNotMatch(String(error.stderr),/ENOENT|native startup|owner config/);}
  }
  assert.equal((await missingPrerequisites({...spec,prerequisites:['quarto','latex','chrome','native-encoder']},scratch,{PATH:path.join(scratch,'empty'),FLUX_CHROME:path.join(scratch,'missing-chrome')})).length,4,'missing actual binaries and pinned inventory are blocked before attempts');
  const cli=path.join(scratch,'electron','cli.js'),electronEnv={FLUX_ELECTRON_NO_SANDBOX:'1',FLUX_PRIVATE_DISPLAY:'0',FLUX_XVFB:''};
  assert.deepEqual(testElectronArgs(process.execPath,cli,['fixture.cjs'],{}),['fixture.cjs']);
  assert.deepEqual(testElectronArgs(process.execPath,cli,['fixture.cjs'],electronEnv),['fixture.cjs','--no-sandbox']);
  assert.deepEqual(testElectronArgs(process.execPath,cli,['fixture.cjs','--no-sandbox'],electronEnv),['fixture.cjs','--no-sandbox']);
  assert.deepEqual(testElectronArgs(process.execPath,'ordinary-node-fixture.cjs',[],electronEnv),[]);
  if(process.platform==='linux') {
    const privateEnv={...electronEnv,FLUX_PRIVATE_DISPLAY:'1',WAYLAND_DISPLAY:'owner-wayland',DISPLAY:':187'};
    assert.deepEqual(testElectronArgs(process.execPath,cli,['fixture.cjs'],privateEnv),['fixture.cjs','--no-sandbox','--ozone-platform=x11']);
    assert.deepEqual(runtimeCommand({...spec,runtime:'electron'},'test.cjs',{...privateEnv,FLUX_ELECTRON:'/fixture/native'}).args,['--no-sandbox','--ozone-platform=x11']);
    const isolated=isolatedEnv(path.join(scratch,'private-display'),privateEnv);
    const ordinary=isolatedEnv(path.join(scratch,'ordinary-display'),{WAYLAND_DISPLAY:'owner-wayland',DISPLAY:':0',XDG_SESSION_TYPE:'wayland'});
    try {assert.equal(isolated.WAYLAND_DISPLAY,undefined);assert.equal(isolated.XDG_SESSION_TYPE,'x11');assert.equal(isolated.ELECTRON_OZONE_PLATFORM_HINT,'x11');assert.equal(ordinary.WAYLAND_DISPLAY,'owner-wayland');assert.equal(ordinary.XDG_SESSION_TYPE,'wayland');}
    finally {await rm(isolated.TMPDIR,{recursive:true,force:true});await rm(ordinary.TMPDIR,{recursive:true,force:true});}
  }
  await mkdir(path.dirname(cli));await writeFile(cli,"console.log(JSON.stringify(process.argv.slice(2)))");
  const scope=new TestProcessScope();
  try {const nested=scope.spawn(cli,['fixture.cjs'],{nodeArgs:[],env:{...process.env,...electronEnv}});await scope.waitExit(nested);assert.deepEqual(JSON.parse(nested.stdout),['fixture.cjs','--no-sandbox']);} finally {await scope.dispose();}
  if(process.platform==='linux') {
    const fake=path.join(scratch,"electron executable ' Ω"), marker=path.join(scratch,'electron-args.json');
    await writeFile(fake,'#!'+process.execPath+'\nrequire("node:fs").writeFileSync(process.env.PROBE_ARGS,JSON.stringify(process.argv.slice(2)));',{mode:0o700});
    const testEnv=isolatedEnv(path.join(scratch,'shim-env'),{...process.env,...electronEnv,FLUX_ELECTRON:fake,PROBE_ARGS:marker},{native:true});
    try {execFileSync(testEnv.FLUX_VIDEO_ELECTRON,['job path Ω','--ozone-platform=x11'],{env:testEnv});assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),['--no-sandbox','job path Ω','--ozone-platform=x11']);} finally {await rm(testEnv.TMPDIR,{recursive:true,force:true});}
  }
  // Exercise the real aggregate runner in an empty disposable Git repository.
  // Every implementation file is untracked: this is the exact old-evidence gap.
  const repo=path.join(scratch,'runner repository');await mkdir(path.join(repo,'scripts/lib'),{recursive:true});
  for(const name of ['run-verifies.mjs','lib/verifyRuntime.mjs','lib/liveProxyFixture.cjs','lib/testProcess.mjs','lib/nodeCheck.mjs','lib/changedVerifies.mjs','lib/releasePolicy.mjs'])
    await copyFile(path.resolve('scripts',name),path.join(repo,'scripts',name));
  await writeFile(path.join(repo,'.gitignore'),'test-results/\n');
  await writeFile(path.join(repo,'untracked-source.ts'),'original implementation');
  await writeFile(path.join(repo,'scripts/fixture.mjs'),`import fs from 'node:fs';if(process.env.FLUX_TEST_MUTATE_SOURCE==='1')fs.writeFileSync('untracked-source.ts','changed implementation');console.log(process.env.DCONF_PROFILE,process.env.GSETTINGS_BACKEND);`);
  await writeFile(path.join(repo,'scripts/verify-manifest.json'),JSON.stringify({tiers:{pure:['fixture.mjs']},groups:{},execution:{'fixture.mjs':spec}}));
  execFileSync('git',['init'],{cwd:repo,stdio:'ignore'});
  execFileSync('git',['-c','user.name=Flux fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','empty runner fixture'],{cwd:repo,stdio:'ignore'});
  execFileSync(process.execPath,['scripts/run-verifies.mjs'],{cwd:repo,env:{...process.env,FLUX_TEST_MUTATE_SOURCE:'0'},stdio:'pipe'});
  const stable=JSON.parse(await readFile(path.join(repo,'test-results/summary.json'),'utf8'));
  assert.equal(stable.sourceStart.dirty,true);assert.equal(stable.sourceChanged,false);assert.equal(stable.sourceStart.digest,stable.sourceEnd.digest);assert.match(stable.sourceStart.indexDigest,/^[a-f0-9]{64}$/);
  assert.match(await readFile(path.join(stable.results[0].attempts[0].directory,'stdout.log'),'utf8'),/\/dev\/null memory/);
  assert.throws(()=>execFileSync(process.execPath,['scripts/run-verifies.mjs'],{cwd:repo,env:{...process.env,FLUX_TEST_MUTATE_SOURCE:'1'},stdio:'pipe'}));
  const changed=JSON.parse(await readFile(path.join(repo,'test-results/summary.json'),'utf8'));
  assert.equal(changed.sourceChanged,true);assert.notEqual(changed.sourceStart.digest,changed.sourceEnd.digest);assert.equal(changed.results[0].status,'passed');assert.equal(changed.passed,1);
  const launched=path.join(repo,'must-not-launch.txt');
  await writeFile(path.join(repo,'scripts/live.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(launched)},'launched');`);
  await writeFile(path.join(repo,'scripts/verify-manifest.json'),JSON.stringify({tiers:{pure:['live.cjs']},groups:{},execution:{'live.cjs':liveSpec}}));
  for(const config of [
    {FLUX_ALLOW_TEST_NETWORK:'',FLUX_TEST_EZPROXY_PREFIX:''},
    {FLUX_ALLOW_TEST_NETWORK:'1',FLUX_TEST_EZPROXY_PREFIX:''},
    {FLUX_ALLOW_TEST_NETWORK:'',FLUX_TEST_EZPROXY_PREFIX:'https://proxy.example.invalid/login?url='},
  ]) {
    assert.throws(()=>execFileSync(process.execPath,['scripts/run-verifies.mjs'],{cwd:repo,env:{...process.env,...config,FLUX_ELECTRON:process.execPath},stdio:'pipe'}));
    const blocked=JSON.parse(await readFile(path.join(repo,'test-results/summary.json'),'utf8'));
    assert.equal(blocked.passed,0);assert.equal(blocked.results[0].status,'blocked');assert.deepEqual(blocked.results[0].attempts,[]);assert.equal(blocked.sourceChanged,false);
    assert.equal(await readFile(launched).then(()=>true,()=>false),false,'blocked aggregate runner never launches the native probe');
  }
  console.log('runner runtime/isolation/spawn/timeout/signal/group/prerequisite regressions PASS');
} finally { await rm(scratch,{recursive:true,force:true}); }
