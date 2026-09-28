'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {compareCohorts,qualificationSamples,cohortIdleVsyncMs}=require('./lib/model3dS8Metrics.cjs');
async function main(){
  const {harness}=await import('./lib/harness.mjs'),{TestProcessScope}=await import('./lib/testProcess.mjs');
  const {fetchPublicS8Fixture,verifyPublicS8Fixture}=await import('./lib/model3dS8PublicFixture.mjs');
  const h=harness('verify-model3d-s8'),scope=new TestProcessScope(),repo=path.resolve(__dirname,'..');
  const scratch=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'flux-model3d-s8-'))),out=path.join(repo,'test-results/model3d/scale/s8');
  const model=path.join(scratch,'model'),image=path.join(scratch,'image');
  const env={...process.env,HOME:path.join(scratch,'home'),XDG_CONFIG_HOME:path.join(scratch,'config'),XDG_DATA_HOME:path.join(scratch,'data'),XDG_CACHE_HOME:path.join(scratch,'cache'),APPDATA:path.join(scratch,'appdata'),FLUX_NO_MIGRATE:'1',FLUX_PRIVATE_DISPLAY:'1',MODEL3D_NATIVE_SCRATCH:scratch};
  for(const k of ['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL','SOFTGPU','FLUX_MODEL3D_DISABLE','WAYLAND_DISPLAY','PROBE_EXTRA_ARGS'])delete env[k];
  if(process.platform==='linux')env.DISPLAY=process.env.DISPLAY||':0';
  async function run(file,args,name,extra={}){
    const child=scope.spawn(path.join(repo,file),args,{env,cwd:repo,deadlineMs:180000,...extra});await scope.waitExit(child);
    await fs.writeFile(path.join(out,name+'.log'),child.stdout+child.stderr);
    if(child.code!==0)throw Error(`${name} failed: `+(child.stdout+child.stderr).slice(-12000));
  }
  try{
    await fs.mkdir(out,{recursive:true});await fs.mkdir(env.HOME,{recursive:true});
    const source=process.env.MODEL3D_S8_PUBLIC_CACHE||path.join(scratch,'public');
    const provenance=process.env.MODEL3D_S8_PUBLIC_CACHE?await verifyPublicS8Fixture(source):await fetchPublicS8Fixture(source);
    await fs.writeFile(path.join(out,'public-source.json'),JSON.stringify(provenance,null,2));
    h.eq(provenance.count,369,'all pinned public example files verified; no owner checkout is used');
    await run('scripts/lib/model3dS8Fixture.ts',[source,model],'seed');
    const fixture=JSON.parse(await fs.readFile(path.join(model,'s8-fixture-receipt.json'),'utf8'));
    await fs.copyFile(path.join(model,'s8-fixture-receipt.json'),path.join(out,'fixture.json'));
    await run('scripts/lib/model3dNativeScaleEntry.cjs',[model,...(process.platform==='linux'?['--ozone-platform=x11']:[])],'capture',{
      command:require('electron'),nodeArgs:[],env:{...env,MODEL3D_NATIVE_ROOT:model,MODEL3D_NATIVE_ARTIFACTS:path.join(out,'capture'),MODEL3D_NATIVE_CAPTURE_BASELINE:image,MODEL3D_NATIVE_FIGURE_ID:fixture.figureId}});
    const capture=JSON.parse(await fs.readFile(path.join(out,'capture/receipt.json'),'utf8'));
    h.ok(capture.ok&&capture.metrics.baseline.captures.length===4,'production worker meshes and furniture produce four matched raster controls');
    for(const [variant,root]of[['model',model],['image',image]])await run('scripts/lib/model3dS8RenderFixture.ts',[root,variant],'render-'+variant);
    const cohorts=[],idleControls=[];
    for(const [i,variant]of['model','image','image','model'].entries()){
      const cohortOut=path.join(out,`${i}-${variant}`),root=variant==='model'?model:image;
      await run('scripts/perf/input-probe.cjs',[root,'--surface=both','--scenarios=base','--phases=hover,panSmall,zoom,typing','--ozone=x11','--qualify',`--model3d-s8=${variant}`,`--out=${cohortOut}`],'probe-'+i,{nodeArgs:[],deadlineMs:240000});
      const result=JSON.parse(await fs.readFile(path.join(cohortOut,'results.json'),'utf8'));
      const samples={};
      for(const phase of['hover','panSmall','zoom','typing']){
        const label=phase==='typing'?'paper-typing':`figure-base-${phase}`;
        const raw=JSON.parse(await fs.readFile(path.join(cohortOut,`qualification-${label}.json`),'utf8')).raw;
        samples[phase]=qualificationSamples(raw,phase);
        h.ok(phase==='typing'?result.paper.typing.keys>=25:result.figure.base[phase].frames>=20,`${variant} cohort${i} ${phase} has delivered input and measured frames`);
      }
      const structure=JSON.parse(await fs.readFile(path.join(cohortOut,'model3d-s8.json'),'utf8'));
      h.ok(structure.modelWorkers.length===(variant==='model'?1:0),`${variant} cohort${i} has the expected actual worker topology`);
      h.ok(structure.idleControl?.gaps?.length>=100,`${variant} cohort${i} recorded an idle vsync control`);idleControls.push(structure.idleControl);
      cohorts.push({variant,samples});
    }
    const idleVsyncMs=cohortIdleVsyncMs(idleControls),comparison=compareCohorts(cohorts,{idleVsyncMs});
    await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify({ok:Object.values(comparison).every(c=>c.ok),idleVsyncMs,comparison,cohorts,metric:'Existing input-probe rAF gap p95 for Figure hover/panSmall/zoom; key to double-rAF p95 for Paper typing. ABBA pooled raw cohorts; production throttling preserved; budget max(image*1.1, image + one idle vsync) with the vsync from the pooled idle controls of this run. The probe has its existing continuous measurement loop, unlike the separate native orbit gate.'},null,2));
    for(const[phase,row]of Object.entries(comparison))h.ok(row.ok,`${phase} p95 stays within max(10%, one idle vsync) of the image baseline (${row.modelP95}/${row.imageP95}ms, budget ${row.budgetMs.toFixed(3)}ms)`);
  }catch(error){h.fail(String(error.stack||error));}
  finally{await scope.dispose();await fs.rm(scratch,{recursive:true,force:true,maxRetries:5});}
  await h.done();
}
void main();
