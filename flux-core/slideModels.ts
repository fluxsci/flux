/** Slide model commands use native import and the same pure animation ops as GUI. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadDeck, mutateDeck } from './slides';
import { projectSourceRelativePath } from './projectSource';
import { makeImportedModel3dElement, type Model3dImportResult } from '../src/lib/model3d/importData';
import { addTurntable as turntable } from '../src/lib/slide/ops';
import { resolveModelPosters } from './model3dPosterCache';
const require = createRequire(import.meta.url);
function native() {
  const appRoot = process.env.FLUX_MODEL3D_APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return require(path.join(appRoot, 'electron/model3dImport.cjs')) as {
    prepareModel3d(options: {root:string;sourcePath:string;target:{kind:'slide';deckId:string};checkCurrent?:()=>void;readGuard?:(file:string)=>void}): Promise<{result:Model3dImportResult;files:string[]}>;
    cleanupPreparedModel3d(owned: unknown): Promise<void>;
  };
}
export async function addSlideModel(root: string, deckId: string, slideId: string, sourcePath: string, options: {
  x?: number; y?: number; width?: number; height?: number; name?: string; noPoster?: boolean;
} = {}) {
  const deck = await loadDeck(root, deckId);
  if (!deck.slides.some(s => s.id === slideId)) throw new Error(`Slide not found: ${slideId}`);
  const relative = await projectSourceRelativePath(root, sourcePath);
  const owned = await native().prepareModel3d({root,sourcePath:path.resolve(root,relative),target:{kind:'slide',deckId}});
  const data = owned.result;
  let element: ReturnType<typeof makeImportedModel3dElement> | undefined;
  try {
    await mutateDeck(root, deckId, 'add_slide_model', target => {
      const slide = target.slides.find(s => s.id === slideId); if (!slide) throw new Error(`Slide not found: ${slideId}`);
      element = makeImportedModel3dElement(data, {root,name:options.name,box:options,figureWidth:target.stage.width,stage:target.stage});
      if(options.x===undefined)element.x=(target.stage.width-element.width)/2;
      if(options.y===undefined)element.y=(target.stage.height-element.height)/2;
      target.assets.push(data.asset); slide.elements.push(element);
    });
  } catch(error) {
    // A journal failure may occur after publication: never discard referenced bytes.
    const live = await loadDeck(root,deckId).catch(()=>null);
    if (live && !live.assets.some(a=>a.id===data.asset.id)) await native().cleanupPreparedModel3d(owned);
    throw error;
  }
  const warnings = [...data.warnings];
  if (!options.noPoster) {
    try {
      const rendered = await resolveModelPosters(root, [{id:slideId,name:'Slide',canvasId:deckId,x:0,y:0,width:deck.stage.width,height:deck.stage.height,background:'transparent',elements:[element!]}], [data.asset],
        {policy:'project',surface:'slide',assetPrefix:`slides/${deckId}`,manifests:{[data.asset.id]:data.manifest}});
      warnings.push(...rendered.warnings);
    } catch(error) { warnings.push(`Model saved; poster could not be rendered: ${String(error)}`); }
  }
  return {elementId:element!.id,assetId:data.asset.id,warnings};
}
export async function addSlideTurntable(root:string,deckId:string,slideId:string,beatId:string,target:string,options:{turns?:number;direction?:'cw'|'ccw';durationMs?:number;start?:number}={}) {
  return mutateDeck(root,deckId,'add_turntable',deck=>{
    const track=turntable(deck,{slideId,beatId,target,...options});
    if(!track)throw new Error('Turntable requires a 3D model and valid slide step');
    return {trackId:track.id};
  });
}
