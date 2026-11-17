// Crystallize (Shift+A; headless `arrange --mode auto`): recognize the row, column or grid a
// loose selection is closest to and plan it outright. Pure planner, the shared op, and the
// editor's controller (offer, one-Undo action, notice) on real stores. Plots line up on their
// AXES (the lines read by plot/landmarks) instead of their boxes; real fluxplot fixtures.
import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOMParser, parseHTML } from 'linkedom';
import { get } from 'svelte/store';
import { preparePlot } from '../src/lib/plot/parse';
import { plotAxisLines, selectionAxisLines, resolveUnitSpine, type SpineContext } from '../src/lib/plot/landmarks';
import type { LayoutLines } from '../src/lib/layout/arrangement';
import { createArrangementSnapshot, planArrangement, planAutoArrangement, autoArrangementRefusal } from '../src/lib/layout/arrangement';
import { arrangePanels, applyArrangementPlan } from '../src/lib/ops';
import type { Element, Figure, Project, RectElement } from '../src/lib/types';

let checks=0;
const eq=(a:unknown,b:unknown,label?:string)=>{assert.deepEqual(a,b,label);checks++;};
const ok=(a:unknown,label:string)=>{assert.ok(a,label);checks++;};
const near=(a:number,b:number,label?:string,tolerance=1e-8)=>{assert.ok(Math.abs(a-b)<=tolerance,`${label??''} ${a} != ${b}`);checks++;};
const rect=(id:string,x:number,y:number,w=56,h=58):RectElement=>({id,type:'rect',x,y,width:w,height:h,rotation:0,fill:'#d95f02',stroke:'none',strokeWidth:0,cornerRadius:0});
const figure=(elements:Element[]):Figure=>({id:'f',canvasId:'c',name:'F',x:0,y:0,width:900,height:900,elements});
const project=(f:Figure):Project=>({version:2,name:'Crystallize',canvases:[{id:'c',name:'C'}],figures:[f],assets:[],palette:[]});
const freezeDeep=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeDeep(child);Object.freeze(value);}};
const auto=(f:Figure,options?:Parameters<typeof planAutoArrangement>[1])=>planAutoArrangement(createArrangementSnapshot(f),options);
const applied=(f:Figure,options?:Parameters<typeof planAutoArrangement>[1])=>{const next=structuredClone(f);applyArrangementPlan(project(next),'f',auto(f,options)!.plan);return next;};
const at=(f:Figure,id:string)=>f.elements.find(e=>e.id===id)!;
/** Passive recognition (the pink guides) accepts exactly this. */
const regular=(f:Figure)=>{const s=createArrangementSnapshot(f);return !s.suggested&&s.regularX&&s.regularY&&planArrangement(s,{mode:'tidy'}).identity;};

// --- 1. The owner's three hand-placed groups (Figure 7, 2026-11-17) -------------------------
const orange=[rect('o1',76.695,372.216),rect('o2',152.563,369.383),rect('o3',226.944,363.419),rect('o4',91.181,451.037),rect('o5',160.24,459.051),rect('o6',237.052,451.037),rect('o7',70.716,526.545),rect('o8',147.507,526.545),rect('o9',219.624,530.625)];
const green=[rect('g1',330.419,451.037),rect('g2',396.865,455.634),rect('g3',461.423,451.037)];
const blue=[rect('b1',537.815,379.667),rect('b2',546.425,445.27),rect('b3',537.815,510.872)];
{
  const result=auto(figure(orange))!;
  eq([result.topology,result.rows,result.cols,result.moves],['grid',3,3,true],'nine loose boxes are a 3 × 3 grid');
  const after=applied(figure(orange));
  for(const column of [['o1','o4','o7'],['o2','o5','o8'],['o3','o6','o9']])eq(new Set(column.map(id=>at(after,id).x)).size,1,'each column shares one x');
  for(const row of [['o1','o2','o3'],['o4','o5','o6'],['o7','o8','o9']])eq(new Set(row.map(id=>at(after,id).y)).size,1,'each row shares one y');
  near(at(after,'o2').x-at(after,'o1').x-56,result.plan.gapX,'one column gap');near(at(after,'o4').y-at(after,'o1').y-58,result.plan.gapY,'one row gap');
  ok(Number.isInteger(result.plan.gapX)&&Number.isInteger(result.plan.gapY),'gaps land on whole pixels beside 56 px objects');
  ok(regular(after),'the result is exactly what the passive guides recognize');
  eq(auto(after)!.moves,false,'crystallizing twice changes nothing');
  const before=createArrangementSnapshot(figure(orange)).bounds,now=createArrangementSnapshot(after).bounds;
  near(now.x+now.w/2,before.x+before.w/2,'the center stays put (x)');near(now.y+now.h/2,before.y+before.h/2,'the center stays put (y)');
}
{
  const row=auto(figure(green))!,column=auto(figure(blue))!;
  eq([row.topology,row.rows,row.cols],['row',1,3],'three side by side are a row');
  eq([column.topology,column.rows,column.cols],['column',3,1],'three stacked are a column');
  const r=applied(figure(green)),c=applied(figure(blue));
  eq(new Set(r.elements.map(e=>e.y)).size,1);eq(new Set(c.elements.map(e=>e.x)).size,1);
  ok(regular(r)&&regular(c),'rows and columns end up recognized too');
}
// "One more green square below the left-most" is the best grid for four: 2 × 2, never 3 + 1.
{
  const four=figure([...green,rect('g4',331,526)]),result=auto(four)!;
  eq([result.topology,result.rows,result.cols],['grid',2,2],'three above one becomes 2 × 2');
  const after=applied(four);
  eq(at(after,'g4').x,at(after,'g1').x,'the fourth stays under the first');
  eq(at(after,'g3').x,at(after,'g2').x,'the third drops under the second instead of crossing');
  eq(at(after,'g3').y,at(after,'g4').y);ok(regular(after),'2 × 2 is recognized');
}

