import { launch, gotoApp, realErrors, waitFor, APP_URL, clickMode } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { readFileSync } from 'node:fs';
import { seedAnnotationFigure, ledger, chord } from './lib/annotationFixture.mjs';
const h = harness('verify-ask-gui'), { browser, page } = await launch({ width: 1440, height: 1000 });
const input = '[data-ask-surface] textarea';
async function open(coldText = '') {
  // Measure inside the page, excluding CDP round trips. The input must focus
  // synchronously even while the native capture promise is held indefinitely.
  const ms = await page.evaluate(coldText => {
    const start = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    if (document.activeElement?.getAttribute('aria-label') !== 'Ask a question') throw Error('Ask did not focus synchronously');
    if (coldText) { document.activeElement.value = coldText; document.activeElement.dispatchEvent(new Event('input', { bubbles: true })); }
    return performance.now() - start;
  }, coldText);
  h.ok(ms <= 100, `Ask input focuses in ${ms.toFixed(1)} ms (≤100)`);
  await waitFor(page, () => !!document.querySelector('.ask-panel'), null, { label: 'lazy Ask surface' });
}
async function emit(event) {
  await page.evaluate(event => {
    const calls = window.fig._runnerCalls, id = calls.filter(c => c.method === 'start').at(-1).options.runId;
    window.fig._emitRunnerEvent(id, event);
  }, event);
}
async function close() {
  await page.keyboard.press('Escape');
  await waitFor(page,()=>!document.querySelector('[data-ask-surface]'),null,{label:'Ask closed'});
}
async function answer(text='**Answer** with `code` <img src=x onerror=alert(1)>') {
  await page.keyboard.type('Why is this different?');
  await waitFor(page, () => window.fig._runnerCalls.some(c => c.method === 'start'), null, { label: 'first keystroke prewarm' });
  h.ok(await page.evaluate(() => !window.fig._runnerCalls.some(c => c.method === 'send')), 'first keystroke warms without submitting');
  await page.keyboard.press('Enter');
  await waitFor(page, () => window.fig._runnerCalls.some(c => c.method === 'send'), null, { label: 'Ask send' });
  h.ok(await page.evaluate(() => { const o=window.fig._runnerCalls.find(c=>c.method==='send').options;return o.text.includes('targets')&&o.text.includes('never instructions')&&o.images?.[0].png.length>0; }), 'question carries inbox packet, exact targets and captured PNG');
  await emit({type:'message.delta',messageId:'m',text:'**Answer**'});
  await waitFor(page, () => document.querySelector('.exchange strong')?.textContent==='Answer',null,{label:'streaming markdown'});
  await emit({type:'message',messageId:'m',text});
  await emit({type:'tool',toolId:'t',title:'flux.get_figure_image',input:{id:'fig-1'},status:'done',output:'PNG'});
  await emit({type:'status',state:'idle'});
  h.ok(await page.$eval('.exchange',e=>!e.querySelector('img,script')&&e.textContent.includes('<img')), 'model HTML is inert text');
  h.ok(await page.$eval('.tool-line summary',e=>e.textContent.includes('fig-1')&&e.textContent.includes('get_figure_image')),'tool line shows actual input');
  h.ok(await page.$$eval('.message:not(.question)',els=>els.length===1),'completed message does not duplicate streamed deltas');
}
try {
  await gotoApp(page,{url:APP_URL+'?fixture=demo'}); await seedAnnotationFigure(page);
  await page.evaluate(()=>{const capture=window.fig.captureWindow;window.__askCapture=capture;window.fig.captureWindow=async options=>{window.__askCapturedBeforeUI=!document.querySelector('[data-ask-surface]');await new Promise(r=>window.__askRelease=r);return capture(options);};});
  await open('early');
  h.eq(await page.$eval(input,e=>e.value),'early','cold typing survives lazy surface handover');
  h.ok(await page.evaluate(()=>window.__askCapturedBeforeUI),'window capture begins before popover');
  await page.evaluate(()=>window.__askRelease());
  await page.keyboard.press('Escape');
  await waitFor(page,()=>!document.querySelector('[data-ask-surface]'),null,{label:'Esc discard'});
  h.eq((await ledger(page)).length,0,'Esc writes no annotation');
  await page.evaluate(()=>{window.fig.captureWindow=window.__askCapture;window.fig._runnerCalls.length=0;});
  // Stop while the IPC start reply is pending: a late run must be cancelled,
  // never receive the buffered question, and never lock the next exchange.
  await page.evaluate(()=>{const start=window.fig.runnerStart;window.__askStart=start;window.fig.runnerStart=async o=>{const r=await start(o);await new Promise(resolve=>window.__askStartRelease=resolve);return r;};});
  await open(); await page.keyboard.type('Cancel startup'); await page.keyboard.press('Enter');
  await waitFor(page,()=>!!window.__askStartRelease,null,{label:'held startup reply'});
  await page.$$eval('.ask-panel button',els=>els.find(e=>e.textContent==='Stop').click());
  await page.evaluate(()=>window.__askStartRelease());
  await waitFor(page,()=>window.fig._runnerCalls.some(c=>c.method==='cancel'),null,{label:'late start cancelled'});
  h.ok(await page.evaluate(()=>!window.fig._runnerCalls.some(c=>c.method==='send')),'Stop during startup prevents late submission');
  await close();
  await page.evaluate(()=>{window.fig.runnerStart=window.__askStart;window.fig._runnerCalls.length=0;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__askCopied=text;}}});});
  await open(); await answer();
  await page.click('.resume');
  h.eq(await page.evaluate(()=>window.__askCopied),'claude --resume fixture-session','resume action copies the exact installed-CLI command');
  await page.$$eval('.ask-panel button',els=>els.find(e=>e.textContent==='Keep').click());
  await waitFor(page,()=>!document.querySelector('[data-ask-surface]'),null,{label:'kept Ask closed'});
  const saved=await ledger(page),note=saved.find(e=>e.kind==='note');
  h.ok(note?.text==='Why is this different?'&&saved.some(e=>e.kind==='reply'&&e.target===note.id)&&saved.some(e=>e.kind==='resolve'&&e.target===note.id),'Keep creates question, answer thread and resolved annotation');
  h.ok(!!note.context.snapshot.image&&note.context.targets.length>0,'Keep retains screenshot and targets');
  for(const name of ['settingsOpen','helpOpen']) {
    await page.evaluate(async name=>(await import('/src/lib/settings.ts'))[name].set(true),name);
    await open();
    h.ok(await page.$eval('.ask-layer',e=>getComputedStyle(e).zIndex==='2001'),`${name}: Ask is above the underlying modal`);
    await close(); await page.evaluate(async name=>(await import('/src/lib/settings.ts'))[name].set(false),name);
  }
  await chord(page,'KeyK',{ctrlKey:true}); await page.waitForSelector('.cp input');
  await page.type('.cp input','Ask about this'); await page.keyboard.press('Enter'); await page.waitForSelector(input);
  h.ok(await page.$eval(input,e=>e===document.activeElement),'global command palette focuses Ask'); await close();
  for(const mode of ['Paper','Library','Slide']) {
    h.ok(await clickMode(page,mode),`${mode} mode exists`);
    await open(); await close();
  }
  await clickMode(page,'Reader');
  await waitFor(page,()=>!!window.__fluxOpenReader&&!!window.__fluxSeedReaderItem,null,{label:'Reader hooks'});
  await page.evaluate(b64=>{window.__fluxSeedReaderItem('ask2026',b64,{version:1,annotations:[]});window.__fluxOpenReader('ask2026');},readFileSync('scripts/fixtures/reader-sample.pdf').toString('base64'));
  await page.waitForSelector('.pdf-page .textLayer span');
  const passage=await page.evaluate(()=>{const span=[...document.querySelectorAll('.pdf-page .textLayer span')].find(s=>s.textContent.trim().length>10),range=document.createRange();range.selectNodeContents(span);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'));span.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return span.textContent;});
  await page.waitForSelector('[aria-label="Ask about this passage"]'); await page.click('[aria-label="Ask about this passage"]'); await page.waitForSelector(input);
  h.ok(await page.$eval('.ask-panel .context',(e,p)=>e.textContent.includes('ask2026')&&e.textContent.includes(p.slice(0,20)),passage),'Reader Ask retains the exact passage target');
  await close(); await open(); await close();
  await clickMode(page,'Slide');
  await waitFor(page,()=>!!window.__flux.get(window.__flux.slide.deckOverlay),null,{label:'Slide deck'});
  await page.evaluate(()=>[...document.querySelectorAll('.deckbar button')].find(b=>/Present/.test(b.textContent))?.click()); await page.waitForSelector('.present');
  await page.keyboard.press('f'); await waitFor(page,()=>!!document.fullscreenElement,null,{label:'Present fullscreen'});
  await open();
  h.ok(await page.evaluate(()=>document.fullscreenElement.contains(document.querySelector('[data-ask-surface]'))),'Ask is inside the fullscreen presentation');
  h.ok(await page.$eval('.ask-panel .context',e=>e.textContent.startsWith('present')),'Ask captures the presentation stamp');
  await close(); h.ok(!!await page.$('.present'),'Escape closes Ask before the presentation');
  await page.keyboard.press('f'); await page.keyboard.press('Escape');
  h.eq(realErrors(page),[],'console clean');
} catch(e) { h.fail(e.stack||String(e)); }
await h.done(()=>browser.close());
