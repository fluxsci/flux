'use strict';
// Real GUI, preload, handlers and Quarto. Only test barriers wrap completed IPC.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const childProcess=require('node:child_process');
const {app,BrowserWindow,dialog,ipcMain}=require('electron');
const root=process.env.PROBE_PROJECT,mode=process.env.PROBE_MODE,phase=process.env.PROBE_PHASE,artifact=process.env.PROBE_ARTIFACT;
if(!root||!artifact)throw Error('Isolated project and artifact required');
const originals=JSON.parse(fs.readFileSync(path.join(root,'fixture-originals.json'),'utf8'));
const journal=path.join(root,'.meta/export-source-transaction.json'),out=path.join(root,'exports/prior.docx');
let armed=false,journalSeen=false,renderStarted=false,latched=false,win,snapshotPaused=false,releaseSnapshot;
const typed=" LIVE_EDIT_DURING_QUARTO";let typingEvidence;
const oldHandle=ipcMain.handle.bind(ipcMain),oldSpawn=childProcess.spawn;
function report(extra={}){return{mode,phase,root,renderStarted,journal:fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal,'utf8')):null,sources:Object.fromEntries(Object.keys(originals).map(rel=>[rel,{text:fs.readFileSync(path.join(root,rel),'utf8'),mtime:fs.statSync(path.join(root,rel)).mtimeMs}])),...extra};}
function barrier(name){if(latched||mode!=='export'||phase!==name)return null;latched=true;fs.writeFileSync(artifact,JSON.stringify(report({barrier:name}),null,2));fs.writeSync(1,`GUI_EXPORT_BARRIER ${name}\n`);return new Promise(()=>{});}
ipcMain.handle=(name,handler)=>oldHandle(name,async(e,...args)=>{
 const result=await handler(e,...args);
 if(armed&&phase==='revision'&&!snapshotPaused&&name==='fs:readText'&&args[0]===path.join(root,'references/library.bib')) {
  snapshotPaused=true;await new Promise(resolve=>releaseSnapshot=resolve);
 }
 if(!armed||mode!=='export')return result;
 const p=typeof args[0]==='string'?path.resolve(args[0]):null;
 if(name==='fs:writeText'&&p===journal)journalSeen=true;
 if(name==='fs:fsyncDir'&&p===path.join(root,'.meta')&&journalSeen){
  if(fs.existsSync(journal)&&Object.entries(originals).every(([rel,text])=>fs.readFileSync(path.join(root,rel),'utf8')===text)){const hold=barrier('journal');if(hold)await hold;}
  if(!fs.existsSync(journal)){const hold=barrier('restored');if(hold)await hold;}
 }
 if(name==='fs:writeText'&&p&&Object.hasOwn(originals,path.relative(root,p))&&fs.existsSync(journal)){
  const rel=path.relative(root,p),text=fs.readFileSync(p,'utf8');
  if(text!==originals[rel]){const hold=barrier('rewrite');if(hold)await hold;}
  else if(renderStarted){const hold=barrier('restore');if(hold)await hold;}
 }
 return result;
});
childProcess.spawn=function(command,args,opts){const child=oldSpawn.call(this,command,args,opts);if(armed&&Array.isArray(args)&&args.includes('render')){
 const started=chunk=>{if(!String(chunk).trim())return;renderStarted=true;};child.stdout?.on('data',started);child.stderr?.on('data',started);
 }return child;};
