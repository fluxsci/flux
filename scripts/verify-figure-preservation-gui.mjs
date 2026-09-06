import assert from 'node:assert/strict';
import { launch, gotoApp, clickMode, waitFor, waitForFrame, realErrors } from './lib/driver.mjs';

const { browser, page } = await launch();
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
try {
  for (const source of ['figure', 'slide']) {
    const destination = source === 'figure' ? 'slide' : 'figure';
    const label = source === 'figure' ? 'Figure' : 'Slide';
    await gotoApp(page, { url: 'http://127.0.0.1:1420/?fixture=demo' });
    await clickMode(page, label);
    await waitFor(page, mode => window.__flux?.tenancy.storeTenant() === mode && !!document.querySelector(`.${mode}-mode .canvas-host`), source);
    await page.evaluate(mode => {
      const F = window.__flux;
      F.fig.commit(p => {
        const f = p.figures.find(f => f.id === F.get(F.fig.activeFigureId));
        f.elements.push({ type: 'rect', id: 'preserve-me', x: 27, y: 39, width: 83, height: 61, rotation: 0, fill: '#4385be', stroke: 'none', strokeWidth: 0, cornerRadius: 0 });
      });
      F.fig.selectOnly('preserve-me');
      F.fig.viewport.set({ panX: 71, panY: 93, zoom: 0.75 });
      const write = window.fig.writeText.bind(window.fig);
      window.__restoreWrites = () => { window.fig.writeText = write; };
      window.__failedWrites = 0;
      window.fig.writeText = async (path, text) => {
        if (path.includes(mode === 'figure' ? '/fig/' : '/slides/')) {
          window.__failedWrites++;
          throw new Error('Verification: simulated save failure');
        }
        return write(path, text);
      };
    }, source);
    const snapshot = () => page.evaluate(() => {
      const F = window.__flux;
      return { marker: F.get(F.fig.project).figures.flatMap(f => f.elements).find(e => e.id === 'preserve-me'), selection: [...F.get(F.fig.selection)], viewport: F.get(F.fig.viewport), history: F.fig.historyStats() };
    });
    await waitForFrame(page);
    const before = await snapshot();
    await clickMode(page, destination === 'slide' ? 'Slide' : 'Figure');
    eq(await page.evaluate(() => window.__failedWrites > 0), true, `${source}: handoff attempted a save`);
    eq(await page.evaluate(() => window.__flux.get(window.__flux.panes.focusedMode)), source, `${source}: failed save keeps the original mode visible`);
    eq(await snapshot(), before, `${source}: failed switch preserves content, selection, viewport, undo and redo`);
    eq(await page.evaluate(() => window.__flux.tenancy.storeTenant()), source, `${source}: ownership stays with unsaved content`);
    await page.evaluate(async mode => { window.__restoreWrites(); await window.__flux.lifecycle.flushById(mode); }, source);
    await clickMode(page, destination === 'slide' ? 'Slide' : 'Figure');
    await waitFor(page, mode => window.__flux.tenancy.storeTenant() === mode && !!document.querySelector(`.${mode}-mode .canvas-host`), destination);
    eq(await page.evaluate(mode => !!document.querySelector(`.${mode}-mode`), source), false, `${source}: successful handoff evicts the old editor`);
    await clickMode(page, label);
    await waitFor(page, () => window.__flux.get(window.__flux.fig.project).figures.some(f => f.elements.some(e => e.id === 'preserve-me')));
    eq((await snapshot()).marker, before.marker, `${source}: edit survives successful save and round trip`);
  }
  // Full initialization is serialized, including a slow deck file read. Rapid
  // navigation may discard candidates, but only the final requested editor owns
  // the store and every durable Figure edit remains present.
  await gotoApp(page, { url: 'http://127.0.0.1:1420/?fixture=demo' });
  await clickMode(page, 'Figure');
  await waitFor(page, () => !!document.querySelector('.figure-mode .canvas-host'));
  await page.evaluate(async () => {
    const F=window.__flux;
    F.fig.commit(p => p.figures[0].elements.push({id:'rapid-marker',type:'rect',x:20,y:20,width:40,height:30,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0}));
    await F.lifecycle.flushById('figure');
    F.fig.selectOnly('rapid-marker');
    const read=window.fig.readText.bind(window.fig);let release;
    const gate=new Promise(r=>release=r);window.__releaseSlowRead=()=>{release();window.fig.readText=read};
    window.__slowReadStarted=false;
    window.fig.readText=async path=>{if(path.includes('/slides/')&&path.endsWith('/deck.json')){window.__slowReadStarted=true;await gate}return read(path)};
  });
  await waitForFrame(page);
  // Use the mounted NumberField's real edit session. Importing a stateful
  // module by URL can create a second instance after Vite HMR timestamps.
  const scrub=await page.evaluate(()=>{const n=[...document.querySelectorAll('.inspector .nf')].find(n=>n.querySelector('.lb')?.textContent.trim()==='X').querySelector('.lb'),b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});
  await page.mouse.move(scrub.x,scrub.y);await page.mouse.down();await page.mouse.move(scrub.x+180,scrub.y);
  eq(await page.evaluate(()=>window.__flux.figures()[0].elements.find(e=>e.id==='rapid-marker').x),200,'real property scrub is still an active preview');
  await page.evaluate(()=>document.querySelector('button[aria-label="Slide"]').click());
  await waitFor(page, () => window.__slowReadStarted, null, {label:'delayed deck initialization begins'});
  await page.evaluate(()=>{for(const label of ['Figure','Slide','Figure'])document.querySelector(`button[aria-label="${label}"]`).click();window.__releaseSlowRead()});
  await waitFor(page,()=>window.__flux.tenancy.storeTenant()==='figure'&&!!document.querySelector('.figure-mode .canvas-host'),null,{label:'final requested editor owns the store'});
  eq(await page.evaluate(()=>document.querySelectorAll('.canvas-host').length),1,'rapid handoff leaves only one editing canvas');
  eq(await page.evaluate(()=>window.__flux.figures().flatMap(f=>f.elements).find(e=>e.id==='rapid-marker')?.x),20,'handoff cancels an uncommitted property preview before saving and preserves the durable edit');
  await page.mouse.up();
  eq(realErrors(page), [], 'no page errors');
  console.log(`FIGURE PRESERVATION GUI: PASS (${checks} assertions)`);
} finally { await browser.close(); }
