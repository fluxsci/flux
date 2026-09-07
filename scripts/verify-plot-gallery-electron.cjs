#!/usr/bin/env node
// Production renderer + actual native child-window/preload/IO. Disposable app
// config and project; never open or write the user's own workspace/library.
'use strict';
const {spawnSync,spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flux-gallery-')),root=path.join(scratch,'project');
const env={...process.env,HOME:path.join(scratch,'home'),XDG_CONFIG_HOME:path.join(scratch,'xdg'),APPDATA:path.join(scratch,'appdata'),FLUX_NO_MIGRATE:'1',PROBE_SCRATCH:scratch,PROBE_PROJECT:root};
fs.mkdirSync(env.HOME,{recursive:true});delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
async function main(){try{
 const seed=spawnSync(process.execPath,['--import','tsx',path.join(__dirname,'lib/figurePolishFixture.ts'),root],{env,cwd:repo,encoding:'utf8'});
 if(seed.status!==0)throw Error(seed.stdout+seed.stderr);
 for(const dir of ['study','other']){fs.mkdirSync(path.join(root,'plots',dir),{recursive:true});fs.writeFileSync(path.join(root,'plots',dir,'growth.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="48pt" viewBox="0 0 72 48"><rect width="72" height="48" fill="#fffcf0"/><path d="M5 40 20 30 40 25 65 7" fill="none" stroke="#205ea6" stroke-width="2"/></svg>')}
 const result=await new Promise((resolve,reject)=>{
  const args=[path.join(__dirname,'lib/plotGalleryProbeEntry.cjs'),root];if(process.platform==='linux')args.push('--no-sandbox','--ozone-platform=x11');
  const child=spawn(require('electron'),args,{env,cwd:repo,stdio:['ignore','pipe','pipe']});let output='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),100000);
  child.stdout.on('data',b=>{output+=b;for(const line of String(b).split('\n'))if(line.startsWith('PROBE '))console.log(line)});
  child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',status=>{clearTimeout(timer);fs.mkdirSync(path.join(repo,'test-results'),{recursive:true});fs.writeFileSync(path.join(repo,'test-results/plot-gallery-native.log'),output);resolve({status,output})});
 });
 if(result.status!==0)throw Error(result.output.slice(-12000));
 console.log('PLOT GALLERY ELECTRON: PASS');
 console.log('##VERIFY## '+JSON.stringify({script:'verify-plot-gallery-electron',ok:true,checks:JSON.parse(fs.readFileSync(path.join(repo,'test-results/plot-gallery-native.json'),'utf8')).length,failed:0}));
}catch(e){console.error(e);process.exitCode=1}finally{fs.rmSync(scratch,{recursive:true,force:true})}}
void main();
