// Production renderer and real native filesystem, using only UI and preload.
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
(async()=>{
 const {TestProcessScope}=await import('./lib/testProcess.mjs');
 const {isolatedEnv}=await import('./lib/verifyRuntime.mjs');
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-native-journey-'));
 const root=path.join(scratch,'project'),external=path.join(scratch,'linked');
 const evidence=process.env.FLUX_OUT||path.resolve(__dirname,'../test-results/v020-native-journey');await fs.mkdir(evidence,{recursive:true});
 const env={...isolatedEnv(path.join(scratch,'environment')),PROBE_PROJECT:root,PROBE_EXTERNAL:external,PROBE_SCRATCH:scratch,PROBE_EVIDENCE:evidence};
 const scope=new TestProcessScope();
 try{
  const fixture=scope.spawn(path.resolve(__dirname,'lib/sourceSyncFixture.ts'),[root,external],{nodeArgs:['--import','tsx'],cwd:path.resolve(__dirname,'..'),env,deadlineMs:30000});
  await fixture.closed;if(fixture.code!==0)throw Error(fixture.stdout+fixture.stderr);
  const child=scope.spawn(path.resolve(__dirname,'fixtures/v020/nativeJourney.cjs'),[root,'--ozone-platform=x11',...(env.FLUX_ELECTRON_NO_SANDBOX==='1'?['--no-sandbox']:[])],{command:require('electron'),nodeArgs:[],cwd:path.resolve(__dirname,'..'),env,deadlineMs:150000});
  await child.closed;await fs.writeFile(path.join(evidence,'native.log'),child.stdout+'\n'+child.stderr);
  if(child.code!==0)throw Error((child.stdout+'\n'+child.stderr).slice(-14000));
  console.log(child.stdout);console.log('Native scientific preservation journey PASS: '+evidence);
 }finally{await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});await fs.rm(env.TMPDIR,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
