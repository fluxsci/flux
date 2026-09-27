#!/usr/bin/env node
// Publication consumes only successful fresh reports, never arbitrary release/ files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {assertChecks,assertIdentity,sourceIdentity,assertArtifactSet} from './lib/releasePolicy.mjs';
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`Required ${name}`);return args[i+1]};
async function walk(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.isFile())out.push(p)}return out;}
const root=path.resolve(option('--directory')),files=await walk(root),reports=await Promise.all(files.filter(f=>path.basename(f)==='qualification.json').map(async file=>({file,...JSON.parse(await fs.readFile(file,'utf8'))})));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),pkg=JSON.parse(await fs.readFile('package.json','utf8')),tag=process.env.RELEASE_TAG;
assertIdentity({version:pkg.version,tag,dirty:false,release:true});
const expected=new Set(['linux-x64','darwin-arm64','darwin-x64']);
const current=await sourceIdentity(process.cwd());
let digest; const verifiedArtifacts=[];
for(const report of reports){const target=`${report.platform}-${report.arch}`;if(!expected.delete(target))throw Error(`Unexpected or duplicate target ${target}`);if(report.status!=='qualified'||report.tag!==tag||report.version!==pkg.version||report.identity.commit!==commit)throw Error(`Unqualified/stale target ${target}`);assertChecks(report,report.identity);if(report.identity.digest!==current.digest)throw Error("Qualification source differs from release checkout");if(digest&&digest!==report.identity.digest)throw Error('Targets were built from different source');digest=report.identity.digest;
 for(const name of ['package','packaged-smoke','fetch-correction-runtime','fetch-video-encoder'])if(report.checks[name]?.status!=='passed')throw Error(`Missing ${target} ${name}`);
 if(!Array.isArray(report.artifacts))throw Error(`Missing artifact manifest for ${target}`);
 assertArtifactSet(report.artifacts.map(a=>a.name),report.platform,[report.arch]);
 const names=new Set();
 for(const artifact of report.artifacts){if(names.has(artifact.name)||path.basename(artifact.name)!==artifact.name||! /\.(deb|AppImage|dmg|zip)$/.test(artifact.name))throw Error('Invalid or duplicate artifact name');names.add(artifact.name);const matches=files.filter(f=>path.basename(f)===artifact.name&&f.startsWith(path.dirname(report.file)+path.sep));if(matches.length!==1)throw Error(`Missing/ambiguous ${artifact.name}`);const data=await fs.readFile(matches[0]);if(data.length!==artifact.size||createHash('sha256').update(data).digest('hex')!==artifact.sha256)throw Error(`Artifact bytes changed: ${artifact.name}`);verifiedArtifacts.push(matches[0]);}
}
if(expected.size)throw Error(`Missing platform qualification: ${[...expected]}`);
const approval=JSON.parse(await fs.readFile(option('--platform-evidence'),'utf8'));
if(approval.commit!==commit||approval.tag!==tag||typeof approval.reviewer!=='string'||!approval.reviewer.trim())throw Error('Platform approval must identify reviewer and exact release source');
for(const key of ['linuxPhysicalDisplay','macArm64PhysicalDisplay','macX64PhysicalDisplay','distributionPolicy'])if(approval.checks?.[key]?.status!=='passed'||!approval.checks[key].evidence)throw Error(`Platform qualification missing: ${key}`);
await fs.writeFile(option('--artifact-list'),verifiedArtifacts.join('\0')+'\0');
console.log(`Release evidence PASS ${tag}: three native targets, artifact SHA-256 values and recorded physical-platform/distribution qualification`);
