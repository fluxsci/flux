// Gallery/defaults, bounded preview work, movable-window ownership and repeated
// insertion. All files live in the in-memory demo bridge, never user storage.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, gotoApp, clickMode, APP_URL, realErrors } from './lib/driver.mjs';
const { browser, page } = await launch();
const metrics = {};
const frame = p => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const open = async () => { await page.keyboard.down('Alt'); await page.keyboard.press('KeyI'); await page.keyboard.up('Alt'); await page.waitForSelector('.importer'); };
const query = async (p, value) => { await p.$eval('.search-in', (n, value) => { n.value = value; n.dispatchEvent(new Event('input', { bubbles:true })); }, value); await frame(p); };
const pick = async (p, name) => { const button = await p.evaluateHandle(name => [...document.querySelectorAll('.row')].find(n => n.querySelector('.nm')?.textContent === name), name); await button.click(); await frame(p); };
try {
  await gotoApp(page, { url: new URL('?fixture=demo', APP_URL).href });
  await clickMode(page, 'Figure');
  await page.evaluate(async () => {
    const root='/demo/myc-growth-paper/plots';
    const svg=(color, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220" width="240pt" height="165pt"><rect width="320" height="220" fill="#fffcf0"/><g stroke="#b7b5ac" stroke-width="1"><path d="M40 25V185H295" fill="none"/><path d="M40 145H295M40 105H295M40 65H295" opacity=".25"/></g><path d="M45 170C90 ${110+n*3} 110 155 145 110S230 ${45+n*2} 290 35" fill="none" stroke="${color}" stroke-width="3"/><g fill="${color}"><circle cx="45" cy="170" r="4"/><circle cx="145" cy="110" r="4"/><circle cx="290" cy="35" r="4"/></g><text x="165" y="212" text-anchor="middle" fill="#6f6e69" font-family="Georgia" font-size="10">Time after treatment (h)</text></svg>`;
    const colors=['#205ea6','#24837b','#ad8301','#a02f6f'];
    for(let n=0;n<12;n++) await window.fig.writeText(`${root}/study/result-${String(n).padStart(2,'0')}.svg`,svg(colors[n%4],n));
    await window.fig.writeText(`${root}/elsewhere/control.svg`,svg(colors[0],0));
    await window.fig.writeText(`${root}/_lighttable/sweep.svg`,svg(colors[1],1));
    await window.fig.writeText(`${root}/bad.svg`,'broken SVG');
    window.__galleryReads=0;
    const read=window.fig.readFile.bind(window.fig);window.fig.readFile=async path=>{window.__galleryReads++;return read(path)};
  });
  await open();
  assert(await page.$('.list.gallery'), 'gallery is the default');
  await pick(page,'study');
  await page.waitForFunction(() => document.querySelectorAll('.preview img').length===12 && [...document.querySelectorAll('.preview img')].every(n=>n.complete&&n.naturalWidth>0));
  await pick(page,'result-00');
  assert.equal(await page.$eval('.pickpill',n=>n.textContent),'1 selected');
  mkdirSync('test-results',{recursive:true});
  await page.screenshot({path:'test-results/plot-gallery.png'});
  console.log('gallery previews ready');
  const popupEvent = new Promise(resolve => page.once('popup',resolve));
  await page.click('.pinbtn');
  const gallery=await popupEvent;
  console.log('popup ready');
  await gallery.waitForSelector('.detached .importer');
  assert.equal(await page.$('.ibackdrop'),null,'pinned gallery leaves no backdrop');
  assert.equal(await gallery.$eval('.path .cur',n=>n.textContent),'study','folder preserved on pin');
  assert.equal(await gallery.$eval('.pickpill',n=>n.textContent),'1 selected','selection preserved on pin');
  assert.equal(await gallery.evaluate(()=>!!window.fig),false,'no second file bridge');
  await gallery.click('.rootbtn');await pick(gallery,'elsewhere');await pick(gallery,'control');
  assert.equal(await gallery.$eval('.pickpill',n=>n.textContent),'2 selected','cross-folder selection survives pin');
  await query(gallery,'result-11');
  assert.equal(await gallery.$eval('.nm',n=>n.textContent),'result-11','pinned search reaches other ordinary folders');
  await query(gallery,'_light');await gallery.keyboard.press('Enter');
  await gallery.waitForFunction(()=>document.querySelector('.path .cur')?.textContent==='_lighttable');
  await query(gallery,'control');assert.equal(await gallery.$('.row'),null,'reserved scope remains isolated');
  await gallery.click('.rootbtn');
  await gallery.setViewport({width:520,height:620});await frame(gallery);
  assert(await gallery.evaluate(()=>{const b=document.querySelector('.insbtn').getBoundingClientRect();return b.right<=innerWidth&&b.bottom<=innerHeight}), 'controls fit narrow window');
  await gallery.$eval('[aria-label="Preview size"]',n=>{n.value='320';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))});
  await frame(gallery);assert.equal(await gallery.$eval('.items',n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1,'preview sizing reflows');
  await gallery.$eval('[aria-label="Preview spacing"]',n=>{n.value='28';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))});
  await frame(gallery);assert.equal(await gallery.$eval('.items',n=>getComputedStyle(n).gap),'28px','spacing changes');
  await gallery.setViewport({width:1060,height:780});await frame(gallery);
  const before=await page.evaluate(()=>window.__flux.figures()[0].elements.length);
  await gallery.click('.insbtn');await gallery.waitForSelector('[role=status]');
  assert.equal(await page.evaluate(()=>window.__flux.figures()[0].elements.length),before+2,'pinned batch inserts into editor');
  assert(await gallery.$('.importer'),'gallery stays open after insert');
  // The actual parent keyboard remains usable; no fixture mutation assists it.
  await page.bringToFront();await page.keyboard.press('ArrowRight');
  await page.keyboard.press('f');await page.waitForSelector('.fluxFigMenu');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.fluxFigMenu .fcontent')).opacity==='1');
  await page.screenshot({path:'test-results/figure-properties.png'});
  await page.keyboard.press('Escape');
  await gallery.bringToFront();await gallery.click('.insbtn');
  await page.waitForFunction(n=>window.__flux.figures()[0].elements.length===n,{},before+4).catch(async()=>{assert.equal(await page.evaluate(()=>window.__flux.figures()[0].elements.length),before+4)});
  // Change the destination through the editor, then hold an actual file read
  // across a second destination change: it must not place into either figure.
  const other = await page.evaluate(() => { const F=window.__flux; F.fig.duplicateFigure(F.figures()[0].id); return {id:F.get(F.fig.activeFigureId), count:F.figures().at(-1).elements.length}; });
  await frame(gallery);await gallery.click('.insbtn');
  await page.waitForFunction(({id,count})=>window.__flux.figures().find(f=>f.id===id)?.elements.length===count+2,{},other);
  assert.equal(await page.evaluate(()=>window.__flux.figures()[0].elements.length),before+4,'new insertion follows the active figure');
  await page.evaluate(()=>{
    const read=window.fig.readFile.bind(window.fig);let held=false;
    window.fig.readFile=async path=>{if(!held && path.endsWith('/study/result-00.svg')){held=true;window.__galleryReadBlocked=true;await new Promise(resolve=>window.__resumeGalleryRead=resolve)}return read(path)};
  });
  await gallery.click('.insbtn');await page.waitForFunction(()=>window.__galleryReadBlocked);
  const originalId=await page.evaluate(()=>window.__flux.figures()[0].id);
  await page.bringToFront();await page.click(`.figrow[data-fig-id="${originalId}"] .item`);
  await page.evaluate(()=>{window.__resumeGalleryRead();});
  await gallery.waitForSelector('[role=alert]');
  assert.match(await gallery.$eval('[role=alert]',n=>n.textContent),/destination changed/);
  assert.equal(await page.evaluate(()=>window.__flux.figures()[0].elements.length),before+4,'slow import cannot leak into another destination');
  assert.equal(await page.evaluate(id=>window.__flux.figures().find(f=>f.id===id).elements.length,other.id),other.count+2,'canceled import adds no elements to original destination');
  await gallery.bringToFront();
  await gallery.click('.pinbtn');await page.waitForSelector('.importer');
  assert.equal(await page.$eval('.pickpill',n=>n.textContent),'2 selected','dock preserves picks');
  await page.click('.closebtn');
  // A fresh open retains display preferences, and closing the native window
  // clears modal ownership so the next Alt+I works normally.
  await open();assert.equal(await page.$eval('[aria-label="Preview size"]',n=>n.value),'320');
  const secondEvent=new Promise(resolve=>page.once('popup',resolve));await page.click('.pinbtn');const second=await secondEvent;
  await second.waitForSelector('.importer');await second.close();await page.waitForFunction(()=>!document.querySelector('.importer'));
  await page.bringToFront();await open();await page.click('.closebtn');
  await page.evaluate(async()=>{
    for(let i=0;i<5000;i++)await window.fig.writeText(`/demo/myc-growth-paper/plots/scale/plot-${String(i).padStart(4,'0')}.svg`,'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#205ea6"/></svg>');
    window.__galleryReads=0;
  });
  await open();await pick(page,'scale');await frame(page);
  metrics.mounted=await page.$$eval('.importer .row',ns=>ns.length);assert(metrics.mounted<100,'5000 plots mount a bounded window');
  metrics.reads=await page.evaluate(()=>window.__galleryReads);assert(metrics.reads<110,'only visible/overscan images read');
  metrics.searchPaint=await page.evaluate(()=>new Promise(resolve=>{const n=document.querySelector('.search-in');const t=performance.now();n.value='plot-4999';n.dispatchEvent(new Event('input',{bubbles:true}));requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-t)))}));
  await page.waitForFunction(()=>document.querySelector('.nm')?.textContent==='plot-4999');assert(metrics.searchPaint<=100,'5000 plot search paints within 100ms');
  await query(page,'');
  await page.focus('.importer .row');await page.keyboard.press('End');await frame(page);

  await page.waitForFunction(()=>document.activeElement?.querySelector('.nm')?.textContent==='plot-4999');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(()=>document.activeElement?.querySelector('.nm')?.textContent==='plot-4998');
  await page.keyboard.press('Home');await frame(page);
  metrics.scrollPaint=await page.evaluate(()=>new Promise(resolve=>{const n=document.querySelector('.list');const t=performance.now();n.scrollTop=n.scrollHeight;n.dispatchEvent(new Event('scroll'));requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-t)))}));
  assert(metrics.scrollPaint<=100,'5000 plot scroll paints within 100ms');
  await page.waitForFunction(()=>[...document.querySelectorAll('.nm')].some(n=>n.textContent==='plot-4999'));
  assert.deepEqual(realErrors(page),[],'clean app console');
  writeFileSync('test-results/plot-gallery-metrics.json',JSON.stringify(metrics,null,2));
  console.log('Plot gallery: PASS',metrics);
  console.log('##VERIFY## '+JSON.stringify({script:'verify-plot-gallery',ok:true,metrics}));
} finally { await browser.close(); }
