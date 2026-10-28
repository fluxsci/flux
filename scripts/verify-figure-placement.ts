import assert from "node:assert/strict";
import { nearestFigurePosition, createFigure, duplicateFigure } from "../src/lib/figureLifecycle";
import { excludeZones, selectionHitZones, hitZoneAt } from "../src/lib/interact/handles";
import type { Project } from "../src/lib/types";

// Independent integer-grid oracle: an exact optimum is on an integer boundary
// for these integer rectangles. Includes overlapping forbidden regions and
// negative canvas positions; a spiral/grid placement would miss fractional input.
let random = 7241;
const rand = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random/2**32; };
for (let trial = 0; trial < 100; trial++) {
  const figures = Array.from({length:8}, () => ({x:Math.floor(rand()*20)-10,y:Math.floor(rand()*20)-10,width:1+Math.floor(rand()*5),height:1+Math.floor(rand()*5)}));
  const at = {x:Math.floor(rand()*12)-6,y:Math.floor(rand()*12)-6};
  const size = {width:3,height:2};
  const clear = (x:number,y:number) => figures.every(f => x+size.width<=f.x || x>=f.x+f.width || y+size.height<=f.y || y>=f.y+f.height);
  let oracle = Infinity;
  for(let x=-25;x<=25;x++) for(let y=-25;y<=25;y++) if(clear(x,y)) oracle=Math.min(oracle,(x-at.x)**2+(y-at.y)**2);
  const p = nearestFigurePosition(figures,at,size,0);
  assert.ok(clear(p.x,p.y),"placed frame clears every obstacle");
  assert.equal((p.x-at.x)**2+(p.y-at.y)**2,oracle,"closest point matches exhaustive independent oracle");
}
assert.deepEqual(nearestFigurePosition([], {x:-3.25,y:4.125}), {x:-3.25,y:4.125});
assert.throws(() => nearestFigurePosition([], {x:NaN,y:0}));
assert.deepEqual(nearestFigurePosition([{x:0,y:0,width:10,height:10}], {x:34,y:0}, {width:10,height:10}), {x:34,y:0},"exact gap is permitted");

const project: Project = {version:2,name:"Frames",canvases:[{id:"c",name:"Canvas"}],figures:[],assets:[],palette:[]};
const first = createFigure(project, {canvasId:"c",family:"figure",nickname:"Synapses"});
first.elements = [{id:"label",type:"text",x:10,y:15,width:60,height:20,rotation:0,text:"a",fontSize:14,fontFamily:"Arial",fontWeight:700,fontStyle:"normal",align:"left",color:"#222222",panelLabel:true}];
first.captions = {__figure__:"Opening",label:"A panel",__ps__:"Closing"};
const copiedId = duplicateFigure(project, first.id);
const copy = project.figures.find(f=>f.id===copiedId)!;
assert.equal(copy.family, first.family); assert.equal(copy.number, first.number!+1);
assert.notEqual(copy.referenceKey, first.referenceKey); assert.notEqual(copy.elements[0].id,first.elements[0].id);
assert.equal(copy.captions?.[copy.elements[0].id],"A panel"); assert.equal(copy.captions?.__ps__,"Closing");
assert.deepEqual(first.captions,{__figure__:"Opening",label:"A panel",__ps__:"Closing"});

const zones = excludeZones(selectionHitZones({x:400,y:100,w:200,h:150}), [{x:0,y:78,w:500,h:18}]);
assert.equal(hitZoneAt(zones,600,175)?.kind,"edge","east handle stays reachable beyond the 500px frame");
assert.equal(hitZoneAt(zones,600,250)?.kind,"corner","overhanging corner stays reachable");
assert.equal(hitZoneAt(zones,400,85),null,"figure title retains its press target");
assert.ok(zones.every(z=>z.rect.w>0&&z.rect.h>0));
console.log("FIGURE PLACEMENT: PASS — nearest nonoverlap oracle, fractional positions, duplicate identities/captions, overhanging zones and title priority");
