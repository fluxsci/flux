import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { harness } from "./lib/harness.mjs";
import { solveSpike, type SpikeModel } from "./lib/relayoutSpike";
import { DOMParser } from "linkedom";
import { bindSpike } from "./lib/relayoutSpikeDom";
const h=harness("verify-relayout-spike");
const dir=path.resolve("scripts/fixtures/relayout");
const read=(f:string)=>JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
const cases=read("cases.json");
const report=[];
for(const c of cases.cases){
  if(!["line","scatter","colorbar","shared","ratios","none"].includes(c.name))continue;
  const base=read(`${c.name}/base.oracle.json`) as SpikeModel;
  let maxError=0; const failures=[];
  for(const size of c.sizes){
    const truth=read(`${c.name}/${size.stem}.oracle.json`) as SpikeModel;
    const actual=solveSpike(base,size.wPt,size.hPt);
    let error=0;
    for(let i=0;i<actual.length;i++)for(const k of ["x0","x1","y0","y1"] as const)error=Math.max(error,Math.abs(actual[i][k]-truth.axes[i].box[k]));
    maxError=Math.max(maxError,error);
    if(error>.5)failures.push({size:size.stem,error});
  }
  const times=[];
  for(let i=0;i<200;i++){const start=performance.now();solveSpike(base,432+i/10,200+i/10);times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);
  report.push({case:c.name,maxError,failures,p95:times[190]});
  h.ok(maxError<=(base.engine.kind==="none"?.01:.5),`${c.name}: maximum edge error ${maxError.toFixed(4)} pt`);
}
const svg=fs.readFileSync(path.join(dir,"hexmatrix.svg"),"utf8");
const root=new DOMParser().parseFromString(svg,"image/svg+xml").documentElement as unknown as Element;
const manifest=read("hexmatrix.fluxplot.json");
const boxes=manifest.axes.map((a:{pixelBox:unknown})=>a.pixelBox);
const t=performance.now(),bound=bindSpike(root,boxes),buildMs=performance.now()-t;
const times=[];
for(let i=0;i<120;i++){
 const target=boxes.map((b:{x0:number;y0:number;x1:number;y1:number})=>({...b,x1:b.x1+40+i/10,y1:b.y1+50+i/10}));
 const start=performance.now();bound.apply(target);times.push(performance.now()-start);
}
times.sort((a,b)=>a-b);
const apply={nodes:root.querySelectorAll('*').length,vertices:bound.vertices,paths:bound.paths,points:bound.points,buildMs,p95:times[Math.floor(times.length*.95)]};
h.ok(apply.p95<=10,`hexmatrix apply p95 ${apply.p95.toFixed(3)} ms (${apply.nodes} nodes)`);
fs.mkdirSync("test-results/relayout",{recursive:true});
fs.writeFileSync("test-results/relayout/spike.json",JSON.stringify({matplotlib:cases.matplotlib,report,apply},null,2)+"\n");
await h.done();
