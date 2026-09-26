// Figure-Meta replaces the canvas caption page. Keep the content-fit contract:
// every field grows, only the fields column scrolls, and model/font/width changes
// refit without an input event. Pin/dock is covered by verify-figure-metadata.
import {launch,gotoApp,clickMode,waitFor,realErrors,shot} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-caption-fit');
const {browser,page}=await launch({width:1600,height:1000});
const LONG='A long scientific caption with several observations. '.repeat(65);
const seed=caps=>page.evaluate(caps=>{const F=window.__flux;F.fig.commit(p=>p.figures[0].captions=caps);},caps);
const measure=()=>page.evaluate(()=>{const ts=[...document.querySelectorAll('.caption-block textarea')],col=document.querySelector('.fields');return{heights:ts.map(t=>t.clientHeight),fits:ts.every(t=>t.scrollHeight<=t.clientHeight+2),hidden:ts.every(t=>getComputedStyle(t).overflowY==='hidden'),font:parseFloat(getComputedStyle(ts[0]).fontSize),overflow:col.scrollHeight>col.clientHeight,height:document.querySelector('.figure-meta').clientHeight};});
const fit=()=>waitFor(page,()=>[...document.querySelectorAll('.caption-block textarea')].every(t=>t.scrollHeight<=t.clientHeight+2));
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await clickMode(page,'Figure');
 await seed({__figure__:'Lead sentence.','el-a':'Panel a.','el-b':''});
 await page.keyboard.down('Alt');await page.keyboard.press('KeyM');await page.keyboard.up('Alt');await page.waitForSelector('.caption-block textarea');await fit();
 let m=await measure();h.eq(m.heights.length,3,'figure and both labeled panels have fields');h.ok(m.fits&&m.hidden,'short captions fit without internal scrollbars');h.ok(m.heights[2]>=38&&m.heights[2]<100,'empty block has a compact multiline floor');const initial=m.height;
 await seed({__figure__:LONG,'el-a':LONG,'el-b':'Short.'});await waitFor(page,()=>document.querySelector('textarea').value.length>2000);await fit();m=await measure();h.ok(m.overflow&&m.fits&&m.hidden,'long fields fit and the column scrolls');h.eq(m.height,initial,'long captions never enlarge the popup beyond the viewport');
 const pane=await page.$('.fields'),b=await pane.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+120);await page.mouse.wheel({deltaY:280});await waitFor(page,()=>document.querySelector('.fields').scrollTop>0);h.ok(true,'real mouse wheel scrolls the fields column');
 const sizes=await page.evaluate(()=>{const t=document.querySelectorAll('textarea')[2];t.focus();const set=v=>{t.value=v;t.dispatchEvent(new Event('input',{bubbles:true}));return t.clientHeight};const before=t.clientHeight,grown=set('A growing caption '.repeat(60)),newline=set(t.value+'\n'),shrunk=set('short');t.dispatchEvent(new Event('change',{bubbles:true}));return{before,grown,newline,shrunk};});h.ok(sizes.grown>sizes.before&&sizes.newline>sizes.grown&&sizes.shrunk<sizes.grown,'typing, trailing newline and deletion grow and shrink synchronously');
 await waitFor(page,()=>document.querySelector('.status')?.textContent.includes('Saved'));
 await seed({__figure__:LONG,'el-a':LONG,'el-b':LONG});await waitFor(page,()=>document.querySelectorAll('textarea')[2].value.length>2000);await fit();h.ok((await measure()).heights[2]>sizes.shrunk,'external model change refits without input');
 const old=(await measure()).heights[0];await page.evaluate(()=>window.__flux.settings.update(v=>({...v,captionFontSize:22})));await waitFor(page,()=>parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize)===22);await fit();m=await measure();h.ok(m.heights[0]>old&&m.fits,'caption font-size preference refits all fields');
 await page.setViewport({width:920,height:700});await fit();h.ok((await measure()).fits,'narrowing the window refits every caption');
 await seed({__figure__:'Short','el-a':'Short','el-b':'Short'});await waitFor(page,()=>document.querySelector('textarea').value==='Short');await fit();h.ok(!(await measure()).overflow,'shrinking external captions removes column overflow');
 await shot(page,'caption-fit');h.ok(!realErrors(page).length,'clean console');
}finally{await browser.close()}
await h.done();
