import fs from 'node:fs';
import {DOMParser,parseHTML} from 'linkedom';
import {preparePlot} from '../../src/lib/plot/parse';
import {buildRelayoutModel} from '../../src/lib/plot/relayout';
import type {SemanticPlotElement,Project} from '../../src/lib/types';
Object.assign(globalThis,{DOMParser,document:parseHTML('<html><body></body></html>').document});
export function fixture(name='line'){
 const svg=fs.readFileSync(`scripts/fixtures/relayout/${name}/base.svg`,'utf8'),manifest=JSON.parse(fs.readFileSync(`scripts/fixtures/relayout/${name}/base.fluxplot.json`,'utf8'));
 const prepared=preparePlot(svg,manifest),root=prepared.root!,effective=prepared.manifest!,model=buildRelayoutModel(effective,root);
 if(!model.supported)throw Error(JSON.stringify(model.report));return {svg,manifest:effective,root,model};
}
export const plot=(id='p',assetId='asset',extra:Partial<SemanticPlotElement>={}):SemanticPlotElement=>({type:'plot',id,assetId,x:20,y:20,width:480,height:307.2,rotation:0,...extra});
export const project=(elements:SemanticPlotElement[]):Project=>({version:2,name:'Relayout',figures:[{id:'f',name:'Figure',x:0,y:0,width:1000,height:700,elements}],assets:[{id:'asset',path:'assets/asset.svg',type:'plot',naturalWidth:480,naturalHeight:307.2}],palette:[]} as Project);
