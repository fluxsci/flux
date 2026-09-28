import { writeGlb } from '../src/lib/model3d/glbCore.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
export const cubePositions=[-1,-1,-1,1,-1,-1,1,1,-1,-1,1,-1,-1,-1,1,1,-1,1,1,1,1,-1,1,1];
export const cubeIndices=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5];
export function blobMesh(rows=50,cols=50){const positions=[],indices=[],colors=[];for(let r=0;r<=rows;r++)for(let c=0;c<=cols;c++){const phi=Math.PI*r/rows,theta=2*Math.PI*c/cols,k=1+.14*Math.cos(theta*3)*Math.sin(phi)**2;positions.push(k*Math.sin(phi)*Math.cos(theta),Math.cos(phi)*1.2,k*Math.sin(phi)*Math.sin(theta));colors.push(c/cols,r/rows,.25);}for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const a=r*(cols+1)+c,b=a+cols+1;indices.push(a,b,a+1,a+1,b,b+1);}return {positions,indices,colors};}
export function model3dFixtures(){const cube={name:'cube.mesh',positions:cubePositions,indices:cubeIndices};return {
 'cube.glb':writeGlb({parts:[cube]}),
 'blob5k-colors.glb':writeGlb({parts:[{name:'blob.mesh',...blobMesh()}]}),
 'two-part.glb':writeGlb({parts:[{...cube,name:'sample.left',positions:cubePositions.map((v,i)=>i%3===0?v-1.5:v),color:[1,0,0,1]},{...cube,name:'sample.right',positions:cubePositions.map((v,i)=>i%3===0?v+1.5:v),color:[0,0,1,1]}]}),
 'quantized.glb':writeGlb({parts:[cube],modify(json,bin){json.extensionsUsed=['KHR_mesh_quantization'];json.extensionsRequired=['KHR_mesh_quantization'];const a=json.accessors[0],v=json.bufferViews[a.bufferView],d=new DataView(bin.buffer,bin.byteOffset);a.componentType=5122;a.normalized=true;a.min=[-32767,-32767,-32767];a.max=[32767,32767,32767];v.byteStride=12;for(let i=0;i<8;i++)for(let c=0;c<3;c++)d.setInt16(v.byteOffset+i*12+c*2,cubePositions[i*3+c]*32767,true);}}),
 'textured.glb':writeGlb({parts:[cube],modify(json){json.images=[{uri:'https://invalid.example/texture.png'}];json.textures=[{source:0}];json.samplers=[{}];json.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};json.animations=[{channels:[],samplers:[]}];}}),
 'draco-flag.glb':writeGlb({parts:[cube],modify(json){json.extensionsRequired=['KHR_draco_mesh_compression'];}}),
 'gltf-json.gltf':new TextEncoder().encode(JSON.stringify({asset:{version:'2.0'},buffers:[{uri:'external.bin',byteLength:4}]})),
 'field-valid.glb':writeGlb({parts:[{...cube,name:'value.field',values:[0,1,2,3,4,5,6,0],valid:[1,1,1,1,1,1,1,0]}]}),
 'states.glb':writeGlb({parts:[{...cube,states:{inflated:cubePositions.map(x=>x*.5),offset:cubePositions.map((_,i)=>i%3===0?2:0)}}]})
};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=new URL('./fixtures/model3d/',import.meta.url);await mkdir(root,{recursive:true});for(const [name,bytes]of Object.entries(model3dFixtures())){const path=new URL(name,root);if(process.argv.includes('--check')){if(!Buffer.from(await readFile(path)).equals(bytes))throw new Error(`Stale model3d fixture ${name}`);}else await writeFile(path,bytes);}console.log('model3d fixtures '+(process.argv.includes('--check')?'fresh':'generated'));}
