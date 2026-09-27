import assert from 'node:assert/strict';
import {planExplicitVocabularyCorrections,correctionPairKey} from '../src/shell/modes/paper/editing/localCorrectionCore';
import {planExplicitVocabularyCorrections as oracle} from './fixtures/correction-oracle/unindexed';
import {applyState,diffState} from '../src/lib/slide/tween';
import {pathD} from '../src/lib/path';
import type {Element} from '../src/lib/types';
const words=['iGluSnFR4f','SLAP2','jRGECO1a','Neuropixels2','NREM','Alpha-Receptor9','alphaReceptor9','MAPKinase7','MAPKinase8'];
const corpus=['We measured IgluSnrf4, iglusnfr4f, jRGECO1a, Neuropixles2 and NREM.', 'SLAP3 MAPKinase9 Alpha_Receptor9 alpha-receptor9.','`IgluSnrf4` $IgluSnrf4$\n```qmd\nIgluSnrf4\n```\nIgluSnrf4','---\ntitle: IgluSnrf4\n---\n\nIgluSnrf4 iglusnfr4f Neuropixles2.','\r\nIgluSnrf4\r\n![](IgluSnrf4)\r\n<!-- IgluSnrf4 -->'];
let comparisons=0;
for(const n of [5000,20000]){
 const vocabulary=[...words,...Array.from({length:n-words.length},(_,i)=>`Receptor${i.toString(36).padStart(6,'0')}Variant`)];
 for(const source of corpus)for(const blocked of [new Set<string>(),new Set([correctionPairKey('IgluSnrf4','iGluSnFR4f')])]){
  assert.deepEqual(planExplicitVocabularyCorrections(source,vocabulary,blocked),oracle(source,vocabulary,blocked),`${n} words, ${source}`);comparisons++;
 }
}
const base={id:'identity',name:'Original',groupId:'g',locked:true,hidden:false,lockAspect:true,x:10,y:20,width:130,height:80,rotation:31};
const nodes=[{x:0,y:0,type:'corner' as const},{x:130,y:80,type:'corner' as const}];
const variants:Element[]=[
 {...base,type:'rect',fill:'#f00',stroke:'#111',strokeWidth:2,cornerRadius:4},
 {...base,type:'ellipse',fill:'#f00',stroke:'#111',strokeWidth:2},
 {...base,type:'line',x1:0,y1:0,x2:130,y2:80,stroke:'#111',strokeWidth:2,arrowStart:false,arrowEnd:true},
 {...base,type:'path',d:pathD(nodes,false),nodes,closed:false,fill:'none',stroke:'#111',strokeWidth:2},
 {...base,type:'text',text:'Scientific α 3.25',fontFamily:'Arial',fontSize:18,fontWeight:400,fontStyle:'normal',align:'left',color:'#111',sizing:'auto'},
 {...base,type:'image',assetId:'image'},
 {...base,type:'plot',assetId:'plot',contentScale:1,overrides:{'a':{fill:'#345'}}},
 {...base,type:'video',assetId:'video',posterAssetId:'poster',durationMs:1000,muted:false,loop:false},
];
const excluded=new Set(['id','name','groupId','locked','hidden','lockAspect','assetId','styleId','panelLabel','lines','needsLayout','source','manifestRef','posterAssetId','durationMs','muted','loop']);
const authorState=(el:Element)=>Object.fromEntries(Object.entries(el).filter(([k,v])=>!excluded.has(k)&&v!==undefined));
let states=0;
for(const a of variants)for(const b of variants)for(const optional of [{},{opacity:.4},{flipX:true},{flipY:true},{opacity:.4,flipX:true,flipY:true}]){
 const pre={...a,...optional},end={...b,x:90,y:70,width:130,height:80};
 const before=structuredClone(pre),after=structuredClone(end);
 const result=applyState(pre,diffState(pre,end));
 assert.deepEqual(authorState(result),authorState(end),`${a.type}->${b.type} deletes ${JSON.stringify(optional)}`);
 assert.equal(result.id,pre.id);assert.deepEqual(pre,before);assert.deepEqual(end,after);states++;
 for(const [key,value]of Object.entries(optional))assert.equal((applyState(end,diffState(end,pre)) as any)[key],value,`optional ${key} also reintroduced`);
}
console.log(JSON.stringify({vocabularyComparisons:comparisons,vocabularySizes:[5000,20000],elementTypes:variants.map(x=>x.type),stateLawCases:states,optionalProps:['opacity','flipX','flipY'],passed:true}));
