// Disposable manual-testing fixture. Refuses to overwrite an existing project.
// npx tsx scripts/create-overhaul-playground.ts [new-directory]
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as op from '../src/lib/slide/ops';
import { buildScaffoldTree } from '../src/lib/project/scaffoldTree';
import { applyAutoAnimation } from '../src/lib/slide/autobuild';
const root=path.resolve(process.argv[2] ?? 'test-results/figures-slides-playground');
const repo=path.resolve(import.meta.dirname,'..');
try { await fs.access(path.join(root,'project.json')); throw new Error('Refusing overwrite of existing scratch project'); } catch(e) { if(e.code!=='ENOENT') throw e; }
const deck=op.createDeck({id:'animation-review',title:'Figures & slides playground',theme:'flux-light',withTitleSlide:false});
deck.background='#fffcf5'; deck.defaults.transition='none';
const title=(sid,text)=>op.addSlideText(deck,sid,{text,x:30,y:20,width:580,height:36,fontSize:23,color:'#242424'});
const note=(sid,text)=>op.addSlideText(deck,sid,{text,x:30,y:320,width:580,height:24,fontSize:11,color:'#777777'});
const beat=(sid,label)=>op.addBeat(deck,sid,{label}).id;
const rect=(sid,id,x,y,fill)=>op.addElement(deck,sid,{id,type:'rect',x,y,width:100,height:90,rotation:0,fill,stroke:'#222222',strokeWidth:1});
const s1=op.addSlide(deck,{id:'reveal-exit',name:'1 · Reveal, leave, re-enter',layout:'blank'}).id;
title(s1,'Reveal → leave → re-enter');
rect(s1,'reveal-box',90,130,'#4385be'); rect(s1,'reveal-peer',340,130,'#d14d41');
op.setAnimation(deck,s1,beat(s1,'Blue enters'),{target:'reveal-box',preset:'fadeRise',duration:900});
op.setAnimation(deck,s1,beat(s1,'Red enters'),{target:'reveal-peer',preset:'drawOn',duration:900});
op.setAnimation(deck,s1,beat(s1,'Blue leaves'),{target:'reveal-box',preset:'fadeOut',duration:900});
op.setAnimation(deck,s1,beat(s1,'Blue returns'),{target:'reveal-box',preset:'popIn',duration:900});
note(s1,'At Start both boxes should be hidden. At “Blue leaves”, only red remains.');

const assetFiles=[];
const scatterSvg=await fs.readFile(path.join(repo,'scripts/fixtures/pre-regen/06_scatter_regression.svg'),'utf8');
const scatterMan=JSON.parse(await fs.readFile(path.join(repo,'scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json'),'utf8'));
function asset(id,svg,manifest,w=480,h=320) { deck.assets.push({id,name:id,kind:'svg',path:`assets/${id}.svg`,naturalWidth:w,naturalHeight:h}); assetFiles.push([`slides/${deck.id}/assets/${id}.svg`,svg],[`slides/${deck.id}/assets/${id}.fluxplot.json`,JSON.stringify(manifest,null,2)]); }
asset('audit-scatter',scatterSvg,scatterMan);
const s2=op.addSlide(deck,{name:'2 · Semantic scatter build',layout:'blank'}).id;
title(s2,'Semantic scatter: build the argument');
const p2=op.addPlotToSlide(deck,s2,{assetId:'audit-scatter',x:60,y:70,width:515,height:235});
applyAutoAnimation(deck,s2,p2,scatterMan);
note(s2,'Auto-animate: axes → grid → data → legend. Inspect timing and target selection.');

const axis=(domain,svg)=>({scale:'linear',domain,anchors:[{data:domain[0],svg:svg[0]},{data:domain[1],svg:svg[1]}]});
for(const [id,ys] of [['data-a',[2,3,5,4]],['data-b',[8,7,5,6]],['data-c',[4,6,3,8]]]) {
 const xs=[1,2,3,4], pts=xs.map((x,i)=>({index:i,svgId:`signal.point.${i}`,x,y:ys[i]}));
 const d=xs.map((x,i)=>`${i?'L':'M'}${40+x*80} ${270-ys[i]*24}`).join(' ');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#fffdf8"/><g id="axis.x.spine"><path d="M40 270H440" stroke="#222" fill="none"/></g><g id="axis.y.spine"><path d="M40 30V270" stroke="#222" fill="none"/></g><g id="signal.line"><path d="${d}" stroke="#4385be" stroke-width="3" fill="none"/></g>${pts.map(p=>`<circle id="${p.svgId}" data-x="${p.x}" data-y="${p.y}" cx="${40+p.x*80}" cy="${270-p.y*24}" r="5" fill="#4385be"/>`).join('')}<text x="225" y="306" font-size="14">Time</text><text x="10" y="20" font-size="14">Response</text></svg>`;
 const man={spec:'fluxplot',schemaVersion:'0.2.0',plotType:'line',svg:`${id}.svg`,size:{width:480,height:320,unit:'px'},axes:[{x:axis([0,5],[40,440]),y:axis([0,10],[270,30])}],series:[{id:'signal',svg:{line:'signal.line'},points:pts}],parts:{id:'figure',role:'figure',children:[{id:'axis.x.spine',role:'spine'},{id:'axis.y.spine',role:'spine'},{id:'signal.line',role:'line'},{id:'signal.points',role:'group',groupRole:'point',members:pts.map(p=>p.svgId)}]}};
 asset(id,svg,man);
}
const s3=op.addSlide(deck,{name:'3 · Chained data morph A → B → C',layout:'blank'}).id;
title(s3,'Data morph chain: A → B → C');
const p3=op.addPlotToSlide(deck,s3,{assetId:'data-a',x:100,y:65,width:420,height:250});
op.setTransform(deck,s3,beat(s3,'A to B'),p3,{toAssetId:'data-b',duration:1800,easing:'linear'});
op.setTransform(deck,s3,beat(s3,'B to C'),p3,{toAssetId:'data-c',duration:1800,easing:'linear'});
note(s3,'Second morph should start at B, never jump back to A. Canvas should show current data.');

