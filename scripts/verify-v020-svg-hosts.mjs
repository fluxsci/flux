// Actual browser hosts for the passive scientific SVG contract. The sole
// network probe binds loopback; no third-party URL is ever contacted.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {launch, gotoApp, clickMode, waitFor, waitForFrame, APP_URL, OUT} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';

const h=harness('verify-v020-svg-hosts'), requests=[], blocked=[], evidence={};
const recorder=createServer((req,res)=>{requests.push(req.url);res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');});
await new Promise(resolve=>recorder.listen(0,'127.0.0.1',resolve));
const probe=`http://127.0.0.1:${recorder.address().port}`;
await fetch(probe+'/calibration');assert.deepEqual(requests,['/calibration']);requests.length=0;
const scratch=await mkdtemp(join(tmpdir(),'flux-svg-hosts-'));
await mkdir(OUT,{recursive:true});
const {browser,page}=await launch({width:1450,height:950});
const appOrigin=new URL(APP_URL).origin;
async function guard(p){
  await p.evaluateOnNewDocument(()=>{window.__svgUnsafe=0;});
  await p.setRequestInterception(true);
  p.on('request',r=>{const u=r.url();if(/^https?:/.test(u)&&!u.startsWith(appOrigin+'/')&&!u.startsWith(probe+'/')){blocked.push(u);void r.abort();}else void r.continue();});
}
await guard(page);
const manifest={spec:'fluxplot',schemaVersion:'1.0',plotType:'svg',svg:'source.svg',size:{width:200,height:120,unit:'px'},axes:[],series:[]};
const colors=['#009933','#cc0099'];
function source(color){return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="120" viewBox="0 0 200 120" onload="window.__svgUnsafe=(window.__svgUnsafe||0)+1">
<style>@import url('${probe}/import');:root{color:${color}}.ink{fill:currentColor}.shade{fill:url(#ramp)}.unsafe{fill:u\\72l('${probe}/escaped-css')}</style>
<defs><linearGradient id="ramp"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#ffdd00"/></linearGradient><clipPath id="clip"><rect width="180" height="100" x="10" y="10"/></clipPath><path id="symbol" d="M0 0h20v15H0Z"/><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><path d="M0 0L10 5L0 10Z" fill="${color}"/></marker></defs>
<rect width="200" height="120" fill="white"/><g clip-path="url(#clip)"><rect id="ink" class="ink" x="10" y="10" width="65" height="85"/><rect class="shade" x="90" y="10" width="90" height="85"/></g><use xlink:href="#symbol" x="10" y="100" fill="${color}"/><path d="M90 105H165" stroke="${color}" stroke-width="3" marker-end="url(#arrow)"/>
<script>window.__svgUnsafe=(window.__svgUnsafe||0)+1;fetch('${probe}/script')</script><a href="javascript:window.__svgUnsafe++"><rect x="195" width="1" height="1" onclick="window.__svgUnsafe++"/></a><image href="${probe}/image" width="1" height="1"/><foreignObject width="2" height="2"><img xmlns="http://www.w3.org/1999/xhtml" src="${probe}/foreign" onerror="window.__svgUnsafe++"/></foreignObject><animate attributeName="opacity" from="1" to="0" dur="1s" onbegin="window.__svgUnsafe++"/><image href="data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgUnsafe++"/>').toString('base64')}" width="1" height="1"/></svg>`;}
const sources=colors.map(source);
const figure={id:'passive-figure',canvasId:'passive-canvas',name:'Figure 1',nickname:'Passive SVG host acceptance',family:'figure',number:1,background:'transparent',x:0,y:0,width:430,height:140,elements:sources.map((_,i)=>({id:`passive-plot-${i}`,type:'plot',assetId:`passive-asset-${i}`,x:10+i*210,y:10,width:200,height:120,rotation:0,overrides:{}}))};
const snapshot={figure,sources,manifest};
async function pixels(p,selector,name){
  const node=await p.$(selector);assert.ok(node,`${name} rendered host exists`);
  await node.evaluate(n=>n.scrollIntoView({block:'center',inline:'center'}));await waitForFrame(p);
  const png=Buffer.from(await node.screenshot());await writeFile(join(OUT,`v020-svg-${name}.png`),png);
  const result=await p.evaluate(async base64=>{const im=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'}));const c=new OffscreenCanvas(im.width,im.height);const ctx=c.getContext('2d');ctx.drawImage(im,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let green=0,magenta=0;for(let i=0;i<d.length;i+=4){if(d[i+1]>100&&d[i+1]>d[i]*1.6&&d[i+1]>d[i+2]*1.6)green++;if(d[i]>100&&d[i+2]>80&&d[i+1]<50)magenta++;}return{width:im.width,height:im.height,green,magenta}},png.toString('base64'));
  evidence[name]=result;return result;
}
async function twoPaints(p,selector,name){
  const q=await pixels(p,selector,name);h.ok(q.green>300&&q.magenta>300,`${name}: two independently scoped :root/currentColor paints, gradients and local references survive (${q.green}/${q.magenta} pixels)`);
  const glyphs=await p.evaluate(()=>[...document.querySelectorAll('[data-flux-glyph]')].filter(n=>n.closest('[data-plot-scope]')?.getAttribute('data-plot-scope')?.includes('passive-plot-')).map(n=>getComputedStyle(n).fill));
  q.glyphs=glyphs;h.ok(glyphs.includes('rgb(0, 153, 51)')&&glyphs.includes('rgb(204, 0, 153)'),`${name}: expanded local-use glyph retains the use element's authored paint (${glyphs.join(', ')})`);
  const roots=await p.evaluate(()=>[...document.querySelectorAll('.ink')].filter(n=>n.closest('[data-plot-scope]')?.getAttribute('data-plot-scope')?.includes('passive-plot-')).map(n=>getComputedStyle(n).fill));
  q.roots=roots;h.ok(roots.includes('rgb(0, 153, 51)')&&roots.includes('rgb(204, 0, 153)'),`${name}: :root color inheritance stays local to each SVG placement (${roots.join(', ')})`);
}
async function inert(p,name){
  const unsafe=await p.evaluate(()=>window.__svgUnsafe??0);h.eq(unsafe,0,`${name}: scripts and event handlers remain inert`);
  h.eq(requests.length,0,`${name}: no loopback resource request`);
}
function inspectSerialized(text,name){
  h.ok(!/<(?:script|foreignObject|animate)\b|\son(?:load|click|error|begin)=|javascript:|data:image\/svg\+xml/i.test(text),`${name}: saved SVG contains no active construct`);
  h.ok(!text.includes(probe),`${name}: saved SVG contains no external-resource URL`);
  h.ok(/linearGradient/.test(text)&&/clipPath/.test(text)&&/(?:href="#|data-flux-glyph="1")/.test(text),`${name}: saved SVG retains gradient, clip and local use definitions`);
}
try{
  await gotoApp(page,{url:new URL('?fixture=demo',APP_URL).href,settle:400});await clickMode(page,'Figure',{settle:300});
  await page.evaluate(({figure,sources,manifest})=>{const F=window.__flux,s=F.fig;sources.forEach((svg,i)=>F.io.reimportPlot(`passive-asset-${i}`,svg,manifest));s.commit(p=>{p.figures.push(figure);p.assets.push(...sources.map((_,i)=>({id:`passive-asset-${i}`,name:'source.svg',kind:'svg',path:`assets/passive-asset-${i}.svg`,naturalWidth:200,naturalHeight:120})));p.canvases.push({id:figure.canvasId,name:'Passive SVG',width:800,height:500});s.activeCanvasId.set(figure.canvasId);s.activeFigureId.set(figure.id)});s.clearSelection();s.viewport.set({panX:50,panY:70,zoom:1});},snapshot);
  await waitFor(page,()=>document.querySelectorAll('.scene [data-editor-element-id^="passive-plot-"] svg').length>=2);
  await twoPaints(page,'.scene .figure-bg','figure-live');await inert(page,'Figure live DOM');
  const live=await page.evaluate(()=>{const nodes=[...document.querySelectorAll('.scene [data-editor-element-id^="passive-plot-"] svg')];return{active:nodes.some(n=>n.querySelector('script,foreignObject,animate,[onload],[onclick]')),ids:nodes.flatMap(n=>[...n.querySelectorAll('[id]')].map(x=>x.id))}});
  h.ok(!live.active&&new Set(live.ids).size===live.ids.length,'live Figure has passive nodes and disjoint IDs across the two plots');
  const svg=await page.evaluate(()=>window.__flux.io.buildFigureSvg(window.__flux.figures().find(f=>f.id==='passive-figure')));
  await writeFile(join(OUT,'v020-svg-standalone.svg'),svg);inspectSerialized(await readFile(join(OUT,'v020-svg-standalone.svg'),'utf8'),'Standalone artifact');
  const standalone=await browser.newPage();await guard(standalone);await standalone.goto(pathToFileURL(resolve(OUT,'v020-svg-standalone.svg')).href);await twoPaints(standalone,'svg','standalone');await inert(standalone,'Standalone SVG');await standalone.close();

  // Raw gallery SVG is an image-context blob, including in its actual detached
  // popup. This host deliberately retains original scientific source bytes.
  await page.evaluate(async sources=>{for(let i=0;i<sources.length;i++)await window.fig.writeText(`/demo/myc-growth-paper/plots/passive-host-${i}.svg`,sources[i]);},sources);
  await page.keyboard.down('Alt');await page.keyboard.press('KeyG');await page.keyboard.up('Alt');await page.waitForSelector('.importer');
  const popupEvent=new Promise(resolve=>page.once('popup',resolve));await page.click('.pinbtn');const gallery=await popupEvent;await guard(gallery);await gallery.waitForSelector('.detached .importer');await gallery.bringToFront();
  await gallery.$eval('.search-in',n=>{n.value='passive-host';n.dispatchEvent(new Event('input',{bubbles:true}))});
  const modifier=process.platform==='darwin'?'Meta':'Control';
  for(let i=0;i<2;i++){
    const row=`.row[data-path="/demo/myc-growth-paper/plots/passive-host-${i}.svg"]`;await gallery.waitForSelector(row);
    const point=await gallery.$eval(row,n=>{n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
    await gallery.keyboard.down(modifier);await gallery.mouse.click(point.x,point.y);await gallery.keyboard.up(modifier);
    await waitFor(gallery,()=>!!document.querySelector('[aria-label="Expanded plot preview"] img')?.naturalWidth,null,{timeout:10000});
    const paint=await pixels(gallery,'[aria-label="Expanded plot preview"] img',`gallery-${i}`);h.ok(paint[i?'magenta':'green']>300,`detached gallery ${i}: image-context original SVG paints its local CSS and references`);await inert(gallery,`Detached gallery ${i}`);await inert(page,'Detached gallery opener');await gallery.keyboard.press('Escape');
  }
  await gallery.close();await page.bringToFront();

  // Actual mounted Paper preview and its exact portable HTML render.
  await clickMode(page,'Paper',{settle:400});await page.waitForSelector('.paper[data-paper-sources-ready="true"]');await waitFor(page,()=>!!window.__fluxView);
  const paperHtml=await page.evaluate(async({figure,sources})=>{const data=Object.fromEntries(sources.map((s,i)=>[`passive-asset-${i}`,`data:image/svg+xml;base64,${btoa(s)}`]));const ref={id:figure.id,label:'fig-passive-figure',name:figure.name,family:'figure',number:1,display:'Fig. 1',captionLabel:'Figure 1 | ',order:1,canvas:figure.canvasId,caption:'Passive scientific SVG',panels:[]};window.__fluxSeedFigures([ref],{[figure.id]:figure},data,[],{},[],[]);const text='# Passive SVG\n\n![](../fig/renders/passive-figure.svg){#fig-passive-figure}\n';window.__fluxView.dispatch({changes:{from:0,to:window.__fluxView.state.doc.length,insert:text}});const {renderManuscript}=await import('/src/shell/modes/paper/render/renderManuscript.ts');return(await renderManuscript(text)).full;},snapshot);
  await page.keyboard.down(modifier);await page.keyboard.down('Shift');await page.keyboard.press('KeyE');await page.keyboard.up('Shift');await page.keyboard.up(modifier);
  const iframe=await page.waitForSelector('iframe[title="Manuscript preview"]');const preview=await iframe.contentFrame();await preview.waitForSelector('figure svg');await twoPaints(preview,'figure','paper-preview');await inert(preview,'Paper preview');await inert(page,'Paper preview parent');
  await writeFile(join(OUT,'v020-svg-paper.html'),paperHtml);h.ok(!paperHtml.includes(probe)&&!paperHtml.includes('window.__svgUnsafe'),'portable Paper bytes contain no malicious source payload');
  const portable=await browser.newPage();await guard(portable);await portable.goto(pathToFileURL(resolve(OUT,'v020-svg-paper.html')).href);await portable.waitForSelector('figure svg');await twoPaints(portable,'figure','paper-portable');await inert(portable,'Portable Paper HTML');await portable.close();

  // Build the real offline Slide document through the shared Node exporter.
  const payloadPath=join(scratch,'fixture.json');await writeFile(payloadPath,JSON.stringify(snapshot));
  const code=`import fs from 'node:fs/promises';import {createDeck,addSlide,addElement} from ${JSON.stringify(pathToFileURL(resolve('src/lib/slide/ops.ts')).href)};import {exportDeckHtml} from ${JSON.stringify(pathToFileURL(resolve('src/lib/slide/export/exportDeck.ts')).href)};const {figure,sources,manifest}=JSON.parse(await fs.readFile(${JSON.stringify(payloadPath)},'utf8'));const deck=createDeck({withTitleSlide:false,stage:{width:430,height:140}});const slide=addSlide(deck,{id:'passive-slide',layout:'blank'});for(const element of figure.elements)addElement(deck,slide.id,element);const plots=Object.fromEntries(sources.map((svg,i)=>['passive-asset-'+i,{svg,manifest}]));await fs.writeFile(${JSON.stringify(resolve(OUT,'v020-svg-slide.html'))},(await exportDeckHtml({deck,plots})).html);`;
  const built=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{encoding:'utf8',timeout:120000});assert.equal(built.status,0,built.stderr||built.stdout);
  const slidePage=await browser.newPage();await guard(slidePage);await slidePage.goto(pathToFileURL(resolve(OUT,'v020-svg-slide.html')).href);await waitFor(slidePage,()=>!!window.fluxDeck?.seek);await twoPaints(slidePage,'#flux-stage','slide-portable');await inert(slidePage,'Portable Slide HTML');
  const slideDom=await slidePage.evaluate(()=>({bad:document.querySelectorAll('[data-el-id] script,[data-el-id] foreignObject,[data-el-id] animate,[data-el-id] [onload]').length,ids:[...document.querySelectorAll('[data-el-id] [id]')].map(n=>n.id)}));h.ok(slideDom.bad===0&&new Set(slideDom.ids).size===slideDom.ids.length,'portable Slide real DOM strips active content and isolates local identifiers');await slidePage.close();
  h.eq(blocked,[],'all hosts stay offline; no attempted third-party request');h.eq(requests,[],'armed loopback recorder observed no corpus request in any host');
  evidence.requests=requests;evidence.blocked=blocked;await writeFile(join(OUT,'v020-svg-hosts.json'),JSON.stringify(evidence,null,2));
}catch(error){h.fail(error.stack??String(error));}finally{await browser.close();await rm(scratch,{recursive:true,force:true});await new Promise(resolve=>recorder.close(resolve));}
await h.done();
