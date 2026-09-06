// Real saved project for production-renderer latency and export checks.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {buildScaffoldTree} from '../../src/lib/project/scaffoldTree';
import {executeFigSave,planFigSave} from '../../src/lib/project/figfiles';
import {createDeck} from '../../src/lib/slide/ops';
import type {Project,Element} from '../../src/lib/types';
const [root]=process.argv.slice(2);
if(!root)throw Error('Disposable project directory required');
const write=async(rel:string,text:string)=>{const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text)};
const deck=createDeck({id:'polish-deck',title:'Native polish',withTitleSlide:true});
const tree=buildScaffoldTree({title:'Figure polish verification'},deck);
for(const dir of tree.dirs)await fs.mkdir(path.join(root,dir),{recursive:true});
for(const [rel,text]of tree.files)await write(rel,text);
const elements=(n:number):Element[]=>Array.from({length:n},(_,i)=>i%3===2?{
 id:`e${n}-${i}`,type:'text',x:10+i%40*30,y:12+Math.floor(i/40)*20,width:26,height:12,rotation:0,text:`t${i}`,fontSize:9,fontFamily:'Arial',fontWeight:400,fontStyle:'normal',align:'left',color:'#111111',sizing:'fixed'
}:{id:`e${n}-${i}`,name:`Object ${i}`,type:'rect',x:12+i%40*30,y:12+Math.floor(i/40)*20,width:24,height:14,rotation:0,fill:'#4385be',stroke:'#222222',strokeWidth:1,cornerRadius:0});
const model:Project={version:2,name:'Polish',canvases:[{id:'c',name:'Canvas'}],assets:[],palette:[],figures:[1600,5000,5].map((n,i)=>({
 id:`native-${n}`,canvasId:'c',referenceKey:`fig-native-${n}`,name:`Figure ${i+1}`,nickname:`${n} objects`,family:'figure',number:i+1,x:0,y:i*10000,width:n===5?320:1220,height:n===5?240:860,background:'#ffffff',elements:elements(n),guides:{x:[20],y:[30]}
}))};
await executeFigSave(planFigSave(model,null),{read:async rel=>fs.readFile(path.join(root,rel),'utf8').catch(()=>null),write});
await write('manuscript/main.qmd','---\ntitle: Native polish\n---\n\n# Disposable test project\n');
