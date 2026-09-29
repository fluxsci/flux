'use strict';
// Real production controls and persisted bytes; no store/test handles or fake IPC.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
module.exports=async function nativeSmoke(c){
 const {scenario,root,artifacts,js,check,wait,click,clickText,key,screenshot,modelState,rendered,modelSelector,captureMesh,pixelDifference,metrics,inputText}=c;
 const modifier=process.platform==='darwin'?'meta':'control';
 const poster=()=>js("document.querySelector('.figure-mode [data-model3d-poster]')?.href.baseVal");
 const changePoster=async old=>{await wait(async()=>await poster()!==old,'changed native semantic poster');await rendered();};
 const edit=async(selector,value)=>{await click(selector);await key('A',[modifier]);await inputText(String(value));await key('Enter');};
 const open=async()=>{await click(modelSelector);await key('R',['alt']);await wait(()=>js("!!document.querySelector('.xray .row')"),'native X-ray rows');};
 const row=part=>`.xray [data-rid="part:${metrics.imported.id}__${part}"]`;
 const reveal=async part=>{await edit('.xray .search-in',part==='scalebar'?'1 µm':part.split('.').at(-1));await wait(()=>js(`!!document.querySelector(${JSON.stringify(row(part))})`),'filtered native semantic row');await click(row(part)+' .rlabel');};
 const properties=async part=>{await reveal(part);await click('.xray .showprops');await wait(()=>js("!!document.querySelector('.fluxFigMenu')"),'native part properties');};
 const closeProperties=()=>click('[aria-label="Close properties"]');
 if(scenario==='semantics'||scenario==='source'){
  const before=await captureMesh('semantics-before'),old=await poster();await open();
  await properties('neuron.axon');await click('.fluxFigMenu .field[data-key="c"] .colorbtn');await edit('.fluxFigMenu .hex','#9933ff');await closeProperties();
  await wait(async()=>((await modelState()).overrides?.['neuron.axon']?.fill??'').toLowerCase()==='#9933ff','saved native axon fill');
  await reveal('neuron.dendrites');await click(row('neuron.dendrites')+' .eye');await wait(async()=>(await modelState()).overrides?.['neuron.dendrites']?.hidden===true,'saved native dendrite visibility');
  await properties('scalebar');await edit('.fluxFigMenu .field[data-key="e"] input',16);await closeProperties();await wait(async()=>(await modelState()).overrides?.scalebar?.fontSize===16,'saved native scale-bar text style');
  check(await js("[...document.querySelectorAll('[data-part-id=\"scalebar\"] text')].some(n=>n.getAttribute('font-size')==='16')"),'native scale-bar vector label uses the authored physical font size');
  await screenshot('xray-neuron');await click('[aria-label="Close X-ray"]');await changePoster(old);
  const after=await captureMesh('semantics-after');check(pixelDifference(before,after)>.005,'native recolor/hide visibly changes the neuron mesh');
  metrics.semantics={saved:await modelState(),changedPixelRatio:pixelDifference(before,after)};
  if(scenario==='source'){
   const previousPoster=await poster();await click(modelSelector);await click('.model3d-properties button[data-axis="top"]');await wait(async()=>(await modelState()).orbitElevation===90,'source-loop saved native top view');await changePoster(previousPoster);
   const sourceViewPoster=await poster(),sourceBeforePixels=await captureMesh('source-before');
   const previous=await modelState(),retain=e=>Object.fromEntries(['x','y','width','height','rotation','orbitAzimuth','orbitElevation','orbitRoll','orbitZoom','orbitPanX','orbitPanY','orbitProjection','orbitFov','modelColors','modelLighting','fill','overrides','fields','modelStates'].map(k=>[k,e[k]]));
   const python=await require('./model3dNativePythonLoop.cjs')(root,artifacts);
   await wait(()=>js("document.querySelector('[data-model3d-source-status=\"changed\"]')?.textContent.includes('Source changed')"),'native watcher observes Python source change');
   check((await modelState()).assetId===previous.assetId,'Python rerun alone never replaces placed geometry');await screenshot('source-changed');
   await click('[data-model3d-source-status] button');await wait(async()=>(await modelState()).assetId!==previous.assetId,'native explicit Update installs a fresh immutable asset');const updated=await modelState();
   check(JSON.stringify(retain(updated))===JSON.stringify(retain(previous)),'native Update preserves view, placement and Flux-side semantic restyles');
   const assetBytes=await Promise.all([previous.assetId,updated.assetId].map(id=>fs.readFile(path.join(root,'fig/assets',id+'.glb'))));
   check(assetBytes.every(b=>b.length>0)&&createHash('sha256').update(assetBytes[0]).digest('hex')!==createHash('sha256').update(assetBytes[1]).digest('hex'),'old and new immutable GLBs exist and their prepared bytes differ');
   const accepted=JSON.parse(await fs.readFile(path.join(root,'fig/assets',updated.assetId+'.fluxplot.json'),'utf8'));
   check(updated.source.sha256===python.sourceSha256&&python.beforeSha256!==python.sourceSha256&&accepted.glbSha256===python.sourceSha256&&accepted.parts.find(p=>p.id==='neuron.soma')?.color.toLowerCase()==='#e8a240','native Update accepts the actual rerun GLB receipt and changed soma colour');
   await changePoster(sourceViewPoster);const sourceAfterPixels=await captureMesh('source-after');check(pixelDifference(sourceBeforePixels,sourceAfterPixels)>.005,'native source Update visibly changes soma pixels while retaining view and restyles');
   await key('Z',[modifier]);await wait(async()=>(await modelState()).assetId===previous.assetId,'one native Undo restores the prior source asset');
   await key('Z',[modifier,'shift']);await wait(async()=>(await modelState()).assetId===updated.assetId,'one native Redo restores the accepted source asset');await rendered();
   await wait(()=>js("!!document.querySelector('[data-model3d-source-status=\"current\"]')"),'native source status current after accepted update');
   metrics.source={python,previous,updated,changedPixelRatio:pixelDifference(sourceBeforePixels,sourceAfterPixels)};await screenshot('source-updated');
  }

 }else if(scenario==='field'){
  const before=await captureMesh('field-before'),old=await poster();await open();const field='.xray [data-model-field="height.field"]';
  await wait(()=>js(`!!document.querySelector(${JSON.stringify(field)})`),'native value field controls');
  await edit(field+' .range .nf:first-child input',-.5);await wait(async()=>(await modelState()).fields?.['height.field']?.range?.[0]===-.5,'saved native field range');
  await click(field+' .map-choice');await wait(()=>js("!!document.querySelector('.xray .picker .cm')"),'native colormap picker');await click('.xray .picker .cm');
  await wait(async()=>!!(await modelState()).fields?.['height.field']?.cmap,'saved native field map');
  check(await js("document.querySelector('[data-part-id=\"height.colorbar\"]')?.textContent.match(/[−-]0\\.5/)"),'native colorbar follows the new field range without Python');
  await screenshot('value-field');await click('[aria-label="Close X-ray"]');await changePoster(old);const after=await captureMesh('field-after');
  check(pixelDifference(before,after)>.005,'native range/colormap remap visibly changes surface pixels');metrics.field={saved:await modelState(),changedPixelRatio:pixelDifference(before,after)};
 }else if(scenario==='paper'){
  const manifest=JSON.parse(await fs.readFile(path.join(root,'project.json'),'utf8'));
  const manuscript=path.join(root,manifest.manuscript.path),sourceBefore=await fs.readFile(manuscript);
  const old=await poster();await click(modelSelector);await click('.model3d-properties button[data-axis="top"]');await wait(async()=>(await modelState()).orbitElevation===90,'saved native top view');await changePoster(old);
  const figurePoster=await poster();metrics.paper={saved:await modelState()};
  await click('button[aria-label=Paper]');await wait(()=>js("!!document.querySelector('.paper[data-paper-sources-ready=\"true\"] .flux-embed-art img')"),'native Paper figure embed');
  const svg=await wait(()=>js("(async()=>{const img=document.querySelector('.flux-embed-art img');if(!img?.complete||!img.naturalWidth)return null;const text=window.__nativeModelEvidence.svgSources?.get(img.src);return text?.includes('data-model3d-poster')&&text.includes('data:image/png;')&&!text.includes('data-model3d-placeholder')?text:null})()"),'decoded native Paper 3D embed');
  await fs.writeFile(path.join(artifacts,'paper-figure.svg'),svg);check(svg.includes('Neuron-like mesh')&&svg.includes('<text'),'native Paper embed includes vector labels and a mesh poster');
  const mesh=svg.match(/<image\b[^>]*data-model3d-poster[^>]*>/)?.[0],paperPoster=mesh?.match(/\bhref="([^"]+)"/)?.[1];
  if(!paperPoster)throw Error('Paper embed missing PNG mesh');
  const comparison=await js(`(async()=>{const pixels=async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,128,128);return {data:ctx.getImageData(0,0,128,128).data,width:image.width,height:image.height}};const distance=(a,b)=>{let sum=0,n=0;for(let i=0;i<a.data.length;i+=4){if(Math.max(a.data[i+3],b.data[i+3])<8)continue;for(let c=0;c<3;c++)sum+=Math.abs(a.data[i+c]*a.data[i+3]/255-b.data[i+c]*b.data[i+3]/255);sum+=Math.abs(a.data[i+3]-b.data[i+3]);n+=4;}return n?sum/n:Infinity};const a=await pixels(${JSON.stringify(figurePoster)}),b=await pixels(${JSON.stringify(paperPoster)}),prior=await pixels(${JSON.stringify(old)});return{topError:distance(a,b),defaultError:distance(prior,b),referenceSeparation:distance(prior,a),figure:[a.width,a.height],paper:[b.width,b.height]}})()`);
  check(comparison.referenceSeparation>2&&comparison.topError<comparison.defaultError*.25,'native Paper shows saved Top rather than prior Default view (foreground-only mesh comparison)');metrics.paper.comparison=comparison;await screenshot('paper-embed');
  await clickText('.statusbar .seg','Export');await wait(()=>js("!!document.querySelector('.export-dialog')"),'native Paper export dialog');await js("Promise.all(document.querySelector('.export-dialog').getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))");
  await clickText('.export-dialog .seg','Word');await wait(()=>js("document.querySelector('.export-dialog .path-text')?.textContent.trim().endsWith('.docx')"),'native Word export destination');
  const destination=await js("document.querySelector('.export-dialog .path-text').textContent.trim()");if(!destination.startsWith(root+path.sep))throw Error('Word output escaped scratch project');
  check(!await js("document.querySelector('.export-dialog button.primary').disabled"),'actual Quarto is available to native Word export');await clickText('.export-dialog button.primary','Export');
  await wait(async()=>{try{return(await fs.stat(destination)).size>100}catch{return false}},'actual native Quarto/Word output',90000);
  await wait(()=>js("!document.querySelector('.export-progress')"),'native Word publication complete');const bytes=await fs.readFile(destination);await fs.writeFile(path.join(artifacts,'paper.docx'),bytes);
  const {unzipSync,strFromU8}=require('fflate'),zip=unzipSync(bytes),xml=strFromU8(zip['word/document.xml']);
  check(xml.includes('The neuron above retains its Figure view'),'actual native Word document contains manuscript text');
  const svgEntries=Object.entries(zip).filter(([name])=>/^word\/media\/.*\.svg$/i.test(name));
  check(svgEntries.some(([,data])=>{const text=strFromU8(data);return text.includes('data:image/png;')&&text.includes('Neuron-like mesh')&&!text.includes('data-model3d-placeholder')}),'actual Quarto Word package retains mesh PNG plus vector furniture in its SVG');
  const pngEntries=Object.entries(zip).filter(([name])=>/^word\/media\/.*\.png$/i.test(name));check(pngEntries.length>0,'Word package includes a real raster fallback for its figure');
  for(const[name,data]of [...svgEntries,...pngEntries])await fs.writeFile(path.join(artifacts,path.basename(name)),data);
  check((await fs.readFile(manuscript)).equals(sourceBefore),'native Quarto export restores exact QMD source bytes');metrics.paper.word={bytes:bytes.length,media:[...svgEntries,...pngEntries].map(([name])=>name)};await screenshot('paper-word-complete');
 }
};
