import {launch,gotoApp,clickMode,waitFor,APP_URL,realErrors,shot,sleep} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-slide-embed-lifecycle');const {browser,page}=await launch();const root='/demo/myc-growth-paper';
try{
 await gotoApp(page,{url:`${APP_URL}?fixture=demo`,settle:600});
 await page.evaluate(async root=>{
  const {inlineSlideFixture,inlineSlideSvg}=await import('/scripts/fixtures/inline-slide.ts');
  const pm=window.__flux.get(window.__flux.shell.projectModel);pm.manifest.slides=['talk','second'].map(id=>({id,path:`slides/${id}/deck.json`}));
  await window.fig.writeText(`${root}/project.json`,JSON.stringify(pm.manifest));
  for(const id of ['talk','second']){await window.fig.writeText(`${root}/slides/${id}/deck.json`,JSON.stringify(inlineSlideFixture(id)));await window.fig.writeText(`${root}/slides/${id}/assets/shared.svg`,inlineSlideSvg(id==='talk'?'#4385be':'#d14d41'));}
 },root);
 await clickMode(page,'Paper');await waitFor(page,()=>!!window.__fluxView,null,{timeout:10000});
 await page.evaluate(()=>{const v=window.__fluxView;const lines=['talk','second'].map((id,i)=>`![](../slides/${id}/renders/results-step-0.svg){#slide-${i} .flux-slide deck="${id}" slide="results" width=50%}`);v.dispatch({changes:{from:0,to:v.state.doc.length,insert:`# Evidence\n\n${lines.join('\n\n')}\n\n`}});});
 await waitFor(page,()=>document.querySelectorAll('.cm-editor .flux-slide-art').length===2,null,{timeout:12000});
 h.eq(await page.$$eval('.cm-editor .flux-slide-art circle',els=>els.map(e=>e.getAttribute('fill'))),['#4385be','#d14d41'],'two decks with colliding asset IDs keep their own source bytes');
 await page.click('.cm-editor .flux-slide-art');await waitFor(page,()=>document.querySelector('.flux-slide-bar')?.textContent.includes('Step 1 / 2'),null,{timeout:5000});
 await page.evaluate(async root=>{const file=`${root}/slides/talk/deck.json`;const d=JSON.parse(await window.fig.readText(file));d.slides[0].name='Revised';await window.fig.writeText(file,JSON.stringify(d));(await import('/src/shell/scholar/revisions.ts')).bumpSlideEmbeds();},root);
 await waitFor(page,()=>document.querySelector('.flux-slide-title')?.textContent.includes('Revised'),null,{timeout:5000});
 h.ok(await page.$eval('.flux-slide-bar',e=>e.textContent.includes('Step 1 / 2')),'source-only revision preserves current beat identity');
 await page.evaluate(async root=>{const file=`${root}/slides/talk/deck.json`;const d=JSON.parse(await window.fig.readText(file));d.slides[0].beats=d.slides[0].beats.filter(b=>b.id!=='reveal');await window.fig.writeText(file,JSON.stringify(d));(await import('/src/shell/scholar/revisions.ts')).bumpSlideEmbeds();},root);
 await waitFor(page,()=>document.querySelector('.flux-slide-bar')?.textContent.includes('Step 0 / 1'),null,{timeout:5000});h.ok(true,'removed beat returns safely to step 0');
 // Full source deletion gives a document placeholder, never an unrelated slide.
 await page.evaluate(async root=>{const file=`${root}/slides/talk/deck.json`;const d=JSON.parse(await window.fig.readText(file));d.slides=d.slides.filter(s=>s.id!=='results');await window.fig.writeText(file,JSON.stringify(d));(await import('/src/shell/scholar/revisions.ts')).bumpSlideEmbeds();},root);
 await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-error')?.textContent.includes('no longer'),null,{timeout:5000});h.ok(true,'removed source shows an actionable unavailable block');
 await page.click('.cm-editor [title="Choose replacement slide"]');await page.waitForSelector('.slide-picker');await page.click('.slide-picker [aria-label="Evidence second"]');await page.waitForSelector('.slide-picker [aria-label="Results"]');await page.click('.slide-picker [aria-label="Results"]');
 await waitFor(page,()=>document.querySelectorAll('.cm-editor .flux-slide-art').length===2,null,{timeout:5000});h.ok(!await page.$('.cm-editor .flux-slide-error'),'replacement repairs the block');
 const saved=await page.evaluate(()=>window.__fluxView.state.doc.toString());
 await page.evaluate(()=>window.__fluxView.focus());await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('e');await page.keyboard.up('Shift');await page.keyboard.up('Control');
 await page.waitForSelector('.preview iframe');const f=await (await page.$('.preview iframe')).contentFrame();await f.waitForSelector('.flux-slide-art');await f.click('[aria-label="Next animation step"]');await f.waitForFunction(()=>document.querySelector('.flux-slide-bar')?.textContent.includes('Step 1 / 2'));
 await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\nNew prose.\n'}});});
 await f.waitForFunction(()=>document.body.textContent.includes('New prose.'));await f.waitForFunction(()=>document.querySelector('.flux-slide-bar')?.textContent.includes('Step 1 / 2'));
 h.ok(true,'live preview restores playback across srcdoc updates');await shot(page,'inline-slide-preview');
 await page.evaluate(()=>{document.querySelector('.paper').focus();});
 // Toggle via the command's window chord (iframe focus would otherwise own it).
 await page.click('button[aria-label="Paper"]');await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('e');await page.keyboard.up('Shift');await page.keyboard.up('Control');
 await waitFor(page,()=>!document.querySelector('.preview iframe'),null,{timeout:5000});
 await page.click('.cm-editor .flux-slide-art');await waitFor(page,()=>document.querySelector('.cm-editor .flux-slide-bar')?.textContent.includes('Step 1 / 2'),null,{timeout:5000});
 await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({changes:{from:v.state.doc.length,insert:'\n'+Array.from({length:600},(_,i)=>`Paragraph ${i}.`).join('\n\n')}});v.scrollDOM.scrollTop=v.scrollDOM.scrollHeight;});
 await waitFor(page,()=>document.querySelectorAll('.cm-editor .flux-slide-art').length===0,null,{timeout:5000});
 await page.evaluate(()=>window.__fluxView.scrollDOM.scrollTop=0);await waitFor(page,()=>document.querySelectorAll('.cm-editor .flux-slide-art').length===2,null,{timeout:5000});
 h.ok(await page.$eval('.cm-editor .flux-slide-bar',e=>e.textContent.includes('Step 1 / 2')),'offscreen disposal and remount preserve settled state');
 // Changing documents resets playback even when pasted IDs match.
 await page.evaluate(()=>{const b=[...document.querySelectorAll('.dp-item')].find(e=>e.title==='manuscript/supp.qmd');b.click();});
 await waitFor(page,()=>document.querySelector('.dp-item.active')?.getAttribute('title')==='manuscript/supp.qmd',null,{timeout:5000});
 await page.evaluate(()=>{const b=[...document.querySelectorAll('.dp-item')].find(e=>e.title==='manuscript/main.qmd');b.click();});
 await waitFor(page,()=>!!document.querySelector('.cm-editor .flux-slide-art'),null,{timeout:5000});
 h.ok(await page.$eval('.cm-editor .flux-slide-bar',e=>e.textContent.includes('Step 0 / 2')),'fresh document open starts at zero');
 h.eq(realErrors(page),[],'lifecycle transitions have no renderer errors');
}catch(e){h.fail(String(e));console.error(e);await shot(page,'inline-slide-lifecycle-failure');}await h.done(()=>browser.close());
