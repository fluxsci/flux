// Owner feedback fbmuiz6j6bsi7p: readable/foldable captions, zoomable complete
// preview, optional closing prose, and the same controls in a pinned window.
import {launch,gotoApp,clickMode,waitFor,realErrors,shot} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
const h=harness('verify-figure-meta-refinements');
const {browser,page}=await launch({width:1500,height:980});
const mod=process.platform==='darwin'?'Meta':'Control';
const click=async(p,s)=>{const b=await p.$eval(s,e=>{e.scrollIntoView({block:'nearest'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await p.mouse.click(b.x,b.y)};
// macOS headless CDP needs the native editing command alongside Command+A.
const fill=async(p,s,value)=>{await click(p,s);await p.keyboard.down(mod);await p.keyboard.press('KeyA', process.platform === 'darwin' ? {commands:['selectAll']} : {});await p.keyboard.up(mod);await p.keyboard.type(value);await p.keyboard.press('Tab')};
const open=async()=>{await page.keyboard.down('Alt');await page.keyboard.press('KeyM');await page.keyboard.up('Alt');await page.waitForSelector('.caption-block textarea')};
const fit=async p=>{await p.waitForFunction(()=>{const v=document.querySelector('.preview-viewport'),s=document.querySelector('.preview-sheet');if(!v||!s||v.dataset.fit!=='true')return false;const a=v.getBoundingClientRect(),b=s.getBoundingClientRect();return b.width>10&&b.height>10&&b.left>=a.left-1&&b.right<=a.right+1&&b.top>=a.top-1&&b.bottom<=a.bottom+1&&v.scrollHeight<=v.clientHeight+2&&v.scrollWidth<=v.clientWidth+2;});};
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});await open();await fit(page);
 h.ok(true,'default preview fits the complete artwork and caption');
 // --- 2026-11-18 rebuild: one header, a page-proof preview, and a list you can walk ------------------
 const look=await page.evaluate(()=>{
  const meta=document.querySelector('.figure-meta'),head=meta.querySelector('header'),sheet=meta.querySelector('.preview-sheet'),cap=meta.querySelector('.caption-preview'),rgb=c=>c.match(/[\d.]+/g).slice(0,3).map(Number);
  const lum=c=>{const [r,g,b]=rgb(c);return .2126*r+.7152*g+.0722*b};
  return {headH:Math.round(head.getBoundingClientRect().height),title:head.querySelector('.title')?.textContent,ctx:head.querySelector('.ctx')?.textContent.trim(),brandWord:!!head.querySelector('.brand-word'),
   paper:lum(getComputedStyle(sheet).backgroundColor),ink:lum(getComputedStyle(cap).color),capInside:cap.getBoundingClientRect().left>=sheet.getBoundingClientRect().left&&cap.getBoundingClientRect().right<=sheet.getBoundingClientRect().right+1,
   words:meta.querySelector('.caption-toolbar .count')?.textContent,rowFont:getComputedStyle(meta.querySelector('.figure-row b')).fontFamily};});
 h.ok(look.headH===36&&look.title==='Figure-Meta'&&!look.brandWord&&look.ctx.length>0,'one 36 px header: Figure-Meta, then which figure',JSON.stringify(look));
 h.ok(look.paper>230&&look.ink<40&&look.capInside,'the preview is a page proof: paper, with the caption on it in ink',JSON.stringify({paper:look.paper,ink:look.ink}));
 h.ok(/^\d+ words?$/.test(look.words)&&/Georgia|serif/i.test(look.rowFont),'the caption’s word count is shown, and the figures are named in the serif',JSON.stringify(look.words));
 await click(page,'.add-ps');await page.waitForSelector('[aria-label="ps caption"]');
 await fill(page,'[aria-label="ps caption"]','Closing prose follows every panel.');await waitFor(page,()=>document.querySelector('.status')?.textContent.includes('Saved'));
 const disk=await page.evaluate(async()=>{const root=window.__flux.get(window.__flux.shell.projectModel).root;const idx=JSON.parse(await window.fig.readText(root+'/fig/index.json'));const c=JSON.parse(await window.fig.readText(root+'/fig/canvases/'+idx.canvases[0].id+'.json'));return{md:await window.fig.readText(root+'/fig/captions/growth.md'),ps:c.figures[0].captions.__ps__}});
 h.ok(disk.ps==='Closing prose follows every panel.'&&disk.md.trim().endsWith(disk.ps)&&!disk.md.includes('**ps**'),'cold Paper saves an unlabelled postscript in canonical and readable captions');
 await click(page,'[aria-label="Remove closing caption"]');await page.waitForFunction(()=>!document.querySelector('[aria-label="ps caption"]'));
 await click(page,'[aria-label="Undo metadata edit"]');await page.waitForSelector('[aria-label="ps caption"]');h.eq(await page.$eval('[aria-label="ps caption"]',e=>e.value),disk.ps,'removing a postscript is undoable');
 await click(page,'[aria-label="Collapse b caption"]');h.ok(!await page.$('[aria-label="b caption"]'),'clicking a panel header collapses its field');
 await click(page,'[aria-label="Expand b caption"]');await page.waitForSelector('[aria-label="b caption"]');h.ok(await page.$eval('[aria-label="b caption"]',e=>e.value.length>0),'expanding keeps the existing caption');
 const size=await page.$eval('[aria-label="Figure caption"]',e=>parseFloat(getComputedStyle(e).fontSize));await click(page,'[aria-label="Increase caption text size"]');await waitFor(page,n=>parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize)===n+1,size);
 await click(page,'[aria-label="Decrease caption text size"]');await waitFor(page,n=>parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize)===n,size);h.ok(true,'plus and minus update the actual caption typing size');
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.figure-meta'));await clickMode(page,'Figure');
 await page.evaluate(()=>window.__flux.fig.commit(p=>{p.figures[0].height=1600;p.figures[0].captions.__figure__='Tall figure caption. '.repeat(28)}));await open();await fit(page);h.ok(true,'a tall figure and long caption fit together without clipping');
 // The search walks the figures: ↓ / ↑ choose the next / previous one, Enter goes to its first field.
 await page.evaluate(()=>window.__flux.fig.commit(p=>{for(let i=0;i<40;i++)p.figures.push({...structuredClone(p.figures[0]),id:'walk-'+i,name:'Walk '+i,nickname:'walk '+i,referenceKey:'fig-walk-'+i,elements:[],captions:i%2?{__figure__:'One two three.'}:{}});}));
 await page.waitForFunction(()=>document.querySelector('.figure-list > div')?.getBoundingClientRect().height>=41*54);
 const chosen=()=>page.$eval('.figure-row.selected b',e=>e.textContent);
 const first=await chosen();await page.click('.meta-search');await page.keyboard.press('ArrowDown');await page.waitForFunction(n=>document.querySelector('.figure-row.selected b')?.textContent!==n,{},first);
 const second=await chosen();await page.keyboard.press('ArrowUp');await page.waitForFunction(n=>document.querySelector('.figure-row.selected b')?.textContent===n,{},first);
 h.ok(second!==first&&await page.evaluate(()=>document.activeElement.classList.contains('meta-search')),'↓ and ↑ in the search move through the figures and keep the caret in the search',`${first} → ${second}`);
 await page.keyboard.press('Enter');h.ok(await page.evaluate(()=>document.activeElement?.closest('.fields')&&document.activeElement.tagName==='TEXTAREA'),'Enter in the search goes to the chosen figure’s first caption');
 // A row says how much caption its figure has: a word count, or a ring when it has none.
 const marks=await page.$$eval('.figure-row',rows=>rows.filter(r=>/^Walk /.test(r.querySelector('b').textContent)).slice(0,4).map(r=>({name:r.querySelector('b').textContent,words:r.querySelector('.words').textContent,none:r.querySelector('.words').classList.contains('none')})));
 h.ok(marks.length>=2&&marks.every(m=>/[13579]$/.test(m.name)?m.words==='3'&&!m.none:m.words===''&&m.none),'each figure row shows its caption’s word count, or a ring when it has none',JSON.stringify(marks));
 // A new filter starts the list at its top (the scroll mirror alone used to reset, leaving stale rows).
 await page.$eval('.figure-list',e=>{e.scrollTop=900});await page.waitForFunction(()=>document.querySelector('.figure-list').scrollTop>800);
 await page.click('.meta-search');await page.keyboard.type('walk 1');
 await page.waitForFunction(()=>document.querySelector('.figure-list').scrollTop===0&&[...document.querySelectorAll('.figure-row b')].length>0&&[...document.querySelectorAll('.figure-row b')].every(b=>/^Walk 1/.test(b.textContent)));
 h.ok(await page.$eval('.figure-row',r=>Math.round(r.getBoundingClientRect().top-r.closest('.figure-list').getBoundingClientRect().top)===0),'filtering returns the list to its top with the matches drawn there');
 await page.$eval('.meta-search',e=>{e.value='';e.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.evaluate(()=>window.__flux.fig.commit(p=>{p.figures=p.figures.filter(f=>!f.id.startsWith('walk-'))}));
 await page.waitForFunction(()=>!document.querySelector('.figure-row.selected')||!/^Walk /.test(document.querySelector('.figure-row.selected b').textContent));
 // Leave as the next checks expect: reopened on the tall figure, its preview settled.
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.figure-meta'));await open();await fit(page);
 await page.waitForFunction(()=>document.querySelector('.art img')?.complete);
 const old=await page.$eval('.preview-viewport',e=>({scale:+e.dataset.scale,url:document.querySelector('.art img').src}));
 const v=await page.$eval('.preview-viewport',e=>{const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}});await page.mouse.move(v.x,v.y);await page.keyboard.down(mod);await page.mouse.wheel({deltaY:-300});await page.keyboard.up(mod);
 await waitFor(page,s=>Number(document.querySelector('.preview-viewport').dataset.scale)>s,old.scale);
 h.ok(await page.$eval('.preview-viewport',(e,url)=>e.dataset.fit==='false'&&document.querySelector('.art img').src===url,old.url),'Ctrl-scroll zooms immediately without regenerating the figure image');
 await page.select('[aria-label="Preview zoom"]','100');await waitFor(page,()=>+document.querySelector('.preview-viewport').dataset.scale===1);
 const offset=await page.$eval('.preview-viewport',e=>e.scrollTop);await page.mouse.move(v.x,v.y);await page.mouse.down();await page.mouse.move(v.x,v.y-70,{steps:4});await page.mouse.up();h.ok(await page.$eval('.preview-viewport',(e,old)=>e.scrollTop>old+30,offset),'zoomed artwork can be panned with a real pointer drag');
 await click(page,'[aria-label="Fit figure and caption"]');await fit(page);h.ok(true,'Fit returns from a zoomed region to the complete composition');
 await page.setViewport({width:950,height:720});await fit(page);h.ok(true,'fit recalculates on a narrower window');
 const event=new Promise(resolve=>page.once('popup',resolve));await click(page,'.pin');const popup=await event;await popup.waitForSelector('.figure-meta');await popup.setViewport({width:1040,height:780});await fit(popup);
 await click(popup,'[aria-label="Collapse a caption"]');await click(popup,'[aria-label="Increase caption text size"]');await popup.setViewport({width:850,height:640});await fit(popup);
 h.ok(!await popup.$('[aria-label="a caption"]'),'collapse, font controls and fit work while pinned');
 await click(popup,'[aria-label="Expand a caption"]');await fill(popup,'[aria-label="ps caption"]','Pinned closing prose.');await popup.waitForFunction(()=>document.querySelector('.caption-preview')?.textContent.endsWith('Pinned closing prose.'));await fit(popup);
 await shot(popup,'meta-refinements-pinned');await click(popup,'.pin');await page.bringToFront();await page.waitForSelector('.figure-meta');await fit(page);h.ok(await page.$eval('[aria-label="ps caption"]',e=>e.value==='Pinned closing prose.'),'dock retains the closing caption and refits the preview');
 await page.setViewport({width:1500,height:980});await fit(page);await shot(page,'meta-refinements');
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.figure-meta'));await open();h.eq(await page.$eval('[aria-label="Figure caption"]',e=>parseFloat(getComputedStyle(e).fontSize)),size+1,'caption size preference survives reopening');
 await page.evaluate(async()=>{const {makeText}=await import('/src/lib/ops.ts');window.__flux.fig.commit(p=>{for(let i=0;i<26;i++){const id='scale-label-'+i;p.figures[0].elements.push({...makeText('p'+i,{x:10,y:50+i*25,width:25,height:20},{},true),id});p.figures[0].captions[id]='A detailed panel observation with sample sizes and uncertainty. '.repeat(12)}})});
 await page.waitForFunction(()=>document.querySelectorAll('.caption-block textarea').length===30);await fit(page);
 await page.evaluate(()=>{window.__metaPaint=[];document.addEventListener('click',e=>{if(!e.isTrusted||!e.target.closest('.text-size button,.block-toggle,.zoom-controls button'))return;const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__metaPaint.push(performance.now()-start)))},{capture:true})});
 for(const selector of ['[aria-label="Increase caption text size"]','[aria-label="Decrease caption text size"]','[aria-label="Collapse Figure caption"]','[aria-label="Expand Figure caption"]','[aria-label="Zoom in preview"]','[aria-label="Fit figure and caption"]']){
   const n=await page.evaluate(()=>window.__metaPaint.length);await click(page,selector);await page.waitForFunction(n=>window.__metaPaint.length>n,{},n);
 }
 const paint=await page.evaluate(()=>window.__metaPaint);writeFileSync(path.join(process.env.FLUX_OUT||'test-results/out','metadata-control-paint.json'),JSON.stringify({captionBlocks:30,milliseconds:paint,max:Math.max(...paint),budget:100},null,2));h.ok(Math.max(...paint)<=100,'all six font/fold/zoom clicks paint within 100 ms with 30 caption blocks',{milliseconds:paint});
 h.ok(!realErrors(page).length,'clean console',realErrors(page));
}finally{await browser.close()}
await h.done();
