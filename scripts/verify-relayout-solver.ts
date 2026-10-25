import fs from 'node:fs';import {harness} from './lib/harness.mjs';import {fixture} from './lib/relayoutFixture';import {buildRelayoutModel,solveRelayout} from '../src/lib/plot/relayout';
const h=harness('verify-relayout-solver'),base=fixture().manifest,tables=JSON.parse(fs.readFileSync('scripts/fixtures/relayout/solver.json','utf8'));let max=0,worst=-1;
for(const [index,row]of tables.rows.entries()){
 const m=structuredClone(base),l=m.layout!;l.figure={widthPt:100,heightPt:100};l.grids=[{id:'g',nrows:row.nr,ncols:row.nc,widthRatios:row.wr,heightRatios:row.hr,parent:null}];l.colorbars=[];l.legends=[];l.frames={};l.texts={};
 l.engine=row.engine==='constrained'?{kind:'constrained',wPad:row.wp,hPad:row.hp,wSpace:row.ws,hSpace:row.hs}:{kind:'tight',pad:row.pad,wPad:row.pad,hPad:row.pad,fontPt:10};
 const source=structuredClone(l.axes[0]);l.axes=[];
 for(let r=0;r<row.nr;r++)for(let c=0;c<row.nc;c++){
  const i=r*row.nc+c,a=structuredClone(source);a.id='a'+i;a.slot={grid:'g',rows:[r,r],cols:[c,c]};a.positionMode='grid';a.position=row.positions?.[i]??[c/row.nc,1-(r+1)/row.nr,1/row.nc,1/row.nr];a.initialPosition=a.position;a.pixelBox=[a.position[0]*100,(1-a.position[1]-a.position[3])*100,(a.position[0]+a.position[2])*100,(1-a.position[1])*100];a.margins=row.margins[i];a.extraLayoutIds=[];a.aspect='auto';a.boxAspect=null;a.title={};
  for(const k of ['x','y']){a.ticking[k]={major:{kind:'null'},minor:{kind:'null'},formatter:{kind:'fixed'},retick:false,domain:[0,1],scale:'linear',values:[],labels:[]};a.axisStyle[k].visible=false;}
  l.axes.push(a);
 }
 const model=buildRelayoutModel(m);if(!model.supported)throw Error('solver model refused');const s=solveRelayout(model,{wPt:row.w,hPt:row.h});
 for(let i=0;i<l.axes.length;i++){const b=s.axesBox['a'+i],err=Math.max(...[b.x0,b.y0,b.x1,b.y1].map((v,j)=>Math.abs(v-row.boxes[i][j])));if(err>max){max=err;worst=index;}}
}
h.ok(tables.rows.length>=400,'random constrained and tight tables');h.ok(max<=.05,`solver maximum ${max} pt at row ${worst}`);await h.done();
