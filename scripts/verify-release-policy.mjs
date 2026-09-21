import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertIdentity,assertChecks,assertResults,assertArtifactSet,assertPackagedApp,freshOutput,REQUIRED_CHECKS,sourceIdentity} from './lib/releasePolicy.mjs';
const identity={commit:'123',digest:'abc',dirty:false};
assertIdentity({version:'0.2.0',tag:'v0.2.0',dirty:false,release:true});
for(const patch of [{tag:'v0.1.0'},{dirty:true},{tag:''}])assert.throws(()=>assertIdentity({version:'0.2.0',tag:'v0.2.0',dirty:false,release:true,...patch}));
const report={identity,checks:Object.fromEntries(REQUIRED_CHECKS.map(k=>[k,{status:'passed'}]))};assertChecks(report,identity);
for(const status of ['failed','blocked','flaky','skipped'])assert.throws(()=>assertChecks({...report,checks:{...report.checks,ui:{status}}},identity));
assert.throws(()=>assertChecks(report,{...identity,digest:'stale'}));
assertResults({total:1,passed:1,results:[{status:'passed',attempts:[{status:'passed'}]}]});
assert.throws(()=>assertResults({sourceChanged:true,total:1,passed:1,results:[{status:'passed',attempts:[{status:'passed'}]}]}),/source changed/);
assert.throws(()=>assertResults({total:1,passed:1,results:[{status:'passed',attempts:[{status:'failed'},{status:'passed'}]}]}));
assertArtifactSet(['fresh.deb','fresh.AppImage'],'linux');assert.throws(()=>assertArtifactSet(['old.deb'],'linux'));
assertArtifactSet(['Flux-arm64.dmg','Flux-arm64.zip','Flux.dmg','Flux.zip'],'darwin');assert.throws(()=>assertArtifactSet(['Flux-arm64.dmg','Flux-arm64.zip'],'darwin'));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'release-policy-'));
try{
 const first=await freshOutput(root),second=await freshOutput(root);assert.notEqual(first,second);await fs.writeFile(path.join(first,'old.AppImage'),'stale');assert.deepEqual(await fs.readdir(second),[]);
 await assert.rejects(assertPackagedApp({cli:path.join(first,'old.AppImage'),resources:{}}),/executable/);

 // Run the production publication validator, including its artifact-list seam,
 // against synthetic reports in a disposable clean repository. These are test
 // fixtures only: no real platform approval or release artifact is certified.
 const execute=promisify(execFile),repo=path.join(root,'synthetic repository');await fs.mkdir(repo);const hooks=path.join(root,'no hooks');await fs.mkdir(hooks);
 const git=(...args)=>execute('git',['-c','user.name=Flux verification','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c',`core.hooksPath=${hooks}`,...args],{cwd:repo,timeout:10000});
 await fs.writeFile(path.join(repo,'package.json'),JSON.stringify({version:'0.2.0'}));await fs.writeFile(path.join(repo,'source.txt'),'release fixture source\n');
 await git('init');await git('add','--','package.json','source.txt');await git('commit','-m','synthetic release verification fixture');
 const cleanSource=await sourceIdentity(repo),newFile=path.join(repo,'untracked implementation.ts');
 await fs.writeFile(newFile,'export const value=1;');const withNew=await sourceIdentity(repo);
 assert.equal(withNew.dirty,true);assert.notEqual(withNew.digest,cleanSource.digest);assert.equal(withNew.indexDigest,cleanSource.indexDigest);
 await fs.writeFile(newFile,'export const value=2;');assert.notEqual((await sourceIdentity(repo)).digest,withNew.digest);
 await fs.rm(newFile);assert.deepEqual(await sourceIdentity(repo),cleanSource);
 const actual=await sourceIdentity(repo),reportsRoot=path.join(root,'qualification fixtures'),approvalFile=path.join(root,'synthetic approval.json'),listFile=path.join(root,'verified-artifacts.nul');
 const approval={commit:actual.commit,tag:'v0.2.0',reviewer:'Synthetic fixture, not approval',checks:Object.fromEntries(['linuxPhysicalDisplay','macArm64PhysicalDisplay','macX64PhysicalDisplay','distributionPolicy'].map(k=>[k,{status:'passed',evidence:'synthetic test fixture only'}]))};await fs.writeFile(approvalFile,JSON.stringify(approval));
 const records=[];const expectedArtifacts=[];
 for(const [platform,arch,names] of [['linux','x64',['fixture.deb','fixture.AppImage']],['darwin','arm64',['fixture-arm64.dmg','fixture-arm64.zip']],['darwin','x64',['fixture-x64.dmg','fixture-x64.zip']]]){
   const directory=path.join(reportsRoot,`${platform}-${arch}`);await fs.mkdir(path.join(directory,'artifacts'),{recursive:true});
   const artifacts=[];for(const name of names){const bytes=Buffer.from(`${platform}-${arch}:${name}`),file=path.join(directory,'artifacts',name);await fs.writeFile(file,bytes);expectedArtifacts.push(file);artifacts.push({name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
   const value={status:'qualified',platform,arch,tag:'v0.2.0',version:'0.2.0',identity:actual,checks:Object.fromEntries([...REQUIRED_CHECKS,'package','packaged-smoke','fetch-correction-runtime','fetch-video-encoder'].map(k=>[k,{status:'passed'}])),artifacts};
   const file=path.join(directory,'qualification.json');await fs.writeFile(file,JSON.stringify(value));records.push({value,file});
 }
 const validator=path.resolve(import.meta.dirname,'verify-release-evidence.mjs');
 const verify=()=>execute(process.execPath,[validator,'--directory',reportsRoot,'--platform-evidence',approvalFile,'--artifact-list',listFile],{cwd:repo,env:{...process.env,RELEASE_TAG:'v0.2.0'},timeout:20000});
 const extra=path.join(path.dirname(records[0].file),'fixture-only.zip');await fs.writeFile(extra,'not a release artifact');await verify();
 assert.deepEqual((await fs.readFile(listFile,'utf8')).split('\0').filter(Boolean).sort(),expectedArtifacts.sort());
 assert.ok(!(await fs.readFile(listFile,'utf8')).includes(extra),'an extra test fixture ZIP must never be emitted for publication');
 const adverse=async(mutate,pattern)=>{const record=records[0],changed=structuredClone(record.value);mutate(changed);await fs.writeFile(record.file,JSON.stringify(changed));try{await assert.rejects(verify,pattern);}finally{await fs.writeFile(record.file,JSON.stringify(record.value));}};
 await adverse(r=>r.artifacts=[],/Missing fresh linux artifact/);
 await adverse(r=>r.checks.ui.status='blocked',/Missing or unsuccessful required check: ui/);
 await adverse(r=>{delete r.checks.docs},/Missing or unsuccessful required check: docs/);
 await adverse(r=>r.identity.digest='stale',/source differs/);
 await adverse(r=>r.artifacts.push(r.artifacts[0]),/Invalid or duplicate artifact name/);
 const lost=records[2];await fs.rename(lost.file,lost.file+'.disabled');try{await assert.rejects(verify,/Missing platform qualification: darwin-x64/);}finally{await fs.rename(lost.file+'.disabled',lost.file);}
 const changed=expectedArtifacts[0],before=await fs.readFile(changed);await fs.writeFile(changed,'corrupted bytes');try{await assert.rejects(verify,/Artifact bytes changed/);}finally{await fs.writeFile(changed,before);}
 const invalidApproval=structuredClone(approval);invalidApproval.checks.macX64PhysicalDisplay.status='unavailable';await fs.writeFile(approvalFile,JSON.stringify(invalidApproval));try{await assert.rejects(verify,/Platform qualification missing: macX64PhysicalDisplay/);}finally{await fs.writeFile(approvalFile,JSON.stringify(approval));}
 console.log('Publication evidence adverse checks PASS: exact6 artifact NUL list excludes extra fixture ZIP; empty/missing architecture, stale source, blocked UI, missing docs check, duplicate/corrupt bytes, and missing physical evidence refused.');
}finally{await fs.rm(root,{recursive:true,force:true})}
console.log('Release policy PASS: mismatched tag, dirty/stale source, failed UI/flaky evidence, stale output and missing native executable refuse qualification.');
