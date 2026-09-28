import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {harness} from './lib/harness.mjs';
import {parseScene3d,buildScene3dPartIndex,isScene3d,resolveScene3dPartStyle} from '../src/lib/model3d/scene3d';
import {inspectGlb,parseGlb} from '../src/lib/model3d/glbCore.mjs';
const h=harness('verify-model3d-scene3d');
execFileSync(process.execPath,['scripts/gen-model3d-validator.mjs','--check'],{stdio:'pipe'});h.ok(true,'generated validator is fresh');
// Frozen contract oracle and fixtures emitted through the public Python API are independent inputs.
for (const fixtureSet of ['fluxplot', 'fluxplot-library']) {
const dir=new URL(`./fixtures/model3d/${fixtureSet}/`,import.meta.url);
const checksums=JSON.parse(await readFile(new URL('SHA256SUMS.json',dir),'utf8'));
for(const name of (await readdir(dir)).filter(n=>n.endsWith('.fluxplot.json'))){const raw=await readFile(new URL(name,dir),'utf8'),m=parseScene3d(raw);h.ok(!('issue'in m),`${name} schema and semantic validation`);if('issue'in m)continue;const bytes=await readFile(new URL(m.glb,dir));h.eq(createHash('sha256').update(bytes).digest('hex'),m.glbSha256,`${name} original source SHA`);const info=inspectGlb(bytes),index=buildScene3dPartIndex(m);h.ok(info.partNames.every(n=>Object.values(index).some(p=>p.node===n)),`${name} semantic node binding`);h.eq(info.states,m.states?.map(s=>s.name)??[],`${name} GLB state names`);const p=parseGlb(bytes);for(const a of p.json.accessors)if(a.componentType===5126){const v=p.json.bufferViews[a.bufferView],d=new DataView(p.bin.buffer,p.bin.byteOffset+(v.byteOffset??0),v.byteLength);for(let i=0;i<v.byteLength;i+=4)if(!Number.isFinite(d.getFloat32(i,true)))h.fail(`${name} non-finite float`);}}
for(const [name,sha]of Object.entries(checksums))h.eq(createHash('sha256').update(await readFile(new URL(name,dir))).digest('hex'),sha,`receipt ${name}`);
}
const base={spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'test.glb'};
const styled={...base,parts:[{id:'parent',role:'mesh',color:'#FF0000',opacity:.5},{id:'child',role:'mesh',parent:'parent',color:'#0000FF',hidden:true}]};
const parsedStyled=parseScene3d(styled);if('issue' in parsedStyled)throw Error(parsedStyled.issue);
h.eq(resolveScene3dPartStyle(parsedStyled,{'parent':{fill:'#00FF00'},child:{hidden:false}},'child'),{fill:'#00FF00',hidden:false,opacity:.5},'ancestor user fill beats child source color and explicit show survives');
h.eq(resolveScene3dPartStyle(parsedStyled,undefined,'child',{sourceColors:false}),{opacity:.5,hidden:true},'mesh caller can omit source color while retaining visibility and opacity');
const constant={...base,parts:[{id:'field',role:'surface-field',node:'field',field:{cmap:{name:'constant',stops:[[0,'#000000'],[1,'#FFFFFF']]},range:[2,2]}}]};h.ok(!('issue' in parseScene3d(constant)),'constant source field range is valid');
for(const bad of [{...base,schemaVersion:'0.2.0'},{...base,glb:'../bad.glb'},{...base,view:{zoom:0}},{...base,view:{azimuth:NaN}},{...base,parts:[{id:'a',role:'mesh'},{id:'a',role:'mesh'}]},{...base,parts:[{id:'a',role:'mesh',parent:'b'},{id:'b',role:'mesh',parent:'a'}]}])h.ok('issue'in parseScene3d(bad),'invalid/newer manifest degrades with issue');
h.ok(!isScene3d({spec:'fluxplot',schemaVersion:'0.3.0'}),'2D manifest dispatch stays separate');h.ok(isScene3d(base),'scene3d discriminator selects3D before2D contract');h.ok(!('issue'in parseScene3d({...base,parts:[{id:'custom',role:'x-custom'}]})),'unknown role remains addressable');h.ok('issue'in parseScene3d({...base,toWorld:[2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}),'non-orthonormal toWorld refused');h.ok('issue'in parseScene3d({...base,toWorld:[-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}),'reflected toWorld refused');await h.done();
