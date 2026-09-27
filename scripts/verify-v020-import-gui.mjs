import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,realErrors,OUT} from './lib/driver.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const {browser,page}=await launch();
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Figure');
 const result=await page.evaluate(async()=>{
  const F=window.__flux,fb=window.fig,s=F.fig;await F.lifecycle.flushAll();const assets=await import('/src/lib/assets.ts');
  const root=F.get(s.embeddedProjectRoot),figure=F.get(s.activeFigureId),base=F.get(s.project).assets.length;
  const png=document.createElement('canvas');png.width=20;png.height=10;const ctx=png.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,20,10);const bytes=Uint8Array.from(atob(png.toDataURL().split(',')[1]),c=>c.charCodeAt(0));
  const good=root+'/plots/good.png',bad=root+'/plots/broken.png',denied=root+'/plots/denied.svg';await fb.writeFile(good,bytes);await fb.writeFile(bad,new Uint8Array([0,13,255]));await fb.writeText(denied,'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>');await fb.writeText(denied.replace('.svg','.fluxplot.json'),'{"schemaVersion":"0.1.0","series":[]}');
  const count=await F.io.importPlotsFromPaths([good,bad]);const one=F.get(s.project);const placed=one.assets.at(-1);const errors=F.get(F.toast.toasts).map(t=>JSON.stringify(t)).join('\n');s.undo();const undoCount=F.get(s.project).assets.length;
  const outcomes=[];
  for(const target of ['root','figure','tenant']){
   const read=fb.readFile.bind(fb);let release,started;const pause=new Promise(r=>release=r),ready=new Promise(r=>started=r);fb.readFile=async p=>{if(p===good){started();await pause}return read(p)};
   const cacheBefore=Object.keys(F.get(assets.assetData)).sort(),assetBefore=F.get(s.project).assets.length;const work=F.io.importPlotsFromPaths([good]).then(()=>null,e=>e.message);await ready;
   if(target==='root')s.embeddedProjectRoot.set('/different-project');if(target==='figure')s.activeFigureId.set(null);if(target==='tenant')F.tenancy.setStoreTenant('slide');release();const error=await work;fb.readFile=read;
   outcomes.push({target,error,assetsBefore:assetBefore,assetsAfter:F.get(s.project).assets.length,cacheBefore,cacheAfter:Object.keys(F.get(assets.assetData)).sort()});
   s.embeddedProjectRoot.set(root);s.activeFigureId.set(figure);F.tenancy.setStoreTenant('figure');
  }
  const readText=fb.readText.bind(fb);fb.readText=async p=>{if(p===denied.replace('.svg','.fluxplot.json'))throw Error('EACCES semantic sidecar');return readText(p)};const beforeDenied=F.get(s.project).assets.length;const deniedCount=await F.io.importPlotsFromPaths([denied]);fb.readText=readText;
  return {count,base,placed:{kind:placed.kind,width:placed.naturalWidth,height:placed.naturalHeight},errors,undoCount,outcomes,deniedCount,deniedUnchanged:beforeDenied===F.get(s.project).assets.length,deniedMessage:F.get(F.toast.toasts).map(t=>JSON.stringify(t)).join('\n')};
 });
 assert.equal(result.count,1);assert.deepEqual(result.placed,{kind:'png',width:20,height:10});assert.match(result.errors,/broken\.png/);assert.equal(result.undoCount,result.base);
 for(const r of result.outcomes){assert.match(r.error,/destination changed/);assert.equal(r.assetsBefore,r.assetsAfter);assert.deepEqual(r.cacheBefore,r.cacheAfter)}
 assert.equal(result.deniedCount,0);assert.equal(result.deniedUnchanged,true);assert.match(result.deniedMessage,/EACCES semantic sidecar/);assert.deepEqual(realErrors(page),[]);mkdirSync(OUT,{recursive:true});writeFileSync(path.join(OUT,'v020-import.json'),JSON.stringify(result,null,2));console.log('V020 IMPORT GUI PASS: real raster decoder rejects malformed data; mixed batch one undo; delayed root/figure/tenant changes publish no model/cache; unreadable semantic sidecar refuses downgrade');
}finally{await browser.close()}
