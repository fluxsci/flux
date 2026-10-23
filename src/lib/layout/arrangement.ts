/** Selection layout is a pure, immutable plan. Both the editor and headless ops
 * consume it; this module never owns history, DOM geometry or project mutation. */
import type { Element, Figure, Id } from '../types';
import { effectiveHidden, effectiveLocked, unitKeyOf } from '../groups';
import { balancedRows, selectionBBox, unionRect, validRowCounts, type AlignKind, type Rect } from '../geometry';
import { gridTracks, layoutDefaultGap, layoutMedian, layoutReadingOrder, type LayoutTrack } from './layoutMath';
export type { LayoutTrack } from './layoutMath';
export type FixedPoint = { x: 0 | 0.5 | 1; y: 0 | 0.5 | 1 };
export type LayoutTopology = 'row' | 'column' | 'grid';
export interface LayoutUnit { key:string; memberIds:Id[]; bounds:Rect }
export interface ResolvedLayoutUnit extends LayoutUnit { members:Element[] }
export interface LayoutTargetOptions { scope?:Id|null; excluded?:ReadonlySet<Id>; editable?:boolean }
export interface LayoutCell { key:string; column:number; row:number; offsetX:number; offsetY:number }
export interface LayoutPosition { id:Id; x:number; y:number }
export interface LayoutTranslation { id:Id; dx:number; dy:number }
export interface GapGuide { axis:'x'|'y'; index:number; value:number; x1:number; y1:number; x2:number; y2:number }
export interface LayoutSnapshot {
  figureId:Id; units:LayoutUnit[]; memberPositions:LayoutPosition[]; orderedKeys:string[];
  columns:LayoutTrack[]; rows:LayoutTrack[]; cells:LayoutCell[];
  cols:number; rowCount:number; gapX:number; gapY:number; regularX:boolean; regularY:boolean;
  topology:LayoutTopology; suggested:boolean; mode:'inferred'|'reflow'; bounds:Rect;
}
export interface ArrangementOptions {
  mode?:'tidy'|'reflow'; cols?:number; rows?:number; gapX?:number; gapY?:number;
  anchor?:FixedPoint; pin?:{x:number;y:number};
}
export interface ArrangementPlan {
  figureId:Id; translations:LayoutTranslation[]; positions:LayoutPosition[]; identity:boolean;
  units:LayoutUnit[]; bounds:Rect; columns:LayoutTrack[]; rows:LayoutTrack[]; cells:LayoutCell[];
  gaps:GapGuide[]; cols:number; rowCount:number; gapX:number; gapY:number;
  topology:LayoutTopology; suggested:boolean; mode:'inferred'|'reflow';
}
const EMPTY:Rect={x:0,y:0,w:0,h:0};
const finiteBox=(b:Rect)=>[b.x,b.y,b.w,b.h].every(Number.isFinite)&&b.w>=0&&b.h>=0;
const topology=(cols:number,rows:number):LayoutTopology=>rows<=1?'row':cols<=1?'column':'grid';
const sameNumber=(a:number,b:number)=>a===b;

/** Expand to whole units at the selected scope BEFORE applying editable policy.
 * editable:false is for scientific preflight, which must inspect every member
 * of a rigid group and refuse a partial move instead of silently excluding it. */
