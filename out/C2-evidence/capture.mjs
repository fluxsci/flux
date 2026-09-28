import fs from 'node:fs/promises';
import {launch,gotoApp,APP_URL,realErrors} from '/home/driessen2/flux/.claude/worktrees/av2-C2/scripts/lib/driver.mjs';
const out='/home/driessen2/flux/.claude/worktrees/av2-C2/out/shots/C2';
await fs.mkdir(out,{recursive:true});
const plots={};
for(const [id,name] of [['box','mpl_boxplot'],['sine','mpl_sine_waves']]) plots[id]={svg:await fs.readFile(`scripts/fixtures/plots/${name}_FLUXPLOT.svg`,'utf8'),manifest:JSON.parse(await fs.readFile(`scripts/fixtures/plots/${name}_FLUXPLOT.fluxplot.json`,'utf8'))};
const {browser,page}=await launch();
try{
 await gotoApp(page,{url:APP_URL+'?fixture=demo'});
 await page.evaluate(async plots=>{
  const [{createDeck,addSlide,addElement,addBeat,becomeTransform},{compileSlide},{preparePlot},{createPlayer}]=await Promise.all([import('/src/lib/slide/ops.ts'),import('/src/lib/slide/compile.ts'),import('/src/lib/plot/parse.ts'),import('/src/lib/slide/player/player.ts')]);
  const points=Array.from({length:100},(_,i)=>({index:i,svgId:`samples.point.${i}`,x:i/20,y:20+12*Math.sin(i)}));
  plots.large={svg:`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><g id="samples.points" fill="#4169e1">${points.map(p=>`<g id="${p.svgId}" data-flux-glyph="1" transform="translate(${p.x*36} ${p.y})"><circle r="2"/></g>`).join('')}</g></svg>`,manifest:{spec:'fluxplot',schemaVersion:'0.2.0',size:{width:200,height:100,unit:'px'},axes:[{x:{scale:'linear',domain:[0,5],anchors:[{data:0,svg:0},{data:5,svg:180}]},y:{scale:'linear',domain:[0,100],anchors:[{data:0,svg:0},{data:100,svg:100}]}}],series:[{id:'samples',roles:['point'],svg:{points:'samples.points'},points}]}};
  const roots=Object.fromEntries(Object.entries(plots).map(([id,p])=>[id,preparePlot(p.svg,p.manifest)]));
  const deck=createDeck({withTitleSlide:false});deck.stage={width:960,height:540};deck.defaults.transition='none';
  const plot=(id,assetId,x,extra={})=>({id,type:'plot',assetId,x,y:150,width:360,height:216,rotation:0,...extra});
  const a=addSlide(deck,{id:'axes',layout:'blank'});addElement(deck,a.id,{id:'source',type:'path',x:40,y:100,width:180,height:120,rotation:0,d:'M0 120 L90 0 L180 120',nodes:[{x:0,y:120,type:'corner'},{x:90,y:0,type:'corner'},{x:180,y:120,type:'corner'}],closed:false,fill:'none',stroke:'#4169e1',strokeWidth:4});addElement(deck,a.id,plot('dest','box',480));
  let beat=addBeat(deck,a.id,{id:'flight'});becomeTransform(deck,a.id,beat.id,'source',{element:'dest',parts:['axis.x.spine','axis.y.spine']},{mode:'handoff',duration:1000,easing:'linear',compiled:compileSlide(a,deck.stage,{plotManifest:id=>roots[id]?.manifest})});
  const b=addSlide(deck,{id:'glyphs',layout:'blank'});addElement(deck,b.id,plot('source','large',30,{width:200,height:100}));addElement(deck,b.id,plot('dest','sine',520,{height:108}));
  beat=addBeat(deck,b.id,{id:'glyph-flight'});becomeTransform(deck,b.id,beat.id,{element:'source',parts:['samples.points']},{element:'dest',parts:['2hz.line']},{mode:'handoff',pair:'data',duration:1000,easing:'linear',compiled:compileSlide(b,deck.stage,{plotManifest:id=>roots[id]?.manifest})});
  const host=document.createElement('div');host.id='c2-qa-stage';host.style.cssText='position:fixed;left:20px;top:50px;width:960px;height:540px;background:#fff;z-index:999999;overflow:hidden';const outer=document.createElement('div');outer.style.cssText=host.style.cssText;host.style.cssText='width:960px;height:540px';outer.appendChild(host);document.body.appendChild(outer);
  const label=document.createElement('div');label.id='c2-qa-label';label.style.cssText='position:fixed;left:20px;top:18px;z-index:999999;color:white;background:#172030;padding:5px 12px;font:14px sans-serif';document.body.appendChild(label);
  window.c2player=createPlayer(host,deck,{theme:deck.theme,plotRoot:id=>roots[id]?.root,plotManifest:id=>roots[id]?.manifest});
 },plots);
 const evidence=[];
 for(const [name,slide,time,label] of [['01-spines-midflight',0,500,'Spine hand-off · 50% · source and destination hidden'],['02-spines-reveal',0,1000,'Spine hand-off · landed · original spines revealed'],['03-glyphs-midflight',1,500,'100-marker hand-off · 50% · glyph driver']]){
  await page.evaluate(({slide,time,label})=>{window.c2player.seek(slide,1,time);document.querySelector('#c2-qa-label').textContent=label;},{slide,time,label});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const state=await page.evaluate(()=>{const host=document.querySelector('#c2-qa-stage'),flight=host.querySelector('.sl-flight');return {source:getComputedStyle(host.querySelector('[data-el-id="source"]')).visibility,spines:[...host.querySelectorAll('[id="dest__axis.x.spine"],[id="dest__axis.y.spine"]')].map(n=>getComputedStyle(n).visibility),curve:host.querySelector('[id="dest__2hz.line"]')?getComputedStyle(host.querySelector('[id="dest__2hz.line"]')).visibility:null,sourceParts:[...host.querySelectorAll('[id^="source__samples.point."]')].map(n=>getComputedStyle(n).visibility),paths:[...flight.querySelectorAll('.sl-handoff-path')].filter(n=>getComputedStyle(n).visibility==='visible').length,glyphs:flight.querySelectorAll('.sl-handoff-glyph').length,lastChild:flight.parentElement.lastElementChild===flight};});
  if(slide===0&&time===500&&!(state.source==='hidden'&&state.spines.every(v=>v==='hidden')&&state.paths===1))throw Error(JSON.stringify(state));
  if(slide===0&&time===1000&&!(state.source==='hidden'&&state.spines.every(v=>v==='visible')&&state.paths===0))throw Error(JSON.stringify(state));
  if(slide===1&&!(state.glyphs===100&&state.paths===0&&state.curve==='hidden'&&state.sourceParts.every(v=>v==='hidden')))throw Error(JSON.stringify(state));
  await page.screenshot({path:`${out}/${name}.png`});evidence.push({name,slide,time,...state});
 }
 if(realErrors(page).length)throw Error(JSON.stringify(realErrors(page)));
 await fs.writeFile(`${out}/states.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();}
