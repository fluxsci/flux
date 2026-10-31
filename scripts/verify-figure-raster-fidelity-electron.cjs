'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
async function main(h){
 const repo=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(os.tmpdir(),'flux-fidelity-'));
 const{TestProcessScope}=await import('./lib/testProcess.mjs'),scope=new TestProcessScope();
 const output=process.env.FLUX_OUT||path.join(repo,'test-results/figure-raster-fidelity');
 const project=path.join(scratch,'project'),specs=path.join(scratch,'specs.json');
 const env={...process.env,FLUX_NO_MIGRATE:'1',FLUX_FIGURE_RASTER_WORKERS:'1',GSETTINGS_BACKEND:'memory',DIFF_FIXTURE:specs};
 try{
  await fs.mkdir(output,{recursive:true});
  const fixture=scope.spawn(path.join(__dirname,'lib/fidelityFixture.ts'),[project,specs],{env,deadlineMs:30000});
  assert.equal((await scope.waitExit(fixture)).code,0,fixture.stderr);
  const probe=scope.spawn(path.join(__dirname,'perf/atlas-diff.cjs'),[process.env.FLUX_FIGURE_RASTER_BASE||repo,project,output,process.env.FLUX_URL||'http://127.0.0.1:1441/'],{env,nodeArgs:[],deadlineMs:240000});
  const status=await scope.waitExit(probe);await fs.writeFile(path.join(output,'probe.log'),probe.stdout+probe.stderr);
  assert.equal(status.code,0,(probe.stdout+probe.stderr).slice(-8000));
  const expected=JSON.parse(await fs.readFile(specs,'utf8')),results=JSON.parse(await fs.readFile(path.join(output,'diff.json'),'utf8'));
  h.eq(results.length,Object.keys(expected).length,'every saved fixture is rendered through the real preload');
  for(const result of results){
   h.ok(!result.error,`${result.id}: service rendered (${result.error||'PNG'})`);
   if(result.error)continue;
   const spec=expected[result.id];
   h.ok(result.fraction<=spec.threshold,`${result.id}: block difference ${(100*result.fraction).toFixed(3)}% <= ${spec.threshold*100}%`);
   for(const label of result.labels){
    h.ok(label.inkLive>0 && Math.abs(label.coverageRatio-1)<=label.coverageTolerance,`${label.name}: ink ratio ${label.coverageRatio.toFixed(4)} within 5% of Chromium`);
    h.ok(label.fraction<=label.threshold,`${label.name}: block difference ${(100*label.fraction).toFixed(3)}% <= 1%`);
   }
  }
 }finally{await scope.dispose();await fs.rm(scratch,{recursive:true,force:true});}
}
import('./lib/harness.mjs').then(async({harness})=>{const h=harness('verify-figure-raster-fidelity-electron');try{await main(h)}catch(e){console.error(e);h.fail(String(e))}await h.done()});
