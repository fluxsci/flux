import type { Model3dAsset, Model3dInfo, ModelTopologyPart } from './types';
export interface MorphCompatibility {ok:boolean;pairs:Array<{nodeA:string;nodeB:string;primitiveA?:number;primitiveB?:number}>;reason?:string}
const topology=(asset:Model3dAsset|Model3dInfo)=>'model' in asset?asset.model.topology:asset.topology;
export function morphCompatible(a:Model3dAsset|Model3dInfo,b:Model3dAsset|Model3dInfo):MorphCompatibility {
 const A=topology(a)?.parts,B=topology(b)?.parts,pairs:MorphCompatibility['pairs']=[],no=(reason:string):MorphCompatibility=>({ok:false,pairs:[],reason});
 if(!A?.length||!B?.length)return no('Topology metadata is unavailable');
 if(A.length!==B.length)return no(`${A.length} vs ${B.length} primitives`);
 const named=A.every(p=>p.node)&&B.every(p=>p.node);
 // Several primitives may share one GLB node. Pair equal-name occurrences in order.
 const groups=new Map<string,ModelTopologyPart[]>();for(const p of B){const g=groups.get(p.node)??[];g.push(p);groups.set(p.node,g);}
 for(let i=0;i<A.length;i++){
  const left=A[i],right=named?groups.get(left.node)?.shift():B[i],label=left.node||`primitive ${i+1}`;
  if(!right)return no(`${label}: no matching node`);
  if(left.mode!==right.mode)return no(`${label}: primitive modes ${left.mode} vs ${right.mode}`);
  if(left.vertices!==right.vertices)return no(`${label}: ${left.vertices.toLocaleString('en-US')} vs ${right.vertices.toLocaleString('en-US')} vertices`);
  if(left.indicesHash!==right.indicesHash)return no(`${label}: face indices or their order differ`);
  if(!named||!pairs.some(p=>p.nodeA===left.node&&p.nodeB===right.node))pairs.push({nodeA:left.node,nodeB:right.node,...(!named?{primitiveA:i,primitiveB:i}:{})});
 }
 return {ok:true,pairs};
}
export const morphFixHint='Save both meshes with shared topology — fp.mesh3d(..., share_topology_with=…) — to morph.';
