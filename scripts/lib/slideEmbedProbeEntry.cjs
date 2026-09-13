'use strict';
const fs=require('node:fs'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();
const root=process.env.PROBE_PROJECT,scratch=process.env.PROBE_SCRATCH;
if(!root||!scratch)throw Error('Isolated probe paths required');
require('../../electron/main.cjs');
const checks=[];let win;const js=code=>win.webContents.executeJavaScript(code,true);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const start=Date.now();while(Date.now()-start<20000){if(await fn())return;await pause(80);}throw Error('Timeout: '+label);}
function check(ok,label){checks.push({ok:!!ok,label});console.log('PROBE check='+JSON.stringify(checks.at(-1)));if(!ok)throw Error(label);}
async function click(selector){const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});}
(async()=>{try{
  await wait(async()=>{win=BrowserWindow.getAllWindows()[0];return !!win;},'native window');
  console.log('PROBE boot='+JSON.stringify({userData:app.getPath('userData'),root}));
  await wait(()=>js("!!document.querySelector('.cm-editor .flux-slide-art')"),'inline slide in built Paper');
  check(app.getPath('userData').startsWith(scratch+path.sep),'native config is isolated');
  check(await js("!window.__flux&&typeof window.fig.printPdf==='function'"),'built renderer and actual preload, no dev handle');
  check(await js("document.querySelector('.flux-slide-bar').textContent.includes('Step 0 / 2')"),'native slide starts at step 0');
  const source=fs.readFileSync(path.join(root,'paper/main.qmd'),'utf8');
  await click('.cm-editor [aria-label="Next animation step"]');
  await wait(()=>js("document.querySelector('.flux-slide-bar').textContent.includes('Step 1 / 2')"),'native click playback');
  check(true,'native pointer input advances one animation');
  const deckPath=path.join(root,'slides/talk/deck.json');let deck=JSON.parse(fs.readFileSync(deckPath,'utf8'));deck.slides[0].name='Revised results';fs.writeFileSync(deckPath,JSON.stringify(deck));
  await wait(()=>js("document.querySelector('.flux-slide-title').textContent.includes('Revised results')"),'external deck watcher refresh');
  check(await js("document.querySelector('.flux-slide-bar').textContent.includes('Step 1 / 2')"),'source refresh retains the authored beat identity');
  check(fs.readFileSync(path.join(root,'paper/main.qmd'),'utf8')===source,'playback and source refresh do not write manuscript');
  const out=path.join(root,'exports/native-slide.pdf'),html=fs.readFileSync(path.join(root,'exports/slide-static.html'),'utf8');
  const printed=await js(`window.fig.printPdf(${JSON.stringify(html)},${JSON.stringify(out)},{})`);
  check(printed&&fs.statSync(out).size>5000,'actual printPdf IPC renders the static slide in its JavaScript-disabled print window');
  fs.writeFileSync(path.join(root,'exports/native-inline-slide.png'),(await win.webContents.capturePage()).toPNG());
  console.log('PROBE result='+JSON.stringify({ok:true,checks}));
}catch(error){if(win){console.log('PROBE file='+await js(`window.fig.readText(${JSON.stringify(path.join(root,'paper/main.qmd'))}).catch(e=>'ERR '+e.message)`));console.log('PROBE dom='+await js("document.body.innerText.slice(0,6000)"));fs.writeFileSync(path.join(root,'exports/native-failure.png'),(await win.webContents.capturePage()).toPNG());}console.log('PROBE result='+JSON.stringify({ok:false,checks,error:String(error.stack||error)}));}finally{app.exit();}})();
