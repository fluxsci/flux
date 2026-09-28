import { findColormap, colormapStops } from '../color/collections';
import type { Scene3dField, ModelFieldOverride } from './types';
export const srgbToLinear=(x:number)=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4);
export function rgba(color:string):[number,number,number,number]{
 if(!/^#[\da-f]{6}([\da-f]{2})?$/i.test(color))throw new Error(`Invalid scene3d colour ${color}`);
 return [parseInt(color.slice(1,3),16)/255,parseInt(color.slice(3,5),16)/255,parseInt(color.slice(5,7),16)/255,color.length===9?parseInt(color.slice(7,9),16)/255:1];
}
export function resolvedColormap(field:Scene3dField,override?:ModelFieldOverride):Array<[number,string]>{
 if(!override?.cmap||override.cmap===field.cmap.name)return field.cmap.stops;
 const found=findColormap(override.cmap);if(!found)throw new Error(`Unknown colormap ${override.cmap}`);
 const stops=colormapStops(found.map,found.reversed);return stops.map((c,i)=>[stops.length===1?0:i/(stops.length-1),c]);
}
export function buildLut(stops:Array<[number,string]>,size=256,linear=true):Float32Array{
 if(!Number.isInteger(size)||size<2||size>65536||stops.length<1)throw new Error('Invalid colormap LUT size/stops');
 const colors=stops.map(s=>rgba(s[1])),out=new Float32Array(size*4);let k=0;
 for(let i=0;i<size;i++){const t=i/(size-1);while(k<stops.length-2&&t>stops[k+1][0])k++;const b=Math.min(k+1,stops.length-1),span=stops[b][0]-stops[k][0],f=span>0?Math.max(0,Math.min(1,(t-stops[k][0])/span)):0;
  for(let c=0;c<4;c++){const v=colors[k][c]+(colors[b][c]-colors[k][c])*f;out[i*4+c]=linear&&c<3?srgbToLinear(v):v;}}
 return out;
}
/** COLOR_0 values supplied to three are linear RGB. _VALID keeps real zero valid. */
export function mapValues(values:ArrayLike<number>,field:Scene3dField,override?:ModelFieldOverride,valid?:ArrayLike<number>):Float32Array{
 const range=override?.range??field.range;if(!range.every(Number.isFinite)||range[1]<=range[0])throw new Error('Field range must be finite and increasing');
 if(valid&&valid.length!==values.length)throw new Error('_VALID length differs from _VALUE');
 const lut=buildLut(resolvedColormap(field,override)),out=new Float32Array(values.length*3),missing=rgba(field.missingColor??'#D8D8D8').slice(0,3).map(srgbToLinear),scale=255/(range[1]-range[0]);
 for(let i=0;i<values.length;i++){if(!Number.isFinite(values[i])||(valid&&valid[i]===0)){out[i*3]=missing[0];out[i*3+1]=missing[1];out[i*3+2]=missing[2];}else{const at=Math.max(0,Math.min(255,Math.round((values[i]-range[0])*scale)))*4;out[i*3]=lut[at];out[i*3+1]=lut[at+1];out[i*3+2]=lut[at+2];}}
 return out;
}
