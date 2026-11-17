// Crystallize (Shift+A; headless `arrange --mode auto`): recognize the row, column or grid a
// loose selection is closest to and plan it outright. Pure planner, the shared op, and the
// editor's controller (offer, one-Undo action, notice) on real stores.
import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
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

// --- 7. The editor's controller -----------------------------------------------------------
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
console.log(`PASS crystallize: recognition, shapes, alignment, fixed point, shared op and controller (${checks} checks)`);
