import fs from "node:fs";
import path from "node:path";
import { DOMParser } from "linkedom";
import { harness } from "./lib/harness.mjs";
import { buildRelayoutModel, solveRelayout, applyRelayout, restoreRelayout } from "../src/lib/plot/relayout";
import { parseMplPath } from "../src/lib/plot/relayout/path";
import {transformToAncestor,applyToPoint} from "../src/lib/plot/svgMatrix";
import type { FluxPlotManifest } from "../src/lib/plot/types";
const h=harness("verify-relayout-oracle"),baseDir=path.resolve("scripts/fixtures/relayout");
const read=(file:string)=>fs.readFileSync(path.join(baseDir,file),"utf8");
const cases=JSON.parse(read("cases.json")),results=[];
for(const c of cases.cases){
  const manifest=JSON.parse(read(`${c.name}/base.fluxplot.json`)) as FluxPlotManifest;
  const root=new DOMParser().parseFromString(read(`${c.name}/base.svg`),"image/svg+xml").documentElement as unknown as Element;
  const model=buildRelayoutModel(manifest,root);
  if(["polar","subfigures","3d"].includes(c.name)){h.ok(!model.supported,`${c.name}: named refusal`);continue;}
  h.ok(model.supported,`${c.name}: supported`);if(!model.supported)continue;
  const original=String(root);
  applyRelayout(root,model,solveRelayout(model,{wPt:manifest.layout!.figure.widthPt,hPt:manifest.layout!.figure.heightPt}));
  h.eq(String(root),original,`${c.name}: native identity`);
  let maxError=0,worst="",maxText=0,textWorst="",maxLegend=0,maxColorbar=0,maxVertex=0,vertexWorst="",maxArrow=0,arrowWorst="",maxTickAnchor=0,tickWorst="",maxImageClip=0;
  for(const size of c.sizes){
    const truth=JSON.parse(read(`${c.name}/${size.stem}.fluxplot.json`)) as FluxPlotManifest;
    const sol=solveRelayout(model,size);
    for(const cb of truth.layout!.colorbars){const b=sol.axesBox[cb.id];if(b)maxColorbar=Math.max(maxColorbar,...[b.x0,b.y0,b.x1,b.y1].map((v,i)=>Math.abs(v-cb.pixelBox[i])));}
    for(const axis of truth.layout!.axes){
      const actual=sol.axesBox[axis.id],expected=axis.pixelBox;
      const err=Math.max(...[actual.x0,actual.y0,actual.x1,actual.y1].map((v,i)=>Math.abs(v-expected[i])));
      if(err>maxError){maxError=err;worst=`${size.stem}/${axis.id}`;}
    }
    for(const [id,p]of Object.entries(sol.decor)){
      const frame=model.layout.frames[id],t=truth.layout!.texts[id];if(!t||frame.part==='ticklabel'||frame.part==='offset')continue;
      const err=Math.hypot(p[0]-t.anchor[0],p[1]-t.anchor[1]);if(err>maxText){maxText=err;textWorst=`${size.stem}/${id}`;}
    }
    for(const [id,b]of Object.entries(sol.legend)){const t=truth.layout!.legends.find(l=>l.id===id);if(t)maxLegend=Math.max(maxLegend,...[b.x0,b.y0,b.x1,b.y1].map((v,i)=>Math.abs(v-t.bbox[i])));}
    applyRelayout(root,model,sol);
    const truthRoot=new DOMParser().parseFromString(read(`${c.name}/${size.stem}.svg`),'image/svg+xml').documentElement as unknown as Element;
    for(const [id,f]of Object.entries(model.layout.frames)){
      if(!['data','glyph','blend','axes'].includes(f.f)||model.layout.texts[id])continue;
      const actual=root.querySelector(`[id="${id}"]`),expected=truthRoot.querySelector(`[id="${id}"]`);if(!actual||!expected)continue;
      const paths=(el:Element)=>el.tagName.toLowerCase()==='path'?[el]:[...el.querySelectorAll('path')].filter(p=>!p.closest('defs'));
      const aa=paths(actual),bb=paths(expected);if(aa.length!==bb.length)continue;
      aa.forEach((node,i)=>{const a=parseMplPath(node.getAttribute('d')??''),b=parseMplPath(bb[i].getAttribute('d')??'');if(!a||!b||a.vertices.length!==b.vertices.length)return;
        const am=transformToAncestor(node,root),bm=transformToAncestor(bb[i],truthRoot);
        for(let j=0;j<a.vertices.length;j+=2){const p=applyToPoint({x:a.vertices[j],y:a.vertices[j+1]},am),q=applyToPoint({x:b.vertices[j],y:b.vertices[j+1]},bm),err=Math.hypot(p.x-q.x,p.y-q.y);if(!Number.isFinite(err))throw Error(`Non-finite geometry at ${c.name}/${id}`);if(err>maxVertex){maxVertex=err;vertexWorst=`${size.stem}/${id}`;}}
      });
    }
    for(const a of truth.layout!.axes.concat(truth.layout!.colorbars as never))for(const [key,t]of Object.entries(a.ticking)){
      const actual=sol.ticks[a.id]?.[key];if(!actual||!t.retick||!a.axisStyle[key].visible)continue;
      const [lo,hi]=t.domain.slice().sort((a,b)=>a-b),visible=(values:number[])=>values.filter(v=>v>=lo&&v<=hi);
      const av=visible(actual.values),ev=visible(t.values??[]);
      if(av.length!==ev.length||av.some((v,i)=>Math.abs(v-ev[i])>1e-9*Math.max(1e-300,Math.abs(v))))h.fail(`${c.name}/${size.stem}/${a.id}/${key}: tick values`);
      if(av.some(v=>actual.labels[actual.values.indexOf(v)]!==t.labels?.[(t.values??[]).findIndex(x=>Math.abs(x-v)<1e-9*Math.max(1e-300,Math.abs(v)))]))h.fail(`${c.name}/${size.stem}/${a.id}/${key}: tick strings`);
      if(actual.offset!==t.offsetText)h.fail(`${c.name}/${size.stem}/${a.id}/${key}: offset`);
    }
    for(const [id,f]of Object.entries(model.layout.frames)){
      if(f.f==='arrow'){
        const actual=root.querySelector(`[id="${id}"]`),expected=truthRoot.querySelector(`[id="${id}"]`);if(!actual||!expected)continue;
        const aa=[...actual.querySelectorAll('path')],bb=[...expected.querySelectorAll('path')];
        aa.forEach((node,i)=>{const a=parseMplPath(node.getAttribute('d')??''),b=bb[i]?parseMplPath(bb[i].getAttribute('d')??''):null;if(!a||!b)return;
          // First/last shaft endpoint and rigid head tip, in SVG points.
          for(const j of [0,a.vertices.length-2]){const err=Math.hypot(a.vertices[j]-b.vertices[j],a.vertices[j+1]-b.vertices[j+1]);if(err>maxArrow){maxArrow=err;arrowWorst=`${size.stem}/${id}`;}}
        });
      }
    }
    for(const [id,t]of Object.entries(truth.layout!.texts)){
      const f=truth.layout!.frames[id];if(f?.part!=='ticklabel'||f.minor||f.value==null||!f.axes||!f.axis)continue;
      const axis=model.axes.get(f.axes);if(!axis)continue;
      const d=truth.layout!.axes.find(a=>a.id===f.axes)?.ticking[f.axis]?.domain??axis.ticking[f.axis].domain;
      if(f.value<Math.min(...d)||f.value>Math.max(...d))continue;
      const family=id.replace(/\.[^.]+$/,''),native=Object.entries(model.layout.frames).find(([other,frame])=>other.replace(/\.[^.]+$/,'')===family&&Math.abs((frame.value??NaN)-f.value!)<=1e-9*Math.max(1e-300,Math.abs(f.value!)));
      let node=native?root.querySelector(`[id="${native[0]}"]`):[...root.querySelectorAll('[data-relayout-tick]')].find(n=>n.id.startsWith(family+'.r')&&Math.abs(Number(n.getAttribute('data-value'))-f.value!)<=1e-9*Math.max(1e-300,Math.abs(f.value!)));
      if(!node)continue;
      const original=model.layout.texts[native?.[0]??node.getAttribute('data-relayout-source')!];if(!original)continue;
      const point=applyToPoint({x:original.anchor[0],y:original.anchor[1]},transformToAncestor(node,root)),err=Math.hypot(point.x-t.anchor[0],point.y-t.anchor[1]);
      if(err>maxTickAnchor){maxTickAnchor=err;tickWorst=`${size.stem}/${id}`;}
    }
    for(const image of Array.from(root.querySelectorAll('image'))){
      let owner:Element|null=image,frame=model.layout.frames[image.id];while(!frame&&owner){frame=model.layout.frames[owner.id];owner=owner.parentElement;}
      if(!frame?.axes)continue;const b=sol.axesBox[frame.axes];if(!b)continue;
      let clip:Element|null=image;while(clip&&!clip.hasAttribute('clip-path'))clip=clip.parentElement;
      const ref=/url\(#([^)]*)\)/.exec(clip?.getAttribute('clip-path')??'');if(!ref)continue;
      const rect=root.querySelector(`[id="${ref[1]}"] rect`);if(!rect)continue;
      const x=Number(rect.getAttribute('x')),y=Number(rect.getAttribute('y')),w=Number(rect.getAttribute('width')),h=Number(rect.getAttribute('height'));
      maxImageClip=Math.max(maxImageClip,Math.abs(x-b.x0),Math.abs(y-b.y0),Math.abs(x+w-b.x1),Math.abs(y+h-b.y1));
    }
    const once=String(root);applyRelayout(root,model,sol);
    if(String(root)!==once)h.fail(`${c.name}/${size.stem}: apply idempotence`);
    restoreRelayout(root);
    if(String(root)!==original)h.fail(`${c.name}/${size.stem}: pristine restoration`);
  }
  results.push({case:c.name,maxError,worst,maxText,textWorst,maxLegend,maxColorbar,maxVertex,vertexWorst,maxArrow,arrowWorst,maxTickAnchor,tickWorst,maxImageClip});
  h.ok(maxImageClip<=.05,`${c.name}: raster clip bounds ${maxImageClip.toFixed(4)} pt`);
  h.ok(maxArrow<=1,`${c.name}: arrow endpoints ${maxArrow.toFixed(4)} pt (${arrowWorst})`);
  h.ok(maxTickAnchor<=1,`${c.name}: tick label anchors ${maxTickAnchor.toFixed(4)} pt (${tickWorst})`);
  h.ok(maxColorbar<=.5,`${c.name}: colorbar ${maxColorbar.toFixed(4)} pt`);
  h.ok(maxVertex<=.05,`${c.name}: SVG vertices ${maxVertex.toFixed(4)} pt (${vertexWorst})`);
  h.ok(maxText<=.5,`${c.name}: text anchors ${maxText.toFixed(4)} pt (${textWorst})`);
  h.ok(maxLegend<=1,`${c.name}: legend box ${maxLegend.toFixed(4)} pt`);
  h.ok(maxError<=(model.layout.engine.kind==="none"?.01:.5),`${c.name}: ${maxError.toFixed(4)} pt max edge error (${worst})`);
}
fs.mkdirSync("test-results/relayout",{recursive:true});
fs.writeFileSync("test-results/relayout/oracle.json",JSON.stringify(results,null,2)+"\n");
await h.done();
