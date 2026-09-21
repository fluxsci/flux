import * as fs from 'node:fs/promises';
import path from 'node:path';
import {buildScaffoldTree} from '../../src/lib/project/scaffoldTree';
import {createDeck} from '../../src/lib/slide/ops';
import {planFigSave,executeFigSave} from '../../src/lib/project/figfiles';
import {stageFigureRegistration} from '../../src/lib/project/figureGeneration';
import type {GenerationWrite} from '../../src/lib/project/textGeneration';
import type {Project} from '../../src/lib/types';
const root=process.argv[2];if(!root)throw Error('Disposable fixture root required');
const tree=buildScaffoldTree({title:'Native Word recovery α'},createDeck({title:'Recovery'}));
for(const dir of tree.dirs)await fs.mkdir(path.join(root,dir),{recursive:true});
const write=async(rel:string,text:string)=>{await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.writeFile(path.join(root,rel),text);};
for(const [rel,text] of tree.files)await write(rel,text);
const figure:Project={version:2,name:'Export recovery',canvases:[{id:'kill-canvas',name:'Recovery'}],figures:[{id:'kill-figure',name:'Figure 1',referenceKey:'fig-kill',family:'figure',number:1,canvasId:'kill-canvas',x:0,y:0,width:240,height:120,background:'#ffffff',captions:{'__figure__':'Unicode α scientific caption; mean 3.25 ± 0.5.'},elements:[{id:'known-signal',type:'rect',x:20,y:20,width:200,height:80,rotation:0,fill:'#4385be',stroke:'none',strokeWidth:0,cornerRadius:0}]}],assets:[],palette:[]};
const io={read:async(rel:string)=>fs.readFile(path.join(root,rel),'utf8').catch(()=>null),write};
const plan=planFigSave(figure,null);if(!JSON.parse(plan.index.text).figures[0].caption.includes('3.25'))throw Error('Fixture must persist a real whole-figure scientific caption');await executeFigSave(plan,io);
const registration=new Map<string,GenerationWrite>();await stageFigureRegistration(io,JSON.parse(plan.index.text),registration);for(const [rel,text]of registration){if(typeof text!=='string')throw Error('Unexpected binary');await write(rel,text);}
const originals={
 'paper/notes.qmd':'---\r\ntitle: "Native Word recovery α"\r\n---\r\n\r\n# Results\r\n\r\nPrimary α CRLF. See @fig-kill.\r\n\r\n![](../fig/renders/kill-figure.svg){#fig-kill}\r\n\r\n{{< include included.qmd >}}\r\n',
 'paper/included.qmd':'## Included result\n\nIncluded β LF. Independent result 12.75. See @fig-kill.\n\n![](../fig/renders/kill-figure.svg){#fig-kill}\n',
};
if(['revision','render','conflict'].includes(process.argv[3])) {
 originals['paper/notes.qmd']=originals['paper/notes.qmd'].replace('---\r\n\r\n# Results','filters: [hold-export.lua]\r\n---\r\n\r\n# Results');
 if(process.argv[3]==='revision') {
 originals['paper/notes.qmd']=originals['paper/notes.qmd'].replace('filters: [hold-export.lua]','bibliography: ../references/library.bib\r\nfilters: [hold-export.lua]')+'\r\nCitation [@snapshot2020].\r\n';
 await write('references/library.bib','@article{snapshot2020, title={Captured old reference}, author={Researcher, Ada}, year={2020}, journal={Scientific Record}}\n');
 }
 await write('paper/hold-export.lua', `function Pandoc(doc)\nlocal f=assert(io.open([[${root}/render-ready]], 'w'));f:write('ready');f:close()\nwhile not io.open([[${root}/render-release]], 'r') do os.execute('sleep 0.02') end\nreturn doc\nend\n`);
}
for(const [rel,text]of Object.entries(originals)){await write(rel,text);await fs.utimes(path.join(root,rel),1600000000,1600000000);}
await write('fixture-originals.json',JSON.stringify(originals));
console.log('GUI export kill fixture prepared');
