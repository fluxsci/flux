import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,waitFor,waitForFrame,OUT,realErrors} from './lib/driver.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const {browser,page}=await launch();const evidence=[];
try{
for(const fault of ['deleted-canvas','corrupt-canvas','corrupt-index','caption-dual','future','ENOSPC','EACCES']){
 console.log('Conflict action: '+fault);
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Figure');await waitFor(page,()=>!!document.querySelector('.canvas-host')||!!window.__flux?.get(window.__flux.fig.project).figures.length);
 const before=await page.evaluate(async fault=>{
  const F=window.__flux,s=F.fig,fb=window.fig,root=F.get(F.shell.projectModel).root;await F.bridge.saveFigFrom(root);const f=F.get(s.project).figures[0],canvas=`${root}/fig/canvases/${f.canvasId}.json`,index=`${root}/fig/index.json`,caption=`${root}/fig/captions/${f.id}.md`;
  s.commit(p=>{p.figures[0].width+=17;if(fault==='caption-dual')p.figures[0].captions={__figure__:'editor-caption'}});
  let target=canvas,external=null;
  if(fault==='deleted-canvas')fb._files.delete(canvas);
  else if(fault==='corrupt-canvas'){external='{ broken';await fb.writeText(canvas,external)}
  else if(fault==='corrupt-index'){target=index;external='{ broken-index';await fb.writeText(index,external)}
  else if(fault==='caption-dual'){target=caption;external='disk-caption\n';await fb.writeText(caption,external)}
  else if(fault==='future'){target=index;const idx=JSON.parse(await fb.readText(index));idx.schemaVersion='99.0.0';external=JSON.stringify(idx);await fb.writeText(index,external)}
  else {const c=JSON.parse(await fb.readText(canvas));c.figures[0].width+=3;external=JSON.stringify(c);await fb.writeText(canvas,external)}
  const snapshot=[...fb._files].filter(([p])=>p===index||p===canvas||p===caption).map(([p,b])=>[p,new TextDecoder().decode(b)]);
  fb._emitFsChange({subsystem:'fig',path:target});window.__conflict={root,canvas,index,caption,target,external,fid:f.id,width:F.get(s.project).figures[0].width};
  if(fault==='ENOSPC'||fault==='EACCES'){const write=fb.writeText;fb.writeText=async(p,t,...args)=>{if(p===canvas){const e=Error(fault+' injected');e.code=fault;throw e}return write(p,t,...args)}}
  return {snapshot,width:F.get(s.project).figures[0].width};
 },fault);
 await page.waitForSelector('.disk-toast',{timeout:10000});await page.click('.disk-toast button.ghost');
 if(['future','ENOSPC','EACCES'].includes(fault)){
  await page.waitForSelector('.disk-toast [role=alert]');const state=await page.evaluate(()=>{const F=window.__flux,c=window.__conflict;return {dirty:F.get(F.fig.dirty),snapshot:[...window.fig._files].filter(([p])=>p===c.index||p===c.canvas||p===c.caption).map(([p,b])=>[p,new TextDecoder().decode(b)]),message:document.querySelector('.disk-toast [role=alert]').textContent}});assert.equal(state.dirty,true);assert.deepEqual(state.snapshot,before.snapshot);assert.match(state.message,fault==='future'?/Newer figure format/:new RegExp(fault));evidence.push({fault,refused:true,message:state.message});
 }else{
  await waitFor(page,()=>!document.querySelector('.disk-toast'));const state=await page.evaluate(async()=>{const F=window.__flux,c=window.__conflict,fb=window.fig;const records=[...fb._files].filter(([p])=>p.startsWith(c.root+'/.meta/figure-conflicts/'));const record=JSON.parse(new TextDecoder().decode(records.at(-1)[1]));await F.bridge.loadFigInto(c.root,'reopened',{reload:true});const f=F.get(F.fig.project).figures.find(f=>f.id===c.fid);return {records:records.length,theirs:record.theirs[c.target.slice(c.root.length+1)],expected:c.external,width:f.width,dirty:F.get(F.fig.dirty),caption:await fb.readText(c.caption),embedded:f.captions}});assert.equal(state.records,1);assert.equal(state.theirs,state.expected);assert.equal(state.width,before.width);assert.equal(state.dirty,false);if(fault==='caption-dual'){assert.match(state.caption,/editor-caption/);assert.match(JSON.stringify(state.embedded),/editor-caption/)}evidence.push({fault,...state});
 }
}
assert.deepEqual(realErrors(page),[]);mkdirSync(OUT,{recursive:true});await page.screenshot({path:path.join(OUT,'v020-conflict-refusal.png')});writeFileSync(path.join(OUT,'v020-conflict-actions.json'),JSON.stringify(evidence,null,2));console.log('V020 CONFLICT GUI PASS: actual overwrite action preserves/reopens four divergence kinds and refuses future/ENOSPC/EACCES without clearing dirty');
}finally{await browser.close()}
