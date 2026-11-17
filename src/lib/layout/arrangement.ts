/** Selection layout is a pure, immutable plan. Both the editor and headless ops
 * consume it; this module never owns history, DOM geometry or project mutation. */
import type { Element, Figure, Id } from '../types';
import { effectiveHidden, effectiveLocked, unitKeyOf } from '../groups';
import { balancedRows, unitBBox, unionRect, validRowCounts, type AlignKind, type LayoutBox, type Rect } from '../geometry';
import { gridTracks, layoutDefaultGap, layoutMedian, layoutReadingOrder, type LayoutTrack } from './layoutMath';
export type { LayoutTrack } from './layoutMath';
export type FixedPoint = { x: 0 | 0.5 | 1; y: 0 | 0.5 | 1 };
export type LayoutTopology = 'row' | 'column' | 'grid';
export interface LayoutUnit { key:string; memberIds:Id[]; bounds:Rect }
export interface ResolvedLayoutUnit extends LayoutUnit { members:Element[] }
export interface LayoutTargetOptions { scope?:Id|null; excluded?:ReadonlySet<Id>; editable?:boolean; box?:LayoutBox }
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
  /** Reflow only: where each unit sits inside its cell (default: centered). */
  align?:FixedPoint;
  /** Reflow only: a line each unit carries, in figure coordinates and keyed by unit: `x` the
   * vertical line the members of a COLUMN then share, `y` the horizontal line the members of a
   * ROW share (a plot's spines; see plot/landmarks plotAxisLines). An axis counts only when
   * every unit has its line, and then replaces `align` on that axis. */
  lines?:LayoutLines;
}
export interface LayoutLines { x?:ReadonlyMap<string,number>; y?:ReadonlyMap<string,number> }
/** Per-unit offsets from each unit's start to its line, or undefined unless all have one. */
function lineOffsets(units:readonly LayoutUnit[],axis:'x'|'y',lines:LayoutLines|undefined):number[]|undefined {
  const map=lines?.[axis];if(!map||!units.length)return undefined;
  const offsets:number[]=[];
  for(const u of units){const line=map.get(u.key);if(line===undefined||!Number.isFinite(line))return undefined;offsets.push(line-u.bounds[axis]);}
  return offsets;
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
const inset=(offset:number)=>Math.round(offset*4294967296)/4294967296;

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
    const bounds=unitBBox(members,options.box)!;
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
  if(options.align&&![options.align.x,options.align.y].every(v=>v===0||v===.5||v===1))throw new Error('Invalid cell alignment');
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
    const grid=gridTracks(ordered.map(u=>u.bounds),cols,gapX,gapY,0,0,options.align?.x??.5,options.align?.y??.5,{x:lineOffsets(ordered,'x',options.lines),y:lineOffsets(ordered,'y',options.lines)});
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
  const deltas=new Map<string,{dx:number;dy:number;from:Rect;to:Rect}>();
  const units=snapshot.units.map(u=>{const bounds=boxes.get(u.key)!;const delta={dx:bounds.x-u.bounds.x,dy:bounds.y-u.bounds.y,from:u.bounds,to:bounds};for(const id of u.memberIds)deltas.set(id,delta);return {...u,bounds};});
  const positions:LayoutPosition[]=[],translations:LayoutTranslation[]=[];
  for(const e of snapshot.memberPositions){
    // A moved member lands at the planned origin plus its own offset inside the unit (kept to
    // 2^-32 px). Adding a difference back to the old position would leave the members of one
    // track an ulp apart: "Mixed" in the Inspector for a column that is exactly aligned.
    const d=deltas.get(e.id)!,p={id:e.id,x:d.dx===0?e.x:d.to.x+inset(e.x-d.from.x),y:d.dy===0?e.y:d.to.y+inset(e.y-d.from.y)};
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
/* ---- Crystallize: recognize the arrangement a loose selection is closest to ------------------
 * planArrangement keeps what is already there (tracks, order, transverse offsets). This is the
 * other half: read a selection somebody placed BY HAND as the row, column or grid it was meant to
 * be, and plan that arrangement outright: aligned inside its tracks, one gap per axis. Pure, so
 * the editor's one-key Crystallize and the headless `arrange --mode auto` are the same plan. */
export type AutoArrangementRefusal='too-few'|'pile'|'spanning';
export interface AutoArrangement {
  plan:ArrangementPlan; topology:LayoutTopology; rows:number; cols:number; moves:boolean;
  /** True when the units were lined up on the lines they carry (plot axes), not on their boxes. */
  onLines:boolean;
  /** Those shared lines as planned, one per track of two or more units (for a preview). */
  rails:{x1:number;y1:number;x2:number;y2:number}[];
}
const autoCenter=(u:LayoutUnit,axis:'x'|'y')=>u.bounds[axis]+u.bounds[axis==='x'?'w':'h']/2;
/** Units share a band when one's center lies inside the other's extent (for equal sizes: more
 * than half an overlap). The band keeps the INTERSECTION of its members, so a steep staircase
 * cannot chain itself into one band; a gentle slant is rejoined below. */
function autoBands(units:readonly LayoutUnit[],axis:'x'|'y',strict=false):{members:LayoutUnit[];lo:number;hi:number}[] {
  const size=axis==='x'?'w':'h',bands:{members:LayoutUnit[];lo:number;hi:number}[]=[];
  for(const unit of [...units].sort((a,b)=>autoCenter(a,axis)-autoCenter(b,axis)||a.key.localeCompare(b.key))){
    const start=unit.bounds[axis],end=start+unit.bounds[size],center=(start+end)/2,band=bands.at(-1),mid=band?(band.lo+band.hi)/2:0;
    if(band&&((center>=band.lo&&center<=band.hi)||(mid>=start&&mid<=end))){band.members.push(unit);band.lo=Math.max(band.lo,start);band.hi=Math.min(band.hi,end);}
    else bands.push({members:[unit],lo:start,hi:end});
  }
  if(strict)return bands;
  // A slanted row drifts out of its own intersection and splits. Neighbouring bands whose
  // extents still overlap by more than a third of a typical unit are one band, drifting.
  const merged:typeof bands=[];
  for(const band of bands){
    const previous=merged.at(-1);
    if(previous){
      const a=envelope(previous.members,axis),b=envelope(band.members,axis);
      const overlap=Math.min(a.start+a.size,b.start+b.size)-Math.max(a.start,b.start);
      if(overlap>layoutMedian([...previous.members,...band.members].map(u=>u.bounds[size]))/3){
        previous.members.push(...band.members);previous.lo=Math.max(previous.lo,band.lo);previous.hi=Math.min(previous.hi,band.hi);continue;
      }
    }
    merged.push(band);
  }
  return merged;
}
/** A unit that reaches across the middle of ANOTHER band (a tall panel beside two stacked ones)
 * is a spanning layout, which a plain grid cannot hold without tearing it apart. */
function autoSpans(bands:{members:LayoutUnit[];lo:number;hi:number}[],axis:'x'|'y'):boolean {
  const size=axis==='x'?'w':'h';
  // Bands are in order along the axis, so a spanning unit reaches a NEIGHBOURING band first:
  // two checks per unit, never bands x bands (thousands of single-unit bands stay linear).
  return bands.some((band,i)=>band.members.some(u=>[bands[i-1],bands[i+1]].some(other=>{
    if(!other)return false;
    const mid=(other.lo+other.hi)/2,margin=Math.max(0,Math.min(u.bounds[size],other.hi-other.lo))*.25;
    return mid>u.bounds[axis]+margin&&mid<u.bounds[axis]+u.bounds[size]-margin;
  })));
}
/** The gaps between neighbours inside each band, along `axis`. */
function autoGaps(bands:{members:LayoutUnit[]}[],axis:'x'|'y'):number[] {
  const size=axis==='x'?'w':'h';
  return bands.flatMap(band=>{
    const line=[...band.members].sort((a,b)=>a.bounds[axis]-b.bounds[axis]||a.key.localeCompare(b.key));
    return line.slice(1).map((u,i)=>u.bounds[axis]-line[i].bounds[axis]-line[i].bounds[size]);
  });
}
/** Whole numbers where a pixel is small beside the objects; exact medians for tiny geometry. */
function autoNiceGap(gap:number,scale:number):number {
  if(scale<8)return gap;
  const magnitude=Math.abs(gap),step=magnitude>=10?1:magnitude>=2?.5:.1,rounded=Math.round(gap/step)*step;
  return rounded===0?0:Number(rounded.toFixed(3));
}
/** The edge or center the members of each band already (nearly) share. Ties keep the center. */
function autoAlign(bands:{members:LayoutUnit[]}[],axis:'x'|'y'):0|.5|1 {
  const size=axis==='x'?'w':'h';let best:0|.5|1=.5,bestCost=-1;
  for(const factor of [.5,0,1] as const){
    let cost=0;
    for(const {members} of bands){
      if(members.length<2)continue;
      const values=members.map(u=>u.bounds[axis]+factor*u.bounds[size]),mean=values.reduce((a,b)=>a+b,0)/values.length;
      for(const v of values)cost+=(v-mean)*(v-mean);
    }
    if(bestCost<0||cost<bestCost-1e-9*(bestCost+1)){best=factor;bestCost=cost;}
  }
  return best;
}
/** Units that all overlap both ways are a pile, unless they are a deliberate overlapping stack
 * (staggered traces): centers marching along one axis and all but still along the other. */
function autoStackAxis(units:readonly LayoutUnit[]):'x'|'y'|null {
  const run=(axis:'x'|'y')=>{
    const centers=units.map(u=>autoCenter(u,axis)).sort((a,b)=>a-b);
    const step=Math.min(...centers.slice(1).map((c,i)=>c-centers[i]));
    return {span:centers[centers.length-1]-centers[0],step,size:layoutMedian(units.map(u=>u.bounds[axis==='x'?'w':'h']))};
  };
  const x=run('x'),y=run('y');
  if(y.span>=3*x.span&&y.step>y.size*.1)return 'y';
  if(x.span>=3*y.span&&x.step>x.size*.1)return 'x';
  return null;
}
/** One object sitting ON another (a label on its panel, an inset in a plot): its center is
 * inside the other's box and not the other way round. A grid would pull the two apart, so the
 * pair is no arrangement until it is grouped. Mutual containment is an overlapping stack. */
function autoNested(units:readonly LayoutUnit[]):boolean {
  if(units.length>1500)return false;
  const within=(u:LayoutUnit,box:Rect)=>{const x=autoCenter(u,'x'),y=autoCenter(u,'y');return x>box.x&&x<box.x+box.w&&y>box.y&&y<box.y+box.h;};
  const line=[...units].sort((a,b)=>a.bounds.x-b.bounds.x);
  for(let i=0;i<line.length;i++)for(let j=i+1;j<line.length&&line[j].bounds.x<=line[i].bounds.x+line[i].bounds.w;j++)
    if(within(line[i],line[j].bounds)!==within(line[j],line[i].bounds))return true;
  return false;
}
/** Why a selection has no automatic arrangement, or null when it has one. */
export function autoArrangementRefusal(snapshot:LayoutSnapshot):AutoArrangementRefusal|null {
  if(snapshot.units.length<2)return 'too-few';
  if(autoNested(snapshot.units))return 'pile';
  if(autoBands(snapshot.units,'y').length===1&&autoBands(snapshot.units,'x').length===1)return autoStackAxis(snapshot.units)?null:'pile';
  // Spans are judged on the strict bands: rejoining a slant would swallow the very rows a
  // tall unit reaches across.
  if(autoSpans(autoBands(snapshot.units,'y',true),'y')||autoSpans(autoBands(snapshot.units,'x',true),'x'))return 'spanning';
  return null;
}
/** Recognize the closest row, column or grid and plan it. One row band is a row and one column
 * band a column; otherwise the rows (or, when every unit is alone in its row, the columns) carry
 * the grid, and a leftover unit that completes a rectangle does (three above one is 2 x 2).
 * Returns null where there is nothing to recognize: fewer than two units, a pile (or one object
 * sitting on another), or a unit spanning several rows or columns. `moves` is false when the selection already IS that plan. */
export function planAutoArrangement(snapshot:LayoutSnapshot,options:Pick<ArrangementOptions,'anchor'|'pin'|'lines'>={}):AutoArrangement|null {
  if(autoArrangementRefusal(snapshot))return null;
  const units=snapshot.units,n=units.length;
  const rowBands=autoBands(units,'y'),columnBands=autoBands(units,'x'),R=rowBands.length,K=columnBands.length;
  const nearest=(counts:number[],wanted:number)=>counts.reduce((a,b)=>Math.abs(b-wanted)<Math.abs(a-wanted)?b:a);
  let cols:number;
  if(R===1&&K===1)cols=autoStackAxis(units)==='x'?n:1;
  else if(R===1)cols=n;
  else if(K===1)cols=1;
  else if(R===n&&K===n){
    // A staircase: every unit alone in both directions. Follow the longer run.
    const span=(axis:'x'|'y')=>{const c=units.map(u=>autoCenter(u,axis));return Math.max(...c)-Math.min(...c);};
    cols=span('x')>=span('y')?n:1;
  }
  // Every unit alone in its row: the columns carry the structure (ties prefer the wider grid).
  else if(R===n)cols=nearest([...new Set(validRowCounts(n).map(r=>Math.ceil(n/r)))].sort((a,b)=>b-a),K);
  else {
    // Rows carry the structure. Full rows over a shorter last one keep their width, unless the
    // same number of rows makes a COMPLETE rectangle (three above one is 2 x 2; thirty-wide
    // rows with one left over stay thirty wide). Uneven rows take the smallest grid that fits.
    const width=rowBands[0].members.length,ragged=rowBands.every((band,i)=>i<R-1?band.members.length===width:band.members.length<=width);
    const exact=Math.ceil(n/R);
    cols=ragged?(R*exact===n?exact:width):Math.ceil(n/nearest(validRowCounts(n),R));
  }
  // Reading order, cut into rows of `cols`; each row then runs left to right, so a unit that
  // changes rows lands under its nearest neighbour instead of crossing the others.
  const along=(axis:'x'|'y')=>(a:LayoutUnit,b:LayoutUnit)=>autoCenter(a,axis)-autoCenter(b,axis)||a.key.localeCompare(b.key);
  const reading=cols===1?[...units].sort(along('y')):rowBands.flatMap(band=>[...band.members].sort(along('x')));
  const orderedKeys:string[]=[];
  for(let i=0;i<n;i+=cols)orderedKeys.push(...reading.slice(i,i+cols).sort(along('x')).map(u=>u.key));
  const envelopes=(bands:{members:LayoutUnit[]}[],axis:'x'|'y')=>{
    const tracks=bands.map(b=>envelope(b.members,axis));
    return tracks.slice(1).map((t,i)=>t.start-tracks[i].start-tracks[i].size);
  };
  const scale=layoutMedian(units.map(u=>Math.min(u.bounds.w,u.bounds.h))),fallback=layoutDefaultGap(units.map(u=>u.bounds));
  const tolerance=1e-6*Math.max(1,snapshot.bounds.w,snapshot.bounds.h);
  // Gaps that already agree are somebody's decision and are kept exactly (33.219 stays
  // 33.219); only a spread of hand-placed gaps is replaced by its median, on a whole number.
  const measure=(own:number[],between:number[]):number|undefined=>{
    const samples=own.length?own:between;if(!samples.length)return undefined;
    const median=layoutMedian(samples);
    return Math.max(...samples)-Math.min(...samples)<=tolerance?median:autoNiceGap(median,scale);
  };
  // What the members of a track share: the line they carry (plot axes) when every unit has
  // one, else the edge or center they are already closest to.
  const byKey=new Map(units.map(u=>[u.key,u])),ordered=orderedKeys.map(k=>byKey.get(k)!),rowCount=Math.ceil(n/cols);
  const align={x:autoAlign(columnBands,'x'),y:autoAlign(rowBands,'y')};
  const carried={x:lineOffsets(units,'x',options.lines)?options.lines!.x!:undefined,y:lineOffsets(units,'y',options.lines)?options.lines!.y!:undefined};
  const shared=(axis:'x'|'y')=>(u:LayoutUnit)=>carried[axis]?carried[axis]!.get(u.key)!:u.bounds[axis]+align[axis]*u.bounds[axis==='x'?'w':'h'];
  const tracks={x:Array.from({length:Math.min(cols,n)},():LayoutUnit[]=>[]),y:Array.from({length:rowCount},():LayoutUnit[]=>[])};
  ordered.forEach((u,i)=>{tracks.x[i%cols].push(u);tracks.y[Math.floor(i/cols)].push(u);});
  // Tracks that are ALREADY lined up and evenly spaced are finished on that axis: their gap is
  // the gap between them as they stand. (Neighbour gaps would misread a settled grid of mixed
  // sizes, where a narrow unit sits further from its neighbour than its column does.)
  const settled=(axis:'x'|'y'):number|undefined=>{
    const line=shared(axis),groups=tracks[axis];if(groups.length<2)return undefined;
    for(const group of groups){const first=line(group[0]);if(group.some(u=>Math.abs(line(u)-first)>tolerance))return undefined;}
    const spans=groups.map(group=>envelope(group,axis)),gaps=spans.slice(1).map((t,i)=>t.start-spans[i].start-spans[i].size);
    return Math.max(...gaps)-Math.min(...gaps)<=tolerance?layoutMedian(gaps):undefined;
  };
  const measuredX=settled('x')??measure(autoGaps(rowBands,'x'),envelopes(columnBands,'x')),measuredY=settled('y')??measure(autoGaps(columnBands,'y'),envelopes(rowBands,'y'));
  const gapX=measuredX??measuredY??autoNiceGap(fallback,scale),gapY=measuredY??measuredX??autoNiceGap(fallback,scale);
  const anchor=options.anchor??{x:.5,y:.5},pin=options.pin??arrangementPin(snapshot.bounds,anchor);
  const planned=planArrangement({...snapshot,orderedKeys,suggested:false},{mode:'reflow',cols,gapX,gapY,anchor,pin,align,lines:carried});
  // An axis on which nothing really moves keeps its bytes: recomputing an already-even
  // column's y positions must not rewrite them an ulp away.
  const still=(axis:'dx'|'dy')=>planned.translations.every(t=>Math.abs(t[axis])<=tolerance);
  const stillX=still('dx'),stillY=still('dy');
  let plan=planned;
  if(planned.translations.length&&(stillX||stillY)){
    const before=new Map(snapshot.memberPositions.map(p=>[p.id,p])),was=new Map(snapshot.units.map(u=>[u.key,u.bounds]));
    const positions=planned.positions.map(p=>({id:p.id,x:stillX?before.get(p.id)!.x:p.x,y:stillY?before.get(p.id)!.y:p.y}));
    const settled=planned.units.map(u=>({...u,bounds:{...u.bounds,x:stillX?was.get(u.key)!.x:u.bounds.x,y:stillY?was.get(u.key)!.y:u.bounds.y}}));
    const translations=positions.flatMap(p=>{const b=before.get(p.id)!;return p.x===b.x&&p.y===b.y?[]:[{id:p.id,dx:p.x-b.x,dy:p.y-b.y}];});
    plan={...planned,positions,translations,units:settled,identity:translations.length===0,bounds:unionRect(settled.map(u=>u.bounds))??planned.bounds};
  }
  // A line matters only where a track holds more than one unit: a row's units share their
  // horizontal line (y), a column's their vertical one (x).
  const rails:AutoArrangement['rails']=[];
  const placed=new Map(plan.units.map(u=>[u.key,u.bounds]));
  for(const axis of ['x','y'] as const){
    const lines=carried[axis];if(!lines)continue;
    for(const group of tracks[axis]){
      if(group.length<2)continue;
      // The planned line: where the first member lands plus its own offset to its line.
      const first=group[0],at=placed.get(first.key)![axis]+(lines.get(first.key)!-first.bounds[axis]);
      const span=envelope(group.map(u=>({...u,bounds:placed.get(u.key)!})),axis==='x'?'y':'x');
      rails.push(axis==='x'?{x1:at,x2:at,y1:span.start,y2:span.start+span.size}:{y1:at,y2:at,x1:span.start,x2:span.start+span.size});
    }
  }
  return {plan,topology:plan.topology,rows:plan.rowCount,cols:plan.cols,moves:plan.translations.some(t=>Math.abs(t.dx)>tolerance||Math.abs(t.dy)>tolerance),onLines:rails.length>0,rails};
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
