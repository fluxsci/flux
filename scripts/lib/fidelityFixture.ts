// Saved figures isolate the service/Chromium rendering contracts. No runtime
// test-only raster shortcuts: the gate opens these through the real app.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { buildScaffoldTree } from '../../src/lib/project/scaffoldTree';
import { executeFigSave, planFigSave } from '../../src/lib/project/figfiles';
import { createDeck } from '../../src/lib/slide/ops';
import type { Project, Figure, TextElement } from '../../src/lib/types';
const [root, specsFile] = process.argv.slice(2);
if (!root || !specsFile) throw Error('Disposable project and specification paths required');
const write=async(rel:string,text:string|Buffer)=>{const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text)};
const tree=buildScaffoldTree({title:'Raster fidelity'},createDeck({id:'fidelity-deck',title:'Raster fidelity',withTitleSlide:true}));
for(const dir of tree.dirs)await fs.mkdir(path.join(root,dir),{recursive:true});
for(const [file,text]of tree.files)await write(file,text);
const model:Project={version:2,name:'Raster fidelity',canvases:[{id:'c',name:'Canvas'}],assets:[],palette:[],figures:[]};
const specs:Record<string,unknown>={};
const add=async(id:string,w:number,h:number,content:string,extra:Partial<Figure>={},spec:Record<string,unknown>={})=>{
 await write(`fig/assets/${id}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${content}</svg>`);
 model.assets.push({id,name:id,kind:'svg',path:`assets/${id}.svg`,naturalWidth:w,naturalHeight:h});
 model.figures.push({id,canvasId:'c',referenceKey:'fig-'+id,name:id,family:'figure',number:model.figures.length+1,x:0,y:model.figures.length*1800,width:w,height:h,background:'#ffffff',elements:[{id:id+'-plot',type:'plot',assetId:id,x:0,y:0,width:w,height:h,rotation:0}],...extra});
 specs[id]={scale:1,threshold:0.01,...spec};
};
// TEXT-BLOCK PINS (QA-P6a, 2026-10-31, orchestrator ruling R-P6a-1). The plan's 1% text-block contract is
// retired as unachievable with a second rasterizer: once the faces match (XML-decoded families, CSS weight
// search) the residual is glyph anti-aliasing, resvg/tiny-skia vs Chromium/Skia. The worker's resvg
// text-rendering-mode, supersampling and subpixel-shift experiments did not close it (3.47-5.49% remained).
// Each pin is the measured post-fix value (deterministic: identical over 3 runs on Xvfb, Electron 43.7.3)
// plus 20%, the plan's rule for hairlines and fills. What still catches the weight/style bug these fixtures
// exist for, measured on the base dca1f1e4 archive (Arial requested as "&quot" -> Noto Sans regular):
//   plot-700/600: ink ratio 0.6775 (the +-5% ink-coverage assertion is the load-bearing pin), blocks 13.92%;
//   plot-400-italic: ink 0.9744 passes, blocks 17.88% vs the 4.17% pin (the block pin carries italic);
//   plot-400-normal 16.87%, whole fixture 6.40% (pin 3.25%).
// The annotation labels (Flux text elements, Georgia) measured the same on the base: regression guards only.
const measured:Record<string,number>={'plot-400-normal':0.040111,'annotation-400-normal':0.037889,'plot-700-normal':0.037278,'annotation-700-normal':0.054056,
 'plot-400-italic':0.034722,'annotation-400-italic':0.054889,'plot-600-normal':0.037278,'annotation-600-normal':0.054056,fonts:0.02712};
const pin=(name:string)=>+(measured[name]*1.2).toFixed(5);
const labels:Record<string,unknown>[]=[];const annotations:TextElement[]=[];
let texts='';
for(const [i,weight,style]of [[0,400,'normal'],[1,700,'normal'],[2,400,'italic'],[3,600,'normal']]as const){
 const y=16+i*72;
 texts+=`<g style="font-family:&quot;Arial&quot;,sans-serif;font-weight:${weight};font-style:${style}"><text x="16" y="${y+40}" font-size="40">Whole state</text></g>`;
 // A second family prevents an annotation from supplying Arial's missing
 // bold file accidentally and masking the old XML scanner's failure.
 annotations.push({id:'annotation-'+i,type:'text',x:390,y,width:350,height:56,rotation:0,text:'Whole state',fontFamily:'Georgia',fontSize:40,fontWeight:weight,fontStyle:style,align:'left',color:'#000000',sizing:'fixed'});
 for(const [x,kind]of [[12,'plot'],[386,'annotation']]as const)labels.push({name:`${kind}-${weight}-${style}`,x,y:y-4,w:300,h:60,threshold:pin(`${kind}-${weight}-${style}`),coverageTolerance:0.05});
}
await add('fonts',750,310,texts,{elements:[{id:'fonts-plot',type:'plot',assetId:'fonts',x:0,y:0,width:750,height:310,rotation:0},...annotations]},{scale:2,labels,threshold:pin('fonts')});
const {Resvg}=createRequire(import.meta.url)('@resvg/resvg-js');
let pixels='';for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels+=`<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${x*37+y*13&255},${x*11+y*79&255},${x*63+y*23&255})"/>`;
const png=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${pixels}</svg>`,{font:{loadSystemFonts:false}}).render().asPng().toString('base64');
for(const size of [512,32])for(const mode of ['auto','optimizeQuality','optimizeSpeed','pixelated','crisp-edges'])await add(`image-${size}-${mode}`,size,size,`<image width="${size}" height="${size}" style="image-rendering:${mode}" href="data:image/png;base64,${png}"/>`);
let strokes='';for(let i=0;i<2200;i++){const x=8+(i*137%580),y=8+(i*71%380);strokes+=`<path d="M${x} ${y}l${(i*17%29)-14} ${(i*23%19)-9}" fill="none" stroke="#4385be" stroke-width="0.3"/>`;}
// 2026-10-31 Chromium oracle: 0/60,000 hairline blocks differ; fill 51/60,000
// (0.085%). Bounds retain the measured value plus 20%, with no text waiver.
await add('hairlines',600,400,strokes,{}, {threshold:0});
await add('area-fill',600,400,'<path d="M10.3 350.7C60.1 18.2 260.6 380.1 310.2 30.9L580.8 330.1Z" fill="#4385be" fill-opacity="0.6"/>',{}, {threshold:0.00102});
await executeFigSave(planFigSave(model,null),{read:async rel=>fs.readFile(path.join(root,rel),'utf8').catch(()=>null),write});
await fs.writeFile(specsFile,JSON.stringify(specs,null,2));
