'use strict';
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS='1';
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const scratch=process.env.PROBE_SCRATCH,root=process.env.PROBE_PROJECT;
if(!scratch||!root)throw Error('Hermetic probe context required');
require('../../electron/main.cjs');
let win,child;const checks=[];
const js=(w,code)=>Promise.race([w.webContents.executeJavaScript(code,true),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error("Renderer did not respond: "+code.slice(0,100))),12000);timer.unref()})]);
const check=(ok,label)=>{checks.push({ok:!!ok,label});console.log('PROBE '+JSON.stringify(checks.at(-1)));if(!ok)throw Error(label)};
async function wait(fn,label){const t=Date.now();while(Date.now()-t<15000){try{const r=await fn();if(r)return r}catch{}await new Promise(r=>setTimeout(r,60))}throw Error('Timeout: '+label)}
async function click(w,selector){console.log("PROBE click="+selector);const p=await js(w,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');n.scrollIntoView({block:'nearest'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});}
const key=(w,keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers})};
const saved=()=>JSON.parse(fs.readFileSync(path.join(root,'fig/canvases/c.json'),'utf8')).figures.find(f=>f.id==='native-5');
async function pin(){await click(win,'.pinbtn');child=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==win),'child window');child.show();child.focus();await wait(()=>js(child,"!!document.querySelector('.detached .importer')"),'mounted child gallery')}
async function main(){
 win=await wait(()=>BrowserWindow.getAllWindows()[0],'app window');win.show();win.focus();win.setAlwaysOnTop(true);
 win.webContents.on('console-message',(_e,details)=>{if(details.level==='error')console.log('PROBE renderer='+details.message)});
 await wait(()=>js(win,"!!document.querySelector('.cm-editor')"),'initial Paper');
 check(app.getPath('userData').startsWith(scratch+path.sep),'isolated native config');
 check(win.webContents.getURL().startsWith('file:')&&await js(win,'!window.__flux'),'production file renderer');
 await click(win,'button[aria-label=Figure]');await wait(()=>js(win,"!!document.querySelector('.figure-mode .canvas-host')"),'Figure');
 await click(win,'.figrow[data-fig-id="native-5"] .item');await wait(()=>js(win,"!!document.querySelector('[data-editor-element-id=\"e5-0\"]')"),'small figure visible');key(win,'i',['alt']);await wait(()=>js(win,"!!document.querySelector('.importer')"),'gallery');
 await click(win,'.row[title=study]');await wait(()=>js(win,"!!document.querySelector('.preview img')?.naturalWidth"),'SVG thumbnail');
 await click(win,'.row[title="growth.svg"]');await pin();
 check(child.isResizable(),'native child is resizable');
 check(await js(child,"!window.fig && !window.__flux && !window.require"),'gallery has no preload bridge or independent project runtime');
 check(await js(child,"document.querySelector('.cur').textContent==='study'&&document.querySelector('.pickpill').textContent==='1 selected'"),'pin preserves folder and picks');
 child.setPosition(140,130);check(child.getPosition()[0]===140,'native gallery can move independently');
 // A pinned gallery must observe its own viewport even when the owning editor
 // has no rendering frames. Its mounted Svelte state still belongs to that editor.
 win.hide();child.focus();
 await js(child,"(()=>{const n=document.querySelector('[aria-label=\"Preview size\"]');n.value='320';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))})()");
 for(const [width,height,columns]of [[520,600,1],[1100,820,3]]){
  child.setSize(width,height);await wait(()=>js(child,`innerWidth>=${width-30}&&innerWidth<=${width}`),'window resized');
  check(await js(child,"(()=>{const b=document.querySelector('.insbtn').getBoundingClientRect();return b.right<=innerWidth&&b.bottom<=innerHeight})()"),`controls fit native ${width}px window`);
  await wait(()=>js(child,`getComputedStyle(document.querySelector('.items')).gridTemplateColumns.split(' ').length===${columns}`),'grid reflows with hidden owner');
  check(true,`native gallery reflows at ${width}px with hidden owner`);
 }
 win.show();
 await click(child,'.rootbtn');await wait(()=>js(child,"!!document.querySelector('.row[title=other]')"),'root navigation');await click(child,'.row[title=other]');await wait(()=>js(child,"document.querySelector('.cur').textContent==='other'"),'other folder');await click(child,'.row[title="growth.svg"]');
 check(await js(child,"document.querySelector('.pickpill').textContent==='2 selected'"),'pinned gallery navigates entire plots tree');
 const before=saved().elements.length;
 await click(child,'.insbtn');await wait(()=>saved().elements.length===before+2,'insert persisted');
 check(!child.isDestroyed()&&await js(child,"!!document.querySelector('.importer')"),'native gallery remains open after insert');
 const added=saved().elements.slice(-2);check(added.every(e=>e.width===96&&e.height===64),'native import retains physical dimensions');
 // Real editor key event while the native utility stays open; check saved bytes.
 win.focus();key(win,'Right');await wait(()=>saved().elements.at(-1).x===added[1].x+1,'parent keyboard persisted');check(true,'parent editing stays live while gallery is pinned');
 key(win,'z',[process.platform==='darwin'?'meta':'control']);await wait(()=>saved().elements.at(-1).x===added[1].x,'nudge undo');
 key(win,'z',[process.platform==='darwin'?'meta':'control']);await wait(()=>saved().elements.length===before,'import undo');check(true,'batch is one durable undo step');
 child.focus();await click(child,'.insbtn');await wait(()=>saved().elements.length===before+2,'repeat insertion');
 fs.writeFileSync(path.resolve(__dirname,'../../test-results/plot-gallery-native.png'),(await child.webContents.capturePage()).toPNG());
 // Navigation has no route to turn this utility into an external/privileged page.
 await js(child,"location.href='https://example.com';void 0");await new Promise(r=>setTimeout(r,100));
 check(child.webContents.getURL().endsWith('/plot-gallery.html'),'utility navigation denied');
 child.close();await wait(()=>child.isDestroyed(),'native close');win.focus();key(win,'i',['alt']);await wait(()=>js(win,"!!document.querySelector('.importer')"),'reopen after native close');
 await pin();win.destroy();await wait(()=>child.isDestroyed(),'owner closes child');check(true,'closing project owner closes utility');
 fs.writeFileSync(path.resolve(__dirname,'../../test-results/plot-gallery-native.json'),JSON.stringify(checks,null,2));
}
app.whenReady().then(()=>main().then(()=>{fs.writeSync(1,'PROBE result=PASS\n');process.exit(0)}).catch(async e=>{try{if(child&&!child.isDestroyed())fs.writeFileSync(path.resolve(__dirname,'../../test-results/plot-gallery-native-failure.png'),(await child.webContents.capturePage()).toPNG())}catch{}fs.writeSync(1,'PROBE result='+String(e.stack||e)+'\n');process.exit(1)}));
setTimeout(()=>process.exit(2),90000);