export function resolveLayoutUnits(figure:Figure, ids?:readonly Id[], options:LayoutTargetOptions={}):ResolvedLayoutUnit[] {
  if (options.scope && !figure.groups?.[options.scope]) throw new Error(`Unknown layout scope: ${options.scope}`);
  const wanted=ids===undefined?null:new Set(ids);
  const keys=new Set(figure.elements.filter(e=>!wanted||wanted.has(e.id)).map(e=>unitKeyOf(figure,e,options.scope)));
  const units=new Map<string,Element[]>();
  for (const e of figure.elements) {
    const key=unitKeyOf(figure,e,options.scope);
    if (!keys.has(key)) continue;
    if (options.editable!==false && (options.excluded?.has(e.id)||effectiveHidden(figure,e)||effectiveLocked(figure,e))) continue;
    const members=units.get(key); if(members)members.push(e);else units.set(key,[e]);
  }
  return [...units].map(([key,members])=>{
    const bounds=selectionBBox(members)!;
    if(!finiteBox(bounds))throw new Error(`Invalid layout bounds: ${key}`);
    return {key,members,memberIds:members.map(e=>e.id),bounds};
  });
}
function disjoint(tracks:LayoutTrack[],eps:number) {
  return tracks.slice(1).every((t,i)=>t.start>=tracks[i].start+tracks[i].size-eps);
}
function intersection(units:LayoutUnit[],axis:'x'|'y') {
  const size=axis==='x'?'w':'h';
  return Math.min(...units.map(u=>u.bounds[axis]+u.bounds[size]))-Math.max(...units.map(u=>u.bounds[axis]));
}
function envelope(units:LayoutUnit[],axis:'x'|'y'):LayoutTrack {
  const size=axis==='x'?'w':'h',start=Math.min(...units.map(u=>u.bounds[axis]));
  return {start,size:Math.max(...units.map(u=>u.bounds[axis]+u.bounds[size]))-start};
}
function gapOf(tracks:LayoutTrack[],eps:number,fallback:number) {
  const gaps=tracks.slice(1).map((t,i)=>{const gap=t.start-tracks[i].start-tracks[i].size;return Math.abs(gap)<=eps?0:gap;});
  if(!gaps.length)return {value:fallback,regular:true};
  const regular=Math.max(...gaps)-Math.min(...gaps)<=eps;
  if(regular)return {value:layoutMedian(gaps),regular};
  const buckets=new Map<number,number[]>();
  for(const gap of gaps){const k=Math.round(gap),bucket=buckets.get(k);if(bucket)bucket.push(gap);else buckets.set(k,[gap]);}
  const median=layoutMedian(gaps);
  const best=[...buckets].sort((a,b)=>b[1].length-a[1].length || Math.abs(a[0]-median)-Math.abs(b[0]-median) || a[0]-b[0])[0];
  return {value:layoutMedian(best[1]),regular:false};
}
/** Overlapping boxes alone do not identify a layout. Require a shared edge
 * or center on the transverse axis before recognizing an overlapping row or
 * column. Diagonal piles and coincident boxes remain ambiguous. */
function aligned(units:LayoutUnit[],axis:'x'|'y',eps:number):boolean {
  const size=axis==='x'?'w':'h';
  return [0,.5,1].some(factor=>{
    const first=units[0].bounds[axis]+factor*units[0].bounds[size];
    return units.every(u=>Math.abs(u.bounds[axis]+factor*u.bounds[size]-first)<=eps);
  });
}
function distinctProgression(units:LayoutUnit[],axis:'x'|'y',eps:number):boolean {
  const size=axis==='x'?'w':'h';
  return units.slice(1).every((u,i)=>u.bounds[axis]>units[i].bounds[axis]+eps &&
    u.bounds[axis]+u.bounds[size]/2>units[i].bounds[axis]+units[i].bounds[size]/2+eps);
}
/** Existing regular overlapping grids have separable aligned rows/columns.
 * Try top/center/bottom row alignment, then verify column correspondence and
 * uniform signed track gaps. This intentionally refuses irregular collisions:
 * explicit reflow remains available without guessing a new topology. */
