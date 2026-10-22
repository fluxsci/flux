import {gotoApp,clickMode,waitFor,waitForFrame,APP_URL} from './driver.mjs';
export async function layoutFixture(page,mode='Figure') {
  await gotoApp(page,{url:APP_URL+'?fixture=demo'});
  await page.evaluate(async()=>{const {scaffoldProject}=await import('/src/lib/project/scaffold.ts');const root=await scaffoldProject('/demo/align-arrange',{title:'Alignment verification'});await window.__flux.shell.openProjectAt(root);});
  await clickMode(page,mode);
  await waitFor(page,()=>!!window.__flux?.fig&&!!document.querySelector('.canvas-host'));
  await seedLayout(page);
}
export async function seedLayout(page,items=[{x:50,y:100,width:60,height:60},{x:140,y:110,width:60,height:40},{x:230,y:90,width:60,height:80}]) {
  await page.evaluate(async items=>{
    window.__flux.layout.closeAlignArrange(true);
    const F=window.__flux,s=F.fig;
    s.commit(p=>{const f=p.figures.find(f=>f.id===F.get(s.activeFigureId))??p.figures[0];f.x=0;f.y=0;f.width=1000;f.height=700;f.elements=items.map((e,i)=>({id:`layout-${i}`,name:`Rectangle ${i+1}`,type:'rect',rotation:0,fill:'#4b8fc8',stroke:'none',strokeWidth:0,cornerRadius:0,...e}));s.activeFigureId.set(f.id);});
    const f=F.get(s.project).figures.find(f=>f.id===F.get(s.activeFigureId));s.selection.set(new Set(f.elements.map(e=>e.id)));s.viewport.set({panX:40,panY:50,zoom:1});s.resetHistory();s.dirty.set(false);document.activeElement?.blur();
  },items);await waitForFrame(page);
}
export const readLayout=page=>page.evaluate(async()=>{const F=window.__flux,s=F.fig,m=F.layout;return{elements:structuredClone(F.get(s.project).figures.find(f=>f.id===F.get(s.activeFigureId)).elements),history:s.historyStats(),dirty:F.get(s.dirty),state:F.get(m.alignArrange),preview:!!F.get(m.arrangementPreview)};});
export async function openArrange(page){await page.keyboard.down('Alt');await page.keyboard.press('KeyT');await page.keyboard.up('Alt');await waitFor(page,()=>!!document.querySelector('[aria-label="Flux Arrange"]'));await waitForFrame(page);}
export async function panelButton(page,text){const button=await page.$(`.align-arrange-panel button[aria-label="${text}"]`);if(button){await button.click();return;}await page.evaluate(text=>{const b=[...document.querySelectorAll('.align-arrange-panel button')].find(b=>b.textContent.trim()===text);if(!b)throw new Error('Missing button '+text);b.click();},text);await waitForFrame(page);}
