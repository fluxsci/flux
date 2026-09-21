import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,waitFor,APP_URL,realErrors,shot} from './lib/driver.mjs';
const {browser,page}=await launch();let checks=0;const ok=(value,label)=>{assert.ok(value,label);checks++;};
const paint=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function trap(selector){
 const count=await page.$eval(selector,n=>[...n.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(e=>e.getClientRects().length).length);
 for(const reverse of [false,true]){if(reverse)await page.keyboard.down('Shift');for(let i=0;i<count+2;i++){await page.keyboard.press('Tab');ok(await page.$eval(selector,n=>n.contains(document.activeElement)),selector+' contains tab '+reverse);}if(reverse)await page.keyboard.up('Shift');}
}
async function openTitle(){await page.focus('.titlepill-wrap .pill');await page.keyboard.press('Enter');await waitFor(page,()=>!!document.querySelector('.te'),null,{label:'title dialog'});}
try{
 await gotoApp(page,{url:APP_URL+'/?fixture=demo'});await clickMode(page,'Paper');await waitFor(page,()=>document.querySelector('.paper[data-paper-sources-ready="true"]')&&window.__fluxMargin?.bg,null,{label:'ready Paper'});
 await openTitle();await trap('.te');const title=await page.$eval('.te input',n=>n.value);await page.$eval('.te input',n=>{n.value='MUST NOT SAVE';n.dispatchEvent(new Event('input',{bubbles:true}));});await page.focus('.te .ghost');await page.keyboard.press('Enter');await waitFor(page,()=>!document.querySelector('.te'),null,{label:'Cancel button Enter'});ok(await page.$eval('.titlepill-wrap',n=>!n.textContent.includes('MUST NOT SAVE')),'title Cancel activated with Enter does not save');
 await openTitle();await page.focus('.te button.primary');await page.keyboard.press('Escape');await waitFor(page,()=>!document.querySelector('.te'),null,{label:'Escape from title button'});ok(await page.evaluate(()=>!!document.activeElement.closest('.paper')),'title restores correct Paper focus');
 await page.evaluate(()=>[...document.querySelectorAll('.statusbar .seg')].find(n=>/export/i.test(n.textContent)).focus());await page.keyboard.press('Enter');await waitFor(page,()=>!!document.querySelector('.export-dialog'),null,{label:'export keyboard opens'});await trap('.export-dialog');await page.focus('.export-dialog button.primary');await page.keyboard.press('Escape');await waitFor(page,()=>!document.querySelector('.export-dialog'),null,{label:'export Escape on button'});ok(await page.evaluate(()=>!!document.activeElement.closest('.paper')),'export returns focus to Paper');
 // Both the native cancel event and hiding the owner must end the real margin gesture.
 for(const hide of [false,true]){
  const grip=await page.$eval('.mhandle.left',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
  await page.mouse.move(grip.x,grip.y);await page.mouse.down();await page.mouse.move(grip.x+15,grip.y);await paint();
  if(hide)await clickMode(page,'Figure');else await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true})));
  const before=await page.evaluate(()=>document.querySelector('.paper').getAttribute('style'));
  await page.mouse.move(grip.x+110,grip.y);await page.mouse.up();await paint();
  ok(await page.evaluate(()=>!document.querySelector('.mhandle.active')),'cancel/hide releases margin drag');
  ok(await page.evaluate(value=>document.querySelector('.paper').getAttribute('style')===value,before),'post-cancel movement cannot change margin layout');
  if(hide)await clickMode(page,'Paper');
 }
 await page.evaluate(()=>{window.__bgProbe=window.__fluxMargin.bg;window.__bgProbe.frames.length=0;});await clickMode(page,'Figure');await paint();
 const hiddenCount=await page.evaluate(()=>window.__bgProbe.frames.length);
 await page.keyboard.type('abcdefghijklmnopqrstuvwxyz',{delay:5});await page.evaluate(()=>new Promise(r=>setTimeout(r,200)));
 ok(await page.evaluate(n=>window.__bgProbe.frames.length===n,hiddenCount),'hidden Paper loop cannot be resurrected by typing elsewhere');
 await clickMode(page,'Paper');await page.evaluate(()=>{window.__bgProbe.frames.length=0;window.__bgProbe.resume();window.__bgProbe.resume();});await page.evaluate(()=>new Promise(r=>setTimeout(r,250)));
 const resumed=await page.evaluate(()=>window.__bgProbe.frames.length);ok(resumed>=5&&resumed<=23,'resume owns exactly one paced loop');
 await clickMode(page,'Slide');await waitFor(page,()=>!!window.__flux.slide.currentDeck(),null,{label:'Slide ready'});
 await page.evaluate(()=>{const f=window.__flux,d=f.slide.currentDeck();window.fig.readSlideLibrary=async()=>[{rel:'fixture.json',payload:{fluxPreset:1,kind:'slide',name:'Keyboard fixture',stage:d.stage,slide:structuredClone(d.slides[0])}}];});
 const preset=()=>page.evaluate(()=>[...document.querySelectorAll('.filmstrip button')].find(n=>n.textContent.includes('Preset')).focus());await preset();await page.keyboard.press('Enter');await waitFor(page,()=>!!document.querySelector('.preset-pick'),null,{label:'preset loaded'});await trap('[aria-label="Slide presets"]');await page.focus('.menu .x');await page.keyboard.press('Escape');await waitFor(page,()=>!document.querySelector('[aria-label="Slide presets"]'),null,{label:'preset escape'});ok(await page.evaluate(()=>document.activeElement?.textContent.includes('Preset')),'preset focus returns to invoking control');
 const n=await page.evaluate(()=>window.__flux.slide.currentDeck().slides.length);await preset();await page.keyboard.press('Enter');await waitFor(page,()=>!!document.querySelector('.preset-pick'),null,{label:'preset reopened'});await page.focus('.preset-pick');await page.keyboard.press('Enter');await waitFor(page,count=>window.__flux.slide.currentDeck().slides.length===count+1,n,{label:'keyboard preset insertion'});ok(true,'keyboard preset inserts one actual slide');
 await shot(page,'v020-paper-lifecycle');await page.evaluate(()=>window.__flux.shell.goHome());await waitFor(page,()=>!!document.querySelector('.wordmark'),null,{label:'destroyed project'});const destroyed=await page.evaluate(()=>window.__bgProbe.frames.length);await page.keyboard.type('after disposal');await page.evaluate(()=>new Promise(r=>setTimeout(r,200)));ok(await page.evaluate(n=>window.__bgProbe.frames.length===n,destroyed),'disposed ambient owner never restarts');
 ok(realErrors(page).length===0,'no renderer errors');console.log(JSON.stringify({checks,resumedFrames:resumed,passed:true}));
}finally{await browser.close();}