dialog.showSaveDialog=async()=>({canceled:false,filePath:out});
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});
app.disableHardwareAcceleration();
require('../../electron/entry.cjs');
const js=code=>win.webContents.executeJavaScript(code,true);
async function wait(fn,label,timeout=30000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){last=e.message;}await new Promise(r=>setTimeout(r,30));}throw Error(`Timeout ${label}${last?': '+last:''}`);}
async function click(selector,text){const pos=await wait(()=>js(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const n=nodes.find(n=>!n.disabled&&${text?`new RegExp(${JSON.stringify(text)},'i').test(n.textContent.trim())`:'true'});if(!n)return null;const b=n.getBoundingClientRect();return b.width&&b.height?{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}:null;})()`),selector+' '+(text||''));win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...pos});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...pos});}
async function main(){
 win=await wait(()=>BrowserWindow.getAllWindows()[0],'window');win.setSize(1280,900);win.show();win.focus();
 await wait(()=>js("!!window.fig?.readText && !!document.querySelector('.wordmark')"),'native Home');
 await click('button','^Open$');
 if(mode==='conflict'){
  await wait(()=>js("document.body.innerText.includes('Export recovery needs attention')"),'visible recovery conflict');
  assert.equal(await js("!!document.querySelector('.cm-editor')"),false,'unsafe authoring never adopted');
  fs.writeFileSync(artifact,JSON.stringify(report({visibleConflict:true}),null,2));fs.writeSync(1,'GUI_RECOVERY_DONE conflict\n');process.exit(0);
 }
 await wait(()=>js("!!document.querySelector('.paper[data-paper-sources-ready=\"true\"] .cm-editor')"),'Paper source-ready');
 assert.equal(await js('!!window.__flux'),false,'built renderer has no dev handles');
 if(mode==='recover'){
  assert.equal(fs.existsSync(journal),false,'startup recovery removes journal');
  for(const [rel,text]of Object.entries(originals)){assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),text);assert.equal(fs.statSync(path.join(root,rel)).mtimeMs,1600000000000);}
  await fs.promises.writeFile(artifact,JSON.stringify(report({reopened:true}),null,2));fs.writeSync(1,'GUI_RECOVERY_DONE recovered\n');process.exit(0);
 }
 for(const [rel,text]of Object.entries(originals))assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),text,'opening preserves exact source bytes');
 await click('.statusbar .seg','export');await wait(()=>js("!!document.querySelector('.export-dialog')"),'export dialog');
 await click('.export-dialog .seg','Word');await wait(()=>js("document.querySelector('.export-dialog .path-text')?.textContent.trim().endsWith('.docx')"),'Word destination');
 await click('.export-dialog button','Change');await wait(()=>js(`document.querySelector('.export-dialog .path-text')?.textContent.trim()===${JSON.stringify(out)}`),'chosen destination');
 armed=true;await click('.export-dialog button.primary','Export');
 if(phase==='render') {
  await wait(()=>fs.existsSync(path.join(root,'render-ready')),'actual Quarto filter entered controlled render barrier');
  await barrier('render');
 }
 if(phase==='revision') {
  await wait(()=>snapshotPaused,'export captured job before delayed bibliography completion');
  // Real canonical files plus the actual native watcher refresh Paper to a new
  // revision while the exporting job is blocked after its immutable capture.
  for(const rel of ['fig/index.json','fig/canvases/kill-canvas.json']) {
   const p=path.join(root,rel);let source=fs.readFileSync(p,'utf8');
   source=source.replaceAll('#4385be','#d14d41').replaceAll('Unicode α scientific caption; mean 3.25 ± 0.5.','NEW CAPTION MUST NOT EXPORT 99.25');
   fs.writeFileSync(p,source);
  }
  await wait(()=>js(`(async()=>{const im=document.querySelector('.flux-embed-art img');if(!im||!im.complete)return false;const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const x=c.getContext('2d');x.drawImage(im,0,0);const p=x.getImageData(c.width/2,c.height/2,1,1).data;return p[0]>180&&p[1]<100;})()`),'new live Figure revision decoded in Paper');
  fs.writeFileSync(path.join(root,'references/library.bib'),'@article{snapshot2020, title={NEW BIBLIOGRAPHY MUST NOT EXPORT}, author={Researcher, Ada}, year={2020}, journal={Scientific Record}}\n');
  releaseSnapshot();await wait(()=>fs.existsSync(path.join(root,'render-ready')),'actual Quarto filter is awaiting release');
  await js(`(()=>{const e=document.querySelector('.cm-content');e.focus();window.__typedPaint=[];e.addEventListener('keydown',ev=>{if(ev.key.length===1){const t=ev.timeStamp;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__typedPaint.push({trusted:ev.isTrusted,ms:performance.now()-t})));}});})()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'End',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'End',modifiers:['control']});
  for(const key of typed){win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'char',keyCode:key});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});}
  await wait(()=>js(`document.querySelector('.cm-content').textContent.includes(${JSON.stringify(typed.trim())})`),'real typing while Quarto held');
  await wait(()=>js(`window.__typedPaint.length===${typed.length}`),'trusted input frame evidence');
  typingEvidence=await js('window.__typedPaint');assert.ok(typingEvidence.every(e=>e.trusted&&e.ms<=100),'typing reaches painted frames within100ms while actualQuarto transaction held');
  assert.ok(!fs.readFileSync(path.join(root,'paper/notes.qmd'),'utf8').includes(typed),'autosave cannot overwrite temporary source while Quarto owns it');
  fs.writeFileSync(path.join(root,'render-release'),'release');
 }

 if(phase==='control'||phase==='revision'){
  await wait(()=>fs.existsSync(out)&&fs.readFileSync(out).subarray(0,2).toString()==='PK','validated Word publication',60000);
  assert.ok(renderStarted,'actual Quarto rendering occurred');assert.equal(fs.existsSync(journal),false);
  if(phase==='revision')await wait(()=>fs.readFileSync(path.join(root,'paper/notes.qmd'),'utf8').includes(typed),'new live edit saves after restoration');
  for(const [rel,text]of Object.entries(originals)){const actual=fs.readFileSync(path.join(root,rel),'utf8');assert.equal(actual,phase==='revision'&&rel==='paper/notes.qmd'?text.replace(/\r\n?/g,'\n')+typed: text);}
  const zip=require('fflate').unzipSync(fs.readFileSync(out)),png=Object.entries(zip).find(([p])=>/^word\/media\/.*\.png$/i.test(p));assert.ok(png,'Word fallback PNG exists');
  if(phase==='revision'){const xml=require('fflate').strFromU8(zip['word/document.xml']);assert.ok(xml.includes('3.25')&&!xml.includes('99.25')&&!xml.includes(typed.trim())&&xml.toLowerCase().includes('captured old reference')&&!xml.toLowerCase().includes('new bibliography'),'Word uses captured caption/source/bibliography, not newer live revisions');}
  fs.writeFileSync(artifact+'.docx',fs.readFileSync(out));
  fs.writeFileSync(artifact+'.document.xml',zip['word/document.xml']);
  fs.writeFileSync(artifact+'.figure.png',png[1]);
  const pixel=await js(`(async()=>{const image=new Image();image.src=${JSON.stringify('data:image/png;base64,'+Buffer.from(png[1]).toString('base64'))};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data];})()`);
  assert.ok(pixel.every((v,i)=>Math.abs(v-[67,133,190,255][i])<=1),'actual decoded Word figure preserves authored blue signal');
  fs.writeFileSync(artifact,JSON.stringify(report({published:true,wordFigurePixel:pixel,typingEvidence,capturedRevision:phase==='revision'}),null,2));fs.writeFileSync(artifact+'.png',(await win.webContents.capturePage()).toPNG());fs.writeSync(1,'GUI_EXPORT_DONE\n');process.exit(0);
 }
 await new Promise(()=>{});
}
app.whenReady().then(()=>main()).catch(async e=>{try{fs.writeFileSync(artifact+'.failure.txt',await js('document.body.innerText'));fs.writeFileSync(artifact+'.failure.png',(await win.webContents.capturePage()).toPNG());}catch{}console.error(e.stack||e);process.exit(1);});
setTimeout(()=>{console.error('GUI export native watchdog');process.exit(2);},75000);