// --- 2. Shapes --------------------------------------------------------------------------
const shape=(items:[number,number][])=>{const r=auto(figure(items.map(([x,y],i)=>rect(`e${i}`,x,y))));return r?`${r.topology} ${r.rows}x${r.cols}`:null;};
eq(shape([[0,0],[70,3],[140,-2],[0,72],[70,70],[140,75]]),'grid 2x3','a full 2 × 3 keeps its shape');
eq(shape([[0,0],[70,3],[140,-2],[0,72],[70,70]]),'grid 2x3','a ragged last row is kept when it is already compact');
eq(shape([[0,0],[70,2],[140,-2],[210,1],[1,72]]),'grid 2x4','four above one cannot complete a rectangle and keeps its rows');
eq(shape([...Array.from({length:15},(_,i)=>[(i%5)*70+(i%3),Math.floor(i/5)*72+(i%2)*3] as [number,number]),[2,217]]),'grid 4x4','5 + 5 + 5 + 1 completes a 4 × 4');
eq(shape([[0,0],[70,3],[140,-2],[0,72],[70,70],[0,144],[70,141],[140,146]]),'grid 3x3','uneven rows take the smallest grid that holds them');
eq(shape([[0,0],[70,70],[0,140],[70,210]]),'grid 2x2','a vertical zigzag reads through its columns');
eq(shape([[0,0],[70,70],[140,140]]),'row 1x3','a wide staircase is a row');
eq(shape([[0,0],[20,70],[40,140]]),'column 3x1','a tall staircase is a column');
eq(shape([[0,0],[80,6]]),'row 1x2','two objects are enough');
// Nothing to recognize.
const refusal=(elements:Element[])=>autoArrangementRefusal(createArrangementSnapshot(figure(elements)));
eq(refusal([rect('a',0,0)]),'too-few');eq(auto(figure([rect('a',0,0)])),null);
eq(refusal([rect('a',0,0),rect('b',10,6)]),'pile','objects on top of each other are not an arrangement');eq(auto(figure([rect('a',0,0),rect('b',10,6)])),null);
eq(refusal([rect('a',0,0,50,50),rect('b',0,60,50,50),rect('tall',60,0,50,110)]),'spanning','a panel beside two stacked ones is left alone');
eq(refusal(orange),null);
// A label on its panel is not a neighbour of that panel: refuse rather than pull them apart.
const labelled=[rect('p1',0,0,200,150),rect('l1',6,6,14,14),rect('p2',220,4,200,150),rect('l2',226,10,14,14)];
eq(refusal(labelled),'pile','an object sitting on another is not an arrangement');eq(auto(figure(labelled)),null);
{const grouped=figure(structuredClone(labelled));grouped.groups={a:{id:'a',name:'A',parentId:null},b:{id:'b',name:'B',parentId:null}} as Figure['groups'];
 for(const [id,g] of [['p1','a'],['l1','a'],['p2','b'],['l2','b']])(at(grouped,id) as Element & {groupId?:string}).groupId=g;
 eq(auto(grouped)!.topology,'row','grouped with its label, each panel is one unit of a row');const after=applied(grouped);eq(at(after,'l2').x-at(after,'p2').x,6,'and the label rides along');}

// --- 3. Alignment inside tracks follows what the objects already share --------------------
{
  const tops=applied(figure([rect('a',0,10,50,80),rect('b',70,11,40,40),rect('c',130,9,60,60)]));
  eq(new Set(tops.elements.map(e=>e.y)).size,1,'nearly shared top edges become shared top edges');
  const bottoms=applied(figure([rect('a',0,10,50,80),rect('b',70,51,40,40),rect('c',130,29,60,60)]));
  eq(new Set(bottoms.elements.map(e=>e.y+e.height)).size,1,'shared bottoms stay bottoms');
  const centers=applied(figure([rect('a',0,0,50,80),rect('b',70,21,40,40),rect('c',130,9,60,60)]));
  eq(new Set(centers.elements.map(e=>e.y+e.height/2)).size,1,'centers when centers are closest');
  const rights=applied(figure([rect('a',40,0,20,30),rect('b',1,40,60,30),rect('c',21,80,40,30)]));
  eq(new Set(rights.elements.map(e=>e.x+e.width)).size,1,'a column keeps its shared right edge');
  ok([tops,bottoms,centers,rights].every(regular),'every alignment is still a recognized arrangement');
}

