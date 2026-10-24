import { asBox,width,height,type Box,type RelayoutModel } from './model';
import type { RelayoutSolution } from './solve';
type Legend=RelayoutModel['layout']['legends'][number];
export function legendBox(leg:Legend,owner:Box,figure:Box,location=leg.locRequested):Box {
  let anchor=owner;
  if(leg.bboxToAnchor?.bbox){const [x,y,w,h]=leg.bboxToAnchor.bbox,p=leg.bboxToAnchor.frame==='figure'?figure:owner;anchor={x0:p.x0+x*width(p),x1:p.x0+(x+w)*width(p),y0:p.y1-(y+h)*height(p),y1:p.y1-y*height(p)};}
  const [w,h]=leg.sizePt,pad=leg.borderAxesPadPt;
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
  if(!leg.collision||!model.axes.has(leg.owner))return legendBox(leg,owner,figure,leg.locResolved);
  const axis=model.axes.get(leg.owner)!,old=asBox(axis.pixelBox),fit=fits[axis.id];
  const map=(p:number[])=>p.map((v,i)=>{const k=i?'y':'x',d=axis.ticking[k].domain,log=axis.ticking[k].scale==='log',t=(v:number)=>log?Math.log(v):v,p0=i?old.y1:old.x0,p1=i?old.y0:old.x1,oldM=(p1-p0)/(t(d[1])-t(d[0])),oldC=p0-oldM*t(d[0]);return fit[k].m*(v-oldC)/oldM+fit[k].c;});
  const lines=(leg.collision.lines??[]).map(line=>line.map(map)),points=(leg.collision.points??[]).map(map),boxes=(leg.collision.boxes??[]).map(v=>{const a=map([v[0],v[1]]),b=map([v[2],v[3]]);return {x0:Math.min(a[0],b[0]),x1:Math.max(a[0],b[0]),y0:Math.min(a[1],b[1]),y1:Math.max(a[1],b[1])};});
  let best:Box|undefined,score=Infinity;
  for(const loc of ['upper right','upper left','lower left','lower right','right','center left','center right','lower center','upper center','center']){
    const b=legendBox(leg,owner,figure,loc);
    const bad=lines.reduce((s,line)=>s+line.filter(p=>inside(p,b)).length+Number(line.some((p,i)=>i>0&&intersects(line[i-1],p,b))),0)+points.filter(p=>inside(p,b)).length+boxes.filter(p=>p.x1>=b.x0&&p.x0<=b.x1&&p.y1>=b.y0&&p.y0<=b.y1).length;
    if(bad<score){score=bad;best=b;}if(!score)break;
  }
  return best!;
}
