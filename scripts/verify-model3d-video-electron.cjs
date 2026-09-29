'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
(async()=>{
  const {harness}=await import('./lib/harness.mjs'),{TestProcessScope}=await import('./lib/testProcess.mjs'),{isolatedEnv}=await import('./lib/verifyRuntime.mjs');
  const h=harness('verify-model3d-video-electron'),scope=new TestProcessScope(),scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-model3d-video-'));
  try {
    const env={...process.env,...isolatedEnv(path.join(scratch,'machine')),FLUX_NO_MIGRATE:'1',FLUX_PRIVATE_DISPLAY:'1',DISPLAY:process.env.DISPLAY||':0',PROBE_SCRATCH:scratch};
    const child=scope.spawn(path.join(__dirname,'lib/model3dVideoProbe.ts'),[],{env,cwd:path.resolve(__dirname,'..'),deadlineMs:240000});
    child.child.stdout.on('data',b=>process.stdout.write(b));const result=await scope.waitExit(child);
    await fs.mkdir('test-results/model3d/video',{recursive:true});await fs.writeFile('test-results/model3d/video/native.log',child.stdout+child.stderr);
    h.eq(result.code,0,'production Electron 1080p60 model export matches deterministic seek frames');
    if(result.code!==0)console.error(child.stdout+child.stderr);
  }finally{await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});}
  await h.done();
})();
