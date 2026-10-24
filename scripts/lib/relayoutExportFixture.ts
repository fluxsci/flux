import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,plot} from './relayoutFixture';
import {buildPlotMarkup} from '../../src/lib/plot/inlineMarkup';
import {solveRelayout} from '../../src/lib/plot/relayout';
import {createDeck} from '../../src/lib/slide/ops';
import {exportDeckHtml} from '../../src/lib/slide/export/exportDeck';
const out=process.argv[2];if(!out)throw Error('Scratch directory required');
const f=fixture(),el=plot('p','a',{x:0,y:0,width:720,height:500}),svg=buildPlotMarkup(f.svg,el,undefined,f.manifest)!;
await fs.writeFile(path.join(out,'figure.html'),`<!doctype html><style>*{margin:0}body{width:720px;height:500px;background:white}svg{display:block}</style>${svg}`);
const solved=solveRelayout(f.model,{wPt:540,hPt:375});
await fs.writeFile(path.join(out,'pdf-anchors.json'),JSON.stringify(['axis.x.title','axis.y.title','panel.a.title'].filter(id=>f.model.layout.texts[id]).map(id=>{
 const t=f.model.layout.texts[id],delta=[solved.decor[id][0]-t.anchor[0],solved.decor[id][1]-t.anchor[1]];
 return {id,words:t.text.split(/\s+/),center:[(t.bbox[0]+t.bbox[2])/2+delta[0],(t.bbox[1]+t.bbox[3])/2+delta[1]]};
})));
const deck=createDeck({id:'reflow',title:'Elastic plot export',withTitleSlide:false});deck.stage={width:1000,height:700};deck.slides=[{id:'s',elements:[plot('p','a',{x:0,y:0})],beats:[{id:'base',tracks:[]},{id:'b',tracks:[{id:'t',target:'p',preset:'transform',duration:1000,easing:'linear',to:{state:{width:780,height:600}}}]}]}];deck.assets=[{id:'a',path:'a.svg',name:'Line',kind:'svg',naturalWidth:480,naturalHeight:307.2}];
await fs.writeFile(path.join(out,'deck.html'),(await exportDeckHtml({deck,plots:{a:{svg:f.svg,manifest:f.manifest}}})).html);
