/** Saved-deck adapter for the shared Figure/Slides model command policy. */
import path from 'node:path';
import { loadDeck, mutateDeck } from './slides';
import { loadFigModel, safeJoin, exists } from './model';
import { boundedModelFile } from './model3dFile';
import { confinedRecoveryPath } from './recovery';
import { deckToProject } from '../src/lib/slide/deckProject';
import { resolveTrack } from '../src/lib/slide/resolve';
import { deckModel3dBindings } from '../src/lib/slide/model3dBindings';
import { collectModel3dSourceBindings, model3dBindingsFromReceipts } from '../src/lib/model3d/sourceBinding';
import { readScene3dSidecars } from '../src/lib/model3d/persistence';
import { applyModelViewCommand, applyModelFieldCommand, commandModels, type ModelViewCommand, type ModelFieldCommand } from '../src/lib/model3d/commandOps';
import type { Deck } from '../src/lib/slide/types';
import type { ModelTarget } from './model3d';
import type { Scene3dManifest } from '../src/lib/model3d/types';

export async function deckModelDocument(root: string, deck: Deck) {
  const figure = (await loadFigModel(root)).project;
  const local = new Set(deck.assets.map(a => a.id));
  const assets = [...deck.assets.map(a => ({...a,path:path.posix.join('slides',deck.id,a.path)})), ...figure.assets.filter(a => !local.has(a.id)).map(a => ({...a,path:path.posix.join('fig',a.path)}))];
  const project = deckToProject(deck, assets), bindings = deckModel3dBindings(deck);
  const figureBindings = collectModel3dSourceBindings(figure.figures.flatMap(f => f.elements));
  const manifests: Record<string,Scene3dManifest|undefined> = {}, warnings: string[] = [];
  const used = new Set(project.figures.flatMap(f => f.elements).filter(e => e.type === 'model3d').map(e => e.assetId));
  for(const slide of deck.slides)for(const beat of slide.beats)for(const raw of beat.tracks){
    const track=resolveTrack(raw,deck);if(track.to?.assetId)used.add(track.to.assetId);
  }
  for (const asset of assets) if (asset.kind === 'glb' && used.has(asset.id)) {
    const candidates=local.has(asset.id)?[bindings.get(asset.id)]:[bindings.get(asset.id),figureBindings.get(asset.id)];
    const binding=model3dBindingsFromReceipts(candidates.flatMap(b=>b?(b.kind==='known'?[b.sha256]:b.sha256s).map(sha256=>({assetId:asset.id,sha256})):[])).get(asset.id);
    const metadata = await readScene3dSidecars({
      exists: async rel => {const file=safeJoin(root,rel);await confinedRecoveryPath(root,file);return exists(file);},
      readText: async rel => (await boundedModelFile(safeJoin(root,rel),4*1024*1024,root)).toString('utf8'),
    },local.has(asset.id)?`slides/${deck.id}/assets`:'fig/assets',asset.id,{binding});
    manifests[asset.id]=metadata.manifest;warnings.push(...metadata.issues??[]);
  }
  return {project,manifests,warnings};
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
