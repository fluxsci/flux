import { asBox,width,height,type Box,type RelayoutModel } from './model';
import type { RelayoutSolution } from './solve';
type Legend=RelayoutModel['layout']['legends'][number];
export interface LegendGeometry {width:number;height:number;scale:number;entries:Map<string,{dx:number;dy:number}>}
/** Keep captured typography while it fits. When narrowing a multicolumn legend,
 * first use fewer columns; uniformly shrink only a still-oversized single row.
 * All metrics come from the capture, shared by the solver and SVG writer. */
export function legendGeometry(leg:Legend,model:RelayoutModel|undefined,owner:Box,figure:Box):LegendGeometry {
  const anchor=leg.bboxToAnchor?.bbox;
  // A legend placed beside the axes owns a dedicated horizontal margin. Its
  // width must not feed back into that axes' remaining width (a shrinking loop).
  const beside=leg.owner!=='figure'&&anchor&&((anchor[0]>=1&&leg.locRequested.includes('left'))||(anchor[0]+anchor[2]<=0&&leg.locRequested.includes('right')));
  const available=beside?Infinity:Math.max(.01,width(leg.bboxToAnchor?.frame==='figure'?figure:owner)-2*leg.borderAxesPadPt);
  const [nativeW,nativeH]=leg.sizePt,result:LegendGeometry={width:nativeW,height:nativeH,scale:1,entries:new Map()};
  if(nativeW<=available+1e-6)return result;
  const prefix=leg.id+'.entry.';
  const labels=Object.entries(model?.layout.texts??{}).flatMap(([id,t])=>{
    const suffix=id.startsWith(prefix)?id.slice(prefix.length):'',match=/^(\d+)\.label$/.exec(suffix);
    return match?[{id:prefix+match[1],index:Number(match[1]),text:t}]:[];
  }).sort((a,b)=>a.index-b.index);
  if(labels.length){
    const columns:number[]=[];for(const {text}of labels)if(!columns.some(x=>Math.abs(x-text.anchor[0])<1))columns.push(text.anchor[0]);columns.sort((a,b)=>a-b);
    if(columns.length>1&&!model?.layout.texts[leg.id+'.title']){
      const inset=columns[0]-leg.bbox[0],right=Math.max(0,leg.bbox[2]-Math.max(...labels.map(v=>v.text.bbox[2])));
      const top=Math.max(0,Math.min(...labels.map(v=>v.text.bbox[1]))-leg.bbox[1]),bottom=Math.max(0,leg.bbox[3]-Math.max(...labels.map(v=>v.text.bbox[3])));
      const rowH=Math.max(...labels.map(v=>v.text.bbox[3]-v.text.bbox[1]));
      const nativeRows=labels.filter(v=>Math.abs(v.text.anchor[0]-columns[0])<1).sort((a,b)=>a.text.bbox[1]-b.text.bbox[1]);
      const rowStep=nativeRows.length>1?(nativeRows.at(-1)!.text.bbox[1]-nativeRows[0].text.bbox[1])/(nativeRows.length-1):rowH+top+bottom;
      const columnGap=Math.max(0,columns[1]-inset-Math.max(...nativeRows.map(v=>v.text.bbox[2])));
      for(let count=columns.length-1;count>=1;count--){
        const groups:typeof labels[]=[],base=Math.floor(labels.length/count),extra=labels.length%count;let at=0;
        for(let c=0;c<count;c++){const n=base+Number(c<extra);groups.push(labels.slice(at,at+n));at+=n;}
        const widths=groups.map(g=>inset+Math.max(...g.map(v=>v.text.bbox[2]-v.text.anchor[0])));
        const w=widths.reduce((a,b)=>a+b,0)+columnGap*(count-1)+right;
        result.width=w;result.height=top+rowH+(Math.max(...groups.map(g=>g.length))-1)*Math.max(rowH,rowStep)+bottom;result.entries.clear();let x=leg.bbox[0];
        for(let c=0;c<groups.length;c++){
          groups[c].forEach(({id,text},row)=>result.entries.set(id,{dx:x+inset-text.anchor[0],dy:leg.bbox[1]+top+row*Math.max(rowH,rowStep)-text.bbox[1]}));
          x+=widths[c]+columnGap;
        }
        if(w<=available+1e-6)break;
      }
    }
  }
  result.scale=Math.min(1,available/Math.max(.01,result.width));
  return result;
}
export function legendBox(leg:Legend,owner:Box,figure:Box,location=leg.locRequested,model?:RelayoutModel):Box {
  let anchor=owner;
  if(leg.bboxToAnchor?.bbox){const [x,y,w,h]=leg.bboxToAnchor.bbox,p=leg.bboxToAnchor.frame==='figure'?figure:owner;anchor={x0:p.x0+x*width(p),x1:p.x0+(x+w)*width(p),y0:p.y1-(y+h)*height(p),y1:p.y1-y*height(p)};}
  const geometry=legendGeometry(leg,model,owner,figure),w=geometry.width*geometry.scale,h=geometry.height*geometry.scale,pad=leg.borderAxesPadPt;
  const xf=location.includes('left')?0:location.includes('right')?1:.5,yf=location.includes('upper')?0:location.includes('lower')?1:.5;
  const x=anchor.x0+(width(anchor)-w)*xf+(xf===0?pad:xf===1?-pad:0),y=anchor.y0+(height(anchor)-h)*yf+(yf===0?pad:yf===1?-pad:0);
  return {x0:x,x1:x+w,y0:y,y1:y+h};
}
const inside=(p:number[],b:Box)=>p[0]>=b.x0&&p[0]<=b.x1&&p[1]>=b.y0&&p[1]<=b.y1;
function intersects(p:number[],q:number[],b:Box):boolean {
  let lo=0,hi=1;
  for(const [i,min,max]of [[0,b.x0,b.x1],[1,b.y0,b.y1]]){
    const d=q[i]-p[i];if(!d){if(p[i]<min||p[i]>max)return false;continue;}
    let a=(min-p[i])/d,c=(max-p[i])/d;if(a>c)[a,c]=[c,a];lo=Math.max(lo,a);hi=Math.min(hi,c);if(lo>hi)return false;
  }
  return true;
}
/** Matplotlib Legend._find_best_position: minimize collisions, then code order. */
export function bestLegend(leg:Legend,model:RelayoutModel,owner:Box,figure:Box,fits:RelayoutSolution['fits']):Box {
  if(!leg.collision||!model.axes.has(leg.owner))return legendBox(leg,owner,figure,leg.locResolved,model);
  const axis=model.axes.get(leg.owner)!,old=asBox(axis.pixelBox),fit=fits[axis.id];
  const map=(p:number[])=>p.map((v,i)=>{const k=i?'y':'x',d=axis.ticking[k].domain,log=axis.ticking[k].scale==='log',t=(v:number)=>log?Math.log(v):v,p0=i?old.y1:old.x0,p1=i?old.y0:old.x1,oldM=(p1-p0)/(t(d[1])-t(d[0])),oldC=p0-oldM*t(d[0]);return fit[k].m*(v-oldC)/oldM+fit[k].c;});
  const lines=(leg.collision.lines??[]).map(line=>line.map(map)),points=(leg.collision.points??[]).map(map),boxes=(leg.collision.boxes??[]).map(v=>{const a=map([v[0],v[1]]),b=map([v[2],v[3]]);return {x0:Math.min(a[0],b[0]),x1:Math.max(a[0],b[0]),y0:Math.min(a[1],b[1]),y1:Math.max(a[1],b[1])};});
  let best:Box|undefined,score=Infinity;
  for(const loc of ['upper right','upper left','lower left','lower right','right','center left','center right','lower center','upper center','center']){
    const b=legendBox(leg,owner,figure,loc,model);
    const bad=lines.reduce((s,line)=>s+line.filter(p=>inside(p,b)).length+Number(line.some((p,i)=>i>0&&intersects(line[i-1],p,b))),0)+points.filter(p=>inside(p,b)).length+boxes.filter(p=>p.x1>=b.x0&&p.x0<=b.x1&&p.y1>=b.y0&&p.y0<=b.y1).length;
    if(bad<score){score=bad;best=b;}if(!score)break;
  }
  return best!;
}