function overlappingGrid(units:LayoutUnit[],eps:number):LayoutUnit[][]|null {
  for(const factor of [0,.5,1]){
    const coordinate=(u:LayoutUnit)=>u.bounds.y+factor*u.bounds.h;
    const sorted=[...units].sort((a,b)=>coordinate(a)-coordinate(b)||a.bounds.x-b.bounds.x||a.key.localeCompare(b.key));
    const bands:LayoutUnit[][]=[];
    for(const unit of sorted){const band=bands.at(-1);if(band&&coordinate(unit)-coordinate(band[0])<=eps)band.push(unit);else bands.push([unit]);}
    const C=bands[0].length;
    if(C<2||bands.length<2||bands.some((b,i)=>i<bands.length-1?b.length!==C:b.length>C))continue;
    for(const band of bands)band.sort((a,b)=>a.bounds.x-b.bounds.x||a.key.localeCompare(b.key));
    if(bands.some(b=>!distinctProgression(b,'x',eps)))continue;
    const members=Array.from({length:C},(_,c)=>bands.flatMap(b=>b[c]?[b[c]]:[]));
    if(members.some(c=>!aligned(c,'x',eps)||!distinctProgression(c,'y',eps)))continue;
    const columns=members.map(c=>envelope(c,'x')),rows=bands.map(b=>envelope(b,'y'));
    if(gapOf(columns,eps,0).regular&&gapOf(rows,eps,0).regular)return bands;
  }
  return null;
}
function detectedBands(units:LayoutUnit[],eps:number):LayoutUnit[][]|null {
  if(units.length<2||units.some(u=>u.bounds.w<=eps||u.bounds.h<=eps))return null;
  const x=[...units].sort((a,b)=>a.bounds.x-b.bounds.x||a.key.localeCompare(b.key));
  const y=[...units].sort((a,b)=>a.bounds.y-b.bounds.y||a.key.localeCompare(b.key));
  const commonX=intersection(units,'x'),commonY=intersection(units,'y');
  const isRow=commonY>eps&&disjoint(x.map(u=>({start:u.bounds.x,size:u.bounds.w})),eps);
  const isCol=commonX>eps&&disjoint(y.map(u=>({start:u.bounds.y,size:u.bounds.h})),eps);
  if(isRow!==isCol)return isRow?[x]:y.map(u=>[u]);
  if(isRow)return null;
  const overlapRow=commonY>eps&&aligned(units,'y',eps)&&distinctProgression(x,'x',eps);
  const overlapCol=commonX>eps&&aligned(units,'x',eps)&&distinctProgression(y,'y',eps);
  if(overlapRow!==overlapCol)return overlapRow?[x]:y.map(u=>[u]);
  const bands:LayoutUnit[][]=[];
  const byCenter=[...units].sort((a,b)=>(a.bounds.y+a.bounds.h/2)-(b.bounds.y+b.bounds.h/2)||a.bounds.x-b.bounds.x||a.key.localeCompare(b.key));
  // Maintain the current band's common interval in O(1) per unit. Re-scanning
  // a growing band makes an overlapping 5k-object selection quadratic.
  let bandTop=0,bandBottom=0;
  for(const unit of byCenter){
    const top=unit.bounds.y,bottom=top+unit.bounds.h,band=bands.at(-1);
    if(band&&Math.min(bandBottom,bottom)-Math.max(bandTop,top)>eps){band.push(unit);bandTop=Math.max(bandTop,top);bandBottom=Math.min(bandBottom,bottom);}
    else {bands.push([unit]);bandTop=top;bandBottom=bottom;}
  }
  const C=bands[0]?.length??0;
  if(C<2||bands.length<2||bands.some((b,i)=>i<bands.length-1?b.length!==C:b.length>C))return overlappingGrid(units,eps);
  for(const band of bands)band.sort((a,b)=>a.bounds.x-b.bounds.x||a.key.localeCompare(b.key));
  if(!disjoint(bands.map(b=>envelope(b,'y')),eps))return overlappingGrid(units,eps);
  const columns=Array.from({length:C},(_,c)=>bands.flatMap(b=>b[c]?[b[c]]:[]));
  if(columns.some(c=>intersection(c,'x')<=eps)||!disjoint(columns.map(c=>envelope(c,'x')),eps))return overlappingGrid(units,eps);
  return bands;
}
export function createArrangementSnapshot(figure:Figure, ids?:readonly Id[], options:LayoutTargetOptions={}):LayoutSnapshot {
  const resolved=resolveLayoutUnits(figure,ids,options),units=resolved.map(({key,memberIds,bounds})=>({key,memberIds,bounds:{...bounds}}));
  const memberPositions=resolved.flatMap(u=>u.members.map(e=>({id:e.id,x:e.x,y:e.y})));
  const bounds=unionRect(units.map(u=>u.bounds))??{...EMPTY},eps=1e-6*Math.max(1,bounds.w,bounds.h),fallback=layoutDefaultGap(units.map(u=>u.bounds));
  let bands=detectedBands(units,eps),suggested=!bands;
  if(!bands){const ordered=layoutReadingOrder(units,u=>u.bounds),C=units.length?Math.ceil(units.length/balancedRows(units.length)):0;bands=[];for(let i=0;i<ordered.length;i+=C)bands.push(ordered.slice(i,i+C));}
  const cols=bands[0]?.length??0,rowCount=bands.length;
  const columns=Array.from({length:cols},(_,c)=>envelope(bands!.flatMap(b=>b[c]?[b[c]]:[]),'x'));
  const rows=bands.map(b=>envelope(b,'y'));
  const gx=suggested?{value:fallback,regular:false}:gapOf(columns,eps,fallback),gy=suggested?{value:fallback,regular:false}:gapOf(rows,eps,fallback);
  const cells=bands.flatMap((band,row)=>band.map((u,column)=>({key:u.key,column,row,offsetX:u.bounds.x-columns[column].start,offsetY:u.bounds.y-rows[row].start})));
  return {figureId:figure.id,units,memberPositions,orderedKeys:bands.flat().map(u=>u.key),columns,rows,cells,cols,rowCount,gapX:gx.value,gapY:gy.value,regularX:gx.regular,regularY:gy.regular,topology:topology(cols,rowCount),suggested,mode:suggested?'reflow':'inferred',bounds};
}
function checkOptions(options:ArrangementOptions) {
  if(options.mode!==undefined&&options.mode!=='tidy'&&options.mode!=='reflow')throw new Error('Invalid arrangement mode');
  if(options.mode==='tidy'&&(options.cols!==undefined||options.rows!==undefined))throw new Error('Tidy does not accept rows or columns');
  for(const [key,value] of [['cols',options.cols],['rows',options.rows]] as const)if(value!==undefined&&(!Number.isInteger(value)||value<1))throw new Error(`${key} must be a positive integer`);
  for(const value of [options.gapX,options.gapY])if(value!==undefined&&!Number.isFinite(value))throw new Error('Layout gaps must be finite');
  if(options.anchor&&![options.anchor.x,options.anchor.y].every(v=>v===0||v===.5||v===1))throw new Error('Invalid layout anchor');
  if(options.pin&&![options.pin.x,options.pin.y].every(Number.isFinite))throw new Error('Invalid layout pin');
}
export function arrangementPin(bounds:Rect,anchor:FixedPoint):{x:number;y:number} {
  return {x:bounds.x+anchor.x*bounds.w,y:bounds.y+anchor.y*bounds.h};
}
function guides(columns:LayoutTrack[],rows:LayoutTrack[],cells:LayoutCell[],gapX:number,gapY:number):GapGuide[]{
  const out:GapGuide[]=[],occupied=new Uint8Array(columns.length*rows.length);
  for(const cell of cells)occupied[cell.row*columns.length+cell.column]=1;
  for(let c=0;c<columns.length-1;c++){
    let low=Infinity,high=-Infinity;
    for(let r=0;r<rows.length;r++)if(occupied[r*columns.length+c]&&occupied[r*columns.length+c+1]){low=Math.min(low,rows[r].start);high=Math.max(high,rows[r].start+rows[r].size);}
    if(!Number.isFinite(low))continue;
    const x=(columns[c].start+columns[c].size+columns[c+1].start)/2;
    out.push({axis:'x',index:c,value:gapX,x1:x,x2:x,y1:low,y2:high});
  }
  for(let r=0;r<rows.length-1;r++){
    let low=Infinity,high=-Infinity;
    for(let c=0;c<columns.length;c++)if(occupied[r*columns.length+c]&&occupied[(r+1)*columns.length+c]){low=Math.min(low,columns[c].start);high=Math.max(high,columns[c].start+columns[c].size);}
    if(!Number.isFinite(low))continue;
    const y=(rows[r].start+rows[r].size+rows[r+1].start)/2;
    out.push({axis:'y',index:r,value:gapY,x1:low,x2:high,y1:y,y2:y});
  }
  return out;
}
/** Undefined gap axes retain exact regular input positions. An explicit gap is
 * an edit, including a value equal to the representative display value. */
