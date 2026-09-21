import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteDocumentFile, type DocumentIO } from "../src/lib/project/documentFiles";
import { applyManifestIntent } from '../src/lib/project/manifestTransaction';
const root = await fs.mkdtemp(path.join(os.tmpdir(),'flux-manifest-'));
// Direct invocation must be as isolated as the aggregate runner before core imports.
process.env.HOME=path.join(root,'home');process.env.USERPROFILE=process.env.HOME;process.env.XDG_CONFIG_HOME=path.join(root,'config');process.env.APPDATA=process.env.XDG_CONFIG_HOME;process.env.FLUX_NO_MIGRATE='1';delete process.env.FLUX_LIB;
await fs.mkdir(process.env.HOME,{recursive:true});await fs.mkdir(process.env.XDG_CONFIG_HOME,{recursive:true});
const { scaffold }=await import('../flux-core/figures');
const { updateManifest }=await import('../flux-core/manifest');
const { loadManifest }=await import('../flux-core/model');
const { createDocument, deleteDocument }=await import('../flux-core/manuscript');
try {
  await scaffold(root,{title:'Original'});
  const file=path.join(root,'project.json');
  await Promise.all([
    updateManifest(root,m=>{m.slides=[{id:'B',path:'slides/B/deck.json',title:'B'}];}),
    updateManifest(root,m=>{m.documentOrder=['paper/notes.qmd']; (m as unknown as Record<string,unknown>).custom={scientific:'preserved'};})
  ]);
  let m=await loadManifest(root); assert.equal(m.slides?.[0].id,'B'); assert.equal(m.documentOrder?.[0],'paper/notes.qmd');
  const doc=await createDocument(root,'Supplement');
  m=await loadManifest(root); assert.equal(m.slides?.[0].id,'B'); assert.deepEqual((m as unknown as Record<string,unknown>).custom,{scientific:'preserved'}); assert.ok(m.supplementary?.some(d=>d.path===doc.path));
  const authored='---\ntitle: "Supplement"\n---\nExact αβ scientific bytes.\n';
  await fs.writeFile(path.join(root,doc.path),authored);
  const beforeDelete=await fs.readFile(file,'utf8');
  const io:DocumentIO={exists:async rel=>!!(await fs.stat(path.join(root,rel)).catch(()=>null)),read:rel=>fs.readFile(path.join(root,rel),'utf8'),
    create:(rel,text)=>fs.writeFile(path.join(root,rel),text,{flag:'wx'}),write:async(rel,text)=>{if(rel==='project.json')throw new Error('ENOSPC publish');await fs.writeFile(path.join(root,rel),text);},
    mkdir:async rel=>{await fs.mkdir(path.join(root,rel),{recursive:true});},entries:async rel=>(await fs.readdir(path.join(root,rel),{withFileTypes:true})).map(e=>({name:e.name,dir:e.isDirectory()})),remove:rel=>fs.rm(path.join(root,rel))};
  await assert.rejects(deleteDocumentFile(await loadManifest(root),io,doc.path),/document files restored.*Recovery:.*ENOSPC/);
  assert.equal(await fs.readFile(path.join(root,doc.path),'utf8'),authored);assert.equal(await fs.readFile(file,'utf8'),beforeDelete);
  const recoveryFiles=await fs.readdir(path.join(root,'.meta/document-recovery'));
  const recovery=JSON.parse(await fs.readFile(path.join(root,'.meta/document-recovery',recoveryFiles[0]),'utf8'));
  assert.equal(recovery.files[doc.path],authored);assert.equal(recovery.files['project.json'],beforeDelete);
  await deleteDocument(root,doc.path);assert.equal(await fs.stat(path.join(root,doc.path)).catch(()=>null),null);
  assert.equal((await loadManifest(root)).slides?.[0].id,'B');
  const good=await fs.readFile(file,'utf8');
  for(const bytes of ['{broken',JSON.stringify({...m,schemaVersion:'99.0.0'})]) {
    await fs.writeFile(file,bytes);
    await assert.rejects(updateManifest(root,m=>{m.title='unsafe';}));
    assert.equal(await fs.readFile(file,'utf8'),bytes);
  }
  await fs.writeFile(file,good);
  let writes=0;
  await assert.rejects(applyManifestIntent({read:async()=>good,write:async()=>{writes++;throw new Error('ENOSPC');}}, m=>{m.title='pending';}),/ENOSPC/);
  assert.equal(writes,1); assert.equal(await fs.readFile(file,'utf8'),good);
  const other=path.join(root,'other'); await scaffold(other,{title:'Other'});
  await Promise.all([updateManifest(root,m=>{m.title='A';}),updateManifest(other,m=>{m.title='B';})]);
  assert.equal((await loadManifest(root)).title,'A'); assert.equal((await loadManifest(other)).title,'B');
  // Renderer mutations use the same manuscript→manifest order; every file
  // publication verifies both leases rather than relying on end-of-call checks.
  const active=new Map<string,string>(),order:string[]=[];
  const bridge={
    exists:async(file:string)=>!!(await fs.stat(file).catch(()=>null)),readText:(file:string)=>fs.readFile(file,'utf8'),
    writeText:async(file:string,text:string,options?:{createOnly?:boolean})=>{assert.ok(active.has('manuscript')&&active.has('manifest'));await fs.writeFile(file,text,{flag:options?.createOnly?'wx':'w'});},
    mkdir:async(file:string)=>{await fs.mkdir(file,{recursive:true});},
    readdir:async(file:string)=>(await fs.readdir(file,{withFileTypes:true})).map(e=>({name:e.name,dir:e.isDirectory()})),
    remove:async(file:string)=>{assert.ok(active.has('manuscript')&&active.has('manifest'));await fs.rm(file);},
    lockAcquire:async(_scope:string,name:string,expectedRoot:string)=>{assert.equal(expectedRoot,root);assert.equal(active.has(name),false);order.push(name);const token=`${name}-${order.length}`;active.set(name,token);return {ok:true,token};},
    lockCheck:async(_scope:string,name:string,token:string)=>{assert.equal(active.get(name),token);return true;},
    lockRelease:async(_scope:string,name:string,token:string)=>{assert.equal(active.get(name),token);active.delete(name);return true;},
  };
  Object.assign(globalThis,{window:{fig:bridge}});
  const gui=await import('../src/shell/modes/paper/documents/documents');
  const loaded={root,manifest:await loadManifest(root)};
  const created=await gui.createDocument(loaded,'Renderer saved document');
  assert.deepEqual(order,['manuscript','manifest']);assert.equal(active.size,0);assert.ok(await bridge.exists(path.join(root,created)));
  await gui.deleteDocument(loaded,await gui.listDocuments(loaded),created);
  assert.deepEqual(order,['manuscript','manifest','manuscript','manifest']);assert.equal(active.size,0);assert.equal(await bridge.exists(path.join(root,created)),false);
  console.log('manifest fresh-intent concurrency, creation, unknown metadata, corruption/forward, I/O failure and root isolation PASS');
} finally {await fs.rm(root,{recursive:true,force:true});}
