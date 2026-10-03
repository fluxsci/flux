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
