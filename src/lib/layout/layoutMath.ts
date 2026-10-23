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
export function gridTracks(boxes: readonly LayoutBox[], cols: number, gapX:number,gapY:number, x=0,y=0) {
  const C=Math.min(cols,boxes.length),R=Math.ceil(boxes.length/C);
  const widths = new Array<number>(C).fill(0), heights = new Array<number>(R).fill(0);
  boxes.forEach((b,i)=>{widths[i%C]=Math.max(widths[i%C],b.w);heights[Math.floor(i/C)]=Math.max(heights[Math.floor(i/C)],b.h);});
  const tracks=(sizes:number[],origin:number,gap:number):LayoutTrack[]=>sizes.map(size=>{const t={start:origin,size};origin+=size+gap;return t;});
  const columns=tracks(widths,x,gapX),rows=tracks(heights,y,gapY);
  return {columns,rows,boxes:boxes.map((b,i)=>{const col=columns[i%C],row=rows[Math.floor(i/C)];return {x:col.start+(col.size-b.w)/2,y:row.start+(row.size-b.h)/2,w:b.w,h:b.h};})};
}
