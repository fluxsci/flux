import { readFileSync } from 'node:fs';
import { clickMode, waitFor } from './driver.mjs';
export const NOTE = '.annotation-composer textarea';
export const chord = (page, code='KeyM', opts={ctrlKey:true,shiftKey:true}) => page.evaluate(({code,opts}) => window.dispatchEvent(new KeyboardEvent('keydown',{key:code.startsWith('Key')?code.slice(3).toLowerCase():code,code,bubbles:true,cancelable:true,...opts})),{code,opts});
export const openAnnotation = async page => { await chord(page); await waitFor(page,()=>document.activeElement===document.querySelector('.annotation-composer textarea'),null,{label:'annotation focused'}); };
export const cancelAnnotation = async page => { await page.keyboard.press('Escape'); await waitFor(page,()=>!document.querySelector('[data-annotation-surface]'),null,{label:'annotation closed'}); };
export const fillNote = (page,text) => page.$eval(NOTE,(el,text)=>{el.value=text;el.dispatchEvent(new Event('input',{bubbles:true}));el.focus();},text);
export const center = (page,selector) => page.$eval(selector,el=>{const b=el.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};});
export const drag = async (page,a,b) => { await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:4});await page.mouse.up(); };
export async function seedAnnotationFigure(page, count=2) {
  const svg=readFileSync('scripts/fixtures/pre-regen/06_scatter_regression.svg','utf8');
  const manifest=JSON.parse(readFileSync('scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json','utf8'));
  await clickMode(page,'Figure');
  await waitFor(page,()=>!!document.querySelector('.canvas-host'),null,{label:'Figure mounted'});
  const box=/viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(svg), size={w:Math.round(Number(box?.[1]??480)),h:Math.round(Number(box?.[2]??360))};
  await page.evaluate(({svg,manifest,count,size})=>{
    const F=window.__flux, f=F.fig;
    F.io.reimportPlot('annot-asset',svg,manifest);
    // A figure of its own (its own canvas): overwriting the demo's first figure
    // deleted panels the manuscript cites, so every later figure save was refused.
    f.addCanvas();
    const figId=F.get(f.activeFigureId);
    f.commit(p=>{
      // Register the plot's bytes as a project asset, as an import would (the
      // saved figure must not reference a missing asset).
      if(!p.assets.some(a=>a.id==='annot-asset'))p.assets.push({id:'annot-asset',name:'annotation',kind:'svg',path:'assets/annot-asset.svg',naturalWidth:size.w,naturalHeight:size.h});
      const g=p.figures.find(x=>x.id===figId);g.x=0;g.y=0;g.width=800;g.height=600;g.nickname='Annotation figure';
      g.elements=[{type:'plot',id:'annot-plot',name:'Density',assetId:'annot-asset',x:20,y:60,width:380,height:260,rotation:0,overrides:{},source:{svgPath:'plots/annotation.svg'}},
        {type:'text',id:'annot-text',text:'n = 12',name:'Sample size',x:50,y:360,width:100,height:30,rotation:0,fontFamily:'Inter',fontSize:20,fill:'#222',align:'left'}];
      for(let i=0;i<count;i++)g.elements.push({type:'rect',id:'annot-box'+i,name:'Box '+i,x:200+(i%30)*18,y:360+Math.floor(i/30)*18,width:15,height:15,rotation:0,fill:'#205ea6',stroke:'none',strokeWidth:0,cornerRadius:0});
      f.activeFigureId.set(g.id);
    });
    f.selection.set(new Set(['annot-plot']));f.viewport.set({panX:30,panY:40,zoom:.8});
  },{svg,manifest,count,size});
  await waitFor(page,()=>!!document.querySelector('[id^="annot-plot__"]'),null,{label:'semantic plot rendered'});
}
export const ledger = page => page.evaluate(async()=>{
 const f=window.__flux,root=f.get(f.shell.currentProject).path;
 try{return (await window.fig.readText(root+'/.meta/feedback.ndjson')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}
});
export async function findPlotPoint(page) {
  return page.evaluate(async()=>{
    const r=await import('/src/lib/bridge/targetResolvers.ts');r.prepareTargetResolvers();
    const b=document.querySelector('[data-editor-element-id="annot-plot"]').getBoundingClientRect();
    for(let y=b.y+10;y<b.bottom-5;y+=5)for(let x=b.x+10;x<b.right-5;x+=5){const h=r.resolveAt(x,y)[0];if(h?.ref.kind==='part'&&h.ref.partId!=='figure'&&h.ref.role!=='figure'&&h.ref.role!=='plot-area')return {x,y,ref:h.ref,label:h.label};}
    throw Error('No semantic part hit in the fixture');
  });
}
