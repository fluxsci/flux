import {executeAttempt,isolatedEnv,discardTemporaryRoot} from '/home/driessen2/flux/.claude/worktrees/av2-C2/scripts/lib/verifyRuntime.mjs';
import {TestProcessScope} from '/home/driessen2/flux/.claude/worktrees/av2-C2/scripts/lib/testProcess.mjs';
const root='/home/driessen2/flux/.claude/worktrees/av2-C2',scope=new TestProcessScope();
const env=isolatedEnv('/tmp/flux-C2-qa/capture-server',{...process.env,FLUX_URL:'http://127.0.0.1:1422/',FLUX_NO_MIGRATE:'1'});
try{
 scope.spawn(root+'/node_modules/vite/bin/vite.js',['--host','127.0.0.1','--port','1422','--strictPort'],{cwd:root,env,nodeArgs:[],deadlineMs:120000});
 for(let i=0;i<120;i++){try{if((await fetch(env.FLUX_URL)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
 const result=await executeAttempt({spec:{runtime:'node',prerequisites:[],isolation:'scratch',externalNetwork:false,exclusive:true},file:'/tmp/flux-C2-qa/capture.mjs',dir:'/tmp/flux-C2-qa/capture-attempt',cwd:root,timeout:60000,env});console.log(result.out);process.exitCode=result.code;
}finally{await scope.dispose();discardTemporaryRoot(env.TMPDIR);}
