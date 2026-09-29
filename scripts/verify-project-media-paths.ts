import { harness } from './lib/harness.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectSourceRelativePath, projectRelativePath } from '../flux-core/projectSource';
import { boundedModelFile } from '../flux-core/model3dFile';
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
  // A backslash separates on win32 and is a filename character on POSIX.
  const backslashed=`plots\\mesh.${ext}`;
  for(const input of [`../project-other/mesh.${ext}`,path.join(sibling,`mesh.${ext}`),'/',root,...(path.sep==='/'?[backslashed]:[]),`plots/mesh.${ext}\0`]) await assert.rejects(()=>projectSourceRelativePath(root,input));
  if(path.sep==='\\') h.eq(await projectSourceRelativePath(root,backslashed),relative,`${ext}: win32 backslashed input is the same stored path`);
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
 // win32: resolvePathParams hands every CLI/MCP input over as `C:\proj\…`
 // and path.relative answers with backslashes; both used to be refused
 // outright, so add_slide_model/add_video and every bounded model read (deck
 // export, MP4, Paper) failed for every input on Windows.
 const win=path.win32;
 h.eq(projectRelativePath('C:\\proj','C:\\proj\\plots\\mesh.glb',win),'plots/mesh.glb','win32: a resolved in-project input becomes the portable stored path');
 h.eq(projectRelativePath('C:\\proj','C:\\proj/slides/deck/assets\\mesh.glb',win),'slides/deck/assets/mesh.glb','win32: a root joined with a stored path (mixed separators) normalizes to /');
 h.eq(projectRelativePath('C:\\Proj','c:\\proj\\plots\\mesh.glb',win),'plots/mesh.glb','win32: drive-letter and folder case follow the platform');
 h.eq(projectRelativePath('C:\\proj','plots\\nested\\mesh.glb',win),'plots/nested/mesh.glb','win32: a root-relative backslashed input is ordinary');
 for(const input of ['C:\\proj-other\\mesh.glb','C:\\proj\\..\\mesh.glb','D:\\proj\\plots\\mesh.glb','\\\\server\\share\\mesh.glb','C:\\proj','..\\proj-other\\mesh.glb']) assert.throws(()=>projectRelativePath('C:\\proj',input,win),undefined,input);
 h.ok(true,'win32: sibling prefix, parent, other drive, UNC share and the root itself are refused');
 if(path.sep==='/'){assert.throws(()=>projectRelativePath(root,'plots\\mesh.glb'),/Invalid stored asset path/);h.ok(true,'POSIX: a backslash is a filename character and stays refused');}
 h.eq(projectRelativePath(root,path.join(root,'plots/mesh.glb')),'plots/mesh.glb','POSIX: the shared helper matches the stored spelling');
 h.eq((await boundedModelFile(path.join(root,'plots/mesh.glb'),1024,root)).toString(),'fixture','bounded model reads judge the root-relative stored path');
 await assert.rejects(()=>boundedModelFile(path.join(sibling,'mesh.glb'),1024,root),/escapes/);h.ok(true,'bounded model reads still refuse a file outside the root');
 // A symlinked --root with a realpath shell cwd (or the reverse) names the
 // same in-project file through the other alias of the root.
 const alias=path.join(scratch,'project-alias');await symlink(root,alias);
 h.eq(await projectSourceRelativePath(alias,path.join(root,'plots/mesh.glb')),'plots/mesh.glb','symlinked root accepts the realpath spelling of an in-project file');
 h.eq(await projectSourceRelativePath(root,path.join(alias,'plots/mesh.glb')),'plots/mesh.glb','realpath root accepts the symlinked spelling of an in-project file');
 for(const input of [path.join(alias,'../project-other/mesh.glb'),path.join(sibling,'mesh.glb')]) await assert.rejects(()=>projectSourceRelativePath(alias,input),/escapes/);
 await symlink(sibling,path.join(root,'linked-dir'));await assert.rejects(()=>projectSourceRelativePath(alias,path.join(root,'linked-dir/mesh.glb')),/escapes/);
 await assert.rejects(()=>projectSourceRelativePath(root,path.join(root,'linked-dir/mesh.glb')),/symlink escapes/);
 h.ok(true,'alias resolution keeps lexical, sibling and symlinked-directory escapes refused');
 const verb=VERBS.find(v=>v.cli==='add-slide-model')!,handler=verb.handler,render=verb.render,cwd=process.cwd();
 try {
  verb.handler=async(ctx,args)=>({relative:await projectSourceRelativePath(ctx.root,String(args.sourcePath))});verb.render=undefined;
  process.chdir(await realpath(root));let output='',error='',exit=0;const pos=['deck','slide','plots/mesh.glb'];
  await runCliVerb(verb.cli,{pos,posRooted:pos,flags:{root:alias},rootFlags:alias,rootPositional:alias},{log:s=>{output=s;},err:s=>{error=s;},setExit:code=>{exit=code;}});
  assert.equal(exit,0,error);h.eq(JSON.parse(output),{relative:'plots/mesh.glb'},'CLI: --root through a symlink with a realpath cwd accepts the project-relative spelling');
 } finally {process.chdir(cwd);verb.handler=handler;verb.render=render;}
} finally {await rm(scratch,{recursive:true,force:true});}
h.done();
