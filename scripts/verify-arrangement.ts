import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { createArrangementSnapshot, planArrangement, snapshotAfterArrangement, arrangementPin, resolveLayoutUnits, planAlignment } from '../src/lib/layout/arrangement';
import { arrangePanels, alignPanels, applyArrangementPlan, applyLayoutTranslations } from '../src/lib/ops';
import { selectionBBox, arrangeGrid } from '../src/lib/geometry';
import type { Figure,Project,RectElement } from '../src/lib/types';
let checks=0;
const eq=(a:unknown,b:unknown,message?:string)=>{assert.deepEqual(a,b,message);checks++;};
const near=(a:number,b:number)=>{assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);checks++;};
const rect=(id:string,x:number,y:number,w=20,h=20):RectElement=>({id,type:'rect',x,y,width:w,height:h,rotation:0,fill:'#222',stroke:'none',strokeWidth:0,cornerRadius:0});
const figure=(els:RectElement[]):Figure=>({id:'f',canvasId:'c',name:'F',x:100,y:100,width:900,height:600,elements:els});
const project=(f:Figure):Project=>({version:2,name:'Fixture',canvases:[{id:'c',name:'C'}],figures:[f],assets:[],palette:[]});
const freezeDeep=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeDeep(child);Object.freeze(value);}};
{
 const f=figure([rect('a',.1,1,.2,1),rect('b',.4,1,.2,1),rect('c',.7,1,.2,1)]),before=structuredClone(f);
 const s=createArrangementSnapshot(f),p=planArrangement(s);
 eq(s.topology,'row');eq(p.identity,true);eq(p.units===s.units&&p.positions===s.memberPositions,true,'exact identity reuses immutable baseline');applyArrangementPlan(project(f),'f',p);eq(f,before,'fractional regular entry is byte-identical');eq(createArrangementSnapshot(f,['c','a','b']),createArrangementSnapshot(f,['a','b','c']));
}
{
 const f=figure([rect('a',0,0,40,100),rect('b',60,30,20,40),rect('c',140,40,20,20)]),s=createArrangementSnapshot(f),original=structuredClone(s);
 freezeDeep(s);
 eq(s.topology,'row');eq(s.regularX,false);const p=planArrangement(s,{gapX:12.5});
 eq(p.positions.map(e=>e.y),f.elements.map(e=>e.y),'inferred row keeps scientific transverse offsets');
 const byKey=new Map(p.units.map(u=>[u.key,u.bounds]));near(byKey.get('e:b')!.x-byKey.get('e:a')!.x-40,12.5);near(byKey.get('e:c')!.x-byKey.get('e:b')!.x-20,12.5);eq(s,original,'planning never mutates baseline');
}
{
 const f=figure([rect('tall-right',300,0,40,1000),rect('left',0,400,40,20),rect('middle',100,400,40,20)]);
 eq(createArrangementSnapshot(f).orderedKeys,['e:left','e:middle','e:tall-right']);
}
{
 const f=figure([rect('a',0,0,40,20),rect('b',60,0,40,20),rect('c',0,40,10,20),rect('d',60,40,10,20)]),s=createArrangementSnapshot(f);
 freezeDeep(s);
 eq(s.topology,'grid');eq(s.suggested,false);eq(planArrangement(s).identity,true);
 const p=planArrangement(s,{gapX:10,anchor:{x:0,y:0}});eq(p.positions.map(e=>e.y),[0,0,40,40]);eq(p.positions.map(e=>e.x),[0,50,0,50],'inferred grid preserves left alignment within tracks');
 const reflow=planArrangement(s,{mode:'reflow',cols:2,gapX:10,gapY:20,anchor:{x:0,y:0}});eq(reflow.positions.map(e=>e.x),[0,50,15,65],'explicit reflow centers cells');
 const after=snapshotAfterArrangement(s,reflow);eq(after.orderedKeys,s.orderedKeys);eq(planArrangement(after).identity,true);eq(after.gapY,20);
 eq(p.gaps.map(g=>g.axis),['x','y']);
}
{
 const f=figure([rect('a',.1,.1,.2,.2),rect('b',.4,.1,.2,.2),rect('c',.7,.1,.2,.2),rect('d',.1,.4,.2,.2),rect('e',.4,.4,.2,.2),rect('g',.7,.4,.2,.2)]),s=createArrangementSnapshot(f);
 eq(s.topology,'grid');eq(planArrangement(s).identity,true);eq(planArrangement(s,{gapX:.15}).positions.map(e=>e.y),f.elements.map(e=>e.y),'X edit preserves exact fractional Y coordinates');
 const rebased=snapshotAfterArrangement(s,planArrangement(s,{gapX:.15}));eq(planArrangement(rebased).identity,true,'releasing unchanged gesture is exact identity');
}
for(const els of [
 [rect('a',0,0),rect('b',50,50),rect('c',100,100)],
 [rect('a',0,0,40,40),rect('b',10,10,40,40)],
 [rect('a',0,0),rect('b',60,0),rect('c',0,50),rect('d',120,50)],
 [rect('a',0,0,0,40),rect('b',20,0,0,40)],
])eq(createArrangementSnapshot(figure(els)).suggested,true,'ambiguous topology gets explicit fallback');
{
 const f=figure([rect('a',0,0),rect('b',50,0),rect('c',100,0),rect('d',0,50),rect('e',50,50)]),s=createArrangementSnapshot(f);
 eq(s.suggested,false);eq(s.cols,3);eq(s.rowCount,2);eq(planArrangement(s).identity,true,'ragged trailing row is recognized');
}
{
 const f=figure([rect('a',0,0),rect('b',20-1e-8,0),rect('c',40-2e-8,0)]),s=createArrangementSnapshot(f);
 eq(s.suggested,false);eq(s.gapX,0);eq(planArrangement(s).identity,true,'epsilon overlap at zero does not jump on open');
}
// Signed spacing keeps overlap usable, with conservative inference and exact
// entry identity. An arbitrary diagonal pile must not become a passive layout.
for(const axis of ['x','y'] as const){
 const f=figure(Array.from({length:4},(_,i)=>rect('overlap'+i,axis==='x'?i*12:0,axis==='y'?i*12:0,20,20)));
 const s=createArrangementSnapshot(f),before=structuredClone(s);
 freezeDeep(s);
 eq(s.suggested,false);eq(s.topology,axis==='x'?'row':'column');eq(axis==='x'?s.gapX:s.gapY,-8);
 eq(planArrangement(s).identity,true,'regular overlapping row/column entry is exact identity');
 for(const gap of [-4,-20,-45])for(const a of [0,.5,1] as const){
  const anchor={x:a,y:a},pin={x:120,y:240},p=planArrangement(s,{[axis==='x'?'gapX':'gapY']:gap,anchor,pin});
  near(axis==='x'?p.bounds.x+a*p.bounds.w:p.bounds.y+a*p.bounds.h,axis==='x'?pin.x:pin.y);
  eq(p.cells.map(c=>c.key),s.cells.map(c=>c.key),'negative gaps preserve logical track order');
  eq(p.units.map(u=>u.key),s.units.map(u=>u.key),'negative gaps preserve element order');
  eq(planArrangement(snapshotAfterArrangement(s,p)).identity,true,'frozen negative/reversed topology reopens without drift');
 }
 eq(s,before,'signed planning leaves frozen baseline intact');
}
for(const [gx,gy] of [[-8,-5],[-8,5],[5,-5]]){
 const f=figure(Array.from({length:8},(_,i)=>rect('grid'+i,(i%3)*(20+gx),Math.floor(i/3)*(20+gy))));
 const s=createArrangementSnapshot(f);
 eq(s.suggested,false);eq(s.topology,'grid');eq(s.cols,3);eq(s.rowCount,3);
 eq(s.gapX,gx);eq(s.gapY,gy);eq(planArrangement(s).identity,true,'regular overlapping ragged grid is exact identity');
}
for(const els of [[rect('same-a',0,0),rect('same-b',0,0)], [rect('diag-a',0,0),rect('diag-b',5,5),rect('diag-c',10,10)]])
 eq(createArrangementSnapshot(figure(els)).suggested,true,'coincident and diagonal overlaps stay ambiguous');
