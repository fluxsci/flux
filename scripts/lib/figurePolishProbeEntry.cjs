'use strict';
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS='1';
const {app,BrowserWindow,dialog}=require('electron'),fs=require('node:fs'),path=require('node:path');
const scratch=process.env.PROBE_SCRATCH,root=process.env.PROBE_PROJECT;
if(!scratch||!root)throw Error('Hermetic native probe context required');
// Use the actual export IPC and encoder with a deterministic save destination.
// Native OS dialog interaction itself is outside this unattended gate.
dialog.showSaveDialog=async(_win,opts)=>({canceled:false,filePath:path.join(root,path.basename(opts.defaultPath))});
require('../../electron/main.cjs');
let win;const checks=[],metrics={},budgets=[];
const budget=(ok,label)=>budgets.push({ok:!!ok,label});
const js=code=>win.webContents.executeJavaScript(code,true).catch(e=>{throw Error(`${e.message}\nProbe expression: ${code.slice(0,500)}`)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(ok,label)=>{checks.push({ok:!!ok,label});console.log('PROBE check='+JSON.stringify(checks.at(-1)));if(!ok)throw Error(label)};
async function wait(fn,label){const t=Date.now();while(Date.now()-t<20000){try{const r=await fn();if(r)return r}catch{}await sleep(80)}throw Error('Timeout: '+label)}
async function click(selector){const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');n.scrollIntoView({block:'nearest'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function key(keyCode,modifiers=[]){win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function selectFigure(n){await click(`.figrow[data-fig-id="native-${n}"] .item`);await wait(()=>js(`!!document.querySelector('[data-editor-element-id="e${n}-0"]')`),'figure visible');}
const p95=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length*.95)];
const command=process.platform==='darwin'?'meta':'control';
const paint=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function startProfile(label){
 const trace=[];let tracingDone;
 const message=(_event,method,params)=>{if(method==='Tracing.dataCollected')trace.push(...params.value);if(method==='Tracing.tracingComplete')tracingDone?.();};
 win.webContents.debugger.attach('1.3');win.webContents.debugger.on('message',message);
 await win.webContents.debugger.sendCommand('Profiler.enable');await win.webContents.debugger.sendCommand('Profiler.start');
 await win.webContents.debugger.sendCommand('Tracing.start',{categories:'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline',transferMode:'ReportEvents'});
 return async()=>{const profile=await win.webContents.debugger.sendCommand('Profiler.stop');fs.writeFileSync(path.resolve(__dirname,`../../test-results/${label}-cpu.json`),JSON.stringify(profile));await new Promise(async resolve=>{tracingDone=resolve;await win.webContents.debugger.sendCommand('Tracing.end');});fs.writeFileSync(path.resolve(__dirname,`../../test-results/${label}-trace.json`),JSON.stringify({traceEvents:trace}));win.webContents.debugger.removeListener('message',message);win.webContents.debugger.detach();};
}
async function timedKey(code,modifiers=[]){
 await js("window.__layoutTime=undefined;window.__layoutKey=()=>{const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__layoutTime=performance.now()-t))};window.addEventListener('keydown',window.__layoutKey,{once:true,capture:true})");
 await key(code,modifiers);return wait(()=>js('Number.isFinite(window.__layoutTime)?window.__layoutTime:null'),'native key paint measurement');
}
async function arrangementCohort(n,count){
 await selectFigure(n);await click('.sidebar .layer .item');await key('A',[command]);
 if(n==='dense')await wait(()=>js("document.querySelectorAll('[data-editor-element-id] svg circle').length>=36000"),'all twelve dense SVGs hydrated');
 const before=JSON.parse(fs.readFileSync(path.join(root,'fig/canvases/c.json'),'utf8')).figures.find(f=>f.id===`native-${n}`);
 const opened=await timedKey('A');
 await wait(()=>js(`document.querySelector('.align-arrange-panel[aria-label="Flux Align"] .count')?.textContent.trim()===${JSON.stringify(`${count} objects`)}`),`${n}: all objects selected`);
 const entered=await timedKey('Space');
 await wait(()=>js("!!document.querySelector('.align-arrange-panel[aria-label=\"Flux Arrange\"] [data-command-scope]')||!!document.querySelector('[data-arrange-gap]')"),'arrange gaps');
 const pinBefore=await js("(()=>{const n=document.querySelector('.gap-guides .pin');return {x:n.getAttribute('cx'),y:n.getAttribute('cy')}})()");
 const handle=await js(`(()=>{for(const n of document.querySelectorAll('[data-arrange-gap="x"]')){const b=n.getBoundingClientRect();for(const q of [.2,.5,.8]){const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height*q);if(document.elementFromPoint(x,y)?.closest('[data-arrange-gap]'))return {x,y}}}return null})()`);
 if(!handle){console.log('PROBE gap-hit-diagnostic='+JSON.stringify(await js("[...document.querySelectorAll('[data-arrange-gap=\"x\"]')].slice(0,3).map(n=>{const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return {box:b.toJSON(),targets:document.elementsFromPoint(x,y).slice(0,4).map(n=>({tag:n.tagName,cls:n.getAttribute('class')}))}})")));throw Error('No exposed horizontal gap handle');}
 const profiling=process.env.FLUX_LAYOUT_PROFILE==='1'&&n===5000;
 const stopProfile=profiling?await startProfile('align-arrange-native'):null;
 await js("window.__layoutNodes=new Map([...document.querySelectorAll('[data-editor-element-id]')].map(n=>[n.dataset.editorElementId,{node:n,art:n.querySelector('svg')} ]));window.__layoutMoves=[];window.__layoutMove=e=>{if(!e.buttons)return;const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__layoutMoves.push(performance.now()-t)))};window.addEventListener('pointermove',window.__layoutMove,true);void 0");
 win.webContents.sendInputEvent({type:'mouseMove',...handle});await paint();
 win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...handle});await paint();
 for(let i=1;i<=18;i++){win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:handle.x+i,y:handle.y});await paint();}
 const moves=await js("window.removeEventListener('pointermove',window.__layoutMove,true);window.__layoutMoves");
 const scene=await js("({mounted:document.querySelectorAll('[data-editor-element-id]').length,drives:document.getAnimations().length,visible:[...document.querySelectorAll('[data-editor-element-id]')].filter(n=>{const b=n.getBoundingClientRect();return b.bottom>70&&b.top<innerHeight&&b.right>200&&b.left<1192}).length})");
 if(stopProfile)await stopProfile();
 check(await js("(()=>{const nodes=new Map([...document.querySelectorAll('[data-editor-element-id]')].map(n=>[n.dataset.editorElementId,n]));return [...window.__layoutNodes].every(([id,old])=>{const n=nodes.get(id);return n===old.node&&n?.querySelector('svg')===old.art})})()"),`${n}: selected wrappers and nested SVG artwork retain identity during gap scrub`);
 check(await js("!!document.querySelector('.gap-value')"),`${n}: pointer events reached the live gap scrub`);
 check(await js(`(()=>{const n=document.querySelector('.gap-guides .pin');return Math.abs(+n.getAttribute('cx')-${Number(pinBefore.x)})<.01&&Math.abs(+n.getAttribute('cy')-${Number(pinBefore.y)})<.01})()`),`${n}: centered anchor stays fixed throughout native gap scrub`);
 win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:handle.x+18,y:handle.y});await paint();
 const row=await timedKey('A');
 check(await js("document.querySelector('.align-arrange-panel')?.textContent.includes('Reflowed row')"),`${n}: explicit row reflow works for full selection`);
 await key('S',[command]);
 await wait(()=>JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'fig/canvases/c.json'),'utf8')).figures.find(f=>f.id===`native-${n}`).elements)!==JSON.stringify(before.elements),'arrange preview reaches saved model before cancellation');
 await key('Escape');await wait(()=>js("!document.querySelector('.align-arrange-panel')"),'arrange Escape closes visit');
 await wait(()=>JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'fig/canvases/c.json'),'utf8')).figures.find(f=>f.id===`native-${n}`).elements)===JSON.stringify(before.elements),'cancel restores saved positions');
 metrics[`arrange-${n}`]={count,openMs:opened,enterMs:entered,rowMs:row,firstMoveMs:moves[0],gapP95:p95(moves),samplesMs:moves,scene,profiling};
 console.log('PROBE metrics='+JSON.stringify({figure:`arrange-${n}`,...metrics[`arrange-${n}`]}));
 fs.writeFileSync(path.resolve(__dirname,'../../test-results/figure-polish-native-metrics.json'),JSON.stringify(metrics,null,2));
 check(moves.length===18,`${n}: eighteen native gap pointer events measured`);
}
async function main(){
 win=await wait(()=>BrowserWindow.getAllWindows()[0],'window');win.setSize(1440,1000);
 // Native paint measurements require a visible surface: macOS stops rAF when
 // another app fully occludes the window. Keep this disposable probe visible;
 // do not disable production background throttling or inflate timing budgets.
 win.setAlwaysOnTop(true);win.show();win.focus();
 await wait(()=>js("!!document.querySelector('button[aria-label=Figure]')&&!!document.querySelector('.cm-editor')"),'initial Paper');
 check(app.getPath('userData').startsWith(scratch+path.sep),'isolated native config');
 check(win.webContents.getURL().startsWith('file:')&&await js('!window.__flux'),'production bundle, no development handles');
 metrics.environment={display:process.env.DISPLAY??null,gpuFeatures:app.getGPUFeatureStatus(),privateDisplay:process.env.FLUX_PRIVATE_DISPLAY==='1',platform:process.platform,cpu:require('node:os').cpus()[0]?.model,versions:process.versions};
 await click('button[aria-label=Figure]');await wait(()=>js("!!document.querySelector('.figure-mode .canvas-host')"),'Figure');
 for(const [n,count]of [[1600,1600],[5000,5000],['dense',12]])await arrangementCohort(n,count);
 for(const n of [1600,5000]){
  await selectFigure(n);
  // Bring the lowest Layers row into view using the actual virtual-list keyboard path.
  await click('.sidebar .layer .item');win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
  await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const beforeX=await js("Number([...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='X')?.querySelector('input')?.value)");
  await js("window.__nativeTimes=[];window.__nativeKey=e=>{if(e.key!=='ArrowRight')return;const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__nativeTimes.push(performance.now()-t)))};window.addEventListener('keydown',window.__nativeKey,true);void 0");
  const stopNudgeProfile=process.env.FLUX_LAYOUT_PROFILE==='nudge'&&n===5000?await startProfile('align-arrange-native-nudge'):null;
  for(let i=0;i<18;i++){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')}
  if(stopNudgeProfile)await stopNudgeProfile();
  const times=await js("window.removeEventListener('keydown',window.__nativeKey,true);window.__nativeTimes");
  check(await js("Number([...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='X')?.querySelector('input')?.value)")===beforeX+18,`${n}: measured key events actually moved the selected object`);
  check(times.length===18,`${n}: actual native keyboard events measured`);metrics[n]={nudgeP95:p95(times),samplesMs:times,viewport:await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'),mounted:await js("document.querySelectorAll('[data-editor-element-id]').length"),layers:await js("document.querySelectorAll('.sidebar .layer').length")};
  console.log('PROBE metrics='+JSON.stringify({figure:n,...metrics[n]}));
  fs.writeFileSync(path.resolve(__dirname,'../../test-results/figure-polish-native-metrics.json'),JSON.stringify(metrics,null,2));
  budget(metrics[n].nudgeP95<=100,`${n}: native key-to-paint p95 ${metrics[n].nudgeP95.toFixed(1)}ms ≤100ms`);
  check(metrics[n].layers<=150,`${n}: virtualized Layers remain bounded`);
  if(n===5000){
   // The same measurement with the Plots rail open and rendering 24 dense plots (Alt+G): the
   // rail must cost the editor nothing (stop-ship: ≤100 ms and within noise of rail-closed).
   await key('G',['alt']);
   await wait(()=>js("document.querySelector('[data-left-rail]')?.getAttribute('data-left-rail')==='plots'&&document.querySelectorAll('[data-plots-gallery] [data-tile*=\"/dense/\"] img').length>=4"),'Plots rail open with dense thumbnails');
   await key('Escape'); // search box → canvas keyboard (the rail owns the unmodified key: no deselect)
   const beforeRailX=await js("Number([...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='X')?.querySelector('input')?.value)");
   await js("window.__nativeTimes=[];window.__nativeKey=e=>{if(e.key!=='ArrowRight')return;const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__nativeTimes.push(performance.now()-t)))};window.addEventListener('keydown',window.__nativeKey,true)");
   for(let i=0;i<18;i++){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')}
   const railTimes=await js("window.removeEventListener('keydown',window.__nativeKey,true);window.__nativeTimes");
   check(await js("Number([...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='X')?.querySelector('input')?.value)")===beforeRailX+18,'5000 + Plots rail: the measured keys moved the object');
   metrics.railOpen={nudgeP95:p95(railTimes),samplesMs:railTimes,closedP95:metrics[n].nudgeP95};
   console.log('PROBE metrics='+JSON.stringify({figure:'5000+rail',...metrics.railOpen}));
   fs.writeFileSync(path.resolve(__dirname,'../../test-results/figure-polish-native-metrics.json'),JSON.stringify(metrics,null,2));
   budget(metrics.railOpen.nudgeP95<=100,`5000 + Plots rail: key-to-paint p95 ${metrics.railOpen.nudgeP95.toFixed(1)}ms ≤100ms`);
   budget(metrics.railOpen.nudgeP95<=metrics[n].nudgeP95+25,`5000 + Plots rail within noise of rail-closed (${metrics.railOpen.nudgeP95.toFixed(1)} vs ${metrics[n].nudgeP95.toFixed(1)} ms)`);
   await click('[data-rail-tab="layers"]'); // back to Layers for the rest of the probe
   await wait(()=>js("document.querySelector('[data-left-rail]')?.getAttribute('data-left-rail')==='layers'"),'back to Layers');
  }
 }
 await selectFigure(5);
 const savedFigure=()=>JSON.parse(fs.readFileSync(path.join(root,'fig/canvases/c.json'),'utf8')).figures.find(f=>f.id==='native-5');
 // Exercise the property/palette refinements against the built renderer and
 // actual autosave, without development stores or synthetic DOM key handlers.
 await click('.sidebar .layer[data-layer-key="e:e5-4"] .item');
 await key('F');await wait(()=>js("document.activeElement===document.querySelector('.fluxFigMenu')"),'property menu focused');
 await key('X');await wait(()=>js("document.activeElement?.closest('.field')?.dataset.key==='x'"),'position field focused');
 await key('Up',['alt']);await key('Up',['alt']);
 check(await js("document.querySelector('.fluxFigMenu .field[data-key=x] .nin')?.value==='132.2'"),'native fine steps accumulate and display fractional position');
 await key('Return');await wait(()=>savedFigure().elements.find(e=>e.id==='e5-4').x===132.2,'fine position autosaved');
 await key('Escape');await wait(()=>js("!document.querySelector('.fluxFigMenu')"),'property menu closed');
 await click('.toolbar button[title^="Undo"]');await wait(()=>savedFigure().elements.find(e=>e.id==='e5-4').x===132,'fine edit undo autosaved');
 check(true,'native fine edit is one reversible saved change');
 await key('F');await wait(()=>js("document.activeElement===document.querySelector('.fluxFigMenu')"),'property menu focused for colour');
 await key('C');await wait(()=>js("document.activeElement===document.querySelector('.cs .grid')"),'palette focused');
 const swatch=await js("(()=>{const n=document.querySelector('.cs .sw:not(.none)'),r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
 win.webContents.sendInputEvent({type:'mouseMove',...swatch});
 await wait(()=>js("document.querySelector('[data-editor-element-id=\"e5-4\"] rect')?.getAttribute('fill')!=='#4385be'"),'native hover previews paint');
 check(await js("document.querySelector('.cs .hex')?.value===document.querySelector('[data-editor-element-id=\"e5-4\"] rect')?.getAttribute('fill')"),'native palette feedback matches the painted colour');
 // Dismiss outside the panel: a hover is not an implicit colour choice.
 win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:8,y:120});
 win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:8,y:120});
 await wait(()=>js("!document.querySelector('.fluxFigMenu')&&document.querySelector('[data-editor-element-id=\"e5-4\"] rect')?.getAttribute('fill')==='#4385be'"),'native dismissal restores paint');
 await wait(()=>savedFigure().elements.find(e=>e.id==='e5-4').fill==='#4385be','cancelled preview autosaved');
 check(true,'native outside dismissal restores the unchosen colour');
 for(const width of [940,1024,1440]){win.setSize(width,900);await sleep(120);check(await js("[...document.querySelectorAll('.figure-mode .toolbar button')].every(n=>{const b=n.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight})"),`toolbar reachable at native ${width}px`)}
 // Resize the frame using actual OS pointer events, wait for autosave, then
 // undo through the shared toolbar. The artwork must keep its own dimensions.
 await click('.figure-titlebar');await wait(()=>js("!!document.querySelector('[data-frame-handle=e]')"),'frame resize handles');
 fs.writeFileSync(path.resolve(__dirname,'../../test-results/figure-polish-frame.png'),(await win.webContents.capturePage()).toPNG());
 const handle=await js("(()=>{const b=document.querySelector('[data-frame-handle=e]').getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()");
 win.webContents.sendInputEvent({type:'mouseMove',...handle});
 await js('new Promise(r=>requestAnimationFrame(r))');
 win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...handle});
 await js('new Promise(r=>requestAnimationFrame(r))');
 // Electron needs the held-button modifier on motion. `button` alone yields
 // DOM buttons=0 and releases pointer capture before the drag reaches Canvas.
 win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:handle.x+50,y:handle.y});
 await js('new Promise(r=>requestAnimationFrame(r))');
 win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:handle.x+50,y:handle.y});
 await js('new Promise(r=>requestAnimationFrame(r))');
 console.log('PROBE frame='+JSON.stringify(await js("({width:[...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='W')?.querySelector('input')?.value,undoDisabled:document.querySelector('.toolbar button[title^=Undo]')?.disabled,status:document.querySelector('.toolbar .path')?.textContent})")));
 await wait(()=>savedFigure().width>320,'frame resize autosaved');
 check(savedFigure().elements[0].width===24&&savedFigure().elements[0].x===12,'native edge resize changes frame without scaling artwork');
 await click('.toolbar button[title^="Undo"]');await wait(()=>savedFigure().width===320,'frame undo autosaved');
 check(savedFigure().width===320,'native frame resize is one reversible edit');
 await js("document.querySelector('.inspector').scrollTop=99999;void 0");
 for(const [label,ext]of [['SVG','svg'],['PNG','png'],['PDF','pdf']]){
  await js(`(()=>{const n=[...document.querySelectorAll('.inspector button')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!n)throw Error('Export control missing');n.click()})()`);
  const file=path.join(root,`Figure 3.${ext}`);await wait(()=>fs.existsSync(file)&&fs.statSync(file).size>100,`${label} exported through real IPC`);
  const bytes=fs.readFileSync(file);check(ext==='pdf'?bytes.subarray(0,5).toString()==='%PDF-':ext==='png'?bytes.subarray(1,4).toString()==='PNG':bytes.toString().includes('viewBox="0 0 320 240"'),`${label}: actual exported file valid`);
  const artifacts=path.resolve(__dirname,'../../test-results/figure-polish-exports');fs.mkdirSync(artifacts,{recursive:true});fs.writeFileSync(path.join(artifacts,path.basename(file)),bytes);
  if(ext==='pdf') {const box=bytes.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);check(box&&Math.abs(+box[1]-240)<.02&&Math.abs(+box[2]-180)<.02,'PDF has the correct physical page dimensions');}
 }

 await click('button[aria-label=Slide]');await wait(()=>js("!!document.querySelector('.slide-mode .canvas-host')"),'Slides');
 check(await js("!document.querySelector('.frame-resize-handle')"),'Slides retains deck-wide stage sizing');
 const out=path.resolve(__dirname,'../../test-results');fs.writeFileSync(path.join(out,'figure-polish-native.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(out,'figure-polish-native.json'),JSON.stringify({checks,metrics},null,2));
 console.log('PROBE metrics='+JSON.stringify(metrics));
 // Keep the unchanged budget strict, while retaining the existing export and
 // interaction receipts even if the new full-selection cohort is too slow.
 for(const [name,m]of Object.entries(metrics))if(name.startsWith('arrange-')){
  for(const metric of ['openMs','enterMs','rowMs','firstMoveMs','gapP95']){const value=m[metric];budget(Number.isFinite(value)&&value<=100,`${name}: ${metric} ${value?.toFixed(1)}ms ≤100ms`);}
 }
 for(const result of budgets){checks.push(result);console.log('PROBE check='+JSON.stringify(result));}
 fs.writeFileSync(path.join(out,'figure-polish-native.json'),JSON.stringify({checks,metrics},null,2));
 const failed=budgets.filter(b=>!b.ok);if(failed.length)throw Error(failed.map(b=>b.label).join('; '));
}
app.whenReady().then(()=>main().then(()=>{fs.writeSync(1,'PROBE result=PASS\n');process.exit(0)}).catch(async e=>{try{fs.writeFileSync(path.resolve(__dirname,'../../test-results/figure-polish-native-failure.png'),(await win.webContents.capturePage()).toPNG())}catch{}fs.writeSync(1,'PROBE result='+String(e.stack||e)+'\n');process.exit(1)}));
setTimeout(()=>process.exit(2),140000);
