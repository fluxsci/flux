import { newId } from '../ids';
import { homeView } from './orbit';
import type { Model3dAsset, Model3dElement, Scene3dManifest } from './types';
export interface Model3dMakeOptions {manifest?:Scene3dManifest;box?:{x?:number;y?:number;width?:number;height?:number};name?:string;
 figureWidth?:number;stage?:{width:number;height:number};id?:string}
export function makeModel3dElement(asset:Model3dAsset,opts:Model3dMakeOptions={}):Model3dElement {
 if(asset.kind!=='glb'||!asset.id||!asset.model)throw new Error('Expected prepared GLB asset metadata');
 const {manifest:m,box={}}=opts,defaultWidth=m?.size?m.size.width*96:opts.stage?opts.stage.height*.6*4/3:Math.min((opts.figureWidth??672)*.5,336);
 const defaultHeight=m?.size?m.size.height*96:defaultWidth*.75;
 const width=box.width??defaultWidth,height=box.height??defaultHeight,x=box.x??0,y=box.y??0;
 if(![width,height,x,y].every(Number.isFinite)||width<=0||height<=0)throw new Error('Invalid 3D placement geometry');
 const sourceColors=(m?.parts??[]).some(p=>p.node||typeof p.field==='object')||asset.model.hasColors||asset.model.materialColors.length>1;
 return {type:'model3d',id:opts.id??newId('model3d'),assetId:asset.id,name:opts.name??m?.parts?.find(p=>p.role==='title')?.text??asset.name.replace(/\.glb$/i,''),
 x,y,width,height,rotation:0,lockAspect:false,...homeView(asset,m),fill:m?.parts?.find(p=>p.node&&p.color)?.color??'#4385BE',
 ...(sourceColors?{modelColors:'source'}:{}),...(m?.lighting?{modelLighting:m.lighting}:{})};
}
