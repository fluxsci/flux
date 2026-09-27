import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { harness } from './lib/harness.mjs';
import { composeCaption, splitCaption, captionBlocks, panelLetters, POSTSCRIPT_CAPTION as PS } from '../src/lib/captions';
import { reconcileFigureCaption } from '../src/lib/project/captionReconcile';
import { applyMetadataChange, reverseMetadataChange, type MetadataChange } from '../src/lib/figure/metadata';
import { makeText } from '../src/lib/ops';
import { buildScaffoldTree } from '../src/lib/project/scaffoldTree';
import { createDeck } from '../src/lib/slide/ops';
import { planFigSave, executeFigSave } from '../src/lib/project/figfiles';
import { setCaption } from '../flux-core/figures';
import { loadFigModel } from '../flux-core/model';
import type { Project } from '../src/lib/types';
const h=harness('verify-caption-postscript');
const fig={id:'f',canvasId:'c',name:'Figure 1',referenceKey:'fig-f',family:'figure',number:1,x:0,y:0,width:500,height:700,background:'#ffffff',elements:[{...makeText('a',{x:0,y:0,width:20,height:20},{},true),id:'a'},{...makeText('f',{x:0,y:50,width:20,height:20},{},true),id:'f-label'}],captions:{__figure__:'Lead.','a':'First panel.','f-label':'Final panel.',[PS]:'Closing sentence.',orphan:'Keep me.'}};
const p:Project={version:2,name:'PS',canvases:[{id:'c',name:'Canvas'}],figures:[fig],assets:[],palette:[]};
const composed='Lead. **a**, First panel. **f**, Final panel. Closing sentence.';
assert.equal(composeCaption(fig),composed);assert.deepEqual(panelLetters(fig),['a','f']);assert.equal(captionBlocks(fig).at(-1)?.id,PS);
h.ok(true,'closing prose is last and carries no label or reference');
const changed=structuredClone(fig);changed.elements[1].text='b';assert.equal(composeCaption(changed),'Lead. **a**, First panel. **b**, Final panel. Closing sentence.');changed.elements=[];assert.equal(composeCaption(changed),'Lead. Closing sentence.');changed.captions.__figure__='';assert.equal(composeCaption(changed),'Closing sentence.');h.ok(true,'postscript survives panel relabel/removal and works without panels or lead');
assert.equal(composeCaption({...fig,captions:splitCaption(fig,composed)!}),composed);assert.equal(splitCaption(fig,composed)?.[PS],'Closing sentence.');assert.deepEqual(splitCaption({...fig,elements:[]},'Lead. Closing sentence.'),{__figure__:'Lead.',[PS]:'Closing sentence.'});h.ok(true,'known plain-text suffix round-trips without adding a marker');
for(const text of ['New lead. **a**, First panel. **f**, Final panel. Closing sentence.','Lead. **a**, First panel. **f**, Final panel. Changed ending.','Replacement prose.']){
 const copy=structuredClone(fig);assert.equal(reconcileFigureCaption(copy,text,composed),'imported');assert.equal(composeCaption(copy),text);assert.equal(copy.captions.orphan,'Keep me.');
}
h.ok(true,'external edits preserve exact prose and never duplicate an old closing block');
const copy=structuredClone(fig);copy.captions[PS]='Local edit.';assert.equal(reconcileFigureCaption(copy,'External edit.',composed),'conflict');assert.equal(copy.captions[PS],'Local edit.');h.ok(true,'concurrent postscript edits retain the caption conflict guard');
const edit:MetadataChange={kind:'caption',figureId:'f',key:PS,before:'Closing sentence.',after:'Revised ending.'};applyMetadataChange(p,edit);assert.equal(composeCaption(fig),composed.replace('Closing sentence.','Revised ending.'));applyMetadataChange(p,reverseMetadataChange(edit));assert.equal(composeCaption(fig),composed);h.ok(true,'metadata edits and undo use the same reserved postscript field');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-ps-'));
try{
 const tree=buildScaffoldTree({title:'Postscript'},createDeck({id:'test',title:'Test'}));
 const write=async(rel:string,value:string)=>{const f=path.join(root,rel);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,value)};
 for(const dir of tree.dirs)await fs.mkdir(path.join(root,dir),{recursive:true});for(const [rel,value] of tree.files)await write(rel,value);
 await executeFigSave(planFigSave(p,null),{read:async rel=>fs.readFile(path.join(root,rel),'utf8').catch(()=>null),write});
 await setCaption(root,'f','Agent ending.',{panel:'ps'});
 const disk=await loadFigModel(root);assert.equal(disk.project.figures[0].captions?.[PS],'Agent ending.');assert.equal(await fs.readFile(path.join(root,'fig/captions/f.md'),'utf8'),composed.replace('Closing sentence.','Agent ending.')+'\n');h.ok(true,'headless single-block edits persist canonical JSON and identical readable Markdown');
 await setCaption(root,'f',composed.replace('Closing sentence.','Agent ending.').replace('Lead.','Revised.'));const again=await loadFigModel(root);assert.equal(again.project.figures[0].captions?.[PS],'Agent ending.');
 await setCaption(root,'f','Whole replacement.');const final=await loadFigModel(root);assert.ok(!final.project.figures[0].captions?.[PS]);assert.ok(!composeCaption(final.project.figures[0]).includes('Agent ending.'));h.ok(true,'headless whole-caption replacement retains a known suffix or clears an obsolete one');
}finally{await fs.rm(root,{recursive:true,force:true})}
await h.done();