export function planArrangement(snapshot:LayoutSnapshot,options:ArrangementOptions={}):ArrangementPlan {
  checkOptions(options);
  const n=snapshot.units.length,reflow=options.mode==='reflow'||options.cols!==undefined||options.rows!==undefined||snapshot.suggested;
  let cols=snapshot.cols;
  if(reflow&&n){
    if(options.cols!==undefined)cols=Math.min(n,options.cols);
    else if(options.rows!==undefined){const r=validRowCounts(n).reduce((a,b)=>Math.abs(b-options.rows!)<Math.abs(a-options.rows!)?b:a);cols=Math.ceil(n/r);}
    else cols=Math.ceil(n/balancedRows(n));
  }
  const gapX=options.gapX??snapshot.gapX,gapY=options.gapY??snapshot.gapY;
  // The common regular-layout entry has no geometry work. Reuse its immutable
  // baseline rather than building and comparing per-member positions just to
  // rediscover identity (important for direct Alt+T on thousands of objects).
  if(n>=2&&!reflow&&options.gapX===undefined&&options.gapY===undefined&&snapshot.regularX&&snapshot.regularY){
    if(!finiteBox(snapshot.bounds)||snapshot.units.some(u=>!finiteBox(u.bounds))||snapshot.memberPositions.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new Error('Arrangement overflowed finite geometry');
    return {figureId:snapshot.figureId,positions:snapshot.memberPositions,translations:[],identity:true,
      units:snapshot.units,bounds:snapshot.bounds,columns:snapshot.columns,rows:snapshot.rows,cells:snapshot.cells,
      gaps:guides(snapshot.columns,snapshot.rows,snapshot.cells,gapX,gapY),cols:snapshot.cols,rowCount:snapshot.rowCount,
      gapX,gapY,topology:snapshot.topology,suggested:false,mode:'inferred'};
  }
  const byKey=new Map(snapshot.units.map(u=>[u.key,u]));
  const anchor=options.anchor??{x:.5,y:.5},pin=options.pin??arrangementPin(snapshot.bounds,anchor);
  // The frozen topology and member IDs are read-only across previews. Share
  // them instead of allocating thousands of identical objects per pointermove.
  let columns=snapshot.columns,rows=snapshot.rows,cells=snapshot.cells;
  let boxes:Map<string,Rect>;
  if(n>=2&&reflow){
    const ordered=snapshot.orderedKeys.map(k=>byKey.get(k)!);
    const grid=gridTracks(ordered.map(u=>u.bounds),cols,gapX,gapY);
    const local=unionRect(grid.boxes)!;const ox=pin.x-anchor.x*local.w-local.x,oy=pin.y-anchor.y*local.h-local.y;
    columns=grid.columns.map(t=>({...t,start:t.start+ox}));rows=grid.rows.map(t=>({...t,start:t.start+oy}));
    boxes=new Map(ordered.map((u,i)=>[u.key,{...grid.boxes[i],x:grid.boxes[i].x+ox,y:grid.boxes[i].y+oy}]));
    cells=ordered.map((u,i)=>{const column=i%cols,row=Math.floor(i/cols),b=boxes.get(u.key)!;return {key:u.key,column,row,offsetX:b.x-columns[column].start,offsetY:b.y-rows[row].start};});
  }else if(n>=2){
    const changeX=columns.length>1&&(options.gapX!==undefined||!snapshot.regularX);
    const changeY=rows.length>1&&(options.gapY!==undefined||!snapshot.regularY);
    const moveTracks=(tracks:LayoutTrack[],gap:number,p:number,a:number):LayoutTrack[]=>{
      // Signed gaps can overlap or even reverse physical track positions.
      // Preserve logical membership/order, and anchor the actual union instead
      // of the nominal sum of sizes (which can be smaller or negative).
      let start=0,low=Infinity,high=-Infinity;
      const result=tracks.map(t=>{const next={start,size:t.size};low=Math.min(low,start);high=Math.max(high,start+t.size);start+=t.size+gap;return next;});
      const shift=p-a*(high-low)-low;
      return result.map(t=>({...t,start:t.start+shift}));
    };
    if(changeX)columns=moveTracks(columns,gapX,pin.x,anchor.x);
    if(changeY)rows=moveTracks(rows,gapY,pin.y,anchor.y);
    boxes=new Map(cells.map(c=>{const old=byKey.get(c.key)!.bounds;return [c.key,{...old,x:changeX?columns[c.column].start+c.offsetX:old.x,y:changeY?rows[c.row].start+c.offsetY:old.y}];}));
  }else boxes=new Map(snapshot.units.map(u=>[u.key,{...u.bounds}]));
  const deltas=new Map<string,{dx:number;dy:number}>();
  const units=snapshot.units.map(u=>{const bounds=boxes.get(u.key)!;const delta={dx:bounds.x-u.bounds.x,dy:bounds.y-u.bounds.y};for(const id of u.memberIds)deltas.set(id,delta);return {...u,bounds};});
  const positions:LayoutPosition[]=[],translations:LayoutTranslation[]=[];
  for(const e of snapshot.memberPositions){
    const d=deltas.get(e.id)!,p={id:e.id,x:d.dx===0?e.x:e.x+d.dx,y:d.dy===0?e.y:e.y+d.dy};
    positions.push(p);
    if(!sameNumber(e.x,p.x)||!sameNumber(e.y,p.y))translations.push({id:e.id,dx:p.x-e.x,dy:p.y-e.y});
  }
  const bounds=unionRect(units.map(u=>u.bounds))??{...EMPTY};
  if(!finiteBox(bounds)||positions.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new Error('Arrangement overflowed finite geometry');
  return {figureId:snapshot.figureId,positions,translations,identity:translations.length===0,units,bounds,columns,rows,cells,gaps:guides(columns,rows,cells,gapX,gapY),cols,rowCount:rows.length,gapX,gapY,topology:topology(cols,rows.length),suggested:snapshot.suggested&&options.mode!=='reflow'&&options.cols===undefined&&options.rows===undefined,mode:reflow?'reflow':'inferred'};
}
/** A gesture baseline captures current exact positions without re-inferring
 * topology/order or losing the stored default for an inactive gap axis. */
export function snapshotAfterArrangement(snapshot:LayoutSnapshot,plan:ArrangementPlan):LayoutSnapshot {
  if(snapshot.figureId!==plan.figureId)throw new Error('Arrangement owner changed');
  return {figureId:plan.figureId,units:plan.units.map(u=>({...u,memberIds:[...u.memberIds],bounds:{...u.bounds}})),memberPositions:plan.positions.map(p=>({...p})),orderedKeys:[...snapshot.orderedKeys],columns:plan.columns.map(t=>({...t})),rows:plan.rows.map(t=>({...t})),cells:plan.cells.map(c=>({...c})),cols:plan.cols,rowCount:plan.rowCount,gapX:plan.gapX,gapY:plan.gapY,regularX:true,regularY:true,topology:plan.topology,suggested:false,mode:plan.mode,bounds:{...plan.bounds}};
}
export type AlignTarget='selection'|'figure'|{unitKey:string};
export interface AlignOptions extends LayoutTargetOptions { target?:AlignTarget }
export function planAlignment(figure:Figure,ids:readonly Id[]|undefined,kind:AlignKind,options:AlignOptions={}):LayoutTranslation[] {
  const kinds:AlignKind[]=['left','right','top','bottom','centerH','centerV'];
  if(!kinds.includes(kind))throw new Error('Unknown alignment kind');
  if(options.target!==undefined&&options.target!=='selection'&&options.target!=='figure'&&(typeof options.target!=='object'||!options.target||typeof options.target.unitKey!=='string'))throw new Error('Invalid alignment target');
  const units=resolveLayoutUnits(figure,ids,options);if(!units.length)return [];
  let ref:Rect;
  if(options.target==='figure')ref={x:0,y:0,w:figure.width,h:figure.height};
  else if(typeof options.target==='object'){const key=options.target.unitKey;const unit=units.find(u=>u.key===key||u.memberIds.includes(key));if(!unit)throw new Error('Reference unit is not editable in this selection');ref=unit.bounds;}
  else ref=unionRect(units.map(u=>u.bounds))!;
  return units.flatMap(u=>{let dx=0,dy=0;const b=u.bounds;
    if(typeof options.target==='object'&&(u.key===options.target.unitKey||u.memberIds.includes(options.target.unitKey)))return [];
    if(options.target!=='figure'&&typeof options.target!=='object'&&units.length===1)return [];
    if(kind==='left')dx=ref.x-b.x;else if(kind==='right')dx=ref.x+ref.w-b.x-b.w;else if(kind==='centerH')dx=ref.x+ref.w/2-b.x-b.w/2;
    else if(kind==='top')dy=ref.y-b.y;else if(kind==='bottom')dy=ref.y+ref.h-b.y-b.h;else dy=ref.y+ref.h/2-b.y-b.h/2;
    return dx===0&&dy===0?[]:u.memberIds.map(id=>({id,dx,dy}));
  });
}
