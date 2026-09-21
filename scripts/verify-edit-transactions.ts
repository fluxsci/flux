import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
const s = await import('../src/lib/store');
const { editSession } = await import('../src/lib/interact/editSession');
function seed() { s.loadProject({version:2,name:'atomic',canvases:[{id:'c',name:'C'}],figures:[{id:'f',canvasId:'c',name:'Figure 1',x:0,y:0,width:680,height:400,elements:[]}],assets:[],palette:[]},null); }
const width = () => get(s.project).figures[0].width;
function state() { return JSON.stringify({model:get(s.project),history:s.historyStats(),dirty:get(s.dirty),available:get(s.historyAvailability),canvas:get(s.activeCanvasId),figure:get(s.activeFigureId)}); }
seed(); s.commit(p=>{p.figures[0].width=701}); s.undo(); s.dirty.set(false);
for (const where of ['before','after','adapter-before','adapter-after']) {
  const before=state();
  let companion=7;
  const offComp=s.registerHistoryCompanion({capture:()=>companion,restore:v=>{companion=v as number}});
  const off=s.registerEditorTransactionAdapter({before:()=>{if(where==='adapter-before') {companion=99;throw Error(where)}},after:()=>{if(where==='adapter-after'){companion=99;throw Error(where)}}});
  assert.throws(()=>s.commit(p=>{if(where==='before') throw Error(where);p.figures[0].width=999;companion=99;if(where==='after')throw Error(where)}));
  assert.equal(state(),before,where);assert.equal(companion,7);off();offComp();
}
seed(); s.commit(p=>{p.figures[0].width=700;s.commit(q=>{q.figures[0].height=200})});
assert.equal(s.historyStats().past,1);s.undo();assert.equal(width(),680);assert.equal(get(s.project).figures[0].height,400);
seed(); const session=editSession();session.run(()=>s.mutate(p=>{p.figures[0].width=321}));
const captured=structuredClone(get(s.project));s.capturePersistenceGeneration();
session.run(()=>s.mutate(p=>{p.figures[0].width=444}));session.cancel();
assert.equal(width(),680);assert.equal(captured.figures[0].width,321);assert.equal(get(s.dirty),true,'cancel stays dirty while captured preview saves');assert.equal(s.historyStats().past,0);
seed();s.commit(p=>{p.figures[0].width=700});s.undo();const before=state();const preview=editSession();preview.run(()=>s.mutate(p=>{p.figures[0].width=333}));preview.cancel();assert.equal(state(),before,'cancel restores redo and dirty');
seed();s.addCanvas();s.undo();assert.equal(get(s.activeCanvasId),'c');assert.equal(get(s.activeFigureId),'f');
s.loadProject(structuredClone(get(s.project)),null,{reload:true});assert.equal(get(s.historyAvailability).undo,true);assert.equal(get(s.historyAvailability).redo,false);
console.log('EDIT TRANSACTIONS: PASS (throwing callbacks/adapters, companion, nested commit, captured save cancellation, redo, active IDs/reload)');
