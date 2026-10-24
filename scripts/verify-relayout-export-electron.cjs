'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),cp=require('node:child_process');
async function main(){
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-relayout-export-')),out=path.resolve('test-results/relayout/native');await fs.mkdir(out,{recursive:true});
 const {TestProcessScope}=await import('./lib/testProcess.mjs'),scope=new TestProcessScope(),env={...process.env,HOME:path.join(scratch,'home'),XDG_CONFIG_HOME:path.join(scratch,'xdg'),XDG_CACHE_HOME:path.join(scratch,'cache'),PROBE_SCRATCH:scratch,PROBE_ARTIFACTS:out};delete env.ELECTRON_RUN_AS_NODE;
 try{
  const setup=scope.spawn(path.resolve('scripts/lib/relayoutExportFixture.ts'),[scratch],{env,deadlineMs:120000});assert.equal((await scope.waitExit(setup)).code,0,setup.stderr);
  if(process.platform==='linux'){const display=path.join(scratch,'display'),x=scope.spawn(path.resolve('scripts/verify-slide-stash-electron.cjs'),['--display',process.env.FLUX_XVFB||'Xvfb',display],{env,readyLine:'DISPLAY READY',nodeArgs:[],deadlineMs:120000});await x.ready;env.DISPLAY=':'+(await fs.readFile(display,'utf8')).trim();delete env.WAYLAND_DISPLAY;}
  const native=scope.spawn(require.resolve('electron/cli.js'),[path.resolve('scripts/lib/relayoutExportNativeEntry.cjs'),...(process.platform==='linux'?['--ozone-platform=x11','--disable-gpu']:[])],{env,deadlineMs:100000,nodeArgs:[]});const r=await scope.waitExit(native);await fs.writeFile(path.join(out,'native.log'),native.stdout+native.stderr);assert.equal(r.code,0,(native.stdout+native.stderr).slice(-12000));
  const text=cp.execFileSync('pdftotext',['-bbox',path.join(out,'figure.pdf'),'-'],{encoding:'utf8'});assert(text.includes('Response')&&text.includes('Time'),'PDF retains scientific text');const words=[...text.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/g)];assert(words.length>10&&words.every(m=>Number(m[1])>=0&&Number(m[3])<=541&&Number(m[4])<=376),'PDF text stays within physical page');
  const anchors=JSON.parse(await fs.readFile(path.join(scratch,'pdf-anchors.json'),'utf8'));
  const extracted=[...text.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)<\/word>/g)];
  assert(anchors.length>=2,'physical title anchors captured');
  for(const anchor of anchors){
   const selected=anchor.words.map(word=>extracted.find(m=>m[5]===word));assert(selected.every(Boolean),'PDF title words '+anchor.id);
   const center=[(Math.min(...selected.map(m=>Number(m[1])))+Math.max(...selected.map(m=>Number(m[3]))))/2,(Math.min(...selected.map(m=>Number(m[2])))+Math.max(...selected.map(m=>Number(m[4]))))/2];
   assert(Math.hypot(center[0]-anchor.center[0],center[1]-anchor.center[1])<=1,'PDF title position within 1 pt: '+anchor.id);
  }
  console.log(native.stdout);
 }finally{await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});}
}
import('./lib/harness.mjs').then(async({harness})=>{const h=harness('verify-relayout-export-electron');try{await main();h.ok(true,'native PNG/canvas parity, PDF text and offline deck Change playback')}catch(e){console.error(e);h.fail(String(e))}await h.done()});
