'use strict';
// Production Flux, real native button/preload/portal, entirely disposable data.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const repo=path.resolve(__dirname,'..');
if(!process.versions.electron) {
 (async()=>{
  const {harness}=await import('./lib/harness.mjs');
  const {TestProcessScope}=await import('./lib/testProcess.mjs');
  const h=harness('verify-eyedropper-electron'),scope=new TestProcessScope();
  if(process.platform!=='linux'||!process.env.WAYLAND_DISPLAY){console.log('BLOCKED: Linux Wayland desktop is required for native portal integration.');process.exitCode=77;return;}
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flux-eyedropper-app-'));
  const root=path.join(scratch,'project'),out=path.join(repo,'test-results/eyedropper-native');
  fs.mkdirSync(out,{recursive:true});
  const env={...process.env,HOME:path.join(scratch,'home'),XDG_CONFIG_HOME:path.join(scratch,'xdg'),APPDATA:path.join(scratch,'appdata'),FLUX_NO_MIGRATE:'1',PROBE_PROJECT:root,PROBE_SCRATCH:scratch,PROBE_OUT:out};
  delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
  fs.mkdirSync(env.HOME,{recursive:true});
  try{
   const seed=scope.spawn(path.join(__dirname,'lib/figurePolishFixture.ts'),[root],{cwd:repo,env});
   await seed.closed;
   if(seed.code!==0)throw Error(seed.stderr);
   const entry=scope.spawn(__filename,[root,'--no-sandbox','--ozone-platform=wayland'],{command:require('electron'),nodeArgs:[],cwd:repo,env,deadlineMs:60000});
   await entry.closed;
   fs.writeFileSync(path.join(out,'native.log'),entry.stdout+entry.stderr);
   h.ok(entry.code===0&&entry.stdout.includes('PROBE PASS'),`production native color picker: ${entry.stdout.trim()}`);
   if(entry.code!==0)console.error(entry.stderr);
  }finally{await scope.dispose();fs.rmSync(scratch,{recursive:true,force:true});}
  await h.done();
 })().catch(e=>{console.error(e);process.exitCode=1});
} else {
 const scratch=process.env.PROBE_SCRATCH,root=process.env.PROBE_PROJECT,out=process.env.PROBE_OUT;
 if(!scratch||!root||!out)throw Error('Isolated context required');
 process.stdin.resume();process.stdin.on('end',()=>process.exit(2));
 process.env.ELECTRON_DISABLE_SECURITY_WARNINGS='1';
 const {app,BrowserWindow}=require('electron');
 const cp=require('node:child_process'),originalSpawn=cp.spawn,portalJobs=[];
 // Passive observation: still executes the shipped helper on the real portal.
 cp.spawn=function(command,args,opts){const child=originalSpawn(command,args,opts);if(command==='/usr/bin/python3'&&args?.[2]?.includes('org.freedesktop.portal.Screenshot')){
  const job={pid:child.pid,closed:false,stdout:'',stderr:'',started:Date.now()};portalJobs.push(job);
  child.stdout.on('data',b=>job.stdout+=b);child.stderr.on('data',b=>job.stderr+=b);
  child.on('close',(code,signal)=>Object.assign(job,{closed:true,code,signal,elapsedMs:Date.now()-job.started}));
 }return child;};
 require('../electron/main.cjs');
 let win;const checks=[];
 const js=code=>win.webContents.executeJavaScript(code,true);
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(yes,label)=>{checks.push({ok:!!yes,label});if(!yes)throw Error(label);console.log('PROBE '+label);};
 async function wait(fn,label){const t=Date.now();while(Date.now()-t<20000){try{const value=await fn();if(value)return value;}catch{}await sleep(50);}throw Error('Timeout: '+label);}
 async function click(selector){const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n?.getBoundingClientRect();if(!r)throw Error('Missing ${selector}');return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});}
 function key(keyCode){win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});}
 const canvasFile=path.join(root,'fig/canvases/c.json');
 const saved=()=>JSON.parse(fs.readFileSync(canvasFile,'utf8')).figures.find(f=>f.id==='native-5').elements.find(e=>e.id==='e5-4');
 async function main(){
  win=await wait(()=>BrowserWindow.getAllWindows()[0],'window');win.setSize(1400,950);win.setAlwaysOnTop(true);win.show();win.focus();
  await wait(()=>js("!!document.querySelector('button[aria-label=Figure]')&&!!document.querySelector('.cm-editor')"),'app ready');
  check(app.getPath('userData').startsWith(scratch+path.sep),'isolated app configuration');
  check(win.webContents.getURL().startsWith('file:')&&await js('!window.__flux'),'production renderer without development stores');
  await click('button[aria-label=Figure]');await wait(()=>js("!!document.querySelector('.figrow[data-fig-id=\"native-5\"]')"),'Figure');
  await click('.figrow[data-fig-id="native-5"] .item');await wait(()=>js("!!document.querySelector('[data-editor-element-id=\"e5-4\"]')"),'small figure visible');
  await click('.sidebar .layer[data-layer-key="e:e5-4"] .item');
  const original=fs.readFileSync(canvasFile,'utf8');
  const undoDisabled=await js("document.querySelector('.figure-mode .toolbar button[title^=Undo]').disabled");
  await js("window.__unsafeDropperCalls=0;window.EyeDropper=class {constructor(){window.__unsafeDropperCalls++;throw Error('Unsafe browser dropper invoked')}};void 0");
  key('F');await wait(()=>js("document.activeElement===document.querySelector('.fluxFigMenu')"),'menu focus');
  key('C');await wait(()=>js("!!document.querySelector('.cs .drop')"),'color picker');
  await click('.cs .drop');await wait(()=>portalJobs.length===1,'real portal helper launched');
  // Allow the desktop compositor to present its user-owned picker. This bounded
  // observation interval does not stand in for app readiness or a latency gate.
  await sleep(500);
  check(!portalJobs[0].closed&&await js("document.querySelector('.cs .drop').disabled"),'real button has a live portal request');
  // Electron sendInputEvent targets this renderer even while the compositor owns
  // physical input. Exercise the actual component Escape -> AbortSignal -> IPC.
  key('Escape');
  await wait(()=>portalJobs[0].closed,'portal request closed');
  await wait(()=>js("!document.querySelector('.cs .drop').disabled"),'picker cancellation finished');
  check(portalJobs[0].code===0&&JSON.parse(portalJobs[0].stdout).status==='cancelled','shipped portal helper acknowledged cancellation cleanly');
  check(await js('window.__unsafeDropperCalls===0'),'Linux never entered native Chromium EyeDropper');
  check(fs.readFileSync(canvasFile,'utf8')===original,'cancel preserved exact saved Figure bytes');
  check(await js("document.querySelector('.figure-mode .toolbar button[title^=Undo]').disabled")===undoDisabled,'cancel preserved Undo history');
  key('Escape');await wait(()=>js("!document.querySelector('.cs')"),'palette closed');
  key('Escape');await wait(()=>js("!document.querySelector('.fluxFigMenu')"),'menu closed');
  await click('.sidebar .layer[data-layer-key="e:e5-4"] .item');
  key('Right');await wait(()=>saved().x===133,'native authoring after cancel autosaved');
  await click('.figure-mode .toolbar button[title^="Undo"]');await wait(()=>saved().x===132,'native Undo saved');
  check(saved().fill==='#4385be','app remains responsive: native nudge/save/Undo preserve color');
  fs.writeFileSync(path.join(out,'after-cancel.png'),(await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({checks,portalJobs,versions:process.versions},null,2));
  console.log('PROBE PASS');
 }
 app.whenReady().then(()=>main().then(()=>process.exit(0)).catch(async e=>{console.error(e);try{fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG())}catch{}process.exit(1)}));
 setTimeout(()=>process.exit(2),55000);
}
