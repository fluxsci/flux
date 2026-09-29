import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validatedModelBytes } from '../src/lib/model3d/portableBytes';
import { boundedModelFile } from '../flux-core/model3dFile';
import { becomeTransform } from '../src/lib/slide/ops';
import { staticModelElement, staticModelContext } from '../src/lib/slide/staticModels';
import { model3dStaticSvg } from '../src/lib/model3d/static';
import { harness } from './lib/harness.mjs';
import { gatherPayload, portablePayload } from '../src/lib/slide/payload';
import { exportDeckHtml, exportSlideVideoHtml } from '../src/lib/slide/export/exportDeck';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { inspectGlb, writeGlb, GLB_LIMITS } from '../src/lib/model3d/glbCore.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Model3dAsset } from '../src/lib/model3d/types';
import type { Deck } from '../src/lib/slide/types';
import { deckPdfDocument } from '../src/lib/slide/export/deckPdf';
import { deckPptxBytes } from '../src/lib/slide/export/deckPptx';
import { renderSlidePosterSvg, compileSlideFor } from '../src/lib/slide/embedRender';
import { unzipSync, strFromU8 } from 'fflate';
import { parseHTML } from 'linkedom';
import { Resvg } from '@resvg/resvg-js';
import { payloadModelContext } from '../src/lib/slide/export/model3dPayloadHost';
const h=harness('verify-model3d-slide-export');
// Fresh checkouts have no build output: the PDF/embed paths read the build-owned
// .generated assets, so run the same generator the npm hooks use (identical bytes are not rewritten).
execFileSync(process.execPath,['scripts/gen-slide-embed-assets.mjs'],{stdio:'pipe'});
const bytes=writeGlb({parts:[{name:'mesh',positions:[0,0,0,1,0,0,0,1,1],indices:[0,1,2]}]});
const asset:Model3dAsset={id:'mesh',name:'Mesh',kind:'glb',path:'assets/mesh.glb',naturalWidth:200,naturalHeight:200,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,model:inspectGlb(bytes)};
const element=makeModel3dElement(asset,{id:'view'});
const scene={build:{provenance:{path:'/private/source.py'}},spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'secret.glb',parts:[{id:'mesh',role:'mesh',node:'mesh'},{id:'title',role:'title',text:'Model title'}]};
const deck={schemaVersion:'0.6.0',id:'deck',title:'Models',stage:{width:640,height:360},assets:[asset,{...asset,id:'target',path:'assets/target.glb'}],slides:[{id:'slide',elements:[element],beats:[{id:'base',tracks:[]},{id:'change',tracks:[{id:'content',target:'view',preset:'transform',to:{assetId:'target'}}]}]}]} as unknown as Deck;
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
let reads=0;
const io={readText:async(p:string)=>{if(p.endsWith('project.json'))return '{}';if(p.endsWith('.fluxplot.json'))return JSON.stringify(scene);throw Error('missing');},readFile:async(p:string)=>{if(!p.endsWith('.glb'))throw Error('unexpectedimage');reads++;return bytes;},modelPoster:async()=>png};
const {payload,warnings}=await gatherPayload('/scratch',deck,io);
h.eq(warnings,[],'models and design posters gather without plot warnings');
h.eq(Object.keys(payload.models??{}).sort(),['mesh','target'],'content-only model assets travel with the deck');
h.ok(!payload.assets?.mesh&&!payload.assets?.target,'GLBs never enter the image assets map');
h.eq(payload.assets?.[payload.modelPosters!.view],png,'design poster has a distinct image reference');
h.eq(reads,2,'each referenced GLB read once');
h.eq(payload.deck.assets[0].model,asset.model,'portable deck preserves model metadata');
h.eq(portablePayload(payload).modelManifests!.mesh.glb,'model.glb','portable model metadata scrubs source filename');
h.ok(!payload.modelManifests!.mesh.build && payload.modelManifests!.mesh.glb==='model.glb','public gathering itself removes private manifest build/name');
const privatePayload=structuredClone(payload);privatePayload.deck.slides[0].beats[1].tracks[0].to={assetId:'target',glbPath:'/private/source.glb',sha256:'0'.repeat(64),state:{source:{glbPath:'/private/nested.glb'}}};
const scrubbed=portablePayload(privatePayload);h.ok(!JSON.stringify(scrubbed).includes('/private/'),'portable direct and nested GLB source paths are removed');
h.eq(scrubbed.deck.assets[0].sha256,asset.sha256,'source scrub preserves the prepared asset digest');
h.eq(await validatedModelBytes(bytes,asset),bytes,'prepared byte validation preserves exact accepted bytes');
await assert.rejects(()=>validatedModelBytes(bytes,{...asset,sha256:''}),/prepared-byte/);h.ok(true,'portable bytes require a saved prepared receipt');
const changed=bytes.slice();changed[changed.length-1]^=1;
await assert.rejects(()=>gatherPayload('/scratch',deck,{...io,readFile:async()=>changed}),/prepared bytes.*SHA-256/);h.ok(true,'changed stored bytes refuse public export instead of carrying mismatched metadata');
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-portable-model-'));
try {
 const root=path.join(scratch,'project'),dir=path.join(root,'slides/deck/assets');await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'mesh.glb'),bytes);await fs.writeFile(path.join(dir,'target.glb'),bytes);
 let bounded=0;const boundedIO={...io,readFile:async()=>{throw Error('unbounded GLB read forbidden');},readModelFile:async(file:string,capturedRoot:string)=>{h.eq(capturedRoot,root,'bounded reader receives captured root');bounded++;return boundedModelFile(file,GLB_LIMITS.maxBytes,capturedRoot);}};
 await gatherPayload(root,deck,boundedIO);h.eq(bounded,2,'public portable gather uses bounded reader for every referenced model');
 const outside=path.join(scratch,'outside.glb');await fs.writeFile(outside,bytes);await fs.rm(path.join(dir,'mesh.glb'));await fs.symlink(outside,path.join(dir,'mesh.glb'));
 await assert.rejects(()=>gatherPayload(root,deck,boundedIO),/escapes|outside|symlink/i);h.ok(true,'portable read refuses a saved-path symlink outside the project');
 await fs.rm(path.join(dir,'mesh.glb'));await fs.writeFile(path.join(dir,'mesh.glb'),'');await fs.truncate(path.join(dir,'mesh.glb'),GLB_LIMITS.maxBytes+1);
 await assert.rejects(()=>gatherPayload(root,deck,boundedIO),/exceeds|limit/i);h.ok(true,'actual sparse oversized stored file refuses before allocation');
} finally {await fs.rm(scratch,{recursive:true,force:true});}
reads=0;await gatherPayload('/scratch',deck,{...io,modelData:'omit'});h.eq(reads,0,'static PDF/PPTX gathering never reads GLB bytes');
const exported=await exportDeckHtml(payload,{warnThreshold:1});
h.ok(exported.html.includes('var FluxModel3dRuntime='),'3D deck includes the conditional runtime');
h.ok(exported.warnings.some(w=>w.includes('max_faces=')),'large 3D deck gives model-specific size guidance');
const runtimeScripts=[...exported.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
for(const script of runtimeScripts)h.ok(exported.html.includes(`sha256-${createHash('sha256').update(script).digest('base64')}`),'every executable script is covered by CSP');
const plain=await exportDeckHtml({deck:{...deck,assets:[],slides:[{...deck.slides[0],elements:[],beats:[]}]}});
h.ok(!plain.html.includes('var FluxModel3dRuntime='),'2D deck does not include Three/model runtime');
const capture=await exportSlideVideoHtml(payload);
h.ok(capture.includes('var FluxModel3dRuntime='),'video capture includes the model runtime');
const dom=parseHTML('<html><body></body></html>');Object.assign(globalThis,{document:dom.document,DOMParser:dom.DOMParser,XMLSerializer:dom.XMLSerializer});
const sample=payloadModelContext(payload);
h.eq(sample.modelPoster(element),png,'matching sampled view finds its exact Design poster');
h.eq(sample.modelPoster({...element,orbitAzimuth:element.orbitAzimuth+90}),undefined,'changed orbit never reuses the Design poster as a matching current frame');
const posterSvg=renderSlidePosterSvg(payload);
h.ok(posterSvg.includes('data-model3d-poster="true"')&&!posterSvg.includes('data:model/gltf-binary'),'shared static PDF/document SVG composes the model PNG');
let composed='';
const pptx=await deckPptxBytes('Model',[{payload}],async(svg)=>{composed=svg;return new Resvg(svg).render().asPng();},undefined,'final');
const archive=unzipSync(pptx.bytes);
h.ok(Object.keys(archive).some(p=>/^ppt\/media\/.*\.png$/.test(p)),'PPTX contains an actual rasterized model image');
h.ok(pptx.warnings.some(w=>w.includes('3D animation exported as a still')),'PPTX explicitly reports its 3D still policy');
h.ok(composed.includes('data-model3d-poster="true"'),'PPTX rasterization receives the shared mesh/furniture composition');
h.ok(!Object.keys(archive).some(p=>p.endsWith('.glb')),'PPTX contains no falsely editable 3D model payload');
h.ok(Object.entries(archive).filter(([p])=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).some(([,v])=>strFromU8(v).includes('<p:pic>')),'PowerPoint slide references the model picture');
// Initially non-model identities have no Design model poster. Their first and
// later model endpoints require matching stills in every static writer.
const retyped=structuredClone(deck);retyped.slides[0].beats=[{id:'base',tracks:[]},{id:'become',tracks:[]}];
retyped.slides[0].elements=[{id:'R',type:'rect',x:10,y:20,width:200,height:160,rotation:0,fill:'#ccc',stroke:'none',strokeWidth:0,cornerRadius:0},{...element,id:'B',orbitAzimuth:117,overrides:{title:{text:'Endpoint title'}}}] as any;
becomeTransform(retyped,'slide','become','R','B',{mode:'consume',modelAsset:id=>retyped.assets.find(a=>a.id===id)});
const requests:any[]=[];
const typed=await gatherPayload('/scratch',retyped,{...io,modelData:'omit',modelPoster:async(request)=>{requests.push(request);return png;}});
h.ok(requests.some(r=>r.element.id==='R'&&r.element.orbitAzimuth===117),'rect-to-model Consume gathers its actual evaluated endpoint still');
const typedSvg=renderSlidePosterSvg(typed.payload,1);h.ok(typedSvg.includes('data-model3d-poster="true"')&&!typedSvg.includes('data-model3d-placeholder'),'rect-to-model SVG final state contains its matching mesh still');
let typedPptxSvg='';await deckPptxBytes('Retyped',[{payload:typed.payload}],async svg=>{typedPptxSvg=svg;return new Resvg(svg).render().asPng();},undefined,'final');
h.ok(typedPptxSvg.includes('data-model3d-poster="true"')&&!typedPptxSvg.includes('data-model3d-placeholder'),'rect-to-model PowerPoint uses the same coherent endpoint still');
const pdf=await deckPdfDocument('/scratch',retyped.id,{...io,readText:async p=>p.endsWith('project.json')?JSON.stringify({schemaVersion:'0.1.0',slides:[{id:retyped.id,path:'slides/deck/deck.json'}]}):p.endsWith('deck.json')?JSON.stringify(retyped):io.readText(p)},'final');
h.ok(pdf.warnings.includes('3D animation exported as a still')&&pdf.html.includes('data-model3d-poster="true"'),'future-only model PDF reports the static policy and includes its endpoint mesh');
const req=requests.find(r=>r.element.id==='R');const expected=model3dStaticSvg(req.element,id=>typed.payload.assets?.[id],staticModelContext(typed.payload));
h.ok(typedSvg.includes(expected)&&typedPptxSvg.includes(expected),'SVG/PPTX share exact endpoint mesh and furniture composition');
const partDeck=structuredClone(deck);partDeck.slides[0].beats=[{id:'base',tracks:[]},{id:'parts',tracks:[{id:'fade-meshes',target:'view',selector:{role:'mesh'},preset:'fadeOut',duration:500},{id:'fade-title',target:'view',part:'title',preset:'fadeOut',duration:500}]}];
const partPayload=(await gatherPayload('/scratch',partDeck,{...io,modelData:'omit'})).payload;
h.eq(compileSlideFor(partPayload).cues[1].tracks[0].parts,['mesh'],'static compilation resolves model role leaves through accepted metadata');
h.eq(renderSlidePosterSvg(partPayload,1),renderSlidePosterSvg(partPayload,0),'static Design still keeps mesh and furniture together despite sampled part fades');
const altered={...element,orbitAzimuth:99,fill:'#ff0000',width:240,height:180,modelStates:{inflated:1}};
const designStill=staticModelElement(altered,deck.slides[0]) as typeof element;
h.eq([designStill.orbitAzimuth,designStill.fill,designStill.modelStates,designStill.width],[element.orbitAzimuth,element.fill,element.modelStates,240],'original model keeps Design mesh/furniture appearance with sampled placement');
// A model that fades in at step 1 and moves at step 2 is pictured at each
// page's sampled visibility and placement (Design mesh) in PowerPoint, and
// agrees with the PDF pages. PowerPoint used to picture every page at step 0,
// so this model vanished from both the animated and the final package.
{
  const built=structuredClone(deck);built.assets=[asset];
  built.slides[0].elements=[{...element,id:'moving',x:40,y:30,width:200,height:150}];
  built.slides[0].beats=[{id:'base',tracks:[]},{id:'in',tracks:[{id:'enter',target:'moving',preset:'fade',duration:300}]},{id:'glide',tracks:[{id:'move',target:'moving',preset:'transform',duration:500,to:{state:{x:300}}}]}] as any;
  const builtPayload=(await gatherPayload('/scratch',built,{...io,modelData:'omit'})).payload;
  const emu=12192000/built.stage.width;
  const pages=(bytes:Uint8Array)=>{const zip=unzipSync(bytes);return Object.keys(zip).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a,b)=>Number(/(\d+)\.xml$/.exec(a)![1])-Number(/(\d+)\.xml$/.exec(b)![1]))
    .map(p=>[...strFromU8(zip[p]).matchAll(/<p:pic>.*?<a:off x="(-?\d+)" y="(-?\d+)"\/>.*?<\/p:pic>/g)].map(m=>[Number(m[1])/emu,Number(m[2])/emu]));};
  const composedSvgs:string[]=[];const raster=async(svg:string)=>{composedSvgs.push(svg);return new Resvg(svg).render().asPng();};
  const animated=await deckPptxBytes('Built',[{payload:builtPayload}],raster,undefined,'animated');
  const still='3D animation exported as a still';
  h.eq(pages(animated.bytes),[[],[[40,30]],[[300,30]]],'animated PowerPoint: absent at rest, pictured where step 1 shows it, then where step 2 moves it');
  h.ok(animated.warnings.includes(still),'animated PowerPoint reports the 3D still policy');
  h.eq(Object.keys(unzipSync(animated.bytes)).filter(p=>/^ppt\/media\/.*\.png$/.test(p)).length,1,'a model that only moves between pages shares one still image');
  const fin=await deckPptxBytes('Built',[{payload:builtPayload}],raster,undefined,'final');
  h.eq(pages(fin.bytes),[[[300,30]]],'final PowerPoint pictures the model at its last-step placement');
  h.ok(fin.warnings.includes(still),'final PowerPoint reports the 3D still policy');
  const imageBox=(svg:string)=>{const m=/<image data-model3d-poster="true" x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg);return m?m.slice(1).map(Number):null;};
  const own=imageBox(composedSvgs[0]);
  h.ok(!!own&&own[0]>=0&&own[1]>=0&&own[0]+own[2]<=200.5&&own[1]+own[3]<=150.5,`the rasterized still lies inside its own picture (${JSON.stringify(own)} in 200x150)`);
  const diskIO={...io,readText:async(p:string)=>p.endsWith('project.json')?JSON.stringify({schemaVersion:'0.1.0',slides:[{id:built.id,path:'slides/deck/deck.json'}]}):p.endsWith('deck.json')?JSON.stringify(built):io.readText(p)};
  const pdfSteps=await deckPdfDocument('/scratch',built.id,diskIO,'steps');
  const pdfBoxes=pdfSteps.html.split('<div class="page">').slice(1).map(imageBox);
  h.ok(pdfSteps.warnings.includes(still)&&pdfBoxes.length===3&&pdfBoxes[0]===null,'PDF steps: the model is absent at rest too');
  h.eq(pdfBoxes.slice(1).map(b=>b&&[b[0],b[1]]),[[40+own![0],30+own![1]],[300+own![0],30+own![1]]],'PDF and PowerPoint place the same still at every build step');
  const gone=structuredClone(built);gone.slides[0].beats=[{id:'base',tracks:[]},{id:'out',tracks:[{id:'leave',target:'moving',preset:'fadeOut',duration:300}]}] as any;
  const gonePayload=(await gatherPayload('/scratch',gone,{...io,modelData:'omit'})).payload;
  const goneFinal=await deckPptxBytes('Gone',[{payload:gonePayload}],raster,undefined,'final');
  h.ok(pages(goneFinal.bytes)[0].length===0&&goneFinal.warnings.includes(still),'a model no final page shows still reports the 3D still policy, as the PDF does');
  // A popping entrance gets an invisible half-size twin on the page before. A
  // model's still depends on its box, so the twin pictures the full-size still
  // Morph lands on (its own size has no rendered poster) instead of a placeholder.
  const pop=structuredClone(built);pop.slides[0].beats=[{id:'base',tracks:[]},{id:'pop',tracks:[{id:'pop-in',target:'moving',preset:'popIn',duration:300,params:{from:0.5}}]}] as any;
  const popPayload=(await gatherPayload('/scratch',pop,{...io,modelData:'omit'})).payload;
  const popped=await deckPptxBytes('Pop',[{payload:popPayload}],raster,undefined,'animated'),popZip=unzipSync(popped.bytes);
  const media=(n:number)=>/Target="\.\.\/media\/([^"]+)"/.exec(strFromU8(popZip[`ppt/slides/_rels/slide${n}.xml.rels`]))?.[1];
  const twinXml=strFromU8(popZip['ppt/slides/slide1.xml']);
  h.eq(pages(popped.bytes),[[[90,67.5]],[[40,30]]],'pop twin sits at half size about the model centre on the page before');
  h.ok(twinXml.includes('<a:alphaModFix amt="0"/>')&&media(1)!==undefined&&media(1)===media(2),'the invisible twin and the landed model share one still image');
  h.ok(!popped.warnings.some(w=>w.includes('placeholder')),'a pop twin never falls back to a placeholder');
}
await h.done();