// Actual union is wider than the nominal summed extent for nested or reversed
// mixed-size tracks. Test inferred edits and explicit reflow at every anchor.
for(const mode of ['inferred','reflow'] as const)for(const cols of [1,2,3])for(const gap of [-10,-40,-200])for(const ax of [0,.5,1] as const)for(const ay of [0,.5,1] as const){
 const f=figure([rect('a',0,0,100,70),rect('b',130,0,20,30),rect('c',180,0,40,90),rect('d',0,140,15,20),rect('e',130,140,25,25)]);
 const original=createArrangementSnapshot(f);
 const baseline=planArrangement(original,{mode:'reflow',cols,gapX:10,gapY:10});
 const s=snapshotAfterArrangement(original,baseline),anchor={x:ax,y:ay},pin={x:73,y:91};
 const p=planArrangement(s,{...(mode==='reflow'?{mode:'reflow' as const,cols}:{}),gapX:gap,gapY:gap,anchor,pin});
 if(p.cols>1)near(p.bounds.x+ax*p.bounds.w,pin.x);
 if(p.rowCount>1)near(p.bounds.y+ay*p.bounds.h,pin.y);
 eq(p.units.map(u=>[u.key,u.bounds.w,u.bounds.h]),s.units.map(u=>[u.key,u.bounds.w,u.bounds.h]));
 for(const guide of p.gaps){assert.ok(guide.x2>=guide.x1&&guide.y2>=guide.y1);checks++;}
}
{
 const f=figure([rect('signed-a',0,0),rect('signed-b',40,0),rect('signed-c',80,0)]),p=project(f);
 arrangePanels(p,'f',{mode:'tidy',gap:-5,anchorX:'start'});
 eq(f.elements.map(e=>e.x),[0,15,30],'modern common gap accepts negative spacing');
}
// All anchors, many mixed sizes, every ragged shape: verify actual bounds, not
// only the formulas used to position the track origins.
for(let n=2;n<=14;n++)for(let cols=1;cols<=n;cols++)for(const ax of [0,.5,1] as const)for(const ay of [0,.5,1] as const){
 const f=figure(Array.from({length:n},(_,i)=>rect('r'+i,i*130,(i%3)*100,10+(i*17+n*3)%100,10+(i*31)%70))),s=createArrangementSnapshot(f),anchor={x:ax,y:ay},pin={x:155,y:273};
 const p=planArrangement(s,{mode:'reflow',cols,gapX:12.5,gapY:0,anchor,pin});
 applyArrangementPlan(project(f),'f',p);const b=selectionBBox(f.elements)!;near(b.x+ax*b.w,pin.x);near(b.y+ay*b.h,pin.y);
 eq(f.elements.map(e=>[e.width,e.height,e.rotation]),s.units.map(u=>[u.bounds.w,u.bounds.h,0]));
}
{
 const f=figure([rect('a',0,0),rect('b',100,100),rect('c',200,200)]),s=createArrangementSnapshot(f),a=planArrangement(s,{mode:'reflow',cols:3,gapX:10}),current=snapshotAfterArrangement(s,a);
 const pin=arrangementPin(current.bounds,{x:1,y:1});
 eq(planArrangement(current,{anchor:{x:1,y:1},pin}).identity,true,'anchor choice moves nothing');
 const b=planArrangement(current,{gapX:50,anchor:{x:1,y:1},pin});near(b.bounds.x+b.bounds.w,pin.x);near(b.bounds.y+b.bounds.h,pin.y);
 eq(planArrangement(s,{mode:'reflow',cols:3,gapX:10}),a,'reflow repeats deterministically');
}
{
 const f=figure([rect('a',0,0),rect('b',30,10),rect('other',200,50),{...rect('locked',400,50),locked:true}]);
 f.groups={outer:{id:'outer',name:'Outer'},inner:{id:'inner',name:'Inner',parentId:'outer'}};f.elements[0].groupId='inner';f.elements[1].groupId='outer';
 eq(resolveLayoutUnits(f,['a']).map(u=>u.memberIds),[['a','b']]);eq(resolveLayoutUnits(f,['a'],{scope:'outer'}).map(u=>u.memberIds),[['a']]);
 eq(resolveLayoutUnits(f).length,2);eq(resolveLayoutUnits(f,undefined,{editable:false}).length,3);eq(resolveLayoutUnits(f,[]).length,0);
 const p=project(f),old=structuredClone(f.elements[3]);arrangePanels(p,'f',{mode:'reflow',cols:2,gap:10,anchorX:'center'});
 near(f.elements[1].x-f.elements[0].x,30);near(f.elements[1].y-f.elements[0].y,10);eq(f.elements[3],old);
 assert.throws(()=>applyLayoutTranslations(p,'f',[{id:'other',dx:10,dy:0},{id:'locked',dx:10,dy:0}]));checks++;eq(f.elements[3],old);
 const before=structuredClone(f);assert.throws(()=>applyLayoutTranslations(p,'f',[{id:'other',dx:10,dy:0},{id:'missing',dx:10,dy:0}]));checks++;eq(f,before,'invalid batch is atomic');
}
{
 const f=figure([rect('a',10,20),rect('b',100,150,40,60)]),p=project(f);
 alignPanels(p,'f','left',['a','b'],{target:{unitKey:'e:b'}});eq(f.elements.map(e=>e.x),[100,100]);eq(f.elements.map(e=>e.y),[20,150]);
 alignPanels(p,'f','bottom',['a'],{target:'figure'});eq(f.elements[0].y,580);
 assert.throws(()=>planAlignment(f,['a'],'left',{target:{unitKey:'e:b'}}));checks++;
}
// Compatibility: wrapper uses the old arithmetic for explicit layout, including
// signed gap and precedence when both cols and rows exist.
{
 const seed=figure([rect('a',15,30,30,40),rect('b',75,20,70,30),rect('c',180,110,10,50)]),a=structuredClone(seed),b=structuredClone(seed);
 arrangePanels(project(a),'f',{cols:2,rows:1,gap:-8});arrangeGrid(b.elements,2,{gap:-8},{figure:b});eq(a,b);
 const scoped=structuredClone(seed);arrangePanels(project(scoped),'f',{ids:['a','b','c'],scope:null,cols:2,gap:-8});eq(scoped,b);
 for(const opts of [{mode:'tidy' as const,rows:2},{mode:'reflow' as const,gap:Infinity},{gapX:Infinity},{anchorX:'center' as const,gap:NaN}]){const before=structuredClone(seed);assert.throws(()=>arrangePanels(project(seed),'f',opts));checks++;eq(seed,before);}
 for(const gap of [Infinity,NaN]){const before=structuredClone(seed);assert.throws(()=>arrangePanels(project(seed),'f',{mode:'tidy',gap,gapX:2,gapY:2}),/gap must be finite/);checks++;eq(seed,before,'overridden common gap is still validated atomically');}
}
{
 const seed=figure([rect('a',0,0),rect('b',100,100)]),p=project(seed),before=structuredClone(seed);
 assert.throws(()=>arrangePanels(p,'f',{mode:'tidy',ids:['a','missing'],gapX:10}),/Unknown layout targets/);checks++;
 eq(seed,before,'modern arrangement with a stale ID refuses before any mutation');
 assert.throws(()=>alignPanels(p,'f','left',['a','b','missing'],{target:'selection'}),/Unknown layout targets/);checks++;
 eq(seed,before,'new reference/target alignment refuses a partial explicit ID set');
 const legacy=structuredClone(seed);arrangePanels(project(legacy),'f',{ids:['a','missing'],gap:-2});
 eq(legacy,seed,'legacy call keeps its historical missing-ID filtering');
}
// Exercise actual registry parsing, file mutation and reopen against the same
// pure planner. Build the scaffold without the machine-global FluxLib helper.
{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-arrangement-'));
 const oldHome=process.env.HOME,oldConfig=process.env.XDG_CONFIG_HOME;
 process.env.HOME=path.join(root,'home');process.env.XDG_CONFIG_HOME=path.join(root,'config');
 try {
  const {buildScaffoldTree}=await import('../src/lib/project/scaffoldTree');
  const {createDeck}=await import('../src/lib/slide/ops');
  const tree=buildScaffoldTree({title:'Arrangement parity'},createDeck({title:'Fixture'}));
  for(const dir of tree.dirs)await fs.mkdir(path.join(root,dir),{recursive:true});
  for(const [name,bytes] of tree.files)await fs.writeFile(path.join(root,name),bytes);
  const {mutateFigModel,loadFigModel}=await import('../flux-core/model');
  const {runCliVerb}=await import('../flux-core/registry');
  await mutateFigModel(root,'arrangement-fixture',({project:p})=>{
   const f=figure([rect('a',.1,20,20,40),rect('b',35.1,25,20,30),rect('c',80.1,30,20,20)]);
   f.canvasId=p.canvases[0].id;p.figures=[f];
  });
  const original=(await loadFigModel(root)).project;
  const expected=structuredClone(original);
  arrangePanels(expected,'f',{ids:['a','b','c'],mode:'tidy',gapX:12.5,anchorX:'end',anchorY:'center'});
  const run=async(verb:string,pos:string[],flags:Record<string,unknown>)=>{
   let code=0;const errors:string[]=[];
   await runCliVerb(verb,{pos,posRooted:pos,flags,rootFlags:root,rootPositional:root},{log:()=>{},err:(m:string)=>errors.push(m),setExit:(n:number)=>{code=n;}});
   return {code,errors};
  };
  const arranged=await run('arrange',['f'],{mode:'tidy','gap-x':'12.5','anchor-x':'end','anchor-y':'center',ids:'a,b,c'});
  eq(arranged.code,0,arranged.errors.join('\n'));
  eq((await loadFigModel(root)).project.figures[0].elements,expected.figures[0].elements,'CLI parser + headless save use identical arrangement');
  alignPanels(expected,'f','top',['a','b','c'],{target:{unitKey:'b'}});
  const aligned=await run('align',['f','top'],{ids:'a,b,c',target:'reference',reference:'b'});
  eq(aligned.code,0,aligned.errors.join('\n'));
  eq((await loadFigModel(root)).project.figures[0].elements,expected.figures[0].elements,'reference alignment survives real save/reopen');
  arrangePanels(expected,'f',{ids:['a','b','c'],mode:'tidy',gapX:-7,anchorX:'end'});
  const overlap=await run('arrange',['f'],{mode:'tidy','gap-x':'-7','anchor-x':'end',ids:'a,b,c'});
  eq(overlap.code,0,overlap.errors.join('\n'));
  eq((await loadFigModel(root)).project.figures[0].elements,expected.figures[0].elements,'signed gaps survive CLI parsing and real save/reopen');
  const invalid=await run('arrange',['f'],{mode:'tidy',rows:'2'});assert.notEqual(invalid.code,0);checks++;
  eq((await loadFigModel(root)).project.figures[0].elements,expected.figures[0].elements,'invalid modern options do not change saved geometry');
 }finally{
  if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
  if(oldConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldConfig;
  await fs.rm(root,{recursive:true,force:true});
 }
}
console.log(`##VERIFY## ${JSON.stringify({name:'arrangement',pass:true,checks})}`);
