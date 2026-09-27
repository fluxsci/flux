// Snapshot request fbmuiurh2jh6ev: cold Paper, live Figure and the same mounted
// view in an inert utility window. Inspect persisted captions, not only UI state.
import { launch, gotoApp, clickMode, errors, shot } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-figure-metadata');
const { browser, page } = await launch({ width:1500, height:950 });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
async function chord(p, key, shift=false) { await p.keyboard.down('Alt'); if(shift) await p.keyboard.down('Shift'); await p.keyboard.press(key); if(shift) await p.keyboard.up('Shift'); await p.keyboard.up('Alt'); }
async function click(p, selector) { const b=await p.$eval(selector,e=>{e.scrollIntoView({block:'nearest'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});await p.mouse.click(b.x,b.y); }
async function fill(p, selector, value) { await click(p,selector); await p.keyboard.down(mod); await p.keyboard.press('KeyA'); await p.keyboard.up(mod); await p.keyboard.press('Backspace'); await p.keyboard.type(value); }
const disk = () => page.evaluate(async () => { const get=window.__flux.get; const root=get(window.__flux.shell.projectModel).root; const index=JSON.parse(await window.fig.readText(root+'/fig/index.json')); const canvases=await Promise.all(index.canvases.map(c=>window.fig.readText(root+'/fig/canvases/'+c.id+'.json').then(JSON.parse))); return {root, model:{figures:canvases.flatMap(c=>c.figures)}, caption:await window.fig.readText(root+'/fig/captions/growth.md')}; });
try {
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});
 await page.waitForFunction(()=>!!window.__fluxView);
 const before = await page.evaluate(()=>JSON.stringify(window.__flux.get(window.__flux.fig.project)));
 await chord(page,'KeyM'); await page.waitForSelector('.figure-meta textarea');
 h.ok(await page.$$eval('.caption-block textarea', ts=>ts.length===3 && ts[1].value.includes('Control')), 'cold Paper opens legacy figure and panel captions');
 await fill(page,'[aria-label="a caption"]','Panel a from Paper.'); await page.keyboard.press('Tab');
 await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('Saved'));
 let saved=await disk();
 h.ok(saved.caption.includes('**a**, Panel a from Paper.'), 'cold Paper saves composed Markdown under the existing panel identity');
 h.ok(saved.model.figures[0].captions['el-a']==='Panel a from Paper.', 'cold Paper saves canonical caption block');
 h.ok(await page.evaluate(old=>JSON.stringify(window.__flux.get(window.__flux.fig.project))===old,before),'cold Paper does not replace the figure/slide editing store');
 await page.click('.tabs button:nth-child(2)'); await page.waitForSelector('[aria-label="Figure title"]');
 await fill(page,'[aria-label="Figure title"]','Metadata growth'); await page.click('button.save');
 await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('Saved'));
 saved=await disk(); h.ok(saved.model.figures[0].nickname==='Metadata growth' && saved.model.figures[0].referenceKey==='fig-growth','naming persists without changing permanent references');
 await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('.figure-meta'));
 await clickMode(page,'Figure'); await page.waitForSelector('.sidebar .item');
 await page.evaluate(()=>document.querySelector('.sidebar section:nth-of-type(2) li .item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
 await page.waitForSelector('[aria-label="Figure title"]');
 h.ok(await page.$eval('[aria-label="Figure title"]',e=>e.value==='Metadata growth'),'sidebar double-click opens Name with the saved title');
 await page.click('.tabs button:first-child'); await page.waitForSelector('[aria-label="a caption"]');
 await fill(page,'[aria-label="a caption"]','Panel a from Figure.'); await page.keyboard.press('Tab');
 await page.waitForFunction(()=>document.querySelector('.caption-preview')?.textContent.includes('Panel a from Figure.'));
 await page.click('[aria-label="Undo metadata edit"]');
 await page.waitForFunction(()=>document.querySelector('[aria-label="a caption"]')?.value==='Panel a from Paper.');
 await page.click('[aria-label="Redo metadata edit"]');
 await page.waitForFunction(()=>document.querySelector('[aria-label="a caption"]')?.value==='Panel a from Figure.');
 h.ok(true,'live metadata edits, undo and redo keep preview and controls synchronized');
 const box=await page.$eval('.preview-pane',el=>el.getBoundingClientRect().width);
 const handle=await page.$('.splitter');const hb=await handle.boundingBox(); await page.mouse.move(hb.x+2,hb.y+60);await page.mouse.down();await page.mouse.move(hb.x-90,hb.y+60,{steps:4});await page.mouse.up();
 h.ok(await page.$eval('.preview-pane',(el,b)=>el.getBoundingClientRect().width<b-60,box),'preview/edit split resizes with a real drag');
 await fill(page,'.meta-search','not a matching figure');
 h.ok(await page.$$eval('.figure-row',els=>els.length===0),'search filters the figure list');
 await fill(page,'.meta-search','');
 const popupEvent = new Promise(resolve=>page.once('popup',resolve)); await page.click('.pin'); const popup=await popupEvent;
 await popup.waitForSelector('.figure-meta'); await popup.setViewport({width:1060,height:780});
 h.ok(await popup.$eval('.meta-wrap',el=>el.classList.contains('detached')),'pin moves the same metadata view into its utility window');
 await fill(popup,'[aria-label="b caption"]','Pinned caption.');await popup.keyboard.press('Tab');
 await popup.waitForFunction(()=>document.querySelector('.caption-preview')?.textContent.includes('Pinned caption.'));
 await click(popup,'.tabs button:nth-child(2)');await popup.waitForSelector('[aria-label="Figure title"]');
 await fill(popup,'[aria-label="Figure title"]','Pinned title');await click(popup,'button.save');
 await popup.waitForFunction(()=>document.querySelector('h2')?.textContent==='Pinned title');
 h.ok(true,'caption and naming events work in the detached document');
 await click(popup,'.tabs button:first-child');await popup.setViewport({width:850,height:700});
 await fill(popup,'[aria-label="Figure caption"]','A long caption '.repeat(45));await popup.keyboard.press('Tab');
 await popup.waitForFunction(()=>[...document.querySelectorAll('textarea')].every(t=>t.scrollHeight<=t.clientHeight+2));
 h.ok(true,'pinned resize and long captions retain fit-to-content fields');
 await shot(popup,'figure-meta-pinned');
 await click(popup,'.pin');await page.bringToFront();await page.waitForSelector('.figure-meta');
 h.ok(await page.$eval('[aria-label="b caption"]',el=>el.value==='Pinned caption.'),'docking retains edits and selected figure');
 await page.evaluate(()=>window.__flux.fig.commit(p=>{p.figures[0].elements.find(e=>e.type==='rect').fill='#ff00aa';}));
 await page.waitForFunction(()=>{const img=document.querySelector('.art img');if(!img?.complete||!img.naturalWidth)return false;const c=document.createElement('canvas');c.width=600;c.height=300;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,600,300);const p=ctx.getImageData(150,150,1,1).data;return p[0]===255&&p[1]===0&&p[2]===170;});h.ok(true,'preview follows the latest unsaved Figure geometry and styling');

 await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('.figure-meta'));
 const directEvent=new Promise(resolve=>page.once('popup',resolve));await chord(page,'KeyM',true);const direct=await directEvent;await direct.waitForSelector('.figure-meta');await direct.setViewport({width:1060,height:780});h.ok(true,'Shift+Alt+M opens already pinned');await click(direct,'header [aria-label="Close Figure-Meta"]');await page.bringToFront();
 await page.waitForFunction(()=>!document.querySelector('.figure-meta'));
 const galleryEvent=new Promise(resolve=>page.once('popup',resolve));await chord(page,'KeyG',true);const gallery=await galleryEvent;await gallery.waitForSelector('.importer');h.ok(true,'Shift+Alt+G opens the gallery already pinned');await gallery.close();
 h.ok(errors(page).length===0,'clean opener console',errors(page));
} finally { await browser.close(); }
await h.done();
