import { launch, gotoApp, clickMode, APP_URL, realErrors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-eyedropper-gui');
const {browser,page} = await launch({width:1400,height:900});
try {
 await gotoApp(page,{url:new URL('?fixture=demo',APP_URL).href});
 await clickMode(page,'Figure');
 await page.evaluate(() => {
  const F=window.__flux.fig;
  F.commit(p=>{const g=p.figures[0];g.elements=[{type:'rect',id:'drop-target',x:60,y:80,width:180,height:120,rotation:0,fill:'#d95f02',stroke:'#222222',strokeWidth:2,cornerRadius:0,opacity:1}]; F.activeFigureId.set(g.id);});
  F.selectOnly('drop-target'); F.resetHistory();
  window.__dropMode='picked'; window.__dropCancels=[]; window.__browserDropperCalls=0;
  window.EyeDropper=class {constructor(){window.__browserDropperCalls++;throw Error('unsafe native API');}};
  window.fig={platform:'linux',pickScreenColor:async id=>{
    window.__dropId=id;
    if(window.__dropMode==='pending')return new Promise(r=>window.__dropResolve=r);
    if(window.__dropMode==='picked')return {status:'picked',hex:'#4080ff'};
    return {status:window.__dropMode};
   },cancelScreenColor:async id=>{window.__dropCancels.push(id);window.__dropResolve?.({status:'cancelled'});return true;},captureWindow:async()=>{
    const c=document.createElement('canvas');c.width=innerWidth*1.25;c.height=innerHeight*1.25;
    const ctx=c.getContext('2d');ctx.fillStyle='#1248ab';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#ee7700';ctx.fillRect(c.width/2,0,c.width/2,c.height);
    const bytes=Uint8Array.from(atob(c.toDataURL().split(',')[1]),x=>x.charCodeAt(0));return {png:bytes,width:c.width,height:c.height};
   }};
 });
 const model=()=>page.evaluate(()=>({fill:window.__flux.figures()[0].elements[0].fill,past:window.__flux.fig.historyStats().past,calls:window.__browserDropperCalls}));
 async function open(){await page.evaluate(()=>{document.activeElement?.blur();});await page.keyboard.press('f');await page.waitForSelector('.fluxFigMenu');await page.keyboard.press('c');await page.waitForSelector('.cs .drop');}
 await open(); await page.click('.cs .drop');
 await page.waitForFunction(()=>window.__flux.figures()[0].elements[0].fill==='#4080ff');
 h.eq(await model(),{fill:'#4080ff',past:1,calls:0},'portal pick applies exact color once without invoking native EyeDropper');
 await page.keyboard.press('Escape');await page.waitForSelector('.fluxFigMenu',{hidden:true});
 await page.evaluate(()=>{window.__dropMode='cancelled';});await open();await page.click('.cs .drop');
 await page.waitForFunction(()=>!document.querySelector('.cs .drop').disabled);
 h.eq((await model()).past,1,'portal refusal/cancel adds no undo');
 h.eq(await page.$('[data-flux-eyedropper]'),null,'portal refusal does not start a fallback capture');
 await page.evaluate(()=>{window.__dropMode='pending';});await page.click('.cs .drop');
 await page.waitForFunction(()=>!!window.__dropResolve);await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('.cs .drop').disabled);
 h.eq(await page.evaluate(()=>window.__dropCancels.at(-1)===window.__dropId),true,'Escape cancels its exact pending request');
 h.eq((await model()).past,1,'cancelled pending request preserves history');
 await page.evaluate(()=>{window.__dropMode='unavailable';});await page.click('.cs .drop');
 await page.waitForSelector('[data-flux-eyedropper="window"]');
 await page.mouse.move(100,200);await page.screenshot({path:'test-results/out/eyedropper-window.png'});
 await page.mouse.click(100,200);await page.waitForSelector('[data-flux-eyedropper]',{hidden:true});
 h.eq((await model()).fill,'#1248ab','window fallback reads exact screenshot pixels at fractional DPR');
 h.eq((await model()).past,2,'fallback pick is one additional undoable color edit');
 await page.keyboard.press('Escape');await page.waitForSelector('.fluxFigMenu',{hidden:true});
 await open();await page.click('.cs .drop');await page.waitForSelector('[data-flux-eyedropper]');await page.keyboard.press('Escape');
 await page.waitForSelector('[data-flux-eyedropper]',{hidden:true});
 h.eq((await model()).past,2,'fallback Escape removes overlay and preserves undo history');
 h.eq(await page.evaluate(()=>document.activeElement?.classList.contains('drop')),true,'fallback cancellation restores invoking control focus');
 h.eq(realErrors(page),[],'renderer console is clean');
} finally {await browser.close();}
await h.done();
