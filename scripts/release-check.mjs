#!/usr/bin/env node
// Local and CI qualification. Produces evidence; NEVER publishes a release.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {assertNodeVersion} from './lib/nodeCheck.mjs';
import {executeAttempt,isolatedEnv} from './lib/verifyRuntime.mjs';
import {TestProcessScope} from './lib/testProcess.mjs';
import {assertIdentity,sourceIdentity,assertChecks,assertResults,freshOutput,assertArtifactSet,RELEASE_TARGETS} from './lib/releasePolicy.mjs';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assertNodeVersion('release-check');
const args=process.argv.slice(2),skipPack=args.includes('--skip-pack'),release=args.includes('--release');
const option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]};
const platform=option('--platform')??process.platform,arch=option('--arch')??process.arch;
const tag=(process.env.RELEASE_TAG??(process.env.GITHUB_REF_TYPE==='tag'?process.env.GITHUB_REF_NAME:'')??'').trim();
if(!RELEASE_TARGETS[platform]?.includes(arch))throw Error(`Unsupported release target ${platform}-${arch}`);
if(platform!==process.platform||arch!==process.arch)throw Error('Qualification must execute on the emitted native architecture');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')),identity=await sourceIdentity(root);
assertIdentity({version:pkg.version,tag,dirty:identity.dirty,release});
if(release&&skipPack)throw Error('--skip-pack cannot qualify a release');
const output=await freshOutput(path.join(root,'release'));
const report={version:pkg.version,tag:tag||null,identity,platform,arch,startedAt:new Date().toISOString(),status:'running',checks:{},output,artifacts:[],limitations:['Physical-display approval and distribution policy remain separate recorded qualifications.']};
const scope=new TestProcessScope();
const npmCandidates=[process.env.npm_execpath,path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')].filter(Boolean);
let npmCli;for(const candidate of npmCandidates)if(await fs.access(candidate).then(()=>true,()=>false)){npmCli=candidate;break;}
if(!npmCli)throw Error('Cannot locate npm CLI for the current Node runtime');
const childEnv=isolatedEnv(path.join(output,'environment'));
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})});
async function check(name,file,argv=[],timeoutMs=3600000){
 console.log(`\n▶ ${name}`);
 const result=await executeAttempt({spec:{runtime:'node',prerequisites:[],externalNetwork:false,isolation:'scratch'},file:path.resolve(root,file),dir:path.join(output,'checks',name),cwd:root,timeout:timeoutMs,env:childEnv,commandOverride:{command:process.execPath,nodeArgs:[],file:path.resolve(root,file),args:argv}});
 report.checks[name]={status:result.status,ms:result.ms,directory:result.directory};
 if(result.status!=='passed')throw Error(`${name}: ${result.status}\n${result.out.slice(-12000)}`);
 return result;
}
async function cohort(name,flags){await check(name,'scripts/run-verifies.mjs',flags);const result=report.checks[name];const log=await fs.readFile(path.join(result.directory,'stdout.log'),'utf8');const evidence=/Evidence:\s*(.+)/.exec(log)?.[1]?.trim();if(!evidence)throw Error('Runner did not record unique cohort evidence');const summary=JSON.parse(await fs.readFile(path.join(evidence,'summary.json'),'utf8'));assertResults(summary);const expectedTier=flags[flags.indexOf('--tier')+1],expectedGroup=flags[flags.indexOf('--group')+1];if(flags.includes('--tier')&&!summary.tiers.includes(expectedTier)||flags.includes('--group')&&!summary.groups.includes(expectedGroup))throw Error('Cohort evidence does not match requested checks');report.checks[name].evidence=summary.directory;}
try {
 const prior=option('--gate-report');
 if(prior){const evidence=JSON.parse(await fs.readFile(prior,'utf8'));assertChecks(evidence,identity);if(evidence.platform!==platform||evidence.arch!==arch)throw Error('Native gate evidence belongs to another platform/architecture');report.checks=evidence.checks;}
 else{
  await check('renderer',npmCli,['run','check']);await check('headless',npmCli,['run','check:headless']);
  const audit=await check('audit',npmCli,['audit','--json']);const parsed=JSON.parse(await fs.readFile(path.join(audit.directory,'stdout.log'),'utf8'));
  if(!parsed.metadata?.vulnerabilities||parsed.metadata.vulnerabilities.total!==0)throw Error('Dependency audit has untriaged findings; record and qualify an explicit exception before release');
  for(const helper of ['correction-runtime','video-encoder'])await check(`fetch-${helper}`,`scripts/fetch-${helper}.mjs`,['--platform',platform,'--arches',arch]);
  await check('build',npmCli,['run','build']);
  await cohort('pure',['--tier','pure','--jobs','3']);
  await cohort('bundle',['--tier','bundle']);await cohort('startup',['--tier','startup']);
  const port=await freePort();childEnv.FLUX_URL=`http://127.0.0.1:${port}/`;
  const server=scope.spawn(path.join(root,'node_modules/vite/bin/vite.js'),['--host','127.0.0.1','--port',String(port),'--strictPort'],{nodeArgs:[],cwd:root,env:childEnv,readyLine:'Local:',deadlineMs:14400000});await server.ready;
  for(const tier of ['ui','ui-extra','scale'])await cohort(tier,['--tier',tier]);
  for(const group of ['paper-gate','reader-gate'])await cohort(group,['--group',group]);
  await cohort('native',['--tier','electron']);
 }
 // Rebuild the offline help even when reusing identical-source gate evidence.
 // Packaging must never consume a stale or absent docs/_site from another run.
 await check('docs',npmCli,['run','build:docs']);
 assertChecks(report,identity);
 if(skipPack){report.status='partial';console.log('\nPreflight checks passed. PARTIAL: packaging, packaged smokes and distribution approval were not performed.');}
 else{
  // Every emitted target is fetched before builder; cached inventory is rehashed.
  for(const helper of ['correction-runtime','video-encoder'])await check(`fetch-${helper}`,`scripts/fetch-${helper}.mjs`,['--platform',platform,'--arches',arch]);
  const builderArgs=[platform==='darwin'?'--mac':'--linux',`--${arch}`,'--publish','never',`-c.directories.output=${path.join(output,'artifacts')}`];
  if(platform==='darwin'){
   if(process.env.CSC_LINK){if(!process.env.APPLE_TEAM_ID)throw Error('Signed macOS qualification requires notarization team identity');builderArgs.push(`-c.mac.notarize.teamId=${process.env.APPLE_TEAM_ID}`);report.signing='Developer ID + notarization';}
   else{builderArgs.push('-c.mac.identity=null','-c.mac.hardenedRuntime=false');report.signing='ad-hoc unsigned';}
  }
  await check('package',require.resolve('electron-builder/out/cli/cli.js'),builderArgs);
  const dir=path.join(output,'artifacts'),files=(await fs.readdir(dir)).map(f=>path.join(dir,f));assertArtifactSet(files,platform,[arch]);
  await check('packaged-smoke','scripts/verify-packaged-app.mjs',['--directory',dir,'--platform',platform,'--arch',arch]);
  const finalIdentity=await sourceIdentity(root);if(finalIdentity.dirty||finalIdentity.digest!==identity.digest||finalIdentity.commit!==identity.commit)throw Error('Source changed during qualification');
  for(const file of files){const stat=await fs.stat(file);if(!stat.isFile()||! /\.(deb|AppImage|dmg|zip)$/.test(file))continue;const bytes=await fs.readFile(file);report.artifacts.push({name:path.basename(file),path:file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  report.status='qualified';console.log('\nAutomated qualification passed for this target. No release was published; inspect the evidence and remaining platform approval before distribution.');
 }
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;console.error(error);}
finally{await scope.dispose();report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'qualification.json'),JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(root,'release','latest-qualification.json'),JSON.stringify(report,null,2)+'\n');await fs.rm(childEnv.TMPDIR,{recursive:true,force:true});console.log(`Evidence: ${path.join(output,'qualification.json')}`);}
