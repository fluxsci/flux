import {launch,gotoApp,waitFor,realErrors} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-metadata-save-safety');const {browser,page}=await launch();
const open=async()=>{await page.keyboard.down('Alt');await page.keyboard.press('KeyM');await page.keyboard.up('Alt');await page.waitForSelector('[aria-label="b caption"]');};
const fill=async text=>{await page.click('[aria-label="b caption"]');await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type(text);};
const saved=()=>page.evaluate(()=>window.fig.readText('/demo/myc-growth-paper/fig/captions/growth.md'));
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await open();
 await page.evaluate(()=>{const orig=window.fig.writeText;window.__originalWrite=orig;window.fig.writeText=async(...args)=>{window.fig.writeText=orig;throw Error('Injected disk write failure');};});
 await fill('Keep this draft');await page.keyboard.press('Tab');await waitFor(page,()=>document.querySelector('.status')?.textContent.includes('Injected disk write failure'));
 h.ok(await page.$eval('[aria-label="b caption"]',t=>t.value==='Keep this draft'),'disk failure retains authored draft');h.ok(!(await saved()).includes('Keep this draft'),'failed write does not claim persisted caption');
 await page.evaluate(()=>[...document.querySelectorAll('.status button')].find(b=>b.textContent==='Retry save').click());await waitFor(page,()=>document.querySelector('.status')?.textContent.startsWith('Saved'));
 h.ok((await saved()).includes('Keep this draft'),'retry recovers and publishes the retained draft');
 await page.evaluate(()=>{const orig=window.fig.writeText;let once=true;window.fig.writeText=async(...args)=>{if(once){once=false;window.__writeHeld=true;await new Promise(r=>window.__releaseMetaWrite=r);}return orig(...args);};});
 await fill('First in flight');await page.keyboard.press('Tab');await waitFor(page,()=>window.__writeHeld===true);
 await fill('Newest while saving');await page.click('header [aria-label="Close Figure-Meta"]');h.ok(!!await page.$('.figure-meta'),'closing waits for an in-flight save');
 await page.evaluate(()=>window.__releaseMetaWrite());await waitFor(page,()=>!document.querySelector('.figure-meta'));
 h.ok((await saved()).includes('Newest while saving'),'close drains newer input that arrived during the first write');
 await open();h.ok(await page.$eval('[aria-label="b caption"]',t=>t.value==='Newest while saving'),'reopening reads the latest durable caption');
 // A pinned view may remain open while the user switches the project owner to
 // Slide. Cold metadata writes must never replace that shared editing store.
 await page.click('header [aria-label="Close Figure-Meta"]');await page.evaluate(()=>window.__flux.panes.setFocusedMode('slide'));
 await waitFor(page,()=>window.__flux.tenancy.storeTenant()==='slide');await page.evaluate(()=>window.__flux.panes.setFocusedMode('paper'));await waitFor(page,()=>!!document.querySelector('.paper'));
 const before=await page.evaluate(()=>JSON.stringify(window.__flux.get(window.__flux.fig.project)));await open();await fill('Metadata with Slide resident');await page.keyboard.press('Tab');await waitFor(page,()=>document.querySelector('.status')?.textContent.startsWith('Saved'));
 h.ok(await page.evaluate(before=>JSON.stringify(window.__flux.get(window.__flux.fig.project))===before,before),'cold Paper metadata preserves the resident Slide model');
 h.ok((await saved()).includes('Metadata with Slide resident'),'Slide residency still allows a durable figure caption save');
 await page.click('header [aria-label="Close Figure-Meta"]');await page.evaluate(()=>window.__flux.panes.setFocusedMode('figure'));await waitFor(page,()=>!!document.querySelector('.figure-mode .canvas-host'));await open();await fill('Last unblurred edit before exit');
 const flushed=await page.evaluate(()=>window.__flux.lifecycle.flushAll());h.ok(flushed.ok,'lifecycle flush includes metadata drafts on its first attempt');h.ok((await saved()).includes('Last unblurred edit before exit'),'lifecycle flush waits for the resulting Figure autosave');
 h.ok(!realErrors(page).length,'clean browser console');
}finally{await browser.close()}await h.done();
