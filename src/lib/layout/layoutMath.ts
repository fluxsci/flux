/** Shared, DOM-free track arithmetic. Legacy arrange and the interactive planner
 * use these same equations; signed gaps overlap tracks without changing their
 * logical membership or order. */
export interface LayoutBox { x: number; y: number; w: number; h: number }
export interface LayoutTrack { start: number; size: number }
export function layoutMedian(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b) => a-b), m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m-1] + sorted[m])/2;
}
export function layoutDefaultGap(boxes: readonly LayoutBox[]): number {
  const median = layoutMedian(boxes.flatMap(b => [b.w,b.h]));
  return median > 0 ? Math.round(Math.min(48,Math.max(8,median*.06))) : 16;
}
export function layoutReadingOrder<T>(items: readonly T[], bounds: (item:T)=>LayoutBox): T[] {
  const tolerance = layoutMedian(items.map(item => bounds(item).h)) * .5;
  const bands: T[][] = [];
  for (const item of [...items].sort((a,b) => bounds(a).y-bounds(b).y)) {
    const band = bands[bands.length-1];
    if (band && bounds(item).y-bounds(band[0]).y <= tolerance) band.push(item);
    else bands.push([item]);
  }
  for (const band of bands) band.sort((a,b) => bounds(a).x-bounds(b).x);
  return bands.flat();
}
/** alignX/alignY place each box inside its cell: 0 start, .5 center (the default every
 * existing caller relies on), 1 end. `lines` replaces that on an axis with one offset per box
 * (from the box's start to a line it carries, e.g. a plot's spine): the boxes of a track then
 * share that LINE, and the track is as large as they need on either side of it. */
export function gridTracks(boxes: readonly LayoutBox[], cols: number, gapX:number,gapY:number, x=0,y=0, alignX=.5,alignY=.5, lines:{x?:readonly number[];y?:readonly number[]}={}) {
  const C=Math.min(cols,boxes.length),R=Math.ceil(boxes.length/C);
  const column=(i:number)=>i%C,row=(i:number)=>Math.floor(i/C);
  // Per track: the room its boxes need before their line and after it. Without lines a box's
  // "line" is its aligned fraction, which is the plain largest-box track.
  const measure=(count:number,track:(i:number)=>number,size:(b:LayoutBox)=>number,offsets:readonly number[]|undefined)=>{
    const before=new Array<number>(count).fill(offsets?-Infinity:0),after=new Array<number>(count).fill(offsets?-Infinity:0);
    boxes.forEach((b,i)=>{const t=track(i);if(offsets){before[t]=Math.max(before[t],offsets[i]);after[t]=Math.max(after[t],size(b)-offsets[i]);}else after[t]=Math.max(after[t],size(b));});
    return {before,sizes:after.map((a,t)=>before[t]+a)};
  };
  const mx=measure(C,column,b=>b.w,lines.x),my=measure(R,row,b=>b.h,lines.y);
  const tracks=(sizes:number[],origin:number,gap:number):LayoutTrack[]=>sizes.map(size=>{const t={start:origin,size};origin+=size+gap;return t;});
  const columns=tracks(mx.sizes,x,gapX),rows=tracks(my.sizes,y,gapY);
  // A box that fills its track (to within the rounding of a measured bounding box) sits ON the
  // track's start, so equal-sized boxes in one track share one coordinate exactly.
  const slack=(track:number,own:number)=>Math.abs(track-own)<=1e-9*Math.max(1,track)?0:track-own;
  return {columns,rows,boxes:boxes.map((b,i)=>{const col=columns[column(i)],r=rows[row(i)];return {
    x:col.start+(lines.x?slack(mx.before[column(i)],lines.x[i]):slack(col.size,b.w)*alignX),
    y:r.start+(lines.y?slack(my.before[row(i)],lines.y[i]):slack(r.size,b.h)*alignY),w:b.w,h:b.h};})};
}
