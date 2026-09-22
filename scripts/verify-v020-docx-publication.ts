import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { compile, scaffold, mutateFigModel } from '../flux-core/index';
import { createFigure } from '../src/lib/ops';
import { DOMParser } from '@xmldom/xmldom';
import { postprocessDocx, validateDocx } from '../src/lib/references/docxArtifact';
import { harness } from './lib/harness.mjs';
const h = harness('verify-v020-docx-publication');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-docx-publication-'));
const oldPath = process.env.PATH;
try {
  await scaffold(root, { title: 'Artifact validation' });
  await fs.mkdir(path.join(root,'manuscript'),{recursive:true});
  // A is the actual main document, while --doc selects B. Neither figure has
  // a pre-rendered SVG: the chosen-document compiler must materialize its own.
  const manifest = JSON.parse(await fs.readFile(path.join(root,'project.json'),'utf8'));
  manifest.manuscript.path = 'manuscript/main.qmd';
  await fs.writeFile(path.join(root,'project.json'),JSON.stringify(manifest,null,2));
  await mutateFigModel(root,'seed_chosen_document_figures',({project}) => {
    const canvasId = project.canvases[0].id;
    for (const [id, background] of [['doc-a-figure','#c73147'],['doc-b-figure','#168a63']]) {
      const figure = createFigure(project,{id,canvasId,width:160,height:100,background});
      figure.referenceKey = `fig-${id}`;
    }
  });
  const document = (name: string) => `---\ntitle: Document ${name}\nformat:\n  html:\n    embed-resources: true\n---\n\nDOC_${name}_ONLY\n\n![Document ${name} figure](../fig/renders/doc-${name.toLowerCase()}-figure.svg){#fig-doc-${name.toLowerCase()}-figure}\n`;
  const a = document('A'), b = document('B');
  const chosenRender = path.join(root,'fig/renders/doc-b-figure.svg');
  const mainRender = path.join(root,'fig/renders/doc-a-figure.svg');
  const isChosenFigure = (svg: string) => svg.includes('#168a63') && !svg.includes('#c73147');
  await fs.writeFile(path.join(root,'manuscript/main.qmd'),a);
  await fs.writeFile(path.join(root,'manuscript/chosen.qmd'),b);
  if (spawnSync('quarto',['--version']).status !== 0) throw new Error('This artifact gate requires Quarto');
  const result = await compile(root,'docx',{doc:'manuscript/chosen.qmd'});
  h.eq(result.code,0,'real Quarto chosen-document DOCX succeeds');
  const output = result.output!;
  const bytes = new Uint8Array(await fs.readFile(output));
  validateDocx(bytes);
  const packageParts = unzipSync(bytes);
  const xml = strFromU8(packageParts['word/document.xml']);
  h.ok(xml.includes('DOC_B_ONLY')&&!xml.includes('DOC_A_ONLY'),'saved DOCX contains selected document B only');
  h.ok(isChosenFigure(await fs.readFile(chosenRender,'utf8')),'DOCX compile materializes the chosen figure with its authored color');
  h.ok(!(await fs.access(mainRender).then(()=>true,()=>false)),'DOCX compile does not materialize the main document figure');
  const parser = new DOMParser();
  const relationships = parser.parseFromString(strFromU8(packageParts['word/_rels/document.xml.rels']),'application/xml').getElementsByTagName('Relationship');
  const referencedIds = new Set([...xml.matchAll(/\br:embed="([^"]+)"/g)].map(match=>match[1]));
  const usedImageParts: string[] = [];
  for (let i=0;i<relationships.length;i++) {
    const relation = relationships.item(i)!;
    if (referencedIds.has(relation.getAttribute('Id')!) && relation.getAttribute('Type')?.endsWith('/image'))
      usedImageParts.push(path.posix.normalize(path.posix.join('word',relation.getAttribute('Target')!)));
  }
  const usedSvgs = usedImageParts.filter(name=>name.endsWith('.svg'));
  const usedPngs = usedImageParts.filter(name=>name.endsWith('.png'));
  h.ok(usedSvgs.length===1&&isChosenFigure(strFromU8(packageParts[usedSvgs[0]])),'DOCX drawing references the chosen SVG bytes, not the main figure');
  h.ok(usedPngs.length===1&&Buffer.from(packageParts[usedPngs[0]]).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'DOCX drawing also references an actual PNG fallback');
  h.eq(await fs.readFile(path.join(root,'manuscript/chosen.qmd'),'utf8'),b,'authoring source is byte-identical after real Quarto');
  await fs.rm(chosenRender); // HTML must materialize afresh, not reuse DOCX's render.
  const html = await compile(root,'html',{doc:'manuscript/chosen.qmd'});
  if(html.code!==0||!html.output) throw new Error(html.log);
  const htmlBytes = await fs.readFile(html.output!,'utf8');
  h.ok(html.code===0&&htmlBytes.includes('DOC_B_ONLY')&&!htmlBytes.includes('DOC_A_ONLY'),'real HTML chosen document bytes match');
  const htmlSvgs = [...htmlBytes.matchAll(/src="data:image\/svg\+xml;base64,([^"\s]+)"/g)].map(match=>Buffer.from(match[1],'base64').toString('utf8'));
  h.ok(htmlSvgs.length===1&&isChosenFigure(htmlSvgs[0]),'saved self-contained HTML embeds the chosen SVG bytes');
  h.ok(isChosenFigure(await fs.readFile(chosenRender,'utf8'))&&!(await fs.access(mainRender).then(()=>true,()=>false)),'HTML freshly materializes only the chosen document figure');
  h.eq(await fs.readFile(path.join(root,'manuscript/main.qmd'),'utf8'),a,'unselected main document remains byte-identical');
  const bin = path.join(root,'fault-bin'); await fs.mkdir(bin);
  const faultBody = `const fs=require('node:fs'),p=require('node:path'); const args=process.argv.slice(2), output=args[args.indexOf('--output')+1], target=p.join(p.dirname(args[1]),output);fs.writeFileSync(target,'corrupt artifact');console.log('Output created: '+output);\n`;
  // Windows runs no shebang and resolves a bare name through PATHEXT, so the
  // fault quarto is a .cmd launching node over the same body. An extensionless
  // script there is simply never found, and the corrupt artifact never appears.
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(bin,'quarto-fault.js'),faultBody);
    await fs.writeFile(path.join(bin,"quarto.cmd"),`@"${process.execPath}" "%~dp0quarto-fault.js" %*\r\n`);
  } else await fs.writeFile(path.join(bin,'quarto'),`#!/usr/bin/env node\n${faultBody}`,{mode:0o755});
  // execResolve deliberately prefers a real .exe in ANY PATH dir over an earlier
  // batch shim, so prepending the fault bin would still run the installed
  // quarto.exe: on win32 the fault bin has to BE the whole PATH.
  process.env.PATH = process.platform === 'win32' ? bin : `${bin}${path.delimiter}${oldPath}`;
  let refused=false;try{await compile(root,'docx',{doc:'manuscript/chosen.qmd'});}catch{refused=true;}
  h.ok(refused,'corrupt zero-exit DOCX is rejected');
  h.ok(Buffer.from(await fs.readFile(output)).equals(Buffer.from(bytes)),'corrupt result preserves last good artifact bytes');
  h.eq(await fs.readFile(path.join(root,'manuscript/chosen.qmd'),'utf8'),b,'source remains original after failed output validation');
  h.ok(!(await fs.readdir(path.join(root,'manuscript'))).some(n=>n.startsWith('.flux-export-')),'owned temporary artifacts removed after failure');
  const parts=unzipSync(bytes); parts['word/document.xml']=strToU8(strFromU8(parts['word/document.xml']).replace('DOC_B_ONLY','⟦ZC{key}⟧DOC_B_ONLY⟦ZE⟧'));
  const fallback=await postprocessDocx(zipSync(parts),{rasterize:async()=>{throw new Error('unused');},inject:async()=>{throw new Error('fault injection');}});
  h.ok(fallback.warnings.length===1&&!strFromU8(unzipSync(fallback.bytes)['word/document.xml']).includes('⟦Z'),'Zotero failure publishes validated marker-free plain-reference bytes and warning');
} finally {process.env.PATH=oldPath;await fs.rm(root,{recursive:true,force:true});}
await h.done();
