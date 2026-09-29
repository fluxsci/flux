'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const scratch=process.env.PROBE_SCRATCH,root=process.env.PROBE_PROJECT;
if(!scratch||!root)throw Error('Hermetic probe context required');
require('../../electron/main.cjs');
const checks=[],errors=[];let win,child;
const js=(w,code)=>w.webContents.executeJavaScript(code,true);
const check=(ok,label)=>{checks.push({ok:!!ok,label});console.log('PROBE '+JSON.stringify(checks.at(-1)));if(!ok)throw Error(label);};
async function wait(fn,label){const start=Date.now();while(Date.now()-start<15000){try{const result=await fn();if(result)return result;}catch{}await new Promise(r=>setTimeout(r,60));}throw Error('Timeout: '+label);}
async function click(w,selector){const p=await js(w,`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing control');const b=el.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);w.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});w.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});}
const key=(w,keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});};
async function main(){
 win=await wait(()=>BrowserWindow.getAllWindows()[0],'owner');win.show();win.focus();
 win.webContents.on('console-message',(_e,d)=>{if(d.level==='error')errors.push(d.message);});
 await wait(()=>js(win,"!!document.querySelector('.cm-editor')"),'Paper loaded');
 check(app.getPath('userData').startsWith(scratch+path.sep),'native state is isolated');
 check(win.webContents.getURL().startsWith('file:')&&await js(win,'!window.__flux'),'production renderer without dev hooks');
 await click(win,'button[aria-label=Figure]');await wait(()=>js(win,"!!document.querySelector('.canvas-host')"),'Figure');
 key(win,'g',['alt']);await wait(()=>js(win,"!!document.querySelector('.pinbtn')"),'gallery');await click(win,'.pinbtn');
 child=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==win),'utility');child.show();child.focus();
 await wait(()=>js(child,"!!document.querySelector('.detached .importer')"),'child gallery mounted');
 check(await js(child,'!window.fig'),'child has no independent project bridge');
 // An unmistakable pixel marker belongs ONLY to the child document.
 await js(child,"(()=>{const n=document.createElement('div');n.style.cssText='position:fixed;left:0;top:0;width:64px;height:64px;background:rgb(12,200,90);z-index:99999;pointer-events:none';document.body.appendChild(n)})()");
 const size=await js(child,'({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})');
 key(child,'m',[process.platform==='darwin'?'meta':'control','shift']);
 await wait(()=>js(win,"document.activeElement===document.querySelector('.annotation-composer textarea')"),'opener composer focused');
 check(!await js(child,"!!document.querySelector('[data-annotation-surface]')"),'overlay renders in the opener');
 const captured=await js(win,"(()=>{const img=document.querySelector('.annotation-shot');if(!img?.naturalWidth)return null;const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return {width:c.width,height:c.height,pixel:[...ctx.getImageData(8,8,1,1).data]}})()");
 check(captured&&captured.pixel.slice(0,3).join()==='12,200,90','win:capture captured the focused child’s pixels');
 check(Math.abs(captured.width-size.w*size.dpr)<=2&&Math.abs(captured.height-size.h*size.dpr)<=2,'frozen picture uses child dimensions and scale');
 win.focus();await js(win,"(()=>{const t=document.querySelector('.annotation-composer textarea');t.value='Native child review';t.dispatchEvent(new Event('input',{bubbles:true}));t.focus()})()");key(win,'Return');
 const ledger=path.join(root,'.meta/feedback.ndjson');await wait(()=>fs.existsSync(ledger),'ledger on disk');
 const lines=fs.readFileSync(ledger,'utf8').trim().split('\n').map(JSON.parse),note=lines[0];
 check(lines.length===1&&note.kind==='note'&&note.text==='Native child review','one durable annotation line');
 check(note.context.window.kind==='utility'&&note.context.window.name==='gallery'&&note.context.snapshot.window.w===size.w,'stamp identifies gallery utility and child viewport');
 check(fs.readFileSync(path.join(root,note.context.snapshot.image)).subarray(0,4).equals(Buffer.from([137,80,78,71])),'child PNG is durable before the ledger reference');
 // Explicit child ids are scoped to the opener; an unrelated window is refused.
 const stranger=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 check(await js(win,`window.fig.captureWindow({target:'child',childId:${stranger.webContents.id}}).then(()=>false,()=>true)`),'capture refuses another window’s webContents');stranger.destroy();
 // Inbox shares the inert utility lifecycle and forwards Annotate as well.
 child.close();await wait(()=>js(win,"!document.querySelector('.detached .importer')"),'gallery closed');
 win.focus();key(win,'q',['alt']);await wait(()=>js(win,"!!document.querySelector('[data-inbox-row]')"),'Inbox items');
 await click(win,'.inbox-panel header button:first-of-type');
 child=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==win),'Inbox utility');child.show();child.focus();
 await wait(()=>js(child,"!!document.querySelector('.detached .inbox-panel')"),'Inbox mounted in child');
 check(await js(child,'!window.fig'),'Inbox child is inert, without a second bridge');
 await js(child,"(()=>{const t=document.querySelector('textarea');t.value='Retain native reply';t.dispatchEvent(new Event('input',{bubbles:true}))})()");
 child.setSize(720,540);await wait(()=>js(child,"document.querySelector('.inbox-list').clientHeight<500"),'Inbox resized');
 check(await js(child,"document.querySelector('.inbox-panel').getBoundingClientRect().width===innerWidth"),'pinned Inbox fits resized native window');
 key(child,'m',[process.platform==='darwin'?'meta':'control','shift']);
 await wait(()=>js(win,"document.activeElement===document.querySelector('.annotation-composer textarea')"),'Inbox forwarded Annotate');
 check(await js(win,"document.querySelector('.annotation-composer .context').textContent.includes('inbox')"),'Annotate stamp names the Inbox utility');
 win.focus();key(win,'Escape');await wait(()=>js(win,"!document.querySelector('[data-annotation-surface]')"),'Annotate dismissed');
 child.focus();await click(child,'.inbox-panel header button:first-of-type');
 await wait(()=>js(win,"!!document.querySelector('.inbox-panel textarea')"),'Inbox docked');
 check(await js(win,"document.querySelector('.inbox-panel textarea').value==='Retain native reply'"),'native dock preserves the draft');
 await click(win,'.inbox-panel header button:first-of-type');child=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==win),'repinned Inbox');
 await wait(()=>js(child,"!!document.querySelector('.inbox-panel')"),'repinned mount');child.close();
 await wait(()=>js(win,"!document.querySelector('.inbox-panel')"),'native Inbox close cleanup');
 check(true,'native close disposes the utility and its mounted panel');
 check(errors.length===0,'clean renderer console');
 fs.writeFileSync(path.resolve(__dirname,'../../test-results/annotate-utility-native.json'),JSON.stringify(checks,null,2));
 if(child&&!child.isDestroyed())child.destroy();win.destroy();
}
app.whenReady().then(()=>main().then(()=>{fs.writeSync(1,'PROBE result=PASS\n');process.exit(0)}).catch(e=>{fs.writeSync(1,'PROBE '+String(e.stack||e)+'\n');process.exit(1)}));
setTimeout(()=>process.exit(2),90000);
