import type { Model3dAsset, Model3dInfo, ModelTopologyPart } from './types';
export interface MorphCompatibility {ok:boolean;pairs:Array<{nodeA:string;nodeB:string;primitiveA?:number;primitiveB?:number}>;reason?:string}
const topology=(asset:Model3dAsset|Model3dInfo)=>'model' in asset?asset.model.topology:asset.topology;
export function morphCompatible(a:Model3dAsset|Model3dInfo,b:Model3dAsset|Model3dInfo):MorphCompatibility {
 const A=topology(a)?.parts,B=topology(b)?.parts,pairs:MorphCompatibility['pairs']=[],no=(reason:string):MorphCompatibility=>({ok:false,pairs:[],reason});
 // Reasons are read by people (pick bar, Inspector, animation issues): plain
 // words — "mesh piece" for a GLB primitive, "mesh structure" for topology.
 if(!A?.length||!B?.length)return no('The mesh structure of one model is unknown');
 if(A.length!==B.length)return no(`The models have different mesh pieces (${A.length} vs ${B.length})`);
 const named=A.every(p=>p.node)&&B.every(p=>p.node);
 // Several primitives may share one GLB node. Pair equal-name occurrences in order.
 const groups=new Map<string,ModelTopologyPart[]>();for(const p of B){const g=groups.get(p.node)??[];g.push(p);groups.set(p.node,g);}
 for(let i=0;i<A.length;i++){
  const left=A[i],right=named?groups.get(left.node)?.shift():B[i],label=left.node?`Mesh piece "${left.node}"`:`Mesh piece ${i+1}`;
  if(!right)return no(`The other model has no mesh piece named "${left.node}"`);
  if(left.mode!==right.mode)return no(`${label} is built from triangles differently in each model`);
  if(left.vertices!==right.vertices)return no(`${label} has a different number of vertices (${left.vertices.toLocaleString('en-US')} vs ${right.vertices.toLocaleString('en-US')})`);
  if(left.indicesHash!==right.indicesHash)return no(`${label} connects its vertices differently`);
  if(!named||!pairs.some(p=>p.nodeA===left.node&&p.nodeB===right.node))pairs.push({nodeA:left.node,nodeB:right.node,...(!named?{primitiveA:i,primitiveB:i}:{})});
 }
 return {ok:true,pairs};
}
export const morphFixHint='Shapes morph only when both were exported with the same mesh structure (fluxplot share_topology_with).';
