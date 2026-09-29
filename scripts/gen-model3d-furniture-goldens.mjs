import {readFile,readdir,writeFile}from'node:fs/promises';
import {createHash}from'node:crypto';
import {fileURLToPath}from'node:url';
import{resolve}from'node:path';
import{parseScene3d}from'../src/lib/model3d/scene3d.ts';
import{inspectGlb}from'../src/lib/model3d/glbCore.mjs';
import{makeModel3dElement}from'../src/lib/model3d/make.ts';
import{orbitPose,axisView}from'../src/lib/model3d/orbit.ts';
import{framingBounds}from'../src/lib/model3d/framing.ts';
import{furnitureLayout}from'../src/lib/model3d/furnitureLayout.ts';
import{furnitureSvg}from'../src/lib/model3d/furniture.ts';
export async function furnitureGoldens(){const dir=new URL('./fixtures/model3d/fluxplot/',import.meta.url),out={};for(const file of(await readdir(dir)).filter(n=>n.endsWith('.fluxplot.json')).sort()){const m=parseScene3d(await readFile(new URL(file,dir),'utf8'));if('issue'in m)throw new Error(m.issue);const bytes=await readFile(new URL(m.glb,dir)),info=inspectGlb(bytes),asset={id:'asset',name:m.glb,kind:'glb',path:'assets/fixture.glb',naturalWidth:336,naturalHeight:288,sha256:'a'.repeat(64),bytes:bytes.length,model:info};const base=makeModel3dElement(asset,{manifest:m,id:'fixture'});for(const view of['front','right','top']){const el={...base,...axisView(view)},layout=furnitureLayout(m,el,el.overrides),pose=orbitPose(el,framingBounds(info.bounds,m),layout.viewport),svg=furnitureSvg(m,el,pose,layout);out[`${file}:${view}`]={viewport:layout.viewport,sha256:createHash('sha256').update(svg.under+'\n'+svg.over).digest('hex'),underNodes:svg.underNodes.length,overNodes:svg.overNodes.length};}}return out;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const out=new URL('./fixtures/model3d/furniture-golden.json',import.meta.url),text=JSON.stringify(await furnitureGoldens(),null,2)+'\n';if(process.argv.includes('--check')){if(await readFile(out,'utf8')!==text)throw new Error('Furniture goldens differ');}else await writeFile(out,text);console.log('furniture goldens '+(process.argv.includes('--check')?'fresh':'generated'));}
