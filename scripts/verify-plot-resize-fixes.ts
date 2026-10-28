import { DOMParser,parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { plotResizeFixFixture } from './lib/plotResizeFixFixture';
import { preparePlot,prefixIds } from '../src/lib/plot/parse';
import { buildRelayoutModel,applyRelayout,solveRelayout,restoreRelayout } from '../src/lib/plot/relayout';
import { parseMplPath } from '../src/lib/plot/relayout/path';
import { transformToAncestor,applyToPoint } from '../src/lib/plot/svgMatrix';
import { legendGeometry } from '../src/lib/plot/relayout/legend';
Object.assign(globalThis,{DOMParser,document:parseHTML('<html><body></body></html>').document});
const h=harness('verify-plot-resize-fixes'),source=plotResizeFixFixture();
for(const prefix of ['', 'placed']){
  const prepared=preparePlot(source.svg,source.manifest),root=prepared.root!,model=buildRelayoutModel(prepared.manifest,root);
  if(!model.supported)throw Error('Reproduction must reflow');
  if(prefix)prefixIds(root,prefix);const id=(v:string)=>prefix?prefix+'__'+v:v;
  const band=root.querySelector(`[id="${id('confidence.band')}"] path`)!;
  const marker=root.querySelector(`[id="${id('confidence.mean')}"] path`)!;
  h.eq(band.getAttribute('data-flux-glyph'),null,`${prefix}: confidence band is data geometry`);
  h.eq(marker.getAttribute('data-flux-glyph'),'1',`${prefix}: mean stays a point-sized glyph`);
  const original=String(root),native=parseMplPath(band.getAttribute('d')!)!,oldTransform=transformToAncestor(band,root),old=model.axes.get('plot-area')!.pixelBox;
  for(const size of [{wPt:180,hPt:230.4},{wPt:360,hPt:115.2},{wPt:500,hPt:300},{wPt:155,hPt:170}]){
    const solution=solveRelayout(model,size);applyRelayout(root,model,solution);
    const path=parseMplPath(band.getAttribute('d')!)!,matrix=transformToAncestor(band,root),box=solution.axesBox['plot-area'];
    let error=0;
    for(let i=0;i<native.vertices.length;i+=2){
      const before=applyToPoint({x:native.vertices[i],y:native.vertices[i+1]},oldTransform),actual=applyToPoint({x:path.vertices[i],y:path.vertices[i+1]},matrix);
      const expected={x:box.x0+(before.x-old[0])/(old[2]-old[0])*(box.x1-box.x0),y:box.y0+(before.y-old[1])/(old[3]-old[1])*(box.y1-box.y0)};
      error=Math.max(error,Math.hypot(actual.x-expected.x,actual.y-expected.y));
    }
    h.ok(error<.00001,`${prefix}/${size.wPt}×${size.hPt}: every band vertex follows axes (${error})`);
    const geometry=legendGeometry(model.layout.legends[0],model,box,{x0:0,y0:0,x1:size.wPt,y1:size.hPt});
    h.ok(geometry.width*geometry.scale<=box.x1-box.x0+1e-6,`${prefix}/${size.wPt}: legend fits resized owner`);
    if(size.wPt===180){h.eq(geometry.entries.size,4,`${prefix}: legend reflows into one column before shrinking`);h.ok(geometry.scale>.9,`${prefix}: reflow retains readable typography`);}
    const once=String(root);applyRelayout(root,model,solution);h.eq(String(root),once,`${prefix}/${size.wPt}: repeated resize is idempotent`);
  }
  restoreRelayout(root);h.eq(String(root),original,`${prefix}: restore retains exact native bytes`);
}
const figureLegend=structuredClone(source.manifest),layout=figureLegend.layout!;
layout.legends=[{...layout.legends[0],id:'figure.legend',owner:'figure',bbox:[100,3,280,15],sizePt:[180,12],bboxToAnchor:null,inLayout:true,locRequested:'upper center',locResolved:'upper center'}];
const outer=buildRelayoutModel(figureLegend);if(!outer.supported)throw Error('Figure legend fixture must reflow');
for(const wPt of [180,270,450]){const sol=solveRelayout(outer,{wPt,hPt:230.4});h.ok(sol.legend['figure.legend'].y1<Math.min(...Object.values(sol.axesBox).map(b=>b.y0)),`${wPt}: figure legend reserves space outside axes`);}
for(const title of [false,true])for(const prefix of ['', 'framed']){
  const source=plotResizeFixFixture({frame:true,title}),prepared=preparePlot(source.svg,source.manifest),root=prepared.root!,model=buildRelayoutModel(prepared.manifest,root);if(!model.supported)throw Error('Framed legend must reflow');
  if(prefix)prefixIds(root,prefix);const id=(value:string)=>prefix?prefix+'__'+value:value;
  const background=root.querySelector(`[id="${id('legend.background')}"] path`)!,native=String(root),nativePath=background.getAttribute('d');
  for(const wPt of [180,500,155]){
    const solution=solveRelayout(model,{wPt,hPt:230.4});applyRelayout(root,model,solution);
    const path=parseMplPath(background.getAttribute('d')!)!,matrix=transformToAncestor(background,root),points=[];
    for(let i=0;i<path.vertices.length;i+=2)points.push(applyToPoint({x:path.vertices[i],y:path.vertices[i+1]},matrix));
    const actual=[Math.min(...points.map(p=>p.x)),Math.min(...points.map(p=>p.y)),Math.max(...points.map(p=>p.x)),Math.max(...points.map(p=>p.y))],box=solution.legend.legend;
    h.ok(Math.max(...actual.map((v,i)=>Math.abs(v-[box.x0,box.y0,box.x1,box.y1][i])))<.00001,`${prefix}/${title?'titled':'wrapped'}/${wPt}: actual background fits solved legend geometry`);
    h.ok(actual[2]-actual[0]<=solution.axesBox['plot-area'].x1-solution.axesBox['plot-area'].x0+.00001,`${prefix}/${title}/${wPt}: framed legend fits owner`);
    if(wPt===500)h.eq(background.getAttribute('d'),nativePath,`${prefix}/${title}: wider nonnative size restores original background`);
    if(title){const plan=legendGeometry(model.layout.legends[0],model,solution.axesBox['plot-area'],{x0:0,y0:0,x1:wPt,y1:230.4}),text=root.querySelector(`[id="${id('legend.title')}"] text`)!,m=transformToAncestor(text,root);h.eq(plan.entries.size,0,'titled legend retains its authored composition');h.ok(Math.abs(Math.hypot(m[0],m[1])-plan.scale)<.00001,'title shares uniform fit with frame and entries');}
    const once=String(root);applyRelayout(root,model,solution);h.eq(String(root),once,`${prefix}/${title}/${wPt}: framed resize repeats exactly`);
  }
  restoreRelayout(root);h.eq(String(root),native,`${prefix}/${title}: framed legend restores exact native bytes`);
}
await h.done();
