import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createDeck,addSlide,addElement,addBeat,becomeTransform,setAnimation,setTransform} from '../src/lib/slide/ops';
import {exportDeckHtml} from '../src/lib/slide/export/exportDeck';
import {harness} from './lib/harness.mjs';
import {launch} from './lib/driver.mjs';
const h=harness('verify-v020-slide-paint'),root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-gradient-'));
const {browser,page}=await launch();
try{
 const deck=createDeck({withTitleSlide:false});deck.defaults.transition='none';
 const slide=addSlide(deck,{id:'paint',layout:'blank'});
 const gradient={map:'fixture',axis:'x' as const,stops:['#ff0000','#0000ff']};
 addElement(deck,slide.id,{type:'rect',id:'source',x:90,y:80,width:200,height:120,rotation:0,fill:'none',fillMap:gradient,stroke:'#ffffff',strokeWidth:3,cornerRadius:15});
 addElement(deck,slide.id,{type:'ellipse',id:'target',x:320,y:80,width:200,height:120,rotation:0,fill:'none',fillMap:gradient,stroke:'#ffffff',strokeWidth:3});
 const beat=addBeat(deck,slide.id,{id:'morph'})!;becomeTransform(deck,slide.id,beat.id,'source','target',{duration:1000,easing:'linear'});
 (deck.slides[0].elements[0] as any).source={svgPath:'/private/microscope/source.svg',recipePath:'/private/recipe.py'};
 const draw=addSlide(deck,{id:'draw',layout:'blank'});
 addElement(deck,draw.id,{type:'path',id:'stroke',x:100,y:100,width:280,height:100,rotation:0,d:'M0 50 C70 -10 200 110 280 50',fill:'none',stroke:'#ffffff',strokeWidth:6,dash:[8,4],cap:'round',closed:false});
 const d1=addBeat(deck,draw.id,{id:'draw-on'})!;setAnimation(deck,draw.id,d1.id,{target:'stroke',preset:'drawOn',duration:800});
 const d2=addBeat(deck,draw.id,{id:'change'})!;setTransform(deck,draw.id,d2.id,'stroke',{state:{x:160,width:420,stroke:'#00ff00'},duration:1000,easing:'linear'});
 const holes=addSlide(deck,{id:'holes',layout:'blank'});
 deck.assets.push({id:'hole-art',kind:'svg',path:'assets/hole.svg',naturalWidth:200,naturalHeight:200});
 addElement(deck,holes.id,{id:'hole',type:'plot',assetId:'hole-art',x:100,y:100,width:200,height:200,rotation:0});
 const hb=addBeat(deck,holes.id,{id:'hole-change'})!;setTransform(deck,holes.id,hb.id,'hole',{state:{x:300,width:300,height:300},duration:1000,easing:'linear'});
 const holeSvg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs><linearGradient id="ring"><stop stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><path id="ring-shape" fill="url(#ring)" fill-rule="evenodd" d="M0 0H200V200H0Z M60 60H140V140H60Z"/></svg>';
 const html=(await exportDeckHtml({deck,plots:{'hole-art':{svg:holeSvg,manifest:{specVersion:'1.0.0',plotType:'custom',size:{width:200,height:200},parts:[]} as any}}})).html;
 h.ok(!html.includes('/private/'),'direct portable exporter removes authoring provenance even without gather adapter');
 const file=path.join(root,'gradient.html');await fs.writeFile(file,html);await page.goto(pathToFileURL(file).href);await page.waitForFunction('!!window.fluxDeck?.seek');
 const seek=async(ms:number)=>{await page.evaluate(t=>(window as any).fluxDeck.seek(0,1,t),ms);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));};
 await seek(500);
 const definition=await page.evaluate(()=>{const el=document.querySelector('[data-el-id="source"]')!;const paths=[...el.querySelectorAll('path')];return paths.some(p=>p.getAttribute('fill')?.startsWith('url('))&&el.querySelectorAll('linearGradient stop').length>=2;});
 h.ok(definition,'gradient-only destination paints the intermediate outline with real gradient definitions');
 for(const t of [0,250,500,750,1000]) {
  await seek(t);
  const shot=await (await page.$('[data-el-id="source"]'))!.screenshot();
  await fs.mkdir(process.env.FLUX_OUT??'test-results/out',{recursive:true});await fs.writeFile(path.join(process.env.FLUX_OUT??'test-results/out',`v020-gradient-${t}.png`),shot);
  const paint=await page.evaluate(()=>{const el=document.querySelector('[data-el-id="source"]')!;return [...el.querySelectorAll('rect,ellipse,path')].some(p=>p.getAttribute('fill')?.startsWith('url('));});
  h.ok(paint,`gradient is painted at t=${t/1000}, including exact rounded source/destination`);
 }
 await seek(500);
 const element=await page.$('[data-el-id="source"]');const first=Buffer.from(await element!.screenshot());
 await seek(1000);await seek(0);await seek(500);const repeated=Buffer.from(await element!.screenshot());
 h.ok(first.equals(repeated),'rendered gradient pixels at the same time are history independent after endpoint and reverse seeks');
 const pixels=await page.evaluate(async b64=>{const image=await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], {type:'image/png'}));const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d')!;ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let red=0,blue=0;for(let i=0;i<data.length;i+=4){if(data[i]>data[i+2]*1.5&&data[i]>80)red++;if(data[i+2]>data[i]*1.5&&data[i+2]>80)blue++;}return{red,blue};},first.toString('base64'));
 h.ok(pixels.red>100&&pixels.blue>100,`captured pixels contain both gradient ends (${pixels.red} red / ${pixels.blue} blue)`);
 // Real browser geometry and style: compare arbitrary/reverse histories to
 // independent freshly constructed players, including the actual dash length.
 const inspect=async(p:any,beat:number,time:number)=>{
  await p.bringToFront();
  await p.evaluate((b:number,t:number)=>(window as any).fluxDeck.seek(1,b,t),beat,time);
  await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  return p.evaluate(()=>{const el=document.querySelector('[data-el-id="stroke"]')!,p=el.querySelector('path')!,css=getComputedStyle(p);return{length:p.getTotalLength(),dash:css.strokeDasharray,offset:css.strokeDashoffset,cap:css.strokeLinecap,d:p.getAttribute('d'),transform:el.getAttribute('style'),stroke:css.stroke};});
 };
 const fresh=await browser.newPage();await fresh.goto(pathToFileURL(file).href);await fresh.waitForFunction('!!window.fluxDeck?.seek');
 for(const [b,t]of [[1,400],[2,0],[2,250],[2,500],[2,750],[2,1000],[1,200],[2,500]]) {
  const current=await inspect(page,b,t);await fresh.reload();await fresh.waitForFunction('!!window.fluxDeck?.seek');const clean=await inspect(fresh,b,t);
  h.eq(current,clean,`real getTotalLength/dash/cap/geometry match fresh seek beat${b} t${t}`);
  h.ok(current.length>280,'browser measures curved length rather than linkedom fallback1');
  if(b===2)h.ok(current.dash==='8px, 4px'&&current.cap==='round',`completed DrawOn restores authored dash/cap throughout Change t${t}`);
 }
 await fresh.close();
 for(const t of [0,250,500,750,1000]){
  await page.bringToFront();await page.evaluate(time=>(window as any).fluxDeck.seek(2,1,time),t);
  const hollow=await page.evaluate(()=>{const p=document.querySelector('[data-el-id="hole"] path') as SVGGeometryElement;return{center:p.isPointInFill(new DOMPoint(100,100)),ring:p.isPointInFill(new DOMPoint(30,100))};});
  h.ok(!hollow.center&&hollow.ring,`compound SVG hole and gradient ring retain exact topology at t=${t/1000}`);
  await (await page.$('[data-el-id="hole"]'))!.screenshot({path:path.join(process.env.FLUX_OUT??'test-results/out',`v020-hole-${t}.png`)});
 }

 const out=process.env.FLUX_OUT??'test-results/out';await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'v020-gradient-mid.png'),first);await fs.writeFile(path.join(out,'v020-gradient.html'),html);
}finally{await browser.close();await fs.rm(root,{recursive:true,force:true});}
await h.done();
