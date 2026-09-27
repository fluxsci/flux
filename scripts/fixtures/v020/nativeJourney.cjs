'use strict';
const {app,BrowserWindow,dialog}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.env.PROBE_PROJECT,out=process.env.PROBE_EVIDENCE;
if(!root||!out)throw Error('Disposable native journey context required');
process.stdin.resume();process.stdin.on('end',()=>process.exit(2));
app.disableHardwareAcceleration();
const incoming=path.join(root,'incoming.svg');
fs.writeFileSync(incoming,'<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#d0a215"/></svg>');
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[incoming]});
dialog.showSaveDialog=async(_win,options)=>({canceled:false,filePath:path.join(out,path.basename(options.defaultPath))});
require('../../../electron/main.cjs');
let win;const checks=[];
const js=source=>win.webContents.executeJavaScript(source,true);
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8'),json=rel=>JSON.parse(read(rel));
const canvas=()=>json('fig/canvases/source-canvas.json');
const figure=()=>canvas().figures.find(f=>f.id==='source-figure');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){let error;const end=Date.now()+20000;while(Date.now()<end){try{const value=await fn();if(value)return value}catch(e){error=e}await sleep(40)}throw Error('Timeout '+label+': '+(error?.message||''));}
async function click(selector){await wait(()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return false;n.click();return true})()`),selector);await js('new Promise(r=>requestAnimationFrame(r))');}
async function button(text,host=''){await wait(()=>js(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(host+' button')})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n||n.disabled)return false;n.click();return true})()`),text);await js('new Promise(r=>requestAnimationFrame(r))');}
async function key(code,modifiers=[]){win.webContents.sendInputEvent({type:'keyDown',keyCode:code,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:code,modifiers});await js('new Promise(r=>requestAnimationFrame(r))');}
function check(label){checks.push(label);console.log('PASS '+label);}
async function main(){
 win=await wait(()=>BrowserWindow.getAllWindows()[0],'window');win.setSize(1440,1000);win.show();win.focus();
 await wait(()=>js("!!window.fig&&!!document.querySelector('.cm-editor')"),'initial document');
 assert.ok(win.webContents.getURL().startsWith('file:'));assert.equal(await js('!!window.__flux'),false);assert.ok(app.getPath('userData').startsWith(process.env.PROBE_SCRATCH));
 await click('button[aria-label=Figure]');await wait(()=>js("!!document.querySelector('[data-editor-element-id=\"figure-live\"] svg')"),'scientific plot');
 await click('.sidebar .layer[data-layer-key="e:figure-live"] .item');
 await key('Right');await wait(()=>figure().elements.find(e=>e.id==='figure-live').x===21,'actual key autosave');
 await click('.toolbar button[title^="Undo"]');await wait(()=>figure().elements.find(e=>e.id==='figure-live').x===20,'Undo saved bytes');check('edit and Undo persist exact scientific position');
 await click('.toolbar button[title^="Import PNG/SVG"]');await wait(()=>figure().elements.length===4,'native import persisted');
 const imported=figure().elements.find(e=>!e.id.startsWith('figure-'));assert.ok(imported);const importedAsset=json('fig/index.json').assets.find(a=>a.id===imported.assetId);assert.ok(fs.readFileSync(path.resolve(root,'fig',importedAsset.path),'utf8').includes('#d0a215'));check('native file picker imports actual decoded asset and saves source bytes');
 await click('.toolbar button[title^="Undo"]');await wait(()=>figure().elements.length===3,'import Undo');
 await click('.sidebar .layer[data-layer-key="e:figure-live"] .item');
 // Force simultaneous edits within the autosave debounce: ordinary external
 // JSON replacement competes with a real native key event, not a test store.
 await key('Right');const external=canvas();external.figures[0].elements[0].y=91;
 fs.writeFileSync(path.join(root,'fig/canvases/source-canvas.json'),JSON.stringify(external,null,2)+'\n');
 await wait(()=>js("document.body.textContent.includes('Overwrite with mine')"),'conflict decision');
 await button('Overwrite with mine');await wait(()=>figure().elements.find(e=>e.id==='figure-live').x===21&&figure().elements[0].y===70,'explicit overwrite persisted');
 const records=fs.readdirSync(path.join(root,'.meta/figure-conflicts'));assert.ok(records.length);const recovery=fs.readFileSync(path.join(root,'.meta/figure-conflicts',records.at(-1)),'utf8');assert.ok(recovery.includes('91'));fs.writeFileSync(path.join(out,'conflict-recovery.json'),recovery);check('external divergence keeps both branches in a saved recovery record');
 // A protected canonical path becomes a directory: the real write fails and
 // the editor must retain its draft until the obstruction is removed.
 const file=path.join(root,'fig/canvases/source-canvas.json'),before=fs.readFileSync(file);fs.renameSync(file,file+'.held');fs.mkdirSync(file);
 await key('Right');await wait(()=>js("!!document.querySelector('.toolbar .save-error')"),'failed save visible');
 assert.deepEqual(fs.readFileSync(file+'.held'),before);fs.rmdirSync(file);fs.renameSync(file+'.held',file);
 await click('.toolbar .save-error');await wait(()=>figure().elements.find(e=>e.id==='figure-live').x===22,'failed draft retry');check('real filesystem write failure preserves prior bytes and owned draft through retry');
 await button('Send to deck…','.inspector');await button('Native source watcher','.inspector');await wait(()=>json('slides/watcher-talk/deck.json').slides.length===2,'Figure to Slide');
 const copied=json('slides/watcher-talk/deck.json').slides[1],original=figure().elements;assert.equal(copied.elements.length,3);
 const dx=copied.elements[0].x-original[0].x,dy=copied.elements[0].y-original[0].y;
 for(let i=0;i<original.length;i++){assert.equal(copied.elements[i].x-original[i].x,dx);assert.equal(copied.elements[i].y-original[i].y,dy);assert.equal(copied.elements[i].width,original[i].width);assert.equal(copied.elements[i].height,original[i].height);}
 check('actual Figure to Slide action preserves all content, scale and relative placement while centering');
 await click('button[aria-label=Slide]');await wait(()=>js("!!document.querySelector('.slide-mode .canvas-host')"),'Slide mode');
 // Convert the first source-linked slide using the ordinary slide inspector.
 await button('Slide','.inspector-tabs');await button('Send to canvas…');await button('Source checks');
 await wait(()=>canvas().figures.length===2,'Slide to Figure');assert.equal(canvas().figures[1].elements.length,4);check('actual Slide to Figure action publishes complete content and registration');
 await click('button[aria-label=Figure]');await wait(()=>js("!!document.querySelector('.figure-mode .canvas-host')"),'Figure reopened');
 assert.equal(await js("document.body.textContent.includes('Some figure sources could not update')"),false,'returning after conversion catches up sources against the new accepted snapshot');
 await click('.figrow[data-fig-id="source-figure"] .item');await button('SVG','.inspector');
 const exportName=await wait(()=>fs.readdirSync(out).find(name=>name.endsWith('.svg')),'native SVG export');const svg=fs.readFileSync(path.join(out,exportName),'utf8');assert.ok(svg.includes('data-probe-source="shared"'));assert.ok(svg.includes('viewBox'));check('native export contains scientific source artwork after save and conversion');
 fs.writeFileSync(path.join(out,'native-journey.png'),(await win.webContents.capturePage()).toPNG());
 const accepted=read('fig/canvases/source-canvas.json');win.webContents.reload();await click('.recent');await wait(()=>js("!!document.querySelector('.cm-editor')"),'reopen recent project');await click('button[aria-label=Figure]');await wait(()=>js("!!document.querySelector('[data-editor-element-id=\"figure-live\"] svg')"),'reopened scientific artwork');assert.equal(read('fig/canvases/source-canvas.json'),accepted);check('reopen preserves accepted composition bytes and rendered scientific source');
 fs.writeFileSync(path.join(out,'canvas.json'),accepted);fs.writeFileSync(path.join(out,'deck.json'),read('slides/watcher-talk/deck.json'));fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2));
}
app.whenReady().then(()=>main().then(()=>process.exit(0)).catch(async error=>{try{fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(await js('document.body.innerText'))}catch{}console.error(error);process.exit(1)}));
