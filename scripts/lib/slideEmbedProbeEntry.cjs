'use strict';
const fs=require('node:fs'),path=require('node:path');
const {app,BrowserWindow,screen}=require('electron');
const {assertUsableDisplay,assertFocusedWindow,assertNativePointerTarget,qualifiedNativeBounds}=require('./nativeWindowQualification.cjs');
app.disableHardwareAcceleration();
const root=process.env.PROBE_PROJECT,scratch=process.env.PROBE_SCRATCH;
if(!root||!scratch)throw Error('Isolated probe paths required');
require('../../electron/main.cjs');
const checks=[],receipt={checks,windowEvents:[],inputs:[]};let win;const js=code=>win.webContents.executeJavaScript(code,true);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function focused(){const observation=await js("({visible:document.visibilityState,focused:document.hasFocus()})");receipt.lastFocus=observation;assertFocusedWindow(win,[observation]);}
async function wait(fn,label,requireFocus=false){const start=Date.now();while(Date.now()-start<20000){if(requireFocus)await focused();if(await fn())return;await pause(80);}throw Error('Timeout: '+label);}
function check(ok,label){checks.push({ok:!!ok,label});console.log('PROBE check='+JSON.stringify(checks.at(-1)));if(!ok)throw Error(label);}
async function settle(){await js(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native input setup received no settled animation frames')),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}))})`);}
async function click(selector){
  await focused();
  await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing native input target');e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});return true})()`);
  await settle();
  const observe=()=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Native input target disappeared');const r=e.getBoundingClientRect(),point={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)},hit=document.elementFromPoint(point.x,point.y);return{point,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},matches:!!hit&&(hit===e||e.contains(hit)),disabled:e.disabled,hit:hit?.className||hit?.tagName,visible:document.visibilityState,focused:document.hasFocus()}})()`);
  let observation=await observe();receipt.inputs.push({selector,observation});assertNativePointerTarget(win,observation);
  win.webContents.sendInputEvent({type:'mouseMove',...observation.point});
  await settle();observation=await observe();receipt.inputs.at(-1).afterMove=observation;assertNativePointerTarget(win,observation);
  await js(`(()=>{const expected=document.querySelector(${JSON.stringify(selector)}),rows=[];window.__fluxNativeEmbedInput=rows;for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>rows.push({type,trusted:e.isTrusted,matches:e.target===expected||expected.contains(e.target),x:e.clientX,y:e.clientY}),{capture:true,once:true});return true})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...observation.point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...observation.point});
  try{await wait(()=>js("window.__fluxNativeEmbedInput?.some(e=>e.type==='click'&&e.trusted&&e.matches)"),'trusted native click delivery',true);}
  finally{receipt.inputs.at(-1).events=await js('window.__fluxNativeEmbedInput');}
  check(receipt.inputs.at(-1).events.filter(e=>e.trusted&&e.matches).length===3,'native pointer down/up/click reach the hit-tested button');
}
(async()=>{try{
  await app.whenReady();
  receipt.display={displays:screen.getAllDisplays(),primary:screen.getPrimaryDisplay()};
  console.log('PROBE display='+JSON.stringify(receipt.display));
  assertUsableDisplay(receipt.display.displays);
  await wait(async()=>{win=BrowserWindow.getAllWindows()[0];return !!win;},'native window');
  win.setBounds(qualifiedNativeBounds(receipt.display.displays,receipt.display.primary,1440,1000));
  for(const name of ['focus','blur','show','hide'])win.on(name,()=>receipt.windowEvents.push({name,at:Date.now()}));
  win.show();app.focus({steal:true});win.focus();win.webContents.focus();
  receipt.windowBounds=win.getBounds();
  console.log('PROBE boot='+JSON.stringify({userData:app.getPath('userData'),root}));
  await wait(()=>js("!!document.querySelector('.cm-editor .flux-slide-art')"),'inline slide in built Paper');
  check(app.getPath('userData').startsWith(scratch+path.sep),'native config is isolated');
  check(await js("!window.__flux&&typeof window.fig.printPdf==='function'"),'built renderer and actual preload, no dev handle');
  check(await js("document.querySelector('.flux-slide-bar').textContent.includes('Step 0 / 2')"),'native slide starts at step 0');
  const source=fs.readFileSync(path.join(root,'paper/main.qmd'),'utf8');
  await click('.cm-editor [aria-label="Next animation step"]');
  await wait(()=>js("document.querySelector('.flux-slide-bar').textContent.includes('Step 1 / 2')"),'native click playback',true);
  check(true,'native pointer input advances one animation');
  const deckPath=path.join(root,'slides/talk/deck.json');let deck=JSON.parse(fs.readFileSync(deckPath,'utf8'));deck.slides[0].name='Revised results';fs.writeFileSync(deckPath,JSON.stringify(deck));
  await wait(()=>js("document.querySelector('.flux-slide-title').textContent.includes('Revised results')"),'external deck watcher refresh');
  check(await js("document.querySelector('.flux-slide-bar').textContent.includes('Step 1 / 2')"),'source refresh retains the authored beat identity');
  check(fs.readFileSync(path.join(root,'paper/main.qmd'),'utf8')===source,'playback and source refresh do not write manuscript');
  const out=path.join(root,'exports/native-slide.pdf'),html=fs.readFileSync(path.join(root,'exports/slide-static.html'),'utf8');
  const printed=await js(`window.fig.printPdf(${JSON.stringify(html)},${JSON.stringify(out)},{})`);
  check(printed&&fs.statSync(out).size>5000,'actual printPdf IPC renders the static slide in its JavaScript-disabled print window');
  fs.writeFileSync(path.join(root,'exports/native-inline-slide.png'),(await win.webContents.capturePage()).toPNG());
  receipt.ok=true;
}catch(error){receipt.ok=false;receipt.code=error.code;receipt.blocked=error.code==='NATIVE_DISPLAY_UNAVAILABLE';receipt.error=String(error.stack||error);if(win){try{console.log('PROBE file='+await js(`window.fig.readText(${JSON.stringify(path.join(root,'paper/main.qmd'))}).catch(e=>'ERR '+e.message)`));console.log('PROBE dom='+await js("document.body.innerText.slice(0,6000)"));fs.writeFileSync(path.join(root,'exports/native-failure.png'),(await win.webContents.capturePage()).toPNG());}catch(captureError){receipt.captureError=String(captureError);}}}
finally{fs.writeFileSync(path.join(root,'exports/native-receipt.json'),JSON.stringify(receipt,null,2));console.log('PROBE result='+JSON.stringify(receipt));app.exit();}})();
