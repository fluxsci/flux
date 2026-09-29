import {readFile}from'node:fs/promises';
import assert from'node:assert/strict';
import{harness}from'./lib/harness.mjs';
import{furnitureGoldens}from'./gen-model3d-furniture-goldens.mjs';
import{furnitureLayout}from'../src/lib/model3d/furnitureLayout';
import{furnitureSvg}from'../src/lib/model3d/furniture';
import{niceTicks}from'../src/lib/model3d/ticks';
import{orbitPose,axisView,pixelsPerUnit,project}from'../src/lib/model3d/orbit';
import{framingBounds}from'../src/lib/model3d/framing';
import{makeModel3dElement}from'../src/lib/model3d/make';
import{inspectGlb}from'../src/lib/model3d/glbCore.mjs';
import type{Scene3dManifest,Model3dAsset}from'../src/lib/model3d/types';
import type{FurnitureNode}from'../src/lib/model3d/furniture';
const h=harness('verify-model3d-furniture'),root=new URL('./fixtures/model3d/fluxplot/',import.meta.url);
const golden=JSON.parse(await readFile(new URL('./fixtures/model3d/furniture-golden.json',import.meta.url),'utf8'));assert.deepEqual(await furnitureGoldens(),golden);h.eq(Object.keys(golden).length,33,'11 fixtures ×3 views match exact layout/SVG goldens');
const m:Scene3dManifest=JSON.parse(await readFile(new URL('box-axes.fluxplot.json',root),'utf8')),info=inspectGlb(await readFile(new URL('box-axes.glb',root))),asset:Model3dAsset={id:'a',name:'box.glb',kind:'glb',path:'assets/a.glb',naturalWidth:336,naturalHeight:288,sha256:'0'.repeat(64),bytes:4000,model:info},el=makeModel3dElement(asset,{manifest:m,id:'test'});
const layout=furnitureLayout(m,el),pose=orbitPose(el,framingBounds(info.bounds,m),layout.viewport),front=furnitureSvg(m,el,pose,layout),back=furnitureSvg(m,{...el,...axisView('back')},orbitPose({...el,...axisView('back')},framingBounds(info.bounds,m),layout.viewport),layout);
h.ok(front.under.includes('<text')&&front.under.includes('x (µm)'),'axes use vector text');h.ok(front.under!==back.under,'panes and projected ticks follow view');h.ok(!/NaN|Infinity/.test(front.under),'all projected coordinates finite');h.ok(front.under.includes('test__axes.x.ticks'),'semantic part ids namespaced');
const cardinal={...el,...axisView('front')},cardinalSvg=furnitureSvg(m,cardinal,orbitPose(cardinal,framingBounds(info.bounds,m),layout.viewport),layout);h.ok(!cardinalSvg.underNodes.some(n=>n.partId==='axes.z.ticks'||n.partId==='axes.z.label'),'collapsed depth axis hides coincident ticks and labels');
const rotated:Scene3dManifest={...m,toWorld:[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1],bounds:{min:[1,3,-7],max:[2,5,-4]},axes:{kind:'box'}},explicit:Scene3dManifest={...rotated,axes:{kind:'box',x:{lim:[1,2]},y:{lim:[4,7]},z:{lim:[3,5]}}};h.eq(furnitureSvg(rotated,el,pose,layout).under,furnitureSvg(explicit,el,pose,layout).under,'absent data limits inverse-rotate world bounds once');
const constant:Scene3dManifest={spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'constant.glb',parts:[{id:'field',role:'surface-field',node:'field',field:{cmap:{name:'constant',stops:[[0,'#000000'],[1,'#FFFFFF']]},range:[2,2],ticks:[2],label:'Constant'}},{id:'bar',role:'colorbar',field:'field'}]};const cl=furnitureLayout(constant,el),cs=furnitureSvg(constant,el,pose,cl);h.ok(cs.over.includes('>2</text>')&&!/NaN|Infinity/.test(cs.over),'constant colorbar has finite centered tick');h.ok(Number(cs.overNodes.find(n=>n.partId==='bar')!.children!.find(n=>n.key==='cbar-title')!.attrs.y)>=cl.fontSize,'colorbar title baseline leaves a full font size above it');
const larger=furnitureLayout(m,{width:el.width*2,height:el.height*2});h.eq(larger.fontSize,layout.fontSize,'resize keeps physical font size');h.ok(larger.viewport.width>layout.viewport.width,'resize expands3D viewport');
const continuous:Scene3dManifest=JSON.parse(await readFile(new URL('continuous.fluxplot.json',root),'utf8'));
for(const size of [9.333333333333332,21])for(const scale of [.5,1,3]){
 const partId=continuous.parts!.find(p=>p.role==='colorbar')!.id;
 const element={...el,width:el.width*scale,height:el.height*scale,overrides:{[partId]:{fontSize:size}}};
 const l=furnitureLayout(continuous,element,element.overrides),s=furnitureSvg(continuous,element,pose,l);
 const nodes=s.overNodes.find(n=>n.partId===partId)!.children!,title=nodes.find(n=>n.key==='cbar-title')!,labels=nodes.filter(n=>n.key.startsWith('cbar-label-'));
 const top=Math.min(...labels.map(n=>Number(n.attrs.y)));
 h.ok(top-Number(title.attrs.y)>=size*1.3,`colorbar title separates from top tick at ${scale}× box / ${size}px font`);
 h.ok(Number(title.attrs.y)>=size,`colorbar title stays within top margin at ${scale}× box / ${size}px font`);
 h.ok([title,...labels].every(n=>n.attrs['font-size']===size),`colorbar physical font unchanged at ${scale}× box / ${size}px font`);
}
h.ok(front.under.includes('font-family="Inter, sans-serif"'),'standalone house font has intentional sans fallback');h.ok(furnitureSvg(m,{...el,overrides:{'axes.x.label':{fontFamily:'Georgia'}}},pose,layout).under.includes('font-family="Georgia"'),'explicit font override remains verbatim');
const sm:Scene3dManifest=JSON.parse(await readFile(new URL('scalebar.fluxplot.json',root),'utf8')),se=makeModel3dElement(asset,{manifest:sm,id:'scale'}),sl=furnitureLayout(sm,se),sp=orbitPose(se,framingBounds(info.bounds,sm),sl.viewport),ss=furnitureSvg(sm,se,sp,sl);const scaleGroup=ss.overNodes.find(n=>n.partId==='scalebar'),bar=scaleGroup?.children?.find(n=>n.tag==='line');h.ok(!!bar,'scale bar rendered');h.ok(Math.abs(Number(bar?.attrs.x2)-Number(bar?.attrs.x1)-(sm.parts!.find(p=>p.id==='scalebar')!.length!*pixelsPerUnit(sp,sl.viewport)!))<1e-9,'scale bar exact data-unit projection');h.ok(!furnitureSvg(sm,se,{...sp,projection:'perspective'},sl).over.includes('scale-line'),'perspective hides exact scale bar');
const hidden={...sm,parts:sm.parts!.map(p=>p.id==='scalebar'?{...p,hidden:true}:p)};h.eq(furnitureLayout(hidden,se,{'scalebar':{hidden:false}}).scalebars.length,1,'explicit show overrides source-hidden');
h.eq(niceTicks(-1,1),[-1,-.5,0,.5,1],'nice tick oracle');h.eq(niceTicks(1.21,3.82),[1.5,2,2.5,3,3.5],'data range tick oracle');
for(const name of ['furniture.ts','furnitureLayout.ts','ticks.ts','textMetrics.ts'])h.ok(!/getBoundingClientRect|measureText|document\.|window\./.test(await readFile(new URL(`../src/lib/model3d/${name}`,import.meta.url),'utf8')),`${name} no DOM/text measurement`);
const styled={...el,overrides:{'axes.x.label':{fill:'#FF0000',fontSize:21}}},s=furnitureSvg(m,styled,pose,layout);h.ok(s.under.includes('fill="#FF0000"')&&s.under.includes('font-size="21"'),'part text styling shares plot units');
const cm=JSON.parse(await readFile(new URL('continuous.fluxplot.json',root),'utf8')) as Scene3dManifest;
const ce={...el,overrides:{'height.colorbar':{fill:'#aa2244',fontSize:18}}},fl=furnitureLayout(cm,ce,ce.overrides),styledBar=furnitureSvg(cm,ce,pose,fl).overNodes.find(n=>n.partId==='height.colorbar')!;
h.ok(styledBar.children!.filter(n=>n.tag==='text').every(n=>n.attrs.fill==='#aa2244'&&n.attrs['font-size']===18),'composite furniture exposes text fill and font size');
h.ok(String(styledBar.children!.find(n=>n.tag==='rect')!.attrs.fill).startsWith('url('),'composite text fill preserves colorbar gradient');
const scaleText=furnitureSvg(sm,{...se,overrides:{scalebar:{fill:'#aa2244',stroke:'#336699',fontSize:18}}},sp,sl).overNodes.find(n=>n.partId==='scalebar')!;
h.ok(scaleText.children!.some(n=>n.tag==='text'&&n.attrs.fill==='#aa2244'&&n.attrs['font-size']===18)&&scaleText.children!.some(n=>n.tag==='line'&&n.attrs.stroke==='#336699'),'scale bar text and line expose independent shared style keys');
const closeView={...el,orbitAzimuth:0,orbitElevation:0,orbitProjection:'perspective' as const,orbitFov:30};
const closeLayout=furnitureLayout(m,closeView),faceZoom=Math.sqrt(3)/Math.sin(Math.PI/12);
for(const zoom of [faceZoom,faceZoom+1,50]) { const view={...closeView,orbitZoom:zoom},svg=furnitureSvg(m,view,orbitPose(view,{min:[-1,-1,-1],max:[1,1,1]},closeLayout.viewport),closeLayout); h.ok(!/NaN|Infinity/.test(svg.under+svg.over),`camera on/inside axes box emits finite SVG at zoom ${zoom}`); }
// Independent geometric oracles: axes lie on the projected convex box's
// outline, ticks point perpendicular/outward, and cardinal axes stay distinct.
for(const projection of ['orthographic','perspective'] as const)for(const azimuth of [0,30,90,150,210,270,330])for(const elevation of [-20,20])for(const roll of [0,35]){
 const view={...el,width:220,height:210,orbitAzimuth:azimuth,orbitElevation:elevation,orbitRoll:roll,orbitProjection:projection};
 const l=furnitureLayout(m,view),p=orbitPose(view,framingBounds(info.bounds,m),l.viewport),svg=furnitureSvg(m,view,p,l);
 const corners=Array.from({length:8},(_,mask)=>project([0,1,2].map(i=>(mask>>i)&1?1:-1) as [number,number,number],p,l.viewport));
 const lines=svg.underNodes.filter(n=>n.partId?.endsWith('.axis')).flatMap(n=>n.children??[]);
 for(const line of lines){
  const a=line.attrs,dx=Number(a.x2)-Number(a.x1),dy=Number(a.y2)-Number(a.y1),length=Math.hypot(dx,dy);
  const signed=corners.map(c=>(dx*(c.y-Number(a.y1))-dy*(c.x-Number(a.x1)))/length);
  assert(signed.every(v=>v>=-1e-6)||signed.every(v=>v<=1e-6),'axis must stay on box silhouette');
  const axis=line.partId!.split('.')[1],ticks=svg.underNodes.find(n=>n.partId===`axes.${axis}.ticks`)!.children!.filter(n=>n.tag==='line');
  for(const tick of ticks){const a=tick.attrs,tx=Number(a.x2)-Number(a.x1),ty=Number(a.y2)-Number(a.y1);assert(Math.abs(dx*tx+dy*ty)<1e-6*length,'tick direction is perpendicular');const center=project([0,0,0],p,l.viewport);assert(tx*(Number(a.x1)-center.x)+ty*(Number(a.y1)-center.y)>=-1e-6,'tick direction points outward');}
 }
 for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
  const a=lines[i].attrs,b=lines[j].attrs,dx=Number(a.x2)-Number(a.x1),dy=Number(a.y2)-Number(a.y1),ex=Number(b.x2)-Number(b.x1),ey=Number(b.y2)-Number(b.y1);
  if(Math.abs(dx*ey-dy*ex)<1e-6*Math.hypot(dx,dy)*Math.hypot(ex,ey))assert(Math.abs(dx*(Number(b.y1)-Number(a.y1))-dy*(Number(b.x1)-Number(a.x1)))/Math.hypot(dx,dy)>=l.fontSize,'parallel projected axes use distinct outlines');
 }
}
h.ok(true,'56 small-box camera/projection/roll cases keep axis labels on distinct outlines with perpendicular outward ticks');
const movedTitle=furnitureSvg(m,{...el,overrides:{'axes.y.label':{dx:3,dy:4}}},pose,layout).underNodes.find(n=>n.partId==='axes.y.label')!.children![0];
h.ok(String(movedTitle.attrs.transform).startsWith('translate(3 4) rotate('),'part translation preserves readable axis title orientation');
// A hidden part leaves the legend entirely (no orphan label) and the rest reflow.
{
 const named:Scene3dManifest=JSON.parse(await readFile(new URL('named-parts.fluxplot.json',root),'utf8'));
 const entries=named.parts!.find(p=>p.role==='legend')!.entries!, hiddenId=entries[0];
 const labelsOf=(overrides:Record<string,{hidden?:boolean}>)=>{const e={...el,overrides},l=furnitureLayout(named,e,e.overrides);return furnitureSvg(named,e,orbitPose(e,framingBounds(info.bounds,named),l.viewport),l).overNodes.find(n=>n.partId==='legend')?.children?.filter(n=>n.key.startsWith('legend-label-'))??[];};
 const shown=labelsOf({}),hidden=labelsOf({[hiddenId]:{hidden:true}});
 h.eq(shown.length,entries.length,'legend lists every visible part');
 h.eq(hidden.length,entries.length-1,'hiding a part removes its legend row');
 h.ok(!hidden.some(n=>n.text===(named.parts!.find(p=>p.id===hiddenId)!.label??hiddenId)),'no orphan label for the hidden part');
 h.eq(Number(hidden[0]?.attrs.y),Number(shown[0]?.attrs.y),'remaining legend rows reflow into the freed slot');
}
{ // With a triad in the bottom-left corner the scale bar moves right, so they never overlap.
 const bar:Scene3dManifest=JSON.parse(await readFile(new URL('scalebar.fluxplot.json',root),'utf8'));
 const barAt=(mf:Scene3dManifest)=>{const l=furnitureLayout(mf,el),s=furnitureSvg(mf,el,orbitPose(el,framingBounds(info.bounds,mf),l.viewport),l);const n=s.overNodes.find(x=>x.partId==='scalebar')?.children?.find(c=>c.key==='scale-line');return {x1:Number(n?.attrs.x1),x2:Number(n?.attrs.x2),mid:l.viewport.x+l.viewport.width/2};};
 const plain=barAt(bar),withTriad=barAt({...bar,axes:{kind:'triad'}});
 h.ok(plain.x1<plain.mid,'scale bar sits bottom-left without a triad');
 h.ok(withTriad.x1>withTriad.mid&&withTriad.x2>withTriad.x1,'scale bar right-aligns beside a triad');
}
{ // Box axes are part of the figure: the default view frames the whole axes box,
  // not just the mesh's tight sphere (box corners sit up to √3 R out).
 const sphere={min:[-1,-1,-1],max:[1,1,1],radius:1} as const,wide:Scene3dManifest={...m,axes:{...m.axes!,x:{...m.axes!.x!,lim:[-3,3]}}};
 h.eq(framingBounds(sphere,{...m,axes:undefined}),sphere,'a bare mesh keeps its tight framing');
 h.eq(framingBounds(sphere,{...m,axes:{kind:'triad'}}),sphere,'a triad does not widen the framing');
 const inside=(mf:Scene3dManifest,b:typeof sphere|ReturnType<typeof framingBounds>)=>{let worst=Infinity;for(const azimuth of [0,30,45,90,135,210,300])for(const elevation of [-35,20,60])for(const projection of ['orthographic','perspective'] as const){
  const view={...el,orbitAzimuth:azimuth,orbitElevation:elevation,orbitProjection:projection},l=furnitureLayout(mf,view),p=orbitPose(view,b,l.viewport);
  for(let mask=0;mask<8;mask++){const lim=['x','y','z'].map(k=>mf.axes![k as 'x'].lim!),q=project(lim.map((v,i)=>v[(mask>>i)&1]) as [number,number,number],p,l.viewport);const v=l.viewport,x0=v.x??0,y0=v.y??0;worst=Math.min(worst,q.x-x0,q.y-y0,x0+v.width-q.x,y0+v.height-q.y);}
 }return worst;};
 h.ok(inside(m,sphere)<0,'control: the tight sphere alone crops the axes box');
 h.ok(inside(m,framingBounds(sphere,m))>0,'box axes stay inside the frame at the default zoom, every view');
 h.ok(inside(wide,framingBounds(sphere,wide))>0,'axis limits wider than the mesh are framed too');
}
{// Guide text fits: the colorbar/legend column grows to its text (≤40% of the box); longer titles wrap.
 const{textWidth}=await import('../src/lib/model3d/textMetrics');
 const bar=(label:string):Scene3dManifest=>({spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'x.glb',style:{fontSizePt:7},parts:[{id:'f',role:'surface-field',node:'f',field:{cmap:{name:'c',stops:[[0,'#000000'],[1,'#FFFFFF']]},range:[0,250],ticks:[0,100,200],label}},{id:'bar',role:'colorbar',field:'f'}]});
 const box={width:230,height:307},fs=7*4/3;
 const short=furnitureLayout(bar('mm'),box),long=furnitureLayout(bar('Path distance from soma (µm)'),box);
 h.eq(short.viewport.width,box.width-Math.max(64,fs*9),'short titles keep the classic guide column');
 const title=long.colorbar!,need=textWidth('Path distance from soma (µm)',fs);
 h.ok(long.viewport.width<short.viewport.width,'a long colorbar title widens the guide column');
 h.ok(box.width-long.viewport.width<=box.width*.4+1e-9,'the guide column never exceeds 40% of the box');
 const lines=title.titleLines!;h.ok(lines.length>=1&&lines.join(' ')==='Path distance from soma (µm)','wrapped lines keep every word in order');
 h.ok(lines.every(l=>title.x+textWidth(l,fs)<=box.width+1e-9),'every title line fits inside the box');
 h.ok(need>box.width*.4?lines.length>1:lines.length===1,'titles wider than the capped column wrap, others stay on one line');
 const narrow=furnitureLayout(bar('Path distance from soma (µm)'),{width:150,height:300});
 h.ok(narrow.colorbar!.titleLines!.length>1&&narrow.colorbar!.y>short.colorbar!.y,'wrapping reserves room above the bar');
 const el={id:'w',kind:'model3d',x:0,y:0,width:150,height:300,fill:'#cccccc',orbitAzimuth:0,orbitElevation:0,orbitZoom:1,orbitProjection:'orthographic',overrides:{}} as any;
 const svg=furnitureSvg(bar('Path distance from soma (µm)'),el,orbitPose(el,{min:[0,0,0],max:[1,1,1]} as any,narrow.viewport),narrow);
 const nodes=svg.overNodes.find(n=>n.partId==='bar')!.children!,titles=nodes.filter(n=>n.key.startsWith('cbar-title')),ticks=nodes.filter(n=>n.key.startsWith('cbar-label-'));
 h.eq(titles.length,narrow.colorbar!.titleLines!.length,'one text node per wrapped title line');
 h.ok(Math.max(...titles.map(n=>Number(n.attrs.y)))<Math.min(...ticks.map(n=>Number(n.attrs.y)))-fs,'the last title line clears the top tick');
 h.ok(Math.min(...titles.map(n=>Number(n.attrs.y)))>=fs,'the first title line stays inside the top margin');
 const legend:Scene3dManifest={spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'x.glb',style:{fontSizePt:7},parts:[{id:'cortex.left',role:'mesh',label:'Left hemisphere, pial surface'},{id:'cortex.right',role:'mesh',label:'Right'},{id:'legend',role:'legend',entries:['cortex.left','cortex.right']}]};
 const lg=furnitureLayout(legend,{width:400,height:300});
 h.ok(lg.legend!.legendRows![0].lines.every(line=>lg.legend!.x+fs*1.5+textWidth(line,fs)<=400),'legend lines fit inside the widened column');
 h.eq(furnitureLayout(legend,{width:400,height:300},{'cortex.left':{hidden:true}}).viewport.width,400-Math.max(64,fs*9),'hidden legend entries stop widening the column');
}
{// Completion regressions: hard tokens, effective fonts/ranges, and honest impossible layouts.
 const {textWidth,wrapWords}=await import('../src/lib/model3d/textMetrics');
 const token='LongUnbrokenScientificIdentifierαβγ';
 const split=wrapWords(token,12,48);
 h.eq(split.join(''),token,'hard wrapping preserves every Unicode code point');
 h.ok(split.length>1&&split.every(line=>textWidth(line,12)<=48),'hard tokens fit the available line width');
 const mf:Scene3dManifest={spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'fit.glb',parts:[{id:'f',role:'surface-field',node:'f',field:{cmap:{name:'c',stops:[[0,'#000000'],[1,'#FFFFFF']]},range:[0,1],label:token}},{id:'bar',role:'colorbar',field:'f'},{id:'mesh',role:'mesh',label:token},{id:'legend',role:'legend',entries:['mesh']}]};
 const element={...el,width:320,height:500,fields:{f:{range:[-99999,99999] as [number,number]}},overrides:{legend:{fontSize:18}}};
 const l=furnitureLayout(mf,element,element.overrides),svg=furnitureSvg(mf,element,pose,l);
 const row=l.legend!.legendRows![0];
 h.eq(row.lines.join(''),token,'legend hard wrap preserves the complete label');
 h.ok(row.lines.length>1&&row.lines.every(line=>l.legend!.x+l.fontSize*1.5+textWidth(line,18)<=320),'legend wrapping uses its effective physical font');
 h.ok(!l.overflow,'sufficient guide height fits all rows');
 const labels=svg.overNodes.find(n=>n.partId==='legend')!.children!.filter(n=>n.tag==='text');
 h.eq(labels.map(n=>n.text),row.lines,'rendered legend uses the layout line breaks');
 h.ok(labels.every(n=>n.attrs['font-size']===18),'legend wrapping preserves physical font size');
 const onlyBar={...mf,parts:mf.parts!.filter(p=>p.id!=='legend')};
 // Remove title-width pressure so this comparison measures effective ticks only.
 const noTitle={...onlyBar,parts:onlyBar.parts!.map(p=>p.id==='f'?{...p,field:{...(p.field as any),label:''}}:p)};
 h.ok(furnitureLayout(noTitle,{width:400,height:400,fields:{f:{range:[-99999,99999]}}},{bar:{fontSize:18}}).viewport.width<furnitureLayout(noTitle,{width:400,height:400},{bar:{fontSize:18}}).viewport.width,'edited field tick widths participate in layout');
 const tiny=furnitureLayout(mf,{width:90,height:40},{legend:{fontSize:18}});
 h.ok(tiny.overflow&&tiny.overflowParts.includes('legend'),'impossible boxes report overflow without shrinking or dropping text');
 h.eq(tiny.legend!.legendRows![0].lines.join(''),token,'overflow still preserves the full scientific label');
 h.ok(tiny.legend!.y>tiny.colorbar!.y+tiny.colorbar!.height,'overflowing guides do not overlap each other');
}
{// Near-cardinal views: an axis seen almost end-on projects to a stub too short for
 // its tick labels. They (and a title longer than the stub) hide; the axis line, tick
 // marks and grid stay. fluxplot's still mirrors the rule (tests/test_scene3d_static.py).
 const{textWidth}=await import('../src/lib/model3d/textMetrics');
 const{tickLabelsCollide}=await import('../src/lib/model3d/furniture');
 const fs=layout.fontSize,space=textWidth(' ',fs);
 h.ok(!tickLabelsCollide([],fs,'middle')&&!tickLabelsCollide([{x:0,y:0,width:50}],fs,'middle'),'no or one tick label never collides');
 h.ok(tickLabelsCollide([{x:0,y:0,width:10},{x:10+space*.9,y:0,width:10}],fs,'start')&&!tickLabelsCollide([{x:0,y:0,width:10},{x:10+space*1.1,y:0,width:10}],fs,'start'),'side-by-side labels need a word space between them');
 h.ok(tickLabelsCollide([{x:0,y:0,width:10},{x:0,y:fs*.9,width:10}],fs,'end')&&!tickLabelsCollide([{x:0,y:0,width:10},{x:0,y:fs*1.1,width:10}],fs,'end'),'stacked labels need one font size between their centres');
 h.ok(tickLabelsCollide([{x:0,y:0,width:40},{x:15,y:fs*2,width:4},{x:30,y:0,width:40}],fs,'middle'),'any two labels are compared, not just neighbours');
 type View={azimuth:number;elevation:number;projection?:'orthographic'|'perspective';manifest?:Scene3dManifest};
 const render=({azimuth,elevation,projection='orthographic',manifest=m}:View)=>{const view={...el,orbitAzimuth:azimuth,orbitElevation:elevation,orbitRoll:0,orbitProjection:projection},l=furnitureLayout(manifest,view,view.overrides);return furnitureSvg(manifest,view,orbitPose(view,framingBounds(info.bounds,manifest),l.viewport),l);};
 const axisOf=(svg:ReturnType<typeof furnitureSvg>,k:string)=>{
  const group=(role:string)=>svg.underNodes.find(n=>n.partId===`axes.${k}.${role}`)?.children??[];
  const line=group('axis')[0],marks=group('ticks').filter(n=>n.tag==='line');
  return {length:line?Math.hypot(Number(line.attrs.x2)-Number(line.attrs.x1),Number(line.attrs.y2)-Number(line.attrs.y1)):0,marks,labels:group('ticks').filter(n=>n.tag==='text'),title:group('label')[0],grid:group('grid').length};
 };
 // Independent oracle over the emitted geometry: rebuild each label box from its tick
 // mark (4 px along the outward normal) and the shared offset, then compare every pair.
 const wouldCollide=(marks:FurnitureNode[],texts:string[])=>{
  const pts=marks.map((t,i)=>{const nx=(Number(t.attrs.x2)-Number(t.attrs.x1))/4,ny=(Number(t.attrs.y2)-Number(t.attrs.y1))/4,x=Number(t.attrs.x1)+nx*(fs*.9+4),w=textWidth(texts[i],fs);const x0=nx<-.5?x-w:nx>.5?x:x-w/2;return {x0:x0-space/2,x1:x0+w+space/2,y:Number(t.attrs.y1)+ny*(fs*.9+4)};});
  for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++)if(pts[i].x0<pts[j].x1&&pts[j].x0<pts[i].x1&&Math.abs(pts[i].y-pts[j].y)<fs)return true;
  return false;
 };
 const ticks=['-1','0','1'];
 const near=render({azimuth:5,elevation:0}),z=axisOf(near,'z');
 h.ok(z.length>=1&&z.length<20,`front + 5° leaves z a short stub (${z.length.toFixed(1)} px)`);
 h.ok(!z.labels.length&&z.marks.length===3&&z.grid>0&&wouldCollide(z.marks,ticks),'the stub hides its colliding tick labels and keeps its line, tick marks and grid');
 h.ok(!z.title&&textWidth('z (µm)',fs)>z.length,'a title longer than the stub hides with its tick labels');
 h.ok(['x','y'].every(k=>{const a=axisOf(near,k);return a.labels.length===3&&!!a.title;}),'the two axes across the view keep every label and title');
 const shortTitle={...m,parts:m.parts!.map(p=>p.id==='axes.z.label'?{...p,text:'z'}:p)};
 h.eq(axisOf(render({azimuth:5,elevation:0,manifest:shortTitle}),'z').title?.text,'z','a title that fits along the stub stays');
 h.ok(!axisOf(render({azimuth:5,elevation:0,projection:'perspective'}),'z').labels.length,'the rule holds under perspective');
 h.ok(!axisOf(render({azimuth:30,elevation:86}),'y').labels.length&&axisOf(render({azimuth:30,elevation:86}),'x').labels.length===3,'looking almost straight down hides the stub axis only');
 // Fine orbit sweeps: labels show exactly when they would not collide (both ways),
 // shown labels never overlap, and each axis changes state at most once per quarter turn.
 let checked=0;
 for(const [projection,elevation] of [['orthographic',0],['orthographic',25],['perspective',0]] as const){
  const states:Record<string,boolean[]>={x:[],y:[],z:[]};
  for(let azimuth=0;azimuth<=90;azimuth+=.5){const svg=render({azimuth,elevation,projection});for(const k of ['x','y','z']){const a=axisOf(svg,k);if(a.length<1)continue;const shown=a.labels.length>0;
   assert.equal(shown,!wouldCollide(a.marks,ticks),`labels shown iff collision-free (${projection} az ${azimuth} el ${elevation} ${k})`);
   if(shown)assert.equal(a.labels.length,a.marks.length,'labels hide all together, never partially');
   states[k].push(shown);checked++;}}
  for(const k of ['x','y','z'])assert(states[k].filter((s,i)=>i&&s!==states[k][i-1]).length<=1,`${k} toggles at most once over a quarter turn (${projection}, el ${elevation})`);
 }
 h.ok(checked>500,`${checked} swept axis views: labels shown exactly when collision-free, all-or-none, no flicker between neighbouring angles`);
}
await h.done();
