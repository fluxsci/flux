import {launch,gotoApp,clickMode,waitFor,APP_URL,realErrors,shot,sleep} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-scale-paper-slide-embeds');const {browser,page}=await launch();
try{
 await gotoApp(page,{url:`${APP_URL}?fixture=demo`,settle:500});
 await page.evaluate(async()=>{const {inlineSlideFixture,inlineSlideSvg}=await import('/scripts/fixtures/inline-slide.ts');const pm=window.__flux.get(window.__flux.shell.projectModel),root=pm.root;const d=inlineSlideFixture();const exemplar=d.slides[0];d.slides=Array.from({length:1000},(_,i)=>({...structuredClone(exemplar),id:`s${i}`,name:`Slide ${i}`}));pm.manifest.slides=[{id:'talk',path:'slides/talk/deck.json',title:d.title}];await window.fig.writeText(`${root}/project.json`,JSON.stringify(pm.manifest));await window.fig.writeText(`${root}/slides/talk/deck.json`,JSON.stringify(d));await window.fig.writeText(`${root}/slides/talk/assets/shared.svg`,inlineSlideSvg());});
 await clickMode(page,'Paper');await waitFor(page,()=>!!window.__fluxView,null,{timeout:10000});
 const load=await page.evaluate(()=>{const rows=Array.from({length:20000},(_,i)=>i%200===10?`![](../slides/talk/renders/s${Math.floor(i/200)%5}-step-0.svg){#slide-${i} .flux-slide deck="talk" slide="s${Math.floor(i/200)%5}" width=100%}`:i%5===4?'':`Paragraph ${i}. Research notes and explanatory text.`);const v=window.__fluxView,t=performance.now();v.dispatch({changes:{from:0,to:v.state.doc.length,insert:rows.join('\n')}});v.dispatch({selection:{anchor:v.state.doc.line(2).from}});v.focus();return performance.now()-t;});
 await waitFor(page,()=>!!document.querySelector('.cm-editor .flux-slide-art'),null,{timeout:10000});
 h.ok(await page.$$eval('.cm-editor .flux-slide-art',els=>els.length<=3),'100 references in 20k lines mount only visible players');
 await page.evaluate(()=>{window.__scaleSlide=document.querySelector('.cm-editor .flux-slide-art');window.__keys=[];window.__keyStart=0;const c=window.__fluxView.contentDOM;c.addEventListener('keydown',e=>{if(e.key==='x')window.__keyStart=performance.now();});c.addEventListener('input',()=>{const t=window.__keyStart;if(t)requestAnimationFrame(()=>window.__keys.push(performance.now()-t));});});
 for(let i=0;i<15;i++){await page.keyboard.type('x');await sleep(20);}
 await waitFor(page,()=>window.__keys.length>=15,null,{timeout:3000});
 const times=await page.evaluate(()=>window.__keys);h.ok(times.length===15&&Math.max(...times)<100,`20k-line key-to-frame ≤100ms (max ${Math.max(...times).toFixed(1)}ms)`);
 h.ok(await page.evaluate(()=>document.querySelector('.cm-editor .flux-slide-art')===window.__scaleSlide),'typing does not rebuild visible slide DOM');
 await page.evaluate(()=>{const v=window.__fluxView;v.dispatch({selection:{anchor:v.state.doc.line(2).from}});v.focus();});
 await page.keyboard.type('/slide',{delay:30});await waitFor(page,()=>document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionLabel')?.textContent==='/slide',null,{timeout:5000});await sleep(100);await page.keyboard.press('Enter');
 await page.waitForSelector('.slide-picker');await page.click('.slide-picker [aria-label="Evidence talk"]');await page.waitForSelector('.slide-picker [aria-label="Slide 0"]');
 h.ok(await page.$$eval('.slide-picker .card',els=>els.length<30),'1000-slide picker virtualizes cards and thumbnails');
 await page.type('.slide-picker input','Slide 99');const searchStart=Date.now();await page.type('.slide-picker input','9');await waitFor(page,()=>document.querySelectorAll('.slide-picker .card').length<=2&&!!document.querySelector('.slide-picker [aria-label="Slide 999"]'),null,{timeout:1000});h.ok(Date.now()-searchStart<100,'large-deck search responds within 100ms');
 await shot(page,'inline-slide-scale-picker');await page.keyboard.press('Escape');
 h.eq(realErrors(page),[],'scale fixture has no browser errors');console.log(JSON.stringify({initialLoadMs:load,keyToFrameMs:times}));
}catch(e){h.fail(String(e));console.error(e);await shot(page,'inline-slide-scale-failure');}await h.done(()=>browser.close());
