/** Saved-deck adapter for the shared Figure/Slides model command policy. */
import { loadDeck, mutateDeck } from './slides';
import { loadFigModel, safeJoin, exists } from './model';
import { boundedModelFile } from './model3dFile';
import { confinedRecoveryPath } from './recovery';
import { deckModelDocumentFrom } from '../src/lib/model3d/livePosterKeys';
import { applyModelViewCommand, applyModelFieldCommand, commandModels, type ModelViewCommand, type ModelFieldCommand } from '../src/lib/model3d/commandOps';
import type { Deck } from '../src/lib/slide/types';
import type { ModelTarget } from './model3d';
import type { Scene3dManifest } from '../src/lib/model3d/types';

/** Node IO over the shared definition (confined, bounded sidecar reads). */
export async function deckModelDocument(root: string, deck: Deck) {
  return deckModelDocumentFrom(deck, (await loadFigModel(root)).project, {
    exists: async rel => {const file=safeJoin(root,rel);await confinedRecoveryPath(root,file);return exists(file);},
    readText: async rel => (await boundedModelFile(safeJoin(root,rel),4*1024*1024,root)).toString('utf8'),
  });
}
export async function mutateDeckModel(root:string,target:ModelTarget,kind:'view'|'field',command:ModelViewCommand|ModelFieldCommand) {
  if (!target.deckId || target.figureId) throw new Error('Use deckId with an optional slideId, or figureId; do not mix Figure and Slides selectors');
  return mutateDeck(root,target.deckId,`set_model_${kind}`,async deck => {
    const {project,manifests,warnings}=await deckModelDocument(root,deck);
    const element=commandModels(project,[target.target])[0];
    const slide=deck.slides.find(s=>s.elements.some(e=>e.id===element.id))!;
    if(target.slideId && target.slideId!==slide.id)throw new Error(`3D target ${target.target} is not in slide ${target.slideId}`);
    const accepted=Object.fromEntries(Object.entries(manifests).filter((entry):entry is [string,Scene3dManifest]=>!!entry[1]));
    if(kind==='view')warnings.push(...applyModelViewCommand(project,[element.id],command as ModelViewCommand,accepted));
    else applyModelFieldCommand(project,[element.id],command as ModelFieldCommand,accepted);
    slide.elements[slide.elements.findIndex(e=>e.id===element.id)]=element;
    return {element:structuredClone(element),deckId:deck.id,slideId:slide.id,warnings};
  });
}
export async function loadDeckModelDocument(root:string,deckId:string){return deckModelDocument(root,await loadDeck(root,deckId));}
