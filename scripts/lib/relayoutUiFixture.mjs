import fs from 'node:fs';
import {layoutFixture} from './alignArrangeFixture.mjs';
import {waitFor,waitForFrame} from './driver.mjs';
export const readFixture=(name='line')=>({svg:fs.readFileSync(`scripts/fixtures/relayout/${name}/base.svg`,'utf8'),manifest:JSON.parse(fs.readFileSync(`scripts/fixtures/relayout/${name}/base.fluxplot.json`,'utf8'))});
export async function relayoutFixture(page,items=[{}],name='line'){
 await layoutFixture(page);const source=readFixture(name);
 await page.evaluate(async({source,items})=>{
  const s=window.__flux.fig,F=window.__flux,root=F.get(F.shell.currentProject).path;
  await window.fig.mkdir(root+'/fig/assets');await window.fig.writeText(root+'/fig/assets/relayout-asset.svg',source.svg);await window.fig.writeText(root+'/fig/assets/relayout-asset.fluxplot.json',JSON.stringify(source.manifest));
  F.plot.cachePlot('relayout-asset',source.svg,source.manifest);
  s.commit(p=>{const f=p.figures.find(f=>f.id===F.get(s.activeFigureId));f.width=1400;f.height=900;f.elements=items.map((extra,i)=>({type:'plot',id:'reflow-'+i,assetId:'relayout-asset',x:40+i*520,y:60,width:480,height:307.2,rotation:0,...extra}));p.assets.push({id:'relayout-asset',name:'Reflow fixture',kind:'svg',path:'assets/relayout-asset.svg',naturalWidth:480,naturalHeight:307.2});});
  s.selection.set(new Set(['reflow-0']));s.viewport.set({panX:30,panY:40,zoom:1});s.resetHistory();s.dirty.set(false);document.activeElement?.blur();
 },{source,items});
 try{await waitFor(page,()=>!!document.querySelector('[data-editor-element-id="reflow-0"] svg'));}catch(e){console.log(JSON.stringify(await page.evaluate(()=>({ids:[...document.querySelectorAll('[data-editor-element-id],[data-el-id]')].map(n=>[n.tagName,n.getAttribute('data-editor-element-id'),n.getAttribute('data-el-id'),n.innerHTML.slice(0,160)]),text:document.body.innerText.slice(-1200)}))));throw e;}await waitForFrame(page);
}
export const state=page=>page.evaluate(()=>{const F=window.__flux,s=F.fig,f=F.get(s.project).figures.find(f=>f.id===F.get(s.activeFigureId));return {elements:structuredClone(f.elements),history:s.historyStats(),plots:f.elements.filter(e=>e.type==='plot').map(e=>{const svg=document.querySelector(`[data-editor-element-id="${e.id}"] svg`);return{viewBox:svg?.getAttribute('viewBox'),textCount:svg?.querySelectorAll('[data-role="tick-label"]').length};})};});
