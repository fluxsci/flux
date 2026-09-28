import { readFileSync, mkdirSync } from 'node:fs';
import { harness } from './lib/harness.mjs';
import { launch, gotoApp, clickMode, APP_URL, waitFor, waitForFrame, realErrors } from './lib/driver.mjs';
const h = harness('verify-plot-view-gui');
const svg = readFileSync('scripts/fixtures/plots/mpl_sine_waves_FLUXPLOT.svg', 'utf8');
const manifest = JSON.parse(readFileSync('scripts/fixtures/plots/mpl_sine_waves_FLUXPLOT.fluxplot.json', 'utf8'));
const { browser, page } = await launch({ width: 1500, height: 1000 });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const input = '.inspector [data-axis-view-row="x"] .nf:nth-of-type(2) input';
const line = '.canvas-host [data-editor-element-id="view-plot"] [id="view-plot__2hz.line"] path';
async function seed(mode) {
  await gotoApp(page, { url: APP_URL+'?fixture=demo' });
  await clickMode(page, mode);
  await waitFor(page, () => !!window.__flux && !!document.querySelector('.canvas-host'));
  await page.evaluate((svg, manifest) => {
    const F = window.__flux;
    F.io.reimportPlot('view-asset', svg, manifest);
    F.fig.commit(p => {
      const f = p.figures.find(f => f.id === F.get(F.fig.activeFigureId));
      f.elements = [{ id:'view-plot', type:'plot', assetId:'view-asset', x:40,y:60,width:650,height:210,rotation:0 }];
    });
    F.fig.selectOnly('view-plot'); F.fig.resetHistory();
  }, svg, manifest);
  await waitFor(page, selector => !!document.querySelector(selector), input);
}
async function typeMax(value, selector=input) {
  await page.click(selector, { count: 3 }); await page.keyboard.type(value); await waitForFrame(page);
}
const model = () => page.evaluate(() => {
  const F=window.__flux, p=F.get(F.fig.project), el=p.figures.flatMap(f=>f.elements).find(e=>e.id==='view-plot');
  return { view:el.view??null, history:F.fig.historyStats().past };
});
try {
  await seed('Figure');
  const before = await page.$eval(line,n=>n.getAttribute('d'));
  h.eq(await page.$eval(input,n=>n.value), '', 'default limit is empty');
  h.eq(await page.$eval(input,n=>n.placeholder), String(manifest.axes[0].x.domain[1]), 'placeholder is generator domain');
  await typeMax('4');
  h.eq((await model()).view?.x?.domain?.[1],4,'typing previews the limit before commit');
  const projected = await page.$eval(line,n=>n.getAttribute('d'));
  h.ok(projected!==before,'canvas line vertices re-project');
  await page.keyboard.press('Enter');
  h.eq((await model()).history,1,'one armed edit is one undo');
  const exported = await page.evaluate(async()=>{
    const F=window.__flux, p=F.get(F.fig.project), f=p.figures.find(f=>f.elements.some(e=>e.id==='view-plot'));
    const {buildFigureSvg}=await import('/src/lib/io.ts');
    return new DOMParser().parseFromString(buildFigureSvg(f),'image/svg+xml').querySelector('[id="view-plot__2hz.line"] path')?.getAttribute('d');
  });
  h.eq(exported, projected, 'standalone SVG export bakes the same view');
  await page.keyboard.down(mod); await page.keyboard.press('z'); await page.keyboard.up(mod);
  await waitForFrame(page);
  h.eq((await model()).view,null,'Ctrl+Z removes the view in one step');
  h.eq(await page.$eval(line,n=>n.getAttribute('d')),before,'undo restores exact canvas vertices');
  await typeMax('3'); await page.keyboard.press('Escape'); await waitForFrame(page);
  h.eq((await model()).view,null,'Escape cancels the live draft');
  await typeMax('4'); await page.keyboard.press('Enter');
  await page.click(input,{count:3}); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter');
  h.eq((await model()).view,null,'empty limit restores its generator default');
  const minInput='.inspector [data-axis-view-row="x"] .nf:nth-of-type(1) input';
  await typeMax('-0.0000003',minInput);await page.keyboard.press('Enter');await waitForFrame(page);
  h.eq(Number(await page.$eval(minInput,n=>n.value)),-3e-7,'small data-unit limits do not round to zero on blur');
  await page.click('.inspector .axis-view .reset');await waitForFrame(page);
  const beforeWheel=(await model()).history;
  await page.hover(input); await page.mouse.wheel({deltaY:-100});
  await waitFor(page,n=>window.__flux.fig.historyStats().past===n+1,beforeWheel);
  h.ok((await model()).view?.x?.domain?.[1]>manifest.axes[0].x.domain[1],'wheel previews in data units with one undo');
  await page.click('.inspector .axis-view .reset');await waitForFrame(page);
  h.eq((await model()).view,null,'Reset restores generated axes');
  await page.select('.inspector select[aria-label="x scale"]','log');await waitForFrame(page);
  h.eq((await model()).view,null,'invalid log limits leave the model unchanged');
  h.ok((await page.$eval('.inspector .axis-view [role="status"]',n=>n.textContent)).includes('positive'),'invalid log limits explain the correction');
  await page.evaluate(()=>document.activeElement?.blur()); await page.keyboard.press('f');
  await waitFor(page,()=>!!document.querySelector('.fluxFigMenu.placed'));
  h.eq(await page.$eval('.fluxFigMenu .field[data-key="v"] .label',n=>n.textContent),'x view','F-menu v offers x view');
  h.eq(await page.$eval('.fluxFigMenu .field[data-key="b"] .label',n=>n.textContent),'y view','F-menu b offers y view');
  await page.keyboard.press('v');
  const menuInput='.fluxFigMenu [data-axis-view-row="x"] .nf:nth-of-type(2) input';
  await waitFor(page, s=>!!document.querySelector(s), menuInput);
  await typeMax('5',menuInput); await page.keyboard.press('Enter');
  h.eq((await model()).view?.x?.domain?.[1],5,'F-menu edits through the same control');
  mkdirSync('test-results/plot-view',{recursive:true});
  await page.screenshot({path:'test-results/plot-view/figure-menu.png'});
  await page.evaluate(()=>document.activeElement?.blur()); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.evaluate(()=>{const F=window.__flux,fig=F.get(F.fig.project).figures.find(f=>f.elements.some(e=>e.id==='view-plot'));F.fig.xrayRoot.set({kind:'element',figId:fig.id,elementId:'view-plot'});F.fig.xrayOpen.set(true)});
  await waitFor(page,()=>!!document.querySelector('.xray.placed'));
  // Click the generator's actual axis row; it is visible in the open tree.
  await page.waitForSelector('.xray .row[data-rid="part:view-plot__axis.x"]');
  await page.click('.xray .row[data-rid="part:view-plot__axis.x"]');
  await waitForFrame(page);
  await page.keyboard.press('v');
  await waitFor(page,()=>!document.querySelector('.xray'));
  h.eq(await page.evaluate(()=>document.activeElement?.closest('[data-axis-view-row]')?.getAttribute('data-axis-view-row')),'x','X-ray axis v focuses matching Inspector row');

  // Fresh page: the demo bridge cannot persist reimported assets through tenancy.
  await seed('Slide');
  await page.evaluate(()=>{const F=window.__flux,sid=F.get(F.fig.activeFigureId);F.slide.commitDeckLive(d=>{F.slideOps.addBeat(d,sid,{label:'First'});F.slideOps.addBeat(d,sid,{label:'Zoom'});});F.slide.activeBeat.set(2)});
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>/Animate ⏱/.test(b.textContent))?.click());
  await waitFor(page,()=>!!document.querySelector('.animator'));
  await page.evaluate(()=>[...document.querySelectorAll('.edit-switch button')].find(b=>b.textContent.trim()==='Edit after step 2')?.click());
  await typeMax('4'); await page.keyboard.press('Enter');await waitForFrame(page);
  const state = await page.evaluate(()=>{const F=window.__flux,d=F.slide.currentDeck(),s=d.slides.find(s=>s.id===F.get(F.fig.activeFigureId));return {base:s.elements.find(e=>e.id==='view-plot').view??null,track:s.beats[2].tracks.find(t=>t.target==='view-plot'),history:F.fig.historyStats().past};});
  h.eq(state.base,null,'After-step edit preserves canonical Design view');
  h.eq(state.track?.to?.state?.view?.x?.domain?.[1],4,'After step 2 captures state.view on a Change track');
  const paths=[];
  for(const fraction of [0,.5,1]) {
    const spot=await page.evaluate(fraction=>{
      const ruler=[...document.querySelectorAll('.animator .ruler')].find(n=>n.getBoundingClientRect().width>0),r=ruler.getBoundingClientRect();
      const tick=[...ruler.querySelectorAll('.tick')].find(n=>parseFloat(n.textContent)>0);
      const scale=parseFloat(tick.style.left)/(parseFloat(tick.textContent)*1000);
      const F=window.__flux,s=F.slide.currentDeck().slides.find(s=>s.id===F.get(F.fig.activeFigureId)),t=s.beats[2].tracks.find(t=>t.target==='view-plot');
      return {x:r.x+fraction*(t.duration??600)*scale+.01,y:r.y+r.height/2};
    },fraction);
    await page.mouse.click(spot.x,spot.y);
    await waitFor(page,()=>!!document.querySelector('.preview-overlay .sl-el'));await waitForFrame(page);
    paths.push(await page.$eval('.preview-overlay [data-el-id="view-plot"] [id="view-plot__2hz.line"] path',n=>n.getAttribute('d')));
  }
  h.ok(paths[0]!==paths[1]&&paths[1]!==paths[2],'real ruler scrubbing glides through distinct projected vertices');
  await page.screenshot({path:'test-results/plot-view/slide-view.png'});
  h.eq(realErrors(page),[],'no console errors');
} catch(e) { await page.screenshot({path:'test-results/plot-view/failure.png'}); h.fail(e.stack??String(e)); }
await h.done(()=>browser.close());
