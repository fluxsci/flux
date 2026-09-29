import { harness } from './lib/harness.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectSourceRelativePath } from '../flux-core/projectSource';
import { VERBS, runCliVerb } from '../flux-core/registry';
const h=harness('verify-project-media-paths');
const scratch=await mkdtemp(path.join(os.tmpdir(),'flux-media-path-')),root=path.join(scratch,'project'),sibling=path.join(scratch,'project-other');
try {
 await mkdir(root);await mkdir(sibling);await mkdir(path.join(root,'plots'));
 await writeFile(path.join(root,'project.json'),JSON.stringify({version:2,title:'Media path fixture'}));
 for(const ext of ['mp4','glb']) {
  const relative=`plots/mesh.${ext}`,absolute=path.join(root,relative);await writeFile(absolute,'fixture');
  h.eq(await projectSourceRelativePath(root,relative),relative,`${ext}: relative input stays relative`);
  h.eq(await projectSourceRelativePath(root,absolute),relative,`${ext}: resolved CLI/MCP input canonicalizes once`);
  await writeFile(path.join(sibling,`mesh.${ext}`),'outside');
  for(const input of [`../project-other/mesh.${ext}`,path.join(sibling,`mesh.${ext}`),'/',root,`plots\\mesh.${ext}`,`plots/mesh.${ext}\0`]) await assert.rejects(()=>projectSourceRelativePath(root,input));
  await symlink(path.join(sibling,`mesh.${ext}`),path.join(root,`escape.${ext}`));
  await assert.rejects(()=>projectSourceRelativePath(root,`escape.${ext}`),/symlink escapes/);
  h.ok(true,`${ext}: lexical, prefix sibling, NUL, root and symlink escapes refused`);
  // Exercise each real registered CLI schema/argument path, substituting only
  // the media workload with the same shared confinement boundary it calls.
  const verb=VERBS.find(v=>v.cli===(ext==='glb'?'add-slide-model':'add-video'))!;
  const handler=verb.handler,render=verb.render,cwd=process.cwd();
  try {
   verb.handler=async(ctx,args)=>({root:ctx.root,received:args.sourcePath,relative:await projectSourceRelativePath(ctx.root,String(args.sourcePath))});
   verb.render=undefined;
   const invoke=async(source:string)=>{
    let output='',error='',exit=0;
    const pos=['deck','slide',source];
    const handled=await runCliVerb(verb.cli,{pos,posRooted:pos,flags:{root},rootFlags:root,rootPositional:root},{log:s=>{output=s;},err:s=>{error=s;},setExit:code=>{exit=code;}});
    assert.equal(handled,true);return {output,error,exit};
   };
   process.chdir(scratch);
   for(const input of [absolute,path.relative(scratch,absolute)]) {
    const result=await invoke(input);assert.equal(result.exit,0,result.error);
    h.eq(JSON.parse(result.output),{root,received:absolute,relative},`${ext}: unrelated CLI cwd accepts absolute or shell-relative in-project media`);
   }
   const wrongCwd=await invoke(relative);
   h.ok(wrongCwd.exit!==0&&/escapes/.test(wrongCwd.error),`${ext}: --root never reinterprets an escaping shell-relative source`);
   process.chdir(root);
   const local=await invoke(relative);assert.equal(local.exit,0,local.error);
   h.eq(JSON.parse(local.output),{root,received:absolute,relative},`${ext}: project cwd permits the ordinary project-relative CLI spelling`);
  } finally {process.chdir(cwd);verb.handler=handler;verb.render=render;}
 }
} finally {await rm(scratch,{recursive:true,force:true});}
h.done();