// --- 4. Fixed point, gaps and purity -----------------------------------------------------
for(const anchor of [{x:0,y:0},{x:.5,y:.5},{x:1,y:1},{x:0,y:1}] as const){
  const f=figure(orange),before=createArrangementSnapshot(f).bounds,after=createArrangementSnapshot(applied(f,{anchor})).bounds;
  near(after.x+anchor.x*after.w,before.x+anchor.x*before.w,`fixed point x ${anchor.x}`);near(after.y+anchor.y*after.h,before.y+anchor.y*before.h,`fixed point y ${anchor.y}`);
}
{
  // Signed spacing survives: overlapping traces stay an overlapping, even stack.
  const traces=figure([rect('t1',100,40,500,140),rect('t2',103,86,500,140),rect('t3',98,129,500,140),rect('t4',101,176,500,140)]),result=auto(traces)!;
  eq(result.topology,'column');ok(result.plan.gapY<0,'a negative gap is kept negative');
  const after=applied(traces);eq(new Set(after.elements.slice(1).map((e,i)=>e.y-after.elements[i].y)).size,1,'even overlap');ok(regular(after),'an even overlap is recognized');
  // Tiny geometry is never rounded away.
  const tiny=auto(figure([rect('a',.1,1,.2,1),rect('b',.43,1.02,.2,1),rect('c',.7,1,.2,1)]))!;
  ok(tiny.plan.gapX>.09&&tiny.plan.gapX<.14&&!Number.isInteger(tiny.plan.gapX),'sub-pixel layouts keep their own gap');
  // Gaps that already agree are kept exactly; a spread is replaced by a whole number.
  const even=auto(figure([rect('a',0,0),rect('b',89.219,6),rect('c',178.438,-3)]))!;near(even.plan.gapX,33.219,'an agreed gap survives',1e-9);
  // A row has no vertical neighbours: its (unused) row gap borrows the measured one.
  eq(auto(figure(green))!.plan.gapY,auto(figure(green))!.plan.gapX);
}
{
  const f=figure(orange),snapshot=createArrangementSnapshot(f),original=structuredClone(snapshot);freezeDeep(snapshot);freezeDeep(f);
  const plan=planAutoArrangement(snapshot)!.plan;
  eq(snapshot,original,'planning never mutates its baseline');eq(plan.positions.length,9);eq(plan.mode,'reflow');
}
// Locked and hidden objects are not units; groups move as one.
{
  const f=figure([...orange.map(e=>({...e})),{...rect('locked',400,400),locked:true} as Element]),before=structuredClone(at(f,'locked'));
  const after=applied(f);eq(at(after,'locked'),before,'a locked object is neither counted nor moved');eq(auto(f)!.rows*auto(f)!.cols,9);
  const grouped=figure([rect('a',0,0),rect('a2',10,62,20,10),rect('b',72,4),rect('c',141,-3)]);
  grouped.groups={g:{id:'g',name:'G',parentId:null}} as Figure['groups'];for(const id of ['a','a2'])(at(grouped,id) as Element & {groupId?:string}).groupId='g';
  const result=applied(grouped);eq(at(result,'a2').x-at(result,'a').x,10,'a group keeps its inner offsets');eq(at(result,'a2').y-at(result,'a').y,62);
  eq(auto(grouped)!.cols,3,'the group is one unit of three');
}

// --- 5. The shared op: `arrange --mode auto` is the same plan ------------------------------
{
  const viaOp=project(figure(structuredClone(orange)));arrangePanels(viaOp,'f',{mode:'auto',anchorX:'center',anchorY:'center'});
  eq(viaOp.figures[0].elements,applied(figure(orange)).elements,'the op writes exactly the planner\'s positions');
  const topLeft=project(figure(structuredClone(orange)));arrangePanels(topLeft,'f',{mode:'auto'});
  const b0=createArrangementSnapshot(figure(orange)).bounds,b1=createArrangementSnapshot(topLeft.figures[0]).bounds;
  near(b1.x,b0.x,'headless default keeps the top-left corner');near(b1.y,b0.y);
  const some=project(figure([...structuredClone(orange),...structuredClone(green)]));arrangePanels(some,'f',{mode:'auto',ids:green.map(e=>e.id)});
  eq(some.figures[0].elements.slice(0,9),orange,'ids limit the arrangement to those units');eq(new Set(some.figures[0].elements.slice(9).map(e=>e.y)).size,1);
  assert.throws(()=>arrangePanels(project(figure(structuredClone(orange))),'f',{mode:'auto',rows:2}),/recognizes rows, columns and gaps itself/);checks++;
  assert.throws(()=>arrangePanels(project(figure(structuredClone(orange))),'f',{mode:'auto',gapX:4}),/recognizes rows, columns and gaps itself/);checks++;
  assert.throws(()=>arrangePanels(project(figure([rect('a',0,0),rect('b',10,6)])),'f',{mode:'auto'}),/sit on top of each other/);checks++;
  assert.throws(()=>arrangePanels(project(figure([rect('a',0,0)])),'f',{mode:'auto'}),/fewer than two/);checks++;
  const untouched=project(figure([rect('a',0,0),rect('b',10,6)]));try{arrangePanels(untouched,'f',{mode:'auto'});}catch{/* refused */}
  eq(untouched.figures[0].elements,[rect('a',0,0),rect('b',10,6)],'a refusal writes nothing');
}

// --- 6. Scale: thousands of units stay near-linear (no bands × bands walk) -------------------
{
  const many=(n:number)=>figure(Array.from({length:n},(_,i)=>rect(`e${i}`,(i%100)*70+Math.sin(i)*8,Math.floor(i/100)*70+Math.cos(i*1.3)*8)));
  const result=auto(many(5000))!;eq([result.topology,result.rows,result.cols],['grid',50,100],'5,000 jittered objects are still their 50 × 100 grid');
  const single=auto(figure(Array.from({length:5000},(_,i)=>rect(`e${i}`,Math.sin(i)*8,i*70))))!;eq([single.topology,single.rows],['column',5000],'5,000 single-unit bands are one column');
}

