'use strict';
const {spawnSync,spawn}=require('node:child_process');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flux-inline-native-')),root=path.join(scratch,'project'),config=path.join(scratch,'FluxConfig');
fs.mkdirSync(path.join(config,'FluxLib'),{recursive:true});fs.mkdirSync(path.join(scratch,'xdg','flux'),{recursive:true});fs.writeFileSync(path.join(scratch,'xdg','flux','preferences.json'),JSON.stringify({fluxConfigPath:config,captureDir:path.join(scratch,'downloads')}));
fs.mkdirSync(path.join(scratch,'downloads'),{recursive:true});
const env={...process.env,XDG_CONFIG_HOME:path.join(scratch,'xdg'),FLUX_NO_MIGRATE:'1',PROBE_PROJECT:root,PROBE_SCRATCH:scratch};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
(async()=>{let ok=false;try{
fs.rmSync(root,{recursive:true,force:true});const fixture=spawnSync(process.execPath,['--import','tsx','scripts/lib/slideEmbedFixture.ts',root],{env,encoding:'utf8',timeout:30000});if(fixture.status!==0)throw Error(fixture.stdout+fixture.stderr);
const nativeArgs=['scripts/lib/slideEmbedProbeEntry.cjs',root];if(process.platform==='linux')nativeArgs.push('--ozone-platform=x11','--no-sandbox');
const child=spawn(require('electron'),nativeArgs,{env,detached:true,stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},60000);child.stdout.on('data',d=>{output+=d;process.stdout.write(d)});child.stderr.on('data',d=>output+=d);await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();try{process.kill(-child.pid,'SIGKILL')}catch{}
const line=output.split('\n').find(l=>l.startsWith('PROBE result='));const result=line?JSON.parse(line.slice(13)):null;ok=result?.ok===true;if(!ok)console.error(output.slice(-14000));
console.log('##VERIFY## '+JSON.stringify({script:'verify-slide-embed-electron',ok,checks:result?.checks?.length??0,failed:ok?0:1}));
}catch(e){console.error(e);}finally{const artifacts=path.resolve('test-results/inline-slide-native');fs.mkdirSync(artifacts,{recursive:true});if(fs.existsSync(path.join(root,'exports')))fs.cpSync(path.join(root,'exports'),artifacts,{recursive:true});fs.rmSync(scratch,{recursive:true,force:true});process.exitCode=ok?0:1;}})();
