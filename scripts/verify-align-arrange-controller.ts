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

// The mounted canvas subscribes to passive recognition. Its immutable baseline
// is reusable only for the same settled targeting inputs, never an owned edit.
const stopRecognition=ctrl.passiveArrangement.subscribe(()=>{});
load([rect('a',0),rect('b',40),rect('c',80)]);
const recognized=get(ctrl.passiveArrangement)!;
ok(recognized,'regular selection is recognized before opening');
ctrl.openAlignArrange('arrange');
ok(get(ctrl.arrangementLayout)?.units===recognized.units,'direct open reuses the exact recognized baseline');
eq(get(ctrl.passiveArrangement),null,'active ownership disables passive recognition');
ctrl.setArrangementGap('x',45);const edited=positions();ctrl.closeAlignArrange();
ok(JSON.stringify(edited)!==JSON.stringify(start),'owned edits advance beyond reused entry');
const editedRecognition=get(ctrl.passiveArrangement)!;
ctrl.openAlignArrange('arrange');
ok(get(ctrl.arrangementLayout)?.units===editedRecognition.units,'reopen recognizes the settled model, not the former baseline');
eq(positions(),edited,'reopen leaves settled coordinates exact');ctrl.closeAlignArrange();
store.undo();eq(positions(),start,'Undo restores the original reused baseline');
const undoRecognition=get(ctrl.passiveArrangement)!;
ok(undoRecognition.units!==editedRecognition.units,'Undo invalidates recognition even with unchanged selection IDs');
ctrl.openAlignArrange('arrange');
ok(get(ctrl.arrangementLayout)?.units===undoRecognition.units,'opening after Undo consumes the restored model');
eq(positions(),start);eq(store.historyStats().past,0,'identity reopen creates no Undo checkpoint');ctrl.closeAlignArrange();
store.redo();eq(positions(),edited,'Redo retains the accepted owned edit');

// Publishing the same mutable selection object still invalidates recognition.
const narrowed=get(store.selection);narrowed.delete('c');store.selection.set(narrowed);
ctrl.openAlignArrange('align');eq(get(ctrl.alignArrange)?.units.map(u=>u.id),['e:a','e:b'],'changed selection cannot reuse stale membership');ctrl.closeAlignArrange();
const firstX=positions()[0].x;
store.commit(p=>{p.figures[0].elements[1].x=200;});
ctrl.openAlignArrange('align');eq(get(ctrl.alignArrange)?.gapX,200-firstX-20,'published in-place geometry invalidates recognition');
// Refreshes inside an active Align owner must continue to capture its model.
ctrl.alignSelection('left');ctrl.switchAlignArrange('arrange');
ok(get(ctrl.alignArrange)?.status.includes('Suggested'),'owned alignment uses its new coincident geometry');ctrl.closeAlignArrange(true);

// Scope and exclusions alter rigid membership independently of element IDs.
load([rect('a',0),rect('b',40),rect('c',100)]);
store.commit(p=>{p.figures[0].groups={g:{id:'g',name:'Group'}};for(const e of p.figures[0].elements.slice(0,2))e.groupId='g';});
ctrl.openAlignArrange('align');eq(get(ctrl.alignArrange)?.count,2,'outer group is one rigid unit');ctrl.closeAlignArrange();
store.enteredGroupId.set('g');
ctrl.openAlignArrange('align');eq(get(ctrl.alignArrange)?.units.map(u=>u.id),['e:a','e:b','e:c'],'entered scope invalidates rigid-unit recognition');ctrl.closeAlignArrange();
store.enteredGroupId.set(null);store.setEditorSelectionExclusions(new Set(['b']));
ctrl.openAlignArrange('arrange');
eq(get(ctrl.arrangementLayout)?.units.find(u=>u.key==='g:g')?.memberIds,['a'],'excluded group descendant cannot reappear from an old baseline');
eq(get(store.project).figures[0].elements.find(e=>e.id==='b')?.x,40,'excluded companion remains untouched');ctrl.closeAlignArrange(true);
store.setEditorSelectionExclusions(new Set());store.selection.set(new Set(['a','b','c']));
store.commit(p=>{p.figures.push({...p.figures[0],id:'other',elements:[rect('other-a',500),rect('other-b',540)]});});
store.activeFigureId.set('other');ctrl.openAlignArrange('align');
eq(get(ctrl.alignArrange)?.count,0,'active figure change cannot reuse a different figure baseline');ctrl.closeAlignArrange();
store.selection.set(new Set(['other-a','other-b']));ctrl.openAlignArrange('arrange');
eq(get(ctrl.alignArrange)?.bounds?.x,500,'new figure owns its own geometry');ctrl.closeAlignArrange();
store.activeFigureId.set('f');store.selection.set(new Set(['a','b','c']));
ctrl.openAlignArrange('arrange');
store.commit(p=>{p.figures[0].elements[0].x=-100;});
eq(get(ctrl.alignArrange),null,'foreign publication closes a reused owner');
ctrl.openAlignArrange('align');eq(get(ctrl.alignArrange)?.bounds?.x,-100,'reopen after foreign close uses the incoming model');ctrl.closeAlignArrange();
stopRecognition();

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
