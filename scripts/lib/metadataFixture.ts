import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {buildScaffoldTree} from '../../src/lib/project/scaffoldTree';
import {executeFigSave,planFigSave} from '../../src/lib/project/figfiles';
import {createDeck} from '../../src/lib/slide/ops';
import {makeText} from '../../src/lib/ops';
import type {Project} from '../../src/lib/types';
const [root]=process.argv.slice(2);
if(!root)throw Error('Disposable project directory required');
const write=async(rel:string,text:string)=>{const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text)};
const tree=buildScaffoldTree({title:'Metadata verification'},createDeck({id:'meta-deck',title:'Untouched deck',withTitleSlide:true}));
for(const dir of tree.dirs)await fs.mkdir(path.join(root,dir),{recursive:true});
for(const [rel,text]of tree.files)await write(rel,text);
const model:Project={version:2,name:'Metadata',canvases:[{id:'c',name:'Canvas'},{id:'other',name:'Other canvas'}],assets:[],palette:[],figures:['c','other'].map((canvasId,i)=>({
 id:`meta-${i}`,canvasId,referenceKey:`fig-meta-${i}`,name:`Figure ${i+1}`,nickname:`Original ${i}`,family:'figure',number:i+1,x:0,y:0,width:600,height:300,background:'#ffffff',elements:[{...makeText('a',{x:20,y:20,width:30,height:30},{},true),id:`label-${i}`}],captions:{__figure__:`Lead ${i}`,[`label-${i}`]:`Panel ${i}`,orphan:'Keep orphan'}
}))};
await executeFigSave(planFigSave(model,null),{read:async rel=>fs.readFile(path.join(root,rel),'utf8').catch(()=>null),write});
await write('manuscript/main.qmd','---\ntitle: Metadata verification\n---\n\n# Disposable metadata test\n');

await write('.meta/feedback.ndjson','');
