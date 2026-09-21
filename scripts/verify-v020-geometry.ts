import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {resizeRemap} from '../src/lib/editing';
import {selectionBBox,rotatedAABB,lineWorldEndpoints,selectionUnits} from '../src/lib/geometry';
import {arrangePanels,alignPanels,distributePanels,autoLetterPanels} from '../src/lib/ops';
import {expandGroups} from '../src/lib/store';
import {pathRender} from '../src/lib/path';
import type {Project,Figure,RectElement,Element} from '../src/lib/types';
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const rect=(id:string,x=0,y=0):RectElement=>({id,type:'rect',x,y,width:100,height:20,rotation:0,fill:'#222',stroke:'none',strokeWidth:0,cornerRadius:0});
for(const rotation of [0,30,45,90,180,270]){
  const orig={...rect('r',40,60),rotation},el=structuredClone(orig),ob=rotatedAABB(orig);
  const uniform=rotation%90!==0,nb={x:20,y:30,w:ob.w*2,h:ob.h*(uniform?2:3)};
  resizeRemap(el,orig,ob,nb);const got=rotatedAABB(el);
  for(const k of ['x','y','w','h'] as const)near(got[k],nb[k]);
  if(uniform)assert.throws(()=>resizeRemap(el,orig,ob,{...nb,h:nb.h*1.3}),/uniform/);
}
const line:Element={id:'line',type:'line',x:10,y:20,width:0,height:0,rotation:90,flipX:true,x1:0,y1:0,x2:80,y2:30,stroke:'#222',strokeWidth:2};
const end=lineWorldEndpoints(line),ob=selectionBBox([line])!,nb={x:0,y:0,w:ob.w*2,h:ob.h*3},line2=structuredClone(line);
resizeRemap(line2,line,ob,nb);const got=lineWorldEndpoints(line2);
for(const key of ['p1','p2'] as const){near(got[key].x,(end[key].x-ob.x)*2);near(got[key].y,(end[key].y-ob.y)*3);}
const fig:Figure={id:'f',canvasId:'c',name:'F',x:0,y:0,width:900,height:600,groups:{g:{id:'g',name:'Outer'},sub:{id:'sub',name:'Inner',parentId:'g'}},elements:[{...rect('a',20,30),groupId:'sub'},{...rect('b',50,80),groupId:'g'},rect('other',400,250),{...rect('locked',800,550),locked:true}]};
const p:Project={version:2,name:'Fixture',canvases:[{id:'c',name:'C'}],figures:[fig],assets:[],palette:[]};
const locked=structuredClone(fig.elements[3]);
assert.equal(selectionUnits(fig.elements,{figure:fig}).length,2);
assert.equal(selectionUnits(fig.elements,{figure:fig,scope:'g'}).length,3);
for(const op of [()=>alignPanels(p,'f','top'),()=>distributePanels(p,'f','h',undefined,15),()=>arrangePanels(p,'f',{cols:2})]){op();near(fig.elements[1].x-fig.elements[0].x,30);near(fig.elements[1].y-fig.elements[0].y,50);assert.deepEqual(fig.elements[3],locked);}
const rotated={...rect('rotated',600,100),rotation:45};fig.elements.push(rotated);alignPanels(p,'f','left');near(rotatedAABB(rotated).x,selectionBBox(fig.elements.slice(0,2))!.x);
const nodes=[{x:0,y:0,type:'corner' as const},{x:40,y:20,type:'corner' as const}];
const arrow={d:'M0 0L40 20',nodes,closed:false,strokeWidth:2,arrowEnd:true};
assert.deepEqual(pathRender({...arrow,nodes:[...nodes,nodes[1]]}).polys,pathRender(arrow).polys);
const veryShort={...arrow,nodes:[nodes[0],{x:1e-12,y:1e-12,type:'corner' as const}]};assert.ok(pathRender(veryShort).polys.flat(2).every(Number.isFinite));
fig.elements=Array.from({length:27},(_,i)=>({id:'label'+i,type:'text',text:'custom'+i,panelLabel:true,x:i*10,y:0,width:20,height:20,rotation:0,fontSize:12,fontFamily:'Arial',fontWeight:400,fontStyle:'normal',align:'left',color:'#222'}));
const labels=structuredClone(fig.elements);assert.throws(()=>autoLetterPanels(p,'f'),/26 panels/);assert.deepEqual(fig.elements,labels);
fig.groups={};fig.elements=Array.from({length:10000},(_,i)=>{const gid='g'+Math.floor(i/5);fig.groups![gid]={id:gid,name:gid};return {...rect('e'+i),groupId:gid}});
const selected=new Set(fig.elements.filter((_,i)=>i%5===0).map(e=>e.id));const times:number[]=[];
for(let i=0;i<12;i++){const start=performance.now();assert.equal(expandGroups(p,selected).size,10000);times.push(performance.now()-start);}
times.sort((a,b)=>a-b);assert.ok(times.at(-1)!<100,JSON.stringify(times));
console.log(`V020 geometry PASS: world resize rotations, endpoints, rigid nested units, exclusions, arrows, panel limit; expansion p50=${times[6].toFixed(1)}ms p95=${times[11].toFixed(1)}ms`);
