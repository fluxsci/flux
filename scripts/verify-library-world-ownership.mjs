// Actual Library handlers with controlled provider promises; no live provider requests.
import assert from 'node:assert/strict';
import {launch,gotoApp,clickMode,realErrors,shot} from './lib/driver.mjs';
const {browser,page}=await launch();let checks=0;
const ok=(condition,message)=>{assert(condition,message);checks++;console.log('✓ '+message);};
try {
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Library');
 await page.evaluate(()=>{
  window.__worldPending=[];window.__worldRequests=[];
  window.fig={...(window.fig||{}),fetchOpenAlex:url=>new Promise((resolve,reject)=>{const u=new URL(url),request={query:u.searchParams.get('search'),page:u.searchParams.get('page')||'1',resolve,reject};window.__worldPending.push(request);window.__worldRequests.push({query:request.query,page:request.page});})};
  window.__worldResolve=(query,page,label,count=1,error=false)=>{const i=window.__worldPending.findIndex(p=>p.query===query&&p.page===String(page));if(i<0)throw Error('Missing controlled request '+query+':'+page);const [p]=window.__worldPending.splice(i,1);if(error)p.reject(Error(label));else p.resolve({results:Array.from({length:count},(_,i)=>({id:'https://openalex.org/W'+label.replace(/[^a-z0-9]/gi,'')+i,title:label+' '+i,publication_year:2026,cited_by_count:12,authorships:[]}))});};
 });
 await page.click('.scopebar .seg button:nth-child(2)');
 const query=async text=>{await page.$eval('.scopebar input.search',(input,text)=>{input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));},text);await page.focus('.scopebar input.search');await page.keyboard.press('Enter');await page.waitForFunction(q=>window.__worldPending.some(p=>p.query===q),{},text);};
 const resolve=async(q,p,label,count=1,error=false)=>{await page.evaluate((q,p,label,count,error)=>window.__worldResolve(q,p,label,count,error),q,p,label,count,error);};
 const state=()=>page.evaluate(()=>({label:document.querySelector('.wlabel')?.textContent,rows:[...document.querySelectorAll('.grid .grow:not(.ghead) .gt')].map(e=>e.textContent.trim()),error:document.querySelector('.werr')?.textContent||'',load:document.querySelector('.loadmore')?.disabled}));
 await query('slow-old');await query('fast-new');await resolve('fast-new',1,'NEWEST');await page.waitForFunction(()=>document.querySelector('.grid')?.textContent.includes('NEWEST'));
 await resolve('slow-old',1,'STALE');await page.evaluate(()=>new Promise(requestAnimationFrame));let s=await state();
 ok(s.label.includes('fast-new')&&s.rows.length===1&&s.rows[0].startsWith('NEWEST'),'late previous query cannot replace current label or results');
 await query('old-page');await resolve('old-page',1,'FIRSTPAGE',50);await page.waitForSelector('.loadmore');await page.click('.loadmore');await page.waitForFunction(()=>window.__worldPending.some(p=>p.query==='old-page'&&p.page==='2'));
 await query('replacement');await resolve('replacement',1,'REPLACEMENT');await page.waitForFunction(()=>document.querySelector('.grid')?.textContent.includes('REPLACEMENT'));
 await resolve('old-page',2,'OLDPAGE');await page.evaluate(()=>new Promise(requestAnimationFrame));s=await state();
 ok(s.label.includes('replacement')&&s.rows.length===1&&s.rows[0].startsWith('REPLACEMENT'),'late old pagination cannot append to a new query');
 await query('retry-page');await resolve('retry-page',1,'RETRYBASE',50);await page.waitForSelector('.loadmore');await page.click('.loadmore');await page.waitForFunction(()=>window.__worldPending.some(p=>p.query==='retry-page'&&p.page==='2'));await resolve('retry-page',2,'controlled page failure',1,true);await page.waitForFunction(()=>document.querySelector('.loadmore')?.disabled===false);
 await page.click('.loadmore');await page.waitForFunction(()=>window.__worldPending.some(p=>p.query==='retry-page'&&p.page==='2'));
 await resolve('retry-page',2,'RETRYOK');await page.waitForFunction(()=>document.querySelector('.grid')?.textContent.includes('RETRYOK'));s=await state();
 ok(s.rows.length===51&&s.rows.at(-1).startsWith('RETRYOK'),'failed pagination retries the same page and advances only after success');
 ok(s.error==='','successful pagination retry removes its previous actionable error');
 const requests=await page.evaluate(()=>window.__worldRequests.filter(p=>p.query==='retry-page').map(p=>p.page));ok(JSON.stringify(requests)===JSON.stringify(['1','2','2']),'actual provider URLs preserve exact successful pagination sequence');
 ok(realErrors(page).length===0,'controlled provider failures produce no unhandled console/page errors');await shot(page,'library-world-ownership');
 console.log(`LIBRARY WORLD OWNERSHIP: PASS (${checks} checks)`);
} finally {await browser.close();}
