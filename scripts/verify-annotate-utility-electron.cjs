// Real utility ownership + native capture, in a disposable project/config.
'use strict';
const {spawnSync,spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flux-annotate-')),root=path.join(scratch,'project');
const env={...process.env,HOME:path.join(scratch,'home'),XDG_CONFIG_HOME:path.join(scratch,'xdg'),APPDATA:path.join(scratch,'appdata'),FLUX_NO_MIGRATE:'1',PROBE_SCRATCH:scratch,PROBE_PROJECT:root};
fs.mkdirSync(env.HOME,{recursive:true});delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
async function main(){try{
 const seed=spawnSync(process.execPath,['--import','tsx',path.join(__dirname,'lib/figurePolishFixture.ts'),root],{env,cwd:repo,encoding:'utf8'});
 if(seed.status!==0)throw Error(seed.stdout+seed.stderr);
 fs.mkdirSync(path.join(repo,'test-results'),{recursive:true});
 const output=await new Promise((resolve,reject)=>{
  const args=[path.join(__dirname,'lib/annotateUtilityProbeEntry.cjs'),root];
  if(process.platform==='linux'){args.push('--ozone-platform=x11');if(process.env.FLUX_ELECTRON_NO_SANDBOX==='1')args.push('--no-sandbox');}
  const child=spawn(require('electron'),args,{env,cwd:repo,stdio:['ignore','pipe','pipe']});let output='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),100000);
  child.stdout.on('data',b=>{output+=b;for(const line of String(b).split('\n'))if(line.startsWith('PROBE '))console.log(line)});
  child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',status=>{clearTimeout(timer);fs.writeFileSync(path.join(repo,'test-results/annotate-utility-native.log'),output);status===0?resolve(output):reject(Error(output.slice(-12000)));});
 });
 const report=JSON.parse(fs.readFileSync(path.join(repo,'test-results/annotate-utility-native.json'),'utf8'));
 console.log('##VERIFY## '+JSON.stringify({script:'verify-annotate-utility-electron',ok:true,checks:report.length,failed:0}));
}catch(e){console.error(e);process.exitCode=1}finally{fs.rmSync(scratch,{recursive:true,force:true});}}
void main();
