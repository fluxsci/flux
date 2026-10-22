import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,waitFor,waitForFrame,realErrors} from './lib/driver.mjs';
const {browser,page}=await launch({width:1200,height:900});
const input='[data-number-owner-probe] input';
const events=()=>page.evaluate(()=>window.__numberEvents);
const stats=()=>page.evaluate(()=>({history:window.__flux.fig.historyStats(),dirty:window.__flux.get(window.__flux.fig.dirty)}));
async function mount({external=true,live=true,history=true}={}) {
 await page.evaluate(async ({external,live,history})=>{
  const sv=await import('/node_modules/svelte/src/index-client.js');
  const {default:Field}=await import('/src/lib/NumberField.svelte');
  if(window.__numberProbe)await sv.unmount(window.__numberProbe);
  document.querySelector('[data-number-owner-probe]')?.remove();
  const host=document.createElement('div');host.dataset.numberOwnerProbe='';host.style.cssText='position:fixed;left:380px;top:160px;width:220px;padding:12px;background:#282726;z-index:9999';document.body.append(host);
  window.__numberEvents=[];
  const emit=(kind,value)=>window.__numberEvents.push(value===undefined?{kind}:{kind,value});
  const owner={begin:()=>emit('begin'),preview:v=>emit('preview',v),accept:()=>emit('accept'),cancel:()=>emit('cancel'),validity:v=>emit('validity',v)};
  window.__numberProbe=sv.mount(Field,{target:host,props:{label:'Owned gap',value:10,min:0,live,history,externalOwner:external?owner:null},events:{commit:e=>emit('commit',e.detail),preview:e=>{emit('preview',e.detail);window.__flux.fig.mutate(p=>p.figures[0].elements.find(e=>e.id==='field-owner-rect').x=e.detail)}}});
  await sv.tick();
 },{external,live,history});
 await waitFor(page,()=>!!document.querySelector('[data-number-owner-probe] input'));
}
async function type(text){await page.click(input);await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type(text);}
try {
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Figure');
 await page.evaluate(()=>{const s=window.__flux.fig;s.commit(p=>{p.figures[0].elements.push({id:'field-owner-rect',type:'rect',x:10,y:20,width:30,height:40,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0});});s.resetHistory();s.dirty.set(false);});
 const baseline=await stats();
 await mount();await type('20.25');
 assert.equal((await events()).filter(e=>e.kind==='preview').at(-1).value,20.25,'external typing keeps fractions');
 assert.deepEqual(await stats(),baseline,'external typing owns no model/history checkpoint');
 await page.keyboard.press('Enter');assert.equal((await events()).filter(e=>e.kind==='accept').length,1,'Enter accepts once');
 await mount();await type('20+');
 assert.equal(await page.$eval(input,n=>n.getAttribute('aria-invalid')),'true','invalid expression remains visibly editable');
 await page.keyboard.press('Enter');assert.equal(await page.$eval(input,n=>n===document.activeElement),true,'invalid Enter retains field focus');
 assert.equal((await events()).filter(e=>e.kind==='accept').length,0,'invalid expression never accepts last valid preview');
 await page.keyboard.press('Escape');assert.equal((await events()).filter(e=>e.kind==='cancel').length,1,'Escape cancels inner owner once');
 assert.deepEqual(await stats(),baseline,'external cancellation preserves history and dirty state');
 await mount();await page.focus(input);await page.keyboard.press('ArrowUp');assert.equal((await events()).filter(e=>e.kind==='preview').at(-1).value,11,'external arrow follows shared step law');await page.keyboard.press('Escape');
 // Shell chords bubble through an externally owned input just as through
 // ordinary fields. Native input Undo and local accept/step keys stay local.
 await mount();await page.focus(input);await page.evaluate(()=>{window.__numberBubbled=[];document.querySelector('[data-number-owner-probe]').addEventListener('keydown',e=>{window.__numberBubbled.push(e.code);e.preventDefault();e.stopPropagation();});});
 await page.keyboard.down('Control');await page.keyboard.press('KeyS');await page.keyboard.down('Shift');await page.keyboard.press('KeyB');await page.keyboard.up('Shift');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
 const routed=await page.evaluate(()=>window.__numberBubbled);assert.ok(routed.includes('KeyS')&&routed.includes('KeyB'),'save and rail chords reach the shell');assert.ok(!routed.includes('KeyZ')&&!routed.includes('ArrowUp')&&!routed.includes('Enter'),'text Undo and local field keys do not escape');
 await mount();const box=await page.$eval(input,n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(box.x,box.y);await page.mouse.wheel({deltaY:100});
 await waitFor(page,()=>window.__numberEvents.some(e=>e.kind==='accept'));
 assert.equal((await events()).filter(e=>e.kind==='begin').length,1,'hover wheel begins one external edit');assert.deepEqual(await stats(),baseline,'wheel owns no hidden model checkpoint');
 await mount();const lb=await page.$eval('[data-number-owner-probe] .lb',n=>{const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(lb.x,lb.y);await page.mouse.down();await page.mouse.move(lb.x+15,lb.y);await page.keyboard.press('Escape');await page.mouse.up();
 assert.equal((await events()).filter(e=>e.kind==='cancel').length,1,'label scrub cancellation routes to external owner');assert.deepEqual(await stats(),baseline,'label scrub owns no model checkpoint');
 await mount({external:false,live:false,history:false});await type('30/2');await page.keyboard.press('Enter');assert.equal((await events()).find(e=>e.kind==='commit').value,15,'ordinary expression commit contract unchanged');assert.deepEqual(await stats(),baseline,'ordinary history=false parameter remains model-independent');
 await mount({external:false,live:true});await type('28');assert.equal((await stats()).history.past,baseline.history.past+1,'ordinary live field still owns its checkpoint');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.__flux.get(window.__flux.fig.project).figures[0].elements.find(e=>e.id==='field-owner-rect').x),10,'ordinary Escape restores model');assert.deepEqual(await stats(),baseline,'ordinary cancellation restores history and dirty');
 await mount();await type('45');await page.evaluate(()=>window.__flux.fig.selection.set(new Set(['field-owner-rect'])));await waitForFrame(page);assert.equal((await events()).filter(e=>e.kind==='cancel').length,1,'target handoff cancels external inner edit');
 assert.deepEqual(realErrors(page),[],'clean browser console');
 console.log('NumberField external ownership and existing behavior: PASS');
} finally {await browser.close();}
