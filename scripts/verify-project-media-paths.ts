import { harness } from './lib/harness.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectSourceRelativePath } from '../flux-core/projectSource';
const h=harness('verify-project-media-paths');
const scratch=await mkdtemp(path.join(os.tmpdir(),'flux-media-path-')),root=path.join(scratch,'project'),sibling=path.join(scratch,'project-other');
try {
 await mkdir(root);await mkdir(sibling);await mkdir(path.join(root,'plots'));
 for(const ext of ['mp4','glb']) {
  const relative=`plots/mesh.${ext}`,absolute=path.join(root,relative);await writeFile(absolute,'fixture');
  h.eq(await projectSourceRelativePath(root,relative),relative,`${ext}: relative input stays relative`);
  h.eq(await projectSourceRelativePath(root,absolute),relative,`${ext}: resolved CLI/MCP input canonicalizes once`);
  await writeFile(path.join(sibling,`mesh.${ext}`),'outside');
  for(const input of [`../project-other/mesh.${ext}`,path.join(sibling,`mesh.${ext}`),'/',root,`plots\\mesh.${ext}`,`plots/mesh.${ext}\0`]) await assert.rejects(()=>projectSourceRelativePath(root,input));
  await symlink(path.join(sibling,`mesh.${ext}`),path.join(root,`escape.${ext}`));
  await assert.rejects(()=>projectSourceRelativePath(root,`escape.${ext}`),/symlink escapes/);
  h.ok(true,`${ext}: lexical, prefix sibling, NUL, root and symlink escapes refused`);
 }
} finally {await rm(scratch,{recursive:true,force:true});}
h.done();
