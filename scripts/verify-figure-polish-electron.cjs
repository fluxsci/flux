#!/usr/bin/env node
// Built renderer, real Electron/preload/files; isolated HOME and app lock.
'use strict';
const {spawnSync,spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flux-figure-polish-')),root=path.join(scratch,'project');
const env={...process.env,HOME:path.join(scratch,'home'),XDG_CONFIG_HOME:path.join(scratch,'xdg'),APPDATA:path.join(scratch,'appdata'),FLUX_NO_MIGRATE:'1',PROBE_SCRATCH:scratch,PROBE_PROJECT:root};
fs.mkdirSync(env.HOME,{recursive:true});delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
const artifact=path.join(repo,'test-results/figure-polish-native.log');fs.mkdirSync(path.dirname(artifact),{recursive:true});
async function main(){try{
 const seed=spawnSync(process.execPath,['--import','tsx',path.join(__dirname,'lib/figurePolishFixture.ts'),root],{env,cwd:repo,encoding:'utf8'});
 if(seed.status!==0)throw Error(seed.stdout+seed.stderr);
 const result=await new Promise((resolve,reject)=>{
  const args=[path.join(__dirname,'lib/figurePolishProbeEntry.cjs'),root];if(process.platform==='linux')args.push('--no-sandbox','--ozone-platform=x11');
  const child=spawn(require('electron'),args,{env,cwd:repo,stdio:['ignore','pipe','pipe']});let output='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),150000);
  child.stdout.on('data',b=>{output+=b;for(const line of String(b).split('\n'))if(line.startsWith('PROBE '))console.log(line)});
  child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',status=>{clearTimeout(timer);fs.writeFileSync(artifact,output);resolve({status,output})});
 });
 if(result.status!==0)throw Error(result.output.slice(-14000));
 console.log('FIGURE POLISH ELECTRON: PASS');
}catch(e){console.error(e);process.exitCode=1}finally{fs.rmSync(scratch,{recursive:true,force:true})}}
void main();
