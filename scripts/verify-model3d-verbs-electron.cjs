'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
async function main(h) {
  await import('./lib/cssStub.mjs');
  const core = await import('../flux-core/index.ts'), { loadFigModel } = await import('../flux-core/model.ts');
  const { staticModelRequest } = await import('../src/lib/model3d/static.ts');
  const { readModel3dMetadata } = await import('../flux-core/model3d.ts');
  const { machineModelPosterDir, validModelPosterPng } = await import('../flux-core/model3dPosterCache.ts');
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const repo=path.resolve(__dirname,'..'), scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-model3d-verbs-native-'));
  const root=path.join(scratch,'project'), artifacts=path.join(repo,'test-results/model3d/verbs-native'), calls=path.join(scratch,'worker-calls');
  const env={...process.env,FLUX_NO_MIGRATE:'1',FLUX_MODEL3D_APP_ROOT:repo}; delete env.FLUX_MODEL3D_DISABLE; delete env.ELECTRON_RUN_AS_NODE;
  const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  if(process.platform==='linux'){
    const shim=path.join(scratch,'electron-counted');
    await fs.writeFile(shim,`#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(calls)}\nexec ${shellQuote(env.FLUX_MODEL3D_ELECTRON||require('electron'))}${env.FLUX_ELECTRON_NO_SANDBOX==='1'?' --no-sandbox':''} "$@"\n`,{mode:0o700});
    env.FLUX_MODEL3D_ELECTRON=shim;
  }
  const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(repo,'dist/flux-cli.mjs'),...args],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err||`CLI exit ${code}`)));});
  const count=async()=>process.platform==='linux'?(await fs.readFile(calls,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length:undefined;
  try{
    await fs.mkdir(artifacts,{recursive:true});await core.scaffold(root,{title:'Native model commands'});const {figureId}=await core.createFigure(root,{id:'model-native'});
    const added=await run(['add-model',figureId,path.join(repo,'scripts/fixtures/model3d/fluxplot/named-parts.glb'),'--root',root,'--width','280','--height','240']);
    assert.equal(added.poster?.ready,true,JSON.stringify(added));h.ok(true,'built add-model returns a real native-rendered project poster');
    if(process.platform==='linux'){assert.equal(await count(),1);h.ok(true,'import spawns the production Electron entry exactly once');}
    await core.mutateFigModel(root,'fixture-second-view',({project})=>{const f=project.figures.find(f=>f.id===figureId),el=f.elements.find(e=>e.id===added.elementId);f.elements.push({...structuredClone(el),id:'second-view',orbitAzimuth:el.orbitAzimuth+90});});
    const renderDir=path.join(root,'fig/renders/model3d');for(const f of await fs.readdir(renderDir))await fs.rm(path.join(renderDir,f));
    const before=await count(),rendered=await run(['render-model-posters','--root',root,'--figure',figureId]);
    assert.equal(rendered.posters.length,2);assert.ok(rendered.posters.every(p=>p.ready&&p.path.startsWith(renderDir+path.sep)));
    if(process.platform==='linux')assert.equal(await count(),before+1);
    h.ok(true,'two uncached saved views use one native batch and return only validated project paths');
    const pngs=await Promise.all(rendered.posters.map(p=>fs.readFile(p.path)));assert.notDeepEqual(pngs[0],pngs[1]);
    const coverage=[];
    for(const [i,p] of rendered.posters.entries()){
      assert.ok(validModelPosterPng(pngs[i],{w:p.width,h:p.height}));
      const c=createCanvas(p.width,p.height),ctx=c.getContext('2d');ctx.drawImage(await loadImage(pngs[i]),0,0);const rgba=ctx.getImageData(0,0,p.width,p.height).data;
      let pixels=0;for(let at=3;at<rgba.length;at+=4)if(rgba[at]>10)pixels++;
      assert.ok(pixels>p.width*p.height*.02&&pixels<p.width*p.height*.95);coverage.push({width:p.width,height:p.height,pixels});await fs.copyFile(p.path,path.join(artifacts,`view-${i}.png`));
    }
    h.ok(true,'decoded mesh posters contain transparent margins and distinct view pixels');
    const warmBefore=await count();await run(['render-model-posters','--root',root]);assert.equal(await count(),warmBefore);h.ok(true,'warm explicit poster command does not spawn another worker');
    const p=rendered.posters[0];await fs.mkdir(machineModelPosterDir(),{recursive:true});await fs.writeFile(path.join(machineModelPosterDir(),`${p.key}.png`),pngs[0]);await fs.writeFile(p.path,'corrupt');
    const repaired=await run(['render-model-posters','--root',root]);assert.ok(repaired.posters.every(p=>p.ready));assert.deepEqual(await fs.readFile(p.path),pngs[0]);assert.equal(await count(),warmBefore);h.ok(true,'valid machine hit repairs a corrupt project poster without a native render');
    const secondFigure=await core.createFigure(root,{id:'protect-off-filter'});await core.mutateFigModel(root,'fixture-protected-view',({project})=>{const source=project.figures.find(f=>f.id===figureId).elements[0];project.figures.find(f=>f.id===secondFigure.figureId).elements.push({...structuredClone(source),id:'protected',orbitAzimuth:222});});
    const saved=await loadFigModel(root),protectedElement=saved.project.figures.find(f=>f.id===secondFigure.figureId).elements[0],asset=saved.project.assets.find(a=>a.id===protectedElement.assetId),metadata=await readModel3dMetadata(root,saved.project,asset.id),request=staticModelRequest(protectedElement,asset,metadata.manifest,'figure');
    const protectedFile=path.join(renderDir,`${request.key}.png`);await fs.writeFile(protectedFile,'derived but old');const ago=new Date(Date.now()-15*86400000);await fs.utimes(protectedFile,ago,ago);
    const pruned=await run(['render-model-posters','--root',root,'--figure',figureId,'--prune']);assert.ok(!pruned.removed.includes(path.basename(protectedFile)));assert.equal(await fs.readFile(protectedFile,'utf8'),'derived but old');h.ok(true,'filtered prune protects live views in every saved figure');
    if(process.platform==='linux'){const log=await fs.readFile(calls,'utf8');assert.ok(log.split('\n').filter(Boolean).every(line=>line.includes('electron/entry.cjs')&&line.includes('--ozone-platform=headless')));await fs.writeFile(path.join(artifacts,'worker-calls.txt'),log);}
    await fs.writeFile(path.join(artifacts,'receipt.json'),JSON.stringify({workerSpawns:await count(),coverage,posterCount:rendered.posters.length},null,2)+'\n');
  }finally{await fs.rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
import('./lib/harness.mjs').then(async({harness})=>{const h=harness('verify-model3d-verbs-electron');try{await main(h);}catch(e){console.error(e);h.fail(String(e));}await h.done();});
