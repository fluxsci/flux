// Shared local/CI release policy. No publishing side effects.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const REQUIRED_CHECKS=['audit','renderer','headless','pure','build','docs','bundle','startup','ui','ui-extra','paper-gate','reader-gate','scale','native'];
export const RELEASE_TARGETS={linux:['x64'],darwin:['arm64','x64']};
export function assertIdentity({version,tag,dirty,release=false}) {
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))throw Error('Invalid package version');
  if(tag && tag!==`v${version}`)throw Error(`Tag ${tag} must exactly match package version v${version}`);
  if(release&&!tag)throw Error('A release requires an exact version tag');
  if(dirty)throw Error('Release qualification requires a clean source checkout');
}
export async function sourceIdentity(root) {
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
  const commit=git('rev-parse','HEAD').trim(),dirty=!!git('status','--porcelain','--untracked-files=normal');
  const files=[...new Set(git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean))].sort(),hash=createHash('sha256');
  const index=git('ls-files','--stage','-z');
  hash.update(index+'\0');
  for(const rel of files){hash.update(rel+'\0');try{hash.update(await fs.readFile(path.join(root,rel)))}catch(error){if(error.code!=='ENOENT')throw error;hash.update('<missing>')}hash.update('\0');}
  return {commit,dirty,digest:hash.digest('hex'),indexDigest:createHash('sha256').update(index).digest('hex')};
}
export function assertChecks(report,identity,required=REQUIRED_CHECKS) {
  if(report.identity?.commit!==identity.commit||report.identity?.digest!==identity.digest||report.identity?.dirty)throw Error('Verification evidence belongs to different or dirty source');
  for(const name of required)if(report.checks?.[name]?.status!=='passed')throw Error(`Missing or unsuccessful required check: ${name}`);
}
export function assertResults(summary) {
  if(summary?.sourceChanged)throw Error('Required cohort source changed during verification');
  if(!summary?.total||summary.passed!==summary.total||summary.results?.length!==summary.total||summary.results.some(r=>r.status!=='passed'||r.attempts?.some(a=>a.status!=='passed')))throw Error('Required cohort contains missing, failed, blocked or flaky evidence');
}
export async function freshOutput(parent) {
  await fs.mkdir(parent,{recursive:true});
  return fs.mkdtemp(path.join(parent,'qualification-'));
}
export function assertArtifactSet(files,platform,arches=RELEASE_TARGETS[platform]) {
  const names=files.map(f=>path.basename(f));
  const wanted=platform==='linux'?[/\.deb$/, /\.AppImage$/]:platform==='darwin'?[...(arches.includes('arm64')?[/arm64.*\.dmg$/, /arm64.*\.zip$/]:[]),...(arches.includes('x64')?[/^(?!.*arm64).*\.dmg$/, /^(?!.*arm64).*\.zip$/]:[])]:null;
  if(!wanted)throw Error(`No release artifacts are authorized for ${platform}`);
  for(const pattern of wanted)if(!names.some(n=>pattern.test(n)))throw Error(`Missing fresh ${platform} artifact: ${pattern}`);
}
export async function assertPackagedApp({executable,cli,mcp,worker,assets,resources}) {
  for(const [name,file] of Object.entries({executable,cli,mcp,worker,assets,...resources})) {
    if(!file)throw Error(`Missing packaged ${name}`);
    const stat=await fs.stat(file).catch(()=>null);
    if(!stat?.isFile()||!stat.size)throw Error(`Missing packaged ${name}: ${file}`);
  }
}
