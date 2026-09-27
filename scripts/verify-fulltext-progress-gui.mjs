// Actual mounted Library owner/progress/cancel behavior, with a controllable
// native broker boundary. Worker/main behavior is independently exercised by
// verify-fulltext-refresh and the real300/1000/5000-worker corpus.
import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,realErrors,shot} from './lib/driver.mjs';
const {browser,page}=await launch();
try {
  await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});
  await clickMode(page,'Library');
  await page.waitForFunction(()=>window.__fluxSeedScaleLibrary&&window.fig);
  await page.evaluate(()=>{
    window.__fluxSeedScaleLibrary(6);
    delete window.__fluxFulltextHook;
    window.__ftRequests=[];window.__ftListeners=new Set();
    window.fig.onFulltextProgress=cb=>{window.__ftListeners.add(cb);return()=>window.__ftListeners.delete(cb);};
    window.fig.searchFulltext=(query,opts)=>new Promise(resolve=>window.__ftRequests.push({query,...opts,resolve}));
    window.fig.cancelFulltext=(requestId,ownerId)=>{const r=window.__ftRequests.find(r=>r.requestId===requestId&&r.ownerId===ownerId);if(r)r.cancelled=true;return Promise.resolve(!!r);};
  });
  const setQuery=async query=>{await page.$eval('.search',(input,q)=>{input.value=q;input.dispatchEvent(new Event('input',{bubbles:true}));},query);await page.waitForFunction(q=>window.__ftRequests.at(-1)?.query===q.replace(/^ft:/,''),{},query);};
  await setQuery('ft:slow');
  await page.evaluate(()=>{const r=window.__ftRequests.at(-1);for(const cb of window.__ftListeners)cb({...r,phase:'indexing',completed:64,total:5000});});
  await page.waitForFunction(()=>document.querySelector('.ftbar')?.textContent.includes('Indexing 64 of 5000'),{timeout:2500});
  assert(await page.$eval('.ftbar',el=>el.textContent.includes('Cancel search')),'cold search has progress and a usable cancel control');
  const first=await page.evaluate(()=>({requestId:window.__ftRequests.at(-1).requestId,ownerId:window.__ftRequests.at(-1).ownerId}));
  await setQuery('ft:next');
  await page.evaluate(()=>{const old=window.__ftRequests[0];for(const cb of window.__ftListeners)cb({...old,phase:'indexing',completed:999,total:999});old.resolve({hits:[],scanned:999,missingText:[],truncated:false});const r=window.__ftRequests.at(-1);for(const cb of window.__ftListeners)cb({...r,phase:'checking',completed:3,total:128});});
  await page.waitForFunction(()=>document.querySelector('.ftbar')?.textContent.includes('Checking 3 of 128'),{timeout:2500});
  assert(!await page.$eval('.ftbar',el=>el.textContent.includes('999')),'superseded progress/result cannot replace current state');
  assert(await page.evaluate(()=>window.__ftRequests[0].cancelled),'replacement cancels the exact old request');
  await page.locator('.ftbar button').click();
  await page.waitForFunction(()=>!document.querySelector('.ftbar'));
  const final=await page.evaluate(()=>{
    const r=window.__ftRequests.at(-1);
    for(const cb of window.__ftListeners)cb({...r,phase:'indexing',completed:5000,total:5000});
    r.resolve({hits:[],scanned:5000,missingText:[],truncated:false});
    return {cancelled:r.cancelled,listeners:window.__ftListeners.size,requestId:r.requestId,ownerId:r.ownerId};
  });
  assert(final.cancelled&&final.listeners===0&&final.requestId!==first.requestId&&final.ownerId===first.ownerId,'cancel clears subscription and preserves pane-specific ownership');
  await page.waitForFunction(()=>document.querySelectorAll('.grid .grow:not(.ghead)').length===6);
  assert.equal(await page.$('.ftbar'),null,'late completion after explicit cancellation cannot resurrect fulltext state');
  assert.deepEqual(realErrors(page),[]);
  await shot(page,'fulltext-progress-cancel');
  console.log('FULLTEXT PROGRESS GUI: PASS — cold progress, owning cancellation, stale-result refusal, subscription cleanup and six restored rows');
} finally {await browser.close();}
