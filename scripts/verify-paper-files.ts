// Real-file coverage for the new scaffold, recursive discovery, relocation,
// collision/rollback preservation, Context policy and no required main filename.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildScaffoldTree } from '../src/lib/project/scaffoldTree';
import { createDeck } from '../src/lib/slide/ops';
import { discoverDocuments, moveDocumentFile, relocateDocumentLinks, type DocumentIO } from '../src/lib/project/documentFiles';
import { commentsMainPath, commentsSidecarRel } from '../src/lib/project/docOrder';
import { createDocument, createFolder, listDocuments, moveDocument, deleteDocument, getManuscript } from '../flux-core/manuscript';
import { listDocumentTree } from '../src/shell/modes/paper/documents/documents';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { atomicWrite } from '../flux-core/fsx';
import { harness } from './lib/harness.mjs';
const h = harness('verify-paper-files');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-paper-files-'));
const io: DocumentIO = {
  create: (r,t) => atomicWrite(path.join(root,r),t,true),
  exists: async r => fs.access(path.join(root,r)).then(()=>true,()=>false),
  read: r => fs.readFile(path.join(root,r),'utf8'),
  write: async (r,t) => { await fs.mkdir(path.dirname(path.join(root,r)),{recursive:true}); await fs.writeFile(path.join(root,r),t); },
  mkdir: async r => { await fs.mkdir(path.join(root,r),{recursive:true}); },
  entries: async r => (await fs.readdir(path.join(root,r),{withFileTypes:true})).map(e=>({name:e.name,dir:e.isDirectory()})),
  remove: r => fs.rm(path.join(root,r),{force:true}),
};
try {
  const links = relocateDocumentLinks('---\nbibliography: ["../references/one.bib", ../references/two.bib]\ncss:\n  - ../styles/paper.css\nformat:\n  docx:\n    reference-doc: "../styles/my template.docx"\n---\n\n[go](old.qmd?view=1#section)\n', 'paper/notes.qmd', 'paper/deep/notes.qmd');
  h.ok(links.includes('"../../references/one.bib", ../../references/two.bib') && links.includes('- ../../styles/paper.css') && links.includes('"../../styles/my template.docx"'),'YAML path arrays, nested fields and quoted spaces survive relocation');
  h.ok(links.includes('(../old.qmd?view=1#section)'),'query and fragment survive together');
  h.eq(relocateDocumentLinks('[methods](Experiments/Week%201/methods.qmd)', 'paper/notes.qmd', 'paper/notes.qmd', 'paper/Experiments/Week 1/methods.qmd','paper/Empty/methods.qmd'), '[methods](Empty/methods.qmd)','incoming percent-encoded document link follows the move');
  h.eq(relocateDocumentLinks('{{< include "Experiments/Week 1/methods.qmd" >}}','paper/notes.qmd','paper/notes.qmd','paper/Experiments/Week 1/methods.qmd','paper/Empty/methods.qmd'), '{{< include "Empty/methods.qmd" >}}','quoted incoming Quarto includes follow the move');
  // Execute the actual Electron file handler against a disposable filesystem.
  const { createFileCore } = createRequire(import.meta.url)('../electron/ipc/files.cjs');
  const handlers = new Map<string, Function>();
  const native = createFileCore({ app: { getPath: () => root }, roots: () => [root] });
  native.registerHandlers({ handle: (name: string, handler: Function) => handlers.set(name,handler) });
  const writeNative = handlers.get('fs:writeText')!;
  const event = { sender: { id: 1 } };
  await writeNative(event, path.join(root,'native-create.txt'),'first',{createOnly:true});
  let nativeRefused=false;
  try { await writeNative(event,path.join(root,'native-create.txt'),'second',{createOnly:true}); } catch { nativeRefused=true; }
  h.ok(nativeRefused && await io.read('native-create.txt')==='first','native Electron create-only IPC refuses replacement');
  await writeNative(event,path.join(root,'native-create.txt'),'ordinary write');
  h.eq(await io.read('native-create.txt'),'ordinary write','ordinary native saves retain their existing replacement behavior');
  await io.remove('native-create.txt');
  const tree = buildScaffoldTree({title:'Research notes'}, createDeck({title:'Talk'}));
  for (const dir of tree.dirs) await io.mkdir(dir);
  for (const [rel,text] of tree.files) await io.write(rel,text);
  let m = tree.manifest;
  h.eq(m.documentRoot,'paper','new project uses paper/');
  const cli = (args: string[]) => execFileSync(process.execPath,['--import','tsx',path.resolve('flux-cli.ts'),...args,'--root',root],{encoding:'utf8'});
  cli(['new-doc-folder','paper','CLI folder']);
  cli(['new-doc','CLI notes','--folder','paper/CLI folder']);
  cli(['move-doc','paper/CLI folder/cli-notes.qmd','paper']);
  h.ok(await io.exists('paper/cli-notes.qmd') && !await io.exists('paper/CLI folder/cli-notes.qmd'),'CLI folder creation, folder selection and move arguments execute');

  h.ok(await io.exists('paper/notes.qmd') && !await io.exists('manuscript/main.qmd'),'no main.qmd or legacy manuscript is created');
  h.ok((await listDocuments(root)).every(d=>!d.isMain),'new documents have no protected main role');
  await createFolder(root,'paper','Experiments');
  await createFolder(root,'paper/Experiments','Week 1');
  await createFolder(root,'paper','Empty');
  const created = await createDocument(root,'Methods','paper/Experiments/Week 1');
  h.eq(created.path,'paper/Experiments/Week 1/methods.qmd','documents can be created several folders deep');
  h.ok((await io.read(created.path)).includes('../../../references/library.bib'),'nested creation uses the correct relative bibliography');
  await io.write('manuscript/legacy/deep/old.md','# Old notes\n');
  await io.write('Context/Reading/analysis.md','# Analysis\n');
  await io.write('Context/Transcripts/ignore.md','not a document');
  await io.write('paper/a.sync-conflict-20260101-120000-ABCDEFG.qmd','not a document');
  const listing = await listDocuments(root);
  h.ok(listing.some(d=>d.path==='manuscript/legacy/deep/old.md'),'legacy manuscript tree remains discoverable alongside paper');
  h.ok(listing.some(d=>d.path==='Context/Reading/analysis.md'),'custom Context descendants are discoverable');
  h.ok(!listing.some(d=>/ignore|sync-conflict/.test(d.path)),'archives and conflict copies stay out');
  m = JSON.parse(await io.read('project.json'));
  const scan = await discoverDocuments(m,io);
  h.ok(scan.folders.includes('paper/Empty'),'empty folders survive scans');
  const original = '---\ntitle: Methods\nbibliography: ../../../references/library.bib\n---\n\n![data](../../../plots/data.svg)\n\n{{< include ../../../paper/notes.qmd >}}\n\n[web](https://example.org/a)\n\n```md\n![literal](../../../plots/data.svg)\n```\n';
  await io.write(created.path,original);
  await io.write('paper/notes.qmd','[methods](Experiments/Week%201/methods.qmd)\n\n{{< include Experiments/Week 1/methods.qmd >}}\n');
  await io.write('Context/Reading/analysis.md','[methods](../../paper/Experiments/Week 1/methods.qmd)\n');
  const side = commentsSidecarRel(commentsMainPath(m),created.path);
  const comments = JSON.stringify({version:1,threads:[{id:'review-1',anchor:{exact:'data'},messages:[]}]});
  await io.write(side,comments);
  const result = await moveDocument(root,created.path,'paper/Empty');
  h.eq(result.path,'paper/Empty/methods.qmd','move returns the new path');
  h.ok(!await io.exists(created.path),'source document is removed');
  const moved = await io.read(result.path);
  h.ok(moved.includes('bibliography: ../../references/library.bib') && moved.includes('![data](../../plots/data.svg)'),'relative bibliography and image links keep their targets');
  h.ok(moved.includes('{{< include ../notes.qmd >}}'),'relative Quarto include keeps its target');
  h.ok(moved.includes('![literal](../../../plots/data.svg)') && moved.includes('https://example.org/a'),'code examples and remote URLs stay intact');
  h.eq(await io.read('paper/Empty/methods.comments.json'),comments,'review sidecar moves byte for byte');
  h.ok(!await io.exists(side),'old sidecar is removed');
  m = JSON.parse(await io.read('project.json'));
  h.ok(m.supplementary.some(s=>s.path===result.path),'manifest follows the move');
  await io.write('paper/methods.qmd','collision');
  const before = await io.read(result.path);
  let rejected = false;
  try { await moveDocument(root,result.path,'paper'); } catch { rejected = true; }
  h.ok(rejected && await io.read('paper/methods.qmd')==='collision' && await io.read(result.path)===before,'collision refuses without overwriting either document');
  await io.mkdir('paper/Rollback');
  const manifestBefore = await io.read('project.json');
  let failOnce = true;
  try { await moveDocumentFile(m,{...io,write:async(r,t)=>{ if(r==='project.json' && failOnce){failOnce=false;throw new Error('injected disk failure');} await io.write(r,t); }},result.path,'paper/Rollback'); } catch {}
  h.ok(await io.read(result.path)===before && !await io.exists('paper/Rollback/methods.qmd'),'failed manifest write restores files without losing the original');
  h.eq(await io.read('project.json'),manifestBefore,'failed move leaves manifest unchanged');
  let raced=false;
  try { await moveDocumentFile(m,{...io,create:async(r,t)=>{ if(r==='paper/Rollback/methods.qmd') { await io.write(r,'concurrent creator'); raced=true; } await io.create(r,t); }},result.path,'paper/Rollback'); } catch {}
  h.ok(raced && await io.read('paper/Rollback/methods.qmd')==='concurrent creator' && await io.read(result.path)===before,'destination created during the move is never overwritten or deleted by rollback');

  for(const bad of ['../escape','paper/../escape','Context/Transcripts','paper/hidden/../../escape']) {
    let failed=false;try{await createFolder(root,bad,'new');}catch{failed=true;}h.ok(failed,`unsafe or reserved destination refused: ${bad}`);
  }
  await deleteDocument(root,'Context/Reading/analysis.md');
  h.ok(!await io.exists('Context/Reading/analysis.md'),'custom Context documents are deletable');
  let protectedStock=false;try{await deleteDocument(root,'Context/NOTEBOOK.md');}catch{protectedStock=true;}
  h.ok(protectedStock,'standard Context files remain protected');
  await deleteDocument(root,'paper/notes.qmd');
  h.ok(!await io.exists('paper/notes.qmd'),'starter notes are deletable');
  for (const d of await listDocuments(root)) if (!d.isContext) await deleteDocument(root,d.path);
  h.eq(JSON.parse(await io.read('project.json')).manuscript.path,'','last document deletion clears the default pointer');
  let noDefault=false;try{await getManuscript(root);}catch(e){noDefault=String(e).includes('no default document');}
  h.ok(noDefault,'headless default read explains that no document exists');
  const fresh=await createDocument(root,'New beginning');
  h.eq(JSON.parse(await io.read('project.json')).manuscript.path,fresh.path,'creating a document after deleting all restores the default');
  // Actual GUI adapter and Node engine read identical filesystem state.
  (globalThis as any).window={fig:{ exists:(p:string)=>io.exists(path.relative(root,p)), readText:(p:string)=>io.read(path.relative(root,p)), readdir:(p:string)=>io.entries(path.relative(root,p)) }};
  const gui=await listDocumentTree({root,manifest:JSON.parse(await io.read('project.json'))});
  h.eq(gui.docs,await listDocuments(root),'GUI and headless discovery produce identical entries');
} finally { await fs.rm(root,{recursive:true,force:true}); }
await h.done();
