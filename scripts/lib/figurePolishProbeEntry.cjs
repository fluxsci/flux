'use strict';
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS='1';
const {app,BrowserWindow,dialog}=require('electron'),fs=require('node:fs'),path=require('node:path');
const scratch=process.env.PROBE_SCRATCH,root=process.env.PROBE_PROJECT;
if(!scratch||!root)throw Error('Hermetic native probe context required');
// Use the actual export IPC and encoder with a deterministic save destination.
// Native OS dialog interaction itself is outside this unattended gate.
dialog.showSaveDialog=async(_win,opts)=>({canceled:false,filePath:path.join(root,path.basename(opts.defaultPath))});
require('../../electron/main.cjs');
let win;const checks=[],metrics={};
const js=code=>win.webContents.executeJavaScript(code,true);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(ok,label)=>{checks.push({ok:!!ok,label});console.log('PROBE check='+JSON.stringify(checks.at(-1)));if(!ok)throw Error(label)};
async function wait(fn,label){const t=Date.now();while(Date.now()-t<20000){try{const r=await fn();if(r)return r}catch{}await sleep(80)}throw Error('Timeout: '+label)}
async function click(selector){const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');n.scrollIntoView({block:'nearest'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function selectFigure(n){await click(`.figrow[data-fig-id="native-${n}"] .item`);await wait(()=>js(`!!document.querySelector('[data-editor-element-id="e${n}-0"]')`),'figure visible');}
const p95=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length*.95)];
async function main(){
 win=await wait(()=>BrowserWindow.getAllWindows()[0],'window');win.setSize(1440,1000);
 // Native paint measurements require a visible surface: macOS stops rAF when
 // another app fully occludes the window. Keep this disposable probe visible;
 // do not disable production background throttling or inflate timing budgets.
 win.setAlwaysOnTop(true);win.show();win.focus();
 await wait(()=>js("!!document.querySelector('button[aria-label=Figure]')&&!!document.querySelector('.cm-editor')"),'initial Paper');
 check(app.getPath('userData').startsWith(scratch+path.sep),'isolated native config');
 check(win.webContents.getURL().startsWith('file:')&&await js('!window.__flux'),'production bundle, no development handles');
 await click('button[aria-label=Figure]');await wait(()=>js("!!document.querySelector('.figure-mode .canvas-host')"),'Figure');
 for(const n of [1600,5000]){
  await selectFigure(n);
  // Bring the lowest Layers row into view using the actual virtual-list keyboard path.
  await click('.sidebar .layer .item');win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
  await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const beforeX=await js("Number([...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='X')?.querySelector('input')?.value)");
  await js("window.__nativeTimes=[];window.__nativeKey=e=>{if(e.key!=='ArrowRight')return;const t=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__nativeTimes.push(performance.now()-t)))};window.addEventListener('keydown',window.__nativeKey,true);void 0");
  for(let i=0;i<18;i++){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')}
  const times=await js("window.removeEventListener('keydown',window.__nativeKey,true);window.__nativeTimes");
  check(await js("Number([...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='X')?.querySelector('input')?.value)")===beforeX+18,`${n}: measured key events actually moved the selected object`);
  check(times.length===18,`${n}: actual native keyboard events measured`);metrics[n]={nudgeP95:p95(times),mounted:await js("document.querySelectorAll('[data-editor-element-id]').length"),layers:await js("document.querySelectorAll('.sidebar .layer').length")};
  check(metrics[n].nudgeP95<=100,`${n}: native key-to-paint p95 ${metrics[n].nudgeP95.toFixed(1)}ms ≤100ms`);
  check(metrics[n].layers<=150,`${n}: virtualized Layers remain bounded`);
 }
 await selectFigure(5);
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
 win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:handle.x+50,y:handle.y});
 await js('new Promise(r=>requestAnimationFrame(r))');
 win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:handle.x+50,y:handle.y});
 await js('new Promise(r=>requestAnimationFrame(r))');
 console.log('PROBE frame='+JSON.stringify(await js("({width:[...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent==='W')?.querySelector('input')?.value,undoDisabled:document.querySelector('.toolbar button[title^=Undo]')?.disabled,status:document.querySelector('.toolbar .path')?.textContent})")));
 const savedFigure=()=>JSON.parse(fs.readFileSync(path.join(root,'fig/canvases/c.json'),'utf8')).figures.find(f=>f.id==='native-5');
 await wait(()=>savedFigure().width>320,'frame resize autosaved');
 check(savedFigure().elements[0].width===24&&savedFigure().elements[0].x===12,'native edge resize changes frame without scaling artwork');
 await click('.toolbar button[title^="Undo"]');await wait(()=>savedFigure().width===320,'frame undo autosaved');
 check(savedFigure().width===320,'native frame resize is one reversible edit');
 await js("document.querySelector('.inspector').scrollTop=99999;void 0");
 for(const [label,ext]of [['SVG','svg'],['PNG','png'],['PDF','pdf']]){
  await js(`(()=>{const n=[...document.querySelectorAll('.inspector button')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!n)throw Error('Export control missing');n.click()})()`);
  const file=path.join(root,`Figure 3.${ext}`);await wait(()=>fs.existsSync(file)&&fs.statSync(file).size>100,`${label} exported through real IPC`);
  const bytes=fs.readFileSync(file);check(ext==='pdf'?bytes.subarray(0,5).toString()==='%PDF-':ext==='png'?bytes.subarray(1,4).toString()==='PNG':bytes.toString().includes('viewBox="0 0 320 240"'),`${label}: actual exported file valid`);
  if(ext==='pdf') {const box=bytes.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);check(box&&Math.abs(+box[1]-240)<.02&&Math.abs(+box[2]-180)<.02,'PDF has the correct physical page dimensions');}
 }

 await click('button[aria-label=Slide]');await wait(()=>js("!!document.querySelector('.slide-mode .canvas-host')"),'Slides');
 check(await js("!document.querySelector('.frame-resize-handle')"),'Slides retains deck-wide stage sizing');
 const out=path.resolve(__dirname,'../../test-results');fs.writeFileSync(path.join(out,'figure-polish-native.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(out,'figure-polish-native.json'),JSON.stringify({checks,metrics},null,2));
 console.log('PROBE metrics='+JSON.stringify(metrics));
}
app.whenReady().then(()=>main().then(()=>{fs.writeSync(1,'PROBE result=PASS\n');process.exit(0)}).catch(async e=>{try{fs.writeFileSync(path.resolve(__dirname,'../../test-results/figure-polish-native-failure.png'),(await win.webContents.capturePage()).toPNG())}catch{}fs.writeSync(1,'PROBE result='+String(e.stack||e)+'\n');process.exit(1)}));
setTimeout(()=>process.exit(2),140000);
