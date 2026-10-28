import type { RelayoutModel, Box } from "./model";
import { asBox, width, height } from "./model";
import { solveRelayout,type RelayoutSolution } from "./solve";
import type { LayoutFrame, LayoutEndpoint } from "../types.gen";
import { mplNumber as n, parseMplPath, writeMplPath, type MplPath } from "./path";
import { restoreOverrideTranslations, plotPartPrefix, drawablesUnder, restorePlotClip } from "../parse";
import {writeMathLabel} from "./mathLabel";
import { arrowPaths } from "./arrows";
import { compose, parseTransform } from '../svgMatrix';
import { legendGeometry, type LegendGeometry } from './legend';
interface Affine {sx:number;sy:number;tx:number;ty:number}
const affine=(a:Box,b:Box):Affine=>{const sx=width(b)/width(a),sy=height(b)/height(a);return {sx,sy,tx:b.x0-a.x0*sx,ty:b.y0-a.y0*sy};};
const mapped=(a:Affine,x:number,y:number):[number,number]=>[x*a.sx+a.tx,y*a.sy+a.ty];
interface Binding {el:Element;frame:LayoutFrame;id:string;path?:MplPath;x?:number;y?:number;transform?:string;clip?:string;sourceD?:string;pathWritten?:boolean}
interface State {root:Element;model:RelayoutModel;bindings:Binding[];ids:Map<string,Element>;pristine:Map<Element,Record<string,string|null>>;added:Element[];prefix:string;templates:Map<string,Element>; arrowPaths:Map<Element,string[]>; textContents:Map<Element,string>;pathChanges:Binding[]}
const states=new WeakMap<Element,State>();
function set(s:State,el:Element,key:string,value:string|null){
  if(key==='transform'&&el.getAttribute(key)!==value)restorePlotClip(el);
  let rec=s.pristine.get(el);if(!rec)s.pristine.set(el,rec={});
  if(!(key in rec))rec[key]=el.getAttribute(key);
  if(value==null)el.removeAttribute(key);else if(el.getAttribute(key)!==value)el.setAttribute(key,value);
}
function setPath(s:State,b:Binding,value:string){
  if(!b.pathWritten){s.pathChanges.push(b);b.pathWritten=true;}
  if(b.el.getAttribute('d')!==value)b.el.setAttribute('d',value);
}
function resizeLegendBackground(s:State,legend:Element,old:RelayoutModel['layout']['legends'][number],plan:LegendGeometry):void {
  const [x0,y0]=old.bbox,[w0,h0]=old.sizePt;
  if(!(w0>0&&h0>0))return;
  // Nine-slice: each vertex keeps its distance to the nearer edge, so a fancybox
  // frame's rounded corners keep their radius while the wrapped legend reshapes it.
  const along=(v:number,o:number,size:number,next:number)=>v-o<=size/2?v:v+next-size,x=(v:number)=>along(v,x0,w0,plan.width),y=(v:number)=>along(v,y0,h0,plan.height);
  for(const frame of Array.from(legend.querySelectorAll('[data-role="background"]')))for(const node of drawablesUnder(frame)){
    const pristine=s.pristine.get(node),original=(key:string)=>pristine&&key in pristine?pristine[key]:node.getAttribute(key);
    if(!plan.entries.size){
      // A wider size can stop wrapping without returning to native dimensions.
      for(const key of ['d','x','y','width','height'])if(pristine&&key in pristine)set(s,node,key,pristine[key]);
      continue;
    }
    const tag=node.tagName.toLowerCase();
    if(tag==='path'){
      const path=parseMplPath(original('d')??'');if(!path)continue;
      const vertices=path.vertices.map((v,i)=>i%2?y(v):x(v));set(s,node,'d',writeMplPath({commands:path.commands,vertices}));
    }else if(tag==='rect'){
      const rx=Number(original('x')??0),ry=Number(original('y')??0),rw=Number(original('width')??0),rh=Number(original('height')??0);
      for(const [key,value]of Object.entries({x:x(rx),y:y(ry),width:x(rx+rw)-x(rx),height:y(ry+rh)-y(ry)}))set(s,node,key,n(value));
    }
  }
}
export function restoreRelayout(root:Element):void {
  restoreOverrideTranslations(root);
  const s=states.get(root);if(!s)return;
  for(const b of s.pathChanges){b.el.setAttribute("d",b.sourceD??"");b.pathWritten=false;}s.pathChanges.length=0;
  for(const el of s.added)el.remove();s.added.length=0;
  for(const [el,attrs]of s.pristine)for(const [key,v]of Object.entries(attrs)){if(v==null)el.removeAttribute(key);else el.setAttribute(key,v);}
  s.pristine.clear();
  for(const [el,html]of s.textContents)el.innerHTML=html;s.textContents.clear();
}
function bindSlow(root:Element,model:RelayoutModel):State {
  const previous=states.get(root);if(previous?.model===model)return previous;
  const prefix=plotPartPrefix(root);
  const s:State={root,model,bindings:[],ids:new Map(),pristine:new Map(),added:[],prefix,templates:new Map(),arrowPaths:new Map(),textContents:new Map(),pathChanges:[]};
  for(const el of [root,...Array.from(root.querySelectorAll("[id]"))]){const id=el.id;if(id)s.ids.set(id.startsWith(prefix)?id.slice(prefix.length):id,el);}
  for(const [id,f]of Object.entries(model.layout.frames))if(f.f==="axis"&&f.value!=null){const node=s.ids.get(id);if(node)s.templates.set(id,node.cloneNode(true) as Element);}
  const clips=new Map<string,string>(),glyphCounts=new Map<string,number>();
  function visit(el:Element,inherited?:{frame:LayoutFrame;id:string}){
    const id=el.id?.startsWith(prefix)?el.id.slice(prefix.length):el.id;
    const frame=model.layout.frames[id]??inherited?.frame;
    const owner=model.layout.frames[id]?id:inherited?.id??id;
    const tag=el.tagName.toLowerCase();
    if(["defs","metadata","style","title","desc"].includes(tag))return;
    const clip=/url\(#([^)]*)\)/.exec(el.getAttribute("clip-path")??"");
    if(clip&&frame?.axes)clips.set(clip[1].startsWith(prefix)?clip[1].slice(prefix.length):clip[1],frame.axes);
    if(frame){
      const b:Binding={el,frame,id:owner,transform:el.getAttribute("transform")??""};
      if(["legend","offset","arrow","title"].includes(frame.f)||model.layout.texts[id]){if(frame.f==='arrow')s.arrowPaths.set(el,Array.from(el.querySelectorAll('path')).map(p=>p.getAttribute('d')??''));s.bindings.push(b);return;}
      if(frame.f==='axis'&&frame.part==='tick'&&tag==='path'&&b.transform?.startsWith('translate(')||el.getAttribute("data-flux-glyph")==="1"){
        const t=/translate\(\s*([-+\deE.]+)[ ,]+([-+\deE.]+)\s*\)/.exec(b.transform??"");
        b.x=t?Number(t[1]):0;b.y=t?Number(t[2]):0;s.bindings.push(b);return;
      }
      if(tag==="path"){
        const source=el.getAttribute("d")??"";let path=model.paths.get(source);if(!path){path=parseMplPath(source)??undefined;if(path)model.paths.set(source,path);}if(path){
          if(frame.f==='glyph'&&frame.anchorsPt){const i=glyphCounts.get(owner)??0;glyphCounts.set(owner,i+1);const p=frame.anchorsPt[i%frame.anchorsPt.length];if(p){b.x=p[0];b.y=p[1];}}
          b.path=path;b.sourceD=source;s.bindings.push(b);
        }
      }else if(tag==="use"){b.x=Number(el.getAttribute("x")??0);b.y=Number(el.getAttribute("y")??0);s.bindings.push(b);}
      else if(["rect","image","line","circle","ellipse","polygon","polyline","lineargradient"].includes(tag))s.bindings.push(b);
    }
    for(const child of Array.from(el.children))visit(child,frame?{frame,id:owner}:inherited);
  }
  visit(root);
  for(const el of Array.from(root.querySelectorAll('[fill], [style]'))){
    const ref=/url\(#([^)]*)\)/.exec((el.getAttribute('fill')??'')+(el.getAttribute('style')??''));if(!ref)continue;
    const def=root.querySelector('[id="'+ref[1]+'"]');if(def?.tagName.toLowerCase()!=='lineargradient')continue;
    let parent:Element|null=el;let frame:LayoutFrame|undefined;
    while(parent&&!frame){const id=parent.id?.replace(prefix,'');frame=model.layout.frames[id];parent=parent.parentElement;}
    if(frame?.axes&&!s.bindings.some(b=>b.el===def))s.bindings.push({el:def,id:def.id,frame:{f:'gradient',axes:frame.axes}});
  }
  // Matplotlib puts raster image clips on an untagged parent <g>, outside
  // the artist's frame. Resolve those references through their semantic child.
  for(const node of Array.from(root.querySelectorAll('[clip-path]'))){
    const ref=/url\(#([^)]*)\)/.exec(node.getAttribute('clip-path')??'');if(!ref)continue;
    const id=ref[1].startsWith(prefix)?ref[1].slice(prefix.length):ref[1];if(clips.has(id))continue;
    for(const child of Array.from(node.querySelectorAll('[id]'))){const key=child.id.startsWith(prefix)?child.id.slice(prefix.length):child.id,frame=model.layout.frames[key];if(frame?.axes){clips.set(id,frame.axes);break;}}
  }
  for(const [id,axis]of clips){const el=s.ids.get(id)?.querySelector("rect");if(el)s.bindings.push({el,id,frame:{f:"clip",axes:axis}});}
  states.set(root,s);return s;
}
interface BindingTemplate {bindings:(Omit<Binding,'el'>&{index:number;nodeId:string;tag:string})[];arrows:[number,string[]][]}
const bindingTemplates=new WeakMap<RelayoutModel,Map<string,BindingTemplate[]>>();
/** Clones share one immutable geometry compilation; only node references bind. */
function bind(root:Element,model:RelayoutModel):State {
  const previous=states.get(root);if(previous?.model===model)return previous;
  const nodes=[root,...Array.from(root.querySelectorAll('*'))],prefix=plotPartPrefix(root);
  const canonical=(id:string)=>id.startsWith(prefix)?id.slice(prefix.length):id;
  const ids=nodes.map(el=>canonical(el.getAttribute('id')??'')),key=nodes.length+':'+root.tagName;
  let cache=bindingTemplates.get(model);if(!cache)bindingTemplates.set(model,cache=new Map());
  const candidates=cache.get(key)??[],template=candidates.find(t=>t.bindings.every(b=>nodes[b.index]?.tagName===b.tag&&ids[b.index]===b.nodeId));
  if(!template){
    const state=bindSlow(root,model),indices=new Map(nodes.map((el,index)=>[el,index]));
    const template:BindingTemplate={bindings:state.bindings.map(({el,...binding})=>({...binding,index:indices.get(el)!,nodeId:ids[indices.get(el)!],tag:el.tagName})),arrows:[...state.arrowPaths].map(([el,paths])=>[indices.get(el)!,paths])};cache.set(key,[...candidates.slice(-7),template]);
    return state;
  }
  const state:State={root,model,prefix,bindings:template.bindings.map(b=>({el:nodes[b.index],frame:b.frame,id:b.id,path:b.path,x:b.x,y:b.y,transform:b.transform,clip:b.clip,sourceD:b.sourceD})),ids:new Map(),pristine:new Map(),added:[],templates:new Map(),arrowPaths:new Map(template.arrows.map(([i,d])=>[nodes[i],d])),textContents:new Map(),pathChanges:[]};
  nodes.forEach((node,i)=>{if(ids[i])state.ids.set(ids[i],node);});
  for(const [id,frame]of Object.entries(model.layout.frames))if(frame.f==='axis'&&frame.value!=null){const node=state.ids.get(id);if(node)state.templates.set(id,node.cloneNode(true) as Element);}
  states.set(root,state);return state;
}
function endpoint(model:RelayoutModel,sol:RelayoutSolution,e:LayoutEndpoint):[number,number] {
  if(e.f==="figure")return [e.pt[0]*sol.wPt,(1-e.pt[1])*sol.hPt];
  const b=sol.axesBox[e.axes??""];
  if(!b)return [0,0];
  if(e.f==="axes")return [b.x0+e.pt[0]*width(b),b.y1-e.pt[1]*height(b)];
  const axis=model.axes.get(e.axes??""),old=axis?asBox(axis.pixelBox):null,fit=sol.fits[e.axes??""];
  const mappedNative=(key:'x'|'y',value:number)=>{
    if(e.nativePt&&old&&axis&&!['linear','log'].includes(axis.ticking[key].scale))return key==='x'?b.x0+(e.nativePt[0]-old.x0)/width(old)*width(b):b.y0+(e.nativePt[1]-old.y0)/height(old)*height(b);
    const f=fit[key];return f.m*(f.log?Math.log(value):value)+f.c;
  };
  return [mappedNative('x',e.pt[0]),mappedNative('y',e.pt[1])];
}
/** Attribute-only, shared by browser and linkedom. Every frame derives from pristine values. */
export function applyRelayout(root:Element,model:RelayoutModel,sol:RelayoutSolution,tier:"exact"|"preview"="exact",options:{skipData?:boolean;skipTickAxes?:ReadonlySet<string>}={}):void {
  if(states.get(root)?.model!==model)restoreRelayout(root);
  const s=bind(root,model);
  if(sol.identity){restoreRelayout(root);return;}
  // All geometry below derives from immutable bindings. Restore only the
  // transient tick state before overwriting it, avoiding a second full pass
  // writing thousands of paths back to native coordinates first.
  restoreOverrideTranslations(root);
  for(const el of s.added)el.remove();s.added.length=0;
  for(const [el,attrs]of s.pristine)for(const key of ['display','data-relayout-hidden'])if(key in attrs){const value=attrs[key];if(value==null)el.removeAttribute(key);else el.setAttribute(key,value);}
  for(const [el,html]of s.textContents)el.innerHTML=html;s.textContents.clear();
  const fig={sx:sol.wPt/model.layout.figure.widthPt,sy:sol.hPt/model.layout.figure.heightPt,tx:0,ty:0};
  const fits=new Map<string,Affine>(),dataFits=new Map<string,Affine>();
  for(const axis of model.axes.values()){
    const b=sol.axesBox[axis.id];if(!b)continue;
    fits.set(axis.id,affine(asBox(axis.pixelBox??[]),b));
    const old=asBox(axis.pixelBox??[]),f=sol.fits[axis.id];
    const oldFit=(key:string)=>{const d=axis.ticking[key].domain,log=axis.ticking[key].scale==='log',t=(v:number)=>log?Math.log(v):v,p0=key==='x'?old.x0:old.y1,p1=key==='x'?old.x1:old.y0,m=(p1-p0)/(t(d[1])-t(d[0]));return {m,c:p0-m*t(d[0])};};
    const x=oldFit('x'),y=oldFit('y'),sx=f.x.m/x.m,sy=f.y.m/y.m;
    dataFits.set(axis.id,{sx,sy,tx:f.x.c-sx*x.c,ty:f.y.c-sy*y.c});
  }
  const translate=(b:Binding,dx:number,dy:number)=>set(s,b.el,"transform",`translate(${n(dx)} ${n(dy)})${b.transform?" "+b.transform:""}`);
  for(const b of s.bindings){
    const f=b.frame;
    if(b.path&&f.f==='data'&&!options.skipData){
      const a=f.axes?dataFits.get(f.axes):fig;
      if(a){
        // A normalized collection path retains the <use>'s placement transform.
        // Bake it BEFORE the data affine, retaining physical stroke widths.
        if(b.transform){setPath(s,b,writeMplPath(b.path,compose([a.sx,0,0,a.sy,a.tx,a.ty],parseTransform(b.transform))));set(s,b.el,'transform','');}
        else setPath(s,b,writeMplPath(b.path,a));
      }
      continue;
    }
    if(options.skipData&&['data','glyph','blend','image'].includes(f.f))continue;const boxFit=f.axes?fits.get(f.axes):fig,dataFit=f.axes?dataFits.get(f.axes):fig;
    let a=boxFit;if(!a||!dataFit)continue;
    if(['data','glyph','image'].includes(f.f))a=dataFit;
    if(f.f==='blend')a={sx:f.x==='data'?dataFit.sx:a.sx,tx:f.x==='data'?dataFit.tx:a.tx,sy:f.y==='data'?dataFit.sy:a.sy,ty:f.y==='data'?dataFit.ty:a.ty};
    const tag=b.el.tagName.toLowerCase(),target=f.axes?sol.axesBox[f.axes]:null;
    if(f.f==="clip"&&target){
      const original=(key:string)=>Number(s.pristine.get(b.el)?.[key]??b.el.getAttribute(key)??0),p=mapped(a,original('x'),original('y'));
      for(const [key,value]of Object.entries({x:p[0],y:p[1],width:original('width')*a.sx,height:original('height')*a.sy}))set(s,b.el,key,n(value));continue;
    }
    if(f.f==="legend"){
      const old=model.layout.legends.find(l=>l.id===b.id),box=sol.legend[b.id];
      if(old&&box){
        const figure={x0:0,y0:0,x1:sol.wPt,y1:sol.hPt},owner=old.owner==='figure'?figure:sol.axesBox[old.owner];
        if(owner){
          const plan=legendGeometry(old,model,owner,figure);
          resizeLegendBackground(s,b.el,old,plan);
          for(const el of Array.from(b.el.querySelectorAll('[id]'))){
            const id=el.id.startsWith(s.prefix)?el.id.slice(s.prefix.length):el.id;
            const match=id.startsWith(b.id+'.entry.')?/^(.*\.entry\.\d+)(?:\.|$)/.exec(id):null;if(!match)continue;
            const parent=el.parentElement?.id??'';if(parent===(s.prefix+match[1])||parent.startsWith(s.prefix+match[1]+'.'))continue;
            const pristine=s.pristine.get(el),original=pristine&&'transform'in pristine?pristine.transform:el.getAttribute('transform'),offset=plan.entries.get(match[1]);
            if(offset)set(s,el,'transform',`translate(${n(offset.dx)} ${n(offset.dy)})${original?' '+original:''}`);
            else if(pristine&&'transform'in pristine)set(s,el,'transform',original);
          }
          if(plan.scale===1)translate(b,box.x0-old.bbox[0],box.y0-old.bbox[1]);
          else set(s,b.el,'transform',`translate(${n(box.x0)} ${n(box.y0)}) scale(${plan.scale}) translate(${n(-old.bbox[0])} ${n(-old.bbox[1])})${b.transform?' '+b.transform:''}`);
        }
      }
      continue;
    }
    const text=model.layout.texts[b.id];
    if(text){
      let p=sol.decor[b.id];
      if(f.f==="data"||f.f==="glyph"||f.f==="blend")p=mapped(a,text.anchor[0],text.anchor[1]);
      if(f.f==="offset"&&f.base){const base=endpoint(model,sol,f.base);p=[base[0]+(f.offsetPt?.[0]??0),base[1]-(f.offsetPt?.[1]??0)];}
      if(p){if(p.every(Number.isFinite))translate(b,p[0]-text.anchor[0],p[1]-text.anchor[1]);else set(s,b.el,"display","none");}continue;
    }
    if(f.f==="arrow"){
      const t=f.text?model.layout.texts[f.text]:null,p=f.text?sol.decor[f.text]:null;
      if(t&&p){const delta=[p[0]-t.anchor[0],p[1]-t.anchor[1]];
        if(tier==='preview'||!f.xy)translate(b,...delta as [number,number]);
        else {const oldSol=solveRelayout(model,{wPt:model.layout.figure.widthPt,hPt:model.layout.figure.heightPt});const paths=arrowPaths(s.arrowPaths.get(b.el)??[],t.bbox,delta,endpoint(model,sol,f.xy),endpoint(model,oldSol,f.xy),f.shrinkA??2);Array.from(b.el.querySelectorAll('path')).forEach((path,i)=>set(s,path,'d',paths[i]));}
      }continue;
    }
    if(f.f==="axis"&&target){
      const old=asBox(model.axes.get(f.axes!)!.pixelBox??[]),v=f.axis?.startsWith("y"),style={...model.axes.get(f.axes!)!.axisStyle[f.axis??"x"],side:f.side??model.axes.get(f.axes!)!.axisStyle[f.axis??"x"].side};
      if(f.part==="spine"&&b.path){
        const pos=f.position??["outward",0],offset=pos[0]==="outward"?Number(pos[1]):0;
        let line:Box={...target};
        const custom=pos[0]==='axes'?Number(pos[1]):pos[0]==='data'?Number(pos[1]):null;
        if(custom!=null){const vertical=['left','right'].includes(f.side??''),fit=sol.fits[f.axes!][vertical?'x':'y'],value=pos[0]==='data'?fit.m*(fit.log?Math.log(custom):custom)+fit.c:vertical?target.x0+custom*width(target):target.y1-custom*height(target);
          line=vertical?{x0:value,x1:value,y0:target.y0,y1:target.y1}:{x0:target.x0,x1:target.x1,y0:value,y1:value};
          setPath(s,b,`M ${n(line.x0)} ${n(line.y0)} L ${n(line.x1)} ${n(line.y1)}`);continue;
        }
        if(f.side==="left")line={x0:target.x0-offset,x1:target.x0-offset,y0:target.y0,y1:target.y1};
        if(f.side==="right")line={x0:target.x1+offset,x1:target.x1+offset,y0:target.y0,y1:target.y1};
        if(f.side==="top")line={x0:target.x0,x1:target.x1,y0:target.y0-offset,y1:target.y0-offset};
        if(f.side==="bottom")line={x0:target.x0,x1:target.x1,y0:target.y1+offset,y1:target.y1+offset};
        setPath(s,b,`M ${n(line.x0)} ${n(line.y0)} L ${n(line.x1)} ${n(line.y1)}`);continue;
      }
      if(f.part==='gridline'&&b.path&&f.value!=null&&['linear','log'].includes(model.axes.get(f.axes!)!.ticking[f.axis!].scale)){const fit=sol.fits[f.axes!][v?'y':'x'],at=fit.m*(fit.log?Math.log(f.value):f.value)+fit.c;if(!Number.isFinite(at)){set(s,b.el,"display","none");continue;}setPath(s,b,v?`M ${n(target.x0)} ${n(at)} L ${n(target.x1)} ${n(at)}`:`M ${n(at)} ${n(target.y0)} L ${n(at)} ${n(target.y1)}`);continue;}
      if(f.part==="tick"&&b.x!=null&&b.y!=null){
        const fit=sol.fits[f.axes!][v?"y":"x"],at=f.value==null||!["linear","log"].includes(model.axes.get(f.axes!)!.ticking[f.axis!].scale)?null:fit.m*(fit.log?Math.log(f.value):f.value)+fit.c;const [mx,my]=mapped(a,b.x,b.y),x=v?mx:at??mx,y=v?at??my:my;const dx=v?(style.side==="right"?target.x1-old.x1:target.x0-old.x0):x-b.x,dy=v?y-b.y:style.side==="top"?target.y0-old.y0:target.y1-old.y1;
        if(!Number.isFinite(dx)||!Number.isFinite(dy)){set(s,b.el,"display","none");continue;}
        if(tag==="use"){set(s,b.el,"x",n(b.x+dx));set(s,b.el,"y",n(b.y+dy));}else translate(b,dx,dy);continue;
      }
    }
    if(b.x!=null&&b.y!=null){
      const [x,y]=mapped(a,b.x,b.y);
      if(tag==="use"){set(s,b.el,"x",n(x));set(s,b.el,"y",n(y));}else translate(b,x-b.x,y-b.y);continue;
    }
    if(b.path){
      if(f.box&&target){const box=f.box,fit=sol.fits[f.axes!],px=(v:number)=>fit.x.m*(fit.x.log?Math.log(v):v)+fit.x.c,py=(v:number)=>fit.y.m*(fit.y.log?Math.log(v):v)+fit.y.c,X=px(box.x!),e=box.widthPt!/2;
        const [lo,hi]=[py(box.y0!),py(box.y1!)].sort((a,b)=>a-b);let points:number[][]=[[X-e,hi],[X+e,hi]];
        if(box.notch!=null){const yn=py(box.notch),h=box.heightPt!/2,tip=e-Math.min(box.depthPt!,e),above=Math.max(yn-h,lo),below=Math.min(yn+h,hi),right=[[X+e,below],[X+tip,yn],[X+e,above]];points.push(...right,[X+e,lo],[X-e,lo],...right.slice().reverse().map(([x,y])=>[2*X-x,y]));}
        else points.push([X+e,lo],[X-e,lo]);
        setPath(s,b,points.map(([x,y],i)=>`${i?'L':'M'} ${n(x)} ${n(y)}`).join(' ')+' Z');
      }else if(f.mark&&target){
        // fluxplot meanmark part (_MeanPart.get_path): point-sized geometry anchored to data. The
        // circle moves rigidly with its mean; an arm runs from the rim to its bound; a cap keeps its
        // point length at the bound, losing the part hidden inside the circle when the arm is shorter.
        const m=f.mark,fit=sol.fits[f.axes!],h=m.orientation==='horizontal',k=h?0:1,px=(v:number)=>fit.x.m*(fit.x.log?Math.log(v):v)+fit.x.c,py=(v:number)=>fit.y.m*(fit.y.log?Math.log(v):v)+fit.y.c;
        const at=(v:number)=>h?[px(v),py(m.position)]:[px(m.position),py(v)],c=at(m.mean),P=(p:number[])=>`${n(p[0])} ${n(p[1])}`;
        if(m.bound==null){setPath(s,b,writeMplPath(b.path,{sx:1,sy:1,tx:c[0]-(c[0]-a.tx)/a.sx,ty:c[1]-(c[1]-a.ty)/a.sy}));continue;}
        const e=at(m.bound),delta=e[k]-c[k],r=m.radiusPt;
        if(m.capPt==null){const start=[...c];start[k]+=Math.sign(delta)*Math.min(Math.abs(delta),r);setPath(s,b,`M ${P(start)} L ${P(e)}`);continue;}
        // Cap ends follow matplotlib's vertex order; SVG y runs opposite to display y.
        const half=m.capPt/2,across=h?-1:1,lo=[...e],hi=[...e];lo[1-k]-=across*half;hi[1-k]+=across*half;
        if(Math.abs(delta)>=r){setPath(s,b,`M ${P(lo)} L ${P(hi)}`);continue;}
        const cut=Math.sqrt(r*r-delta*delta);if(half<=cut){setPath(s,b,`M ${P(e)}`);continue;}
        const innerLo=[...e],innerHi=[...e];innerLo[1-k]-=across*cut;innerHi[1-k]+=across*cut;
        setPath(s,b,`M ${P(lo)} L ${P(innerLo)} M ${P(innerHi)} L ${P(hi)}`);
      }else setPath(s,b,writeMplPath(b.path,a));continue;
    }
    const original=(key:string)=>s.pristine.get(b.el)&&key in s.pristine.get(b.el)!?s.pristine.get(b.el)![key]:b.el.getAttribute(key);
    const value=(key:string)=>Number(original(key)??0);
    if(tag==="rect"||tag==="image"){
      if(tag==='image')set(s,b.el,'preserveAspectRatio','none');
      const x=value("x"),y=value("y"),w=value("width"),h=value("height");
      const flipped=tag==='image'&&(b.transform??'').startsWith('scale(1 -1)');
      const [nx,ny]=mapped(a,x,flipped?-y:y),nh=h*a.sy;
      set(s,b.el,"x",n(nx));set(s,b.el,"y",n(flipped?-ny:ny));set(s,b.el,"width",n(w*a.sx));set(s,b.el,"height",n(nh));
      if(flipped)set(s,b.el,'transform',`scale(1 -1) translate(0 ${n(-nh)})`);
    }else if(tag==='circle'||tag==='ellipse'){
      const [x,y]=mapped(a,value('cx'),value('cy'));set(s,b.el,'cx',n(x));set(s,b.el,'cy',n(y));
      if(f.f!=='glyph')for(const key of tag==='circle'?['r']:['rx','ry'])set(s,b.el,key,n(value(key)*(key==='ry'?a.sy:a.sx)));
    }else if(tag==='polygon'||tag==='polyline'){
      const pts=(original('points')??'').match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g)?.map(Number)??[];const out=[];for(let i=0;i<pts.length;i+=2)out.push(mapped(a,pts[i],pts[i+1]).map(n).join(','));set(s,b.el,'points',out.join(' '));
    }else if(tag==="line"||tag==="lineargradient"){
      for(const [x,y]of [["x1","y1"],["x2","y2"]]){const p=mapped(a,value(x),value(y));set(s,b.el,x,n(p[0]));set(s,b.el,y,n(p[1]));}
    }
  }
  set(s,root,"viewBox",`0 0 ${n(sol.wPt)} ${n(sol.hPt)}`);
  if(tier==="exact")applyTickSets(s,model,sol,options.skipTickAxes);
}

function applyTickSets(s:State,model:RelayoutModel,sol:RelayoutSolution,skip?:ReadonlySet<string>){
  const close=(a:number,b:number)=>Math.abs(a-b)<=1e-9*Math.max(1e-300,Math.abs(a),Math.abs(b));
  for(const axis of model.axes.values())for(const [key,tickSet]of Object.entries(sol.ticks[axis.id]??{})){
    if(!tickSet.reticked||skip?.has(axis.id+'/'+key))continue;
    const original=Object.entries(model.layout.frames).filter(([,f])=>f.axes===axis.id&&f.axis===key&&f.value!=null&&['tick','ticklabel','gridline'].includes(f.part??''));
    const families=new Map<string,typeof original>();
    for(const entry of original){const family=entry[0].replace(/\.[^.]+$/,'');const list=families.get(family)??[];list.push(entry);families.set(family,list);}
    const domain=sol.domains[axis.id][key],[lo,hi]=domain.slice().sort((a,b)=>a-b),vertical=key==='y',fit=sol.fits[axis.id][vertical?'y':'x'];
    const pixel=(v:number)=>fit.m*(fit.log?Math.log(v):v)+fit.c;
    const old=asBox(axis.pixelBox),b=sol.axesBox[axis.id],scale=(v:number)=>axis.ticking[key].scale==='log'?Math.log(v):v,baseDomain=axis.ticking[key].domain;
    const oldPixel=(v:number)=>{const u=(scale(v)-scale(baseDomain[0]))/(scale(baseDomain[1])-scale(baseDomain[0]));return vertical?old.y1-u*height(old):old.x0+u*width(old);};
    for(const [family,members]of families){
      const template=members.find(([id])=>s.ids.has(id));if(!template)continue;const [templateId,tf]=template;
      const node=s.ids.get(templateId)!,values=tf.minor?tickSet.minor:tickSet.values;
      if(tf.minor&&(axis.ticking[key].minorRetick===false||!['log','auto-minor'].includes(axis.ticking[key].minor.kind)))continue;
      const visible=values.map((value,index)=>({value,index})).filter(t=>t.value>=lo&&t.value<=hi);
      for(const [id,f]of members){const el=s.ids.get(id);if(el&&!visible.some(t=>close(t.value,f.value!))){set(s,el,'display','none');set(s,el,'data-relayout-hidden','');}}
      for(const {value,index}of visible){
        const reuse=members.find(([id,f])=>s.ids.has(id)&&close(f.value!,value));
        let el:Element;
        if(reuse)el=s.ids.get(reuse[0])!;
        else {
          el=s.templates.get(templateId)!.cloneNode(true) as Element;
          el.id=s.prefix+family+`.r${index}`;el.setAttribute('data-relayout-tick','');el.setAttribute('data-relayout-source',templateId);el.setAttribute('data-value',String(value));
          for(const child of Array.from(el.querySelectorAll('[id]')))child.removeAttribute('id');
          node.parentNode!.appendChild(el);s.added.push(el);
          const cross=vertical?((tf.side??axis.axisStyle[key].side)==='right'?b.x1-old.x1:b.x0-old.x0):((tf.side??axis.axisStyle[key].side)==='top'?b.y0-old.y0:b.y1-old.y1),delta=pixel(value)-oldPixel(tf.value!),transform=el.getAttribute('transform')??'';
          el.setAttribute('transform',`translate(${n(vertical?cross:delta)} ${n(vertical?delta:cross)})${transform?' '+transform:''}`);
          el.removeAttribute('display');
          if(tf.part==='gridline'){
            const path=el.tagName.toLowerCase()==='path'?el:el.querySelector('path');
            if(path){el.removeAttribute('transform');path.removeAttribute('transform');path.setAttribute('d',vertical?`M ${n(b.x0)} ${n(pixel(value))} L ${n(b.x1)} ${n(pixel(value))}`:`M ${n(pixel(value))} ${n(b.y0)} L ${n(pixel(value))} ${n(b.y1)}`);}
          }
        }
        if(tf.part==='ticklabel'){
          const text=el.tagName.toLowerCase()==='text'?el:el.querySelector('text'),label=(tf.minor?tickSet.minorLabels:tickSet.labels)[index]??'',native=model.layout.texts[reuse?.[0]??templateId];
          if(text&&label!==native?.text){
            if(reuse&&!label.startsWith('$')&&!s.textContents.has(text))s.textContents.set(text,text.innerHTML);
            if(label.startsWith('$')&&native){
              if(reuse&&!s.textContents.has(el))s.textContents.set(el,el.innerHTML);
              const font=model.layout.fonts[native.font]??model.layout.fonts[axis.axisStyle[key].font];writeMathLabel(el,label,native,font);
            }else text.textContent=label;

          }
        }
      }
    }
    const offsetId=axis.axisStyle[key].offsetText,spec=axis.axisStyle[key].offsetSpec;
    let el=offsetId?s.ids.get(offsetId):null;
    if(!el&&tickSet.offset&&spec?.id&&spec.font&&spec.anchor){
      el=s.bindings[0]?.el.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','g');
      if(el){
        el.id=s.prefix+spec.id;el.setAttribute('data-role','tick-offset');el.setAttribute('data-relayout-owner',spec.id.replace(/\.[^.]+$/,''));
        const font=model.layout.fonts[spec.font],text=el.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','text');
        text.setAttribute('font-family',font.family);text.setAttribute('font-size',String(font.sizePt));if(font.weight!=null)text.setAttribute('font-weight',String(font.weight));if(font.style)text.setAttribute('font-style',font.style);
        text.setAttribute('text-anchor',spec.ha==='right'?'end':spec.ha==='center'?'middle':'start');
        const x=spec.anchor![0]+(vertical?(axis.axisStyle[key].side==='right'?b.x1-old.x1:b.x0-old.x0):b.x1-old.x1),y=spec.anchor![1]+(vertical?b.y0-old.y0:b.y1-old.y1);
        text.setAttribute('x',String(x));text.setAttribute('y',String(y+(spec.va==='top'?font.ascentPt:spec.va==='bottom'?-font.descentPt:0)));text.textContent=tickSet.offset;
        el.appendChild(text);s.root.appendChild(el);s.added.push(el);
        if(tickSet.offset.startsWith('$')){const native={anchor:[x,y],bbox:[x,y,x,y],font:spec.font,text:'',ha:spec.ha??'left',va:spec.va??'bottom',rotation:spec.rotation??0};writeMathLabel(el,tickSet.offset,native,font);}
      }
    }
    const text=el?.querySelector('text');
    if(offsetId&&text&&el&&tickSet.offset!==model.layout.texts[offsetId]?.text){
      const native=model.layout.texts[offsetId!];
      if(native&&tickSet.offset.startsWith('$')){if(!s.textContents.has(el))s.textContents.set(el,el.innerHTML);writeMathLabel(el,tickSet.offset,native,model.layout.fonts[native.font]);}
      else{if(!s.textContents.has(text))s.textContents.set(text,text.innerHTML);text.textContent=tickSet.offset;}
    }
  }
}
