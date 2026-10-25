import assert from 'node:assert/strict';
import fs from 'node:fs';
import {launch,gotoApp,realErrors} from './lib/driver.mjs';
const {browser,page}=await launch();
try{
 await gotoApp(page,{url:'http://127.0.0.1:1420/?fixture=demo'});
 const svg=fs.readFileSync('scripts/fixtures/relayout/line/base.svg','utf8'),manifest=JSON.parse(fs.readFileSync('scripts/fixtures/relayout/line/base.fluxplot.json','utf8'));
 const result=await page.evaluate(async({svg,manifest})=>{
  const [{renderSlide},{computeSlideAnims,applyAt,applyStatic},{FLUX_DARK}]=await Promise.all([import('/src/lib/slide/player/render.ts'),import('/src/lib/slide/player/player.ts'),import('/src/lib/slide/theme.ts')]);
  const root=new DOMParser().parseFromString(svg,'image/svg+xml').documentElement,host=document.createElement('div');document.body.replaceChildren(host);
  const el={id:'p',type:'plot',assetId:'a',x:0,y:0,width:480,height:307.2,rotation:0};
  const slide={id:'s',elements:[el],beats:[{id:'base',tracks:[]},{id:'b',tracks:[{id:'t',target:'p',preset:'transform',duration:1000,easing:'linear',to:{state:{width:780,height:600}}}]}]};
  const ctx={theme:FLUX_DARK,plotRoot:()=>root,plotManifest:()=>manifest},stage={width:1000,height:700},rendered=renderSlide(host,slide,stage,ctx),specs=computeSlideAnims(slide,rendered,host,stage,ctx);
  const samples=[];let layers=0;for(let i=0;i<150;i++){const t=performance.now();applyAt(specs,1,(i%100)*10+1);if(i>25)samples.push(performance.now()-t);layers=Math.max(layers,host.querySelectorAll('[data-tween-ticks]').length);}
  applyAt(specs,1,500);const mid=host.querySelector('svg').getAttribute('viewBox');applyStatic(specs,1);const end=host.querySelector('svg').getAttribute('viewBox');applyStatic(specs,0);const start=host.querySelector('svg').getAttribute('viewBox');
  return {p95:samples.sort((a,b)=>a-b)[Math.floor(samples.length*.95)],layers,mid,end,start};
 },{svg,manifest});
 assert.equal(result.layers,2);assert.equal(result.start,'0 0 360 230.4');assert.equal(result.end,'0 0 585 450');assert.notEqual(result.mid,result.end);assert(result.p95<=8,`tween p95 ${result.p95} ms`);assert.deepEqual(realErrors(page),[]);console.log('##VERIFY## '+JSON.stringify({script:'verify-slide-relayout-tween',ok:true,...result}));
}finally{await browser.close();}
