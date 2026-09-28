import type { Model3dInfo, Vec3 } from './types';
export const GLB_LIMITS: Readonly<{maxBytes:number;warnBytes:number;maxTriangles:number;warnTriangles:number;maxItems:number;maxAccessorValues:number;maxInspectedValues:number}>;
export class GlbError extends Error { code:string; constructor(code:string,message:string); }
export function cyrb53(value:string|Uint8Array, seed?:number):number;
export function hex14(hash:number):string;
export function canonical(value:unknown):string;
export function parseGlb(bytes:Uint8Array|ArrayBuffer):{json:any;bin:Uint8Array};
export function inspectGlb(bytes:Uint8Array|ArrayBuffer):Model3dInfo;
export function prepareGlb(bytes:Uint8Array|ArrayBuffer,opts?:Record<string,unknown>):{bytes:Uint8Array;info:Model3dInfo};
export function transformPoint(matrix:readonly number[],point:readonly number[]):Vec3;
export interface GlbFixturePart { name?:string; positions:ArrayLike<number>|number[][]; indices?:ArrayLike<number>|number[][];
 normals?:ArrayLike<number>|number[][]; colors?:ArrayLike<number>|number[][]; values?:ArrayLike<number>; valid?:ArrayLike<number>;
 color?:number[]; mode?:number; indexType?:5123|5125; matrix?:number[];
 states?:Record<string, ArrayLike<number>|{positions:ArrayLike<number>;normals?:ArrayLike<number>}>; weights?:Record<string,number>; }
export function writeGlb(spec:{parts:GlbFixturePart[];modify?:(json:any,bin:Uint8Array)=>void}):Uint8Array;
