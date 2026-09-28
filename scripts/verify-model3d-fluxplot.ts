/** Cross-repo import-to-composition acceptance uses checked-in public Python outputs. */
import { readFile, readdir } from 'node:fs/promises';
import { harness } from './lib/harness.mjs';
import { prepareModel3dImport, makeImportedModel3dElement } from '../src/lib/model3d/importData';
import { furnitureLayout } from '../src/lib/model3d/furnitureLayout';
import { furnitureSvg } from '../src/lib/model3d/furniture';
import { orbitPose } from '../src/lib/model3d/orbit';
import { framingBounds } from '../src/lib/model3d/framing';
import { resolveScene3dPartStyle } from '../src/lib/model3d/scene3d';
import { buildScene3dPartIndex } from '../src/lib/model3d/parts';
const h=harness('verify-model3d-fluxplot');
const directory=new URL('./fixtures/model3d/fluxplot-library/',import.meta.url);
let fields=0,furniture=0,states=0,multipart=0;
for(const file of (await readdir(directory)).filter(name=>name.endsWith('.fluxplot.json'))){
 const text=await readFile(new URL(file,directory),'utf8'),raw=JSON.parse(text);
 const imported=await prepareModel3dImport({bytes:await readFile(new URL(raw.glb,directory)),name:raw.glb,assetId:file.replace(/\..*$/,''),manifestText:text});
 const manifest=imported.data.manifest!;
 h.ok(!!manifest,`${file}: actual production import accepts source-bound Python metadata`);
 const element=makeImportedModel3dElement(imported.data),info=imported.data.asset.model;
 h.eq([element.orbitAzimuth,element.orbitElevation,element.orbitZoom],[manifest.view?.azimuth??30,manifest.view?.elevation??20,manifest.view?.zoom??.9],`${file}: Python camera defaults become editor properties`);
 const index=buildScene3dPartIndex(manifest),meshes=Object.values(index).filter(p=>p.node);
 if(meshes.length>1)multipart++;
 for(const part of meshes){ h.ok(info.partNames.includes(part.node!),`${file}: stable semantic ID binds a stored mesh`);if(part.color)h.eq(resolveScene3dPartStyle(manifest,undefined,part.id).fill,part.color,`${file}: source part color survives import`);if(typeof part.field==='object'){fields++;h.ok(info.hasValues,`${file}: continuous metadata maps stored raw values`);} }
 const layout=furnitureLayout(manifest,element),svg=furnitureSvg(manifest,element,orbitPose(element,framingBounds(info.bounds,manifest),layout.viewport),layout);
 h.ok(!/(?:NaN|Infinity)/.test(svg.under+svg.over),`${file}: composed vector furniture is finite`);
 if(svg.under||svg.over)furniture++;
 if(info.states.length){states++;h.eq(info.states,manifest.states?.map(state=>state.name),`${file}: shape/sequence order comes from saved GLB`);}
 h.eq(manifest.toWorld,raw.toWorld,`${file}: canonical up-axis transform is preserved without repeat conversion`);
}
h.ok(fields>0&&furniture>0&&states>0&&multipart>0,'public fixtures exercise fields, furniture, shapes and multiple semantic parts');
await h.done();