const s4=op.addSlide(deck,{name:'4 · Transform chain + camera',layout:'blank'}).id;
title(s4,'Move, reshape, recolor, then focus');
rect(s4,'move-box',65,150,'#4385be');
const t4=op.addSlideText(deck,s4,{text:'Signal before treatment',x:290,y:120,width:280,height:70,fontSize:24,color:'#242424'});
op.setTransform(deck,s4,beat(s4,'Move and recolor'),'move-box',{state:{x:200,y:130,width:180,fill:'#d14d41',rotation:18},duration:1600});
const b4=beat(s4,'Change message and focus');
op.setTransform(deck,s4,b4,t4,{state:{text:'Signal after treatment',x:305,y:225,fontSize:19},duration:1400});
op.setAnimation(deck,s4,b4,{target:'@camera',preset:'camera',to:{x:325,y:175,zoom:1.4},duration:1400,easing:'smooth'});
op.setTransform(deck,s4,beat(s4,'Return'),'move-box',{state:{x:70,y:150,width:100,rotation:0,fill:'#4385be'},duration:1400});
note(s4,'Edit t1/t2; preview; reverse beats; compare camera and text between editor/presenter.');

const s5=op.addSlide(deck,{name:'5 · Concurrent appearance + transform',layout:'blank'}).id;
title(s5,'Concurrent motion and appearance');
rect(s5,'overlap-box',60,140,'#4385be');
const b5=beat(s5,'Rise and travel');
op.setTransform(deck,s5,b5,'overlap-box',{state:{x:440,y:170,rotation:55},duration:1800,easing:'enter'});
op.setAnimation(deck,s5,b5,{target:'overlap-box',preset:'fadeRise',start:500,duration:800,easing:'enter'});
note(s5,'Rise + transform coexist; should retain travel, rotation, opacity and correct delayed start.');

for(const slide of deck.slides){
  for(const el of slide.elements)if(el.type==='plot')el.source={svgPath:`plots/${el.assetId}.svg`};
  for(const step of slide.beats)for(const track of step.tracks)if(track.to?.assetId)track.to.svgPath=`plots/${track.to.assetId}.svg`;
}
const tree=buildScaffoldTree({title:'Flux figures & slides playground'},deck);
for(const d of tree.dirs) await fs.mkdir(path.join(root,d),{recursive:true});
for(const [rel,text] of [...tree.files,...assetFiles]) await fs.writeFile(path.join(root,rel),text);

// Seed recognizable figures and live manuscript references alongside the deck.
const { planFigSave, executeFigSave } = await import('../src/lib/project/figfiles');
const { makeText } = await import('../src/lib/ops');
const { reindex } = await import('../flux-core/model');
const project:any={version:2,name:'Figure playground',palette:['#4385be','#d14d41'],canvases:[{id:'experiments',name:'Experiments'}],assets:deck.assets.map(a=>({...a})),figures:[]};
for(const [rel,text] of assetFiles){
  const filename=path.basename(rel);
  for(const dir of ['plots','fig/assets']){await fs.mkdir(path.join(root,dir),{recursive:true});await fs.writeFile(path.join(root,dir,filename),text);}
}
for(const [i,id,title] of [[1,'growth','Growth through time'],[2,'regression','Treatment and response']] as const){
  const assetId=i===1?'data-a':'audit-scatter';
  const panel={...makeText('a',{x:12,y:8,width:20,height:20},{fontSize:14},true),id:`panel-${id}`};
  project.figures.push({id,name:`Figure ${i}`,nickname:title,referenceKey:`fig-${id}`,family:'figure',number:i,canvasId:'experiments',x:(i-1)*620,y:0,width:580,height:360,background:'#ffffff',elements:[panel,{id:`plot-${id}`,type:'plot',assetId,x:40,y:35,width:480,height:300,rotation:0,source:{svgPath:`plots/${assetId}.svg`}}],captions:{__figure__:title,[panel.id]:'Linked data with independent figure styling.'}});
}
await executeFigSave(planFigSave(project,null),{read:async rel=>fs.readFile(path.join(root,rel),'utf8').catch(()=>null),write:async(rel,text)=>{await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.writeFile(path.join(root,rel),text);}});
await reindex(root);
await fs.writeFile(path.join(root,'manuscript/main.qmd'),`---
title: "Figures and slides playground"
---

The treatment relationship is shown in @fig-regression-a. The growth experiment is @fig-growth.

This prose deliberately references Figure 2 before Figure 1. Reordering it must never change either figure's number.

![](../fig/renders/growth.svg){#fig-growth}

![](../fig/renders/regression.svg){#fig-regression}
`);
console.log(`Playground created: ${root}\nTwo linked figures, manuscript references, and five animation scenarios. Existing projects were not touched.`);
