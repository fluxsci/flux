/** Matplotlib's absolute SVG path dialect. No DOM and no font measurement. */
import type { SvgMatrix } from '../svgMatrix';
export interface MplPath { commands: string[]; vertices: Float64Array }
const arity: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
export function parseMplPath(source: string): MplPath | null {
  const tokens = source.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  const commands: string[] = [], vertices: number[] = [];
  let i = 0, cmd = "";
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === "z") cmd = "Z";
    }
    if (!(cmd in arity)) return null;
    const n = arity[cmd];
    commands.push(cmd);
    if (!n) { cmd = ""; continue; }
    if (i + n > tokens.length) return null;
    for (let j = 0; j < n; j++) {
      const v = Number(tokens[i++]);
      if (!Number.isFinite(v)) return null;
      vertices.push(v);
    }
    if (cmd === "M") cmd = "L";
  }
  return { commands, vertices: new Float64Array(vertices) };
}
export const mplNumber = (v: number): string => {
  if (!Number.isFinite(v)) throw new Error("Non-finite relayout coordinate");
  return String(Math.round(v*1e6)/1e6);
};
export function writeMplPath(path: MplPath, affine: {sx:number;sy:number;tx:number;ty:number} | SvgMatrix = { sx: 1, sy: 1, tx: 0, ty: 0 }): string {
  const m: SvgMatrix = 'sx' in affine ? [affine.sx, 0, 0, affine.sy, affine.tx, affine.ty] : affine;
  let i=0,out='',separator='';
  for(const cmd of path.commands){
    out+=separator+cmd;separator=' ';
    for(let j=0;j<arity[cmd];j+=2){const x=path.vertices[i++],y=path.vertices[i++];out+=' '+mplNumber(x*m[0]+y*m[2]+m[4])+' '+mplNumber(x*m[1]+y*m[3]+m[5]);}
  }
  return out;
}
