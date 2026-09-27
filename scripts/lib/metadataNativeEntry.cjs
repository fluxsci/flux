'use strict';
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS='1';
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const root=process.env.PROBE_PROJECT,out=process.env.PROBE_ARTIFACTS;
if(!root||!out)throw Error('Disposable probe context required');
require('../../electron/main.cjs');
let win,child;
const js=(w,s)=>Promise.race([w.webContents.executeJavaScript(s,true),new Promise((_,reject)=>setTimeout(()=>reject(Error('Renderer timeout: '+s.slice(0,150))),10000).unref())]);
const check=(ok,label)=>{console.log('PROBE '+JSON.stringify({ok:!!ok,label}));if(!ok)throw Error(label)};
async function wait(f,label){const start=Date.now();while(Date.now()-start<18000){try{const r=await f();if(r)return r}catch{}await new Promise(r=>setTimeout(r,50))}throw Error('Timeout: '+label)}
async function click(w,selector){console.log('PROBE click='+selector);const p=await js(w,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');n.scrollIntoView({block:'nearest'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});}
const key=(w,keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers})};
async function fill(w,selector,text){await click(w,selector);await wait(()=>js(w,`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),'field focused');key(w,'a',[process.platform==='darwin'?'meta':'control']);await wait(()=>js(w,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e.selectionStart===0&&e.selectionEnd===e.value.length})()`),'field selected');await w.webContents.insertText(text);await wait(()=>js(w,`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`),'text delivered');}
const saved=(canvas='c')=>JSON.parse(fs.readFileSync(path.join(root,`fig/canvases/${canvas}.json`),'utf8')).figures[0];
async function pinned(){child=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==win),'utility window');child.show();child.focus();await wait(()=>js(child,"!!document.querySelector('.detached .figure-meta')"),'metadata in native child');}
async function main(){
 win=await wait(()=>BrowserWindow.getAllWindows()[0],'main');win.show();win.focus();
 await wait(()=>js(win,"!!document.querySelector('.cm-editor')"),'cold Paper');
 check(win.webContents.getURL().startsWith('file:')&&await js(win,'!window.__flux'),'production renderer');
 key(win,'m',['alt','shift']);await pinned();
 check(await js(child,'!window.fig&&!window.__flux&&!window.require'),'utility has no privileged preload or independent runtime');
 await wait(()=>js(child,"document.querySelectorAll('.figure-row').length===2"),'all figures loaded');check(true,'cold Paper lists figures across canvases');
 await fill(child,'[aria-label="a caption"]','Native cold caption');key(child,'Tab');
 await wait(()=>saved().captions['label-0']==='Native cold caption','cold metadata disk save');
 check(fs.readFileSync(path.join(root,'fig/captions/meta-0.md'),'utf8').includes('Native cold caption'),'readable caption and canonical model agree');
 check(saved().captions.orphan==='Keep orphan','orphan captions preserved');
 await click(child,'.add-ps');await fill(child,'[aria-label="ps caption"]','Native closing sentence.');key(child,'Tab');
 await wait(()=>saved().captions.__ps__==='Native closing sentence.','postscript saved');
 check(fs.readFileSync(path.join(root,'fig/captions/meta-0.md'),'utf8').trim().endsWith('Native closing sentence.')&&!fs.readFileSync(path.join(root,'fig/captions/meta-0.md'),'utf8').includes('**ps**'),'native closing prose persists with no output label');

 await click(child,'.tabs button:nth-child(2)');await wait(()=>js(child,"!!document.querySelector('[aria-label=\"Figure title\"]')"),'Name');
 await fill(child,'[aria-label="Figure title"]','Native title');await click(child,'.new-family');await fill(child,'[aria-label="Family name"]','Movie');key(child,'Enter');await click(child,'.save');
 await wait(()=>saved().family==='movie'&&saved().nickname==='Native title','custom family saved');
 check(saved().referenceKey==='fig-meta-0','permanent references retained');
 await click(child,'.tabs button:first-child');await wait(()=>js(child,"!!document.querySelector('[aria-label=\"Figure caption\"]')"),'captions tab');win.hide();child.focus();child.setSize(820,660);await wait(()=>js(child,'innerWidth<830'),'utility resized with hidden owner');
 await fill(child,'[aria-label="Figure caption"]','Long native caption. '.repeat(60));key(child,'Tab');
 await wait(()=>js(child,"[...document.querySelectorAll('textarea')].every(t=>t.scrollHeight<=t.clientHeight+2)"),'fields refit with hidden owner');check(true,'native resize refits captions while owner is hidden');
 await wait(()=>js(child,`(()=>{const v=document.querySelector('.preview-viewport'),s=document.querySelector('.preview-sheet');const a=v.getBoundingClientRect(),b=s.getBoundingClientRect();return b.top>=a.top-1&&b.bottom<=a.bottom+1&&b.left>=a.left-1&&b.right<=a.right+1})()`),'whole figure and caption fit with hidden owner');
 await click(child,'[aria-label="Collapse a caption"]');await wait(()=>js(child,`!document.querySelector('[aria-label="a caption"]')`),'caption folded after native input delivery');check(true,'native caption folding');
 await click(child,'[aria-label="Increase caption text size"]');await click(child,'[aria-label="Expand a caption"]');
 await click(child,'[aria-label="Zoom in preview"]');await wait(()=>js(child,`document.querySelector('.preview-viewport').dataset.fit==='false'`),'native zoom');
 await click(child,'[aria-label="Fit figure and caption"]');
 await wait(()=>js(child,`document.querySelector('.preview-viewport').dataset.fit==='true'`),'native fit click delivered');check(true,'native zoom returns to fit');
 fs.writeFileSync(path.join(out,'metadata-pinned.png'),(await child.webContents.capturePage()).toPNG());
 win.show();await click(child,'.pin');await wait(()=>child.isDestroyed(),'docked utility closes');win.focus();key(win,'Escape');await wait(()=>js(win,"!document.querySelector('.figure-meta')"),'docked focus supports Escape');
 await click(win,'button[aria-label=Figure]');await wait(()=>js(win,"!!document.querySelector('.figure-mode .canvas-host')"),'resident Figure');key(win,'m',['alt','shift']);await pinned();
 await fill(child,'[aria-label="a caption"]','Saved on native close');child.close();await wait(()=>saved().captions['label-0']==='Saved on native close','OS close saves unblurred caption');
 check(true,'resident Figure autosave persists edits on native close');
 win.webContents.reload();await wait(()=>js(win,"!!document.querySelector('.recent')"),'Home after reload');await click(win,'.recent');await wait(()=>js(win,"!!document.querySelector('.cm-editor,.figure-mode .canvas-host')"),'reloaded workspace');key(win,'m',['alt']);await wait(()=>js(win,"document.querySelector('[aria-label=\"a caption\"]')?.value==='Saved on native close'"),'reloaded caption');check(true,'reload reads exact saved metadata');check(await js(win,`document.querySelector('[aria-label="ps caption"]')?.value==='Native closing sentence.'`),'postscript survives full native reload');
 await click(win,'header [aria-label="Close Figure-Meta"]');await click(win,'button[aria-label=Figure]');await wait(()=>js(win,"!!document.querySelector('.figure-mode .canvas-host')"),'Figure again');key(win,'g',['alt','shift']);
 child=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==win),'direct gallery');await wait(()=>js(child,"!!document.querySelector('.detached .importer')"),'direct gallery mounted');check(true,'Shift+Alt+G creates the native gallery directly');
 child.close();win.destroy();
}
app.whenReady().then(()=>main().then(()=>{console.log('PROBE result=PASS');process.exit(0)}).catch(async e=>{for(const [name,w]of [['owner',win],['child',child]])try{if(w&&!w.isDestroyed()&&w.isVisible())fs.writeFileSync(path.join(out,`failure-${name}.png`),(await w.webContents.capturePage()).toPNG())}catch{}console.error(e);process.exit(1)}));
setTimeout(()=>process.exit(2),100000).unref();
