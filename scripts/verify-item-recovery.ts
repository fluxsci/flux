import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writePdf, writeLinkedPdf, writeFulltext, readFulltext, recoverPdfItem, readSource, pdfBytesIdentity } from '../flux-core/items';
import { harness } from './lib/harness.mjs';
const h=harness('verify-item-recovery'),root=fs.mkdtempSync(path.join(os.tmpdir(),'flux-item-recovery-'));
const dir=path.join(root,'items','paper'),A=Buffer.from('%PDF-A prior scientific bytes'),B=Buffer.from('%PDF-B new scanned scientific bytes');
const digest=(b:Buffer)=>crypto.createHash('sha256').update(b).digest('hex');
const proposed={key:'paper',source:'ingest',fetchedAt:'2026-09-21T00:00:00.000Z',sha256:digest(B),bytes:B.length};
const p=(name:string)=>path.join(dir,name),read=(name:string)=>fs.readFileSync(p(name),'utf8');
try {
 await writePdf('paper',A,{source:'ingest'},root);const oldSource=read('source.json');
 const annotations='{"version":1,"annotations":[],"future":"preserve exact user bytes"}\r\n';fs.writeFileSync(p('annotations.json'),annotations);
 await writeFulltext('paper','prior paper A scientific context',root,pdfBytesIdentity(A));
 fs.writeFileSync(p('source.pending.json'),JSON.stringify({version:1,source:proposed}));
 h.eq(await recoverPdfItem('paper',root),'rolled-back','interruption before PDF replacement resolves to proven prior generation');
 h.eq(fs.readFileSync(p('paper.pdf')),A,'rollback preserves exact prior PDF bytes');
 h.eq(read('source.json'),oldSource,'rollback preserves exact prior provenance bytes');
 h.eq(await readFulltext('paper',root),null,'rollback marks old extraction for rebuild instead of exposing ambiguous context');
 // Abruptly terminate an actual child immediately after the PDF rename in the real writer.
 const child=spawnSync(process.execPath,['--import','tsx','-e',`import('node:fs').then(async({default:fs})=>{const original=fs.promises.rename;fs.promises.rename=async(a,b)=>{await original(a,b);if(b===${JSON.stringify(p('paper.pdf'))})process.exit(86);};(await import('node:module')).syncBuiltinESMExports();const m=await import('./flux-core/items.ts');await(m.writePdf||m.default.writePdf)('paper',Buffer.from(${JSON.stringify(B.toString())}),{source:'ingest'},${JSON.stringify(root)});})`],{cwd:process.cwd(),env:{...process.env},encoding:'utf8',timeout:15000});
 assert.equal(child.status,86,child.stderr);
 h.eq(fs.readFileSync(p('paper.pdf')),B,'actual interrupted writer published exact new PDF bytes');
 h.eq(read('source.json'),oldSource,'actual interrupted writer has not replaced prior provenance');
 assert(fs.existsSync(p('source.pending.json')));
 h.eq(await readFulltext('paper',root),null,'ordinary read recovers interrupted child without returning old paper text');
 h.eq((await readSource('paper',root))?.sha256,digest(B),'read recovery commits only the proven current PDF provenance');
 h.eq(fs.readFileSync(p('paper.pdf')),B,'completion never rewrites the new PDF bytes');
 h.eq(read('annotations.json'),annotations,'both recovery directions retain exact annotation bytes');
 h.eq(await recoverPdfItem('paper',root),'none','completed recovery is idempotent with no remaining pending marker');
 // Deferred pointers recover from exact pointer bytes without reading external PDFs.
 const linkDir=path.join(root,'items','linked'),linkPath=path.join(linkDir,'paper.link.json');
 await writeLinkedPdf('linked',path.join(root,'external-old-missing.pdf'),root);
 const previousLink=fs.readFileSync(linkPath,'utf8'),previousSource=fs.readFileSync(path.join(linkDir,'source.json'),'utf8');
 const link={path:path.join(root,'external-new-missing.pdf'),linkedAt:'2026-09-21T00:00:00.000Z'};
 const linkedSource={key:'linked',source:'zotero-link',url:link.path,fetchedAt:link.linkedAt};
 const linkedPending=JSON.stringify({version:1,source:linkedSource,link,previousLink});
 fs.writeFileSync(path.join(linkDir,'source.pending.json'),linkedPending);
 h.eq(await recoverPdfItem('linked',root),'rolled-back','interrupted deferred link before pointer publication retains prior generation');
 h.eq([fs.readFileSync(linkPath,'utf8'),fs.readFileSync(path.join(linkDir,'source.json'),'utf8')],[previousLink,previousSource],'deferred rollback preserves exact pointer/provenance bytes');
 fs.writeFileSync(path.join(linkDir,'source.pending.json'),linkedPending);fs.writeFileSync(linkPath,JSON.stringify(link,null,2)+'\n');
 h.eq(await recoverPdfItem('linked',root),'completed','published deferred pointer completes provenance without reading its missing external PDF');
 h.eq((await readSource('linked',root))?.url,link.path,'deferred recovered source names the exact published pointer');
 // Recovery I/O failure remains retryable with all scientific bytes/receipt intact.
 fs.writeFileSync(p('source.json'),oldSource);fs.writeFileSync(p('source.pending.json'),JSON.stringify({version:1,source:proposed}));
 const originalRename=fs.promises.rename;
 fs.promises.rename=(async(a:any,b:any)=>{if(b===p('source.json'))throw Object.assign(new Error('fixture EACCES'),{code:'EACCES'});return originalRename(a,b);}) as typeof originalRename;
 syncBuiltinESMExports();
 try {await assert.rejects(()=>recoverPdfItem('paper',root),/EACCES/);}finally{fs.promises.rename=originalRename;syncBuiltinESMExports();}
 h.eq(read('source.json'),oldSource,'failed recovery preserves exact old provenance');
 h.eq(fs.readFileSync(p('paper.pdf')),B,'failed recovery preserves valid current PDF');
 h.ok(fs.existsSync(p('source.pending.json')),'failed recovery retains pending receipt');
 h.eq(await recoverPdfItem('paper',root),'completed','retry after failed recovery finishes deterministically');
 for(const [pending,pdf] of [['{invalid',B],[JSON.stringify({version:1,source:proposed}),Buffer.from('%PDF-C unknown replacement')]] as const){
  fs.writeFileSync(p('source.pending.json'),pending);fs.writeFileSync(p('paper.pdf'),pdf);const sourceBefore=read('source.json');
  await assert.rejects(()=>recoverPdfItem('paper',root),/Pending PDF generation/);
  h.eq(fs.readFileSync(p('paper.pdf')),pdf,'unrecognized generation never replaces scientific PDF bytes');
  h.eq([read('source.pending.json'),read('source.json')],[pending,sourceBefore],'corrupt/unknown recovery preserves exact receipt and provenance for explicit repair');
 }
} finally {fs.rmSync(root,{recursive:true,force:true});}
h.done();
