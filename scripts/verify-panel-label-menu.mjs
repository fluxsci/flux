import {launch,gotoApp,clickMode,waitFor,realErrors} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-panel-label-menu');const {browser,page}=await launch();
const labels=()=>page.evaluate(()=>window.__flux.figures()[0].elements.filter(e=>e.type==='text').map(e=>!!e.panelLabel));
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Figure');
 await page.evaluate(()=>{const F=window.__flux;const texts=F.figures()[0].elements.filter(e=>e.type==='text');F.fig.commit(p=>{p.figures[0].elements.find(e=>e.id===texts[0].id).panelLabel=false});F.fig.selection.set(new Set(texts.map(e=>e.id)));F.fig.resetHistory();});
 await page.keyboard.press('f');await waitFor(page,()=>!![...document.querySelectorAll('.fluxFigMenu .field')].find(e=>e.textContent.includes('panel label')));
 const key=await page.evaluate(()=>{const row=[...document.querySelectorAll('.fluxFigMenu .field')].find(e=>e.textContent.includes('panel label'));return row.dataset.key;});
 h.ok(!!key,'mixed text selection offers the Panel label toggle');await page.keyboard.press(key);await waitFor(page,()=>window.__flux.figures()[0].elements.filter(e=>e.type==='text').every(e=>e.panelLabel));h.eq(await labels(),[true,true],'toggle marks both selected text elements');
 await page.keyboard.press(key);await waitFor(page,()=>window.__flux.figures()[0].elements.filter(e=>e.type==='text').every(e=>!e.panelLabel));h.eq(await labels(),[false,false],'toggle also unmarks both texts');await page.evaluate(()=>window.__flux.fig.undo());h.eq(await labels(),[true,true],'undo restores the marked selection');
 await page.keyboard.press('Escape');await page.evaluate(()=>window.__flux.fig.undo());h.eq(await labels(),[false,true],'one undo restores each original flag');await page.evaluate(()=>window.__flux.fig.redo());h.eq(await labels(),[true,true],'redo marks the same panel identities');
 await page.keyboard.down('Alt');await page.keyboard.press('KeyM');await page.keyboard.up('Alt');await page.waitForSelector('.caption-block textarea');h.eq(await page.$$eval('.caption-block',a=>a.length),3,'both panels appear in Figure-Meta');
 h.ok(!realErrors(page).length,'clean console');
}finally{await browser.close()}await h.done();
