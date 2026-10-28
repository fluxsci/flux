// Disposable synthetic probe. No files/config outside browser fixture are used.
import {writeFileSync} from 'node:fs';
import {launch,gotoApp,clickMode,waitFor,APP_URL,realErrors} from '../lib/driver.mjs';
const {browser,page}=await launch({width:1600,height:1000});
try {
await gotoApp(page,{url:`${APP_URL}?fixture=demo`,settle:1000});
await clickMode(page,'Paper');
await waitFor(page,()=>!!window.__fluxView&&!!window.__fluxSeedFigures&&!!window.__fluxMargin,null,{timeout:15000,label:'Paper'});
await page.evaluate(()=>{
 const refs=[],figs={},data={};
 const paths=Array.from({length:1800},(_,i)=>`<path d="M ${i%180*5} ${20+Math.floor(i/180)*15} l 4 8 -4 5 z" fill="${i%2?'#4385be':'#da702c'}"/>`).join('');
 for(let i=0;i<40;i++){
  const id=`probe${i}`,assetId=`asset${i}`;
  data[assetId]=`data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 240">${paths}<text x="20" y="220">Dense figure ${i}</text></svg>`)}`;
  refs.push({id,label:`fig-${id}`,name:`Figure ${i+1}`,family:'figure',number:i+1,display:`Fig. ${i+1}`,captionLabel:`Figure ${i+1} | `,order:i,canvas:'main',caption:'Dense preview',panels:['a','b']});
  figs[id]={id,name:id,canvasId:'main',x:0,y:0,width:1000,height:240,elements:[{type:'plot',id:`plot${i}`,assetId,x:0,y:0,width:1000,height:240,rotation:0,overrides:{}}]};
 }
 window.__fluxSeedFigures(refs,figs,data);
 const v=window.__fluxView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'# Probe\n\nTyping here.\n\n'},selection:{anchor:22}});v.focus();
});
const measure=()=>page.evaluate(async()=>{
 const v=window.__fluxView,sync=[],paint=[];let mutations=0;
 const observer=new MutationObserver(rows=>{mutations+=rows.filter(row=>row.type==='attributes'&&['src','width','height','style'].includes(row.attributeName)).length;});
 const pane=document.querySelector('[data-pane-id="figure"]');if(pane)observer.observe(pane,{subtree:true,attributes:true});
 for(let i=0;i<30;i++){
  const at=v.state.selection.main.head,t=performance.now();v.dispatch({changes:{from:at,insert:'x'},selection:{anchor:at+1},userEvent:'input.type'});sync.push(performance.now()-t);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));paint.push(performance.now()-t);
 }
 observer.disconnect();const q=(a,p)=>[...a].sort((a,b)=>a-b)[Math.floor((a.length-1)*p)];return{syncP95:q(sync,.95),paintP95:q(paint,.95),maxPaint:Math.max(...paint),mutations};
});
const closed=await measure();
await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\n\n'},selection:{anchor:v.state.doc.length+2}});v.focus();});
const coldStart=Date.now();
await page.keyboard.type('@@');
await waitFor(page,()=>!!document.querySelector('#figref-grid'),null,{timeout:4000,label:'cold reference picker shell'});
const coldShellMs=Date.now()-coldStart;
await waitFor(page,()=>!!document.querySelector('#figref-grid img[data-figure-state="ready"]'),null,{timeout:30000,label:'cold reference preview'});
const coldFirstPreviewMs=Date.now()-coldStart;
await page.keyboard.press('Escape');
await waitFor(page,()=>!document.querySelector('#figref-grid'),null,{timeout:4000,label:'cold picker close'});
await page.evaluate(()=>window.__fluxMargin.summon('figure'));
await waitFor(page,()=>document.querySelectorAll('[data-pane-id="figure"] img[data-figure-state="ready"]').length>=5,null,{timeout:30000,label:'visible previews'});
await page.evaluate(()=>window.__fluxView.focus());
const open=await measure();
await page.evaluate(()=>{window.__fluxMargin.closeAll();const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\n\n'},selection:{anchor:v.state.doc.length+2}});v.focus();});
await new Promise(r=>setTimeout(r,200));
await page.keyboard.type('@@');
const start=Date.now();
await waitFor(page,()=>!!document.querySelector('#figref-grid'),null,{timeout:4000,label:'reference picker shell'});
const shellMs=Date.now()-start;
await waitFor(page,()=>!!document.querySelector('#figref-grid img[data-figure-state="ready"]'),null,{timeout:30000,label:'reference preview'});
const firstPreviewMs=Date.now()-start;
const binding=await page.evaluate(async()=>{
 const {bindFigureImage,figureImage}=await import('/src/shell/modes/paper/scholar/figures.ts');
 const img=document.createElement('img');img.style.width='200px';document.body.append(img);
 let cancel=bindFigureImage(img,'probe0');let start=performance.now();
 for(let i=0;i<100;i++){cancel();cancel=bindFigureImage(img,'probe0');}
 const rebind100Ms=performance.now()-start;cancel();
 const action=figureImage(img,'probe0');start=performance.now();
 for(let i=0;i<100;i++)action.update('probe0');
 const stable100Ms=performance.now()-start;action.destroy();img.remove();
 return{rebind100Ms,stable100Ms};
});
const result={closed,open,coldShellMs,coldFirstPreviewMs,shellMs,firstPreviewMs,binding,errors:realErrors(page)};
writeFileSync(process.env.FLUX_PICKER_RECEIPT||'/tmp/paper-picker-probe.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