// --- 7. Plots line up on their axes -------------------------------------------------------
Object.assign(globalThis,{DOMParser,document:parseHTML('<html><body></body></html>').document});
const fixtureText=(name:string)=>({svg:fs.readFileSync(new URL(`./fixtures/${name}.svg`,import.meta.url),'utf8'),manifest:JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.fluxplot.json`,import.meta.url),'utf8'))});
const boxText=fixtureText('plots/mpl_boxplot_FLUXPLOT'),multiText=fixtureText('fluxplot03/features');
const boxPlot=preparePlot(boxText.svg,boxText.manifest),multiPlot=preparePlot(multiText.svg,multiText.manifest);
const plotCtx:SpineContext={manifest:id=>id==='multi'?multiPlot.manifest:boxPlot.manifest,plotRoot:id=>id==='multi'?multiPlot.root:boxPlot.root};
const plotEl=(id:string,x:number,y:number,width=240,height=144,extra:Record<string,unknown>={}):Element=>({id,type:'plot',assetId:'box',x,y,width,height,rotation:0,...extra} as Element);
const linesOf=(f:Figure,ctx:SpineContext=plotCtx):LayoutLines=>selectionAxisLines(f,undefined,{...ctx,figure:f});
const onAxes=(f:Figure)=>{const next=structuredClone(f);applyArrangementPlan(project(next),'f',planAutoArrangement(createArrangementSnapshot(f),{lines:linesOf(f)})!.plan);return next;};
const spread=(values:number[])=>Math.max(...values)-Math.min(...values);
{
  // The planner itself knows nothing of plots: a line per unit, keyed by unit.
  const boxes=figure([rect('a',0,10,50,80),rect('b',70,31,40,40),rect('c',130,2,60,60)]);
  const y=new Map([['e:a',10+70],['e:b',31+20],['e:c',2+55]]),result=planAutoArrangement(createArrangementSnapshot(boxes),{lines:{y}})!;
  eq([result.topology,result.onLines,result.rails.length],['row',true,1],'a row with a line per unit lines up on them');
  const after=structuredClone(boxes);applyArrangementPlan(project(after),'f',result.plan);
  near(spread([at(after,'a').y+70,at(after,'b').y+20,at(after,'c').y+55]),0,'the three lines are one line');
  near(result.rails[0].y1,at(after,'a').y+70,'the rail is that line');ok(result.rails[0].x2-result.rails[0].x1>=180,'across the whole row');
  near(at(after,'b').x-at(after,'a').x-50,at(after,'c').x-at(after,'b').x-40,'gaps stay between the BOXES');ok(regular(after),'so the passive guides recognize a row lined up on lines');
  const moved=new Map([['e:a',at(after,'a').y+70],['e:b',at(after,'b').y+20],['e:c',at(after,'c').y+55]]);
  eq(planAutoArrangement(createArrangementSnapshot(after),{lines:{y:moved}})!.moves,false,'and crystallizing it again changes nothing');
  ok(planAutoArrangement(createArrangementSnapshot(after))!.moves,'while its boxes are still not aligned (Alt would move them)');
  // A line missing for one unit, or lines on the axis a row does not use: boxes.
  const partial=planAutoArrangement(createArrangementSnapshot(boxes),{lines:{y:new Map([['e:a',80],['e:b',51]])}})!;
  eq([partial.onLines,partial.rails.length],[false,0],'one unit without a line: the whole axis falls back to boxes');
  eq(partial.plan.positions,planAutoArrangement(createArrangementSnapshot(boxes))!.plan.positions);
  const unused=planAutoArrangement(createArrangementSnapshot(boxes),{lines:{x:new Map([['e:a',5],['e:b',75],['e:c',140]])}})!;
  eq(unused.onLines,false,'a row has one unit per column: column lines decide nothing');eq(unused.plan.positions,planAutoArrangement(createArrangementSnapshot(boxes))!.plan.positions);
  // A grid uses both: rows share y lines, columns x lines, and the tracks hold what sticks out.
  const cells=[rect('a',0,0,60,50),rect('b',90,6,80,70),rect('c',4,95,70,60),rect('d',96,90,60,50)],grid=figure(cells);
  const lx=new Map(cells.map((e,i)=>[`e:${e.id}`,e.x+[10,25,20,5][i]])),ly=new Map(cells.map((e,i)=>[`e:${e.id}`,e.y+e.height-[8,20,12,6][i]]));
  const planned=planAutoArrangement(createArrangementSnapshot(grid),{lines:{x:lx,y:ly}})!;eq([planned.topology,planned.onLines,planned.rails.length],['grid',true,4]);
  const g=structuredClone(grid);applyArrangementPlan(project(g),'f',planned.plan);
  near(at(g,'a').x+10,at(g,'c').x+20,'left column shares its x line');near(at(g,'b').x+25,at(g,'d').x+5,'right column too');
  near(at(g,'a').y+50-8,at(g,'b').y+70-20,'top row shares its y line');near(at(g,'c').y+60-12,at(g,'d').y+50-6,'bottom row too');
  ok(regular(g),'a grid on lines is a recognized grid');
  const again=planAutoArrangement(createArrangementSnapshot(g),{lines:{x:new Map(cells.map((e,i)=>[`e:${e.id}`,at(g,e.id).x+[10,25,20,5][i]])),y:new Map(cells.map((e,i)=>[`e:${e.id}`,at(g,e.id).y+e.height-[8,20,12,6][i]]))}})!;
  eq(again.moves,false,'idempotent on lines');
  // The same settled-tracks rule fixes boxes of mixed sizes: a crystallized grid stays put.
  const mixed=figure([rect('a',0,0,50,40),rect('b',70,3,60,40),rect('c',2,62,100,40),rect('d',131,60,60,40)]),once=applied(mixed);
  ok(regular(once),'a mixed-size grid crystallizes into a recognized grid');eq(auto(once)!.moves,false,'and is not re-spaced by a second press');
}
{
  // Real plots: the lines ARE the Align pane's landmarks.
  const row=figure([plotEl('p1',20,40),plotEl('p2',300,70,300,180),plotEl('p3',640,22,200,120)]),lines=linesOf(row);
  for(const e of row.elements){
    near(lines.y!.get('e:'+e.id)!,resolveUnitSpine({key:'e:'+e.id,members:[e]},'x',plotCtx).landmark!.coordinate,'a row shares the canvas Y of each bottom X spine');
    near(lines.x!.get('e:'+e.id)!,resolveUnitSpine({key:'e:'+e.id,members:[e]},'y',plotCtx).landmark!.coordinate,'a column the canvas X of each left Y spine');
  }
  const after=onAxes(row),settled=linesOf(after);
  near(spread([...settled.y!.values()]),0,'three plots of different sizes end with ONE X-axis line');ok(spread(after.elements.map(e=>e.y+e.height))>5,'which no box edge could have given');
  ok(spread(after.elements.map(e=>e.y))>1,'their tops differ as well');ok(regular(after),'and the pink guides recognize the row');
  near(after.elements[1].x-after.elements[0].x-240,after.elements[2].x-after.elements[1].x-300,'even gaps between the plots\' boxes');
  eq(planAutoArrangement(createArrangementSnapshot(after),{lines:settled})!.moves,false,'pressing again changes nothing');
  const column=figure([plotEl('p1',40,20),plotEl('p2',70,200,300,180),plotEl('p3',22,420,200,120)]),stacked=onAxes(column);
  near(spread([...linesOf(stacked).x!.values()]),0,'a column of plots shares its Y-axis line');ok(regular(stacked));
  const four=figure([plotEl('p1',20,30),plotEl('p2',300,44,300,180),plotEl('p3',31,260,200,120),plotEl('p4',290,250)]),grid=onAxes(four),gl=linesOf(grid);
  near(gl.y!.get('e:p1')!,gl.y!.get('e:p2')!,'grid rows share X axes');near(gl.y!.get('e:p3')!,gl.y!.get('e:p4')!);near(gl.x!.get('e:p1')!,gl.x!.get('e:p3')!,'grid columns share Y axes');near(gl.x!.get('e:p2')!,gl.x!.get('e:p4')!);ok(regular(grid),'and the grid is recognized');
  // Who has a line. Several panels: the outermost main spine, with nobody to ask.
  const many={...plotEl('m',0,0,900,600),assetId:'multi'} as Element,manyLines=plotAxisLines([{key:'e:m',members:[many]},{key:'e:p1',members:[row.elements[0]]}],plotCtx);
  const candidates=(axis:'x'|'y')=>resolveUnitSpine({key:'e:m',members:[many]},axis,plotCtx).candidates.filter(c=>c.eligible&&!c.inset&&c.axisKey===axis&&c.side===(axis==='x'?'bottom':'left')).map(c=>c.coordinate!);
  ok(candidates('x').length>1&&!resolveUnitSpine({key:'e:m',members:[many]},'x',plotCtx).landmark,'a plot of several panels has no single landmark');
  eq(manyLines.y!.get('e:m'),Math.max(...candidates('x')),'its row line is the LOWEST bottom spine');eq(manyLines.x!.get('e:m'),Math.min(...candidates('y')),'its column line the LEFTMOST left spine');
  eq(plotAxisLines([{key:'e:p1',members:[row.elements[0]]},{key:'e:r',members:[rect('r',0,0)]}],plotCtx),{},'a unit without a plot: no lines at all');
  eq(plotAxisLines([{key:'e:p1',members:[row.elements[0]]}],plotCtx),{},'one unit is no arrangement');
  const noSpine=linesOf(figure([plotEl('p1',20,40),plotEl('p2',300,70,240,144,{overrides:{'axis.x.spine':{hidden:true}}})]));
  eq([!!noSpine.x,!!noSpine.y],[true,false],'a hidden bottom spine drops the row line and keeps the column line');
  const turned=linesOf(figure([plotEl('p1',20,40),plotEl('p2',300,70,240,144,{rotation:90})]));eq(turned,{},'a turned plot has no horizontal X spine: boxes');
  eq(linesOf(row,{...plotCtx,plotRoot:()=>undefined}),{},'unprepared geometry never becomes a line');
  // A plot grouped with its letter is one unit on its plot's axes; a locked member is not.
  const lettered=figure([plotEl('p1',20,40),{...plotEl('p2',300,70,300,180),groupId:'g'} as Element,{...rect('letter',280,60,14,14),groupId:'g'} as Element]);
  lettered.groups={g:{id:'g',name:'B',parentId:null}} as Figure['groups'];
  const ll=linesOf(lettered);ok(ll.y?.has('g:g')&&ll.y.has('e:p1'),'a group of one plot and its letter carries the plot\'s lines');
  const moved=onAxes(lettered);near(spread([...linesOf(moved).y!.values()]),0);eq(at(moved,'letter').x-at(moved,'p2').x,-20,'and the letter rides along');
  (at(lettered,'letter') as Element & {locked?:boolean}).locked=true;eq(linesOf(lettered),{},'a group that cannot move whole has no line');
  // The shared op: lines in, axes out; "boxes" ignores them; "axes" refuses to fall back.
  const viaOp=project(structuredClone(row));arrangePanels(viaOp,'f',{mode:'auto',lines,anchorX:'center',anchorY:'center'});eq(viaOp.figures[0].elements,after.elements,'arrange --mode auto with lines is the same plan');
  const boxed=project(structuredClone(row));arrangePanels(boxed,'f',{mode:'auto',lines,on:'boxes',anchorX:'center',anchorY:'center'});eq(boxed.figures[0].elements,applied(row).elements,'on boxes is the bounding-box plan');
  assert.throws(()=>arrangePanels(project(structuredClone(row)),'f',{mode:'auto',on:'axes'}),/No axes to line up on/);checks++;
  assert.throws(()=>arrangePanels(project(structuredClone(row)),'f',{mode:'reflow',on:'axes'}),/mode auto only/);checks++;
  assert.throws(()=>arrangePanels(project(structuredClone(row)),'f',{on:'boxes'}),/mode auto only/);checks++;
}

// --- 8. The editor's controller -----------------------------------------------------------
const store=await import('../src/lib/store');
const ctrl=await import('../src/lib/interact/alignArrange');
const toast=await import('../src/lib/toast');
const load=(elements:Element[],selected=elements.map(e=>e.id))=>{ctrl.closeAlignArrange();ctrl.crystallizeNotice.set(null);store.loadProject(project(figure(structuredClone(elements))),null);store.activeFigureId.set('f');store.selection.set(new Set(selected));store.resetHistory();store.dirty.set(false);};
const model=()=>get(store.project).figures[0].elements;
const stop=[ctrl.crystallizeOffer.subscribe(()=>{}),ctrl.passiveArrangement.subscribe(()=>{})];
ctrl.setArrangementAnchor(.5,.5);
load(orange);
{
  const offer=get(ctrl.crystallizeOffer)!;
  ok(offer,'a loose selection has an offer');eq([offer.topology,offer.rows,offer.cols,offer.count],['grid',3,3,9]);eq(get(ctrl.passiveArrangement),null,'and no guides yet');
  eq(model(),orange,'an offer moves nothing');eq(store.historyStats().past,0);
  const notice=ctrl.crystallizeSelection()!;
  eq([notice.topology,notice.rows,notice.cols,notice.count,notice.changed],['grid',3,3,9,true]);eq(ctrl.crystallizeLabel(notice),'Grid 3 × 3');
  eq(model(),applied(figure(orange)).elements,'the editor writes the planner\'s positions');
  eq(store.historyStats().past,1,'Crystallize is one Undo step');eq(get(store.dirty),true);
  eq(get(ctrl.crystallizeOffer),null,'the offer is spent');ok(get(ctrl.passiveArrangement),'the passive guides take over');
  eq(get(ctrl.crystallizeNotice)?.id,notice.id);
  const again=ctrl.crystallizeSelection()!;eq(again.changed,false,'a second press recognizes the same grid');eq(store.historyStats().past,1,'and adds no history');
  store.undo();eq(model(),orange,'Undo restores every hand-placed position');ok(get(ctrl.crystallizeOffer),'and the offer returns');
}
{
  // The session's fixed point is honoured, and a regular selection is never "improved".
  load(orange);ctrl.setArrangementAnchor(0,0);ctrl.crystallizeSelection();
  const b0=createArrangementSnapshot(figure(orange)).bounds,b1=createArrangementSnapshot(get(store.project).figures[0]).bounds;
  near(b1.x,b0.x,'top-left fixed point (x)');near(b1.y,b0.y,'top-left fixed point (y)');ctrl.setArrangementAnchor(.5,.5);
  const centered=[rect('a',0,0,40,100),rect('b',60,30,20,40),rect('c',100,40,20,20)];load(centered);
  ok(get(ctrl.passiveArrangement),'an even, center-aligned row of mixed sizes is already regular');eq(get(ctrl.crystallizeOffer),null,'and already crystallized: no offer');
  eq(ctrl.crystallizeSelection()?.changed,false);eq(model(),centered,'Shift+A leaves it exactly alone');eq(store.historyStats().past,0);
  // Evenly spaced is not yet crystallized: the owner's blue column has equal gaps and a middle
  // box pushed sideways. It keeps its guides, gets the offer, and keeps its gap EXACTLY.
  const column=[rect('b1',537.815,379.667),rect('b2',546.425,445.2696),rect('b3',537.815,510.8722)];load(column);
  ok(get(ctrl.passiveArrangement),'equal gaps: the guides already show');const offered=get(ctrl.crystallizeOffer)!;ok(offered,'one box sideways: the offer shows too');eq(offered.topology,'column');
  eq(ctrl.crystallizeSelection()?.changed,true);eq(new Set(model().map(e=>e.x)).size,1,'the column lines up');
  eq(model().map(e=>e.y),column.map(e=>e.y),'and an already-even gap is not touched');eq(get(ctrl.crystallizeOffer),null);
  // An exact grid keeps its own fractional gaps: nothing to offer, nothing rounded.
  const exact=Array.from({length:9},(_,i)=>rect(`e${i}`,86.125+(i%3)*89.545,81.08+Math.floor(i/3)*74.018,56.326,57.602));load(exact);
  eq(get(ctrl.crystallizeOffer),null,'a regular grid with 33.219 / 16.416 gaps is offered nothing');eq(ctrl.crystallizeSelection()?.changed,false);eq(model(),exact);
  // Plots: an even row whose boxes do not line up is usually aligned on its spines. No offer;
  // the key is still a decision.
  const plot=(id:string,x:number,y:number,h:number):Element=>({id,type:'plot',assetId:'asset',x,y,width:60,height:h,rotation:0} as Element);
  const plots=[plot('p1',0,0,80),plot('p2',80,7,90),plot('p3',160,3,70)];load(plots);
  ok(get(ctrl.passiveArrangement),'an even row of plots has its guides');eq(get(ctrl.crystallizeOffer),null,'and no offer to disturb its spines');
  eq(ctrl.crystallizeSelection()?.changed,true,'Shift+A still lines the boxes up when asked');store.undo();eq(model(),plots);
  load([plot('p1',0,0,80),plot('p2',83,7,90),plot('p3',160,3,70)]);ok(get(ctrl.crystallizeOffer),'a loose row of plots is offered like anything else');
  eq(get(ctrl.crystallizeOffer)!.onAxes,false,'plots whose axes cannot be read are offered their boxes');
}
{
  // Plots with readable axes: the offer, the key and the notice are all on axes; Alt is boxes.
  const plotStore=await import('../src/lib/plot/store');
  const loadPlots=(elements:Element[])=>{load(elements);plotStore.cachePlot('box',boxText.svg,boxText.manifest);store.selection.set(new Set(elements.map(e=>e.id)));};
  const live=():SpineContext=>({manifest:id=>get(plotStore.plotManifests)[id],plotRoot:id=>plotStore.plotDom.get(id)});
  const liveLines=()=>{const f=get(store.project).figures[0];return selectionAxisLines(f,undefined,{...live(),figure:f});};
  const row=[plotEl('p1',20,40),plotEl('p2',300,70,300,180),plotEl('p3',640,22,200,120)];loadPlots(row);
  const offer=get(ctrl.crystallizeOffer)!;ok(offer,'a loose row of fluxplots has an offer');eq([offer.onAxes,offer.topology,offer.rails.length],[true,'row',1],'on axes, with the shared X-axis line to preview');
  ok(offer.boxes&&offer.boxes.plan.positions.some((p,i)=>p.y!==offer.plan.positions[i].y),'and the bounding-box plan Alt would apply instead');
  eq(ctrl.crystallizeLabel(offer),'Row of 3 · on axes');
  const notice=ctrl.crystallizeSelection()!;eq([notice.onAxes,notice.changed,ctrl.crystallizeLabel(notice)],[true,true,'Row of 3 · on axes']);eq(store.historyStats().past,1,'one Undo step');
  near(spread([...liveLines().y!.values()]),0,'Shift+A puts the three X axes on one line');ok(get(ctrl.passiveArrangement),'the pink guides appear');eq(get(ctrl.crystallizeOffer),null,'and the offer is spent');
  eq(ctrl.crystallizeSelection()?.changed,false,'a second press changes nothing');eq(store.historyStats().past,1);
  // Alt on the same selection: the boxes, one more step, and the notice says so by omission.
  const boxed=ctrl.crystallizeSelection({boxes:true})!;eq([boxed.onAxes,boxed.changed,ctrl.crystallizeLabel(boxed)],[false,true,'Row of 3'],'Shift+Alt+A lines the boxes up instead');eq(store.historyStats().past,2);
  ok(spread([...liveLines().y!.values()])>1,'which takes the axes off their line');ok(get(ctrl.passiveArrangement),'still a recognized row');
  eq(get(ctrl.crystallizeOffer),null,'boxes were a decision: the axes are not offered straight back');
  const returned=ctrl.crystallizeSelection()!;eq([returned.onAxes,returned.changed],[true,true],'Shift+A still puts them on their axes');store.undo();
  store.undo();store.undo();eq(model(),row,'Undo restores the hand-placed plots');
  // Evenly spaced AND on their axes: nothing to offer, whatever the boxes do.
  loadPlots(row);ctrl.crystallizeSelection();const settled=structuredClone(model());loadPlots(settled);
  eq(get(ctrl.crystallizeOffer),null,'plots already on their axes are offered nothing');eq(ctrl.crystallizeSelection()?.changed,false);eq(model(),settled);
  // Evenly spaced boxes whose axes do not line up now get the offer the old rule withheld.
  const even=[plotEl('p1',0,0),plotEl('p2',260,30,300,180),plotEl('p3',580,10,200,120)];loadPlots(even);
  ok(get(ctrl.passiveArrangement),'an even row of plots has its guides');ok(get(ctrl.crystallizeOffer)?.onAxes,'and, lined up on nothing, an offer to put it on its axes');
  // Many plots are not read on the selection path: no offer, and the key still finds the axes.
  const crowd=Array.from({length:ctrl.CRYSTALLIZE_AXES_OFFER_UNITS+1},(_,i)=>plotEl(`c${i}`,(i%7)*260+(i%3)*4,Math.floor(i/7)*170+(i%2)*9,240-(i%4)*20,144-(i%4)*12));loadPlots(crowd);
  eq(get(ctrl.crystallizeOffer),null,'past the limit a selection of plots is offered nothing');const crowded=ctrl.crystallizeSelection()!;eq([crowded.topology,crowded.cols,crowded.onAxes,crowded.changed],['grid',7,true,true],'Shift+A still reads every axis');
  // A mixed selection is a box arrangement.
  loadPlots([plotEl('p1',20,40),plotEl('p2',300,70,300,180),rect('r',652,60,240,150)]);eq(get(ctrl.crystallizeOffer)?.onAxes,false,'a plot beside a rectangle lines up by box');
}
{
  eq(ctrl.crystallizeLabel({topology:'row',rows:1,cols:3,count:3}),'Row of 3');eq(ctrl.crystallizeLabel({topology:'column',rows:4,cols:1,count:4}),'Column of 4');
  // Refusals say why and write nothing.
  const said=()=>get(toast.toasts).map(t=>t.msg);
  load([rect('a',0,0),rect('b',10,6)]);eq(get(ctrl.crystallizeOffer),null);eq(ctrl.crystallizeSelection(),null);ok(said().some(m=>/on top of each other/.test(m)),'a pile is explained');eq(store.historyStats().past,0);
  load(orange,['o1']);eq(get(ctrl.crystallizeOffer),null);eq(ctrl.crystallizeSelection(),null);ok(said().some(m=>/two or more/.test(m)),'one object is explained');
  load([rect('a',0,0,50,50),rect('b',2,60,50,50),rect('c',0,125,50,50),rect('tall',60,0,50,175)]);eq(get(ctrl.passiveArrangement),null);eq(get(ctrl.crystallizeOffer),null);eq(ctrl.crystallizeSelection(),null);ok(said().some(m=>/spans several/.test(m)),'a spanning layout is explained');eq(store.historyStats().past,0);
  // The tool owns its own visit: no offer and no action while Align & Arrange is open.
  load([rect('a',0,0,50,50),rect('b',0,60,50,50),rect('tall',60,0,50,110)]);ok(get(ctrl.passiveArrangement),'an exact spanning layout is recognized as it stands');eq(get(ctrl.crystallizeOffer),null);eq(ctrl.crystallizeSelection()?.changed,false,'and Shift+A names it without touching it');eq(store.historyStats().past,0);
  load(orange);ctrl.openAlignArrange('align');eq(get(ctrl.crystallizeOffer),null,'no offer while the tool is open');eq(ctrl.crystallizeSelection(),null);eq(model(),orange);ctrl.closeAlignArrange();
  ok(get(ctrl.crystallizeOffer),'closing the tool brings the offer back');
  // The corner offer is for objects of comparable size; the key does not judge.
  const uneven=[rect('big',0,0,200,150),rect('small',230,60,20,20),rect('big2',280,3,200,150)];load(uneven);
  eq(get(ctrl.crystallizeOffer),null,'a 75× size spread gets no offer');eq(ctrl.crystallizeSelection()?.topology,'row','Shift+A still makes the row');store.undo();
  // Other tools and drilled parts are not layout selections.
  store.activeTool.set('rect');eq(get(ctrl.crystallizeOffer),null);store.activeTool.set('select');
  // Past the eager limit the corner offer is skipped; the key still plans on demand.
  const many=Array.from({length:ctrl.CRYSTALLIZE_OFFER_UNITS+1},(_,i)=>rect(`e${i}`,(i%30)*70+Math.sin(i)*6,Math.floor(i/30)*70+Math.cos(i)*6));
  load(many);eq(get(ctrl.crystallizeOffer),null,'no per-selection planning above the limit');
  const big=ctrl.crystallizeSelection()!;eq([big.topology,big.cols,big.changed],['grid',30,true],'Shift+A still crystallizes a large selection');eq(store.historyStats().past,1);
}
for(const unsubscribe of stop)unsubscribe();

// --- 9. The file engine: `flux arrange --mode auto` reads the same axes from the saved sources ---
{
  const os=await import('node:os'),path=await import('node:path');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flux-crystallize-core-'));
  try{
    process.env.HOME=path.join(scratch,'home');process.env.XDG_CONFIG_HOME=path.join(scratch,'home','.config');process.env.FLUX_NO_MIGRATE='1';
    fs.mkdirSync(process.env.XDG_CONFIG_HOME,{recursive:true});
    const {arrangeFigure}=await import('../flux-core/figures');
    const {loadFigModel}=await import('../flux-core/model');
    const root=path.join(scratch,'project');
    for(const dir of ['fig/assets','fig/canvases','fig/captions'])fs.mkdirSync(path.join(root,dir),{recursive:true});
    const write=(file:string,value:unknown)=>fs.writeFileSync(path.join(root,file),JSON.stringify(value,null,2));
    const row=[plotEl('p1',20,40),plotEl('p2',300,70,300,180),plotEl('p3',640,22,200,120)],loose=rect('r',40,300,240,150),plain={...plotEl('s',330,310),assetId:'plain'} as Element;
    write('project.json',{schemaVersion:'0.1.0',id:'crystallize-test',title:'Crystallize test',manuscript:{path:'paper/main.qmd'},references:{library:'references/library.bib'},figures:[]});
    write('fig/index.json',{schemaVersion:'0.1.0',canvases:[{id:'canvas',name:'Canvas',order:1}],figures:[{id:'figure',name:'Figure',label:'fig-crystallize',order:1,kind:'main',canvas:'canvas',caption:''}],assets:[{id:'box',name:'Box',kind:'svg',path:'assets/box.svg',naturalWidth:240,naturalHeight:144},{id:'plain',name:'Plain',kind:'svg',path:'assets/plain.svg',naturalWidth:240,naturalHeight:144}],palette:[],colorGroups:[]});
    const seed=()=>write('fig/canvases/canvas.json',{schemaVersion:'0.1.0',id:'canvas',name:'Canvas',figures:[{id:'figure',name:'Figure',canvasId:'canvas',x:0,y:0,width:900,height:500,background:'#ffffff',elements:[...row,loose,plain]}]});
    fs.writeFileSync(path.join(root,'fig/assets/box.svg'),boxText.svg);fs.writeFileSync(path.join(root,'fig/assets/box.fluxplot.json'),JSON.stringify(boxText.manifest));
    fs.writeFileSync(path.join(root,'fig/assets/plain.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="144" viewBox="0 0 240 144"><rect width="240" height="144" fill="#eeeeee"/></svg>');
    const saved=async()=>(await loadFigModel(root)).project.figures[0];
    const canvas=()=>fs.readFileSync(path.join(root,'fig/canvases/canvas.json'),'utf8');
    const ids=row.map(e=>e.id),expected=(lines?:LayoutLines)=>{const f=figure(structuredClone(row));const p=project(f);arrangePanels(p,'f',{mode:'auto',lines});return f.elements;};
    seed();await arrangeFigure(root,'figure',{mode:'auto',ids});
    let after=await saved();eq(after.elements.slice(0,3).map(e=>[e.x,e.y]),expected(linesOf(figure(structuredClone(row)))).map(e=>[e.x,e.y]),'the file engine writes the on-axes plan the planner makes from the same sources');
    near(spread([...selectionAxisLines(after,ids,{...plotCtx,figure:after}).y!.values()]),0,'saved and reopened, the three X axes share one line');eq(after.elements.slice(3),[loose,plain],'objects outside ids are untouched');
    const settled=canvas();await arrangeFigure(root,'figure',{mode:'auto',ids});eq(canvas(),settled,'a second run writes nothing new');
    seed();await arrangeFigure(root,'figure',{mode:'auto',ids,on:'boxes'});after=await saved();eq(after.elements.slice(0,3).map(e=>[e.x,e.y]),expected().map(e=>[e.x,e.y]),'on boxes is the bounding-box plan');
    // Not all readable plots: the default falls back to boxes, "axes" refuses and writes nothing.
    seed();await arrangeFigure(root,'figure',{mode:'auto',ids:['p1','p2','r']});after=await saved();
    {const f=figure(structuredClone([row[0],row[1],loose]));arrangePanels(project(f),'f',{mode:'auto'});eq(after.elements.filter(e=>['p1','p2','r'].includes(e.id)).map(e=>[e.x,e.y]),f.elements.map(e=>[e.x,e.y]),'a plot beside a rectangle is arranged by box');}
    seed();const before=canvas();
    await assert.rejects(arrangeFigure(root,'figure',{mode:'auto',ids:['p1','p2','r'],on:'axes'}),/No axes to line up on/);checks++;eq(canvas(),before,'a refused on axes leaves the saved canvas byte-identical');
    await assert.rejects(arrangeFigure(root,'figure',{mode:'auto',ids:['p1','p2','s'],on:'axes'}),/No axes to line up on/);checks++;
    await arrangeFigure(root,'figure',{mode:'auto',ids:['p1','p2','s']});ok(canvas()!==before,'a plain SVG beside fluxplots still crystallizes, by box');
    eq(fs.readFileSync(path.join(root,'fig/assets/box.svg'),'utf8'),boxText.svg,'plot sources are never written');
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
console.log(`PASS crystallize: recognition, shapes, alignment, axes, fixed point, shared op, file engine and controller (${checks} checks)`);
