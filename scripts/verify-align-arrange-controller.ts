import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import type { Project,Element,SemanticPlotElement } from '../src/lib/types';
import type { FluxPlotManifest } from '../src/lib/plot/types';
const store=await import('../src/lib/store');
const ctrl=await import('../src/lib/interact/alignArrange');
const plots=await import('../src/lib/plot/store');
let checks=0;
const eq=(a:unknown,b:unknown,label?:string)=>{assert.deepEqual(a,b,label);checks++;};
const ok=(a:unknown,label:string)=>{assert.ok(a,label);checks++;};
const rect=(id:string,x:number,y=0):Element=>({id,type:'rect',x,y,width:20,height:20,rotation:0,fill:'#123456',stroke:'none',strokeWidth:0,cornerRadius:0});
const make=(elements:Element[]):Project=>({version:2,name:'Controller',canvases:[{id:'c',name:'C'}],figures:[{id:'f',canvasId:'c',name:'F',x:0,y:0,width:800,height:600,elements}],assets:[],palette:[]});
function load(elements:Element[]){ctrl.closeAlignArrange();store.loadProject(make(elements),null);store.activeFigureId.set('f');store.selection.set(new Set(elements.map(e=>e.id)));store.resetHistory();store.dirty.set(false);}
const positions=()=>get(store.project).figures[0].elements.map(e=>({id:e.id,x:e.x,y:e.y}));
load([rect('a',0),rect('b',40),rect('c',80)]);
const start=positions();ctrl.openAlignArrange('arrange');eq(store.historyStats().past,0,'regular open owns no checkpoint');
ctrl.beginArrangementField('x');ctrl.setArrangementGap('x',30);eq(positions(),start,'numeric preview is transient');ok(get(ctrl.arrangementPreview),'preview is published');
ctrl.cancelArrangementField();eq(positions(),start);eq(get(ctrl.arrangementPreview),null);eq(store.historyStats().past,0);
ctrl.setArrangementGap('x',35);const accepted=positions();ok(JSON.stringify(accepted)!==JSON.stringify(start),'accepted value moves model');eq(store.historyStats().past,1);
ctrl.beginArrangementField('x');ctrl.setArrangementGap('x',50);ctrl.cancelArrangementField();eq(positions(),accepted,'inner Escape preserves earlier settled preview');
ctrl.closeAlignArrange(true);eq(positions(),start,'visit Escape restores entry');eq(store.historyStats().past,0);eq(get(store.dirty),false);

// Acceptance inside anchor switching must not republish stale old bounds/gaps.
ctrl.openAlignArrange('arrange');ctrl.beginArrangementField('x');ctrl.setArrangementGap('x',45);ctrl.setArrangementAnchor(1,.5);
eq(get(ctrl.alignArrange)?.gapX,45,'anchor switch keeps accepted field value');const end=Math.max(...get(store.project).figures[0].elements.map(e=>e.x+e.width));
ctrl.setArrangementGap('x',60);eq(Math.max(...get(store.project).figures[0].elements.map(e=>e.x+e.width)),end,'new right pin uses current geometry');ctrl.closeAlignArrange(true);

// A foreign commit while a field is previewing must not accept that old plan.
ctrl.openAlignArrange('arrange');ctrl.beginArrangementField('x');ctrl.setArrangementGap('x',99);
store.commit(p=>{p.figures[0].elements[0].x=777;});eq(get(ctrl.alignArrange),null);eq(get(store.project).figures[0].elements[0].x,777,'foreign edit survives draft disposal');eq(get(store.project).figures[0].elements[1].x,40,'foreign close does not accept another old preview');

const plot=(id:string,x:number):SemanticPlotElement=>({id,type:'plot',assetId:'asset',x,y:0,width:40,height:40,rotation:0});
const manifest=()=>({spec:'fixture/unsupported'} as unknown as FluxPlotManifest);
const root=()=>({} as SVGSVGElement);
// Source hydration and replacement are different events. Unsupported semantics
// intentionally keep this policy fixture independent of DOM geometry parsing.
plots.plotDom.delete('asset');plots.plotManifests.set({asset:manifest()});load([plot('a',0),plot('b',60)]);ctrl.openAlignArrange('align');
const hydrated=root();plots.plotDom.set('asset',hydrated);plots.plotManifests.set({asset:manifest()});plots.plotGen.update(g=>({...g,asset:1}));
ok(get(ctrl.alignArrange),'first missing-root hydration keeps panel open');
plots.plotDom.set('asset',root());plots.plotGen.update(g=>({...g,asset:2}));eq(get(ctrl.alignArrange),null,'replacing accepted root closes stale owner');
ctrl.openAlignArrange('align');plots.plotManifests.set({asset:manifest()});eq(get(ctrl.alignArrange),null,'replacing accepted metadata closes stale owner');

load([plot('a',0),{...rect('label',10),groupId:'dangling',locked:true},plot('b',100)]);
get(store.project).figures[0].elements[0].groupId='dangling';
ctrl.openAlignArrange('align');ok(get(ctrl.alignArrange)?.plot?.reasonX?.includes('locked'),'dangling plot group includes locked annotation in preflight');ctrl.closeAlignArrange();
plots.plotDom.delete('asset');plots.plotManifests.set({});

// The scale path resolves ordinary units once and never fabricates thousands
// of plot-choice rows or runs semantic SVG inspections for rectangle units.
load(Array.from({length:5000},(_,i)=>rect('s'+i,(i%50)*30,Math.floor(i/50)*30)));
const t=performance.now();ctrl.openAlignArrange('align');const openMs=performance.now()-t;
eq(get(ctrl.alignArrange)?.count,5000);eq(get(ctrl.alignArrange)?.plot,undefined);eq(store.historyStats().past,0);ctrl.closeAlignArrange();
console.log(`##VERIFY## ${JSON.stringify({name:'align-arrange-controller',pass:true,checks,open5000Ms:openMs})}`);
