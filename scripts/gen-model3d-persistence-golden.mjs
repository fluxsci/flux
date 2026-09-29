// Deterministic no-3D save bytes, initially generated against pre-P1 8ff8742.
// --reference-root permits an independent baseline checkout; never edits it.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ref=process.argv.indexOf('--reference-root');
const root=ref<0?process.cwd():process.argv[ref+1];
const {planFigSave}=await import(pathToFileURL(path.join(root,'src/lib/project/figfiles.ts')).href);
const input={version:2,name:'2D remains unchanged',canvases:[{id:'canvas',name:'Canvas'}],figures:[{id:'figure',name:'Alpha',canvasId:'canvas',x:10,y:20,width:320,height:240,elements:[{type:'image',id:'image',assetId:'png',x:0,y:0,width:100,height:80,rotation:30},{type:'plot',id:'plot',assetId:'svg',x:120,y:0,width:100,height:80,rotation:0,overrides:{label:{fill:'#abc',hidden:false}}}],captions:{__figure__:'Caption.'}}],assets:[{id:'png',name:'Raster',kind:'png',path:'assets/png.png',naturalWidth:100,naturalHeight:80,dpi:144},{id:'svg',name:'Plot',kind:'svg',path:'assets/svg.svg',naturalWidth:100,naturalHeight:80}],palette:['#abcdef']};
const output={referenceCommit:'8ff8742',input,plan:planFigSave(input,null)};
await writeFile(new URL('./fixtures/model3d/persistence-no3d.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
