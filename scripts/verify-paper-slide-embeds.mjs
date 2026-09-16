import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-paper-slide-embeds');
const {browser,page} = await launch();
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const ROOT = '/demo/myc-growth-paper';
try {
  await gotoApp(page,{url:`${APP_URL}?fixture=demo`,settle:600});
  await page.evaluate(async root=>{
    const { inlineSlideFixture, inlineSlideSvg } = await import('/scripts/fixtures/inline-slide.ts');
    const pm = window.__flux.get(window.__flux.shell.projectModel);
    pm.manifest.slides = ['talk','second'].map(id=>({id,path:`slides/${id}/deck.json`,title:`Evidence ${id}`}));
    await window.fig.writeText(`${root}/project.json`,JSON.stringify(pm.manifest));
    for(const id of ['talk','second']) {
      const deck = inlineSlideFixture(id,id==='talk'?'#4385be':'#d14d41');
      await window.fig.writeText(`${root}/slides/${id}/deck.json`,JSON.stringify(deck));
      await window.fig.writeText(`${root}/slides/${id}/assets/shared.svg`,inlineSlideSvg(id==='talk'?'#4385be':'#d14d41'));
    }
  },ROOT);
  await clickMode(page,'Paper');
  await waitFor(page,()=>!!window.__fluxView,null,{timeout:10000});
  await page.evaluate(()=>{ const v=window.__fluxView;v.dispatch({selection:{anchor:v.state.doc.length}});v.focus(); });
  await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'---\ntitle: Inline slide verification\n---\n\n# Results\n\nBefore.\n\n'}});v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();});
  await waitFor(page,async root=>(await window.fig.readText(`${root}/manuscript/main.qmd`)).includes('Inline slide verification'),ROOT,{timeout:5000});
  const sourceBefore = await page.evaluate(()=>window.__fluxView.state.doc.toString());
  const deckBefore = await page.evaluate(root=>window.fig.readText(`${root}/slides/talk/deck.json`),ROOT);
  await page.keyboard.type('/slide',{delay:35});
  await waitFor(page,()=>document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionLabel')?.textContent==='/slide',null,{timeout:5000});
  await sleep(100);await page.keyboard.press('Enter');
  await page.waitForSelector('.slide-picker');
  await page.click('.slide-picker [aria-label="Evidence talk"]');
  await page.waitForSelector('.slide-picker [aria-label="Results"]');
  await waitFor(page,()=>{const img=document.querySelector('.slide-picker [aria-label="Results"] img');return img?.complete&&img.naturalWidth>0;},null,{timeout:10000});
  h.ok(await page.$eval('.slide-picker [aria-label="Results"] img',img=>decodeURIComponent(img.src).includes('#4385be')),'picker displays a loaded slide thumbnail');
  await shot(page,'inline-slide-picker');
  await page.click('.slide-picker [aria-label="Results"]');
  await waitFor(page,()=>!!document.querySelector('.cm-editor .flux-slide-art'),null,{timeout:12000});
  await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-bar')?.textContent.includes('Step 0 / 2'),null,{timeout:5000});
  h.ok(true,'deck → slide picker inserts at step 0');
  const line = await page.evaluate(()=>window.__fluxView.state.doc.toString().split('\n').find(l=>l.includes('.flux-slide')));
  h.ok(line.includes('deck="talk"')&&line.includes('slide="results"'),'document contains stable source IDs');
  await page.evaluate(()=>window.__fluxView.focus());await page.keyboard.down(modifier);await page.keyboard.press('z');await page.keyboard.up(modifier);
  h.ok(await page.evaluate(()=>!window.__fluxView.state.doc.toString().includes('.flux-slide')),'one Undo removes the inserted block');
  // CDP must send uppercase Z with Shift, as a real keyboard does; lowercase
  // z+Shift is interpreted as plain Undo by CodeMirror's character keymap.
  await page.keyboard.down(modifier);await page.keyboard.down('Shift');await page.keyboard.press('Z');await page.keyboard.up('Shift');await page.keyboard.up(modifier);
  await waitFor(page,()=>!!document.querySelector('.cm-editor .flux-slide-art'),null,{timeout:10000});
  const initial = await page.$('.cm-editor .flux-slide-art');
  await initial.click();await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-bar')?.textContent.includes('Step 1 / 2'),null,{timeout:5000});
  await sleep(350);
  h.ok(await page.$eval('.cm-editor .flux-slide-bar',e=>e.textContent.includes('Step 1 / 2')),'auto/with-prev steps wait for separate clicks');
  await page.click('.cm-editor [aria-label="Next animation step"]');
  await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-bar')?.textContent.includes('Step 2 / 2'),null,{timeout:5000});
  await page.click('.cm-editor [aria-label="Previous animation step"]');
  await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-bar')?.textContent.includes('Step 1 / 2'),null,{timeout:5000});
  const playerIdentity = await page.evaluate(()=>{window.__testSlideNode=document.querySelector('.cm-editor .flux-slide-art');return true;});
  await page.click('.cm-editor [title="Slide width 50%"]');
  h.ok(await page.evaluate(()=>window.__testSlideNode===document.querySelector('.cm-editor .flux-slide-art')&&window.__fluxView.state.doc.toString().includes('width=50%')),'resizing patches DOM and preserves playback');
  await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.toString().indexOf('Before.'),insert:'Prose edit. '}});});
  h.ok(await page.evaluate(()=>window.__testSlideNode===document.querySelector('.cm-editor .flux-slide-art')),'prose typing retains the player DOM');
  await page.click('.cm-editor [aria-label="Reset to step 0"]');
  await page.$eval('.cm-editor .flux-slide-art',e=>e.focus());await page.keyboard.press('ArrowRight');
  await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-bar')?.textContent.includes('Step 1 / 2'),null,{timeout:5000});
  h.ok(true,'focused keyboard navigation advances one step');
  await page.keyboard.press('Home');await page.keyboard.press('Escape');
  h.ok(await page.evaluate(()=>window.__fluxView.hasFocus),'Escape returns focus to prose');
  await page.evaluate(l=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:`\n\n${l}\n`}});},line);
  await waitFor(page,()=>document.querySelectorAll('.cm-editor .flux-slide-art').length===2,null,{timeout:10000});
  await page.click('.cm-editor .flux-slide-art');
  await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-bar')?.textContent.includes('Step 1 / 2'),null,{timeout:5000});
  h.ok(await page.$$eval('.cm-editor .flux-slide-bar',els=>els[1].textContent.includes('Step 0 / 2')),'pasted duplicate anchor has independent playback');
  h.ok(await page.$$eval('.cm-editor .flux-slide-art [id]',els=>new Set(els.map(e=>e.id)).size===els.length),'no duplicate SVG or element IDs');
  h.eq(await page.evaluate(root=>window.fig.readText(`${root}/slides/talk/deck.json`),ROOT),deckBefore,'insertion and playback preserve source deck bytes');
  await shot(page,'inline-slide-document');
  // Renderer smoke: shared standalone runtime under the application's actual CSP.
  await page.evaluate(async()=>{
    const {createSlideRepository}=await import('/src/lib/slide/embedRepository.ts');
    const {renderManuscript}=await import('/src/shell/modes/paper/render/renderManuscript.ts');
    const pm=window.__flux.get(window.__flux.shell.projectModel);
    const repo=createSlideRepository(pm.root,window.fig);
    window.__slideExport=(await renderManuscript(window.__fluxView.state.doc.toString(),{slides:repo,strict:true})).full;
    repo.dispose();
    const iframe=document.createElement('iframe');iframe.id='slide-artifact';iframe.style.cssText='position:fixed;inset:20px;width:950px;height:700px;z-index:9999;background:white';iframe.sandbox='allow-scripts';iframe.srcdoc=window.__slideExport;document.body.append(iframe);
  });
  const handle=await page.$('#slide-artifact'), frame=await handle.contentFrame();
  await frame.waitForSelector('.flux-slide-art');
  await frame.click('[aria-label="Next animation step"]');
  await waitFor(page,async()=>true,null,{timeout:1000});
  await frame.waitForFunction(()=>document.querySelector('.flux-slide-bar')?.textContent.includes('Step 1 / 2'));
  h.ok(true,'standalone HTML runtime executes under exact application CSP');
  await shot(page,'inline-slide-html-export');
  h.eq(realErrors(page),[],'no browser, module or CSP errors');
} catch(error) { h.fail(String(error)); console.error(error); await shot(page,'inline-slide-failure'); }
await h.done(()=>browser.close());
